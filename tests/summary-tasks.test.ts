import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createGroupService } from "../runtime/group-service";
import { complete, type ModelProfile } from "../runtime/models";
import { openSummaryTasks, summaryFailure, summaryRetryDelay } from "../runtime/summary-tasks";
import { openBackgroundJobs } from "../runtime/background-jobs";
import { openGroupReplyTraces } from "../runtime/group-reply-traces";
import { openServiceBudget } from "../runtime/service-budget";
import { openStore } from "../runtime/store";

async function until(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await done()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  assert.fail("Expected summary state did not arrive");
}

test("summary tasks retain the failed batch and delay retry after restart", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const t = Date.parse("2026-11-23T11:00:00Z");
    const task = openSummaryTasks(db, t);
    task.begin("scope", 4, 5, 2, t);
    const restarted = openSummaryTasks(db, t + 5000);
    assert.match(restarted.view("scope")?.nextAttemptAt ?? "", /11:01:05/);
    assert.equal(restarted.view("scope")?.failure, "interrupted");
    assert.equal(restarted.view("scope")?.attempts, 1);
    assert.equal(restarted.task("scope")?.last_id, 5);
    assert.equal(restarted.retry("scope", t + 7000), true);
    restarted.begin("scope", 4, 5, 2, t + 7000);
    restarted.failed("scope", {kind: "rate-limit", httpStatus: 429}, t + 7010);
    assert.equal(restarted.view("scope")?.attempts, 2);
    assert.equal(restarted.view("scope")?.httpStatus, 429);
    assert.equal(restarted.view("scope")?.nextAttemptAt, "2026-11-23T11:02:07.010Z");
    assert.equal(summaryRetryDelay(1, { kind: "authorization" }), 300_000);
    assert.equal(summaryRetryDelay(40, { kind: "format" }), 900_000);
  } finally { db.close(); }
});

test("background jobs and reply traces recover recorded deliveries without replay", async (t) => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-background-recovery-"));
  t.after(async () => {
    const resolved = await realpath(directory);
    assert.ok(resolved.startsWith(root + sep));
    await rm(resolved, { recursive: true, force: true });
  });
  const database = join(directory, "state.db");
  const scope = "qq:1001:5001";
  const original = openStore(database);
  try {
    openServiceBudget(original, []);
    const batches = openSummaryTasks(original.db);
    const jobs = openBackgroundJobs(original.db);
    const traces = openGroupReplyTraces(original.db);
    batches.begin(scope, 4, 5, 2, Date.now());
    jobs.begin("summary", scope, "摘要", [], new AbortController());
    jobs.begin("profile", scope, "画像", [], new AbortController());
    const insert = original.db.prepare(`INSERT INTO outbox(scope,event_id,content,status,created_at,platform_message_id)
      VALUES (?,?,?,?,?,?)`);
    for (const [event, state, message] of [["completed", "sent", "5000"], ["interrupted", "sending", null]] as const) {
      const id = jobs.begin("proactive", scope, event, [], new AbortController());
      jobs.sending(id, event);
      assert.equal(jobs.cancel(id), false);
      insert.run(scope, event, "本机投递测试", state, new Date().toISOString(), message);
      const trace = traces.begin(scope, event, "discussion", { id: "fixture.role", name: "测试角色", version: "1.0.0", revision: "a".repeat(64) });
      traces.planDelivery(trace, event);
      if (state === "sent") traces.finish(trace, "finished", "sent");
    }
  } finally { original.db.close(); }
  const reopened = openStore(database);
  try {
    openServiceBudget(reopened, []);
    openSummaryTasks(reopened.db);
    const jobs = openBackgroundJobs(reopened.db);
    const items = jobs.list("1001", null, null);
    assert.deepEqual(items.map(item => [item.state, item.deliveryStatus, item.cancellable]), [
      ["unknown", "unknown", false], ["sent", "sent", false], ["cancelled", null, false], ["retry", null, false],
    ]);
    assert.equal(items[1].platformMessageId, "5000");
    assert.ok(items[3].nextAttemptAt);
    assert.deepEqual(jobs.list("1002", scope, null), []);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS total FROM outbox").get()?.total, 2);
    const traces = openGroupReplyTraces(reopened.db);
    const since = new Date(0).toISOString();
    assert.deepEqual(traces.list("1001", scope, "discussion", null, since).map(item => [item.state, item.reason, item.receipts[0].status]), [
      ["interrupted", "restart", "unknown"], ["finished", "sent", "sent"],
    ]);
    assert.deepEqual(traces.list("1002", null, null, null, since), []);
    traces.prune(new Date(Date.now() + 60_000).toISOString());
    assert.deepEqual(traces.list("1001", null, null, null, since), []);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS total FROM outbox").get()?.total, 2);
  } finally { reopened.db.close(); }
});

test("a deadline while reading a model response is classified as a timeout", async (t) => {
  const slow = createServer((_req, res) => {
    res.writeHead(200, {"Content-Type":"application/json"});
    res.write('{"choices":');
  });
  slow.listen(0, "127.0.0.1");
  await once(slow, "listening");
  t.after(() => { slow.closeAllConnections(); slow.close(); });
  const profile = { baseUrl: `http://127.0.0.1:${(slow.address() as AddressInfo).port}`, model: "slow" } as ModelProfile;
  await assert.rejects(complete(profile, null, [], undefined, undefined, 50), error => {
    assert.equal(summaryFailure(error).kind, "timeout");
    return true;
  });
});

test("a rate-limited batch retries the same messages while direct QQ replies continue", async (t) => {
  const testRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(testRoot, "ohjingjing-summary-retry-"));
  const preparedBatches: string[][] = [];
  const calls: string[] = [];
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const { messages } = JSON.parse(body);
    const summarizing = messages[0].content.includes("生成中文话题摘要");
    calls.push(summarizing ? "summary" : "reply");
    res.setHeader("Content-Type", "application/json");
    let text = "继续聊吧。";
    if (summarizing) {
      const { messages: sample } = JSON.parse(messages.at(-1).content);
      preparedBatches.push(sample.map((message: { text: string }) => message.text));
      if (preparedBatches.length === 1) { res.statusCode = 429; res.end("{}"); return; }
      if (preparedBatches.length === 3) { await once(res, "close"); return; }
      text = JSON.stringify({ overview: "讨论约局时间。", topics: [{ title: "周末约局", summary: "谈到周日。", evidence: [1, 2], facts: [] }] });
    }
    res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const port = (server: { address(): unknown }) => (server.address() as AddressInfo).port;
  const admin = "integration-summary-retry-admin";
  const database = join(directory, "state.db");
  const scope = "qq:1001:5001";
  const service = createGroupService({ database, adminToken: admin, observeGroups: ["5001"], summaryGroups: ["5001"],
    summarizeAfter: 2, summaryCooldownSeconds: 0,
    channel: { enabled: true, expectedBotId: "1001", groups: ["5001"], address: `ws://127.0.0.1:${port(gateway)}`,
      hasToken: false, roleId: "", modelId: "" },
    model: { id: "test", name: "Test", baseUrl: `http://127.0.0.1:${port(provider)}`, billing: "none", model: "test",
      hasKey: false, inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "" },
  });
  t.after(async () => {
    await service.stop();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await new Promise<void>(resolve => provider.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.ok(resolved.startsWith(testRoot + sep));
    await rm(resolved, { recursive: true, force: true });
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const connected = once(gateway, "connection");
  service.startChannel();
  const [socket] = await connected;
  const replies: string[] = [];
  socket.on("message", (frame: Buffer) => {
    const request = JSON.parse(frame.toString());
    replies.push(request.params.message[0].data.text);
    socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data: { message_id: 50001 } }));
  });
  function send(id: number, message: string) {
    socket.send(JSON.stringify({ post_type: "message", message_type: "group", self_id: 1001, user_id: 2001,
      group_id: 5001, message_id: id, message }));
  }
  function request(path: string, data?: object, token = admin) {
    return fetch(`http://127.0.0.1:${port(service.server)}${path}`, { method: data ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: data && JSON.stringify(data) });
  }
  async function task() {
    const state = await (await request("/admin/status")).json();
    return state.groups.find((group: { scope: string }) => group.scope === scope)?.summaryTask;
  }
  const jobsPath = "/admin/background-jobs?" + new URLSearchParams({ scope, kind: "summary" });
  const jobs = async () => (await (await request(jobsPath)).json()).items;
  send(1, "周末约局想定在哪天？");
  send(2, "周日可以。");
  await until(async () => (await task())?.state === "waiting");
  const failure = await task();
  assert.equal(failure.failure, "rate-limit");
  assert.equal(failure.httpStatus, 429);
  assert.equal(Date.parse(failure.nextAttemptAt) - Date.parse(failure.updatedAt), 120_000);
  assert.equal((await request(jobsPath, undefined, "invalid-token")).status, 403);
  assert.equal((await request("/admin/background-jobs?kind=invalid")).status, 400);
  const [rateLimited] = await jobs();
  assert.equal(rateLimited.state, "retry");
  assert.equal(rateLimited.httpStatus, 429);
  assert.equal(rateLimited.modelStatus, "failed");
  assert.equal(rateLimited.modelName, "Test");
  assert.equal(rateLimited.nextAttemptAt, failure.nextAttemptAt);
  assert.ok(!JSON.stringify(rateLimited).includes("周末约局"));
  send(3, "[CQ:at,qq=1001]还在吗？");
  await until(() => replies.length === 1);
  assert.deepEqual(replies, ["继续聊吧。"]);
  assert.deepEqual(calls, ["summary", "reply"]);
  assert.equal((await request("/admin/summary-retry", { scope }, "invalid-token")).status, 403);
  assert.equal((await request("/admin/summary-retry", { scope })).status, 202);
  await until(async () => (await task())?.state === "archived");
  assert.deepEqual(preparedBatches, [["周末约局想定在哪天？", "周日可以。"], ["周末约局想定在哪天？", "周日可以。"]]);
  assert.equal((await task()).attempts, 2);
  const history = await (await request("/admin/group-topics?scope=" + encodeURIComponent(scope))).json();
  assert.equal(history.summaries[0].topics[0].title, "周末约局");
  const [archived, failed] = await jobs();
  assert.equal(archived.state, "succeeded");
  assert.equal(archived.resultId, history.summaries[0].id);
  assert.equal(failed.id, rateLimited.id);
  assert.equal(failed.nextAttemptAt, null);
  assert.notEqual(archived.requestId, failed.requestId);

  send(4, "下一次摘要用来验证取消。");
  await until(() => preparedBatches.length === 3);
  const [running] = await jobs();
  assert.equal(running.cancellable, true);
  const cancelPath = "/admin/background-jobs/" + running.id + "/cancel";
  assert.equal((await request(cancelPath, {})).status, 202);
  await until(async () => (await jobs())[0]?.state === "retry");
  const [cancelled] = await jobs();
  assert.equal(cancelled.reason, "operator");
  assert.equal(cancelled.modelStatus, "cancelled");
  assert.equal(cancelled.cancellable, false);
  assert.ok(cancelled.nextAttemptAt);
  assert.equal((await request(cancelPath, {})).status, 409);
});

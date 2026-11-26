import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { createGroupService } from "../runtime/group-service.js";
import { openDesktopCredentials } from "../runtime/desktop-credentials.js";
import { openDesktopWorkspaces } from "../runtime/desktop-workspaces.js";
import { createQqIngressCollector, openQqIngress } from "../runtime/qq-ingress.js";
import { openStore } from "../runtime/store.js";

test("a QQ group recall revokes stored and in-flight evidence and blocks a later arrival", { timeout: 30_000 }, async t => {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, "ohjingjing-recalled-"));
  const database = join(directory, "service.db");
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const token = "isolated-qq-recall-ingress-token";
  const admin = "isolated-qq-recall-operator-token";
  const address = (server: { address(): unknown }) => (server.address() as AddressInfo).port;
  const endpoint = `ws://127.0.0.1:${address(gateway)}`;
  const groups = ["5001", "5002"];
  const scope = "qq:1001:5001";
  const otherScope = "qq:1001:5002";
  const sends: string[] = [];
  let historyRows: object[] = [];
  gateway.on("connection", socket => socket.on("message", frame => {
    const { action, params, echo } = JSON.parse(String(frame));
    let data = {};
    if (action === "get_status") data = { online: true, good: true };
    if (action === "get_login_info") data = { user_id: 1001 };
    if (action === "get_group_msg_history") data = { messages: params.group_id === 5001 ? historyRows : [] };
    if (action === "send_group_msg") {
      sends.push(params.message.map((part: { data: { text?: string } }) => part.data.text).join(""));
      data = { message_id: 9000 + sends.length };
    }
    socket.send(JSON.stringify({ status: "ok", retcode: 0, echo, data }));
  }));
  const collector = createQqIngressCollector({ database: join(directory, "ingress.db"), gateway: endpoint, accountId: "1001",
    groups, privateContacts: [], token, recoverHistory: true });
  collector.server.listen(0, "127.0.0.1");
  await once(collector.server, "listening");
  const ingress = `http://127.0.0.1:${address(collector.server)}`;
  const realFetch = globalThis.fetch;
  const prompts: string[] = [];
  let modelAborted = false;
  t.mock.method(globalThis, "fetch", async (url: URL | string, init?: RequestInit) => {
    if (!String(url).startsWith("https://model.example.org")) return realFetch(url, init);
    const prompt = String(JSON.parse(String(init?.body)).messages.at(-1).content);
    prompts.push(prompt);
    if (prompt.includes("等我撤回原文再说")) {
      await once(init!.signal!, "abort");
      modelAborted = true;
    }
    return Response.json({ choices: [{ message: { content: "当前没有可核实的引文。" } }] });
  });
  const createService = () => createGroupService({ database, adminToken: admin, observeGroups: groups, summaryGroups: groups, summarizeAfter: 1000,
    qqIngress: ingress, qqIngressToken: token,
    model: { id: "fixture", name: "fixture", model: "fixture", baseUrl: "https://model.example.org", hasKey: false,
      billing: "none", billingAccount: "", currency: "CNY", inputPrice: null, outputPrice: null },
    channel: { enabled: true, address: endpoint, groups, roleId: "", modelId: "", hasToken: false, expectedBotId: "1001" },
  });
  let service = createService();
  let db: DatabaseSync | undefined;
  t.after(async () => {
    db?.close();
    await service.stop();
    await collector.stop();
    for (const socket of gateway.clients) socket.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    const path = await realpath(directory);
    assert.equal(dirname(path), parent);
    await rm(path, { recursive: true, force: true });
  });
  async function until(check: () => unknown | Promise<unknown>) {
    for (let i = 0; i < 180; i++) {
      if (await check()) return;
      await delay(25);
    }
    assert.fail("Expected a QQ recall state");
  }
  async function start() {
    service.server.listen(0, "127.0.0.1");
    await once(service.server, "listening");
    service.startChannel();
    await until(async () => (await api("/admin/qq-ingress")).ready);
  }
  const api = (path: string) => fetch(`http://127.0.0.1:${address(service.server)}${path}`,
    { headers: { Authorization: "Bearer " + admin } }).then(response => response.json());
  const emit = (event: object) => { for (const socket of gateway.clients) socket.send(JSON.stringify(event)); };
  const text = (value: string) => ({ type: "text", data: { text: value } });
  const at = { type: "at", data: { qq: 1001 } };
  const say = (id: number, message: object[], group = 5001) => emit({
    post_type: "message", message_type: "group", self_id: 1001, group_id: group, user_id: 2001, message_id: id, message,
  });
  const recall = (id: number, group = 5001, actor = 2001) => emit({
    post_type: "notice", notice_type: "group_recall", self_id: 1001, group_id: group, user_id: actor, operator_id: actor, message_id: id,
  });
  await start();
  db = new DatabaseSync(database);
  const original = db.prepare("SELECT id, content FROM group_messages WHERE scope=? AND event_id=?");
  const rawSeed = db.prepare("INSERT INTO group_messages(scope,author,content,created_at,event_id) VALUES(?,?,?,?,?)");
  const source = "原安排定在橡木坡，记号蓝椿。";
  say(70, [text("同一场安排需要核对新通知。")]);
  say(51, [text("另一群的原文保留。")], 5002);
  say(71, [text(source)]);
  await until(() => original.get(scope, "70") && original.get(scope, "71") && original.get(otherScope, "51"));
  const id = original.get(scope, "71")!.id;
  db.prepare("INSERT INTO group_summaries(scope,first_id,last_id,content,created_at,sample_count) VALUES(?,?,?,?,?,1)")
    .run(scope, id, id, "已记录橡木坡及蓝椿。", new Date().toISOString());
  const profileRow = db.prepare(`INSERT INTO group_profile_candidates(scope,subject,summary,evidence_count,publication_revision,status,created_at)
    VALUES(?,?,?,2,?,?,?)`);
  const addEvidence = db.prepare("INSERT INTO group_profile_evidence VALUES(?,?)");
  const set = db.prepare("INSERT INTO settings(key,value) VALUES(?,?)");
  const profileAt = new Date().toISOString();
  const candidates = [["group", "published"], ["2001", "published"], ["2001", "pending"]].map(([subject, status]) => {
    const revision = status === "published" ? randomUUID() : null;
    const summary = "画像依赖记号蓝椿。";
    const candidate = profileRow.run(scope, subject, summary, revision, status, profileAt).lastInsertRowid;
    addEvidence.run(candidate, id);
    addEvidence.run(candidate, original.get(scope, "70")!.id);
    if (revision) set.run(`profile:${scope}:${subject}`, JSON.stringify({ displayName: subject, summary, revision, source: "model-reviewed" }));
    return candidate;
  });
  set.run(`profile:${otherScope}:group`, JSON.stringify({ displayName: "另一群", summary: "独立画像。" }));
  const base = `http://127.0.0.1:${address(service.server)}`;
  async function reader(qqId: string, scopes: string[], raw: string[]) {
    const grant = await fetch(base + "/admin/subscribers", { method: "POST", headers: {
      Authorization: "Bearer " + admin, "Content-Type": "application/json",
    }, body: JSON.stringify({ qqId, groups: scopes, messageGroups: raw }) });
    assert.equal(grant.status, 201);
    const { token: permission } = await grant.json();
    const client = openStore(":memory:");
    t.after(() => client.db.close());
    const credentials = openDesktopCredentials(client);
    const desktop = openDesktopWorkspaces(client, credentials);
    const source = randomUUID();
    const slot = `service-profile:${source}`;
    const plan = credentials.plan(slot, true);
    credentials.commit(slot, { change: { expected: plan.binding, replacement: plan.replacement } }, plan.binding, base, false);
    credentials.saveServiceProfile(source, "隔离群服务", base);
    credentials.activateService(source);
    const frame = { key: permission, binding: credentials.serviceProfile(source).binding };
    return { sync: () => desktop.sync(source, frame), profiles: (scope: string) => desktop.profiles(source, frame, scope),
      cursor: () => client.setting<{ cursor: string }>(`workspaceFeed:${source}`, { cursor: "" }).cursor,
      page: (cursor: string) => fetch(base + "/api/workspace/feed?cursor=" + encodeURIComponent(cursor),
        { headers: { Authorization: "Bearer " + permission } }).then(response => response.json()) };
  }
  const rawReader = await reader("3001", [scope, otherScope], [scope, otherScope]);
  const summaryReader = await reader("3002", [scope], []);
  const otherReader = await reader("3003", [otherScope], [otherScope]);
  assert.match(JSON.stringify((await rawReader.sync()).items), /橡木坡/u);
  const summaryBefore = await summaryReader.sync();
  const summaryCursor = summaryReader.cursor();
  assert.match(JSON.stringify(summaryBefore.items), /已记录橡木坡/u);
  await otherReader.sync();
  assert.match(JSON.stringify(await summaryReader.profiles(scope)), /画像依赖记号蓝椿/u);
  db.exec("BEGIN");
  for (let index = 0; index < 140; index++) rawSeed.run(otherScope, "2001", `另一群分页样本 ${index}`, profileAt, `fixture-${index}`);
  db.prepare("INSERT INTO group_summaries(scope,first_id,last_id,content,created_at,sample_count) VALUES(?,?,?,?,?,141)")
    .run(otherScope, original.get(otherScope, "51")!.id, original.get(otherScope, "fixture-139")!.id, "另一群的摘要保留。", profileAt);
  db.exec("COMMIT");
  await rawReader.sync();
  await otherReader.sync();
  const otherCursor = otherReader.cursor();
  const rawCursor = rawReader.cursor();
  say(72, [at, { type: "reply", data: { id: "71" } }, text("等我撤回原文再说。")]);
  await until(() => prompts.length === 1);
  assert.match(prompts[0], /橡木坡/u);
  recall(71, 5002);
  recall(71, 5001, 2002);
  await delay(450);
  assert.equal(original.get(scope, "71")!.content, source);
  assert.equal(modelAborted, false);
  recall(71);
  await until(() => modelAborted && !original.get(scope, "71"));
  assert.equal(sends.length, 0);
  assert.doesNotMatch(String(db.prepare("SELECT content FROM group_summaries WHERE scope=?").get(scope)?.content), /橡木坡|蓝椿/u);
  for (const candidate of candidates) {
    const view: Record<string, unknown> | undefined = db.prepare("SELECT summary,status FROM group_profile_candidates WHERE id=?").get(candidate);
    assert.equal(view?.status, "expired");
    assert.equal(view?.summary, "");
  }
  const reset = await rawReader.page(rawCursor);
  assert.equal(reset.reset, true);
  assert.equal(reset.hasMore, true);
  assert.equal((await summaryReader.page(summaryCursor)).reset, true);
  assert.equal((await otherReader.page(otherCursor)).reset, false);
  assert.equal((await rawReader.page(rawCursor.split(".").slice(0, 2).join("."))).hasMore, true);
  const refreshedRaw = await rawReader.sync();
  const refreshedSummary = await summaryReader.sync();
  assert.doesNotMatch(JSON.stringify([refreshedRaw.items, refreshedSummary.items]), /橡木坡|蓝椿/u);
  assert.ok(refreshedRaw.items.some(item => item.kind === "message" && item.message.text === "另一群的原文保留。"));
  assert.equal(refreshedRaw.items.filter(item => item.kind === "message" && item.conversationId === otherScope).length, 141);
  assert.notEqual(refreshedSummary.featureRevision, summaryBefore.featureRevision);
  assert.deepEqual(await summaryReader.profiles(scope), { group: null, members: [] });
  assert.equal((await rawReader.profiles(otherScope))?.group?.summary, "独立画像。");

  await service.stop();
  recall(73);
  const legacy = openQqIngress(ingress, token, "1001");
  assert.ok((await legacy(null, AbortSignal.timeout(1500))).entries.every(entry => entry.message.kind === "group"));
  service = createService();
  await start();
  historyRows = [{ message_id: 73, user_id: 2001, group_id: 5001, time: Math.floor(Date.now() / 1000),
    message: [at, text("这条已先撤回，不应恢复。")] }];
  for (const socket of gateway.clients) socket.terminate();
  await until(async () => (await legacy(null, AbortSignal.timeout(1500))).entries.some(entry =>
    entry.message.messageId === "73" && entry.recoveredAt !== undefined));
  say(73, [at, text("这条已先撤回，不应回复。")]);
  say(74, [at, { type: "reply", data: { id: "71" } }, text("请核对这条引用。")]);
  await until(() => sends.length === 1);
  assert.doesNotMatch(JSON.stringify(prompts.slice(1)), /橡木坡|蓝椿|已先撤回/u);
  assert.deepEqual(JSON.parse(prompts.at(-1)!).quote, { unavailable: true });
  assert.equal(original.get(scope, "73"), undefined);
  assert.ok(Number(original.get(scope, "74")?.id) > Number(id));
  say(75, [text("后来补了一句。")]);
  await until(() => !!original.get(scope, "75"));
  const latest = original.get(scope, "75")!.id;
  recall(75);
  await until(() => !original.get(scope, "75"));
  say(76, [text("新的有效活动。")]);
  await until(() => !!original.get(scope, "76"));
  assert.ok(Number(original.get(scope, "76")!.id) > Number(latest));
});

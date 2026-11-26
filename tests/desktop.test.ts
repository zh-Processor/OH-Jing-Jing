import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { CredentialFrame } from "../runtime/desktop-credentials.js";
import { createPublishedRole } from "../runtime/published-role.js";
import { defaultSummaryReminderPolicy, readSummaryReminderPolicy, summaryReminderQuiet } from "../runtime/summary-reminder-policy.js";

async function openDesktopRuntime(directory: string, packaged = process.env.OHJINGJING_TEST_DESKTOP_PACKAGE, preload?: string) {
  const executable = packaged ? join(packaged, "node.exe") : process.execPath;
  const args = [...(preload ? ["--import", pathToFileURL(preload).href] : []),
    ...(packaged ? [join(packaged, "runtime.mjs"), directory] : ["--import", "tsx", "runtime/main.ts", directory])];
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, timeout: 20_000 });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  await once(child, "spawn");
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let sequence = 0;
  return {
    async rpc(action: string, args: object = {}, key?: string, metadata?: Omit<CredentialFrame, "key">) {
      child.stdin.write(JSON.stringify({ action, args, key, ...metadata }) + "\n");
      const response = await output.next();
      assert.equal(response.done, false, `Desktop runtime exited while handling ${action}`);
      return JSON.parse(response.value!);
    },
    send(action: string, args: object = {}, key?: string, metadata?: Omit<CredentialFrame, "key">) {
      const id = ++sequence;
      child.stdin.write(JSON.stringify({ id, action, args, key, ...metadata }) + "\n");
      return id;
    },
    async nextReply() {
      const response = await output.next();
      assert.equal(response.done, false, "The runtime must keep its IPC connection open");
      return JSON.parse(response.value!);
    },
    async terminate() {
      child.kill();
      await closed;
    },
    async close() {
      child.stdin.end();
      await closed;
      assert.equal(child.exitCode, 0, "Desktop runtime must exit cleanly");
    },
  };
}

test("long desktop conversations generate a local Pi checkpoint without copying it to personal memory", async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "ohjingjing-checkpoint-"));
  const roleId = "ohjingjing.dafeiyu";
  const modelId = "checkpoint-fixture";
  const requests: { scope: "checkpoint" | "chat"; system: string }[] = [];
  const provider = createServer(async (req, res) => {
    const body: Buffer[] = [];
    for await (const part of req) body.push(part);
    const { messages } = JSON.parse(Buffer.concat(body).toString("utf8"));
    const system = messages[0].content;
    const compact = system.includes("整理本机桌宠对话的续聊检查点");
    requests.push({ scope: compact ? "checkpoint" : "chat", system });
    if (compact) {
      const input = JSON.parse(messages[1].content);
      assert.equal(input.lines.length, 8);
      assert.match(input.lines[0].text, /^旧轮1$/u);
      assert.doesNotMatch(messages[1].content, /异角色原文|旧轮9/u);
    }
    const answer = compact ? '{"checkpoint":"旧轮确认需要继续处理。"}' : "我在。";
    res.end(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { prompt_tokens: 25, completion_tokens: 12 } }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const runtime = await openDesktopRuntime(directory);
  const { rpc } = runtime;
  t.after(async () => {
    await runtime.terminate();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), await realpath(tmpdir()));
    await rm(resolved, { recursive: true, force: true });
  });
  assert.equal((await rpc("saveModel", { id: modelId, name: "检查点模型", model: "fixture", hasKey: true,
    baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, contextBudget: 4096 })).ok, true);
  const db = new DatabaseSync(join(directory, "desktop.db"));
  try {
    const insert = db.prepare("INSERT INTO messages(scope,role_id,author,content,created_at) VALUES('desktop',?,?,?,?)");
    const at = new Date().toISOString();
    for (let index = 1; index <= 22; index++) insert.run(roleId, index % 2 ? "user" : "assistant", "旧轮" + index, at);
    insert.run("unrelated.role", "user", "异角色原文", at);
    const send = (text: string) => rpc("chat", { text, roleId, modelId }, "checkpoint-key");
    assert.equal((await send("接着聊。")).ok, true);
    const waitUntil = Date.now() + 3000;
    let checkpoint = db.prepare("SELECT text FROM desktop_checkpoints WHERE role_id=?").get(roleId);
    while (!checkpoint && Date.now() < waitUntil) {
      await delay(25);
      checkpoint = db.prepare("SELECT text FROM desktop_checkpoints WHERE role_id=?").get(roleId);
    }
    assert.equal(checkpoint?.text, "旧轮确认需要继续处理。");
    assert.equal((await send("那就继续。")).ok, true);
    assert.deepEqual(requests.map(entry => entry.scope), ["chat", "checkpoint", "chat"]);
    assert.match(requests.at(-1)!.system, /旧轮确认需要继续处理/u);
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory").get()?.count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM requests WHERE scope='desktop-checkpoint' AND status='ok'").get()?.count, 1);
  } finally { db.close(); }
});

test("role rehearsal uses the selected model and keeps its sample data out of desktop conversations", async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "ohjingjing-role-rehearsal-"));
  const requests: { auth: string | undefined; messages: { role: string; content: string }[] }[] = [];
  const provider = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const { messages } = JSON.parse(Buffer.concat(parts).toString());
    requests.push({ auth: req.headers.authorization, messages });
    const current = messages.at(-1).content;
    const content = current.includes('"trigger":"private-greeting"') ? '{"action":"skip"}'
      : current.includes('"speaker":"测试群友"') ? '{"action":"reply","parts":["一句结论。","补一句说明。"]}'
      : "这是一句试演回复。";
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(async () => {
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const { rpc, close } = await openDesktopRuntime(directory);
  const roleId = "ohjingjing.dafeiyu";
  const modelId = "local-rehearsal";
  const key = "mock-rehearsal-key";
  const preview = (input: object) => rpc("rehearseRole", { roleId, modelId, ...input }, key);
  try {
    assert.equal((await rpc("saveModel", { id: modelId, name: "试演模型", model: "fixture", hasKey: true,
      baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`, currency: "USD" }, key)).ok, true);
    assert.equal((await rpc("saveMemory", { roleId, text: "仅限正式会话的私人偏好" })).ok, true);
    assert.equal((await rpc("setRolePersonality", { roleId, personality: { scenes: { group: "试演使用本地群聊覆盖" } } })).ok, true);
    const before = (await rpc("companionState", { roleId })).value;
    const group = await preview({ scenario: "group", text: "群聊测试消息", reference: "手填样本专案" });
    assert.equal(group.ok, true);
    assert.equal(group.value.scene, "group");
    assert.equal(group.value.role.id, roleId);
    assert.match(group.value.role.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(group.value.parts, ["一句结论。", "补一句说明。"]);
    assert.equal(group.value.reference, "手填样本专案");
    assert.match(requests[0].messages[0].content, /手填样本专案/);
    assert.match(requests[0].messages[0].content, /试演使用本地群聊覆盖/);
    assert.doesNotMatch(JSON.stringify(requests[0].messages), /仅限正式会话的私人偏好/);

    const mood = await preview({ scenario: "mood", text: "心情测试", care: "feed" });
    assert.equal(mood.value.scene, "desktop");
    assert.match(mood.value.reason, /投喂/);
    assert.deepEqual((await rpc("companionState", { roleId })).value, before);
    const greeting = await preview({ scenario: "scheduled", time: "21:00", text: "旧输入不发送", reference: "旧输入不发送" });
    assert.equal(greeting.value.outcome, "skip");
    assert.equal(greeting.value.scene, "private");
    assert.match(requests[2].messages.at(-1)!.content, /21:00/);
    assert.doesNotMatch(JSON.stringify(requests[2]), /旧输入不发送/);
    assert.equal((await preview({ scenario: "private", text: "私聊测试" })).value.scene, "private");
    assert.equal((await preview({ scenario: "desktop", text: "桌面测试" })).value.scene, "desktop");
    assert.equal((await preview({ scenario: "scheduled", time: "64:00" })).ok, false);
    assert.equal((await rpc("saveModelBudget", { modelId, currency: "USD", requests: { daily: 5, monthly: null },
      cost: { daily: null, monthly: null } })).ok, true);
    assert.equal((await preview({ scenario: "desktop", text: "预算用完" })).ok, false);
    assert.deepEqual((await rpc("history", { roleId })).value, []);
    assert.equal(requests.length, 5);
    assert.ok(requests.every(request => request.auth === `Bearer ${key}`));
    assert.equal((await rpc("state")).value.usage[0].requests, 5);
  } finally { await close(); }
  const data = new DatabaseSync(join(directory, "desktop.db"), { readOnly: true });
  try {
    assert.equal(data.prepare("SELECT COUNT(*) AS count FROM requests WHERE scope='role-rehearsal' AND status='ok'").get()?.count, 5);
  } finally { data.close(); }
});

test("desktop chat can cancel while another model operation is waiting, and counts interrupted requests", { timeout: 12_000 }, async (t) => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-desktop-turn-"));
  const held = new Map<string, ServerResponse>();
  const requests: string[] = [];
  const payloads: string[][] = [];
  const responseBody = JSON.stringify({ choices: [{ message: { content: "下次继续聊。" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  const provider = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const messages = JSON.parse(Buffer.concat(parts).toString()).messages;
    const text = messages.at(-1).content;
    requests.push(text);
    payloads.push(messages.map((item: { content: string }) => item.content));
    if (text === "重新发送的消息") res.end(responseBody);
    else held.set(text, res);
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let runtime = await openDesktopRuntime(directory);
  t.after(async () => {
    await runtime.terminate();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), root);
    await rm(resolved, { recursive: true, force: true });
  });
  async function until(check: () => boolean | Promise<boolean>) {
    for (let step = 0; step < 200; step++) {
      if (await check()) return;
      await delay(20);
    }
    assert.fail("The desktop turn did not reach the expected state");
  }
  const modelId = "desktop-turn-model";
  const roleId = "ohjingjing.dafeiyu";
  const key = "turn-fixture-key";
  assert.equal((await runtime.rpc("saveModel", { id: modelId, name: "轮次模型", model: "mock", hasKey: true,
    baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`, inputPrice: 1, outputPrice: 2, currency: "CNY" })).ok, true);
  const args = { id: randomUUID(), roleId, modelId, text: "要停止的草稿" };
  assert.equal((await runtime.rpc("startChat", args, key)).value.status, "running");
  await until(() => held.has(args.text));
  const blocked = runtime.send("testModel", { modelId }, key);
  await until(() => held.has("Reply with OK."));
  const cancellation = runtime.send("cancelChat", { id: args.id });
  assert.deepEqual(await runtime.nextReply(), { id: cancellation, ok: true, value: true });
  await until(async () => {
    const stateCheck = runtime.send("chatTurn");
    const afterCancellation = await runtime.nextReply();
    assert.equal(afterCancellation.id, stateCheck);
    return afterCancellation.value.status === "cancelled";
  });
  const historyCheck = runtime.send("history", { roleId });
  assert.deepEqual(await runtime.nextReply(), { id: historyCheck, ok: true, value: [] });
  held.get("Reply with OK.")!.end(responseBody);
  assert.equal((await runtime.nextReply()).id, blocked);

  const next = { ...args, id: randomUUID(), text: "重新发送的消息" };
  assert.equal((await runtime.rpc("startChat", next, key)).ok, true);
  assert.equal((await runtime.rpc("cancelChat", { id: args.id })).value, false);
  await until(async () => (await runtime.rpc("chatTurn")).value.status === "completed");
  assert.equal((await runtime.rpc("startChat", next, key)).value.status, "completed");
  assert.equal(requests.filter(text => text === next.text).length, 1);
  assert.ok(!payloads[requests.indexOf(next.text)].includes(args.text));
  assert.deepEqual((await runtime.rpc("history", { roleId })).value.map((row: { content: string }) => row.content), [next.text, "下次继续聊。"]);
  assert.equal((await runtime.rpc("state")).value.usage[0].cancelled, 1);

  const interrupted = { ...args, id: randomUUID(), text: "退出时仍在生成" };
  assert.equal((await runtime.rpc("startChat", interrupted, key)).ok, true);
  await until(() => held.has(interrupted.text));
  await runtime.terminate();
  runtime = await openDesktopRuntime(directory);
  assert.equal((await runtime.rpc("chatTurn")).value, null);
  const [usage] = (await runtime.rpc("state")).value.usage;
  assert.equal(usage.requests, 4);
  assert.equal(usage.cancelled, 1);
  assert.equal(usage.interrupted, 1);
  assert.equal(usage.priced_requests, 2);
  assert.deepEqual((await runtime.rpc("history", { roleId })).value.map((row: { content: string }) => row.content), [next.text, "下次继续聊。"]);
});

test("desktop personal chat can switch credentials once and keeps reference explanations on the selected model", { timeout: 12_000 }, async t => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-desktop-backup-"));
  const calls: { text: string; path: string; key: string | undefined }[] = [];
  const held = new Map<string, ServerResponse>();
  const provider = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk);
    const text = JSON.parse(Buffer.concat(parts).toString()).messages.at(-1).content as string;
    const path = req.url ?? "";
    calls.push({ text, path, key: req.headers.authorization });
    const primary = path === "/primary/chat/completions";
    if ((primary && text === "等待期间更换备用凭据") || (!primary && text === "停止备用请求")) {
      held.set(text, res);
      return;
    }
    if (primary) { res.writeHead(text === "明确拒绝" ? 403 : 429).end(); return; }
    res.end(JSON.stringify({ choices: [{ message: { content: "备用模型的回答。" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const runtime = await openDesktopRuntime(directory);
  t.after(async () => {
    await runtime.terminate();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), root);
    await rm(resolved, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const primary = { id: "primary", name: "主模型", model: "mock-primary", baseUrl: origin + "/primary", hasKey: true };
  const spare = { id: "spare", name: "备用模型", model: "mock-spare", baseUrl: origin + "/spare", hasKey: true, inputPrice: 1, outputPrice: 2 };
  const primaryKey = "desktop-primary-fixture";
  const spareKey = "desktop-spare-fixture";
  const roleId = "ohjingjing.dafeiyu";
  const request = (text: string) => ({ id: randomUUID(), roleId, modelId: primary.id, text });
  const plan = async () => (await runtime.rpc("_credentialPlan", { slot: "model:primary", includeBackup: true })).value;
  const credentials = async (key = spareKey) => {
    const { binding, backup } = await plan();
    return { binding, backup: { ...backup, key } };
  };
  async function until(check: () => boolean | Promise<boolean>) {
    for (let step = 0; step < 140; step++) {
      if (await check()) return;
      await delay(20);
    }
    assert.fail("Desktop backup did not reach the expected state");
  }
  const keys = (text: string) => calls.filter(call => call.text.startsWith(text)).map(call => call.key);
  const checkTurn = async (status: string) => until(async () => (await runtime.rpc("chatTurn")).value.status === status);

  assert.equal((await runtime.rpc("saveModel", primary)).ok, true);
  assert.equal((await runtime.rpc("saveModel", spare)).ok, true);
  assert.equal((await plan()).backup, null);
  assert.equal((await runtime.rpc("saveModelBackup", { modelId: primary.id, backupModelId: primary.id })).ok, false);
  assert.equal((await runtime.rpc("saveModelBackup", { modelId: primary.id, backupModelId: spare.id })).ok, true);

  assert.equal((await runtime.rpc("startChat", request("个人聊天切换"), primaryKey, await credentials())).ok, true);
  await checkTurn("completed");
  assert.deepEqual((await runtime.rpc("chatTurn")).value.backup, { name: spare.name, reason: "返回 HTTP 429" });
  assert.deepEqual(keys("个人聊天切换"), [`Bearer ${primaryKey}`, `Bearer ${spareKey}`]);
  assert.deepEqual((await runtime.rpc("history", { roleId })).value.map((entry: { content: string }) => entry.content),
    ["个人聊天切换", "备用模型的回答。"]);

  assert.equal((await runtime.rpc("chat", { ...request("查看群摘要"), context: "仅给本次确认的模型" }, primaryKey, await credentials())).ok, false);
  assert.deepEqual(keys("查看群摘要"), [`Bearer ${primaryKey}`]);
  assert.equal((await runtime.rpc("startChat", request("明确拒绝"), primaryKey, await credentials())).ok, true);
  await checkTurn("failed");
  assert.deepEqual(keys("明确拒绝"), [`Bearer ${primaryKey}`]);

  const cancellation = request("停止备用请求");
  assert.equal((await runtime.rpc("startChat", cancellation, primaryKey, await credentials())).ok, true);
  await until(() => held.has(cancellation.text));
  assert.equal((await runtime.rpc("chatTurn")).value.backup.name, spare.name);
  assert.equal((await runtime.rpc("cancelChat", { id: cancellation.id })).value, true);
  await checkTurn("cancelled");
  assert.deepEqual(keys(cancellation.text), [`Bearer ${primaryKey}`, `Bearer ${spareKey}`]);

  const changed = request("等待期间更换备用凭据");
  assert.equal((await runtime.rpc("startChat", changed, primaryKey, await credentials())).ok, true);
  await until(() => held.has(changed.text));
  const prior = (await runtime.rpc("_credentialPlan", { slot: "model:spare", stage: true })).value;
  assert.equal((await runtime.rpc("saveModel", { ...spare, baseUrl: origin + "/replacement" }, undefined,
    { change: { expected: prior.binding, replacement: prior.replacement } })).ok, true);
  held.get(changed.text)!.writeHead(503).end();
  await checkTurn("failed");
  assert.deepEqual(keys(changed.text), [`Bearer ${primaryKey}`]);

  const freshKey = "desktop-fresh-spare-fixture";
  assert.equal((await runtime.rpc("startChat", request("新凭据切换"), primaryKey, await credentials(freshKey))).ok, true);
  await checkTurn("completed");
  assert.deepEqual(keys("新凭据切换"), [`Bearer ${primaryKey}`, `Bearer ${freshKey}`]);
  assert.equal(calls.at(-1)?.path, "/replacement/chat/completions");
  const state = (await runtime.rpc("state")).value;
  assert.equal(state.models.find((item: { id: string }) => item.id === primary.id).backupModelId, spare.id);
  const usage = state.usage.find((item: { model_id: string }) => item.model_id === spare.id);
  assert.deepEqual([usage.requests, usage.cancelled, usage.priced_requests], [3, 1, 2]);
  assert.doesNotMatch(JSON.stringify(state), /desktop-(?:primary|spare|fresh-spare)-fixture/);
  assert.equal((await runtime.rpc("saveModelBackup", { modelId: primary.id, backupModelId: null })).ok, true);
  assert.equal((await plan()).backup, null);
});

test("desktop budgets guard actual provider attempts across chat, explanations, tests, and failover", { timeout: 12_000 }, async t => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-desktop-budget-"));
  const calls: string[] = [];
  let primaryTest: ServerResponse | undefined;
  const answer = JSON.stringify({ choices: [{ message: { content: "完成" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content;
    calls.push(req.url!);
    if (req.url!.startsWith("/spare/")) res.end(answer);
    else if (text === "Reply with OK.") { primaryTest = res; }
    else res.writeHead(429).end();
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let runtime = await openDesktopRuntime(directory);
  t.after(async () => {
    await runtime.terminate();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), root);
    await rm(resolved, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const profile = { model: "budget-mock", hasKey: true, currency: "USD", inputPrice: 10_000, outputPrice: 40_000 };
  const primary = { ...profile, id: "primary", name: "主档案", baseUrl: url + "/primary" };
  const spare = { ...profile, id: "spare", name: "备用档案", baseUrl: url + "/spare" };
  const key = "budget-fixture-key";
  const request = { roleId: "ohjingjing.dafeiyu", modelId: primary.id, text: "你好" };
  const budget = (modelId: string, daily: number | null, monthly: number | null = null,
      dailyCost: number | null = null, monthlyCost: number | null = null, currency = "USD") =>
    runtime.rpc("saveModelBudget", { modelId, currency, requests: { daily, monthly }, cost: { daily: dailyCost, monthly: monthlyCost } });
  const snapshot = async (id: string) => (await runtime.rpc("state")).value.models.find((model: { id: string }) => model.id === id).budget;
  const chat = async () => {
    const { binding, backup } = (await runtime.rpc("_credentialPlan", { slot: "model:primary", includeBackup: true })).value;
    return runtime.rpc("chat", request, key, { binding, backup: { ...backup, key: "separate-spare-fixture-key" } });
  };
  assert.equal((await runtime.rpc("saveModel", primary)).ok, true);
  assert.equal((await runtime.rpc("saveModel", spare)).ok, true);
  assert.equal((await runtime.rpc("saveModelBackup", { modelId: primary.id, backupModelId: spare.id })).ok, true);
  assert.equal((await budget(primary.id, 0)).ok, true);
  assert.match((await budget(primary.id, 1.5)).error, /非负整数/);
  assert.match((await budget(primary.id, null, null, -1)).error, /非负数字/);
  assert.match((await runtime.rpc("testModel", { modelId: primary.id }, key)).error, /今日本机请求上限/);
  for (const referenceKind of ["summary", "profile"]) {
    assert.match((await runtime.rpc("chat", { ...request, context: "仍可阅读的群资料", referenceKind }, key)).error, /今日本机请求上限/);
  }
  assert.match((await chat()).error, /主档案.*今日本机请求上限/);
  assert.equal(calls.length, 0);
  assert.equal((await snapshot(primary.id)).daily.requests, 0);

  assert.equal((await budget(primary.id, null)).ok, true);
  assert.equal((await budget(spare.id, null, 0)).ok, true);
  assert.match((await chat()).error, /备用档案.*本月本机请求上限/);
  assert.deepEqual(calls, ["/primary/chat/completions"]);
  assert.deepEqual((await snapshot(primary.id)).daily, { requests: 1, cost: 0, unpriced: 1, pending: 0 });
  assert.equal((await budget(spare.id, null, 5, null, 0.3)).ok, true);
  assert.equal((await chat()).value, "完成");
  assert.deepEqual((await snapshot(spare.id)).monthly, { requests: 1, cost: 0.3, unpriced: 0, pending: 0 });
  assert.match((await chat()).error, /备用档案.*本月本机估算费用上限（USD）/);
  assert.equal(calls.filter(path => path.startsWith("/spare/")).length, 1);

  assert.equal((await budget(primary.id, null, null, 1)).ok, true);
  const checkId = runtime.send("testModel", { modelId: primary.id }, key);
  for (let i = 0; i < 200 && !primaryTest; i++) await delay(15);
  assert.ok(primaryTest, "The model test must reach the provider before a second attempt");
  const before = calls.length;
  const turn = { ...request, id: randomUUID() };
  runtime.send("startChat", turn, key);
  const failed = await runtime.nextReply();
  assert.equal(failed.event, "desktop-chat-turn");
  assert.equal(failed.value.status, "running");
  const events = [await runtime.nextReply(), await runtime.nextReply()];
  assert.match(events.find(item => item.event && item.value.status === "failed").value.error, /模型请求在计量/);
  assert.equal(calls.length, before);
  primaryTest.end(answer);
  assert.equal((await runtime.nextReply()).id, checkId);
  assert.deepEqual((await snapshot(primary.id)).daily, { requests: 4, cost: 0.3, unpriced: 3, pending: 0 });

  assert.equal((await runtime.rpc("saveModel", { ...spare, currency: "CNY" })).ok, true);
  const changed = await snapshot(spare.id);
  assert.deepEqual(changed.limits, { requests: { daily: null, monthly: 5 }, cost: { daily: null, monthly: null } });
  assert.deepEqual(changed.monthly, { requests: 1, cost: 0, unpriced: 0, pending: 0 });
  assert.match((await budget(spare.id, 0)).error, /计费币种已变更/);
  assert.equal((await runtime.rpc("saveModel", spare)).ok, true);
  await runtime.close();
  runtime = await openDesktopRuntime(directory);
  assert.equal((await snapshot(spare.id)).limits.cost.monthly, 0.3);
  assert.match((await runtime.rpc("testModel", { modelId: spare.id }, key)).error, /本月本机估算费用上限/);
});

test("desktop extracts evidenced personal memories, and usage and sync follow existing scopes", { timeout: 12_000 }, async t => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-desktop-memory-"));
  const modelKey = "memory-extraction-fixture";
  const readServiceKey = "private-service-fixture";
  const primary = "ohjingjing.dafeiyu";
  const other = "fixture.memory-other";
  const modelId = "memory-model";
  const hobby = "我喜欢听爵士乐。";
  const sensitive = "我曾接受焦虑治疗，希望聊天节奏慢一些。";
  const routine = "我平时喜欢跑步。";
  const medical = "我每周去心理门诊。";
  const walking = "我喜欢散步。";
  const badSecret = "fixture-code-not-a-real-secret";
  const uploads: { authorization: string | undefined; path: string; data: any }[] = [];
  const extracts: { line: number; text: string }[][] = [];
  const dialogue: { role: string; content: string }[][] = [];
  const suggested = (line: number, quote: string, text = quote) => ({ line, quote, text, kind: "preference" });
  let malformed = false;
  let pauseExtraction = false;
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url?.startsWith("/api/private-memory/")) {
      uploads.push({ path: req.url, authorization: req.headers.authorization, data: payload });
      res.end(JSON.stringify({ version: 1 }));
      return;
    }
    let text = "这些是模拟模型的普通回复，不作为用户证据。";
    if (payload.messages[0].content.startsWith("为当前用户提取长期个人记忆候选")) {
      const rows: { line: number; text: string }[] = JSON.parse(payload.messages[1].content);
      extracts.push(rows);
      const items = rows.flatMap(({ line, text }) =>
        text === hobby || text === routine || text === sensitive || text === medical || text === walking ? [suggested(line, text)] :
          text.includes("[凭据]") ? [suggested(line, "原文里没有的凭据内容")] : []);
      text = malformed ? "模型未遵守输出格式" : JSON.stringify({ items });
    } else dialogue.push(payload.messages);
    const reply = JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    if (pauseExtraction && payload.messages[0].content.startsWith("为当前用户提取长期个人记忆候选")) {
      provider.emit("paused-memory", () => res.end(reply));
    } else res.end(reply);
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let runtime = await openDesktopRuntime(directory);
  t.after(async () => {
    await runtime.terminate();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), root);
    await rm(resolved, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const rpc = (action: string, args: object = {}, key?: string) => runtime.rpc(action, args, key);
  const act = async (action: string, args: object = {}, key?: string) => {
    const result = await rpc(action, args, key);
    assert.equal(result.ok, true, result.error);
    return result.value;
  };
  const chat = (text: string, roleId = primary, context?: string) => act("chat", { roleId, modelId, text, context }, modelKey);
  const review = (roleId = primary) => act("memoryReview", { roleId });
  const extract = () => rpc("extractMemory", { roleId: primary, modelId }, modelKey);
  const decide = (id: number, accept: boolean, text?: string, roleId = primary) =>
    rpc("decideMemoryCandidate", { roleId, id, accept, text });
  const budget = (daily: number | null) => act("saveModelBudget", { modelId, currency: "USD",
    requests: { daily, monthly: null }, cost: { daily: null, monthly: null } });
  const list = (roleId = primary) => act("listMemory", { roleId });

  await act("saveModel", { id: modelId, name: "记忆测试", model: "memory-fixture", baseUrl: origin, currency: "USD", hasKey: true });
  await act("createRole", { id: other, name: "独立角色", version: "1.0.0", persona: "平静地对话。" });
  await act("saveService", { address: origin });
  await act("syncPreferences", { push: true, pull: false });
  assert.deepEqual(await review(), { candidates: [], autoAccept: false, ready: false });
  await chat(hobby);
  await chat(sensitive);
  await chat(`密码：${badSecret}`);
  await chat("另一个角色的私聊资料", other);
  await chat("解释群摘要", primary, "群资料不会进入提取");
  assert.equal((await review()).ready, true);
  assert.deepEqual((await extract()).value, { accepted: 0, proposed: 2 });
  assert.deepEqual(extracts[0].map(row => row.text), [hobby, sensitive, "[凭据]"]);
  const [reviewSensitive, reviewHobby] = (await review()).candidates;
  assert.equal(reviewHobby.excerpt, hobby);
  assert.equal(reviewSensitive.excerpt, sensitive);
  assert.deepEqual((await review(other)).candidates, []);
  assert.equal((await decide(reviewHobby.id, true, undefined, other)).ok, false);
  assert.deepEqual(await act("pushMemory", { roleId: primary }, readServiceKey), { uploaded: 0 });
  assert.deepEqual(await list(), []);
  assert.equal((await decide(reviewSensitive.id, false)).ok, true);
  assert.equal((await decide(reviewHobby.id, true, "我喜欢在晚上听爵士乐。")).ok, true);
  assert.equal((await decide(reviewHobby.id, true)).ok, false);
  assert.deepEqual((await list()).map((row: { text: string }) => row.text), ["我喜欢在晚上听爵士乐。"]);
  assert.deepEqual(await act("pushMemory", { roleId: primary }, readServiceKey), { uploaded: 1 });
  assert.equal(uploads[0].authorization, `Bearer ${readServiceKey}`);
  assert.match(uploads[0].path, /^\/api\/private-memory\/ohjingjing\.dafeiyu\//u);
  assert.deepEqual(uploads[0].data, { text: "我喜欢在晚上听爵士乐。", baseVersion: 0 });
  assert.deepEqual((await extract()).value, { accepted: 0, proposed: 0 });
  assert.equal(extracts.length, 1);

  await act("setMemoryAutoAccept", { roleId: primary, enabled: true });
  await chat(routine);
  await chat(medical);
  await budget(0);
  assert.match((await extract()).error, /本机请求上限/);
  assert.equal(extracts.length, 1);
  await budget(null);
  malformed = true;
  assert.match((await extract()).error, /可核对的记忆格式/);
  assert.equal((await review()).ready, true);
  malformed = false;
  assert.deepEqual((await extract()).value, { accepted: 1, proposed: 1 });
  assert.equal(extracts.length, 3);
  assert.equal((await act("state")).usage[0].requests, 10);
  await runtime.close();
  runtime = await openDesktopRuntime(directory);
  const after = await review();
  assert.equal(after.autoAccept, true);
  assert.equal(after.ready, false);
  assert.deepEqual(after.candidates.map((item: { text: string }) => item.text), [medical]);
  assert.deepEqual(await list(other), []);
  await chat("检查已保存的记忆");
  assert.match(dialogue.at(-1)![0].content, /我平时喜欢跑步。/);
  assert.doesNotMatch(dialogue.at(-1)![0].content, /心理门诊|焦虑治疗/);
  await chat(walking);
  pauseExtraction = true;
  const held = once(provider, "paused-memory");
  const extraction = runtime.send("extractMemory", { roleId: primary, modelId }, modelKey);
  const [release] = await held as [() => void];
  const settingsRuntime = await openDesktopRuntime(directory);
  try {
    const changed = await settingsRuntime.rpc("saveModel", { id: modelId, name: "记忆测试", model: "changed-memory-fixture", baseUrl: origin,
      currency: "USD", hasKey: true });
    assert.equal(changed.ok, true, changed.error);
  } finally {
    await settingsRuntime.close();
    release();
  }
  const stale = await runtime.nextReply();
  assert.equal(stale.id, extraction);
  assert.match(stale.error, /角色或模型配置已更新/u);
  assert.equal((await review()).ready, true);
  assert.ok(!(await list()).some((row: { text: string }) => row.text === walking));
  pauseExtraction = false;
  assert.deepEqual((await extract()).value, { accepted: 1, proposed: 0 });
});

test("a desktop interaction review offers an evidenced reminder and a separate memory candidate", { timeout: 15_000 }, async t => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-interaction-review-"));
  const roleId = "ohjingjing.dafeiyu";
  const otherRole = "fixture.interaction-other";
  const modelId = "interaction-fixture";
  const key = "synthetic-personal-key";
  const hobby = "我喜欢听爵士乐。";
  const followUp = "我明天还要把桌游规则发给朋友。";
  const assistantText = "我先替你约一局。";
  const recapText = "聊了爵士乐，也提到要发桌游规则。";
  const prompts: { interaction: { line: number; speaker: string; text: string }[];
    followUpSources: { ref: string; text: string }[]; pendingMemory: { line: number; text: string }[] }[] = [];
  let malformed = true;
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const messages = JSON.parse(Buffer.concat(chunks).toString()).messages;
    let text = assistantText;
    if (messages[0].content.startsWith("复盘一位用户与桌宠")) {
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      const prompt = JSON.parse(messages[1].content) as typeof prompts[number];
      prompts.push(prompt);
      text = JSON.stringify({ overview: recapText,
        followUpRefs: [prompt.followUpSources.find(row => row.text === followUp)?.ref, "T999", 1], items: malformed ? "invalid" : [
        { line: prompt.pendingMemory.find(row => row.text === hobby)?.line, quote: hobby, text: hobby, kind: "preference" },
        { line: 1, quote: assistantText, text: assistantText, kind: "other" },
      ] });
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 19, completion_tokens: 9 } }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let runtime = await openDesktopRuntime(directory);
  t.after(async () => {
    await runtime.terminate();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), root);
    await rm(resolved, { recursive: true, force: true });
  });
  const act = async (action: string, args: object = {}, secret?: string) => {
    const response = await runtime.rpc(action, args, secret);
    assert.equal(response.ok, true, response.error);
    return response.value;
  };
  const model = { id: modelId, name: "复盘模型", model: modelId, hasKey: true,
    baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}` };
  await act("saveModel", model);
  await act("createRole", { id: otherRole, name: "独立角色", version: "1.0.0", persona: "轻声问好。" });
  await act("setMemoryAutoAccept", { roleId, enabled: true });
  assert.deepEqual(await act("interactionReview", { roleId }), { ready: false, recap: null, pendingMemory: 0 });
  await act("chat", { roleId, modelId, text: hobby }, key);
  await act("chat", { roleId, modelId, text: followUp }, key);
  await act("chat", { roleId, modelId, text: "密码：synthetic-uncited-value" }, key);
  await act("chat", { roleId: otherRole, modelId, text: "另一个角色的私聊" }, key);
  await act("chat", { roleId, modelId, text: "讲讲授权群聊", context: "群资料仅供本次讲解" }, key);

  const generate = () => runtime.rpc("generateInteractionReview", { roleId, modelId }, key);
  assert.equal((await generate()).ok, false);
  assert.deepEqual(await act("interactionReview", { roleId }), { ready: true, recap: null, pendingMemory: 0 });
  assert.equal((await act("memoryReview", { roleId })).ready, true);
  malformed = false;
  const generated = await generate();
  assert.equal(generated.ok, true, generated.error);
  const { recap, pendingMemory } = generated.value;
  assert.equal(recap.overview, recapText);
  assert.deepEqual(recap.followUps, [followUp]);
  assert.equal(pendingMemory, 1);
  assert.deepEqual(prompts.at(-1)?.pendingMemory.map(row => row.text), [hobby, followUp, "[凭据]"]);
  assert.deepEqual(prompts.at(-1)?.followUpSources.map(row => row.text), [hobby, followUp]);
  assert.doesNotMatch(JSON.stringify(prompts), /另一个角色|群资料|synthetic-uncited-value/);
  assert.deepEqual(await act("listMemory", { roleId }), []);
  assert.deepEqual(await act("history", { roleId }), prompts.at(-1)?.interaction.map(row => ({
    role: row.speaker, content: row.text === "[凭据]" ? "密码：synthetic-uncited-value" : row.text,
  })));
  assert.deepEqual((await act("localReminders")).items, []);
  const reminder = { roleId, revision: recap.revision, index: 0, dueAt: Date.now() + 120_000, requestId: randomUUID(), text: "伪造的提醒" };
  await act("createInteractionReviewReminder", reminder);
  await act("createInteractionReviewReminder", reminder);
  assert.deepEqual((await act("localReminders")).items.map((item: { text: string }) => item.text), [followUp]);
  const [memory] = (await act("memoryReview", { roleId })).candidates;
  assert.equal(memory.excerpt, hobby);
  await act("decideMemoryCandidate", { roleId, id: memory.id, accept: true });
  assert.deepEqual((await act("listMemory", { roleId })).map((item: { text: string }) => item.text), [hobby]);

  await runtime.close();
  runtime = await openDesktopRuntime(directory);
  assert.deepEqual((await act("interactionReview", { roleId })).recap, recap);
  assert.deepEqual((await generate()).value.recap, recap);
  assert.equal(prompts.length, 2);
  assert.equal((await act("interactionReview", { roleId: otherRole })).recap, null);
  const db = new DatabaseSync(join(directory, "desktop.db"));
  try {
    assert.deepEqual(db.prepare("SELECT status,input_tokens,output_tokens FROM requests WHERE scope='desktop-interaction-review' ORDER BY id").all()
      .map(row => [row.status, row.input_tokens, row.output_tokens]), [["failed", 19, 9], ["ok", 19, 9]]);
    db.prepare("UPDATE messages SET created_at=? WHERE scope='desktop' AND role_id=?").run(
      new Date(Date.now() - 25 * 60 * 60_000).toISOString(), roleId);
  } finally { db.close(); }
  assert.deepEqual(await act("interactionReview", { roleId }), { ready: false, recap: null, pendingMemory: 0 });
  assert.match((await runtime.rpc("createInteractionReviewReminder", { ...reminder, requestId: randomUUID() })).error, /互动复盘已更新/);
});

test("an editable downloaded memory stays with its service subscription and uses the approved base version", async t => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-desktop-memory-link-"));
  const roleId = "ohjingjing.dafeiyu";
  const remote = { id: randomUUID(), version: 4, text: "来自服务端的初始记忆" };
  const firstKey = "same-owner-original-fixture";
  const secondKey = "different-subscription-fixture";
  const writes: { path: string; auth: string | undefined; data: any }[] = [];
  let system = "";
  const provider = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.end(JSON.stringify({ items: req.headers.authorization === `Bearer ${firstKey}` ? [remote] : [] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (req.method === "PUT") {
      writes.push({ path: req.url ?? "", auth: req.headers.authorization, data });
      res.end(JSON.stringify({ version: remote.version + 1 }));
      return;
    }
    system = data.messages[0].content;
    res.end(JSON.stringify({ choices: [{ message: { content: "好。" } }] }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const runtime = await openDesktopRuntime(directory);
  t.after(async () => {
    await runtime.terminate();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), root);
    await rm(resolved, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const act = async (action: string, args: object, key?: string) => {
    const result = await runtime.rpc(action, args, key);
    assert.equal(result.ok, true, result.error);
    return result.value;
  };
  const request = { roleId };
  await act("saveService", { address: origin });
  await act("saveModel", { id: "linked-model", name: "联调模型", model: "test", baseUrl: origin, hasKey: true });
  await act("syncPreferences", { push: true, pull: true });
  const preview = await act("previewMemory", request, firstKey);
  await act("applyMemory", { ...request, revision: preview.revision }, firstKey);
  const download = { ...request, ...preview.items[0], expectedLocalText: null };
  assert.equal((await runtime.rpc("downloadMemory", { ...download, version: 3 }, firstKey)).ok, false);
  await act("downloadMemory", download, firstKey);
  assert.equal((await runtime.rpc("downloadMemory", download, firstKey)).ok, false);
  assert.deepEqual(await act("pushMemory", request, firstKey), { uploaded: 0 });
  const [local] = await act("listMemory", request);
  await act("saveMemory", { ...request, id: local.id, text: "本机编辑的同一条记忆" });
  await act("chat", { ...request, modelId: "linked-model", text: "检查记忆" }, "model-fixture");
  assert.match(system, /本机编辑的同一条记忆/);
  assert.doesNotMatch(system, /来自服务端的初始记忆/);
  assert.deepEqual(await act("pushMemory", request, firstKey), { uploaded: 1 });
  assert.deepEqual(writes[0], { path: `/api/private-memory/${roleId}/${remote.id}`, auth: `Bearer ${firstKey}`,
    data: { baseVersion: 4, text: "本机编辑的同一条记忆" } });
  await act("saveService", { address: origin });
  await act("syncPreferences", { push: true, pull: true });
  assert.deepEqual(await act("pushMemory", request, secondKey), { uploaded: 0 });
  assert.equal(writes.length, 1);
  assert.equal((await act("listMemory", request))[0].text, "本机编辑的同一条记忆");
});

test("desktop runs independently and confines summary explanation to one request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-desktop-"));
  const requests: { key: string | undefined; payload: any }[] = [];
  const uploaded: { text: string | null; baseVersion: number }[] = [];
  let cloudDeleted = false;
  let conflict = false;
  const remoteIds: string[] = [];
  const groupId = "qq:1001:5001";
  const serverRole = { id: "test.other", name: "群机器人", version: "1.0.0", persona: "群角色初始版本",
    personality: { scenes: { reference: "群角色讲解规则" } } };
  let published = createPublishedRole(serverRole);
  let publicRole = true;
  const model = createServer(async (req, res) => {
    if (req.url === `/api/groups/${groupId}/role`) {
      assert.equal(req.headers.authorization, "Bearer mock-sync-token");
      res.setHeader("Content-Type", "application/json");
      res.statusCode = publicRole ? 200 : 404;
      res.end(JSON.stringify(publicRole ? published : {}));
      return;
    }
    if (req.url === "/api/groups" || req.url === "/api/me" || req.url === "/api/groups/qq:1001:5001/members") {
      assert.equal(req.headers.authorization, "Bearer mock-sync-token");
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/groups") {
        res.end(JSON.stringify({ groups: [{ id: groupId, publishedRole: publicRole ? published.info : undefined, summaries: [
          { id: 2, content: "近期摘要", topics: [{ title: "周末解谜", coverage: "complete",
            facts: [{ kind: "decision", text: "定在周日晚上八点。" }] }] }, { id: 1, content: "历史摘要" },
        ] }] }));
      } else if (req.url === "/api/me") {
        res.end(JSON.stringify({ profile: { displayName: "我", summary: "本人画像" } }));
      } else {
        res.end(JSON.stringify({ items: [{ id: "test-member", displayName: "群友", summary: "群友画像" }] }));
      }
      return;
    }
    if (req.url?.startsWith("/api/private-memory/")) {
      assert.equal(req.headers.authorization, "Bearer mock-sync-token");
      res.setHeader("Content-Type", "application/json");
      if (req.method === "PUT") {
        let body = "";
        for await (const part of req) body += part;
        const payload = JSON.parse(body);
        const recordId = req.url.split("/").at(-1)!;
        if (conflict && recordId === remoteIds[0]) {
          res.statusCode = 409;
          res.end(JSON.stringify({ version: 2 }));
          return;
        }
        remoteIds.push(recordId);
        uploaded.push(payload);
        if (uploaded.at(-1)?.text === null) cloudDeleted = true;
        res.end(JSON.stringify({ version: uploaded.length }));
      } else {
        res.end(JSON.stringify({ items: conflict ? [
          { id: remoteIds[0], version: 2, text: "另一台设备的编辑" },
        ] : cloudDeleted ? [] : [
          { id: "12345678-1234-1234-1234-123456789abc", version: 1, text: "从服务端拉取的记忆" },
        ] }));
      }
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ key: req.headers.authorization, payload: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { content: "收到，我来陪你。" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const baseUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
  let closeRuntime: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await closeRuntime?.(); }
    finally {
      await new Promise<void>(resolve => model.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  const { rpc, close } = await openDesktopRuntime(directory);
  closeRuntime = close;
  const profile = {
    id: "desk", name: "mock", model: "mock", baseUrl, billing: "none",
    inputPrice: 1, outputPrice: 2, currency: "USD", hasKey: true,
  };
  assert.deepEqual((await rpc("state")).value.models, []);
  assert.equal((await rpc("saveService", { address: baseUrl })).ok, true);
  assert.equal((await rpc("groups")).ok, false);
  const feed = await rpc("groups", {}, "mock-sync-token");
  assert.deepEqual(feed.value.groups[0].summaries.map((item: { content: string }) => item.content),
    ["近期摘要", "历史摘要"]);
  assert.equal(feed.value.groups[0].summaries[0].topics[0].facts[0].text, "定在周日晚上八点。");
  assert.equal((await rpc("self", {}, "mock-sync-token")).value.profile.summary, "本人画像");
  assert.equal((await rpc("members", { groupId: "qq:1001:5001" }, "mock-sync-token")).value.items[0].summary, "群友画像");
  assert.equal((await rpc("saveModel", profile)).ok, true);
  assert.equal((await rpc("saveModel", { ...profile, reusingKey: true, baseUrl: "https://models.example.com/v1" })).ok, false);
  assert.equal((await rpc("saveService", { address: "https://groups.example.com" })).ok, true);
  assert.equal((await rpc("saveService", { address: "https://other.example.com", reusingKey: true })).ok, false);
  const roleId = "ohjingjing.dafeiyu";
  const session = { roleId, modelId: "desk" };
  assert.match((await rpc("chat", { ...session, text: "你好" })).error, /自己的 API Key/);
  assert.match((await rpc("chat", { ...session, text: "讲讲摘要", context: "历史摘要" })).error, /自己的 API Key/);
  assert.match((await rpc("testModel", { modelId: "desk" }, " ")).error, /自己的 API Key/);
  assert.equal(requests.length, 0);
  assert.equal((await rpc("saveMemory", { roleId, text: "我喜欢夜间听爵士乐。" })).ok, true);
  const [{ id }] = (await rpc("listMemory", { roleId })).value;
  const other = { id: "test.other", name: "另一个角色", version: "1.0.0", persona: "陪伴" };
  assert.equal((await rpc("saveRole", other)).ok, true);
  assert.deepEqual((await rpc("listMemory", { roleId: other.id })).value, []);
  assert.equal((await rpc("deleteMemory", { roleId: other.id, id })).ok, false);
  assert.equal((await rpc("setRolePersonality", { roleId, personality: { traits: { humor: 6 } } })).ok, false);
  const personality = { traits: { humor: 1 }, scenes: { desktop: "只在本地用朴素短句", group: "群聊专属规则", reference: "讲解专属规则" } };
  assert.deepEqual((await rpc("setRolePersonality", { roleId, personality })).value.personality, personality);
  assert.deepEqual((await rpc("state")).value.roles.find((item: { id: string }) => item.id === roleId).personality, personality);
  assert.equal((await rpc("state")).value.roles.find((item: { id: string }) => item.id === other.id).personality, undefined);
  assert.equal((await rpc("chat", { ...session, text: "你好" }, "mock-desk-token")).ok, true);
  assert.equal((await rpc("saveMemory", { roleId, id, text: "我喜欢夜间听古典乐。" })).ok, true);
  assert.equal((await rpc("chat", { ...session, text: "讲讲摘要", context: "群在聊新游戏" }, "mock-desk-token")).ok, true);
  assert.equal((await rpc("setRolePersonality", { roleId, personality: null })).value.personality.traits.humor, 4);
  assert.equal((await rpc("chat", { ...session, text: "晚安" }, "mock-desk-token")).ok, true);
  const history = await rpc("history", { roleId });
  assert.deepEqual(history.value.filter((message: any) => message.role === "user").map((message: any) => message.content), ["你好", "晚安"]);
  assert.equal(requests[0].key, "Bearer mock-desk-token");
  assert.match(JSON.stringify(requests[0].payload), /夜间听爵士乐/);
  assert.match(requests[0].payload.messages[0].content, /使用朴素表达[\s\S]+只在本地用朴素短句/);
  assert.doesNotMatch(requests[0].payload.messages[0].content, /群聊专属规则|讲解专属规则/);
  assert.match(JSON.stringify(requests[1].payload), /群在聊新游戏/);
  assert.match(requests[1].payload.messages[0].content, /讲解专属规则/);
  assert.doesNotMatch(requests[1].payload.messages[0].content, /只在本地用朴素短句|群聊专属规则/);
  assert.doesNotMatch(JSON.stringify(requests[1].payload), /爵士乐|古典乐/);
  assert.match(JSON.stringify(requests[2].payload), /夜间听古典乐/);
  assert.match(requests[2].payload.messages[0].content, /善用双关或自嘲/);
  assert.equal((await rpc("deleteMemory", { roleId, id })).ok, true);
  assert.doesNotMatch(JSON.stringify(requests[2].payload), /群在聊新游戏|讲讲摘要/);
  assert.equal((await rpc("saveModel", { ...profile, inputPrice: null, outputPrice: null })).ok, true);
  assert.equal((await rpc("chat", { ...session, text: "明天见" }, "mock-desk-token")).ok, true);
  assert.doesNotMatch(JSON.stringify(requests[3].payload), /爵士乐|古典乐/);
  const state = await rpc("state");
  assert.doesNotMatch(JSON.stringify(state), /mock-desk-token/);
  const [usage] = state.value.usage;
  assert.equal(usage.model_id, "desk");
  assert.equal(usage.requests, 4);
  assert.equal(usage.priced_requests, 3);
  assert.equal(usage.input_tokens, 40);
  assert.ok(Math.abs(usage.estimated_cost - 0.00006) < 1e-10);
  const connection = await rpc("testModel", { modelId: "desk" }, "mock-desk-token");
  assert.equal(connection.value.hasText, true);
  assert.deepEqual(requests[4].payload.messages, [{ role: "user", content: "Reply with OK." }]);
  assert.equal(requests[4].payload.max_tokens, 64);
  assert.equal((await rpc("state")).value.usage[0].requests, 5);
  assert.equal((await rpc("saveService", { address: baseUrl })).ok, true);
  assert.equal((await rpc("previewMemory", { roleId }, "mock-sync-token")).ok, false);
  assert.equal((await rpc("pushMemory", { roleId }, "mock-sync-token")).ok, false);
  await rpc("syncPreferences", { push: true, pull: false });
  await rpc("saveMemory", { roleId, text: "桌宠本地记忆" });
  assert.equal((await rpc("pushMemory", { roleId }, "mock-sync-token")).value.uploaded, 1);
  assert.equal((await rpc("pushMemory", { roleId }, "mock-sync-token")).value.uploaded, 0);
  assert.deepEqual(uploaded, [{ baseVersion: 0, text: "桌宠本地记忆" }]);
  await rpc("syncPreferences", { push: false, pull: true });
  assert.equal((await rpc("pushMemory", { roleId }, "mock-sync-token")).ok, false);
  const preview = (await rpc("previewMemory", { roleId }, "mock-sync-token")).value;
  assert.equal((await rpc("applyMemory", { roleId, revision: "invalid" }, "mock-sync-token")).ok, false);
  await rpc("chat", { ...session, text: "预览后" }, "mock-desk-token");
  assert.doesNotMatch(JSON.stringify(requests.at(-1)?.payload), /从服务端拉取的记忆/);
  assert.equal((await rpc("applyMemory", { roleId, revision: preview.revision }, "mock-sync-token")).ok, true);
  await rpc("chat", { ...session, text: "确认后" }, "mock-desk-token");
  assert.match(JSON.stringify(requests.at(-1)?.payload), /从服务端拉取的记忆/);
  assert.equal((await rpc("deleteRemoteMemory", { roleId, ...preview.items[0] }, "mock-sync-token")).ok, false);
  await rpc("syncPreferences", { push: true, pull: true });
  assert.equal((await rpc("deleteRemoteMemory", { roleId, ...preview.items[0] }, "mock-sync-token")).ok, true);
  assert.deepEqual(uploaded.at(-1), { baseVersion: 1, text: null });
  assert.deepEqual((await rpc("previewMemory", { roleId }, "mock-sync-token")).value.items, []);
  assert.equal((await rpc("listMemory", { roleId })).value[0].text, "桌宠本地记忆");
  await rpc("syncPreferences", { push: false, pull: false });
  await rpc("chat", { ...session, text: "关闭后" }, "mock-desk-token");
  assert.doesNotMatch(JSON.stringify(requests.at(-1)?.payload), /从服务端拉取的记忆/);
  const [local] = (await rpc("listMemory", { roleId })).value;
  await rpc("syncPreferences", { push: true, pull: true });
  await rpc("saveMemory", { roleId, id: local.id, text: "当前设备的编辑" });
  conflict = true;
  assert.equal((await rpc("pushMemory", { roleId }, "mock-sync-token")).ok, false);
  const conflictPreview = (await rpc("previewMemory", { roleId }, "mock-sync-token")).value.items[0];
  assert.equal(conflictPreview.text, "另一台设备的编辑");
  assert.equal(conflictPreview.localText, "当前设备的编辑");
  assert.equal((await rpc("forkMemoryConflict", { roleId, ...conflictPreview, version: 1 }, "mock-sync-token")).ok, false);
  assert.equal((await rpc("forkMemoryConflict", { roleId, ...conflictPreview }, "mock-sync-token")).ok, true);
  assert.equal((await rpc("pushMemory", { roleId }, "mock-sync-token")).value.uploaded, 1);
  assert.notEqual(remoteIds.at(-1), remoteIds[0]);
  assert.deepEqual(uploaded.at(-1), { baseVersion: 0, text: "当前设备的编辑" });
  assert.equal((await rpc("chat", { ...session, text: "介绍这位群友", context: "群友简介：周末打球", referenceKind: "profile" }, "mock-desk-token")).ok, true);
  assert.match(JSON.stringify(requests.at(-1)?.payload), /群友简介：周末打球/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)?.payload), /当前设备的编辑|另一台设备的编辑/);
  assert.equal((await rpc("createRole", other)).ok, false);
  assert.equal((await rpc("createRole", { ...other, id: "local.selected" })).ok, true);
  const firstRevision = published.info.revision;
  const first = { groupId, revision: firstRevision };
  const sync = "mock-sync-token";
  const localKey = "mock-desk-token";
  assert.deepEqual((await rpc("previewGroupRole", first, sync)).value.info, published.info);
  assert.equal((await rpc("groups", {}, sync)).value.groups[0].followedRole, undefined);
  assert.equal((await rpc("followGroupRole", first, sync)).ok, true);
  const install = (await rpc("installGroupRole", first, sync)).value;
  assert.notEqual(install.id, serverRole.id);
  assert.equal((await rpc("installGroupRole", first, sync)).value.id, install.id);
  assert.equal((await rpc("state")).value.roles.find((item: { id: string }) => item.id === other.id).persona, other.persona);
  published = createPublishedRole({ ...serverRole, version: "1.1.0", persona: "群角色更新版本" });
  const versions = (await rpc("groups", {}, sync)).value.groups[0];
  assert.equal(versions.publishedRole.version, "1.1.0");
  assert.equal(versions.followedRole.version, "1.0.0");
  assert.equal((await rpc("followGroupRole", first, sync)).ok, false);
  const followChat = { ...session, groupId, groupRoleRevision: firstRevision, text: "讲解群动态" };
  assert.equal((await rpc("chat", followChat, localKey)).ok, false);
  assert.equal((await rpc("chat", { ...followChat, context: "群消息摘要" }, localKey)).ok, true);
  assert.equal(requests.at(-1)?.key, "Bearer mock-desk-token");
  assert.match(requests.at(-1)?.payload.messages[0].content, /群角色初始版本[\s\S]+群角色讲解规则/);
  await rpc("followGroupRole", { groupId, revision: published.info.revision }, sync);
  assert.equal((await rpc("chat", { ...followChat, context: "群消息摘要" }, localKey)).ok, false);
  publicRole = false;
  assert.equal((await rpc("groups", {}, sync)).value.groups[0].followedRole, undefined);
  assert.equal((await rpc("chat", { ...followChat, context: "群消息摘要", groupRoleRevision: published.info.revision }, localKey)).ok, false);
  assert.equal((await rpc("state")).value.roles.find((item: { id: string }) => item.id === install.id).name, serverRole.name);
  assert.deepEqual((await rpc("history", { roleId })).value.filter((message: any) => message.role === "user").map((message: any) => message.content),
    ["你好", "晚安", "明天见", "预览后", "确认后", "关闭后"]);
  assert.equal((await rpc("resetCompanion", { roleId })).value.mood.joy, 59);
  const careEvent = { roleId, kind: "pet", eventId: "12345678-1234-1234-1234-123456789abc" };
  const requestCount = requests.length;
  assert.equal((await rpc("petCare", careEvent)).value.changed, true);
  assert.equal((await rpc("petCare", careEvent)).value.changed, false);
  assert.ok((await rpc("companionState", { roleId })).value.mood.joy > 72);
  assert.equal((await rpc("companionState", { roleId: other.id })).value.mood.joy, 55);
  assert.equal(requests.length, requestCount);
  assert.equal((await rpc("chat", { ...session, text: "摸摸后的对话" }, localKey)).ok, true);
  assert.match(requests.at(-1)?.payload.messages[0].content, /心情轻松/);
  assert.equal((await rpc("chat", { ...session, text: "讲摘要", context: "群消息摘要" }, localKey)).ok, true);
  assert.doesNotMatch(requests.at(-1)?.payload.messages[0].content, /相处状态|心情轻松/);
});

test("summary and member explanations retain authorization and personal credentials through DSH and fallback", async (t) => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-summary-explanation-"));
  const groupId = "qq:1001:5001";
  const otherId = "qq:1001:5002";
  const roleId = "ohjingjing.dafeiyu";
  const modelKey = "fixture-personal-model-key";
  const subscriptionKey = "fixture-group-subscription-key";
  const groupRole = createPublishedRole({ id: "fixture.guide", name: "群讲解角色", version: "1.0.0", persona: "专属群讲解口吻" });
  const summaryTime = "2026-11-25T08:00:00Z";
  const selectedSummary = { id: 7, content: "本群约了周末解谜。", created_at: summaryTime };
  const secondSummary = { ...selectedSummary, content: "其他群的排练安排。" };
  const selectedMember = { id: "a".repeat(64), displayName: "发布称呼", summary: "在群里说喜欢合作解谜。",
    revision: "published-version-1", updatedAt: summaryTime, privateMemory: "服务私有字段" };
  const secondMember = { id: "b".repeat(64), displayName: "另一位群友", summary: "选择的画像之外的简介" };
  const expiredTopic = { title: "旧话题", content: "失去依据的变更。", coverage: "expired",
    facts: [{ text: "失去依据的最后决定", kind: "change" }] };
  const visibleProfile = "只有单次同意才可发送的公开画像";
  const ownMemory = "仅保存在客户端的私有记忆";
  let current = selectedSummary;
  let canReadGroup = true;
  let revokeOnModel = false;
  let revokeMemberOnModel = false;
  let currentMembers = [selectedMember, secondMember];
  let profileReads = 0;
  let dshCalls = 0;
  const prompts: string[] = [];
  const upstream = createServer(async (req, res) => {
    if (req.url?.startsWith("/api/")) {
      assert.equal(req.headers.authorization, `Bearer ${subscriptionKey}`);
      if (req.url === "/api/me") {
        profileReads++;
        res.end(JSON.stringify({ profile: { displayName: "测试用户", summary: visibleProfile } }));
      } else if (req.url === `/api/groups/${groupId}/role`) {
        res.end(JSON.stringify(groupRole));
      } else if (req.url === `/api/groups/${groupId}/members`) {
        res.end(JSON.stringify({ items: currentMembers }));
      } else if (req.url === `/api/groups/${otherId}/members`) {
        res.writeHead(404).end("{}");
      } else {
        assert.equal(req.url, "/api/groups");
        res.end(JSON.stringify({ groups: [
          ...(canReadGroup ? [{ id: groupId, summary: { ...current, topics: [expiredTopic] }, publishedRole: groupRole.info }] : []),
          { id: otherId, summary: secondSummary },
        ] }));
      }
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${modelKey}`);
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(parts).toString());
    if (request.fixtureDsh) dshCalls++;
    prompts.push(JSON.stringify(request.messages));
    if (revokeOnModel) canReadGroup = false;
    if (revokeMemberOnModel) currentMembers = [secondMember];
    const reply = prompts.at(-1)?.includes("群内称呼") ? "群友画像讲解完成。" : "群摘要讲解完成。";
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const sdk = join(directory, "sdk");
  const library = join(sdk, "node_modules", "@deepseek-ai", "dsh-sdk-client", "lib", "index.js");
  await mkdir(dirname(library), { recursive: true });
  await writeFile(library, "");
  const runner = join(directory, "explanation-runner.mjs");
  await writeFile(runner, `
import { once } from 'node:events';
import { createInterface } from 'node:readline';
const input = createInterface({input:process.stdin});
const [line] = await once(input, 'line');
input.close();
process.stdin.destroy();
const {profile, key, messages} = JSON.parse(line);
const upstream = await fetch(profile.baseUrl + '/chat/completions', {method:'POST',
  headers:{'authorization':'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({messages,fixtureDsh:true})});
const result = await upstream.json();
console.log(JSON.stringify({ok:true,text:result.choices[0].message.content,inputTokens:142,outputTokens:12}));
`);
  const preload = join(directory, "explanation-rollout.mjs");
  await writeFile(preload, "Object.assign(process.env," + JSON.stringify({
    OHJINGJING_DSH_DESKTOP: "summary-explanation,profile-explanation", OHJINGJING_DSH_NODE: process.execPath,
    OHJINGJING_DSH_TURN_SCRIPT: runner, OHJINGJING_DSH_SDK_ROOT: sdk, OHJINGJING_DSH_STATE: join(directory, "turns"),
  }) + ");");
  const runtime = await openDesktopRuntime(directory, undefined, preload);
  t.after(async () => {
    await runtime.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), root);
    await rm(resolved, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const modelId = "summary-model";
  await runtime.rpc("saveModel", { id: modelId, name: "个人摘要模型", model: "fixture", baseUrl: origin, hasKey: true });
  await runtime.rpc("saveService", { address: origin });
  await runtime.rpc("saveMemory", { roleId, text: ownMemory });
  const model = (await runtime.rpc("state")).value.models[0];
  const binding = (await runtime.rpc("_credentialPlan", { slot: `model:${modelId}`, includeSubscription: true })).value;
  await runtime.rpc("followGroupRole", { groupId, revision: groupRole.info.revision }, subscriptionKey);
  const view = (await runtime.rpc("groups", {}, subscriptionKey)).value.groups.find((item: { id: string }) => item.id === groupId);
  const args = { groupId, revision: view.summaryRevision, roleId, modelId, model,
    groupRoleRevision: view.followedRole.revision, includeSelf: false };
  const invoke = (overrides: object = {}, key: string | undefined = modelKey) => runtime.rpc(
    "explainGroupSummary", { ...args, ...overrides }, key, {
      binding: binding.binding, subscription: { key: subscriptionKey, binding: binding.subscriptionBinding },
    });
  assert.match((await invoke({ groupId: otherId })).error, /已更新或不可访问/);
  assert.match((await invoke({ model: { ...model, baseUrl: origin + "/changed" } })).error, /模型配置已变更/);
  assert.match((await invoke({}, "")).error, /API Key/);
  current = { ...current, content: "本群内容刚更新。" };
  assert.match((await invoke()).error, /已更新或不可访问/);
  assert.equal(prompts.length, 0);
  current = selectedSummary;
  assert.equal((await invoke()).value, "群摘要讲解完成。");
  assert.equal(profileReads, 0);
  assert.ok([selectedSummary.content, "专属群讲解口吻"].every(item => prompts[0].includes(item)));
  assert.ok([secondSummary.content, ownMemory, visibleProfile, expiredTopic.content, expiredTopic.facts[0].text]
    .every(item => !prompts[0].includes(item)));
  assert.equal((await invoke({ includeSelf: true })).value, "群摘要讲解完成。");
  assert.equal(profileReads, 1);
  assert.ok(prompts[1].includes(visibleProfile));
  revokeOnModel = true;
  const denied = await invoke();
  assert.equal(denied.ok, false);
  assert.match(denied.error, /已更新或不可访问/);
  assert.equal(prompts.length, 3);
  assert.equal((await runtime.rpc("state")).value.usage[0].requests, 3);
  assert.deepEqual((await runtime.rpc("history", { roleId })).value, []);

  canReadGroup = true;
  revokeOnModel = false;
  const directoryView = (await runtime.rpc("members", { groupId }, subscriptionKey)).value;
  const [member] = directoryView.items;
  assert.match(member.referenceRevision, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(directoryView), /服务私有字段/u);
  const memberParams = { groupId, roleId, modelId, model, memberId: member.id, revision: member.referenceRevision,
    groupRoleRevision: groupRole.info.revision };
  const explainMember = (overrides: object = {}, key = modelKey) => runtime.rpc(
    "explainGroupMember", { ...memberParams, ...overrides }, key, {
      binding: binding.binding, subscription: { key: subscriptionKey, binding: binding.subscriptionBinding },
    });
  assert.match((await explainMember({ groupId: otherId, groupRoleRevision: undefined })).error, /HTTP 404/);
  assert.match((await explainMember({ model: { ...model, baseUrl: origin + "/changed" } })).error, /模型配置已变更/);
  assert.match((await explainMember({}, "")).error, /API Key/);
  currentMembers = [{ ...selectedMember, summary: "刚刚发布的新简介" }, secondMember];
  assert.match((await explainMember()).error, /已更新或不可访问/u);
  currentMembers = [selectedMember, secondMember];
  assert.equal(prompts.length, 3);
  assert.equal((await explainMember({ context: "伪造的界面上下文" })).value, "群友画像讲解完成。");
  assert.ok([selectedMember.summary, "专属群讲解口吻"].every(item => prompts[3].includes(item)));
  assert.ok([secondMember.summary, ownMemory, visibleProfile, selectedMember.privateMemory, "伪造的界面上下文"]
    .every(item => !prompts[3].includes(item)));
  revokeMemberOnModel = true;
  assert.match((await explainMember()).error, /已更新或不可访问/u);
  assert.equal(prompts.length, 5);
  assert.equal(dshCalls, 5);
  assert.equal(profileReads, 1);
  assert.deepEqual((await runtime.rpc("history", { roleId })).value, []);
  revokeMemberOnModel = false;
  currentMembers = [selectedMember, secondMember];
  await rm(library);
  assert.equal((await explainMember()).value, "群友画像讲解完成。");
  assert.equal(prompts.length, 6);
  assert.equal(dshCalls, 5);
  assert.deepEqual((await runtime.rpc("history", { roleId })).value, []);
});

test("desktop removes revoked subscription data and keeps local memory usable", async (t) => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-subscription-state-"));
  const roleId = "ohjingjing.dafeiyu";
  const groupId = "qq:1001:5001";
  const role = createPublishedRole({ id: "fixture.group", name: "群角色", version: "1.0.0", persona: "受授权的群角色" });
  const shared = { id: randomUUID(), version: 1, text: "已确认的云端记忆" };
  const local = "离线可用的本机记忆";
  const modelKey = "fixture-model-key";
  const subscriptionKey = "fixture-subscription-key";
  let access: "allowed" | "offline" | "memory-denied" | "revoked" = "allowed";
  let latestMessages = "";
  const upstream = createServer(async (req, res) => {
    if (req.url?.startsWith("/api/")) {
      assert.equal(req.headers.authorization, `Bearer ${subscriptionKey}`);
      if (access === "revoked" || access === "offline") {
        res.writeHead(access === "revoked" ? 401 : 503).end("{}");
      } else if (req.url === "/api/groups") {
        res.end(JSON.stringify({ groups: [{ id: groupId, publishedRole: role.info,
          summary: { id: 1, created_at: new Date().toISOString(), content: "同群摘要" } }] }));
      } else if (req.url === `/api/groups/${groupId}/role`) {
        res.end(JSON.stringify(role));
      } else {
        assert.equal(req.url, `/api/private-memory/${roleId}`);
        res.writeHead(access === "memory-denied" ? 403 : 200).end(JSON.stringify({ items: [shared] }));
      }
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${modelKey}`);
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    latestMessages = Buffer.concat(parts).toString();
    res.end(JSON.stringify({ choices: [{ message: { content: "本地陪伴正常。" } }] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  let runtime = await openDesktopRuntime(directory);
  t.after(async () => {
    await runtime.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), root);
    await rm(resolved, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const modelId = "desk";
  assert.equal((await runtime.rpc("saveModel", { id: modelId, name: "本机模型", baseUrl,
    model: "fixture", hasKey: true, billing: "none", currency: "CNY" })).ok, true);
  assert.equal((await runtime.rpc("saveService", { address: baseUrl })).ok, true);
  assert.equal((await runtime.rpc("saveMemory", { roleId, text: local })).ok, true);
  async function approveRemote() {
    await runtime.rpc("syncPreferences", { push: true, pull: true });
    const preview = await runtime.rpc("previewMemory", { roleId }, subscriptionKey);
    assert.equal(preview.value.items[0].text, shared.text);
    assert.equal((await runtime.rpc("applyMemory", { roleId, revision: preview.value.revision }, subscriptionKey)).ok, true);
  }
  await approveRemote();
  assert.equal((await runtime.rpc("followGroupRole", { groupId, revision: role.info.revision }, subscriptionKey)).ok, true);
  await runtime.rpc("summaryReminders", { legacyWatch: [groupId] });
  await runtime.rpc("groups", {}, subscriptionKey);
  const chat = async () => assert.equal((await runtime.rpc("chat", { roleId, modelId, text: "你好" }, modelKey)).ok, true);
  await chat();
  assert.ok(latestMessages.includes(shared.text));
  access = "offline";
  assert.match((await runtime.rpc("groups", {}, subscriptionKey)).error, /HTTP 503/);
  assert.deepEqual((await runtime.rpc("state")).value.memorySync, { push: true, pull: true });
  await chat();
  assert.ok(latestMessages.includes(local));
  access = "memory-denied";
  assert.match((await runtime.rpc("previewMemory", { roleId }, subscriptionKey)).error, /HTTP 403/);
  assert.deepEqual((await runtime.rpc("state")).value.memorySync, { push: true, pull: false });
  assert.equal((await runtime.rpc("groups", {}, subscriptionKey)).value.groups[0].followedRole.revision, role.info.revision);
  await chat();
  assert.ok(!latestMessages.includes(shared.text));
  access = "allowed";
  await approveRemote();
  access = "revoked";
  assert.match((await runtime.rpc("groups", {}, subscriptionKey)).error, /HTTP 401/);
  await runtime.close();
  const database = new DatabaseSync(join(directory, "desktop.db"), { readOnly: true });
  try {
    const protectedKeys = database.prepare(`SELECT key FROM settings
      WHERE key GLOB 'followedRole:*' OR key GLOB 'approvedMemory:*' OR key='groupSummaryNotices'`).all();
    assert.deepEqual(protectedKeys, []);
  } finally { database.close(); }
  runtime = await openDesktopRuntime(directory);
  assert.deepEqual((await runtime.rpc("state")).value.memorySync, { push: false, pull: false });
  assert.equal((await runtime.rpc("listMemory", { roleId })).value[0].text, local);
  await chat();
  assert.ok(latestMessages.includes(local) && !latestMessages.includes(shared.text));
});

test("desktop discards a delayed successful group response after a concurrent subscription denial", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-desktop-revocation-"));
  const groupId = "qq:1001:5001";
  const key = "revoked-subscription-fixture";
  const previousSummary = "只在有效订阅期间可看的旧摘要。";
  let phase: "hold" | "denied" | "replacement" = "hold";
  const upstream = createServer((req, res) => {
    assert.equal(req.url, "/api/groups");
    assert.equal(req.headers.authorization, "Bearer " + key);
    if (phase === "hold") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders();
      upstream.emit("held-response", res);
    } else if (phase === "denied") {
      res.writeHead(401).end("{}");
    } else {
      res.end(JSON.stringify({ groups: [], gatewayStatus: "online" }));
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const runtime = await openDesktopRuntime(directory);
  t.after(async () => {
    upstream.closeAllConnections();
    await runtime.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const address = "http://127.0.0.1:" + (upstream.address() as AddressInfo).port;
  assert.equal((await runtime.rpc("saveService", { address })).ok, true);
  await runtime.rpc("summaryReminders", { legacyWatch: [groupId] });

  const held = once(upstream, "held-response");
  const staleRead = runtime.send("groups", {}, key);
  const [response] = await held as [ServerResponse];
  phase = "denied";
  const verification = runtime.send("explainGroupSummary", { groupId, revision: "a".repeat(64), includeSelf: false },
    undefined, { subscription: { key } });
  const permission = await runtime.nextReply();
  assert.equal(permission.event, "desktop-service-permissions");
  assert.equal(permission.value.subscription, false);
  const denied = await runtime.nextReply();
  assert.equal(denied.id, verification);
  assert.match(denied.error, /HTTP 401/);

  response.end(JSON.stringify({ groups: [{ id: groupId,
    summary: { id: 9, content: previousSummary, created_at: new Date().toISOString() } }], gatewayStatus: "online" }));
  const stale = await runtime.nextReply();
  assert.equal(stale.id, staleRead);
  assert.equal(stale.ok, false);
  assert.match(stale.error, /订阅已失效/u);
  assert.doesNotMatch(JSON.stringify(stale), new RegExp(previousSummary, "u"));

  phase = "replacement";
  assert.deepEqual((await runtime.rpc("groups", {}, key)).value.groups, []);
});

test("role cards can be edited and shared, with explicit handling of import conflicts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-role-cards-"));
  const { rpc, close } = await openDesktopRuntime(directory);
  t.after(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  const builtInId = "ohjingjing.dafeiyu";
  await rpc("saveMemory", { roleId: builtInId, text: "private-role-memory-fixture" });
  const builtIn = (await rpc("getRoleCard", { roleId: builtInId })).value;
  assert.equal((await rpc("editRole", { role: { ...builtIn.role, name: "替换内置角色" }, expectedRevision: builtIn.info.revision })).ok, false);
  const copy = (await rpc("copyRole", { roleId: builtInId })).value;
  assert.notEqual(copy.id, builtInId);
  assert.equal(copy.persona, builtIn.role.persona);
  assert.deepEqual((await rpc("listMemory", { roleId: copy.id })).value, []);
  await rpc("saveMemory", { roleId: copy.id, text: "private-copy-memory-fixture" });
  const editor = (await rpc("getRoleCard", { roleId: copy.id })).value;
  const next = { ...copy, name: "本地编辑角色", version: "2.0.0", persona: "这是角色可分享的设定。",
    examples: [{ user: "在吗", assistant: "我在桌边。", scene: "desktop" }] };
  assert.equal((await rpc("editRole", { role: next, expectedRevision: editor.info.revision })).ok, true);
  assert.equal((await rpc("editRole", { role: copy, expectedRevision: editor.info.revision })).ok, false);
  await rpc("setRolePersonality", { roleId: copy.id, personality: { traits: { humor: 1 } } });
  const shared = (await rpc("exportRole", { roleId: copy.id })).value;
  assert.equal(shared.persona, next.persona);
  assert.deepEqual(shared.examples, next.examples);
  assert.deepEqual(shared.personality, { traits: { humor: 1 } });
  assert.doesNotMatch(JSON.stringify(shared), /private-(?:role|copy)-memory-fixture/);

  const modified = { ...shared, version: "2.1.0" };
  const { incoming, existing } = (await rpc("inspectRoleImport", { role: modified })).value;
  assert.notEqual(incoming.revision, existing.revision);
  assert.equal((await rpc("importRole", { role: modified, mode: "install", expectedRevision: existing.revision })).ok, false);
  assert.equal((await rpc("importRole", { role: modified, mode: "replace", expectedRevision: editor.info.revision })).ok, false);
  const installedCopy = (await rpc("importRole", { role: modified, mode: "copy", expectedRevision: null })).value;
  assert.notEqual(installedCopy.id, copy.id);
  assert.deepEqual((await rpc("listMemory", { roleId: installedCopy.id })).value, []);
  assert.equal((await rpc("importRole", { role: modified, mode: "replace", expectedRevision: existing.revision })).value.version, "2.1.0");
  assert.equal((await rpc("listMemory", { roleId: copy.id })).value[0].text, "private-copy-memory-fixture");
  assert.equal((await rpc("exportRole", { roleId: builtInId })).value.name, builtIn.role.name);
});

test("summary reminder quiet hours use half-open local intervals for daytime and overnight", () => {
  const policy = { ...defaultSummaryReminderPolicy, quietHours: true };
  const local = (hour: number, minute: number) => new Date(2026, 0, 10, hour, minute);
  assert.equal(summaryReminderQuiet(policy, local(22, 59)), false);
  assert.equal(summaryReminderQuiet(policy, local(23, 0)), true);
  assert.equal(summaryReminderQuiet(policy, local(7, 59)), true);
  assert.equal(summaryReminderQuiet(policy, local(8, 0)), false);
  const daytime = { ...policy, quietStart: "09:30", quietEnd: "10:45" };
  assert.equal(summaryReminderQuiet(daytime, local(9, 30)), true);
  assert.equal(summaryReminderQuiet(daytime, local(10, 45)), false);
  assert.equal(summaryReminderQuiet({ ...policy, paused: true }, local(12, 0)), true);
  assert.throws(() => readSummaryReminderPolicy({ ...policy, quietEnd: policy.quietStart }));
  assert.throws(() => readSummaryReminderPolicy({ ...policy, quietEnd: "24:00" }));
});

test("undelivered summary notices survive restart and acknowledge only the revision displayed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-summary-notices-"));
  const groupId = "qq:1001:5001";
  const watchSummaries = [groupId, "qq:1001:5002"];
  const key = "summary-subscription-fixture";
  const summaryText = "仅供获准订阅者读取的模拟摘要";
  let latestId = 3;
  let revoked = false;
  let hiddenGroup = false;
  let summaryUnavailable = false;
  const service = createServer((req, res) => {
    assert.equal(req.url, "/api/groups");
    assert.equal(req.headers.authorization, "Bearer " + key);
    res.setHeader("Content-Type", "application/json");
    if (revoked) { res.writeHead(403).end("{}"); return; }
    const summary = { id: latestId, created_at: "2026-01-01T10:00:00Z", content: summaryText };
    const groups = hiddenGroup ? [] : [{ id: groupId, summary: summaryUnavailable ? undefined : summary,
      summaries: summaryUnavailable ? [] : [summary] }];
    res.end(JSON.stringify({ groups, gatewayStatus: "online" }));
  });
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  t.after(async () => {
    await new Promise<void>(resolve => service.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const address = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  const first = await openDesktopRuntime(directory);
  const paused = { ...defaultSummaryReminderPolicy, paused: true };
  let pendingToken: string;
  try {
    assert.equal((await first.rpc("saveService", { address })).ok, true);
    assert.deepEqual((await first.rpc("state")).value.models, []);
    assert.deepEqual((await first.rpc("summaryReminders", { legacyWatch: [...watchSummaries, groupId, "bad"] })).value.watched, watchSummaries);
    assert.deepEqual((await first.rpc("summaryReminders", { legacyWatch: [] })).value.watched, watchSummaries);
    assert.deepEqual((await first.rpc("saveSummaryReminderPolicy", paused)).value.policy, paused);
    assert.deepEqual((await first.rpc("groups", {}, key)).value.summaryNotices, []);
    latestId++;
    const observed = (await first.rpc("groups", {}, key)).value.summaryNotices;
    assert.equal(observed[0].groupId, groupId);
    pendingToken = observed[0].token;
  } finally { await first.close(); }

  const reopened = await openDesktopRuntime(directory);
  try {
    const groups = async () => (await reopened.rpc("groups", {}, key)).value;
    const reading = await groups();
    assert.equal(reading.groups[0].summary.content, summaryText);
    assert.deepEqual(reading.summaryNotices, [{ groupId, token: pendingToken }]);
    assert.deepEqual((await reopened.rpc("summaryReminders")).value.policy, paused);
    latestId++;
    const newest = (await groups()).summaryNotices[0].token;
    assert.notEqual(newest, pendingToken);
    assert.equal((await reopened.rpc("acknowledgeSummaryNotices", { tokens: [pendingToken] })).ok, true);
    assert.deepEqual((await groups()).summaryNotices, [{ groupId, token: newest }]);
    assert.equal((await reopened.rpc("acknowledgeSummaryNotices", { tokens: [newest] })).ok, true);
    assert.deepEqual((await groups()).summaryNotices, []);
    latestId++;
    assert.equal((await groups()).summaryNotices.length, 1);
    summaryUnavailable = true;
    assert.deepEqual((await groups()).summaryNotices, []);
    summaryUnavailable = false;
    assert.deepEqual((await groups()).summaryNotices, []);
    latestId++;
    assert.equal((await groups()).summaryNotices.length, 1);
    hiddenGroup = true;
    assert.deepEqual((await groups()).summaryNotices, []);
    hiddenGroup = false;
    assert.deepEqual((await groups()).summaryNotices, []);
    latestId++;
    assert.equal((await groups()).summaryNotices.length, 1);
    assert.equal((await reopened.rpc("setSummaryWatch", { groupId, enabled: false })).ok, true);
    assert.equal((await reopened.rpc("setSummaryWatch", { groupId, enabled: true })).ok, true);
    assert.deepEqual((await groups()).summaryNotices, []);
    latestId++;
    assert.equal((await groups()).summaryNotices.length, 1);
    assert.deepEqual((await reopened.rpc("state")).value.usage, []);
    revoked = true;
    assert.match((await reopened.rpc("groups", {}, key)).error, /403/u);
    revoked = false;
    assert.deepEqual((await groups()).summaryNotices, []);
  } finally { await reopened.close(); }
  assert.ok(!(await readFile(join(directory, "desktop.db"))).toString("utf8").includes(summaryText));
});

test("desktop rotates credentials without using the previous secret at the replacement address", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-credential-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function endpoint() {
    const received: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      received.push(req.headers.authorization);
      req.resume();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.url === "/api/groups"
        ? { groups: [] }
        : { choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
  }
  const [original, replacement] = await Promise.all([endpoint(), endpoint()]);
  const { rpc, close } = await openDesktopRuntime(directory);
  const model = { id: "rotate", name: "测试模型", model: "mock", baseUrl: original.origin, hasKey: true };
  const modelId = { modelId: model.id };
  const plan = async (slot: string, stage = false) => {
    const response = await rpc("_credentialPlan", { slot, stage });
    assert.equal(response.ok, true);
    return response.value;
  };
  try {
    assert.equal((await rpc("saveModel", model)).ok, true);
    assert.equal((await rpc("saveService", { address: original.origin })).ok, true);
    const priorModel = await plan("model:rotate", true);
    const priorService = await plan("service", true);
    assert.deepEqual(priorModel.binding, { slot: "model:rotate", origin: original.origin });
    assert.deepEqual(priorService.binding, { slot: "service", origin: original.origin });
    const change = (before: typeof priorModel, slot = before.replacement) => ({
      change: { expected: before.binding, replacement: slot },
    });
    const nextModel = { ...model, baseUrl: replacement.origin };
    const nextService = { address: replacement.origin };
    assert.equal((await rpc("saveModel", { ...nextModel, reusingKey: true }, undefined,
      change(priorModel, priorModel.binding.slot))).ok, false);
    assert.equal((await rpc("saveService", { ...nextService, reusingKey: true }, undefined,
      change(priorService, priorService.binding.slot))).ok, false);
    assert.equal((await rpc("testModel", modelId, "prior-provider-secret", priorModel)).ok, true);
    assert.equal((await rpc("groups", {}, "prior-service-secret", priorService)).ok, true);
    assert.deepEqual(original.received, ["Bearer prior-provider-secret", "Bearer prior-service-secret"]);
    assert.deepEqual(replacement.received, []);

    assert.equal((await rpc("saveModel", nextModel, undefined, change(priorModel))).ok, true);
    assert.equal((await rpc("saveService", nextService, undefined, change(priorService))).ok, true);
    assert.equal((await rpc("saveModel", model, undefined, change(priorModel))).ok, false);
    assert.equal((await rpc("saveService", { address: original.origin }, undefined, change(priorService))).ok, false);
    assert.equal((await rpc("saveService", { address: original.origin })).ok, false);
    assert.equal((await rpc("testModel", modelId, "prior-provider-secret", priorModel)).ok, false);
    assert.equal((await rpc("groups", {}, "prior-service-secret", priorService)).ok, false);
    assert.deepEqual(replacement.received, []);

    const liveModel = await plan("model:rotate", true);
    const liveService = await plan("service", true);
    assert.deepEqual(liveModel.binding, { slot: priorModel.replacement, origin: replacement.origin });
    assert.deepEqual(liveService.binding, { slot: priorService.replacement, origin: replacement.origin });
    assert.equal((await rpc("testModel", modelId, "new-provider-secret", liveModel)).ok, true);
    assert.equal((await rpc("groups", {}, "new-service-secret", liveService)).ok, true);
    assert.deepEqual(replacement.received, ["Bearer new-provider-secret", "Bearer new-service-secret"]);

    assert.equal((await rpc("saveModel", nextModel, undefined, change(liveModel))).ok, true);
    assert.equal((await rpc("testModel", modelId, "new-provider-secret", liveModel)).ok, false);
    const rotatedModel = await plan("model:rotate");
    assert.equal(rotatedModel.binding.slot, liveModel.replacement);
    assert.equal((await rpc("saveModel", { ...nextModel, hasKey: false }, undefined, change(rotatedModel, null))).ok, true);
    assert.equal((await rpc("saveService", nextService, undefined, change(liveService, null))).ok, true);
    assert.equal((await plan("model:rotate")).binding.slot, null);
    assert.equal((await plan("service")).binding.slot, null);
    assert.equal((await rpc("groups", {}, "prior-service-secret")).ok, false);
    assert.deepEqual(replacement.received, ["Bearer new-provider-secret", "Bearer new-service-secret"]);
    assert.doesNotMatch(JSON.stringify(await rpc("state")), /(?:prior|new)-(?:provider|service)-secret/);
  } finally { await close(); }
  assert.doesNotMatch((await readFile(join(directory, "desktop.db"))).toString("utf8"), /(?:prior|new)-(?:provider|service)-secret/);
});

const previousPackage = process.env.OHJINGJING_TEST_PREVIOUS_DESKTOP_PACKAGE;

test("desktop retires bound model keys and removes model profiles while preserving measured usage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-model-removal-"));
  let calls = 0;
  const provider = createServer((req, res) => {
    calls++;
    req.resume();
    res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let runtime = await openDesktopRuntime(directory);
  t.after(async () => {
    provider.closeAllConnections();
    await runtime.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const baseUrl = "http://127.0.0.1:" + (provider.address() as AddressInfo).port;
  const primary = { id: "primary", name: "主档案", model: "fixture", baseUrl, hasKey: true, currency: "USD" };
  const spare = { ...primary, id: "spare", name: "备用档案" };
  assert.equal((await runtime.rpc("saveModel", primary)).ok, true);
  assert.equal((await runtime.rpc("saveModel", spare)).ok, true);
  assert.equal((await runtime.rpc("testModel", { modelId: spare.id }, "fixture-key")).ok, true);
  assert.equal((await runtime.rpc("saveModelBackup", { modelId: primary.id, backupModelId: spare.id })).ok, true);
  assert.equal((await runtime.rpc("saveModelBudget", { modelId: spare.id, currency: "USD",
    requests: { daily: 7, monthly: 20 }, cost: { daily: null, monthly: null } })).ok, true);
  const { binding } = (await runtime.rpc("_credentialPlan", { slot: "model:" + spare.id })).value;
  const params = { modelId: spare.id };
  assert.equal((await runtime.rpc("clearModelKey", params, undefined, { binding: { ...binding, origin: "https://example.com" } })).ok, false);
  assert.equal((await runtime.rpc("clearModelKey", params, undefined, { binding })).ok, true);
  const cleared = (await runtime.rpc("state")).value;
  assert.equal(cleared.models.find((item: { id: string }) => item.id === spare.id).hasKey, false);
  assert.equal(cleared.models.find((item: { id: string }) => item.id === spare.id).budget.limits.requests.daily, 7);
  assert.equal(cleared.models.find((item: { id: string }) => item.id === primary.id).backupModelId, null);
  assert.equal(cleared.pendingModelKeyRemovals, 1);
  assert.equal(cleared.usage[0].input_tokens, 3);
  assert.equal((await runtime.rpc("testModel", params, "fixture-key", { binding })).ok, false);
  assert.equal(calls, 1);
  await runtime.close();
  runtime = await openDesktopRuntime(directory);
  assert.deepEqual((await runtime.rpc("pendingModelKeyRemovals")).value, [binding.slot]);
  assert.equal((await runtime.rpc("finishModelKeyRemoval", { slot: binding.slot })).ok, true);
  const plan = (await runtime.rpc("_credentialPlan", { slot: "model:" + spare.id, stage: true })).value;
  assert.equal((await runtime.rpc("saveModel", spare, undefined, { change: { expected: plan.binding, replacement: plan.replacement } })).ok, true);
  const active = (await runtime.rpc("_credentialPlan", { slot: "model:" + spare.id })).value.binding;
  assert.equal((await runtime.rpc("removeModel", params, undefined, { binding })).ok, false);
  assert.equal((await runtime.rpc("removeModel", params, undefined, { binding: active })).ok, true);
  const removed = (await runtime.rpc("state")).value;
  assert.deepEqual(removed.models.map((item: { id: string }) => item.id), [primary.id]);
  assert.deepEqual(removed.usage, cleared.usage);
  assert.deepEqual((await runtime.rpc("pendingModelKeyRemovals")).value, [active.slot]);
  assert.equal((await runtime.rpc("testModel", params, "fixture-key", { binding: active })).ok, false);
  assert.equal((await runtime.rpc("saveModel", spare)).ok, false);
  assert.equal(calls, 1);
});

test("desktop balance retains the last successful snapshot for the saved credential and rejects a late reply after Key rotation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-model-balance-"));
  const preload = join(directory, "provider-fixture.mjs");
  const firstKey = "old-fixture-model-key";
  const newKey = "new-fixture-model-key";
  const seen: string[] = [];
  let mode: "available" | "denied" | "hold" = "available";
  const provider = createServer((req, res) => {
    const auth = req.headers.authorization;
    assert.ok(auth === "Bearer " + firstKey || auth === "Bearer " + newKey);
    seen.push(auth);
    if (mode === "denied") res.writeHead(403).end("{}");
    else if (mode === "hold") provider.emit("holding", res);
    else res.end(JSON.stringify({ data: { limit: 50, limit_remaining: auth.endsWith(firstKey) ? 18 : 27, usage: 13 } }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const fixtureUrl = "http://127.0.0.1:" + (provider.address() as AddressInfo).port;
  await writeFile(preload, "const original = globalThis.fetch;\n" +
    "globalThis.fetch = (url, init) => original(url === 'https://openrouter.ai/api/v1/key' ? " +
    JSON.stringify(fixtureUrl) + " : url, init);\n");
  let runtime = await openDesktopRuntime(directory, undefined, preload);
  t.after(async () => {
    provider.closeAllConnections();
    await runtime.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const modelId = "fixture-balance";
  const model = { id: modelId, name: "个人额度", baseUrl: "https://openrouter.ai/api/v1", model: "fixture",
    billing: "openrouter", hasKey: true };
  const cachedOnly = { modelId, cachedOnly: true };
  assert.equal((await runtime.rpc("saveModel", model)).ok, true);
  assert.equal((await runtime.rpc("balance", cachedOnly, firstKey)).value, null);
  assert.equal(seen.length, 0);
  const initial = (await runtime.rpc("balance", { modelId }, firstKey)).value;
  assert.equal(initial.status, "available");
  assert.equal(initial.values[0].remaining, 18);
  await runtime.close();
  runtime = await openDesktopRuntime(directory, undefined, preload);
  assert.deepEqual((await runtime.rpc("balance", cachedOnly, firstKey)).value, initial);
  assert.equal(seen.length, 1);
  assert.equal((await runtime.rpc("balance", cachedOnly, newKey)).value, null);
  mode = "denied";
  const denied = (await runtime.rpc("balance", { modelId }, firstKey)).value;
  assert.equal(denied.status, "denied");
  assert.deepEqual(denied.previous, initial);
  assert.deepEqual((await runtime.rpc("balance", cachedOnly, firstKey)).value, denied);

  const { binding, replacement } = (await runtime.rpc("_credentialPlan", { slot: "model:" + modelId, stage: true })).value;
  mode = "hold";
  const held = once(provider, "holding");
  const oldRead = runtime.send("balance", { modelId }, firstKey, { binding });
  const [res] = await held as [ServerResponse];
  const rotate = runtime.send("saveModel", model, undefined, { change: { expected: binding, replacement } });
  const saved = await runtime.nextReply();
  assert.equal(saved.id, rotate);
  assert.equal(saved.ok, true);
  res.end(JSON.stringify({ data: { limit: 50, limit_remaining: 18, usage: 13 } }));
  const late = await runtime.nextReply();
  assert.equal(late.id, oldRead);
  assert.match(late.error, /配置已变更/u);
  const nextBinding = { ...binding, slot: replacement };
  assert.equal((await runtime.rpc("balance", cachedOnly, newKey, { binding: nextBinding })).value, null);
  mode = "available";
  const current = (await runtime.rpc("balance", { modelId }, newKey, { binding: nextBinding })).value;
  assert.equal(current.values[0].remaining, 27);
  assert.equal(current.previous, undefined);
  assert.deepEqual((await runtime.rpc("state")).value.usage, []);
  assert.doesNotMatch((await readFile(join(directory, "desktop.db"))).toString("utf8"), /(?:old|new)-fixture-model-key/u);
});
test("local reminders work offline, persist across restart, and reject stale actions", async (t) => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-local-reminders-"));
  t.after(async () => {
    const safe = await realpath(directory);
    assert.equal(dirname(safe), root);
    await rm(safe, { recursive: true, force: true });
  });
  const id = randomUUID();
  const base = { id, text: "居民专属本地待办样本", dueAt: Date.now() + 60 * 60_000 };
  const first = await openDesktopRuntime(directory);
  try {
    assert.deepEqual((await first.rpc("localReminders")).value, { paused: false, items: [] });
    assert.equal((await first.rpc("createLocalReminder", { ...base, dueAt: Date.now() - 100 })).ok, false);
    const saved = await first.rpc("createLocalReminder", base);
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.value.items, [{ ...base, version: 1 }]);
    assert.deepEqual((await first.rpc("createLocalReminder", base)).value, saved.value);
    assert.equal((await first.rpc("createLocalReminder", { ...base, text: "同编号不同内容" })).ok, false);
    assert.equal((await first.rpc("changeLocalReminder", { id, action: "snooze", minutes: 5, version: 1 })).ok, false);
    assert.equal((await first.rpc("pauseLocalReminders", { paused: true })).value.paused, true);
  } finally { await first.close(); }
  const db = new DatabaseSync(join(directory, "desktop.db"));
  try { db.prepare("UPDATE desktop_local_reminders SET due_at=? WHERE id=?").run(Date.now() - 100, id); }
  finally { db.close(); }
  const resumed = await openDesktopRuntime(directory);
  try {
    const { paused, items } = (await resumed.rpc("localReminders")).value;
    assert.equal(paused, true);
    assert.equal(items[0].text, base.text);
    assert.ok(items[0].dueAt < Date.now());
    const before = Date.now();
    const delayed = await resumed.rpc("changeLocalReminder", { id, action: "snooze", minutes: 5, version: items[0].version });
    assert.equal(delayed.ok, true);
    // The test host and the packaged runtime read the Windows wall clock in separate processes.
    const delayMs = 5 * 60_000;
    assert.ok(delayed.value.items[0].dueAt >= before + delayMs - 250);
    assert.ok(delayed.value.items[0].dueAt <= Date.now() + delayMs + 250);
    assert.equal((await resumed.rpc("changeLocalReminder", { id, action: "complete", version: 1 })).ok, false);
    assert.equal((await resumed.rpc("changeLocalReminder", { id, action: "complete", version: 2 })).ok, true);
    assert.deepEqual((await resumed.rpc("createLocalReminder", base)).value.items, []);
    const state = (await resumed.rpc("state")).value;
    assert.equal(state.serviceAddress, "");
    assert.deepEqual(state.models, []);
    assert.deepEqual(state.usage, []);
  } finally { await resumed.close(); }
  const retained = new DatabaseSync(join(directory, "desktop.db"), { readOnly: true });
  try { assert.equal(retained.prepare("SELECT text FROM desktop_local_reminders WHERE id=?").get(id)?.text, null); }
  finally { retained.close(); }
});

test("daily group review reminders recheck permission and keep only a source reference on the desktop", async t => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-review-reminder-"));
  const conversationId = "qq:1001:5001";
  const followUpId = "a".repeat(64);
  const key = "fixture-only-review-access-token";
  const privateSummary = "测试复盘专用群内容";
  let mode = "available";
  let checks = 0;
  const server = createServer((req, res) => {
    checks++;
    const url = new URL(req.url!, "http://localhost");
    assert.equal(req.method, "GET");
    assert.equal(url.pathname, "/api/workspace/features/group-daily-review");
    if (req.headers.authorization !== `Bearer ${key}` || mode === "revoked") return res.writeHead(401).end("{}");
    if (url.searchParams.get("conversation") !== conversationId) return res.writeHead(404).end("{}");
    res.end(JSON.stringify({ items: [{ title: "复盘事项", text: privateSummary, ...(mode === "available" ? { followUpId } : {}) }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    const safe = await realpath(directory);
    assert.equal(dirname(safe), root);
    await rm(safe, { recursive: true, force: true });
  });
  const args = { id: "legacy", workspaceId: "default", conversationId, followUpId,
    dueAt: Date.now() + 60 * 60_000, requestId: randomUUID() };
  const runtime = await openDesktopRuntime(directory);
  try {
    assert.equal((await runtime.rpc("saveService", { address: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })).ok, true);
    const { binding } = (await runtime.rpc("_credentialPlan", { slot: "service" })).value;
    const create = (data = args) => runtime.rpc("createWorkspaceReviewReminder", data, key, { binding });
    assert.equal((await create({ ...args, workspaceId: "wrong-workspace" })).ok, false);
    assert.equal(checks, 0);
    assert.equal((await create({ ...args, conversationId: "qq:1001:5002" })).ok, false);
    const result = await create();
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.value.items, [{ id: args.requestId, text: "查看每日复盘的待确认事项", dueAt: args.dueAt, version: 1,
      review: { sourceId: args.id, conversationId, followUpId } }]);
    assert.deepEqual((await create({ ...args, requestId: randomUUID() })).value, result.value);
    assert.equal((await create({ ...args, requestId: randomUUID(), dueAt: args.dueAt + 60_000 })).ok, false);
    mode = "settled";
    assert.equal((await create({ ...args, requestId: randomUUID() })).ok, false);
    mode = "revoked";
    assert.equal((await create({ ...args, requestId: randomUUID() })).ok, false);
    assert.equal((await runtime.rpc("state")).value.usage.length, 0);
  } finally { await runtime.close(); }
  assert.doesNotMatch((await readFile(join(directory, "desktop.db"))).toString("utf8"), new RegExp(`${privateSummary}|${key}`, "u"));
  const resumed = await openDesktopRuntime(directory);
  try {
    const { items } = (await resumed.rpc("localReminders")).value;
    assert.equal(items.length, 1);
    assert.equal(items[0].review.followUpId, followUpId);
    assert.equal((await resumed.rpc("changeLocalReminder", { id: args.requestId, version: 1, action: "complete" })).ok, true);
  } finally { await resumed.close(); }
  const saved = new DatabaseSync(join(directory, "desktop.db"), { readOnly: true });
  try { assert.equal(saved.prepare("SELECT review_json FROM desktop_local_reminders WHERE id=?").get(args.requestId)?.review_json, null); }
  finally { saved.close(); }
});

test("saved desktop connections separate credentials, watched groups, private memory, and late replies", async t => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-service-profiles-"));
  const scope = "qq:1001:5001";
  const roleId = "ohjingjing.dafeiyu";
  const tokenA = "fixture-service-profile-a";
  const tokenB = "fixture-service-profile-b";
  const tokenC = "fixture-service-profile-c";
  const requests: { target: string; token?: string }[] = [];
  let resolveLegacyRead!: () => void;
  const legacyReadStarted = new Promise<void>(resolve => { resolveLegacyRead = resolve; });
  let holdLegacy = false;
  let pendingResponse: (() => void) | undefined;
  const remote = { id: randomUUID(), version: 1, text: "两个服务相同的记忆快照。" };
  function fixture(target: string, accepted: readonly string[]) {
    return createServer((req, res) => {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      requests.push({ target, token });
      res.setHeader("Content-Type", "application/json");
      if (!token || !accepted.includes(token)) return res.writeHead(401).end("{}");
      if (req.url === `/api/private-memory/${roleId}`) return res.end(JSON.stringify({ items: [remote] }));
      assert.equal(req.url, "/api/groups");
      const content = JSON.stringify({ groups: [{ id: scope, profile: { displayName: target + (token === tokenC ? "另一个订阅" : ""), summary: "" },
        summary: { id: 1, content: "联调摘要", created_at: "2026-01-01T02:00:00Z" } }], gatewayStatus: "online" });
      if (target === "第一台" && holdLegacy) {
        pendingResponse = () => res.end(content);
        resolveLegacyRead();
      } else res.end(content);
    });
  }
  const primary = fixture("第一台", [tokenA]);
  const secondary = fixture("第二台", [tokenB, tokenC]);
  for (const server of [primary, secondary]) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  const origin = (server: typeof primary) => "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  let runtime = await openDesktopRuntime(directory);
  t.after(async () => {
    pendingResponse?.();
    await runtime.close();
    await Promise.all([primary, secondary].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    const target = await realpath(directory);
    assert.equal(dirname(target), root);
    await rm(target, { recursive: true, force: true });
  });
  async function act(action: string, args: object = {}, key?: string, metadata?: Omit<CredentialFrame, "key">) {
    const result = await runtime.rpc(action, args, key, metadata);
    assert.ok(result.ok, result.error);
    return result.value;
  }
  const state = () => act("state");
  const binding = (slot = "service", stage = false) => act("_credentialPlan", { slot, stage });
  async function named(id: string, name: string) {
    const plan = await binding(`service-profile:${id}`, true);
    await act("saveServiceProfile", { id, name, address: origin(secondary), reusingKey: false }, undefined,
      { change: { expected: plan.binding, replacement: plan.replacement } });
    return (await binding()).binding;
  }
  const labels = (response: { groups: { profile: { displayName: string } }[] }) => response.groups.map(group => group.profile.displayName);

  await act("saveService", { address: origin(primary), name: "家用服务" });
  const epochA = (await state()).serviceEpoch;
  const legacy = (await binding()).binding;
  assert.equal((await state()).activeServiceProfile, "legacy");
  await act("saveMemory", { roleId, text: "桌宠本机记忆。" });
  await act("setSummaryWatch", { groupId: scope, enabled: true, serviceEpoch: epochA });
  await act("syncPreferences", { push: true, pull: true, serviceEpoch: epochA });
  const firstPreview = await act("previewMemory", { roleId, serviceEpoch: epochA }, tokenA);
  await act("applyMemory", { roleId, revision: firstPreview.revision }, tokenA);
  assert.deepEqual(labels(await act("groups", {}, tokenA)), ["第一台"]);

  const second = randomUUID();
  const secondCredential = await named(second, "开发服务");
  const snapshotB = await state();
  assert.equal(snapshotB.activeServiceProfile, second);
  assert.equal(snapshotB.serviceAddress, origin(secondary));
  assert.deepEqual(snapshotB.serviceProfiles.map((item: { name: string }) => item.name), ["家用服务", "开发服务"]);
  assert.deepEqual(snapshotB.memorySync, { push: false, pull: false });
  assert.deepEqual((await act("summaryReminders", { legacyWatch: [scope] })).watched, []);
  assert.deepEqual(labels(await act("groups", {}, tokenB, { binding: secondCredential })), ["第二台"]);
  const beforeRejections = requests.length;
  assert.match((await runtime.rpc("groups", {}, tokenA, { binding: legacy })).error, /已变更/);
  assert.match((await runtime.rpc("setSummaryWatch", { groupId: scope, enabled: true, serviceEpoch: epochA })).error, /已切换/);
  assert.equal(requests.length, beforeRejections);
  await act("syncPreferences", { push: false, pull: true });
  assert.match((await runtime.rpc("applyMemory", { roleId, revision: firstPreview.revision }, tokenB,
    { binding: secondCredential })).error, /重新预览/);
  assert.equal((await act("listMemory", { roleId }))[0].text, "桌宠本机记忆。");

  const third = randomUUID();
  const thirdCredential = await named(third, "开发服务的第二个订阅");
  assert.notEqual(thirdCredential.slot, secondCredential.slot);
  assert.equal(thirdCredential.origin, secondCredential.origin);
  assert.deepEqual(labels(await act("groups", {}, tokenC, { binding: thirdCredential })), ["第二台另一个订阅"]);
  assert.match((await runtime.rpc("groups", {}, tokenB, { binding: secondCredential })).error, /已变更/);
  await act("selectServiceProfile", { id: "legacy" });
  assert.deepEqual((await act("summaryReminders")).watched, [scope]);
  assert.deepEqual((await state()).memorySync, { push: false, pull: false });
  assert.deepEqual(labels(await act("groups", {}, tokenA)), ["第一台"]);

  holdLegacy = true;
  const oldRead = runtime.send("groups", {}, tokenA);
  await legacyReadStarted;
  for (const id of [second, "legacy"]) {
    const switchRequest = runtime.send("selectServiceProfile", { id });
    const response = await runtime.nextReply();
    assert.equal(response.id, switchRequest);
    assert.ok(response.ok);
  }
  pendingResponse?.();
  pendingResponse = undefined;
  const late = await runtime.nextReply();
  assert.equal(late.id, oldRead);
  assert.match(late.error, /已变更/);
  holdLegacy = false;
  await act("selectServiceProfile", { id: second });
  assert.equal((await binding()).binding.slot, secondCredential.slot);
  await runtime.close();
  runtime = await openDesktopRuntime(directory);
  assert.equal((await state()).activeServiceProfile, second);
  assert.deepEqual(labels(await act("groups", {}, tokenB, { binding: secondCredential })), ["第二台"]);
  await act("removeServiceProfile", { id: second }, undefined, { binding: secondCredential });
  assert.equal((await state()).serviceAddress, "");
  assert.deepEqual((await state()).serviceProfiles.map((item: { id: string }) => item.id), ["legacy", third]);
  assert.doesNotMatch(JSON.stringify(await state()), /fixture-service-profile-/);
  assert.ok(requests.every(entry => entry.target === "第一台" ? entry.token === tokenA : [tokenB, tokenC].includes(entry.token!)));
});

test("upgrading the packaged desktop runtime preserves existing data", { skip: !previousPackage }, async (t) => {
  assert.ok(process.env.OHJINGJING_TEST_DESKTOP_PACKAGE);
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-desktop-upgrade-"));
  const model = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "旧会话的回复" } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
  });
  t.after(async () => {
    await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const baseUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
  const role = { id: "upgrade.demo", name: "本地测试角色", version: "1.0.0", persona: "保持配置。" };
  const profile = { id: "upgrade", name: "联调模型", model: "mock", baseUrl, billing: "none",
    inputPrice: 1, outputPrice: 2, currency: "USD", hasKey: true };
  const session = { roleId: role.id, modelId: profile.id };
  const modelKey = "test-upgrade-model-key";
  const message = "这是安装了旧版时留下的会话。";
  const memory = "旧版保存的本机记忆。";
  const old = await openDesktopRuntime(directory, previousPackage);
  try {
    assert.deepEqual((await old.rpc("state")).value.models, []);
    assert.equal((await old.rpc("saveRole", role)).ok, true);
    assert.equal((await old.rpc("saveModel", profile)).ok, true);
    assert.equal((await old.rpc("saveService", { address: baseUrl })).ok, true);
    assert.equal((await old.rpc("saveMemory", { roleId: role.id, text: memory })).ok, true);
    assert.equal((await old.rpc("chat", { ...session, text: message }, modelKey)).ok, true);
  } finally { await old.close(); }

  const current = await openDesktopRuntime(directory);
  try {
    const state = (await current.rpc("state")).value;
    assert.equal(state.roles.find((item: { id: string }) => item.id === role.id)?.persona, role.persona);
    assert.equal(state.models[0].baseUrl, baseUrl);
    assert.equal(state.models[0].hasKey, true);
    assert.equal(state.serviceAddress, baseUrl);
    assert.deepEqual(state.serviceProfiles, [{ id: "legacy", name: "默认连接", address: baseUrl, hasCredential: true }]);
    assert.equal(state.activeServiceProfile, "legacy");
    assert.equal(state.usage[0].requests, 1);
    assert.doesNotMatch(JSON.stringify(state), /test-upgrade-model-key/);
    assert.equal((await current.rpc("listMemory", { roleId: role.id })).value[0].text, memory);
    assert.equal((await current.rpc("history", { roleId: role.id })).value[0].content, message);
    const modelPlan = (await current.rpc("_credentialPlan", { slot: "model:upgrade" })).value;
    const servicePlan = (await current.rpc("_credentialPlan", { slot: "service" })).value;
    assert.deepEqual(modelPlan.binding, { slot: "model:upgrade", origin: baseUrl });
    assert.deepEqual(servicePlan.binding, { slot: "service", origin: baseUrl });
    assert.equal((await current.rpc("chat", { ...session, text: "升级后的下一句话。" }, modelKey, modelPlan)).ok, true);
    assert.equal((await current.rpc("state")).value.usage[0].requests, 2);
  } finally { await current.close(); }
});

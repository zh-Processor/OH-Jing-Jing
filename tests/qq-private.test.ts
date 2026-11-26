import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createGroupService } from "../runtime/group-service.js";
import { DevelopmentTaskClarification, DevelopmentTaskFailure, openDevelopmentTasks, processDevelopmentTask } from "../runtime/development-tasks.js";
import { openQqPrivate, qqPrivateScope } from "../runtime/qq-private.js";
import { openQqPrivateReminders } from "../runtime/qq-private-reminders.js";
import { nextReminderOccurrence, occurrenceWindow, readPrivateReminderRecurrence, readPrivateReminderTime } from "../runtime/qq-private-reminder-time.js";
import { openStore } from "../runtime/store.js";

function port(server: Server | WebSocketServer) {
  return (server.address() as AddressInfo).port;
}

async function until(check: () => boolean | Promise<boolean>, attempts = 250) {
  for (let tries = 0; tries < attempts; tries++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Expected QQ private-chat state was not reached.");
}

test("private reminder times use the recipient's zone and reject impossible or ambiguous local times", () => {
  const now = Date.parse("2027-01-04T12:00:00Z");
  assert.deepEqual(readPrivateReminderTime("30分钟 喝水", "Asia/Shanghai", now),
    { dueAt: now + 30 * 60_000, text: "喝水" });
  assert.deepEqual(readPrivateReminderTime("2027-01-06 20:00 记录", "Asia/Shanghai", now),
    { dueAt: Date.parse("2027-01-06T12:00:00Z"), text: "记录" });
  assert.equal(readPrivateReminderTime("2027-02-30 20:00 记录", "Asia/Shanghai", now), null);
  assert.equal(readPrivateReminderTime("2027-03-14 02:30 记录", "America/New_York", now), null);
  assert.equal(readPrivateReminderTime("2027-11-07 01:30 记录", "America/New_York", now), null);
  assert.equal(readPrivateReminderTime("2027-01-04 19:59 记录", "Asia/Shanghai", now), null);
});

test("private reminder state enforces quiet hours, local limits, expiry and restart recovery", () => {
  const { db } = openStore(":memory:");
  try {
    const a = { accountId: "1001", userId: "2001" };
    const b = { accountId: "1001", userId: "2002" };
    const reminders = openQqPrivateReminders(db);
    const local2300 = Date.parse("2027-01-04T15:00:00Z");
    const local0800 = Date.parse("2027-01-05T00:00:00Z");
    assert.match(reminders.command(a, "s", "/提醒订阅"), /尚未开放/);
    reminders.setAccess(a, true);
    assert.match(reminders.command(a, "1", "/提醒 1分钟 隐私提醒", local2300), /先在这段私聊中发送/);
    assert.match(reminders.command(a, "s", "/提醒订阅", local2300), /定时提醒已订阅/);
    for (let i = 1; i <= 5; i++) assert.match(reminders.command(a, String(i), `/提醒 ${i}分钟 隐私提醒`, local2300), /已设提醒/);
    assert.match(reminders.command(a, "1", "/提醒 30分钟 重复消息", local2300), /已处理提醒/);
    assert.equal(reminders.summary(a).queued, 5);
    assert.equal(reminders.summary(b).queued, 0);
    assert.deepEqual(reminders.due(local2300 + 10 * 60_000), []);
    const first = reminders.due(local0800)[0];
    assert.equal(reminders.claim(first, local0800), first.id);
    db.prepare("INSERT INTO outbox(scope,event_id,content,status,created_at,platform_message_id) VALUES(?,?,?,'sent',?,'901')")
      .run(qqPrivateScope(a.accountId, a.userId), `reminder:${first.id}`, "", new Date(local0800).toISOString());
    const restarted = openQqPrivateReminders(db);
    assert.equal(restarted.summary(a).lastDelivery?.status, "sent");
    assert.equal(restarted.summary(a).lastDelivery?.platformMessageId, "901");
    assert.deepEqual(restarted.due(local0800 + 1000), []);
    for (let i = 1; i <= 3; i++) {
      const now = local0800 + i * 60_000;
      const [plan] = restarted.due(now);
      assert.equal(restarted.claim(plan, now), plan.id);
      restarted.finish(plan.id, i === 1 ? "unknown" : "sent");
    }
    assert.deepEqual(restarted.due(local0800 + 6 * 60_000), []);
    assert.equal(restarted.summary(a).queued, 1);
    restarted.due(local2300 + 26 * 60 * 60_000);
    assert.equal(restarted.summary(a).queued, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM qq_private_reminders WHERE text IS NOT NULL").get()?.n, 0);
  } finally { db.close(); }
});

test("repeat reminder schedules preserve local time across daylight changes and skip missing slots", () => {
  const day = readPrivateReminderRecurrence("每天 09:00 喝水", "America/New_York")!;
  const previous = Date.parse("2027-03-13T14:00:00Z");
  assert.equal(nextReminderOccurrence(day, previous), Date.parse("2027-03-14T13:00:00Z"));
  const sunday = readPrivateReminderRecurrence("每周日 02:30 备份", "America/New_York")!;
  assert.equal(nextReminderOccurrence(sunday, Date.parse("2027-03-07T07:30:00Z")), Date.parse("2027-03-21T06:30:00Z"));
  const ambiguous = readPrivateReminderRecurrence("每周日 01:30 记录", "America/New_York")!;
  assert.equal(nextReminderOccurrence(ambiguous, Date.parse("2027-10-31T05:30:00Z")), Date.parse("2027-11-14T06:30:00Z"));
  assert.equal(readPrivateReminderRecurrence("每天 25:00 无效计划", "UTC"), null);
});

test("repeat reminders advance and reserve a single live occurrence atomically", () => {
  const { db } = openStore(":memory:");
  const at = (value: string) => Date.parse(value);
  try {
    const contact = { accountId: "1001", userId: "2001" };
    const otherContact = { accountId: "1001", userId: "2002" };
    const reminders = openQqPrivateReminders(db);
    const monday = at("2027-01-04T00:00:00Z");
    for (const item of [contact, otherContact]) {
      reminders.setAccess(item, true);
      reminders.command(item, "subscribe", "/提醒订阅 Asia/Shanghai", monday);
    }
    assert.match(reminders.command(contact, "repeat", "/提醒 每天 09:00 私有重复正文", monday), /已设重复提醒 R1/);
    assert.match(reminders.command(contact, "repeat", "/提醒 每周三 20:00 相同事件", monday), /已处理重复提醒 R1/);
    assert.match(reminders.command(contact, "list", "/提醒列表", monday), /R1 每天 09:00/);
    assert.match(reminders.command(otherContact, "try-cancel", "/提醒取消 R1", monday), /没有可取消/);
    assert.doesNotMatch(JSON.stringify(reminders.summary(contact)), /私有重复正文/);
    assert.deepEqual(reminders.summary(otherContact).rules, []);

    const wednesday = at("2027-01-06T01:30:00Z");
    const [open] = reminders.due(wednesday);
    assert.equal(open.repeat, true);
    assert.equal(open.due_at, at("2027-01-06T01:00:00Z"));
    assert.equal(reminders.summary(contact).rules[0].lastResult, "expired");
    db.exec(`CREATE TEMP TRIGGER fail_reminder_reserve BEFORE INSERT ON qq_private_reminders
      WHEN NEW.rule_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'simulated failure'); END`);
    assert.throws(() => reminders.claim(open, wednesday), /simulated failure/);
    assert.equal(reminders.summary(contact).rules[0].nextAt, open.due_at);
    db.exec("DROP TRIGGER fail_reminder_reserve");
    const reservation = reminders.claim(open, wednesday)!;
    assert.equal(typeof reservation, "number");
    assert.equal(reminders.claim(open, wednesday), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM qq_private_reminders WHERE rule_id=1").get()?.n, 1);

    const restarted = openQqPrivateReminders(db);
    assert.equal(restarted.summary(contact).lastDelivery?.status, "unknown");
    assert.deepEqual(restarted.due(wednesday + 60_000), []);
    const thursday = at("2027-01-07T01:00:00Z");
    restarted.command(contact, "pause", "/提醒暂停", thursday);
    assert.deepEqual(restarted.due(thursday), []);
    restarted.command(contact, "resume", "/提醒恢复", thursday + occurrenceWindow);
    assert.deepEqual(restarted.due(thursday + occurrenceWindow), []);
    assert.equal(restarted.summary(contact).rules[0].nextAt, at("2027-01-08T01:00:00Z"));

    const friday = at("2027-01-08T01:00:00Z");
    const [inFlight] = restarted.due(friday);
    restarted.command(contact, "tz", "/提醒订阅 UTC", friday);
    assert.equal(restarted.summary(contact).rules[0].timeZone, "Asia/Shanghai");
    restarted.command(contact, "quiet-off", "/提醒勿扰 关闭", friday);
    restarted.command(contact, "stop", "/提醒退订", friday);
    assert.equal(restarted.claim(inFlight, friday), null);
    assert.deepEqual(restarted.summary(contact).rules, []);
    assert.equal(db.prepare("SELECT text FROM qq_private_reminder_rules WHERE id=1").get()?.text, null);
  } finally { db.close(); }
});

test("adding repeat capability to a 0.1.16 database preserves a pending one-time reminder", () => {
  const { db } = openStore(":memory:");
  try {
    db.exec(`CREATE TABLE qq_private_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, user_id TEXT NOT NULL, source_event TEXT NOT NULL,
      due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, text TEXT, state TEXT NOT NULL, attempted_at INTEGER,
      UNIQUE(account_id,user_id,source_event)
    )`);
    const now = Date.parse("2027-01-04T02:00:00Z");
    db.prepare("INSERT INTO qq_private_reminders VALUES (1,'1001','2001','legacy',?,?,'原有一次性提醒','queued',NULL)")
      .run(now, now + 60_000);
    const reminders = openQqPrivateReminders(db);
    const contact = { accountId: "1001", userId: "2001" };
    reminders.setAccess(contact, true);
    reminders.command(contact, "legacy-opt-in", "/提醒订阅", now);
    assert.equal(reminders.summary(contact).queued, 1);
    assert.deepEqual(reminders.summary(contact).rules, []);
    const [legacy] = reminders.due(now);
    assert.equal(legacy.text, "原有一次性提醒");
    assert.equal(reminders.claim(legacy, now), 1);
    reminders.finish(1, "sent");
    assert.deepEqual(reminders.summary(contact).schedules.map(row => ({ ...row })),
      [{ id: 1, dueAt: now, state: "sent", ruleId: null }]);
  } finally { db.close(); }
});

test("QQ private replies respect account, per-contact history, revocation, and receipts", async (t) => {
  const testRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(testRoot, "ohjingjing-private-"));
  const database = join(directory, "qq.db");
  const developmentDatabase = join(directory, "development.db");
  const token = "mock-private-test-administrator";
  const requests: { content: string; messages: { role: string; content: string }[]; key?: string }[] = [];
  const sends: { action: string; to: number; text: string }[] = [];
  let refusedDevelopmentNotice = false;
  let delayedClosed = false;
  const model = createServer(async (req, res) => {
    let input = "";
    for await (const chunk of req) input += chunk;
    const { messages } = JSON.parse(input);
    const content = messages.at(-1).content;
    requests.push({ content, messages, key: req.headers.authorization });
    if (content === "取消生成标记") {
      res.once("close", () => { delayedClosed = true; });
      return;
    }
    if (content === "模型故障标记") {
      res.writeHead(503).end();
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: "测试回复" } }] }));
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const service = createGroupService({ database, adminToken: token, modelKey: "mock-private-model-key",
    development: { target: "test-instance", maintainers: ["2001", "2003"], database: developmentDatabase },
    channel: { address: `ws://127.0.0.1:${port(gateway)}`, enabled: true, groups: ["5001"],
      roleId: "", modelId: "mock", hasToken: false, expectedBotId: "1001" },
    model: { id: "mock", name: "Mock", baseUrl: `http://127.0.0.1:${port(model)}`, model: "mock", billing: "none",
      hasKey: true, inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "" },
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  t.after(async () => {
    await service.stop();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await new Promise<void>(resolve => model.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.ok(resolved.startsWith(testRoot + sep));
    await rm(resolved, { recursive: true, force: true });
  });
  const connected = once(gateway, "connection");
  service.startChannel();
  const [socket] = await connected;
  socket.on("message", (raw: Buffer) => {
    const frame = JSON.parse(raw.toString());
    const { action, params } = frame;
    if (action === "get_login_info") {
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: frame.echo, data: { user_id: 1001, nickname: "测试机器人" } }));
      return;
    }
    if (action === "get_status") {
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: frame.echo, data: { online: true, good: true } }));
      return;
    }
    assert.ok(["send_private_msg", "send_group_msg"].includes(action));
    const sent = { action, to: params.user_id ?? params.group_id, text: params.message[0].data.text };
    sends.push(sent);
    if (sent.text.includes(" 已发布。") && !refusedDevelopmentNotice) {
      refusedDevelopmentNotice = true;
      socket.send(JSON.stringify({ status: "failed", retcode: 1200, echo: frame.echo }));
      return;
    }
    socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: frame.echo, data: { message_id: 6000 + sends.length } }));
  });

  async function api(path: string, method = "GET", data?: object, key = token) {
    return fetch(`http://127.0.0.1:${port(service.server)}${path}`, {
      method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: data && JSON.stringify(data),
    });
  }
  function privateMessage(id: number, user: number, text: string, account = 1001, type = "friend", reference?: string) {
    socket.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: type,
      self_id: account, user_id: user, message_id: id, message: [
        ...(reference ? [{ type: "reply", data: { id: reference } }] : []), { type: "text", data: { text } },
      ] }));
  }
  const contactA = { userId: "2001" };
  const contactB = { userId: "2002" };
  const contactRoute = "/admin/private-contacts";
  const budget = (await (await api("/admin/budget")).json()).policy;
  assert.equal((await api("/admin/budget", "PUT", { ...budget, background: { daily: 0, monthly: 0 } })).status, 200);
  assert.equal((await api(contactRoute, "PUT", contactA, "non-admin")).status, 403);
  assert.equal((await api(contactRoute, "PUT", { ...contactA, accountId: "1002" })).status, 409);
  assert.equal((await api(contactRoute, "PUT", contactA)).status, 200);
  assert.equal((await api(contactRoute, "PUT", contactB)).status, 200);
  socket.send(JSON.stringify({ post_type: "message", message_type: "group", message_id: 3, group_id: 5001,
    self_id: 1001, user_id: 2001, message: [{ type: "at", data: { qq: "1001" } }, { type: "text", data: { text: "群聊隔离标记" } }] }));
  await until(() => sends.some(item => item.action === "send_group_msg"));

  privateMessage(3, 2001, "联系人甲历史标记");
  privateMessage(3, 2001, "重复投递标记");
  privateMessage(3, 2002, "联系人乙历史标记");
  privateMessage(5, 2003, "未授权标记");
  privateMessage(6, 2001, "其他机器人账号标记", 1002);
  privateMessage(7, 2001, "临时会话标记", 1001, "group");
  await until(() => sends.filter(item => item.action === "send_private_msg").length === 2);
  privateMessage(8, 2001, "联系人甲继续");
  privateMessage(9, 2002, "模型故障标记");
  await until(() => sends.filter(item => item.action === "send_private_msg").length === 4);
  const historyA = requests.find(item => item.content === "联系人甲继续");
  assert.ok(historyA);
  assert.equal(historyA.key, "Bearer mock-private-model-key");
  assert.match(JSON.stringify(historyA.messages), /联系人甲历史标记/);
  assert.doesNotMatch(JSON.stringify(historyA.messages), /联系人乙历史标记|群聊隔离标记/);
  assert.doesNotMatch(JSON.stringify(requests), /重复投递标记|未授权标记|其他机器人账号标记|临时会话标记/);
  assert.match(sends.find(item => item.to === 2002 && item.text !== "测试回复")!.text, /再说一次/);

  privateMessage(10, 2001, "取消生成标记");
  await until(() => requests.some(item => item.content === "取消生成标记"));
  assert.equal((await api(contactRoute, "DELETE", contactA)).status, 200);
  await until(() => delayedClosed);
  assert.equal((await api(contactRoute, "PUT", contactA)).status, 200);
  privateMessage(11, 2001, "重新授权标记");
  await until(() => sends.filter(item => item.to === 2001).length === 3);
  const refreshed = requests.find(item => item.content === "重新授权标记");
  assert.ok(refreshed);
  assert.doesNotMatch(JSON.stringify(refreshed.messages), /联系人甲历史标记|取消生成标记/);
  const status = await (await api("/admin/status")).json();
  assert.deepEqual(status.groups.map((group: { scope: string }) => group.scope), ["qq:1001:5001"]);
  assert.deepEqual(status.delivery, [{ status: "sent", count: 1 }]);
  assert.equal(status.privateContacts.length, 2);
  assert.ok(status.usage.some((row: { purpose: string }) => row.purpose === "private"));
  assert.doesNotMatch(JSON.stringify(status), /历史标记|取消生成标记|测试回复/);
  const inspection = new DatabaseSync(database);
  try {
    const reopened = openQqPrivate(inspection);
    const scope = qqPrivateScope("1001", "2001");
    assert.equal(reopened.get(scope)?.userId, "2001");
    assert.deepEqual(reopened.history(scope, "ohjingjing.dafeiyu", "").map(item => item.content), ["重新授权标记", "测试回复"]);
    assert.equal(inspection.prepare("SELECT COUNT(*) AS n FROM outbox WHERE scope = ? AND content <> ''").get(scope)?.n, 0);
  } finally { inspection.close(); }

  const realFetch = globalThis.fetch;
  const lookups: { query: string; objective: string }[] = [];
  let giveFreshEvidence = true;
  const source = "https://example.org/report";
  t.mock.method(globalThis, "fetch", async (url: URL | string, options?: RequestInit) => {
    if (!String(url).startsWith("https://mcp.exa.ai/")) return realFetch(url, options);
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    const request = JSON.parse(String(options?.body));
    if (request.method === "initialize") return Response.json({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
    } });
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.equal(request.params.name, "web_search_exa");
    lookups.push(request.params.arguments);
    const date = giveFreshEvidence ? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) : "2020-01-01";
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text:
      `Title: 新闻样本\nURL: ${source}\nPublished: ${date}\nHighlights:\n公开报道样本` }] } });
  });
  const initialRequests = requests.length;
  const start = sends.length;
  privateMessage(12, 2001, "帮我搜一下样本人物最近的新闻");
  await until(() => sends.length === start + 1);
  assert.deepEqual(sends.at(-1), { action: "send_private_msg", to: 2001, text: `测试回复\n来源：${source}` });
  assert.equal(lookups[0].query, "样本人物最近的新闻");
  assert.match(lookups[0].objective, /past 30 days/);
  assert.match(requests.at(-1)!.content, /公开报道样本/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)!.messages), /重新授权标记|"content":"测试回复"/u);

  giveFreshEvidence = false;
  privateMessage(13, 2001, "帮我搜一下样本人物最近的新闻");
  await until(() => sends.length === start + 2);
  assert.match(sends.at(-1)!.text, /暂时没找到能核实发布日期/);
  assert.equal(requests.length, initialRequests + 1);
  assert.equal(lookups.length, 2);

  for (const [index, input] of ["我刚看到一条新闻。", "帮我查一下我的群聊记录", "搜索引擎最近新闻挺多"].entries()) {
    privateMessage(14 + index, 2001, input);
    await until(() => sends.length === start + 3 + index);
  }
  assert.equal(lookups.length, 2);
  const records = new DatabaseSync(database);
  try {
    const scope = qqPrivateScope("1001", "2001");
    assert.equal(records.prepare("SELECT count(*) AS count FROM requests WHERE scope=? AND status='running'").get("private:" + scope)?.count, 0);
    assert.equal(records.prepare("SELECT count(*) AS count FROM requests WHERE scope=? AND status='ok'").get("private:" + scope)?.count, 7);
  } finally { records.close(); }

  const developmentRoute = "/api/workspace/development/tasks";
  const grant = async (qqId: string) => (await (await api("/admin/subscribers", "POST", { qqId, groups: [] })).json()).token as string;
  const keyA = await grant("2001");
  const keyB = await grant("2002");
  assert.equal((await api("/admin/development", "GET", undefined, keyA)).status, 403);
  assert.deepEqual(await (await api("/admin/development")).json(), { configured: true, target: "test-instance", separateQueue: true,
    workerOnline: false, states: [], lastPublished: null });
  assert.equal((await api(developmentRoute, "GET", undefined, keyB)).status, 403);
  const taskSeed = new DatabaseSync(developmentDatabase);
  const recovered = openDevelopmentTasks(taskSeed).enqueue("test-instance", "2001", "本周话题指令",
    "验证需求描述的行为、异常输入与原有 QQ 消息投递。", "qq-private:1001:2001:17");
  taskSeed.close();
  privateMessage(17, 2001, "帮我加一个本周话题指令");
  privateMessage(17, 2001, "帮我加一个重复指令");
  await until(() => sends.some(item => item.to === 2001 && item.text.startsWith("已受理开发任务")));
  const developmentFeed = await (await api(developmentRoute, "GET", undefined, keyA)).json();
  assert.equal(developmentFeed.acceptanceInput, true);
  const first = developmentFeed.items;
  assert.equal(first[0].id, recovered.id);
  assert.deepEqual(first.map((item: { requirement: string; state: string }) => [item.requirement, item.state]), [["本周话题指令", "queued"]]);
  privateMessage(18, 2001, `/开发状态 ${first[0].id}`);
  await until(() => sends.some(item => item.text === `${first[0].id} · queued`));
  assert.ok(!requests.some(item => item.content.includes("本周话题指令")));

  const request = { target: "test-instance", requirement: "在工作区显示本周话题", requestId: "11111111-2222-4333-8444-555555555555",
    acceptance: "仅在目标群已授权时显示。" };
  assert.equal((await api(developmentRoute, "POST", { ...request, target: "foreign" }, keyA)).status, 400);
  assert.equal((await api(developmentRoute, "POST", { ...request, acceptance: 12 }, keyA)).status, 400);
  const submit = async () => (await (await api(developmentRoute, "POST", request, keyA)).json()).task;
  const workspaceTask = await submit();
  assert.equal(workspaceTask.id, (await submit()).id);
  assert.equal(workspaceTask.acceptance, "验证需求描述的行为、异常输入与原有 QQ 消息投递。\n仅在目标群已授权时显示。");
  assert.equal((await (await api(developmentRoute, "GET", undefined, keyA)).json()).items.length, 2);
  const workerDb = new DatabaseSync(developmentDatabase);
  const chatDb = new DatabaseSync(database);
  try {
    const worker = openDevelopmentTasks(workerDb);
    assert.equal(chatDb.prepare("SELECT 1 FROM sqlite_master WHERE name='development_tasks'").get(), undefined);
    assert.equal(workerDb.prepare("SELECT 1 FROM sqlite_master WHERE name='messages'").get(), undefined);
    assert.equal(worker.acquireWorker("test-instance", "worker-a", 0), true);
    assert.equal(worker.acquireWorker("test-instance", "worker-b", 1), false);
    assert.equal(worker.claim("test-instance")?.id, first[0].id);
    assert.equal(worker.claim("test-instance"), undefined);
    assert.equal(worker.acquireWorker("test-instance", "worker-b", 90_001), true);
    assert.equal(worker.requeueBeforePublish("test-instance"), 1);
    const foreign = worker.enqueue("test-instance", "2001", "另一个账号的任务", "", "qq-private:1002:2001:17");
    assert.equal(worker.control(foreign.actor, { taskId: foreign.id, target: foreign.target, state: "queued",
      action: "cancel", updatedAt: foreign.updatedAt }).status, "updated");
    const outcome = await processDevelopmentTask(worker, "test-instance", {
      async develop() {},
      async verify() { return { version: "b".repeat(64), artifact: "fixture.cjs", report: "隔离测试通过。" }; },
      async publish() { return { state: "published", report: "测试实例生效。" }; },
    }, new AbortController().signal);
    assert.ok(outcome);
    assert.equal(outcome.id, first[0].id);
    assert.equal(outcome.state, "published");
    const notices = () => sends.filter(item => item.to === 2001 && item.text.includes(`${outcome.id} 已发布`));
    const retry = workerDb.prepare("SELECT retry_at FROM development_notice_retry WHERE task_id=?");
    const receipt = () => chatDb.prepare("SELECT status,platform_message_id FROM outbox WHERE scope=? AND event_id=?")
      .get(qqPrivateScope("1001", "2001"), `development-result:${outcome.id}:${outcome.updatedAt}`);
    await until(() => !!retry.get(outcome.id), 350);
    assert.equal(receipt()?.status, "failed");
    assert.equal(notices().length, 1);
    assert.deepEqual(worker.notices("test-instance", "1001"), []);
    workerDb.prepare("UPDATE development_notice_retry SET retry_at=0 WHERE task_id=?").run(outcome.id);
    await until(() => receipt()?.status === "sent" && !retry.get(outcome.id), 350);
    assert.equal(notices().length, 2);
    assert.ok(receipt()?.platform_message_id);
    assert.equal(workerDb.prepare("SELECT 1 FROM development_result_notices WHERE task_id=?").get(foreign.id), undefined);
    assert.deepEqual(worker.notices("test-instance", "1001"), []);
    assert.deepEqual(worker.notices("test-instance", "1002").map(task => task.id), [foreign.id]);
    assert.equal(worker.lastPublished("test-instance")?.id, outcome.id);
    const controls = developmentRoute + "/actions";
    const holder = await grant("2003");
    const action = (task: { id: string; target: string; state: string; updatedAt: string }, operation: "cancel" | "retry") => ({
      taskId: task.id, target: task.target, state: task.state, updatedAt: task.updatedAt, action: operation,
    });
    const interrupted = await processDevelopmentTask(worker, "test-instance", {
      async develop() {},
      async verify() { return { version: "c".repeat(64), artifact: "fixture-2.cjs", report: "隔离测试通过。" }; },
      async publish() { throw new Error("publisher interrupted before returning its receipt"); },
    }, new AbortController().signal);
    assert.ok(interrupted);
    assert.equal(interrupted.state, "publishing");
    assert.equal(worker.claim("test-instance"), undefined);
    assert.equal(worker.publishing("test-instance")[0].id, interrupted.id);
    assert.equal((await api(controls, "POST", { ...action(interrupted, "cancel"), state: "candidate" }, keyA)).status, 409);
    assert.equal(worker.lastPublished("test-instance")?.id, outcome.id);
    const restored = worker.transition("test-instance", interrupted.id, "publishing", "rolled-back")!;
    assert.equal(restored.state, "rolled-back");
    assert.equal(worker.lastPublished("test-instance")?.id, outcome.id);
    const failed = worker.enqueue("test-instance", "2001", "改善本周话题的空结果提示", "验证提示内容", "qq-private:1001:2001:19");
    assert.equal(worker.claim("test-instance")?.id, failed.id);
    const terminal = worker.transition("test-instance", failed.id, "developing", "failed", "隔离用例失败。")!;
    const ambiguousId = `development-result:${terminal.id}:${terminal.updatedAt}`;
    chatDb.prepare("INSERT INTO outbox(scope,event_id,content,status,created_at) VALUES (?,?,'','unknown',?)")
      .run(qqPrivateScope("1001", "2001"), ambiguousId, terminal.updatedAt);
    await until(() => !worker.notices("test-instance", "1001").some(task => task.id === terminal.id), 350);
    assert.equal(sends.some(item => item.text.includes(terminal.id)), false);
    assert.equal(chatDb.prepare("SELECT status FROM outbox WHERE event_id=?").get(ambiguousId)?.status, "unknown");
    worker.releaseWorker("test-instance", "worker-b");
    assert.equal(worker.acquireWorker("test-instance", "live-worker"), true);
    const active = await (await api("/admin/development")).json();
    assert.equal(active.workerOnline, true);
    assert.equal(active.lastPublished.version, outcome.version);
    assert.doesNotMatch(JSON.stringify(active), /2001|隔离用例失败|本周话题/u);

    const snapshots = (await (await api(developmentRoute, "GET", undefined, keyA)).json()).items;
    assert.equal(snapshots.find((item: { id: string }) => item.id === restored.id).availableAction, "retry");
    assert.equal((await api(controls, "POST", action(restored, "retry"), keyB)).status, 403);
    assert.equal((await api(controls, "POST", action(restored, "retry"), holder)).status, 404);
    assert.equal((await api(controls, "POST", { ...action(restored, "retry"), target: "other-source" }, keyA)).status, 400);
    const retryResponse = await api(controls, "POST", action(restored, "retry"), keyA);
    assert.equal(retryResponse.status, 200);
    const retried = (await retryResponse.json()).task;
    assert.equal(retried.id, restored.id);
    assert.equal(retried.state, "queued");
    assert.equal(retried.version, null);
    assert.equal((await api(controls, "POST", action(restored, "retry"), keyA)).status, 409);

    let developing: AbortSignal | undefined;
    const running = processDevelopmentTask(worker, "test-instance", {
      async develop(_task, signal) {
        developing = signal;
        await once(signal, "abort");
      },
      async verify() { assert.fail("cancelled development must not verify"); },
      async publish() { assert.fail("cancelled development must not publish"); },
    }, new AbortController().signal);
    assert.ok(developing);
    assert.equal((await api(controls, "POST", action(retried, "cancel"), keyA)).status, 409);
    const current = worker.get("test-instance", "2001", restored.id)!;
    assert.equal(current.state, "developing");
    const stopped = await api(controls, "POST", action(current, "cancel"), keyA);
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).task.availableAction, null);
    assert.equal((await running)?.state, "cancelled");
    assert.equal(developing.reason, "operator");
    assert.equal(worker.claim("test-instance"), undefined);

    privateMessage(22, 2001, "/开发 给本周话题增加帮助。\r\n验收条件：帮助显示用法。\n原命令继续正常工作。");
    privateMessage(22, 2001, "/开发 此次重复内容不覆盖已有任务。\n验收条件：不应保存。");
    await until(() => worker.list("test-instance", "2001").some(task => task.requirement === "给本周话题增加帮助。"));
    const claimed = worker.claim("test-instance");
    assert.equal(claimed?.requirement, "给本周话题增加帮助。");
    assert.equal(claimed?.acceptance, "验证需求描述的行为、异常输入与原有 QQ 消息投递。\n帮助显示用法。\n原命令继续正常工作。");
    await until(() => sends.filter(item => item.text.includes(`已受理开发任务 ${claimed?.id}`)).length === 1);
    assert.ok(!worker.list("test-instance", "2001").some(task => task.requirement.includes("重复内容")));

    privateMessage(23, 2001, "/开发 给本周话题修改文案。\n验收条件：" + "字".repeat(1001));
    await until(() => sends.some(item => item.text.includes("验收条件最多 1000 字")));
    assert.ok(!worker.list("test-instance", "2001").some(task => task.requirement === "给本周话题修改文案。"));

    const retryCommand = "/开发重试 " + terminal.id;
    const nonMaintainerResponses = sends.filter(item => item.to === 2002).length;
    privateMessage(24, 2002, retryCommand);
    await until(() => sends.filter(item => item.to === 2002).length === nonMaintainerResponses + 1);
    assert.equal(worker.get("test-instance", "2001", terminal.id)?.state, "failed");
    privateMessage(25, 2001, "/开发重试");
    await until(() => sends.some(item => item.text === "用 /开发重试 加上原任务编号。"));

    const other = worker.enqueue("test-instance", "2003", "另一个维护者的需求", "", "fixture:other-owner");
    privateMessage(26, 2001, "/开发重试 " + other.id);
    await until(() => sends.some(item => item.text === "找不到该开发任务。"));
    assert.equal(worker.get("test-instance", "2003", other.id)?.updatedAt, other.updatedAt);

    const confirmations = () => sends.filter(item => item.to === 2001 && item.text.includes("已将开发任务 " + terminal.id + " 重新排队"));
    privateMessage(27, 2001, retryCommand);
    privateMessage(27, 2001, retryCommand);
    await until(() => confirmations().length === 1);
    const qqRetried = worker.get("test-instance", "2001", terminal.id);
    assert.ok(qqRetried && qqRetried.updatedAt > terminal.updatedAt);
    assert.deepEqual([qqRetried.state, qqRetried.requirement, qqRetried.acceptance, qqRetried.version],
      ["queued", terminal.requirement, terminal.acceptance, null]);
    assert.equal(workerDb.prepare("SELECT source_event FROM development_tasks WHERE id=?").get(terminal.id)?.source_event,
      "qq-private:1001:2001:19");
    privateMessage(28, 2001, retryCommand);
    await until(() => sends.some(item => item.text.includes("当前任务状态为 queued")));
    assert.equal(confirmations().length, 1);
    assert.equal(worker.get("test-instance", "2001", terminal.id)?.updatedAt, qqRetried.updatedAt);

    assert.equal(worker.control("2001", { ...action(qqRetried, "cancel"), state: "queued" }).status, "updated");
    assert.equal(worker.requeueBeforePublish("test-instance"), 1);
    const awaiting = await processDevelopmentTask(worker, "test-instance", {
      async develop() { throw new DevelopmentTaskClarification("帮助应从哪个子命令打开？"); },
      async verify() { assert.fail("an incomplete request must not reach tests"); },
      async publish() { assert.fail("an incomplete request must not publish"); },
    }, new AbortController().signal);
    assert.ok(awaiting);
    assert.equal(awaiting.id, claimed?.id);
    assert.equal(awaiting.state, "awaiting-details");
    assert.equal(worker.requeueBeforePublish("test-instance"), 0);
    const questions = () => sends.filter(item => item.to === 2001 && item.text.includes(`${awaiting.id} 等待补充`));
    await until(() => questions().length === 1, 350);
    assert.match(questions()[0].text, /帮助应从哪个子命令打开？/u);
    assert.match(questions()[0].text, /引用这条消息/u);
    const clarificationReceipt = chatDb.prepare("SELECT platform_message_id, content FROM outbox WHERE scope=? AND event_id=? AND status='sent'");
    const quotedReceipt = () => clarificationReceipt.get(qqPrivateScope("1001", "2001"), `development-clarification:${awaiting.id}:${awaiting.updatedAt}`);
    await until(() => /^\d+$/u.test(String(quotedReceipt()?.platform_message_id)));
    const quoteId = String(quotedReceipt()?.platform_message_id);
    assert.equal(quotedReceipt()?.content, "");
    const supplementRoute = developmentRoute + "/details";
    const requestDetails = { target: awaiting.target, taskId: awaiting.id, updatedAt: awaiting.updatedAt, details: "补充样本" };
    assert.equal((await api(supplementRoute, "POST", requestDetails, keyB)).status, 403);
    assert.equal((await api(supplementRoute, "POST", requestDetails, holder)).status, 404);
    assert.equal((await api(supplementRoute, "POST", { ...requestDetails, updatedAt: "2026-01-03T00:00:00.000Z" }, keyA)).status, 409);
    assert.equal((await (await api(developmentRoute, "GET", undefined, keyA)).json()).detailsInput, true);
    assert.equal((await api(contactRoute, "PUT", { userId: "2003" })).status, 200);
    privateMessage(291, 2003, "跨联系人引用仅是普通聊天。", 1001, "friend", quoteId);
    await until(() => requests.some(item => item.content.includes("跨联系人引用仅是普通聊天。")));
    assert.equal(worker.get(awaiting.target, "2001", awaiting.id)?.updatedAt, awaiting.updatedAt);
    privateMessage(29, 2001, "/本周话题 帮助，其他参数处理保持原样。", 1001, "friend", quoteId);
    privateMessage(29, 2001, "重放时不能覆写。", 1001, "friend", quoteId);
    const supplementalNotices = () => sends.filter(item => item.to === 2001 && item.text.includes(`已记录补充，开发任务 ${awaiting.id}`));
    await until(() => supplementalNotices().length === 1);
    const fromQq = worker.get(awaiting.target, "2001", awaiting.id)!;
    assert.equal(fromQq.state, "queued");
    assert.equal(fromQq.requirement, `${awaiting.requirement}\n\n补充说明\n/本周话题 帮助，其他参数处理保持原样。`);
    assert.equal(fromQq.acceptance, awaiting.acceptance);
    assert.equal(workerDb.prepare("SELECT source_event FROM development_tasks WHERE id=?").get(awaiting.id)?.source_event,
      "qq-private:1001:2001:22");
    const remaining = await processDevelopmentTask(worker, "test-instance", {
      async develop() { throw new DevelopmentTaskClarification("帮助具体用哪句话？"); },
      async verify() { assert.fail("an incomplete request must not reach tests"); },
      async publish() { assert.fail("an incomplete request must not publish"); },
    }, new AbortController().signal);
    assert.equal(remaining?.id, awaiting.id);
    assert.equal(remaining?.state, "awaiting-details");
    await until(() => questions().length === 2, 350);
    privateMessage(292, 2001, "旧通知上的补充不能进入这一轮。", 1001, "friend", quoteId);
    await until(() => sends.some(item => item.text.includes("请引用最新的补充通知")));
    assert.equal(worker.get(awaiting.target, "2001", awaiting.id)?.updatedAt, remaining?.updatedAt);
    const desktopUpdate = { ...requestDetails, updatedAt: remaining?.updatedAt, details: "帮助固定显示《查看本周话题》。" };
    for (const _ of [1, 2]) {
      const response = await api(supplementRoute, "POST", desktopUpdate, keyA);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).task.id, awaiting.id);
    }
    const published = await processDevelopmentTask(worker, "test-instance", {
      async develop(task) {
        assert.equal(task.requirement, `${fromQq.requirement}\n\n补充说明\n${desktopUpdate.details}`);
        assert.equal(task.acceptance, awaiting.acceptance);
      },
      async verify() { return { version: "e".repeat(64), artifact: "fixture.cjs", report: "用例通过。" }; },
      async publish() { return { state: "published", report: "测试实例生效。" }; },
    }, new AbortController().signal);
    assert.equal(published?.id, awaiting.id);
    assert.equal(published?.state, "published");
    await until(() => sends.some(item => item.to === 2001 && item.text.includes(`${awaiting.id} 已发布`)), 350);
    assert.equal(supplementalNotices().length, 1);

    const scope = qqPrivateScope("1001", "2001");
    const botMessageId = String(chatDb.prepare("SELECT platform_message_id FROM outbox WHERE scope=? AND event_id='11' AND status='sent'")
      .get(scope)?.platform_message_id);
    assert.match(botMessageId, /^\d+$/u);
    async function quotePrompt(id: number, from: number, text: string, reference: string) {
      const start = sends.length;
      privateMessage(id, from, text, 1001, "friend", reference);
      await until(() => sends.length === start + 1 && requests.at(-1)?.content.includes(text) === true);
      const { messages, content } = requests.at(-1)!;
      assert.equal(messages.length, 2);
      return JSON.parse(content);
    }
    const replyQuote = await quotePrompt(40, 2001, "能展开你刚才这句吗？", botMessageId);
    assert.deepEqual(replyQuote.quote, { speaker: "机器人", text: "测试回复", original: "重新授权标记" });
    assert.equal(replyQuote.priorTurns, undefined);
    const reopenedHistory = openQqPrivate(chatDb);
    assert.deepEqual(reopenedHistory.quote(scope, "ohjingjing.dafeiyu", botMessageId, ""), replyQuote.quote);
    assert.equal(reopenedHistory.quote(scope, "other.role", botMessageId, ""), undefined);
    assert.equal(reopenedHistory.quote(scope, "ohjingjing.dafeiyu", botMessageId, new Date(Date.now() + 1000).toISOString()), undefined);
    assert.equal((await quotePrompt(41, 2001, "解释我当时说的这句。", "11")).quote.text, "重新授权标记");
    assert.deepEqual((await quotePrompt(42, 2002, "帮我回顾引用的内容。", botMessageId)).quote, { unavailable: true });
    assert.equal((await api(contactRoute, "DELETE", contactA)).status, 200);
    assert.equal(chatDb.prepare("SELECT COUNT(*) AS count FROM qq_private_message_references WHERE platform_message_id=?").get(botMessageId)?.count, 0);
    assert.equal((await api(contactRoute, "PUT", contactA)).status, 200);
    assert.deepEqual((await quotePrompt(43, 2001, "再看看这条引用。", botMessageId)).quote, { unavailable: true });
  } finally { chatDb.close(); workerDb.close(); }
});

test("development failures preserve the failed stage and only publish safe explanations", async () => {
  const db = new DatabaseSync(":memory:");
  const queue = openDevelopmentTasks(db);
  const target = "isolated";
  const signal = new AbortController().signal;
  try {
    const missing = queue.enqueue(target, "2001", "修改本周话题提示", "核对提示用语", "fixture:1");
    const noCandidate = await processDevelopmentTask(queue, target, {
      async develop() { throw new DevelopmentTaskFailure("no-candidate"); },
      async verify() { assert.fail("a missing candidate cannot be tested"); },
      async publish() { assert.fail("a missing candidate cannot be published"); },
    }, signal);
    assert.equal(noCandidate?.id, missing.id);
    assert.equal(noCandidate?.state, "failed");
    assert.match(noCandidate?.result ?? "", /开发阶段未提交可验收的代码改动/u);
    const next = queue.enqueue(target, "2001", "完善本周话题提示", "检查旧用法兼容", "fixture:2");
    const invalid = await processDevelopmentTask(queue, target, {
      async develop() {},
      async verify() { throw new Error("log contents must not be copied"); },
      async publish() { assert.fail("a test failure cannot be published"); },
    }, signal);
    assert.equal(invalid?.id, next.id);
    assert.equal(invalid?.state, "failed");
    assert.equal(invalid?.result, "测试阶段失败，请查看本次任务的验收日志。");
    for (const sample of [
      { message: "请提供一条脱敏示例，包含群里的原始消息、机器人实际输出和预期回复。", kept: true },
      { message: "Send the redacted input and expected output.", kept: true },
      { message: "请把内容上传到 https://example.invalid。", kept: false },
      { message: "请核对测试凭据 sk-fixture-only-0000。", kept: false },
      { message: "。", kept: false },
    ]) {
      const clarification = queue.enqueue(target, "2001", "处理群里的异常回复", "", "fixture:" + sample.message);
      const result = await processDevelopmentTask(queue, target, {
        async develop() { throw new DevelopmentTaskClarification(sample.message); },
        async verify() { assert.fail("a request awaiting details cannot be tested"); },
        async publish() { assert.fail("a request awaiting details cannot be published"); },
      }, signal);
      assert.equal(result?.id, clarification.id);
      assert.equal(result?.state, "awaiting-details");
      assert.equal(result?.result, sample.kept ? sample.message : "能提供一条脱敏示例，并说明希望产生什么结果吗？");
    }
    for (const sample of [
      { stage: "developing", reason: "TimeoutError", expected: "开发阶段超过任务时限。任务可重试。" },
      { stage: "testing", reason: "TimeoutError", expected: "验收阶段超过任务时限。任务可重试。" },
      { stage: "developing", reason: "AbortError", expected: "任务中断。" },
    ]) {
      const task = queue.enqueue(target, "2001", "修改帮助说明", "", "fixture:" + sample.stage + ":" + sample.reason);
      const stop = new AbortController();
      const abort = () => stop.abort(new DOMException("internal diagnostic", sample.reason));
      const result = await processDevelopmentTask(queue, target, {
        async develop() { if (sample.stage === "developing") abort(); },
        async verify() {
          assert.equal(sample.stage, "testing");
          abort();
          return { version: "unpublished-fixture", artifact: "unpublished.cjs", report: "试验报告。" };
        },
        async publish() { assert.fail("an aborted task cannot be published"); },
      }, stop.signal);
      assert.equal(result?.id, task.id);
      assert.equal(result?.state, "failed");
      assert.equal(result?.result, sample.expected);
    }
    assert.equal(queue.lastPublished(target), undefined);
  } finally { db.close(); }
});

test("private reminders require the recipient, recheck the QQ login and retain a disconnect receipt", async (t) => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-private-reminders-"));
  const database = join(directory, "private-reminders.db");
  const token = "mock-qq-reminders-administrator";
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  let loginAccount = 1001;
  let loginChecks = 0;
  let holdLogin = false;
  let answerLogin: (() => void) | undefined;
  let peer: import("ws").WebSocket;
  const sends: { to: number; text: string; messageId: string }[] = [];
  gateway.on("connection", socket => {
    peer = socket;
    socket.on("message", (raw: Buffer) => {
      const { action, params, echo } = JSON.parse(raw.toString());
      if (action === "get_login_info") {
        loginChecks++;
        const answer = () => socket.send(JSON.stringify({ status: "ok", retcode: 0, echo, data: { user_id: loginAccount } }));
        if (holdLogin) answerLogin = answer;
        else answer();
        return;
      }
      assert.equal(action, "send_private_msg");
      const text = params.message[0].data.text as string;
      const messageId = String(700 + sends.length);
      sends.push({ to: params.user_id, text, messageId });
      if (text === "提醒：断线回执样本") { socket.close(); return; }
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo, data: { message_id: messageId } }));
    });
  });
  async function start() {
    const instance = createGroupService({ database, adminToken: token,
      channel: { address: `ws://127.0.0.1:${port(gateway)}`, enabled: true, groups: [],
        roleId: "", modelId: "", hasToken: false, expectedBotId: "1001" } });
    instance.server.listen(0, "127.0.0.1");
    await once(instance.server, "listening");
    instance.startChannel();
    return instance;
  }
  let service = await start();
  t.after(async () => {
    await service.stop();
    await new Promise<void>(done => gateway.close(() => done()));
    const safe = await realpath(directory);
    assert.ok(safe.startsWith(root + sep));
    await rm(safe, { recursive: true, force: true });
  });
  const settingsPath = "/admin/private-contacts/reminders";
  const authorize = (userId: string, enabled = true) => api(settingsPath, "PUT", { userId, enabled });
  async function api(path: string, method = "GET", data?: object, credential = token) {
    return fetch(`http://127.0.0.1:${port(service.server)}${path}`, {
      method, headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
      body: data && JSON.stringify(data),
    });
  }
  const status = async () => (await api("/admin/status")).json();
  const snapshot = async () => (await status()).privateContacts.find((item: { userId: string }) => item.userId === "2001").reminders;
  const online = () => until(async () => (await status()).channel === "online");
  let event = 1;
  function emit(text: string, user = 2001, id = event++, subType = "friend") {
    peer.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: subType, self_id: 1001,
      user_id: user, message_id: id, message: [{ type: "text", data: { text } }] }));
  }
  async function command(input: string, reply: RegExp, user = 2001) {
    const before = sends.length;
    emit(input, user);
    await until(() => sends.slice(before).some(item => item.to === user && reply.test(item.text)));
  }
  function makeDue(text: string) {
    const db = new DatabaseSync(database);
    try {
      assert.equal(db.prepare("UPDATE qq_private_reminders SET due_at=? WHERE text=? AND state='queued'")
        .run(Date.now() - 100, text).changes, 1);
      db.prepare("UPDATE qq_private_reminders SET attempted_at=attempted_at-120000 WHERE attempted_at IS NOT NULL").run();
    } finally { db.close(); }
  }
  const remindersSent = () => sends.filter(item => item.text.startsWith("提醒："));

  await online();
  assert.equal((await authorize("2001")).status, 409);
  for (const userId of ["2001", "2002"]) assert.equal((await api("/admin/private-contacts", "PUT", { userId })).status, 200);
  assert.equal((await api(settingsPath, "PUT", { userId: "2001", enabled: true }, "non-admin")).status, 403);
  assert.equal((await authorize("2001")).status, 200);
  assert.equal((await snapshot()).settings.subscribed, false);
  emit("/提醒订阅", 2001, event++, "group");
  await command("/提醒 1小时 未订阅样本", /先在这段私聊中发送/);
  await command("/提醒订阅", /尚未开放/, 2002);
  await command("/提醒订阅 Asia/Shanghai", /定时提醒已订阅/);
  await command("/提醒勿扰 关闭", /已关闭提醒勿扰/);
  await command("/提醒暂停", /提醒已暂停/);
  const unique = event;
  await command("/提醒 1小时 受保护的提醒样本", /已设提醒/);
  emit("/提醒 1小时 重复消息", 2001, unique);
  makeDue("受保护的提醒样本");
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(remindersSent().length, 0);
  assert.equal((await snapshot()).queued, 1);
  assert.doesNotMatch(JSON.stringify(await status()), /受保护的提醒样本|重复消息/);

  loginAccount = 1002;
  await command("/提醒恢复", /提醒已恢复/);
  await until(() => loginChecks > 0);
  assert.equal(remindersSent().length, 0);
  assert.equal((await snapshot()).queued, 1);
  loginAccount = 1001;
  await until(async () => (await snapshot()).lastDelivery?.status === "sent");
  assert.deepEqual(remindersSent().map(item => [item.to, item.text]), [[2001, "提醒：受保护的提醒样本"]]);
  assert.equal((await snapshot()).lastDelivery.platformMessageId, remindersSent()[0].messageId);

  await command("/提醒 1小时 等候退订样本", /已设提醒/);
  holdLogin = true;
  makeDue("等候退订样本");
  await until(() => !!answerLogin);
  await command("/提醒退订", /已退订/);
  answerLogin?.();
  holdLogin = false;
  assert.equal((await snapshot()).queued, 0);
  assert.equal((await snapshot()).settings.subscribed, false);

  await command("/提醒订阅", /定时提醒已订阅/);
  await command("/提醒 1小时 可取消的样本", /已设提醒/);
  await command("/提醒列表", /可取消的样本/);
  const shown = sends.at(-1)!.text.match(/^#(\d+)/u)![1];
  await command("/提醒取消 " + shown, /已取消该提醒/);
  const localClock = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", timeStyle: "short", hourCycle: "h23" })
    .format(Date.now() + 3 * 60 * 60_000);
  await command(`/提醒 每天 ${localClock} 断线回执样本`, /已设重复提醒 R1/);
  const repeatDb = new DatabaseSync(database);
  try {
    assert.equal(repeatDb.prepare("UPDATE qq_private_reminder_rules SET next_at=? WHERE id=1")
      .run(Date.now() - 100).changes, 1);
    repeatDb.prepare("UPDATE qq_private_reminders SET attempted_at=attempted_at-120000 WHERE attempted_at IS NOT NULL").run();
  } finally { repeatDb.close(); }
  await until(async () => (await snapshot()).lastDelivery?.status === "unknown");
  await service.stop();
  service = await start();
  await online();
  assert.equal((await snapshot()).queued, 0);
  assert.equal((await snapshot()).rules.length, 1);
  assert.equal((await snapshot()).lastDelivery.status, "unknown");
  assert.deepEqual(remindersSent().map(item => item.text), ["提醒：受保护的提醒样本", "提醒：断线回执样本"]);
  await command("/提醒 1小时 撤权取消样本", /已设提醒/);
  assert.equal((await api("/admin/private-contacts", "DELETE", { userId: "2001" })).status, 200);
  assert.equal((await api("/admin/private-contacts", "PUT", { userId: "2001" })).status, 200);
  assert.equal((await snapshot()).settings, null);
  assert.equal((await snapshot()).queued, 0);
  assert.deepEqual((await snapshot()).rules, []);
  assert.deepEqual((await status()).usage, []);
  const db = new DatabaseSync(database);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM qq_private_reminders WHERE text IS NOT NULL").get()?.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM qq_private_reminder_rules WHERE text IS NOT NULL").get()?.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE content<>''").get()?.n, 0);
  } finally { db.close(); }
});

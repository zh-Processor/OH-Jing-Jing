import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { defaultGroupConversation } from "../runtime/group-conversation.js";
import { createGroupService } from "../runtime/group-service.js";
import type { ChannelStatus, ImChannelPlugin } from "../runtime/im-channel.js";
import { openQqGroupReminders, readGroupReminder, readGroupReminderPolish } from "../runtime/qq-group-reminders.js";
import { openStore } from "../runtime/store.js";

const scope = "qq:1001:5001";
const secondScope = "qq:1001:5002";
const settings = { text: "周会提醒", timeZone: "Asia/Shanghai", quietStart: "23:00", quietEnd: "08:00", windowMinutes: 30 };
const at = (value: string) => Date.parse(value);

test("group reminders validate time zones and send windows, and retain local time across clock changes", () => {
  const now = at("2026-10-29T10:00:00Z");
  const input = { ...settings, kind: "once", at: "2026-10-29T19:00" };
  assert.equal(readGroupReminder(input, now)?.nextAt, at("2026-10-29T11:00:00Z"));
  assert.equal(readGroupReminder(input, now)?.polish, false);
  assert.equal(readGroupReminder({ ...input, polish: true }, now)?.polish, true);
  assert.equal(readGroupReminder({ ...input, openingTopic: " Ａ桌游 " }, now)?.openingTopic, "A桌游");
  assert.equal(readGroupReminder({ ...input, text: "第一行\r\n第二行" }, now)?.text, "第一行\n第二行");
  for (const invalid of [{ text: "" }, { text: "鱼".repeat(301) }, { text: "one\ttwo" }, { at: "2026-10-28T19:00" },
    { at: "2027-12-01T19:00" }, { quietStart: "24:00" }, { windowMinutes: 0 }, { timeZone: "Invalid/Zone" }, { polish: "true" },
    { openingTopic: "计划\n群聊" }, { openingTopic: "联系 123456" }, { openingTopic: "https://example.org" }]) {
    assert.equal(readGroupReminder({ ...input, ...invalid }, now), undefined);
  }
  const timeZone = "America/New_York";
  assert.equal(readGroupReminder({ ...input, timeZone, at: "2026-11-01T01:30" }, now), undefined);
  const repeat = { ...settings, timeZone, kind: "weekly", weekday: 0, localTime: "09:00" };
  assert.equal(readGroupReminder(repeat, now)?.nextAt, at("2026-11-01T14:00:00Z"));
  assert.equal(readGroupReminder({ ...repeat, localTime: "01:30" }, now)?.nextAt, at("2026-11-08T06:30:00Z"));
  assert.equal(readGroupReminder({ ...repeat, weekday: 7 }, now), undefined);
});

test("reminder rewrites keep key literals and reject added mentions, invalid output and changes to times", () => {
  const original = "周六19:00，活动编号 A-19，记得确认。";
  const draft = (content: unknown) => JSON.stringify({ content });
  const good = "提醒一下：周六19:00，活动编号 A-19。记得确认哦。";
  assert.equal(readGroupReminderPolish(draft(good), original), good);
  for (const altered of [good.replace("周六", "周日"), good.replace("19:00", "20:00"), good.replace("A-19", "A-20"),
    good + "@全体", good + "[CQ:at,qq=all]", good + "在 302 室。", original, "海".repeat(301), null]) {
    assert.equal(readGroupReminderPolish(draft(altered), original), undefined);
  }
  assert.equal(readGroupReminderPolish("这里是 Markdown", original), undefined);
});

test("group reminder reservations respect quiet hours, expire old slots, and reconcile restart receipts without replay", () => {
  const store = openStore(":memory:");
  try {
    const reminders = openQqGroupReminders(store.db);
    const now = at("2026-10-29T14:00:00Z");
    const quiet = readGroupReminder({ ...settings, kind: "once", at: "2026-10-30T00:15" }, now)!;
    reminders.create(scope, quiet);
    assert.deepEqual(reminders.due(quiet.nextAt), []);
    assert.equal(reminders.summary(scope, quiet.nextAt).plans[0].hold, "quiet");
    assert.deepEqual(reminders.due(quiet.nextAt + 30 * 60_000), []);
    assert.equal(reminders.summary(scope).history[0].status, "expired");

    const daily = readGroupReminder({ ...settings, kind: "daily", localTime: "09:00" }, now)!;
    const repeatId = reminders.create(scope, daily);
    const secondId = reminders.create(scope, daily);
    const auditId = reminders.create(secondScope, daily);
    assert.equal(reminders.setOpeningTopic(secondScope, repeatId, "跨群话题"), false);
    assert.equal(reminders.setOpeningTopic(scope, repeatId, "合作桌游"), true);
    assert.equal(reminders.setOpeningTopic(scope, secondId, "合作桌游"), true);
    assert.equal(reminders.setOpeningTopic(secondScope, auditId, "其他群的话题"), true);
    assert.deepEqual(reminders.openingTopics(scope, now), ["合作桌游"]);
    assert.deepEqual(reminders.openingTopics(scope, daily.nextAt), []);
    assert.equal(reminders.setPaused(scope, repeatId, true), true);
    assert.deepEqual(reminders.openingTopics(scope, now), ["合作桌游"]);
    assert.equal(reminders.setPaused(scope, secondId, true), true);
    assert.deepEqual(reminders.openingTopics(scope, now), []);
    assert.equal(reminders.setPaused(scope, repeatId, false), true);
    assert.equal(reminders.setPaused(scope, secondId, false), true);
    const live = daily.nextAt + 3 * 86_400_000 + 5_000;
    const ready = reminders.due(live);
    assert.equal(ready.length, 3);
    assert.deepEqual(ready.map(item => item.nextAt), Array(3).fill(live - 5_000));
    assert.equal(reminders.setPaused(secondScope, repeatId, true), false);
    assert.equal(reminders.setPaused(scope, secondId, true), true);
    assert.equal(reminders.claim(ready[1], live), false);
    assert.equal(reminders.claim(ready[0], live), true);
    assert.equal(reminders.claim(ready[0], live), false);
    assert.equal(reminders.setPaused(scope, secondId, false), true);
    assert.equal(reminders.claim(ready[1], live), false);
    assert.equal(reminders.summary(scope, live).plans.find(item => item.id === secondId)?.hold, "spacing");
    assert.equal(reminders.claim(ready[2], live), true);
    store.db.prepare("INSERT INTO outbox(scope,event_id,content,status,created_at,platform_message_id) VALUES (?,?,?,?,?,?)")
      .run(scope, `group-reminder:${repeatId}:${ready[0].nextAt}`, daily.text, "sent", new Date(live).toISOString(), "sent-id");

    const restarted = openQqGroupReminders(store.db);
    assert.deepEqual(restarted.openingTopics(scope, live), ["合作桌游"]);
    const sent = restarted.summary(scope).history[0];
    assert.equal(sent.status, "sent");
    assert.equal(sent.platformMessageId, "sent-id");
    assert.equal(restarted.summary(secondScope).history[0].status, "unknown");
    assert.equal(restarted.summary(secondScope).history[0].planId, auditId);
    assert.equal(restarted.remove(scope, secondId), true);
    assert.deepEqual(restarted.due(live + 60_000), []);
    assert.deepEqual(restarted.due(live + 86_400_000).map(item => item.id), [repeatId, auditId]);
  } finally { store.db.close(); }
});

test("group reminder API and scheduler enforce group policy, pause and login and send plain text once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-qq-group-reminders-"));
  const database = join(directory, "service.sqlite");
  const seed = openStore(database);
  seed.saveSetting(`groupConversation:${scope}`, { ...defaultGroupConversation, quietStart: "00:00", quietEnd: "00:00" });
  seed.db.close();
  let loginId = "1002";
  let checks = 0;
  const deliveries: { groupId: string; content: string }[] = [];
  const plugin: ImChannelPlugin = {
    manifest: { id: "qq.reminder-test", name: "Reminder test", platform: "qq", apiVersion: 1, capabilities: ["groupText"] },
    create: () => {
      let status: ChannelStatus = "disabled";
      return {
        get status() { return status; },
        start() { status = "online"; },
        stop() { status = "disabled"; },
        async checkLogin() {
          checks++;
          return { status: "confirmed", account: { id: loginId, nickname: "Test" } };
        },
        async deliverGroup(groupId, content) {
          deliveries.push({ groupId, content });
          return { status: "sent", messageId: "138" };
        },
      };
    },
  };
  const adminToken = "group-reminder-test-admin-token";
  const service = createGroupService({ database, adminToken, observeGroups: ["5002"],
    channel: { pluginId: plugin.manifest.id, address: "", enabled: true, groups: ["5001"],
      roleId: "", modelId: "", hasToken: false, expectedBotId: "1001" },
  }, [plugin]);
  let stopped = false;
  t.after(async () => {
    if (!stopped) await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const headers = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };
  const call = (method: string, payload?: unknown, group = scope) => fetch(
    base + "/admin/group-reminders" + (method === "GET" ? "?" + new URLSearchParams({ scope: group }) : ""),
    { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const announcement = { ...settings, kind: "daily", localTime: "09:00", quietStart: "00:00", quietEnd: "00:00" };
  assert.equal((await fetch(base + "/admin/group-reminders")).status, 401);
  assert.equal((await fetch(base + "/admin/group-reminders", { headers: { Authorization: "Bearer subscriber" } })).status, 403);
  assert.equal((await call("GET", undefined, "qq:1002:5001")).status, 404);
  assert.equal((await call("POST", { scope: secondScope, ...announcement })).status, 409);
  assert.equal((await call("POST", { scope, ...announcement, windowMinutes: 0 })).status, 400);
  const create = await call("POST", { scope, ...announcement });
  assert.equal(create.status, 201);
  const { id } = (await create.json()).plans[0];
  assert.equal((await call("PUT", { scope, id, paused: true })).status, 200);
  assert.equal((await call("DELETE", { scope: secondScope, id })).status, 404);
  const fixture = new DatabaseSync(database);
  fixture.prepare("UPDATE qq_group_reminder_plans SET next_at=? WHERE id=?").run(Date.now() - 1_000, id);
  fixture.close();

  service.startChannel();
  await delay(1_100);
  assert.equal(checks, 0);
  assert.equal((await call("PUT", { scope, id, paused: false })).status, 200);
  const deadline = Date.now() + 5_000;
  while (checks === 0 && Date.now() < deadline) await delay(20);
  assert.ok(checks > 0);
  assert.deepEqual(deliveries, []);
  loginId = "1001";
  let result: { history: { status: string; platformMessageId: string }[] } | undefined;
  while (Date.now() < deadline) {
    result = await (await call("GET")).json();
    if (result?.history[0]?.status === "sent") break;
    await delay(40);
  }
  assert.equal(result?.history[0]?.status, "sent");
  assert.equal(result?.history[0]?.platformMessageId, "138");
  assert.deepEqual(deliveries, [{ groupId: "5001", content: announcement.text }]);
  assert.equal((await call("DELETE", { scope, id })).status, 200);
  assert.equal((await (await call("GET")).json()).history.length, 1);
  await service.stop();
  stopped = true;
});

test("reminder drafts preserve legacy plans and settle interruption without replay after restart", () => {
  const { db } = openStore(":memory:");
  try {
    db.exec(`CREATE TABLE qq_group_reminder_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      time_zone TEXT NOT NULL, local_time TEXT, weekday INTEGER, quiet_start TEXT NOT NULL, quiet_end TEXT NOT NULL,
      window_minutes INTEGER NOT NULL, next_at INTEGER, paused INTEGER NOT NULL DEFAULT 0
    );`);
    const now = at("2026-10-29T09:00:00Z");
    db.prepare(`INSERT INTO qq_group_reminder_plans VALUES (1,?,'once','旧版正文','Asia/Shanghai',NULL,NULL,
      '00:00','00:00',30,?,0)`).run(scope, now);
    const reminders = openQqGroupReminders(db);
    assert.equal(reminders.summary(scope).plans[0].polish, false);
    assert.equal(reminders.summary(scope).plans[0].openingTopic, "");
    assert.equal(reminders.claim(reminders.due(now)[0], now), true);
    assert.equal(reminders.summary(scope).history[0].source, "fixed");
    // An earlier executable still reserves a run by inserting five values.
    db.prepare("INSERT INTO qq_group_reminder_runs VALUES (?,?,?,?,?)").run(2, scope, now, now, "sent");
    const planned = readGroupReminder({ ...settings, kind: "once", polish: true, at: "2026-10-29T18:00" }, now)!;
    reminders.create(secondScope, planned);
    const live = reminders.due(planned.nextAt)[0];
    assert.equal(reminders.claim(live, planned.nextAt), true);
    assert.equal(reminders.summary(secondScope).plans[0].drafting, true);
    assert.equal(reminders.draftHold(live, reminders.deadline(live)), "expired");
    const restarted = openQqGroupReminders(db);
    assert.deepEqual(restarted.due(planned.nextAt + 1), []);
    assert.equal(restarted.summary(secondScope).history[0].reason, "restart");
    assert.equal(restarted.summary(secondScope).history[0].status, "skipped");
  } finally { db.close(); }
});

test("service polishes reminders with separate budget, protects fixed delivery, and skips a cancelled or expired draft", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-qq-reminder-polish-"));
  const database = join(directory, "service.sqlite");
  const groups = ["5101", "5102", "5103", "5104", "5105", "5106", "5107", "5108"];
  const noQuiet = { ...defaultGroupConversation, quietStart: "00:00", quietEnd: "00:00" };
  const seed = openStore(database);
  for (const id of groups) seed.saveSetting(`groupConversation:qq:1001:${id}`, noQuiet);
  seed.db.close();
  const modelInputs: { text: string }[] = [];
  const held: string[] = [];
  const aborted: string[] = [];
  const provider = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const input = JSON.parse(JSON.parse(Buffer.concat(parts).toString()).messages.at(-1).content);
    modelInputs.push(input);
    assert.equal(req.headers.authorization, "Bearer fixture-service-model-key");
    if (input.text.includes("取消") || input.text.includes("超时")) {
      held.push(input.text);
      res.once("close", () => { if (!res.writableEnded) aborted.push(input.text); });
      return;
    }
    if (input.text.includes("拒绝")) { res.writeHead(503).end("{}"); return; }
    const polished = input.text.includes("改动") ? input.text.replace("19:00", "20:00") : "温馨提醒：" + input.text;
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ content: polished }) } }] }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const deliveries: { groupId: string; content: string }[] = [];
  const plugin: ImChannelPlugin = {
    manifest: { id: "qq.reminder-polish-test", name: "Reminder polish test", platform: "qq", apiVersion: 1, capabilities: ["groupText"] },
    create: () => {
      let status: ChannelStatus = "disabled";
      return {
        get status() { return status; },
        start() { status = "online"; },
        stop() { status = "disabled"; },
        async checkLogin() { return { status: "confirmed", account: { id: "1001", nickname: "Fixture" } }; },
        async deliverGroup(groupId, content) {
          deliveries.push({ groupId, content });
          return { status: "sent", messageId: String(deliveries.length) };
        },
      };
    },
  };
  const adminToken = "fixture-group-polish-admin-token";
  const service = createGroupService({ database, adminToken, modelKey: "fixture-service-model-key",
    model: { id: "fixture", name: "Fixture", model: "fixture", baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
      hasKey: true, currency: "CNY", billing: "none", billingAccount: "", inputPrice: null, outputPrice: null },
    channel: { pluginId: plugin.manifest.id, address: "", enabled: true, groups, roleId: "", modelId: "", hasToken: false, expectedBotId: "1001" },
  }, [plugin]);
  t.after(async () => {
    await service.stop();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  service.startChannel();
  const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const headers = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };
  const api = (path: string, method = "GET", payload?: unknown) => fetch(origin + path,
    { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const scopeOf = (group: string) => `qq:1001:${group}`;
  const state = async (group: string) => (await api("/admin/group-reminders?scope=" + scopeOf(group))).json();
  async function until<T>(read: () => T | Promise<T>) {
    const end = Date.now() + 7_000;
    while (Date.now() < end) {
      const value = await read();
      if (value) return value;
      await delay(45);
    }
    assert.fail("Reminder fixture did not reach the expected state.");
  }
  const run = async (group: string, text: string, opts: { polish?: boolean; short?: boolean } = {}) => {
    const { polish = true, short = false } = opts;
    const response = await api("/admin/group-reminders", "POST", { ...settings, kind: "once", text, polish,
      at: new Date(Date.now() + 60 * 60_000).toISOString().slice(0, 16), timeZone: "UTC",
      windowMinutes: short ? 1 : 30, quietStart: "00:00", quietEnd: "00:00", scope: scopeOf(group),
    });
    assert.equal(response.status, 201);
    const { id } = (await response.json()).plans[0];
    const fixture = new DatabaseSync(database);
    fixture.prepare("UPDATE qq_group_reminder_plans SET next_at=? WHERE id=?").run(Date.now() - (short ? 56_000 : 1_000), id);
    fixture.close();
    return id;
  };
  const outcome = (group: string, status: string) => until(async () =>
    (await state(group)).history.find((item: { status: string }) => item.status === status));

  const source = "周六19:00请准备材料。";
  await run(groups[0], source);
  const sent = await outcome(groups[0], "sent");
  assert.deepEqual([sent.source, sent.outgoingText, sent.platformMessageId], ["polished", "温馨提醒：" + source, "1"]);
  assert.equal(deliveries[0].content, "温馨提醒：" + source);
  assert.deepEqual(Object.keys(modelInputs[0]).sort(), ["style", "text"]);
  await run(groups[1], "拒绝时回退原文。");
  assert.equal((await outcome(groups[1], "sent")).reason, "model-error");
  assert.equal(deliveries[1].content, "拒绝时回退原文。");
  await run(groups[2], "检测时刻改动，周六19:00。");
  const invalid = await outcome(groups[2], "sent");
  assert.deepEqual([invalid.source, invalid.reason], ["fallback", "format"]);
  assert.equal(deliveries[2].content, "检测时刻改动，周六19:00。");

  const cancelledId = await run(groups[3], "准备取消的原文。");
  await until(() => held.includes("准备取消的原文。"));
  await run(groups[4], "独立群的固定正文。", { polish: false });
  assert.equal((await outcome(groups[4], "sent")).source, "fixed");
  assert.equal((await api("/admin/group-reminders", "PUT", { scope: scopeOf(groups[3]), id: cancelledId, paused: true })).status, 200);
  assert.equal((await outcome(groups[3], "skipped")).reason, "paused");
  await until(() => aborted.includes("准备取消的原文。"));
  assert.ok(!deliveries.some(item => item.groupId === groups[3]));

  await run(groups[5], "发送窗口即将超时。", { short: true });
  await until(() => held.includes("发送窗口即将超时。"));
  assert.equal((await outcome(groups[5], "skipped")).reason, "expired");
  await until(() => aborted.includes("发送窗口即将超时。"));
  assert.ok(!deliveries.some(item => item.groupId === groups[5]));

  const protectedText = "请阅读 https://example.invalid/help 的说明。";
  await run(groups[6], protectedText);
  assert.equal((await outcome(groups[6], "sent")).reason, "protected-text");
  assert.equal(deliveries.find(item => item.groupId === groups[6])?.content, protectedText);
  assert.equal((await api("/admin/budget", "PUT", {
    version: 0, warningPercent: 80, pauseOnCostLimit: false, background: { daily: 0, monthly: null }, currencies: [],
  })).status, 200);
  await run(groups[7], "后台预算已经用完。");
  assert.equal((await outcome(groups[7], "sent")).reason, "budget");
  assert.equal(deliveries.find(item => item.groupId === groups[7])?.content, "后台预算已经用完。");
  assert.equal(modelInputs.length, 5);
  const filtered = await (await api("/admin/status?purpose=group-reminder")).json();
  assert.equal(filtered.usage[0].requests, 5);
});

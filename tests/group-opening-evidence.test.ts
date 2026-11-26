import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { defaultGroupConversation } from "../runtime/group-conversation.js";
import { createGroupService } from "../runtime/group-service.js";
import type { ImChannelPlugin } from "../runtime/im-channel.js";
import { defaultRole } from "../runtime/roles.js";

test("a pending opening rechecks new plan and diary topics once, and skips a withdrawn replacement", { timeout: 20_000 }, async t => {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, "ohjingjing-opening-evidence-"));
  const database = join(directory, "service.db");
  const [plan, diary, withdrew] = ["5001", "5002", "5003"];
  const groups = [plan, diary, withdrew];
  const scopes = Object.fromEntries(groups.map(group => [group, "qq:1001:" + group]));
  const originalLabels = ["纸桥初稿", "旧折纸计划", "旧手绘计划"];
  const waitForFirst = new Map<string, () => void>();
  const calls: { plans?: string[]; diary?: string[] }[] = [];
  const sent: { group: string; text: string }[] = [];
  const model = createServer(async (req, res) => {
    let input = "";
    for await (const part of req) input += part;
    const { messages } = JSON.parse(input);
    assert.doesNotMatch(JSON.stringify(messages), /不可外发的日记全文|固定提醒正文/u);
    const context = JSON.parse(messages.at(-1).content);
    calls.push({ plans: context.openingPlans, diary: context.openingDiaryTopics });
    const label = context.openingPlans?.[0] ?? context.openingDiaryTopics?.[0];
    if (originalLabels.includes(label)) await new Promise<void>(resolve => waitForFirst.set(label, resolve));
    const content = JSON.stringify({ action: "reply", text: "想聊聊" + label + "吗？" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const url = (server: { address(): unknown }) => "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const gateway: ImChannelPlugin = {
    manifest: { id: "qq.opening-evidence", name: "隔离开场验证", platform: "qq", apiVersion: 1, capabilities: ["groupText"] },
    create: () => ({
      status: "online", start() {}, stop() {},
      async checkLogin() { return { status: "confirmed", account: { id: "1001", nickname: "隔离账号" } }; },
      async updateSelfAccount() { return { status: "failed" }; },
      async deliverGroup(group, text, permitted) {
        if (!permitted?.()) return { status: "failed" };
        sent.push({ group, text });
        return { status: "sent", messageId: String(9000 + sent.length) };
      },
    }),
  };
  const initial = Date.parse("2026-11-20T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: initial });
  const admin = "isolated-opening-evidence-admin";
  const options = { database, adminToken: admin, observeGroups: groups,
    channel: { pluginId: gateway.manifest.id, enabled: true, expectedBotId: "1001",
      address: "isolated-gateway", groups, roleId: "", modelId: "", hasToken: false },
    model: { id: "evidence-model", name: "Fixture", model: "fixture", baseUrl: url(model), hasKey: false,
      billing: "none" as const, billingAccount: "", currency: "CNY", inputPrice: null, outputPrice: null },
  };
  let service = createGroupService(options, [gateway]);
  t.after(async () => {
    for (const finish of waitForFirst.values()) finish();
    await service.stop();
    await new Promise<void>(resolve => model.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), parent);
    await rm(resolved, { recursive: true, force: true });
  });
  async function start() {
    service.server.listen(0, "127.0.0.1");
    await once(service.server, "listening");
    service.startChannel();
  }
  async function api(path: string, body?: object, method = body ? "PUT" : "GET") {
    const response = await fetch(url(service.server) + path, { method, body: body && JSON.stringify(body),
      headers: { Authorization: "Bearer " + admin, "Content-Type": "application/json" } });
    assert.equal(response.ok, true, await response.clone().text());
    return response.json();
  }
  async function until(check: () => unknown | Promise<unknown>) {
    for (let i = 0; i < 160; i++) {
      if (await check()) return;
      await delay(25);
    }
    assert.fail("Expected an opening with fresh authorization");
  }
  const opening = async (group: string) => (await api("/admin/group-conversation?scope=" + scopes[group])).opening;
  const traces = async (group: string) => (await api("/admin/group-reply-traces?scope=" + scopes[group] + "&trigger=opening")).items;
  const newPlan = (group: string, label: string) => api("/admin/group-reminders", { scope: scopes[group], kind: "daily", text: "固定提醒正文",
    openingTopic: label, timeZone: "UTC", localTime: "13:00", quietStart: "00:00", quietEnd: "00:00", windowMinutes: 15 }, "POST");
  const replacePlan = (group: string, id: number, label: string) => api("/admin/group-reminders", { scope: scopes[group], id, openingTopic: label });
  await start();
  const ids: Record<string, number> = {};
  for (const [index, group] of groups.entries()) {
    ids[group] = (await newPlan(group, originalLabels[index])).plans[0].id;
    await api("/admin/group-conversation", { ...defaultGroupConversation, scope: scopes[group],
      mode: "enabled", startTopics: true, topicIdleMinutes: 15, timeZone: "UTC", quietStart: "00:00", quietEnd: "00:00",
      cooldownMinutes: 1, dailyLimit: 2 });
  }
  const seeded = new DatabaseSync(database);
  try {
    const insert = seeded.prepare("INSERT INTO channel_events VALUES(?,?,?,?,?,?)");
    for (const group of groups) insert.run("1001", group, new Date(initial - 16 * 60_000).toISOString(), scopes[group], "2001", "");
  } finally { seeded.close(); }

  t.mock.timers.tick(15_000);
  await until(() => waitForFirst.size === 3);
  await replacePlan(plan, ids[plan], "纸桥承重");
  const diaryView = await api("/admin/qq-account/diary", { accountId: "1001", roleId: defaultRole.id,
    text: "不可外发的日记全文", shareable: false }, "POST");
  const entry = diaryView.entries[0];
  const current = await api("/admin/group-opening-diary?scope=" + scopes[diary]);
  await api("/admin/group-opening-diary", { scope: scopes[diary], entryId: entry.id, entryVersion: entry.version,
    label: "折纸配色", roleRevision: current.roleRevision, version: 0 });
  await replacePlan(diary, ids[diary], "");
  await replacePlan(withdrew, ids[withdrew], "授权后又撤回的手绘话题");
  for (const finish of waitForFirst.values()) finish();
  await until(async () => (await Promise.all(groups.map(traces))).every(rows => rows.some((row: {reason:string}) => row.reason === "evidence-changed")));
  assert.equal(sent.length, 0);

  t.mock.timers.tick(65_000);
  assert.equal((await opening(plan)).code, "opening-retry-wait");
  assert.equal((await opening(diary)).until, initial + 135_000);
  await replacePlan(withdrew, ids[withdrew], "");
  assert.equal((await opening(withdrew)).code, "same-topic");
  await service.stop();
  service = createGroupService(options, [gateway]);
  await start();
  assert.equal((await opening(diary)).code, "opening-retry-wait");

  t.mock.timers.tick(65_000);
  await until(() => sent.length === 2);
  assert.deepEqual(sent.toSorted((a, b) => a.group.localeCompare(b.group)), [
    { group: plan, text: "想聊聊纸桥承重吗？" },
    { group: diary, text: "想聊聊折纸配色吗？" },
  ]);
  const planTraces = (await traces(plan)).filter((row: {requestId:number|null}) => row.requestId !== null);
  assert.deepEqual(planTraces.map((row: {reason:string}) => row.reason), ["sent", "evidence-changed"]);
  assert.equal(planTraces[0].eventId, planTraces[1].eventId);
  assert.deepEqual(planTraces[1].receipts, []);
  assert.ok(planTraces[0].receipts[0].platformMessageId);
  t.mock.timers.tick(180_000);
  assert.equal(calls.length, 5);
  assert.equal(sent.length, 2);
});

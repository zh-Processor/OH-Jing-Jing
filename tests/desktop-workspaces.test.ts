import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { openDesktopCredentials } from "../runtime/desktop-credentials";
import { openDesktopWorkspaces } from "../runtime/desktop-workspaces";
import { defaultSummaryReminderPolicy, defaultWorkspaceReminderPolicy } from "../runtime/summary-reminder-policy";
import { openStore } from "../runtime/store";
import type { GroupSummary } from "../runtime/group-summary-reference";

test("desktop workspaces share a feed per credential and recover sources independently", async t => {
  const store = openStore(":memory:");
  t.after(() => store.db.close());
  const credentials = openDesktopCredentials(store);
  const workspaces = openDesktopWorkspaces(store, credentials);
  const group = "qq:1001:5001";
  async function source(token: string, label: string) {
    const sourceId = randomUUID();
    const cursors: (string | null)[] = [];
    const state = { status: 200, version: 1, legacy: false, summaryAt: "", topics: undefined as GroupSummary["topics"],
      waitForMembers: undefined as (() => Promise<void>) | undefined };
    const service = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      const url = new URL(req.url!, "http://localhost");
      const headers = { "Content-Type": "application/json" };
      if (state.status !== 200) return res.writeHead(state.status, headers).end("{}");
      if (url.pathname === `/api/groups/${group}/members`) {
        await state.waitForMembers?.();
        return res.writeHead(200, headers).end(JSON.stringify({ items: [{ id: "shared-member", displayName: "同名群友",
          summary: label + "的群友画像", revision: "current", privateMemory: "服务私有字段" }] }));
      }
      if (url.pathname === "/api/groups" && !state.legacy) return res.writeHead(200, headers).end(JSON.stringify({ groups: [
        { id: group, profile: { displayName: "同名群", summary: label + "的群画像", privateMemory: "服务私有字段" } },
        { id: "qq:1001:5002", profile: { displayName: "另一个群", summary: "异群画像" } },
      ] }));
      if (state.legacy && url.pathname === "/api/workspace/feed") return res.writeHead(404, headers).end("{}");
      if (state.legacy) return res.writeHead(200, headers).end(JSON.stringify({ channelPlugin: { platform: "qq" },
        groups: [{ id: group, profile: { displayName: "同名群" }, summary: {
          id: state.version, content: label, created_at: "2026-01-02T00:00:00Z",
        } }],
      }));
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      const version = state.version;
      const event = state.summaryAt ? { id: version, kind: "summary", conversationId: group,
        at: state.summaryAt, summary: { content: label + version, created_at: state.summaryAt, topics: state.topics } } : {
        id: version, kind: "message", conversationId: group, at: "2026-01-02T00:00:00Z", message: { text: label + version },
      };
      return res.writeHead(200, headers).end(JSON.stringify({ platform: "qq", cursor: `cursor-${version}`,
        reset: !cursor, hasMore: false, retainedAfter: "2026-01-01T00:00:00Z",
        conversations: [{ id: group, label: "同名群", messageAccess: true }],
        items: cursor !== `cursor-${version}` ? [event] : [],
      }));
    });
    service.listen(0, "127.0.0.1");
    await once(service, "listening");
    t.after(() => new Promise<void>(resolve => service.close(() => resolve())));
    const address = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    const slot = `service-profile:${sourceId}`;
    const plan = credentials.plan(slot, true);
    credentials.commit(slot, { change: { expected: plan.binding, replacement: plan.replacement } }, plan.binding, address, false);
    credentials.saveServiceProfile(sourceId, label, address);
    return { sourceId, state, cursors, frame: { key: token, binding: credentials.serviceProfile(sourceId).binding } };
  }

  const a = await source("fixture-alpha-token", "甲");
  const b = await source("fixture-beta-token", "乙");
  credentials.activateService(a.sourceId);
  assert.deepEqual(workspaces.configuration().items[0].sourceIds, [a.sourceId]);
  workspaces.save({ id: "default", name: "日常", sourceIds: [a.sourceId, b.sourceId] });
  const testWorkspace = workspaces.save({ name: "测试", sourceIds: [a.sourceId] });
  assert.equal(testWorkspace.items.length, 2);
  workspaces.filter("default", b.sourceId);
  workspaces.filter(testWorkspace.activeId, a.sourceId);
  assert.throws(() => workspaces.filter(testWorkspace.activeId, b.sourceId), /工作区中的来源/u);
  assert.deepEqual(openDesktopWorkspaces(store, credentials).configuration().items.map(item => item.sourceFilter), [b.sourceId, a.sourceId]);

  const readA = () => workspaces.sync(a.sourceId, a.frame);
  const readB = () => workspaces.sync(b.sourceId, b.frame);
  const [alpha, beta, duplicate] = await Promise.all([readA(), readB(), readA()]);
  assert.deepEqual(alpha, duplicate);
  assert.equal(alpha.items[0].kind === "message" && alpha.items[0].message.text, "甲1");
  assert.equal(beta.items[0].kind === "message" && beta.items[0].message.text, "乙1");
  assert.deepEqual(a.cursors, [null]);
  assert.deepEqual(b.cursors, [null]);

  const [portraitA, portraitB] = await Promise.all([
    workspaces.profiles(a.sourceId, a.frame, group), workspaces.profiles(b.sourceId, b.frame, group),
  ]);
  assert.equal(portraitA?.group?.summary, "甲的群画像");
  assert.equal(portraitB?.group?.summary, "乙的群画像");
  assert.equal(portraitA?.members[0].id, portraitB?.members[0].id);
  assert.equal(portraitA?.members[0].summary, "甲的群友画像");
  assert.equal(portraitB?.members[0].summary, "乙的群友画像");
  assert.doesNotMatch(JSON.stringify([portraitA, portraitB]), /服务私有字段|异群画像/u);

  workspaces.select("default");
  a.state.status = 503;
  b.state.version = 2;
  const [offline, healthy] = await Promise.all([readA(), readB()]);
  assert.equal(offline.state, "stale");
  assert.deepEqual(healthy.items.map(item => item.id), [2, 1]);
  a.state.status = 200;
  a.state.version = 3;
  const resumed = await openDesktopWorkspaces(store, credentials).sync(a.sourceId, a.frame);
  assert.deepEqual(resumed.items.map(item => item.id), [3, 1]);
  assert.deepEqual(a.cursors, [null, "cursor-1"]);

  workspaces.watch("default", a.sourceId, group, true);
  workspaces.watch(testWorkspace.activeId, a.sourceId, group, true);
  workspaces.watch("default", b.sourceId, group, true);
  assert.deepEqual(workspaces.notices(), []);
  a.state.version = 4;
  a.state.summaryAt = new Date(Date.now() + 1000).toISOString();
  b.state.version = 4;
  b.state.summaryAt = a.state.summaryAt;
  const topic = { title: "同名话题", content: "测试摘要", from: a.state.summaryAt, to: a.state.summaryAt, coverage: "complete" } as const;
  a.state.topics = [{ ...topic, facts: [
    { kind: "open", text: "维护状态待确认。", at: a.state.summaryAt },
    { kind: "change", reported: true, text: "群友称开放了新功能。", at: a.state.summaryAt },
  ] }];
  b.state.topics = [{ ...topic, facts: [{ kind: "change", text: "活动确定改到周日下午。", at: b.state.summaryAt }] }];
  await Promise.all([readA(), readB()]);
  const notices = workspaces.notices();
  assert.equal(notices.length, 2);
  assert.deepEqual(new Set(notices.map(item => item.sourceId)), new Set([a.sourceId, b.sourceId]));
  assert.deepEqual(new Set(notices.map(item => item.conversationId)), new Set([group]));
  assert.deepEqual(new Set(notices.map(item => item.label)), new Set(["甲 · 同名群", "乙 · 同名群"]));
  assert.equal(notices.find(item => item.sourceId === a.sourceId)?.reaction, "reported-question");
  assert.equal(notices.find(item => item.sourceId === b.sourceId)?.reaction, "change");
  assert.doesNotMatch(JSON.stringify(notices), /维护状态|活动确定/u);
  workspaces.acknowledge([notices[0].token]);
  assert.deepEqual(openDesktopWorkspaces(store, credentials).notices(), [notices[1]]);
  workspaces.acknowledge([notices[1].token]);
  assert.deepEqual(openDesktopWorkspaces(store, credentials).notices(), []);

  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(8, 59, 30, 0);
  const at = (hour: number, minute: number) => Number(new Date(start).setHours(hour, minute, 0, 0));
  const global = { ...defaultSummaryReminderPolicy, quietHours: true, quietStart: "08:00", quietEnd: "10:00" };
  const daily = { id: "default", name: "日常", sourceIds: [a.sourceId, b.sourceId] };
  workspaces.save({ ...daily, reminders: { ...defaultWorkspaceReminderPolicy,
    quietHours: true, quietStart: "08:00", quietEnd: "09:00", intervalMinutes: 15 } });
  const other = { id: testWorkspace.activeId, name: "测试", sourceIds: [a.sourceId] };
  assert.throws(() => workspaces.save({ ...other, reminders: { ...defaultWorkspaceReminderPolicy, intervalMinutes: 1 } }), /提醒频率/u);
  workspaces.save({ ...other, reminders: { ...defaultWorkspaceReminderPolicy, intervalMinutes: 5 } });
  t.mock.timers.enable({ apis: ["Date"], now: Number(start) });
  const refreshBoth = () => Promise.all([readA(), readB()]);
  function publish(version: number) {
    a.state.version = b.state.version = version;
    a.state.summaryAt = b.state.summaryAt = new Date().toISOString();
  }
  function show(sourceId: string) {
    const batch = workspaces.notices(Date.now(), global);
    assert.deepEqual(batch.map(item => item.sourceId), [sourceId]);
    workspaces.acknowledge(batch.map(item => item.token), Date.now(), global);
  }
  try {
    publish(5);
    await refreshBoth();
    assert.deepEqual(workspaces.notices(Date.now(), { ...global, paused: true }), []);
    show(a.sourceId);
    t.mock.timers.setTime(at(9, 0));
    show(b.sourceId);
    t.mock.timers.setTime(at(9, 1));
    publish(6);
    await refreshBoth();
    assert.deepEqual(openDesktopWorkspaces(store, credentials).notices(Date.now(), global), []);
    t.mock.timers.setTime(at(9, 5));
    await refreshBoth();
    show(a.sourceId);
    t.mock.timers.setTime(at(9, 15));
    await refreshBoth();
    show(b.sourceId);
    assert.deepEqual(workspaces.notices(Date.now(), global), []);
    workspaces.save({ ...other, reminders: null });
    assert.equal(workspaces.configuration().items.find(item => item.id === other.id)?.reminders, undefined);
  } finally { t.mock.timers.reset(); }

  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { a.state.waitForMembers = () => { resolve(); return hold; }; });
  const stalePortrait = workspaces.profiles(a.sourceId, a.frame, group);
  await started;
  try {
    const slot = `service-profile:${a.sourceId}`;
    const plan = credentials.plan(slot, true);
    credentials.commit(slot, { change: { expected: plan.binding, replacement: plan.replacement } }, plan.binding,
      credentials.serviceProfile(a.sourceId).profile!.address, false);
    workspaces.forget(a.sourceId, true);
    const watched = workspaces.configuration().items.flatMap(item => item.watched ?? []);
    assert.deepEqual(watched.map(item => item.sourceId), [b.sourceId]);
  } finally { finish(); }
  assert.equal(await stalePortrait, null);
  a.state.waitForMembers = undefined;

  a.state.status = 401;
  const renewed = { ...a.frame, binding: credentials.serviceProfile(a.sourceId).binding };
  assert.deepEqual(await workspaces.sync(a.sourceId, renewed), { id: a.sourceId, state: "unauthorized", conversations: [], items: [] });
  assert.equal(await workspaces.profiles(a.sourceId, renewed, group), null);
  assert.equal((await workspaces.profiles(b.sourceId, b.frame, group))?.members[0].summary, "乙的群友画像");
  b.state.legacy = true;
  const legacy = await readB();
  assert.equal(legacy.state, "summary-only");
  assert.equal(legacy.items[0].kind, "summary");
  assert.deepEqual(legacy.conversations.map(item => item.messageAccess), [false]);
});

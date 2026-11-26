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
import { WebSocketServer, type WebSocket } from "ws";
import { createGroupService } from "../runtime/group-service";
import { createQqIngressCollector, openQqIngress } from "../runtime/qq-ingress";

test("interrupted collector recovery keeps the original checkpoint through later live events and restarts", { timeout: 24_000 }, async t => {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, "ohjingjing-recovery-checkpoint-"));
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const groupEvent = (id: number, time = Math.floor(Date.now() / 1000)) => ({ post_type: "message", message_type: "group", self_id: 1001,
    group_id: 5001, user_id: 2001, message_id: id, time, message: [{ type: "text", data: { text: "恢复测试样本" } }] });
  const checkpoint = Math.floor(Date.now() / 1000) - 10;
  const missed = groupEvent(12, checkpoint + 2);
  let phase: "start" | "interrupted" | "resume" = "start";
  let blocked: WebSocket | undefined;
  let resumedReads = 0;
  let writes = 0;
  gateway.on("connection", peer => peer.on("message", frame => {
    const { action, echo, params } = JSON.parse(String(frame));
    if (action.startsWith("send_")) writes++;
    let data: object = { online: true, good: true };
    if (action === "get_login_info") data = { user_id: 1001, nickname: "收件恢复测试" };
    if (action === "get_group_msg_history") {
      if (phase === "interrupted") { blocked = peer; return; }
      if (phase === "resume") {
        resumedReads++;
        if (resumedReads >= 3) assert.equal(params.message_seq, 13);
        if (resumedReads === 1 || resumedReads === 3) {
          peer.send(JSON.stringify({ status: "failed", retcode: 1500, echo }));
          return;
        }
      }
      data = { messages: resumedReads === 2 ? [{ ...groupEvent(13), message_seq: 13 }]
        : [missed, groupEvent(13), groupEvent(11, checkpoint - 3)] };
    }
    peer.send(JSON.stringify({ status: "ok", retcode: 0, echo, data }));
  }));
  const token = "persistent-history-recovery-fixture";
  const database = join(directory, "collector.db");
  const options = { accountId: "1001", groups: ["5001"], privateContacts: [], token, recoverHistory: true,
    database, gateway: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}` };
  let collector: ReturnType<typeof createQqIngressCollector> | undefined;
  t.after(async () => {
    await collector?.stop();
    for (const peer of gateway.clients) peer.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), temporaryRoot);
    await rm(resolved, { recursive: true, force: true });
  });
  async function start() {
    const active = collector = createQqIngressCollector(options);
    active.server.listen(0, "127.0.0.1");
    await once(active.server, "listening");
    return openQqIngress(`http://127.0.0.1:${(active.server.address() as AddressInfo).port}`, token, "1001");
  }
  async function until<T>(probe: () => T | undefined | Promise<T | undefined>) {
    for (let i = 0; i < 225; i++) {
      const result = await probe();
      if (result !== undefined) return result;
      await delay(25);
    }
    assert.fail("The original recovery checkpoint was not completed.");
  }
  let read = await start();
  const signal = new AbortController().signal;
  const page = () => read(null, signal);
  const first = await until(async () => { const current = await page(); return current.online ? current : undefined; });
  for (const peer of gateway.clients) peer.send(JSON.stringify(groupEvent(11, checkpoint)));
  await until(async () => (await page()).entries.length === 1 ? true : undefined);
  const seed = new DatabaseSync(database);
  try { seed.prepare("UPDATE qq_ingress_messages SET received_at=? WHERE sequence=1").run(checkpoint * 1000); }
  finally { seed.close(); }

  phase = "interrupted";
  for (const peer of gateway.clients) peer.terminate();
  const resumed = await until(() => blocked);
  resumed.send(JSON.stringify(groupEvent(13)));
  await until(async () => (await page()).entries.some(item => item.message.messageId === "13") ? true : undefined);
  await collector!.stop();
  collector = undefined;
  phase = "resume";
  read = await start();
  const recovered = await until(async () => {
    const current = await page();
    return current.entries.some(item => item.message.messageId === "12") ? current : undefined;
  });
  assert.equal(recovered.feed, first.feed);
  assert.equal(recovered.missed, false);
  assert.deepEqual(recovered.entries.map(item => [item.message.messageId, item.recoveredAt ?? null]),
    [["11", null], ["13", null], ["12", missed.time * 1000]]);
  assert.equal(resumedReads, 4);
  assert.equal(writes, 0);
});

test("long QQ outages resume past the page budget and a stalled cursor remains pending", { timeout: 24_000 }, async t => {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, "ohjingjing-recovery-pages-"));
  const database = join(directory, "collector.db");
  const inspection = new DatabaseSync(database);
  inspection.exec(`CREATE TABLE qq_ingress_recovery (
    kind TEXT NOT NULL, scope_id TEXT NOT NULL, last_seen INTEGER NOT NULL, ticket TEXT NOT NULL, PRIMARY KEY(kind,scope_id)
  )`);
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const checkpoint = Math.floor(Date.now() / 1000) - 700;
  const event = (groupId: number, id: number, time: number) => ({ post_type: "message", message_type: "group",
    self_id: 1001, group_id: groupId, user_id: 2001, message_id: id, message_seq: id, real_seq: id, time,
    message: [{ type: "at", data: { qq: 1001 } }, { type: "text", data: { text: "累计补收测试" } }] });
  const older = event(5001, 7000, checkpoint - 10);
  const start = event(5001, 7001, checkpoint);
  const backlog = Array.from({ length: 550 }, (_, i) => event(5001, 7002 + i, checkpoint + i + 1)).reverse();
  const pages = [...backlog, start, older];
  const stalled = Array.from({ length: 50 }, (_, i) => event(5002, 8000 + i, checkpoint + i + 1)).reverse();
  const longReads: Array<number | undefined> = [];
  let stalledReads = 0;
  let writes = 0;
  gateway.on("connection", peer => peer.on("message", frame => {
    const { action, echo, params } = JSON.parse(String(frame));
    if (action.startsWith("send_")) writes++;
    let data: object = { online: true, good: true };
    if (action === "get_login_info") data = { user_id: 1001 };
    if (action === "get_group_msg_history") {
      if (params.group_id === 5001) {
        longReads.push(params.message_seq);
        const offset = params.message_seq === undefined ? 0 : pages.findIndex(row => row.message_seq === params.message_seq);
        assert.ok(offset >= 0);
        data = { messages: pages.slice(offset, offset + params.count) };
      } else {
        assert.equal(params.group_id, 5002);
        stalledReads++;
        data = { messages: stalled };
      }
    }
    peer.send(JSON.stringify({ status: "ok", retcode: 0, echo, data }));
  }));
  const token = "large-history-recovery-fixture-token";
  const collector = createQqIngressCollector({ accountId: "1001", groups: ["5001", "5002"], privateContacts: [], token, recoverHistory: true,
    database, gateway: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}` });
  t.after(async () => {
    await collector.stop();
    inspection.close();
    for (const peer of gateway.clients) peer.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), temporaryRoot);
    await rm(resolved, { recursive: true, force: true });
  });
  collector.server.listen(0, "127.0.0.1");
  await once(collector.server, "listening");
  const inbox = openQqIngress(`http://127.0.0.1:${(collector.server.address() as AddressInfo).port}`, token, "1001");
  async function until(check: () => unknown | Promise<unknown>) {
    for (let until = Date.now() + 11_000; Date.now() < until; await delay(25)) if (await check()) return;
    assert.fail("expected the backlog recovery checkpoint");
  }
  await until(async () => (await inbox(null, AbortSignal.timeout(1000))).online);
  const received = inspection.prepare("SELECT COUNT(*) AS n FROM qq_ingress_messages");
  const waiting = inspection.prepare("SELECT resume_before AS cursor, last_seen AS lastSeen FROM qq_ingress_recovery WHERE scope_id=?");
  for (const peer of gateway.clients) {
    peer.send(JSON.stringify(start));
    peer.send(JSON.stringify(event(5002, 7999, checkpoint)));
  }
  await until(() => received.get()?.n === 2);
  inspection.prepare("UPDATE qq_ingress_messages SET received_at=?").run(checkpoint * 1000);
  for (const peer of gateway.clients) peer.terminate();
  await until(() => (waiting.get("5001")?.cursor ?? null) !== null);
  assert.equal(longReads.length, 10);
  const cursor = waiting.get("5001")!.cursor;
  assert.equal(waiting.get("5001")!.lastSeen, checkpoint * 1000);
  await until(() => !waiting.get("5001"));
  assert.equal(longReads[10], cursor);
  const completed = inspection.prepare("SELECT event_key, recovered_at FROM qq_ingress_messages WHERE event_key GLOB 'group:5001:*' ORDER BY event_key").all();
  assert.equal(completed.length, backlog.length + 1);
  assert.equal(completed[0].event_key, "group:5001:7001");
  assert.equal(completed[0].recovered_at, null);
  assert.equal(completed[1].recovered_at, (checkpoint + 1) * 1000);
  await until(() => stalledReads >= 4);
  assert.equal(waiting.get("5002")?.cursor, stalled.at(-1)?.message_seq);
  assert.equal(writes, 0);
});

test("QQ reconnect backfills source-bounded group events without replaying replies", { timeout: 18_000 }, async t => {
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const admin = "group-recovery-fixture-admin-token";
  const scope = "qq:1001:5001";
  const service = createGroupService({ database: ":memory:", adminToken: admin, observeGroups: ["5001"], summaryGroups: ["5001"],
    channel: { address: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`, enabled: true, groups: ["5001"],
      roleId: "", modelId: "", hasToken: false, expectedBotId: "1001", recoverHistory: true },
  });
  t.after(async () => {
    await service.stop();
    for (const client of gateway.clients) client.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const api = (path: string, key = admin, payload?: object) => fetch(base + path, {
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    method: payload ? "POST" : "GET", body: payload && JSON.stringify(payload),
  });
  const record = (id: number, group: number, text: string, mention = false, age = 0) => ({
    post_type: "message", message_type: "group", self_id: 1001, group_id: group, user_id: 2001, message_id: id,
    message_seq: id, real_seq: id === -22 ? 22 : id,
    time: Math.floor(Date.now() / 1000) - age, message: [...mention ? [{ type: "at", data: { qq: 1001 } }] : [],
      { type: "text", data: { text } }],
  });
  let sent = 0;
  const historyCursors: (number | undefined)[] = [];
  function respond(peer: WebSocket) {
    peer.on("message", packet => {
      const { action, echo, params } = JSON.parse(String(packet));
      let data: object = { online: true, good: true };
      if (action === "get_login_info") data = { user_id: 1001, nickname: "测试机器人" };
      if (action === "send_group_msg") sent++;
      if (action === "get_group_msg_history") {
        assert.equal(params.group_id, 5001);
        assert.equal(params.count, 50);
        historyCursors.push(params.message_seq);
        const sticker = record(5, 5001, "/收藏表情 离线表情");
        if (params.message_seq === undefined) {
          data = { messages: [record(-22, 5001, "离线期间的点名", true), record(3, 5002, "跨群排除", false, 180)] };
        } else {
          assert.deepEqual(params, { group_id: 5001, count: 50, message_seq: -22, reverseOrder: true });
          data = { messages: [record(1, 5001, "之前收到"), record(7, 5001, "更早的离线消息"), record(-22, 5001, "离线期间的点名", true),
            record(4, 5001, "检查点以前", false, 180),
            { ...sticker, message: [...sticker.message, { type: "image", data: { url: "https://gchat.qpic.cn/recovery-fixture.png" } }] }] };
        }
      }
      peer.send(JSON.stringify({ status: "ok", retcode: 0, echo, data }));
    });
  }
  async function until<T>(read: () => Promise<T | undefined>) {
    for (let i = 0; i < 350; i++) {
      const result = await read();
      if (result !== undefined) return result;
      await delay(20);
    }
    assert.fail("The expected recovery did not happen");
  }
  const connected = once(gateway, "connection");
  service.startChannel();
  const [first] = await connected as [WebSocket];
  respond(first);
  first.send(JSON.stringify(record(1, 5001, "之前收到")));
  await until(async () => (await (await api("/admin/status")).json()).groups.length ? true : undefined);
  const granted = await (await api("/admin/subscribers", admin, { qqId: "2001", groups: [scope], messageGroups: [scope] })).json();
  const nextConnection = once(gateway, "connection");
  first.terminate();
  const [second] = await nextConnection as [WebSocket];
  respond(second);
  const feed = await until(async () => {
    const page = await (await api("/api/workspace/feed", granted.token)).json();
    return page.items?.length === 3 ? page : undefined;
  });
  assert.deepEqual(feed.items.map((item: { message: { text: string } }) => item.message.text), ["之前收到", "更早的离线消息", "离线期间的点名"]);
  assert.deepEqual(historyCursors, [undefined, -22]);
  assert.equal(sent, 0);
});

test("the QQ collector retains events across cutover and backfills observations after gateway reconnect", { timeout: 25_000 }, async t => {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, "ohjingjing-ingress-"));
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sent: { action: string; text: string }[] = [];
  let history: object[] = [];
  let historyReads = 0;
  let privateHistory: object[] = [];
  let olderPrivateHistory: object[] = [];
  const privateHistoryReaders: number[] = [];
  const privateHistoryCursors: (number | undefined)[] = [];
  gateway.on("connection", peer => peer.on("message", packet => {
    const { action, echo, params } = JSON.parse(String(packet));
    let data: object = { online: true, good: true };
    if (action === "get_login_info") data = { user_id: 1001, nickname: "测试机器人" };
    if (action === "get_group_msg_history") {
      assert.equal(params.group_id, 5001);
      historyReads++;
      data = { messages: history };
    }
    if (action === "get_friend_msg_history") {
      privateHistoryReaders.push(params.user_id);
      privateHistoryCursors.push(params.message_seq);
      if (params.message_seq !== undefined) assert.deepEqual(params, { user_id: 2001, count: 50, message_seq: 32, reverseOrder: true });
      data = { messages: params.message_seq === undefined ? privateHistory : olderPrivateHistory };
    }
    if (action === "send_group_msg" || action === "send_private_msg") {
      sent.push({ action, text: params.message[0].data.text });
      data = { message_id: 7000 + sent.length };
    }
    peer.send(JSON.stringify({ status: "ok", retcode: 0, echo, data }));
  }));
  await once(gateway, "listening");
  const address = `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  const token = "independent-qq-collector-fixture";
  const admin = "server-admin-collector-test-fixture";
  const serviceDatabase = join(directory, "service.db");
  const collectorOptions = { accountId: "1001", groups: ["5001"], privateContacts: [], token, recoverHistory: true,
    database: join(directory, "ingress.db"), policyDatabase: serviceDatabase, gateway: address };
  let collector = createQqIngressCollector(collectorOptions);
  let service: ReturnType<typeof createGroupService> | undefined;
  t.after(async () => {
    await service?.stop();
    await collector.stop();
    for (const peer of gateway.clients) peer.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), temporaryRoot);
    await rm(resolved, { recursive: true, force: true });
  });
  collector.server.listen(0, "127.0.0.1");
  await once(collector.server, "listening");
  const relayPort = (collector.server.address() as AddressInfo).port;
  const ingress = `http://127.0.0.1:${relayPort}`;
  const readIngress = openQqIngress(ingress, token, "1001");
  async function startService() {
    service = createGroupService({ database: serviceDatabase, adminToken: admin,
      qqIngress: ingress, qqIngressToken: token, development: { target: "cutover-test", maintainers: ["2001"] },
      observeGroups: ["5001"], summaryGroups: ["5001"], channel: { address, enabled: true, groups: ["5001"], roleId: "", modelId: "", hasToken: false,
        expectedBotId: "1001", verifyExpectedBot: true, recoverHistory: true } });
    service.server.listen(0, "127.0.0.1");
    await once(service.server, "listening");
    service.startChannel();
    return `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  }
  let base = await startService();
  const request = (path: string, method = "GET", body?: object) => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body),
  });
  async function until<T>(probe: () => T | Promise<T | undefined> | undefined) {
    for (let i = 0; i < 200; i++) {
      const found = await probe();
      if (found !== undefined) return found;
      await delay(25);
    }
    assert.fail("The QQ handoff did not reach the expected state");
  }
  function broadcast(event: object) { for (const peer of gateway.clients) peer.send(JSON.stringify(event)); }
  const group = (id: number, groupId = 5001) => ({ post_type: "message", message_type: "group", self_id: 1001,
    group_id: groupId, user_id: 2001, message_id: id, message: [{ type: "at", data: { qq: 1001 } }, { type: "text", data: { text: "在吗" } }] });
  const direct = (id: number, text: string, time: number, userId = 2001) => ({ post_type: "message", message_type: "private",
    sub_type: "friend", self_id: 1001, target_id: 1001, user_id: userId, sender: { user_id: userId }, message_id: id, time,
    message_seq: id, real_seq: id,
    message: [{ type: "text", data: { text } }] });
  const readRelay = () => readIngress(null, AbortSignal.timeout(1000));
  const ready = () => until(async () => (await (await request("/admin/qq-ingress")).json()).ready ? true : undefined);
  assert.equal((await fetch(ingress + "/inbox")).status, 401);
  await ready();
  assert.equal((await request("/admin/private-contacts", "PUT", { userId: "2001" })).status, 200);
  assert.equal((await request("/admin/private-contacts", "PUT", { userId: "2009" })).status, 200);
  broadcast(group(11));
  broadcast(group(11));
  await until(() => sent.length === 1 ? true : undefined);

  const pause = await request("/admin/qq-ingress/drain", "POST");
  assert.deepEqual(await pause.json(), { drained: true });
  broadcast(group(12));
  await until(async () => (await readRelay()).entries.length === 2 ? true : undefined);
  assert.equal(sent.length, 1);
  await service!.stop();
  service = undefined;
  broadcast(group(12));
  broadcast(group(13));
  broadcast(group(90, 5002));
  broadcast({ post_type: "message", message_type: "private", sub_type: "friend", self_id: 1001, user_id: 2001, message_id: 14,
    message: [{ type: "text", data: { text: "/开发 保留切换期间的任务" } }] });
  const buffered = await until(async () => (await readRelay()).entries.length === 4 ? await readRelay() : undefined);
  assert.deepEqual(buffered.entries.map(entry => entry.message.messageId), ["11", "12", "13", "14"]);

  await collector.stop();
  collector = createQqIngressCollector(collectorOptions);
  collector.server.listen(relayPort, "127.0.0.1");
  await once(collector.server, "listening");
  const restartedRelay = await until(() => readRelay().catch(() => undefined));
  assert.equal(restartedRelay.feed, buffered.feed);
  base = await startService();
  await ready();
  await until(() => sent.length === 4 ? true : undefined);
  assert.equal(sent.filter(item => item.action === "send_group_msg").length, 3);
  assert.equal(sent.filter(item => item.action === "send_private_msg").length, 1);
  assert.match(sent.find(item => item.action === "send_private_msg")?.text ?? "", /已受理开发任务/u);
  broadcast(group(13));
  await until(async () => (await (await request("/admin/qq-ingress")).json()).pending === 0 ? true : undefined);
  const traces = await (await request("/admin/group-reply-traces?scope=qq%3A1001%3A5001")).json();
  assert.deepEqual(traces.items.map((item: { eventId: string }) => item.eventId).sort(), ["11", "12", "13"]);
  assert.equal(sent.length, 4);

  const holdId = randomUUID();
  const locked = await (await request("/admin/qq-ingress/drain", "POST", { holdId })).json();
  assert.deepEqual(locked, { drained: true, holdId });
  const across = group(20);
  broadcast(across);
  await until(async () => (await readRelay()).entries.some(entry => entry.message.messageId === "20") ? true : undefined);
  await service!.stop();
  service = undefined;
  base = await startService();
  await ready();
  const held = await (await request("/admin/qq-ingress")).json();
  assert.deepEqual([held.holdSupported, held.paused, held.holdId, held.pending], [true, true, holdId, 1]);
  assert.equal((await request("/admin/qq-ingress/resume", "POST", { holdId: randomUUID() })).status, 409);
  assert.equal((await request("/admin/qq-ingress/drain", "POST", { holdId: randomUUID() })).status, 409);
  broadcast(across);
  await delay(650);
  assert.equal(sent.length, 4);
  const released = await (await request("/admin/qq-ingress/resume", "POST", { holdId })).json();
  assert.equal(released.paused, false);
  await until(() => sent.length === 5 ? true : undefined);
  broadcast(across);
  await delay(650);
  assert.equal(sent.length, 5);
  const afterHold = await (await request("/admin/group-reply-traces?eventId=20")).json();
  assert.equal(afterHold.items.length, 1);
  assert.equal(afterHold.items[0].receipts[0].platformMessageId, "7005");

  const readsBefore = historyReads;
  const privateReadsBefore = privateHistoryReaders.length;
  const platformTime = Math.floor(Date.now() / 1000);
  const recovered = { ...group(21), time: platformTime };
  history = [{ ...across, time: platformTime }, recovered, { ...group(22, 5002), time: platformTime },
    { ...group(23), time: platformTime - 60 }];
  const recoveredPrivate = direct(31, "离线时补充的私聊", platformTime);
  const recoveredCommand = direct(32, "/开发 不应执行的历史任务", platformTime);
  privateHistory = [recoveredCommand, direct(33, "异会话记录", platformTime - 60, 2009),
    { ...direct(35, "发到另一个账号的记录", platformTime), target_id: 9999 }];
  olderPrivateHistory = [direct(14, "/开发 保留切换期间的任务", platformTime), recoveredPrivate, recoveredCommand,
    direct(34, "机器人发出的记录", platformTime, 1001), direct(36, "检查点以前", platformTime - 60)];
  for (const peer of gateway.clients) peer.terminate();
  const caught = await until(async () => (await readRelay()).entries.find(entry => entry.message.messageId === "21"));
  assert.equal(caught.recoveredAt, platformTime * 1000);
  assert.ok(historyReads > readsBefore);
  const caughtPrivate = await until(async () => (await readRelay()).entries.find(entry => entry.message.messageId === "32") ? await readRelay() : undefined);
  assert.deepEqual(caughtPrivate.entries.map(entry => entry.message.messageId), ["11", "12", "13", "14", "20", "21", "31", "32"]);
  assert.equal(caughtPrivate.entries.find(entry => entry.message.messageId === "31")?.recoveredAt, platformTime * 1000);
  assert.deepEqual(privateHistoryReaders.slice(privateReadsBefore), [2001, 2001]);
  assert.deepEqual(privateHistoryCursors.slice(privateReadsBefore), [undefined, 32]);
  const legacyView = await (await fetch(ingress + "/inbox", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(legacyView.entries.map((entry: { message: { messageId: string } }) => entry.message.messageId), ["11", "12", "13", "14", "20"]);
  const priorServiceView = await (await fetch(ingress + "/inbox?history=1", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(priorServiceView.entries.map((entry: { message: { messageId: string } }) => entry.message.messageId), ["11", "12", "13", "14", "20", "21"]);

  const stored = new DatabaseSync(serviceDatabase, { readOnly: true });
  try {
    const received = stored.prepare("SELECT created_at FROM channel_events WHERE scope='qq:1001:5001' AND message_id=?");
    assert.equal(await until(() => received.get("21")?.created_at as string | undefined), new Date(platformTime * 1000).toISOString());
    assert.equal(stored.prepare("SELECT COUNT(*) AS n FROM group_messages WHERE scope='qq:1001:5001' AND event_id='21'").get()?.n, 1);
    assert.equal((await (await request("/admin/group-reply-traces?eventId=21")).json()).items.length, 0);
    const privateEvent = stored.prepare("SELECT created_at FROM channel_events WHERE scope='qq-private:1001:2001' AND message_id=?");
    assert.equal(await until(() => privateEvent.get("private:2001:32")?.created_at as string | undefined), new Date(platformTime * 1000).toISOString());
    assert.equal(privateEvent.get("private:2001:31")?.created_at, new Date(platformTime * 1000).toISOString());
    const privateMessages = stored.prepare("SELECT content FROM messages WHERE scope='qq-private:1001:2001' ORDER BY id");
    assert.deepEqual(privateMessages.all().map(row => row.content), ["离线时补充的私聊"]);
    assert.equal(sent.length, 5);
    broadcast(recovered);
    broadcast(recoveredPrivate);
    broadcast(recoveredCommand);
    broadcast(group(24));
    await until(() => sent.length === 6 ? true : undefined);
    assert.equal(stored.prepare("SELECT COUNT(*) AS n FROM channel_events WHERE scope='qq:1001:5001' AND message_id='21'").get()?.n, 1);
    assert.equal((await (await request("/admin/group-reply-traces?eventId=24")).json()).items[0].receipts[0].platformMessageId, "7006");
    assert.deepEqual(privateMessages.all().map(row => row.content), ["离线时补充的私聊"]);
    assert.equal(sent.filter(item => item.action === "send_private_msg").length, 1);
  } finally { stored.close(); }
});

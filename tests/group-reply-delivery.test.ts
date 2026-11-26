import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { dafeiyuExpressions, readCommandReply, readGroupReply, readRoleExpressions } from "../runtime/group-replies";
import { createGroupService, type GroupServiceOptions } from "../runtime/group-service";
import { openGroupTopics, readTopicSummary } from "../runtime/group-topics";
import { createPublishedRole } from "../runtime/published-role";
import { openStore } from "../runtime/store";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";

test("group replies keep formatting and select only validated role expressions", () => {
  assert.deepEqual(readGroupReply("一份清单\n1. 第一项\n2. 第二项", dafeiyuExpressions), [{ text: "一份清单\n1. 第一项\n2. 第二项" }]);
  assert.deepEqual(readGroupReply('```\n{"action":"reply","parts":["（点头）同意[CQ:at,qq=all]"],"expression":"agree"}\n```',
    dafeiyuExpressions), [{ text: "同意", expression: dafeiyuExpressions[1] }]);
  assert.deepEqual(readGroupReply('{"action":"reply","parts":["收到"],"expression":"unknown"}', dafeiyuExpressions), [{ text: "收到" }]);
  assert.deepEqual(readGroupReply('{"action":"reply","text":"桌游开局。"}', dafeiyuExpressions), [{ text: "桌游开局。" }]);
  assert.deepEqual(readGroupReply('{"action":"reply","parts":["一","二","三"],"text":"不能绕开分段校验"}', dafeiyuExpressions), []);
  assert.deepEqual(readGroupReply('{"action":"reply","parts":["一","二","三"]}', dafeiyuExpressions), []);
  assert.deepEqual(readGroupReply('{"action":"reply","parts":', dafeiyuExpressions), []);
  assert.deepEqual(readGroupReply('{"action":"send_image","parts":["收到"]}', dafeiyuExpressions), []);
  assert.equal(readGroupReply("🐟".repeat(701), dafeiyuExpressions)[0].text, "🐟".repeat(700));
  assert.throws(() => readRoleExpressions([{ id: "hello", label: "问好", emoji: "🙂", png: "https://example.test/x.png" }]), /内嵌 PNG/);
});

test("command replies preserve the exact service result and accept only a single optional introduction", () => {
  const result = "已安排提醒 #46\n2026-11-25 18:00 · 喝水";
  const draft = (intro: string, action = "reply") => JSON.stringify({ action, intro });
  assert.equal(readCommandReply(draft("喏，给你看一下。"), result), "喏，给你看一下。\n" + result);
  for (const malformed of [draft(""), draft("{}"), draft("已安排提醒 #99"), draft("去这里 https://example.test"),
    draft("[CQ:at,qq=all]"), draft("第一句\n第二句"), draft("嗯", "web_search"), "收到"]) {
    assert.equal(readCommandReply(malformed, result), result);
  }
  assert.equal(readCommandReply(null, result), result);
});

test("QQ sticker commands collect explicit attachments and only send items from the current group", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-stickers-"));
  const database = join(directory, "chat.db");
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const connected = once(gateway, "connection");
  const groups = ["5001", "5002"];
  const admin = "sticker-fixture-admin-secret";
  const service = createGroupService({ database, observeGroups: groups, adminToken: admin,
    channel: { enabled: true, address: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`, groups,
      roleId: "", modelId: "", hasToken: false, expectedBotId: "1001", ownerId: "2003" } });
  t.after(async () => {
    await service.stop();
    for (const peer of gateway.clients) peer.terminate();
    await new Promise<void>(done => gateway.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  });
  const image = Buffer.from(png.split(",", 2)[1], "base64");
  const stickerUrl = "https://gchat.qpic.cn/fixture.png";
  let downloads = 0;
  const network = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: URL | string, options?: RequestInit) => {
    if (new URL(url).hostname === "127.0.0.1") return network(url, options);
    assert.equal(options?.redirect, "error");
    if (String(url) === stickerUrl) { downloads++; return new Response(new Uint8Array(image)); }
    assert.equal(String(url), "https://gchat.qpic.cn/large.png");
    return new Response(new Uint8Array(256 * 1024 + 1));
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  service.startChannel();
  const [peer] = await connected;
  type Segment = { type: string; data: Record<string, string> };
  const deliveries: { group: number; message: Segment[] }[] = [];
  let acknowledgeImage = true;
  peer.on("message", (packet: Buffer) => {
    const { action, echo, params } = JSON.parse(String(packet));
    let data: object = { online: true, good: true };
    if (action === "get_login_info") data = { user_id: 1001, nickname: "示例机器人" };
    if (action === "get_msg" && ["19", "20"].includes(String(params.message_id))) data = { message_id: params.message_id, message_type: "group", group_id: 5001,
      sender: { user_id: 2001 }, message: [attachment] };
    if (action === "send_group_msg") {
      deliveries.push({ group: params.group_id, message: params.message });
      data = !acknowledgeImage && params.message[0]?.type === "image" ? {} : { message_id: 900 + deliveries.length };
    }
    peer.send(JSON.stringify({ status: "ok", retcode: 0, echo, data }));
  });
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  async function wait(check: () => boolean | Promise<boolean>) {
    for (let count = 0; count < 150; count++) {
      if (await check()) return;
      await delay(20);
    }
    assert.fail("QQ sticker fixture did not complete.");
  }
  const emit = (id: number, text: string, group = 5001, actor = 2001, attachments: Segment[] = []) => peer.send(JSON.stringify({
    post_type: "message", message_type: "group", self_id: 1001, user_id: actor, group_id: group, message_id: id,
    message: [{ type: "text", data: { text } }, ...attachments],
  }));
  const attachment = { type: "image", data: { url: stickerUrl } };
  const ask = async (...command: Parameters<typeof emit>) => {
    const count = deliveries.length;
    emit(...command);
    await wait(() => deliveries.length > count);
    return deliveries[count].message[0].data.text;
  };
  await wait(async () => (await (await fetch(base + "/admin/gateway", { headers: {
    Authorization: `Bearer ${admin}`,
  } })).json()).matchesExpected);
  emit(1, "一张普通群图", 5001, 2001, [attachment]);
  assert.equal(await ask(2, "/找表情"), "本群没有匹配的表情。");
  assert.equal(downloads, 0);
  assert.match(await ask(3, "/收藏表情 早安", 5001, 2001, [
    { type: "reply", data: { id: "1" } }, attachment,
  ]), /同一条消息/u);
  assert.equal(downloads, 0);
  const collected = await ask(4, "/收藏表情 Morning 早安", 5001, 2001, [attachment]);
  const stickerId = /编号 ([a-f0-9]{10})/u.exec(collected)?.[1];
  assert.ok(stickerId);
  emit(4, "/收藏表情 重复事件", 5001, 2001, [attachment]);
  assert.match(await ask(5, "/收藏表情 新标签", 5001, 2002, [attachment]), new RegExp(`本群已收藏.+${stickerId}`, "u"));
  assert.equal(downloads, 2);
  assert.match(await ask(6, "/找表情 MORNING", 5001), new RegExp(`${stickerId}  Morning 早安`, "u"));
  assert.equal(await ask(7, "/找表情 早安", 5002), "本群没有匹配的表情。");
  assert.equal(await ask(8, `/发表情 ${stickerId}`, 5002), "本群没有这个编号的表情。");
  assert.equal(await ask(9, `/删除表情 ${stickerId}`, 5001, 2002), "找不到你可以删除的表情。");
  await ask(10, `/发表情 ${stickerId}`, 5001, 2002);
  assert.deepEqual(deliveries.at(-1), { group: 5001, message: [{ type: "image", data: { file: `base64://${image.toString("base64")}` } }] });
  acknowledgeImage = false;
  await ask(11, `/发表情 ${stickerId}`);
  const stored = new DatabaseSync(database);
  try {
    const receipt = stored.prepare("SELECT status,platform_message_id FROM outbox WHERE scope='qq:1001:5001' AND event_id=?");
    await wait(() => receipt.get("sticker:11")?.status === "unknown");
    assert.ok(receipt.get("sticker:10")?.platform_message_id);
    assert.equal(await ask(12, `/删除表情 ${stickerId}`, 5001, 2003), "已从本群移除这张表情。");
    assert.match(await ask(13, "/收藏表情 过大", 5001, 2001, [{ type: "image", data: { url: "https://gchat.qpic.cn/large.png" } }]), /读取失败/u);
    assert.match(await ask(14, "/收藏表情 外链", 5001, 2001, [{ type: "image", data: { url: "https://example.invalid/image.png" } }]), /读取失败/u);
    await ask(15, "/收藏表情 临时", 5001, 2001, [attachment]);
    stored.prepare("UPDATE qq_group_stickers SET created_at='2000-01-01T00:00:00Z'").run();
    assert.equal(await ask(16, "/找表情"), "本群没有匹配的表情。");
    await ask(17, "/收藏表情 重新收藏", 5001, 2001, [attachment]);
    assert.equal(stored.prepare("SELECT COUNT(*) AS n FROM qq_group_stickers").get()?.n, 1);
    assert.equal(stored.prepare("SELECT COUNT(*) AS n FROM requests").get()?.n, 0);
    const count = downloads;
    assert.match(await ask(18, "/收藏表情 双图", 5001, 2001, [attachment, attachment]), /同一条消息/u);
    const missingUrl = { type: "image", data: { file: "fixture.png" } };
    assert.match(await ask(19, "/收藏表情 原消息", 5001, 2001, [missingUrl]), /本群已收藏/u);
    assert.match(await ask(20, "/收藏表情 其他群", 5002, 2001, [missingUrl]), /读取失败/u);
    assert.equal(downloads, count + 1);
  } finally { stored.close(); }
});

test("a bare group call stays with its sender and opens one explicit Pi search", async t => {
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const connected = once(gateway, "connection");
  const admin = "group-web-fixture-admin-secret";
  const groups = ["5001", "5002"];
  const modelUrl = "https://model.example.org";
  const source = "https://example.org/report";
  const lookups: string[] = [];
  const prompts: { role: string; content: string }[][] = [];
  let fresh = true;
  const fetchNetwork = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: URL | string, options?: RequestInit) => {
    if (String(url).startsWith(modelUrl)) {
      prompts.push(JSON.parse(String(options?.body)).messages);
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        action: "reply", parts: ["有一条近期报道。"],
      }) } }] });
    }
    if (!String(url).startsWith("https://mcp.exa.ai/")) return fetchNetwork(url, options);
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    const { id, method, params } = JSON.parse(String(options?.body));
    if (method === "initialize") return Response.json({ jsonrpc: "2.0", id, result: {
      protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
    } });
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.equal(params.name, "web_search_exa");
    lookups.push(params.arguments.query);
    const date = fresh ? new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) : "2020-01-01";
    return Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text",
      text: `Title: 新闻样本\nURL: ${source}\nPublished: ${date}\nHighlights:\n模拟报道`,
    }] } });
  });
  const service = createGroupService({ database: ":memory:", adminToken: admin, observeGroups: groups,
    channel: { address: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`, enabled: true, groups, roleId: "",
      modelId: "fixture", hasToken: false, expectedBotId: "1001" },
    model: { id: "fixture", name: "模拟模型", model: "fixture", baseUrl: modelUrl, billing: "none", hasKey: false,
      inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "", contextBudget: 4096 },
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  t.after(async () => {
    await service.stop();
    for (const peer of gateway.clients) peer.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
  });
  service.startChannel();
  const [peer] = await connected;
  const sends: string[] = [];
  peer.on("message", (packet: Buffer) => {
    const { action, echo, params } = JSON.parse(String(packet));
    let data = {};
    if (action === "get_status") data = { online: true, good: true };
    if (action === "get_login_info") data = { user_id: 1001, nickname: "测试机器人" };
    if (action === "send_group_msg") {
      assert.equal(params.group_id, 5001);
      sends.push(params.message[0].data.text);
      data = { message_id: 901 + sends.length };
    }
    peer.send(JSON.stringify({ status: "ok", retcode: 0, echo, data }));
  });
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const api = async (path: string) => (await fetch(base + path, { headers: { Authorization: `Bearer ${admin}` } })).json();
  async function wait<T>(read: () => T | Promise<T>) {
    for (let count = 0; count < 250; count++) {
      const item = await read();
      if (item) return item;
      await delay(20);
    }
    assert.fail("Expected group reply was not acknowledged.");
  }
  const trace = (id: number) => wait(async () => (await api(`/admin/group-reply-traces?eventId=${id}`)).items
    .find((item: { state: string }) => item.state === "finished"));
  const say = (id: number, content: string, actor = 2001, group = 5001, mention = false) => peer.send(JSON.stringify({
    post_type: "message", message_type: "group", message_id: id, self_id: 1001, group_id: group, user_id: actor,
    message: [...mention ? [{ type: "at", data: { qq: "1001" } }] : [], { type: "text", data: { text: content } }],
  }));
  await wait(async () => (await api("/admin/status")).channel === "online");
  say(1, "另一位群友的讨论记录", 2002);
  say(2, "大肥鱼");
  assert.equal((await trace(2)).reason, "ping");
  assert.deepEqual(sends, ["在。"]);
  assert.equal(prompts.length, 0);
  const query = "帮我搜一下样本人物最近的新闻";
  say(3, query, 2002);
  say(4, query, 2001, 5002);
  say(5, query);
  const follow = await trace(5);
  assert.equal(follow.trigger, "follow-up");
  assert.ok(follow.context.included.some((item: { kind: string }) => item.kind === "web-tool"));
  assert.equal(follow.receipts[0].status, "sent");
  assert.deepEqual(lookups, ["样本人物最近的新闻"]);
  assert.equal(sends[1], `有一条近期报道。\n来源：${source}`);
  assert.doesNotMatch(JSON.stringify(prompts[0]), /另一位群友的讨论记录/u);
  say(6, query);
  say(7, "大肥鱼，" + query, 2002);
  await trace(7);
  assert.equal(lookups.length, 2);
  fresh = false;
  say(8, query, 2001, 5001, true);
  const insufficient = await trace(8);
  assert.match(sends.at(-1)!, /没找到能核实发布日期/u);
  assert.equal(insufficient.requestId, null);
  assert.equal(insufficient.providerModelId, null);
  assert.equal(insufficient.receipts[0].status, "sent");
  assert.equal(prompts.length, 2);

  const start = "写一句合作探险开场白。原定道具在旧柜，队伍三组。";
  const correction = "更正：铜钟在钟楼，只有两组。";
  const finalLine = "结尾请用问句。";
  const prompt = () => JSON.parse(prompts.at(-1)!.at(-1)!.content);
  say(9, start, 2001, 5001, true);
  say(10, "可参考布景。" + "远处有灯。".repeat(125) + correction);
  assert.equal((await trace(9)).receipts[0].status, "sent");
  const fullSupplement = prompt().current.endsWith(correction);
  say(11, start + "远处可布景。".repeat(660), 2001, 5001, true);
  say(12, correction);
  say(13, finalLine);
  say(14, "另一位群友要求独自出发。", 2002);
  const fitted = await trace(11);
  assert.equal(fitted.receipts[0].status, "sent");
  assert.ok(fitted.context.omitted > 0);
  assert.ok(fitted.context.estimatedTokens <= 4096);
  assert.ok(prompt().current.startsWith(start));
  assert.deepEqual({ fullSupplement, newestInOrder: prompt().current.endsWith(correction + "\n" + finalLine) },
    { fullSupplement: true, newestInOrder: true });
  assert.doesNotMatch(prompt().current, /另一位群友/u);
  assert.equal(prompts.length, 4);
  assert.equal(lookups.length, 3);
});

test("workspace feed requires a separate grant for each group's archived messages and invalidates stale cursors", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-workspace-feed-"));
  const database = join(directory, "test.db");
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const pending = once(gateway, "connection");
  const admin = "workspace-feed-fixture-secret";
  const scopes = ["qq:1001:5001", "qq:1001:5002"];
  const groups = ["5001", "5002"];
  const service = createGroupService({ database, adminToken: admin, observeGroups: groups, summaryGroups: groups, recallGroups: ["5001"],
    channel: { address: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`, enabled: true, groups: ["5001"],
      roleId: "", modelId: "", hasToken: false, expectedBotId: "1001" },
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  t.after(async () => {
    await service.stop();
    for (const client of gateway.clients) client.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  service.startChannel();
  const [peer] = await pending;
  const deliveries: { group_id: number; message: { data: { text: string } }[] }[] = [];
  peer.on("message", (packet: Buffer) => {
    const { action, echo, params } = JSON.parse(String(packet));
    if (action === "send_group_msg") deliveries.push(params);
    const data = action === "send_group_msg" ? { message_id: 901 }
      : action === "get_login_info" ? { user_id: 1001, nickname: "测试机器人" } : { online: true, good: true };
    peer.send(JSON.stringify({ status: "ok", retcode: 0, echo, data }));
  });
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const api = (path: string, key = admin, body?: object, method = body ? "POST" : "GET") => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  async function wait<T>(read: () => Promise<T | undefined>) {
    for (let i = 0; i < 400; i++) {
      const result = await read();
      if (result !== undefined) return result;
      await delay(15);
    }
    assert.fail("Expected workspace operation did not finish");
  }
  const emit = (id: number, group: number, text: string) => peer.send(JSON.stringify({
    post_type: "message", message_type: "group", self_id: 1001, user_id: 2001, group_id: group, message_id: id,
    message: [{ type: "text", data: { text } }],
  }));
  const grant = (groups: string[], messageGroups?: string[]) => api("/admin/subscribers", admin, { qqId: 2001, groups, messageGroups });
  const feed = (token: string, cursor?: string) => api("/api/workspace/feed" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""), token);
  await wait(async () => (await (await api("/admin/status")).json()).channel === "online" ? true : undefined);
  emit(1, 5001, "授权原文");
  emit(2, 5002, "另一个群的原文");
  await wait(async () => (await (await api("/admin/status")).json()).groups.length === 2 ? true : undefined);
  assert.equal((await grant([scopes[0]], [scopes[1]])).status, 400);
  const readOnly = await (await grant(scopes)).json();
  const full = await (await grant(scopes, [scopes[0]])).json();
  const first = await (await feed(full.token)).json();
  assert.equal(first.platform, "qq");
  assert.equal(first.reset, true);
  assert.deepEqual(first.conversations.map((group: { messageAccess: boolean }) => group.messageAccess).sort(), [false, true]);
  assert.deepEqual(first.items.map((item: { message: { text: string } }) => item.message.text), ["授权原文"]);
  const denied = await (await feed(readOnly.token, first.cursor)).json();
  assert.equal(denied.reset, true);
  assert.deepEqual(denied.items, []);
  emit(3, 5001, "后来的一条");
  const next = await wait(async () => {
    const page = await (await feed(full.token, first.cursor)).json();
    return page.items.length ? page : undefined;
  });
  assert.equal(next.reset, false);
  assert.deepEqual(next.items.map((item: { message: { text: string } }) => item.message.text), ["后来的一条"]);
  assert.deepEqual((await (await feed(full.token, next.cursor)).json()).items, []);
  assert.equal((await api(`/admin/subscribers/${full.id}`, admin, undefined, "DELETE")).status, 200);
  assert.equal((await feed(full.token, next.cursor)).status, 401);

  const permitted = await (await api("/admin/subscribers", admin, { qqId: 2001, groups: scopes, replyGroups: [scopes[0]] })).json();
  const send = (key: string, conversationId: string) => api("/api/workspace/reply", key, { conversationId,
    text: "工作区原渠道回复", requestId: "11111111-2222-4333-8444-555555555555" });
  assert.equal((await send(readOnly.token, scopes[0])).status, 403);
  assert.equal((await send(permitted.token, scopes[1])).status, 403);
  assert.deepEqual(await (await send(permitted.token, scopes[0])).json(), { status: "sent", messageId: "901" });
  assert.deepEqual(await (await send(permitted.token, scopes[0])).json(), { status: "sent", messageId: "901" });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].group_id, 5001);
  assert.equal(deliveries[0].message[0].data.text, "工作区原渠道回复");
  const featureFeed = await (await feed(permitted.token)).json();
  assert.ok(featureFeed.featureRevision);
  assert.ok(featureFeed.features.some((feature: { id: string }) => feature.id === "group-week-topics"));
  const reviewPath = "/api/workspace/features/group-topic-review?conversation=";
  assert.ok(featureFeed.features.some((feature: { id: string }) => feature.id === "group-topic-review"));
  assert.equal((await api(reviewPath + scopes[0], readOnly.token)).status, 200);
  assert.equal((await api(reviewPath + "qq:1001:5003", readOnly.token)).status, 404);
  assert.equal((await api(reviewPath + scopes[0], full.token)).status, 401);
  assert.deepEqual(await (await api(`/admin/group-topic-review?scope=${scopes[0]}&days=1`)).json().then(payload => payload.items), []);
  assert.equal((await api(`/admin/group-topic-review?scope=${scopes[0]}&days=365`)).status, 400);
  assert.equal((await api(`/admin/group-topic-review?scope=${scopes[0]}`, readOnly.token)).status, 403);
  assert.deepEqual(await (await api(`/api/workspace/features/group-week-topics?conversation=${scopes[0]}`, permitted.token)).json(), { items: [] });
  assert.equal((await api("/api/workspace/features/group-week-topics?conversation=qq:1001:5003", permitted.token)).status, 404);
  emit(9, 5001, "/本周话题");
  emit(9, 5001, "/本周话题");
  await wait(async () => deliveries.length === 2 ? true : undefined);
  assert.match(deliveries[1].message[0].data.text, /本群本周(?:还没有|暂无)可查看的话题/u);
  emit(10, 5001, "/话题复盘 30天");
  emit(10, 5001, "/话题复盘 30天");
  await wait(async () => deliveries.length === 3 ? true : undefined);
  assert.equal(deliveries[2].group_id, 5001);
  assert.match(deliveries[2].message[0].data.text, /本群近 30 天暂无可核实的话题进展/u);
  const { db } = openStore(database);
  try {
    const archive = openGroupTopics(db);
    for (const [index, text] of ["发起联机周六档。", "另一个群定周三。"].entries()) {
      const scope = scopes[index];
      const at = new Date(Date.now() - 3_600_000).toISOString();
      const author = "2001";
      const id = Number(db.prepare("INSERT INTO group_messages(scope,author,content,created_at) VALUES(?,?,?,?)")
        .run(scope, author, text, at).lastInsertRowid);
      const summary = db.prepare("INSERT INTO group_summaries(scope,first_id,last_id,content,created_at,source_start,source_end) VALUES(?,?,?,?,?,?,?)")
        .run(scope, id, id, "已确定本周联机时间。", at, at, at).lastInsertRowid;
      const structured = readTopicSummary(JSON.stringify({ overview: "已确定本周联机时间。", topics: [{ title: "联机档期",
        summary: text, evidence: [1], facts: [{ kind: "decision", text, evidence: [1] }] }] }), [{ id, author, content: text, created_at: at }], []);
      assert.ok(structured);
      archive.save(scope, summary, structured.topics);
    }
  } finally { db.close(); }
  const subscriberReport = await (await api(reviewPath + scopes[0], readOnly.token)).json();
  assert.match(subscriberReport.items[0].text, /已确认.*周六/u);
  assert.doesNotMatch(JSON.stringify(subscriberReport), /周三/u);
  const adminReport = await (await api(`/admin/group-topic-review?scope=${scopes[0]}`)).json();
  assert.equal(adminReport.items[0].current.text, "发起联机周六档。");
  emit(11, 5001, "/话题复盘");
  await wait(async () => deliveries.length === 4 ? true : undefined);
  assert.match(deliveries[3].message[0].data.text, /联机档期\n已确认.*周六/u);
  assert.doesNotMatch(deliveries[3].message[0].data.text, /周三/u);
  function seedMapReview(db: ReturnType<typeof openStore>["db"], kind: "open" | "decision", offset: number) {
    const title = "下次联机地图";
    const at = new Date(Date.now() - offset).toISOString();
    const content = kind === "open" ? "下次联机用哪张地图，尚待确认。" : "下次联机地图确定为林地。";
    const scope = scopes[0];
    const author = "2001";
    const id = Number(db.prepare("INSERT INTO group_messages(scope,author,content,created_at) VALUES(?,?,?,?)")
      .run(scope, author, content, at).lastInsertRowid);
    const archive = openGroupTopics(db);
    const prior = archive.prior(scope, at);
    const previous = prior.findIndex(topic => topic.title === title) + 1 || null;
    const draft = readTopicSummary(JSON.stringify({ overview: content, topics: [{ title, previous, summary: content, evidence: [1],
      facts: [{ kind, text: content, evidence: [1] }] }] }), [{ id, author, content, created_at: at }], prior, true)!;
    const summary = db.prepare("INSERT INTO group_summaries(scope,first_id,last_id,content,created_at,source_start,source_end) VALUES(?,?,?,?,?,?,?)")
      .run(scope, id, id, content, at, at, at).lastInsertRowid;
    archive.save(scope, summary, draft.topics);
    return id;
  }
  const schedulePath = "/admin/group-review-plan";
  const dailyPath = "/api/workspace/features/group-daily-review?conversation=";
  const group = scopes[0];
  const settings = { scope: group, enabled: true, localTime: "08:00", timeZone: "Asia/Shanghai", version: 0 };
  assert.equal((await api(schedulePath, readOnly.token, settings, "PUT")).status, 403);
  assert.equal((await api(schedulePath, admin, settings, "PUT")).status, 200);
  assert.equal((await api(schedulePath, admin, settings, "PUT")).status, 409);
  assert.equal((await api(dailyPath + group, readOnly.token)).status, 404);
  const dueAt = Date.now() - 10 * 60_000;
  const { db: fixture } = openStore(database);
  try {
    const pendingSource = seedMapReview(fixture, "open", 2 * 3_600_000);
    fixture.prepare("UPDATE group_review_plans SET next_at=? WHERE scope=?").run(dueAt, group);
    const scheduled = await wait(async () => {
      const view = await (await api(`${schedulePath}?scope=${group}`)).json();
      return view.selected?.state === "ready" ? view : undefined;
    });
    assert.equal(scheduled.selected.dueAt, dueAt);
    assert.match(scheduled.review.items[0].current.text, /周六/u);
    const subscribed = await (await api(dailyPath + group, readOnly.token)).json();
    assert.match(subscribed.items[1].text, /周六/u);
    const nextMap = (report: { items: { title: string; text: string; followUpId?: string }[] }) => report.items.find(item => item.title === "下次联机地图");
    assert.match(nextMap(subscribed)?.followUpId ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(subscribed.items[1].followUpId, undefined);
    assert.doesNotMatch(JSON.stringify(subscribed), /周三/u);
    assert.equal((await api(dailyPath + scopes[1], permitted.token)).status, 404);
    const withDaily = await (await feed(readOnly.token)).json();
    assert.ok(withDaily.features.some((feature: { id: string }) => feature.id === "group-daily-review"));
    seedMapReview(fixture, "decision", 60_000);
    const settled = await (await api(dailyPath + group, readOnly.token)).json();
    assert.match(nextMap(settled)?.text ?? "", /仍待定|待确认/u);
    assert.equal(nextMap(settled)?.followUpId, undefined);
    fixture.prepare("DELETE FROM group_messages WHERE id=?").run(pendingSource);
    fixture.prepare("DELETE FROM group_messages WHERE scope=? AND content=?").run(group, "发起联机周六档。");
    const redacted = await (await api(dailyPath + group, readOnly.token)).json();
    assert.doesNotMatch(JSON.stringify(redacted), /周六/u);
    assert.doesNotMatch(JSON.stringify(redacted), /尚待确认|followUpId/u);
    assert.notEqual((await (await feed(readOnly.token)).json()).featureRevision, withDaily.featureRevision);
    assert.equal((await api(schedulePath, admin, { ...settings, enabled: false, version: 1 }, "PUT")).status, 200);
    assert.equal((await api(dailyPath + group, readOnly.token)).status, 404);
    assert.equal(deliveries.length, 4);
  } finally { fixture.close(); }
});

test("a vision-enabled QQ reply uses the picture route for attachments and retains the text route for ordinary turns", async t => {
  const modelUrl = "https://vision.example.org";
  const textUrl = "https://text.example.org";
  const stickerId = "8e00112233445566778899aabbccddee";
  const sticker = `https://gxh.vip.qq.com/club/item/parcel/item/8e/${stickerId}/raw300.gif`;
  const photo = "https://gchat.qpic.cn/fixture-photo.png";
  const other = "https://gchat.qpic.cn/unrelated.png";
  const origin = globalThis.fetch;
  const downloads: string[] = [];
  const inputs: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (request: URL | string, options?: RequestInit) => {
    if (String(request).startsWith("https://gchat.qpic.cn/") || String(request).startsWith("https://gxh.vip.qq.com/")) {
      downloads.push(String(request));
      return new Response(Buffer.from(png.split(",")[1], "base64"));
    }
    if (String(request).startsWith(modelUrl)) {
      inputs.push(JSON.parse(String(options?.body)));
      return Response.json({ choices: [{ message: { content: "图片已读到。" } }] });
    }
    if (String(request).startsWith(textUrl)) return Response.json({ choices: [{ message: { content: "文字已读到。" } }] });
    return origin(request, options);
  });
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const connected = once(gateway, "connection");
  const profile = { id: "vision-fixture", name: "视觉测试", model: "vision-fixture", vision: true, baseUrl: modelUrl,
    billing: "none", hasKey: false, inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "" } as const;
  const service = createGroupService({ database: ":memory:", adminToken: "vision-test-admin-token-fixture", observeGroups: ["5001"],
    channel: { address: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`, enabled: true, groups: ["5001"],
      roleId: "", modelId: "vision-fixture", hasToken: false, expectedBotId: "1001" },
    model: { ...profile, id: "text-fixture", name: "文字测试", model: "text-fixture", vision: false, baseUrl: textUrl },
    modelProfiles: { visual: profile }, groupVisionProfiles: { "5001": "visual" },
  });
  t.after(async () => {
    await service.stop();
    for (const client of gateway.clients) client.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
  });
  service.startChannel();
  const [peer] = await connected;
  const sent = new Promise<string>(resolve => peer.on("message", (data: Buffer) => {
    const { action, echo, params } = JSON.parse(String(data));
    if (action === "send_group_msg") resolve(params.message[0].data.text);
    peer.send(JSON.stringify({ status: "ok", retcode: 0, echo, data: { message_id: 901 } }));
  }));
  const inbound = (messageId: number, actor: number, message: object[]) => peer.send(JSON.stringify({ post_type: "message",
    message_type: "group", self_id: 1001, group_id: 5001, user_id: actor, message_id: messageId, message }));
  inbound(11, 2002, [{ type: "image", data: { url: other } }]);
  inbound(12, 2001, [{ type: "at", data: { qq: 1001 } }, { type: "text", data: { text: "看看这个" } },
    { type: "face", data: { id: 14 } }, { type: "mface", data: { emoji_id: stickerId } }, { type: "image", data: { url: photo } }]);
  assert.equal(await Promise.race([sent, delay(5000, "timed out", { ref: false })]), "图片已读到。");
  assert.deepEqual(downloads, [sticker, photo]);
  assert.equal(inputs.length, 1);
  const text = JSON.stringify(inputs[0]);
  assert.match(text, /QQ 表情 #14/u);
  assert.match(text, /已附上本轮图片/u);
  assert.match(text, /"type":"image_url"/u);
  assert.ok(text.includes(png));
  assert.ok(!text.includes(other));
  const textReply = new Promise<string>(resolve => peer.on("message", (data: Buffer) => {
    const { action, params } = JSON.parse(String(data));
    if (action === "send_group_msg") resolve(params.message[0].data.text);
  }));
  inbound(13, 2001, [{ type: "at", data: { qq: 1001 } }, { type: "text", data: { text: "继续聊点别的" } }]);
  assert.equal(await Promise.race([textReply, delay(5000, "timed out", { ref: false })]), "文字已读到。");
  assert.equal(inputs.length, 1);
});

test("OneBot replies wait for acknowledgement and respect authorized pause and resume", { timeout: 30_000 }, async (t) => {
  const plans = new Map<string, string>();
  const reply = (key: string, parts: string[], expression?: string) => plans.set(key, JSON.stringify({ action: "reply", parts, expression }));
  reply("分段回复", ["先给结论。", "再补一个例子。"], "agree");
  reply("请解释上一条", ["我说的是这个例子。"]);
  reply("表情降级", ["同意这个建议。"], "smile");
  reply("暂停检查", ["只发送第一条。", "暂停之后停止。"]);
  reply("自定义表情", ["送一个问候。"], "hello");
  reply("两段有不同回执", ["已被网关确认。", "网关拒绝的说明。"]);
  reply("核对实际发送", ["我只说了已确认的部分。"]);
  reply("发送时断开", ["第一条等回执。", "未知结果之后停止。"], "agree");
  reply("未知表情回执", ["回执未返回，这条待核对。"], "agree");
  reply("恢复后请求", ["已经恢复。"]);
  const contexts: { current: string; recent: { text: string }[]; quote?: { text: string };
    quoteContext?: { original?: { text: string }; adjacent?: { position: string; text: string } };
    previousExchange?: { answer: string }[] }[] = [];
  const failoverKeys: (string | undefined)[] = [];
  const routeCalls: { path: string | undefined; key: string | undefined }[] = [];
  const rolePrompts: string[] = [];
  let beforeRouteChange: ServerResponse | undefined;
  let waitingReply: ServerResponse | undefined;
  const model = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const prompt = JSON.parse(Buffer.concat(parts).toString()).messages;
    const context = JSON.parse(prompt.at(-1).content);
    contexts.push(context);
    if (context.current.startsWith("角色选择")) {
      rolePrompts.push(prompt[0].content);
      res.end(JSON.stringify({ choices: [{ message: { content: "角色设定已应用。" } }] }));
      return;
    }
    if (context.current.startsWith("档案路由")) {
      routeCalls.push({ path: req.url, key: req.headers.authorization });
      if (context.current === "档案路由进行中") { beforeRouteChange = res; return; }
      const content = req.url === "/selected/chat/completions" ? "已走新档案。" : "已恢复原档案。";
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      return;
    }
    if (context.current === "切换备用") {
      failoverKeys.push(req.headers.authorization);
      if (req.url !== "/backup/chat/completions") { res.writeHead(429).end(); return; }
      res.end(JSON.stringify({ choices: [{ message: { content: "备用模型接上了。" } }], usage: { prompt_tokens: 8, completion_tokens: 4 } }));
      return;
    }
    if (context.current === "暂停前请求") {
      waitingReply = res;
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: plans.get(context.current) } }] }));
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const admin = "reply-delivery-fixture-secret";
  const groups = ["5001", "5002"];
  const custom = { id: "fixture.sticker", name: "问候角色", version: "1.0.0", persona: "按情境问候。" };
  const upstream = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
  const primary: GroupServiceOptions["model"] = { id: "fixture", name: "模拟模型", baseUrl: upstream, model: "fixture-provider-model",
    billing: "none", hasKey: false, inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "" };
  const options: GroupServiceOptions = { database: ":memory:", adminToken: admin, observeGroups: groups,
    channel: { address: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`, enabled: true, groups,
      roleId: "", modelId: "fixture", hasToken: false, expectedBotId: "1001", ownerId: "2001" },
    roles: [custom], groupRoles: { "5002": custom.id }, roleExpressions: { [custom.id]: [{ id: "hello", label: "问候", emoji: "🙂", png }] },
    model: primary, backupModels: { default: { ...primary, id: "fixture-backup", name: "备用测试模型",
      baseUrl: upstream + "/backup", model: "backup-provider-model", hasKey: true } },
    backupModelKeys: { default: "integration-backup-key" },
    modelProfiles: { second: { ...primary, id: "selected-fixture", name: "切换测试模型", model: "selected-provider-model",
      baseUrl: upstream + "/selected", hasKey: true } }, modelProfileKeys: { second: "route-profile-fixture-key" },
  };
  type Send = { action: string; echo: string; params: { group_id: number; message: { type: string; data: Record<string, string> }[] } };
  const outbound: Send[] = [];
  gateway.on("connection", peer => {
    peer.on("message", (frame: Buffer) => {
      const request: Send = JSON.parse(frame.toString());
      if (request.action === "get_status" || request.action === "get_login_info") {
        const data = request.action === "get_status" ? { online: true, good: true } : { user_id: 1001, nickname: "测试机器人" };
        peer.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data }));
        return;
      }
      outbound.push(request);
    });
  });
  const connected = once(gateway, "connection");
  let closeService: (() => Promise<void>) | undefined;
  t.after(async () => {
    waitingReply?.destroy();
    beforeRouteChange?.destroy();
    await closeService?.();
    for (const client of gateway.clients) client.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await new Promise<void>(resolve => model.close(() => resolve()));
  });
  const release = process.env.OHJINGJING_TEST_SERVICE_RELEASE;
  let base: string;
  if (release) {
    const root = await realpath(tmpdir());
    const directory = await mkdtemp(join(root, "ohjingjing-reply-package-"));
    const configuration = join(directory, "service.json");
    const { adminToken, backupModelKeys, modelProfileKeys, ...config } = options;
    await writeFile(configuration, JSON.stringify({ ...config, database: "group.db", host: "127.0.0.1", port: 0 }));
    const child = spawn(process.execPath, [join(release, "server.cjs")], {
      env: { ...process.env, OHJINGJING_CONFIG: configuration, OHJINGJING_ADMIN_TOKEN: adminToken,
        OHJINGJING_ONEBOT_TOKEN: "", OHJINGJING_MODEL_KEY: "", OHJINGJING_SUMMARY_MODEL_KEY: "", OHJINGJING_GROUP_MODEL_KEYS: "",
        OHJINGJING_BACKUP_MODEL_KEYS: JSON.stringify(backupModelKeys), OHJINGJING_MODEL_PROFILE_KEYS: JSON.stringify(modelProfileKeys) },
      stdio: ["ignore", "pipe", "inherit"], windowsHide: true, timeout: 28_000,
    });
    const closed = once(child, "close");
    closeService = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      const resolved = await realpath(directory);
      assert.equal(dirname(resolved), root);
      await rm(resolved, { recursive: true, force: true });
    };
    const lines = createInterface({ input: child.stdout });
    const { value } = await lines[Symbol.asyncIterator]().next();
    lines.close();
    const bound = /^OHJingJing listening on (http:\/\/127\.0\.0\.1:\d+)$/u.exec(value ?? "")?.[1];
    assert.ok(bound, "The packaged service must listen on loopback");
    base = bound;
  } else {
    const service = createGroupService(options);
    closeService = service.stop;
    service.server.listen(0, "127.0.0.1");
    await once(service.server, "listening");
    service.startChannel();
    base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  }
  let [socket] = await connected;
  async function until(check: () => unknown | Promise<unknown>) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await check()) return;
      await delay(20);
    }
    assert.fail("Expected message or acknowledgement was not observed");
  }
  async function readStatus() {
    const response = await fetch(base + "/admin/status", { headers: { Authorization: `Bearer ${admin}` } });
    assert.ok(response.ok);
    return response.json();
  }
  const waitForOnline = () => until(async () => (await readStatus()).channel === "online");
  const tracePath = "/admin/group-reply-traces";
  const auth = { Authorization: `Bearer ${admin}` };
  const statisticsPath = "/admin/group-statistics?";
  const statistics = (scope: string, days = "7", headers: HeadersInit = auth) =>
    fetch(base + statisticsPath + new URLSearchParams({ scope, days }), { headers });
  async function traces(filter: Record<string, string> = {}) {
    const response = await fetch(base + tracePath + "?" + new URLSearchParams(filter), { headers: auth });
    assert.ok(response.ok);
    return (await response.json()).items;
  }
  async function pause(paused: boolean) {
    const res = await fetch(base + "/admin/group-reply", { method: "PUT",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "qq:1001:5001", paused }) });
    assert.equal(res.status, 200);
  }
  function say(id: number, text: string, { group = 5001, quote, actor = 2001, mention = true }:
      { group?: number; quote?: number; actor?: number; mention?: boolean } = {}) {
    const addressed = { type: "at", data: { qq: "1001" } };
    const prefix = quote !== undefined ? [{ type: "reply", data: { id: String(quote) } }] : mention ? [addressed] : [];
    socket.send(JSON.stringify({ post_type: "message", message_type: "group", self_id: 1001,
      message_id: id, user_id: actor, group_id: group, sender: { nickname: "相同昵称" },
      message: [...prefix, { type: "text", data: { text } }] }));
  }
  function confirm(index: number, id: number) {
    socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: outbound[index].echo, data: { message_id: id } }));
  }
  const total = async (status: string) => (await readStatus()).delivery.find((row: { status: string }) => row.status === status)?.count ?? 0;
  const textPart = (text: string) => ({ type: "text", data: { text } });

  const dashboard = await (await fetch(base)).text();
  assert.match(dashboard, /id="tracePanel" hidden/);
  assert.match(dashboard, /id="groupStatsPanel" hidden/);
  assert.doesNotThrow(() => new Function(/<script>([\s\S]+)<\/script>/u.exec(dashboard)?.[1] ?? "syntax error"));
  assert.equal((await fetch(base + tracePath)).status, 401);
  assert.equal((await fetch(base + tracePath, { headers: { Authorization: "Bearer fixture-without-admin-privileges" } })).status, 403);
  assert.equal((await fetch(base + tracePath + "?trigger=invalid", { headers: auth })).status, 400);
  assert.equal((await statistics("qq:1001:5001", "7", {})).status, 401);
  assert.equal((await statistics("qq:1001:5001", "30")).status, 400);
  assert.equal((await statistics("qq:1002:5001")).status, 404);
  assert.equal((await statistics("qq:1001:5003")).status, 404);
  const emptyStats = await (await statistics("qq:1001:5001")).json();
  assert.equal(emptyStats.observed.messages, 0);
  assert.equal(emptyStats.reply.rate, null);

  await waitForOnline();
  say(1, "分段回复");
  await until(() => outbound.length === 1);
  assert.deepEqual(outbound[0].params.message, [textPart("先给结论。")]);
  const [pending] = await traces({ eventId: "1", trigger: "mention", scope: "qq:1001:5001" });
  assert.deepEqual(pending.receipts.map(({ status }: { status: string }) => status), ["sending", "pending"]);
  assert.equal(pending.modelProfileId, "fixture");
  assert.equal(pending.providerModelId, "fixture-provider-model");
  assert.match(pending.roleRevision, /^[a-f0-9]{64}$/);
  assert.equal(pending.state, "running");
  await delay(450);
  assert.equal(outbound.length, 1);
  confirm(0, 901);
  await until(() => outbound.length === 2);
  assert.deepEqual(outbound[1].params.message, [textPart("再补一个例子。"), { type: "face", data: { id: "76" } }]);
  confirm(1, 902);
  await until(async () => await total("sent") === 2);
  const [done] = await traces({ eventId: "1" });
  assert.deepEqual(done.receipts, [
    { part: 1, status: "sent", platformMessageId: "901" },
    { part: 2, status: "sent", platformMessageId: "902", format: "qq-face" },
  ]);
  assert.equal(done.state, "finished");
  assert.ok(!JSON.stringify(done).includes("分段回复") && !JSON.stringify(done).includes("先给结论"));
  assert.deepEqual(await traces({ eventId: "1", scope: "qq:1001:5002" }), []);
  assert.deepEqual(await traces({ scope: "qq:1002:5001" }), []);
  say(2, "请解释上一条", { quote: 902 });
  await until(() => outbound.length === 3);
  assert.equal(contexts.at(-1)?.quote?.text, "再补一个例子。 👍");
  assert.equal(contexts.at(-1)?.quoteContext?.original?.text, "分段回复");
  assert.deepEqual(contexts.at(-1)?.quoteContext?.adjacent, { position: "before", text: "先给结论。" });
  confirm(2, 903);
  assert.equal((await traces({ eventId: "2", trigger: "quote" }))[0].trigger, "quote");

  say(3, "表情降级");
  await until(() => outbound.length === 4);
  assert.deepEqual(outbound[3].params.message[1], { type: "face", data: { id: "14" } });
  socket.send(JSON.stringify({ status: "failed", retcode: 100, echo: outbound[3].echo }));
  await until(() => outbound.length === 5);
  assert.deepEqual(outbound[4].params.message, [textPart("同意这个建议。 🙂")]);
  confirm(4, 904);
  await until(async () => await total("sent") === 4);
  assert.equal(await total("failed"), 0, "Native and fallback attempts belong to one logical message");

  say(4, "暂停检查");
  await until(() => outbound.length === 6);
  assert.deepEqual(outbound[5].params.message, [textPart("只发送第一条。")]);
  await pause(true);
  await pause(false);
  confirm(5, 905);
  await delay(525);
  assert.equal(outbound.length, 6);
  const [paused] = await traces({ eventId: "4" });
  assert.equal(paused.reason, "paused");
  assert.deepEqual(paused.receipts.map(({ status }: { status: string }) => status), ["sent", "not-attempted"]);

  say(5, "自定义表情", { group: 5002 });
  await until(() => outbound.length === 7);
  assert.deepEqual(outbound[6].params.message, [textPart("送一个问候。"), { type: "image", data: { file: "base64://" + png.split(",")[1] } }]);
  confirm(6, 906);

  say(6, "两段有不同回执");
  await until(() => outbound.length === 8);
  confirm(7, 907);
  await until(() => outbound.length === 9);
  socket.send(JSON.stringify({ status: "failed", retcode: 100, echo: outbound[8].echo }));
  await until(async () => await total("failed") === 1);
  say(7, "核对实际发送");
  await until(() => outbound.length === 10);
  assert.equal(contexts.at(-1)?.previousExchange?.at(-1)?.answer, "已被网关确认。");
  confirm(9, 908);

  say(8, "发送时断开");
  await until(() => outbound.length === 11);
  const reconnected = once(gateway, "connection");
  socket.close();
  await until(async () => await total("unknown") === 1);
  const [disconnected] = await traces({ eventId: "8" });
  assert.equal(disconnected.receipts[0].status, "unknown");
  assert.equal(disconnected.receipts[1].status, "not-attempted");
  [socket] = await reconnected;
  await waitForOnline();
  await delay(425);
  assert.equal(outbound.length, 11);

  say(9, "未知表情回执");
  await until(() => outbound.length === 12);
  assert.deepEqual(outbound[11].params.message[1], { type: "face", data: { id: "76" } });
  const reconnectForCommands = once(gateway, "connection");
  socket.close();
  await until(async () => await total("unknown") === 2);
  assert.equal(outbound.length, 12);
  assert.equal(contexts.length, 9);
  [socket] = await reconnectForCommands;
  await waitForOnline();

  async function confirmText(index: number, expected: string) {
    await until(() => outbound.length > index);
    assert.equal(outbound[index].params.group_id, 5001);
    assert.deepEqual(outbound[index].params.message, [textPart(expected)]);
    confirm(index, 910 + index);
  }
  async function pausedIn(groupId: number) {
    return (await readStatus()).groups.find((group: { scope: string }) => group.scope === `qq:1001:${groupId}`).paused;
  }

  say(10, "/机器人 暂停", { actor: 2002 });
  say(11, "/机器人 暂停", { group: 5003 });
  say(12, "/机器人 暂停", { mention: false });
  say(13, "/机器人 状态");
  await confirmText(12, "本群的机器人回复已开启。");
  assert.equal(await pausedIn(5001), false);
  assert.equal(contexts.length, 9);

  say(14, "暂停前请求");
  await until(() => waitingReply);
  say(15, "暂停前排队");
  say(16, "/机器人 暂停");
  await confirmText(13, "本群的机器人回复已暂停。");
  assert.equal(await pausedIn(5001), true);
  assert.equal(await pausedIn(5002), false);
  say(17, "暂停中的请求");
  say(18, "/机器人 状态");
  await confirmText(14, "本群的机器人回复已暂停。");
  say(19, "/机器人 恢复");
  await confirmText(15, "本群的机器人回复已开启。");
  await until(() => waitingReply?.destroyed);

  say(16, "/机器人 暂停");
  say(20, "恢复后请求");
  await confirmText(16, "已经恢复。");
  assert.equal(await pausedIn(5001), false);
  assert.deepEqual(contexts.slice(9).map(context => context.current), ["暂停前请求", "恢复后请求"]);
  const [cancelled] = await traces({ eventId: "14" });
  assert.equal(cancelled.state, "interrupted");
  assert.equal(cancelled.modelStatus, "cancelled");
  const [skipped] = await traces({ eventId: "17" });
  assert.deepEqual([skipped.state, skipped.reason, skipped.requestId], ["skipped", "paused", null]);
  assert.ok(contexts.at(-1)?.recent.every(line => !["/机器人 状态", "/机器人 恢复"].includes(line.text)));
  assert.ok(outbound.every(message => message.action === "send_group_msg"));
  await until(async () => (await (await statistics("qq:1001:5001")).json()).deliveries.sent === 12);
  const result = await (await statistics("qq:1001:5001")).json();
  assert.equal(result.observed.messages, 17);
  assert.equal(result.observed.activeAccounts, 1);
  assert.equal(result.hours.reduce((sum: number, hour: { messages: number }) => sum + hour.messages, 0), 17);
  assert.deepEqual([result.reply.eligibleMessages, result.reply.triggeredMessages, result.reply.rate], [12, 11, 11 / 12]);
  assert.deepEqual(result.deliveries, { sent: 12, failed: 1, unknown: 2, sending: 0 });
  const other = await (await statistics("qq:1001:5002", "1")).json();
  assert.equal(other.observed.messages, 1);
  assert.equal(other.deliveries.sent, 1);
  assert.equal(other.reply.rate, 1);
  say(21, "切换备用");
  await confirmText(17, "备用模型接上了。");
  await until(async () => (await traces({ eventId: "21" }))[0]?.state === "finished");
  const [switched] = await traces({ eventId: "21" });
  assert.deepEqual(failoverKeys, [undefined, "Bearer integration-backup-key"]);
  assert.equal(switched.providerModelId, "backup-provider-model");
  assert.deepEqual(switched.modelAttempts.map((item: { stage: string; status: string; httpStatus: number | null }) =>
    [item.stage, item.status, item.httpStatus]), [["primary", "failed", 429], ["backup", "ok", null]]);
  assert.equal(switched.receipts.length, 1);
  const inventory = (await readStatus()).models;
  assert.equal(inventory.find((item: { id: string }) => item.id === "backup:default").usage[0].requests, 1);
  assert.ok(!JSON.stringify(inventory).includes("integration-backup-key"));

  say(22, "档案路由进行中");
  await until(() => beforeRouteChange);
  const modelRoute = (method: string, change: object) => fetch(base + "/admin/model-routes", { method,
    headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ route: "qq:1001:5001", ...change }) });
  const applied = await modelRoute("PUT", { expectedVersion: 0, bindingId: "profile:second" });
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).version, 1);
  beforeRouteChange!.end(JSON.stringify({ choices: [{ message: { content: "仍按开始时的档案回复。" } }] }));
  await confirmText(18, "仍按开始时的档案回复。");
  say(23, "档案路由切换完成");
  await confirmText(19, "已走新档案。");
  await until(async () => (await traces({ eventId: "23" }))[0]?.state === "finished");
  assert.equal((await traces({ eventId: "22" }))[0].modelAttempts[0].bindingId, "default");
  assert.equal((await traces({ eventId: "23" }))[0].modelAttempts[0].bindingId, "profile:second");
  const chosen = (await readStatus()).models.find((row: { id: string }) => row.id === "profile:second");
  assert.equal(chosen.usage[0].requests, 1);
  assert.ok(!JSON.stringify(chosen).includes("route-profile-fixture-key"));
  const rollback = await modelRoute("POST", { expectedVersion: 1, restoreVersion: 0 });
  assert.equal(rollback.status, 200);
  assert.equal((await rollback.json()).effectiveBindingId, "default");
  say(24, "档案路由回退完成");
  await confirmText(20, "已恢复原档案。");
  assert.deepEqual(routeCalls, [{ path: "/chat/completions", key: undefined },
    { path: "/selected/chat/completions", key: "Bearer route-profile-fixture-key" }, { path: "/chat/completions", key: undefined }]);

  const roleRoute = (method: string, fields: object) => fetch(base + "/admin/plugins/assigned-role", { method,
    headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ scope: "qq:1001:5001", ...fields }) });
  const persona = createPublishedRole(custom).info;
  assert.equal((await roleRoute("PUT", { expectedVersion: 0, revision: persona.revision })).status, 200);
  say(25, "角色选择应用");
  await confirmText(21, "角色设定已应用。");
  assert.ok(rolePrompts[0].includes(custom.persona));
  assert.equal((await traces({ eventId: "25" }))[0].roleRevision, persona.revision);
  assert.equal((await roleRoute("POST", { expectedVersion: 1, restoreVersion: 0 })).status, 200);
  say(26, "角色选择回退");
  await confirmText(22, "角色设定已应用。");
  assert.ok(!rolePrompts[1].includes(custom.persona));
  assert.equal((await traces({ eventId: "26" }))[0].roleName, "大肥鱼");
});

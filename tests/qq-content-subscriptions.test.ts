import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { openBilibiliAuthorization } from "../runtime/bilibili-authorization.js";
import { readBilibiliCreators } from "../runtime/bilibili-content-feed.js";
import { defaultGroupConversation } from "../runtime/group-conversation.js";
import { createGroupService } from "../runtime/group-service.js";
import { isPublicFeedAddress, parsePublicFeed, readPublicFeedUrl } from "../runtime/public-content-feed.js";
import { feedEventId, openQqContentSubscriptions, readQqContentSubscription } from "../runtime/qq-content-subscriptions.js";
import { openStore } from "../runtime/store.js";

const scope = "qq:1001:5001";
const otherScope = "qq:1001:5002";
const source = new URL("https://news.example.org/blog/feed.xml");
const config = { url: source.href, label: "项目动态", intervalMinutes: 15, maxItemsPerCheck: 3 };
const minute = 60_000;
const rss = (items: string) => `<rss version="2.0"><channel>${items}</channel></rss>`;
const entry = (key: number) => `<item><title>更新 ${key}</title><guid isPermaLink="false">${key}</guid><link>/posts/${key}</link></item>`;
const items = (...keys: number[]) => parsePublicFeed(rss(keys.map(entry).join("")), source);

test("RSS 2.0 and Atom yield stable keys, actionable public links and plain titles", () => {
  const records = parsePublicFeed(rss(`<item><title><![CDATA[发布 <b>桌宠</b> [CQ:at,qq=all]]]></title>
    <link>../posts/1#top</link><guid isPermaLink="false">stable</guid></item>
    <item><title>新标题</title><guid>stable</guid></item>
    <item><title>本机地址</title><link>https://127.0.0.1:8443/x</link></item>`), source);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, "发布 桌宠");
  assert.equal(records[0].link, "https://news.example.org/posts/1");
  assert.equal(records[0].key, parsePublicFeed(rss("<item><title>改名</title><guid>stable</guid></item>"), source)[0].key);
  const atom = parsePublicFeed(`<a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="/announcements/">
    <a:entry><a:id>tag:example.org,2026:2</a:id><a:title type="html">Fish &amp; Chips &lt;b&gt;第二期&lt;/b&gt;</a:title>
    <a:link rel="self" href="current.atom"/><a:link rel="alternate" href="second"/>
    <a:content>正文不投递</a:content></a:entry></a:feed>`, source);
  assert.deepEqual(atom.map(({ title, link }) => ({ title, link })), [
    { title: "Fish & Chips 第二期", link: "https://news.example.org/announcements/second" },
  ]);
  assert.equal(parsePublicFeed(rss(`<item xml:base="http://news.example.org/"><title>不改写来源</title>
    <guid isPermaLink="false">safe-key</guid><link>/posts/1</link></item>`), source)[0].link, undefined);
  assert.deepEqual(items(), []);
  for (const xml of ["<html/>", "<rss version='2.0'/>", "<rss>", "<!DOCTYPE rss [<!ENTITY item 'foo'>]>" + rss("&item;")]) {
    assert.throws(() => parsePublicFeed(xml, source), { message: "feed-format" });
  }
  assert.throws(() => parsePublicFeed(rss("x".repeat(525_000)), source), { message: "feed-too-large" });
});

test("JSON Feed accepts both versions, deduplicates item IDs and delivers only public-link text", () => {
  const records = [
    { id: "one", title: "发布 <b>桌宠</b> [CQ:at,qq=all]", url: "../posts/1#top", content_text: "正文" },
    { id: "one", title: "改过的标题", url: "https://news.example.org/another", content_text: "重复" },
    { id: "two", content_text: "无标题的简短更新", url: "https://127.0.0.1/x", external_url: "/handbook" },
    { id: "three", content_html: "<script>这些内容不应进群</script>", url: "/posts/3" },
    { id: "four", content_html: "<p>只有 HTML</p>" },
    { title: "缺少标识", url: "/posts/5" },
  ];
  const parse = (version: string, feedItems: unknown = records) => parsePublicFeed("\ufeff " + JSON.stringify({
    version, title: "公告", items: feedItems,
  }), source);
  const result = parse("https://jsonfeed.org/version/1.1");
  assert.deepEqual(result, parse("https://jsonfeed.org/version/1"));
  assert.deepEqual(result.map(({ title, link }) => ({ title, link })), [
    { title: "发布 桌宠", link: "https://news.example.org/posts/1" },
    { title: "无标题的简短更新", link: "https://news.example.org/handbook" },
    { title: "新条目", link: "https://news.example.org/posts/3" },
  ]);
  assert.throws(() => parse("https://jsonfeed.org/version/2"), { message: "feed-format" });
  assert.throws(() => parse("https://jsonfeed.org/version/1.1", {}), { message: "feed-format" });
  assert.throws(() => parse("https://jsonfeed.org/version/1.1", [{ id: "huge", content_text: "x".repeat(525_000) }]),
    { message: "feed-too-large" });
});

test("subscription address checks reject credentials, local names and reserved network ranges", () => {
  assert.deepEqual(readQqContentSubscription(config), config);
  for (const url of ["http://news.example.org/feed", "https://user@news.example.org/feed", "https://news.example.org:8080/feed",
    "https://news.example.org/?access_token=private", "https://foo.local/feed", "https://127.0.0.1/feed", "https://[::1]/feed"]) {
    assert.equal(readPublicFeedUrl(url), undefined, url);
  }
  for (const address of ["127.0.0.1", "10.1.0.3", "172.31.0.2", "192.168.0.8", "169.254.169.254", "100.64.1.1", "168.63.129.16",
    "::1", "::ffff:8.8.8.8", "fd00::1", "fe80::1", "2001:db8::1", "2002:abcd::1"]) assert.equal(isPublicFeedAddress(address), false, address);
  assert.equal(isPublicFeedAddress("8.8.8.8"), true);
  assert.equal(isPublicFeedAddress("2606:4700:4700::1111"), true);
  assert.equal(readQqContentSubscription({ ...config, intervalMinutes: 14 }), undefined);
  for (const maximum of [0, 4, 1.5, "1", null]) assert.equal(readQqContentSubscription({ ...config, maxItemsPerCheck: maximum }), undefined);
  assert.equal(readQqContentSubscription({ ...config, maxItemsPerCheck: undefined })?.maxItemsPerCheck, 3);
});

test("content subscription ledger seeds, bounds queue size, persists dedupe and reconciles ambiguous sends", () => {
  const { db } = openStore(":memory:");
  try {
    let subscriptions = openQqContentSubscriptions(db);
    const now = 1_800_000_000_000;
    assert.equal(subscriptions.create(scope, config, now), true);
    assert.equal(subscriptions.create(scope, config, now), false);
    assert.equal(subscriptions.create(otherScope, config, now), true);
    const [first, second] = subscriptions.due(now);
    assert.equal(subscriptions.setPaused(otherScope, first.id, true, now), false);
    assert.equal(subscriptions.record(first, now, items(3, 2, 1)), true);
    assert.equal(subscriptions.record(second, now, items(3, 2, 1)), true);
    assert.deepEqual(subscriptions.pending(now), []);

    const next = now + 15 * minute;
    assert.equal(subscriptions.record(subscriptions.due(next)[0], next, items(7, 6, 5, 4, 3, 1, 2)), true);
    const pending = subscriptions.pending(next);
    assert.deepEqual(pending.map(p => p.key), items(7, 6, 5).map(p => p.key));
    assert.equal(subscriptions.claim(pending[0], next), true);
    assert.equal(subscriptions.claim(pending[1], next), false);
    db.prepare("INSERT INTO outbox(scope,event_id,content,status,created_at) VALUES(?,?,?,?,?)")
      .run(scope, feedEventId(pending[0]), pending[0].body, "sent", new Date(next).toISOString());

    subscriptions = openQqContentSubscriptions(db);
    assert.deepEqual(subscriptions.summary(scope).feeds[0].runs, { pending: 2, unknown: 1 });
    assert.deepEqual(subscriptions.pending(next + 5 * minute).map(p => p.key), items(6, 5).map(p => p.key));
    const due = next + 15 * minute;
    const beforePause = subscriptions.due(due).find(feed => feed.scope === scope)!;
    assert.equal(subscriptions.setPaused(scope, first.id, true, due), true);
    assert.equal(subscriptions.setPaused(scope, first.id, false, due), true);
    assert.equal(subscriptions.record(beforePause, due, items(8)), false);
    const afterPause = subscriptions.due(due).find(feed => feed.scope === scope)!;
    assert.equal(subscriptions.record(afterPause, due, "feed-timeout"), true);
    assert.equal(subscriptions.summary(scope).feeds[0].primed, false);
    assert.equal(subscriptions.record(subscriptions.due(due + 15 * minute).find(feed => feed.scope === scope)!, due + 15 * minute, items(8, 7)), true);
    assert.deepEqual(subscriptions.pending(due + 15 * minute), []);
    assert.equal(subscriptions.remove(otherScope, first.id), false);
    assert.equal(subscriptions.remove(scope, first.id), true);
    assert.equal(subscriptions.summary(scope).recent.length, 1);
    assert.equal(subscriptions.summary(scope).recent[0].status, "unknown");
    db.exec("ALTER TABLE qq_content_feeds DROP COLUMN max_items_per_check");
    const migrated = openQqContentSubscriptions(db).summary(otherScope).feeds[0];
    assert.equal(migrated.maxItemsPerCheck, 3);
    assert.equal(migrated.checkedAt, now);
    assert.equal(migrated.primed, true);
  } finally { db.close(); }
});

test("Bilibili renewals are serialized and encrypted across separate SQLite connections", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-authorization-"));
  const database = join(directory, "service.sqlite");
  const now = Math.floor(Date.now() / 1000);
  const original = { label: "创作者", clientId: "fixture-client", appSecret: "fixture-app-secret",
    accessToken: "fixture-initial-access", refreshToken: "fixture-initial-refresh", expiresAt: now + 600 };
  const creators = readBilibiliCreators(JSON.stringify({ creator: original }));
  const { db: firstDb } = openStore(database);
  const { db: secondDb } = openStore(database);
  let firstClosed = false;
  t.after(async () => {
    if (!firstClosed) firstDb.close();
    secondDb.close();
    await rm(directory, { recursive: true, force: true });
  });
  let respond!: (response: Response) => void;
  const waiting = new Promise<Response>(resolve => { respond = resolve; });
  const fake = t.mock.method(globalThis, "fetch", async (input: URL, init?: RequestInit) => {
    assert.equal(input.origin + input.pathname, "https://api.bilibili.com/x/account-oauth2/v1/refresh_token");
    assert.equal(input.searchParams.get("client_id"), original.clientId);
    assert.equal(input.searchParams.get("client_secret"), original.appSecret);
    assert.equal(input.searchParams.get("grant_type"), "refresh_token");
    assert.equal(input.searchParams.get("refresh_token"), original.refreshToken);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    return waiting;
  });
  const source = "bilibili:creator";
  const first = openBilibiliAuthorization(firstDb, creators);
  const second = openBilibiliAuthorization(secondDb, creators);
  const attempt = first.renewDue();
  await second.renewDue();
  assert.equal(fake.mock.callCount(), 1);
  respond(Response.json({ code: 0, data: { access_token: "fixture-fresh-access", refresh_token: "fixture-fresh-refresh", expires_in: now + 7200 } }));
  await attempt;
  const row = secondDb.prepare("SELECT grant_id, sealed FROM bilibili_authorizations").get();
  assert.ok(row?.sealed instanceof Uint8Array);
  assert.doesNotMatch(Buffer.from(row.sealed).toString(), /fixture-|accessToken|refreshToken/u);
  firstDb.close();
  firstClosed = true;

  const restored = openBilibiliAuthorization(secondDb, creators);
  assert.equal(restored.creator(source)?.accessToken, "fixture-fresh-access");
  await restored.renewDue();
  assert.equal(fake.mock.callCount(), 1);
  restored.invalidate(source, original.accessToken);
  assert.equal(restored.creator(source)?.accessToken, "fixture-fresh-access");
  restored.invalidate(source, "fixture-fresh-access");
  assert.equal(restored.creator(source), undefined);
  assert.equal(secondDb.prepare("SELECT sealed FROM bilibili_authorizations").get()?.sealed, null);
});

test("admin-managed RSS and authorized Bilibili subscriptions use the QQ adapter and respect quiet hours", { timeout: 35_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-content-feed-"));
  const database = join(directory, "service.sqlite");
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const deliveries: string[] = [];
  let omitPlatformReceipt = false;
  gateway.on("connection", peer => peer.on("message", message => {
    const { action, params, echo } = JSON.parse(String(message));
    let data: object = action === "get_login_info" ? { user_id: 1001, nickname: "测试机器人" } : { online: true, good: true };
    if (action === "send_group_msg") {
      assert.equal(String(params.group_id), "5001");
      const [part] = params.message;
      assert.equal(part.type, "text");
      deliveries.push(part.data.text);
      data = omitPlatformReceipt ? {} : { message_id: 5678 };
    }
    peer.send(JSON.stringify({ status: "ok", retcode: 0, echo, data }));
  }));
  const token = "content-feed-admin-token";
  let observed = items(1);
  const author = { label: "联调视频账号", clientId: "fixture-client-id", appSecret: "fixture-signing-secret", accessToken: "fixture-access-token",
    refreshToken: "fixture-original-renewal", expiresAt: Math.floor(Date.now() / 1000) + 600 };
  const rotatedAccess = "fixture-rotated-access";
  let renewals = 0;
  const creators = readBilibiliCreators(JSON.stringify({ creator: author }));
  const makeVideo = (id: string, title: string, published: number, state = 0) => ({
    resource_id: id, title, ptime: published, addit_info: { state }, video_info: { share_url: "https://example.org/mismatched" },
  });
  const before = Math.floor(Date.now() / 1000) - 600;
  const older = makeVideo("BVz123456789", "已经发布的旧稿件", before);
  let videos: unknown = { code: 0, data: { list: [older] } };
  const nativeFetch = globalThis.fetch;
  const nonces = new Set<string>();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.bilibili.com") {
      assert.equal(url.pathname, "/x/account-oauth2/v1/refresh_token");
      assert.equal(url.searchParams.get("refresh_token"), author.refreshToken);
      renewals++;
      return Response.json({ code: 0, data: { access_token: rotatedAccess, refresh_token: "fixture-new-renewal",
        expires_in: author.expiresAt + 7200 } });
    }
    if (url.hostname !== "member.bilibili.com") return nativeFetch(input, init);
    assert.equal(url.href, "https://member.bilibili.com/arcopen/fn/archive/viewlist?pn=1&ps=50&status=all");
    assert.equal(init?.redirect, "error");
    assert.ok(init.signal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Access-Token"), rotatedAccess);
    assert.equal(headers.get("x-bili-accesskeyid"), author.clientId);
    assert.equal(headers.get("x-bili-content-md5"), "d41d8cd98f00b204e9800998ecf8427e");
    const signatureInput = [...headers].filter(([key]) => key.startsWith("x-bili-")).map(([key, value]) => `${key}:${value}`).sort().join("\n");
    assert.equal(headers.get("Authorization"), createHmac("sha256", author.appSecret).update(signatureInput).digest("hex"));
    const nonce = headers.get("x-bili-signature-nonce");
    assert.ok(nonce && !nonces.has(nonce));
    nonces.add(nonce);
    return Response.json(videos);
  });
  const service = createGroupService({ database, adminToken: token, observeGroups: ["5002"],
    bilibiliCreators: creators,
    contentFeedLoader: async address => { assert.equal(address, source.href); return observed; },
    channel: { enabled: true, address: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`, groups: ["5001"],
      roleId: "", modelId: "", hasToken: false, expectedBotId: "1001", verifyExpectedBot: true },
  });
  t.after(async () => {
    await service.stop();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  service.startChannel();
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const api = (path: string, method = "GET", payload?: object) => fetch(base + path, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: payload && JSON.stringify(payload), signal: AbortSignal.timeout(5000),
  });
  const path = "/admin/group-content-feeds";
  const view = async () => (await api(path + "?" + new URLSearchParams({ scope }))).json();
  async function waitFor<T>(read: () => Promise<T | undefined>) {
    const end = Date.now() + 7500;
    while (Date.now() < end) {
      const result = await read();
      if (result !== undefined) return result;
      await delay(40);
    }
    throw new Error("Subscription state did not update");
  }
  const noQuiet = { ...defaultGroupConversation, scope, timeZone: "UTC", quietStart: "00:00", quietEnd: "00:00" };
  const utcClock = (offset: number) => new Date(Date.now() + offset * minute).toISOString().slice(11, 16);
  assert.equal((await api("/admin/group-conversation", "PUT", { ...noQuiet, quietStart: utcClock(-2), quietEnd: utcClock(2) })).status, 200);
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await fetch(base + path, { headers: { authorization: "Bearer subscriber-token" } })).status, 403);
  assert.equal((await api(path, "POST", { ...config, scope: otherScope })).status, 409);
  assert.equal((await api(path, "POST", { ...config, url: "https://127.0.0.1/feed", scope })).status, 400);
  const created = await api(path, "POST", { ...config, scope, maxItemsPerCheck: 1 });
  assert.equal(created.status, 201);
  const id = (await created.json()).feeds[0].id;
  assert.equal((await api(path, "DELETE", { scope: otherScope, id })).status, 404);
  await waitFor(async () => (await view()).feeds[0]?.primed || undefined);
  assert.deepEqual(deliveries, []);
  observed = parsePublicFeed(JSON.stringify({ version: "https://jsonfeed.org/version/1.1", title: "联调公告",
    items: [3, 2, 1].map(id => ({ id: String(id), title: `更新 ${id}`, content_text: "公告正文", url: `/posts/${id}` })),
  }), source);
  const fixture = new DatabaseSync(database);
  const accelerate = () => fixture.prepare("UPDATE qq_content_feeds SET next_at=0 WHERE id=?").run(id);
  try {
    accelerate();
    assert.equal(await waitFor(async () => (await view()).feeds[0]?.runs.pending || undefined), 1);
    assert.deepEqual(deliveries, []);
    assert.equal((await api("/admin/group-conversation", "PUT", noQuiet)).status, 200);
    const sent = await waitFor(async () => (await view()).recent.find((receipt: { status: string }) => receipt.status === "sent"));
    assert.equal(sent.platformMessageId, "5678");
    assert.deepEqual(deliveries, ["项目动态 · 新内容\n更新 3\nhttps://news.example.org/posts/3"]);
    accelerate();
    await waitFor(async () => (await view()).feeds[0]?.nextAt || undefined);
    assert.equal((await view()).recent.length, 1);
    assert.equal((await api(path, "PUT", { scope, id, paused: true })).status, 200);
    observed = items(4, 3, 2, 1);
    assert.equal((await api(path, "PUT", { scope, id, paused: false })).status, 200);
    await waitFor(async () => (await view()).feeds[0]?.primed || undefined);
    assert.equal((await view()).recent.length, 1);

    omitPlatformReceipt = true;
    observed = items(5, 4, 3, 2, 1);
    fixture.prepare("UPDATE qq_content_feed_spacing SET attempted_at=0 WHERE scope=?").run(scope);
    accelerate();
    const unknown = await waitFor(async () => (await view()).recent.find((receipt: { status: string }) => receipt.status === "unknown"));
    assert.equal(unknown.platformMessageId, null);
    assert.deepEqual((await view()).feeds[0].runs, { sent: 1, unknown: 1 });
    assert.equal(deliveries.length, 2);
    accelerate();
    await waitFor(async () => ((await view()).feeds[0].nextAt > Date.now()) || undefined);
    assert.equal(deliveries.length, 2);

    assert.deepEqual((await view()).creators, [{ id: "bilibili:creator", label: author.label }]);
    assert.doesNotMatch(JSON.stringify(await view()), /fixture-(?:client-id|signing-secret|access-token|rotated-access|original-renewal|new-renewal)/u);
    assert.equal((await api(path, "POST", { ...config, scope, url: "bilibili:unconfigured" })).status, 400);
    assert.equal((await api(path, "PUT", { scope, id, paused: true })).status, 200);
    const videoSub = await api(path, "POST", { ...config, scope, url: "bilibili:creator", label: "视频更新" });
    assert.equal(videoSub.status, 201);
    const videoId = (await videoSub.json()).feeds[1].id;
    const prime = await waitFor(async () => {
      const feed = (await view()).feeds.find((value: { id: number }) => value.id === videoId);
      return feed?.primed ? feed.checkedAt as number : undefined;
    });
    assert.equal(deliveries.length, 2);
    const published = Math.floor(prime / 1000) + 1;
    await delay(Math.max(0, published * 1000 - Date.now()));
    const newestId = "BVy123456789";
    videos = { code: 0, data: { list: [makeVideo("BVw123456789", "审核中", published, -1),
      makeVideo("BVx123456789", "窗口外的旧稿件", before), makeVideo(newestId, "新稿件 [CQ:at,qq=all]", published),
      makeVideo(newestId, "重复", published), older] } };
    omitPlatformReceipt = false;
    fixture.prepare("UPDATE qq_content_feed_spacing SET attempted_at=0 WHERE scope=?").run(scope);
    const checkVideos = () => fixture.prepare("UPDATE qq_content_feeds SET next_at=0 WHERE id=?").run(videoId);
    checkVideos();
    const videoReceipt = await waitFor(async () => (await view()).recent.find((receipt: { eventId: string; status: string }) =>
      receipt.eventId.startsWith(`content-feed:${videoId}:`) && receipt.status === "sent"));
    assert.equal(deliveries.at(-1), `视频更新 · 新内容\n新稿件\nhttps://www.bilibili.com/video/${newestId}`);
    assert.equal(videoReceipt.platformMessageId, "5678");
    videos = { code: 127001, message: "the upstream error may contain private fields" };
    checkVideos();
    const revoked = await waitFor(async () => {
      const feed = (await view()).feeds.find((value: { id: number }) => value.id === videoId);
      return feed.error ? feed : undefined;
    });
    assert.equal(revoked.error, "feed-authorization");
    assert.equal(revoked.primed, false);
    assert.ok(nonces.size >= 3);
    assert.equal(renewals, 1);
  } finally { fixture.close(); }
});

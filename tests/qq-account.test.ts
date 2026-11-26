import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createGroupService } from "../runtime/group-service";
import { OneBotConnection } from "../runtime/onebot.js";
import { openQqAccount } from "../runtime/qq-account";
import { openQqAccountSchedules } from "../runtime/qq-account-schedule";
import { openQqRoleDiaryEvents } from "../runtime/qq-role-diary-events";
import { openQqSpaceDiary } from "../runtime/qq-space-diary";
import { openStore } from "../runtime/store";

const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";

test("an independently named QQ gateway uses only the opted-in account contract", { timeout: 10_000 }, async t => {
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const channel = new OneBotConnection({ pollMs: 200, pongMs: 80, probeMs: 150, reconnectMs: 200 });
  t.after(async () => {
    channel.stop();
    for (const client of gateway.clients) client.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
  });
  const settings = {
    enabled: true, address: "ws://127.0.0.1:" + (gateway.address() as AddressInfo).port, expectedBotId: "1001", groups: ["5001"],
    roleId: "", modelId: "", hasToken: false,
  };
  const optedIn = { ...settings, qqAccountContract: "ohjingjing-v1" as const };
  let account = 1001;
  let nickname = "原昵称";
  let postOwner: number | undefined = 1001;
  let version = 1;
  let appName = "独立测试网关";
  const writes: string[] = [];
  const accepted: string[] = [];
  gateway.on("connection", client => client.on("message", raw => {
    const { action, echo, params } = JSON.parse(raw.toString());
    let data: object = {};
    if (action === "get_status") data = { online: true, good: true };
    if (action === "get_login_info") data = { user_id: account, nickname };
    if (action === "get_version_info") data = { app_name: appName, app_version: "4.18.42", protocol_version: "v11",
      ohjingjing_account: { version, capabilities: ["nickname", "qzone", "qzone-posts", "qzone-comments", "qzone-reply"] } };
    if (action === "get_stranger_info") {
      assert.deepEqual(params, { user_id: 1001, no_cache: true });
      data = { user_id: account, nickname };
    }
    if (action === "set_qq_profile") {
      writes.push(action);
      nickname = params.nickname;
    }
    if (action === "get_qzone_msg_list") {
      assert.deepEqual(params, { target_uin: 2001, format: "native" });
      data = { msglist: [{ tid: "allowed-post", user_id: 2001, content: "可见内容" }, { tid: "other-owner", user_id: 9001 }] };
    }
    if (action === "get_qzone_msg_detail") data = { tid: params.tid, uin: params.tid === "new-post" ? postOwner : 2001, comments: [] };
    if (action === "send_qzone_msg") {
      writes.push(action);
      assert.deepEqual(params, { content: "测试内容", ugc_right: 64 });
      data = { tid: "new-post" };
    }
    if (action === "send_group_msg" || action === "send_private_msg") data = { message_id: action === "send_group_msg" ? 100 : 101 };
    client.send(JSON.stringify({ echo, status: "ok", retcode: 0, data }));
  }));
  async function waitFor(check: () => boolean) {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await delay(20);
    }
    assert.fail("The candidate gateway did not reach the expected state");
  }
  const inbound = (message: { messageId: string }) => accepted.push(message.messageId);
  channel.start(settings, null, inbound);
  await waitFor(() => channel.status === "online");
  assert.equal((await channel.checkCapabilities()).accountContract, undefined);
  assert.equal((await channel.selfAccountStatus()).capabilities.nickname, false);

  channel.start(optedIn, null, inbound);
  await waitFor(() => channel.status === "online");
  assert.equal((await channel.checkCapabilities()).accountContract, "declared");
  assert.equal((await channel.selfAccountStatus()).nicknameReadBack, true);
  const update = { kind: "nickname", nickname: "候选昵称" } as const;
  assert.equal((await channel.updateSelfAccount("1001", update, () => false)).state, "policy-changed");
  assert.equal((await channel.updateSelfAccount("2001", update, () => true)).state, "account-mismatch");
  assert.equal((await channel.updateSelfAccount("1001", { kind: "avatar", avatar }, () => true)).state, "unsupported");
  assert.deepEqual(writes, []);
  assert.deepEqual(await channel.updateSelfAccount("1001", update, () => true), { state: "verified", nickname: update.nickname });
  assert.deepEqual(await channel.listSpacePosts("1001", "2001"), [{ id: "allowed-post", excerpt: "可见内容", time: null }]);
  assert.deepEqual(await channel.listSpaceComments("1001", "2001", "allowed-post", 0), { threads: [], nextOffset: null });
  const post = { kind: "qzone", content: "测试内容", visibility: "self" } as const;
  assert.deepEqual(await channel.updateSelfAccount("1001", post, () => true), { state: "verified", platformId: "new-post" });
  postOwner = 2001;
  assert.equal((await channel.updateSelfAccount("1001", post, () => true)).state, "accepted");
  postOwner = undefined;
  assert.equal((await channel.updateSelfAccount("1001", post, () => true)).state, "accepted");
  assert.deepEqual(writes, ["set_qq_profile", "send_qzone_msg", "send_qzone_msg", "send_qzone_msg"]);

  for (const client of gateway.clients) client.send(JSON.stringify({ post_type: "message", message_type: "group",
    self_id: 1001, group_id: 5001, user_id: 2001, message_id: 99, message: [{ type: "text", data: { text: "收到" } }] }));
  await waitFor(() => accepted.includes("99"));
  assert.deepEqual(await channel.deliverGroup("5001", "群回执"), { status: "sent", messageId: "100" });
  assert.deepEqual(await channel.deliverPrivate("2001", "私聊回执"), { status: "sent", messageId: "101" });

  version = 2;
  appName = "NapCat.Onebot";
  assert.equal((await channel.checkCapabilities()).accountContract, "unavailable");
  assert.equal((await channel.updateSelfAccount("1001", update, () => true)).state, "unsupported");
  assert.equal(await channel.listSpacePosts("1001", "2001"), null);
  account = 2001;
  for (const client of gateway.clients) client.terminate();
  await waitFor(() => channel.connectionIssue?.kind === "account-mismatch");
  assert.notEqual(channel.status, "online");
  account = 1001;
  await waitFor(() => channel.status === "online");
  assert.equal((await channel.checkLogin()).account?.id, "1001");
});

test("an interrupted account update is retained without replay after restart", () => {
  const store = openStore(":memory:");
  try {
    const target = "1001";
    const id = randomUUID();
    const update = { kind: "avatar", avatar } as const;
    const before = openQqAccount(store);
    before.save(target, { ...before.policy(target), avatar: true, cooldownSeconds: 0 });
    const schedules = openQqAccountSchedules(store);
    assert.equal(schedules.create(id, target, update, { dueAt: 1000, expiresAt: null }, 0).plan?.state, "queued");
    assert.deepEqual(schedules.due(999), []);
    assert.equal(schedules.due(1000)[0].id, id);
    assert.equal(before.begin(id, target, update).started, true);
    const restarted = openQqAccount(store);
    const recoveredSchedules = openQqAccountSchedules(store);
    assert.equal(restarted.begin(id, target, update).previous?.state, "unknown");
    assert.equal(restarted.history(target).length, 1);
    assert.equal(recoveredSchedules.pending(), false);
    assert.equal(recoveredSchedules.list(target)[0].state, "finished");
    assert.equal(recoveredSchedules.list(target)[0].update, null);
    const future = randomUUID();
    recoveredSchedules.create(future, target, update, { dueAt: 2000, expiresAt: 3000 }, 0);
    assert.equal(openQqAccountSchedules(store).due(2400)[0].id, future);
    const material = { kind: "qzone", mode: "generate", visibility: "self", material: "可发布的合成素材" } as const;
    const prepared = randomUUID();
    const interrupted = randomUUID();
    const scheduleTime = { dueAt: 4000, expiresAt: null };
    recoveredSchedules.create(prepared, target, material, scheduleTime, 0);
    recoveredSchedules.create(interrupted, target, material, scheduleTime, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM qq_account_schedules WHERE state='queued' AND kind='qzone'").get()?.n, 0);
    assert.equal(recoveredSchedules.beginDraft(prepared, "a".repeat(64)), true);
    assert.equal(recoveredSchedules.readyDraft(prepared, "同一份生成文案"), true);
    assert.equal(recoveredSchedules.beginDraft(interrupted, "a".repeat(64)), true);
    const reopened = openQqAccountSchedules(store);
    assert.equal(reopened.due(4200).find(row => row.id === prepared)?.generated_text, "同一份生成文案");
    assert.equal(reopened.due(4200).some(row => row.id === interrupted), false);
    assert.equal(reopened.list(target).find(row => row.id === interrupted)?.generation?.state, "interrupted");
    assert.doesNotMatch(JSON.stringify(restarted.history(target)), /data:image|base64/);
  } finally { store.db.close(); }
});

test("diary event recovery retains queued work and a revoked event cannot be replayed", () => {
  const store = openStore(":memory:");
  try {
    const first = openQqRoleDiaryEvents(store);
    const diary = openQqSpaceDiary(store);
    const policy = { enabled: true, roleChanges: false, accountUpdates: true };
    first.save("1001", 0, policy);
    first.save("1002", 0, policy);
    assert.equal(first.enqueue("1001", "fish", "role-change", "revision", "角色事件"), "disabled");
    assert.equal(first.enqueue("1001", "fish", "operator", "first", "事件甲"), "added");
    assert.equal(first.enqueue("1002", "fish", "operator", "second", "事件乙"), "added");
    const work = first.next("fish", "1001")!;
    const other = first.next("fish", "1002")!;
    assert.equal(first.next("different-role"), undefined);
    assert.equal(work.text, "事件甲");
    assert.equal(other.text, "事件乙");
    assert.equal(first.begin(work.id, "old-role-revision"), true);
    assert.throws(() => first.write(work.id, "撰写测试", (account, role, text) => {
      diary.create(account, role, { text, shareable: false });
      throw new Error("simulated failed save");
    }));
    assert.deepEqual(diary.read("1001", "fish").entries, []);
    const recovered = openQqRoleDiaryEvents(store);
    assert.equal(recovered.next("fish", "1001"), undefined);
    assert.equal(recovered.read("1001", "fish").events[0].reason, "restart");
    assert.equal(recovered.begin(other.id, "other-role-revision"), true);
    assert.equal(recovered.revoke("1001", "fish", other.id, () => assert.fail()), false);
    assert.equal(recovered.revoke("1002", "fish", other.id, () => assert.fail()), true);
    assert.equal(recovered.write(other.id, "迟到的模型输出", () => assert.fail()), false);
    assert.equal(recovered.read("1002", "fish").events[0].text, null);
    assert.equal(recovered.enqueue("1002", "fish", "operator", "second", "事件乙"), "existing");
    assert.equal(recovered.enqueue("1002", "fish", "operator", "second", "不同内容"), "conflict");
    assert.equal(recovered.next("fish", "1002"), undefined);
  } finally { store.db.close(); }
});

test("account changes check the active login, read back nicknames and deduplicate writes", async (t) => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-qq-account-"));
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const generatedRequests: { material: string; input: string; model: string }[] = [];
  const interactionRequests: string[] = [];
  const abortedDrafts = new Set<string>();
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = Buffer.concat(chunks).toString();
    const payload = JSON.parse(input);
    const data = JSON.parse(payload.messages[1].content);
    if (typeof data.post === "string") {
      interactionRequests.push(data.post);
      if (data.post === "模拟等待撤销空间权限") {
        res.once("close", () => { if (!res.writableEnded) abortedDrafts.add(data.post); });
        return;
      }
      const decision = data.post === "角色决定跳过" ? { action: "skip" }
        : data.post === "适合点赞的好消息" ? { action: "like" } : { action: "comment", content: "桌上的花终于等到阳光啦。" };
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 } }));
      return;
    }
    const material = data.material as string;
    generatedRequests.push({ material, input, model: payload.model });
    if (["模拟等待权限撤销", "模拟等待截止时间", "模拟等待撤下日记", "模拟等待撤回事件", "模拟等待停用撰写",
      "模拟等待关联动态"].includes(material)) {
      res.once("close", () => { if (!res.writableEnded) abortedDrafts.add(material); });
      return;
    }
    const content = material === "模型决定跳过" ? null : material === "不恰当的文案" ? "联系 demo@example.test"
      : material.startsWith("整理了桌面") ? "模拟等待关联动态" : "我把小花盆搬到了窗边。";
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ content }) } }],
      usage: { prompt_tokens: 12, completion_tokens: 8 } }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const admin = "integration-account-change-admin";
  const port = (server: { address(): unknown }) => (server.address() as AddressInfo).port;
  const database = join(directory, "state.db");
  const service = createGroupService({ database, adminToken: admin,
    channel: { enabled: true, expectedBotId: "1001", groups: [], address: `ws://127.0.0.1:${port(gateway)}`,
      hasToken: false, roleId: "fixture.publish", modelId: "" },
    observeGroups: ["5001", "5002"],
    summaryModel: { id: "draft-fixture", name: "摘要联调模型", baseUrl: `http://127.0.0.1:${port(provider)}`, model: "summary-for-space",
      billing: "none", hasKey: true, currency: "CNY", billingAccount: "", inputPrice: 1, outputPrice: 2 },
    summaryModelKey: "fixture-draft-provider-key",
    roles: [{ id: "fixture.publish", name: "近况联调鱼", version: "1.0.0", persona: "喜欢用短句写近况。" },
      { id: "fixture.second", name: "第二条联调鱼", version: "1.0.0", persona: "喜欢写短日记。" }],
  });
  t.after(async () => {
    await service.stop();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.ok(resolved.startsWith(root + sep));
    await rm(resolved, { recursive: true, force: true });
  });
  let accountId = 1001;
  let nickname = "测试账号";
  let recognized = true;
  let gatewayVersion = "4.18.42";
  let signatureResult = 0;
  let accountSignature = "原签名";
  let holdMember = false;
  let releaseMember: (() => void) | undefined;
  const cards = new Map([[5001, "原名片"], [5002, "另一群名片"]]);
  type SpaceComment = { comment_id: string; uin: number; name: string; content: string; time: number };
  type SpaceReply = SpaceComment & { parent_comment_id: string; parent_comment_uin: number };
  const spaceComments: (SpaceComment & { replies: SpaceReply[] })[] = [];
  let spacePostTime = 1760000000;
  let freshPostId = "visible-post";
  let freshPostContent = "合成可见动态";
  let holdSpaceDetail = false;
  let releaseSpaceDetail: (() => void) | undefined;
  const writes: { action: string; params: object }[] = [];
  gateway.on("connection", socket => socket.on("message", (raw: Buffer) => {
    const frame = JSON.parse(raw.toString());
    let data = {};
    if (frame.action === "get_version_info") data = { app_name: recognized ? "NapCat.Onebot" : "other", protocol_version: "v11", app_version: gatewayVersion };
    else if (frame.action === "get_login_info") data = { user_id: accountId, nickname };
    else if (frame.action === "get_status") data = { online: true, good: true };
    else if (frame.action === "get_stranger_info") {
      assert.deepEqual(frame.params, { user_id: accountId, no_cache: true });
      data = { user_id: accountId, nickname, longNick: accountSignature, long_nick: accountSignature, email: "private@example.test" };
    } else if (frame.action === "set_qq_profile" || frame.action === "set_qq_avatar") {
      writes.push({ action: frame.action, params: frame.params });
      if (frame.action === "set_qq_profile") nickname = frame.params.nickname;
    } else if (frame.action === "set_self_longnick") {
      writes.push({ action: frame.action, params: frame.params });
      data = { result: signatureResult };
      if (signatureResult === 0) accountSignature = frame.params.longNick;
    } else if (frame.action === "get_group_member_info") {
      const { group_id, user_id, no_cache } = frame.params;
      assert.equal(no_cache, true);
      assert.equal(user_id, accountId);
      data = { group_id, user_id, card: cards.get(group_id) };
      if (holdMember) {
        holdMember = false;
        releaseMember = () => socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data }));
        return;
      }
    } else if (frame.action === "set_group_card") {
      writes.push({ action: frame.action, params: frame.params });
      cards.set(frame.params.group_id, frame.params.card);
    } else if (frame.action === "send_qzone_msg") {
      writes.push({ action: frame.action, params: frame.params });
      data = { tid: "demo-post", time: 0 };
    } else if (frame.action === "get_qzone_msg_list") {
      assert.deepEqual(frame.params, { target_uin: 2001, format: "native" });
      data = { msglist: [
        { tid: freshPostId, user_id: "2001", content: freshPostContent, time: spacePostTime, feed_ref: { raw: "not-for-dashboard" } },
        { tid: "another-author", user_id: "2002", content: "越界动态" },
        { tid: "https://example.test", user_id: "2001", content: "无效编号" },
      ] };
    } else if (frame.action === "get_qzone_msg_detail") {
      if (frame.params.tid === "demo-post") {
        assert.deepEqual(frame.params, { tid: "demo-post", target_uin: accountId, pos: 0, num: 1 });
        data = { tid: "demo-post", content: "发布正文" };
      } else {
        assert.deepEqual(frame.params, { tid: frame.params.tid, target_uin: 2001, pos: frame.params.pos, num: frame.params.num });
        assert.ok([1, 20].includes(frame.params.num));
        if (frame.params.tid === freshPostId) data = { tid: freshPostId,
          comments: spaceComments.slice(frame.params.pos, frame.params.pos + frame.params.num) };
        if (holdSpaceDetail) {
          holdSpaceDetail = false;
          releaseSpaceDetail = () => socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data }));
          return;
        }
      }
    } else if (["comment_qzone", "like_qzone", "unlike_qzone"].includes(frame.action)) {
      writes.push({ action: frame.action, params: frame.params });
      if (frame.action === "comment_qzone") {
        const { comment_id, comment_uin, reply_uin, reply_name, content } = frame.params;
        const author = { uin: accountId, name: "测试账号", time: Math.floor(Date.now() / 1000) };
        if (comment_id) {
          const parent = spaceComments.find(row => row.comment_id === comment_id);
          assert.ok(parent && parent.uin === comment_uin);
          const newId = parent.replies.length ? "reply-" + (parent.replies.length + 1) : parent.comment_id;
          const link = { parent_comment_id: comment_id, parent_comment_uin: comment_uin };
          parent.replies.push({ ...author, ...link, comment_id: newId, content: reply_uin
            ? '@{uin:' + reply_uin + ',nick:' + reply_name + ',auto:1} ' + content : content });
          data = { comment_id: newId, ...link };
        } else {
          spaceComments.unshift({ ...author, comment_id: "comment-" + (spaceComments.length + 1), content, replies: [] });
        }
      }
    } else assert.fail("Unrecognized gateway action: " + frame.action);
    socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data }));
  }));
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const connected = once(gateway, "connection");
  service.startChannel();
  await connected;
  function request(path = "", method = "GET", data?: object, token = admin) {
    return fetch(`http://127.0.0.1:${port(service.server)}/admin/qq-account${path}`, {
      method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: data && JSON.stringify(data),
    });
  }
  const edit = { id: randomUUID(), accountId: "1001", kind: "nickname", nickname: "小鱼" };
  const permission = { accountId: "1001", nickname: true, avatar: true, cooldownSeconds: 30 };
  assert.equal((await request("/actions", "POST", edit, "not-admin")).status, 403);
  const first = await (await request()).json();
  assert.deepEqual(first.capabilities, { nickname: true, avatar: true, signature: true, "group-card": true, qzone: true,
    "qzone-comment": true, "qzone-like": true, "qzone-reply": true });
  assert.equal(first.nicknameReadBack, true);
  assert.equal(first.account.id, "1001");
  assert.equal(first.policy.nickname, false);
  assert.equal(first.currentSignature, "原签名");
  assert.equal((await request("/actions", "POST", edit)).status, 409);
  assert.equal(writes.length, 0);
  assert.equal((await request("/policy", "PUT", permission)).status, 200);
  const changed = (await (await request("/actions", "POST", edit)).json()).operation;
  assert.equal(changed.state, "verified");
  assert.equal(changed.observedNickname, "小鱼");
  assert.doesNotMatch(JSON.stringify(changed), /private@example/);
  assert.deepEqual((await (await request("/actions", "POST", edit)).json()).operation, changed);
  assert.equal((await request("/actions", "POST", { ...edit, nickname: "另一昵称" })).status, 409);
  const image = { id: randomUUID(), accountId: "1001", kind: "avatar", avatar };
  assert.equal((await request("/actions", "POST", image)).status, 429);
  assert.equal((await request("/policy", "PUT", { ...permission, cooldownSeconds: 0 })).status, 200);
  assert.equal((await request("/actions", "POST", { ...image, avatar: "https://example.test/picture.png" })).status, 400);
  assert.equal((await (await request("/actions", "POST", image)).json()).operation.state, "accepted");
  const post = { kind: "qzone", id: randomUUID(), accountId: "1001", content: "发布正文", visibility: "self" };
  assert.equal((await request("/actions", "POST", post)).status, 409);
  assert.equal((await request("/policy", "PUT", { ...permission, cooldownSeconds: 0, qzone: true, spaceVisibility: "self" })).status, 200);
  assert.equal((await request("/actions", "POST", { ...post, visibility: "public" })).status, 409);
  gatewayVersion = "4.18.41";
  assert.equal((await (await request("/actions", "POST", { ...post, id: randomUUID() })).json()).operation.state, "unsupported");
  gatewayVersion = "4.18.42";
  const issued = (await (await request("/actions", "POST", post)).json()).operation;
  assert.equal(issued.state, "verified");
  assert.equal(issued.platformId, "demo-post");
  assert.equal(issued.requestedVisibility, "self");
  assert.deepEqual((await (await request("/actions", "POST", post)).json()).operation, issued);
  accountId = 2001;
  assert.equal((await (await request("/actions", "POST", { ...edit, id: randomUUID() })).json()).operation.state, "account-mismatch");
  assert.equal((await request("/policy", "PUT", permission)).status, 409);
  accountId = 1001;
  recognized = false;
  assert.equal((await (await request("/actions", "POST", { ...edit, id: randomUUID() })).json()).operation.state, "unsupported");
  assert.deepEqual(writes, [{ action: "set_qq_profile", params: { nickname: "小鱼" } },
    { action: "set_qq_avatar", params: { file: "base64://" + avatar.split(",")[1] } },
    { action: "send_qzone_msg", params: { content: "发布正文", ugc_right: 64 } }]);
  const history = (await (await request()).json()).actions;
  assert.equal(history.length, 6);
  assert.doesNotMatch(JSON.stringify(history), /data:image|base64|发布正文/);

  recognized = true;
  const time = Date.now() + 1500;
  const scheduledNickname = { ...edit, id: randomUUID(), nickname: "预约昵称", dueAt: time, expiresAt: null };
  const cancelledAvatar = { ...image, id: randomUUID(), dueAt: time + 60_000 };
  const expiringPost = { ...post, id: randomUUID(), dueAt: time, expiresAt: time + 450 };
  const queuedPost = { ...post, id: randomUUID(), dueAt: time, expiresAt: time + 60_000 };
  assert.equal((await request("/schedules", "POST", scheduledNickname, "not-admin")).status, 403);
  assert.equal((await request("/schedules", "POST", { ...scheduledNickname, expiresAt: time })).status, 400);
  assert.equal((await request("/schedules", "POST", { ...queuedPost, visibility: "public" })).status, 409);
  const plans = async () => (await (await request()).json()).schedules;
  const add = async (plan: object) => {
    const response = await request("/schedules", "POST", plan);
    assert.equal(response.status, 200);
    return (await response.json()).plan;
  };
  assert.deepEqual(await add(scheduledNickname), await add(scheduledNickname));
  assert.equal((await request("/actions", "POST", scheduledNickname)).status, 409);
  assert.equal((await request("/schedules", "POST", { ...scheduledNickname, nickname: "不同预约" })).status, 409);
  assert.equal((await add(cancelledAvatar)).update.avatar, avatar);
  await add(expiringPost);
  await add(queuedPost);
  assert.equal(writes.length, 3);
  assert.equal((await request("/schedules", "DELETE", cancelledAvatar)).status, 200);
  assert.equal((await request("/policy", "PUT", { ...permission, cooldownSeconds: 0, qzone: false })).status, 200);
  const find = async (id: string) => (await plans()).find((item: { id: string }) => item.id === id);
  async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 90; i++) {
      if (await check()) return;
      await delay(60);
    }
    assert.fail("Scheduled operation did not reach its expected state");
  }
  await waitFor(async () => (await find(scheduledNickname.id)).operation?.state === "verified" &&
    (await find(expiringPost.id)).state === "expired" && (await find(queuedPost.id)).hold === "permission");
  assert.equal((await find(cancelledAvatar.id)).state, "cancelled");
  assert.deepEqual(writes.slice(3), [{ action: "set_qq_profile", params: { nickname: "预约昵称" } }]);
  assert.equal((await request("/policy", "PUT", { ...permission, cooldownSeconds: 0, qzone: true, spaceVisibility: "self" })).status, 200);
  await waitFor(async () => (await find(queuedPost.id)).operation?.state === "verified");
  assert.deepEqual(writes.slice(4), [{ action: "send_qzone_msg", params: { content: "发布正文", ugc_right: 64 } }]);
  const done = await add(queuedPost);
  assert.equal(done.state, "finished");
  assert.equal(done.update, null);
  assert.equal((await request("/schedules", "DELETE", queuedPost)).status, 409);
  assert.equal(writes.length, 5);
  const offlineAvatar = { ...image, id: randomUUID(), dueAt: Date.now() + 1100 };
  await add(offlineAvatar);
  const toggle = async (enabled: boolean) => fetch(`http://127.0.0.1:${port(service.server)}/admin/plugins/im-channel`, {
    method: "PUT", headers: { Authorization: "Bearer " + admin, "Content-Type": "application/json" },
    body: JSON.stringify({ pluginId: "qq.onebot", enabled }),
  });
  assert.equal((await toggle(false)).status, 200);
  await waitFor(async () => (await find(offlineAvatar.id)).hold === "gateway");
  assert.equal(writes.length, 5);
  assert.equal((await toggle(true)).status, 200);
  await waitFor(async () => (await find(offlineAvatar.id)).operation?.state === "accepted");
  assert.deepEqual(writes.slice(5), [{ action: "set_qq_avatar", params: { file: "base64://" + avatar.split(",")[1] } }]);

  const seed = openStore(database);
  seed.db.prepare("INSERT INTO group_messages(scope,author,content,created_at) VALUES('qq:1001:5001','2001',?,?)")
    .run("群聊保密样本", new Date().toISOString());
  seed.db.prepare("INSERT INTO messages(scope,role_id,author,content,created_at) VALUES('qq-private:1001:2001','fixture.publish','user',?,?)")
    .run("私聊保密样本", new Date().toISOString());
  seed.db.close();
  const serverUrl = `http://127.0.0.1:${port(service.server)}`;
  const adminHeaders = { Authorization: "Bearer " + admin, "Content-Type": "application/json" };
  async function setBudget(version: number, limit: number | null) {
    const response = await fetch(serverUrl + "/admin/budget", { method: "PUT", headers: adminHeaders,
      body: JSON.stringify({ version, background: { daily: limit, monthly: null },
        currencies: [], warningPercent: 80, pauseOnCostLimit: false }) });
    assert.equal(response.status, 200);
  }
  const draft = (material: string, deadline?: number) => {
    const dueAt = Date.now() + 1100;
    return { id: randomUUID(), accountId: "1001", kind: "qzone", mode: "generate", visibility: "self", material, dueAt,
      expiresAt: deadline === undefined ? null : dueAt + deadline };
  };
  await setBudget(0, 0);
  const generated = draft("角色办公桌上多了一个小花盆。");
  await add(generated);
  await waitFor(async () => (await find(generated.id)).hold === "budget");
  assert.equal(generatedRequests.length, 0);
  assert.equal(writes.length, 6);
  await setBudget(1, null);
  await waitFor(async () => (await find(generated.id)).operation?.state === "verified");
  assert.equal(generatedRequests.length, 1);
  assert.equal(generatedRequests[0].model, "summary-for-space");
  assert.equal(generatedRequests[0].material, generated.material);
  assert.match(generatedRequests[0].input, /近况联调鱼/);
  assert.doesNotMatch(generatedRequests[0].input, /群聊保密样本|私聊保密样本/);
  assert.deepEqual(writes[6], { action: "send_qzone_msg", params: { content: "我把小花盆搬到了窗边。", ugc_right: 64 } });
  const generatedState = await add(generated);
  assert.equal(generatedState.generation.state, "ready");
  assert.match(generatedState.generation.roleRevision, /^[a-f0-9]{64}$/u);
  assert.equal(generatedState.generation.content, null);
  const usage = await (await fetch(serverUrl + "/admin/status", { headers: adminHeaders })).json();
  assert.equal(usage.usage.find((row: { purpose: string }) => row.purpose === "qzone").requests, 1);
  assert.equal(usage.budget.background.daily.used, 1);

  const skipped = draft("模型决定跳过");
  const invalid = draft("不恰当的文案");
  await add(skipped);
  await add(invalid);
  await waitFor(async () => (await find(skipped.id)).generation?.state === "skipped" &&
    (await find(invalid.id)).generation?.reason === "invalid-output");

  const interrupted = draft("模拟等待权限撤销");
  await add(interrupted);
  await waitFor(async () => generatedRequests.some(row => row.material === interrupted.material));
  assert.equal((await request("/policy", "PUT", { ...permission, cooldownSeconds: 0, qzone: false })).status, 200);
  await waitFor(async () => (await find(interrupted.id)).generation?.reason === "permission");
  await waitFor(async () => abortedDrafts.has(interrupted.material));
  assert.equal((await request("/policy", "PUT", { ...permission, cooldownSeconds: 0, qzone: true, spaceVisibility: "self" })).status, 200);
  const deadline = draft("模拟等待截止时间", 2600);
  await add(deadline);
  await waitFor(async () => (await find(deadline.id)).state === "expired" && abortedDrafts.has(deadline.material));
  assert.equal(writes.length, 7);
  assert.equal(generatedRequests.length, 5);

  const diaryRole = "fixture.publish";
  const diary = async () => (await (await request()).json()).diary;
  const addDiary = (text: string, shareable: boolean) => request("/diary", "POST",
    { accountId: "1001", roleId: diaryRole, text, shareable });
  assert.equal((await request("/diary", "POST", { accountId: "1001", roleId: diaryRole, text: "鉴权样本", shareable: true }, "bad")).status, 403);
  assert.equal((await addDiary("仅角色自己留存的近况", false)).status, 200);
  assert.equal((await addDiary("可以对外说的小花盆近况", true)).status, 200);
  const rule = (nextAt: number, enabled: boolean, previous?: { version: number; nextAt: number }) =>
    request("/diary-rule", "PUT", { accountId: "1001", expectedVersion: previous?.version ?? 0,
      expectedNextAt: previous?.nextAt, enabled, nextAt, windowMinutes: 1, intervalDays: 1, visibility: "self" });
  const firstSlot = Date.now() + 1400;
  assert.equal((await rule(firstSlot, true)).status, 200);
  await waitFor(async () => writes.length === 8);
  assert.deepEqual(writes[7], { action: "send_qzone_msg", params: { content: "我把小花盆搬到了窗边。", ugc_right: 64 } });
  assert.deepEqual(generatedRequests.slice(5).map(row => row.material), ["可以对外说的小花盆近况"]);
  assert.equal((await diary()).rule.nextAt, firstSlot + 86_400_000);
  assert.equal((await diary()).entries.find((entry: { shareable: boolean }) => !entry.shareable).selected, false);

  assert.equal((await addDiary("模拟等待撤下日记", true)).status, 200);
  assert.equal((await rule(Date.now() + 1400, true, (await diary()).rule)).status, 200);
  await waitFor(async () => generatedRequests.some(row => row.material === "模拟等待撤下日记"));
  const revokeEntry = (await diary()).entries.find((entry: { text: string }) => entry.text === "模拟等待撤下日记");
  assert.equal((await request("/diary", "PUT", { accountId: "1001", roleId: diaryRole, entryId: revokeEntry.id,
    expectedVersion: revokeEntry.version, text: revokeEntry.text, shareable: false })).status, 200);
  await waitFor(async () => abortedDrafts.has("模拟等待撤下日记") &&
    (await plans()).some((plan: { state: string; generation?: { state: string } }) => plan.state === "cancelled" && plan.generation?.state === "interrupted"));

  assert.equal((await addDiary("暂停计划时不会生成的近况", true)).status, 200);
  await setBudget(2, 0);
  assert.equal((await rule(Date.now() + 1400, true, (await diary()).rule)).status, 200);
  await waitFor(async () => (await plans()).some((plan: { update?: { diary?: unknown }; hold: string }) => plan.update?.diary && plan.hold === "budget"));
  const savedRule = (await diary()).rule;
  assert.equal((await rule(savedRule.nextAt, false, savedRule)).status, 200);
  await waitFor(async () => !(await plans()).some((plan: { update?: { diary?: unknown }; state: string }) => plan.update?.diary && plan.state === "queued"));
  assert.equal(writes.length, 8);
  assert.equal((await diary()).rule.enabled, false);
  assert.equal(generatedRequests.some(row => row.material === "暂停计划时不会生成的近况"), false);

  const eventScope = { accountId: "1001", roleId: diaryRole };
  const setWriter = (expectedVersion: number, enabled: boolean, automations = true) =>
    request("/diary-writer", "PUT", { ...eventScope, expectedVersion, enabled, roleChanges: automations, accountUpdates: automations });
  const addEvent = (text: string, eventKey = randomUUID()) =>
    request("/diary-events", "POST", { ...eventScope, text, eventKey });
  const writer = async () => (await diary()).writer;
  assert.deepEqual((await writer()).settings, { version: 0, enabled: false, roleChanges: false, accountUpdates: false });
  assert.deepEqual((await writer()).events, []);
  const eventKey = randomUUID();
  const eventText = "整理了桌面。联调邮件 demo@example.test";
  assert.equal((await addEvent(eventText, eventKey)).status, 200);
  assert.equal((await addEvent(eventText, eventKey)).status, 200);
  assert.equal((await addEvent("不同的事件正文", eventKey)).status, 409);
  assert.equal((await writer()).events.length, 1);
  assert.equal((await setWriter(0, true)).status, 200);
  assert.equal((await setWriter(0, false)).status, 409);
  await waitFor(async () => (await writer()).events[0].reason === "budget");
  assert.equal(generatedRequests.some(request => request.material.startsWith("整理了桌面")), false);
  await setBudget(3, null);
  await waitFor(async () => (await writer()).events[0].state === "written");
  const event = (await writer()).events[0];
  assert.match(event.roleRevision, /^[a-f0-9]{64}$/u);
  const modelCall = generatedRequests.find(request => request.material.startsWith("整理了桌面"))!;
  assert.equal(modelCall.model, "summary-for-space");
  assert.match(modelCall.input, /第一人称的私人日记/);
  assert.doesNotMatch(modelCall.input, /demo@example\.test|群聊保密样本|私聊保密样本/);
  assert.equal(writes.length, 8);
  const readEntry = async () => (await diary()).entries.find((item: { id: number }) => item.id === event.diaryId);
  const written = await readEntry();
  assert.deepEqual(written, { id: event.diaryId, version: 1, text: "模拟等待关联动态", shareable: false, selected: false, canShare: true });
  const share = (entry: typeof written) => request("/diary", "PUT", { ...eventScope, entryId: entry.id,
    expectedVersion: entry.version, text: entry.text, shareable: true });
  assert.equal((await share(written)).status, 200);
  assert.equal((await rule(Date.now() + 1400, true, (await diary()).rule)).status, 200);
  await waitFor(async () => generatedRequests.some(request => request.material === written.text));
  const linkedPlan = (await plans()).find((plan: { update?: { diary?: { entryId: number } } }) => plan.update?.diary?.entryId === written.id);
  assert.ok(linkedPlan);
  const revokeEvent = (id: number) => request("/diary-events", "DELETE", { ...eventScope, eventId: id });
  assert.equal((await revokeEvent(event.id)).status, 200);
  await waitFor(async () => abortedDrafts.has(written.text) && (await find(linkedPlan.id)).state === "cancelled");
  assert.equal((await rule((await diary()).rule.nextAt, false, (await diary()).rule)).status, 200);
  const withdrawn = await readEntry();
  assert.equal(withdrawn.shareable, false);
  assert.equal(withdrawn.canShare, false);
  assert.equal((await share(withdrawn)).status, 409);
  assert.equal((await writer()).events[0].text, null);
  assert.equal((await addEvent(eventText, eventKey)).status, 200);
  assert.equal((await writer()).events[0].state, "revoked");

  assert.equal((await addEvent("模拟等待撤回事件")).status, 200);
  await waitFor(async () => generatedRequests.some(request => request.material === "模拟等待撤回事件"));
  const inFlight = (await writer()).events.find((item: { state: string }) => item.state === "running");
  assert.equal((await revokeEvent(inFlight.id)).status, 200);
  await waitFor(async () => abortedDrafts.has("模拟等待撤回事件"));
  assert.equal((await writer()).events.find((item: { id: number }) => item.id === inFlight.id).state, "revoked");

  const newNickname = { ...edit, id: randomUUID(), nickname: "未发送给模型的回执昵称" };
  const newAvatar = { ...image, id: randomUUID() };
  assert.equal((await (await request("/actions", "POST", newNickname)).json()).operation.state, "verified");
  assert.equal((await (await request("/actions", "POST", newNickname)).json()).operation.state, "verified");
  assert.equal((await (await request("/actions", "POST", newAvatar)).json()).operation.state, "accepted");
  await waitFor(async () => (await writer()).events.filter((item: { source: string; state: string }) =>
    item.source === "account-update" && item.state === "written").length === 2);
  const receiptCalls = generatedRequests.filter(request => /更新的 QQ 昵称|新的 QQ 头像/.test(request.material));
  assert.equal(receiptCalls.length, 2);
  assert.doesNotMatch(JSON.stringify(receiptCalls), /未发送给模型的回执昵称|base64/);

  const rolePath = serverUrl + "/admin/plugins/assigned-role";
  const defaultRole = await (await fetch(rolePath + "?scope=default", { headers: adminHeaders })).json();
  const secondRole = defaultRole.choices.find((choice: { id: string }) => choice.id === "fixture.second");
  assert.equal((await fetch(rolePath, { method: "PUT", headers: adminHeaders,
    body: JSON.stringify({ scope: "default", expectedVersion: defaultRole.assignedVersion, revision: secondRole.revision }) })).status, 200);
  await waitFor(async () => (await writer()).events.some((item: { source: string; state: string }) =>
    item.source === "role-change" && item.state === "written"));
  assert.equal((await diary()).roleId, "fixture.second");
  assert.equal((await diary()).entries.length, 1);
  assert.match(generatedRequests.at(-1)!.input, /第二条联调鱼/);
  assert.equal((await request("/diary-events", "POST", { ...eventScope, eventKey: randomUUID(), text: "过期角色事件" })).status, 409);

  const pauseText = "模拟等待停用撰写";
  const secondScope = { ...eventScope, roleId: "fixture.second" };
  assert.equal((await request("/diary-events", "POST", { ...secondScope, eventKey: randomUUID(), text: pauseText })).status, 200);
  await waitFor(async () => generatedRequests.some(request => request.material === pauseText));
  assert.equal((await request("/diary-writer", "PUT", { ...secondScope, expectedVersion: 1,
    enabled: false, roleChanges: false, accountUpdates: false })).status, 200);
  await waitFor(async () => abortedDrafts.has(pauseText));
  assert.equal((await writer()).events.find((item: { text: string }) => item.text === pauseText).state, "interrupted");
  assert.equal((await diary()).entries.length, 1);
  assert.equal(writes.length, 10);
  const writerUsage = await (await fetch(serverUrl + "/admin/status", { headers: adminHeaders })).json();
  assert.equal(writerUsage.usage.find((row: { purpose: string }) => row.purpose === "role-diary").requests, 6);
  assert.equal(writerUsage.budget.background.daily.used, generatedRequests.length);

  const newPolicy = { ...permission, cooldownSeconds: 0, signature: true, groupCards: ["5001"] };
  const signature = { id: randomUUID(), accountId: "1001", kind: "signature", signature: "今天也要自在一点" };
  const card = { id: randomUUID(), accountId: "1001", kind: "group-card", groupId: "5001", card: "鱼鱼", user_id: 9999 };
  assert.deepEqual((await (await request()).json()).groups.map((group: { id: string }) => group.id), ["5001", "5002"]);
  assert.equal((await request("/actions", "POST", signature)).status, 409);
  assert.equal((await request("/policy", "PUT", { ...newPolicy, groupCards: ["5003"] })).status, 400);
  assert.equal((await request("/policy", "PUT", newPolicy)).status, 200);
  await request("/policy", "PUT", { ...permission, cooldownSeconds: 0 });
  assert.deepEqual((await (await request()).json()).policy.groupCards, ["5001"]);
  assert.equal((await request("/actions", "POST", { ...card, groupId: "5002" })).status, 409);
  const signed = (await (await request("/actions", "POST", signature)).json()).operation;
  assert.equal(signed.state, "verified");
  assert.equal(signed.requestedSignature, signature.signature);
  assert.equal(signed.observedSignature, signature.signature);
  assert.equal((await (await request()).json()).currentSignature, signature.signature);
  signatureResult = 42;
  assert.equal((await (await request("/actions", "POST", { ...signature, id: randomUUID() })).json()).operation.state, "failed");
  const changedCard = (await (await request("/actions", "POST", card)).json()).operation;
  assert.deepEqual([changedCard.state, changedCard.groupId, changedCard.observedCard], ["verified", "5001", "鱼鱼"]);
  assert.deepEqual((await (await request("/actions", "POST", card)).json()).operation, changedCard);
  assert.deepEqual(writes.slice(-3), [
    { action: "set_self_longnick", params: { longNick: signature.signature } },
    { action: "set_self_longnick", params: { longNick: signature.signature } },
    { action: "set_group_card", params: { group_id: 5001, user_id: 1001, card: "鱼鱼" } },
  ]);
  assert.equal(cards.get(5002), "另一群名片");

  holdMember = true;
  const denied = request("/actions", "POST", { ...card, id: randomUUID(), card: "权限已撤销" });
  await waitFor(async () => !!releaseMember);
  assert.equal((await request("/policy", "PUT", { ...newPolicy, groupCards: [] })).status, 200);
  releaseMember!();
  assert.equal((await (await denied).json()).operation.state, "policy-changed");
  assert.equal(cards.get(5001), "鱼鱼");
  assert.equal((await request("/policy", "PUT", newPolicy)).status, 200);

  const clearing = { ...card, id: randomUUID(), card: "", dueAt: Date.now() + 1250 };
  assert.equal((await request("/schedules", "POST", clearing)).status, 200);
  await waitFor(async () => (await find(clearing.id))?.operation?.state === "verified");
  assert.equal(cards.get(5001), "");

  const target = { accountId: "1001", targetId: "2001", postId: "visible-post" };
  const comment = { ...target, id: randomUUID(), kind: "qzone-comment", content: "联调评论" };
  const like = { ...target, id: randomUUID(), kind: "qzone-like", like: true };
  const spaces = { ...newPolicy, spaceTargets: ["2001"], spaceComment: true, spaceLike: false };
  assert.equal((await request("/actions", "POST", comment)).status, 409);
  assert.equal((await request("/actions", "POST", comment, "not-admin")).status, 403);
  const listPosts = "/space-posts?accountId=1001&targetId=2001";
  assert.equal((await request(listPosts)).status, 403);
  assert.equal((await request("/policy", "PUT", spaces)).status, 200);
  assert.equal((await request("/space-posts?accountId=1001&targetId=2002")).status, 403);
  assert.deepEqual(await (await request(listPosts)).json(), { posts: [{ id: "visible-post", excerpt: "合成可见动态", time: 1760000000 }] });
  assert.equal((await request("/actions", "POST", { ...comment, targetId: "2002" })).status, 409);
  assert.equal((await request("/actions", "POST", { ...comment, postId: "https://example.test" })).status, 400);
  assert.equal((await request("/actions", "POST", like)).status, 409);
  const priorWrites = writes.length;
  const inaccessible = (await (await request("/actions", "POST", { ...comment, id: randomUUID(), postId: "inaccessible" })).json()).operation;
  assert.equal(inaccessible.state, "failed");
  assert.equal(writes.length, priorWrites);
  const firstComment = (await (await request("/actions", "POST", comment)).json()).operation;
  assert.deepEqual([firstComment.state, firstComment.spaceOwnerId, firstComment.spacePostId, firstComment.platformId],
    ["verified", "2001", "visible-post", "comment-1"]);
  assert.deepEqual((await (await request("/actions", "POST", comment)).json()).operation, firstComment);
  assert.equal(spaceComments.length, 1);

  assert.equal((await request("/policy", "PUT", { ...spaces, spaceLike: true })).status, 200);
  assert.equal((await (await request("/actions", "POST", like)).json()).operation.state, "accepted");
  assert.equal((await (await request("/actions", "POST", { ...like, id: randomUUID(), like: false })).json()).operation.requestedLike, false);
  assert.deepEqual(writes.slice(priorWrites), [
    { action: "comment_qzone", params: { tid: "visible-post", target_uin: 2001, content: "联调评论" } },
    { action: "like_qzone", params: { tid: "visible-post", target_uin: 2001 } },
    { action: "unlike_qzone", params: { tid: "visible-post", target_uin: 2001 } },
  ]);

  const listComments = "/space-comments?accountId=1001&targetId=2001&postId=visible-post";
  const commentPage = await (await request(listComments)).json();
  assert.deepEqual(commentPage, { threads: [{ id: "comment-1", author: "测试账号", excerpt: "联调评论",
    time: spaceComments[0].time, replyable: true, replies: [] }], nextOffset: null });
  assert.deepEqual(await (await request(listComments + "&offset=20")).json(), { threads: [], nextOffset: null });
  assert.equal((await request(listComments + "&offset=-1")).status, 400);
  assert.equal((await request(listComments.replace("2001", "2002"))).status, 403);
  assert.equal((await request(listComments, "GET", undefined, "not-admin")).status, 403);
  const reply = { ...target, id: randomUUID(), kind: "qzone-reply", parentCommentId: "comment-1", content: "楼中楼联调" };
  const beforeReplies = writes.length;
  const sendReply = async (input: object) => (await (await request("/actions", "POST", input)).json()).operation;
  assert.equal((await sendReply({ ...reply, id: randomUUID(), parentCommentId: "missing" })).state, "failed");
  assert.equal((await sendReply({ ...reply, id: randomUUID(), replyToId: "missing" })).state, "failed");
  assert.equal(writes.length, beforeReplies);
  const postedReply = await sendReply(reply);
  assert.deepEqual([postedReply.state, postedReply.platformId, postedReply.spaceParentCommentId, postedReply.spaceReplyToId],
    ["verified", "comment-1", "comment-1", null]);
  assert.deepEqual(await sendReply(reply), postedReply);
  assert.equal((await request("/actions", "POST", { ...reply, content: "另一段回复" })).status, 409);
  assert.equal((await (await request(listComments)).json()).threads[0].replies[0].id, "comment-1");
  const replyToReply = await sendReply({ ...reply, id: randomUUID(), replyToId: "comment-1",
    content: "继续楼中楼", reply_uin: 8001, reply_name: "外部填写" });
  assert.deepEqual([replyToReply.state, replyToReply.platformId, replyToReply.spaceReplyToId], ["verified", "reply-2", "comment-1"]);
  assert.deepEqual(writes.slice(beforeReplies), [
    { action: "comment_qzone", params: { tid: "visible-post", target_uin: 2001, content: "楼中楼联调",
      comment_id: "comment-1", comment_uin: 1001 } },
    { action: "comment_qzone", params: { tid: "visible-post", target_uin: 2001, content: "继续楼中楼",
      comment_id: "comment-1", comment_uin: 1001, reply_uin: 1001, reply_name: "测试账号" } },
  ]);

  releaseSpaceDetail = undefined;
  holdSpaceDetail = true;
  const withdrawnComment = request("/actions", "POST", { ...reply, id: randomUUID() });
  await waitFor(async () => !!releaseSpaceDetail);
  assert.equal((await request("/policy", "PUT", { ...spaces, spaceTargets: [] })).status, 200);
  releaseSpaceDetail!();
  assert.equal((await (await withdrawnComment).json()).operation.state, "policy-changed");
  assert.equal(spaceComments.length, 1);
  assert.equal(spaceComments[0].replies.length, 2);
  assert.equal((await request(listComments)).status, 403);

  const autoPath = "/space-interaction";
  const configure = async (mode: string, targetIds = ["2001"], comment = true, like = false) => {
    const before = (await (await request()).json()).spaceInteraction.rule;
    return request(autoPath, "PUT", { accountId: "1001", mode, targetIds, comment, like, nextAt: Date.now() + 1200,
      intervalDays: 1, windowMinutes: 1, expectedVersion: before?.version ?? 0, expectedNextAt: before?.nextAt });
  };
  const autoRuns = async () => (await (await request()).json()).spaceInteraction.runs;
  const latestRun = async () => (await autoRuns())[0];
  assert.equal((await configure("enabled")).status, 409);
  assert.equal((await request("/policy", "PUT", spaces)).status, 200);
  assert.equal((await configure("enabled", ["2001", "2002"])).status, 409);
  assert.equal((await configure("enabled", ["2001"], true, true)).status, 409);

  const beforeAuto = writes.length;
  spacePostTime = Math.floor(Date.now() / 1000);
  freshPostContent = "一盆小花正晒太阳，参考 https://example.test/hidden";
  assert.equal((await configure("preview")).status, 200);
  await waitFor(async () => (await latestRun())?.state === "preview");
  const preview = await latestRun();
  assert.equal(preview.previewText, "桌上的花终于等到阳光啦。");
  assert.equal(preview.operation, null);
  assert.equal(writes.length, beforeAuto);
  assert.deepEqual(interactionRequests, ["一盆小花正晒太阳，参考 [链接]"]);
  assert.equal((await configure("enabled")).status, 200);
  await waitFor(async () => (await latestRun())?.state === "submitted");
  assert.equal((await latestRun()).operation.state, "verified");
  assert.equal(writes.length, beforeAuto + 1);
  assert.equal(interactionRequests.length, 2);
  assert.equal((await configure("enabled")).status, 200);
  await waitFor(async () => (await latestRun())?.state === "no-post");
  assert.equal(writes.length, beforeAuto + 1);
  assert.equal(interactionRequests.length, 2);

  freshPostId = "revoked-during-generation";
  freshPostContent = "模拟等待撤销空间权限";
  assert.equal((await configure("enabled")).status, 200);
  await waitFor(async () => interactionRequests.includes(freshPostContent));
  assert.equal((await request("/policy", "PUT", { ...spaces, spaceComment: false })).status, 200);
  await waitFor(async () => (await latestRun())?.state === "interrupted" && abortedDrafts.has(freshPostContent));
  assert.equal(writes.length, beforeAuto + 1);

  assert.equal((await request("/policy", "PUT", { ...spaces, spaceLike: true })).status, 200);
  freshPostId = "like-candidate";
  freshPostContent = "适合点赞的好消息";
  assert.equal((await configure("enabled", ["2001"], false, true)).status, 200);
  await waitFor(async () => (await latestRun())?.state === "submitted");
  assert.equal((await latestRun()).operation.state, "accepted");
  assert.deepEqual(writes.at(-1), { action: "like_qzone", params: { tid: freshPostId, target_uin: 2001 } });
  freshPostId = "skip-candidate";
  freshPostContent = "角色决定跳过";
  assert.equal((await configure("enabled", ["2001"], false, true)).status, 200);
  await waitFor(async () => (await latestRun())?.state === "model-skipped");
  assert.equal((await latestRun()).operation, null);
  assert.equal(writes.length, beforeAuto + 2);
  assert.equal((await configure("off", [], false)).status, 200);
});

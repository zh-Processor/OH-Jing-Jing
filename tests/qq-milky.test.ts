import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { encode } from "silk-wasm";
import { WebSocketServer, type WebSocket } from "ws";
import { createGroupService } from "../runtime/group-service";
import type { ChannelMessage, IncomingGroupMessage } from "../runtime/im-channel";
import { createQqIngressCollector, openQqIngress } from "../runtime/qq-ingress";
import { MilkyConnection } from "../runtime/qq-milky";
import { pcmWav } from "../runtime/qq-voice";

const accountId = "1001";
const contact = "2001";
const group = "5001";
const gatewayToken = "milky-fixture-gateway-token";
const intakeToken = "milky-fixture-independent-intake-token";

function address(server: { address(): unknown }) {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>) {
  for (let i = 0; i < 250; i++) {
    const item = await read();
    if (item !== undefined) return item;
    await delay(20);
  }
  assert.fail("QQ HTTP fixture failed to reach the expected state");
}

test("the opted-in QQ HTTP account extension verifies space ownership, policy and platform receipts", { timeout: 15_000 }, async t => {
  const events = new WebSocketServer({ noServer: true });
  const writes: { action: string; params: Record<string, unknown> }[] = [];
  const calls: string[] = [];
  const at = Math.floor(Date.now() / 1000);
  const declared = ["qzone", "qzone-posts", "qzone-comments", "qzone-comment", "qzone-reply", "qzone-like"];
  let contract = { version: 1, account_id: accountId, capabilities: declared };
  let activeAccount = Number(accountId);
  let postOwner = Number(accountId);
  let interactionOwner = Number(contact);
  let onDetail: (() => void) | undefined;
  let onWrite: (() => void) | undefined;
  const parent = { comment_id: "parent", uin: 3001, name: "评论者", time: at, content: "父评论",
    replies: [{ comment_id: "recipient", uin: 3002, name: "楼中楼", time: at, content: "原回复",
      parent_comment_id: "parent", parent_comment_uin: 3001 }] };
  const newComments: object[] = [];
  const channel = new MilkyConnection();
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + gatewayToken);
    assert.equal(req.method, "POST");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const params: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const action = req.url?.split("/").at(-1) ?? "";
    calls.push(action);
    let data: unknown;
    switch (action) {
      case "get_impl_info":
        data = { impl_name: "独立空间联调", impl_version: "1.0.0", milky_version: "1.3", ohjingjing_account: contract };
        break;
      case "get_login_info": data = { uin: activeAccount, nickname: "空间测试机器人" }; break;
      case "get_user_profile": data = { nickname: "空间测试机器人" }; break;
      case "get_qzone_msg_list":
        assert.deepEqual(params, { target_uin: Number(contact), format: "native" });
        data = { msglist: [{ tid: "post", user_id: Number(contact), content: "可见动态", time: at },
          { tid: "other", user_id: 9001, content: "别的账号" }] };
        break;
      case "get_qzone_msg_detail":
        onDetail?.();
        data = { tid: params.tid, uin: params.tid === "published" ? postOwner : interactionOwner,
          comments: [{ ...parent, replies: [...parent.replies] }, ...newComments] };
        break;
      case "send_qzone_msg":
        writes.push({ action, params });
        onWrite?.();
        data = { tid: "published" };
        break;
      case "comment_qzone": {
        writes.push({ action, params });
        onWrite?.();
        const id = params.comment_id ? "nested-new" : "comment-new";
        const row = { comment_id: id, uin: Number(accountId), time: at, name: "空间测试机器人", content: String(params.content) };
        if (params.comment_id) {
          const relation = { parent_comment_id: parent.comment_id, parent_comment_uin: parent.uin };
          parent.replies.push({ ...row, ...relation });
          data = { comment_id: id, ...relation };
        } else {
          newComments.push(row);
          data = { comment_id: id };
        }
        break;
      }
      case "like_qzone":
      case "unlike_qzone":
        writes.push({ action, params });
        data = {};
        break;
      default:
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok", retcode: 0, data }));
  });
  server.on("upgrade", (req, socket, head) => {
    assert.equal(req.url, "/event");
    assert.equal(req.headers.authorization, "Bearer " + gatewayToken);
    events.handleUpgrade(req, socket, head, ws => events.emit("connection", ws, req));
  });
  server.listen(0, "127.0.0.1");
  t.after(async () => {
    channel.stop();
    for (const socket of events.clients) socket.terminate();
    events.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await once(server, "listening");

  const settings = { enabled: true, hasToken: true, expectedBotId: accountId, groups: [group],
    roleId: "", modelId: "", address: address(server), qqAccountContract: "ohjingjing-v1" as const };
  channel.start(settings, gatewayToken, () => {});
  await until(() => channel.status === "online" ? true : undefined);
  contract = { ...contract, account_id: "9001" };
  assert.equal((await channel.checkCapabilities()).accountContract, "unavailable");
  assert.equal(await channel.listSpacePosts(accountId, contact), null);
  const publish = { kind: "qzone", visibility: "self", content: "测试动态" } as const;
  assert.deepEqual(await channel.updateSelfAccount(accountId, publish, () => true), { state: "unsupported" });
  assert.ok(!calls.some(action => action.includes("_qzone")));

  contract = { ...contract, account_id: accountId };
  assert.equal((await channel.checkCapabilities()).accountContract, "declared");
  assert.equal((await channel.selfAccountStatus()).capabilities["qzone-reply"], true);
  assert.deepEqual(await channel.listSpacePosts(accountId, contact), [{ id: "post", time: at, excerpt: "可见动态" }]);
  assert.equal(await channel.listSpacePosts("9001", contact), null);
  const threads = await channel.listSpaceComments(accountId, contact, "post", 0);
  assert.equal(threads?.threads[0]?.replies[0]?.id, "recipient");
  assert.deepEqual(await channel.updateSelfAccount(accountId, publish, () => true), { state: "verified", platformId: "published" });
  assert.deepEqual(writes[0], { action: "send_qzone_msg", params: { content: "测试动态", ugc_right: 64 } });
  postOwner = 9001;
  assert.deepEqual(await channel.updateSelfAccount(accountId, publish, () => true), { state: "accepted", platformId: "published" });

  const target = { targetId: contact, postId: "post" };
  const like = { ...target, kind: "qzone-like", like: true } as const;
  let allowed = true;
  onDetail = () => { allowed = false; };
  assert.deepEqual(await channel.updateSelfAccount(accountId, like, () => allowed), { state: "policy-changed" });
  assert.equal(writes.length, 2);
  onDetail = undefined;
  interactionOwner = 9001;
  assert.deepEqual(await channel.updateSelfAccount(accountId, like, () => true), { state: "failed" });
  assert.equal(writes.length, 2);
  interactionOwner = Number(contact);
  assert.deepEqual(await channel.updateSelfAccount(accountId, like, () => true), { state: "accepted" });
  assert.deepEqual(await channel.updateSelfAccount(accountId, { ...like, like: false }, () => true), { state: "accepted" });
  assert.deepEqual(await channel.updateSelfAccount(accountId, { ...target, kind: "qzone-comment", content: "评论回执" }, () => true),
    { state: "verified", platformId: "comment-new" });
  assert.deepEqual(await channel.updateSelfAccount(accountId, { ...target, kind: "qzone-reply", parentCommentId: "parent",
    replyToId: "recipient", commentOffset: 0, content: "楼内回执" }, () => true), { state: "verified", platformId: "nested-new" });
  assert.deepEqual(writes.at(-1)?.params, { tid: "post", target_uin: Number(contact), content: "楼内回执",
    comment_id: "parent", comment_uin: 3001, reply_uin: 3002, reply_name: "楼中楼" });
  allowed = true;
  onWrite = () => { allowed = false; };
  assert.deepEqual(await channel.updateSelfAccount(accountId, publish, () => allowed), { state: "unknown" });
  assert.equal(writes.length, 7);
  onWrite = undefined;
  onDetail = () => { activeAccount = 9001; };
  assert.deepEqual(await channel.updateSelfAccount(accountId, like, () => true), { state: "account-mismatch" });
  assert.equal(writes.length, 7);
  assert.equal(channel.connectionIssue?.kind, "account-mismatch");
});

test("the second QQ protocol verifies login, scopes message IDs and drives the independent collector", { timeout: 25_000 }, async t => {
  const events = new WebSocketServer({ noServer: true });
  const received: ChannelMessage[] = [];
  const writes: { api: string; params: any }[] = [];
  const pageReads: { scene: string; cursor?: number }[] = [];
  let recoveryAt: number | undefined;
  let onHistoryRead: (() => void) | undefined;
  const profile = { nickname: "原昵称", bio: "原签名", card: "原群名片" };
  let memberGroup = 5001;
  let onReadMember: (() => void) | undefined;
  let loggedIn = 1001;
  let sendSeq: number | undefined = 99;
  let returnSender = 2001;
  let mediaAddress = "https://multimedia.nt.qq.com.cn/fixture-expired";
  let renewedAddress = "https://multimedia.nt.qq.com.cn/fixture-current";
  let downloads = 0;
  let transcriptions = 0;
  const imageReads: string[] = [];
  const visionInputs: string[] = [];
  const imageResourceReads: string[] = [];
  let afterImageLookup: (() => void) | undefined;
  let imageAddress = "https://gchat.qpic.cn/fixture-image-current";
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX2QAAAAASUVORK5CYII=";
  const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const silk = (await encode(Buffer.alloc(6400), 16_000)).data;
  const fetchLocal = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "gchat.qpic.cn" && url.pathname.startsWith("/fixture-image-")) {
      assert.equal(init?.redirect, "error");
      assert.ok(!new Headers(init?.headers).has("authorization"));
      imageReads.push(url.pathname);
      if (url.pathname.endsWith("-expired")) return new Response(null, { status: 403 });
      const asset = url.pathname.endsWith("-second") ? gif : png;
      return new Response(Uint8Array.from(Buffer.from(asset, "base64")));
    }
    if (url.hostname !== "multimedia.nt.qq.com.cn") return fetchLocal(input, init);
    downloads++;
    assert.equal(init?.redirect, "error");
    assert.ok(!new Headers(init?.headers).has("authorization"));
    if (url.pathname.endsWith("-expired")) return new Response(null, { status: 403 });
    const bytes = url.pathname.endsWith("-truncated") ? silk.slice(0, -1) : silk;
    return new Response(new Uint8Array(bytes));
  });
  const at = Math.floor(Date.now() / 1000);
  const part = (type: string, data: object) => ({ type, data });
  const groupRow = (peerId = 5001) => ({ message_scene: "group", peer_id: peerId, sender_id: 2001, message_seq: 7, time: at,
    group_member: { card: "试演成员" }, segments: [part("mention", { user_id: 1001 }), part("reply", { message_seq: 2 }),
      part("text", { text: "试演" }), part("image", { temp_url: "https://gchat.qpic.cn/test-image.jpg" })] });
  const privateRow = (senderId = 2001) => ({ message_scene: "friend", peer_id: 2001, sender_id: senderId, message_seq: 7, time: at,
    segments: [part("reply", { message_seq: 3 }), part("text", { text: "私聊试演" })] });
  const recording = (seq: number, sender = 2001) => ({ ...groupRow(), sender_id: sender, message_seq: seq,
    segments: [part("mention", { user_id: 1001 }), part("record", { resource_id: "fixture-record", temp_url: mediaAddress, duration: 1 })] });
  const expiredImage = "https://gchat.qpic.cn/fixture-image-expired";
  const imageRow = (seq: number, text = "这张图有什么？") => ({ ...groupRow(), message_seq: seq,
    segments: [part("mention", { user_id: 1001 }), part("text", { text }),
      part("image", { resource_id: "fixture-image", temp_url: expiredImage })] });
  const privateImage = { ...privateRow(), message_seq: 132,
    segments: [part("text", { text: "私聊看图" }), part("image", { resource_id: "fixture-image" })] };
  const orderedImages = { ...imageRow(139), segments: [part("mention", { user_id: 1001 }), part("text", { text: "比较第一张和第二张图" }),
    part("image", { resource_id: "fixture-image" }), part("image", { temp_url: "https://gchat.qpic.cn/fixture-image-second" })] };
  const packet = (row: object, selfId = 1001) => JSON.stringify({ event_type: "message_receive", self_id: selfId, time: at, data: row });
  const server = createServer(async (request, response) => {
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(chunk);
    if (request.url === "/chat/completions") {
      const { messages } = JSON.parse(Buffer.concat(body).toString("utf8"));
      for (const part of messages.flatMap((message: { content: unknown }) => Array.isArray(message.content) ? message.content : [])) {
        if (part.type === "image_url") visionInputs.push(part.image_url.url);
      }
      response.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ choices: [{ message: { content: "这张图我看到了。" } }] }));
      return;
    }
    if (request.url === "/transcribe") {
      const bytes = Buffer.concat(body);
      const offset = bytes.indexOf("RIFF");
      assert.ok(offset > 0 && pcmWav(bytes.subarray(offset, offset + bytes.readUInt32LE(offset + 4) + 8)));
      transcriptions++;
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: "候选转写通过" }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${gatewayToken}`) { response.writeHead(401).end(); return; }
    const params = JSON.parse(Buffer.concat(body).toString("utf8"));
    const api = request.url?.split("/").at(-1) ?? "";
    let data: object = {};
    switch (api) {
      case "get_login_info": data = { uin: loggedIn, nickname: profile.nickname }; break;
      case "get_impl_info": data = { impl_name: "接口试演", impl_version: "1.0", milky_version: "1.3" }; break;
      case "get_history_messages":
        if (recoveryAt === undefined) {
          data = { messages: params.message_scene === "group" ? [groupRow(), groupRow(5002), privateRow()] : [privateRow(), privateRow(2002), groupRow()] };
          break;
        }
        assert.equal(params.limit, 30);
        pageReads.push({ scene: params.message_scene, cursor: params.start_message_seq });
        onHistoryRead?.();
        if (params.message_scene === "group") {
          assert.equal(params.peer_id, 5001);
          const next = params.start_message_seq;
          assert.ok(next === undefined || next === 35);
          const first = next === undefined ? 35 : 7;
          const messages = Array.from({ length: 29 }, (_, index) => ({ ...groupRow(), message_seq: first + index, time: recoveryAt }));
          const old = { ...groupRow(next === undefined ? 5002 : 5001), message_seq: first - 1, time: recoveryAt - 60 };
          data = { messages: [old, ...messages], next_message_seq: next === undefined ? 35 : 6 };
        } else {
          assert.equal(params.message_scene, "friend");
          assert.equal(params.peer_id, 2001);
          assert.ok(params.start_message_seq === undefined || params.start_message_seq === 50);
          const first = params.start_message_seq === undefined ? 50 : 49;
          data = { messages: [first, first + 1].map(message_seq => ({ ...privateRow(), message_seq, time: recoveryAt })), next_message_seq: 50 };
        }
        break;
      case "get_message": {
        if (params.message_scene === "friend") {
          assert.equal(params.peer_id, 2001);
          data = { message: privateImage };
          break;
        }
        assert.equal(params.message_scene, "group");
        assert.equal(params.peer_id, 5001);
        const seq = params.message_seq;
        if (seq === 136) data = { message: { ...groupRow(5001), message_seq: seq, sender_id: returnSender,
          segments: [part("forward", { forward_id: "milky-forward-fixture" })] } };
        else if (seq === 139) data = { message: orderedImages };
        else if (seq === 128 || seq === 129 || seq === 130 || seq === 135) {
          const row = imageRow(seq);
          if (seq === 129) row.segments.push(part("image", { resource_id: "unreadable-second-image" }));
          if (seq === 130) row.segments = [part("market_face", { url: expiredImage, emoji_id: "0123456789abcdef0123456789abcdef" })];
          data = { message: { ...row, sender_id: returnSender } };
          afterImageLookup?.();
        } else data = { message: recording(seq, returnSender) };
        break;
      }
      case "get_forwarded_messages":
        assert.ok(["milky-forward-fixture", "milky-inner"].includes(params.forward_id));
        data = params.forward_id === "milky-forward-fixture"
          ? { messages: [{ segments: [part("text", { text: "先讨论东门。" }), part("forward", { forward_id: "milky-inner" })] }] }
          : { messages: [{ sender_name: "原昵称", segments: [part("text", { text: "最后定在西门。" }),
            part("image", { temp_url: "https://gchat.qpic.cn/forwarded.png" }),
            part("record", { resource_id: "fixture-record", temp_url: "https://multimedia.nt.qq.com.cn/fixture-expired", duration: 1 })] }] };
        break;
      case "get_resource_temp_url":
        if (params.resource_id === "fixture-record") data = { url: renewedAddress };
        else {
          imageResourceReads.push(params.resource_id);
          data = { url: imageAddress };
        }
        break;
      case "get_user_profile": data = { nickname: profile.nickname, bio: profile.bio }; break;
      case "get_group_member_info":
        assert.deepEqual(params, { group_id: 5001, user_id: 1001, no_cache: true });
        onReadMember?.();
        data = { member: { group_id: memberGroup, user_id: 1001, card: profile.card } };
        break;
      case "send_group_message":
      case "send_private_message": data = { message_seq: sendSeq, time: at }; writes.push({ api, params }); break;
      case "set_nickname": profile.nickname = params.new_nickname; writes.push({ api, params }); break;
      case "set_bio": profile.bio = params.new_bio; writes.push({ api, params }); break;
      case "set_avatar": writes.push({ api, params }); break;
      case "set_group_member_card": profile.card = params.card; writes.push({ api, params }); break;
      default: response.writeHead(404).end(); return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok", retcode: 0, data }));
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/qq/event" || req.headers.authorization !== `Bearer ${gatewayToken}`) { socket.destroy(); return; }
    events.handleUpgrade(req, socket, head, peer => events.emit("connection", peer, req));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `${address(server)}/qq`;
  const channel = new MilkyConnection({ handshake: 500, reconnect: 150, monitor: 2000 });
  const collector = createQqIngressCollector({ database: ":memory:", gateway: endpoint, accountId, groups: [group], privateContacts: [contact],
    token: intakeToken, gatewayToken, pluginId: "qq.milky", recoverHistory: true });
  let service: ReturnType<typeof createGroupService> | undefined;
  t.after(async () => {
    channel.stop();
    await service?.stop();
    await collector.stop();
    for (const client of events.clients) client.terminate();
    await new Promise<void>(resolve => events.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  collector.server.listen(0, "127.0.0.1");
  await once(collector.server, "listening");
  const inbox = openQqIngress(address(collector.server), intakeToken, accountId, "qq.milky");
  const readInbox = () => inbox(null, AbortSignal.timeout(1000));
  await until(async () => (await readInbox()).online ? true : undefined);
  const legacy = openQqIngress(address(collector.server), intakeToken, accountId);
  await assert.rejects(() => legacy(null, AbortSignal.timeout(1000)), /无法核对/u);

  const connected = once(events, "connection");
  channel.start({ address: endpoint, enabled: true, groups: [group], roleId: "", modelId: "", hasToken: true, expectedBotId: accountId },
    gatewayToken, event => received.push(event));
  const [peer] = await connected as [WebSocket];
  await until(() => channel.status === "online" ? true : undefined);
  for (const client of events.clients) {
    client.send(packet(groupRow(), 9001));
    client.send(packet(groupRow()));
    client.send(packet(privateRow()));
    client.send(packet({ ...privateRow(), message_scene: "temp" }));
  }
  await until(() => received.length === 2 ? true : undefined);
  const buffered = await until(async () => {
    const reply = await readInbox();
    return reply.entries.length === 2 ? reply : undefined;
  });
  const [groupMessage, privateMessage] = received;
  assert.equal(groupMessage.kind, "group");
  assert.deepEqual([groupMessage.addressed, groupMessage.referenceId, groupMessage.name, groupMessage.hasImage],
    [true, "milky:group:5001:2", "试演成员", true]);
  assert.deepEqual(buffered.entries.map(row => row.message.messageId), ["milky:group:5001:7", "milky:friend:2001:7"]);
  assert.equal(privateMessage.referenceId, "milky:friend:2001:3");
  assert.equal(buffered.entries[1].message.referenceId, "milky:friend:2001:3");
  assert.deepEqual((await channel.readRecentGroup(group, accountId))?.map(row => row.message.messageId), [groupMessage.messageId]);
  assert.deepEqual((await channel.readRecentPrivate(contact, accountId))?.map(row => row.message.messageId), [privateMessage.messageId]);
  assert.equal(await channel.readRecentPrivate(contact, "4001"), null);
  const sourceEvent: IncomingGroupMessage = { ...groupMessage, messageId: "milky:group:5001:44", hasVoice: true, voiceOnly: true };
  const audio = await channel.readVoice(sourceEvent, () => true);
  assert.ok(audio && pcmWav(audio));
  assert.equal(audio.readUInt32LE(24), 16_000);
  assert.equal(downloads, 2);
  returnSender = 2009;
  assert.equal(await channel.readVoice(sourceEvent, () => true), null);
  assert.equal(await channel.readVoice({ ...sourceEvent, groupId: "5002" }, () => true), null);
  assert.equal(await channel.readVoice(sourceEvent, () => false), null);
  assert.equal(downloads, 2);
  returnSender = 2001;
  mediaAddress = "http://127.0.0.1:1/blocked";
  renewedAddress = "https://multimedia.nt.qq.com.cn/fixture-truncated";
  assert.equal(await channel.readVoice(sourceEvent, () => true), null);
  assert.equal(downloads, 3);
  mediaAddress = "https://multimedia.nt.qq.com.cn/fixture-current";
  const imageSource = { ...groupMessage, images: [expiredImage], messageId: "milky:group:5001:128" };
  assert.deepEqual(await channel.refreshImageUrls(imageSource, () => true), [imageAddress]);
  assert.equal(imageResourceReads.length, 1);
  assert.deepEqual(await channel.refreshImageUrls({ ...imageSource, actorId: "2009" }, () => true), []);
  assert.deepEqual(await channel.refreshImageUrls({ ...imageSource, groupId: "5002" }, () => true), []);
  assert.deepEqual(await channel.refreshImageUrls({ ...imageSource, accountId: "9001" }, () => true), []);
  assert.deepEqual(await channel.refreshImageUrls({ ...imageSource, messageId: "milky:group:5001:129" }, () => true, true), []);
  let imageAllowed = true;
  afterImageLookup = () => { imageAllowed = false; };
  assert.deepEqual(await channel.refreshImageUrls(imageSource, () => imageAllowed), []);
  afterImageLookup = undefined;
  assert.equal(imageResourceReads.length, 1);
  imageAddress = "https://outside.invalid/fixture-image-current";
  assert.deepEqual(await channel.refreshImageUrls(imageSource, () => true), [expiredImage]);
  imageAddress = "https://gchat.qpic.cn/fixture-image-current";
  assert.deepEqual(await channel.refreshImageUrls({ ...imageSource, messageId: "milky:group:5001:130" }, () => true),
    ["https://gxh.vip.qq.com/club/item/parcel/item/01/0123456789abcdef0123456789abcdef/raw300.gif"]);
  const forwardSource = { ...groupMessage, messageId: "milky:group:5001:136" };
  const forwardMedia = [
    { kind: "text", text: "先讨论东门。" }, { kind: "text", text: "最后定在西门。" },
    { kind: "image", url: "https://gchat.qpic.cn/forwarded.png" },
  ];
  const beforeForwardDownloads = downloads;
  assert.deepEqual(await channel.readForward(forwardSource, () => true), [
    ...forwardMedia, { kind: "text", text: "【转发语音未转写】" },
  ]);
  assert.deepEqual(await channel.readForward({ ...forwardSource, actorId: "2009" }, () => true, true), []);
  assert.deepEqual(await channel.readForward(forwardSource, () => false, true), []);
  assert.equal(downloads, beforeForwardDownloads);
  renewedAddress = "https://multimedia.nt.qq.com.cn/fixture-current";
  assert.deepEqual(await channel.readForward(forwardSource, () => true, true), [...forwardMedia, { kind: "voice", audio }]);
  assert.equal(downloads, beforeForwardDownloads + 2);
  assert.equal((await channel.deliverGroup(group, "测试群回执")).messageId, "milky:group:5001:99");
  assert.equal((await channel.deliverPrivate(contact, "测试私聊回执")).messageId, "milky:friend:2001:99");
  assert.equal((await channel.deliverGroupExpression(group, "表情试演", { kind: "qq-face", id: 14 })).messageId, "milky:group:5001:99");
  assert.deepEqual(writes.at(-1)?.params.message[1], { type: "face", data: { face_id: "14" } });
  assert.deepEqual(await channel.deliverVoice(groupMessage, Buffer.from("fixture-wav"), () => true),
    { status: "sent", messageId: "milky:group:5001:99", format: "voice" });
  assert.equal(writes.at(-1)?.params.message[0].data.uri, "base64://Zml4dHVyZS13YXY=");
  sendSeq = undefined;
  assert.deepEqual(await channel.deliverGroup(group, "回执缺失"), { status: "unknown" });

  assert.equal((await channel.checkCapabilities()).spaceCapabilityCheck, "unavailable");
  assert.equal((await channel.selfAccountStatus()).capabilities.qzone, false);
  assert.deepEqual(await channel.updateSelfAccount(accountId, { kind: "qzone", content: "不支持的动态", visibility: "self" }, () => true),
    { state: "unsupported" });
  assert.deepEqual(await channel.updateSelfAccount(accountId, { kind: "nickname", nickname: "新昵称" }, () => true),
    { state: "verified", nickname: "新昵称" });
  assert.deepEqual(await channel.updateSelfAccount(accountId, { kind: "signature", signature: "新签名" }, () => true),
    { state: "verified", observedSignature: "新签名" });
  assert.deepEqual(await channel.updateSelfAccount(accountId, { kind: "avatar", avatar: "data:image/png;base64,Zml4dHVyZQ==" }, () => true),
    { state: "accepted" });
  assert.equal(writes.at(-1)?.params.uri, "base64://Zml4dHVyZQ==");
  assert.deepEqual(await channel.updateSelfAccount(accountId, { kind: "group-card", groupId: group, card: "新群名片" }, () => true),
    { state: "verified", observedCard: "新群名片" });
  assert.equal(writes.at(-1)?.params.user_id, 1001);
  const beforeMismatch = writes.length;
  memberGroup = 5002;
  assert.deepEqual(await channel.updateSelfAccount(accountId, { kind: "group-card", groupId: group, card: "不得写入错群" }, () => true),
    { state: "failed" });
  memberGroup = 5001;
  let cardAllowed = true;
  onReadMember = () => { cardAllowed = false; };
  assert.deepEqual(await channel.updateSelfAccount(accountId, { kind: "group-card", groupId: group, card: "不得在撤权后写入" }, () => cardAllowed),
    { state: "policy-changed" });
  onReadMember = undefined;
  assert.equal(writes.length, beforeMismatch);
  let permissionChecks = 0;
  assert.deepEqual(await channel.deliverGroup(group, "等待登录核验时撤权", () => ++permissionChecks === 1), { status: "failed" });
  assert.equal(permissionChecks, 2);
  loggedIn = 9001;
  assert.deepEqual(await channel.deliverGroup(group, "不得投递"), { status: "failed" });
  assert.equal(channel.connectionIssue?.kind, "account-mismatch");
  assert.equal(writes.length, beforeMismatch);
  loggedIn = 1001;
  await until(() => channel.status === "online" && peer.readyState === 3 ? true : undefined);
  assert.equal((await channel.checkLogin()).account?.id, accountId);

  recoveryAt = Math.floor(Date.now() / 1000);
  let historyAllowed = true;
  onHistoryRead = () => { historyAllowed = false; };
  assert.equal(await channel.readRecentPrivate(contact, accountId, { since: recoveryAt * 1000, stillAllowed: () => historyAllowed }), null);
  assert.deepEqual(pageReads.splice(0), [{ scene: "friend", cursor: undefined }]);
  onHistoryRead = undefined;
  assert.deepEqual((await channel.readRecentPrivate(contact, accountId, { since: recoveryAt * 1000 }))?.map(row => row.message.messageId),
    ["milky:friend:2001:49", "milky:friend:2001:50", "milky:friend:2001:51"]);
  assert.deepEqual(pageReads.splice(0), [{ scene: "friend", cursor: undefined }, { scene: "friend", cursor: 50 }]);
  assert.deepEqual((await channel.readRecentPrivate(contact, accountId, { since: recoveryAt * 1000, before: 50 }))?.map(row => row.message.messageId),
    ["milky:friend:2001:49", "milky:friend:2001:50"]);
  assert.deepEqual(pageReads.splice(0), [{ scene: "friend", cursor: 50 }]);
  for (const client of events.clients) client.terminate();
  const recoveredTail = await until(async () => {
    const page = await readInbox();
    return page.lastSequence >= 61 ? page : undefined;
  });
  const recovered = [];
  let sequence = 2;
  while (sequence < recoveredTail.lastSequence) {
    const page = await inbox({ feed: recoveredTail.feed, sequence }, AbortSignal.timeout(1000));
    assert.ok(page.entries.length && !page.missed);
    recovered.push(...page.entries);
    sequence = page.entries.at(-1)!.sequence;
  }
  assert.deepEqual(pageReads, [{ scene: "group", cursor: undefined }, { scene: "group", cursor: 35 },
    { scene: "friend", cursor: undefined }, { scene: "friend", cursor: 50 }]);
  assert.ok(recovered.every(row => row.recoveredAt === recoveryAt! * 1000));
  assert.deepEqual(recovered.map(row => row.message.messageId), [
    ...Array.from({ length: 56 }, (_, index) => `milky:group:5001:${index + 8}`),
    "milky:friend:2001:49", "milky:friend:2001:50", "milky:friend:2001:51",
  ]);
  recoveryAt = undefined;

  const adminToken = "milky-candidate-service-admin-token";
  service = createGroupService({ database: ":memory:", adminToken, qqIngress: address(collector.server),
    qqIngressToken: intakeToken, channelToken: gatewayToken, observeGroups: [group],
    model: { id: "vision", name: "Fixture vision", baseUrl: address(server), model: "vision", vision: true, billing: "none", hasKey: true,
      inputPrice: 0, outputPrice: 0, currency: "CNY", billingAccount: "" }, modelKey: "fixture-vision-key",
    qqVoice: { endpoint: `${address(server)}/transcribe`, model: "fixture-recognizer", hasKey: false, groups: [group], privateContacts: [] },
    channel: { pluginId: "qq.milky", enabled: true, hasToken: true, expectedBotId: accountId, address: endpoint, groups: [group],
      roleId: "", modelId: "" } });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const base = address(service.server);
  const api = async (path: string) => (await fetch(base + path, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
  service.startChannel();
  await until(async () => {
    const state = await api("/admin/qq-ingress");
    return state.ready && state.pending === 0 ? true : undefined;
  });
  const traces = await api(`/admin/group-reply-traces?scope=${encodeURIComponent(`qq:${accountId}:${group}`)}`);
  assert.ok(traces.items.every((entry: { eventId: string }) => entry.eventId === "milky:group:5001:7"));
  assert.ok(writes.length <= beforeMismatch + 1);
  const previousWrites = writes.length;
  sendSeq = 121;
  const event = { ...groupRow(), message_seq: 120, segments: [part("mention", { user_id: 1001 })] };
  for (const client of events.clients) client.send(packet(event));
  const filter = new URLSearchParams({ scope: `qq:${accountId}:${group}`, eventId: "milky:group:5001:120" });
  const item = await until(async () => {
    const result = await api(`/admin/group-reply-traces?${filter}`);
    return result.items?.find((entry: { state: string }) => entry.state === "finished") as
      { receipts: { platformMessageId: string }[] } | undefined;
  });
  assert.deepEqual(item.receipts.map(receipt => receipt.platformMessageId), ["milky:group:5001:121"]);
  assert.equal(writes.length, previousWrites + 1);
  sendSeq = 125;
  for (const client of events.clients) client.send(packet(recording(124)));
  await until(() => transcriptions === 1 && writes.length === previousWrites + 2 ? true : undefined);

  sendSeq = 131;
  for (const client of events.clients) client.send(packet(imageRow(128)));
  await until(() => visionInputs.length === 1 && writes.length === previousWrites + 3 ? true : undefined);
  assert.deepEqual(imageReads, ["/fixture-image-expired", "/fixture-image-current"]);
  assert.equal(writes.at(-1)?.params.group_id, 5001);
  assert.equal(visionInputs[0], `data:image/png;base64,${png}`);

  const allow = await fetch(`${base}/admin/private-contacts`, { method: "PUT", headers: {
    Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ userId: contact, accountId }) });
  assert.equal(allow.status, 200);
  sendSeq = 134;
  for (const client of events.clients) client.send(packet(privateImage));
  await until(() => visionInputs.length === 2 && writes.length === previousWrites + 4 ? true : undefined);
  assert.equal(writes.at(-1)?.params.user_id, 2001);
  assert.equal(visionInputs[1], `data:image/png;base64,${png}`);

  sendSeq = 136;
  for (const client of events.clients) client.send(packet(imageRow(135, "/收藏表情 恢复链接")));
  await until(() => writes.length === previousWrites + 5 ? true : undefined);
  assert.match(writes.at(-1)?.params.message.at(-1).data.text ?? "", /已收藏到本群「恢复链接」/u);
  sendSeq = 140;
  for (const client of events.clients) client.send(packet(orderedImages));
  await until(() => visionInputs.length === 4 && writes.length === previousWrites + 6 ? true : undefined);
  assert.deepEqual(visionInputs.slice(2), [`data:image/png;base64,${png}`, `data:image/gif;base64,${gif}`]);
  assert.ok(imageResourceReads.every(resource => resource === "fixture-image"));
  const last = await readInbox();
  const cursor = { feed: last.feed, sequence: last.lastSequence };
  const packetRecall = (self: number, scene = "group", peer = 5001) => JSON.stringify({
    event_type: "message_recall", self_id: self, time: at,
    data: { message_scene: scene, peer_id: peer, message_seq: 139, sender_id: 2001, operator_id: 2001 },
  });
  for (const client of events.clients) {
    client.send(packetRecall(9001));
    client.send(packetRecall(1001, "friend"));
    client.send(packetRecall(1001, "group", 5002));
    client.send(packetRecall(1001));
  }
  const readRecalls = openQqIngress(address(collector.server), intakeToken, accountId, "qq.milky", true);
  const notices = await until(async () => {
    const page = await readRecalls(cursor, AbortSignal.timeout(1000));
    return page.entries.length ? page.entries : undefined;
  });
  assert.deepEqual(notices.map(entry => entry.message), [{
    kind: "group-recall", accountId, groupId: group, actorId: contact, messageId: "milky:group:5001:139",
  }]);
  assert.deepEqual((await inbox(cursor, AbortSignal.timeout(1000))).entries, []);
});

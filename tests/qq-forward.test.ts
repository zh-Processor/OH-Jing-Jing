import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createGroupService } from "../runtime/group-service.js";
import { readQqForwardContent } from "../runtime/qq-forward.js";

test("QQ replies use the current authorized forward without exposing its participant details", async t => {
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const connected = once(gateway, "connection");
  const admin = "qq-forward-admin-fixture";
  const provider = "https://model.example.org";
  const originalImage = "https://gchat.qpic.cn/forwarded-fixture.png";
  const attachedImage = "https://gchat.qpic.cn/attached-fixture.png";
  const expiredImage = "https://gchat.qpic.cn/forwarded-expired.png";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64");
  const forwardedPng = Buffer.concat([png, Buffer.from([1])]);
  const wavHeader = Buffer.from("52494646a40c000057415645666d74201000000001000100803e0000007d00000200100064617461800c0000", "hex");
  const wav = Buffer.concat([wavHeader, Buffer.alloc(3200)]);
  const groups = ["5001", "5002"];
  const sent: { action: string; text: string }[] = [];
  const originals: string[] = [];
  const reads: string[] = [];
  const prompts: object[] = [];
  const imageRequests: string[] = [];
  const promptImages: string[][] = [];
  const voiceReads: string[] = [];
  const transcriptions: Buffer[] = [];
  let revokeDuringTranscription = false;
  let transcriptionAborted = false;
  const request = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: URL | string, init?: RequestInit) => {
    if (String(url) === attachedImage || String(url) === originalImage) {
      imageRequests.push(String(url));
      return new Response(String(url) === attachedImage ? png : forwardedPng);
    }
    if (String(url) === expiredImage) return new Response(null, { status: 410 });
    assert.doesNotMatch(String(url), /outside\.invalid/u);
    if (!String(url).startsWith(provider)) return request(url, init);
    if (String(url) === provider + "/audio/transcriptions") {
      const file = (init?.body as FormData).get("file") as File;
      transcriptions.push(Buffer.from(await file.arrayBuffer()));
      if (revokeDuringTranscription) {
        await once(init!.signal!, "abort");
        transcriptionAborted = true;
      }
      return Response.json({ text: "从西门走。联系号码 12345678。" });
    }
    const messages = JSON.parse(String(init?.body)).messages;
    const body = messages.at(-1).content;
    prompts.push(JSON.parse(Array.isArray(body) ? body[0].text : body));
    promptImages.push(Array.isArray(body) ? body.slice(1).map(part => part.image_url.url) : []);
    return Response.json({ choices: [{ message: { content: "我把转发里能确认的安排整理好了。" } }] });
  });
  const service = createGroupService({ database: ":memory:", adminToken: admin, observeGroups: groups,
    qqVoice: { endpoint: provider + "/audio/transcriptions", model: "fixture-asr", hasKey: false,
      groups: ["5001"], privateContacts: ["2001"], language: "zh" },
    model: { id: "fixture", name: "Fixture", model: "fixture", baseUrl: provider, billing: "none", hasKey: false, vision: true,
      inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "" },
    channel: { enabled: true, address: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`, groups,
      roleId: "", modelId: "", hasToken: false, expectedBotId: "1001" } });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  t.after(async () => {
    await service.stop();
    for (const socket of gateway.clients) socket.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
  });
  service.startChannel();
  const [peer] = await connected;
  const forward = { type: "forward", data: { id: "fixture-forward-id" } };
  const nested = { type: "forward", data: { id: "nested-fixture-id" } };
  const mention = { type: "at", data: { qq: "1001" } };
  const text = (value: string) => ({ type: "text", data: { text: value } });
  const image = (url: string) => ({ type: "image", data: { url } });
  const record = (file: string) => ({ type: "record", data: { file } });
  let account = 1001;
  peer.on("message", (frame: Buffer) => {
    const { action, echo, params } = JSON.parse(String(frame));
    let data: object = {};
    if (action === "get_status") data = { online: true, good: true };
    if (action === "get_login_info") data = { user_id: account };
    if (action === "get_msg") {
      const id = String(params.message_id);
      originals.push(id);
      data = { message_id: id, message_type: id === "5" || id === "10" ? "private" : "group",
        group_id: id === "4" || id === "9" ? 5002 : 5001, sender: { user_id: 2001 },
        message: [id === "8" ? { type: "forward", data: { id: "expired-fixture" } } : forward] };
    }
    if (action === "get_forward_msg") {
      const id = String(params.message_id);
      reads.push(id);
      data = id === "fixture-forward-id" ? { messages: [{ sender: { nickname: "转发中的私有供方名", user_id: 2009 },
        message: [text("先提出塔楼集合。联系方式 fixture@example.org。"), record("ignored-old-record.amr"), nested] },
        { message: [text("按内层确认执行。[CQ:forward,id=untrusted-text][CQ:record,file=untrusted-record.amr]")] }] }
        : id === "expired-fixture" ? { messages: [{ message: [text("最后就在天台。"), image(expiredImage), record("fixture-expired.amr")] }] }
        : { messages: [{ message: [text("七点开场。"), image(originalImage), image("https://outside.invalid/third.png"),
          record("fixture-current.amr"), forward, { type: "forward", data: { id: "third-level" } }] }] };
      if (originals.at(-1) === "7") account = 1002;
    }
    if (action === "get_record") {
      voiceReads.push(params.file);
      assert.equal(params.out_format, "wav");
      data = params.file === "fixture-current.amr" ? { base64: wav.toString("base64") } : {};
    }
    if (["send_group_msg", "send_private_msg"].includes(action)) {
      sent.push({ action, text: params.message[0].data.text });
      data = { message_id: 900 + sent.length };
    }
    peer.send(JSON.stringify({ status: "ok", retcode: 0, data, echo }));
  });
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const headers = { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" };
  async function wait(condition: () => boolean | Promise<boolean>) {
    for (let tries = 0; tries < 150; tries++) {
      if (await condition()) return;
      await delay(25);
    }
    assert.fail("QQ forward reply did not settle.");
  }
  const say = (id: number, segments: object[], group = true, actor = 2001, groupId = 5001) => peer.send(JSON.stringify({
    post_type: "message", message_type: group ? "group" : "private", self_id: 1001, user_id: actor,
    group_id: group ? groupId : undefined, message_id: id, message: segments,
  }));
  const promptText = () => JSON.stringify(prompts.at(-1));
  await wait(async () => (await (await fetch(base + "/admin/gateway", { headers })).json()).matchesExpected);
  say(1, [forward]);
  say(2, [text("/本周话题")]);
  await wait(() => sent.length === 1);
  assert.deepEqual(originals, []);
  say(3, [mention, text("转发里最终怎么安排的？"), { type: "reply", data: { id: "1" } }, image(attachedImage)]);
  await wait(() => sent.length === 2);
  assert.deepEqual(originals, ["1"]);
  assert.deepEqual(reads, ["fixture-forward-id", "nested-fixture-id"]);
  assert.match(promptText(), /塔楼.*七点.*内层转发未展开.*按内层确认执行/u);
  assert.doesNotMatch(promptText(), /fixture@example|私有供方名|nested-fixture-id|third-level|untrusted-text/u);
  assert.deepEqual(imageRequests, [attachedImage, originalImage]);
  assert.deepEqual(promptImages.at(-1), [png, forwardedPng].map(bytes => `data:image/png;base64,${bytes.toString("base64")}`));
  assert.match(promptText(), /转发图片对应本轮第 2 张图.*转发图片未读取/u);
  assert.match(promptText(), /七点开场.*【转发语音转写】.*从西门走.*\[数字标识\]/u);
  assert.doesNotMatch(promptText(), /12345678|fixture-current|ignored-old-record|untrusted-record/u);
  say(4, [mention, text("这条怎么看？"), forward]);
  await wait(() => sent.length === 3);
  assert.deepEqual(originals, ["1", "4"]);
  assert.equal(reads.length, 2);
  assert.doesNotMatch(promptText(), /定在塔楼/u);
  assert.equal((await fetch(base + "/admin/private-contacts", { method: "PUT", headers,
    body: JSON.stringify({ userId: "2001" }) })).status, 200);
  say(5, [text("帮我总结这份转发。"), forward], false);
  await wait(() => sent.length === 4);
  assert.equal(sent.at(-1)?.action, "send_private_msg");
  assert.deepEqual(originals, ["1", "4", "5"]);
  assert.deepEqual(reads, ["fixture-forward-id", "nested-fixture-id", "fixture-forward-id", "nested-fixture-id"]);
  assert.match(promptText(), /塔楼.*七点/u);
  assert.equal(promptImages.at(-1)?.length, 1);
  assert.match(promptText(), /转发图片对应本轮第 1 张图/u);
  assert.match(promptText(), /【转发语音转写】.*从西门走/u);
  say(6, [mention, text("帮我读一下那条卡片。"), { type: "reply", data: { id: "1" } }], true, 2002);
  await wait(() => sent.length === 5);
  assert.deepEqual(originals, ["1", "4", "5"]);
  assert.doesNotMatch(promptText(), /塔楼|七点/u);
  say(7, [mention, text("读一下这条转发。"), forward]);
  await wait(() => sent.length === 6);
  assert.deepEqual(originals, ["1", "4", "5", "7"]);
  assert.deepEqual(reads.slice(-3), ["fixture-forward-id", "nested-fixture-id", "fixture-forward-id"]);
  assert.doesNotMatch(promptText(), /塔楼|七点/u);
  account = 1001;
  say(8, [mention, text("读图和文字。"), forward]);
  await wait(() => sent.length === 7);
  assert.deepEqual(promptImages.at(-1), []);
  assert.match(promptText(), /最后就在天台.*转发图片未读取/u);
  assert.match(promptText(), /转发语音未转写/u);
  say(9, [mention, text("概括转发的安排。"), forward], true, 2001, 5002);
  await wait(() => sent.length === 8);
  assert.match(promptText(), /七点开场.*转发语音未转写/u);
  assert.doesNotMatch(promptText(), /从西门走/u);
  assert.deepEqual(voiceReads, ["fixture-current.amr", "fixture-current.amr", "fixture-expired.amr"]);
  assert.deepEqual(transcriptions, [wav, wav]);
  revokeDuringTranscription = true;
  const deliveredPrompts = prompts.length;
  say(10, [text("这段录音说了什么？"), forward], false);
  await wait(() => transcriptions.length === 3);
  assert.equal((await fetch(base + "/admin/private-contacts", { method: "DELETE", headers,
    body: JSON.stringify({ userId: "2001" }) })).status, 200);
  await wait(() => transcriptionAborted);
  assert.equal(prompts.length, deliveredPrompts);
  assert.equal(sent.length, 8);
});

test("nested forwards use a bounded number of recent cards and discard results after revocation", async () => {
  const card = (id: string) => ({ type: "forward", data: { id } });
  const row = (text: string) => ({ message: [{ type: "text", data: { text } }] });
  const read: string[] = [];
  const root = { id: "outer", content: [
    { message: [card("old")] }, { message: [card("earlier")] }, { message: [card("later")] },
    { message: [card("earlier"), card("outer")] }, row("执行上面的决定。"),
  ] };
  const excerpt = await readQqForwardContent(root, "message", async id => {
    read.push(id);
    return [row(id === "earlier" ? "先确认集合地点。" : "后来确认具体时间。")];
  }, () => true);
  assert.deepEqual(read, ["earlier", "later"]);
  assert.deepEqual(excerpt, ["【内层转发未展开】", "后来确认具体时间。", "先确认集合地点。", "【内层转发未展开】", "执行上面的决定。"]
    .map(text => ({ kind: "text", text })));

  let authorized = true;
  const revoked = await readQqForwardContent({ content: [{ message: [card("earlier"), card("later")] }] }, "message",
    async () => { authorized = false; return [row("撤权后取得的正文。")]; }, () => authorized);
  assert.deepEqual(revoked, []);
});

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
import { WebSocketServer } from "ws";
import { createGroupService } from "../runtime/group-service";
import { createQqIngressCollector } from "../runtime/qq-ingress";
import { qqVoicePlaceholder, qqVoiceUnavailable, readSpeechConfig, readSpeechRequest, readVoiceWav,
  roleSpeechVoice, synthesizeSpeech, type QqSpeechConfig } from "../runtime/qq-voice";
import { defaultRole } from "../runtime/roles";

function wavFixture(dataLength = 3200) {
  const bytesPerSecond = 32000;
  const file = Buffer.alloc(44 + dataLength);
  file.write("RIFF", 0);
  file.writeUInt32LE(file.length - 8, 4);
  file.write("WAVEfmt ", 8);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(16000, 24);
  file.writeUInt32LE(bytesPerSecond, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write("data", 36);
  file.writeUInt32LE(dataLength, 40);
  return file;
}

test("a role uses its configured speech presets without sending performance instructions", async t => {
  const audio = wavFixture();
  const bodies: unknown[] = [];
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const fields = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    bodies.push(fields);
    if (fields.input === "等待超时。") return;
    response.writeHead(200, { "Content-Type": "audio/wav" }).end(audio);
  });
  provider.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>(resolve => provider.close(() => resolve())));
  await once(provider, "listening");
  const options: QqSpeechConfig = { endpoint: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/speech`,
    model: "fixture-preset", hasKey: false, voice: "generic", groups: [], privateContacts: [] };
  const config = readSpeechConfig({ ...options, roleVoices: { dafeiyu: { voice: "fish-neutral",
    styles: { playful: "fish-playful", warm: "fish-warm" } } } })!;
  const signal = new AbortController().signal;
  for (const [style, voice] of [["playful", "fish-playful"], ["warm", "fish-warm"], ["serious", "fish-neutral"]] as const) {
    assert.deepEqual(await synthesizeSpeech(config, "今晚月色不错。", defaultRole, signal, style), audio);
    assert.deepEqual(bodies.at(-1), { model: "fixture-preset", voice, input: "今晚月色不错。", response_format: "wav" });
  }
  assert.equal(roleSpeechVoice(readSpeechConfig(options), defaultRole), undefined);
  assert.equal(roleSpeechVoice(readSpeechConfig({ ...options, roleVoices: { dafeiyu: "fish-neutral" } }), defaultRole), undefined);
  assert.throws(() => readSpeechConfig({ ...options, roleVoices: { dafeiyu: { voice: "fish-neutral", styles: {} } } }), /语气预设/u);
  assert.throws(() => readSpeechConfig({ ...options, timeoutMs: 25_001 }), /超时/u);
  assert.throws(() => readSpeechConfig({ ...options, maxCharacters: 0 }), /字数/u);
  const shorter = readSpeechConfig({ ...options, style: "instructions", roleVoices: { dafeiyu: "fish-neutral" }, timeoutMs: 1000 })!;
  await assert.rejects(synthesizeSpeech(shorter, "等待超时。", defaultRole, signal), { name: "TimeoutError" });
});

test("only an authorized directed QQ turn reads its own voice and returns one private or group reply", { timeout: 25_000 }, async t => {
  // This fixture's Base64 frame exceeds the former one-megabyte transport limit.
  const pcm = wavFixture(960_000);
  const spoken = wavFixture();
  assert.deepEqual(readVoiceWav(pcm.toString("base64")), pcm);
  assert.equal(readVoiceWav(Buffer.from("not wave").toString("base64")), null);
  const transcript = "请写一句关于春天的问候";
  const replyText = "春风一吹，好消息也来啦。";
  const fullStory = "小鱼捡到一粒星星，带回海里种下。第二天，全部礁石都亮了起来。它就把这片星光送给了迷路的船。";
  const observed = { voiceRequests: 0, modelRequests: 0 };
  const spokenRequests: { voice: string; input: string }[] = [];
  const spokenDirections: string[] = [];
  let speechProviderAborted = false;
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (request.url === "/audio/transcriptions") {
      assert.equal(request.headers.authorization, "Bearer voice-fixture");
      assert.match(String(request.headers["content-type"]), /multipart\/form-data/u);
      assert.match(body.toString("utf8"), /filename="message.wav"[\s\S]+name="model"\r\n\r\nfixture-voice/u);
      assert.ok(body.includes(pcm));
      observed.voiceRequests += 1;
      response.end(JSON.stringify({ text: transcript }));
    } else if (request.url === "/audio/speech" || request.url === "/audio/private-speech") {
      const privateEndpoint = request.url === "/audio/private-speech";
      assert.equal(request.headers.authorization, privateEndpoint ? "Bearer private-speech-fixture" : "Bearer speech-fixture");
      const fields = JSON.parse(body.toString());
      assert.equal(fields.model, "fixture-speech");
      assert.equal(fields.response_format, "wav");
      assert.equal(fields.voice, privateEndpoint ? "fish-private-voice" : "fish-voice");
      spokenRequests.push({ voice: fields.voice, input: fields.input });
      assert.match(fields.instructions, /少女感/u);
      spokenDirections.push(fields.instructions);
      if (fields.input.includes("撤销时等待")) {
        response.once("close", () => { if (!response.writableEnded) speechProviderAborted = true; });
        return;
      }
      if (fields.input.includes("合成故障")) {
        response.writeHead(503).end();
        return;
      }
      response.setHeader("Content-Type", "audio/wav");
      response.end(spoken);
    } else {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer text-fixture");
      const raw = String(JSON.parse(body.toString()).messages.at(-1)?.content ?? "");
      const groupReply = raw.startsWith("{");
      const invalidPage = raw.includes("请提供一个公开的 HTTPS 网页地址。");
      const prompt = invalidPage ? "/读网页" : groupReply ? String(JSON.parse(raw).current) : raw;
      assert.match(prompt, /请写一句关于春天的问候|合成故障|撤销时等待|简短的晚安|完整的长故事|冷笑话|\/读网页/u);
      const content = invalidPage ? "需要一个公开的网页地址。"
        : prompt.includes("完整的长故事") ? JSON.stringify({ action: "reply", text: fullStory, delivery: "voice", style: "warm" })
        : prompt.includes("合成故障") ? "合成故障仍可发文字。"
        : prompt.includes("撤销时等待") ? "撤销时等待完成。"
        : prompt.includes("简短的晚安") ? groupReply ? JSON.stringify({ action: "reply", parts: ["晚安。", "做个好梦。"], delivery: "text" })
          : JSON.stringify({ action: "reply", text: "晚安，做个好梦。", delivery: prompt.startsWith("写个") ? "text" : "voice", style: "warm" })
        : prompt.includes("冷笑话") ? JSON.stringify({ action: "reply", parts: [replyText],
          delivery: prompt.includes("引用") ? "text" : "voice", style: "playful" })
        : replyText;
      observed.modelRequests += 1;
      response.end(JSON.stringify({ choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    }
  });
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  provider.listen(0, "127.0.0.1");
  await Promise.all([once(gateway, "listening"), once(provider, "listening")]);
  const root = await realpath(tmpdir());
  const scratch = await mkdtemp(join(root, "ohjingjing-voice-"));
  const database = join(scratch, "service.db");
  const intakeDatabase = join(scratch, "intake.db");
  const token = "fixture-authorized-voice-collector";
  const admin = "fixture-transcription-admin";
  const listen = (server: { address(): unknown }) => (server.address() as AddressInfo).port;
  const gatewayUrl = `ws://127.0.0.1:${listen(gateway)}`;
  const providerUrl = `http://127.0.0.1:${listen(provider)}`;
  const originals = new Map<string, object>();
  const metadataReads: string[] = [];
  const fileReads: string[] = [];
  const deliveries: { action: string; recipient: number; text: string }[] = [];
  const voiceAttempts: { recipient: number; success: boolean }[] = [];
  let voiceOutcome: "success" | "reject" | "ambiguous" = "success";
  gateway.on("connection", peer => peer.on("message", raw => {
    const { action, echo, params } = JSON.parse(String(raw));
    let data: object = {};
    if (action === "get_login_info") data = { user_id: 1001, nickname: "联调机器人" };
    if (action === "get_status") data = { online: true, good: true };
    if (action === "can_send_record") data = { yes: true };
    if (action === "get_msg") {
      metadataReads.push(String(params.message_id));
      data = originals.get(String(params.message_id)) ?? {};
    }
    if (action === "get_record") {
      assert.equal(params.out_format, "wav");
      assert.match(params.file, /^gateway-opaque/u);
      fileReads.push(params.file);
      data = { base64: pcm.toString("base64"), file: "ignored-local-path" };
    }
    if (action === "send_group_msg" || action === "send_private_msg") {
      const recipient = params.group_id ?? params.user_id;
      if (params.message[0]?.type === "record") {
        assert.equal(params.message.length, 1);
        assert.deepEqual(Buffer.from(params.message[0].data.file.split("://")[1], "base64"), spoken);
        voiceAttempts.push({ recipient, success: voiceOutcome === "success" });
        if (voiceOutcome === "reject") {
          peer.send(JSON.stringify({ status: "failed", retcode: 1404, echo }));
          return;
        }
        if (voiceOutcome === "ambiguous") {
          peer.send(JSON.stringify({ status: "ok", retcode: 0, echo, data: {} }));
          return;
        }
      }
      deliveries.push({ action, recipient,
        text: params.message.map((part: { data: { text?: string } }) => part.data.text ?? "").join("") });
      data = { message_id: 9000 + deliveries.length };
    }
    peer.send(JSON.stringify({ status: "ok", retcode: 0, echo, data }));
  }));
  const collector = createQqIngressCollector({ database: intakeDatabase, accountId: "1001", gateway: gatewayUrl, token,
    groups: ["5001", "5002"], privateContacts: ["2001", "2002"] });
  collector.server.listen(0, "127.0.0.1");
  await once(collector.server, "listening");
  const collectorUrl = `http://127.0.0.1:${listen(collector.server)}`;
  const service = createGroupService({ adminToken: admin, database, qqIngress: collectorUrl, qqIngressToken: token,
    channel: { address: gatewayUrl, enabled: true, groups: ["5001", "5002"], roleId: "", modelId: "", hasToken: false, expectedBotId: "1001" },
    observeGroups: ["5001", "5002"], summaryGroups: ["5001", "5002"], summarizeAfter: 1000,
    qqVoice: { endpoint: providerUrl + "/audio/transcriptions", model: "fixture-voice", hasKey: true,
      groups: ["5001"], privateContacts: ["2001", "2002"], language: "zh" },
    qqVoiceKey: "voice-fixture",
    qqSpeech: { endpoint: providerUrl + "/audio/speech", model: "fixture-speech", hasKey: true,
      groups: ["5001"], privateContacts: ["2001"], voice: "generic-voice", roleVoices: { dafeiyu: "fish-voice" }, style: "instructions" },
    qqSpeechKey: "speech-fixture",
    qqPrivateSpeech: { endpoint: providerUrl + "/audio/private-speech", model: "fixture-speech", hasKey: true,
      groups: [], privateContacts: ["2001"], voice: "other-default", roleVoices: { dafeiyu: "fish-private-voice" }, style: "instructions", maxCharacters: 20 },
    qqPrivateSpeechKey: "private-speech-fixture",
    model: { id: "fixture-text", name: "fixture-text", model: "fixture-text", hasKey: true,
      baseUrl: providerUrl + "/v1", billing: "none", billingAccount: "", currency: "CNY", inputPrice: null, outputPrice: null },
    modelKey: "text-fixture" });
  t.after(async () => {
    await service.stop();
    await collector.stop();
    for (const peer of gateway.clients) peer.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    const directory = await realpath(scratch);
    assert.equal(dirname(directory), root);
    await rm(directory, { recursive: true, force: true });
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  service.startChannel();
  const base = `http://127.0.0.1:${listen(service.server)}`;
  const api = (path: string, body?: object, method = body ? "PUT" : "GET") => fetch(base + path, { method,
    headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const until = async (condition: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 300; i++) {
      if (await condition()) return;
      await delay(25);
    }
    assert.fail("Voice fixture timed out");
  };
  await until(async () => gateway.clients.size === 2 && (await (await api("/admin/qq-ingress")).json()).ready === true);
  const info = await (await api("/admin/gateway")).json();
  assert.deepEqual(info.speech, { engine: "http", voice: "generic-voice", groups: 1, privateContacts: 0 });
  assert.deepEqual(info.privateSpeech, { engine: "http", voice: "other-default", contacts: 1, maxCharacters: 20 });
  assert.equal((await api("/admin/private-contacts", { userId: "2001" })).status, 200);
  function event(id: number, recipient: number, mention = true, authorizedSource = true) {
    const group = recipient >= 5000;
    const incoming = { post_type: "message", message_type: group ? "group" : "private", sub_type: group ? "normal" : "friend",
      self_id: 1001, user_id: group ? 2001 : recipient, group_id: group ? recipient : undefined, message_id: id,
      message: [...(group && mention ? [{ type: "at", data: { qq: 1001 } }] : []),
        { type: "record", data: { file: "gateway-opaque-" + id + ".amr", url: "https://example.test/private-media" } }] };
    originals.set(String(id), authorizedSource ? incoming : { ...incoming, group_id: 5002 });
    for (const peer of gateway.clients) peer.send(JSON.stringify(incoming));
  }
  event(11, 5001, false);
  event(12, 5002);
  event(13, 5001, true, false);
  event(14, 5001);
  event(14, 5001);
  event(15, 2001);
  event(16, 2002);
  await until(() => deliveries.length === 4);
  assert.deepEqual([...metadataReads].sort(), ["13", "14", "15"]);
  assert.deepEqual([...fileReads].sort(), ["gateway-opaque-14.amr", "gateway-opaque-15.amr"]);
  assert.deepEqual(observed, { voiceRequests: 2, modelRequests: 2 });
  assert.deepEqual(deliveries.filter(row => row.recipient === 5001).map(item => item.text), [qqVoiceUnavailable, replyText]);
  assert.equal(deliveries.find(item => item.recipient === 5002)?.text, qqVoiceUnavailable);
  assert.equal(deliveries.find(item => item.action === "send_private_msg" && item.recipient === 2001)?.text, replyText);
  const persisted = new DatabaseSync(database, { readOnly: true });
  const inbox = new DatabaseSync(intakeDatabase, { readOnly: true });
  try {
    const groups = persisted.prepare("SELECT content FROM group_messages ORDER BY id").all().map(row => row.content);
    assert.equal(groups.filter(text => text === qqVoicePlaceholder).length, 4);
    assert.ok(!groups.some(text => String(text).includes(transcript)));
    assert.equal(persisted.prepare("SELECT COUNT(*) AS n FROM messages WHERE author='user' AND content=?").get(qqVoicePlaceholder)?.n, 1);
    assert.equal(persisted.prepare("SELECT COUNT(*) AS n FROM requests WHERE scope GLOB 'voice-transcription:*' AND status='ok'").get()?.n, 2);
    const intake = JSON.stringify(inbox.prepare("SELECT message FROM qq_ingress_messages").all());
    assert.ok(intake.includes("hasVoice"));
    assert.doesNotMatch(intake, /gateway-opaque|private-media/u);
  } finally { inbox.close(); persisted.close(); }
  const groupTrace = async (id: number) =>
    (await (await api("/admin/group-reply-traces?eventId=" + id)).json()).items[0];
  function speechEvent(id: number, recipient: number, text: string, mention = true, actor = 2001) {
    const group = recipient >= 5000;
    const incoming = { post_type: "message", message_type: group ? "group" : "private", sub_type: "friend",
      self_id: 1001, user_id: group ? actor : recipient, group_id: group ? recipient : undefined, message_id: id,
      message: [...(group && mention ? [{ type: "at", data: { qq: 1001 } }] : []), { type: "text", data: { text } }] };
    for (const peer of gateway.clients) peer.send(JSON.stringify(incoming));
  }
  speechEvent(20, 5001, "/语音 写个简短的晚安");
  await until(async () => (await groupTrace(20))?.receipts[0]?.status === "sent");
  assert.deepEqual((await groupTrace(20)).receipts.map((row: { format?: string }) => row.format), ["voice"]);
  assert.deepEqual(spokenRequests[0], { voice: "fish-voice", input: "晚安。\n做个好梦。" });
  speechEvent(21, 2001, "请用语音回复：写个简短的晚安");
  await until(() => voiceAttempts.length === 2);
  assert.equal(voiceAttempts[1].recipient, 2001);
  assert.deepEqual(spokenRequests[1], { voice: "fish-private-voice", input: "晚安，做个好梦。" });
  speechEvent(31, 2001, "用语音讲完整的长故事。");
  await until(() => deliveries.at(-1)?.text === fullStory);
  assert.equal(voiceAttempts.length, 2);
  assert.equal(spokenRequests.length, 2);
  speechEvent(22, 5002, "/语音 写个简短的晚安");
  await until(async () => (await groupTrace(22))?.state === "finished");
  assert.deepEqual((await groupTrace(22)).receipts.map((row: { format?: string }) => row.format), [undefined, undefined]);
  assert.equal(spokenRequests.length, 2);
  speechEvent(23, 5001, "/语音 合成故障");
  await until(async () => (await groupTrace(23))?.receipts[0]?.status === "sent");
  assert.equal(deliveries.at(-1)?.text, "合成故障仍可发文字。");
  assert.equal(voiceAttempts.length, 2);
  voiceOutcome = "reject";
  speechEvent(24, 5001, "/语音 写个简短的晚安");
  await until(async () => (await groupTrace(24))?.receipts[0]?.status === "sent");
  assert.equal(deliveries.at(-1)?.text, "晚安。\n做个好梦。");
  assert.equal(voiceAttempts.length, 3);
  voiceOutcome = "ambiguous";
  const count = deliveries.length;
  speechEvent(25, 5001, "/语音 写个简短的晚安");
  await until(async () => (await groupTrace(25))?.receipts[0]?.status === "unknown");
  assert.equal((await groupTrace(25)).receipts[0].format, "voice");
  assert.equal(deliveries.length, count);
  assert.equal(voiceAttempts.length, 4);
  speechEvent(26, 5001, "/语音");
  await until(async () => (await groupTrace(26))?.reason === "speech-help");
  assert.equal(voiceAttempts.length, 4);
  speechEvent(27, 2001, "/语音 撤销时等待");
  await until(() => spokenRequests.some(row => row.input.includes("撤销时等待")));
  assert.equal((await api("/admin/private-contacts", { userId: "2001" }, "DELETE")).status, 200);
  await until(() => speechProviderAborted);
  assert.equal(voiceAttempts.length, 4);
  assert.equal(readSpeechRequest("我听到他用语音讲了个笑话"), undefined);
  assert.equal(readSpeechRequest("用语音讲个冷笑话"), undefined);
  assert.equal(readSpeechRequest("你能讲个冷笑话吗，语音的"), undefined);
  voiceOutcome = "success";
  speechEvent(28, 5001, "用语音讲个冷笑话");
  await until(async () => (await groupTrace(28))?.receipts[0]?.status === "sent");
  assert.deepEqual((await groupTrace(28)).receipts.map((row: { format?: string }) => row.format), ["voice"]);
  speechEvent(29, 5001, "你能讲个冷笑话吗，语音的");
  await until(async () => (await groupTrace(29))?.receipts[0]?.status === "sent");
  assert.deepEqual((await groupTrace(29)).receipts.map((row: { format?: string }) => row.format), ["voice"]);
  assert.match(spokenDirections.at(-1) ?? "", /语气俏皮/u);
  assert.match(spokenDirections[1], /语气温柔/u);
  speechEvent(30, 5001, "我在引用这句话：用语音讲个冷笑话");
  await until(async () => (await groupTrace(30))?.receipts[0]?.status === "sent");
  assert.equal((await groupTrace(30)).receipts[0].format, undefined);
  assert.equal(voiceAttempts.length, 6);

  speechEvent(40, 5001, "");
  speechEvent(41, 5001, "/语音 写个简短的晚安", false);
  await until(async () => (await groupTrace(40))?.state === "finished");
  assert.deepEqual((await groupTrace(40)).receipts.map((row: { format?: string }) => row.format), ["voice"]);
  assert.equal(await groupTrace(41), undefined);
  assert.deepEqual(spokenRequests.at(-1), { voice: "fish-voice", input: "晚安。\n做个好梦。" });

  speechEvent(42, 5001, "/语音");
  speechEvent(43, 5001, "写个简短的晚安", false);
  await until(async () => (await groupTrace(42))?.state === "finished");
  assert.equal((await groupTrace(42)).receipts[0].format, "voice");
  assert.equal(await groupTrace(43), undefined);

  speechEvent(44, 5001, "");
  speechEvent(45, 5001, "/读网页 https://127.0.0.1/", false);
  await until(async () => (await groupTrace(44))?.state === "finished");
  assert.ok((await groupTrace(44)).context.included.some((item: { kind: string }) => item.kind === "web-tool"));
  assert.equal((await groupTrace(44)).receipts.length, 1);
  assert.equal(await groupTrace(45), undefined);

  speechEvent(46, 5001, "");
  speechEvent(47, 5001, "先看这里", false, 2002);
  speechEvent(48, 5001, "/读网页 https://127.0.0.1/", false);
  await until(async () => (await groupTrace(46))?.state === "finished");
  assert.equal((await groupTrace(46)).reason, "ping");
  assert.equal(await groupTrace(48), undefined);

  assert.equal((await api("/admin/private-contacts", { userId: "2001" })).status, 200);
  speechEvent(49, 2001, "/语音 写个简短的晚安");
  await until(() => voiceAttempts.at(-1)?.recipient === 2001);
  assert.deepEqual(spokenRequests.at(-1), { voice: "fish-private-voice", input: "晚安，做个好梦。" });
});

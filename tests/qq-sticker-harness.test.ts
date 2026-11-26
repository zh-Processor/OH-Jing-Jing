import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { createGroupService } from "../runtime/group-service.js";

test("Harness can only send available stickers explicitly selected from the same group's lookup", { timeout: 30_000 }, async t => {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "ohjingjing-sticker-tool-"));
  const sdk = join(root, "node_modules", "@deepseek-ai", "dsh-sdk-client", "lib");
  await mkdir(sdk, { recursive: true });
  await writeFile(join(sdk, "index.js"), "");
  const script = join(root, "turn.mjs");
  const checkpoint = join(root, "read-sticker");
  const proceed = join(root, "resume-turn");
  const groupSticker = "abcdef0123";
  await writeFile(script, `
import { createInterface } from "node:readline";
import { writeFile, access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const input = createInterface({ input: process.stdin });
input.once("line", async line => {
  const { messages, groupHistoryUrl } = JSON.parse(line);
  const current = JSON.parse(messages.at(-1).content).current;
  async function rpc(method, params) {
    const response = await fetch(groupHistoryUrl, { method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return response.json();
  }
  const text = current === "今天风真大" ? "确实刮得厉害。" : current.startsWith("先查") ? "这是收藏标签。" : "这张合适。";
  if (current === "今天风真大") {
    const list = await rpc("tools/list");
    if (!list.result.tools.some(tool => tool.name === "find_stickers")) process.exit(2);
  } else {
    const found = await rpc("tools/call", { name: "find_stickers", arguments: {
      query: "鼓掌", mode: current.startsWith("先查") ? "find" : "send",
    } });
    const matches = JSON.parse(found.result.content[0].text).matches;
    if (current === "本群有吗" ? matches.length !== 0 : matches[0]?.id !== ${JSON.stringify(groupSticker)}) process.exit(3);
    if (current === "等我移除") {
      await writeFile(${JSON.stringify(checkpoint)}, "ready");
      for (;;) {
        if (await access(${JSON.stringify(proceed)}).then(() => true, () => false)) break;
        await delay(40);
      }
    }
  }
  const textReply = JSON.stringify({ action: "reply", parts: [text],
    ...(current === "想在群里看纸帽鼓掌" ? {} : { groupSticker: ${JSON.stringify(groupSticker)} }) });
  input.close();
  process.stdout.write(JSON.stringify({ ok: true, text: textReply, inputTokens: 25, outputTokens: 8 }) + "\\n", () => process.exit(0));
});
`);
  for (const [name, value] of Object.entries({ OHJINGJING_DSH_NODE: process.execPath, OHJINGJING_DSH_TURN_SCRIPT: script,
    OHJINGJING_DSH_SDK_ROOT: root, OHJINGJING_DSH_STATE: join(root, "turns") })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const sends: { group: number; text: string; media?: string; acknowledged: boolean }[] = [];
  let refuseImage = false;
  let omitReceipt = false;
  gateway.on("connection", socket => socket.on("message", frame => {
    const { action, params, echo } = JSON.parse(String(frame));
    let data: object | undefined;
    if (action === "get_status") data = { online: true, good: true };
    if (action === "get_login_info") data = { user_id: 1001 };
    if (action === "send_group_msg") {
      const media = params.message.find((part: { type: string }) => part.type === "image")?.data.file;
      const acknowledged = !(media && (refuseImage || omitReceipt));
      sends.push({ group: params.group_id, text: params.message[0].data.text, media, acknowledged });
      data = acknowledged ? { message_id: 9200 + sends.length } : {};
      if (media && refuseImage) data = undefined;
    }
    socket.send(JSON.stringify({ status: data ? "ok" : "failed", retcode: data ? 0 : 1404, echo, data }));
  }));
  const database = join(root, "service.db");
  const service = createGroupService({
    database, adminToken: "isolated-qq-sticker-admin", observeGroups: ["5001", "5002"],
    channel: { enabled: true, address: "ws://127.0.0.1:" + (gateway.address() as AddressInfo).port, groups: ["5001", "5002"],
      roleId: "", modelId: "", hasToken: false, expectedBotId: "1001", cooldownSeconds: 0 },
    dshTurns: { purposes: ["reply"], groups: ["5001", "5002"] },
    model: { id: "sticker-fixture", name: "Fixture", model: "fixture", hasKey: true, baseUrl: "http://127.0.0.1:1",
      billing: "none", billingAccount: "", currency: "CNY", inputPrice: null, outputPrice: null }, modelKey: "fixture-sticker-key",
  });
  const db = new DatabaseSync(database);
  t.after(async () => {
    await service.stop();
    db.close();
    for (const socket of gateway.clients) socket.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    const path = await realpath(root);
    assert.equal(dirname(path), parent);
    await rm(path, { recursive: true, force: true });
  });
  const scope = "qq:1001:5001";
  const sticker = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTHsAAAAASUVORK5CYII=", "base64");
  db.prepare("INSERT INTO qq_group_stickers VALUES(?,?,?,?,?,?,?,?)")
    .run(scope, groupSticker, "2001", "纸帽鼓掌", "纸帽鼓掌", "fixture-digest", sticker, new Date().toISOString());
  const ready = once(gateway, "connection");
  service.startChannel();
  const [connection] = await ready;
  await delay(250);
  async function waitFor(check: () => unknown | Promise<unknown>) {
    for (let i = 0; i < 150; i++) {
      if (await check()) return;
      await delay(35);
    }
    assert.fail("Expected a sticker turn state");
  }
  const outbox = db.prepare("SELECT status,content,delivery_format FROM outbox WHERE scope=? AND event_id=?");
  const trace = db.prepare("SELECT context_json FROM group_reply_traces WHERE scope=? AND event_id=?");
  async function say(id: number, current: string, group = 5001, waitForDelivery = true) {
    connection.send(JSON.stringify({ post_type: "message", message_type: "group", self_id: 1001, group_id: group, user_id: 2001,
      message_id: id, message: [{ type: "at", data: { qq: 1001 } }, { type: "text", data: { text: current } }] }));
    if (waitForDelivery) await waitFor(() => ["sent", "unknown"].includes(String(outbox.get("qq:1001:" + group, String(id))?.status)));
  }
  await say(1, "今天风真大");
  assert.equal(sends[0].media, undefined);
  assert.doesNotMatch(String(trace.get(scope, "1")?.context_json), /sticker-tool/u);
  await say(2, "先查纸帽鼓掌");
  assert.equal(sends[1].media, undefined);
  assert.match(String(trace.get(scope, "2")?.context_json), /sticker-tool/u);
  await say(3, "想在群里看纸帽鼓掌");
  assert.equal(sends[2].media, "base64://" + sticker.toString("base64"));
  assert.equal(outbox.get(scope, "3")?.delivery_format, "image");
  await say(4, "本群有吗", 5002);
  assert.equal(sends[3].group, 5002);
  assert.equal(sends[3].media, undefined);
  refuseImage = true;
  await say(5, "再发一次纸帽鼓掌");
  assert.equal(sends[4].acknowledged, false);
  assert.equal(sends[5].text, "这张表情发送失败。");
  assert.equal(outbox.get(scope, "5")?.content, sends[5].text);
  refuseImage = false;
  omitReceipt = true;
  await say(6, "请发送纸帽鼓掌");
  assert.equal(sends.length, 7);
  assert.equal(outbox.get(scope, "6")?.status, "unknown");
  omitReceipt = false;
  await say(7, "等我移除", 5001, false);
  await waitFor(() => readFile(checkpoint).catch(() => null));
  db.prepare("DELETE FROM qq_group_stickers WHERE scope=? AND id=?").run(scope, groupSticker);
  await writeFile(proceed, "resume");
  await waitFor(() => outbox.get(scope, "7")?.status === "sent");
  assert.equal(sends[7].media, undefined);
  assert.equal(sends[7].text, "这张表情现在不可用了。");
  assert.equal(sends.length, 8);
});

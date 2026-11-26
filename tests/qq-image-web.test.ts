import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { createGroupService } from "../runtime/group-service.js";

test("a QQ image and an explicitly requested public lookup stay in the same Harness turn", { timeout: 25_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ohjingjing-image-web-"));
  const sdk = join(root, "node_modules", "@deepseek-ai", "dsh-sdk-client", "lib");
  const turn = join(root, "turn.mjs");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";
  const imageUrl = "https://gchat.qpic.cn/qq-image-web-fixture.png";
  const source = "https://docs.python.org/3/library/functions.html#enumerate";
  await mkdir(sdk, { recursive: true });
  await writeFile(join(sdk, "index.js"), "");
  await writeFile(turn, `
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
input.once("line", line => {
  const { messages, images, groupHistoryUrl, privateHistoryUrl } = JSON.parse(line);
  assert.deepEqual(images, [{ type: "image", mimeType: "image/png", data: ${JSON.stringify(png)} }]);
  assert.ok(!groupHistoryUrl && !privateHistoryUrl);
  const structured = messages.flatMap(({ role, content }) => {
    if (role !== "user") return [];
    try { return [JSON.parse(content)]; } catch { return []; }
  });
  const { current, recent, priorTurns } = structured.find(item => typeof item.current === "string");
  assert.ok(!recent?.length && !priorTurns?.length);
  const page = structured.find(item => item.tool === "web_search");
  const answer = text => current.startsWith("私聊：") ? text : JSON.stringify({ action: "reply", parts: [text] });
  let text;
  if (page) {
    const found = page.content.includes("enumerate");
    text = answer(found ? "图里是红圆。官方文档的默认值是 0。" : "图里是红圆。公开资料暂时核实不了。");
  } else if (current.includes("官方出处")) {
    text = current.startsWith("私聊：") ? JSON.stringify({ action: "web_search", terms: ["Python enumerate"] }) :
      '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="web_search"><｜｜DSML｜｜ parameter name="terms" string="false">' +
      '["Python enumerate"]</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  } else if (current === "图片上的文字是什么") {
    text = JSON.stringify({ action: "web_search", terms: ["图中独有的内容"] });
  } else {
    text = answer("图里是红圆。");
  }
  if (!page) assert.ok(messages.find(item => item.role === "system" && item.content.includes("配文明确要求查询")));
  input.close();
  process.stdout.write(JSON.stringify({ ok: true, text, inputTokens: 35, outputTokens: 13 }) + "\\n", () => process.exit(0));
});
`);
  const env = { OHJINGJING_DSH_NODE: process.execPath, OHJINGJING_DSH_TURN_SCRIPT: turn,
    OHJINGJING_DSH_SDK_ROOT: root, OHJINGJING_DSH_STATE: join(root, "turns") };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let service: ReturnType<typeof createGroupService> | undefined;
  t.after(async () => {
    await service?.stop();
    for (const socket of gateway.clients) socket.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  await once(gateway, "listening");
  const sent: { action: string; text: string }[] = [];
  const queries: string[] = [];
  let found = true;
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: URL | string, init?: RequestInit) => {
    if (String(url) === imageUrl) return new Response(Buffer.from(png, "base64"));
    if (!String(url).startsWith("https://mcp.exa.ai/")) return fetch(url, init);
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    const request = JSON.parse(String(init?.body));
    if (request.method === "initialize") return Response.json({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
    } });
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.equal(request.params.name, "web_search_exa");
    queries.push(request.params.arguments.query);
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { content: found ? [{ type: "text",
      text: "Title: Python enumerate\nURL: " + source + "\nHighlights:\nThe starting index defaults to zero." }] : [] } });
  });
  gateway.on("connection", socket => socket.on("message", frame => {
    const { action, params, echo } = JSON.parse(String(frame));
    let data: object | undefined;
    if (action === "get_status") data = { online: true, good: true };
    if (action === "get_login_info") data = { user_id: 1001 };
    if (action === "send_group_msg" || action === "send_private_msg") {
      sent.push({ action, text: params.message[0].data.text });
      data = { message_id: 9000 + sent.length };
    }
    socket.send(JSON.stringify({ echo, status: data ? "ok" : "failed", retcode: data ? 0 : 1404, data }));
  }));
  const adminToken = randomUUID();
  service = createGroupService({ database: ":memory:", adminToken, observeGroups: ["5001"],
    channel: { enabled: true, address: "ws://127.0.0.1:" + (gateway.address() as AddressInfo).port, groups: ["5001"],
      roleId: "", modelId: "", hasToken: false, expectedBotId: "1001", cooldownSeconds: 0 },
    dshTurns: { purposes: ["reply", "private"], groups: ["5001"] },
    model: { id: "image-web-fixture", name: "Fixture", model: "fixture", hasKey: true, vision: true, baseUrl: "http://127.0.0.1:1",
      billing: "none", billingAccount: "", currency: "CNY", inputPrice: null, outputPrice: null }, modelKey: "fixture-model-key" });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const url = "http://127.0.0.1:" + (service.server.address() as AddressInfo).port;
  const headers = { Authorization: "Bearer " + adminToken, "Content-Type": "application/json" };
  const connected = once(gateway, "connection");
  service.startChannel();
  const [socket] = await connected;
  async function until(condition: () => unknown | Promise<unknown>) {
    for (let deadline = Date.now() + 5_000; Date.now() < deadline; await delay(40)) {
      if (await condition()) return;
    }
    assert.fail("expected a ready test gateway or a reply");
  }
  await until(async () => (await (await fetch(url + "/admin/gateway", { headers })).json()).matchesExpected);
  assert.equal((await fetch(url + "/admin/private-contacts", { method: "PUT", headers, body: '{"userId":"2001"}' })).status, 200);
  async function say(id: number, caption: string, group: boolean) {
    const index = sent.length;
    socket.send(JSON.stringify({ post_type: "message", message_type: group ? "group" : "private", sub_type: group ? "normal" : "friend",
      self_id: 1001, group_id: group ? 5001 : undefined, user_id: 2001, message_id: id,
      message: [...(group ? [{ type: "at", data: { qq: 1001 } }] : []), { type: "text", data: { text: caption } },
        { type: "image", data: { url: imageUrl } }] }));
    await until(() => sent.length > index);
    assert.equal(sent[index].action, group ? "send_group_msg" : "send_private_msg");
    return sent[index].text;
  }
  assert.equal(await say(1, "图片里的形状是什么？", true), "图里是红圆。");
  assert.deepEqual(queries, []);
  for (const [id, group] of [[2, true], [3, false]] as const) {
    const reply = await say(id, (group ? "" : "私聊：") + "看看图片，再帮忙找 Python enumerate 的官方出处。", group);
    assert.match(reply, /红圆.*默认值是 0/u);
    assert.ok(reply.includes(source));
  }
  assert.deepEqual(queries, ["Python enumerate", "Python enumerate"]);
  assert.match(await say(4, "图片上的文字是什么", true), /没找到可以对外查询/u);
  assert.equal(queries.length, 2);
  found = false;
  assert.equal(await say(5, "看看图片，再帮忙找 Python enumerate 的官方出处。", true), "图里是红圆。公开资料暂时核实不了。");
  assert.deepEqual(queries, ["Python enumerate", "Python enumerate", "Python enumerate"]);
  assert.equal(sent.length, 5);
});

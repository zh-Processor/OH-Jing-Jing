import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { createGroupService } from "../runtime/group-service.js";
import { openQqPrivateGreetings } from "../runtime/qq-private-greetings.js";
import { openStore } from "../runtime/store.js";

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 250; i++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail("The private greeting state was not reached.");
}

test("recipient controls, quiet windows and unanswered greetings survive service restart", () => {
  const { db } = openStore(":memory:");
  try {
    const contact = { accountId: "1001", userId: "2001" };
    const date = (day: number, hour = 18) => Date.UTC(2027, 0, day, hour - 8);
    const first = openQqPrivateGreetings(db);
    assert.match(first.command(contact, "/问候订阅", date(1)), /尚未开放/);
    first.setAccess(contact, true);
    assert.equal(first.pending(), false);
    assert.match(first.command(contact, "/问候订阅 18:00 Asia/Shanghai", date(1, 16)), /已订阅/);
    first.command(contact, "/问候勿扰 17:00 19:00", date(1, 17));
    assert.deepEqual(first.due(date(1, 18)), []);
    first.command(contact, "/问候勿扰 关闭", date(1, 19));
    function attempt(plans: ReturnType<typeof openQqPrivateGreetings>, time: number, outcome: "sent" | "unknown") {
      const [candidate] = plans.due(time);
      const id = plans.begin(candidate, time)!;
      assert.ok(id);
      assert.equal(plans.begin(candidate, time), null);
      assert.equal(plans.reserve(candidate, id, time), true);
      assert.equal(plans.reserve(candidate, id, time), false);
      plans.finish(id, outcome);
    }
    attempt(first, date(1, 19), "sent");
    attempt(first, date(2), "unknown");
    assert.equal(first.summary(contact).nextAt, date(5));
    const restarted = openQqPrivateGreetings(db);
    assert.deepEqual(restarted.due(date(3)), []);
    attempt(restarted, date(5), "sent");
    attempt(restarted, date(8), "sent");
    assert.equal(restarted.summary(contact).settings?.unanswered, 4);
    assert.equal(restarted.summary(contact).nextAt, date(15));
    restarted.noteInbound(contact, date(9, 17));
    assert.equal(restarted.summary(contact).settings?.unanswered, 0);
    assert.equal(restarted.summary(contact).nextAt, date(9));
    assert.deepEqual(restarted.due(date(9)), []);
    const [catchUp] = restarted.due(date(12, 19));
    assert.equal(catchUp.dueAt, date(12));
    const id = restarted.begin(catchUp, date(12, 19))!;
    restarted.command(contact, "/问候退订", date(12, 19));
    assert.equal(restarted.reserve(catchUp, id, date(12, 19)), false);
    assert.equal(restarted.summary(contact).nextAt, null);
    assert.equal(openQqPrivateGreetings(db).summary(contact).history[0].state, "interrupted");
  } finally { db.close(); }
});

test("the QQ greeting worker isolates prompts, respects budget and withdraws a running greeting", async (t) => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-private-greetings-"));
  const database = join(directory, "greetings.db");
  const admin = "test-private-greeting-administrator";
  let mode: "normal" | "hold" | "disconnect" = "normal";
  let providerAborted = false;
  const modelPrompts: string[] = [];
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    modelPrompts.push(body);
    if (mode === "hold") {
      response.once("close", () => { providerAborted = true; });
      return;
    }
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "reply", text: "晚上好，忙完的话就歇一小会儿吧。" }) } }],
      usage: { prompt_tokens: 14, completion_tokens: 7 } }));
  });
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  provider.listen(0, "127.0.0.1");
  await Promise.all([once(provider, "listening"), once(gateway, "listening")]);
  let peer: WebSocket;
  let currentAccount = 1001;
  let loginChecks = 0;
  const outgoing: { text: string; to: number; id: string }[] = [];
  gateway.on("connection", socket => {
    peer = socket;
    peer.on("message", (raw: Buffer) => {
      const command = JSON.parse(raw.toString());
      if (command.action === "get_login_info") {
        loginChecks++;
        socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: command.echo, data: { user_id: currentAccount } }));
        return;
      }
      assert.equal(command.action, "send_private_msg");
      const { user_id: to, message } = command.params;
      const text: string = message[0].data.text;
      const id = String(900 + outgoing.length);
      outgoing.push({ text, to, id });
      if (mode === "disconnect" && text.startsWith("晚上好")) { socket.close(); return; }
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: command.echo, data: { message_id: id } }));
    });
  });
  const port = (server: { address(): unknown }) => (server.address() as AddressInfo).port;
  async function start() {
    const instance = createGroupService({ database, adminToken: admin,
      model: { id: "greeting-fixture", name: "Test provider", baseUrl: `http://127.0.0.1:${port(provider)}`, model: "fixture",
        hasKey: false, billing: "none", inputPrice: 1, outputPrice: 1, currency: "CNY", billingAccount: "" },
      channel: { address: `ws://127.0.0.1:${port(gateway)}`, enabled: true, groups: [],
        roleId: "", modelId: "", hasToken: false, expectedBotId: "1001" } });
    instance.server.listen(0, "127.0.0.1");
    await once(instance.server, "listening");
    instance.startChannel();
    return instance;
  }
  let service = await start();
  t.after(async () => {
    await service.stop();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    const safe = await realpath(directory);
    assert.ok(safe.startsWith(root + sep));
    await rm(safe, { recursive: true, force: true });
  });
  function api(path: string, data?: object, token = admin) {
    return fetch(`http://127.0.0.1:${port(service.server)}${path}`, { method: data ? "PUT" : "GET",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: data && JSON.stringify(data) });
  }
  const state = async () => (await api("/admin/status")).json();
  const greeting = async () => (await state()).privateContacts.find((item: { userId: string }) => item.userId === "2001").greetings;
  const allow = async (enabled: boolean) => api("/admin/private-contacts/greetings", { userId: "2001", enabled });
  let event = 0;
  async function privateCommand(text: string, pattern: RegExp) {
    const before = outgoing.length;
    peer.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend", self_id: 1001,
      user_id: 2001, message_id: ++event, message: [{ type: "text", data: { text } }] }));
    await until(() => outgoing.slice(before).some(item => pattern.test(item.text) && item.to === 2001));
  }
  const localClock = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", timeStyle: "short", hourCycle: "h23" })
    .format(Date.now() + 3 * 60 * 60_000);
  async function subscribe() {
    await privateCommand(`/问候订阅 ${localClock} Asia/Shanghai`, /已订阅角色问候/);
    await privateCommand("/问候勿扰 关闭", /已关闭问候勿扰/);
  }
  function forceDue() {
    const db = new DatabaseSync(database);
    try {
      assert.equal(db.prepare("UPDATE qq_private_greeting_policies SET next_at=? WHERE account_id='1001' AND user_id='2001'")
        .run(Date.now() - 100).changes, 1);
    } finally { db.close(); }
  }
  const sent = () => outgoing.filter(item => item.text.startsWith("晚上好"));

  await until(async () => (await state()).channel === "online");
  assert.equal((await allow(true)).status, 409);
  assert.equal((await api("/admin/private-contacts", { userId: "2001" })).status, 200);
  assert.equal((await api("/admin/private-contacts/greetings", { userId: "2001", enabled: true }, "not-admin")).status, 403);
  assert.equal((await allow(true)).status, 200);
  assert.equal((await greeting()).nextAt, null);
  await subscribe();
  const db = new DatabaseSync(database);
  try {
    db.prepare("INSERT INTO messages VALUES(NULL,?,?,?,?,?)")
      .run("qq-private:1001:2001", "ohjingjing.dafeiyu", "user", "只留在私聊上下文的正文", new Date().toISOString());
    db.prepare("INSERT INTO group_messages(scope,author,content,created_at) VALUES(?,?,?,?)")
      .run("qq:1001:5001", "2001", "只留在群聊的正文", new Date().toISOString());
  } finally { db.close(); }
  const budget = (await (await api("/admin/budget")).json()).policy;
  assert.equal((await api("/admin/budget", { ...budget, background: { daily: 0, monthly: null } })).status, 200);
  forceDue();
  await delay(1200);
  assert.equal(modelPrompts.length, 0);
  currentAccount = 1002;
  const updated = (await (await api("/admin/budget")).json()).policy;
  assert.equal((await api("/admin/budget", { ...updated, background: { daily: null, monthly: null } })).status, 200);
  await until(() => loginChecks > 0);
  assert.equal(modelPrompts.length, 0);
  currentAccount = 1001;
  await until(async () => (await greeting()).history[0]?.state === "sent");
  assert.equal(sent()[0].to, 2001);
  assert.equal((await greeting()).history[0].platformMessageId, sent()[0].id);
  assert.match(modelPrompts[0], /private-greeting/);
  assert.doesNotMatch(modelPrompts[0], /只留在|2001|1001/);
  assert.equal((await state()).usage.find((item: { purpose: string }) => item.purpose === "private-greeting").requests, 1);
  assert.equal((await state()).budget.background.daily.used, 1);

  mode = "hold";
  forceDue();
  await until(() => modelPrompts.length === 2);
  assert.equal((await allow(false)).status, 200);
  await until(() => providerAborted);
  await until(async () => (await greeting()).history[0]?.reason === "permission");
  assert.equal(sent().length, 1);
  assert.equal((await greeting()).nextAt, null);

  assert.equal((await allow(true)).status, 200);
  await subscribe();
  mode = "disconnect";
  forceDue();
  await until(async () => (await greeting()).history[0]?.state === "unknown");
  const next = (await greeting()).nextAt;
  assert.equal(await service.stop(), undefined);
  service = await start();
  await until(async () => (await state()).channel === "online");
  assert.equal((await greeting()).nextAt, next);
  assert.equal((await greeting()).history[0].state, "unknown");
  assert.equal(sent().length, 2);
  assert.equal(modelPrompts.length, 3);
  assert.doesNotMatch(JSON.stringify(await greeting()), /晚上好|只留在/);
});

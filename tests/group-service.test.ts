import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Script } from "node:vm";
import { WebSocketServer } from "ws";
import { createGroupService } from "../runtime/group-service";
import { openStore } from "../runtime/store";
import type { ChannelMessage, ChannelStatus, ImChannelPlugin, IncomingGroupMessage } from "../runtime/im-channel";
import { balance, billingAvailable, type ModelProfile } from "../runtime/models";
import { groupMessage, OneBotConnection, privateMessage } from "../runtime/onebot";
import { defaultRole, readRole } from "../runtime/roles";
import { conversationCooldown, conversationWindow, defaultGroupConversation, openingWindow, readConversationDecision } from "../runtime/group-conversation";
import { callsRole, cleanGroupReply, isGroupFollowUp, isStandaloneGroupDraft, keepSchedulePending, proposedSchedule } from "../runtime/group-dialogue";
import { openGroupTopics, readTopicSummary } from "../runtime/group-topics";

function address(server: Server) {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("standalone group drafts only shed old context when they do not refer to previous discussion", () => {
  assert.equal(isStandaloneGroupDraft("写一句桌游开场白"), true);
  assert.equal(isStandaloneGroupDraft("桌游开场白"), true);
  assert.equal(isStandaloneGroupDraft("桌游开场白\n给第一次来的朋友"), true);
  assert.equal(isStandaloneGroupDraft("帮我来个桌游开场白！"), true);
  assert.equal(isStandaloneGroupDraft("，请帮我拟一段开场。"), true);
  assert.equal(isStandaloneGroupDraft("你用语音讲个故事"), true);
  assert.equal(isStandaloneGroupDraft("可以给我讲一个原创故事吗？"), true);
  assert.equal(isStandaloneGroupDraft("讲个故事吧"), true);
  assert.equal(isStandaloneGroupDraft("写一句刚才群里聊的活动开场白"), false);
  assert.equal(isStandaloneGroupDraft("桌游开场白\n按照刚才群里的安排"), false);
  assert.equal(isStandaloneGroupDraft("上次的桌游开场白"), false);
  assert.equal(isStandaloneGroupDraft("哪位群友的桌游开场白"), false);
  assert.equal(isStandaloneGroupDraft("用语音讲一段刚才群里聊的故事"), false);
  assert.equal(isStandaloneGroupDraft("讲个故事\n照群里的那段提示词"), false);
  assert.equal(isStandaloneGroupDraft("再讲个故事给上一段收尾"), false);
  assert.equal(isStandaloneGroupDraft("再短一点，保留桌游两个字"), false);
});
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}
async function waitFor(check: () => Promise<boolean> | boolean) {
  const end = performance.now() + 4500;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (performance.now() < end);
  assert.fail("Expected state was not reached");
}

test("provider billing selects only the intended first-party origin", () => {
  assert.equal(billingAvailable({ billing: "deepseek", baseUrl: "https://api.deepseek.com/v1" }), true);
  assert.equal(billingAvailable({ billing: "deepseek", baseUrl: "https://models.example.com/v1" }), false);
  assert.throws(() => billingAvailable({ billing: "deepseek", baseUrl: "https://secret@api.deepseek.com/v1" }));
  assert.equal(billingAvailable({ billing: "packy", baseUrl: "https://cf.api.fan/v1" }), true);
  assert.equal(billingAvailable({ billing: "packy", baseUrl: "https://slb-v1.api.fan/v1" }), true);
  assert.equal(billingAvailable({ billing: "packy", baseUrl: "https://cf.api.fan.example.com/v1" }), false);
});

test("provider balances preserve zero, unknown, and effective-budget scope", async (t) => {
  const payloads = [
    { balance_infos: [] },
    { balance_infos: [{ currency: "CNY", total_balance: "0.00" }] },
    { data: {} },
    { data: { limit: null, effective_budget: { remaining_usd: 2.25, scope: "member" } } },
    { data: { limit: 5, limit_remaining: 0 } },
  ];
  const mocked = t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json(payloads.shift()));
  const profile = (billing: "deepseek" | "openrouter"): ModelProfile => ({
    id: billing, name: billing, billing, model: "mock",
    baseUrl: billing === "deepseek" ? "https://api.deepseek.com/v1" : "https://openrouter.ai/api/v1",
    hasKey: true, inputPrice: null, outputPrice: null, currency: "USD", billingAccount: "",
  });
  const unknown = await balance(profile("deepseek"), "mock-key");
  assert.equal(unknown.status, "unknown");
  const zero = await balance(profile("deepseek"), "mock-key");
  assert.equal(zero.values?.[0]?.remaining, "0.00");
  assert.equal((await balance(profile("openrouter"), "mock-key")).status, "unknown");
  const unlimited = await balance(profile("openrouter"), "mock-key");
  assert.equal(unlimited.status, "unlimited");
  assert.equal(unlimited.effectiveBudget?.remaining, 2.25);
  assert.equal(unlimited.effectiveBudget?.scope, "member");
  assert.equal((await balance(profile("openrouter"), "mock-key")).values?.[0]?.remaining, 0);
  assert.equal(mocked.mock.calls[0].arguments[0], "https://api.deepseek.com/user/balance");
  assert.equal(mocked.mock.calls[2].arguments[0], "https://openrouter.ai/api/v1/key");
});

test("Packy quota verifies the original provider, handles unlimited keys and never sends keys to the public conversion API", async (t) => {
  const key = "packy-fixture-key";
  const profile: ModelProfile = { id: "packy", name: "Mock", model: "mock", billing: "packy",
    baseUrl: "https://cf.api.fan/v1", hasKey: true, inputPrice: null, outputPrice: null, currency: "USD", billingAccount: "" };
  const quota = (unlimited: boolean, fields = {}) => Response.json({ code: true, data: {
    object: "token_usage", unlimited_quota: unlimited, total_available: 0, total_used: 1500000, total_granted: 1500000, ...fields,
  } });
  const unit = () => Response.json({ data: { quota_per_unit: 500000 } });
  const responses = [quota(false), unit(), quota(true), unit(), quota(false), Response.json({ data: {} }),
    new Response(null, { status: 403 }), new Response(null, { status: 503 }), Response.json({ code: false })];
  const mocked = t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => responses.shift()!);
  const none = await balance({ ...profile, baseUrl: "https://gateway.example.com/v1" }, key);
  assert.equal(none.status, "unsupported");
  assert.equal(mocked.mock.callCount(), 0);

  const limited = await balance(profile, key);
  assert.equal(limited.status, "available");
  assert.equal(limited.scope, "key");
  assert.equal(limited.source, "www.packyapi.ai");
  assert.ok(limited.checkedAt);
  assert.deepEqual(limited.values, [{ currency: "USD", remaining: 0, used: 3, limit: 3 }]);
  const unlimited = await balance(profile, key);
  assert.equal(unlimited.status, "unlimited");
  assert.deepEqual(unlimited.values, [{ currency: "USD", remaining: null, used: 3, limit: null }]);
  const originalUnit = await balance(profile, key);
  assert.deepEqual(originalUnit.values, [{ currency: "quota", remaining: 0, used: 1500000, limit: 1500000 }]);
  assert.equal((await balance(profile, key)).status, "denied");
  assert.equal((await balance(profile, key)).status, "unavailable");
  assert.equal((await balance(profile, key)).status, "unknown");
  assert.equal(responses.length, 0);
  for (const { arguments: [url, init] } of mocked.mock.calls) {
    assert.equal(init?.redirect, "error");
    if (url === "https://www.packyapi.ai/api/status") {
      assert.equal(new Headers(init?.headers).has("authorization"), false);
    } else {
      assert.equal(url, "https://www.packyapi.ai/api/usage/token/");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
    }
  }
});

test("operations model inventory attributes requests to the configured binding and credential", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-model-bindings-"));
  const database = join(directory, "service.db");
  const admin = "integration-model-inventory-admin";
  const authenticated: string[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(input.max_tokens, 32);
    authenticated.push(req.headers.authorization ?? "");
    res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
  });
  await listen(upstream);
  const previous = openStore(database);
  previous.db.prepare(`INSERT INTO requests(model_id,model_name,scope,created_at,status,currency,duration_ms)
    VALUES('shared','共享模型','reply:qq:1001:5002',?,'ok','USD',20)`).run(new Date().toISOString());
  previous.db.close();
  const profile = { id: "shared", name: "共享模型", model: "shared", baseUrl: address(upstream), hasKey: true,
    billing: "none" as const, billingAccount: "测试账单", inputPrice: 1, outputPrice: 2, currency: "USD" };
  const options = {
    database, adminToken: admin, model: profile, modelKey: "default-fixture-secret",
    summaryModel: profile, summaryModelKey: "summary-fixture-secret",
    channel: { address: "", enabled: false, groups: ["5002"], roleId: "", modelId: "", hasToken: false },
    groupModels: { "5002": profile }, groupModelKeys: { "5002": "group-fixture-secret" },
  };
  let service: ReturnType<typeof createGroupService> | undefined;
  t.after(async () => {
    if (service) await service.stop();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  async function start(modelKey: string) {
    service = createGroupService({ ...options, modelKey });
    await listen(service.server);
  }
  async function call(path: string, method = "GET", token: string | null = admin) {
    const response = await fetch(address(service!.server) + path, {
      method, headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, data: await response.json() };
  }
  const ids = ["default", "summary", "group:5002"];
  await start(options.modelKey);
  assert.equal((await call("/admin/models", "GET", null)).status, 401);
  assert.equal((await call("/admin/models/default/test", "POST", "not-an-admin")).status, 403);
  assert.deepEqual((await call("/admin/models")).data.models.map((model: { id: string }) => model.id), ids);
  for (const id of ids) {
    const response = await call(`/admin/models/${encodeURIComponent(id)}/test`, "POST");
    assert.equal(response.status, 200);
    assert.equal(response.data.status, "ok");
  }
  assert.deepEqual(authenticated, ["Bearer default-fixture-secret", "Bearer summary-fixture-secret", "Bearer group-fixture-secret"]);
  const inventory = (await call("/admin/models?days=7")).data.models;
  assert.doesNotMatch(JSON.stringify(inventory), /fixture-secret/u);
  for (const item of inventory) {
    assert.equal(item.keyConfigured, true);
    assert.ok(item.lastUsed);
    assert.equal(item.usage[0].requests, 1);
    assert.equal(item.usage[0].input_tokens, 5);
    assert.equal(item.usage[0].output_tokens, 2);
  }
  assert.equal((await call("/admin/models/group%3A5002/balance")).data.status, "unsupported");
  assert.equal((await call("/admin/models/group%3A4999/balance")).status, 404);
  assert.equal((await call("/admin/status")).data.usage.reduce((total: number, row: { requests: number }) => total + row.requests, 0), 4);
  const selected = (await call("/admin/status?model=shared&purpose=model-test&binding=summary")).data;
  assert.equal(selected.usage.length, 1);
  assert.equal(selected.usage[0].requests, 1);
  assert.equal(selected.usage[0].purpose, "model-test");
  assert.equal(selected.modelHealth.measured, 1);
  assert.equal(selected.modelHealth.succeeded, 1);
  assert.deepEqual(selected.usageModels, [{ id: "shared", name: "共享模型" }]);
  assert.doesNotMatch(JSON.stringify(selected), /fixture-secret|usageKey/u);
  const older = (await call("/admin/status?model=shared&purpose=reply")).data;
  assert.equal(older.usage[0].requests, 1);
  assert.equal(older.modelHealth.p95Ms, 20);
  assert.equal((await call("/admin/status?purpose=invalid%3Apurpose")).status, 400);
  await service!.stop();
  service = undefined;

  await start("rotated-fixture-secret");
  const rotated = (await call("/admin/models")).data.models;
  assert.deepEqual(rotated[0].usage, []);
  assert.equal(rotated[0].lastUsed, null);
  assert.equal(rotated[1].usage[0].requests, 1);
  assert.equal(rotated[2].usage[0].requests, 1);
  assert.equal((await call("/admin/status")).data.usage.reduce((total: number, row: { requests: number }) => total + row.requests, 0), 4);
  const rotatedSelection = (await call("/admin/status?model=shared&binding=default")).data;
  assert.deepEqual(rotatedSelection.usage, []);
  assert.equal(rotatedSelection.modelHealth.measured, 0);
  assert.equal((await call("/admin/status?binding=group%3A5002")).data.usage[0].requests, 1);
});

test("operations report model success and nearest-rank P95 for completed attempts in the selected range", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-model-health-"));
  const database = join(directory, "service.sqlite");
  const adminToken = "fixture-admin-token-for-model-health";
  const service = createGroupService({ database, adminToken });
  t.after(async () => {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await listen(service.server);
  async function health(days: string) {
    const response = await fetch(address(service.server) + "/admin/status?days=" + days, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(response.status, 200);
    return (await response.json()).modelHealth;
  }
  assert.deepEqual(await health("1"), { measured: 0, succeeded: 0, successRate: null, p95Ms: null });
  const db = new DatabaseSync(database);
  try {
    const insert = db.prepare(`INSERT INTO requests(model_id,model_name,scope,created_at,status,currency,duration_ms)
      VALUES('fixture','测试模型','reply:qq:1001:5002',?,?,'USD',?)`);
    const recent = new Date().toISOString();
    const older = new Date(Date.now() - 3 * 86_400_000).toISOString();
    for (let rank = 1; rank <= 20; rank++) {
      insert.run(recent, rank === 19 ? "empty" : rank === 20 ? "failed" : "ok", rank * 100);
    }
    for (const status of ["running", "cancelled", "unknown"]) insert.run(recent, status, 99_000);
    insert.run(older, "ok", 3000);
  } finally {
    db.close();
  }
  assert.deepEqual(await health("1"), { measured: 20, succeeded: 18, successRate: 0.9, p95Ms: 1900 });
  assert.deepEqual(await health("7"), { measured: 21, succeeded: 19, successRate: 19 / 21, p95Ms: 2000 });
});

test("group statistics count only attempts for the selected account, group, period and currency", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-group-model-usage-"));
  const database = join(directory, "service.sqlite");
  const adminToken = "fixture-admin-token-for-group-usage";
  const service = createGroupService({ database, adminToken, observeGroups: ["5001", "5002"],
    channel: { address: "", enabled: false, groups: ["5001"], roleId: "", modelId: "", hasToken: false, expectedBotId: "1001" } });
  t.after(async () => {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await listen(service.server);
  const scope = "qq:1001:5001";
  const db = new DatabaseSync(database);
  try {
    const insert = db.prepare(`INSERT INTO requests(model_id,model_name,scope,created_at,status,input_tokens,output_tokens,estimated_cost,currency,duration_ms)
      VALUES('fixture','测试模型',?,?,?,?,?,?,?,100)`);
    const recent = new Date(Date.now() - 60_000).toISOString();
    const older = new Date(Date.now() - 3 * 86_400_000).toISOString();
    insert.run("reply:" + scope, recent, "ok", 20, 10, 0.125, "USD");
    insert.run("reply:" + scope, recent, "failed", null, null, null, "USD");
    insert.run("summary:" + scope, recent, "ok", 80, 5, 1.25, "CNY");
    insert.run(scope, recent, "ok", 4, 5, 0, "EUR");
    insert.run("reply:" + scope, older, "ok", 4, 4, 0.25, "USD");
    for (const elsewhere of ["reply:qq:1002:5001", "reply:qq:1001:5003", "private:qq-private:1001:5001", "reply:other:" + scope]) {
      insert.run(elsewhere, recent, "ok", 500, 500, 50, "USD");
    }
    insert.run("reply:" + scope, new Date(Date.now() + 600_000).toISOString(), "ok", 500, 500, 50, "USD");
  } finally {
    db.close();
  }
  async function statistics(target: string, days: string) {
    return fetch(address(service.server) + "/admin/group-statistics?" + new URLSearchParams({ scope: target, days }),
      { headers: { Authorization: `Bearer ${adminToken}` } });
  }
  const day = await (await statistics(scope, "1")).json();
  assert.deepEqual(day.modelUsage.map((row: any) =>
    [row.purpose, row.currency, row.requests, row.failed, row.input_tokens, row.estimated_cost, row.priced_requests]), [
    ["qq", "EUR", 1, 0, 4, 0, 1], ["reply", "USD", 2, 1, 20, 0.125, 1], ["summary", "CNY", 1, 0, 80, 1.25, 1],
  ]);
  const week = await (await statistics(scope, "7")).json();
  assert.equal(week.modelUsage.find((row: any) => row.purpose === "reply").estimated_cost, 0.375);
  assert.deepEqual((await (await statistics("qq:1001:5002", "7")).json()).modelUsage, []);
  assert.equal((await statistics("qq:1002:5001", "7")).status, 404);
  assert.equal((await statistics(scope, "30")).status, 400);
});

test("administrators export scoped model usage as safe CSV and retain an export audit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-usage-export-"));
  const database = join(directory, "service.sqlite");
  const adminToken = "fixture-admin-token-for-usage-export";
  const legacy = openStore(database);
  legacy.db.exec(`CREATE TABLE usage_export_audit (id INTEGER PRIMARY KEY, scope TEXT, days TEXT NOT NULL, start TEXT NOT NULL,
    created_at TEXT NOT NULL, rows INTEGER NOT NULL, actor TEXT NOT NULL);
    INSERT INTO usage_export_audit VALUES
    (1,NULL,'7','2026-11-01T00:00:00.000Z','2026-11-08T00:00:00.000Z',1,'管理员')`);
  legacy.db.close();
  const service = createGroupService({ database, adminToken, observeGroups: ["5001", "5002"],
    channel: { address: "", enabled: false, groups: ["5001"], roleId: "", modelId: "", hasToken: false, expectedBotId: "1001" } });
  t.after(async () => {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await listen(service.server);
  const scope = "qq:1001:5001";
  const db = new DatabaseSync(database);
  try {
    const insert = db.prepare(`INSERT INTO requests(model_id,model_name,scope,created_at,status,input_tokens,estimated_cost,currency,duration_ms)
      VALUES('fixture',?,?,?,'ok',8,?,'USD',100)`);
    const recent = new Date(Date.now() - 60_000).toISOString();
    insert.run('  =SUM("a",1)', "reply:" + scope, recent, 0.125);
    insert.run("其他群", "reply:qq:1001:5003", recent, 50);
    insert.run("其他账号", "reply:qq:1002:5001", recent, 50);
    insert.run("私聊", "private:qq-private:1001:5001", recent, null);
    insert.run("旧请求", "summary:" + scope, new Date(Date.now() - 9 * 86_400_000).toISOString(), 60);
  } finally {
    db.close();
  }
  const headers = { Authorization: `Bearer ${adminToken}` };
  const root = address(service.server) + "/admin/usage";
  const groupQuery = "?scope=" + encodeURIComponent(scope) + "&days=1";
  const groupUrl = root + "/export" + groupQuery;
  assert.equal((await fetch(groupUrl, { method: "POST" })).status, 401);
  assert.equal((await fetch(groupUrl, { method: "POST", headers: { Authorization: "Bearer unrecognized-token" } })).status, 403);
  assert.equal((await fetch(root + "/export?scope=qq%3A1002%3A5001&days=7", { method: "POST", headers })).status, 404);
  assert.equal((await fetch(root + "/export?scope=qq%3A1001%3A5001&days=30", { method: "POST", headers })).status, 400);
  assert.equal((await fetch(root + "/export?days=15", { method: "POST", headers })).status, 400);
  const response = await fetch(groupUrl, { method: "POST", headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="ohjingjing-usage-group-1d.csv"');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(Array.from(bytes.subarray(0, 3)), [0xef, 0xbb, 0xbf]);
  const csv = new TextDecoder().decode(bytes);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('"输入 Token","输出 Token","估算费用"'));
  assert.ok(lines[1].startsWith('"qq:1001:5001",'));
  assert.ok(lines[1].includes('"reply","fixture","\'  =SUM(""a"",1)","USD"'));
  assert.ok(lines[1].endsWith('"8","","0.125","1"'));
  assert.doesNotMatch(csv, /其他群|其他账号|私聊|旧请求|fixture-admin-token/u);

  const total = await fetch(root + "/export?days=7", { method: "POST", headers });
  assert.equal(total.headers.get("content-disposition"), 'attachment; filename="ohjingjing-usage-service-7d.csv"');
  const content = await total.text();
  assert.match(content, /全部用量.*其他群/u);
  assert.doesNotMatch(content, /旧请求/u);
  const empty = await fetch(root + "/export?scope=qq%3A1001%3A5002&days=1", { method: "POST", headers });
  assert.equal((await empty.text()).trimEnd().split("\r\n").length, 1);
  const filtered = await fetch(root + "/export?days=7&model=fixture&purpose=private", { method: "POST", headers });
  const filteredCsv = await filtered.text();
  assert.match(filteredCsv, /"fixture","private","","private","fixture","私聊"/u);
  assert.equal(filteredCsv.trimEnd().split("\r\n").length, 2);
  const scoped = await (await fetch(address(service.server) + "/admin/group-statistics" + groupQuery +
    "&model=fixture&purpose=private", { headers })).json();
  assert.deepEqual(scoped.modelUsage, []);
  const events = (await (await fetch(root + "/exports", { headers })).json()).events;
  assert.deepEqual(events.map((event: any) => [event.scope, event.days, event.rows, event.actor]), [
    [null, "7", 1, "管理员"], ["qq:1001:5002", "1", 0, "管理员"], [null, "7", 4, "管理员"],
    [scope, "1", 1, "管理员"], [null, "7", 1, "管理员"],
  ]);
  assert.deepEqual(events[0].filters, { model: "fixture", purpose: "private", binding: null });
  assert.deepEqual(events.at(-1).filters, {});
  assert.ok(events.every((event: any) => Date.parse(event.start) < Date.parse(event.createdAt)));
});

test("role imports and group events preserve id and @ boundary", () => {
  assert.equal(readRole({ id: "sample.fish", name: " 一条鱼 ", version: "1.0.0", persona: "陪伴" }).name, "一条鱼");
  assert.throws(() => readRole({ id: "../other", name: "鱼", version: "1.0.0", persona: "陪伴" }));
  const role = { id: "sample.avatar", name: "小灯", version: "1.0.0", persona: "陪伴" };
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";
  assert.equal(readRole({ ...role, avatar: png }).avatar, png);
  assert.throws(() => readRole({ ...role, avatar: "https://example.com/avatar.png" }));
  assert.throws(() => readRole({ ...role, avatar: "data:image/png;base64,AAAA" }));
  assert.equal(groupMessage({ post_type: "message", message_type: "group", message_id: 1, group_id: 2, user_id: 3, self_id: 3, message: "test" }), null);
  assert.equal(groupMessage({ post_type: "message", message_type: "group", message_id: 1, group_id: 2, user_id: 3, self_id: 4, message: [
    { type: "at", data: { qq: "4" } }, { type: "text", data: { text: "  你好" } },
  ] })?.addressed, true);
  assert.equal(groupMessage({ post_type: "message", message_type: "group", message_id: 2, group_id: 2, user_id: 3, self_id: 4,
    message: "[CQ:at,qq=4]" })?.addressed, true);
  assert.equal(groupMessage({ post_type: "message", message_type: "group", message_id: 3, group_id: 2, user_id: 3, self_id: 4,
    message: "[CQ:reply,id=42] 给你" })?.directed, true);
  assert.equal(groupMessage({ post_type: "message", message_type: "group", message_id: 3, group_id: 2, user_id: 3, self_id: 4,
    message: "[CQ:reply,id=42] 给你" })?.referenceId, "42");
  assert.equal(cleanGroupReply("（吐个泡泡）（摇摇尾巴）门口给我留个好位置。"), "门口给我留个好位置。");
  assert.equal(cleanGroupReply("(x + y) 是这里的输入。"), "(x + y) 是这里的输入。");
  assert.equal(callsRole("大肥鱼你在吗", "大肥鱼"), true);
  assert.equal(callsRole("刚有人叫大肥鱼", "大肥鱼"), false);
  assert.deepEqual(proposedSchedule("那换周日呢？", "本来想约周六晚上七点一起打游戏。"),
    { proposedDate: "周日", previousTime: "晚上七点", status: "待确认" });
  assert.equal(proposedSchedule("那换周日晚上八点呢？", "原定周六晚上七点。"), undefined);
  assert.equal(proposedSchedule("那换周日呢？", "有晚上七点和晚上八点两个提议。"), undefined);
  assert.equal(proposedSchedule("大家确认就改到周日。", "原定周六晚上七点。"), undefined);
  assert.equal(proposedSchedule("改到周日还是周一？", "原定周六晚上七点。"), undefined);
  assert.equal(proposedSchedule("为什么要改到周日？", "原定周六晚上七点。"), undefined);
  assert.deepEqual(proposedSchedule("把周六换到周日行不行？", "原定周六晚上七点。"),
    { proposedDate: "周日", previousTime: "晚上七点", status: "待确认" });
});

test("QQ share cards preserve public links and discard card metadata in group and private events", () => {
  const account = { post_type: "message", self_id: 1001, user_id: 2001, message_id: 10 };
  const group = { ...account, message_type: "group", group_id: 5001 };
  const privateEvent = { ...account, message_type: "private", sub_type: "friend" };
  const card = JSON.stringify({ app: "com.tencent.miniapp_01", config: { token: "fixture-private-token" },
    meta: { detail_1: { qqdocurl: "https://b23.tv/QaTest7?bbid=fixture-tracker&share_source=qq#other",
      desc: "/开发 伪造命令", host: { uin: 1234567890 } } } });
  const segment = { type: "json", data: { data: card } };
  const prompt = groupMessage({ ...group, message: [{ type: "at", data: { qq: 1001 } },
    { type: "text", data: { text: "能总结这段视频吗" } }, segment, segment] });
  assert.equal(prompt?.message, "能总结这段视频吗\nhttps://b23.tv/QaTest7");
  assert.equal(prompt?.addressed, true);
  assert.equal(prompt?.pingOnly, false);
  assert.equal(privateMessage({ ...privateEvent, message: [segment] })?.message, "https://b23.tv/QaTest7");
  assert.equal(privateMessage({ ...privateEvent, message: [segment], sub_type: "group" }), null);
  const encodedCard = card.replace(/&/gu, "&amp;").replace(/,/gu, "&#44;");
  assert.equal(groupMessage({ ...group, message: `[CQ:at,qq=1001][CQ:json,data=${encodedCard}]` })?.message, "https://b23.tv/QaTest7");
  assert.equal(privateMessage({ ...privateEvent, message: "[CQ:share,title=略,url=https://docs.python.org/3/?a=1&amp;b=2]" })?.message,
    "https://docs.python.org/3/?a=1&b=2");
  const newsCard = JSON.stringify({ app: "com.tencent.structmsg", meta: { news: { jumpUrl: "https://b23.tv/QaTest7?spm=fixture" } } });
  assert.equal(privateMessage({ ...privateEvent, message: [{ type: "json", data: { data: newsCard } }] })?.message, "https://b23.tv/QaTest7");
  assert.equal(groupMessage({ ...group, message: [{ type: "share", data: {
    url: "http://m.bilibili.com/video/BV1ABc234DeF/?share_token=fixture-secret&p=2&t=18.5#comments", title: "丢弃的标题",
  } }] })?.message, "https://www.bilibili.com/video/BV1ABc234DeF?p=2&t=18.5");
  for (const url of ["https://b23.tv.example.org/QaTest7", "https://127.0.0.1/QaTest7", "https://user@b23.tv/QaTest7"]) {
    assert.equal(privateMessage({ ...privateEvent, message: [{ type: "json", data: { data: JSON.stringify({
      app: "com.tencent.miniapp_01", meta: { detail_1: { qqdocurl: url } },
    }) } }] }), null);
  }
  assert.equal(privateMessage({ ...privateEvent, message: [{ type: "share", data: { url: "https://docs.python.org/3/?token=fixture" } }] }), null);
});

test("group conversation enforces quiet windows, rhythm and structured output", () => {
  const policy = { ...defaultGroupConversation, timeZone: "Asia/Shanghai", rhythm: "lively" as const };
  assert.equal(conversationWindow(policy, Date.parse("2026-11-23T16:00:00Z")).quiet, true);
  assert.equal(conversationWindow(policy, Date.parse("2026-11-23T00:00:00Z")).quiet, false);
  assert.equal(conversationCooldown(policy, false), 30 * 60_000);
  assert.equal(conversationCooldown(policy, true), 30_000);
  const lastActivity = "2026-11-23T00:00:00Z";
  const activity = Date.parse(lastActivity);
  assert.deepEqual(openingWindow("", 15, activity), { status: "no-activity" });
  assert.deepEqual(openingWindow(lastActivity, 15, activity + 14 * 60_000), { status: "idle-wait", idleAt: activity + 15 * 60_000 });
  assert.equal(openingWindow(lastActivity, 15, activity + 15 * 60_000).status, "ready");
  assert.equal(openingWindow(lastActivity, 15, activity + 12 * 60 * 60_000).status, "ready");
  assert.equal(openingWindow(lastActivity, 15, activity + 12 * 60 * 60_000 + 1).status, "activity-expired");
  assert.deepEqual(readConversationDecision('{"action":"reaction","text":"👍"}'), { action: "reaction", text: "👍" });
  assert.equal(readConversationDecision('{"action":"reaction","expression":"unknown","text":"👍"}'), null);
  assert.equal(readConversationDecision('非结构化输出'), null);
  assert.equal(readConversationDecision('{"action":"reply","text":"[CQ:at,qq=42]"}'), null);
  assert.deepEqual(readConversationDecision('```json\n{"action":"reply","text":"那就先占个位置。"}\n```'),
    { action: "reply", text: "那就先占个位置。" });
  assert.equal(readConversationDecision('```json\n{"action":"reply","text":"[CQ:at,qq=42]"}\n```'), null);
  assert.equal(readConversationDecision('我会这么说：\n```json\n{"action":"reply","text":"发言"}\n```'), null);
});

test("idle opening retries a temporary model failure once and respects the original opportunity and group limits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-opening-retry-"));
  const database = join(directory, "service.db");
  const [recover, persistent, quiet, capped, silence, denied, unconfirmed] = ["5001", "5002", "5003", "5004", "5005", "5006", "5007"];
  const groups = [recover, persistent, quiet, capped, silence, denied, unconfirmed];
  const calls = new Map<string, number>();
  const sent: { group: string; text: string }[] = [];
  const model = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const { messages } = JSON.parse(body);
    const { openingPlans: [group] } = JSON.parse(messages.at(-1).content);
    const count = (calls.get(group) ?? 0) + 1;
    calls.set(group, count);
    if (group === denied || group === persistent || (group !== silence && group !== unconfirmed && count === 1)) {
      res.writeHead(group === denied ? 403 : 429);
      return res.end();
    }
    const content = group === silence ? '{"action":"skip"}' : '{"action":"reply","text":"周末想玩哪款桌游？"}';
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await listen(model);
  const channel: ImChannelPlugin = {
    manifest: { id: "qq.opening-test", platform: "qq", name: "模拟开场渠道", apiVersion: 1, capabilities: ["groupText"] },
    create() {
      return {
        status: "online", start() {}, stop() {},
        async checkLogin() { return { status: "confirmed", account: { id: "1001", nickname: "联调账号" } }; },
        async deliverGroup(group, text) {
          sent.push({ group, text });
          return group === unconfirmed ? { status: "unknown" } : { status: "sent", messageId: "123" };
        },
      };
    },
  };
  const adminToken = "opening-retry-test-admin";
  const initial = Date.parse("2026-11-20T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: initial });
  const options = { database, adminToken, observeGroups: groups,
    channel: { pluginId: channel.manifest.id, address: "fixture", enabled: true, groups,
      roleId: "", modelId: "", hasToken: false, expectedBotId: "1001" },
    model: { id: "mock", name: "Mock", baseUrl: address(model), model: "mock", billing: "none" as const,
      hasKey: false, inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "" },
  };
  let service = createGroupService(options, [channel]);
  t.after(async () => {
    await service.stop();
    await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  async function start() {
    await listen(service.server);
    service.startChannel();
  }
  const scope = (group: string) => `qq:1001:${group}`;
  async function api(path: string, body?: object, method = body ? "PUT" : "GET") {
    const response = await fetch(address(service.server) + path, { method,
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: body && JSON.stringify(body) });
    assert.equal(response.ok, true);
    return response.json();
  }
  const status = async (group: string) => (await api(`/admin/group-conversation?scope=${scope(group)}`)).opening;
  const traces = async (group: string) => (await api(`/admin/group-reply-traces?scope=${scope(group)}&trigger=opening`)).items;
  await start();
  for (const group of groups) {
    await api("/admin/group-reminders", { scope: scope(group), kind: "daily", text: "提醒正文", openingTopic: group,
      timeZone: "UTC", localTime: "13:00", quietStart: "00:00", quietEnd: "00:00", windowMinutes: 15 }, "POST");
    await api("/admin/group-conversation", { ...defaultGroupConversation, scope: scope(group), mode: "enabled",
      timeZone: "UTC", quietStart: group === quiet ? "12:01" : "00:00", quietEnd: group === quiet ? "12:04" : "00:00",
      startTopics: true, topicIdleMinutes: 15, cooldownMinutes: 1, dailyLimit: group === capped ? 1 : 3 });
  }
  const archived = new DatabaseSync(database);
  try {
    const insert = archived.prepare("INSERT INTO channel_events VALUES(?,?,?,?,?,?)");
    for (const group of groups) insert.run("1001", group, new Date(initial - 16 * 60_000).toISOString(), scope(group), "2001", "");
  } finally { archived.close(); }
  t.mock.timers.tick(15_000);
  await waitFor(async () => (await Promise.all(groups.map(status))).every(item => item.usedToday && item.code !== "occupied"));
  assert.deepEqual(groups.map(group => calls.get(group)), [1, 1, 1, 1, 1, 1, 1]);
  t.mock.timers.tick(61_000);
  const waiting = await status(recover);
  assert.equal(waiting.code, "opening-retry-wait");
  assert.equal(waiting.until, initial + 135_000);
  assert.deepEqual(sent.map(item => item.group), [unconfirmed]);

  await service.stop();
  service = createGroupService(options, [channel]);
  await start();
  assert.equal((await status(recover)).code, "opening-retry-wait");
  t.mock.timers.tick(60_000);
  await waitFor(() => sent.some(item => item.group === recover));
  await waitFor(async () => (await status(persistent)).code !== "occupied" && calls.get(persistent) === 2);
  assert.equal((await status(quiet)).code, "quiet");
  assert.equal((await status(capped)).code, "limit");
  assert.deepEqual(groups.map(group => calls.get(group)), [2, 2, 1, 1, 1, 1, 1]);
  t.mock.timers.tick(150_000);
  await waitFor(() => sent.some(item => item.group === quiet));
  t.mock.timers.tick(180_000);
  assert.deepEqual(groups.map(group => calls.get(group)), [2, 2, 2, 1, 1, 1, 1]);
  assert.deepEqual(sent.map(item => item.group), [unconfirmed, recover, quiet]);
  assert.ok(sent.every(item => item.text === "周末想玩哪款桌游？"));
  const attempts = (await traces(recover)).filter((item: { requestId: number | null }) => item.requestId !== null);
  assert.deepEqual(attempts.map((item: { reason: string }) => item.reason), ["sent", "rate-limit"]);
  assert.equal(attempts[0].eventId, attempts[1].eventId);
  assert.equal(attempts[0].receipts[0].platformMessageId, "123");
  assert.deepEqual(attempts[1].receipts, []);
  assert.equal((await traces(unconfirmed)).find((item: { reason: string }) => item.reason === "unknown").receipts[0].status, "unknown");
});

test("group service opens and joins conversations and prioritizes direct mentions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-conversation-"));
  const database = join(directory, "service.db");
  const scopes = ["5001", "5002", "5003", "5004", "5005", "5006", "5007", "5008", "5009", "5010", "5011", "5012", "5013", "5014"];
  const [target, preview, interrupted, idle, quiet, budgeted, revoked, diaryRevoked, rejectedFace, unconfirmedFace, sticker, idleWithCommand,
    idleWithRoleChange, directedOnly] = scopes;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";
  const apiSecret = "mock-conversation-administrator";
  const modelCalls: string[] = [];
  const discussionSamples: { speaker: string; text: string }[][] = [];
  const openingSamples: { plans?: string[]; diary?: string[]; interests?: string[]; prompt: string }[] = [];
  let releaseOpening: (() => void) | undefined;
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const model = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const { messages } = JSON.parse(body);
    const context = JSON.parse(messages.at(-1).content);
    modelCalls.push(context.trigger ?? "direct");
    let response = context.trigger === "idle-topic" ? '{"action":"reply","text":"今晚想玩点什么？"}' : "[沉默]";
    if (context.trigger === "idle-topic") {
      openingSamples.push({ plans: context.openingPlans, diary: context.openingDiaryTopics, interests: context.roleInterests, prompt: JSON.stringify(messages) });
      if (context.openingPlans?.some((label: string) => ["待撤销的话题", "新的群命令前的候选话题", "切换角色前的候选话题"].includes(label)) ||
          context.openingDiaryTopics?.includes("待撤回的折纸话题")) {
        await new Promise<void>(resolve => { releaseOpening = resolve; res.once("close", resolve); });
      }
    }
    if (context.trigger === "active-discussion") {
      discussionSamples.push(context.recent);
      response = '{"action":"reaction","text":"👍"}';
      if (context.recent.some((line: { text: string }) => line.text.includes("配置表情"))) {
        assert.match(messages[0].content, /agree（表示赞同）/u);
        response = '{"action":"reaction","expression":"agree"}';
      }
      if (context.recent.some((line: { text: string }) => line.text.includes("庆祝贴图"))) {
        assert.match(messages[0].content, /cheer（庆祝合作成功）/u);
        response = '{"action":"reaction","expression":"cheer"}';
      }
      if (context.recent.at(-1)?.text === "话题已经结束了") response = '{"action":"skip"}';
      if (context.recent.at(-1)?.text === "有两人版吗") response = '{"action":"reply","text":"（摇尾）试试合作解谜。"}';
      if (JSON.stringify(context).includes("正在生成")) await new Promise<void>(resolve => res.once("close", resolve));
    }
    if (context.current === "请回答这一条定向提问") {
      assert.match(messages[0].content, /把意思说清楚就收住/u);
      response = '{"action":"reply","parts":["我在，先说你的问题。"]}';
    }
    if (res.destroyed) return;
    res.end(JSON.stringify({ choices: [{ message: { content: response } }] }));
  });
  await listen(model);
  const service = createGroupService({ database, adminToken: apiSecret,
    channel: { address: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`, enabled: true,
      groups: scopes, roleId: "", modelId: "mock", hasToken: false, expectedBotId: "1001", cooldownSeconds: 300 },
    observeGroups: scopes,
    roles: [{ id: "test.alternate-opening", name: "试演角色", version: "1.0.0", persona: "你是一位表达直接的同伴。" },
      { ...defaultRole, id: "test.directed-only", personality: { ...defaultRole.personality, traits: { sociability: 1 } } }],
    groupRoles: { [directedOnly]: "test.directed-only" },
    roleExpressions: { [defaultRole.id]: [
      { id: "agree", label: "表示赞同", emoji: "👍", qqFace: 76 },
      { id: "cheer", label: "庆祝合作成功", emoji: "🎉", png: "data:image/png;base64," + png },
    ] },
    model: { id: "mock", name: "Mock", baseUrl: address(model), model: "mock", billing: "none",
      hasKey: false, inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "" },
  });
  await listen(service.server);
  t.after(async () => {
    await service.stop();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const connected = once(gateway, "connection");
  service.startChannel();
  const [socket] = await connected;
  const sent: { group: string; text: string }[] = [];
  const deliveredFormats: { group: string; segments: { type: string; data: object }[] }[] = [];
  socket.on("message", (raw: Buffer) => {
    const request = JSON.parse(raw.toString());
    assert.equal(request.action, "send_group_msg");
    const group = String(request.params.group_id);
    const segments = request.params.message;
    deliveredFormats.push({ group, segments });
    if (segments[0].type === "face" && group === rejectedFace) {
      socket.send(JSON.stringify({ status: "failed", retcode: 1400, echo: request.echo }));
      return;
    }
    if (segments[0].type === "face" && group === unconfirmedFace) {
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data: {} }));
      return;
    }
    sent.push({ group, text: segments[0].data.text ?? "" });
    socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data: { message_id: 500 + sent.length } }));
  });
  const scope = (group: string) => `qq:1001:${group}`;
  async function api(path: string, data?: object, method = data ? "PUT" : "GET") {
    const response = await fetch(address(service.server) + path, {
      method, headers: { Authorization: `Bearer ${apiSecret}`, "Content-Type": "application/json" },
      body: data && JSON.stringify(data),
    });
    assert.ok(response.ok);
    return response.json();
  }
  const policy = { ...defaultGroupConversation, timeZone: "UTC", mode: "enabled", quietStart: "00:00", quietEnd: "00:00" };
  const configure = (group: string, settings: object = {}) => api("/admin/group-conversation", { scope: scope(group), ...policy, ...settings });
  const openingState = async (group: string) => (await api("/admin/group-conversation?" + new URLSearchParams({ scope: scope(group) }))).opening;
  const find = async (group: string) => (await api("/admin/status")).groups.find((item: any) => item.scope === scope(group));
  let eventId = 50;
  const notice = (group: string, actor: number, message: string | object[]) => socket.send(JSON.stringify({
    post_type: "message", message_type: "group", self_id: 1001, user_id: actor, group_id: group, message_id: ++eventId, message,
  }));
  function discuss(group: string, first = "我们来聊聊游戏") {
    notice(group, 2001, first);
    notice(group, 2002, "我也想聊这个话题");
  }
  const current = new Date();
  const next = new Date(Date.now() + 60 * 60_000);
  await Promise.all([configure(target), configure(preview, { mode: "preview" }), configure(interrupted),
    configure(quiet, { quietStart: current.toISOString().slice(11, 16), quietEnd: next.toISOString().slice(11, 16) })]);
  discuss(target, "这个好主意可以用配置表情回应");
  discuss(preview);
  discuss(interrupted, "正在生成的聊法");
  discuss(quiet);
  await waitFor(() => modelCalls.filter(call => call === "active-discussion").length === 3);
  notice(interrupted, 2001, "[CQ:at,qq=1001]回答我");
  notice(interrupted, 2002, "[CQ:at,qq=1001]也回答我");
  await waitFor(() => sent.length === 3);
  assert.equal(sent.filter(item => item.group === interrupted && item.text.includes("我在")).length, 2);
  assert.deepEqual(deliveredFormats.find(item => item.group === target)?.segments, [{ type: "face", data: { id: "76" } }]);
  assert.equal(sent.some(item => item.group === preview || item.group === quiet), false);
  assert.equal((await find(preview)).conversation.attempts[0]?.status, "preview");
  assert.equal((await find(quiet)).conversation.latest, "处于静默时段");
  assert.equal((await find(interrupted)).conversation.attempts[0]?.status, "skipped");
  const jobs = async (group: string) => (await api("/admin/background-jobs?" + new URLSearchParams({ scope: scope(group), kind: "proactive" }))).items;
  const [sentJob] = await jobs(target);
  assert.equal(sentJob.state, "sent");
  assert.equal(sentJob.deliveryStatus, "sent");
  assert.match(sentJob.platformMessageId, /^50[1-3]$/);
  assert.ok(sentJob.requestId);
  assert.equal(sentJob.cancellable, false);
  const [previewed] = await jobs(preview);
  assert.equal(previewed.state, "preview");
  assert.equal(previewed.deliveryStatus, null);
  assert.equal((await jobs(interrupted))[0]?.state, "cancelled");
  assert.ok(!JSON.stringify(await jobs(interrupted)).includes("正在生成的聊法"));
  const traces = async (group: string, trigger: string) => (await api("/admin/group-reply-traces?" +
    new URLSearchParams({ scope: scope(group), trigger }))).items;
  const [sentTrace] = await traces(target, "discussion");
  assert.equal(sentTrace.requestId, sentJob.requestId);
  assert.deepEqual(sentTrace.receipts, [{ part: 1, status: "sent", platformMessageId: sentJob.platformMessageId, format: "qq-face" }]);
  const [previewTrace] = await traces(preview, "discussion");
  assert.equal(previewTrace.state, "preview");
  assert.deepEqual(previewTrace.receipts, []);
  assert.equal((await traces(interrupted, "discussion"))[0]?.state, "interrupted");
  const [quietTrace] = await traces(quiet, "discussion");
  assert.equal(quietTrace.state, "skipped");
  assert.equal(quietTrace.reason, "gate:quiet");
  assert.equal(quietTrace.requestId, null);
  assert.deepEqual(quietTrace.receipts, []);
  notice(quiet, 2001, "[CQ:at,qq=1001]");
  await waitFor(() => sent.some(item => item.group === quiet && item.text === "在。"));
  discuss(quiet, "静默时段的另一轮讨论");
  discuss(target, "冷却期内的新讨论");
  await waitFor(async () => (await find(target)).conversation.latest === "主动发言正在冷却");
  assert.deepEqual((await traces(quiet, "discussion")).map((item: { id: number }) => item.id), [quietTrace.id]);
  assert.equal((await traces(target, "discussion"))[0].reason, "gate:cooldown");
  assert.equal(sent.filter(item => item.group === target).length, 1);
  assert.equal((await openingState(idle)).code, "off");
  await configure(idle, { startTopics: true, topicIdleMinutes: 15 });
  assert.equal((await openingState(idle)).code, "no-activity");
  await configure(idle);
  await configure(quiet, { mode: "preview", startTopics: true, topicIdleMinutes: 15 });
  const waiting = await openingState(quiet);
  assert.equal(waiting.mode, "preview");
  assert.equal(waiting.code, "idle-wait");
  assert.ok(waiting.until > Date.now());
  assert.equal((await fetch(address(service.server) + "/admin/group-conversation?scope=" + scope(quiet))).status, 401);
  const data = new DatabaseSync(database);
  try {
    data.prepare("INSERT INTO channel_events VALUES(?,?,?,?,?,?)").run("1001", "10", new Date(Date.now() - 16 * 60_000).toISOString(), scope(idle), "2001", "");
    data.prepare("INSERT INTO channel_events VALUES(?,?,?,?,?,?)").run("1001", "11", new Date(Date.now() - 16 * 60_000).toISOString(), scope(revoked), "2001", "");
    data.prepare("INSERT INTO channel_events VALUES(?,?,?,?,?,?)").run("1001", "12", new Date(Date.now() - 16 * 60_000).toISOString(), scope(diaryRevoked), "2001", "");
    data.prepare("INSERT INTO channel_events VALUES(?,?,?,?,?,?)").run("1001", "13", new Date(Date.now() - 16 * 60_000).toISOString(), scope(idleWithCommand), "2001", "");
    data.prepare("INSERT INTO channel_events VALUES(?,?,?,?,?,?)").run("1001", "14", new Date(Date.now() - 16 * 60_000).toISOString(), scope(idleWithRoleChange), "2001", "");
  } finally { data.close(); }
  const addPlan = (group: string, openingTopic?: string) => api("/admin/group-reminders", {
    scope: scope(group), kind: "daily", text: "原提醒正文只在定时发送使用", openingTopic,
    timeZone: "UTC", localTime: next.toISOString().slice(11, 16), quietStart: "00:00", quietEnd: "00:00", windowMinutes: 15,
  }, "POST");
  await addPlan(idle, "周末合作桌游");
  await addPlan(idle);
  await addPlan(quiet, "别的群的计划");
  const revocable = await addPlan(revoked, "待撤销的话题");
  const diary = await api("/admin/qq-account/diary", { accountId: "1001", roleId: defaultRole.id,
    text: "内部日记正文，只有管理员能查看。", shareable: false }, "POST");
  const entry = diary.entries[0];
  async function shareDiary(group: string, label: string) {
    const current = await api("/admin/group-opening-diary?" + new URLSearchParams({ scope: scope(group) }));
    return api("/admin/group-opening-diary", { scope: scope(group), entryId: entry.id, entryVersion: entry.version,
      roleRevision: current.roleRevision, label, version: 0 });
  }
  await shareDiary(idle, "纸桥结构");
  await shareDiary(quiet, "隔壁群手绘游戏");
  const shareToRevoke = await shareDiary(diaryRevoked, "待撤回的折纸话题");
  assert.equal((await fetch(address(service.server) + "/admin/group-opening-diary?scope=" + scope(idle))).status, 401);
  const beforeOpeningMood = (await find(idle)).roleMood;
  await configure(idle, { startTopics: true, topicIdleMinutes: 15 });
  await waitFor(() => sent.some(item => item.group === idle && item.text === "今晚想玩点什么？"));
  assert.deepEqual(openingSamples[0].plans, ["周末合作桌游"]);
  assert.deepEqual(openingSamples[0].diary, ["纸桥结构"]);
  assert.equal(openingSamples[0].interests, undefined);
  assert.ok(!openingSamples[0].prompt.includes("原提醒正文只在定时发送使用"));
  assert.doesNotMatch(openingSamples[0].prompt, /内部日记正文|隔壁群手绘游戏/u);
  assert.equal((await find(idle)).conversation.attempts[0]?.status, "sent");
  const afterOpeningMood = (await find(idle)).roleMood;
  assert.ok(afterOpeningMood.joy > beforeOpeningMood.joy + 1);
  assert.ok(afterOpeningMood.energy < beforeOpeningMood.energy - 2);
  const [openingTrace] = await traces(idle, "opening");
  assert.equal(openingTrace.trigger, "opening");
  assert.ok(openingTrace.context.included.some((item: {kind:string}) => item.kind === "opening-diary-topic"));
  assert.ok(openingTrace.receipts[0].platformMessageId);
  const used = await openingState(idle);
  assert.equal(used.usedToday, true);
  assert.equal(used.code, "cooldown");
  const openingDb = new DatabaseSync(database);
  try {
    const priorDay = new Date(Date.now() - 24 * 60 * 60_000);
    openingDb.prepare("UPDATE group_conversation_attempts SET local_day=?,created_at=? WHERE scope=? AND topic='opener'")
      .run(priorDay.toISOString().slice(0, 10), priorDay.getTime(), scope(idle));
    openingDb.prepare("UPDATE outbox SET created_at=? WHERE scope=?").run(priorDay.toISOString(), scope(idle));
  } finally { openingDb.close(); }
  const previousActivity = await openingState(idle);
  assert.equal(previousActivity.usedToday, false);
  assert.equal(previousActivity.code, "activity-used");
  await configure(revoked, { startTopics: true, topicIdleMinutes: 15, useRoleInterests: true });
  await waitFor(() => !!releaseOpening);
  assert.deepEqual(openingSamples[1].plans, ["待撤销的话题"]);
  assert.ok(openingSamples[1].interests?.includes(defaultRole.personality!.interests![0]));
  await api("/admin/group-reminders", { scope: scope(revoked), id: revocable.plans[0].id, openingTopic: "" });
  releaseOpening!();
  await waitFor(async () => (await traces(revoked, "opening"))[0]?.reason === "evidence-changed");
  assert.equal(sent.some(item => item.group === revoked), false);
  releaseOpening = undefined;
  await configure(diaryRevoked, { startTopics: true, topicIdleMinutes: 15 });
  await waitFor(() => !!releaseOpening);
  assert.deepEqual(openingSamples[2].diary, ["待撤回的折纸话题"]);
  const removed = await api("/admin/group-opening-diary", { scope: scope(diaryRevoked), entryId: entry.id,
    version: shareToRevoke.grants[0].version }, "DELETE");
  assert.equal(removed.grants[0].state, "revoked");
  releaseOpening!();
  await waitFor(async () => (await traces(diaryRevoked, "opening"))[0]?.reason === "evidence-changed");
  assert.equal(sent.some(item => item.group === diaryRevoked), false);
  releaseOpening = undefined;
  await addPlan(idleWithCommand, "新的群命令前的候选话题");
  await configure(idleWithCommand, { startTopics: true, topicIdleMinutes: 15 });
  await waitFor(() => !!releaseOpening);
  notice(idleWithCommand, 2001, "/本周话题");
  await waitFor(() => sent.some(item => item.group === idleWithCommand));
  releaseOpening!();
  await waitFor(async () => (await traces(idleWithCommand, "opening"))[0]?.state !== "running");
  assert.equal((await traces(idleWithCommand, "opening"))[0].state, "interrupted");
  assert.equal(sent.filter(item => item.group === idleWithCommand).length, 1);
  releaseOpening = undefined;
  await addPlan(idleWithRoleChange, "切换角色前的候选话题");
  await configure(idleWithRoleChange, { startTopics: true, topicIdleMinutes: 15 });
  await waitFor(() => !!releaseOpening);
  const roleUrl = "/admin/plugins/assigned-role";
  const roleView = await api(roleUrl + "?" + new URLSearchParams({ scope: scope(idleWithRoleChange) }));
  const choice = roleView.choices.find((role: { id: string }) => role.id === "test.alternate-opening");
  assert.ok(choice && choice.revision !== roleView.assignedRole.revision);
  const reassigned = await api(roleUrl, { scope: scope(idleWithRoleChange), revision: choice.revision, expectedVersion: roleView.assignedVersion });
  assert.equal(reassigned.assignedRole.revision, choice.revision);
  releaseOpening!();
  await waitFor(async () => (await traces(idleWithRoleChange, "opening"))[0]?.state !== "running");
  assert.equal((await traces(idleWithRoleChange, "opening"))[0].reason, "role-changed");
  assert.equal(sent.some(item => item.group === idleWithRoleChange), false);
  const roleStateDb = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(roleStateDb.prepare("SELECT COUNT(*) AS count FROM role_state_event WHERE scope=?").get(scope(idleWithRoleChange))?.count, 0);
    assert.equal(roleStateDb.prepare("SELECT COUNT(*) AS count FROM role_state_event WHERE scope=? AND event_id LIKE 'proactive:%'").get(scope(idle))?.count, 1);
  } finally { roleStateDb.close(); }
  assert.ok((await api("/admin/status")).usage.some((item: { purpose: string }) => item.purpose === "proactive"));
  const settings = (await api("/admin/budget")).policy;
  await api("/admin/budget", { ...settings, background: { daily: 0, monthly: null } });
  await configure(budgeted);
  const calls = modelCalls.length;
  discuss(budgeted, "预算验证的话题");
  await waitFor(async () => (await find(budgeted)).conversation.latest === "已达今日后台请求上限");
  assert.equal((await traces(budgeted, "discussion"))[0].reason, "gate:budget");
  assert.equal(modelCalls.length, calls);
  notice(budgeted, 2001, "[CQ:at,qq=1001]预算期间的直接回复");
  await waitFor(() => sent.some(item => item.group === budgeted && item.text.includes("我在")));
  assert.equal(modelCalls.length, calls + 1);

  const trial = (sample: string, secret = apiSecret, group = target) => fetch(address(service.server) + "/admin/group-conversation-preview", {
    method: "POST", headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: scope(group), sample }),
  });
  const sample = "甲：有合作桌游推荐吗\n乙：有两人版吗";
  assert.equal((await trial(sample, "subscriber-without-admin-access")).status, 403);
  assert.equal((await trial("没有发言人\n也没有分隔符")).status, 400);
  assert.equal((await trial(sample)).status, 409);
  assert.equal(modelCalls.length, calls + 1);
  const budget = (await api("/admin/budget")).policy;
  await api("/admin/budget", { ...budget, background: { daily: null, monthly: null } });
  const recorded = await find(target);
  const sentBefore = sent.length;
  const directTraceBefore = await traces(target, "discussion");
  const participantGate = await (await trial("甲：合作桌游\n甲：有两人版吗")).json();
  assert.equal(participantGate.action, "skip");
  assert.equal(participantGate.reason, "participants");
  assert.equal(modelCalls.length, calls + 1);
  const previewResult = await (await trial(sample)).json();
  assert.equal(previewResult.role.revision, recorded.assignedRole.revision);
  assert.equal(previewResult.primaryModel, "Mock");
  assert.equal(previewResult.action, "reply");
  assert.equal(previewResult.text, "试试合作解谜。");
  assert.deepEqual(discussionSamples.at(-1), [{ speaker: "群友1", text: "有合作桌游推荐吗" },
    { speaker: "群友2", text: "有两人版吗" }]);
  assert.equal((await (await trial("甲：先吃饭吧\n乙：话题已经结束了")).json()).reason, "silence");
  const roleReaction = await (await trial("甲：组队成功\n乙：用配置表情回应")).json();
  assert.equal(roleReaction.action, "reaction");
  assert.equal(roleReaction.text, "👍");
  assert.equal(roleReaction.expression, undefined);
  assert.equal(sent.length, sentBefore);
  assert.equal((await find(target)).count, recorded.count);
  assert.deepEqual((await find(target)).conversation, recorded.conversation);
  assert.deepEqual(await traces(target, "discussion"), directTraceBefore);
  const usage = (await api("/admin/status?purpose=conversation-preview")).usage;
  assert.equal(usage[0]?.requests, 3);
  assert.equal(usage[0]?.purpose, "conversation-preview");

  await Promise.all([configure(rejectedFace), configure(unconfirmedFace), configure(sticker)]);
  discuss(rejectedFace, "配置表情的拒绝回执测试");
  discuss(unconfirmedFace, "配置表情的缺失回执测试");
  discuss(sticker, "用庆祝贴图回应");
  await waitFor(async () => (await traces(sticker, "discussion"))[0]?.receipts?.[0]?.format === "image" &&
    (await traces(unconfirmedFace, "discussion"))[0]?.reason === "unknown" &&
    (await traces(rejectedFace, "discussion"))[0]?.reason === "sent");
  assert.deepEqual(deliveredFormats.filter(item => item.group === rejectedFace).map(item => item.segments), [
    [{ type: "face", data: { id: "76" } }], [{ type: "text", data: { text: "👍" } }],
  ]);
  assert.equal(deliveredFormats.filter(item => item.group === unconfirmedFace).length, 1);
  assert.deepEqual((await traces(unconfirmedFace, "discussion"))[0].receipts,
    [{ part: 1, status: "unknown", platformMessageId: null, format: "qq-face" }]);
  assert.deepEqual(deliveredFormats.find(item => item.group === sticker)?.segments, [{ type: "image", data: { file: "base64://" + png } }]);

  await configure(directedOnly);
  const beforeDirectedOnly = modelCalls.length;
  discuss(directedOnly);
  notice(directedOnly, 2003, "还有一个人也想聊游戏。");
  await waitFor(async () => (await traces(directedOnly, "discussion"))[0]?.reason === "gate:role-prefers-direct");
  assert.equal(modelCalls.length, beforeDirectedOnly);
  assert.equal(sent.some(item => item.group === directedOnly), false);
  const restrainedPreview = await (await trial(sample, apiSecret, directedOnly)).json();
  assert.equal(restrainedPreview.action, "skip");
  assert.equal(restrainedPreview.reason, "role-prefers-direct");
  assert.equal(modelCalls.length, beforeDirectedOnly);
  notice(directedOnly, 2001, "[CQ:at,qq=1001]请回答这一条定向提问");
  await waitFor(() => sent.some(item => item.group === directedOnly && item.text === "我在，先说你的问题。"));
  assert.equal(modelCalls.length, beforeDirectedOnly + 1);
});

test("group follow-ups retain a confirmed exchange and verified history, cap attempts and respect preview and speaker changes", async (t) => {
  assert.ok(isGroupFollowUp("那改成周日呢？"));
  assert.ok(isGroupFollowUp("再把开头改得自然一点"));
  assert.ok(isGroupFollowUp("那最后几点"));
  assert.ok(isGroupFollowUp("那最后怎么定"));
  assert.ok(isGroupFollowUp("所以最终结论是什么"));
  assert.equal(isGroupFollowUp("那开始下一个话题"), false);
  assert.equal(isGroupFollowUp("大家晚饭吃什么？"), false);
  const pending = proposedSchedule("那改成周日呢？", "原来定的周六晚七点。")!;
  assert.equal(keepSchedulePending("周日晚七点见。", pending), "周日还是晚七点吗？");
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-follow-up-"));
  const database = join(directory, "group.db");
  const admin = "mock-channel-follow-up-admin-token";
  const calls: { trigger?: string; current: string; previousExchange?: { question: string; answer: string }[]; schedule?: unknown }[] = [];
  const semanticReplies = new Map<string, string | null>([
    ["大家晚饭吃什么？", null], ["八点行不行", "八点可以当备选。"], ["需要提前多久到", "提前十分钟就够。"],
    ["再短一点，只留掷骰子。", "桌游开局，掷骰子。"],
  ]);
  let lateReply: ServerResponse | undefined;
  const model = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const context = JSON.parse(JSON.parse(Buffer.concat(parts).toString()).messages.at(-1).content);
    calls.push(context);
    if (context.trigger === "follow-up" && ["再短一点，保留桌游两个字。", "我们车库碰头合适吧"].includes(context.current)) {
      lateReply = res;
      return;
    }
    const semantic = context.trigger === "follow-up" ? semanticReplies.get(context.current) : undefined;
    if (semantic !== undefined) {
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(semantic ? { action: "reply", text: semantic } : { action: "skip" }) } }] }));
    }
    const text = context.trigger === "active-discussion" ? '{"action":"reply","text":"合作解谜可以试试。"}'
      : context.trigger === "follow-up" ? context.current.includes("周日")
      ? '{"action":"reply","text":"周日晚上七点见。"}'
      : '{"action":"reply","text":"周日七点？"}'
      : context.trigger ? '{"action":"skip"}' : context.current === "写一句桌游开场白。"
      ? "桌游开局，先掷一轮骰子。" : "定在周六晚上七点。";
    res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
  await listen(model);
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const groups = ["5001", "5002", "5003", "5004", "5005", "5006", "5007"];
  const archiveGroups = groups.slice(4, 6);
  const semanticGroup = groups[6];
  const service = createGroupService({
    database, adminToken: admin, observeGroups: groups, summaryGroups: archiveGroups, recallGroups: archiveGroups,
    dshTurns: { purposes: ["proactive"], groups: [semanticGroup] },
    messageRetentionDays: 14,
    channel: { enabled: true, address: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
      expectedBotId: "1001", groups, roleId: "", modelId: "", hasToken: false },
    model: { id: "mock", name: "Mock", model: "mock", baseUrl: address(model), hasKey: false, billing: "none",
      inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "" },
  });
  t.after(async () => {
    await service.stop();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await listen(service.server);
  const connected = once(gateway, "connection");
  service.startChannel();
  const [socket] = await connected;
  const deliveries: { group: string; text: string }[] = [];
  socket.on("message", (raw: Buffer) => {
    const request = JSON.parse(raw.toString());
    deliveries.push({ group: String(request.params.group_id), text: request.params.message[0].data.text });
    socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data: { message_id: deliveries.length + 500 } }));
  });
  const scope = (id: string) => `qq:1001:${id}`;
  async function api(path: string, payload?: object) {
    const response = await fetch(address(service.server) + path, {
      method: payload ? "PUT" : "GET",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: payload && JSON.stringify(payload),
    });
    assert.ok(response.ok);
    return response.json();
  }
  const snapshot = async (group: string) => (await api("/admin/status")).groups.find((entry: { scope: string }) => entry.scope === scope(group));
  const base = { ...defaultGroupConversation, mode: "enabled", timeZone: "UTC", followUps: true, quietStart: "00:00", quietEnd: "00:00" };
  const [running, preview, interrupted, quiet] = groups;
  const minute = (time: number) => new Date(time).toISOString().slice(11, 16);
  for (const group of groups) {
    await api("/admin/group-conversation", { ...base, scope: scope(group), mode: group === preview ? "preview" : "enabled",
      ...(group === quiet ? { quietStart: minute(Date.now() - 60_000), quietEnd: minute(Date.now() + 60 * 60_000) } : {}) });
  }
  let messageId = 100;
  const say = (group: string, user: number, message: string) => socket.send(JSON.stringify({
    post_type: "message", message_type: "group", self_id: 1001, group_id: group, user_id: user, message_id: ++messageId, message,
  }));
  for (const group of groups.slice(0, 4)) say(group, 2001, "[CQ:at,qq=1001]我们约的时间是几点？");
  await waitFor(async () => (await api("/admin/status")).delivery.some((entry: { status: string; count: number }) =>
    entry.status === "sent" && entry.count === 4));
  say(running, 2001, "那改成周日呢？");
  await waitFor(async () => (await snapshot(running)).conversation.latest === "已发送连续追问");
  const first = calls.find(call => call.trigger === "follow-up")!;
  assert.deepEqual(first.previousExchange, [{ question: "我们约的时间是几点？", answer: "定在周六晚上七点。" }]);
  assert.deepEqual(first.schedule, { proposedDate: "周日", previousTime: "晚上七点", status: "待确认" });
  assert.equal(deliveries.at(-1)?.text, "周日还是晚上七点吗？");
  say(running, 2001, "再短一点");
  await waitFor(() => deliveries.some(item => item.group === running && item.text === "周日七点？"));
  assert.equal(calls.filter(call => call.trigger === "follow-up").at(-1)?.previousExchange?.length, 2);

  say(running, 2001, "继续");
  say(preview, 2001, "那改成周日呢？");
  say(interrupted, 2002, "那改成周日呢？");
  say(interrupted, 2001, "继续");
  say(quiet, 2001, "那改成周日呢？");
  await waitFor(async () => (await snapshot(preview)).conversation.latest === "已预览连续追问");
  await waitFor(async () => (await snapshot(quiet)).conversation.latest === "处于静默时段");
  assert.equal(calls.filter(call => call.trigger === "follow-up").length, 3);
  assert.equal(deliveries.filter(item => item.group !== running).length, 3);
  say(running, 2001, "[CQ:at,qq=1001]再核对一次");
  await waitFor(() => deliveries.filter(item => item.group === running).length === 4);
  assert.equal(calls.find(call => call.current === "再核对一次")?.previousExchange?.length, 3);

  async function sayAndWait(group: string, user: number, message: string) {
    say(group, user, `[CQ:at,qq=1001]${message}`);
    const event = messageId;
    await waitFor(async () => (await api(`/admin/group-reply-traces?scope=${scope(group)}&eventId=${event}`)).items
      .some((item: { state: string }) => item.state === "finished"));
    const call = calls.find(entry => entry.current === message);
    assert.ok(call);
    return call;
  }

  const interjection = await sayAndWait(interrupted, 2002, "乙在问收藏夹。");
  assert.equal(interjection.previousExchange, undefined);
  const resumed = await sayAndWait(interrupted, 2001, "再补一句上午的安排。");
  assert.deepEqual(resumed.previousExchange, [{ question: "我们约的时间是几点？", answer: "定在周六晚上七点。" }]);
  assert.equal((await sayAndWait(preview, 2002, "换个群看看。")).previousExchange, undefined);
  await api("/admin/group-reply", { scope: scope(interrupted), paused: true });
  await api("/admin/group-reply", { scope: scope(interrupted), paused: false });
  assert.equal((await sayAndWait(interrupted, 2001, "恢复后重新问。")).previousExchange, undefined);

  const [archiveGroup, archivePreviewGroup] = archiveGroups;
  await api("/admin/group-conversation", { ...base, scope: scope(archivePreviewGroup), mode: "preview" });
  const weeksAgo = Date.now() - 7 * 86_400_000;
  const evidence = new Map<string, number>();
  const seed = new DatabaseSync(database);
  try {
    const archive = openGroupTopics(seed);
    for (const group of archiveGroups) {
      const target = scope(group);
      const content = "聚餐确认改到周五19:00。";
      const at = new Date(weeksAgo).toISOString();
      const stored = seed.prepare("INSERT INTO group_messages(scope,author,content,created_at) VALUES (?,?,?,?)")
        .run(target, "2002", content, at);
      const id = Number(stored.lastInsertRowid);
      const summary = seed.prepare("INSERT INTO group_summaries(scope,first_id,last_id,content,created_at,source_start,source_end) VALUES (?,?,?,?,?,?,?)")
        .run(target, id, id, content, at, at, at);
      const extracted = readTopicSummary(JSON.stringify({ overview: content, topics: [{
        title: "周末聚餐", summary: content, evidence: [1], facts: [{ kind: "change", text: content, evidence: [1] }],
      }] }), [{ id, author: "2002", content, created_at: at }], []);
      assert.ok(extracted);
      archive.save(target, summary.lastInsertRowid, extracted.topics);
      evidence.set(group, id);
    }
  } finally { seed.close(); }

  const modelCount = calls.length;
  const trace = async (group: string, event: number) => (await api(`/admin/group-reply-traces?scope=${scope(group)}&eventId=${event}`)).items[0];
  for (const group of archiveGroups) {
    say(group, 2001, "[CQ:at,qq=1001]上周聚餐最后定了几点？");
    const directEvent = messageId;
    await waitFor(async () => (await trace(group, directEvent))?.state === "finished");
  }
  say(archiveGroup, 2001, "那最后几点");
  const archiveEvent = messageId;
  say(archivePreviewGroup, 2001, "那最后几点？");
  await waitFor(async () => (await snapshot(archivePreviewGroup)).conversation.latest === "已预览连续追问");
  await waitFor(async () => (await trace(archiveGroup, archiveEvent))?.state === "finished");
  const delivered = await trace(archiveGroup, archiveEvent);
  assert.equal(delivered.receipts[0].status, "sent");
  assert.equal(delivered.reason, "history-decision");
  assert.deepEqual(deliveries.filter(entry => entry.group === archiveGroup).map(entry => entry.text),
    ["按群里的确认记录，是周五19:00。", "按群里的确认记录，是周五19:00。"]);
  assert.equal(deliveries.filter(entry => entry.group === archivePreviewGroup).length, 1);

  const expired = new DatabaseSync(database);
  try {
    expired.exec("PRAGMA foreign_keys=ON");
    expired.prepare("DELETE FROM group_messages WHERE id=?").run(evidence.get(archiveGroup)!);
  } finally { expired.close(); }
  say(archiveGroup, 2001, "那最后定了几点？");
  const missingEvent = messageId;
  await waitFor(async () => (await trace(archiveGroup, missingEvent))?.state === "finished");
  assert.equal((await trace(archiveGroup, missingEvent)).reason, "history-evidence-missing");
  assert.match(deliveries.at(-1)?.text ?? "", /现有记录里核实不了/u);
  assert.equal(calls.length, modelCount);

  await api("/admin/group-conversation", { ...base, scope: scope(quiet) });
  await sayAndWait(quiet, 2001, "写一句桌游开场白。");
  const anchorTime = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: anchorTime });
  try {
    t.mock.timers.setTime(anchorTime + 44_000);
    say(quiet, 2001, "再短一点，保留桌游两个字。");
    const lateEvent = messageId;
    await waitFor(() => !!lateReply);
    t.mock.timers.setTime(anchorTime + 46_000);
    lateReply!.end(JSON.stringify({ choices: [{ message: { content: '{"action":"reply","text":"桌游开张，翻牌见！"}' } }] }));
    await waitFor(async () => {
      const state = (await trace(quiet, lateEvent))?.state;
      return !!state && state !== "running";
    });
    assert.deepEqual((await trace(quiet, lateEvent)).receipts.map(({ status }: { status: string }) => status), ["sent"]);
    const deliveredCount = deliveries.length;
    say(quiet, 2001, "再写一句桌游开场。");
    await waitFor(async () => (await snapshot(quiet)).conversation.latest === "等待多位群友参与话题");
    assert.equal(await trace(quiet, messageId), undefined);
    assert.equal(deliveries.length, deliveredCount);

    say(quiet, 2002, "有推荐的合作桌游吗？");
    const tooSoon = messageId;
    await waitFor(async () => (await trace(quiet, tooSoon))?.reason === "gate:recent-send");
    assert.equal(deliveries.length, deliveredCount);

    t.mock.timers.setTime(anchorTime + 92_000);
    say(quiet, 2002, "想玩两个人也能合作的。");
    say(quiet, 2003, "解谜桌游挺适合的吧？");
    const discussion = messageId;
    await waitFor(async () => (await trace(quiet, discussion))?.state === "finished");
    const joined = await trace(quiet, discussion);
    assert.equal(joined.trigger, "discussion");
    assert.deepEqual(joined.receipts.map(({ status }: { status: string }) => status), ["sent"]);
    assert.equal(deliveries.at(-1)?.text, "合作解谜可以试试。");

    t.mock.timers.setTime(anchorTime + 138_000);
    say(quiet, 2002, "再聊个别的话题。");
    say(quiet, 2003, "晚上找家面馆怎么样？");
    const newTopic = messageId;
    await waitFor(async () => (await trace(quiet, newTopic))?.reason === "gate:cooldown");
    assert.equal(calls.filter(call => call.trigger === "active-discussion").length, 1);
    assert.equal(deliveries.length, deliveredCount + 1);
  } finally { t.mock.timers.reset(); }

  await sayAndWait(semanticGroup, 2001, "测试下一轮碰头的时间。");
  say(semanticGroup, 2001, "大家晚饭吃什么？");
  const unrelated = messageId;
  await waitFor(async () => (await trace(semanticGroup, unrelated))?.reason === "silence");
  assert.equal(deliveries.filter(item => item.group === semanticGroup).length, 1);
  for (const [message, answer] of [["八点行不行", "八点可以当备选。"], ["需要提前多久到", "提前十分钟就够。"]]) {
    assert.equal(isGroupFollowUp(message), false);
    say(semanticGroup, 2001, message);
    await waitFor(async () => (await trace(semanticGroup, messageId))?.receipts[0]?.status === "sent");
    assert.equal(deliveries.at(-1)?.text, answer);
  }
  assert.equal(calls.find(call => call.current === "八点行不行")?.previousExchange?.length, 1);
  assert.equal(calls.find(call => call.current === "需要提前多久到")?.previousExchange?.length, 2);
  say(semanticGroup, 2001, "继续");
  await waitFor(async () => (await snapshot(semanticGroup)).conversation.latest === "等待多位群友参与话题");
  assert.equal(await trace(semanticGroup, messageId), undefined);

  await sayAndWait(semanticGroup, 2001, "聚会前在哪里见？");
  lateReply = undefined;
  say(semanticGroup, 2001, "我们车库碰头合适吧");
  const stale = messageId;
  await waitFor(() => !!lateReply);
  say(semanticGroup, 2002, "/本周话题");
  await waitFor(async () => (await trace(semanticGroup, stale))?.state === "interrupted");
  assert.deepEqual((await trace(semanticGroup, stale)).receipts, []);
  say(semanticGroup, 2001, "需要提前多久到");
  await waitFor(async () => (await snapshot(semanticGroup)).conversation.latest === "等待多位群友参与话题");
  assert.equal(await trace(semanticGroup, messageId), undefined);

  const freshDraft = await sayAndWait(semanticGroup, 2001, "写一句桌游开场白。");
  assert.equal(freshDraft.previousExchange, undefined);
  say(semanticGroup, 2001, "再短一点，只留掷骰子。");
  const newFollow = messageId;
  await waitFor(async () => (await trace(semanticGroup, newFollow))?.state === "finished");
  assert.deepEqual(calls.find(call => call.current === "再短一点，只留掷骰子。")?.previousExchange,
    [{ question: "写一句桌游开场白。", answer: "桌游开局，先掷一轮骰子。" }]);
  assert.equal(deliveries.at(-1)?.text, "桌游开局，掷骰子。");

  const draft = "写一句合作探险开场白，本轮先省去暗号。";
  const correction = "最终改为塔楼集合，只有两组。确认后才能加上暗号「薄荷齿轮」。";
  say(semanticGroup, 2001, "[CQ:at,qq=1001]" + draft + "可选说明。".repeat(180));
  const longDraft = messageId;
  say(semanticGroup, 2001, correction);
  await waitFor(async () => (await trace(semanticGroup, longDraft))?.state === "finished");
  const revisit = "可以把刚才暂不公开的暗号也写进去。";
  semanticReplies.set(revisit, "塔楼集合，两组，暗号薄荷齿轮。");
  say(semanticGroup, 2001, revisit);
  const longFollow = messageId;
  await waitFor(async () => (await trace(semanticGroup, longFollow))?.state === "finished");
  const previous = calls.find(call => call.current === revisit)?.previousExchange?.at(-1);
  assert.ok(previous);
  assert.ok(previous.question.startsWith(draft));
  assert.ok(previous.question.endsWith(correction), "the next turn retains requirements absent from the previous answer");
  assert.ok(previous.question.length <= 650);
  assert.doesNotMatch(previous.answer, /薄荷齿轮/u);
  assert.equal((await trace(semanticGroup, longFollow)).receipts[0].status, "sent");
});

test("server processes group activity independently, shares a single summary and gates profile access", async (t) => {
  type ReplyContext = { current: string; speaker: string; recent: { text: string; speaker: string }[];
    related: { content: string }[]; quote?: { speaker: string; text: string } | null; schedule?: ReturnType<typeof proposedSchedule>;
    speakerProfile?: string; groupProfile?: string };
  const portraitCalls: { line: number; speaker: string; text: string }[][] = [];
  let holdPortrait = false;
  const fakeModel = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const messages = JSON.parse(data).messages;
    const system = messages[0].content as string;
    const summary = system.includes("话题摘要");
    modelCalls.push({ model: JSON.parse(data).model, key: req.headers.authorization });
    if (system.includes("生成供群管理员审阅的画像候选")) {
      const sample: typeof portraitCalls[number] = JSON.parse(messages.at(-1).content);
      portraitCalls.push(sample);
      if (holdPortrait) {
        await once(res, "close");
        return;
      }
      const group = system.includes("只概括多人");
      if (group && messages.length === 2) {
        assert.match(system, /至少两位不同群友讨论同一主题/u);
        assert.match(system, /禁止超过 5 条/u);
        assert.doesNotMatch(system, /"changes"/u);
      }
      const second = group ? sample.find(row => row.speaker !== sample[0].speaker)!.line : 2;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        summary: group ? "群友常讨论联机游戏。" : "在群里提到自己喜欢协作。", evidence: [1, second],
      }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    }
    const context = summary ? null : JSON.parse(messages.at(-1).content);
    const topicSummary = summary && JSON.parse(messages.at(-1).content).messages.some((row: { text: string }) => row.text.includes("馆内读书会"));
    if (summary) summaries++;
    else {
      replyRoles.push(system);
      replyContexts.set(system, context);
      turns.push(context);
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { content: topicSummary ? JSON.stringify({ overview: "大家约了馆内读书会。", topics: [{
        title: "馆内读书会", summary: "确认明晚六点。", previous: null, evidence: [1, 2],
        facts: [{ kind: "decision", text: "定在明晚六点。", evidence: [2] }],
      }] }) : summary ? "大家在聊周末的新游戏。" :
        context?.current?.includes("当门口的招牌") ? "（咕噜咕噜）那可得把折扣写大点。" : "等我准备好就来。" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
  });
  let summaries = 0;
  const modelCalls: {model: string; key?: string}[] = [];
  const replyRoles: string[] = [];
  const replyContexts = new Map<string, ReplyContext>();
  const turns: ReplyContext[] = [];
  await listen(fakeModel);
  const gateway = createServer();
  const ws = new WebSocketServer({ server: gateway });
  await listen(gateway);
  const admin = "local-mock-admin-token-for-tests";
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-group-"));
  const database = join(directory, "groups.db");
  const legacy = new DatabaseSync(database);
  legacy.exec(`
    CREATE TABLE group_summaries (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, first_id INTEGER NOT NULL,
      last_id INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  legacy.close();
  const service = createGroupService({
    database, adminToken: admin, messageRetentionDays: 1,
    channel: { address: address(gateway).replace("http:", "ws:"), groups: ["5001", "5002"],
      enabled: true, roleId: "", modelId: "", hasToken: true, cooldownSeconds: 0, expectedBotId: "1001" },
    channelToken: "mock-channel-token",
    roles: [{ id: "test.lantern", name: "小灯", version: "1.0.0", persona: "你是小灯。",
      personality: {
        traits: { warmth: 1, humor: 1 },
        scenes: { group: "群里先指出关键事实", desktop: "桌面用灯光表达" },
      } }],
    groupRoles: { "5002": "test.lantern" },
    groupModels: { "5002": { id: "mock-group", name: "专用模型", baseUrl: address(fakeModel), model: "mock-group",
      billing: "none", hasKey: true, inputPrice: 1, outputPrice: 2, currency: "USD", billingAccount: "" } },
    groupModelKeys: { "5002": "mock-group-key" },
    observeGroups: ["5001", "5002"], summaryGroups: ["5001"], recallGroups: ["5001"], summarizeAfter: 2, summaryCooldownSeconds: 1,
    model: { id: "mock", name: "Mock", baseUrl: address(fakeModel), model: "mock",
      billing: "none", hasKey: false, inputPrice: 1, outputPrice: 1, currency: "CNY", billingAccount: "" },
    modelKey: "mock-reply-key",
    summaryModel: { id: "mock-summary", name: "Mock 摘要", baseUrl: address(fakeModel), model: "mock-summary",
      billing: "none", hasKey: true, inputPrice: 1, outputPrice: 1, currency: "CNY", billingAccount: "" },
    summaryModelKey: "mock-summary-key",
  });
  await listen(service.server);
  t.after(async () => {
    if (service.server.listening) await service.stop();
    ws.close();
    gateway.close();
    fakeModel.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function api(path: string, key: string, method = "GET", payload?: object) {
    const response = await fetch(address(service.server) + path, {
      method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: payload && JSON.stringify(payload),
    });
    return { status: response.status, data: await response.json() };
  }
  const scope = "qq:1001:5002";
  const seed = new DatabaseSync(database);
  try {
    const expired = new Date(Date.now() - 2 * 86_400_000).toISOString();
    seed.prepare("INSERT INTO group_messages(id,scope,author,content,created_at) VALUES (?,?,?,?,?)").run(100,scope,"2001","expired",expired);
    seed.prepare("INSERT INTO group_summaries(scope,first_id,last_id,content,created_at) VALUES (?,?,?,?,?)")
      .run(scope,100,100,"历史摘要",expired);
    service.startChannel();
    assert.equal(seed.prepare("SELECT COUNT(*) AS n FROM group_messages").get()?.n, 0);
    assert.equal(seed.prepare("SELECT content FROM group_summaries WHERE scope = ?").get(scope)?.content, "历史摘要");
  } finally {
    seed.close();
  }
  const connected = once(ws, "connection");
  const [socket, request] = await connected;
  assert.equal(request.headers.authorization, "Bearer mock-channel-token");
  let replies = 0;
  const sentText: string[] = [];
  let reportsSpaceCapabilities = true;
  socket.on("message", (raw: Buffer) => {
    const sent = JSON.parse(raw.toString());
    if (sent.action === "get_login_info") {
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: sent.echo,
        data: { user_id: 1001, nickname: "模拟 QQ" } }));
      return;
    }
    if (sent.action === "get_version_info") {
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: sent.echo,
        data: { app_name: "模拟网关", app_version: "1.2.3", protocol_version: "v11", internal: "不公开的字段" } }));
      return;
    }
    if (sent.action === "get_qzone_public_capabilities") {
      socket.send(JSON.stringify(reportsSpaceCapabilities
        ? { status: "ok", retcode: 0, echo: sent.echo, data: { internal: "不公开的字段" } }
        : { status: "failed", retcode: 1404, echo: sent.echo }));
      return;
    }
    assert.equal(sent.action, "send_group_msg");
    replies++;
    sentText.push(sent.params.message[0].data.text);
    socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: sent.echo, data: { message_id: 9000 + replies } }));
  });
  const event = (id: number, group: number, addressed: boolean, text = "周末一起玩新游戏？", sender = 2001) => socket.send(JSON.stringify({
    post_type: "message", message_type: "group", message_id: id, group_id: group, self_id: 1001, user_id: sender,
    message: [...(addressed ? [{ type: "at", data: { qq: "1001" } }] : []),
      { type: "text", data: { text } }],
  }));
  socket.send(JSON.stringify({ post_type: "message", message_type: "group", message_id: 9001,
    group_id: 5001, self_id: 1002, user_id: 2001,
    message: [{ type: "at", data: { qq: "1002" } }, { type: "text", data: { text: "不匹配的机器人账号" } }],
  }));
  event(1, 5001, false, "这个群刚说周日碰面。");
  event(2, 5001, true, "我们哪天碰面？");
  event(2, 5001, true, "重复事件");
  event(3, 5002, true);
  await waitFor(() => summaries === 1 && replies === 2);
  event(4, 5001, false);
  event(5, 5001, false);
  await waitFor(() => summaries === 2);
  const inspection = new DatabaseSync(database);
  try {
    assert.ok(Number(inspection.prepare("SELECT MIN(id) AS first FROM group_messages").get()?.first) > 100);
  } finally {
    inspection.close();
  }
  const gatewayCheck = await api("/admin/gateway", admin);
  assert.deepEqual(gatewayCheck.data, {
    connection: "online", login: { status: "confirmed", account: { id: "1001", nickname: "模拟 QQ" } },
    expectedAccount: "1001", matchesExpected: true, issue: null,
  });
  const capabilities = await api("/admin/gateway/capabilities", admin);
  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.data, {
    connection: "online",
    capabilities: {
      software: { name: "模拟网关", version: "1.2.3", protocolVersion: "v11" },
      spaceCapabilityCheck: "responded",
    },
  });
  reportsSpaceCapabilities = false;
  const fallback = await api("/admin/gateway/capabilities", admin);
  assert.equal(fallback.data.capabilities.spaceCapabilityCheck, "unavailable");
  assert.equal(fallback.data.capabilities.software.version, "1.2.3");
  const dashboard = await (await fetch(address(service.server))).text();
  assert.match(dashboard, /id="jobsPanel" hidden/);
  assert.match(dashboard, /<div id="groupContentCreatorLabel" hidden><label>/u);
  assert.match(dashboard, /<div id="groupContentUrlLabel"><label>/u);
  const script = dashboard.match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  const target = "qq:1001:5001";
  const hidden = "qq:1001:5002";
  const rolePublication = "/admin/plugins/group-role";
  const assigned = (await api("/admin/status", admin)).data.groups.find((group: any) => group.scope === target);
  assert.equal(assigned.rolePublished, false);
  assert.equal((await api(rolePublication, admin, "PUT", { scope: target, revision: "old", publish: true })).status, 409);
  const publish = { scope: target, revision: assigned.assignedRole.revision, publish: true };
  assert.deepEqual((await api(rolePublication, admin, "PUT", publish)).data.publishedRole, assigned.assignedRole);
  for (const data of [
    { scope: "self", subject: "2001", displayName: "小周", summary: "喜欢合作游戏" },
    { scope: target, subject: "group", displayName: "联机小组", summary: "公开的群聊画像" },
    { scope: target, subject: "2002", displayName: "小余", summary: "群内公开简介" },
    { scope: hidden, subject: "2002", displayName: "小鱼", summary: "其他群内容" },
  ]) assert.equal((await api("/admin/profiles", admin, "PUT", data)).status, 200);

  const issued = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    api("/admin/subscribers", admin, "POST", { qqId: String(2001 + index), groups: [target] })));
  for (const grant of issued) assert.equal(grant.status, 201);
  assert.equal(new Set(issued.map(grant => grant.data.token)).size, 10);
  const shared = await Promise.all(issued.map(async ({ data: { token } }, index) => {
    const groups = await api("/api/groups", token);
    assert.equal(groups.status, 200);
    assert.deepEqual(groups.data.groups.map((group: { id: string }) => group.id), [target]);
    assert.equal(groups.data.groups[0].messageCount, 4);
    assert.equal(groups.data.groups[0].summaries.length, 2);
    for (const summary of groups.data.groups[0].summaries) {
      assert.ok(Number.isSafeInteger(summary.id));
      assert.ok(Number.isFinite(Date.parse(summary.source_start)));
      assert.ok(summary.source_start <= summary.source_end && summary.source_end <= summary.created_at);
    }
    assert.equal(groups.data.groups[0].summary.content, "大家在聊周末的新游戏。");
    assert.equal(groups.data.groups[0].profile.summary, "公开的群聊画像");
    assert.deepEqual(groups.data.groups[0].publishedRole, assigned.assignedRole);
    if (index === 0) {
      const card = await api(`/api/groups/${target}/role`, token);
      assert.deepEqual(card.data.info, assigned.assignedRole);
      assert.equal(card.data.role.name, "大肥鱼");
      assert.equal((await api(`/api/groups/${hidden}/role`, token)).status, 404);
      assert.equal((await api(rolePublication, token, "PUT", { ...publish, publish: false })).status, 403);
    }
    assert.equal((await api("/api/me", token)).data.profile?.displayName, index === 0 ? "小周" : undefined);
    const directory = await api(`/api/groups/${target}/members`, token);
    assert.equal(directory.status, 200);
    assert.deepEqual(directory.data.items.map((entry: {displayName: string; summary: string}) =>
      [entry.displayName, entry.summary]), [["小余", "群内公开简介"]]);
    assert.equal((await api(`/api/groups/${hidden}/members`, token)).status, 404);
    assert.equal((await api("/api/private-memory/ohjingjing.dafeiyu", token)).status, 403);
    assert.equal((await api(`/api/groups/${target}/members/2002`, token)).data.profile.summary, "群内公开简介");
    assert.equal((await api(`/api/groups/${hidden}/members/2002`, token)).status, 404);
    assert.equal((await api("/admin/profiles", token, "PUT", {})).status, 403);
    assert.equal((await api("/admin/gateway", token)).status, 403);
    assert.equal((await api("/admin/gateway/capabilities", token)).status, 403);
    assert.equal((await api("/api/groups", token, "POST", {})).status, 403);
    return { group: groups.data.groups[0], directory: directory.data };
  }));
  for (const observation of shared) assert.deepEqual(observation, shared[0]);
  const sharedDirectory = shared[0].directory;
  assert.equal((await api("/admin/profiles", admin, "DELETE", { scope: target, subject: "group" })).status, 200);
  const grant = async (qqId: string, memoryRead: boolean, memoryWrite: boolean) =>
    (await api("/admin/subscribers", admin, "POST",
      { qqId, groups: [target], memoryRead, memoryWrite })).data.token;
  const [writer, reader, another] = await Promise.all([
    grant("2001", false, true), grant("2001", true, false), grant("2002", true, true),
    ...issued.map(async ({ data: { id } }) => assert.equal((await api(`/admin/subscribers/${id}`, admin, "DELETE")).status, 200)),
  ]);
  for (const { data: { token } } of issued) {
    assert.equal((await api("/api/groups", token)).status, 401);
    assert.equal((await api(`/api/groups/${target}/members`, token)).status, 401);
    assert.equal((await api("/api/me", token)).status, 401);
  }
  assert.equal((await api(rolePublication, admin, "PUT", { ...publish, publish: false })).status, 200);
  assert.equal((await api(`/api/groups/${target}/role`, reader)).status, 404);
  assert.equal((await api("/api/groups", reader)).data.groups[0].publishedRole, undefined);
  const memory = "/api/private-memory/ohjingjing.dafeiyu";
  const record = memory + "/12345678-1234-1234-1234-123456789abc";
  assert.deepEqual((await api("/api/me", writer)).data.account, { qqId: "2001", memoryRead: false, memoryWrite: true });
  assert.deepEqual((await api("/api/me", reader)).data.account, { qqId: "2001", memoryRead: true, memoryWrite: false });
  assert.equal((await api("/api/me", another)).data.account.qqId, "2002");
  assert.equal((await api(record, writer, "PUT", { baseVersion: 0, text: "只给本人看的偏好" })).status, 200);
  assert.equal((await api(record, writer, "PUT", { baseVersion: 0, text: "只给本人看的偏好" })).data.version, 1);
  assert.equal((await api(record, writer, "PUT", { baseVersion: 0, text: "冲突编辑" })).status, 409);
  assert.equal((await api(memory, writer)).status, 403);
  assert.equal((await api(record, reader, "PUT", { baseVersion: 1, text: "无法改写" })).status, 403);
  assert.equal((await api(memory, reader)).data.items[0].text, "只给本人看的偏好");
  assert.deepEqual((await api(memory, another)).data.items, []);
  const edits = await Promise.all([
    api(record, writer, "PUT", { baseVersion: 1, text: "第一个账号保留的记忆" }),
    api(record, another, "PUT", { baseVersion: 0, text: "第二个账号的同编号记忆" }),
  ]);
  assert.deepEqual(edits.map(item => item.data.version), [2, 1]);
  assert.equal((await api(memory, reader)).data.items[0].text, "第一个账号保留的记忆");
  assert.equal((await api(memory, another)).data.items[0].text, "第二个账号的同编号记忆");
  assert.deepEqual((await api(`/api/groups/${target}/members`, reader)).data, sharedDirectory);
  assert.equal((await api("/admin/profiles", admin, "DELETE", { scope: target, subject: "2002" })).status, 200);
  assert.deepEqual((await api(`/api/groups/${target}/members`, another)).data.items, []);
  assert.equal((await api(record, writer, "PUT", { baseVersion: 2, text: null })).status, 200);
  assert.equal((await api(memory, reader)).data.items[0].text, null);
  assert.equal((await api(memory, another)).data.items[0].text, "第二个账号的同编号记忆");
  const usage = (await api("/admin/status?days=7", admin)).data.usage;
  assert.equal(usage.find((row: any) => row.purpose === "reply")?.model_id, "mock");
  assert.equal(usage.find((row: any) => row.purpose === "summary")?.model_id, "mock-summary");
  assert.ok(usage.every((row: any) => row.failed === 0 && row.requests === row.priced_requests));
  assert.equal(usage.find((row: any) => row.model_id === "mock-group")?.currency, "USD");
  assert.equal(modelCalls.filter(call => call.model === "mock" && call.key === "Bearer mock-reply-key").length, 1);
  assert.equal(modelCalls.filter(call => call.model === "mock-group" && call.key === "Bearer mock-group-key").length, 1);
  assert.equal((await api("/admin/balance?group=5002", admin)).data.status, "unsupported");
  assert.equal((await api("/admin/balance?group=5001", admin)).status, 404);
  assert.equal(modelCalls.filter(call => call.model === "mock-summary" && call.key === "Bearer mock-summary-key").length, 2);
  assert.equal(summaries, 2);
  assert.equal(replies, 2);
  assert.equal(replyRoles.filter(role => role.includes("你是大肥鱼")).length, 1);
  assert.equal(replyRoles.filter(role => role.includes("你是小灯")).length, 1);
  const fish = replyRoles.find(role => role.includes("你是大肥鱼"))!;
  const lantern = replyRoles.find(role => role.includes("你是小灯"))!;
  assert.match(fish, /新群友用普通称呼/);
  assert.doesNotMatch(fish, /群里先指出关键事实|可以陪对方慢慢聊/);
  assert.match(lantern, /保持礼貌距离[\s\S]+群里先指出关键事实/);
  assert.doesNotMatch(lantern, /桌面用灯光表达|新群友用普通称呼/);
  assert.deepEqual(replyContexts.get(fish)?.recent.map(item => item.text), ["这个群刚说周日碰面。"]);
  assert.deepEqual(replyContexts.get(lantern)?.recent, []);
  assert.deepEqual(replyContexts.get(fish)?.related, []);
  const privateSeed = new DatabaseSync(database);
  try {
    privateSeed.prepare("UPDATE group_summaries SET content = ? WHERE scope = ?").run("另一个群在聊周末新游戏，私密记录。", hidden);
  } finally {
    privateSeed.close();
  }
  event(6, 5001, true, "周末新游戏聊过什么？");
  await waitFor(() => replies === 3);
  assert.deepEqual(replyContexts.get(fish)?.related.map(item => item.content),
    ["大家在聊周末的新游戏。", "大家在聊周末的新游戏。"]);
  await waitFor(async () => {
    const result = await api(`/admin/group-reply-traces?scope=${target}&eventId=6`, admin);
    return result.data.items[0]?.context?.included.some((item: { kind: string }) => item.kind === "history-tool");
  });
  event(7, 5001, true, "苹果香蕉菠萝好吃吗？");
  await waitFor(() => replies === 4);
  assert.deepEqual(replyContexts.get(fish)?.related, []);
  assert.equal((await api("/admin/group-reply", reader, "PUT", { scope: target, paused: true })).status, 403);
  assert.equal((await api("/admin/group-reply", admin, "PUT", { scope: target, paused: true })).data.paused, true);
  event(8, 5001, true, "暂停期间");
  await waitFor(async () => (await api("/admin/status", admin)).data.groups.some(
    (group: any) => group.scope === target && group.count === 7 && group.paused === true));
  event(9, 5002, true, "另一个群继续回复");
  await waitFor(() => replies === 5);
  assert.deepEqual(replyContexts.get(fish)?.related, []);
  assert.equal((await api("/admin/group-reply", admin, "PUT", { scope: target, paused: false })).data.paused, false);
  event(10, 5001, true, "恢复后的新消息");
  await waitFor(() => replies === 6);
  assert.equal(replyRoles.filter(role => role.includes("你是大肥鱼")).length, 4);

  const newScope = "qq:1001:5003";
  const observe = { scope: newScope, observe: true, reply: false, summary: false, recall: false };
  const policyPath = "/admin/group-policy";
  assert.equal((await api(policyPath, reader, "PUT", observe)).status, 403);
  assert.equal((await api(policyPath, admin, "PUT", { ...observe, scope: "qq:1002:5003" })).status, 409);
  assert.equal((await api(policyPath, admin, "PUT", { ...observe, observe: false, summary: true })).status, 400);
  assert.equal((await api(policyPath, admin, "PUT", observe)).status, 200);
  const managed = async () => (await api("/admin/status", admin)).data.groups.find((group: any) => group.scope === newScope);
  assert.equal((await managed()).count, 0);
  event(11, 5003, true, "观察阶段的测试消息");
  await waitFor(async () => (await managed()).count === 1);
  assert.equal(replies, 6);
  const data = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(data.prepare("SELECT COUNT(*) AS count FROM group_messages WHERE scope = ?").get(newScope)?.count, 0);
    assert.equal((await api(policyPath, admin, "PUT", { ...observe, summary: true })).status, 200);
    event(12, 5003, false, "馆内读书会提议明晚六点。");
    event(13, 5003, false, "确认馆内读书会定在明晚六点。");
    await waitFor(() => Boolean(data.prepare("SELECT id FROM group_summaries WHERE scope = ?").get(newScope)));
    assert.equal(data.prepare("SELECT COUNT(*) AS count FROM group_messages WHERE scope = ?").get(newScope)?.count, 2);
    assert.equal(data.prepare("SELECT title FROM group_topic_entries WHERE scope = ?").get(newScope)?.title, "馆内读书会");
    const historical = "/admin/group-topics?" + new URLSearchParams({ scope: newScope });
    assert.equal((await api(historical, reader)).status, 403);
    assert.equal((await api(historical, admin)).data.summaries[0].topics[0].facts[0].text, "定在明晚六点。");
  } finally {
    data.close();
  }
  const disabled = { ...observe, observe: false };
  assert.equal((await api(policyPath, admin, "PUT", disabled)).status, 200);
  event(14, 5003, true, "关闭后不应记录");
  event(15, 5002, true, "等待前一条事件被处理");
  await waitFor(() => replies === 7);
  assert.equal((await managed()).count, 3);
  function quote(id: number, groupId: number, target: number) {
    socket.send(JSON.stringify({ post_type: "message", message_type: "group", message_id: id, group_id: groupId,
      self_id: 1001, user_id: 2002, message: [
        { type: "reply", data: { id: target } }, { type: "text", data: { text: "那就这么定？" } },
      ] }));
  }
  quote(16, 5001, 9007);
  quote(17, 5002, 9007);
  await waitFor(() => replies === 8);
  const followUp = turns.findLast(context => context.quote?.speaker === "你");
  assert.deepEqual(followUp?.quote, { speaker: "你", text: "等我准备好就来。" });
  assert.notEqual(followUp?.recent.find(line => line.text === "等待前一条事件被处理")?.speaker, followUp?.speaker);
  event(18, 5001, false, "大肥鱼，你来当门口的招牌。");
  await waitFor(() => replies === 9);
  assert.equal(sentText.at(-1), "那可得把折扣写大点。");

  const activePolicy = { scope: target, observe: true, reply: true, summary: true, recall: false };
  assert.equal((await api(policyPath, admin, "PUT", activePolicy)).status, 200);
  socket.send(JSON.stringify({ post_type: "message", message_type: "group", message_id: 19, group_id: 5001,
    self_id: 1001, user_id: 2001, message: [
      { type: "reply", data: { id: 1 } }, { type: "at", data: { qq: "1001" } }, { type: "text", data: { text: "确认一下老消息" } },
    ] }));
  event(20, 5001, false, "我说的是活动时间");
  event(21, 5001, true, "另一个问题也请回一下");
  await waitFor(() => replies === 11);
  const known = turns.find(context => context.current.startsWith("确认一下老消息"));
  assert.deepEqual(known?.quote, { speaker: "群友1", text: "这个群刚说周日碰面。" });
  assert.equal(known?.current, "确认一下老消息\n我说的是活动时间");
  assert.ok(turns.some(context => context.current === "另一个问题也请回一下"));

  const candidatePath = "/admin/profile-candidates";
  const candidateQuery = (subject: string) => candidatePath + "?" + new URLSearchParams({ scope: target, subject });
  const generate = (subject: string) => api(candidatePath, admin, "POST", { scope: target, subject });
  const adminReview = (id: number, payload: object) => api(`${candidatePath}/${id}`, admin, "PUT", payload);
  assert.equal((await api(candidateQuery("group"), reader)).status, 403);
  assert.equal((await generate("2999")).data.status, "insufficient");
  assert.equal(portraitCalls.length, 0);

  const seedProfileMessages = new DatabaseSync(database);
  try {
    const insert = seedProfileMessages.prepare("INSERT INTO group_messages(scope,author,content,created_at) VALUES (?,?,?,?)");
    insert.run(target, "2001", "可公开的协作兴趣，私下联系 somebody@example.com", new Date().toISOString());
    insert.run(target, "2002", "我想试联机游戏。", new Date().toISOString());
    insert.run(target, "2003", "我也喜欢协作。", new Date().toISOString());
    insert.run(hidden, "2001", "异群独有话题", new Date().toISOString());
  } finally { seedProfileMessages.close(); }
  const portraitJobsPath = "/admin/background-jobs?" + new URLSearchParams({ scope: target, kind: "profile" });
  const portraitJobs = async () => (await api(portraitJobsPath, admin)).data.items;
  holdPortrait = true;
  const generating = generate("2001");
  await waitFor(() => portraitCalls.length === 1);
  const [operation] = await portraitJobs();
  assert.equal(operation.state, "running");
  assert.equal(operation.cancellable, true);
  assert.equal(operation.modelStatus, "running");
  const cancelPath = "/admin/background-jobs/" + operation.id + "/cancel";
  assert.equal((await api(cancelPath, reader, "POST", {})).status, 403);
  assert.equal((await api(cancelPath, admin, "POST", {})).status, 202);
  assert.equal((await generating).status, 409);
  holdPortrait = false;
  const [cancelled] = await portraitJobs();
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.reason, "operator");
  assert.equal(cancelled.modelStatus, "cancelled");
  assert.equal(cancelled.resultId, null);
  assert.equal((await api(candidateQuery("2001"), admin)).data.items.length, 0);

  const memberCandidate = await generate("2001");
  assert.equal(memberCandidate.status, 201);
  const [completedPortrait] = await portraitJobs();
  assert.equal(completedPortrait.state, "succeeded");
  assert.equal(completedPortrait.resultId, memberCandidate.data.id);
  assert.equal(completedPortrait.inputTokens, 10);
  assert.equal(completedPortrait.outputTokens, 5);
  assert.ok(!JSON.stringify(completedPortrait).includes("somebody@example.com"));
  assert.ok(!JSON.stringify(completedPortrait).includes("mock-summary-key"));
  assert.equal((await generate("2001")).status, 409);
  assert.ok(portraitCalls.at(-1)?.some(row => row.text.includes("[电邮]")));
  assert.ok(portraitCalls.at(-1)?.every(row => row.speaker === "当前成员" && !row.text.includes("异群独有")));
  const pendingMember = (await api(candidateQuery("2001"), admin)).data.items[0];
  assert.equal(pendingMember.status, "pending");
  assert.equal(pendingMember.evidence.length, 2);
  assert.deepEqual((await api(`/api/groups/${target}/members`, reader)).data.items, []);
  const edit = { scope: target, subject: "2001", displayName: "联机群友", summary: "参与本群协作约局。" };
  assert.equal((await api("/admin/profiles", admin, "PUT", edit)).status, 200);
  assert.equal((await adminReview(memberCandidate.data.id, { action: "publish", ...edit })).status, 409);
  assert.equal((await adminReview(memberCandidate.data.id, { action: "reject" })).data.status, "rejected");
  const newerMember = await generate("2001");
  assert.equal(newerMember.status, 201);
  assert.equal((await adminReview(newerMember.data.id, { action: "publish", ...edit, useInReplies: true })).data.status, "published");
  const memberDirectoryPath = `/api/groups/${target}/members`;
  const firstDirectory = (await api(memberDirectoryPath, reader)).data;
  assert.deepEqual(firstDirectory, (await api(memberDirectoryPath, another)).data);
  assert.equal(firstDirectory.items[0].summary, edit.summary);
  assert.equal(firstDirectory.items[0].source, "model-reviewed");
  assert.ok(firstDirectory.items[0].revision);
  assert.equal(firstDirectory.items[0].evidence, undefined);
  assert.equal(firstDirectory.items[0].useInReplies, undefined);
  assert.equal((await api(`/api/groups/${hidden}/members`, reader)).status, 404);
  const correctedMember = { ...edit, summary: "喜欢在本群约联机合作游戏。", useInReplies: true,
    expectedRevision: firstDirectory.items[0].revision };
  assert.equal((await api("/admin/profiles", admin, "PUT", correctedMember)).status, 200);
  assert.equal((await api("/admin/profiles", admin, "PUT", { ...correctedMember, summary: edit.summary })).status, 409);
  assert.equal((await api("/admin/profiles", admin, "DELETE", correctedMember)).status, 409);
  const correctedDirectory = (await api(memberDirectoryPath, reader)).data;
  assert.deepEqual(correctedDirectory, (await api(memberDirectoryPath, another)).data);
  assert.notEqual(correctedDirectory.items[0].revision, firstDirectory.items[0].revision);
  assert.equal(correctedDirectory.items[0].summary, correctedMember.summary);
  assert.equal(correctedDirectory.items[0].source, "model-reviewed");
  const correctedReview = (await api(candidateQuery("2001"), admin)).data;
  assert.equal(correctedReview.revision, correctedDirectory.items[0].revision);
  assert.equal(correctedReview.items[0].status, "published");
  assert.equal(correctedReview.items[0].evidence.length, 2);

  const groupCandidate = await generate("group");
  assert.equal(groupCandidate.status, 201);
  assert.ok(new Set(portraitCalls.at(-1)?.map(row => row.speaker)).size >= 3);
  const beforePreview = (await api(candidateQuery("group"), admin)).data;
  const profilePreview = { scope: target, subject: "group", preview: true };
  const beforeCalls = portraitCalls.length;
  assert.equal((await api(candidatePath, reader, "POST", profilePreview)).status, 403);
  assert.equal((await api(candidatePath, admin, "POST", { ...profilePreview, preview: "true" })).status, 400);
  assert.equal(portraitCalls.length, beforeCalls);
  const preview = await api(candidatePath, admin, "POST", profilePreview);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.status, "preview");
  assert.equal(preview.data.summary, "群友常讨论联机游戏。");
  assert.deepEqual(preview.data.evidence, beforePreview.items[0].evidence);
  assert.equal(preview.data.id, undefined);
  assert.deepEqual((await api(candidateQuery("group"), admin)).data, beforePreview);
  const [previewJob] = await portraitJobs();
  assert.equal(previewJob.state, "preview");
  assert.equal(previewJob.reason, "candidate-preview");
  assert.equal(previewJob.resultId, null);
  assert.equal(previewJob.outputTokens, 5);
  assert.equal(portraitCalls.length, beforeCalls + 1);
  assert.ok(portraitCalls.at(-1)?.every(row => !row.text.includes("异群独有")));
  assert.equal((await api("/api/groups", reader)).data.groups[0].profile, null);
  assert.equal((await adminReview(groupCandidate.data.id, { action: "publish", displayName: "游戏群", summary: "常讨论联机游戏。" })).status, 200);
  const beforeGroupEdit = (await api("/api/groups", reader)).data.groups[0].profile;
  assert.equal(beforeGroupEdit.displayName, "游戏群");
  const groupEdit = { scope: target, subject: "group", displayName: "游戏群", summary: "近期讨论多人协作游戏。",
    expectedRevision: beforeGroupEdit.revision };
  assert.equal((await api("/admin/profiles", admin, "PUT", groupEdit)).status, 200);
  const afterGroupEdit = (await api("/api/groups", reader)).data.groups[0].profile;
  assert.equal(afterGroupEdit.summary, groupEdit.summary);
  assert.notEqual(afterGroupEdit.revision, beforeGroupEdit.revision);
  event(22, 5001, true, "说说约局");
  await waitFor(() => replies === 12);
  assert.equal(turns.at(-1)?.speakerProfile, correctedMember.summary);
  assert.equal(turns.at(-1)?.groupProfile, undefined);
  assert.equal((await api("/admin/profiles", admin, "DELETE", { scope: target, subject: "2001" })).status, 200);
  assert.deepEqual((await api(memberDirectoryPath, another)).data.items, []);
  assert.equal((await api(candidateQuery("2001"), admin)).data.items[0].status, "withdrawn");
  const removeEvidence = new DatabaseSync(database);
  try {
    removeEvidence.exec("PRAGMA foreign_keys=ON");
    removeEvidence.prepare("DELETE FROM group_messages WHERE id=(SELECT MIN(message_id) FROM group_profile_evidence WHERE candidate_id=?)").run(groupCandidate.data.id);
  } finally { removeEvidence.close(); }
  assert.equal((await api("/api/groups", reader)).data.groups[0].profile, null);
  const expired = (await api(candidateQuery("group"), admin)).data.items[0];
  assert.equal(expired.status, "expired");
  assert.equal(expired.summary, "");
  assert.deepEqual(expired.evidence, []);
  assert.equal((await api("/admin/profiles", admin, "PUT", { ...groupEdit, expectedRevision: afterGroupEdit.revision })).status, 409);
  assert.equal((await api("/api/groups", another)).data.groups[0].profile, null);
  const portraitUsage = (await api("/admin/status", admin)).data.usage.find((row: { purpose: string }) => row.purpose === "profile");
  assert.equal(portraitUsage?.requests, 5);
  assert.equal(portraitUsage?.model_id, "mock-summary");

  assert.equal((await api("/admin/budget", reader)).status, 403);
  const budget = (await api("/admin/budget", admin)).data;
  assert.equal(budget.policy.background.daily, null);
  const limit = { ...budget.policy, background: { daily: 0, monthly: null } };
  assert.equal((await api("/admin/budget", admin, "PUT", limit)).data.background.daily.status, "limit");
  assert.equal((await api("/admin/budget", admin, "PUT", limit)).status, 409);
  assert.equal((await generate("group")).status, 429);
  assert.equal((await api(candidatePath, admin, "POST", profilePreview)).status, 429);
  const budgetScope = "qq:1001:5004";
  assert.equal((await api(policyPath, admin, "PUT", { scope: budgetScope, observe: true, summary: true, reply: false, recall: false })).status, 200);
  event(23, 5004, false, "后台预算暂停期间的样本一");
  event(24, 5004, false, "后台预算暂停期间的样本二");
  await waitFor(async () => (await api("/admin/status", admin)).data.groups.some((group: any) => group.scope === budgetScope && group.count === 2));
  const pausedData = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(pausedData.prepare("SELECT COUNT(*) n FROM group_messages WHERE scope=?").get(budgetScope)?.n, 2);
    assert.equal(pausedData.prepare("SELECT COUNT(*) n FROM requests WHERE scope=?").get(`summary:${budgetScope}`)?.n, 0);
  } finally { pausedData.close(); }

  assert.equal((await api(policyPath, admin, "PUT", { ...activePolicy, recall: true })).status, 200);
  assert.equal((await api("/admin/profiles", admin, "PUT", { scope: target, subject: "group", displayName: "当前群",
    summary: "常玩合作桌游。", useInReplies: true })).status, 200);
  const repliesBeforeDraft = replies;
  event(219, 5001, true, "周末新游戏开场白。");
  event(220, 5001, false, "给第一次来的朋友");
  await waitFor(() => replies === repliesBeforeDraft + 1);
  const draft = turns.find(item => item.current.startsWith("周末新游戏开场白。"));
  assert.equal(draft?.current, "周末新游戏开场白。\n给第一次来的朋友");
  assert.deepEqual(draft?.related, []);
  assert.deepEqual(draft?.recent, []);
  assert.equal(draft?.groupProfile, "常玩合作桌游。");
  await waitFor(async () => {
    const result = await api(`/admin/group-reply-traces?scope=${target}&eventId=219`, admin);
    const turn = result.data.items[0];
    if (turn?.state !== "finished") return false;
    assert.ok(!turn.context.included.some((item: { kind: string }) => item.kind.endsWith("-tool")));
    assert.equal(turn.receipts[0].status, "sent");
    return true;
  });
  event(221, 5001, true, "");
  event(222, 5001, false, "写一句周末合作桌游开场白");
  event(223, 5001, false, "线索藏在旧钟里。");
  event(224, 5001, false, "我那局的线索藏在另一本书里。", 2002);
  event(225, 5001, false, "我已经点好今天的外卖了。");
  await waitFor(() => replies === repliesBeforeDraft + 2);
  const calledDraft = turns.find(item => item.current.includes("线索藏在旧钟里。"));
  assert.equal(calledDraft?.current, "写一句周末合作桌游开场白\n线索藏在旧钟里。");
  assert.deepEqual(calledDraft?.related, []);
  assert.deepEqual(calledDraft?.recent, []);
  await waitFor(async () => {
    const turn = (await api(`/admin/group-reply-traces?scope=${target}&eventId=221`, admin)).data.items[0];
    if (turn?.state !== "finished") return false;
    assert.ok(!turn.context.included.some((item: { kind: string }) => item.kind.endsWith("-tool")));
    assert.equal(turn.receipts[0].status, "sent");
    return true;
  });

  await service.stop();
  const reopened = createGroupService({ database, adminToken: admin });
  try {
    await listen(reopened.server);
    const res = await fetch(address(reopened.server) + "/admin/status", { headers: { Authorization: `Bearer ${admin}` } });
    const status = await res.json();
    const row = status.groups.find((group: any) => group.scope === newScope);
    assert.deepEqual(row.policy, { observe: false, reply: false, summary: false, recall: false });
    assert.equal(row.count, 3);
    assert.equal(status.budget.policy.background.daily, 0);
  } finally {
    await reopened.stop();
  }
});

test("quoting a confirmed reply after restart restores only its same-group, retained context", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-quoted-turn-"));
  const admin = "mock-admin-for-persisted-quotes";
  const retainedQuestion = "图书馆活动安排在什么时候？";
  const unretainedQuestion = "请告诉我桌游的地点。";
  const partialQuestion = "看看分开发送的效果。";
  const before = "周六晚上七点在图书馆碰面。";
  const rejected = "第二条没有通过网关。";
  const answers = new Map([
    [retainedQuestion, [before, "到时候见。"]],
    [unretainedQuestion, ["桌游在一楼大厅。", "地点照旧。"]],
    [partialQuestion, ["第一条确认发送。", rejected]],
  ]);
  const contexts: {
    current: string; speaker: string; quote: { speaker: string; text: string } | null;
    quoteContext?: { original?: { speaker: string; text: string }; adjacent?: { position: string; text: string } };
    schedule?: ReturnType<typeof proposedSchedule>;
  }[] = [];
  const provider = createServer(async (req, res) => {
    const body: Buffer[] = [];
    for await (const chunk of req) body.push(Buffer.from(chunk));
    const messages = JSON.parse(Buffer.concat(body).toString()).messages;
    const context = JSON.parse(messages.at(-1).content);
    contexts.push(context);
    const answer = context.schedule ? `那就${context.schedule.proposedDate}${context.schedule.previousTime}见。` : "收到。";
    res.end(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({ action: "reply", parts: answers.get(context.current) ?? [answer] }),
    } }] }));
  });
  await listen(provider);
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const groups = ["5001", "5002"];
  const options = {
    database: join(directory, "groups.db"), adminToken: admin, observeGroups: groups, summaryGroups: ["5001"], summarizeAfter: 20,
    model: {
      id: "model", name: "模拟模型", baseUrl: address(provider), model: "model", billing: "none" as const, hasKey: false,
      inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "",
    },
    channel: { enabled: true, groups, address: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
      roleId: "", modelId: "model", hasToken: false, expectedBotId: "1001" },
  };
  let service = createGroupService(options);
  t.after(async () => {
    await service.stop();
    for (const socket of gateway.clients) socket.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const deliveries: { group: number; id: number; text: string }[] = [];
  gateway.on("connection", socket => socket.on("message", (raw: Buffer) => {
    const frame = JSON.parse(raw.toString());
    if (frame.action !== "send_group_msg") return;
    const text = frame.params.message[0].data.text as string;
    const id = 9101 + deliveries.length;
    deliveries.push({ group: frame.params.group_id, id, text });
    socket.send(JSON.stringify(text === rejected
      ? { echo: frame.echo, status: "failed", retcode: 100 }
      : { echo: frame.echo, status: "ok", retcode: 0, data: { message_id: id } }));
  }));
  async function connect() {
    await listen(service.server);
    const connection = once(gateway, "connection");
    service.startChannel();
    const [socket] = await connection;
    return socket;
  }
  let socket = await connect();
  function say(id: number, group_id: number, text: string, reference?: number, addressed = true) {
    const parts: { type: string; data: Record<string, string> }[] =
      reference !== undefined ? [{ type: "reply", data: { id: String(reference) } }] : [];
    if (addressed) parts.push({ type: "at", data: { qq: "1001" } });
    socket.send(JSON.stringify({
      post_type: "message", message_type: "group", group_id, message_id: id, self_id: 1001,
      user_id: reference === undefined ? 2001 : 2002, message: [...parts, { type: "text", data: { text } }],
    }));
  }
  async function finished(id: number) {
    const response = await fetch(address(service.server) + `/admin/group-reply-traces?eventId=${id}`,
      { headers: { Authorization: `Bearer ${admin}` } });
    const { items } = await response.json();
    return items[0]?.state === "finished";
  }
  say(1, 5001, retainedQuestion);
  await waitFor(() => finished(1));
  say(2, 5002, unretainedQuestion);
  await waitFor(() => finished(2));
  say(3, 5001, partialQuestion);
  await waitFor(() => finished(3));
  assert.equal(deliveries.length, 6);
  await service.stop();
  service = createGroupService(options);
  socket = await connect();

  const change = "那换到周日呢？";
  say(4, 5001, change, deliveries[1].id, false);
  await waitFor(() => finished(4));
  const retained = contexts.find(context => context.current === change)!;
  assert.deepEqual(retained.quote, { speaker: "你", text: "到时候见。" });
  assert.equal(retained.quoteContext?.original?.text, retainedQuestion);
  assert.notEqual(retained.quoteContext?.original?.speaker, retained.speaker);
  assert.deepEqual(retained.quoteContext?.adjacent, { position: "before", text: before });
  assert.deepEqual(retained.schedule, { proposedDate: "周日", previousTime: "晚上七点", status: "待确认" });
  assert.equal(deliveries.at(-1)?.text, "周日还是晚上七点吗？");

  say(5, 5002, "再看桌游那条。", deliveries[3].id, false);
  await waitFor(() => finished(5));
  const unretained = contexts.find(context => context.current === "再看桌游那条。")!;
  assert.deepEqual(unretained.quoteContext, { adjacent: { position: "before", text: "桌游在一楼大厅。" } });

  say(6, 5001, "解释实际发出的那条。", deliveries[4].id, false);
  await waitFor(() => finished(6));
  const partial = contexts.find(context => context.current === "解释实际发出的那条。")!;
  assert.equal(partial.quoteContext?.original?.text, partialQuestion);
  assert.equal(partial.quoteContext?.adjacent, undefined);

  say(7, 5002, "确认这次引用。", deliveries[1].id);
  await waitFor(() => finished(7));
  const foreign = contexts.find(context => context.current === "确认这次引用。")!;
  assert.equal(foreign.quote, null);
  assert.equal(foreign.quoteContext, undefined);

  const policy = await fetch(address(service.server) + "/admin/group-policy", {
    method: "PUT", headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "qq:1001:5001", reply: true, observe: true, summary: false, recall: false }),
  });
  assert.equal(policy.status, 200);
  say(8, 5001, "再看前一轮。", deliveries[1].id, false);
  await waitFor(() => finished(8));
  assert.deepEqual(contexts.find(context => context.current === "再看前一轮。")?.quoteContext,
    { adjacent: { position: "before", text: before } });
});

test("group replies in progress cannot cross a OneBot disconnect", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-disconnected-reply-"));
  const admin = "onebot-disconnect-fixture-admin";
  const scope = "qq:1001:5001";
  let held: ServerResponse | undefined;
  const calls: { current: string; previousExchange?: unknown }[] = [];
  function answer(res: ServerResponse, content: string) {
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  }
  const model = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const context = JSON.parse(JSON.parse(Buffer.concat(parts).toString()).messages.at(-1).content);
    calls.push(context);
    if (context.current === "断线前还在生成") held = res;
    else answer(res, `${context.current}的回复。`);
  });
  await listen(model);
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const sent: string[] = [];
  gateway.on("connection", socket => socket.on("message", (raw: Buffer) => {
    const request = JSON.parse(raw.toString());
    let data: object = { online: true, good: true };
    if (request.action === "get_login_info") data = { user_id: 1001 };
    if (request.action === "send_group_msg") {
      sent.push(request.params.message[0].data.text);
      data = { message_id: 600 + sent.length };
    }
    socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data }));
  }));
  const service = createGroupService({ database: join(directory, "group.db"), adminToken: admin, observeGroups: ["5001"],
    channel: { enabled: true, address: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
      expectedBotId: "1001", verifyExpectedBot: true, groups: ["5001"], roleId: "", modelId: "", hasToken: false },
    model: { id: "mock", name: "Mock", model: "mock", baseUrl: address(model), hasKey: false, billing: "none",
      inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "" },
  });
  t.after(async () => {
    await service.stop();
    for (const socket of gateway.clients) socket.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    model.closeAllConnections();
    await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await listen(service.server);
  async function api(path: string) {
    const response = await fetch(address(service.server) + path, { headers: { Authorization: `Bearer ${admin}` } });
    assert.ok(response.ok);
    return response.json();
  }
  const online = async () => (await api("/admin/plugins/im-channel")).status === "online";
  const trace = async (event: number) => (await api(`/admin/group-reply-traces?scope=${scope}&eventId=${event}`)).items[0];
  const opened = once(gateway, "connection");
  service.startChannel();
  let [socket] = await opened;
  await waitFor(online);
  const say = (event: number, text: string) => socket.send(JSON.stringify({
    post_type: "message", message_type: "group", self_id: 1001, group_id: 5001, user_id: 2001, message_id: event,
    message: `[CQ:at,qq=1001]${text}`,
  }));
  say(201, "断线前已经确认");
  await waitFor(async () => (await trace(201))?.state === "finished");
  say(202, "断线前还在生成");
  await waitFor(() => held !== undefined);
  const reconnected = once(gateway, "connection");
  socket.terminate();
  await waitFor(async () => (await api("/admin/gateway")).issue?.kind === "connection-closed");
  [socket] = await reconnected;
  await waitFor(online);
  if (!held!.destroyed) answer(held!, "断线前的旧回复。");
  say(203, "重连后的新请求");
  await waitFor(async () => (await trace(203))?.state === "finished");
  assert.deepEqual(sent, ["断线前已经确认的回复。", "重连后的新请求的回复。"]);
  const { channelCoverage: coverage } = await api(`/admin/group-statistics?scope=${scope}&days=1`);
  assert.ok(coverage.onlineMs > 0 && coverage.unavailableMs >= 3000 && coverage.unobservedMs > 0);
  assert.ok(coverage.gaps.some((gap: { state: string; start: string; end: string }) =>
    gap.state === "unavailable" && Date.parse(gap.end) - Date.parse(gap.start) >= 3000));
  const issue = async (groups: string[]) => {
    const response = await fetch(address(service.server) + "/admin/subscribers", { method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: JSON.stringify({ qqId: "2001", groups }) });
    assert.equal(response.status, 201);
    return (await response.json()).token;
  };
  async function feed(token: string) {
    const response = await fetch(address(service.server) + "/api/groups", { headers: { Authorization: `Bearer ${token}` } });
    return response.json();
  }
  assert.ok((await feed(await issue([scope]))).channelCoverage.unavailableMs >= 3000);
  assert.equal((await feed(await issue([]))).channelCoverage, undefined);
  assert.equal(calls.find(call => call.current === "重连后的新请求")?.previousExchange, undefined);
  const interrupted = await trace(202);
  assert.equal(interrupted.state, "interrupted");
  assert.equal(interrupted.reason, "connection");
  assert.deepEqual(interrupted.receipts, []);
});

test("OneBot marks an interrupted send unknown and reconnects without replay", async (t) => {
  const gateway = createServer();
  const websocket = new WebSocketServer({ server: gateway });
  const channel = new OneBotConnection();
  await listen(gateway);
  t.after(() => {
    channel.stop();
    for (const client of websocket.clients) client.terminate();
    websocket.close();
    gateway.close();
  });

  const first = once(websocket, "connection");
  channel.start({
    address: address(gateway).replace("http:", "ws:"),
    enabled: true, groups: ["5001"], roleId: "", modelId: "", hasToken: false,
  }, null, () => {});
  const [socket] = await first;
  await waitFor(() => channel.status === "online");
  const frame = once(socket, "message");
  const sent = channel.sendGroup("5001", "模拟发送");
  await frame;
  const reconnected = once(websocket, "connection");
  socket.terminate();
  const result = await Promise.race([
    sent,
    new Promise(resolve => setTimeout(() => resolve("too late"), 1000).unref()),
  ]);
  assert.equal(result, "unknown");
  assert.equal(channel.status, "disconnected");

  const [replacement] = await reconnected;
  await waitFor(() => channel.status === "online");
  let frames = 0;
  replacement.on("message", (raw: Buffer) => {
    frames++;
    const request = JSON.parse(raw.toString());
    replacement.send(JSON.stringify({ echo: request.echo, status: "ok", retcode: 0 }));
  });
  assert.equal(await channel.sendGroup("5001", "重连后的新消息"), "sent");
  assert.equal(frames, 1);
});

test("OneBot reconnects when a socket sends replies but stops answering matching pings", async (t) => {
  const gateway = createServer();
  const sockets = new WebSocketServer({ server: gateway, autoPong: false });
  const channel = new OneBotConnection({ pollMs: 100, pongMs: 150, probeMs: 300, reconnectMs: 80 });
  await listen(gateway);
  t.after(() => {
    channel.stop();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    gateway.close();
  });
  const first = once(sockets, "connection");
  channel.start({
    enabled: true, address: address(gateway).replace("http:", "ws:"), groups: [], roleId: "", modelId: "", hasToken: false,
  }, null, () => {});
  const [stalled] = await first;
  stalled.on("ping", () => stalled.pong(Buffer.from("unrelated")));
  stalled.on("message", (raw: Buffer) => {
    const frame = JSON.parse(raw.toString());
    if (frame.action === "get_status") {
      stalled.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { online: true, good: true } }));
    }
  });
  await waitFor(() => channel.status === "online");
  const replaced = once(sockets, "connection");
  const delivered = channel.sendGroup("5001", "等待回执的消息");
  assert.equal(await delivered, "unknown");
  assert.equal(channel.connectionIssue?.kind, "heartbeat-timeout");
  const [healthy] = await replaced;
  const outgoing: string[] = [];
  healthy.on("ping", (payload: Buffer) => healthy.pong(payload));
  healthy.on("message", (raw: Buffer) => {
    const frame = JSON.parse(raw.toString());
    if (frame.action === "send_group_msg") outgoing.push(frame.params.message[0].data.text);
    healthy.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { online: true, good: true } }));
  });
  await waitFor(() => channel.status === "online");
  assert.equal(channel.connectionIssue, null);
  assert.equal(await channel.sendGroup("5001", "重连后的新消息"), "sent");
  assert.deepEqual(outgoing, ["重连后的新消息"]);
});

test("OneBot verifies login at startup, disconnects when QQ drops, and recovers with the expected account", async (t) => {
  const gateway = createServer();
  const sockets = new WebSocketServer({ server: gateway });
  const channel = new OneBotConnection({ pollMs: 100, pongMs: 150, probeMs: 300, reconnectMs: 100 });
  const issue = () => channel.connectionIssue;
  let account = "1002";
  let online: boolean | null = true;
  const incoming: ChannelMessage[] = [];
  await listen(gateway);
  sockets.on("connection", socket => {
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString());
      const data = frame.action === "get_login_info" ? { user_id: account } : { online, good: online };
      socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data }));
    });
  });
  t.after(() => {
    channel.stop();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    gateway.close();
  });

  const wrong = once(sockets, "connection");
  channel.start({
    enabled: true, address: address(gateway).replace("http:", "ws:"), groups: [], roleId: "", modelId: "",
    hasToken: false, expectedBotId: "1001", verifyExpectedBot: true,
  }, null, message => incoming.push(message));
  const message = (self_id: string) => JSON.stringify({
    post_type: "message", message_type: "group", message_id: "101", self_id, user_id: "2001", group_id: "5001",
    message: "测试联调",
  });
  const [wrongAccount] = await wrong;
  const wrongClosed = once(wrongAccount, "close");
  wrongAccount.send(message("1002"));
  await wrongClosed;
  assert.equal(incoming.length, 0);
  assert.equal(issue()?.kind, "account-mismatch");
  assert.ok(Number.isFinite(Date.parse(issue()!.detectedAt)));

  account = "";
  const [unconfirmed] = await once(sockets, "connection");
  await once(unconfirmed, "close");
  assert.equal(issue()?.kind, "login-unconfirmed");

  account = "1001";
  online = null;
  const [initial] = await once(sockets, "connection");
  await waitFor(() => channel.status === "online");
  assert.equal(issue(), null);
  initial.send(message(account));
  await waitFor(() => incoming.length === 1);
  assert.equal(incoming[0].accountId, account);

  const loggedOut = once(initial, "close");
  online = false;
  await loggedOut;
  assert.equal(issue()?.kind, "gateway-offline");
  assert.equal(await channel.sendGroup("5001", "离线后不发送"), "failed");
  online = true;
  const [restored] = await once(sockets, "connection");
  await waitFor(() => channel.status === "online");
  const heartbeatReportedOffline = once(restored, "close");
  restored.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", status: { online: false, good: false } }));
  await heartbeatReportedOffline;
  assert.equal(issue()?.kind, "gateway-offline");
  channel.stop();
  let newSessions = 0;
  sockets.on("connection", () => { newSessions++; });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(newSessions, 0);
  assert.equal(channel.status, "disabled");
  assert.equal(issue(), null);
});

test("OneBot distinguishes an explicit handshake authorization rejection and clears it after recovery", async t => {
  const gateway = createServer();
  let accepted = false;
  const sockets = new WebSocketServer({ server: gateway, verifyClient: (_request, callback) => callback(accepted, 401) });
  const channel = new OneBotConnection({ pollMs: 100, pongMs: 150, probeMs: 300, reconnectMs: 80 });
  await listen(gateway);
  t.after(() => {
    channel.stop();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    gateway.close();
  });
  channel.start({ address: address(gateway).replace("http:", "ws:"), enabled: true,
    groups: [], roleId: "", modelId: "", hasToken: true }, "fixture-credential", () => {});
  await waitFor(() => channel.connectionIssue?.kind === "authorization");
  assert.deepEqual(Object.keys(channel.connectionIssue!).sort(), ["detectedAt", "kind"]);
  accepted = true;
  await waitFor(() => channel.status === "online");
  assert.equal(channel.connectionIssue, null);
});

test("a configured channel plugin uses existing QQ policies, and pausing cancels delivery across restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-channel-plugin-"));
  const admin = "integration-channel-plugin-token";
  const credential = "testing-channel-connection-secret";
  const scope = "qq:1001:5001";
  const deliveries: { groupId: string; text: string }[] = [];
  const sessions: ((message: ChannelMessage) => void)[] = [];
  let stopped = 0;
  let modelStarted = false;
  let modelAborted = false;
  const provider = createServer((req, res) => {
    modelStarted = true;
    req.resume();
    res.once("close", () => { modelAborted = true; });
  });
  await listen(provider);
  const alternate: ImChannelPlugin = {
    manifest: { id: "qq.fixture", platform: "qq", name: "模拟替代渠道", apiVersion: 1, capabilities: ["groupText"] },
    create() {
      let status: ChannelStatus = "disabled";
      return {
        get status() { return status; },
        start(_settings, token, inbound) {
          assert.equal(token, credential);
          sessions.push(inbound);
          status = "online";
        },
        stop() { status = "disabled"; stopped++; },
        async checkLogin() { return { status: "confirmed", account: { id: "1001", nickname: "联调账号" } }; },
        async deliverGroup(groupId, text) {
          deliveries.push({ groupId, text });
          return { status: "sent", messageId: "500" };
        },
      };
    },
  };
  const options = {
    database: join(directory, "plugins.db"), adminToken: admin, channelToken: credential,
    channel: { pluginId: alternate.manifest.id, enabled: true, groups: ["5001"], roleId: "", modelId: "", hasToken: true,
      address: "adapter-specific-endpoint", expectedBotId: "1001" },
    observeGroups: ["5001"],
    model: { id: "plugin-test", name: "mock", model: "mock", baseUrl: address(provider), billing: "none" as const,
      hasKey: false, currency: "USD", inputPrice: null, outputPrice: null, billingAccount: "" },
  };
  let service: ReturnType<typeof createGroupService> | undefined;
  t.after(async () => {
    if (service) await service.stop();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  assert.throws(() => createGroupService(options), /未安装的 IM 渠道插件/);
  assert.throws(() => createGroupService(options, [alternate, alternate]), /插件 ID 重复/);
  assert.throws(() => createGroupService(options, [{ ...alternate, manifest: { ...alternate.manifest, platform: "wechat" } }]),
    /需要选择 QQ/);

  async function launch() {
    service = createGroupService(options, [alternate]);
    await listen(service.server);
    service.startChannel();
  }
  async function call(path: string, token?: string, method = "GET", payload?: object) {
    const response = await fetch(address(service!.server) + path, { method, headers: token
      ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : undefined,
      body: payload && JSON.stringify(payload) });
    return { status: response.status, data: await response.json() };
  }
  const route = "/admin/plugins/im-channel";
  const toggle = (enabled: boolean) => call(route, admin, "PUT", { pluginId: alternate.manifest.id, enabled });
  const mention: IncomingGroupMessage = {
    kind: "group", accountId: "1001", groupId: "5001", messageId: "101", actorId: "2001", name: "测试成员",
    message: "有人 @ 你。", hasImage: false, pingOnly: true, addressed: true, directed: true, bot: false,
  };
  await launch();
  assert.equal((await call(route)).status, 401);
  assert.equal((await call(route, admin, "PUT", { pluginId: "qq.onebot", enabled: false })).status, 400);
  const plugin = (await call("/admin/status", admin)).data.channelPlugin;
  assert.deepEqual(plugin, { ...alternate.manifest, configured: true, enabled: true, status: "online" });
  assert.doesNotMatch(JSON.stringify(plugin), /adapter-specific-endpoint|testing-channel-connection-secret/);
  assert.equal((await call("/admin/qq-account", admin)).data.capabilities.avatar, false);
  assert.equal((await call("/admin/qq-account/actions", admin, "POST", {})).status, 501);

  sessions[0](mention);
  await waitFor(() => deliveries.length === 1);
  assert.deepEqual(deliveries[0], { groupId: mention.groupId, text: "在。" });
  const grant = await call("/admin/subscribers", admin, "POST", { qqId: mention.actorId, groups: [scope] });
  assert.equal(grant.status, 201);
  const subscriber = grant.data.token;
  assert.equal((await call("/admin/group-reply-traces", subscriber)).status, 403);
  assert.equal((await call("/admin/group-statistics?" + new URLSearchParams({ scope }), subscriber)).status, 403);

  sessions[0]({ ...mention, messageId: "102", pingOnly: false, message: "请回答一个问题" });
  await waitFor(() => modelStarted);
  assert.equal((await toggle(false)).data.status, "disabled");
  await waitFor(() => modelAborted);
  assert.equal(deliveries.length, 1);
  assert.equal((await call("/api/groups", subscriber)).data.channelPlugin.status, "disabled");

  const lastCount = (await call("/admin/status", admin)).data.groups[0].count;
  assert.equal((await toggle(true)).data.status, "online");
  sessions[0]({ ...mention, messageId: "103" });
  sessions[1]({ ...mention, accountId: "1002", messageId: "104" });
  sessions[1]({ ...mention, messageId: "105" });
  await waitFor(() => deliveries.length === 2);
  assert.equal((await call("/admin/status", admin)).data.groups[0].count, lastCount + 1);
  assert.equal((await toggle(false)).data.enabled, false);
  await service!.stop();
  service = undefined;

  await launch();
  assert.equal((await call(route, admin)).data.status, "disabled");
  assert.equal((await call("/api/groups", subscriber)).data.groups[0].id, scope);
  assert.equal(sessions.length, 2);
  assert.ok(stopped >= 2);
  assert.equal((await toggle(true)).data.status, "online");
  assert.equal(sessions.length, 3);
});

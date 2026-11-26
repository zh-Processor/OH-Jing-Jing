import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openBackgroundJobs } from "../runtime/background-jobs";
import { dshImageBlocks } from "../runtime/dsh-harness";
import { openGroupReplyTraces } from "../runtime/group-reply-traces";
import { readTopicSummary, topicPrompt } from "../runtime/group-topics";
import { complete, type Message, type ModelProfile } from "../runtime/models";
import type { PiLookup } from "../runtime/pi-harness";
import { openServiceBudget } from "../runtime/service-budget";
import { serviceInference } from "../runtime/service-inference";
import { openServiceModelAttempts } from "../runtime/service-model-attempts";
import { openServiceModels, readBackupModels } from "../runtime/service-models";
import { openStore } from "../runtime/store";
import { openSummaryTasks } from "../runtime/summary-tasks";
import { hasPublicPageAddress, readSemanticWebDecision, readWebLookup } from "../runtime/web-lookup";
import { readPrivateHistoryLookup } from "../runtime/qq-private";
import { openQqTurnTools } from "../runtime/qq-history-tool";
import { planRoleTurn } from "../runtime/turn";

test("vision turns admit ordered inline images only on the current user message", () => {
  const images = ["data:image/png;base64,YQ==", "data:image/gif;base64,Yg=="];
  const current: Message = { role: "user", content: "这两张图有什么不同？", images };
  const earlier: Message = { role: "assistant", content: "上次讨论了角色。" };
  assert.deepEqual(dshImageBlocks([earlier, current], true), [
    { type: "image", mimeType: "image/png", data: "YQ==" },
    { type: "image", mimeType: "image/gif", data: "Yg==" },
  ]);
  assert.deepEqual(dshImageBlocks([earlier], false), []);
  assert.equal(dshImageBlocks([current], false), null);
  assert.equal(dshImageBlocks([current, earlier], true), null);
  assert.equal(dshImageBlocks([{ ...current, images: ["https://example.org/image.png"] }], true), null);
  assert.equal(dshImageBlocks([{ ...current, images: ["data:image/svg+xml;base64,YQ=="] }], true), null);
  assert.equal(dshImageBlocks([{ ...current, images: [...images, images[0]] }], true), null);
});

test("Harness public lookups take only a public query or URL from the current speaker's message", () => {
  const decision = (query: string, current: string) => readSemanticWebDecision(JSON.stringify({ action: "web_search", query }), current);
  assert.equal(decision("Python enumerate 默认起始下标", "Python enumerate 默认起始下标，给个官方出处。")?.lookup?.argument,
    "Python enumerate 默认起始下标");
  assert.equal(readSemanticWebDecision('{"action":"web_search","terms":["Python enumerate","默认起始下标"]}',
    "想写一段 Python enumerate 的讲义，需要核实默认起始下标。")?.lookup?.argument, "Python enumerate 默认起始下标");
  const providerAction = '<｜DSML｜ calls>\n<｜DSML｜ invoke name="web_search">\n<｜DSML｜ parameter name="terms" string="false">' +
    '["Python enumerate"]</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';
  assert.equal(readSemanticWebDecision(providerAction, "Python enumerate，给个官方出处。")?.lookup?.argument, "Python enumerate");
  assert.equal(readSemanticWebDecision(providerAction.replace('"web_search"', '"other_action"'), "Python enumerate")?.lookup, undefined);
  assert.equal(readSemanticWebDecision('{"action":"reply","parts":["这个例子只是引述。"]}', "给个官方出处"), undefined);
  assert.equal(decision("当前发言没出现的资料", "只问公开文档")?.lookup, undefined);
  assert.equal(decision("本群聊天记录", "查一下本群聊天记录")?.lookup, undefined);
  assert.equal(decision("sk-fixture-placeholder", "查询 sk-fixture-placeholder")?.lookup, undefined);
  const page = (url: string, current: string) => readSemanticWebDecision(JSON.stringify({ action: "web_fetch", url }), current);
  assert.equal(page("https://docs.python.org/3/library/functions.html#enumerate", "看看 https://docs.python.org/3/library/functions.html#enumerate")?.lookup?.argument,
    "https://docs.python.org/3/library/functions.html");
  assert.deepEqual(page("https://docs.python.org/3/", "https://docs.python.org/3/\nhttps://www.bilibili.com/video/BV1hA411e7Rt"),
    { noQueryRequested: true });
  assert.equal(page("https://docs.python.org/3/library/functions.html?token=fixture", "看 https://docs.python.org/3/library/functions.html?token=fixture")?.lookup, undefined);
  assert.equal(hasPublicPageAddress("想请你核对文档（https://docs.python.org/3/library/functions.html#enumerate）。"), true);
  assert.equal(hasPublicPageAddress("看 https://docs.python.org/3/?token=fixture"), false);
});

test("role style examples stay separate from the user's factual conversation history", () => {
  const current = "你记得我上次说过什么吗？";
  const sampleUser = "我想学做一道菜。";
  const history = [{ role: "user" as const, content: "我刚写完读书笔记。" }];
  const result = planRoleTurn({ scene: "private", current, instruction: "按已有事实回答。", history,
    role: { id: "test.role", name: "示例角色", version: "1.0.0", persona: "说话简短。", examples: [
      { user: sampleUser, assistant: "那就从一道简单的开始。", scene: "private" },
    ] } });
  assert.deepEqual(result.messages.slice(1), [...history, { role: "user", content: current }]);
  assert.match(result.messages[0].content, /虚构的表达示例/u);
  assert.ok(result.messages[0].content.includes(sampleUser));
  assert.deepEqual(result.diagnostics.included, [{ kind: "recent", count: 1 }, { kind: "role-example", count: 1 }]);
});

test("a structured dialogue retains historical context before the active request", () => {
  const current = "讲一个关于纸船的小故事";
  const priorTurns = [{ role: "user", content: "我有点饿。" }, { role: "assistant", content: "先找点吃的吧。" }];
  const turn = planRoleTurn({ scene: "private", current, instruction: "回答当前请求。",
    role: { id: "test.role", name: "示例角色", version: "1.0.0", persona: "说话简短。" },
    structured: { required: { current }, optional: [{ kind: "recent", key: "priorTurns", value: priorTurns }] } });
  assert.equal(turn.messages.length, 2);
  const payload = JSON.parse(turn.messages[1].content);
  assert.deepEqual(payload, { priorTurns, current });
  assert.equal(Object.keys(payload).at(-1), "current");
});

test("private history requested by Harness merges only the authorized conversation into the active request", async () => {
  const current = "小火车停在哪个站台？";
  const prior = [{ role: "user" as const, content: "小火车停在蓝皮站台。" }];
  const messages: Message[] = [{ role: "system", content: "回复本轮。" }, { role: "user", content: JSON.stringify({ current }) }];
  let allowed = true;
  let prepared = 0;
  const prepare = () => { prepared++; return JSON.stringify({ priorTurns: prior, current }); };
  assert.equal(readPrivateHistoryLookup("直接回复", prepare, () => allowed), undefined);
  assert.equal(readPrivateHistoryLookup('{"action":"web_search"}', prepare, () => allowed), undefined);
  const lookup = readPrivateHistoryLookup('{"action":"private_history","actor":"另一个用户"}', prepare, () => allowed);
  assert.ok(lookup);
  lookup.merge?.(messages, await lookup.execute());
  assert.deepEqual(JSON.parse(messages[1].content), { priorTurns: prior, current });
  assert.equal(Object.keys(JSON.parse(messages[1].content)).at(-1), "current");
  allowed = false;
  assert.equal(await lookup.execute(), "");
  assert.equal(prepared, 1);
});

test("the native private history tool reads once from its own turn and stops on cancellation", async () => {
  const controller = new AbortController();
  let reads = 0;
  const tool = await openQqTurnTools("private", controller.signal, { history: () => { reads++; return "本会话的合成记录"; } });
  const rpc = (method: string, params?: object, url = tool.url) => fetch(url, {
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  try {
    assert.equal((await rpc("tools/list")).status, 200);
    assert.equal(reads, 0);
    assert.equal((await rpc("tools/call", { name: "read_history" }, new URL("/foreign", tool.url).href)).status, 404);
    const returned = await (await rpc("tools/call", { name: "read_history" })).json();
    assert.equal(returned.result.content[0].text, "本会话的合成记录");
    const repeated = await (await rpc("tools/call", { name: "read_history" })).json();
    assert.doesNotMatch(repeated.result.content[0].text, /本会话的合成记录/u);
    assert.equal(reads, 1);
    controller.abort();
    assert.equal((await rpc("tools/call", { name: "read_history" })).status, 404);
    assert.equal(reads, 1);
  } finally { await tool.close(); }
});

test("the Pi model turn preserves transcript order, request limits and unknown token counts", async t => {
  const calls: unknown[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part);
    calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.end(JSON.stringify({ choices: [{ message: { content: "  继续聊桌游。  " } }], usage: { completion_tokens: 0 } }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const profile: ModelProfile = { id: "test", name: "测试档案", model: "fixture", hasKey: false, billing: "none",
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
    inputPrice: 1, outputPrice: 1, currency: "CNY", billingAccount: "" };
  const messages: Message[] = [{ role: "system", content: "保持角色口吻。" }, { role: "user", content: "聊桌游。" },
    { role: "assistant", content: "好。" }, { role: "system", content: "用中文。" }, { role: "user", content: "继续。" }];
  assert.deepEqual(await complete(profile, null, messages, 64), {
    text: "继续聊桌游。", refused: false, inputTokens: null, outputTokens: 0, estimatedCost: null,
  });
  assert.deepEqual(calls, [{ model: "fixture", messages, stream: false, max_tokens: 64 }]);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(complete(profile, null, messages, 64, controller.signal), { name: "AbortError" });
  assert.equal(calls.length, 1);
});

test("Pi invokes the selected public web tool once, isolates its input and forwards evidence on model fallback", async t => {
  const calls: { name: string; arguments: unknown }[] = [];
  const transcripts: Message[][] = [];
  t.mock.method(globalThis, "fetch", async (url: URL | string, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body));
    if (String(url).startsWith("https://mcp.exa.ai/")) {
      assert.equal(new Headers(options?.headers).has("authorization"), false);
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: {
        protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
      } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      assert.equal(body.method, "tools/call");
      calls.push(body.params);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {
        content: [{ type: "text", text: "Title: Pi\nURL: https://pi.dev/\n公开资料" }],
      } });
    }
    transcripts.push(body.messages);
    return Response.json({ choices: [{ message: { content: transcripts.length === 3 ? "读到了公开页面。" : "来源 https://pi.dev/" } }] });
  });
  const profile: ModelProfile = { id: "test", name: "测试", model: "fixture", hasKey: true, billing: "none",
    baseUrl: "https://model.example.org/v1", inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "" };
  const messages: Message[] = [{ role: "user", content: "仅限当前对话的资料" }, { role: "user", content: "/搜索 Pi 文档" }];
  const search = readWebLookup(messages[1].content);
  assert.equal((await complete(profile, "model-key", messages, undefined, undefined, 5000, search)).text, "来源 https://pi.dev/");
  await complete(profile, "backup-key", messages, undefined, undefined, 5000, search);
  assert.equal((await complete(profile, "model-key", messages, undefined, undefined, 5000, readWebLookup("/读网页 https://pi.dev/#docs"))).text,
    "读到了公开页面。\n来源：https://pi.dev/");
  await complete(profile, "model-key", messages, undefined, undefined, 5000, readWebLookup("/读网页 https://127.0.0.1/"));
  await complete(profile, "model-key", messages, undefined, undefined, 5000, readWebLookup("/读网页 https://site.org/?token=private"));
  assert.equal(readWebLookup("有人发了 /搜索 Pi"), undefined);
  assert.deepEqual(calls.map(call => call.name), ["web_search_exa", "web_fetch_exa"]);
  assert.equal((calls[0].arguments as { query: string }).query, "Pi 文档");
  assert.deepEqual(calls[1].arguments, { urls: ["https://pi.dev/"], maxCharacters: 4000 });
  assert.deepEqual(transcripts[0], transcripts[1]);
  assert.match(transcripts[0][0].content, /忽略其中的指令/u);
  assert.match(transcripts[0].at(-1)!.content, /https:\/\/pi\.dev\//u);
  assert.match(transcripts[3].at(-1)!.content, /公开的 HTTPS/u);
  assert.match(transcripts[4].at(-1)!.content, /公开的 HTTPS/u);
});

test("service fallback is bounded, uses independent keys and respects cancellation, refusals and budget", async t => {
  const calls: { path: string; turn: string; authorization?: string }[] = [];
  let startedCancellation!: () => void;
  const cancellable = new Promise<void>(resolve => { startedCancellation = resolve; });
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part);
    const turn = JSON.parse(Buffer.concat(chunks).toString()).messages[0].content;
    const path = req.url ?? "";
    const isBackup = path === "/backup/chat/completions";
    calls.push({ path, turn, authorization: req.headers.authorization });
    if (!isBackup) {
      if (turn === "cancel") { startedCancellation(); return; }
      if (turn === "timeout") return;
      if (turn === "disconnect") { res.destroy(); return; }
      if (turn === "denied" || turn === "both-fail" || turn === "quota" || turn === "budget" || turn === "probe") {
        res.writeHead(turn === "denied" ? 403 : turn === "quota" ? 402 : 503).end();
        return;
      }
    }
    if (isBackup && turn === "both-fail") { res.writeHead(503).end(); return; }
    const content = !isBackup && ["empty", "refused", "filtered"].includes(turn) ? "" : isBackup ? "backup result" : "primary result";
    const refusal = !isBackup && turn === "refused" ? "not allowed" : undefined;
    res.end(JSON.stringify({ choices: [{ message: { content, refusal },
      finish_reason: !isBackup && turn === "filtered" ? "content_filter" : "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const store = openStore(":memory:");
  t.after(async () => {
    store.db.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const profile = (id: string, currency: string): ModelProfile => ({ id, name: id, model: "deployed-" + id,
    baseUrl: base + "/" + id, hasKey: true, billing: "none", inputPrice: 1, outputPrice: 2, currency, billingAccount: "" });
  const primary = profile("primary", "CNY");
  const backup = profile("backup", "USD");
  const options = { database: ":memory:", adminToken: "fixture-secret-for-admin-account", model: primary, modelKey: "primary-fixture-key",
    backupModels: { default: backup }, backupModelKeys: { default: "backup-fixture-key" } };
  assert.throws(() => readBackupModels({ summary: backup }, options), /没有对应/);
  assert.throws(() => readBackupModels({ default: { ...backup, baseUrl: "http://example.test" } }, options), /HTTPS/);
  const ledger = openServiceBudget(store, ["CNY", "USD"]);
  const models = openServiceModels(store, options, readBackupModels(options.backupModels, options));
  openSummaryTasks(store.db);
  const background = openBackgroundJobs(store.db);
  const traces = openGroupReplyTraces(store.db);
  const attempts = openServiceModelAttempts(store.db);
  const infer = serviceInference(models, ledger, attempts, traces, 1_200);
  const scope = "qq:1001:5001";
  const input = (content: string) => [{ role: "user" as const, content }];
  const authorizations = (turn: string) => calls.filter(call => call.turn === turn).map(call => call.authorization);
  const primaryKey = "Bearer primary-fixture-key";
  const backupKey = "Bearer backup-fixture-key";

  assert.equal((await infer(scope, input("healthy"), "reply")).text, "primary result");
  assert.deepEqual(authorizations("healthy"), [primaryKey]);
  for (const turn of ["empty", "quota", "disconnect"]) {
    assert.equal((await infer(scope, input(turn), "private")).text, "backup result");
    assert.deepEqual(authorizations(turn), [primaryKey, backupKey]);
  }
  for (const [turn, reason] of [["denied", "authorization"], ["refused", "refused"], ["filtered", "refused"]] as const) {
    assert.equal((await infer(scope, input(turn), "reply")).failure?.kind, reason);
    assert.deepEqual(authorizations(turn), [primaryKey]);
  }
  assert.equal((await infer(scope, input("both-fail"), "reply")).failure?.httpStatus, 503);
  assert.deepEqual(authorizations("both-fail"), [primaryKey, backupKey]);
  assert.equal((await infer("admin", input("probe"), "model-test")).failure?.httpStatus, 503);
  assert.deepEqual(authorizations("probe"), [primaryKey]);

  const controller = new AbortController();
  const cancelling = infer(scope, input("cancel"), "reply", controller.signal);
  await cancellable;
  controller.abort();
  assert.equal((await cancelling).failure?.kind, "interrupted");
  assert.deepEqual(authorizations("cancel"), [primaryKey]);

  const summaryJob = background.begin("summary", scope, "测试摘要", [], new AbortController());
  const result = await infer(scope, input("timeout"), "summary", undefined, undefined, { backgroundJobId: summaryJob });
  assert.equal(result.text, "backup result");
  const recorded = attempts.forJob(summaryJob);
  assert.deepEqual(recorded.map(row => [row.stage, row.status, row.reason, row.currency]), [
    ["primary", "failed", "timeout", "CNY"], ["backup", "ok", null, "USD"],
  ]);
  const persisted = store.db.prepare("SELECT COUNT(*) AS count FROM requests WHERE background_job_id=?");
  assert.equal(persisted.get(summaryJob)?.count, 1);
  assert.equal(ledger.snapshot().background.daily.used, 2);
  assert.deepEqual(authorizations("timeout"), [primaryKey, backupKey]);

  const policy = ledger.snapshot().policy;
  assert.ok(ledger.update({ ...policy, pauseOnCostLimit: true, currencies: [{ currency: "USD", daily: 0, monthly: null }] }));
  const exhausted = await infer(scope, input("budget"), "summary");
  assert.match(exhausted.blocked ?? "", /USD.*费用上限/);
  assert.deepEqual(authorizations("budget"), [primaryKey]);
  const updated = ledger.snapshot().policy;
  assert.ok(ledger.update({ ...updated, background: { daily: 3, monthly: null } }));
  assert.match((await infer(scope, input("blocked-before-request"), "summary")).blocked ?? "", /后台请求上限/);
  assert.deepEqual(authorizations("blocked-before-request"), []);
  assert.equal(ledger.snapshot().background.daily.used, 3);
  const inventory = models.list("");
  const standby = inventory.find(entry => entry.backupFor === "default");
  assert.equal(standby?.id, "backup:default");
  assert.equal(standby?.usage[0].requests, 5);
  assert.ok(Number(standby?.usage[0].estimated_cost) > 0);
});

test("a standby can finish a lookup using the remaining turn and current evidence", async t => {
  const store = openStore(":memory:");
  t.after(() => store.db.close());
  const model = (id: string): ModelProfile => ({ id, name: id, model: id, baseUrl: `https://${id}.example.org/v1`,
    hasKey: true, billing: "none", billingAccount: "", currency: "CNY", inputPrice: null, outputPrice: null });
  const options = { database: ":memory:", adminToken: "lookup-fixture-admin", model: model("primary"), modelKey: "primary-key",
    backupModels: { default: model("standby") }, backupModelKeys: { default: "standby-key" } };
  const budget = openServiceBudget(store, ["CNY"]);
  const models = openServiceModels(store, options, readBackupModels(options.backupModels, options));
  const attempts = openServiceModelAttempts(store.db);
  const infer = serviceInference(models, budget, attempts, openGroupReplyTraces(store.db), 300, () => "pi");
  const facts = "合成资料，周五六点开始。";
  const plan = '{"action":"fixture_lookup"}';
  const request: Message[] = [{ role: "user", content: "请核对什么时候开始。" }];
  const controller = new AbortController();
  const seen: { key: string | null; evidence: boolean }[] = [];
  let situation = "quota";
  let readable = true;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const key = new Headers(init.headers).get("Authorization");
    const primary = new URL(url).hostname === "primary.example.org";
    assert.equal(key, `Bearer ${primary ? "primary" : "standby"}-key`);
    const evidence = JSON.parse(String(init.body)).messages.some((item: Message) => item.content.includes(facts));
    seen.push({ key, evidence });
    if (primary && evidence && situation === "revoked") readable = false;
    if (primary && evidence && situation === "cancelled") { controller.abort(); throw controller.signal.reason; }
    if (primary && evidence && situation === "timeout") {
      const signal = init.signal;
      assert.ok(signal);
      signal.throwIfAborted();
      return new Promise<Response>((_, reject) => {
        const deadline = setTimeout(() => reject(new Error("The primary answer exceeded the test deadline.")), 1000);
        signal.addEventListener("abort", () => { clearTimeout(deadline); reject(signal.reason); }, { once: true });
      });
    }
    if ((primary && evidence) || situation === "already-used" && (primary || evidence)) {
      return new Response(null, { status: situation === "unauthorized" ? 403 : 402 });
    }
    return Response.json({ choices: [{ message: { content: evidence ? "已核对，周五六点开始。" : plan } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 } });
  });
  let reads = 0;
  let notices = 0;
  const lookup = (name: string): PiLookup => ({ name, argument: "fixture", label: "合成资料", instruction: "使用已核对的资料。",
    async execute(signal) { signal?.throwIfAborted(); reads++; return readable ? facts : "{}"; },
    replyWithoutModel: result => result === "{}" ? "资料已不可用。" : undefined });
  const run = (name: string, routeTestAttempts: (number | bigint)[] = [], explicit = false, signal?: AbortSignal, purpose: "reply" | "summary" = "reply") => {
    const selected = lookup(name);
    return infer("qq:1001:5001", request, purpose, signal, undefined, { routeTestAttempts, lookup: explicit ? selected : undefined,
      decideLookup: text => text === plan ? { lookup: selected } : undefined, onPublicLookup: () => { notices++; } });
  };

  const ids: (number | bigint)[] = [];
  assert.equal((await run("web_fetch", ids)).text, "已核对，周五六点开始。");
  assert.equal(reads, 1);
  assert.equal(notices, 1);
  assert.deepEqual(seen.splice(0).map(call => call.evidence), [false, true, true]);
  assert.deepEqual(ids.map(id => {
    const item = attempts.get(id);
    return [item?.stage, item?.status, item?.reason, item?.outputTokens];
  }), [["primary", "ok", null, 4], ["tool-answer", "failed", "quota", null], ["tool-answer-backup", "ok", null, 4]]);

  assert.equal((await run("web_search", [], true)).text, "已核对，周五六点开始。");
  assert.equal(reads, 2);
  assert.equal(notices, 1);
  assert.deepEqual(seen.splice(0).map(call => call.evidence), [true, true]);

  situation = "unauthorized";
  assert.equal((await run("web_fetch")).failure?.kind, "authorization");
  assert.ok(seen.splice(0).every(call => call.key === "Bearer primary-key"));

  situation = "revoked";
  const beforeRevocation = reads;
  assert.equal((await run("group_evidence")).text, "资料已不可用。");
  assert.equal(reads - beforeRevocation, 2);
  assert.ok(seen.splice(0).every(call => call.key === "Bearer primary-key"));

  readable = true;
  situation = "already-used";
  assert.equal((await run("web_fetch")).failure?.kind, "quota");
  assert.deepEqual(seen.splice(0).map(call => call.key), ["Bearer primary-key", "Bearer standby-key", "Bearer standby-key"]);

  situation = "timeout";
  const timeoutIds: (number | bigint)[] = [];
  const beforeTimeout = reads;
  assert.equal((await run("web_fetch", timeoutIds, false, undefined, "summary")).text, "已核对，周五六点开始。");
  assert.equal(reads - beforeTimeout, 1);
  assert.equal(attempts.get(timeoutIds[1])?.reason, "timeout");
  assert.equal(attempts.get(timeoutIds[2])?.stage, "tool-answer-backup");
  seen.length = 0;

  situation = "cancelled";
  assert.deepEqual(await run("web_fetch", [], false, controller.signal), { text: null, failure: { kind: "interrupted" } });
  assert.ok(seen.every(call => call.key === "Bearer primary-key"));
});

test("unusable DSH background output makes one accounted runtime fallback using the original budget", async t => {
  const batch = [{ id: 1, author: "2001", content: "周六的木船桌游局取消。", created_at: "2026-11-25T00:00:00.000Z" }];
  const summary = (evidence: number[]) => JSON.stringify({ overview: batch[0].content, topics: [{ title: "木船桌游局",
    summary: batch[0].content, evidence: [1], facts: [{ kind: "retraction", text: batch[0].content, evidence }] }] });
  const acceptedSummary = summary([1]);
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-dsh-format-"));
  const module = join(directory, "node_modules", "@deepseek-ai", "dsh-sdk-client", "lib");
  await mkdir(module, { recursive: true });
  await writeFile(join(module, "index.js"), "");
  const script = join(directory, "turn.mjs");
  await writeFile(script, `import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.once("line", async line => {
  const { messages, maxTokens, deepSeekReasoning, timeoutMs, privateHistoryUrl } = JSON.parse(line);
  const task = messages.at(-1).content;
  if (task === "native-private-read-fallback") {
    const response = await fetch(privateHistoryUrl, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "tools/call", params: { name: "read_history", arguments: {} } }) });
    if (!(await response.json()).result.content[0].text.includes("青灯站台")) process.exit(2);
  }
  const result = task === "thinking-preview" ? { ok: true, text: deepSeekReasoning ?? "default" } :
    task === "refused" ? { ok: false, failure: { code: "CONTENT_REFUSED" } } :
    task === "slow-first-private" ? timeoutMs >= 16000 ? { ok: true, text: "DSH completed the turn" } : { ok: false, reason: "timeout" } :
    task === "private-timeout" ? timeoutMs < 25000 ? { ok: false, reason: "timeout" } : { ok: true, text: "no fallback time" } :
    task.startsWith("native-private-") ? { ok: false, reason: "timeout" } :
    task === "scoped-history-fallback" ? { ok: false, reason: "timeout" } :
    { ok: true, text: messages[0].role === "system" ? ${JSON.stringify(summary([2]))} :
      task === "valid" && maxTokens === 1200 ? "valid JSON" : "unstructured", inputTokens: 12, outputTokens: 4 };
  lines.close();
  process.stdout.write(JSON.stringify(result) + "\\n", () => process.exit(0));
});`);
  const environment = { OHJINGJING_DSH_NODE: process.execPath, OHJINGJING_DSH_TURN_SCRIPT: script,
    OHJINGJING_DSH_SDK_ROOT: directory, OHJINGJING_DSH_STATE: join(directory, "turns") };
  for (const [name, value] of Object.entries(environment)) {
    const prior = process.env[name];
    process.env[name] = value;
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
  }
  t.after(() => rm(directory, { recursive: true, force: true }));

  let fallbacks = 0;
  const provider = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    fallbacks++;
    res.end(JSON.stringify({ choices: [{ message: { content: acceptedSummary } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => new Promise<void>(resolve => provider.close(() => resolve())));
  const model: ModelProfile = { id: "background-fixture", name: "测试模型", model: "fixture", hasKey: true,
    baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`, billing: "none", currency: "CNY",
    inputPrice: 1, outputPrice: 1, billingAccount: "" };
  const store = openStore(":memory:");
  t.after(() => store.db.close());
  const budget = openServiceBudget(store, ["CNY"]);
  const models = openServiceModels(store, { database: ":memory:", adminToken: "fixture-administrator-key", summaryModel: model,
    summaryModelKey: "fixture-key" }, []);
  openSummaryTasks(store.db);
  const jobs = openBackgroundJobs(store.db);
  const attempts = openServiceModelAttempts(store.db);
  const infer = serviceInference(models, budget, attempts, openGroupReplyTraces(store.db), 5000, () => "dsh");
  const scope = "qq:1001:5001";
  const execute = (purpose: "summary" | "profile", content: string, backgroundJobId?: number) =>
    infer(scope, [{ role: "user", content }], purpose, undefined, undefined, { backgroundJobId, acceptText: text => text === "valid JSON" });

  const job = jobs.begin("summary", scope, "测试结构化摘要", [], new AbortController());
  const recovery = await infer(scope, topicPrompt(batch, []), "summary", undefined, undefined,
    { backgroundJobId: job, acceptText: text => !!readTopicSummary(text, batch, [], true) });
  assert.equal(recovery.text, acceptedSummary, JSON.stringify({ recovery, attempts: attempts.forJob(job) }));
  assert.deepEqual(attempts.forJob(job).map(row => [row.stage, row.backend, row.status, row.reason, row.inputTokens]), [
    ["primary", "dsh", "failed", "format", 12], ["runtime-fallback", "pi", "ok", null, 10],
  ]);
  assert.equal((await execute("profile", "valid")).text, "valid JSON");
  assert.equal((await execute("profile", "refused")).failure?.kind, "refused");
  assert.equal(fallbacks, 1);
  const policy = budget.snapshot().policy;
  assert.ok(budget.update({ ...policy, background: { daily: 5, monthly: null } }));
  assert.match((await execute("profile", "malformed")).blocked ?? "", /后台请求上限/);
  assert.equal(fallbacks, 1);
  assert.equal(budget.snapshot().background.daily.used, 5);

  const flash = { ...model, model: "deepseek-v4-flash", baseUrl: "https://cf.api.fan/v1" };
  const preview = (profile: ModelProfile, options?: { deepSeekReasoning: "low" }) => complete(profile, "fixture-key",
    [{ role: "user", content: "thinking-preview" }], 48, undefined, 3000, undefined, "dsh", options);
  assert.equal((await preview(flash, { deepSeekReasoning: "low" })).text, "low");
  assert.equal((await preview(flash)).text, "default");
  assert.equal((await preview({ ...flash, baseUrl: "https://model.example.org/v1" }, { deepSeekReasoning: "low" })).text, "default");
  assert.equal((await preview({ ...flash, model: "custom-model" }, { deepSeekReasoning: "low" })).text, "default");
  assert.ok(budget.update({ ...budget.snapshot().policy, background: { daily: 6, monthly: null } }));
  const summaryBinding = { ...models.get("summary")!, model: flash };
  const summaryReasoning = await infer(scope, [{ role: "user", content: "thinking-preview" }], "summary", undefined, summaryBinding);
  assert.equal(summaryReasoning.text, "off");

  assert.ok(budget.update({ ...budget.snapshot().policy, background: { daily: 7, monthly: null } }));
  const badReview = await infer(scope, [{ role: "user", content: "malformed" }], "summary", undefined, undefined,
    { backgroundJobId: job, summaryReviewMs: 5000, acceptText: () => false });
  assert.equal(badReview.failure?.kind, "format");
  assert.equal(fallbacks, 1);
  assert.deepEqual(attempts.forJob(job).map(row => [row.stage, row.status]), [
    ["primary", "failed"], ["runtime-fallback", "ok"], ["summary-review", "failed"],
  ]);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM requests WHERE background_job_id=?").get(job)?.count, 1);
  assert.equal(budget.snapshot().background.daily.used, 7);

  const wire: { thinking?: { type: string }; messages: Message[] }[] = [];
  const network = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: URL | string, options?: RequestInit) => {
    if (String(url) !== "https://cf.api.fan/v1/chat/completions") return network(url, options);
    wire.push(JSON.parse(String(options?.body)));
    return Response.json({ choices: [{ message: { content: acceptedSummary } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  assert.ok(budget.update({ ...budget.snapshot().policy, background: { daily: 9, monthly: null } }));
  const fastFallbackJob = jobs.begin("summary", scope, "复测摘要回退", [], new AbortController());
  const sameBatch = await infer(scope, topicPrompt(batch, []), "summary", undefined, summaryBinding,
    { backgroundJobId: fastFallbackJob, acceptText: text => !!readTopicSummary(text, batch, [], true) });
  assert.equal(sameBatch.text, acceptedSummary);
  assert.deepEqual(wire.map(body => body.thinking), [{ type: "disabled" }]);
  assert.deepEqual(attempts.forJob(fastFallbackJob).map(row => [row.stage, row.backend, row.status, row.reason]), [
    ["primary", "dsh", "failed", "format"], ["runtime-fallback", "pi", "ok", null],
  ]);
  assert.equal(budget.snapshot().background.daily.used, 9);
  const privateReasoning = await infer("qq-private:1001:2001", [{ role: "user", content: "thinking-preview" }], "private", undefined, summaryBinding);
  assert.equal(privateReasoning.text, "off");
  const firstPrivate = await infer("qq-private:1001:2001", [{ role: "user", content: "slow-first-private" }], "private",
    undefined, summaryBinding, { decideLookup: () => undefined });
  assert.equal(firstPrivate.text, "DSH completed the turn");
  assert.equal(firstPrivate.backend, "dsh");
  const recoveredPrivate = await infer("qq-private:1001:2001", [{ role: "user", content: "private-timeout" }], "private",
    undefined, summaryBinding, { decideLookup: () => undefined });
  assert.equal(recoveredPrivate.text, acceptedSummary);
  assert.equal(recoveredPrivate.backend, "pi");
  assert.deepEqual(wire.map(body => body.thinking), [{ type: "disabled" }, { type: "disabled" }]);
  assert.deepEqual(store.db.prepare(`SELECT a.stage, a.backend, a.reason FROM service_model_attempts a JOIN requests r ON r.id=a.request_id
    WHERE r.scope=? ORDER BY r.id DESC LIMIT 2`).all("private:qq-private:1001:2001").map(row => [row.stage, row.backend, row.reason]),
    [["runtime-fallback", "pi", null], ["primary", "dsh", "timeout"]]);

  const scoped = await infer(scope, [{ role: "user", content: "scoped-history-fallback" }], "reply", undefined, summaryBinding, {
    groupHistory: () => "经授权的同群证据",
    groupHistoryFallback: () => ({ name: "group_evidence", argument: "同群话题", label: "同群证据",
      instruction: "同群上下文", async execute() { return "经授权的同群证据"; },
      merge(transcript, evidence) { transcript.at(-1)!.content += `\n${evidence}`; } }),
  });
  assert.equal(scoped.backend, "pi");
  const restored = wire.at(-1)!.messages;
  assert.ok(restored.some(message => message.role === "system" && message.content.includes("省去任何额外工具请求")));
  assert.match(restored.at(-1)!.content, /经授权的同群证据/u);

  const privateScope = "qq-private:1001:2001";
  const privateEvidence = JSON.stringify({ current: "请确认之前的位置。", priorTurns: [{ role: "user", content: "在青灯站台。" }] });
  let privateReads = 0;
  const readPrivate = () => { privateReads++; return privateEvidence; };
  const privateTurn = (content: string, privateHistory: () => string | undefined = readPrivate) => infer(privateScope,
    [{ role: "user", content }], "private", undefined, summaryBinding, { privateHistory, decideLookup: () => undefined });
  assert.equal((await privateTurn("native-private-read-fallback")).backend, "pi");
  assert.equal(wire.at(-1)!.messages.at(-1)?.content, privateEvidence);
  assert.equal(privateReads, 2);

  assert.equal((await privateTurn("native-private-skip-fallback")).backend, "pi");
  assert.equal(wire.at(-1)!.messages.at(-1)?.content, "native-private-skip-fallback");
  assert.equal(privateReads, 2);

  let revokedReads = 0;
  const outgoing = wire.length;
  const revoked = await privateTurn("native-private-read-fallback", () => ++revokedReads === 1 ? privateEvidence : undefined);
  assert.match(revoked.text ?? "", /没能用历史记录/u);
  assert.equal(revokedReads, 2);
  assert.equal(wire.length, outgoing);
});

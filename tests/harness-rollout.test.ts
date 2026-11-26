import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { desktopHarnessRollout, qqAccountHarnessScope, serviceHarnessRollout } from "../runtime/harness-rollout";
import { openGroupReplyTraces } from "../runtime/group-reply-traces";
import { complete, type ModelProfile } from "../runtime/models";
import { readSpaceDraft } from "../runtime/qq-space-draft";
import { openServiceBudget } from "../runtime/service-budget";
import { serviceInference } from "../runtime/service-inference";
import { openServiceModelAttempts } from "../runtime/service-model-attempts";
import { openServiceModels } from "../runtime/service-models";
import { openStore } from "../runtime/store";

test("DSH can be selected per workflow and QQ group without changing other purposes", () => {
  const server = serviceHarnessRollout({ purposes: ["reply", "summary", "private"], groups: ["5001"] })!;
  assert.equal(server("reply", "qq:1001:5001"), "dsh");
  assert.equal(server("reply", "qq:1001:5002"), "pi");
  assert.equal(server("summary", "qq:1001:5001"), "dsh");
  assert.equal(server("profile", "qq:1001:5001"), "pi");
  assert.equal(server("conversation-preview", "qq:1001:5001"), "pi");
  const conversation = serviceHarnessRollout({ purposes: ["proactive"], groups: ["5001"] })!;
  assert.equal(conversation("proactive", "qq:1001:5001"), "dsh");
  assert.equal(conversation("conversation-preview", "qq:1001:5001"), "dsh");
  assert.equal(conversation("conversation-preview", "qq:1001:5002"), "pi");
  assert.equal(server("private", "qq-private:1001:2001"), "dsh");
  const privatePilot = serviceHarnessRollout({ purposes: ["private", "reply"], groups: ["5001"],
    privateContacts: [{ accountId: "1001", userId: "2001" }] })!;
  assert.equal(privatePilot("private", "qq-private:1001:2001"), "dsh");
  assert.equal(privatePilot("private", "qq-private:1001:2002"), "pi");
  assert.equal(privatePilot("private", "qq-private:1002:2001"), "pi");
  assert.equal(privatePilot("reply", "qq:1001:5001"), "dsh");
  assert.equal(serviceHarnessRollout({ purposes: ["private"], privateContacts: [] })!("private", "qq-private:1001:2001"), "pi");
  assert.throws(() => serviceHarnessRollout({ purposes: ["private"], privateContacts: [{ accountId: "1001", userId: "1001" }] }));
  assert.equal(serviceHarnessRollout({ purposes: [] })!("reply", "qq:1001:5001"), "pi");
  assert.throws(() => serviceHarnessRollout({ purposes: ["reply"], groups: ["not-a-qq-group"] }));
  const accountPilot = serviceHarnessRollout({ purposes: ["role-diary", "qzone", "reply"], groups: ["5001"], accounts: ["1001"] })!;
  assert.equal(accountPilot("role-diary", qqAccountHarnessScope("1001")), "dsh");
  assert.equal(accountPilot("qzone", qqAccountHarnessScope("1001")), "dsh");
  assert.equal(accountPilot("qzone", qqAccountHarnessScope("1002")), "pi");
  assert.equal(accountPilot("qzone", "qq:1001:5001"), "pi");
  assert.equal(accountPilot("reply", "qq:1001:5001"), "dsh");
  assert.equal(serviceHarnessRollout({ purposes: ["qzone"] })!("qzone", qqAccountHarnessScope("1001")), "pi");
  assert.throws(() => serviceHarnessRollout({ purposes: ["qzone"], accounts: ["invalid-qq"] }));
  const desktop = desktopHarnessRollout("desktop,profile-explanation");
  assert.equal(desktop("desktop"), "dsh");
  assert.equal(desktop("profile-explanation"), "dsh");
  assert.equal(desktop("summary-explanation"), "pi");
  assert.equal(desktopHarnessRollout(undefined)("desktop"), undefined);
  const bundled = desktopHarnessRollout(undefined, true);
  const packy = { baseUrl: "https://cf.api.fan/v1", model: "deepseek-flash" };
  assert.equal(bundled("desktop", packy), "dsh");
  assert.equal(bundled("desktop-checkpoint", { ...packy, model: "deepseek-v4-flash" }), "dsh");
  assert.equal(bundled("summary-explanation", packy), "dsh");
  assert.equal(bundled("profile-explanation", packy), "dsh");
  assert.equal(bundled("desktop", { ...packy, baseUrl: "https://cf.api.fan.example.org/v1" }), "pi");
  assert.equal(bundled("summary-explanation", { ...packy, baseUrl: "https://cf.api.fan.example.org/v1" }), "pi");
  assert.equal(bundled("desktop", { ...packy, model: "another-model" }), "pi");
  assert.equal(bundled("memory-extraction", packy), "dsh");
  assert.equal(bundled("role-rehearsal", packy), "dsh");
  assert.equal(bundled("memory-extraction", { ...packy, model: "another-model" }), "pi");
  assert.equal(desktopHarnessRollout("", true)("desktop", packy), "pi");
  assert.throws(() => desktopHarnessRollout("unknown"));
});

test("a missing DSH runtime falls back before the model call without repeating lookup or counting another request", async t => {
  const prior = process.env.OHJINGJING_DSH_NODE;
  delete process.env.OHJINGJING_DSH_NODE;
  t.after(() => { if (prior !== undefined) process.env.OHJINGJING_DSH_NODE = prior; });
  const requests: { stream: boolean; messages: unknown[] }[] = [];
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "读取成功" } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => new Promise<void>(resolve => provider.close(() => resolve())));
  const profile: ModelProfile = { id: "runtime-fixture", name: "运行时测试", baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
    model: "fixture", billing: "none", hasKey: true, inputPrice: 1, outputPrice: 1, currency: "CNY", billingAccount: "" };
  let lookups = 0;
  const result = await complete(profile, "fixture-key", [{ role: "user", content: "请核对资料" }], 120, undefined, 3000, {
    name: "fixture", argument: "data", label: "读取", instruction: "只用已取得的资料。",
    async execute() { lookups++; return "合成证据 42"; },
    formatReply: (text, evidence) => text + " · " + evidence,
  }, "dsh");
  assert.equal(lookups, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].stream, false);
  assert.match(JSON.stringify(requests[0].messages), /合成证据 42/u);
  assert.equal(result.backend, "pi");
  assert.equal(result.text, "读取成功 · 合成证据 42");
  assert.equal(result.inputTokens, 12);
  assert.equal(result.outputTokens, 4);
});

test("the DSH wrapper preserves usage, interruption and provider status without forwarding error text", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-dsh-token-ceiling-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sdk = join(directory, "node_modules", "@deepseek-ai", "dsh-sdk-client");
  await mkdir(join(sdk, "lib"), { recursive: true });
  await writeFile(join(sdk, "package.json"), '{"type":"module"}');
  const providerFailures = {
    quota: { code: "PI_AI_ERROR", message: '402: {"message":"private fixture body"}' },
    denied: { code: "AUTH", status: 403, message: '402: {"message":"private fixture body"}' },
    generic: { code: "PI_AI_ERROR", message: "Model failure containing 402 in the body" },
    timeout: { code: "TIMEOUT", message: "408: provider timed out" },
  };
  await writeFile(join(sdk, "lib", "index.js"), `export class DeepSeekHarness {
  async start() {}
  async run(prompt) {
    const error = ${JSON.stringify(providerFailures)}[prompt];
    if (error) return { finishReason: "error", finalResponse: "", events: [
      { type: "turn/end", data: { reason: { kind: "error", error } } },
    ] };
    return { finishReason: "max-tokens", finalResponse: "", events: [
      { type: "assistant/message", data: { usage: { inputTokens: 20, outputTokens: 600 } } },
      { type: "turn/end", data: { reason: { kind: "max-tokens" } } },
    ] };
  }
  async close() {}
}`);
  async function runWrapper(interrupt: boolean, prompt = "测试输出上限") {
    const child = spawn(process.execPath, [resolve("scripts", "dsh-text-turn.mjs")], {
      cwd: directory, env: { ...process.env, OHJINGJING_DSH_SDK_ROOT: directory }, windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timeout = setTimeout(() => child.kill(), 5000);
    const exited = once(child, "close").finally(() => clearTimeout(timeout));
    let output = "";
    child.stdout.setEncoding("utf8").on("data", chunk => {
      output += chunk;
      if (output.includes("\n")) child.stdin.end();
    });
    const turn = { profile: { model: "fixture", baseUrl: "https://model.example.org/v1" }, key: "fixture-only",
      messages: [{ role: "user", content: prompt }], maxTokens: 600 };
    child.stdin.write(JSON.stringify(turn) + (interrupt ? "\n\n" : "\n"));
    assert.equal((await exited)[0], 0);
    return JSON.parse(output);
  }
  assert.deepEqual(await runWrapper(false), { ok: true, text: "", inputTokens: 20, outputTokens: 600, reason: "max-tokens" });
  assert.deepEqual(await runWrapper(true), { ok: false, reason: "cancelled" });
  const baseline = { ok: false, text: "", inputTokens: null, outputTokens: null, reason: "error" };
  assert.deepEqual(await runWrapper(false, "quota"), { ...baseline, failure: { code: "PI_AI_ERROR", status: 402 } });
  assert.deepEqual(await runWrapper(false, "denied"), { ...baseline, failure: { code: "AUTH", status: 403 } });
  assert.deepEqual(await runWrapper(false, "generic"), { ...baseline, failure: { code: "PI_AI_ERROR" } });
  assert.deepEqual(await runWrapper(false, "timeout"), { ...baseline, failure: { code: "TIMEOUT", status: 408 } });
});

test("structured drafts preserve attribution when the DSH runtime returns invalid content or a profile timeout", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ohjingjing-scoped-account-drafts-"));
  const sdk = join(directory, "sdk");
  const library = join(sdk, "node_modules", "@deepseek-ai", "dsh-sdk-client", "lib", "index.js");
  await mkdir(dirname(library), { recursive: true });
  await writeFile(library, "");
  const runner = join(directory, "fixture.mjs");
  await writeFile(runner, "process.stdout.write(JSON.stringify({ok:true,text:'invalid',inputTokens:41,outputTokens:9})+'\\n');");
  const config = { OHJINGJING_DSH_NODE: process.execPath, OHJINGJING_DSH_TURN_SCRIPT: runner,
    OHJINGJING_DSH_SDK_ROOT: sdk, OHJINGJING_DSH_STATE: join(directory, "turns") };
  const original = Object.fromEntries(Object.keys(config).map(name => [name, process.env[name]]));
  Object.assign(process.env, config);
  let calls = 0;
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(req.headers.authorization, "Bearer account-fixture");
    calls++;
    const response = body.includes("群画像样本") ? '{"summary":"群内讨论过纸船。","evidence":[1,2]}' : '{"content":"纸船浮起来了。"}';
    res.end(JSON.stringify({ choices: [{ message: { content: response } }],
      usage: { prompt_tokens: 30, completion_tokens: 10 } }));
  });
  const store = openStore(":memory:");
  t.after(async () => {
    store.db.close();
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise<void>(done => provider.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const model: ModelProfile = { id: "account-fixture", name: "Model", model: "fixture", hasKey: true,
    baseUrl: "http://127.0.0.1:" + (provider.address() as AddressInfo).port + "/v1",
    billing: "none", billingAccount: "", currency: "CNY", inputPrice: 1, outputPrice: 1 };
  const budget = openServiceBudget(store, ["CNY"]);
  const models = openServiceModels(store, { database: ":memory:", adminToken: "scoped-account-fixture-admin", model, modelKey: "account-fixture" }, []);
  const attemptJournal = openServiceModelAttempts(store.db);
  const choose = serviceHarnessRollout({ purposes: ["role-diary", "profile"], accounts: ["1001"], groups: ["5001"] });
  const infer = serviceInference(models, budget, attemptJournal, openGroupReplyTraces(store.db), 15000, choose);
  const messages = [{ role: "user" as const, content: "合成的纸船素材" }];
  const output = await infer("sample-operator-event", messages, "role-diary", undefined, undefined, {
    backendScope: qqAccountHarnessScope("1001"), acceptText: text => !!readSpaceDraft(text),
  });
  assert.equal(output.text, '{"content":"纸船浮起来了。"}');
  assert.equal(calls, 1);
  const rows = store.db.prepare("SELECT scope,status,input_tokens FROM requests ORDER BY id").all();
  assert.deepEqual(rows.map(row => [row.scope, row.status, row.input_tokens]),
    [["role-diary:sample-operator-event", "failed", 41], ["role-diary:sample-operator-event", "ok", 30]]);
  assert.deepEqual([1, 2].map(id => {
    const item = attemptJournal.get(id);
    return [item?.stage, item && "backend" in item ? item.backend : null, item?.reason];
  }), [["primary", "dsh", "format"], ["runtime-fallback", "pi", null]]);
  await infer("another-account-event", messages, "role-diary", undefined, undefined, { backendScope: qqAccountHarnessScope("1002") });
  assert.equal(calls, 2);

  await writeFile(runner, "process.stdout.write(JSON.stringify({ok:false,reason:'timeout'})+'\\n');");
  const groupProfile = await infer("qq:1001:5001", [{ role: "user", content: "群画像样本" }], "profile", undefined, undefined, {
    acceptText: text => Array.isArray(JSON.parse(text).evidence),
  });
  assert.equal(groupProfile.text, '{"summary":"群内讨论过纸船。","evidence":[1,2]}');
  assert.equal(calls, 3);
  assert.deepEqual([4, 5].map(id => {
    const item = attemptJournal.get(id);
    return [item?.stage, item && "backend" in item ? item.backend : null, item?.reason, item?.status];
  }), [["primary", "dsh", "timeout", "failed"], ["runtime-fallback", "pi", null, "ok"]]);
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createGroupService } from "../runtime/group-service";
import type { ModelProfile } from "../runtime/models";

test("billing overview groups accounts and identical keys, remembers outcomes and expires or removes old snapshots", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ohjingjing-service-balances-"));
  const database = join(dir, "service.db");
  const admin = "fixture-balance-admin-token";
  const profile = (id: string, billingAccount = "", billing: "deepseek" | "openrouter" = "deepseek"): ModelProfile => ({
    id, name: id, model: "fixture", hasKey: true, currency: "USD", inputPrice: null, outputPrice: null,
    baseUrl: billing === "deepseek" ? "https://api.deepseek.com/v1" : "https://openrouter.ai/api/v1",
    billing, billingAccount,
  });
  const options = {
    database, adminToken: admin, model: profile("Default", "主账户"), modelKey: "fixture-unauthorized",
    summaryModel: profile("Summary", "主账户"), summaryModelKey: "fixture-authorized",
    modelProfiles: {
      same: profile("Shared"), unnamed: profile("Independent"),
      routerA: profile("Router A", "同一组", "openrouter"), routerB: profile("Router B", "同一组", "openrouter"),
      routerAlias: profile("Router alias", "其他标签", "openrouter"),
      conflictA: profile("Conflicting A", "标签一"), conflictB: profile("Conflicting B", "标签二"),
      missing: profile("Missing"), custom: { ...profile("Custom"), baseUrl: "https://llm.example.invalid/v1" },
    },
    modelProfileKeys: {
      same: "fixture-authorized", unnamed: "fixture-unnamed", routerA: "fixture-router-a", routerB: "fixture-router-b",
      routerAlias: "fixture-router-b", conflictA: "fixture-conflict", conflictB: "fixture-conflict", custom: "fixture-custom",
    },
  };
  const realFetch = globalThis.fetch;
  const hits = new Map<string, number>();
  let allow = true;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    assert.ok(["https://api.deepseek.com/user/balance", "https://openrouter.ai/api/v1/key"].includes(url));
    const key = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
    hits.set(key, (hits.get(key) ?? 0) + 1);
    await delay(25);
    if (key === "fixture-unauthorized" || (key === "fixture-authorized" && !allow)) return new Response(null, { status: 403 });
    if (url.includes("deepseek")) return Response.json({ balance_infos: [
      { currency: "CNY", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" },
      { currency: "USD", total_balance: "3.50", topped_up_balance: "3.50" },
    ] });
    return Response.json({ data: key === "fixture-router-a" ? { limit: null, usage: 2.5 } : { limit: 10, limit_remaining: 0, usage: 10 } });
  });

  let service: ReturnType<typeof createGroupService> | undefined;
  t.after(async () => {
    await service?.stop();
    await rm(dir, { recursive: true, force: true });
  });
  async function start(config = options) {
    service = createGroupService(config);
    service.server.listen(0, "127.0.0.1");
    await once(service.server, "listening");
    return "http://127.0.0.1:" + (service.server.address() as AddressInfo).port;
  }
  let base = await start();
  const path = "/admin/model-balances";
  const request = (endpoint: string, method = "GET", token = admin) =>
    fetch(base + endpoint, { method, headers: { Authorization: "Bearer " + token } });
  async function json(endpoint = path, method = "GET") {
    const response = await request(endpoint, method);
    assert.equal(response.status, 200);
    return response.json();
  }
  const find = (report: any, id: string) => report.subjects.find((item: any) => item.profiles.some((member: any) => member.id === id));
  const initial = await json();
  assert.equal(initial.subjects.length, 5);
  assert.ok(initial.subjects.every((item: any) => item.latest === null));
  assert.equal((await request(path, "GET", "subscriber-fixture")).status, 403);
  assert.equal((await request(path, "POST", "subscriber-fixture")).status, 403);
  assert.equal((await json("/admin/models/profile%3Amissing/balance")).status, "unsupported");
  assert.equal((await json("/admin/models/profile%3Acustom/balance")).status, "unsupported");
  assert.equal(hits.size, 0);

  const [report, concurrent] = await Promise.all([json(path, "POST"), json(path, "POST")]);
  assert.deepEqual(report, concurrent);
  const account = find(report, "default");
  assert.equal(account.accountLabel, "主账户");
  assert.equal(account.scope, "account");
  assert.deepEqual(account.profiles.map((member: any) => member.id), ["default", "summary", "profile:same"]);
  assert.deepEqual(account.latest.values.map((value: any) => [value.currency, value.remaining]), [["CNY", "0.00"], ["USD", "3.50"]]);
  assert.equal(find(report, "profile:unnamed").accountLabel, null);
  assert.equal(find(report, "profile:conflictA").accountConflict, true);
  assert.equal(find(report, "profile:routerA").latest.status, "unlimited");
  assert.equal(find(report, "profile:routerB").latest.values[0].remaining, 0);
  assert.equal(find(report, "profile:routerAlias").profiles.length, 2);
  assert.equal(find(report, "profile:routerA").profiles.length, 1);
  assert.equal(hits.size, 6);
  assert.ok([...hits.values()].every(count => count === 1));
  assert.doesNotMatch(JSON.stringify(report), /fixture-(?:authorized|router)|[a-f\d]{64}/u);

  allow = false;
  assert.equal((await json("/admin/models/summary/balance")).status, "denied");
  const failed = find(await json(), "default");
  assert.equal(failed.latest.status, "denied");
  assert.equal(failed.lastSuccessful.values[0].remaining, "0.00");
  assert.equal(failed.stale, false);
  const db = new DatabaseSync(database);
  try {
    const old = new Date(Date.now() - 16 * 60_000).toISOString();
    db.prepare("UPDATE provider_balance_snapshots SET last_successful=json_set(last_successful, '$.checkedAt', ?)").run(old);
  } finally { db.close(); }

  await service?.stop();
  service = undefined;
  base = await start({ ...options, modelProfileKeys: { ...options.modelProfileKeys, routerA: "fixture-rotated" } });
  const restored = await json();
  assert.equal(find(restored, "default").latest.status, "denied");
  assert.equal(find(restored, "default").stale, true);
  assert.equal(find(restored, "profile:routerA").latest, null);
  assert.equal(find(restored, "profile:routerB").latest.values[0].remaining, 0);
  assert.equal(hits.has("fixture-rotated"), false);
});

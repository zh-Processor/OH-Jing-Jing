import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createGroupService, type GroupServiceOptions } from "../runtime/group-service";
import type { ModelProfile } from "../runtime/models";
import { openServiceModelRoutes } from "../runtime/service-model-routes";

test("existing route revisions inherit their configured standby after migration", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE service_model_routes (route TEXT NOT NULL, version INTEGER NOT NULL, binding_id TEXT, fingerprint TEXT," +
      " operation TEXT NOT NULL, restored_version INTEGER, actor TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(route,version))");
    db.prepare("INSERT INTO service_model_routes VALUES('default',1,'profile:fixture','original','select',NULL,'administrator',?)")
      .run(new Date().toISOString());
    const routes = openServiceModelRoutes(db);
    assert.equal(routes.current("default")?.standbyMode, "inherit");
    assert.equal(routes.current("default")?.bindingId, "profile:fixture");
    assert.deepEqual(routes.change("default", 1, { ...routes.current("default")!, standbyMode: "disabled" }, null),
      { status: "ok", version: 2 });
    assert.equal(routes.revision("default", 1)?.standbyMode, "inherit");
    assert.equal(routes.current("default")?.standbyMode, "disabled");
  } finally { db.close(); }
});

test("model route changes persist, reject stale revisions, and roll back within their original scopes", async t => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-model-routes-"));
  const model = (id: string): ModelProfile => ({ id, name: id, model: id + "-deployment", baseUrl: "http://127.0.0.1:3201/" + id,
    hasKey: true, billing: "none", billingAccount: "", inputPrice: null, outputPrice: null, currency: "CNY" });
  const options: GroupServiceOptions = { database: join(directory, "server.db"), adminToken: "fixture-secret-for-model-routes", model: model("base"),
    modelKey: "default-fixture-key", modelProfiles: { first: model("first"), second: model("second"), empty: model("empty") },
    modelProfileKeys: { first: "first-profile-fixture-key", second: "second-profile-fixture-key" },
    groupModels: { "5001": model("dedicated") }, groupModelKeys: { "5001": "group-only-fixture-key" },
    channel: { address: "ws://127.0.0.1:3202", enabled: false, groups: ["5001", "5002"], roleId: "", modelId: "", hasToken: false,
      expectedBotId: "1001" } };
  let running: ReturnType<typeof createGroupService> | undefined;
  let base!: string;
  async function start(settings = options) {
    running = createGroupService(settings);
    running.server.listen(0, "127.0.0.1");
    await once(running.server, "listening");
    running.startChannel();
    base = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
  }
  t.after(async () => {
    await running?.stop();
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), root);
    await rm(resolved, { recursive: true, force: true });
  });
  await start();
  const first = "profile:first";
  const second = "profile:second";
  const group = "qq:1001:5001";
  const other = "qq:1001:5002";
  const path = "/admin/model-routes";
  const authorization = `Bearer ${options.adminToken}`;
  const read = (route = "default", token = authorization) => fetch(base + path + "?" + new URLSearchParams({ route }), { headers: { Authorization: token } });
  const apply = (route: string, expectedVersion: number, bindingId: string | null) => write("PUT", { route, expectedVersion, bindingId });
  const restore = (route: string, expectedVersion: number, restoreVersion: number) => write("POST", { route, expectedVersion, restoreVersion });
  const write = (method: string, data: object) => fetch(base + path, { method,
    headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify(data) });

  assert.equal((await read("default", "Bearer not-an-admin")).status, 403);
  assert.equal((await read("qq:1002:5001")).status, 404);
  assert.equal((await read("qq:1001:5003")).status, 404);
  const initial = await (await read()).json();
  assert.equal(initial.version, 0);
  assert.equal(initial.effectiveBindingId, "default");
  assert.equal(initial.choices.find((choice: { id: string }) => choice.id === "profile:empty").available, false);
  assert.equal((await apply("default", 0, "profile:empty")).status, 422);
  assert.equal((await apply(other, 0, "group:5001")).status, 422);
  assert.equal((await apply("summary", 0, "group:5001")).status, 422);
  assert.equal((await apply("private", 0, "group:5001")).status, 422);
  assert.doesNotMatch(JSON.stringify(initial), /profile-fixture-key|group-only-fixture-key/);

  const competing = await Promise.all([apply("default", 0, first), apply("default", 0, second)]);
  assert.deepEqual(competing.map(response => response.status).sort(), [200, 409]);
  const winner = await competing.find(response => response.ok)!.json();
  const alternative = winner.selectedBindingId === first ? second : first;
  assert.equal(winner.version, 1);
  assert.equal(winner.history.length, 1);
  assert.equal((await (await read("summary")).json()).effectiveBindingId, winner.selectedBindingId);
  assert.equal((await (await read(group)).json()).effectiveBindingId, "group:5001");
  assert.equal((await (await read(other)).json()).effectiveBindingId, winner.selectedBindingId);
  assert.equal((await (await read("private")).json()).effectiveBindingId, winner.selectedBindingId);
  const selectedPrivate = await (await apply("private", 0, alternative)).json();
  assert.equal(selectedPrivate.effectiveBindingId, alternative);
  assert.equal((await (await read()).json()).effectiveBindingId, winner.selectedBindingId);
  const staleInherited = await fetch(base + "/admin/model-route-test", { method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ route: other, expectedVersion: 0, expectedBindingId: "default" }) });
  assert.equal(staleInherited.status, 409);
  assert.equal((await apply("summary", 0, alternative)).status, 200);
  assert.equal((await apply(group, 0, first)).status, 200);
  const chosen = await (await apply("default", 1, alternative)).json();
  assert.equal(chosen.version, 2);
  assert.equal((await apply("default", 1, alternative)).status, 409);
  const rolledBack = await (await restore("default", 2, 1)).json();
  assert.equal(rolledBack.version, 3);
  assert.equal(rolledBack.effectiveBindingId, winner.selectedBindingId);
  assert.equal(rolledBack.history[0].operation, "rollback");
  assert.equal(rolledBack.history[0].restoredVersion, 1);
  assert.equal(rolledBack.history[0].actor, "administrator");
  assert.equal((await restore("default", 3, 99)).status, 404);

  await running!.stop();
  running = undefined;
  await start();
  assert.equal((await (await read()).json()).version, 3);
  assert.equal((await (await read("summary")).json()).effectiveBindingId, alternative);
  assert.equal((await (await read(group)).json()).effectiveBindingId, first);
  assert.equal((await (await read("private")).json()).effectiveBindingId, alternative);
  const restoredPrivate = await (await restore("private", 1, 0)).json();
  assert.equal(restoredPrivate.effectiveBindingId, winner.selectedBindingId);
  const inherited = await (await restore(group, 1, 0)).json();
  assert.equal(inherited.effectiveBindingId, "group:5001");
  assert.equal(inherited.selectedBindingId, null);
  assert.equal(inherited.history[0].restoredVersion, 0);

  await running!.stop();
  running = undefined;
  const changed = winner.selectedBindingId.slice("profile:".length) as "first" | "second";
  await start({ ...options, modelProfiles: { ...options.modelProfiles, [changed]: {
    ...options.modelProfiles![changed], baseUrl: "http://127.0.0.1:3203/changed" } } });
  const unavailable = await (await read()).json();
  assert.equal(unavailable.version, 3);
  assert.equal(unavailable.selectionUnavailable, true);
  assert.equal(unavailable.effectiveBindingId, "default");
  assert.equal((await restore("default", 3, 1)).status, 422);
  const reauthorized = await (await apply("default", 3, winner.selectedBindingId)).json();
  assert.equal(reauthorized.version, 4);
  assert.equal(reauthorized.selectionUnavailable, false);
  const standby = (route: string, version: number, primary: string | null, id: string | null, disabled = false) =>
    write("PUT", { route, expectedVersion: version, bindingId: primary, standbyBindingId: id,
      standbyMode: disabled ? "disabled" : id ? "custom" : "inherit" });
  assert.equal((await standby(other, 0, null, "group:5001")).status, 422);
  assert.equal((await standby("default", reauthorized.version, winner.selectedBindingId, winner.selectedBindingId)).status, 422);
  const custom = await (await standby("default", reauthorized.version, winner.selectedBindingId, alternative)).json();
  assert.equal(custom.standbyMode, "custom");
  assert.equal(custom.backupBindingId, alternative);
  assert.doesNotMatch(JSON.stringify(custom), /profile-fixture-key|fingerprint/i);
  assert.equal((await (await read(other)).json()).backupBindingId, alternative);
  assert.equal((await (await read("summary")).json()).backupBindingId, null);
  const stopped = await (await standby(other, 0, null, null, true)).json();
  assert.equal(stopped.standbyMode, "disabled");
  assert.equal(stopped.backupBindingId, null);
  assert.equal((await (await read("default")).json()).backupBindingId, alternative);
  assert.equal((await (await restore(other, stopped.version, 0)).json()).backupBindingId, alternative);
  const legacyUpdate = await (await apply("default", custom.version, winner.selectedBindingId)).json();
  assert.equal(legacyUpdate.backupBindingId, alternative);
  assert.equal(legacyUpdate.version, custom.version);

  await running!.stop();
  running = undefined;
  const alternateId = alternative.slice("profile:".length);
  await start({ ...options, modelProfiles: { ...options.modelProfiles,
    [changed]: { ...options.modelProfiles![changed]!, baseUrl: "http://127.0.0.1:3203/changed" },
    [alternateId]: { ...options.modelProfiles![alternateId]!, baseUrl: "http://127.0.0.1:3203/standby-changed" } } });
  const unavailableStandby = await (await read()).json();
  assert.equal(unavailableStandby.effectiveBindingId, winner.selectedBindingId);
  assert.equal(unavailableStandby.standbyUnavailable, true);
  assert.equal(unavailableStandby.backupBindingId, null);
  assert.equal((await restore("default", unavailableStandby.version, custom.version)).status, 422);
  const cleared = await (await restore("default", unavailableStandby.version, reauthorized.version)).json();
  assert.equal(cleared.standbyMode, "inherit");
});

test("operators can test the active route with its standby and see the actual model requests", { timeout: 10_000 }, async t => {
  const requests: { path?: string; key?: string; message: string }[] = [];
  let primaryHealthy = false;
  let primaryHttpStatus = 429;
  let primaryStarted!: () => void;
  let releasePrimary!: () => void;
  const started = new Promise<void>(resolve => { primaryStarted = resolve; });
  const released = new Promise<void>(resolve => { releasePrimary = resolve; });
  const upstream = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    requests.push({ path: req.url, key: req.headers.authorization, message: JSON.parse(body).messages[0].content });
    if (req.url === "/primary/chat/completions" && !primaryHealthy) {
      primaryStarted();
      await released;
      res.writeHead(primaryHttpStatus).end();
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 4, completion_tokens: 1 } }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const modelUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const profile = (id: string): ModelProfile => ({ id, name: id, model: id, baseUrl: `${modelUrl}/${id}`, hasKey: true,
    billing: "none", billingAccount: "", inputPrice: 1, outputPrice: 2, currency: "CNY" });
  const service = createGroupService({ database: ":memory:", adminToken: "fixture-admin-route-probe",
    model: profile("primary"), modelKey: "fixture-key-primary", backupModels: { default: profile("standby") },
    backupModelKeys: { default: "fixture-key-standby" }, modelProfiles: { alternate: profile("alternate") },
    modelProfileKeys: { alternate: "fixture-key-alternate" } });
  t.after(async () => {
    releasePrimary();
    await service.stop();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const headers = { Authorization: "Bearer fixture-admin-route-probe", "Content-Type": "application/json" };
  const read = async () => (await fetch(base + "/admin/model-routes?route=default", { headers })).json();
  const expected = { route: "default", expectedVersion: 0, expectedBindingId: "default" };
  const probe = (body: typeof expected & { expectedBackupBindingId?: string | null } = expected,
      token = headers.Authorization) => fetch(base + "/admin/model-route-test", {
    method: "POST", headers: { ...headers, Authorization: token }, body: JSON.stringify(body), signal: AbortSignal.timeout(4_000),
  });
  const initial = await read();
  assert.equal(initial.backupBindingId, "backup:default");
  assert.equal(initial.canTest, true);
  assert.equal((await probe(expected, "Bearer fixture-unauthorized")).status, 403);
  assert.equal((await probe({ ...expected, route: "qq:1001:5001" })).status, 404);
  assert.equal((await probe({ ...expected, expectedVersion: 9 })).status, 409);
  assert.equal(requests.length, 0);

  const pending = probe();
  await started;
  assert.equal((await probe()).status, 409);
  releasePrimary();
  const response = await pending;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "ok");
  assert.doesNotMatch(JSON.stringify(result), /fixture-key-|Reply with OK\./u);
  assert.deepEqual(result.attempts.map(({ stage, bindingId, status, httpStatus }: Record<string, unknown>) =>
    [stage, bindingId, status, httpStatus]), [["primary", "default", "failed", 429], ["backup", "backup:default", "ok", null]]);
  assert.notEqual(result.attempts[0].requestId, result.attempts[1].requestId);
  assert.equal(result.attempts[1].outputTokens, 1);
  assert.deepEqual(requests, [
    { path: "/primary/chat/completions", key: "Bearer fixture-key-primary", message: "Reply with OK." },
    { path: "/standby/chat/completions", key: "Bearer fixture-key-standby", message: "Reply with OK." },
  ]);
  const { usage } = await (await fetch(base + "/admin/status?days=1&purpose=model-test", { headers })).json();
  assert.deepEqual(usage.map(({ model_id, requests, failed }: Record<string, unknown>) => [model_id, requests, failed]), [
    ["primary", 1, 1], ["standby", 1, 0],
  ]);
  const single = await fetch(base + "/admin/models/default/test", { method: "POST", headers });
  assert.equal((await single.json()).status, "rate-limit");
  assert.equal(requests.length, 3);
  primaryHealthy = true;
  const successful = await (await probe()).json();
  assert.equal(successful.status, "ok");
  assert.deepEqual(successful.attempts.map(({ stage }: { stage: string }) => stage), ["primary"]);
  assert.equal(requests.length, 4);
  assert.equal((await read()).version, initial.version);

  const choose = await fetch(base + "/admin/model-routes", { method: "PUT", headers,
    body: JSON.stringify({ ...expected, bindingId: null, standbyMode: "custom", standbyBindingId: "profile:alternate" }) });
  assert.equal(choose.status, 200);
  const route = await choose.json();
  assert.equal(route.backupBindingId, "profile:alternate");
  const fresh = { ...expected, expectedVersion: route.version, expectedBackupBindingId: route.backupBindingId };
  assert.equal((await probe({ ...fresh, expectedBackupBindingId: "backup:default" })).status, 409);
  primaryHealthy = false;
  primaryHttpStatus = 402;
  const quota = await (await probe(fresh)).json();
  assert.equal(quota.status, "ok");
  assert.deepEqual(quota.attempts.map(({ stage, bindingId, status, httpStatus, reason }: Record<string, unknown>) =>
    [stage, bindingId, status, httpStatus, reason]),
    [["primary", "default", "failed", 402, "quota"], ["backup", "profile:alternate", "ok", null, null]]);
  assert.deepEqual(requests.slice(4).map(({ path, key }) => [path, key]), [
    ["/primary/chat/completions", "Bearer fixture-key-primary"], ["/alternate/chat/completions", "Bearer fixture-key-alternate"]]);
  primaryHttpStatus = 401;
  const unauthorized = await (await probe(fresh)).json();
  assert.equal(unauthorized.status, "authorization");
  assert.equal(unauthorized.attempts.length, 1);
  assert.equal(requests.length, 7);
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createGroupService, type GroupServiceOptions } from "../runtime/group-service";
import { createPublishedRole } from "../runtime/published-role";
import { openStore } from "../runtime/store";

test("role assignments and public snapshots have independent, scoped rollback histories", async t => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-role-history-"));
  const database = join(directory, "server.db");
  const target = "qq:1001:5001";
  const other = "qq:1001:5002";
  const original = { id: "fixture.first", version: "1.0.0", name: "旧角色", persona: "公开的第一版设定。" };
  const updated = { ...original, version: "1.1.0", name: "新版角色", persona: "公开的第二版设定。" };
  const alternative = { id: "fixture.second", version: "1.0.0", name: "其他角色", persona: "独立角色设定。" };
  const a = createPublishedRole(original);
  const b = createPublishedRole(updated);
  const c = createPublishedRole(alternative);
  const aWire = { info: a.info, role: original };
  const bWire = { info: b.info, role: updated };
  const originalStore = openStore(database);
  originalStore.saveSetting(`publishedRole:${target}`, original.id);
  originalStore.saveSetting(`publishedRole:${other}`, alternative.id);
  const event = originalStore.db.prepare("INSERT INTO channel_events VALUES (?,?,?,?,?,?)");
  event.run("1001", "1", new Date().toISOString(), target, "2001", "");
  event.run("1001", "2", new Date().toISOString(), other, "2002", "");
  originalStore.db.close();

  const admin = "administrator-fixture-role-history";
  const options: GroupServiceOptions = { database, adminToken: admin, roles: [original, alternative], groupRoles: { "5001": original.id },
    observeGroups: ["5001", "5002"], channel: { enabled: false, expectedBotId: "1001", groups: ["5001", "5002"],
      address: "ws://127.0.0.1:3202", roleId: "", modelId: "", hasToken: false } };
  let runtime: ReturnType<typeof createGroupService> | undefined;
  let base: string;
  async function start(settings = options) {
    await runtime?.stop();
    runtime = createGroupService(settings);
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    runtime.startChannel();
    base = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
  }
  t.after(async () => {
    await runtime?.stop();
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), root);
    await rm(resolved, { recursive: true, force: true });
  });
  const assignment = "/admin/plugins/assigned-role";
  const publication = "/admin/plugins/group-role";
  const request = (path: string, method = "GET", data?: object, token = admin) => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: data && JSON.stringify(data),
  });
  const state = async (scope = target) => (await request(assignment + "?" + new URLSearchParams({ scope }))).json();
  const change = (path: string, method: string, data: object, scope = target) => request(path, method, { scope, ...data });
  const snapshotPath = `/api/groups/${target}/role`;
  async function subscriber(scope: string) {
    return (await (await request("/admin/subscribers", "POST", { groups: [scope], qqId: "2001" })).json()).token;
  }

  await start();
  const migrated = await state();
  assert.equal(migrated.publishedVersion, 1);
  assert.deepEqual(migrated.publishedRole, a.info);
  assert.equal(migrated.publications[0].operation, "migrate");
  const token = await subscriber(target);
  const outsider = await subscriber(other);
  assert.deepEqual(await (await request(snapshotPath, "GET", undefined, token)).json(), aWire);
  assert.equal((await request(snapshotPath, "GET", undefined, outsider)).status, 404);
  assert.equal((await request(publication + "?scope=" + target, "GET", undefined, token)).status, 403);

  const newSettings = { ...options, roles: [updated, alternative] };
  await start(newSettings);
  assert.deepEqual((await state()).assignedRole, b.info);
  assert.deepEqual(await (await request(snapshotPath, "GET", undefined, token)).json(), aWire);
  const result = await change(publication, "PUT", { expectedVersion: 1, publish: true, revision: b.info.revision });
  assert.equal((await result.json()).publishedVersion, 2);
  assert.deepEqual(await (await request(snapshotPath, "GET", undefined, token)).json(), bWire);
  assert.equal((await change(publication, "PUT", { expectedVersion: 1, publish: false })).status, 409);
  assert.equal((await change(publication, "PUT", { expectedVersion: 2, publish: false })).status, 200);
  assert.equal((await request(snapshotPath, "GET", undefined, token)).status, 404);
  const restored = await (await change(publication, "POST", { expectedVersion: 3, restoreVersion: 1 })).json();
  assert.equal(restored.publishedVersion, 4);
  assert.deepEqual(restored.assignedRole, b.info);
  assert.deepEqual(restored.publishedRole, a.info);
  assert.deepEqual(await (await request(snapshotPath, "GET", undefined, token)).json(), aWire);
  assert.equal((await change(publication, "POST", { expectedVersion: 1, restoreVersion: 3 }, other)).status, 404);

  const first = await change(assignment, "PUT", { expectedVersion: 0, revision: b.info.revision });
  assert.equal((await first.json()).assignedVersion, 1);
  const second = await change(assignment, "PUT", { expectedVersion: 1, revision: c.info.revision });
  assert.deepEqual((await second.json()).assignedRole, c.info);
  assert.equal((await change(assignment, "PUT", { expectedVersion: 1, revision: null })).status, 409);
  assert.equal((await change(assignment, "PUT", { expectedVersion: 2, revision: a.info.revision })).status, 400);
  const roller = await (await change(assignment, "POST", { expectedVersion: 2, restoreVersion: 1 })).json();
  assert.equal(roller.assignedVersion, 3);
  assert.deepEqual(roller.assignedRole, b.info);
  assert.deepEqual(roller.publishedRole, a.info);

  const removedRevision = { ...newSettings, roles: [alternative], groupRoles: {} };
  await start(removedRevision);
  assert.deepEqual((await state()).assignedRole, b.info);
  assert.deepEqual(await (await request(snapshotPath, "GET", undefined, token)).json(), aWire);
  const defaultApply = await change(assignment, "PUT", { expectedVersion: 0, revision: c.info.revision }, "default");
  assert.equal(defaultApply.status, 200);
  assert.deepEqual((await state(other)).assignedRole, c.info);
  assert.equal((await state(other)).publishedRole, null);
  assert.deepEqual((await state()).assignedRole, b.info);
  assert.equal((await change(assignment, "POST", { expectedVersion: 3, restoreVersion: 0 })).status, 200);
  assert.deepEqual((await state()).assignedRole, c.info);
  assert.equal((await request("/admin/group-policy", "PUT", { scope: target, reply: true, observe: false, summary: false, recall: false })).status, 200);
  assert.equal((await request(snapshotPath, "GET", undefined, token)).status, 404);
  assert.equal((await change(publication, "POST", { expectedVersion: 4, restoreVersion: 2 })).status, 409);
});

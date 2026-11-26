import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createGroupService } from "../runtime/group-service";
import { memberDirectoryPageSize } from "../runtime/group-member-directory";

test("operators can find scoped members and assess profile samples without publishing tags or stale names", async t => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-member-directory-"));
  const database = join(directory, "service.db");
  const admin = "fixture-member-directory-admin-token";
  const scope = "qq:1001:5001";
  const other = "qq:1001:5002";
  const otherAccount = "qq:1002:5001";
  const primary = "2001";
  const insufficient = "2002";
  const promptBodies: string[] = [];
  const model = createServer(async (req, res) => {
    const body: Buffer[] = [];
    for await (const chunk of req) body.push(Buffer.from(chunk));
    promptBodies.push(Buffer.concat(body).toString());
    res.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"此群友常分享合作活动。","evidence":[1,2]}' } }] }));
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  let service: ReturnType<typeof createGroupService> | undefined;
  t.after(async () => {
    await service?.stop();
    await new Promise<void>(resolve => model.close(() => resolve()));
    const target = await realpath(directory);
    assert.equal(dirname(target), root);
    await rm(target, { recursive: true, force: true });
  });
  service = createGroupService({ database, adminToken: admin, observeGroups: ["5001", "5002"], summaryGroups: ["5001"],
    messageRetentionDays: 2,
    channel: { enabled: false, address: "ws://127.0.0.1:0", expectedBotId: "1001", groups: [],
      roleId: "", modelId: "", hasToken: false },
    model: { id: "fixture", name: "Fixture", model: "fixture", baseUrl: "http://127.0.0.1:" + (model.address() as AddressInfo).port,
      billing: "none", hasKey: false, currency: "CNY", billingAccount: "", inputPrice: null, outputPrice: null },
  });
  const db = new DatabaseSync(database);
  try {
    const event = db.prepare("INSERT INTO channel_events VALUES (?,?,?,?,?,?)");
    const archive = db.prepare("INSERT INTO group_messages(scope,author,content,created_at) VALUES (?,?,?,?)");
    const now = Date.now();
    const time = (difference: number) => new Date(now - difference).toISOString();
    event.run("1001", "1", time(1000), scope, primary, "小林旧称呼");
    event.run("1001", "2", time(100), scope, primary, "小林最新称呼");
    event.run("1001", "3", time(200), scope, insufficient, "小齐");
    event.run("1001", "4", time(100), scope, "1001", "机器人自己");
    event.run("1001", "5", time(100), other, primary, "第二组昵称");
    event.run("1002", "1", time(100), otherAccount, primary, "另一个机器人账号");
    event.run("1001", "6", time(3 * 86_400_000), scope, "2010", "已过期成员");
    for (let i = 0; i < 4; i++) archive.run(scope, primary, "同群可用内容 " + i, time(600 - i));
    for (let i = 0; i < 3; i++) archive.run(scope, insufficient, "另一个成员的发言 " + i, time(500 - i));
    archive.run(scope, insufficient, "已经过期的发言", time(3 * 86_400_000));
    archive.run(other, primary, "跨群的内容", time(100));
  } finally { db.close(); }
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const base = "http://127.0.0.1:" + (service.server.address() as AddressInfo).port;
  async function request(path: string, method = "GET", payload?: object, token = admin) {
    const response = await fetch(base + path, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: payload && JSON.stringify(payload) });
    return { status: response.status, data: await response.json() };
  }
  const roster = (group = scope, q = "", offset = "0") =>
    "/admin/profile-members?" + new URLSearchParams({ scope: group, q, offset });
  const detail = (subject: string) => "/admin/profile-candidates?" + new URLSearchParams({ scope, subject });
  const tag = (subject: string, tags: string[]) => request("/admin/profile-members", "PUT", { scope, subject, tags });
  assert.equal((await request("/admin/profiles", "PUT", { scope, subject: primary,
    displayName: "公开称呼", summary: "明确同意公开的内容。" })).status, 200);
  assert.equal((await request("/admin/profiles", "PUT", { scope, subject: "2099",
    displayName: "仅手工发布", summary: "来自运营者的公开简介。" })).status, 200);
  assert.deepEqual((await tag(primary, [" 内部运营标签 ", "内部运营标签"])).data.tags, ["内部运营标签"]);
  assert.equal((await tag(primary, ["不合适\n标签"])).status, 400);
  for (const query of ["小林最新", "公开称呼", primary, "内部运营标签"]) {
    const report = await request(roster(scope, query));
    assert.equal(report.status, 200);
    assert.equal(report.data.minimumMessages, 4);
    assert.equal(report.data.summaryEnabled, true);
    assert.deepEqual(report.data.items.map((item: { id: string }) => item.id), [primary]);
    assert.equal(report.data.items[0].archivedCount, 4);
  }
  assert.equal((await request(roster(other, "内部运营标签"))).data.items.length, 0);
  assert.equal((await request(roster(other, primary))).data.items[0].observedName, "第二组昵称");
  assert.equal((await request(roster(other))).data.summaryEnabled, false);
  assert.equal((await request(roster(otherAccount))).status, 404);
  assert.equal((await request(roster(scope, "小林旧称呼"))).data.items.length, 0);
  assert.equal((await request(roster(scope, "已过期成员"))).data.items.length, 0);
  assert.equal((await request(roster(scope, "机器人自己"))).data.items.length, 0);
  assert.equal((await request(roster(scope, "仅手工发布"))).data.items[0].lastActive, null);
  assert.equal((await request(roster(scope, "", "-1"))).status, 400);
  const coverage = (await request(detail(insufficient))).data.coverage;
  assert.deepEqual(coverage, { messages: 3, speakers: 1, minimumMessages: 4, minimumSpeakers: 1, sufficient: false });
  assert.equal((await request("/admin/profile-candidates", "POST", { scope, subject: insufficient })).data.status, "insufficient");
  assert.equal(promptBodies.length, 0);

  const generated = await request("/admin/profile-candidates", "POST", { scope, subject: primary });
  assert.equal(generated.status, 201);
  assert.equal((await request(roster(scope, primary))).data.items[0].pending, true);
  assert.doesNotMatch(promptBodies[0], /内部运营标签|跨群的内容|另一个成员的发言|已经过期的发言/u);
  assert.deepEqual((await request(detail(primary))).data.tags, ["内部运营标签"]);
  const subscriber = (await request("/admin/subscribers", "POST", { qqId: primary, groups: [scope] })).data.token;
  assert.equal(typeof subscriber, "string");
  assert.equal((await request(roster(), "GET", undefined, subscriber)).status, 403);
  assert.doesNotMatch(JSON.stringify((await request(`/api/groups/${scope}/members`, "GET", undefined, subscriber)).data), /内部运营标签|tags/u);
  assert.equal((await tag(primary, [])).status, 200);
  assert.equal((await request(roster(scope, "内部运营标签"))).data.items.length, 0);
  for (let i = 0; i <= memberDirectoryPageSize; i++) await tag(String(3000 + i), ["批量联调"]);
  const pageOne = (await request(roster(scope, "批量联调"))).data;
  const pageTwo = (await request(roster(scope, "批量联调", String(pageOne.next)))).data;
  assert.equal(pageOne.items.length, memberDirectoryPageSize);
  assert.equal(pageTwo.items.length, 1);
  assert.ok(!pageOne.items.some((item: { id: string }) => item.id === pageTwo.items[0].id));
  assert.equal(pageTwo.next, null);
});

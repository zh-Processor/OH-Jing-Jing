import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { readInstances } from "../runtime/instance-config";

const port = (server: { address(): unknown }) => (server.address() as AddressInfo).port;

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return port(server);
}

async function until<T>(description: string, attempt: () => T | Promise<T>) {
  for (let count = 0; count < 240; count++) {
    const result = await attempt();
    if (result) return result;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test("managed instances isolate accounts and data and recover failed configuration releases", { timeout: 60_000 }, async t => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "ohjingjing-instances-"));
  const manifest = join(directory, "instances.json");
  const holders = [createServer(), createServer(), createServer()];
  const [managerPort, portA, portB] = await Promise.all(holders.map(listen));
  const managerToken = "test-supervisor-administrator-secret";
  const adminA = "first-account-administration-key";
  const adminB = "second-account-administration-key";
  const grouped = ["5001"];
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const modelCalls: { key: string | undefined; path: string; payload: string }[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = Buffer.concat(chunks).toString();
    const path = req.url ?? "";
    const content = path.startsWith("/first/") ? "第一实例" : "第二实例";
    const summary = JSON.stringify({ overview: content + "模拟摘要", topics: [{ title: content, summary: "日常话题", evidence: [1, 2], facts: [] }] });
    const system = JSON.parse(payload).messages[0].content;
    const reply = system.startsWith("从不可信的同群聊天素材生成中文话题摘要。") ? summary : content + "的回复。";
    modelCalls.push({ key: req.headers.authorization, path, payload });
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 8, completion_tokens: 3 } }));
  });
  const providerPort = await listen(upstream);
  async function gateway(account: number) {
    const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(ws, "listening");
    let loginAccount = account;
    let readLogin: ((connection: number) => number | Promise<number> | undefined) | undefined;
    let spaceReadable = false;
    let spaceReadCount = 0;
    const keys: (string | undefined)[] = [];
    const outgoing: string[] = [];
    ws.on("connection", (socket, req) => {
      keys.push(req.headers.authorization);
      const connection = keys.length;
      socket.on("message", async bytes => {
        const command = JSON.parse(bytes.toString());
        if (command.action === "send_group_msg") outgoing.push(command.params.message[0].data.text);
        let data: object;
        switch (command.action) {
          case "get_login_info": data = { user_id: await readLogin?.(connection) ?? loginAccount, nickname: "模拟账号" }; break;
          case "get_version_info": data = { app_name: "NapCat", protocol_version: "11", app_version: "4.18.42" }; break;
          case "get_stranger_info": data = { user_id: loginAccount, nickname: "模拟账号" }; break;
          case "get_qzone_msg_list":
            assert.equal(command.params.target_uin, loginAccount);
            assert.equal(command.params.format, "native");
            spaceReadCount++;
            data = spaceReadable ? { msglist: [] } : {};
            break;
          default: data = { message_id: outgoing.length + 9000 };
        }
        socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: command.echo, data }));
      });
    });
    return { ws, keys, outgoing, reportAccount(id: number) { loginAccount = id; },
      overrideLogin(hook?: typeof readLogin) { readLogin = hook; },
      allowSpaceRead() { spaceReadable = true; }, spaceReads() { return spaceReadCount; }, send(id: number, text: string, reply = false, who = account) {
      const socket = [...ws.clients][0];
      assert.ok(socket);
      socket.send(JSON.stringify({ post_type: "message", message_type: "group", self_id: who, user_id: 2001,
        group_id: 5001, message_id: id, message: (reply ? `[CQ:at,qq=${who}]` : "") + text }));
    } };
  }
  const [first, second, replacement] = await Promise.all([gateway(1001), gateway(1002), gateway(1002)]);
  let reportedPlugin = "qq.milky";
  let reportedOnline = true;
  let ingressChecks = 0;
  let ingressOfflineFrom = Infinity;
  const ingress = createServer((req, res) => {
    if (req.url?.startsWith("/inbox?") && req.headers.authorization === "Bearer isolated-test-collector-token") {
      ingressChecks++;
      res.end(JSON.stringify({ accountId: "1002", pluginId: reportedPlugin, online: reportedOnline && ingressChecks < ingressOfflineFrom,
        feed: "2ab9fec8-7f4e-4a9a-8f54-47ee50f844b6", lastSequence: 0, missed: false, entries: [] }));
    } else res.writeHead(403).end();
  });
  const ingressPort = await listen(ingress);
  const alternateCalls: string[] = [];
  const alternateGateway = createServer((req, res) => {
    req.resume();
    const action = req.url ?? "";
    alternateCalls.push(action);
    let data;
    if (action === "/api/get_login_info") data = { uin: 1002, nickname: "候选 QQ" };
    else if (action === "/api/get_impl_info") data = { impl_name: "候选网关", impl_version: "1.0", milky_version: "1.3" };
    else if (action === "/api/get_user_profile") data = { nickname: "候选 QQ", bio: "" };
    if (!data || req.headers.authorization !== "Bearer gateway-second-token") { res.writeHead(403).end(); return; }
    res.end(JSON.stringify({ status: "ok", retcode: 0, data }));
  });
  const alternateEvents = new WebSocketServer({ server: alternateGateway, path: "/event" });
  const alternatePort = await listen(alternateGateway);
  let managed: ReturnType<typeof fork> | undefined;
  let managerClosed: Promise<unknown[]> | undefined;
  t.after(async () => {
    if (managed?.connected) managed.send("shutdown", () => {});
    await managerClosed;
    for (const side of [first, second, replacement]) {
      for (const socket of side.ws.clients) socket.terminate();
      await new Promise<void>(resolve => side.ws.close(() => resolve()));
    }
    for (const holder of holders) if (holder.listening) await new Promise<void>(resolve => holder.close(() => resolve()));
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    ingress.closeAllConnections();
    await new Promise<void>(resolve => ingress.close(() => resolve()));
    for (const socket of alternateEvents.clients) socket.terminate();
    await new Promise<void>(resolve => alternateEvents.close(() => resolve()));
    alternateGateway.closeAllConnections();
    await new Promise<void>(resolve => alternateGateway.close(() => resolve()));
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), root);
    await rm(resolved, { recursive: true, force: true });
  });
  const fileA = join(directory, "first.json");
  const fileB = join(directory, "second.json");
  function configuration(id: string, portNumber: number, gatewayPort: number, account: string) {
    return { database: id + "/state.db", port: portNumber, observeGroups: grouped, summaryGroups: grouped, summarizeAfter: 2,
      channel: { address: `ws://127.0.0.1:${gatewayPort}`, enabled: true, hasToken: true, expectedBotId: account, groups: grouped,
        roleId: `test.${id}`, modelId: id }, roles: [{ id: `test.${id}`, name: id, version: "1.0.0", persona: `只使用角色 ${id} 的信息` }],
      model: { id, name: id, baseUrl: `http://127.0.0.1:${providerPort}/${id}`, model: id, billing: "none", currency: "CNY",
        hasKey: true, billingAccount: "", inputPrice: null, outputPrice: null } };
  }
  const configA = configuration("first", portA, port(first.ws), "1001");
  const configB = configuration("second", portB, port(second.ws), "1002");
  const saveFile = (path: string, data: unknown) => writeFile(path, JSON.stringify(data));
  const env = { ...process.env, OHJINGJING_MANAGER_TOKEN: managerToken,
    OHJINGJING_INSTANCE_FIRST_ADMIN_TOKEN: adminA, OHJINGJING_INSTANCE_FIRST_MODEL_KEY: "provider-first-key",
    OHJINGJING_INSTANCE_FIRST_ONEBOT_TOKEN: "gateway-first-token",
    OHJINGJING_INSTANCE_SECOND_ADMIN_TOKEN: adminB, OHJINGJING_INSTANCE_SECOND_MODEL_KEY: "provider-second-key",
    OHJINGJING_INSTANCE_SECOND_ONEBOT_TOKEN: "gateway-second-token", OHJINGJING_INSTANCE_SECOND_QQ_INGRESS_TOKEN: "isolated-test-collector-token",
    OHJINGJING_MODEL_KEY: "ambient-key-must-not-be-used" };
  const manifestInstances = [
    { id: "first", name: "第一实例", config: "first.json" },
    { id: "second", name: "第二实例", config: "second.json", start: false, requiredQqCapabilities: ["nickname", "qzone"] },
  ];
  await saveFile(manifest, { port: managerPort, instances: manifestInstances });
  await saveFile(fileA, configA);
  await saveFile(fileB, { ...configB, database: ".\\" + configA.database.replace("/", "\\") });
  if (process.platform === "win32") assert.throws(() => readInstances(manifest, env), /共用了状态数据库/);
  await saveFile(fileB, { ...configB, database: configA.database + "-wal" });
  assert.throws(() => readInstances(manifest, env), /共用了状态数据库/);
  await saveFile(fileB, { ...configB, channel: { ...configB.channel, expectedBotId: "1001" } });
  assert.throws(() => readInstances(manifest, env), /独立的预期 QQ 账号/);
  await saveFile(fileB, { ...configB, port: portA });
  assert.throws(() => readInstances(manifest, env), /独立的固定端口/);
  await saveFile(fileB, configB);
  assert.throws(() => readInstances(manifest, { ...env, OHJINGJING_INSTANCE_SECOND_ADMIN_TOKEN: adminA }), /独立的管理员令牌/);
  await saveFile(manifest, { port: managerPort, instances: [manifestInstances[0], { ...manifestInstances[1], requiredQqCapabilities: ["unknown"] }] });
  assert.throws(() => readInstances(manifest, env), /未知的 QQ 账号能力/u);
  await saveFile(manifest, { port: managerPort, instances: manifestInstances });
  const entries = readInstances(manifest, env).entries;
  assert.deepEqual(entries.map(item => [item.env.OHJINGJING_MODEL_KEY, item.env.OHJINGJING_MANAGER_TOKEN]), [
    ["provider-first-key", undefined], ["provider-second-key", undefined],
  ]);
  await Promise.all(holders.map(holder => new Promise<void>(resolve => holder.close(() => resolve()))));

  const release = process.env.OHJINGJING_TEST_SERVICE_RELEASE;
  const program = release ? join(release, "instances.cjs") : resolve("runtime/instances.ts");
  const check = fork(program, [manifest, "--check"], { env, execArgv: release ? [] : ["--import", "tsx"], windowsHide: true,
    stdio: ["ignore", "pipe", "inherit", "ipc"] });
  let verified = "";
  check.stdout!.setEncoding("utf8").on("data", value => { verified += value; });
  assert.equal((await once(check, "close"))[0], 0);
  assert.equal(JSON.parse(verified).valid, true);
  await assert.rejects(access(join(directory, configA.database)));
  await assert.rejects(access(join(directory, configB.database)));
  const manager = managed = fork(program, [manifest], { env, execArgv: release ? [] : ["--import", "tsx"], windowsHide: true,
    stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exited = managerClosed = once(manager, "close");
  const management = `http://127.0.0.1:${managerPort}`;
  const endpoint = (port: number) => `http://127.0.0.1:${port}`;
  const list = async () => (await (await fetch(management + "/api/instances", { headers: auth(managerToken) })).json()).instances;
  const action = (id: string, command: string, token = managerToken) => fetch(management + `/api/instances/${id}/${command}`,
    { method: "POST", headers: auth(token) });
  const state = async (id: string, expected: string) => until(`${id} ${expected}`, async () => {
    const current = (await list()).find((item: { id: string }) => item.id === id);
    return current?.state === expected && current;
  });
  const request = (p: number, path: string, token: string, body?: object) => fetch(endpoint(p) + path, {
    method: body ? "POST" : "GET", headers: { ...auth(token), "Content-Type": "application/json" }, body: body && JSON.stringify(body),
  });

  await until("manager page", () => fetch(management).then(response => response.ok).catch(() => false));
  const dashboard = await (await fetch(management)).text();
  assert.match(dashboard, /OHJingJing 实例管理/);
  assert.doesNotThrow(() => new Function(/<script>([\s\S]+)<\/script>/u.exec(dashboard)![1]));
  assert.ok(!dashboard.includes(adminA));
  assert.equal((await action("second", "start", adminA)).status, 401);
  const runningA = await state("first", "running");
  await state("second", "stopped");
  second.reportAccount(1001);
  assert.equal((await action("second", "start")).status, 202);
  const runningB = await state("second", "running");
  assert.notEqual(runningA.pid, runningB.pid);
  const channelState = async (p: number, token: string) => (await (await request(p, "/admin/status", token)).json()).channel;
  await until("the wrong login to disconnect", async () => second.keys.length > 0 && await channelState(portB, adminB) === "disconnected");
  assert.deepEqual(second.outgoing, []);
  assert.equal(modelCalls.length, 0);
  second.reportAccount(1002);
  await until("both verified gateway connections", async () => await channelState(portA, adminA) === "online" && await channelState(portB, adminB) === "online");
  assert.deepEqual([first.keys[0], second.keys[0]], ["Bearer gateway-first-token", "Bearer gateway-second-token"]);
  assert.equal((await request(portA, "/admin/status", adminB)).status, 403);
  assert.equal((await request(portB, "/admin/status", managerToken)).status, 403);

  first.send(1, "不属于当前账号的事件", true, 1002);
  first.send(1, "第一实例私有素材", true);
  first.send(2, "第一实例又一条素材");
  second.send(1, "第二实例私有素材", true);
  second.send(2, "第二实例又一条素材");
  await until("scoped replies and summaries", () => modelCalls.length >= 4 && first.outgoing.length === 1 && second.outgoing.length === 1);
  assert.deepEqual(first.outgoing, ["第一实例的回复。"]);
  assert.deepEqual(second.outgoing, ["第二实例的回复。"]);
  for (const call of modelCalls) {
    const firstAccount = call.path.startsWith("/first/");
    assert.equal(call.key, firstAccount ? "Bearer provider-first-key" : "Bearer provider-second-key");
    assert.ok(!call.payload.includes(firstAccount ? "第二实例私有素材" : "第一实例私有素材"));
    assert.ok(!call.payload.includes("不属于当前账号的事件"));
  }
  const scopeA = "qq:1001:5001";
  const scopeB = "qq:1002:5001";
  const grant = (p: number, admin: string, scope: string) => request(p, "/admin/subscribers", admin, { qqId: "2001", groups: [scope] });
  assert.equal((await grant(portA, adminA, scopeB)).status, 400);
  const tokenA = (await (await grant(portA, adminA, scopeA)).json()).token;
  const tokenB = (await (await grant(portB, adminB, scopeB)).json()).token;
  assert.equal((await request(portA, "/api/groups", tokenB)).status, 401);
  assert.equal((await request(portB, "/api/groups", tokenA)).status, 401);
  async function summaryAt(p: number, token: string) { return (await (await request(p, "/api/groups", token)).json()).groups[0]?.summary?.content; }
  await until("isolated summaries", async () => (await summaryAt(portA, tokenA)) === "第一实例模拟摘要" &&
    (await summaryAt(portB, tokenB)) === "第二实例模拟摘要");
  const statusA = await (await request(portA, "/admin/status", adminA)).json();
  assert.deepEqual(statusA.groups.map((group: { scope: string; count: number }) => [group.scope, group.count]), [[scopeA, 2]]);
  assert.deepEqual(statusA.models.map((model: { model: string }) => model.model), ["first"]);
  const changedRoute = await fetch(endpoint(portA) + "/admin/model-routes", { method: "PUT", headers: { ...auth(adminA), "Content-Type": "application/json" },
    body: JSON.stringify({ route: "default", expectedVersion: 0, bindingId: "default" }) });
  assert.equal((await changedRoute.json()).version, 1);
  const otherRoute = await (await request(portB, "/admin/model-routes", adminB)).json();
  assert.equal(otherRoute.version, 0);

  await saveFile(fileB, { ...configB, messageRetentionDays: 30 });
  assert.equal((await action("second", "restart")).status, 409);
  assert.equal((await state("second", "running")).pid, runningB.pid);
  await saveFile(fileB, configB);
  assert.equal((await action("second", "restart")).status, 202);
  const restarted = await until("new process for the second instance", async () => {
    const current = (await list()).find((item: { id: string }) => item.id === "second");
    return current.state === "running" && current.pid !== runningB.pid && current;
  });
  assert.equal(await summaryAt(portB, tokenB), "第二实例模拟摘要");
  assert.equal((await state("first", "running")).pid, runningA.pid);
  process.kill(restarted.pid);
  const recovered = await until("automatic recovery after a child exit", async () => (await list()).find((item: { id: string; state: string; pid: number }) =>
    item.id === "second" && item.state === "running" && item.pid !== restarted.pid));
  const versionPath = management + "/api/instances/second/config";
  const getVersion = async () => {
    const response = await fetch(versionPath, { headers: auth(managerToken) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const applyVersion = (version: number, change: object) => fetch(versionPath, {
    method: "PUT", headers: { ...auth(managerToken), "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion: version, ...change }),
  });
  const publishDraft = async (version: number) => applyVersion(version, { draftHash: (await getVersion()).draftHash });
  assert.equal((await fetch(versionPath, { headers: auth(adminB) })).status, 401);
  await saveFile(fileB, { ...configB, messageRetentionDays: 30 });
  const unversioned = await getVersion();
  assert.equal(unversioned.version, 0);
  assert.ok(unversioned.changed);
  await saveFile(fileB, { ...configB, messageRetentionDays: 31 });
  assert.equal((await applyVersion(0, { draftHash: unversioned.draftHash })).status, 409);
  await saveFile(fileB, { ...configB, database: configA.database });
  assert.equal((await publishDraft(0)).status, 400);
  await saveFile(fileB, { ...configB, channel: { ...configB.channel, roleId: "role.missing" } });
  assert.equal((await publishDraft(0)).status, 422);
  await saveFile(fileB, { ...configB, channel: { ...configB.channel, address: configA.channel.address } });
  assert.equal((await publishDraft(0)).status, 422);
  assert.equal((await state("second", "running")).pid, recovered.pid);
  assert.equal((await state("first", "running")).pid, runningA.pid);

  const blockedPort = await listen(holders[0]);
  await saveFile(fileB, { ...configB, port: blockedPort });
  assert.equal((await publishDraft(0)).status, 409);
  const fallback = await state("second", "running");
  assert.notEqual(fallback.pid, recovered.pid);
  assert.equal(fallback.address, endpoint(portB));
  assert.equal(await summaryAt(portB, tokenB), "第二实例模拟摘要");
  assert.equal((await getVersion()).version, 0);
  await new Promise<void>(resolve => holders[0].close(() => resolve()));

  await saveFile(fileB, { ...configB, port: blockedPort, messageRetentionDays: 30 });
  const submission = { draftHash: (await getVersion()).draftHash };
  const competing = await Promise.all([applyVersion(0, submission), applyVersion(0, submission)]);
  assert.deepEqual(competing.map(response => response.status).sort(), [200, 409]);
  assert.equal((await competing.find(response => response.ok)!.json()).version, 1);
  assert.equal((await state("second", "running")).address, endpoint(blockedPort));
  await until("the published instance answers reads", async () =>
    (await summaryAt(blockedPort, tokenB)) === "第二实例模拟摘要");
  assert.equal((await publishDraft(0)).status, 409);
  await saveFile(fileB, { ...configB, modelKey: "fixture-disallowed-credential" });
  assert.equal((await getVersion()).draftHash, null);
  assert.equal((await action("second", "restart")).status, 202);
  await state("second", "running");
  assert.equal((await getVersion()).version, 1);
  const rolledBack = await applyVersion(1, { restoreVersion: 0 });
  assert.equal(rolledBack.status, 200);
  const rollbackState = await rolledBack.json();
  assert.equal(rollbackState.version, 2);
  assert.equal(rollbackState.revisions[0].operation, "rollback");
  assert.equal(rollbackState.revisions[0].restoredVersion, 0);
  assert.equal((await state("second", "running")).address, endpoint(portB));
  await until("the previous configuration answers reads again", async () =>
    (await summaryAt(portB, tokenB)) === "第二实例模拟摘要");
  assert.equal((await state("first", "running")).pid, runningA.pid);
  const beforeGatewaySwitch = await state("second", "running");
  second.allowSpaceRead();
  await saveFile(fileB, { ...configB, channel: { ...configB.channel, pluginId: "qq.milky", address: endpoint(alternatePort) } });
  const alternateRejected = await publishDraft(2);
  assert.equal(alternateRejected.status, 422);
  assert.deepEqual((await alternateRejected.json()).missingCapabilities, ["qzone"]);
  assert.deepEqual([...new Set(alternateCalls)].sort(), ["/api/get_impl_info", "/api/get_login_info", "/api/get_user_profile"]);
  const candidate = { ...configB, channel: { ...configB.channel, address: `ws://127.0.0.1:${port(replacement.ws)}` },
    qqIngress: endpoint(ingressPort) };
  await saveFile(fileB, candidate);
  const missingSpace = await publishDraft(2);
  assert.equal(missingSpace.status, 422);
  assert.deepEqual((await missingSpace.json()).missingCapabilities, ["qzone"]);
  assert.equal(replacement.spaceReads(), 1);
  assert.equal(ingressChecks, 0);
  replacement.allowSpaceRead();
  const wrongIngress = await publishDraft(2);
  assert.equal(wrongIngress.status, 422);
  assert.match((await wrongIngress.json()).error, /独立收件/u);
  reportedPlugin = "qq.onebot";
  reportedOnline = false;
  assert.equal((await publishDraft(2)).status, 422);
  assert.equal((await getVersion()).version, 2);
  assert.equal((await state("second", "running")).pid, beforeGatewaySwitch.pid);
  assert.deepEqual(replacement.outgoing, []);

  reportedOnline = true;
  const trialConnection = replacement.keys.length + 2;
  let finishLogin!: (account: number) => void;
  const changedLogin = new Promise<number>(done => { finishLogin = done; });
  replacement.overrideLogin(connection => connection >= trialConnection ? changedLogin : undefined);
  const failedSwitch = publishDraft(2);
  try {
    await until("trial gateway connects after the preflight", () => replacement.keys.length >= trialConnection);
    const blocked = await request(portB, "/api/groups", tokenB);
    assert.equal(blocked.status, 503);
    assert.equal((await getVersion()).version, 2);
  } finally { finishLogin(1003); }
  const staleLogin = await failedSwitch;
  assert.equal(staleLogin.status, 409);
  assert.match((await staleLogin.json()).error, /登录账号核对/u);
  assert.equal((await getVersion()).version, 2);
  assert.equal(await summaryAt(portB, tokenB), "第二实例模拟摘要");
  replacement.overrideLogin();

  ingressOfflineFrom = ingressChecks + 2;
  const staleIngress = await publishDraft(2);
  assert.equal(staleIngress.status, 409);
  assert.match((await staleIngress.json()).error, /独立收件/u);
  assert.equal((await getVersion()).version, 2);
  assert.equal(await summaryAt(portB, tokenB), "第二实例模拟摘要");
  assert.deepEqual(replacement.outgoing, []);
  ingressOfflineFrom = Infinity;

  assert.equal((await publishDraft(2)).status, 200);
  assert.notEqual((await state("second", "running")).pid, beforeGatewaySwitch.pid);
  assert.equal(await summaryAt(portB, tokenB), "第二实例模拟摘要");
  assert.equal((await applyVersion(3, { restoreVersion: 2 })).status, 200);
  assert.equal((await getVersion()).version, 4);
  assert.equal(await summaryAt(portB, tokenB), "第二实例模拟摘要");
  assert.equal((await state("first", "running")).pid, runningA.pid);
  assert.equal((await action("second", "stop")).status, 202);
  await state("second", "stopped");
  assert.equal(await summaryAt(portA, tokenA), "第一实例模拟摘要");
  manager.send("shutdown");
  assert.equal((await exited)[0], 0);
  await until("all gateways were disconnected", () => [first, second, replacement].every(side => side.ws.clients.size === 0));
  await writeFile(fileB, "Invalid draft that must not prevent restart.");
  managed = fork(program, [manifest], { env, execArgv: release ? [] : ["--import", "tsx"], windowsHide: true,
    stdio: ["ignore", "ignore", "inherit", "ipc"] });
  managerClosed = once(managed, "close");
  await until("manager restarted with an invalid draft", () => fetch(management).then(response => response.ok).catch(() => false));
  assert.equal((await getVersion()).version, 4);
  assert.equal((await getVersion()).draftHash, null);
  assert.equal((await action("second", "start")).status, 202);
  assert.equal((await state("second", "running")).address, endpoint(portB));
  assert.equal(await summaryAt(portB, tokenB), "第二实例模拟摘要");
  managed.send("shutdown");
  assert.equal((await managerClosed)[0], 0);
});

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const release = process.env.OHJINGJING_TEST_SERVICE_RELEASE;

function entry(name: "server" | "service-data") {
  return release ? [join(release, `${name}.cjs`)] : ["--import", "tsx", `runtime/${name}.ts`];
}

async function dataCommand(...args: string[]) {
  const result = await run(process.execPath, [...entry("service-data"), ...args], { timeout: 12_000, windowsHide: true });
  return JSON.parse(result.stdout);
}

test("backs up a running service and restores a separate, inactive QQ instance", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ohjingjing-service-recovery-"));
  const children: ChildProcess[] = [];
  let writer: DatabaseSync | undefined;
  const admin = "integration-admin-for-recovery-check";
  const modelKey = "fixture-provider-key";
  const balanceRef = createHmac("sha256", admin).update(JSON.stringify(["provider-balance", "openrouter", modelKey])).digest("hex");
  const scope = "qq:1001:5001";
  async function start(path: string, key = "") {
    const child = spawn(process.execPath, entry("server"), {
      env: { ...process.env, OHJINGJING_CONFIG: path, OHJINGJING_ADMIN_TOKEN: admin,
        OHJINGJING_ONEBOT_TOKEN: "", OHJINGJING_MODEL_KEY: key, OHJINGJING_SUMMARY_MODEL_KEY: "", OHJINGJING_GROUP_MODEL_KEYS: "" },
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 30_000,
    });
    children.push(child);
    await once(child, "spawn");
    const lines = createInterface({ input: child.stdout });
    try {
      const line = await lines[Symbol.asyncIterator]().next();
      const address = /^OHJingJing listening on (http:\/\/127\.0\.0\.1:\d+)$/u.exec(line.value ?? "")?.[1];
      assert.ok(address, "Expected the packaged service to listen on loopback");
      return address;
    } finally { lines.close(); }
  }
  async function request(base: string, path: string, token = admin, body?: object, method = body ? "POST" : "GET") {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
    assert.ok(response.ok, `Unexpected HTTP status ${response.status} for ${path}`);
    return response.json();
  }
  try {
    const configPath = join(fixture, "config.json");
    const config = { database: "live/state.db", host: "127.0.0.1", port: 0, observeGroups: ["5001"],
      messageRetentionDays: 30, channel: { enabled: false, address: "ws://127.0.0.1:0", groups: ["5001"],
        roleId: "", modelId: "", hasToken: true, expectedBotId: "1001" } };
    await writeFile(configPath, "\uFEFF" + JSON.stringify(config));
    const running = await start(configPath);
    const database = join(fixture, "live", "state.db");
    writer = new DatabaseSync(database);
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    const timestamp = new Date().toISOString();
    const event = writer.prepare("INSERT INTO channel_events VALUES (?,?,?,?,?,?)");
    event.run("1001", "1", timestamp, scope, "2001", "示例发言人");
    writer.prepare("INSERT INTO group_summaries (scope,first_id,last_id,content,created_at) VALUES (?,?,?,?,?)")
      .run(scope, 1, 1, "联机解谜约在周日。", timestamp);
    const snapshot = JSON.stringify({ status: "available", scope: "key", checkedAt: timestamp,
      source: "openrouter.ai", values: [{ currency: "USD", remaining: 3 }] });
    writer.prepare("INSERT INTO provider_balance_snapshots(ref, attempted_at, latest, last_successful) VALUES (?, ?, ?, ?)")
      .run(balanceRef, timestamp, snapshot, snapshot);
    assert.ok((await stat(database + "-wal")).size > 32);
    const { token } = await request(running, "/admin/subscribers", admin, { qqId: "2001", groups: [scope] });
    const { policy } = await request(running, "/admin/budget");
    const updatedBudget = await request(running, "/admin/budget", admin,
      { ...policy, background: { daily: 7, monthly: 40 } }, "PUT");
    assert.equal(updatedBudget.policy.background.daily, 7);

    // Recovery must remain inert even if the production configuration is enabled and has other fields.
    await writeFile(configPath, JSON.stringify({ ...config, channel: { ...config.channel, enabled: true },
      channelToken: "test-config-value-that-must-not-be-snapshotted" }));
    const archive = join(fixture, "backups", "rehearsal");
    assert.equal((await dataCommand("backup", configPath, archive)).ok, true);
    const file = join(archive, "manifest.json");
    const manifest = await readFile(file, "utf8");
    assert.doesNotMatch(manifest, /test-config-value|state\.db/);
    assert.deepEqual((await readdir(archive)).sort(), ["group.db", "manifest.json"]);
    const verified = await dataCommand("verify", archive);
    assert.match(verified.sha256, /^[a-f0-9]{64}$/);
    assert.ok(verified.bytes > 0);
    await assert.rejects(dataCommand("backup", configPath, archive), /EEXIST/);
    assert.equal(await readFile(file, "utf8"), manifest);

    event.run("1001", "2", timestamp, scope, "2001", "备份后的示例发言");
    const restored = join(fixture, "recovery");
    const result = await dataCommand("restore", archive, restored);
    const recoveryConfig = JSON.parse(await readFile(result.config, "utf8"));
    assert.equal(recoveryConfig.database, "group.db");
    assert.equal(recoveryConfig.port, 0);
    assert.equal(recoveryConfig.channel.enabled, false);
    assert.equal(recoveryConfig.channel.paused, true);
    assert.equal(recoveryConfig.messageRetentionDays, 30);
    assert.equal(recoveryConfig.model, undefined);
    const recovery = await start(result.config);
    const restoredGroups = await request(recovery, "/api/groups", token);
    assert.equal(restoredGroups.gatewayStatus, "disabled");
    assert.equal(restoredGroups.groups[0].summary.content, "联机解谜约在周日。");
    assert.equal(restoredGroups.groups[0].messageCount, 1);
    assert.deepEqual((await request(recovery, "/admin/budget")).policy.background, { daily: 7, monthly: 40 });
    assert.deepEqual((await request(recovery, "/admin/model-balances")).subjects, []);
    const inspected = new DatabaseSync(join(restored, "group.db"), { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT last_successful FROM provider_balance_snapshots WHERE ref=?")
        .get(balanceRef)?.last_successful, snapshot);
    } finally { inspected.close(); }
    const recoveryWorker = children.at(-1)!;
    const closed = once(recoveryWorker, "exit");
    recoveryWorker.kill();
    await closed;
    await writeFile(result.config, JSON.stringify({ ...recoveryConfig, model: {
      id: "default", name: "额度验证模型", model: "fixture", baseUrl: "https://openrouter.ai/api/v1", billing: "openrouter",
      billingAccount: "", hasKey: true, currency: "USD", inputPrice: null, outputPrice: null,
    } }));
    const reopened = await start(result.config, modelKey);
    const { subjects } = await request(reopened, "/admin/model-balances");
    assert.deepEqual(subjects[0]?.latest, JSON.parse(snapshot));
    assert.equal((await request(running, "/api/groups", token)).groups[0].messageCount, 2);
    await assert.rejects(dataCommand("restore", archive, restored), /EEXIST/);

    const bad = join(fixture, "bad");
    await mkdir(bad);
    await copyFile(file, join(bad, "manifest.json"));
    await copyFile(join(archive, "group.db"), join(bad, "group.db"));
    await appendFile(join(bad, "group.db"), "damaged");
    await assert.rejects(dataCommand("verify", bad), /校验记录不一致/);
    const rejected = join(fixture, "rejected-recovery");
    await assert.rejects(dataCommand("restore", bad, rejected), /校验记录不一致/);
    await assert.rejects(stat(rejected), { code: "ENOENT" });
  } finally {
    writer?.close();
    await Promise.all(children.map(async child => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }));
    await rm(fixture, { recursive: true, force: true });
  }
});

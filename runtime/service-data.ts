import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { readServerConfig, type ServiceConfig } from "./server-config.js";

const databaseName = "group.db";
const manifestName = "manifest.json";
const recoveryConfigName = "server.config.json";
const format = "ohjingjing-service-backup-v1";

type BackupManifest = {
  format: typeof format;
  createdAt: string;
  bytes: number;
  sha256: string;
  inspectionConfig: ServiceConfig;
};

function inspectionConfig(input: Partial<ServiceConfig>): ServiceConfig {
  const qqId = (value: unknown): value is string => typeof value === "string" && /^\d{4,20}$/u.test(value);
  const groupIds = (values: unknown) => Array.isArray(values) ? values.filter(qqId) : [];
  const retention = input.messageRetentionDays;
  return {
    database: databaseName, host: "127.0.0.1", port: 0,
    observeGroups: groupIds(input.observeGroups), summaryGroups: groupIds(input.summaryGroups),
    recallGroups: groupIds(input.recallGroups),
    messageRetentionDays: typeof retention === "number" && Number.isInteger(retention) && retention >= 1 && retention <= 365 ? retention : 7,
    channel: {
      enabled: false, address: "ws://127.0.0.1:0", groups: groupIds(input.channel?.groups),
      roleId: "", modelId: "", hasToken: false, paused: true,
      expectedBotId: qqId(input.channel?.expectedBotId) ? input.channel.expectedBotId : undefined,
    },
  };
}

function confirmServiceDatabase(db: DatabaseSync) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
  if (!["settings", "channel_events", "outbox", "group_messages", "group_summaries"].every(table => tables.has(table))) {
    throw new Error("指定数据库缺少群聊服务的基础表。");
  }
}

async function fileHash(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function integrityCheck(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    confirmServiceDatabase(db);
    const results = db.prepare("PRAGMA integrity_check(1)").all();
    if (results.length !== 1 || results[0].integrity_check !== "ok") throw new Error("备份数据库完整性检查失败。");
  } finally { db.close(); }
}

async function checkFiles(path: string, manifest: Pick<BackupManifest, "bytes" | "sha256">) {
  const info = await stat(path);
  if (!info.isFile() || info.size !== manifest.bytes || await fileHash(path) !== manifest.sha256) {
    throw new Error("备份文件与校验记录不一致。");
  }
  integrityCheck(path);
}

async function buildInNewDirectory(destination: string, files: string[], build: (directory: string) => Promise<void>) {
  const directory = resolve(destination);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  try { await build(directory); }
  catch (error) {
    for (const file of [...files, `${databaseName}-wal`, `${databaseName}-shm`, `${databaseName}-journal`]) {
      await unlink(join(directory, file)).catch(() => undefined);
    }
    await rmdir(directory).catch(() => undefined);
    throw error;
  }
  return directory;
}

async function verify(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, manifestName), "utf8")) as BackupManifest | null;
  if (manifest?.format !== format || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 ||
      typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.sha256) ||
      typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !manifest.inspectionConfig || typeof manifest.inspectionConfig !== "object") {
    throw new Error("备份清单无效或不受支持。");
  }
  await checkFiles(join(directory, databaseName), manifest);
  return manifest;
}

async function backupService(configPath: string, destination: string) {
  const { config, database } = readServerConfig(configPath);
  const directory = await buildInNewDirectory(destination, [databaseName, manifestName], async target => {
    const source = new DatabaseSync(database, { readOnly: true });
    const snapshot = join(target, databaseName);
    try {
      source.exec("PRAGMA busy_timeout = 5000");
      confirmServiceDatabase(source);
      await backup(source, snapshot);
    } finally { source.close(); }

    const portable = new DatabaseSync(snapshot);
    try {
      const journal = portable.prepare("PRAGMA journal_mode = DELETE").get();
      if (journal?.journal_mode !== "delete") throw new Error("无法生成独立的备份数据库文件。");
    } finally { portable.close(); }
    integrityCheck(snapshot);
    const manifest: BackupManifest = { format, createdAt: new Date().toISOString(),
      bytes: (await stat(snapshot)).size, sha256: await fileHash(snapshot), inspectionConfig: inspectionConfig(config) };
    await writeFile(join(target, manifestName), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
  });
  return { directory };
}

async function restore(directory: string, destination: string) {
  const manifest = await verify(directory);
  const recovery = await buildInNewDirectory(destination, [databaseName, recoveryConfigName], async target => {
    const database = join(target, databaseName);
    await copyFile(join(directory, databaseName), database, constants.COPYFILE_EXCL);
    await checkFiles(database, manifest);
    const config = inspectionConfig(manifest.inspectionConfig);
    await writeFile(join(target, recoveryConfigName), JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
  });
  return { config: join(recovery, recoveryConfigName), createdAt: manifest.createdAt };
}

async function run([action, first, second, ...extra]: string[]) {
  if (action === "backup" && first && second && !extra.length) return backupService(first, second);
  if (action === "restore" && first && second && !extra.length) return restore(first, second);
  if (action === "verify" && first && !second && !extra.length) {
    const { createdAt, bytes, sha256 } = await verify(first);
    return { createdAt, bytes, sha256 };
  }
  throw new Error("用法：service-data.cjs backup <配置文件> <新备份目录> | verify <备份目录> | restore <备份目录> <新恢复目录>");
}

void run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n"))
  .catch(error => {
    process.stderr.write((error instanceof Error ? error.message : "数据操作失败。") + "\n");
    process.exitCode = 1;
  });

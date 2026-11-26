import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { isQqId, qqAccountCapabilities, type QqAccountCapability } from "./qq-channel.js";
import { readServerConfig } from "./server-config.js";

const secretNames = ["ADMIN_TOKEN", "ONEBOT_TOKEN", "QQ_INGRESS_TOKEN", "MODEL_KEY", "SUMMARY_MODEL_KEY", "GROUP_MODEL_KEYS",
  "BACKUP_MODEL_KEYS", "MODEL_PROFILE_KEYS"] as const;
export const instanceTokenPattern = /^[A-Za-z0-9_.~-]{24,}$/u;
export type InstancePreflightFailure = { kind: "gateway" | "ingress" } | { kind: "qq-capabilities"; missing: QqAccountCapability[] };
export type InstanceStartupResult = { ok: boolean; failure?: InstancePreflightFailure };
export type InstanceEntry = {
  id: string; name: string; start: boolean; address: string; sourceFile: string; configFile: string;
  hash: string; database: string; databaseKey: string; account: string | undefined; gateway: string | null;
  qqIngress?: string; requiredQqCapabilities: QqAccountCapability[];
  source: Buffer; env: NodeJS.ProcessEnv;
};

export function instanceConfigIsCurrent(entry: InstanceEntry) {
  try { return createHash("sha256").update(readFileSync(entry.configFile)).digest("hex") === entry.hash; }
  catch { return false; }
}

function canonical(path: string): string {
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  if (parent === path) throw new Error("实例数据库所在驱动器不可用。");
  return join(canonical(parent), basename(path));
}

function port(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}

export function readInstances(path: string, environment: NodeJS.ProcessEnv,
    selected: ReadonlyMap<string, string> = new Map(), expectedManifest?: string) {
  let manifest;
  let source: Buffer;
  try {
    source = readFileSync(path);
    manifest = JSON.parse(source.toString("utf8").replace(/^\uFEFF/u, ""));
  }
  catch { throw new Error("实例清单无法读取或 JSON 格式无效。"); }
  const manifestHash = createHash("sha256").update(source).digest("hex");
  if (expectedManifest && expectedManifest !== manifestHash) throw new Error("实例清单已改变，请重启管理器。");
  if (!manifest || !port(manifest.port) || !Array.isArray(manifest.instances) || !manifest.instances.length) {
    throw new Error("请填写实例管理端口和至少一个实例。");
  }
  const token = environment.OHJINGJING_MANAGER_TOKEN;
  if (!token || !instanceTokenPattern.test(token)) throw new Error("请为实例管理设置独立的 OHJINGJING_MANAGER_TOKEN。");
  const ports = new Set<number>([manifest.port]);
  const ids = new Set<string>();
  const paths = new Set<string>();
  const files = new Set<string>();
  const accounts = new Set<string>();
  const tokens = new Set<string>([token]);
  const cleanEnvironment = Object.fromEntries(Object.entries(environment).filter(([name]) => !/^OHJINGJING_/iu.test(name)));
  const entries: InstanceEntry[] = manifest.instances.map((item: any) => {
    const { id, name, config: configPath, start = true, requiredQqCapabilities = [] } = item ?? {};
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(id) || ids.has(id) ||
        typeof name !== "string" || !name.trim() || name.length > 80 || typeof configPath !== "string" || !configPath.trim() || typeof start !== "boolean") {
      throw new Error("实例需要唯一的小写标识、名称、配置路径和有效的自动启动设置。");
    }
    if (!Array.isArray(requiredQqCapabilities) || requiredQqCapabilities.some(value => !qqAccountCapabilities.includes(value))) {
      throw new Error(`实例 ${id} 配置了未知的 QQ 账号能力。`);
    }
    ids.add(id);
    const sourceFile = resolve(dirname(path), configPath);
    const configFile = selected.get(id) ?? sourceFile;
    let loaded: ReturnType<typeof readServerConfig>;
    try { loaded = readServerConfig(configFile); }
    catch { throw new Error(`实例 ${id} 的服务配置无法读取。`); }
    const { config, database, hash, source } = loaded;
    const bindHost = config.host ?? "127.0.0.1";
    const bindPort = config.port ?? 8789;
    if (!port(bindPort) || ports.has(bindPort) || !["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"].includes(bindHost)) {
      throw new Error(`实例 ${id} 需要独立的固定端口和有效的绑定地址。`);
    }
    ports.add(bindPort);
    const realDatabase = canonical(database);
    const databaseFiles = [realDatabase, `${realDatabase}-wal`, `${realDatabase}-shm`, `${realDatabase}-journal`]
      .map(file => process.platform === "win32" ? file.toLowerCase() : file);
    if (databaseFiles.some(file => paths.has(file))) throw new Error(`实例 ${id} 与其他实例共用了状态数据库。`);
    for (const file of databaseFiles) paths.add(file);
    if (existsSync(database)) {
      const stat = statSync(database, { bigint: true });
      const file = `${stat.dev}:${stat.ino}`;
      if (!stat.isFile() || (stat.ino !== 0n && files.has(file))) throw new Error(`实例 ${id} 需要独立的状态数据库。`);
      if (stat.ino !== 0n) files.add(file);
    }
    if (config.channel?.enabled) {
      const account = config.channel.expectedBotId;
      if (!isQqId(account) || accounts.has(account)) throw new Error(`实例 ${id} 需要一个独立的预期 QQ 账号。`);
      accounts.add(account);
    }
    const prefix = `OHJINGJING_INSTANCE_${id.replaceAll("-", "_").toUpperCase()}_`;
    const env = { ...cleanEnvironment, OHJINGJING_CONFIG: configFile, OHJINGJING_CONFIG_SHA256: hash,
      OHJINGJING_SUPERVISED: "1" } as NodeJS.ProcessEnv;
    for (const name of secretNames) {
      const value = environment[prefix + name];
      if (value !== undefined) env[`OHJINGJING_${name}`] = value;
    }
    const admin = env.OHJINGJING_ADMIN_TOKEN;
    if (!admin || !instanceTokenPattern.test(admin) || tokens.has(admin)) throw new Error(`实例 ${id} 需要独立的管理员令牌。`);
    tokens.add(admin);
    if (config.channel?.enabled && config.channel.hasToken && !env.OHJINGJING_ONEBOT_TOKEN) {
      throw new Error(`实例 ${id} 缺少当前网关令牌。`);
    }
    if (config.qqIngress && !env.OHJINGJING_QQ_INGRESS_TOKEN) throw new Error(`实例 ${id} 缺少独立收件令牌。`);
    const loopback = bindHost === "localhost" ? bindHost : bindHost.includes(":") ? "[::1]" : "127.0.0.1";
    const channel = config.channel;
    const gateway = channel?.enabled ? JSON.stringify([channel.pluginId ?? "qq.onebot", channel.address, !!channel.hasToken, channel.qqAccountContract]) : null;
    return { id, name: name.trim(), start, address: `http://${loopback}:${bindPort}`, sourceFile, configFile, hash,
      database, databaseKey: databaseFiles[0], account: channel?.expectedBotId, gateway, qqIngress: config.qqIngress,
      requiredQqCapabilities: [...new Set<QqAccountCapability>(requiredQqCapabilities)], source, env };
  });
  return { port: manifest.port as number, token, entries, manifestHash };
}

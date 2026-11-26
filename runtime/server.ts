import { mkdirSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readBilibiliCreators } from "./bilibili-content-feed.js";
import { createGroupService } from "./group-service.js";
import { resolveImPlugin } from "./im-plugins.js";
import type { InstancePreflightFailure } from "./instance-config.js";
import { type QqAccountCapability, type QqChannelExtensions } from "./qq-channel.js";
import { openQqIngress } from "./qq-ingress.js";
import { readServerConfig } from "./server-config.js";

if (process.argv[2] === "--release-capabilities") {
  writeSync(1, '{"qqIngressHold":1}\n');
  process.exit(0);
}
const path = process.env.OHJINGJING_CONFIG;
if (!path) throw new Error("请设置 OHJINGJING_CONFIG 指向服务端配置文件。");
const { config, database } = readServerConfig(path, process.env.OHJINGJING_CONFIG_SHA256);
const supervised = process.env.OHJINGJING_SUPERVISED === "1" && !!process.send;
const checking = supervised && process.env.OHJINGJING_CONFIG_CHECK === "1";
let activated = !supervised || process.env.OHJINGJING_CONFIG_TRIAL !== "1";
let trialReady = false;
if (!checking) mkdirSync(dirname(database), { recursive: true });
function parseModelKeys(variable: string, slot: RegExp): Record<string, string> {
  const value = process.env[variable];
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.entries(parsed).some(([id, key]) => !slot.test(id) || typeof key !== "string" || !key.trim())) {
      throw new Error("Invalid map");
    }
    return parsed;
  } catch {
    throw new Error(`${variable} 必须为档案位置到密钥的 JSON 对象。`);
  }
}
const developmentTarget = process.env.OHJINGJING_DEVELOPMENT_TARGET?.trim();
const developmentMaintainers = process.env.OHJINGJING_DEVELOPMENT_MAINTAINERS?.split(",").map(value => value.trim()).filter(Boolean) ?? [];
const development = developmentTarget ? { target: developmentTarget, maintainers: developmentMaintainers,
  database: process.env.OHJINGJING_DEVELOPMENT_DATABASE } : config.development;
let developmentDatabase: string | undefined;
if (development !== undefined) {
  if (!development || typeof development.target !== "string" || !/^[\w-]{1,80}$/u.test(development.target) ||
      !Array.isArray(development.maintainers) || !development.maintainers.length ||
      development.maintainers.some(id => typeof id !== "string" || !/^[1-9]\d{3,15}$/u.test(id)) ||
      (development.database !== undefined && (typeof development.database !== "string" || !development.database.trim()))) {
    throw new Error("开发任务需要有效的目标实例、已核验的维护者和任务存储配置。");
  }
  if (development.database) {
    const separate = resolve(dirname(path), development.database);
    if (process.platform === "win32" ? separate.toLowerCase() === database.toLowerCase() : separate === database) {
      throw new Error("开发任务数据库路径需独立于聊天数据库。");
    }
    developmentDatabase = checking ? ":memory:" : separate;
    if (!checking) mkdirSync(dirname(separate), { recursive: true });
  }
}
const service = createGroupService({
  ...config,
  channel: config.channel?.expectedBotId ? { ...config.channel, verifyExpectedBot: true } : config.channel,
  database: checking ? ":memory:" : database,
  adminToken: process.env.OHJINGJING_ADMIN_TOKEN ?? "",
  modelKey: process.env.OHJINGJING_MODEL_KEY,
  summaryModelKey: process.env.OHJINGJING_SUMMARY_MODEL_KEY,
  groupModelKeys: parseModelKeys("OHJINGJING_GROUP_MODEL_KEYS", /^\d+$/),
  backupModelKeys: parseModelKeys("OHJINGJING_BACKUP_MODEL_KEYS", /^(?:default|summary|group:\d+|profile:[\w-]{1,80})$/),
  modelProfileKeys: parseModelKeys("OHJINGJING_MODEL_PROFILE_KEYS", /^[\w-]{1,80}$/),
  channelToken: process.env.OHJINGJING_ONEBOT_TOKEN,
  qqIngressToken: process.env.OHJINGJING_QQ_INGRESS_TOKEN,
  qqVoiceKey: process.env.OHJINGJING_QQ_VOICE_KEY,
  qqWindowsTranscriber: process.env.OHJINGJING_WINDOWS_TRANSCRIBER ??
    resolve(dirname(path), "transcription", "OHJingJing-transcriber.exe"),
  qqSpeechKey: process.env.OHJINGJING_QQ_SPEECH_KEY,
  qqPrivateSpeechKey: process.env.OHJINGJING_QQ_PRIVATE_SPEECH_KEY,
  bilibiliCreators: readBilibiliCreators(process.env.OHJINGJING_BILIBILI_CREATORS),
  development: development ? { ...development, database: developmentDatabase } : undefined,
}, [], () => activated);
const host = config.host ?? "127.0.0.1";
const port = config.port ?? 8789;
async function checkStartup(): Promise<InstancePreflightFailure | undefined> {
  const channel = config.channel;
  if (process.env.OHJINGJING_CONFIG_CHECK_GATEWAY === "1" && channel?.enabled) {
    const gateway = resolveImPlugin(channel.pluginId).create(channel);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const verified = await new Promise<boolean>(done => {
        deadline = setTimeout(() => done(false), 6500);
        try {
          gateway.start({ ...channel, verifyExpectedBot: true }, process.env.OHJINGJING_ONEBOT_TOKEN ?? null, () => {}, undefined, () => {
            if (gateway.status === "online") done(true);
            else if (gateway.status === "disconnected" &&
                (gateway.connectionIssue?.kind === "account-mismatch" || gateway.connectionIssue?.kind === "authorization")) done(false);
          });
        } catch { done(false); }
      });
      if (!verified) return { kind: "gateway" };
      const required: QqAccountCapability[] = JSON.parse(process.env.OHJINGJING_CONFIG_CHECK_QQ_CAPABILITIES ?? "[]");
      if (required.length) {
        const qq = gateway as Partial<QqChannelExtensions>;
        const status = await qq.selfAccountStatus?.();
        const account = status?.account;
        if (gateway.status !== "online" || !account || account.id !== channel.expectedBotId) return { kind: "gateway" };
        const missing = required.filter(capability => !status.capabilities[capability] || (capability === "nickname" && !status.nicknameReadBack));
        if (missing.length) return { kind: "qq-capabilities", missing };
        const space = required.filter(capability => capability.startsWith("qzone"));
        if (space.length && !await qq.listSpacePosts?.(account.id, account.id)) return { kind: "qq-capabilities", missing: space };
        if (gateway.status !== "online") return { kind: "gateway" };
      }
    } finally {
      clearTimeout(deadline);
      gateway.stop();
    }
  }
  if (process.env.OHJINGJING_CONFIG_CHECK_INGRESS === "1" && config.qqIngress) {
    try {
      const read = openQqIngress(config.qqIngress, process.env.OHJINGJING_QQ_INGRESS_TOKEN, channel?.expectedBotId,
        resolveImPlugin(channel?.pluginId).manifest.id);
      if (!(await read(null, AbortSignal.timeout(3000))).online) return { kind: "ingress" };
    } catch { return { kind: "ingress" }; }
  }
}
function reportStartupFailure(failure: InstancePreflightFailure, done: () => void) {
  if (process.connected) process.send!({ preflightFailure: failure }, done);
  else done();
}
if (checking) {
  void checkStartup().finally(() => service.stop()).then(failure => {
    if (failure) reportStartupFailure(failure, () => process.exit(1));
    else process.exit(0);
  }).catch(() => process.exit(1));
} else {
  service.server.listen(port, host, () => {
    const address = service.server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    const urlHost = host.includes(":") ? `[${host}]` : host;
    process.stdout.write(`OHJingJing listening on http://${urlHost}:${boundPort}\n`);
    if (activated) {
      service.startChannel();
      if (supervised && process.connected) process.send?.({ type: "ready" });
    } else {
      void checkStartup().then(failure => {
        if (shuttingDown) return;
        if (failure) { reportStartupFailure(failure, () => shutdown(1)); return; }
        trialReady = true;
        if (process.connected) process.send?.({ type: "ready" });
      }).catch(() => shutdown(1));
    }
  });
}
let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  void service.stop().then(() => process.exit(exitCode), () => process.exit(1));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => shutdown());
if (supervised) {
  process.on("message", message => {
    if (message === "shutdown") shutdown();
    else if (message === "activate" && trialReady && !activated && service.server.listening && !shuttingDown) {
      service.startChannel();
      activated = true;
      process.send?.({ type: "activated" });
    }
  });
  process.once("disconnect", () => shutdown());
}

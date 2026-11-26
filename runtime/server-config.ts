import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { GroupServiceOptions } from "./group-service.js";
import { isQqId } from "./qq-channel.js";

export type ServiceConfig = Omit<GroupServiceOptions, "adminToken" | "modelKey" | "summaryModelKey" | "groupModelKeys" | "backupModelKeys" |
  "modelProfileKeys" | "channelToken" | "qqIngressToken" | "qqVoiceKey" | "qqWindowsTranscriber" | "qqSpeechKey" | "qqPrivateSpeechKey" |
  "contentFeedLoader" | "bilibiliCreators"> & {
  port?: number; host?: string;
};

export function readServerConfig(path: string, expectedHash?: string) {
  const source = readFileSync(path);
  const hash = createHash("sha256").update(source).digest("hex");
  if (expectedHash && hash !== expectedHash) throw new Error("实例配置已更新，请重新启动实例管理以校验新配置。");
  const config = JSON.parse(source.toString("utf8").replace(/^\uFEFF/u, "")) as ServiceConfig | null;
  if (typeof config?.database !== "string" || !config.database.trim()) throw new Error("服务端配置缺少数据库路径。");
  if (config.channel?.qqAccountContract !== undefined && (config.channel.qqAccountContract !== "ohjingjing-v1" ||
      !isQqId(config.channel.expectedBotId) || (config.channel.pluginId !== undefined &&
        !["qq.onebot", "qq.milky"].includes(config.channel.pluginId)))) {
    throw new Error("QQ 账号扩展协议需要受支持的 QQ 渠道、协议版本和明确的机器人账号。");
  }
  return { config, database: resolve(dirname(path), config.database), hash, source };
}

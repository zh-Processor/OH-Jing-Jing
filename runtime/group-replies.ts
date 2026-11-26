import { cleanGroupReply } from "./group-dialogue.js";
import type { GroupExpressionAsset } from "./im-channel.js";
import { readPngAvatar } from "./png-avatar.js";
import { speechStyle, type SpeechStyle } from "./qq-voice.js";

export type RoleExpression = { id: string; label: string; emoji: string; asset?: GroupExpressionAsset };
type ReplyDelivery = { delivery?: "text" | "voice"; style?: SpeechStyle };
export type GroupReplyPart = { text: string; expression?: RoleExpression; groupSticker?: string } & ReplyDelivery;

function readDelivery(value: { delivery?: unknown; style?: unknown }): ReplyDelivery {
  if (value.delivery === "text") return { delivery: "text" };
  if (value.delivery !== "voice") return {};
  const style = speechStyle(value.style);
  return style ? { delivery: "voice", style } : { delivery: "voice" };
}

export function readPrivateReply(input: string | null): { text: string } & ReplyDelivery {
  const text = input?.trim() ?? "";
  const candidate = /^```(?:json)?[ \t]*\r?\n([\s\S]+?)\r?\n```$/iu.exec(text)?.[1] ?? text;
  if (candidate.startsWith("{") && /"delivery"\s*:/u.test(candidate)) {
    try {
      const value = JSON.parse(candidate);
      if (value?.action === "reply" && typeof value.text === "string") return { text: value.text.trim(), ...readDelivery(value) };
    } catch { return { text: "" }; }
  }
  return { text };
}

export function readCommandReply(input: string | null, result: string) {
  if (!input) return result;
  const text = input.trim();
  const candidate = /^```(?:json)?[ \t]*\r?\n([\s\S]+?)\r?\n```$/iu.exec(text)?.[1] ?? text;
  try {
    const value: unknown = JSON.parse(candidate);
    if (!value || typeof value !== "object" || !("action" in value) || value.action !== "reply" ||
        !("intro" in value) || typeof value.intro !== "string") return result;
    const intro = value.intro.trim();
    if (!intro || Array.from(intro).length > 32 || /[\r\n\p{C}\p{N}@<>{}\[\]\/]/u.test(intro)) return result;
    return `${intro}\n${result}`;
  } catch {
    return result;
  }
}

const emoji = new Set(["🙂", "👍", "😂", "👀", "🤔", "🎉", "🐟", "😅", "❤️"]);

export const dafeiyuExpressions: readonly RoleExpression[] = [
  { id: "smile", label: "轻松地笑一下", emoji: "🙂", asset: { kind: "qq-face", id: 14 } },
  { id: "agree", label: "对好主意表示赞同", emoji: "👍", asset: { kind: "qq-face", id: 76 } },
  { id: "bubbles", label: "在自然出现鱼梗时冒个泡", emoji: "🐟" },
];

export function readRoleExpressions(input: unknown): RoleExpression[] {
  if (!Array.isArray(input) || input.length > 8) throw new Error("角色表情预设必须是最多八项的列表。");
  const ids = new Set<string>();
  return input.map(item => {
    if (typeof item?.id !== "string" || !/^[a-z][a-z0-9_-]{0,23}$/.test(item.id) || ids.has(item.id) ||
        typeof item.label !== "string" || !item.label.trim() || item.label.length > 48 || /[\r\n]/.test(item.label) ||
        !emoji.has(item.emoji) || (item.png !== undefined && item.qqFace !== undefined)) {
      throw new Error("表情预设需要唯一 ID、简短用途和有效的备用表情。");
    }
    let asset: GroupExpressionAsset | undefined;
    if (item.png !== undefined) {
      const image = readPngAvatar(item.png, "角色表情");
      asset = { kind: "image", base64: image.split(",", 2)[1] };
    } else if (item.qqFace !== undefined) {
      if (!Number.isSafeInteger(item.qqFace) || item.qqFace < 0 || item.qqFace > 65535) throw new Error("QQ 表情编号无效。");
      asset = { kind: "qq-face", id: item.qqFace };
    }
    ids.add(item.id);
    return { id: item.id, label: item.label.trim(), emoji: item.emoji, asset };
  });
}

export function describeGroupExpressions(expressions: readonly RoleExpression[]) {
  return expressions.map(({ id, label }) => `${id}（${label}）`).join("、");
}

export function groupReplyFormat(expressions: readonly RoleExpression[], voice = false) {
  const choices = describeGroupExpressions(expressions);
  return "只返回 JSON 对象 {\"action\":\"reply\",\"parts\":[\"一条给群友看的回复\"]}。日常一句话用一条消息。" +
    "只有两条各自完整的内容才使用两项，例如先答结论、再给一个完整说明。代码块、清单和引用留在一项里。" +
    (choices ? `轻松场合可用 expression 字段选一个预设：${choices}。严肃回答和通知省略该字段。` : "") +
    (voice ? '请填写 delivery。文字用 "text"。语音用 {"action":"reply","delivery":"voice","style":"playful","parts":["完整的短口述正文"]}。' : "");
}

export function readGroupReply(input: string | null, expressions: readonly RoleExpression[], allowedStickers?: ReadonlySet<string>,
    attachSingleSticker = false): GroupReplyPart[] {
  const text = input?.trim() ?? "";
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]+?)\r?\n```$/iu.exec(text);
  const candidate = fence?.[1] ?? text;
  let pieces: string[] = [text];
  let expression: RoleExpression | undefined;
  let sticker: string | undefined;
  let choseSticker = false;
  let delivery: ReplyDelivery = {};
  if (candidate.startsWith("{") && /"(?:action|parts|expression)"\s*:/.test(candidate)) {
    try {
      const value = JSON.parse(candidate);
      const parts = value?.parts === undefined && typeof value?.text === "string" ? [value.text] : value?.parts;
      if (value?.action !== "reply" || !Array.isArray(parts) || parts.length < 1 || parts.length > 2 ||
          parts.some(part => typeof part !== "string")) return [];
      pieces = parts;
      expression = expressions.find(entry => entry.id === value.expression);
      choseSticker = "groupSticker" in value;
      if (typeof value.groupSticker === "string" && allowedStickers?.has(value.groupSticker)) sticker = value.groupSticker;
      delivery = readDelivery(value);
    } catch { return []; }
  }
  let remaining = 700;
  const result = pieces.flatMap(part => {
    const clean = cleanGroupReply(part.replace(/\[CQ:[^\]\r\n]*\]/giu, ""));
    if (!clean || clean === "[沉默]" || remaining <= 0) return [];
    const clipped = Array.from(clean).slice(0, remaining);
    remaining -= clipped.length;
    return [{ text: clipped.join("") }];
  }) as GroupReplyPart[];
  if (attachSingleSticker && !choseSticker && allowedStickers?.size === 1) sticker = allowedStickers.values().next().value;
  if (sticker && result.length && delivery.delivery !== "voice") result[result.length - 1].groupSticker = sticker;
  else if (expression && result.length) result[result.length - 1].expression = expression;
  if (result.length) Object.assign(result[0], delivery);
  return result;
}

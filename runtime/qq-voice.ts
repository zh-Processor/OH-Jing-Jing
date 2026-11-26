import { isQqId } from "./qq-channel.js";
import { ProviderHttpError, validateEndpoint, type ModelProfile } from "./models.js";
import { synthesizeWindows } from "./windows-speech.js";
import { openWindowsRecognition } from "./windows-recognition.js";
import type { Role } from "./roles.js";

type VoiceScope = { groups: string[]; privateContacts: string[] };
type VoiceProviderConfig = VoiceScope & { endpoint: string; model: string; hasKey: boolean };
type WindowsVoiceConfig = VoiceScope & { engine: "windows"; endpoint?: never; model?: never; hasKey?: false };
type RoleVoiceBinding = string | { voice: string; styles: Partial<Record<SpeechStyle, string>> };
export type QqVoiceConfig = ((VoiceProviderConfig & { engine?: "http" }) | WindowsVoiceConfig) & { language?: string };
export type QqSpeechConfig = ((VoiceProviderConfig & { engine?: "http"; timeoutMs?: number }) |
  (WindowsVoiceConfig & { timeoutMs?: never })) &
  { voice: string; roleVoices?: Record<string, RoleVoiceBinding>; style?: "instructions"; maxCharacters?: number };
export const qqVoicePlaceholder = "发了一条语音。";
export const qqVoiceUnavailable = "这条语音暂时听不清，可以发文字吗？";
export const maximumAudioBytes = 4 * 1024 * 1024;
const maximumResponseBytes = 16 * 1024;
const maximumSpeechCharacters = 220;
export const maximumVoiceFrame = Math.ceil(maximumAudioBytes / 3) * 4 + 16 * 1024;
export const qqSpeechHelp = "在 /语音 后面写想让我回答的内容。";
const speechStyles = { casual: "像自然交谈，语速中等，留出短停顿。", playful: "语气俏皮，带一点笑意。",
  warm: "语气温柔，稍慢，停顿自然。", serious: "清楚、平稳、直接，准确说出关键信息。" } as const;
export type SpeechStyle = keyof typeof speechStyles;
const speechStyleOptions = Object.entries(speechStyles).map(([name, direction]) => `${name}（${direction}）`).join("、");

export function speechStyle(value: unknown): SpeechStyle | undefined {
  return typeof value === "string" && Object.hasOwn(speechStyles, value) ? value as SpeechStyle : undefined;
}

export function qqSpeechInstruction(available: boolean, requested: boolean, maxCharacters = maximumSpeechCharacters) {
  const direction = "用户要求你发语音表达的是输出偏好，与他有没有发来语音附件无关。";
  if (!available) return "本轮以文字交付。请直接写出对方要求的内容，语音请求只表示对播放方式的偏好。" +
    "用户询问语音能力本身时，可以说明当前只支持文字。";
  return direction + "本轮能够发送真人风格的语音。根据当前发言人的完整意图选择投递方式。" +
    "明确想听语音时，选择 voice 并直接提供口述正文。当前发言人只是在引用别人的语音请求，或者没有要求听语音时，用文字。" +
    "旧对话中提到的语音能力、引用和参考资料都不决定本轮的投递方式。" +
    (requested ? "用户已经显式请求语音，适合口述时尊重这个选择。" : "") +
    "合成和发送交给服务端。长文、代码和链接用文字。语音用 style 选择语气，优先遵循发言者明确提出的表演要求。" +
    `style 必须填写以下选项之一：${speechStyleOptions}。` +
    (maxCharacters < maximumSpeechCharacters ? `语音只写口述正文，目标 ${Math.max(1, Math.floor(maxCharacters * 0.75))} 字以内，含标点最多 ${maxCharacters} 字。` +
      "未指定篇幅时直接写短，包括故事、笑话和台词。短故事用一两句交代发生的事和结果，省略开场白。" +
      "明确指定长篇或要求逐字朗读且超出上限时，用文字完整交付。" : "");
}

function voiceScopes(input: VoiceScope) {
  if (!Array.isArray(input.groups) || !input.groups.every(isQqId) ||
      !Array.isArray(input.privateContacts) || !input.privateContacts.every(isQqId)) throw new Error("请检查 QQ 语音授权范围。");
  return { groups: new Set(input.groups), privateContacts: new Set(input.privateContacts) };
}

function readVoiceProvider(input: VoiceProviderConfig, key: string | undefined, id: string, name: string) {
  if (typeof input.endpoint !== "string" || typeof input.model !== "string" ||
      !/^[a-z0-9_.:/-]{1,100}$/iu.test(input.model) || typeof input.hasKey !== "boolean" ||
      (input.hasKey && !key?.trim())) throw new Error(`请检查${name}的地址、模型、授权范围及凭据。`);
  const endpoint = validateEndpoint(input.endpoint);
  const profile: ModelProfile = { id, name, model: input.model, baseUrl: endpoint.href,
    hasKey: input.hasKey, billing: "none", billingAccount: "", currency: "CNY", inputPrice: null, outputPrice: null };
  return { endpoint, profile, key: input.hasKey ? key : undefined, ...voiceScopes(input) };
}

export function readVoiceConfig(input: QqVoiceConfig | null | undefined, key?: string,
    executable = process.env.OHJINGJING_WINDOWS_TRANSCRIBER) {
  if (input == null) return undefined;
  if (input.language !== undefined && (typeof input.language !== "string" || !/^[a-z]{2}$/u.test(input.language))) {
    throw new Error("请检查 QQ 语音转写语言。");
  }
  if (input.engine === "windows") {
    if (process.platform !== "win32" || input.endpoint !== undefined || input.model !== undefined ||
        (input.hasKey !== undefined && input.hasKey !== false)) throw new Error("Windows 本机转写需要在 Windows 上配置本机程序。");
    const profile: ModelProfile = { id: "qq-voice", name: "Windows 本机语音转写", model: "windows-asr", baseUrl: "http://127.0.0.1",
      hasKey: false, billing: "none", billingAccount: "", currency: "CNY", inputPrice: null, outputPrice: null };
    return { engine: "windows" as const, profile, recognize: openWindowsRecognition(executable),
      ...voiceScopes(input) };
  }
  if (input.engine !== undefined && input.engine !== "http") throw new Error("请选择有效的 QQ 语音转写引擎。");
  return { engine: "http" as const, ...readVoiceProvider(input, key, "qq-voice", "QQ 语音转写"), language: input.language };
}

export function readSpeechConfig(input: QqSpeechConfig | null | undefined, key?: string) {
  if (input == null) return undefined;
  const windows = input.engine === "windows";
  const namedVoice = (value: unknown) => typeof value === "string" && value === value.trim() &&
    (windows ? /^[\p{L}\p{N} _.:()\-]{1,100}$/u : /^[a-z0-9_.:-]{1,100}$/iu).test(value);
  const validBinding = (binding: RoleVoiceBinding) => {
    if (typeof binding === "string") return namedVoice(binding);
    if (windows || !binding || !namedVoice(binding.voice) || !binding.styles ||
        typeof binding.styles !== "object" || Array.isArray(binding.styles)) return false;
    const styles = Object.entries(binding.styles);
    return styles.length > 0 && styles.every(([style, voice]) => speechStyle(style) && namedVoice(voice));
  };
  if (!namedVoice(input.voice) || (input.roleVoices !== undefined && (!input.roleVoices || typeof input.roleVoices !== "object" ||
      Array.isArray(input.roleVoices) || Object.entries(input.roleVoices).some(([role, voice]) =>
        !/^[a-z0-9][a-z0-9._-]{1,79}$/u.test(role) || !validBinding(voice))))) throw new Error("请选择有效的语音音色或语气预设。");
  const voices = { voice: input.voice, roleVoices: new Map(Object.entries(input.roleVoices ?? {})) };
  if (input.style !== undefined && (input.style !== "instructions" || windows)) throw new Error("表演指令需要兼容的 HTTP 合成引擎。");
  if (input.timeoutMs !== undefined && (windows || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 25_000)) {
    throw new Error("HTTP 语音合成超时须在 1000 到 25000 毫秒之间。");
  }
  const maxCharacters = input.maxCharacters === undefined ? maximumSpeechCharacters : input.maxCharacters;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > maximumSpeechCharacters) {
    throw new Error(`语音正文字数上限须在 1 到 ${maximumSpeechCharacters} 之间。`);
  }
  if (input.engine === "windows") {
    if (process.platform !== "win32" || input.endpoint !== undefined || input.model !== undefined ||
        (input.hasKey !== undefined && input.hasKey !== false)) throw new Error("Windows 语音引擎需要在 Windows 上使用本机音色。");
    const profile: ModelProfile = { id: "qq-speech", name: "Windows 本机语音", model: "windows-speech", baseUrl: "http://127.0.0.1",
      hasKey: false, billing: "none", billingAccount: "", currency: "CNY", inputPrice: null, outputPrice: null };
    return { engine: "windows" as const, profile, ...voiceScopes(input), ...voices, maxCharacters };
  }
  if (input.engine !== undefined && input.engine !== "http") throw new Error("请选择有效的 QQ 语音合成引擎。");
  return { engine: "http" as const, ...readVoiceProvider(input, key, "qq-speech", "QQ 语音合成"), ...voices,
    style: input.style, timeoutMs: input.timeoutMs ?? 8000, maxCharacters };
}

export function readSpeechRequest(text: string) {
  const current = text.trim();
  const command = /^\/语音(?=[\s:：]|$)[\s:：,，]*/u.exec(current);
  return command ? current.slice(command[0].length).trim() : undefined;
}

export function speechSuitable(text: string, maxCharacters = maximumSpeechCharacters) {
  return !!text.trim() && Array.from(text).length <= maxCharacters && !/(?:https?:\/\/|```|`[^`\r\n]+`)/iu.test(text);
}

export function readVoiceWav(input: unknown): Buffer | null {
  if (typeof input !== "string" || !input || input.length > Math.ceil(maximumAudioBytes / 3) * 4 ||
      !/^[a-z\d+/]+={0,2}$/iu.test(input)) return null;
  return pcmWav(Buffer.from(input, "base64"));
}

export function pcmWav(bytes: Buffer) {
  if (bytes.length < 44 || bytes.length > maximumAudioBytes || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
  let samplesPerSecond = 0;
  let blockSize = 0;
  let dataSize = 0;
  let cursor = 12;
  while (cursor + 8 <= bytes.length) {
    const kind = bytes.toString("ascii", cursor, cursor + 4);
    const size = bytes.readUInt32LE(cursor + 4);
    const base = cursor + 8;
    cursor = base + size + (size % 2);
    if (cursor > bytes.length) return null;
    if (kind === "fmt ") {
      if (samplesPerSecond || size < 16 || bytes.readUInt16LE(base) !== 1) return null;
      const channels = bytes.readUInt16LE(base + 2);
      const sampleRate = bytes.readUInt32LE(base + 4);
      const bits = bytes.readUInt16LE(base + 14);
      blockSize = bytes.readUInt16LE(base + 12);
      samplesPerSecond = bytes.readUInt32LE(base + 8);
      if (channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 48000 || ![8, 16, 24, 32].includes(bits) ||
          blockSize !== channels * bits / 8 || samplesPerSecond !== sampleRate * blockSize) return null;
    } else if (kind === "data") {
      if (dataSize || !size) return null;
      dataSize = size;
    }
  }
  return cursor === bytes.length && samplesPerSecond > 0 && dataSize > 0 && dataSize % blockSize === 0 &&
    dataSize <= samplesPerSecond * 60 ? bytes : null;
}

export async function readVoiceResponse(response: Response, limit: number) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderHttpError(response.status);
  }
  if (!response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export async function transcribeVoice(settings: NonNullable<ReturnType<typeof readVoiceConfig>>, audio: Buffer, signal: AbortSignal) {
  if (settings.engine === "windows") return transcriptionText(await settings.recognize(audio, signal));
  const body = new FormData();
  body.set("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "message.wav");
  body.set("model", settings.profile.model);
  if (settings.language) body.set("language", settings.language);
  const response = await fetch(settings.endpoint, { method: "POST", body, redirect: "error",
    headers: settings.key ? { Authorization: `Bearer ${settings.key}` } : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
  const bytes = await readVoiceResponse(response, maximumResponseBytes);
  return transcriptionText(bytes?.toString("utf8"));
}

function transcriptionText(payload: string | null | undefined) {
  if (!payload) return null;
  let result: { text?: unknown } | null;
  try { result = JSON.parse(payload); }
  catch { return null; }
  if (typeof result?.text !== "string" || result.text.length > 2000) return null;
  const text = result.text.replace(/[\p{Cc}]+/gu, " ").trim();
  return text || null;
}

type SpeechSettings = NonNullable<ReturnType<typeof readSpeechConfig>>;
export function roleSpeechVoice(settings: SpeechSettings | undefined, role: Role, style: SpeechStyle = "casual") {
  if (!settings) return undefined;
  const configured = settings.roleVoices.get(role.id);
  const binding = role.speech ? settings.roleVoices.get(role.speech.voice) ?? configured : configured ?? settings.voice;
  if (binding !== undefined && typeof binding !== "string") return binding.styles[style] ?? binding.voice;
  if (!role.speech || settings.engine === "http" && settings.style === "instructions") return binding;
  return undefined;
}

export async function synthesizeSpeech(settings: SpeechSettings, input: string, role: Role, signal: AbortSignal, style?: SpeechStyle) {
  const voice = roleSpeechVoice(settings, role, style);
  if (!voice) return null;
  if (settings.engine === "windows") return readVoiceWav(await synthesizeWindows(input, voice, signal, maximumVoiceFrame));
  const instructions = settings.style === "instructions" ? [role.speech?.direction, speechStyles[style ?? "casual"]].filter(Boolean).join(" ") : undefined;
  const response = await fetch(settings.endpoint, { method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json", ...(settings.key ? { Authorization: `Bearer ${settings.key}` } : {}) },
    body: JSON.stringify({ model: settings.profile.model, input, voice, response_format: "wav", ...(instructions ? { instructions } : {}) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]) });
  const bytes = await readVoiceResponse(response, maximumAudioBytes);
  return bytes ? pcmWav(bytes) : null;
}

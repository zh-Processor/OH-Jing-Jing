import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import type { Message, ModelProfile } from "./models.js";
import type { PiLookup } from "./pi-harness.js";
import { openQqTurnTools, type FindGroupStickers } from "./qq-history-tool.js";
import type { ThinkingFormat } from "../scripts/model-thinking.mjs";

type Completion = { text: string; refused: boolean; inputTokens: number | null; outputTokens: number | null; local?: true };
type ImageBlock = { type: "image"; mimeType: string; data: string };
export type DshTurnOptions = { privateHistory?: () => string | undefined; groupHistory?: () => string | undefined;
  groupStickers?: FindGroupStickers };
type DshRequestOptions = DshTurnOptions & { thinkingFormat?: ThinkingFormat; images?: ImageBlock[] };
type TurnResult = { ok?: boolean; text?: string; inputTokens?: number | null; outputTokens?: number | null; reason?: string;
  failure?: { code?: unknown; status?: unknown } };
export class DshUnavailableError extends Error {}
export class DshProviderError extends Error {
  constructor(readonly code?: string, readonly status?: number) { super("DSH 供应商请求失败。"); }
}

export function dshImageBlocks(messages: Message[], vision: boolean) {
  const attachments = messages.filter(item => item.images?.length);
  if (!attachments.length) return [];
  const current = messages.findLast(item => item.role !== "system");
  if (!vision || attachments.length !== 1 || current !== attachments[0] || current.role !== "user" || current.images!.length > 2) return null;
  const images: ImageBlock[] = [];
  for (const image of current.images!) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(image);
    if (!match || match[2].length % 4 !== 0 || Buffer.byteLength(match[2], "base64") > 2 * 1024 * 1024) return null;
    images.push({ type: "image", mimeType: match[1], data: match[2] });
  }
  return images;
}

function requiredPath(name: string) {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new DshUnavailableError(`DSH 运行时需要绝对路径 ${name}。`);
  return normalize(value);
}

async function execute(profile: ModelProfile, key: string, messages: Message[], maxTokens: number | undefined,
    timeoutMs: number, signal: AbortSignal, options?: DshRequestOptions): Promise<Completion> {
  signal.throwIfAborted();
  const node = requiredPath("OHJINGJING_DSH_NODE");
  const script = requiredPath("OHJINGJING_DSH_TURN_SCRIPT");
  const sdk = requiredPath("OHJINGJING_DSH_SDK_ROOT");
  const state = requiredPath("OHJINGJING_DSH_STATE");
  try { await Promise.all([access(node), access(script), access(join(sdk, "node_modules", "@deepseek-ai", "dsh-sdk-client", "lib", "index.js"))]); }
  catch { throw new DshUnavailableError("DSH 运行时文件不可用。"); }
  await mkdir(state, { recursive: true });
  const root = await realpath(state);
  const temporary = await mkdtemp(join(root, "turn-"));
  let localTools: Awaited<ReturnType<typeof openQqTurnTools>> | undefined;
  try {
    const groupTools = options?.groupHistory || options?.groupStickers;
    const history = options?.groupHistory ?? options?.privateHistory;
    if (history || groupTools) localTools = await openQqTurnTools(groupTools ? "group" : "private", signal,
      { history, stickers: options?.groupStickers });
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      /^(?:SystemRoot|windir|ComSpec|Path|PATHEXT|SystemDrive|OS|HTTPS_PROXY|NO_PROXY|SSL_CERT_FILE)$/iu.test(name)));
    const value = await new Promise<TurnResult>((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn(node, [script], { cwd: temporary, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
        env: { ...environment, TEMP: temporary, TMP: temporary, OHJINGJING_DSH_SDK_ROOT: sdk } });
      let output = "";
      let force: ReturnType<typeof setTimeout> | undefined;
      let error: Error | undefined;
      const interrupt = () => {
        child.stdin.write("\n");
        force = setTimeout(() => child.kill(), 8_000);
        force.unref();
      };
      signal.addEventListener("abort", interrupt, { once: true });
      child.stdin.on("error", () => {});
      child.stdout.setEncoding("utf8").on("data", chunk => { output = (output + chunk).slice(-280_000); });
      child.once("error", value => { error = value; });
      child.once("close", status => {
        clearTimeout(force);
        signal.removeEventListener("abort", interrupt);
        if (signal.aborted) { reject(signal.reason); return; }
        if (error && child.pid === undefined) { reject(new DshUnavailableError("DSH 运行时启动失败。")); return; }
        if (error || status !== 0) { reject(new Error("DSH 运行时执行失败。")); return; }
        try { resolve(JSON.parse(output.trim()) as TurnResult); }
        catch { reject(new Error("DSH 未返回可读取的回合结果。")); }
      });
      const textMessages = options?.images?.length ? messages.map(({ role, content }) => ({ role, content })) : messages;
      child.stdin.write(JSON.stringify({ profile: { model: profile.model, baseUrl: profile.baseUrl }, key, messages: textMessages,
        images: options?.images, maxTokens, timeoutMs,
        thinkingFormat: options?.thinkingFormat,
        ...(groupTools ? { groupHistoryUrl: localTools?.url } : { privateHistoryUrl: localTools?.url }) }) + "\n");
    });
    const count = (item: number | null | undefined) => Number.isSafeInteger(item) && item! >= 0 ? item! : null;
    const inputTokens = count(value?.inputTokens);
    const outputTokens = count(value?.outputTokens);
    if (!value?.ok || typeof value.text !== "string") {
      if (value?.reason === "timeout") throw new DOMException("DSH response timed out", "TimeoutError");
      if (value?.reason === "startup") throw new DshUnavailableError("DSH 初始化失败。");
      const failure = value?.failure;
      const code = typeof failure?.code === "string" && /^[A-Z_0-9]{1,50}$/u.test(failure.code) ? failure.code : undefined;
      if (code === "CONTENT_REFUSED" || code === "EMPTY_RESPONSE") return { text: "", refused: code === "CONTENT_REFUSED", inputTokens, outputTokens };
      const status = typeof failure?.status === "number" && Number.isInteger(failure.status) && failure.status >= 400 && failure.status <= 599
        ? failure.status : undefined;
      if (code || status) throw new DshProviderError(code, status);
      throw new Error("DSH 回合没有完成。");
    }
    return { text: value.text, refused: false, inputTokens, outputTokens };
  } finally {
    await localTools?.close();
    const path = await realpath(temporary).catch(() => undefined);
    if (path && dirname(path) === root && basename(path).startsWith("turn-")) {
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  }
}

export async function runDshTurn(profile: ModelProfile, key: string, messages: Message[], maxTokens?: number,
    signal?: AbortSignal, timeoutMs = 25_000, lookup?: PiLookup,
    fallback?: (messages: Message[], signal: AbortSignal, remaining: number) => Promise<Completion>, options?: DshRequestOptions) {
  const started = Date.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  const turn = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const transcript = messages.map(item => ({ ...item }));
  let evidence: string | undefined;
  if (lookup) {
    evidence = await lookup.execute(turn);
    turn.throwIfAborted();
    const local = lookup.replyWithoutModel?.(evidence);
    if (local) return { text: local, refused: false, inputTokens: null, outputTokens: null, local: true, backend: "dsh" as const };
    if (lookup.merge) lookup.merge(transcript, evidence);
    else {
      transcript.unshift({ role: "system", content: lookup.instruction });
      transcript.push({ role: "user", content: JSON.stringify({ type: "外部网页资料", tool: lookup.name, content: evidence }) });
    }
  }
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
  let backend: "dsh" | "pi" = "dsh";
  let completion: Completion;
  try { completion = await execute(profile, key, transcript, maxTokens, remaining(), turn, options); }
  catch (error) {
    if (!(error instanceof DshUnavailableError) || !fallback || turn.aborted) throw error;
    backend = "pi";
    completion = await fallback(transcript, turn, remaining());
  }
  const text = !completion.refused && evidence !== undefined && lookup?.formatReply ? lookup.formatReply(completion.text, evidence) : completion.text;
  return { ...completion, text, backend };
}

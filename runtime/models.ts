import { runPiTurn, type PiLookup } from "./pi-harness.js";
import { DshProviderError, dshImageBlocks, runDshTurn, type DshTurnOptions } from "./dsh-harness.js";
import type { TurnBackend } from "./harness-rollout.js";

export interface ModelProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  billing: BillingProvider;
  hasKey: boolean;
  inputPrice: number | null;
  outputPrice: number | null;
  currency: string;
  billingAccount: string;
  contextBudget?: number;
  vision?: boolean;
}

export type Message = { role: "system" | "user" | "assistant"; content: string; images?: string[] };

export function validateEndpoint(value: string): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error("请输入 HTTPS API 地址。本机模型可使用 HTTP。");
  }
  return url;
}

const billingAdapters = {
  deepseek: {
    url: "https://api.deepseek.com/user/balance", origins: ["https://api.deepseek.com"], scope: "account", parse: deepSeekBalance,
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/key", origins: ["https://openrouter.ai"], scope: "key", parse: openRouterBalance,
  },
  packy: {
    url: "https://www.packyapi.ai/api/usage/token/", origins: ["https://cf.api.fan", "https://slb-v1.api.fan"], scope: "key", parse: packyBalance,
  },
} as const;

export type BillingProvider = "none" | keyof typeof billingAdapters;
export type BalanceSnapshot = {
  status: "available" | "unlimited" | "unknown" | "unsupported" | "denied" | "unavailable";
  scope?: "account" | "key";
  checkedAt?: string;
  source?: string;
  values?: { currency: string; remaining: string | number | null; limit?: number | null; used?: number | null;
    granted?: string | null; toppedUp?: string | null }[];
  reset?: string | null;
  effectiveBudget?: { currency: string; remaining: number; scope: string | null; resetsAt: string | null } | null;
};

export function readBillingProvider(value: unknown): BillingProvider {
  return typeof value === "string" && Object.hasOwn(billingAdapters, value)
    ? value as keyof typeof billingAdapters : "none";
}

export function billingAvailable(profile: Pick<ModelProfile, "billing" | "baseUrl">): boolean {
  const provider = readBillingProvider(profile.billing);
  if (provider === "none") return false;
  const origin = validateEndpoint(profile.baseUrl).origin;
  return billingAdapters[provider].origins.some(supported => supported === origin);
}

export class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super(`供应商请求失败（HTTP ${status}）`);
  }
}

export class ProviderTransportError extends Error {}
const dshStatus = new Map([["AUTH", 401], ["QUOTA", 402], ["RATE_LIMIT", 429], ["SERVER", 503]]);

function rethrowDshProviderError(error: unknown): never {
  if (!(error instanceof DshProviderError)) throw error;
  const status = error.status ?? dshStatus.get(error.code ?? "");
  if (status) throw new ProviderHttpError(status);
  if (error.code === "TIMEOUT") throw new DOMException("模型响应超时。", "TimeoutError");
  if (error.code === "MALFORMED_RESPONSE") throw new SyntaxError("模型响应格式错误。");
  if (error.code === "TRANSPORT" || error.code === "STREAM_CLOSED") throw new ProviderTransportError("供应商连接中断。", { cause: error });
  throw error;
}
const transientConnectionErrors = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

export function retryableModelError(error: unknown) {
  if (error instanceof ProviderHttpError) return [402, 408, 429].includes(error.status) || (error.status >= 500 && error.status < 600);
  return error instanceof ProviderTransportError || error instanceof SyntaxError || (error instanceof Error && error.name === "TimeoutError");
}

export function modelAttemptWindow(totalMs: number, hasBackup: boolean) {
  const deadline = performance.now() + totalMs;
  return { primaryTimeout: hasBackup ? Math.floor(totalMs * 2 / 3) : totalMs,
    remaining: () => Math.floor(deadline - performance.now()) };
}

async function request(url: string, key: string | null, body?: object, signal?: AbortSignal, timeoutMs = 25_000) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body) headers["Content-Type"] = "application/json";
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers,
      body: body && JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
    });
    if (!response.ok) throw new ProviderHttpError(response.status);
    return await response.json();
  } catch (error) {
    if (deadline.aborted && !signal?.aborted) throw deadline.reason;
    const cause = error instanceof TypeError ? error.cause as { code?: string } | undefined : undefined;
    if (!signal?.aborted && cause?.code && transientConnectionErrors.has(cause.code)) {
      throw new ProviderTransportError("供应商连接中断。", { cause: error });
    }
    throw error;
  }
}

export async function complete(profile: ModelProfile, key: string | null, messages: Message[], maxTokens?: number,
    signal?: AbortSignal, timeoutMs?: number, lookup?: PiLookup, backend?: TurnBackend, options?: DshTurnOptions) {
  const endpoint = validateEndpoint(profile.baseUrl);
  const base = endpoint.toString().replace(/\/+$/, "");
  const deadline = lookup && timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
  const turnSignal = deadline && signal ? AbortSignal.any([deadline, signal]) : deadline ?? signal;
  const supportsDeepSeekReasoning = /^(?:deepseek-flash|deepseek-v4-flash|deepseek-v4-pro)$/u.test(profile.model) &&
    [...billingAdapters.deepseek.origins, ...billingAdapters.packy.origins].some(origin => origin === endpoint.origin);
  const deepSeekReasoning = supportsDeepSeekReasoning ? options?.deepSeekReasoning : undefined;
  const generate = async (transcript: Message[], modelSignal?: AbortSignal, remaining = timeoutMs) => {
    const result = await request(`${base}/chat/completions`, key, {
      model: profile.model,
      messages: transcript.map(({ role, content, images }) => ({ role, content: images?.length && profile.vision
        ? [{ type: "text", text: content }, ...images.map(url => ({ type: "image_url", image_url: { url } }))] : content })),
      stream: false,
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(deepSeekReasoning === "off" ? { thinking: { type: "disabled" } } :
        deepSeekReasoning === "low" ? { thinking: { type: "enabled" }, reasoning_effort: "low" } : {}),
    }, modelSignal, remaining);
    const choice = result?.choices?.[0];
    const content = choice?.message?.content;
    const input = result?.usage?.prompt_tokens;
    const output = result?.usage?.completion_tokens;
    return {
      text: typeof content === "string" ? content.trim() : "",
      refused: choice?.finish_reason === "content_filter" || !!choice?.message?.refusal || !!result?.error,
      inputTokens: Number.isSafeInteger(input) && input >= 0 ? input : null,
      outputTokens: Number.isSafeInteger(output) && output >= 0 ? output : null,
    };
  };
  const chosen = backend ?? process.env.OHJINGJING_HARNESS;
  const dshImages = chosen === "dsh" && key ? dshImageBlocks(messages, profile.vision === true) : null;
  const completion = dshImages && key
    ? await runDshTurn({ ...profile, baseUrl: base }, key, messages, maxTokens, turnSignal, timeoutMs, lookup,
      (transcript, fallbackSignal, remaining) => runPiTurn(profile, transcript, (input, modelSignal) => generate(input, modelSignal, remaining), fallbackSignal),
      { ...options, deepSeekReasoning, images: dshImages })
      .catch(rethrowDshProviderError)
    : { ...await runPiTurn(profile, messages, generate, turnSignal, lookup), backend: "pi" as const };
  const { inputTokens, outputTokens, backend: actualBackend, ...reply } = completion;
  const estimatedCost = inputTokens !== null && outputTokens !== null &&
    profile.inputPrice !== null && profile.outputPrice !== null
    ? (inputTokens * profile.inputPrice + outputTokens * profile.outputPrice) / 1_000_000
    : null;
  return { ...reply, inputTokens, outputTokens, estimatedCost,
    ...(backend !== undefined || chosen === "dsh" ? { backend: actualBackend } : {}) };
}

const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const billingTimeout = 8000;

export async function balance(profile: ModelProfile, key: string, signal?: AbortSignal): Promise<BalanceSnapshot> {
  const provider = readBillingProvider(profile.billing);
  if (provider === "none" || !billingAvailable(profile)) return { status: "unsupported" };
  const { url, scope, parse } = billingAdapters[provider];
  let snapshot: BalanceSnapshot;
  try {
    const timeout = AbortSignal.timeout(billingTimeout);
    const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const result = await request(url, key, undefined, deadline);
    snapshot = await parse(result, deadline);
  } catch (error) {
    snapshot = { status: error instanceof ProviderHttpError && [401, 403].includes(error.status) ? "denied" : "unavailable" };
  }
  return { ...snapshot, scope, checkedAt: new Date().toISOString(), source: new URL(url).hostname };
}

function deepSeekBalance(result: any): BalanceSnapshot {
  if (!Array.isArray(result?.balance_infos)) return { status: "unknown" };
  const money = (value: unknown) => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;
  const values = result.balance_infos.flatMap((item: any) => {
    if (typeof item?.currency !== "string" || !/^[A-Z]{3}$/.test(item.currency)) return [];
    return [{
      currency: item.currency, remaining: money(item.total_balance),
      granted: money(item.granted_balance), toppedUp: money(item.topped_up_balance),
    }];
  });
  return {
    status: values.some((item: { remaining: string | null }) => item.remaining !== null) ? "available" : "unknown",
    values,
  };
}

function openRouterBalance(result: any): BalanceSnapshot {
  if (!result?.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return { status: "unknown" };
  }
  const data = result.data;
  const limit = amount(data.limit);
  const remaining = amount(data.limit_remaining);
  const effective = data.effective_budget;
  const effectiveRemaining = amount(effective?.remaining_usd);
  return {
    status: remaining !== null ? "available" : data.limit === null ? "unlimited" : "unknown",
    reset: typeof data.limit_reset === "string" ? data.limit_reset : null,
    values: [{ currency: "USD", limit, remaining, used: amount(data.usage) }],
    effectiveBudget: effectiveRemaining === null ? null : {
      currency: "USD", remaining: effectiveRemaining,
      scope: typeof effective?.scope === "string" ? effective.scope : null,
      resetsAt: typeof effective?.resets_at === "string" ? effective.resets_at : null,
    },
  };
}

async function packyBalance(result: any, signal: AbortSignal): Promise<BalanceSnapshot> {
  const data = result?.data;
  if (result?.code === false || result?.success === false || data?.object !== "token_usage" ||
      typeof data.unlimited_quota !== "boolean") {
    return { status: "unknown" };
  }
  const unlimited = data.unlimited_quota;
  const remaining = unlimited ? null : amount(data.total_available);
  const limit = unlimited ? null : amount(data.total_granted);
  const used = amount(data.total_used);
  const status = unlimited ? "unlimited" : remaining === null ? "unknown" : "available";
  if (remaining === null && limit === null && used === null) return { status };

  const publicStatus = await request("https://www.packyapi.ai/api/status", null, undefined, signal).catch(() => null);
  const quotaPerDollar = amount(publicStatus?.data?.quota_per_unit);
  const factor = quotaPerDollar !== null && quotaPerDollar > 0 ? quotaPerDollar : null;
  const convert = (value: number | null) => factor !== null && value !== null ? value / factor : value;
  return {
    status,
    values: [{ currency: factor !== null ? "USD" : "quota", remaining: convert(remaining), limit: convert(limit), used: convert(used) }],
    reset: typeof data.quota_reset_period === "string" && /^[a-z]{1,16}$/u.test(data.quota_reset_period)
      && !["none", "never"].includes(data.quota_reset_period) ? data.quota_reset_period : null,
  };
}

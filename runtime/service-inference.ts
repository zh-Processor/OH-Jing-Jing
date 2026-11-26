import { complete, modelAttemptWindow, retryableModelError, type Message } from "./models.js";
import { summaryFailure, type SummaryFailure } from "./summary-tasks.js";
import type { openGroupReplyTraces } from "./group-reply-traces.js";
import type { openServiceModelAttempts, ModelAttemptLinks, ModelAttemptStage } from "./service-model-attempts.js";
import type { openServiceModels } from "./service-models.js";
import type { openServiceBudget, RequestPurpose } from "./service-budget.js";
import type { PiLookup } from "./pi-harness.js";
import type { TurnBackend } from "./harness-rollout.js";
import type { SemanticWebDecision } from "./web-lookup.js";
import type { FindGroupStickers } from "./qq-history-tool.js";
import { privateHistoryLookup } from "./qq-private.js";

type Binding = NonNullable<ReturnType<ReturnType<typeof openServiceModels>["get"]>>;
type AttemptResult = { text: string | null; failure?: SummaryFailure; blocked?: string; retryable?: boolean; backend?: TurnBackend };
type InferenceContext = ModelAttemptLinks & {
  routeTestAttempts?: (number | bigint)[]; lookup?: PiLookup; acceptText?: (text: string) => boolean; backendScope?: string;
  summaryReviewMs?: number;
  groupProfile?: boolean;
  decideLookup?: (text: string) => SemanticWebDecision | undefined;
  privateHistory?: () => string | undefined;
  groupHistory?: () => string | undefined;
  groupStickers?: FindGroupStickers;
  groupHistoryFallback?: () => PiLookup | undefined;
  onPublicLookup?: () => void;
  reasonOverCurrent?: boolean;
};

function reusePublicEvidence(lookup: PiLookup | undefined, onRead?: () => void): PiLookup | undefined {
  if (lookup?.name !== "web_search" && lookup?.name !== "web_fetch") return lookup;
  let evidence: string | undefined;
  let reported = false;
  return { ...lookup, async execute(signal) {
    signal?.throwIfAborted();
    if (evidence !== undefined) return evidence;
    if (!reported) { reported = true; onRead?.(); }
    const result = await lookup.execute(signal);
    signal?.throwIfAborted();
    evidence = result;
    return evidence;
  } };
}

export function serviceInference(models: ReturnType<typeof openServiceModels>, budget: ReturnType<typeof openServiceBudget>,
    attempts: ReturnType<typeof openServiceModelAttempts>, traces: ReturnType<typeof openGroupReplyTraces>, summaryTimeout: number,
    backendFor?: (purpose: RequestPurpose, scope: string) => TurnBackend) {
  return async function infer(scope: string, messages: Message[], purpose: RequestPurpose, signal?: AbortSignal,
      primary: Binding | undefined = models.select(purpose, scope), links?: InferenceContext): Promise<AttemptResult> {
    if (!primary || signal?.aborted) return { text: null };
    const shortDraft = purpose === "qzone" || purpose === "role-diary";
    const groupConversation = purpose === "proactive" || purpose === "conversation-preview";
    const shortTurn = shortDraft || groupConversation || purpose === "private-greeting" || purpose === "group-reminder";
    const selectedBackend = backendFor?.(purpose, links?.backendScope ?? scope);
    const dshProfile = purpose === "profile" && selectedBackend === "dsh";
    const fastGroupProfile = dshProfile && links?.groupProfile;
    const reviewingSummary = purpose === "summary" && links?.summaryReviewMs !== undefined;
    const totalTimeout = reviewingSummary ? links.summaryReviewMs! : purpose === "summary" || dshProfile ? summaryTimeout : shortTurn ? 15_000 : 25_000;
    const limit = reviewingSummary ? 450 : shortDraft || purpose === "group-reminder" ? 460 : groupConversation ? 240 : purpose === "private-greeting" ? 120
      : dshProfile ? 1200 : purpose === "profile" ? 600 : purpose === "model-test" ? 32 : undefined;
    const singleModelTest = purpose === "model-test" && !links?.routeTestAttempts;
    const candidate = singleModelTest || reviewingSummary ? undefined : models.backup(primary);
    const hasImages = messages.some(message => message.images?.length);
    const backup = candidate && (!hasImages || candidate.model.vision) ? candidate : undefined;
    const canRetryStructured = !reviewingSummary && selectedBackend === "dsh" && !!primary.key && !!links?.acceptText;
    const profileFallback = dshProfile && canRetryStructured;
    const readPrivateHistory = purpose === "private" ? links?.privateHistory : undefined;
    const privateFallback = purpose === "private" && !hasImages && selectedBackend === "dsh" && !!primary.key &&
      !!(readPrivateHistory || links?.decideLookup);
    const groupFallback = purpose === "reply" && selectedBackend === "dsh" && !!primary.key && !!links?.groupHistory;
    const window = modelAttemptWindow(totalTimeout, !!backup || groupFallback || privateFallback || profileFallback);
    const initialLookup = reusePublicEvidence(links?.lookup);
    let privateHistoryRead = false;
    const trackPrivateHistory = readPrivateHistory && (() => {
      const evidence = readPrivateHistory();
      if (evidence) privateHistoryRead = true;
      return evidence;
    });

    async function attempt(binding: Binding, stage: ModelAttemptStage, timeout: number, lookup = initialLookup,
        transcript = messages, routedBackend?: TurnBackend): Promise<AttemptResult> {
      if (signal?.aborted) return { text: null, failure: { kind: "interrupted" } };
      const { model, key, usageKey } = binding;
      if (model.hasKey && !key) return { text: null, failure: { kind: "authorization" } };
      const start = performance.now();
      const elapsed = () => Math.round(performance.now() - start);
      // The background job has one legacy request ID. All attempts are linked in the separate ledger.
      const jobId = stage === "primary" || stage === "test" ? links?.backgroundJobId : undefined;
      const request = budget.start(model, purpose, scope, Date.now(), usageKey, jobId);
      if (request.id === undefined) return { text: null, blocked: request.reason };
      const id = request.id;
      attempts.begin(id, binding.id, model.model, stage, links);
      links?.routeTestAttempts?.push(id);
      if (links?.replyTraceId !== undefined) traces.request(links.replyTraceId, id, model.model);
      const standbyStage = stage === "backup" || stage === "tool-answer-backup";
      const engine = routedBackend ?? (stage === "runtime-fallback" || (standbyStage && selectedBackend === "dsh") ? "pi" : selectedBackend);
      let result: Awaited<ReturnType<typeof complete>>;
      try {
        if (engine) attempts.backend(id, engine);
        const fastSummary = selectedBackend === "dsh" && purpose === "summary";
        const interactiveText = !transcript.some(message => message.images?.length) && (purpose === "private" || purpose === "reply");
        const reasoning = engine === "dsh" && links?.reasonOverCurrent ? "low" :
          fastSummary || fastGroupProfile || privateFallback || groupFallback || (engine === "dsh" && (groupConversation || shortDraft || interactiveText)) ? "off" :
          engine === "dsh" && dshProfile ? "low" : undefined;
        const nativeTools = engine === "dsh" && stage === "primary";
        result = await complete(model, key ?? null, transcript, limit, signal, timeout, lookup, engine, {
          deepSeekReasoning: reasoning, privateHistory: nativeTools ? trackPrivateHistory : undefined,
          groupHistory: nativeTools ? links?.groupHistory : undefined,
          groupStickers: nativeTools && purpose === "reply" ? links?.groupStickers : undefined,
        });
        if (result.backend) attempts.backend(id, result.backend);
      } catch (error) {
        const failure = summaryFailure(error, signal?.aborted);
        budget.finish(id, signal?.aborted ? "cancelled" : "failed", elapsed());
        attempts.failure(id, failure.kind, failure.httpStatus);
        return { text: null, failure, retryable: !signal?.aborted && retryableModelError(error), backend: engine };
      }
      const cancelled = signal?.aborted;
      const text = cancelled || result.refused ? null : result.text;
      if (result.local) {
        budget.releaseUnused(id);
        if (links?.replyTraceId !== undefined) traces.clearRequest(links.replyTraceId, id);
        return cancelled ? { text: null, failure: { kind: "interrupted" } } : { text };
      }
      if (text && links?.acceptText && !links.acceptText(text)) {
        budget.finish(id, "failed", elapsed(), result);
        attempts.failure(id, "format");
        return { text: null, failure: { kind: "format" }, retryable: true, backend: result.backend };
      }
      budget.finish(id, cancelled ? "cancelled" : text ? "ok" : "empty", elapsed(), result);
      if (text) return { text, backend: result.backend ?? engine };
      const kind = cancelled ? "interrupted" : result.refused ? "refused" : "empty";
      attempts.failure(id, kind);
      return { text: null, failure: { kind }, retryable: kind === "empty", backend: result.backend };
    }

    let usedBinding = primary;
    let result = await attempt(primary, reviewingSummary ? "summary-review" : singleModelTest ? "test" : "primary", window.primaryTimeout);
    let remaining = window.remaining();
    if (result.retryable && !signal?.aborted && remaining > 0) {
      const history = privateHistoryRead && readPrivateHistory ? privateHistoryLookup(readPrivateHistory) : links?.groupHistoryFallback?.();
      const withHistory: Message[] = history ? [...messages.slice(0, -1),
        { role: "system", content: "相关历史资料已在本轮提供。根据当前问题和这些资料直接回复，省去任何额外工具请求。" },
        ...messages.slice(-1)] : messages;
      const interruptedOutput = result.failure?.kind === "timeout" || result.failure?.kind === "empty";
      if (backup) {
        usedBinding = backup;
        result = await attempt(backup, "backup", remaining, history, withHistory);
      } else if (result.backend === "dsh" && (
          (canRetryStructured && (result.failure?.kind === "format" || result.failure?.kind === "empty")) ||
          ((privateFallback || groupFallback || profileFallback) && interruptedOutput))) {
        result = await attempt(primary, "runtime-fallback", remaining, history, withHistory);
      }
    }
    const plannedLookup = result.text && links?.decideLookup?.(result.text);
    if (!plannedLookup) return result;
    if (signal?.aborted) return { text: null, failure: { kind: "interrupted" } };
    if (plannedLookup.noQueryRequested) return { text: "收到链接了。你想让我核对什么？" };
    if (!plannedLookup.lookup) return { text: "我没找到可以对外查询的公开检索词或地址。" };
    const selected = plannedLookup.lookup;
    const history = selected.name === "private_history" ? "私聊" : selected.name === "group_evidence" ? "同群" : undefined;
    const unavailable = history ? "这次没能用历史记录继续，能再说一下你指的是哪一段吗？"
      : "这次没能核实到可以回答的公开资料。";
    remaining = window.remaining();
    if (remaining <= 0) return { text: history ? unavailable : "这次没来得及查到资料。" };
    const lookup = reusePublicEvidence(hasImages && !history ? { ...selected, replyWithoutModel: undefined } : selected, links?.onPublicLookup);
    const transcript: Message[] = [...messages.slice(0, -1),
      { role: "system", content: history
        ? `根据当前问题和读取到的${history}记录直接答复。仅参考有关记录，不要再输出工具请求。`
        : "这是本轮最后一次生成。用给定的公开资料直接给出答复，保留依据及来源，不要再输出任何工具请求。"
          + (hasImages ? "完成本轮要求的图片解读。公开资料不足时保留可从图中核实的部分，并说明哪些信息待核实。" : "") },
      ...messages.slice(-1)];
    const answerBackup = usedBinding === primary && remaining > 1 ? backup : undefined;
    const answerTimeout = modelAttemptWindow(remaining, !!answerBackup).primaryTimeout;
    let answer = await attempt(usedBinding, "tool-answer", answerTimeout, lookup, transcript, result.backend);
    remaining = window.remaining();
    if (answerBackup && answer.retryable && remaining > 0 && !signal?.aborted) {
      answer = await attempt(answerBackup, "tool-answer-backup", remaining, lookup, transcript);
    }
    if (signal?.aborted) return { text: null, failure: { kind: "interrupted" } };
    return answer.text && !links?.decideLookup?.(answer.text) ? answer : { ...answer, text: unavailable };
  };
}

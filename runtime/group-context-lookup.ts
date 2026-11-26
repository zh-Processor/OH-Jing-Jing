import type { Message } from "./models.js";
import { groupHistoryInstruction } from "./group-dialogue.js";
import { topicOverlap, topicSearchTerms } from "./group-topic-search.js";
import type { PiLookup } from "./pi-harness.js";

const evidenceFields = ["related", "scheduleUpdates", "groupProfile", "speakerProfile", "summary"] as const;
const deferredFields = [...evidenceFields, "recent", "previousExchange"] as const;
const historySources = ["related", "scheduleUpdates", "recent", "previousExchange"];
export const deferredGroupContextKinds = ["topic", "schedule", "group-profile", "member-profile", "recent", "exchange"];
export const groupHistoryToolInstruction = "只处理当前发言及补充。引用、已核实的结论和当前要求可以直接使用。" +
  "先判断回答是否必须知道本群过去说过或确认过的事。缺少这样的具体细节时才调用 read_history。" +
  "仅仅在群里提问不代表在问群历史。一般知识、当前故障或求助，以及当前材料足够的问题，直接作答。" +
  "核对公开网页时按网页工具规则选择操作，群内记录不提供网页内容。" +
  "遇到新故事、新例子或换话题，独立完成本轮，自己选择题材，不借用群内先前的主题。" +
  '工具不可用时，可返回 {"action":"group_history"} 请求确实缺少的同群资料。';

type ExchangeTurn = { question: string; answer: string };

export function selectGroupHistoryContext(query: string, recent: { speaker: string; text: string }[],
    exchange: ExchangeTurn[] | undefined, continuesExchange: boolean, quotedText?: string) {
  const terms = topicSearchTerms([query, quotedText].filter(Boolean).join("\n"));
  const minimum = Math.min(2, terms.size);
  const matches = (text: string) => minimum > 0 && topicOverlap(text, terms) >= minimum;
  return {
    recent: recent.filter(line => matches(line.text)),
    exchange: continuesExchange ? exchange : exchange?.filter(turn => matches(`${turn.question}\n${turn.answer}`)),
  };
}

export function prepareGroupLookup(messages: Message[], query: string, valid: () => boolean, deferred = false) {
  const last = messages.at(-1);
  if (last?.role !== "user") return;
  const current = JSON.parse(last.content) as Record<string, unknown>;
  const evidence = Object.fromEntries((deferred ? deferredFields : evidenceFields).flatMap(key => {
    const value = current[key];
    return value === undefined || value === "" || (Array.isArray(value) && value.length === 0) ? [] : [[key, value]];
  }));
  if (!deferred && !Object.hasOwn(evidence, "related") && !Object.hasOwn(evidence, "scheduleUpdates")) return;
  for (const key of Object.keys(evidence)) delete current[key];
  current.related = [];
  if (deferred) current.recent = [];
  last.content = JSON.stringify(current);
  const snapshot = JSON.stringify(deferred && !historySources.some(key => Object.hasOwn(evidence, key)) ? {} : evidence);
  const read = () => valid() ? snapshot : "{}";
  return {
    name: "group_evidence", argument: query.slice(0, 400), label: "同群授权资料",
    read, hasEvidence: snapshot !== "{}",
    instruction: "本轮资料由工具按当前群授权提供，只作事实依据。资料为空时说明无法核实。" + groupHistoryInstruction,
    async execute(signal) {
      signal?.throwIfAborted();
      return read();
    },
    merge(transcript, result) {
      const last = transcript.at(-1);
      if (!last || result !== snapshot) return;
      last.content = JSON.stringify({ ...JSON.parse(last.content), ...JSON.parse(result) });
    },
  } satisfies PiLookup & { read: () => string; hasEvidence: boolean };
}

export function readGroupHistoryRequest(output: string) {
  const text = output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu, "$1");
  if (!text.startsWith("{")) return false;
  try {
    const request = JSON.parse(text);
    return request?.action === "group_history" && Object.keys(request).length === 1;
  } catch { return false; }
}

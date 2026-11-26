import { groupScheduleDates, groupScheduleTimes, type GroupLine } from "./group-dialogue.js";
import { asksForLastDecision, recallSearchTerms, topicDateRange, topicOverlap, topicSearchTerms } from "./group-topic-search.js";
import type { TopicRecall } from "./group-topics.js";

const finalClockQuestion = /(?:几点(?:钟)?|几时|什么时间|什么时候|何时|周几|哪天|几号)(?:来着|呀|啊|呢|吗)?[。？?！!\s]*$/u;
const dayQuestion = /(?:周几|哪天|几号)(?:来着|呀|啊|呢|吗)?[。？?！!\s]*$/u;
const proposal = /(?:要不|提议|建议|可否|能否|能不能|行不行|可以吗|暂定|还没定|尚未|如果|不行|不再|不改|不去|取消|待定|待确认|否决|反对|听说|好像|可能|据说|(?:没|未|不|别)(?:有|能|会|打算)?(?:确认|确定|定在|定为|决定|改到|改成))/u;
const confirmation = /(?:确认|决定|确定|就定|定在|定为|改到|改成|更改为|以.{1,20}为准|准时见)/u;
const changedSchedule = /(?:改到|改成|调整到|取消|推迟|提前|恢复原|时间变|换到|改期|待定)/u;

const canonical = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "").replace(/^星期/u, "周").replace(/^周天$/u, "周日");

export function preservesHistoryConclusion(text: string, conclusion: string) {
  const comparable = (value: string) => value.normalize("NFKC").trim().replace(/^["“「]|["”」]$/gu, "")
    .replace(/[。！!?？\s]+$/u, "");
  return comparable(text) === comparable(conclusion);
}

function readSchedule(text: string, askingDay: boolean) {
  const dates = groupScheduleDates(text);
  const times = groupScheduleTimes(text);
  if (dates.length > 1 || times.length > 1) return undefined;
  const date = dates[0];
  const time = times[0];
  if ((askingDay ? !date : !time) || (date && (date === "周末" && askingDay ||
      /^(?:今天|明天|后天)$/u.test(date)))) return undefined;
  return { date, time };
}

function showsConfirmation(text: string) {
  return !/[？?]/u.test(text) && !proposal.test(text) && confirmation.test(text);
}

function confirmedTime(history: Extract<TopicRecall, { missingDecisionEvidence: boolean }>, askingDay: boolean) {
  const decision = history.latestDecision;
  if (!decision || decision.reported || !history.evidence?.length) return undefined;
  const schedule = readSchedule(decision.text, askingDay);
  if (!schedule) return undefined;
  const { date, time } = schedule;
  const verified = history.evidence.some(({ excerpt }) => {
    if (!showsConfirmation(excerpt)) return false;
    const observedDates = groupScheduleDates(excerpt).map(canonical);
    const observedTimes = groupScheduleTimes(excerpt).map(canonical);
    return (!date || observedDates.length === 1 && observedDates.includes(canonical(date))) &&
      (!time || observedTimes.length === 1 && observedTimes.includes(canonical(time)));
  });
  return verified ? `按群里的确认记录，是${date ?? ""}${askingDay ? "" : time}。` : undefined;
}

export function groupHistoryReply(input: {
  query: string; reference?: string; related: TopicRecall[]; conversation: GroupLine[]; additions: GroupLine[]; quoted: boolean;
  calendar?: { now: number; timeZone: string };
}) {
  const { query, reference, related, conversation, additions, quoted } = input;
  const history = related.length === 1 ? related[0] : undefined;
  if (!history || !("missingDecisionEvidence" in history) || !asksForLastDecision(query)) return {};
  const terms = recallSearchTerms(query, reference);
  const search = new Set([...terms, ...topicSearchTerms(history.title)]);
  const lastKnown = Date.parse(history.latestDecision?.at ?? history.createdAt);
  const dateRange = topicDateRange(query, input.calendar, reference);
  const newer = conversation.filter(line => {
    if (line.role !== "member" || line.time <= lastKnown || !topicOverlap(line.text, search)) return false;
    if (dateRange) {
      const at = new Date(line.time).toISOString();
      if (!dateRange.contains(at, at)) return false;
    }
    return groupScheduleTimes(line.text).length || groupScheduleDates(line.text).length || changedSchedule.test(line.text);
  }).slice(-3);
  const clauses = query.trim().replace(/[。！？!?\s]+$/u, "");
  const extraRequest = /[。！？!?\r\n]|顺便|还想问|再告诉我|另外|以及/u.test(clauses);
  if (quoted || additions.length || extraRequest || groupScheduleTimes(query).length) return { newer };
  const askingDay = dayQuestion.test(query);
  const clockLookup = finalClockQuestion.test(query) && query.length <= 160;
  if (newer.length) {
    const latest = newer.at(-1)!.text;
    const schedule = clockLookup && showsConfirmation(latest) ? readSchedule(latest, askingDay) : undefined;
    const attribution = dateRange ? "群友后来确认" : "刚有群友确认";
    return schedule ? { newer, reply: { text: `${attribution}，是${schedule.date ?? ""}${askingDay ? "" : schedule.time}。`,
      reason: "recent-schedule-confirmation" } } : { newer };
  }
  if (history.missingDecisionEvidence || (history.effective === "unknown" && history.coverage === "expired")) {
    return { reply: { text: "这事最后怎么定的，现有记录里核实不了。", reason: "history-evidence-missing" } };
  }
  if (history.effective === "retracted" && history.evidence?.some(({ excerpt }) =>
      !/[？?]/u.test(excerpt) && !/(?:要不|提议|建议|是否|可能|听说|好像|还没|不取消|未取消)/u.test(excerpt)
      && /(?:取消|撤回|作废|不再举行)/u.test(excerpt))) {
    return { reply: { text: "按群里的记录，之前的安排已经撤回。", reason: "history-retracted" } };
  }
  const text = clockLookup ? confirmedTime(history, askingDay) : undefined;
  return text ? { reply: { text, reason: "history-decision" } } : {};
}

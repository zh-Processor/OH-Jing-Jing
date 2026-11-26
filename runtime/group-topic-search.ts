import { redactExcerpt } from "./group-profiles.js";

const wording: [RegExp, string][] = [
  [/一起吃(?:个)?饭|约(?:个)?饭|聚个[餐饭]|聚饭|饭局/gu, "聚餐"],
  [/组队联机|联网组队|一起开黑|打团开黑|开黑/gu, "联机"],
  [/破谜|做谜题|破解谜题|解开谜题|做解谜题/gu, "解谜"],
  [/走台|彩排/gu, "排练"],
  [/团体报名|登记参加|登记参赛|报名参加/gu, "报名"],
];
const generic = /前几天|上上星期|上上周|上个星期|上星期|上周|本周|这周|下周|前天|昨天|昨日|今天|明天|后天|这两天|之前|刚才|当时|后来|然后|原来|最后一次|最后|最终|究竟|到底|确定下来|什么时候|什么时间|几点钟|几点|几时|何时|哪天|周几|几号|在哪儿|在哪里|什么地方|地点|时间|怎么安排|安排|确认过|确认|决定|已经|定下|定好|定了|定在|改成|改到|要不要|能不能|告诉我|帮我查|帮忙查|查一下|问一下|能说说|说一下|说过什么|聊过什么|聊了什么|怎么说|这件事|那件事|这个群|这个|那个|记不记得|记得|是不是|还没|现在|目前|大家|我们|你们|群里|好的|谢谢|什么|怎么|一下|一些/gu;
const decisionQuestion = /怎么定(?:的|了)?|结果是什么|结论是什么/gu;
const historicalQuestion = /什么时候|什么时间|几点|几时|何时|哪天|周几|几号|在哪儿|在哪里|什么地方|地点|时间|定(?:下|好|了|在)|怎么定|结果是什么|结论是什么|(?:最后|最终|之前).{0,8}(?:说|确认|改|决定)|改成|改到|确认|决定/u;
const relativeDate = /上上周|上上星期|上个星期|上星期|上周|本周|这周|前天|昨天|昨日|今天/u;

export function topicSearchTerms(value: string) {
  let cleaned = redactExcerpt(value.normalize("NFKC").toLowerCase()).replace(/\[(?:链接|电邮|凭据|数字标识)\]/gu, " ");
  for (const [pattern, canonical] of wording) cleaned = cleaned.replace(pattern, ` ${canonical} `);
  const words = cleaned.replace(decisionQuestion, " ").replace(generic, " ").match(/\p{Script=Han}{2,}|[a-z0-9]{3,}/gu) ?? [];
  return new Set(words.flatMap(word => {
    if (!/^\p{Script=Han}/u.test(word)) return [word];
    const characters = Array.from(word);
    return characters.slice(1).map((character, index) => characters[index] + character);
  }));
}

export function recallSearchTerms(query: string, reference?: string) {
  const direct = topicSearchTerms(query);
  return !direct.size && reference && historicalQuestion.test(query) ? topicSearchTerms(reference) : direct;
}

export function topicOverlap(value: string, requested: Set<string>) {
  return [...topicSearchTerms(value)].filter(term => requested.has(term)).length;
}

export function asksForLastDecision(query: string) {
  return /(?:最后|最终|到底).{0,12}(?:几点|几时|哪天|周几|几号|何时|什么时间|什么时候|在哪|结果|结论|定|确认)/u.test(query);
}

export function topicDateRange(query: string, calendar?: { now: number; timeZone: string }, reference?: string) {
  if (!calendar) return undefined;
  const direct = relativeDate.exec(query)?.[0];
  const carried = !direct && reference && historicalQuestion.test(query) && !topicSearchTerms(query).size
    ? relativeDate.exec(reference)?.[0] : undefined;
  const relative = direct ?? carried;
  if (!relative) return undefined;
  const localDay = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeZone: calendar.timeZone });
  const today = Date.parse(localDay.format(calendar.now) + "T00:00:00Z");
  const weekDay = (new Date(today).getUTCDay() + 6) % 7;
  const week = /周|星期/u.test(relative);
  const offset = week ? -weekDay - (relative === "本周" || relative === "这周" ? 0 : relative.startsWith("上上") ? 14 : 7) :
    relative === "前天" ? -2 : relative === "今天" ? 0 : -1;
  const day = 86_400_000;
  const start = new Date(today + offset * day);
  const end = new Date(start.getTime() + (week ? 7 : 1) * day);
  const firstDay = start.toISOString().slice(0, 10);
  const lastDay = end.toISOString().slice(0, 10);
  return {
    // SQL narrows the scan. Exact membership uses the group's local calendar.
    scanFrom: new Date(start.getTime() - day).toISOString(),
    scanTo: new Date(end.getTime() + day).toISOString(),
    contains(first: string, last: string) {
      const earliest = Date.parse(first);
      const latest = Date.parse(last);
      return Number.isFinite(earliest) && Number.isFinite(latest) && localDay.format(earliest) < lastDay && localDay.format(latest) >= firstDay;
    },
  };
}

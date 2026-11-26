import type { TopicReviewItem } from "./group-topics.js";

const day = 86_400_000;
export const reviewDays = [1, 7, 30] as const;
export type ReviewDays = typeof reviewDays[number];
const commandPeriods = { "近一天": 1, "近七天": 7, "近三十天": 30, "1天": 1, "7天": 7, "30天": 30 } as const;

export function readTopicReviewCommand(value: string): ReviewDays | undefined {
  const command = /^\/话题复盘(?:[ \t]+(近一天|近七天|近三十天|1天|7天|30天))?[\s。！？!?]*$/u.exec(value.trim());
  if (!command) return;
  return command[1] ? commandPeriods[command[1] as keyof typeof commandPeriods] : 7;
}

export function topicReviewWindow(days: ReviewDays, now: number, retainedAfter: string) {
  const from = now - days * day;
  const retention = Date.parse(retainedAfter);
  return {
    from: new Date(Math.max(from, retention)).toISOString(),
    to: new Date(now).toISOString(),
    retentionLimited: retention > from,
  };
}

export const topicReviewState = { confirmed: "已确认", retracted: "已取消", pending: "仍待定", unknown: "原文不足，待核对" };

export function topicReviewDetails(item: TopicReviewItem, timeZone: string) {
  const clock = new Intl.DateTimeFormat("zh-CN", { timeZone, month: "numeric", day: "numeric" });
  const line = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  const state = item.current?.reported ? "群友报告" : topicReviewState[item.state];
  return [item.current ? state + " · " + clock.format(new Date(item.current.at)) + " " + line(item.current.text) : state,
    item.pending ? "待确认 · " + clock.format(new Date(item.pending.at)) + " " + line(item.pending.text) : ""].filter(Boolean).join("\n");
}

export function topicReviewReply(days: ReviewDays, report: { items: TopicReviewItem[]; retentionLimited: boolean; limited: boolean }, timeZone: string) {
  if (!report.items.length) return `本群近 ${days} 天暂无可核实的话题进展。`;
  const items = report.items.slice(0, 4).map((item, index) => `${index + 1}. ${item.title.replace(/\s+/gu, " ").trim()}\n${topicReviewDetails(item, timeZone)}`);
  return [`本群近 ${days} 天话题复盘`, report.retentionLimited && "原文保留期较短，仅整理仍可核实的部分。",
    (report.limited || report.items.length > items.length) && "以下是最近的进展。", ...items].filter(Boolean).join("\n");
}

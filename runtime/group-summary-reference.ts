import { createHash } from "node:crypto";
import type { TopicDetails } from "./group-topics.js";

export type GroupSummary = {
  id?: number; content: string; created_at: string; source_start?: string | null; source_end?: string | null;
  topics?: TopicDetails[];
};

const topicFactNames = { proposal: "提议", decision: "已确认", change: "已确认的变更", open: "待定", retraction: "已取消或撤回" } as const;

export function summaryReference(summary?: GroupSummary) {
  if (typeof summary?.content !== "string" || !summary.content.trim() ||
      typeof summary.created_at !== "string" || !Number.isFinite(Date.parse(summary.created_at))) return null;
  const topics = Array.isArray(summary.topics) ? summary.topics.slice(0, 3).map(topic => {
    if (!topic || typeof topic.title !== "string" || typeof topic.content !== "string") return "";
    if (topic.coverage === "expired") return topic.title.slice(0, 64) + "\n该话题的原文已超出可用范围。";
    const facts = Array.isArray(topic.facts) ? topic.facts.slice(0, 6).flatMap(fact =>
      fact && typeof fact.text === "string" && Object.hasOwn(topicFactNames, fact.kind)
        ? [`${fact.kind === "change" && fact.reported === true ? "群友报告" :
          fact.kind === "decision" && fact.reaffirms === true ? "原决定仍有效" : topicFactNames[fact.kind]} ${fact.text.slice(0, 200)}`] : []) : [];
    return [topic.title.slice(0, 64), topic.content.slice(0, 480), ...facts,
      ...(topic.effective === "retracted" ? ["此前决定已撤回"] : []),
      ...(topic.coverage === "complete" ? [] : ["历史证据有缺口"])].join("\n");
  }) : [];
  const context = [summary.content.slice(0, 900), ...topics].filter(Boolean).join("\n\n").slice(0, 2900);
  const revision = createHash("sha256").update(JSON.stringify([summary.id ?? null, summary.created_at, context])).digest("hex");
  return { context, revision };
}

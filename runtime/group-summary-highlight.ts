import type { TopicDetails } from "./group-topics.js";

const factReactions = { proposal: "question", open: "question", decision: "decision", change: "change", retraction: "retracted" } as const;
const priority = { proposal: 0, open: 1, decision: 2, change: 3, retraction: 4 } as const;
export const summaryReactionLabels = {
  summary: "有新摘要", topic: "有话题更新", question: "有话题待确认", decision: "有新决定", change: "有已确认的变更",
  reported: "有群友报告", "reported-question": "有群友报告和待确认事项", retracted: "原决定已撤回",
} as const;
export type SummaryReaction = keyof typeof summaryReactionLabels;

export function groupSummaryHighlight(topics?: TopicDetails[]) {
  if (!Array.isArray(topics)) return undefined;
  const current = topics.filter(topic => topic?.title && (topic.coverage === "complete" || topic.coverage === "partial"));
  const updates = current.flatMap(topic => (Array.isArray(topic.facts) ? topic.facts : [])
    .filter(fact => fact?.text && !fact.reaffirms && Object.hasOwn(factReactions, fact.kind) && Number.isFinite(Date.parse(fact.at)))
    .map(fact => ({ topic, fact, reaction: fact.kind === "change" && fact.reported === true ? "reported" as const : factReactions[fact.kind] })));
  updates.sort((first, second) => Date.parse(second.fact.at) - Date.parse(first.fact.at) ||
    priority[second.fact.kind] - priority[first.fact.kind]);
  const latest = updates[0];
  if (latest) {
    if (latest.reaction === "reported" || latest.reaction === "question") {
      const related = updates.filter(item => item.topic === latest.topic);
      const decision = related.findIndex(item => item.reaction !== "reported" && item.reaction !== "question");
      const pending = decision < 0 ? related : related.slice(0, decision);
      const report = pending.find(item => item.reaction === "reported");
      const question = pending.find(item => item.reaction === "question");
      if (report && question) return { reaction: "reported-question", title: latest.topic.title, detail: question.fact.text, report: report.fact.text } as const;
    }
    return { reaction: latest.reaction, title: latest.topic.title, detail: latest.fact.text } as const;
  }
  const topic = current[0];
  return topic ? { reaction: "topic", title: topic.title, detail: "" } as const : undefined;
}

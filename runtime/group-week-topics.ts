import type { TopicDetails } from "./group-topics.js";

const hour = 3_600_000;
const shanghaiOffset = 8 * hour;

export function weekTopicCommand(text: string) {
  return /^\/本周话题[\s。！？!?]*$/u.test(text.trim());
}

export function weekTopicWindow(now: number) {
  const day = new Date(now + shanghaiOffset);
  const daysSinceMonday = (day.getUTCDay() + 6) % 7;
  const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - daysSinceMonday) - shanghaiOffset;
  return { start, end: now };
}

export function selectWeekTopics(summaries: readonly (readonly TopicDetails[])[], window: ReturnType<typeof weekTopicWindow>) {
  const candidates = new Map<string, { topic: TopicDetails; appearances: number; latest: number }>();
  for (const summary of summaries) {
    for (const topic of summary) {
      const from = Date.parse(topic.from);
      const to = Date.parse(topic.to);
      const title = topic.title.trim();
      if (!title || topic.coverage === "expired" || !Number.isFinite(from) || !Number.isFinite(to) ||
          to < window.start || from > window.end) continue;
      const key = title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") || title;
      const previous = candidates.get(key);
      candidates.set(key, { topic: previous && previous.latest > to ? previous.topic : topic,
        appearances: (previous?.appearances ?? 0) + 1, latest: Math.max(previous?.latest ?? to, to) });
    }
  }
  return [...candidates.values()].sort((a, b) => b.appearances - a.appearances || b.latest - a.latest)
    .slice(0, 3).map(item => item.topic);
}

export function weekTopicReply(topics: readonly TopicDetails[]) {
  if (!topics.length) return "本群本周还没有可查看的话题记录。";
  return "本群本周话题：\n" + topics.map((topic, index) => `${index + 1}. ${topic.title}`).join("\n");
}

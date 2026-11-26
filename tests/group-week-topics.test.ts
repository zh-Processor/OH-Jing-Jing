import assert from "node:assert/strict";
import test from "node:test";
import type { TopicDetails } from "../runtime/group-topics";
import { selectWeekTopics, weekTopicWindow } from "../runtime/group-week-topics";

test("weekly topics use Shanghai Monday midnight, exclude expired evidence and merge equivalent titles", () => {
  const now = Date.parse("2026-11-23T01:00:00.000Z");
  const window = weekTopicWindow(now);
  assert.equal(new Date(window.start).toISOString(), "2026-11-22T16:00:00.000Z");
  assert.equal(window.end, now);
  const topic = (title: string, to: string, coverage: TopicDetails["coverage"] = "complete"): TopicDetails => ({
    title, content: "用于验收", from: to, to, coverage, facts: [],
  });
  const result = selectWeekTopics([
    [topic("上周活动", "2026-11-22T15:59:59.000Z"), topic("新展览", "2026-11-22T16:00:00.000Z"),
      topic("午饭安排", "2026-11-22T19:30:00.000Z"), topic("已过期", "2026-11-22T23:00:00.000Z", "expired")],
    [topic("新展览！", "2026-11-22T19:00:00.000Z"), topic("桌游", "2026-11-22T18:00:00.000Z"),
      topic("未发生", "2026-11-23T01:00:01.000Z")],
  ], window);
  assert.deepEqual(result.map(item => item.title), ["新展览！", "午饭安排", "桌游"]);
});

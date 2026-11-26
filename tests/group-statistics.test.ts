import assert from "node:assert/strict";
import test from "node:test";
import { openGroupReplyTraces, type GroupReplyTrigger, type TraceState } from "../runtime/group-reply-traces";
import { openGroupStatistics } from "../runtime/group-statistics";
import { openStore } from "../runtime/store";

test("group statistics reuse historical activity and measure trigger rates within the reply sample", () => {
  const { db } = openStore(":memory:");
  try {
    const scope = "qq:1001:5001";
    const otherAccount = "qq:1002:5001";
    const otherGroup = "qq:1001:5002";
    const first = "2026-11-22T18:00:00.000Z";
    const beforeMidnight = "2026-11-23T15:59:59.000Z";
    const midnight = "2026-11-23T16:00:00.000Z";
    const end = "2026-11-23T18:00:00.000Z";
    const weekOnly = "2026-11-20T04:00:00.000Z";
    const notice = db.prepare("INSERT INTO channel_events VALUES (?,?,?,?,?,?)");
    notice.run("1001", "old", first, scope, "2001", "");
    notice.run("1001", "earlier", weekOnly, scope, "2003", "");
    notice.run("1001", "trigger", beforeMidnight, scope, "2001", "");
    notice.run("1001", "quiet", midnight, scope, "2002", "");
    notice.run("1001", "at-end", end, scope, "2004", "");
    notice.run("1002", "trigger", midnight, otherAccount, "2005", "");
    notice.run("1001", "other-group", midnight, otherGroup, "2006", "");
    const send = db.prepare("INSERT INTO outbox(scope,event_id,created_at,status,content) VALUES (?,?,?,?,'')");
    for (const status of ["sent", "failed", "unknown", "sending"]) send.run(scope, status, midnight, status);
    send.run(otherAccount, "sent", midnight, "sent");
    send.run(scope, "old-delivery", weekOnly, "sent");

    const traces = openGroupReplyTraces(db);
    const stats = openGroupStatistics(db);
    const role = { id: "fixture.role", name: "测试角色", version: "1.0.0", revision: "a".repeat(64) };
    const now = Date.parse(end);
    const legacy = stats.read(scope, "1", 7, now);
    assert.equal(legacy.observed.messages, 3);
    assert.equal(legacy.reply.rate, null);
    assert.deepEqual(legacy.deliveries, { sent: 1, failed: 1, unknown: 1, sending: 1 });

    stats.recordEligibleMessage(scope, "trigger", beforeMidnight);
    stats.recordEligibleMessage(scope, "trigger", beforeMidnight);
    stats.recordEligibleMessage(scope, "quiet", midnight);
    stats.recordEligibleMessage(scope, "earlier", weekOnly);
    stats.recordEligibleMessage(otherAccount, "trigger", midnight);
    traces.finish(traces.begin(scope, "trigger", "mention", role), "finished", "reply");
    traces.finish(traces.begin(scope, "trigger", "discussion", role), "finished", "sent");
    traces.finish(traces.begin(scope, "quiet", "opening", role), "finished", "sent");
    traces.finish(traces.begin(scope, "quiet", "mention", role), "skipped", "paused");
    traces.gated(scope, "quiet", "discussion", role, "quiet", Date.parse(midnight));
    traces.gated(scope, "quiet", "discussion", role, "quiet", Date.parse(midnight) + 12 * 60_000);
    assert.equal(traces.list("1001", scope, "discussion", "quiet", first).length, 1);

    const day = stats.read(scope, "1", 7, now);
    assert.equal(day.timeZone, "Asia/Shanghai");
    assert.equal(day.start, first);
    assert.equal(day.end, end);
    assert.deepEqual(day.observed, { messages: 3, activeAccounts: 2, firstAt: first, lastAt: midnight });
    assert.equal(day.hours.length, 24);
    assert.deepEqual(day.hours.filter(hour => hour.messages), [{ hour: 0, messages: 1 }, { hour: 2, messages: 1 }, { hour: 23, messages: 1 }]);
    assert.deepEqual(day.reply, { eligibleMessages: 2, triggeredMessages: 1, firstAt: beforeMidnight, lastAt: midnight, start: first, rate: 0.5 });

    const week = stats.read(scope, "7", 1, now);
    assert.equal(week.observed.messages, 4);
    assert.equal(week.deliveries.sent, 2);
    assert.equal(week.reply.eligibleMessages, day.reply.eligibleMessages);
    assert.equal(stats.read(otherAccount, "1", 7, now).reply.rate, 0);
    assert.equal(stats.read(otherGroup, "1", 7, now).reply.rate, null);
    assert.deepEqual(stats.read("qq:1001:5003", "1", 7, now).observed, { messages: 0, activeAccounts: 0, firstAt: null, lastAt: null });

    stats.prune(midnight);
    assert.equal(stats.read(scope, "7", 7, now).reply.eligibleMessages, 1);
    assert.equal(stats.read(scope, "7", 7, now).observed.messages, 4);
  } finally { db.close(); }
});

test("group reply activity separates complete, partial and unknown deliveries from policy blocks", t => {
  const { db } = openStore(":memory:");
  t.after(() => db.close());
  const scope = "qq:1001:5001";
  const now = Date.parse("2026-11-24T12:00:00.000Z");
  const tick = 60_000;
  t.mock.timers.enable({ apis: ["Date"], now: now - 5 * tick });
  const traces = openGroupReplyTraces(db);
  const stats = openGroupStatistics(db);
  const role = { id: "test", name: "测试", version: "1.0.0", revision: "a".repeat(64) };
  const outbox = db.prepare("INSERT INTO outbox(scope,event_id,created_at,status,content) VALUES (?,?,?,?,'fixture message')");
  let sequence = 0;
  function add(target: string, trigger: GroupReplyTrigger, state: TraceState | "running", reason: string,
      first?: "sent" | "failed" | "sending", second?: "sent" | "failed" | "unknown" | "missing") {
    const event = `event-${++sequence}`;
    const id = traces.begin(target, event, trigger, role);
    if (first) {
      traces.planDelivery(id, event, second ? `${event}:part2` : null);
      outbox.run(target, event, new Date().toISOString(), first);
      if (second && second !== "missing") outbox.run(target, `${event}:part2`, new Date().toISOString(), second);
    }
    if (state !== "running") traces.finish(id, state, reason);
  }
  add(scope, "mention", "finished", "reply", "sent", "sent");
  add(scope, "mention", "interrupted", "connection", "sent", "missing");
  add(scope, "mention", "finished", "reply", "sent", "unknown");
  add(scope, "mention", "finished", "reply", "failed");
  add(scope, "mention", "skipped", "paused");
  add(scope, "follow-up", "preview", "preview");
  add(scope, "follow-up", "finished", "sent", "sent");
  add(scope, "discussion", "skipped", "silence");
  add(scope, "discussion", "running", "");
  traces.gated(scope, "cooldown-1", "discussion", role, "cooldown", now - 7 * tick);
  traces.gated(scope, "cooldown-2", "discussion", role, "cooldown", now - 4 * tick);
  traces.gated(scope, "quiet", "opening", role, "quiet", now - 4 * tick);
  add("qq:1002:5001", "mention", "finished", "reply", "sent");
  add("qq:1001:5002", "discussion", "finished", "sent", "sent");
  t.mock.timers.setTime(now - 48 * 60 * tick);
  add(scope, "opening", "finished", "sent", "sent");
  t.mock.timers.setTime(now);
  add(scope, "quote", "finished", "sent", "sent");

  const day = stats.read(scope, "1", 7, now);
  assert.deepEqual(day.replyActivity.turns, [
    { trigger: "mention", entered: 4, delivered: 1, partial: 1, pending: 1, withheld: 0, undelivered: 1 },
    { trigger: "follow-up", entered: 2, delivered: 1, partial: 0, pending: 0, withheld: 1, undelivered: 0 },
    { trigger: "discussion", entered: 2, delivered: 0, partial: 0, pending: 1, withheld: 1, undelivered: 0 },
  ]);
  assert.deepEqual(day.replyActivity.blockers, [
    { trigger: "discussion", reason: "gate:cooldown", count: 1 },
    { trigger: "mention", reason: "paused", count: 1 },
    { trigger: "opening", reason: "gate:quiet", count: 1 },
  ]);
  assert.deepEqual(stats.read(scope, "7", 1, now).replyActivity, day.replyActivity);
  assert.equal(stats.read(scope, "7", 7, now).replyActivity.turns.at(-1)?.trigger, "opening");
  assert.deepEqual(stats.read("qq:1001:5003", "1", 7, now).replyActivity.turns, []);
});

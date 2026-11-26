import assert from "node:assert/strict";
import test from "node:test";
import { openGroupReviewSchedule, readGroupReviewSchedule } from "../runtime/group-review-schedule.js";
import { openStore } from "../runtime/store.js";

const a = "qq:1001:5001";
const b = "qq:1001:5002";
const day = 86_400_000;
const hour = day / 24;
const input = { enabled: true, localTime: "08:00", timeZone: "UTC" };

test("daily review retains one record per slot, catches up only within its window and respects scope policy", () => {
  const { db } = openStore(":memory:");
  try {
    const schedule = openGroupReviewSchedule(db);
    const at = Date.parse("2026-11-25T08:00:00Z");
    assert.equal(schedule.hasActive(), false);
    assert.equal(schedule.save(a, 0, input, at - hour), true);
    assert.equal(schedule.save(b, 0, input, at - hour), true);
    assert.equal(schedule.save(a, 0, { ...input, localTime: "09:00" }, at - hour), false);
    assert.equal(schedule.read(a).plan.nextAt, at);
    assert.equal(schedule.save(a, 1, input, at - 60_000), true);
    const trace: Array<[string, number]> = [];
    const provide = (scope: string, slot: number) => {
      trace.push([scope, slot]);
      return scope === a ? { itemCount: 3, pendingCount: 2 } : undefined;
    };
    schedule.process(at - 1, provide);
    assert.deepEqual(trace, []);
    schedule.process(at, provide);
    schedule.process(at, provide);
    assert.deepEqual(trace, [[a, at], [b, at]]);
    assert.deepEqual({ ...schedule.latest(a) }, { dueAt: at, recordedAt: at, timeZone: "UTC", state: "ready", itemCount: 3, pendingCount: 2 });
    assert.equal(schedule.latest(b), undefined);
    assert.equal(schedule.read(b).runs[0].state, "policy");

    const recovered = openGroupReviewSchedule(db);
    const catchUp = at + 3 * day + 5 * hour;
    recovered.process(catchUp, provide);
    assert.equal(recovered.latest(a)?.dueAt, at + 3 * day);
    assert.equal(recovered.read(a).runs.length, 2);
    assert.equal(recovered.read(a).plan.nextAt, at + 4 * day);
    recovered.process(at + 4 * day + 7 * hour, provide);
    assert.equal(recovered.read(a).runs[0].state, "expired");
    assert.equal(recovered.latest(a)?.dueAt, at + 3 * day);
    assert.equal(recovered.save(a, 1, { ...input, enabled: false }, at + 4 * day + 7 * hour), true);
    assert.equal(recovered.latest(a), undefined);
    assert.equal(recovered.read(a).runs.length, 3);
    recovered.prune(at + 40 * day);
    assert.deepEqual(recovered.read(a).runs, []);
  } finally { db.close(); }
});

test("daily review schedules preserve wall clock time across daylight-saving changes", () => {
  const { db } = openStore(":memory:");
  try {
    const schedule = openGroupReviewSchedule(db);
    assert.equal(readGroupReviewSchedule({ ...input, localTime: "24:00" }), undefined);
    assert.equal(readGroupReviewSchedule({ ...input, timeZone: "local zone" }), undefined);
    const plan = readGroupReviewSchedule({ enabled: true, localTime: "08:00", timeZone: "America/New_York" });
    assert.ok(plan);
    assert.equal(schedule.save(a, 0, plan, Date.parse("2026-10-31T10:00:00Z")), true);
    assert.equal(schedule.read(a).plan.nextAt, Date.parse("2026-10-31T12:00:00Z"));
    schedule.process(Date.parse("2026-10-31T12:00:00Z"), () => ({ itemCount: 0, pendingCount: 0 }));
    assert.equal(schedule.latest(a)?.state, "empty");
    assert.equal(schedule.read(a).plan.nextAt, Date.parse("2026-11-01T13:00:00Z"));
  } finally { db.close(); }
});

test("a failed scope can finish its slot without stalling another scheduled review", () => {
  const { db } = openStore(":memory:");
  try {
    const schedule = openGroupReviewSchedule(db);
    const slot = Date.parse("2026-11-25T08:00:00Z");
    schedule.save(a, 0, input, slot - hour);
    schedule.save(b, 0, input, slot - hour);
    schedule.process(slot, scope => {
      if (scope === a) throw new Error("corrupt fixture");
      return { itemCount: 2, pendingCount: 1 };
    });
    assert.equal(schedule.read(a).runs[0].state, "failed");
    assert.equal(schedule.latest(b)?.pendingCount, 1);
  } finally { db.close(); }
});

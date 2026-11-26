import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { moodExpression } from "../runtime/companion-state.js";
import { openCompanionStore } from "../runtime/companion-store.js";
import { readPersonality } from "../runtime/personality.js";

test("companion interactions recover, deduplicate and preserve different relationships", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const time = Date.parse("2026-11-23T08:00:00.000Z");
    const store = openCompanionStore(db);
    const scope = { scope: "qq:1001:5001", roleId: "test.role", subject: "1002",
      profile: readPersonality({ mood: { baseline: { joy: 60, curiosity: 45 }, recoveryMinutes: { joy: 10 } } }).mood };
    const sameGroup = { ...scope, subject: "1003" };
    const secondGroup = { ...scope, scope: "qq:1001:5002" };
    const secondRole = { ...scope, roleId: "test.another" };
    assert.equal(store.snapshot(scope, time).mood.joy, 60);
    assert.equal(store.record(scope, "pet", "first", time), true);
    assert.equal(store.record(scope, "pet", "second", time + 500), false);
    assert.equal(store.record(scope, "pet", "first", time + 60_000), false);
    const after = store.snapshot(scope, time);
    assert.equal(after.mood.joy, 78);
    assert.equal(moodExpression(after.mood), "bright");
    assert.equal(store.snapshot(sameGroup, time).mood.joy, 78);
    assert.equal(store.snapshot(secondGroup, time).mood.joy, 60);
    assert.equal(store.snapshot(secondRole, time).mood.joy, 60);
    assert.equal(openCompanionStore(db).snapshot(scope, time + 600_000).mood.joy, 69);
    for (const [event, minutes] of [["third", 11], ["fourth", 12]] as const) {
      store.record(scope, "conversation", event, time + minutes * 60_000);
    }
    assert.equal(store.snapshot(scope, time + 720_000).familiarity, "渐熟");
    assert.equal(store.snapshot(sameGroup, time + 720_000).familiarity, "初识");
    store.record(scope, "rest", "sleep", time + 720_000);
    assert.ok(store.snapshot(scope, time + 720_000).mood.joy >= 68);
    assert.equal(moodExpression(store.snapshot(scope, time + 720_000).mood), "quiet");
    store.reset(scope);
    assert.equal(store.snapshot(scope, time + 720_000).mood.joy, 60);
    assert.equal(store.snapshot(scope, time + 720_000).familiarity, "初识");
    assert.throws(() => readPersonality({ mood: { recoveryMinutes: { joy: 0 } } }), /5 到 1440/);
  } finally {
    db.close();
  }
});

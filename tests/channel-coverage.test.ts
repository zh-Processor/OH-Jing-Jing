import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openChannelCoverage } from "../runtime/channel-coverage";

test("coverage separates operational states and leaves observation gaps across stalls and restarts", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const start = Date.parse("2026-11-24T12:00:00.000Z");
  const at = (seconds: number) => start + seconds * 1000;
  const iso = (seconds: number) => new Date(at(seconds)).toISOString();
  const identity = "qq.onebot:1001";
  const first = openChannelCoverage(db, identity);
  first.sample("online", at(0));
  first.sample("online", at(10));
  first.sample("unavailable", at(14));
  first.sample("online", at(20));
  first.sample("online", at(30));
  first.sample("online", at(70));
  first.sample("disabled", at(79));
  first.sample("disabled", at(85));
  const resumed = openChannelCoverage(db, identity);
  resumed.sample("online", at(95));
  resumed.sample("unavailable", at(90));
  resumed.sample("online", at(100));
  assert.deepEqual(resumed.read(at(5), at(101)), {
    onlineMs: 33_000, unavailableMs: 6_000, disabledMs: 6_000, unobservedMs: 51_000,
    gaps: [{ state: "disabled", start: iso(79), end: iso(85) }, { state: "unavailable", start: iso(14), end: iso(20) }],
  });
  assert.deepEqual(resumed.read(at(16), at(17)).gaps, [{ state: "unavailable", start: iso(16), end: iso(17) }]);
  assert.equal(openChannelCoverage(db, "qq.onebot:1002").read(at(0), at(100)).unobservedMs, 100_000);
  resumed.prune(at(70));
  assert.equal(resumed.read(at(0), at(100)).unavailableMs, 0);
  assert.equal(resumed.read(at(0), at(100)).onlineMs, 14_000);
});

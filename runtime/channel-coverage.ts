import type { DatabaseSync } from "node:sqlite";

export const coverageSampleMs = 10_000;
const maxSampleGapMs = 3 * coverageSampleMs;
type ObservedState = "online" | "unavailable" | "disabled";
type Gap = { state: Exclude<ObservedState, "online">; start: string; end: string };
export type ChannelCoverageReport = {
  onlineMs: number; unavailableMs: number; disabledMs: number; unobservedMs: number; gaps: Gap[];
};

export function openChannelCoverage(db: DatabaseSync, identity: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS channel_coverage (
    id INTEGER PRIMARY KEY, identity TEXT NOT NULL, state TEXT NOT NULL,
    start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS channel_coverage_identity_end ON channel_coverage(identity,end_ms);`);
  const last = db.prepare("SELECT MAX(end_ms) AS time FROM channel_coverage WHERE identity=?");
  const begin = db.prepare("INSERT INTO channel_coverage(identity,state,start_ms,end_ms) VALUES(?,?,?,?)");
  const extend = db.prepare("UPDATE channel_coverage SET end_ms=? WHERE id=?");
  const prune = db.prepare("DELETE FROM channel_coverage WHERE end_ms<?");
  const window = "identity=$identity AND start_ms<$end AND end_ms>$start AND start_ms<end_ms";
  const totals = db.prepare(`SELECT state,SUM(MIN(end_ms,$end)-MAX(start_ms,$start)) AS ms
    FROM channel_coverage WHERE ${window} GROUP BY state`);
  const gaps = db.prepare(`SELECT state,MAX(start_ms,$start) AS start,MIN(end_ms,$end) AS end
    FROM channel_coverage WHERE ${window} AND state<>'online' ORDER BY end_ms DESC,id DESC LIMIT 10`);
  let lastAt = Number(last.get(identity)?.time ?? 0);
  let active: { id: number | bigint; state: ObservedState } | undefined;

  return {
    sample(state: ObservedState, now = Date.now()) {
      if (now < lastAt) return;
      if (active && now - lastAt <= maxSampleGapMs) {
        extend.run(now, active.id);
      } else {
        active = undefined;
      }
      if (!active || active.state !== state) {
        active = { id: begin.run(identity, state, now, now).lastInsertRowid, state };
      }
      lastAt = now;
    },
    prune(before: number) { prune.run(before); },
    read(start: number, end: number): ChannelCoverageReport {
      const params = { identity, start, end };
      const measured = new Map(totals.all(params).map(row => [row.state as ObservedState, Number(row.ms)]));
      const onlineMs = measured.get("online") ?? 0;
      const unavailableMs = measured.get("unavailable") ?? 0;
      const disabledMs = measured.get("disabled") ?? 0;
      return { onlineMs, unavailableMs, disabledMs, unobservedMs: Math.max(0, end - start - onlineMs - unavailableMs - disabledMs),
        gaps: gaps.all(params).map(row => ({ state: row.state as Gap["state"],
          start: new Date(Number(row.start)).toISOString(), end: new Date(Number(row.end)).toISOString() })) };
    },
  };
}

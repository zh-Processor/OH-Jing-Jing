import type { DatabaseSync } from "node:sqlite";
import { nextReminderOccurrence, reminderClock, reminderDay } from "./qq-private-reminder-time.js";

type Settings = { enabled: boolean; localTime: string; timeZone: string };
type Plan = Omit<Settings, "enabled"> & { scope: string; version: number; enabled: number; nextAt: number | null };
type Run = { dueAt: number; recordedAt: number; timeZone: string; state: "ready" | "empty" | "expired" | "policy" | "failed";
  itemCount: number; pendingCount: number };
const catchUp = 6 * 60 * 60_000;
const defaults = { enabled: false, localTime: "08:00", timeZone: "Asia/Shanghai", version: 0, nextAt: null };

export function readGroupReviewSchedule(value: unknown): Settings | undefined {
  if (!value || typeof value !== "object") return;
  const { enabled, localTime, timeZone } = value as Partial<Settings>;
  if (typeof enabled !== "boolean" || typeof localTime !== "string" || !reminderClock.test(localTime) ||
      typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return;
  try { new Intl.DateTimeFormat("zh-CN", { timeZone }); } catch { return undefined; }
  return { enabled, localTime, timeZone };
}

export function openGroupReviewSchedule(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS group_review_plans (
    scope TEXT PRIMARY KEY,version INTEGER NOT NULL,enabled INTEGER NOT NULL,
    local_time TEXT NOT NULL,time_zone TEXT NOT NULL,next_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS group_review_due ON group_review_plans(next_at) WHERE enabled=1;
  CREATE TABLE IF NOT EXISTS group_review_runs (
    scope TEXT NOT NULL,due_at INTEGER NOT NULL,recorded_at INTEGER NOT NULL,state TEXT NOT NULL,
    item_count INTEGER NOT NULL,pending_count INTEGER NOT NULL,time_zone TEXT NOT NULL,PRIMARY KEY(scope,due_at)
  );`);
  const fields = `scope,version,enabled,local_time AS localTime,time_zone AS timeZone,next_at AS nextAt`;
  const runFields = `due_at AS dueAt,recorded_at AS recordedAt,state,item_count AS itemCount,pending_count AS pendingCount,time_zone AS timeZone`;
  const get = db.prepare(`SELECT ${fields} FROM group_review_plans WHERE scope=?`);
  const put = db.prepare(`INSERT INTO group_review_plans VALUES(?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET
    version=excluded.version,enabled=excluded.enabled,local_time=excluded.local_time,time_zone=excluded.time_zone,
    next_at=excluded.next_at WHERE group_review_plans.version=excluded.version-1`);
  const due = db.prepare(`SELECT ${fields} FROM group_review_plans WHERE enabled=1 AND next_at<=? ORDER BY next_at,scope LIMIT 12`);
  const active = db.prepare("SELECT 1 FROM group_review_plans WHERE enabled=1 LIMIT 1");
  const advance = db.prepare(`UPDATE group_review_plans SET next_at=? WHERE scope=? AND enabled=1 AND version=? AND next_at=?`);
  const history = db.prepare(`SELECT ${runFields} FROM group_review_runs WHERE scope=? ORDER BY due_at DESC LIMIT 14`);
  const published = db.prepare(`SELECT ${runFields} FROM group_review_runs WHERE scope=? AND state IN ('ready','empty') ORDER BY due_at DESC LIMIT 1`);
  const record = db.prepare("INSERT OR IGNORE INTO group_review_runs VALUES(?,?,?,?,?,?,?)");
  const prune = db.prepare("DELETE FROM group_review_runs WHERE due_at<?");
  const planFor = (scope: string) => get.get(scope) as Plan | undefined;
  const next = (plan: Pick<Plan, "localTime" | "timeZone">, after: number) => nextReminderOccurrence({ ...plan, weekday: null }, after);

  return {
    save(scope: string, version: number, settings: Settings, now: number) {
      const previous = planFor(scope);
      if ((previous?.version ?? 0) !== version) return false;
      const enabled = Number(settings.enabled);
      if (previous && previous.enabled === enabled && previous.localTime === settings.localTime && previous.timeZone === settings.timeZone) return true;
      const nextAt = enabled ? next(settings, now) : null;
      return !!put.run(scope, version + 1, enabled, settings.localTime, settings.timeZone, nextAt).changes;
    },
    read(scope: string) {
      const plan = planFor(scope);
      return { plan: plan ? { version: plan.version, enabled: !!plan.enabled, localTime: plan.localTime, timeZone: plan.timeZone, nextAt: plan.nextAt } : defaults,
        runs: history.all(scope) as unknown as Run[] };
    },
    latest(scope: string) {
      return planFor(scope)?.enabled ? published.get(scope) as Run | undefined : undefined;
    },
    hasActive: () => !!active.get(),
    prune: (now: number) => prune.run(now - 30 * reminderDay),
    process(now: number, review: (scope: string, slot: number) => { itemCount: number; pendingCount: number } | undefined) {
      for (const plan of due.all(now) as unknown as (Plan & { nextAt: number })[]) {
        const recent = next(plan, now - catchUp - 1);
        const slot = plan.nextAt < now - catchUp && recent <= now ? recent : plan.nextAt;
        let counts: { itemCount: number; pendingCount: number } | undefined;
        let state: Run["state"] = "expired";
        if (slot >= now - catchUp) {
          try {
            counts = review(plan.scope, slot);
            state = !counts ? "policy" : counts.itemCount ? "ready" : "empty";
          } catch { state = "failed"; }
        }
        db.exec("SAVEPOINT group_review_run");
        try {
          if (advance.run(next(plan, now), plan.scope, plan.version, plan.nextAt).changes) {
            record.run(plan.scope, slot, now, state, counts?.itemCount ?? 0, counts?.pendingCount ?? 0, plan.timeZone);
          }
          db.exec("RELEASE group_review_run");
        } catch (error) {
          db.exec("ROLLBACK TO group_review_run; RELEASE group_review_run");
          throw error;
        }
      }
    },
  };
}

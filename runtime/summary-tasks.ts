import type { DatabaseSync } from "node:sqlite";
import { ProviderHttpError } from "./models.js";

type FailureKind = "timeout" | "authorization" | "quota" | "rate-limit" | "provider" | "empty" | "refused" | "format" | "interrupted" | "storage";
export type SummaryFailure = { kind: FailureKind; httpStatus?: number };
type SummaryTask = {
  scope: string; first_id: number; last_id: number; sample_count: number; attempts: number;
  state: "running" | "waiting" | "archived"; failure: FailureKind | null; http_status: number | null;
  updated_at: string; next_attempt_at: string | null;
};

export function summaryFailure(error: unknown, cancelled = false): SummaryFailure {
  if (cancelled) return { kind: "interrupted" };
  if (error instanceof ProviderHttpError) {
    const kind = error.status === 401 || error.status === 403 ? "authorization" : error.status === 402 ? "quota"
      : error.status === 408 ? "timeout" : error.status === 429 ? "rate-limit" : "provider";
    return { kind, httpStatus: error.status };
  }
  if (error instanceof Error && error.name === "TimeoutError") return { kind: "timeout" };
  return { kind: error instanceof SyntaxError ? "format" : "provider" };
}

export function summaryRetryDelay(attempt: number, failure: SummaryFailure) {
  const exponential = 60_000 * 2 ** Math.min(4, Math.max(0, attempt - 1));
  const minimum = failure.kind === "authorization" || failure.kind === "quota" ? 5 * 60_000
    : failure.kind === "rate-limit" ? 2 * 60_000 : 60_000;
  return Math.min(15 * 60_000, Math.max(exponential, minimum));
}

export function openSummaryTasks(db: DatabaseSync, now = Date.now()) {
  db.exec(`CREATE TABLE IF NOT EXISTS group_summary_tasks (
    scope TEXT PRIMARY KEY, first_id INTEGER NOT NULL, last_id INTEGER NOT NULL,
    sample_count INTEGER NOT NULL, attempts INTEGER NOT NULL,
    state TEXT NOT NULL, failure TEXT, http_status INTEGER, updated_at TEXT NOT NULL, next_attempt_at TEXT
  )`);
  const find = db.prepare("SELECT * FROM group_summary_tasks WHERE scope=?");
  const start = db.prepare(`INSERT INTO group_summary_tasks VALUES (?,?,?,?,?,'running',NULL,NULL,?,NULL)
    ON CONFLICT(scope) DO UPDATE SET first_id=excluded.first_id,last_id=excluded.last_id,sample_count=excluded.sample_count,
      attempts=excluded.attempts,state='running',failure=NULL,http_status=NULL,updated_at=excluded.updated_at,next_attempt_at=NULL`);
  const fail = db.prepare(`UPDATE group_summary_tasks SET state='waiting',failure=?,http_status=?,updated_at=?,next_attempt_at=?
    WHERE scope=? AND state='running'`);
  const finish = db.prepare(`UPDATE group_summary_tasks SET state='archived',failure=NULL,http_status=NULL,updated_at=?,next_attempt_at=NULL
    WHERE scope=? AND state='running'`);
  const defer = db.prepare(`UPDATE group_summary_tasks SET next_attempt_at=? WHERE scope=? AND state='waiting'`);
  const forget = db.prepare("DELETE FROM group_summary_tasks WHERE scope=? AND state='waiting'");
  const task = (scope: string) => find.get(scope) as SummaryTask | undefined;

  function failed(scope: string, failure: SummaryFailure, at: number) {
    const current = task(scope);
    if (!current || current.state !== "running") return;
    fail.run(failure.kind, failure.httpStatus ?? null, new Date(at).toISOString(),
      new Date(at + summaryRetryDelay(current.attempts, failure)).toISOString(), scope);
  }

  for (const row of db.prepare("SELECT scope FROM group_summary_tasks WHERE state='running'").all()) {
    failed(String(row.scope), { kind: "interrupted" }, now);
  }

  return {
    task,
    begin(scope: string, first: number, last: number, count: number, at: number) {
      const previous = task(scope);
      const continuing = previous?.state === "waiting" && previous.first_id === first && previous.last_id === last && previous.sample_count === count;
      start.run(scope, first, last, count, continuing ? previous.attempts + 1 : 1, new Date(at).toISOString());
    },
    failed,
    archived(scope: string, timestamp: string) { finish.run(timestamp, scope); },
    clearWaiting(scope: string) { forget.run(scope); },
    retry(scope: string, at = Date.now()) { return defer.run(new Date(at).toISOString(), scope).changes === 1; },
    view(scope: string) {
      const item = task(scope);
      return item ? { state: item.state, attempts: item.attempts, sampleCount: item.sample_count, failure: item.failure,
        httpStatus: item.http_status, updatedAt: item.updated_at, nextAttemptAt: item.next_attempt_at } : null;
    },
  };
}

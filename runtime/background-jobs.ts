import type { DatabaseSync } from "node:sqlite";

export const backgroundKinds = ["summary", "profile", "proactive"] as const;
type BackgroundKind = typeof backgroundKinds[number];
type JobState = "succeeded" | "retry" | "cancelled" | "failed" | "skipped" | "preview" | "sent" | "unknown";
export type BackgroundOutcome = { state: JobState; reason: string; httpStatus?: number; resultId?: number };
type JobRow = {
  id: number; kind: BackgroundKind; scope: string; trigger: string; sources: string;
  state: JobState | "running" | "sending"; reason: string | null; httpStatus: number | null;
  startedAt: string; finishedAt: string | null; resultId: number | null; nextAttemptAt: string | null;
  requestId: number | null; modelName: string | null; modelStatus: string | null; modelDurationMs: number | null;
  inputTokens: number | null; outputTokens: number | null; estimatedCost: number | null; currency: string | null;
  deliveryStatus: string | null; platformMessageId: string | null;
};

export function openBackgroundJobs(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS background_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, scope TEXT NOT NULL, trigger TEXT NOT NULL,
    sources TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, http_status INTEGER, started_at TEXT NOT NULL,
    finished_at TEXT, delivery_event TEXT, result_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS background_jobs_scope_id ON background_jobs(scope, id DESC);
  CREATE INDEX IF NOT EXISTS background_jobs_kind_id ON background_jobs(kind, id DESC);`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS requests_background_job ON requests(background_job_id) WHERE background_job_id IS NOT NULL");
  // openStore already marks an interrupted outbox send as unknown. Never replay it.
  const recover = db.prepare(`UPDATE background_jobs SET state=CASE
    WHEN state='running' AND kind='summary' THEN 'retry'
    WHEN state='sending' THEN COALESCE((SELECT status FROM outbox
      WHERE outbox.scope=background_jobs.scope AND event_id=delivery_event), 'cancelled')
    ELSE 'cancelled' END, reason='restart', finished_at=? WHERE state IN ('running','sending')`);
  recover.run(new Date().toISOString());
  const insert = db.prepare(`INSERT INTO background_jobs(kind,scope,trigger,sources,state,started_at)
    VALUES (?,?,?,?,'running',?)`);
  const dispatch = db.prepare("UPDATE background_jobs SET state='sending',delivery_event=? WHERE id=? AND state='running'");
  const settle = db.prepare(`UPDATE background_jobs SET state=?,reason=?,http_status=?,result_id=?,finished_at=?
    WHERE id=? AND state IN ('running','sending')`);
  const active = new Map<number, AbortController>();
  const list = db.prepare(`SELECT j.id,j.kind,j.scope,j.trigger,j.sources,j.state,j.reason,j.http_status AS httpStatus,
    j.started_at AS startedAt,j.finished_at AS finishedAt,j.result_id AS resultId,
    r.id AS requestId,r.model_name AS modelName,r.status AS modelStatus,r.input_tokens AS inputTokens,
    r.output_tokens AS outputTokens,r.estimated_cost AS estimatedCost,r.currency,r.duration_ms AS modelDurationMs,
    o.status AS deliveryStatus,o.platform_message_id AS platformMessageId,
    CASE WHEN j.state='retry' AND j.id=(SELECT MAX(id) FROM background_jobs WHERE kind='summary' AND scope=j.scope)
      AND s.state='waiting' THEN s.next_attempt_at END AS nextAttemptAt
    FROM background_jobs j
    LEFT JOIN requests r ON r.background_job_id=j.id
    LEFT JOIN outbox o ON o.scope=j.scope AND o.event_id=j.delivery_event
    LEFT JOIN group_summary_tasks s ON j.kind='summary' AND s.scope=j.scope
    WHERE j.scope GLOB ? AND (? IS NULL OR j.scope=?) AND (? IS NULL OR j.kind=?)
    ORDER BY CASE WHEN j.state IN ('running','sending') THEN 0 ELSE 1 END,j.id DESC LIMIT 50`);
  const prune = db.prepare("DELETE FROM background_jobs WHERE finished_at < ?");

  return {
    begin(kind: BackgroundKind, scope: string, trigger: string, sources: string[], controller: AbortController) {
      const id = Number(insert.run(kind, scope, trigger, JSON.stringify(sources), new Date().toISOString()).lastInsertRowid);
      active.set(id, controller);
      return id;
    },
    sending(id: number, eventId: string) {
      dispatch.run(eventId, id);
      active.delete(id);
    },
    finish(id: number, outcome: BackgroundOutcome) {
      settle.run(outcome.state, outcome.reason, outcome.httpStatus ?? null, outcome.resultId ?? null, new Date().toISOString(), id);
      active.delete(id);
    },
    cancel(id: number) {
      const controller = active.get(id);
      if (!controller || controller.signal.aborted) return false;
      controller.abort("operator");
      return true;
    },
    list(accountId: string | undefined, scope: string | null, kind: string | null) {
      const rows = list.all(accountId ? `qq:${accountId}:*` : "qq:*", scope, scope, kind, kind) as unknown as JobRow[];
      return rows.map(row => ({ ...row, sources: JSON.parse(row.sources) as string[],
        cancellable: active.get(row.id)?.signal.aborted === false }));
    },
    prune(at: number) { prune.run(new Date(at).toISOString()); },
  };
}

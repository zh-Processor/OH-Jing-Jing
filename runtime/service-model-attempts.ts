import type { DatabaseSync } from "node:sqlite";
import type { TurnBackend } from "./harness-rollout.js";

export type ModelAttemptLinks = { backgroundJobId?: number; replyTraceId?: number };
export type ModelAttemptStage = "primary" | "backup" | "runtime-fallback" | "summary-review" | "tool-answer" | "tool-answer-backup" | "test";

export function openServiceModelAttempts(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_model_attempts (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
      background_job_id INTEGER, reply_trace_id INTEGER, stage TEXT NOT NULL,
      binding_id TEXT NOT NULL, provider_model_id TEXT NOT NULL, reason TEXT, http_status INTEGER
    );
    CREATE INDEX IF NOT EXISTS service_attempts_job ON service_model_attempts(background_job_id, request_id) WHERE background_job_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS service_attempts_trace ON service_model_attempts(reply_trace_id, request_id) WHERE reply_trace_id IS NOT NULL;
  `);
  if (!db.prepare("PRAGMA table_info(service_model_attempts)").all().some(row => row.name === "backend")) {
    db.exec("ALTER TABLE service_model_attempts ADD COLUMN backend TEXT");
  }
  const insert = db.prepare(`INSERT INTO service_model_attempts(request_id,background_job_id,reply_trace_id,stage,binding_id,provider_model_id)
    VALUES (?,?,?,?,?,?)`);
  const recordFailure = db.prepare("UPDATE service_model_attempts SET reason=?, http_status=? WHERE request_id=?");
  const recordBackend = db.prepare("UPDATE service_model_attempts SET backend=? WHERE request_id=?");
  const query = `SELECT r.id AS requestId, a.stage, a.binding_id AS bindingId, a.provider_model_id AS providerModelId,
    r.model_name AS modelName, r.status, a.reason, a.http_status AS httpStatus, r.duration_ms AS durationMs, a.backend,
    r.input_tokens AS inputTokens, r.output_tokens AS outputTokens, r.estimated_cost AS estimatedCost, r.currency
    FROM service_model_attempts a JOIN requests r ON r.id=a.request_id`;
  const byJob = db.prepare(`${query} WHERE a.background_job_id=? ORDER BY r.id`);
  const byTrace = db.prepare(`${query} WHERE a.reply_trace_id=? ORDER BY r.id`);
  const byRequest = db.prepare(`${query} WHERE r.id=?`);
  const visible = ({ backend, ...row }: ReturnType<typeof byRequest.all>[number]) => backend ? { ...row, backend } : row;

  return {
    begin(requestId: number | bigint, bindingId: string, providerModel: string, stage: ModelAttemptStage, links?: ModelAttemptLinks) {
      insert.run(requestId, links?.backgroundJobId ?? null, links?.replyTraceId ?? null, stage, bindingId, providerModel);
    },
    failure(requestId: number | bigint, reason: string, httpStatus?: number) {
      recordFailure.run(reason, httpStatus ?? null, requestId);
    },
    backend(requestId: number | bigint, backend: TurnBackend) { recordBackend.run(backend, requestId); },
    forJob(job: number) { return byJob.all(job).map(visible); },
    forTrace(trace: number) { return byTrace.all(trace).map(visible); },
    get(request: number | bigint) { const row = byRequest.get(request); return row && visible(row); },
  };
}

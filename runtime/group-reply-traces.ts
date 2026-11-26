import type { DatabaseSync } from "node:sqlite";
import type { DeliveryStatus, GroupDeliveryFormat } from "./im-channel.js";
import type { PublishedRoleInfo } from "./published-role.js";
import type { TurnDiagnostics } from "./turn.js";

export const groupReplyTriggers = ["mention", "name", "quote", "follow-up", "discussion", "opening"] as const;
export type GroupReplyTrigger = typeof groupReplyTriggers[number];
export type TraceState = "finished" | "skipped" | "preview" | "interrupted" | "failed";
type ReceiptState = DeliveryStatus | "sending";
type TraceRow = {
  id: number; scope: string; eventId: string; trigger: GroupReplyTrigger;
  roleId: string; roleName: string; roleVersion: string; roleRevision: string;
  startedAt: string; endedAt: string | null; state: TraceState | "running"; reason: string | null;
  requestId: number | null; modelProfileId: string | null; modelName: string | null; providerModelId: string | null;
  modelStatus: string | null; modelDurationMs: number | null; inputTokens: number | null; outputTokens: number | null;
  estimatedCost: number | null; currency: string | null;
  firstDelivery: string | null; secondDelivery: string | null;
  firstStatus: ReceiptState | null; firstPlatformId: string | null; firstFormat: GroupDeliveryFormat | null;
  secondStatus: ReceiptState | null; secondPlatformId: string | null; secondFormat: GroupDeliveryFormat | null;
  contextJson: string | null;
};

export function openGroupReplyTraces(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_reply_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, event_id TEXT NOT NULL, trigger TEXT NOT NULL,
      role_id TEXT NOT NULL, role_name TEXT NOT NULL, role_version TEXT NOT NULL, role_revision TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, state TEXT NOT NULL, reason TEXT,
      request_id INTEGER, provider_model_id TEXT, first_delivery TEXT, second_delivery TEXT
    );
    CREATE INDEX IF NOT EXISTS group_reply_traces_scope_id ON group_reply_traces(scope, id DESC);
    CREATE INDEX IF NOT EXISTS group_reply_traces_event ON group_reply_traces(event_id, id DESC);
    CREATE INDEX IF NOT EXISTS group_reply_traces_time ON group_reply_traces(started_at);
    CREATE INDEX IF NOT EXISTS group_reply_traces_scope_time ON group_reply_traces(scope, started_at);
    CREATE INDEX IF NOT EXISTS group_reply_traces_first_delivery ON group_reply_traces(scope, first_delivery) WHERE first_delivery IS NOT NULL;
    CREATE INDEX IF NOT EXISTS group_reply_traces_second_delivery ON group_reply_traces(scope, second_delivery) WHERE second_delivery IS NOT NULL;
  `);
  if (!db.prepare("PRAGMA table_info(group_reply_traces)").all().some(column => column.name === "context_json")) {
    db.exec("ALTER TABLE group_reply_traces ADD COLUMN context_json TEXT");
  }
  db.prepare("UPDATE group_reply_traces SET state='interrupted', reason='restart', ended_at=? WHERE state='running'")
    .run(new Date().toISOString());
  const insert = db.prepare(`INSERT INTO group_reply_traces(scope,event_id,trigger,role_id,role_name,role_version,role_revision,started_at,state)
    VALUES (?,?,?,?,?,?,?,?,'running')`);
  const insertGate = db.prepare(`INSERT INTO group_reply_traces(scope,event_id,trigger,role_id,role_name,role_version,role_revision,
    started_at,ended_at,state,reason)
    SELECT ?,?,?,?,?,?,?,?,?,'skipped',? WHERE NOT EXISTS (
      SELECT 1 FROM group_reply_traces WHERE scope=? AND trigger=? AND reason=? AND (event_id=? OR started_at>=?)
    )`);
  const link = db.prepare("UPDATE group_reply_traces SET request_id=?, provider_model_id=? WHERE id=?");
  const unlink = db.prepare("UPDATE group_reply_traces SET request_id=NULL, provider_model_id=NULL WHERE id=? AND request_id=?");
  const recordContext = db.prepare("UPDATE group_reply_traces SET context_json=? WHERE id=?");
  const plan = db.prepare("UPDATE group_reply_traces SET first_delivery=?, second_delivery=? WHERE id=?");
  const settle = db.prepare("UPDATE group_reply_traces SET state=?,reason=?,ended_at=? WHERE id=? AND state='running'");
  const prune = db.prepare("DELETE FROM group_reply_traces WHERE started_at < ? AND state <> 'running'");
  const quotedTurn = db.prepare(`SELECT t.event_id AS eventId, other.content AS otherText,
    CASE WHEN t.first_delivery = $delivery THEN 'after' ELSE 'before' END AS otherPosition
    FROM group_reply_traces t
    LEFT JOIN outbox other ON other.scope = t.scope AND other.event_id =
      CASE WHEN t.first_delivery = $delivery THEN t.second_delivery ELSE t.first_delivery END
      AND other.status = 'sent' AND other.created_at >= $messageCutoff
    WHERE t.scope = $scope AND (t.first_delivery = $delivery OR t.second_delivery = $delivery)
      AND t.trigger IN ('mention','name','quote','follow-up') AND t.started_at >= $traceCutoff
    ORDER BY t.id DESC LIMIT 1`);
  const list = db.prepare(`SELECT t.id,t.scope,t.event_id AS eventId,t.trigger,
    t.role_id AS roleId,t.role_name AS roleName,t.role_version AS roleVersion,t.role_revision AS roleRevision,
    t.started_at AS startedAt,t.ended_at AS endedAt,t.state,t.reason,t.context_json AS contextJson,
    r.id AS requestId,r.model_id AS modelProfileId,r.model_name AS modelName,t.provider_model_id AS providerModelId,
    r.status AS modelStatus,r.duration_ms AS modelDurationMs,r.input_tokens AS inputTokens,r.output_tokens AS outputTokens,
    r.estimated_cost AS estimatedCost,r.currency,
    t.first_delivery AS firstDelivery,t.second_delivery AS secondDelivery,
    first.status AS firstStatus,first.platform_message_id AS firstPlatformId,first.delivery_format AS firstFormat,
    second.status AS secondStatus,second.platform_message_id AS secondPlatformId,second.delivery_format AS secondFormat
    FROM group_reply_traces t
    LEFT JOIN requests r ON r.id=t.request_id
    LEFT JOIN outbox first ON first.scope=t.scope AND first.event_id=t.first_delivery
    LEFT JOIN outbox second ON second.scope=t.scope AND second.event_id=t.second_delivery
    WHERE t.scope GLOB ? AND (? IS NULL OR t.scope=?) AND (? IS NULL OR t.trigger=?)
      AND (? IS NULL OR t.event_id=?) AND t.started_at >= ?
    ORDER BY t.id DESC LIMIT 50`);

  return {
    begin(scope: string, eventId: string, trigger: GroupReplyTrigger, role: PublishedRoleInfo) {
      return Number(insert.run(scope, eventId, trigger, role.id, role.name, role.version, role.revision, new Date().toISOString()).lastInsertRowid);
    },
    gated(scope: string, eventId: string, trigger: GroupReplyTrigger, role: PublishedRoleInfo, reason: string, now: number) {
      const time = new Date(now).toISOString();
      const recent = new Date(now - 5 * 60_000).toISOString();
      const code = `gate:${reason}`;
      insertGate.run(scope, eventId, trigger, role.id, role.name, role.version, role.revision, time, time, code,
        scope, trigger, code, eventId, recent);
    },
    request(id: number, requestId: number | bigint, model: string) { link.run(requestId, model, id); },
    clearRequest(id: number, requestId: number | bigint) { unlink.run(id, requestId); },
    context(id: number, diagnostics: TurnDiagnostics, began: number) {
      recordContext.run(JSON.stringify({ ...diagnostics, durationMs: Math.round(performance.now() - began) }), id);
    },
    planDelivery(id: number, first: string, second: string | null = null) { plan.run(first, second, id); },
    finish(id: number, state: TraceState, reason: string) { settle.run(state, reason, new Date().toISOString(), id); },
    quotedTurn(scope: string, delivery: string, messageCutoff: string, traceCutoff: string) {
      return quotedTurn.get({ scope, delivery, messageCutoff, traceCutoff }) as
        { eventId: string; otherText: string | null; otherPosition: "before" | "after" } | undefined;
    },
    list(account: string | undefined, scope: string | null, trigger: string | null, eventId: string | null, since: string) {
      const rows = list.all(account ? `qq:${account}:*` : "qq:*", scope, scope, trigger, trigger, eventId, eventId, since) as unknown as TraceRow[];
      return rows.map(row => {
        const { firstDelivery, secondDelivery, firstStatus, secondStatus, firstPlatformId, secondPlatformId, firstFormat, secondFormat,
          contextJson, ...trace } = row;
        const receipts = [
          { delivery: firstDelivery, status: firstStatus, platformMessageId: firstPlatformId, format: firstFormat },
          { delivery: secondDelivery, status: secondStatus, platformMessageId: secondPlatformId, format: secondFormat },
        ].flatMap(({ delivery, status, platformMessageId, format }, index) => delivery === null ? [] : [
          { part: index + 1, status: status ?? (row.state === "running" ? "pending" : "not-attempted"), platformMessageId, ...(format ? { format } : {}) },
        ]);
        return { ...trace, receipts, ...(contextJson ? { context: JSON.parse(contextJson) as TurnDiagnostics & { durationMs: number } } : {}) };
      });
    },
    prune(since: string) { prune.run(since); },
  };
}

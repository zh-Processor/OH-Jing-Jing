import { createHash } from "node:crypto";
import type { SelfAccountUpdate } from "./qq-channel.js";
import type { SpaceDraftPlan } from "./qq-space-draft.js";
import type { openStore } from "./store.js";

export type AccountScheduleTime = { dueAt: number; expiresAt: number | null };
type Hold = "gateway" | "permission" | "cooldown" | "busy" | "budget" | "model";
type State = "queued" | "generation-queued" | "diary-queued" | "finished" | "cancelled" | "expired";
type Generation = "waiting" | "running" | "ready" | "skipped" | "failed" | "interrupted";
type ScheduleUpdate = SelfAccountUpdate | SpaceDraftPlan;
type Row = {
  id: string; account_id: string; kind: SelfAccountUpdate["kind"]; due_at: number; expires_at: number | null;
  state: State; hold: Hold | null; payload: string | null; fingerprint: string;
  generation_state: Generation | null; generation_reason: string | null; role_revision: string | null; generated_text: string | null;
};
const pendingStates = "('queued','generation-queued','diary-queued')";
const draftStates = "('generation-queued','diary-queued')";

export const accountOperationId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function readAccountSchedule(input: unknown): AccountScheduleTime {
  const data = input as Partial<AccountScheduleTime> | null;
  if (typeof data?.dueAt !== "number" || !Number.isSafeInteger(data.dueAt) || data.dueAt < 1 || data.dueAt > 8.64e15 ||
      (data.expiresAt !== undefined && data.expiresAt !== null &&
        (!Number.isSafeInteger(data.expiresAt) || data.expiresAt <= data.dueAt || data.expiresAt > 8.64e15))) {
    throw new Error("请填写执行时间，截止时间需晚于执行时间。");
  }
  return { dueAt: data.dueAt, expiresAt: data.expiresAt ?? null };
}

export function openQqAccountSchedules(store: ReturnType<typeof openStore>) {
  const { db } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS qq_account_schedules (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, due_at INTEGER NOT NULL,
    expires_at INTEGER, state TEXT NOT NULL, hold TEXT, payload TEXT, fingerprint TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS qq_account_schedules_queued ON qq_account_schedules(due_at,id) WHERE state='queued';
  CREATE INDEX IF NOT EXISTS qq_account_schedules_history ON qq_account_schedules(account_id,due_at DESC,id);`);
  const columns = new Set(db.prepare("PRAGMA table_info(qq_account_schedules)").all().map(row => row.name));
  for (const column of ["generation_state", "generation_reason", "role_revision", "generated_text"]) {
    if (!columns.has(column)) db.exec(`ALTER TABLE qq_account_schedules ADD COLUMN ${column} TEXT`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS qq_account_schedules_generation ON qq_account_schedules(due_at,id) WHERE state='generation-queued'");
  db.exec("CREATE INDEX IF NOT EXISTS qq_account_schedules_diary ON qq_account_schedules(due_at,id) WHERE state='diary-queued'");
  const lookup = db.prepare("SELECT * FROM qq_account_schedules WHERE id=?");
  const insert = db.prepare(`INSERT INTO qq_account_schedules(id,account_id,kind,due_at,expires_at,state,payload,fingerprint,generation_state)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const queued = db.prepare(`SELECT * FROM qq_account_schedules WHERE state IN ${pendingStates} AND due_at<=? ORDER BY due_at,id`);
  const hasPending = db.prepare(`SELECT 1 FROM qq_account_schedules WHERE state IN ${pendingStates} LIMIT 1`);
  const activeForAccount = db.prepare(`SELECT * FROM qq_account_schedules WHERE account_id=? AND state IN ${pendingStates} ORDER BY due_at,id`);
  const historyForAccount = db.prepare(`SELECT * FROM qq_account_schedules WHERE account_id=? AND state NOT IN ${pendingStates} ORDER BY due_at DESC,id LIMIT 20`);
  const changeHold = db.prepare(`UPDATE qq_account_schedules SET hold=? WHERE id=? AND state IN ${pendingStates} AND hold IS NOT ?`);
  const end = db.prepare(`UPDATE qq_account_schedules SET state=?,hold=NULL,payload=NULL,generated_text=NULL,
    generation_state=CASE WHEN generation_state='running' THEN 'interrupted' ELSE generation_state END
    WHERE id=? AND state IN ${pendingStates}`);
  const expire = db.prepare(`UPDATE qq_account_schedules SET state='expired',hold=NULL,payload=NULL,generated_text=NULL
    WHERE state IN ${pendingStates} AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM qq_account_actions WHERE id=qq_account_schedules.id)`);
  const beginDraft = db.prepare(`UPDATE qq_account_schedules SET generation_state='running',role_revision=?,hold=NULL
    WHERE id=? AND state IN ${draftStates} AND generation_state='waiting'`);
  const readyDraft = db.prepare(`UPDATE qq_account_schedules SET generation_state='ready',generated_text=?
    WHERE id=? AND state IN ${draftStates} AND generation_state='running'`);
  const endDraft = db.prepare(`UPDATE qq_account_schedules SET state=?,generation_state=?,generation_reason=?,hold=NULL,payload=NULL
    WHERE id=? AND state IN ${draftStates} AND generation_state='running'`);
  // An operation already reserved before shutdown has its own persisted receipt and is never sent again.
  db.prepare(`UPDATE qq_account_schedules SET state='finished',hold=NULL,payload=NULL,generated_text=NULL WHERE state IN ${pendingStates}
    AND EXISTS(SELECT 1 FROM qq_account_actions WHERE id=qq_account_schedules.id)`).run();
  db.prepare(`UPDATE qq_account_schedules SET state='finished',generation_state='interrupted',generation_reason='restart',
    hold=NULL,payload=NULL WHERE state IN ${draftStates} AND generation_state='running'`).run();

  const get = (id: string) => lookup.get(id) as Row | undefined;
  const publicPlan = (row: Row) => ({ id: row.id, kind: row.kind, dueAt: row.due_at, expiresAt: row.expires_at,
    state: row.state === "generation-queued" || row.state === "diary-queued" ? "queued" : row.state, hold: row.hold,
    update: row.payload ? JSON.parse(row.payload) as ScheduleUpdate : null,
    generation: row.generation_state ? { state: row.generation_state, reason: row.generation_reason,
      roleRevision: row.role_revision, content: row.generated_text } : undefined });
  return {
    get,
    list(accountId: string) {
      return [...activeForAccount.all(accountId), ...historyForAccount.all(accountId)].map(row => publicPlan(row as unknown as Row));
    },
    pending() { return !!hasPending.get(); },
    due(now: number) {
      expire.run(now);
      return (queued.all(now) as unknown as Row[]).map(row => ({ ...row, update: JSON.parse(row.payload!) as ScheduleUpdate }));
    },
    create(id: string, accountId: string, update: ScheduleUpdate, time: AccountScheduleTime, now = Date.now()) {
      const payload = JSON.stringify(update);
      const fingerprint = createHash("sha256").update(JSON.stringify([accountId, payload, time])).digest("hex");
      const before = get(id);
      if (before) return before.fingerprint === fingerprint
        ? { plan: publicPlan(before) } : { error: "预约编号已用于其他内容。" };
      if (time.dueAt < now || (time.expiresAt !== null && time.expiresAt <= now)) {
        return { error: "请选择未来的执行时间。" };
      }
      // Diary rows require source checks, which earlier server releases do not have.
      const state = "mode" in update ? update.diary ? "diary-queued" : "generation-queued" : "queued";
      insert.run(id, accountId, update.kind, time.dueAt, time.expiresAt, state,
        payload, fingerprint, state === "queued" ? null : "waiting");
      return { plan: publicPlan(get(id)!) };
    },
    beginDraft(id: string, roleRevision: string) { return !!beginDraft.run(roleRevision, id).changes; },
    readyDraft(id: string, text: string) { return !!readyDraft.run(text, id).changes; },
    endDraft(id: string, outcome: "skipped" | "failed" | "interrupted", reason: string, expired = false) {
      endDraft.run(expired ? "expired" : "finished", outcome, reason, id);
    },
    hold(id: string, reason: Hold) { changeHold.run(reason, id, reason); },
    finish(id: string) { end.run("finished", id); },
    cancel(id: string) { return !!end.run("cancelled", id).changes; },
  };
}

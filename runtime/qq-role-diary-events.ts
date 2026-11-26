import { createHash } from "node:crypto";
import type { openStore } from "./store.js";

export type RoleDiarySource = "operator" | "role-change" | "account-update";
type State = "queued" | "running" | "written" | "skipped" | "failed" | "interrupted" | "revoked";
type Row = { id: number; account_id: string; role_id: string; source: RoleDiarySource; text: string | null;
  state: State; reason: string | null; diary_id: number | null; role_revision: string | null; created_at: string };
type Settings = { version: number; enabled: boolean; roleChanges: boolean; accountUpdates: boolean };
const defaults: Settings = { version: 0, enabled: false, roleChanges: false, accountUpdates: false };
const prefsKey = (accountId: string) => `roleDiaryWriter:${accountId}`;

export function readDiaryWriter(input: unknown): Omit<Settings, "version"> {
  const data = input as Partial<Settings> | null;
  if (typeof data?.enabled !== "boolean" || typeof data.roleChanges !== "boolean" || typeof data.accountUpdates !== "boolean") {
    throw new Error("请填写日记撰写和事件来源开关。");
  }
  return { enabled: data.enabled, roleChanges: data.roleChanges, accountUpdates: data.accountUpdates };
}

export function openQqRoleDiaryEvents(store: ReturnType<typeof openStore>) {
  const { db } = store;
  db.exec(`
    CREATE TABLE IF NOT EXISTS qq_role_diary_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, role_id TEXT NOT NULL, source TEXT NOT NULL,
      source_key TEXT NOT NULL, fingerprint TEXT NOT NULL, text TEXT, state TEXT NOT NULL, reason TEXT, diary_id INTEGER,
      role_revision TEXT, created_at TEXT NOT NULL, UNIQUE(account_id,role_id,source,source_key)
    );
    CREATE INDEX IF NOT EXISTS qq_role_diary_events_ready ON qq_role_diary_events(role_id,account_id,id) WHERE state='queued';
    CREATE INDEX IF NOT EXISTS qq_role_diary_events_roles ON qq_role_diary_events(account_id,role_id,id DESC);
    CREATE INDEX IF NOT EXISTS qq_role_diary_revoked_entries ON qq_role_diary_events(diary_id) WHERE state='revoked';
  `);
  db.prepare(`UPDATE qq_role_diary_events SET state='interrupted',reason='restart' WHERE state='running'`).run();
  const byId = db.prepare("SELECT * FROM qq_role_diary_events WHERE id=?");
  const get = (id: number) => byId.get(id) as Row | undefined;
  const known = db.prepare("SELECT id,fingerprint FROM qq_role_diary_events WHERE account_id=? AND role_id=? AND source=? AND source_key=?");
  const enqueue = db.prepare(`INSERT INTO qq_role_diary_events(account_id,role_id,source,source_key,fingerprint,text,state,created_at)
    VALUES(?,?,?,?,?,?,'queued',?)`);
  const next = db.prepare("SELECT * FROM qq_role_diary_events WHERE role_id=? AND state='queued' ORDER BY id");
  const nextForAccount = db.prepare("SELECT * FROM qq_role_diary_events WHERE role_id=? AND account_id=? AND state='queued' ORDER BY id");
  const history = db.prepare(`SELECT * FROM qq_role_diary_events WHERE account_id=? AND role_id=?
    ORDER BY CASE WHEN state IN ('queued','running') THEN 0 ELSE 1 END,id DESC`);
  const begin = db.prepare("UPDATE qq_role_diary_events SET state='running',reason=NULL,role_revision=? WHERE id=? AND state='queued'");
  const hold = db.prepare("UPDATE qq_role_diary_events SET reason=? WHERE id=? AND state='queued' AND reason IS NOT ?");
  const finish = db.prepare("UPDATE qq_role_diary_events SET state=?,reason=?,diary_id=? WHERE id=? AND state='running'");
  const revoke = db.prepare(`UPDATE qq_role_diary_events SET state='revoked',reason=NULL,text=NULL WHERE id=? AND state<>'revoked'`);
  const revokedEntry = db.prepare("SELECT 1 FROM qq_role_diary_events WHERE diary_id=? AND state='revoked'");
  const settings = (accountId: string) => store.setting(prefsKey(accountId), defaults);
  function enabled(accountId: string, source: RoleDiarySource) {
    const policy = settings(accountId);
    return policy.enabled && (source === "operator" || (source === "role-change" ? policy.roleChanges : policy.accountUpdates));
  }
  return {
    enabled,
    save(accountId: string, expectedVersion: number, change: Omit<Settings, "version">) {
      const current = settings(accountId);
      if (current.version !== expectedVersion) return false;
      store.saveSetting(prefsKey(accountId), { ...change, version: current.version + 1 });
      return true;
    },
    read(accountId: string, roleId: string) {
      return { settings: settings(accountId), events: (history.all(accountId, roleId) as unknown as Row[]).map(row => ({
        id: row.id, source: row.source, text: row.text, state: row.state, reason: row.reason, diaryId: row.diary_id,
        roleRevision: row.role_revision, createdAt: row.created_at,
      })) };
    },
    enqueue(accountId: string, roleId: string, source: RoleDiarySource, key: string, input: string) {
      const fingerprint = createHash("sha256").update(input).digest("hex");
      const before = known.get(accountId, roleId, source, key);
      if (before) return before.fingerprint === fingerprint ? "existing" : "conflict";
      if (source !== "operator" && !enabled(accountId, source)) return "disabled";
      enqueue.run(accountId, roleId, source, key, fingerprint, input, new Date().toISOString());
      return "added";
    },
    next(roleId: string, accountId?: string) {
      const candidates = accountId ? nextForAccount.iterate(roleId, accountId) : next.iterate(roleId);
      for (const candidate of candidates) {
        const row = candidate as unknown as Row;
        if (row.text !== null && enabled(row.account_id, row.source)) return { ...row, text: row.text };
      }
    },
    mayShare(diaryId: number) { return !revokedEntry.get(diaryId); },
    hold(id: number, reason: string) { hold.run(reason, id, reason); },
    begin(id: number, roleRevision: string) { return !!begin.run(roleRevision, id).changes; },
    finish(id: number, outcome: "skipped" | "failed" | "interrupted", reason: string) {
      finish.run(outcome, reason, null, id);
    },
    write(id: number, content: string, save: (accountId: string, roleId: string, content: string) => number) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = get(id);
        // Revoked or disabled input cannot become a new diary entry after a model response.
        if (row?.state === "running" && enabled(row.account_id, row.source)) {
          const diaryId = save(row.account_id, row.role_id, content);
          finish.run("written", null, diaryId, id);
          db.exec("COMMIT");
          return true;
        }
        db.exec("COMMIT");
        return false;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    revoke(accountId: string, roleId: string, id: number, unshare: (diaryId: number) => void) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = get(id);
        if (!row || row.account_id !== accountId || row.role_id !== roleId || row.state === "revoked") {
          db.exec("COMMIT");
          return false;
        }
        if (row.diary_id !== null) unshare(row.diary_id);
        revoke.run(id);
        db.exec("COMMIT");
        return true;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

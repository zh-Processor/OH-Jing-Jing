import { randomUUID } from "node:crypto";
import { isQqId } from "./qq-channel.js";
import type { openStore } from "./store.js";

const day = 86_400_000;
const minute = 60_000;
type Settings = {
  mode: "off" | "preview" | "enabled";
  targetIds: string[];
  comment: boolean;
  like: boolean;
  nextAt: number;
  intervalDays: number;
  windowMinutes: number;
};
type Rule = Settings & { version: number };
type Result = "no-post" | "model-skipped" | "invalid-output" | "model-failed" | "interrupted" |
  "permission" | "stale-post" | "busy" | "gateway" | "preview" | "submitted";
type Run = {
  id: string; account_id: string; version: number; role_revision: string;
  slot: number; expires_at: number; mode: Settings["mode"]; state: Result | "running";
  target_id: string | null; post_id: string | null; action: "comment" | "like" | null; preview_text: string | null;
};

export function readSpaceInteractionRule(input: unknown): Settings {
  const data = (input ?? {}) as Partial<Settings>;
  if ((data.mode !== "off" && data.mode !== "preview" && data.mode !== "enabled") ||
      !Array.isArray(data.targetIds) || data.targetIds.length > 5 || !data.targetIds.every(isQqId) ||
      typeof data.comment !== "boolean" || typeof data.like !== "boolean" ||
      (data.mode !== "off" && (!data.targetIds.length || (!data.comment && !data.like))) ||
      typeof data.nextAt !== "number" || !Number.isSafeInteger(data.nextAt) || data.nextAt < 1 || data.nextAt > 8e15 ||
      typeof data.intervalDays !== "number" || !Number.isSafeInteger(data.intervalDays) || data.intervalDays < 1 || data.intervalDays > 365 ||
      typeof data.windowMinutes !== "number" || !Number.isSafeInteger(data.windowMinutes) || data.windowMinutes < 1 || data.windowMinutes > 180) {
    throw new Error("请选择账号、互动方式及执行窗口，最多 5 个空间，间隔至少一天。");
  }
  return { mode: data.mode, targetIds: [...new Set(data.targetIds)], comment: data.comment, like: data.like,
    nextAt: data.nextAt, intervalDays: data.intervalDays, windowMinutes: data.windowMinutes };
}

export function openQqSpaceInteractions(store: ReturnType<typeof openStore>) {
  const { db } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS qq_space_interaction_rules (
    account_id TEXT PRIMARY KEY, version INTEGER NOT NULL, mode TEXT NOT NULL, next_at INTEGER NOT NULL, settings TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS qq_space_interaction_runs (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, version INTEGER NOT NULL, role_revision TEXT NOT NULL,
    slot INTEGER NOT NULL, expires_at INTEGER NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL,
    target_id TEXT, post_id TEXT, action TEXT, preview_text TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS qq_space_interaction_post
    ON qq_space_interaction_runs(account_id,mode,target_id,post_id) WHERE post_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS qq_space_interaction_history ON qq_space_interaction_runs(account_id,slot DESC);
  UPDATE qq_space_interaction_runs
    SET state=CASE WHEN EXISTS(SELECT 1 FROM qq_account_actions WHERE id=qq_space_interaction_runs.id)
      THEN 'submitted' ELSE 'interrupted' END WHERE state='running';`);
  const lookup = db.prepare("SELECT version,next_at,settings FROM qq_space_interaction_rules WHERE account_id=?");
  const save = db.prepare(`INSERT INTO qq_space_interaction_rules(account_id,version,mode,next_at,settings) VALUES(?,?,?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET version=excluded.version,mode=excluded.mode,next_at=excluded.next_at,settings=excluded.settings
    WHERE qq_space_interaction_rules.version=excluded.version-1`);
  const advance = db.prepare(`UPDATE qq_space_interaction_rules SET next_at=? WHERE account_id=? AND version=? AND next_at=?`);
  const insert = db.prepare(`INSERT INTO qq_space_interaction_runs(id,account_id,version,role_revision,slot,expires_at,mode,state)
    VALUES(?,?,?,?,?,?,?,'running')`);
  const known = db.prepare("SELECT 1 FROM qq_space_interaction_runs WHERE account_id=? AND mode=? AND target_id=? AND post_id=?");
  const bind = db.prepare("UPDATE OR IGNORE qq_space_interaction_runs SET target_id=?,post_id=? WHERE id=? AND state='running' AND post_id IS NULL");
  const finish = db.prepare("UPDATE qq_space_interaction_runs SET state=?,action=?,preview_text=? WHERE id=? AND state='running'");
  const history = db.prepare("SELECT * FROM qq_space_interaction_runs WHERE account_id=? ORDER BY slot DESC,id LIMIT 20");
  const next = db.prepare("SELECT account_id FROM qq_space_interaction_rules WHERE mode<>'off' AND next_at<=? ORDER BY next_at");
  const pending = db.prepare("SELECT 1 FROM qq_space_interaction_rules WHERE mode<>'off' LIMIT 1");
  const read = (accountId: string) => {
    const row = lookup.get(accountId) as { version: number; next_at: number; settings: string } | undefined;
    return row && { ...JSON.parse(row.settings) as Settings, version: row.version, nextAt: row.next_at };
  };

  return {
    read,
    pending() { return !!pending.get(); },
    due(now: number) { return next.all(now).map(row => String(row.account_id)); },
    history(accountId: string) { return (history.all(accountId) as unknown as Run[]).map(row => ({
      id: row.id, slot: row.slot, mode: row.mode, state: row.state, roleRevision: row.role_revision, ruleVersion: row.version,
      targetId: row.target_id, postId: row.post_id, action: row.action, previewText: row.preview_text,
    })); },
    save(accountId: string, expectedVersion: number, expectedNextAt: number | undefined, settings: Settings, now = Date.now()) {
      const old = read(accountId);
      if ((old?.version ?? 0) !== expectedVersion || (expectedNextAt !== undefined && old?.nextAt !== expectedNextAt)) return "conflict";
      if (settings.mode !== "off" && settings.nextAt <= now && settings.nextAt !== old?.nextAt) return "past";
      return save.run(accountId, expectedVersion + 1, settings.mode, settings.nextAt, JSON.stringify(settings)).changes ? "saved" : "conflict";
    },
    claim(accountId: string, revision: string, expected: Rule, now = Date.now()) {
      const interval = expected.intervalDays * day;
      if (expected.mode === "off" || expected.nextAt > now) return undefined;
      const slot = expected.nextAt + Math.floor((now - expected.nextAt) / interval) * interval;
      const expiresAt = slot + expected.windowMinutes * minute;
      db.exec("BEGIN IMMEDIATE");
      try {
        const moved = advance.run(slot + interval, accountId, expected.version, expected.nextAt).changes;
        const id = moved && now < expiresAt ? randomUUID() : undefined;
        if (id) insert.run(id, accountId, expected.version, revision, slot, expiresAt, expected.mode);
        db.exec("COMMIT");
        return id ? { id, expiresAt } : undefined;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    seen(accountId: string, mode: Settings["mode"], targetId: string, postId: string) {
      return !!known.get(accountId, mode, targetId, postId);
    },
    bind(id: string, targetId: string, postId: string) { return !!bind.run(targetId, postId, id).changes; },
    finish(id: string, state: Result, action: Run["action"] = null, previewText: string | null = null) {
      finish.run(state, action, previewText, id);
    },
  };
}

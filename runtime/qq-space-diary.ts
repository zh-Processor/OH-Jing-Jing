import { randomUUID } from "node:crypto";
import { qzoneRights, type QzoneVisibility } from "./qq-channel.js";
import type { openStore } from "./store.js";

const day = 86_400_000;
const minute = 60_000;
export type SpaceDiarySource = { entryId: number; entryVersion: number; ruleVersion: number; roleId: string };
type Entry = { id: number; version: number; text: string; shareable: number; schedule_id: string | null };
type Rule = {
  account_id: string; version: number; enabled: number; next_at: number;
  interval_days: number; window_minutes: number; visibility: QzoneVisibility; last_result: string | null;
};
type RuleInput = { enabled: boolean; nextAt: number; intervalDays: number; windowMinutes: number; visibility: QzoneVisibility };

export function readDiaryEntry(input: unknown) {
  const data = input as { text?: unknown; shareable?: unknown } | null;
  if (typeof data?.text !== "string" || !data.text.trim() || data.text.trim().length > 2000 || data.text.includes("\0") ||
      typeof data.shareable !== "boolean") throw new Error("请填写近况和发布许可，文字最多 2000 个字符。");
  return { text: data.text.trim(), shareable: data.shareable };
}

export function readDiaryRule(input: unknown): RuleInput {
  const data = input as Partial<RuleInput> | null;
  if (!data || typeof data.enabled !== "boolean" || typeof data.nextAt !== "number" || !Number.isSafeInteger(data.nextAt) ||
      data.nextAt <= 0 || data.nextAt > 8e15 || typeof data.intervalDays !== "number" ||
      !Number.isSafeInteger(data.intervalDays) || data.intervalDays < 1 || data.intervalDays > 365 ||
      typeof data.windowMinutes !== "number" || !Number.isSafeInteger(data.windowMinutes) ||
      data.windowMinutes < 1 || data.windowMinutes > 1440 ||
      typeof data.visibility !== "string" || !Object.hasOwn(qzoneRights, data.visibility)) {
    throw new Error("请填写下次执行时间、1 到 365 天的间隔、有效窗口及可见范围。");
  }
  return { enabled: data.enabled, nextAt: data.nextAt, intervalDays: data.intervalDays,
    windowMinutes: data.windowMinutes, visibility: data.visibility };
}

export function openQqSpaceDiary(store: ReturnType<typeof openStore>) {
  const { db } = store;
  db.exec(`
    CREATE TABLE IF NOT EXISTS qq_space_diary (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, role_id TEXT NOT NULL,
      version INTEGER NOT NULL, text TEXT NOT NULL, shareable INTEGER NOT NULL, schedule_id TEXT
    );
    CREATE INDEX IF NOT EXISTS qq_space_diary_roles ON qq_space_diary(account_id,role_id,id);
    CREATE TABLE IF NOT EXISTS qq_space_diary_rules (
      account_id TEXT PRIMARY KEY, version INTEGER NOT NULL, enabled INTEGER NOT NULL, next_at INTEGER NOT NULL,
      interval_days INTEGER NOT NULL, window_minutes INTEGER NOT NULL, visibility TEXT NOT NULL, last_result TEXT
    );
  `);
  const findRule = db.prepare("SELECT * FROM qq_space_diary_rules WHERE account_id=?");
  const getRule = (id: string) => findRule.get(id) as Rule | undefined;
  const scopeEntry = db.prepare("SELECT * FROM qq_space_diary WHERE account_id=? AND role_id=? AND id=?");
  const all = db.prepare("SELECT * FROM qq_space_diary WHERE account_id=? AND role_id=? ORDER BY id DESC");
  const candidate = db.prepare(`SELECT * FROM qq_space_diary
    WHERE account_id=? AND role_id=? AND shareable=1 AND schedule_id IS NULL ORDER BY id LIMIT 1`);
  const insertEntry = db.prepare("INSERT INTO qq_space_diary(account_id,role_id,version,text,shareable) VALUES(?,?,1,?,?)");
  const updateEntry = db.prepare(`UPDATE qq_space_diary SET text=?,shareable=?,version=version+1
    WHERE account_id=? AND role_id=? AND id=? AND version=?`);
  const deleteEntry = db.prepare("DELETE FROM qq_space_diary WHERE account_id=? AND role_id=? AND id=? AND version=?");
  const removePermission = db.prepare(`UPDATE qq_space_diary SET shareable=0,version=version+1
    WHERE account_id=? AND role_id=? AND id=? AND shareable=1`);
  const selected = db.prepare("UPDATE qq_space_diary SET schedule_id=? WHERE id=? AND schedule_id IS NULL");
  const saveRule = db.prepare(`INSERT INTO qq_space_diary_rules(account_id,version,enabled,next_at,interval_days,window_minutes,visibility)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,
    next_at=excluded.next_at,interval_days=excluded.interval_days,window_minutes=excluded.window_minutes,
    visibility=excluded.visibility,last_result=NULL WHERE qq_space_diary_rules.version=excluded.version-1`);
  const hasWork = db.prepare("SELECT 1 FROM qq_space_diary_rules WHERE enabled=1 LIMIT 1");
  const due = db.prepare("SELECT * FROM qq_space_diary_rules WHERE enabled=1 AND next_at<=? ORDER BY next_at");
  const advance = db.prepare("UPDATE qq_space_diary_rules SET next_at=?,last_result=? WHERE account_id=?");
  const wait = db.prepare("UPDATE qq_space_diary_rules SET last_result=? WHERE account_id=? AND last_result IS NOT ?");

  const showRule = (rule: Rule) => ({
    version: rule.version, enabled: rule.enabled === 1, nextAt: rule.next_at, intervalDays: rule.interval_days,
    windowMinutes: rule.window_minutes, visibility: rule.visibility, lastResult: rule.last_result,
  });
  const list = (accountId: string, roleId: string) => (all.all(accountId, roleId) as unknown as Entry[]).map(row => ({
    id: row.id, version: row.version, text: row.text, shareable: row.shareable === 1, selected: row.schedule_id !== null,
  }));
  return {
    read(accountId: string, roleId: string) {
      const rule = getRule(accountId);
      return { entries: list(accountId, roleId), rule: rule ? showRule(rule) : null };
    },
    create(accountId: string, roleId: string, entry: ReturnType<typeof readDiaryEntry>) {
      return Number(insertEntry.run(accountId, roleId, entry.text, Number(entry.shareable)).lastInsertRowid);
    },
    edit(accountId: string, roleId: string, id: number, version: number, entry: ReturnType<typeof readDiaryEntry>) {
      return !!updateEntry.run(entry.text, Number(entry.shareable), accountId, roleId, id, version).changes;
    },
    delete(accountId: string, roleId: string, id: number, version: number) {
      return !!deleteEntry.run(accountId, roleId, id, version).changes;
    },
    unshare(accountId: string, roleId: string, id: number) { removePermission.run(accountId, roleId, id); },
    save(accountId: string, version: number, input: RuleInput, now = Date.now(), expectedNextAt?: number) {
      const previous = getRule(accountId);
      if ((previous?.version ?? 0) !== version || (expectedNextAt !== undefined && expectedNextAt !== previous?.next_at)) return "conflict";
      if (previous && Number(input.enabled) === previous.enabled && input.nextAt === previous.next_at &&
          input.intervalDays === previous.interval_days && input.windowMinutes === previous.window_minutes &&
          input.visibility === previous.visibility) return "saved";
      if (input.enabled && input.nextAt <= now && input.nextAt !== previous?.next_at) return "past";
      return saveRule.run(accountId, version + 1, Number(input.enabled), input.nextAt, input.intervalDays,
        input.windowMinutes, input.visibility).changes ? "saved" : "conflict";
    },
    pending() { return !!hasWork.get(); },
    ready(now: number) { return !!due.get(now); },
    eligible(accountId: string, planId: string, currentRoleId: string, source: SpaceDiarySource) {
      if (currentRoleId !== source.roleId) return false;
      const rule = getRule(accountId);
      if (!rule?.enabled || rule.version !== source.ruleVersion) return false;
      const row = scopeEntry.get(accountId, source.roleId, source.entryId) as Entry | undefined;
      return row?.shareable === 1 && row.version === source.entryVersion && row.schedule_id === planId;
    },
    dispatch(now: number, eligibleRole: (accountId: string, visibility: QzoneVisibility) => string | null,
        queue: (event: { id: string; accountId: string; source: SpaceDiarySource; visibility: QzoneVisibility;
          material: string; expiresAt: number }) => void) {
      for (const row of due.all(now) as unknown as Rule[]) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const rule = getRule(row.account_id);
          if (!rule?.enabled || rule.next_at > now) { db.exec("COMMIT"); continue; }
          const interval = rule.interval_days * day;
          const slot = rule.next_at + Math.floor((now - rule.next_at) / interval) * interval;
          const expiresAt = slot + rule.window_minutes * minute;
          if (now >= expiresAt) {
            advance.run(slot + interval, "window-ended", rule.account_id);
          } else {
            const roleId = eligibleRole(rule.account_id, rule.visibility);
            const entry = roleId ? candidate.get(rule.account_id, roleId) as Entry | undefined : undefined;
            if (!roleId || !entry) {
              const result = roleId ? "waiting-material" : "waiting-permission";
              wait.run(result, rule.account_id, result);
            } else {
              const id = randomUUID();
              queue({ id, accountId: rule.account_id, visibility: rule.visibility, material: entry.text, expiresAt,
                source: { entryId: entry.id, entryVersion: entry.version, ruleVersion: rule.version, roleId } });
              selected.run(id, entry.id);
              advance.run(slot + interval, "scheduled", rule.account_id);
            }
          }
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      }
    },
  };
}

import type { DatabaseSync } from "node:sqlite";

export function openPrivateMemory(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS private_memory (
      account TEXT NOT NULL,
      role_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      text TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account, role_id, record_id)
    )
  `);
  const list = db.prepare(
    "SELECT record_id AS id,version,text,updated_at FROM private_memory WHERE account = ? AND role_id = ? ORDER BY updated_at,record_id",
  );
  const read = db.prepare(
    "SELECT version,text FROM private_memory WHERE account = ? AND role_id = ? AND record_id = ?",
  );
  const save = db.prepare(`
    INSERT INTO private_memory(account,role_id,record_id,version,text,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(account,role_id,record_id) DO UPDATE SET
      version = excluded.version, text = excluded.text, updated_at = excluded.updated_at
  `);
  const count = db.prepare("SELECT COUNT(*) AS total FROM private_memory WHERE account = ?");
  return {
    list: (account: string, roleId: string) => list.all(account, roleId),
    apply(account: string, roleId: string, recordId: string, input: unknown, authorized: () => boolean) {
      const item = input as { baseVersion?: number; text?: string | null } | null;
      const base = item?.baseVersion;
      const text = typeof item?.text === "string" ? item.text.trim() : item?.text;
      if (typeof base !== "number" || !Number.isSafeInteger(base) || base < 0 ||
          (text !== null && (typeof text !== "string" || !text || text.length > 400))) {
        return { status: 400, data: { error: "记忆文本或版本无效。" } };
      }
      // A single SQLite transaction preserves compare-and-set across processes.
      db.exec("BEGIN IMMEDIATE");
      try {
        const commit = (status: number, data: Record<string, unknown>) => {
          db.exec("COMMIT");
          return { status, data };
        };
        if (!authorized()) return commit(403, { error: "个人记忆写入权限已撤销。" });
        const previous = read.get(account, roleId, recordId);
        const version = Number(previous?.version ?? 0);
        if (version === base + 1 && previous?.text === text) {
          return commit(200, { version });
        }
        if (version !== base || (!previous && text === null)) {
          return commit(409, { error: "版本已变更，请保留本地编辑。", version });
        }
        if (!previous && Number(count.get(account)?.total ?? 0) >= 2000) {
          return commit(409, { error: "此账户的同步记录已达到上限。" });
        }
        save.run(account, roleId, recordId, version + 1, text, new Date().toISOString());
        return commit(200, { version: version + 1 });
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

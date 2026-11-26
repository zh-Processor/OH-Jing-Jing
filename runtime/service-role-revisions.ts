import type { PublishedRole, PublishedRoleInfo } from "./published-role.js";
import type { openStore } from "./store.js";

type Kind = "assignment" | "publication";
type Operation = "assign" | "publish" | "withdraw" | "rollback" | "migrate";
type Revision = { version: number; revision: string | null; operation: Operation; restoredVersion: number | null;
  createdAt: string; actor: string; info: string | null };

export function openServiceRoleRevisions({ db }: ReturnType<typeof openStore>) {
  db.exec(`CREATE TABLE IF NOT EXISTS service_role_snapshots (
    revision TEXT PRIMARY KEY, info TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS service_role_versions (
    kind TEXT NOT NULL, scope TEXT NOT NULL, version INTEGER NOT NULL, revision TEXT REFERENCES service_role_snapshots(revision),
    operation TEXT NOT NULL, restored_version INTEGER, actor TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (kind, scope, version)
  )`);
  const selectVersion = `SELECT v.version,v.revision,v.operation,v.restored_version AS restoredVersion,v.actor,v.created_at AS createdAt,s.info
    FROM service_role_versions v LEFT JOIN service_role_snapshots s ON s.revision=v.revision WHERE v.kind=? AND v.scope=?`;
  const latest = db.prepare(`${selectVersion} ORDER BY v.version DESC LIMIT 1`);
  const revision = db.prepare(`${selectVersion} AND v.version=?`);
  const history = db.prepare(`${selectVersion} ORDER BY v.version DESC LIMIT 30`);
  const snapshot = db.prepare("SELECT info,role FROM service_role_snapshots WHERE revision=?");
  const saveSnapshot = db.prepare("INSERT OR IGNORE INTO service_role_snapshots(revision,info,role) VALUES (?,?,?)");
  const insert = db.prepare(`INSERT INTO service_role_versions(kind,scope,version,revision,operation,restored_version,actor,created_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const removeLegacy = db.prepare("DELETE FROM settings WHERE key=?");
  const head = (kind: Kind, scope: string) => latest.get(kind, scope) as Revision | undefined;

  function role(revision: string | null | undefined): PublishedRole | undefined {
    if (!revision) return undefined;
    const stored = snapshot.get(revision);
    return stored ? { info: JSON.parse(String(stored.info)), role: JSON.parse(String(stored.role)) } : undefined;
  }

  function write(kind: Kind, scope: string, expectedVersion: number | undefined, value: PublishedRole | undefined,
      operation: Operation, restoredVersion: number | null = null) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = head(kind, scope);
      const version = current?.version ?? 0;
      if (expectedVersion !== undefined && expectedVersion !== version) {
        db.exec("ROLLBACK");
        return false;
      }
      const next = value?.info.revision ?? null;
      if ((current?.revision ?? null) !== next || (!current && operation === "migrate")) {
        if (value) saveSnapshot.run(next, JSON.stringify(value.info), JSON.stringify(value.role));
        insert.run(kind, scope, version + 1, next, operation, restoredVersion,
          operation === "migrate" ? "migration" : "administrator", new Date().toISOString());
      }
      // Keep the inherited marker during an application upgrade so the previous binary can still read it.
      if (kind === "publication" && operation !== "migrate") removeLegacy.run(`publishedRole:${scope}`);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    version(kind: Kind, scope: string) { return head(kind, scope)?.version ?? 0; },
    current(kind: Kind, scope: string) { return role(head(kind, scope)?.revision); },
    history(kind: Kind, scope: string) {
      return (history.all(kind, scope) as unknown as Revision[]).map(({ info, ...item }) => ({
        ...item, role: info ? JSON.parse(info) as PublishedRoleInfo : null,
      }));
    },
    at(kind: Kind, scope: string, version: number) {
      if (version === 0) return { found: true, value: undefined };
      const row = revision.get(kind, scope, version) as Revision | undefined;
      return { found: !!row, value: role(row?.revision) };
    },
    write,
  };
}

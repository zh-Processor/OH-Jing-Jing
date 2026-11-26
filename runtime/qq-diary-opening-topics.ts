import type { DatabaseSync } from "node:sqlite";

type Grant = { entryId: number; entryVersion: number; version: number; label: string; expiresAt: number };
type Entry = { id: number; version: number; text: string };
const lifetime = 7 * 86_400_000;

export function openQqDiaryOpeningTopics(db: DatabaseSync, mayShare: (id: number) => boolean) {
  db.exec(`CREATE TABLE IF NOT EXISTS qq_diary_opening_topics (
    scope TEXT NOT NULL, diary_id INTEGER NOT NULL REFERENCES qq_space_diary(id) ON DELETE CASCADE,
    diary_version INTEGER NOT NULL, role_revision TEXT NOT NULL, version INTEGER NOT NULL,
    label TEXT NOT NULL, expires_at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(scope,diary_id)
  ); CREATE INDEX IF NOT EXISTS qq_diary_opening_entry ON qq_diary_opening_topics(diary_id);`);
  const list = db.prepare(`SELECT g.diary_id AS entryId,g.diary_version AS entryVersion,g.version,g.label,g.expires_at AS expiresAt,g.removed,
    g.role_revision AS roleRevision,d.role_id AS roleId,d.version AS currentVersion
    FROM qq_diary_opening_topics g JOIN qq_space_diary d ON d.id=g.diary_id
    WHERE g.scope=? AND d.account_id=? ORDER BY g.expires_at DESC,g.diary_id DESC`);
  const entries = db.prepare(`SELECT id,version,text FROM qq_space_diary WHERE account_id=? AND role_id=? ORDER BY id DESC LIMIT 40`);
  const current = db.prepare(`SELECT g.version FROM qq_diary_opening_topics g JOIN qq_space_diary d ON d.id=g.diary_id
    WHERE g.scope=? AND g.diary_id=? AND d.account_id=?`);
  const entry = db.prepare(`SELECT 1 FROM qq_space_diary WHERE id=? AND account_id=? AND role_id=? AND version=?`);
  const upsert = db.prepare(`INSERT INTO qq_diary_opening_topics(scope,diary_id,diary_version,role_revision,version,label,expires_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,diary_id) DO UPDATE SET diary_version=excluded.diary_version,role_revision=excluded.role_revision,
    version=excluded.version,label=excluded.label,expires_at=excluded.expires_at,removed=0 WHERE version=excluded.version-1`);
  const remove = db.prepare(`UPDATE qq_diary_opening_topics SET removed=1,version=version+1,label=''
    WHERE scope=? AND diary_id=? AND version=? AND removed=0
    AND EXISTS(SELECT 1 FROM qq_space_diary WHERE id=? AND account_id=?)`);
  const revokeEntry = db.prepare("UPDATE qq_diary_opening_topics SET removed=1,version=version+1,label='' WHERE diary_id=? AND removed=0");
  const accountFor = (scope: string) => scope.split(":")[1];

  function grants(scope: string, roleId: string, roleRevision: string, now: number) {
    return (list.all(scope, accountFor(scope)) as unknown as (Grant & { roleId: string; roleRevision: string; currentVersion: number; removed: number })[])
      .map(({ roleId: sourceRole, roleRevision: sourceRevision, currentVersion, removed, ...grant }) => {
        const changed = sourceRole !== roleId || sourceRevision !== roleRevision || currentVersion !== grant.entryVersion;
        const state = removed || !mayShare(grant.entryId) ? "revoked" : changed ? "changed" : grant.expiresAt <= now ? "expired" : "active";
        return { ...grant, state };
      });
  }

  return {
    read(scope: string, roleId: string, roleRevision: string, now: number) {
      return { grants: grants(scope, roleId, roleRevision, now),
        entries: (entries.all(accountFor(scope), roleId) as unknown as Entry[]).filter(row => mayShare(row.id)).map(row => ({
          id: row.id, version: row.version, preview: Array.from(row.text.replace(/\s+/gu, " ")).slice(0, 48).join(""),
        })) };
    },
    active(scope: string, roleId: string, roleRevision: string, now: number) {
      return grants(scope, roleId, roleRevision, now).filter(grant => grant.state === "active").slice(0, 3)
        .map(({ entryId, entryVersion, version, label }) => ({ entryId, entryVersion, version, label }));
    },
    save(scope: string, roleId: string, roleRevision: string, entryId: number, entryVersion: number, version: number, label: string, now: number) {
      const account = accountFor(scope);
      if (!entry.get(entryId, account, roleId, entryVersion) || !mayShare(entryId)) return "stale";
      const previous = current.get(scope, entryId, account);
      if ((previous?.version ?? 0) !== version) return "stale";
      const active = grants(scope, roleId, roleRevision, now).filter(grant => grant.state === "active" && grant.entryId !== entryId);
      if (active.length >= 3) return "limit";
      if (active.some(grant => grant.label === label)) return "duplicate";
      return upsert.run(scope, entryId, entryVersion, roleRevision, version + 1, label, now + lifetime).changes ? "saved" : "stale";
    },
    remove(scope: string, entryId: number, version: number) {
      return !!remove.run(scope, entryId, version, entryId, accountFor(scope)).changes;
    },
    revokeEntry(entryId: number) { revokeEntry.run(entryId); },
  };
}

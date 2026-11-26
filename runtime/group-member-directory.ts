import type { DatabaseSync } from "node:sqlite";

export const memberDirectoryPageSize = 24;

export function readMemberTags(value: unknown) {
  if (!Array.isArray(value) || value.length > 6 ||
      value.some(tag => typeof tag !== "string" || !tag.trim() || tag.trim().length > 24 || /[，,\r\n]/u.test(tag))) {
    throw new Error("每位群友可填写最多 6 个标签，每个标签最长 24 字。标签正文请避开逗号和换行。");
  }
  return [...new Set<string>(value.map(tag => tag.trim()))];
}

export function openGroupMemberDirectory(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_member_labels (
      scope TEXT NOT NULL, subject TEXT NOT NULL, labels TEXT NOT NULL, PRIMARY KEY(scope,subject)
    );
    CREATE INDEX IF NOT EXISTS group_messages_scope_created_author ON group_messages(scope,created_at,author);
  `);
  const readTags = db.prepare("SELECT labels FROM group_member_labels WHERE scope=? AND subject=?");
  const writeTags = db.prepare(`INSERT INTO group_member_labels(scope,subject,labels) VALUES (?,?,?)
    ON CONFLICT(scope,subject) DO UPDATE SET labels=excluded.labels`);
  const removeTags = db.prepare("DELETE FROM group_member_labels WHERE scope=? AND subject=?");
  const rows = db.prepare(`
    WITH observed AS (
      SELECT actor_id AS id, MAX(rowid) AS last_event FROM channel_events
      WHERE scope=$scope AND created_at>=$cutoff GROUP BY actor_id
    ), archive AS (
      SELECT author AS id, COUNT(*) AS messages, MAX(created_at) AS latest FROM group_messages
      WHERE scope=$scope AND created_at>=$cutoff GROUP BY author
    ), publication AS (
      SELECT substr(key, length($prefix)+1) AS id, json_extract(value, '$.displayName') AS public_name
      FROM settings WHERE key >= $prefix AND key < $end
    ), candidates AS (
      SELECT subject AS id FROM group_profile_candidates WHERE scope=$scope AND status='pending'
    ), tags AS (
      SELECT subject AS id, labels FROM group_member_labels WHERE scope=$scope
    ), members AS (
      SELECT id FROM observed UNION SELECT id FROM archive UNION SELECT id FROM publication
      UNION SELECT id FROM candidates UNION SELECT id FROM tags
    )
    SELECT m.id, e.display_name AS observedName, p.public_name AS publishedName,
      COALESCE(a.messages,0) AS archivedCount, COALESCE(e.created_at,a.latest) AS lastActive,
      c.id IS NOT NULL AS pending, t.labels AS tags
    FROM members m
    LEFT JOIN observed o ON o.id=m.id
    LEFT JOIN channel_events e ON e.rowid=o.last_event
    LEFT JOIN archive a ON a.id=m.id
    LEFT JOIN publication p ON p.id=m.id
    LEFT JOIN candidates c ON c.id=m.id
    LEFT JOIN tags t ON t.id=m.id
    WHERE length(m.id) BETWEEN 4 AND 20 AND m.id NOT GLOB '*[^0-9]*' AND m.id<>$bot
      AND ($query='' OR instr(m.id,$query)>0 OR instr(lower(e.display_name),lower($query))>0
        OR instr(lower(p.public_name),lower($query))>0 OR EXISTS(
          SELECT 1 FROM json_each(t.labels) WHERE instr(lower(value),lower($query))>0
        ))
    ORDER BY lastActive DESC, m.id ASC LIMIT $limit OFFSET $offset
  `);
  type Row = { id: string; observedName: string | null; publishedName: string | null; archivedCount: number;
    lastActive: string | null; pending: number; tags: string | null };
  return {
    list(scope: string, query: string, offset: number, cutoff: string) {
      const prefix = `profile:${scope}:`;
      const result = rows.all({
        scope, cutoff, prefix, end: prefix.slice(0, -1) + ";", bot: scope.split(":")[1],
        query, limit: memberDirectoryPageSize + 1, offset,
      }) as unknown as Row[];
      return {
        items: result.slice(0, memberDirectoryPageSize).map(({ tags, pending, ...member }) =>
          ({ ...member, pending: Boolean(pending), tags: tags ? JSON.parse(tags) as string[] : [] })),
        next: result.length > memberDirectoryPageSize ? offset + memberDirectoryPageSize : null,
      };
    },
    tags(scope: string, subject: string): string[] {
      const value = readTags.get(scope, subject)?.labels;
      return typeof value === "string" ? JSON.parse(value) as string[] : [];
    },
    writeTags(scope: string, subject: string, tags: string[]) {
      if (tags.length) writeTags.run(scope, subject, JSON.stringify(tags));
      else removeTags.run(scope, subject);
    },
  };
}

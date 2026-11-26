import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const batchSize = 100;
const rebuiltHistorySize = 400;

export type WorkspaceConversation = { id: string; label: string; messageAccess: boolean; replyAccess?: boolean };
export type WorkspaceFeature = { id: string; title: string; minimumClientVersion: string; conversationIds: string[]; view: "list" };
type FeedPosition = { id: number; scope: string; kind: "message" | "summary"; row_id: number; created_at: string };

export function openWorkspaceFeed(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, kind TEXT NOT NULL,
      row_id INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(kind, row_id)
    );
    CREATE INDEX IF NOT EXISTS workspace_events_scope ON workspace_events(scope, id);
    CREATE TABLE IF NOT EXISTS workspace_recall_revisions (
      scope TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(scope,kind)
    );
    CREATE TRIGGER IF NOT EXISTS workspace_message_added AFTER INSERT ON group_messages BEGIN
      INSERT INTO workspace_events(scope,kind,row_id,created_at) VALUES(new.scope,'message',new.id,new.created_at);
    END;
    CREATE TRIGGER IF NOT EXISTS workspace_message_removed AFTER DELETE ON group_messages BEGIN
      DELETE FROM workspace_events WHERE kind='message' AND row_id=old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS workspace_summary_added AFTER INSERT ON group_summaries BEGIN
      INSERT INTO workspace_events(scope,kind,row_id,created_at) VALUES(new.scope,'summary',new.id,new.created_at);
    END;
    CREATE TRIGGER IF NOT EXISTS workspace_summary_removed AFTER DELETE ON group_summaries BEGIN
      DELETE FROM workspace_events WHERE kind='summary' AND row_id=old.id;
    END;
  `);
  const journalInitialized = db.prepare("SELECT 1 FROM sqlite_sequence WHERE name='workspace_events'");
  if (!journalInitialized.get()) {
    db.exec(`INSERT INTO workspace_events(scope,kind,row_id,created_at)
      SELECT scope,kind,row_id,created_at FROM (
        SELECT scope,'message' AS kind,id AS row_id,created_at FROM group_messages
        UNION ALL SELECT scope,'summary',id,created_at FROM group_summaries
      ) ORDER BY created_at, kind, row_id`);
  }

  const visible = `scope IN (SELECT value FROM json_each(?)) AND created_at>=?
    AND (kind='summary' OR scope IN (SELECT value FROM json_each(?)))`;
  const initial = db.prepare(`SELECT * FROM workspace_events WHERE ${visible} ORDER BY id DESC LIMIT ?`);
  const rebuild = db.prepare(`SELECT * FROM (
    SELECT * FROM workspace_events WHERE ${visible} ORDER BY id DESC LIMIT ?
  ) ORDER BY id LIMIT ?`);
  const subsequent = db.prepare(`SELECT * FROM workspace_events WHERE ${visible} AND id>? ORDER BY id LIMIT ?`);
  const ceiling = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='workspace_events'");
  const message = db.prepare("SELECT author, content, event_id FROM group_messages WHERE scope=? AND id=? AND created_at>=?");
  const markRecall = db.prepare(`INSERT INTO workspace_recall_revisions(scope,kind,revision) VALUES(?,?,1)
    ON CONFLICT(scope,kind) DO UPDATE SET revision=revision+1`);
  const revisions = db.prepare(`SELECT scope,kind,revision FROM workspace_recall_revisions
    WHERE (kind='summary' AND scope IN (SELECT value FROM json_each(?)))
       OR (kind='message' AND scope IN (SELECT value FROM json_each(?))) ORDER BY scope,kind`);

  return {
    page(conversations: WorkspaceConversation[], cutoff: string, cursor: string | null, subscriberId: string) {
      const scopes = conversations.map(item => item.id).sort();
      const rawScopes = conversations.filter(item => item.messageAccess).map(item => item.id).sort();
      const revision = createHash("sha256").update(JSON.stringify([subscriberId, scopes, rawScopes])).digest("hex").slice(0, 24);
      const visibleScopes = JSON.stringify(scopes);
      const messageScopes = JSON.stringify(rawScopes);
      const visibleRecalls = revisions.all(visibleScopes, messageScopes);
      const recallRevision = createHash("sha256").update(JSON.stringify(visibleRecalls)).digest("hex").slice(0, 16);
      const summaryRecallRevision = visibleRecalls.filter(item => item.kind === "summary").map(item => [item.scope, item.revision]);
      const high = Number(ceiling.get()?.seq ?? 0);
      const match = /^([a-f0-9]{24})\.(\d{1,16})(?:\.([a-f0-9]{16}))?$/.exec(cursor ?? "");
      const after = match?.[1] === revision ? Number(match[2]) : NaN;
      const canRebuild = Number.isSafeInteger(after) && after <= high;
      const reset = !canRebuild || match?.[3] !== recallRevision;
      const filters = [visibleScopes, cutoff, messageScopes];
      const rows = (!reset ? subsequent.all(...filters, after, batchSize + 1)
        : canRebuild ? rebuild.all(...filters, rebuiltHistorySize, batchSize + 1)
        : initial.all(...filters, batchSize).reverse()) as unknown as FeedPosition[];
      const hasMore = rows.length > batchSize;
      const events = rows.slice(0, batchSize);
      const next = hasMore ? events.at(-1)!.id : high;
      return { events, hasMore, reset, cursor: `${revision}.${next}.${recallRevision}`, retainedAfter: cutoff, summaryRecallRevision };
    },
    groupMessageRecalled(scope: string, summariesChanged: boolean) {
      markRecall.run(scope, "message");
      if (summariesChanged) markRecall.run(scope, "summary");
    },
    message(scope: string, rowId: number, cutoff: string) {
      return message.get(scope, rowId, cutoff) as { author: string; content: string; event_id: string | null } | undefined;
    },
  };
}

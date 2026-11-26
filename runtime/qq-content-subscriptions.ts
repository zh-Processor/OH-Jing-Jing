import type { DatabaseSync } from "node:sqlite";
import { feedTitle, readPublicFeedUrl, type PublicFeedItem } from "./public-content-feed.js";

const minute = 60_000;
const spacing = 5 * minute;
const lifetime = 24 * 60 * minute;
const defaultItemsPerCheck = 3;
const errors = new Set(["feed-format", "feed-http", "feed-address", "feed-too-large", "feed-redirect", "feed-authorization", "feed-rate-limited"]);

type Settings = { url: string; label: string; intervalMinutes: number; maxItemsPerCheck: number };
type Feed = Settings & { id: number; scope: string; paused: number; revision: number; primed: number;
  primedAt: number | null; nextAt: number; checkedAt: number | null; error: string | null };
type PendingItem = { id: number; scope: string; url: string; key: string; body: string };

export function readQqContentSubscription(input: unknown, authorizedCreators?: { has(id: string): boolean }): Settings | undefined {
  if (!input || typeof input !== "object") return;
  const { url, label, intervalMinutes, maxItemsPerCheck = defaultItemsPerCheck } = input as Partial<Settings>;
  const source = typeof url === "string" && authorizedCreators?.has(url) ? url : readPublicFeedUrl(url)?.href;
  const title = feedTitle(label);
  if (!source || !title || Array.from(title).length > 48 || typeof intervalMinutes !== "number" ||
      !Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 1440 ||
      !Number.isInteger(maxItemsPerCheck) || maxItemsPerCheck < 1 || maxItemsPerCheck > defaultItemsPerCheck) return;
  return { url: source, label: title, intervalMinutes, maxItemsPerCheck };
}

export const feedEventId = ({ id, key }: Pick<PendingItem, "id" | "key">) => `content-feed:${id}:${key}`;

export function contentFeedError(error: unknown) {
  if (!(error instanceof Error)) return "feed-network";
  if (errors.has(error.message)) return error.message;
  if (error.name === "TimeoutError" || (error.name === "AbortError" && error.cause instanceof Error && error.cause.name === "TimeoutError")) {
    return "feed-timeout";
  }
  return "feed-network";
}

export function openQqContentSubscriptions(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qq_content_feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, url TEXT NOT NULL, label TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL, next_at INTEGER NOT NULL, checked_at INTEGER, error TEXT,
      paused INTEGER NOT NULL DEFAULT 0, primed INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
      primed_at INTEGER,
      max_items_per_check INTEGER NOT NULL DEFAULT ${defaultItemsPerCheck},
      UNIQUE(scope,url)
    );
    CREATE INDEX IF NOT EXISTS qq_content_feed_due ON qq_content_feeds(next_at,id) WHERE paused=0;
    CREATE TABLE IF NOT EXISTS qq_content_feed_items (
      feed_id INTEGER NOT NULL REFERENCES qq_content_feeds(id) ON DELETE CASCADE, item_key TEXT NOT NULL,
      body TEXT NOT NULL, discovered_at INTEGER NOT NULL, status TEXT NOT NULL,
      PRIMARY KEY(feed_id,item_key)
    );
    CREATE INDEX IF NOT EXISTS qq_content_feed_pending ON qq_content_feed_items(discovered_at) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS qq_content_feed_spacing (scope TEXT PRIMARY KEY, attempted_at INTEGER NOT NULL);
    UPDATE qq_content_feed_items AS i SET status=COALESCE((
      SELECT CASE WHEN o.status='sent' AND o.platform_message_id IS NOT NULL THEN 'sent'
        WHEN o.status='failed' THEN 'failed' ELSE 'unknown' END
      FROM outbox o JOIN qq_content_feeds f ON f.id=i.feed_id
      WHERE o.scope=f.scope AND o.event_id='content-feed:' || i.feed_id || ':' || i.item_key
    ),'pending') WHERE i.status='sending';
  `);
  const properties = db.prepare("PRAGMA table_info(qq_content_feeds)").all().map(column => column.name);
  if (!properties.includes("max_items_per_check")) {
    db.exec(`ALTER TABLE qq_content_feeds ADD COLUMN max_items_per_check INTEGER NOT NULL DEFAULT ${defaultItemsPerCheck}`);
  }
  if (!properties.includes("primed_at")) db.exec("ALTER TABLE qq_content_feeds ADD COLUMN primed_at INTEGER");
  const fields = `id,scope,url,label,interval_minutes AS intervalMinutes,max_items_per_check AS maxItemsPerCheck,
    next_at AS nextAt,checked_at AS checkedAt,error,paused,primed,primed_at AS primedAt,revision`;
  const list = db.prepare(`SELECT ${fields} FROM qq_content_feeds WHERE scope=? ORDER BY id`);
  const due = db.prepare(`SELECT ${fields} FROM qq_content_feeds WHERE paused=0 AND next_at<=? ORDER BY next_at,id`);
  const active = db.prepare("SELECT 1 FROM qq_content_feeds WHERE paused=0 LIMIT 1");
  const insert = db.prepare(`INSERT OR IGNORE INTO qq_content_feeds(scope,url,label,interval_minutes,max_items_per_check,next_at)
    SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM qq_content_feeds WHERE scope=?)<8`);
  const updatePause = db.prepare(`UPDATE qq_content_feeds SET primed=0,primed_at=NULL,revision=revision+1,paused=?,next_at=?
    WHERE id=? AND scope=? AND paused<>?`);
  const cancelPending = db.prepare("UPDATE qq_content_feed_items SET status='expired',body='' WHERE feed_id=? AND status='pending'");
  const remove = db.prepare("DELETE FROM qq_content_feeds WHERE scope=? AND id=?");
  const recordCheck = db.prepare(`UPDATE qq_content_feeds SET next_at=?,checked_at=?,error=?,primed=?,primed_at=?
    WHERE id=? AND revision=? AND paused=0 AND next_at=?`);
  const invalidateCreator = db.prepare(`UPDATE qq_content_feeds SET primed=0,primed_at=NULL,error='feed-authorization',revision=revision+1,
    next_at=MAX(next_at,?+interval_minutes*${minute}) WHERE url=? AND paused=0`);
  const cancelCreatorItems = db.prepare(`UPDATE qq_content_feed_items SET status='expired',body='' WHERE status='pending'
    AND feed_id IN (SELECT id FROM qq_content_feeds WHERE url=?)`);
  const insertItem = db.prepare("INSERT OR IGNORE INTO qq_content_feed_items VALUES (?,?,?,?,?)");
  const countPending = db.prepare("SELECT COUNT(*) AS count FROM qq_content_feed_items WHERE feed_id=? AND status='pending'");
  const expire = db.prepare("UPDATE qq_content_feed_items SET status='expired',body='' WHERE status='pending' AND discovered_at<=?");
  const pending = db.prepare(`SELECT f.id,f.scope,f.url,i.item_key AS key,i.body FROM qq_content_feed_items i
    JOIN qq_content_feeds f ON f.id=i.feed_id LEFT JOIN qq_content_feed_spacing s ON s.scope=f.scope
    WHERE f.paused=0 AND i.status='pending' AND (s.attempted_at IS NULL OR s.attempted_at<=?)
    ORDER BY i.discovered_at,i.rowid`);
  const beginSend = db.prepare(`UPDATE qq_content_feed_items SET status='sending' WHERE feed_id=? AND item_key=? AND status='pending'
    AND discovered_at>? AND EXISTS (SELECT 1 FROM qq_content_feeds WHERE id=? AND scope=? AND paused=0)
    AND NOT EXISTS (SELECT 1 FROM qq_content_feed_spacing WHERE scope=? AND attempted_at>?)`);
  const setSpacing = db.prepare(`INSERT INTO qq_content_feed_spacing(scope,attempted_at) VALUES (?,?)
    ON CONFLICT(scope) DO UPDATE SET attempted_at=excluded.attempted_at`);
  const finish = db.prepare("UPDATE qq_content_feed_items SET status=?,body='' WHERE feed_id=? AND item_key=? AND status='sending'");
  const metrics = db.prepare(`SELECT i.status,COUNT(*) AS count FROM qq_content_feed_items i
    JOIN qq_content_feeds f ON f.id=i.feed_id WHERE f.id=? AND f.scope=? AND i.status<>'seen' GROUP BY i.status`);
  const recent = db.prepare(`SELECT event_id AS eventId,CASE WHEN status='sent' AND platform_message_id IS NULL THEN 'unknown' ELSE status END AS status,
    created_at AS at,platform_message_id AS platformMessageId
    FROM outbox WHERE scope=? AND event_id GLOB 'content-feed:*' ORDER BY id DESC LIMIT 20`);

  function change(action: () => boolean) {
    db.exec("SAVEPOINT qq_content_change");
    try {
      const changed = action();
      db.exec("RELEASE qq_content_change");
      return changed;
    } catch (error) {
      db.exec("ROLLBACK TO qq_content_change; RELEASE qq_content_change");
      throw error;
    }
  }

  return {
    create: (scope: string, config: Settings, now: number) => !!insert.run(scope, config.url, config.label, config.intervalMinutes,
      config.maxItemsPerCheck, now, scope).changes,
    setPaused(scope: string, id: number, paused: boolean, now: number) {
      return change(() => {
        if (!updatePause.run(Number(paused), now, id, scope, Number(paused)).changes) return false;
        if (paused) cancelPending.run(id);
        return true;
      });
    },
    remove: (scope: string, id: number) => !!remove.run(scope, id).changes,
    hasActive: () => !!active.get(),
    due: (now: number) => due.all(now) as unknown as Feed[],
    record(feed: Feed, now: number, result: PublicFeedItem[] | string) {
      return change(() => {
        const items = Array.isArray(result) ? result : undefined;
        const error = typeof result === "string" ? result : null;
        const nextCheck = now + feed.intervalMinutes * minute;
        const primedAt = items ? feed.primedAt ?? now : feed.primedAt;
        if (!recordCheck.run(nextCheck, now, error, items ? 1 : feed.primed, primedAt, feed.id, feed.revision, feed.nextAt).changes) return false;
        if (error === "feed-authorization" && feed.url.startsWith("bilibili:")) {
          invalidateCreator.run(now, feed.url);
          cancelCreatorItems.run(feed.url);
        }
        let remaining = Math.max(0, Math.min(feed.maxItemsPerCheck, 6 - Number(countPending.get(feed.id)?.count ?? 0)));
        for (const { key, title, link, publishedAt } of items ?? []) {
          if (publishedAt !== undefined && publishedAt > now) continue;
          const fresh = publishedAt === undefined || (primedAt !== null && publishedAt > primedAt);
          const notify = !!feed.primed && fresh && remaining > 0;
          const body = notify ? [`${feed.label} · 新内容`, title, link].filter(Boolean).join("\n") : "";
          if (insertItem.run(feed.id, key, body, now, notify ? "pending" : "seen").changes && notify) remaining--;
        }
        return true;
      });
    },
    pending(now: number) {
      expire.run(now - lifetime);
      return pending.all(now - spacing) as unknown as PendingItem[];
    },
    claim(item: PendingItem, now: number) {
      return change(() => {
        if (!beginSend.run(item.id, item.key, now - lifetime, item.id, item.scope, item.scope, now - spacing).changes) return false;
        setSpacing.run(item.scope, now);
        return true;
      });
    },
    finish(item: PendingItem, status: unknown) {
      finish.run(status === "sent" || status === "failed" ? status : "unknown", item.id, item.key);
    },
    summary(scope: string) {
      const feeds = (list.all(scope) as unknown as Feed[]).map(({ id, label, url, intervalMinutes, maxItemsPerCheck, nextAt, checkedAt, error, paused, primed }) =>
        ({ id, label, url, intervalMinutes, maxItemsPerCheck, nextAt: paused ? null : nextAt, checkedAt, error, paused: !!paused, primed: !!primed,
          runs: Object.fromEntries(metrics.all(id, scope).map(({ status, count }) => [String(status), count])) }));
      return { feeds, recent: recent.all(scope) };
    },
  };
}

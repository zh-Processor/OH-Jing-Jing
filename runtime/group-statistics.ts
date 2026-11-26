import type { DatabaseSync } from "node:sqlite";
import { groupReplyTriggers, type GroupReplyTrigger } from "./group-reply-traces.js";

export const groupStatisticDays = ["1", "7"] as const;
type StatisticDays = typeof groupStatisticDays[number];
type ObservedEvents = { messages: number; activeAccounts: number; firstAt: string | null; lastAt: string | null };
type Deliveries = { sent: number; failed: number; unknown: number; sending: number };
type ReplySample = { eligibleMessages: number; triggeredMessages: number; firstAt: string | null; lastAt: string | null };
type ReplyActivity = { trigger: GroupReplyTrigger; entered: number; delivered: number; partial: number;
  pending: number; withheld: number; undelivered: number };
type BlockedReply = { trigger: GroupReplyTrigger; reason: string; count: number };

const dayMs = 86_400_000;
const blockedReply = "(t.state='skipped' AND COALESCE(t.reason IN ('paused','reply-disabled') OR t.reason GLOB 'gate:*', 0))";

export function openGroupStatistics(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_reply_samples (
      scope TEXT NOT NULL, event_id TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(scope, event_id)
    );
    CREATE INDEX IF NOT EXISTS group_reply_samples_scope_time ON group_reply_samples(scope, observed_at);
    CREATE INDEX IF NOT EXISTS group_reply_samples_time ON group_reply_samples(observed_at);
    CREATE INDEX IF NOT EXISTS outbox_scope_time ON outbox(scope, created_at);
  `);
  const record = db.prepare("INSERT OR IGNORE INTO group_reply_samples(scope,event_id,observed_at) VALUES (?,?,?)");
  const prune = db.prepare("DELETE FROM group_reply_samples WHERE observed_at < ?");
  const inbound = db.prepare(`SELECT COUNT(*) AS messages, COUNT(DISTINCT actor_id) AS activeAccounts,
    MIN(created_at) AS firstAt, MAX(created_at) AS lastAt
    FROM channel_events WHERE scope=? AND created_at>=? AND created_at<?`);
  const byHour = db.prepare(`SELECT CAST(strftime('%H',created_at,'+08:00') AS INTEGER) AS hour, COUNT(*) AS messages
    FROM channel_events WHERE scope=? AND created_at>=? AND created_at<? GROUP BY hour`);
  const sent = db.prepare(`SELECT COUNT(*) FILTER (WHERE status='sent') AS sent,
    COUNT(*) FILTER (WHERE status='failed') AS failed, COUNT(*) FILTER (WHERE status='unknown') AS unknown,
    COUNT(*) FILTER (WHERE status='sending') AS sending FROM outbox WHERE scope=? AND created_at>=? AND created_at<?`);
  const sample = db.prepare(`SELECT COUNT(*) AS eligibleMessages,
    COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM group_reply_traces t
      WHERE t.scope=s.scope AND t.event_id=s.event_id AND t.trigger<>'opening'
        AND NOT ${blockedReply})) AS triggeredMessages,
    MIN(s.observed_at) AS firstAt, MAX(s.observed_at) AS lastAt
    FROM group_reply_samples s WHERE s.scope=? AND s.observed_at>=? AND s.observed_at<?`);
  const activity = db.prepare(`WITH outcomes AS (
    SELECT t.trigger, CASE
      WHEN first.status IN ('sending','unknown') OR second.status IN ('sending','unknown') OR t.state='running' THEN 'pending'
      WHEN first.status='sent' AND (t.second_delivery IS NULL OR second.status='sent') THEN 'delivered'
      WHEN first.status='sent' OR second.status='sent' THEN 'partial'
      WHEN t.state='preview' OR (t.state='skipped' AND t.reason='silence') THEN 'withheld'
      ELSE 'undelivered' END AS outcome
    FROM group_reply_traces t
    LEFT JOIN outbox first ON first.scope=t.scope AND first.event_id=t.first_delivery
    LEFT JOIN outbox second ON second.scope=t.scope AND second.event_id=t.second_delivery
    WHERE t.scope=? AND t.started_at>=? AND t.started_at<? AND NOT ${blockedReply}
  ) SELECT trigger, COUNT(*) AS entered,
    COUNT(*) FILTER (WHERE outcome='delivered') AS delivered, COUNT(*) FILTER (WHERE outcome='partial') AS partial,
    COUNT(*) FILTER (WHERE outcome='pending') AS pending, COUNT(*) FILTER (WHERE outcome='withheld') AS withheld,
    COUNT(*) FILTER (WHERE outcome='undelivered') AS undelivered FROM outcomes GROUP BY trigger`);
  const blocked = db.prepare(`SELECT t.trigger, t.reason, COUNT(*) AS count FROM group_reply_traces t
    WHERE t.scope=? AND t.started_at>=? AND t.started_at<? AND ${blockedReply}
    GROUP BY t.trigger,t.reason ORDER BY count DESC,t.trigger,t.reason`);

  return {
    recordEligibleMessage(scope: string, eventId: string, at: string) { record.run(scope, eventId, at); },
    prune(since: string) { prune.run(since); },
    read(scope: string, days: StatisticDays, traceRetentionDays: number, now = Date.now()) {
      const end = new Date(now).toISOString();
      const start = new Date(now - Number(days) * dayMs).toISOString();
      const sampleStart = new Date(now - Math.min(Number(days), traceRetentionDays) * dayMs).toISOString();
      const observed = inbound.get(scope, start, end) as ObservedEvents;
      const deliveries = sent.get(scope, start, end) as Deliveries;
      const measured = sample.get(scope, sampleStart, end) as ReplySample;
      const turns = (activity.all(scope, sampleStart, end) as unknown as ReplyActivity[]).map(turn => ({ ...turn }));
      const blockers = (blocked.all(scope, sampleStart, end) as unknown as BlockedReply[]).map(block => ({ ...block }));
      turns.sort((a, b) => groupReplyTriggers.indexOf(a.trigger) - groupReplyTriggers.indexOf(b.trigger));
      const activeHours = new Map(byHour.all(scope, start, end).map(row => [row.hour, row.messages as number]));
      const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, messages: activeHours.get(hour) ?? 0 }));
      return { scope, start, end, timeZone: "Asia/Shanghai", observed: { ...observed }, hours, deliveries: { ...deliveries }, reply: {
        ...measured, start: sampleStart, rate: measured.eligibleMessages ? measured.triggeredMessages / measured.eligibleMessages : null,
      }, replyActivity: { start: sampleStart, turns, blockers } };
    },
  };
}

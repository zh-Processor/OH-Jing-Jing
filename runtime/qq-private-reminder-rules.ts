import type { DatabaseSync } from "node:sqlite";
import type { QqPrivateContact } from "./qq-private.js";
import { nextReminderOccurrence, occurrenceWindow, type ReminderRecurrence } from "./qq-private-reminder-time.js";

type Row = { id: number; account_id: string; user_id: string; weekday: number | null; local_time: string; time_zone: string;
  next_at: number; text: string; last_result: string | null };
export type ReminderOccurrence = {
  id: number; account_id: string; user_id: string; due_at: number; expires_at: number; text: string; repeat: true;
};

const schedule = (row: Row): ReminderRecurrence => ({ weekday: row.weekday, localTime: row.local_time, timeZone: row.time_zone });

export function openPrivateReminderRules(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qq_private_reminder_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, user_id TEXT NOT NULL, source_event TEXT NOT NULL,
      weekday INTEGER, local_time TEXT NOT NULL, time_zone TEXT NOT NULL, next_at INTEGER NOT NULL, text TEXT,
      last_result TEXT, cancelled_at INTEGER, UNIQUE(account_id,user_id,source_event)
    );
    CREATE INDEX IF NOT EXISTS qq_private_reminder_rules_due ON qq_private_reminder_rules(next_at,id) WHERE cancelled_at IS NULL;
    CREATE INDEX IF NOT EXISTS qq_private_reminder_rules_contact ON qq_private_reminder_rules(account_id,user_id,id) WHERE cancelled_at IS NULL;
  `);
  const active = db.prepare(`SELECT * FROM qq_private_reminder_rules WHERE account_id=? AND user_id=?
    AND cancelled_at IS NULL ORDER BY next_at,id`);
  const insert = db.prepare(`INSERT INTO qq_private_reminder_rules(account_id,user_id,source_event,weekday,local_time,time_zone,next_at,text)
    VALUES(?,?,?,?,?,?,?,?)`);
  const known = db.prepare("SELECT id FROM qq_private_reminder_rules WHERE account_id=? AND user_id=? AND source_event=?");
  const find = db.prepare("SELECT * FROM qq_private_reminder_rules WHERE id=? AND cancelled_at IS NULL");
  const hasWork = db.prepare("SELECT 1 FROM qq_private_reminder_rules WHERE cancelled_at IS NULL LIMIT 1");
  const due = db.prepare("SELECT * FROM qq_private_reminder_rules WHERE next_at<=? AND cancelled_at IS NULL ORDER BY next_at,id");
  const advance = db.prepare("UPDATE qq_private_reminder_rules SET next_at=?,last_result=? WHERE id=? AND next_at=? AND cancelled_at IS NULL");
  const cancel = db.prepare(`UPDATE qq_private_reminder_rules SET cancelled_at=?,text=NULL
    WHERE id=? AND account_id=? AND user_id=? AND cancelled_at IS NULL`);
  const cancelAll = db.prepare(`UPDATE qq_private_reminder_rules SET cancelled_at=?,text=NULL
    WHERE account_id=? AND user_id=? AND cancelled_at IS NULL`);
  const purge = db.prepare("DELETE FROM qq_private_reminder_rules WHERE cancelled_at<?");

  return {
    list(contact: QqPrivateContact) {
      return (active.all(contact.accountId, contact.userId) as unknown as Row[]).map(row => ({
        id: row.id, ...schedule(row), text: row.text, nextAt: row.next_at, lastResult: row.last_result,
      }));
    },
    known(contact: QqPrivateContact, eventId: string) { return known.get(contact.accountId, contact.userId, eventId); },
    create(contact: QqPrivateContact, eventId: string, rule: ReminderRecurrence & { text: string }, now: number) {
      const nextAt = nextReminderOccurrence(rule, now);
      const id = insert.run(contact.accountId, contact.userId, eventId, rule.weekday, rule.localTime, rule.timeZone, nextAt, rule.text).lastInsertRowid;
      return { id, nextAt };
    },
    pending() { return !!hasWork.get(); },
    due(now: number): ReminderOccurrence[] {
      return (due.all(now) as unknown as Row[]).flatMap(row => {
        let slot = row.next_at;
        if (slot + occurrenceWindow <= now) {
          // Retain the live window, if any, and jump over every older occurrence.
          slot = nextReminderOccurrence(schedule(row), now - occurrenceWindow);
          if (!advance.run(slot, "expired", row.id, row.next_at).changes) return [];
        }
        return slot <= now ? [{ id: row.id, account_id: row.account_id, user_id: row.user_id, due_at: slot,
          expires_at: slot + occurrenceWindow, text: row.text, repeat: true }] : [];
      });
    },
    claim(item: ReminderOccurrence, now: number) {
      const row = find.get(item.id) as Row | undefined;
      if (!row || row.account_id !== item.account_id || row.user_id !== item.user_id ||
          row.next_at !== item.due_at || now < row.next_at || now >= row.next_at + occurrenceWindow) return false;
      const nextAt = nextReminderOccurrence(schedule(row), row.next_at);
      return !!advance.run(nextAt, "attempted", row.id, row.next_at).changes;
    },
    cancel(contact: QqPrivateContact, id: number, now: number) {
      return !!cancel.run(now, id, contact.accountId, contact.userId).changes;
    },
    cancelAll(contact: QqPrivateContact, now: number) { cancelAll.run(now, contact.accountId, contact.userId); },
    prune(before: number) { purge.run(before); },
  };
}

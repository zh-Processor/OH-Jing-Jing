import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { conversationWindow } from "./group-conversation.js";
import { nextReminderOccurrence, occurrenceWindow, reminderClock, reminderDateLabel, reminderMinute } from "./qq-private-reminder-time.js";
import type { QqPrivateContact as Contact } from "./qq-private.js";

type Settings = {
  subscribed: boolean; paused: boolean; timeZone: string; localTime: string; quietStart: string; quietEnd: string;
  unanswered: number; lastInboundAt: number | null; revision: string;
};
type Policy = { settings: Settings; nextAt: number | null };
type Candidate = { contact: Contact; settings: Settings; dueAt: number };
type Outcome = "sent" | "failed" | "unknown" | "interrupted" | "skipped";
const commands = "/问候订阅 [时间] [时区]、/问候状态、/问候勿扰 23:00 08:00（或 关闭）、/问候暂停、/问候恢复、/问候退订。";
const nextSlot = (settings: Settings, time: number) => nextReminderOccurrence({ ...settings, weekday: null }, time);
const activeConversationWindow = 120 * reminderMinute;

export function isPrivateGreetingCommand(text: string) { return /^\/问候/u.test(text.trimStart()); }

export function openQqPrivateGreetings(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qq_private_greeting_policies (
      account_id TEXT NOT NULL, user_id TEXT NOT NULL, settings TEXT NOT NULL, next_at INTEGER,
      PRIMARY KEY(account_id,user_id)
    );
    CREATE INDEX IF NOT EXISTS qq_private_greetings_due ON qq_private_greeting_policies(next_at) WHERE next_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS qq_private_greetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, user_id TEXT NOT NULL, due_at INTEGER NOT NULL,
      state TEXT NOT NULL, reason TEXT, UNIQUE(account_id,user_id,due_at)
    );
    UPDATE qq_private_greetings SET state='interrupted',reason='restart' WHERE state='generating';
    UPDATE qq_private_greetings SET state=COALESCE((
      SELECT CASE WHEN status IN ('sent','failed') THEN status ELSE 'unknown' END FROM outbox
      WHERE scope='qq-private:' || account_id || ':' || user_id AND event_id='greeting:' || qq_private_greetings.id
    ),'unknown'), reason='restart' WHERE state='sending';
  `);
  const entry = db.prepare("SELECT settings,next_at FROM qq_private_greeting_policies WHERE account_id=? AND user_id=?");
  const save = db.prepare("INSERT OR REPLACE INTO qq_private_greeting_policies VALUES(?,?,?,?)");
  const remove = db.prepare("DELETE FROM qq_private_greeting_policies WHERE account_id=? AND user_id=?");
  const hasWork = db.prepare("SELECT 1 FROM qq_private_greeting_policies WHERE next_at IS NOT NULL LIMIT 1");
  const due = db.prepare("SELECT * FROM qq_private_greeting_policies WHERE next_at<=? ORDER BY next_at,account_id,user_id");
  const job = db.prepare("INSERT OR IGNORE INTO qq_private_greetings(account_id,user_id,due_at,state) VALUES(?,?,?,'generating')");
  const reserve = db.prepare(`UPDATE qq_private_greetings SET state='sending'
    WHERE id=? AND account_id=? AND user_id=? AND due_at=? AND state='generating'`);
  const settle = db.prepare("UPDATE qq_private_greetings SET state=?,reason=? WHERE id=? AND state IN ('generating','sending')");
  const history = db.prepare(`SELECT g.due_at AS dueAt,g.state,g.reason, o.platform_message_id AS platformMessageId
    FROM qq_private_greetings g LEFT JOIN outbox o ON o.scope='qq-private:' || g.account_id || ':' || g.user_id AND o.event_id='greeting:' || g.id
    WHERE g.account_id=? AND g.user_id=? ORDER BY g.id DESC LIMIT 5`);
  const prune = db.prepare("DELETE FROM qq_private_greetings WHERE due_at<? AND state NOT IN ('generating','sending')");

  const read = (contact: Contact) => {
    const row = entry.get(contact.accountId, contact.userId);
    return row ? { settings: JSON.parse(String(row.settings)) as Settings, nextAt: row.next_at === null ? null : Number(row.next_at) } : null;
  };
  function write(contact: Contact, settings: Settings, nextAt: number | null) {
    save.run(contact.accountId, contact.userId, JSON.stringify(settings), nextAt);
  }
  function transaction<T>(apply: () => T): T {
    db.exec("SAVEPOINT private_greeting_change");
    try {
      const result = apply();
      db.exec("RELEASE private_greeting_change");
      return result;
    } catch (error) {
      db.exec("ROLLBACK TO private_greeting_change; RELEASE private_greeting_change");
      throw error;
    }
  }
  function current(candidate: Candidate, now: number): Policy | null {
    const policy = read(candidate.contact);
    const settings = policy?.settings;
    if (!settings?.subscribed || settings.paused || settings.revision !== candidate.settings.revision ||
        now < candidate.dueAt || now >= candidate.dueAt + occurrenceWindow ||
        (settings.lastInboundAt !== null && now - settings.lastInboundAt < activeConversationWindow) ||
        conversationWindow(settings, now).quiet) return null;
    return policy;
  }

  return {
    setAccess(contact: Contact, enabled: boolean) {
      if (!enabled) { remove.run(contact.accountId, contact.userId); return; }
      if (!read(contact)) write(contact, { subscribed: false, paused: false, timeZone: "Asia/Shanghai", localTime: "18:30",
        quietStart: "23:00", quietEnd: "08:00", unanswered: 0, lastInboundAt: null, revision: randomUUID() }, null);
    },
    summary(contact: Contact) {
      const policy = read(contact);
      const settings = policy && { subscribed: policy.settings.subscribed, paused: policy.settings.paused, timeZone: policy.settings.timeZone,
        localTime: policy.settings.localTime, quietStart: policy.settings.quietStart, quietEnd: policy.settings.quietEnd,
        unanswered: policy.settings.unanswered };
      return { settings, nextAt: policy?.nextAt ?? null, history: history.all(contact.accountId, contact.userId) };
    },
    command(contact: Contact, input: string, now = Date.now()) {
      const policy = read(contact);
      if (!policy) return "这个私聊联系人尚未开放角色问候。";
      const { settings, nextAt } = policy;
      const [command, ...parts] = input.trim().split(/\s+/u);
      const update = (change: Partial<Settings>, next: number | null = nextAt) =>
        write(contact, { ...settings, ...change, revision: randomUUID() }, next);
      if (command === "/问候订阅") {
        const [localTime = settings.localTime, timeZone = settings.timeZone] = parts;
        try {
          if (parts.length > 2 || !reminderClock.test(localTime) || timeZone.length > 64) throw new Error("Invalid preference");
          new Intl.DateTimeFormat("zh-CN", { timeZone });
        } catch { return "请填写本地时间和时区，例如 /问候订阅 18:30 Asia/Shanghai。"; }
        const nextSettings = { ...settings, subscribed: true, localTime, timeZone };
        const next = settings.subscribed && settings.localTime === localTime && settings.timeZone === timeZone && nextAt !== null
          ? nextAt : nextSlot(nextSettings, now);
        update(nextSettings, next);
        return `已订阅角色问候，${localTime}（${timeZone}），下次时段 ${reminderDateLabel(timeZone, next)}。`;
      }
      if (!settings.subscribed) return "请先发送 /问候订阅。";
      if (command === "/问候退订" && !parts.length) {
        update({ subscribed: false, paused: false, unanswered: 0, lastInboundAt: null }, null);
        return "已退订角色问候。";
      }
      if ((command === "/问候暂停" || command === "/问候恢复") && !parts.length) {
        const paused = command === "/问候暂停";
        update({ paused });
        return paused ? "已暂停角色问候。" : "已恢复角色问候。";
      }
      if (command === "/问候勿扰") {
        const off = parts.length === 1 && parts[0] === "关闭";
        const [quietStart, quietEnd] = off ? ["00:00", "00:00"] : parts;
        if (!off && (parts.length !== 2 || !reminderClock.test(quietStart) || !reminderClock.test(quietEnd) || quietStart === quietEnd)) {
          return "请使用 /问候勿扰 23:00 08:00 或 /问候勿扰 关闭。";
        }
        update({ quietStart, quietEnd });
        return off ? "已关闭问候勿扰时段。" : `已设问候勿扰 ${quietStart} 至 ${quietEnd}（${settings.timeZone}）。`;
      }
      if (command === "/问候状态" && !parts.length && nextAt !== null) {
        return `${settings.paused ? "问候已暂停" : "已订阅"}，下次时段 ${reminderDateLabel(settings.timeZone, nextAt)}（${settings.timeZone}）。`;
      }
      return commands;
    },
    noteInbound(contact: Contact, now: number) {
      const policy = read(contact);
      if (!policy?.settings.subscribed || policy.nextAt === null) return;
      const settings = { ...policy.settings, unanswered: 0, lastInboundAt: now, revision: randomUUID() };
      const next = policy.nextAt <= now || policy.settings.unanswered >= 2 ? nextSlot(settings, now) : policy.nextAt;
      write(contact, settings, next);
    },
    pending() { return !!hasWork.get(); },
    due(now: number) {
      const candidates: Candidate[] = [];
      for (const row of due.all(now)) {
        const contact = { accountId: String(row.account_id), userId: String(row.user_id) };
        const settings = JSON.parse(String(row.settings)) as Settings;
        const dueAt = Number(row.next_at);
        if (dueAt + occurrenceWindow <= now) {
          // A past interval is discarded; only a currently open interval can be attempted.
          const slot = nextSlot(settings, now - occurrenceWindow);
          write(contact, settings, slot);
          if (slot <= now) candidates.push({ contact, settings, dueAt: slot });
        } else candidates.push({ contact, settings, dueAt });
      }
      return candidates.filter(candidate => current(candidate, now));
    },
    begin(candidate: Candidate, now: number) {
      return transaction(() => {
        if (current(candidate, now)?.nextAt !== candidate.dueAt) return null;
        const { accountId, userId } = candidate.contact;
        const record = job.run(accountId, userId, candidate.dueAt);
        write(candidate.contact, candidate.settings, nextSlot(candidate.settings, candidate.dueAt));
        return record.changes ? Number(record.lastInsertRowid) : null;
      });
    },
    reserve(candidate: Candidate, id: number, now: number) {
      return transaction(() => {
        const policy = current(candidate, now);
        if (!policy || policy.nextAt === null ||
            !reserve.run(id, candidate.contact.accountId, candidate.contact.userId, candidate.dueAt).changes) return false;
        const unanswered = Math.min(4, policy.settings.unanswered + 1);
        const gap = unanswered >= 4 ? 7 : unanswered >= 2 ? 3 : 1;
        let next = policy.nextAt;
        for (let days = 1; days < gap; days++) next = nextSlot(policy.settings, next);
        write(candidate.contact, { ...policy.settings, unanswered }, next);
        return true;
      });
    },
    finish(id: number, state: Outcome, reason?: string) { settle.run(state, reason ?? null, id); },
    prune(before: number) { prune.run(before); },
  };
}

import type { DatabaseSync } from "node:sqlite";
import { conversationWindow } from "./group-conversation.js";
import { qqPrivateScope, type QqPrivateContact as Contact } from "./qq-private.js";
import { openPrivateReminderRules, type ReminderOccurrence } from "./qq-private-reminder-rules.js";
import { readPrivateReminderRecurrence, readPrivateReminderTime, recurrenceLabel, reminderClock as clock,
  reminderDateLabel as dateLabel, reminderDay as day, reminderMinute as minute } from "./qq-private-reminder-time.js";

type Preferences = { subscribed: boolean; paused: boolean; timeZone: string; quietStart: string; quietEnd: string };
type Delivery = "sent" | "failed" | "unknown";
type Reminder = { id: number; account_id: string; user_id: string; due_at: number; expires_at: number; text: string; repeat?: false };
const defaults: Preferences = { subscribed: false, paused: false, timeZone: "Asia/Shanghai", quietStart: "23:00", quietEnd: "08:00" };
const queuedLimit = 10;
const dailyLimit = 4;
const help = "提醒用法：/提醒订阅 [时区]、/提醒 30分钟 喝水、/提醒 YYYY-MM-DD HH:mm 正文、" +
  "/提醒 每天 09:00 喝水、/提醒 每周三 20:00 备份、/提醒列表、/提醒取消 编号、" +
  "/提醒勿扰 23:00 08:00（或 关闭）、/提醒暂停、/提醒恢复、/提醒退订。";
const reminderId = /^([#R])?([1-9]\d{0,14})$/iu;

export function isPrivateReminderCommand(text: string) {
  return /^\/提醒/u.test(text.trimStart());
}

export function openQqPrivateReminders(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qq_private_reminder_preferences (
      account_id TEXT NOT NULL, user_id TEXT NOT NULL, preferences TEXT NOT NULL, PRIMARY KEY(account_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS qq_private_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, user_id TEXT NOT NULL, source_event TEXT NOT NULL,
      due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, text TEXT, state TEXT NOT NULL, attempted_at INTEGER, rule_id INTEGER,
      UNIQUE(account_id,user_id,source_event)
    );
    CREATE INDEX IF NOT EXISTS qq_private_reminders_due ON qq_private_reminders(due_at,id) WHERE state='queued';
    CREATE INDEX IF NOT EXISTS qq_private_reminders_contact ON qq_private_reminders(account_id,user_id,attempted_at DESC);
    UPDATE qq_private_reminders SET text=NULL, state=COALESCE((
      SELECT CASE WHEN status IN ('sent','failed') THEN status ELSE 'unknown' END FROM outbox
      WHERE scope='qq-private:' || account_id || ':' || user_id AND event_id='reminder:' || qq_private_reminders.id
    ),'unknown') WHERE state='sending';
  `);
  if (!db.prepare("PRAGMA table_info(qq_private_reminders)").all().some(column => column.name === "rule_id")) {
    db.exec("ALTER TABLE qq_private_reminders ADD COLUMN rule_id INTEGER");
  }
  const rules = openPrivateReminderRules(db);
  const prefs = db.prepare("SELECT preferences FROM qq_private_reminder_preferences WHERE account_id=? AND user_id=?");
  const putPrefs = db.prepare("INSERT OR REPLACE INTO qq_private_reminder_preferences VALUES(?,?,?)");
  const removePrefs = db.prepare("DELETE FROM qq_private_reminder_preferences WHERE account_id=? AND user_id=?");
  const cancelAll = db.prepare("UPDATE qq_private_reminders SET state='cancelled',text=NULL WHERE account_id=? AND user_id=? AND state='queued'");
  const cancelOne = db.prepare("UPDATE qq_private_reminders SET state='cancelled',text=NULL WHERE account_id=? AND user_id=? AND id=? AND state='queued'");
  const expire = db.prepare("UPDATE qq_private_reminders SET state='expired',text=NULL WHERE state='queued' AND expires_at<=?");
  const hasWork = db.prepare("SELECT 1 FROM qq_private_reminders WHERE state='queued' LIMIT 1");
  const insert = db.prepare(`INSERT INTO qq_private_reminders(account_id,user_id,source_event,due_at,expires_at,text,state)
    VALUES(?,?,?,?,?,?,'queued')`);
  const occurrence = db.prepare(`INSERT INTO qq_private_reminders(account_id,user_id,source_event,due_at,expires_at,state,attempted_at,rule_id)
    VALUES(?,?,?,?,?,'sending',?,?) ON CONFLICT(account_id,user_id,source_event) DO NOTHING`);
  const byEvent = db.prepare("SELECT id,due_at,state FROM qq_private_reminders WHERE account_id=? AND user_id=? AND source_event=?");
  const queue = db.prepare("SELECT * FROM qq_private_reminders WHERE account_id=? AND user_id=? AND state='queued' ORDER BY due_at,id");
  const history = db.prepare(`SELECT id,due_at AS dueAt,state,rule_id AS ruleId FROM qq_private_reminders
    WHERE account_id=? AND user_id=? AND state<>'queued' ORDER BY id DESC LIMIT 8`);
  const due = db.prepare("SELECT * FROM qq_private_reminders WHERE state='queued' AND due_at<=? ORDER BY due_at,id");
  const sent = db.prepare("SELECT attempted_at FROM qq_private_reminders WHERE account_id=? AND user_id=? AND attempted_at>? ORDER BY attempted_at DESC");
  const last = db.prepare(`SELECT r.state AS status, r.attempted_at AS attemptedAt, o.platform_message_id AS platformMessageId
    FROM qq_private_reminders r LEFT JOIN outbox o ON o.scope=? AND o.event_id='reminder:' || r.id
    WHERE r.account_id=? AND r.user_id=? AND r.attempted_at IS NOT NULL ORDER BY r.attempted_at DESC LIMIT 1`);
  const claim = db.prepare("UPDATE qq_private_reminders SET state='sending',attempted_at=? WHERE id=? AND state='queued' AND due_at<=? AND expires_at>?");
  const finish = db.prepare("UPDATE qq_private_reminders SET state=?,text=NULL WHERE id=? AND state='sending'");
  const purge = db.prepare("DELETE FROM qq_private_reminders WHERE state NOT IN ('queued','sending') AND MAX(expires_at,COALESCE(attempted_at,0))<?");

  function read(contact: Contact) {
    const row = prefs.get(contact.accountId, contact.userId);
    return row ? JSON.parse(String(row.preferences)) as Preferences : null;
  }

  function save(contact: Contact, settings: Preferences) {
    putPrefs.run(contact.accountId, contact.userId, JSON.stringify(settings));
  }

  function transaction<T>(apply: () => T): T {
    db.exec("SAVEPOINT private_reminder_change");
    try {
      const result = apply();
      db.exec("RELEASE private_reminder_change");
      return result;
    } catch (error) {
      db.exec("ROLLBACK TO private_reminder_change; RELEASE private_reminder_change");
      throw error;
    }
  }
  function removePending(contact: Contact, now: number, update: () => void) {
    transaction(() => {
      cancelAll.run(contact.accountId, contact.userId);
      rules.cancelAll(contact, now);
      update();
    });
  }

  const list = (contact: Contact) => queue.all(contact.accountId, contact.userId) as unknown as Reminder[];

  function hold(contact: Contact, now: number) {
    const settings = read(contact);
    if (!settings?.subscribed) return "permission";
    if (settings.paused) return "paused";
    const local = conversationWindow(settings, now);
    if (local.quiet) return "quiet";
    const recent = sent.all(contact.accountId, contact.userId, now - 48 * 60 * minute);
    if (recent.length && now - Number(recent[0].attempted_at) < minute) return "spacing";
    if (recent.filter(row => conversationWindow(settings, Number(row.attempted_at)).day === local.day).length >= dailyLimit) return "limit";
    return null;
  }

  return {
    setAccess(contact: Contact, enabled: boolean) {
      const current = read(contact);
      if (enabled && !current) save(contact, defaults);
      if (!enabled && current) removePending(contact, Date.now(), () => removePrefs.run(contact.accountId, contact.userId));
    },
    summary(contact: Contact) {
      const settings = read(contact);
      const queued = list(contact);
      const repeats = rules.list(contact).map(({ text: _text, ...item }) => item);
      const nextAt = Math.min(queued[0]?.due_at ?? Infinity, repeats[0]?.nextAt ?? Infinity);
      const now = Date.now();
      return { settings, queued: queued.length, rules: repeats, nextAt: Number.isFinite(nextAt) ? nextAt : null,
        hold: nextAt <= now ? hold(contact, now) : null,
        schedules: [...queued.map(item => ({ id: item.id, dueAt: item.due_at, state: "queued" })), ...history.all(contact.accountId, contact.userId)],
        lastDelivery: last.get(qqPrivateScope(contact.accountId, contact.userId), contact.accountId, contact.userId) ?? null };
    },
    command(contact: Contact, eventId: string, input: string, now = Date.now()) {
      expire.run(now);
      const settings = read(contact);
      if (!settings) return "这个私聊联系人尚未开放定时提醒。";
      const [command, ...parts] = input.trim().split(/\s+/u);
      if (command === "/提醒订阅") {
        const timeZone = parts[0] ?? settings.timeZone;
        try {
          if (parts.length > 1 || timeZone.length > 64) return "请填写一个时区，例如 Asia/Shanghai。";
          new Intl.DateTimeFormat("zh-CN", { timeZone });
        } catch { return "无法识别该时区，例如可使用 Asia/Shanghai。"; }
        save(contact, { ...settings, subscribed: true, timeZone });
        return `定时提醒已订阅，时区 ${timeZone}。${help}`;
      }
      if (!settings.subscribed) return "请先在这段私聊中发送 /提醒订阅。";
      if (command === "/提醒退订" && !parts.length) {
        removePending(contact, now, () => save(contact, { ...settings, subscribed: false, paused: false }));
        return "已退订，尚未发出的提醒已取消。";
      }
      if ((command === "/提醒暂停" || command === "/提醒恢复") && !parts.length) {
        const paused = command === "/提醒暂停";
        save(contact, { ...settings, paused });
        return paused ? "提醒已暂停，尚未过期的提醒会保留。" : "提醒已恢复。";
      }
      if (command === "/提醒勿扰") {
        const [from, to] = parts[0] === "关闭" && parts.length === 1 ? ["00:00", "00:00"] : parts;
        if (!clock.test(from) || !clock.test(to) || parts.length > 2 || (from === to && parts[0] !== "关闭")) {
          return "请使用 /提醒勿扰 23:00 08:00 或 /提醒勿扰 关闭。";
        }
        save(contact, { ...settings, quietStart: from, quietEnd: to });
        return from === to ? "已关闭提醒勿扰时段。" : `已设勿扰时段 ${from} 至 ${to}（${settings.timeZone}）。`;
      }
      if (command === "/提醒列表" && !parts.length) {
        const entries = list(contact).map(entry =>
          `#${entry.id} ${dateLabel(settings.timeZone, entry.due_at)} ${Array.from(entry.text).slice(0, 40).join("")}`);
        const repeats = rules.list(contact).map(rule =>
          `R${rule.id} ${recurrenceLabel(rule)} (${rule.timeZone}) ${Array.from(rule.text).slice(0, 40).join("")}`);
        return [...entries, ...repeats].join("\n") || "目前没有待发送的提醒。";
      }
      if (command === "/提醒取消") {
        const selection = parts.length === 1 ? reminderId.exec(parts[0]) : null;
        if (!selection) return "请用 /提醒列表 查看编号，再发送 /提醒取消 编号。";
        const id = Number(selection[2]);
        const cancelled = selection[1]?.toUpperCase() === "R" ? rules.cancel(contact, id, now) :
          cancelOne.run(contact.accountId, contact.userId, id).changes;
        return cancelled ? "已取消该提醒。" : "没有可取消的这条提醒。";
      }
      if (command !== "/提醒" || !parts.length) return help;
      const previous = byEvent.get(contact.accountId, contact.userId, eventId);
      if (previous) return `已处理提醒 #${previous.id}。`;
      const priorRule = rules.known(contact, eventId);
      if (priorRule) return `已处理重复提醒 R${priorRule.id}。`;
      const content = input.trim().slice(command.length).trimStart();
      if (list(contact).length + rules.list(contact).length >= queuedLimit) return `一次性待发提醒和重复计划合计最多 ${queuedLimit} 条。`;
      const repeat = readPrivateReminderRecurrence(content, settings.timeZone);
      if (repeat) {
        const scheduled = rules.create(contact, eventId, repeat, now);
        return `已设重复提醒 R${scheduled.id}，${recurrenceLabel(repeat)}（${repeat.timeZone}）。下次 ${dateLabel(repeat.timeZone, scheduled.nextAt)}。`;
      }
      const plan = readPrivateReminderTime(content, settings.timeZone, now);
      if (!plan) return "请填写未来一年内的有效时间和最多 120 字的正文。跨时区时可用 /提醒 30分钟 正文。";
      const id = insert.run(contact.accountId, contact.userId, eventId, plan.dueAt, plan.dueAt + day, plan.text).lastInsertRowid;
      return `已设提醒 #${id}，${dateLabel(settings.timeZone, plan.dueAt)}（${settings.timeZone}）。`;
    },
    pending() { return !!hasWork.get() || rules.pending(); },
    due(now: number) {
      expire.run(now);
      const entries: (Reminder | ReminderOccurrence)[] = [...due.all(now) as unknown as Reminder[], ...rules.due(now)];
      return entries.filter(item => !hold({ accountId: item.account_id, userId: item.user_id }, now))
        .sort((left, right) => left.due_at - right.due_at);
    },
    claim(item: Reminder | ReminderOccurrence, now: number) {
      if (hold({ accountId: item.account_id, userId: item.user_id }, now)) return null;
      if (!item.repeat) return claim.run(now, item.id, now, now).changes ? item.id : null;
      return transaction(() => {
        if (!rules.claim(item, now)) return null;
        const reserved = occurrence.run(item.account_id, item.user_id, `repeat:${item.id}:${item.due_at}`,
          item.due_at, item.expires_at, now, item.id);
        return reserved.changes ? Number(reserved.lastInsertRowid) : null;
      });
    },
    finish(id: number, outcome: Delivery | "duplicate") { finish.run(outcome === "duplicate" ? "unknown" : outcome, id); },
    prune(before: number) { purge.run(before); rules.prune(before); },
  };
}

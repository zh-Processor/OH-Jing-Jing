import { createHash } from "node:crypto";
import type { openStore } from "./store.js";

export type LocalReviewReference = { sourceId: string; conversationId: string; followUpId: string };
export type LocalReminder = { id: string; text: string; dueAt: number; version: number; review?: LocalReviewReference };
export type LocalReminders = { paused: boolean; items: LocalReminder[] };
const idFormat = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const pauseKey = "desktopLocalRemindersPaused";

function reminderId(value: unknown) {
  if (typeof value !== "string" || !idFormat.test(value)) throw new Error("提醒编号无效。");
  return value;
}

function reminderFields(data: { text?: unknown; dueAt?: unknown }) {
  const text = typeof data.text === "string" ? data.text.trim() : "";
  const dueAt = data.dueAt;
  if (!text || Array.from(text).length > 120 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error("请输入一行不超过 120 字的提醒内容。");
  }
  if (typeof dueAt !== "number" || !Number.isSafeInteger(dueAt) || dueAt < 1 || dueAt > 8.64e15) {
    throw new Error("请选择有效的提醒时间。");
  }
  return { text, dueAt };
}

function requireFuture(time: number, now: number) {
  if (time <= now) throw new Error("请选择未来的提醒时间。");
}

export function openDesktopLocalReminders(store: ReturnType<typeof openStore>) {
  const { db } = store;
  db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_local_reminders (
      id TEXT PRIMARY KEY, text TEXT, due_at INTEGER NOT NULL, version INTEGER NOT NULL,
      state TEXT NOT NULL, creation_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS desktop_local_reminders_due ON desktop_local_reminders(due_at,id) WHERE state='active';
  `);
  if (!db.prepare("PRAGMA table_info(desktop_local_reminders)").all().some(column => column.name === "review_json")) {
    db.exec("ALTER TABLE desktop_local_reminders ADD COLUMN review_json TEXT");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS desktop_local_review_active ON desktop_local_reminders(review_json) WHERE state='active' AND review_json IS NOT NULL");
  const active = db.prepare("SELECT id,text,due_at AS dueAt,version,review_json AS review FROM desktop_local_reminders WHERE state='active' ORDER BY due_at,id");
  const previous = db.prepare("SELECT creation_hash FROM desktop_local_reminders WHERE id=?");
  const existingReview = db.prepare("SELECT due_at FROM desktop_local_reminders WHERE state='active' AND review_json=?");
  const insert = db.prepare("INSERT INTO desktop_local_reminders(id,text,due_at,version,state,creation_hash,review_json) VALUES(?,?,?,1,'active',?,?)");
  const edit = db.prepare("UPDATE desktop_local_reminders SET text=?,due_at=?,version=version+1 WHERE id=? AND state='active' AND version=?");
  const snooze = db.prepare(`UPDATE desktop_local_reminders SET due_at=?,version=version+1
    WHERE id=? AND state='active' AND version=? AND due_at<=?`);
  const end = db.prepare("UPDATE desktop_local_reminders SET text=NULL,review_json=NULL,state=?,version=version+1 WHERE id=? AND state='active' AND version=?");
  const read = (): LocalReminders => ({ paused: store.setting(pauseKey, false), items: active.all().map(({ review, ...row }) =>
    ({ ...row, ...(typeof review === "string" ? { review: JSON.parse(review) as LocalReviewReference } : {}) })) as LocalReminder[] });
  return {
    read,
    create(data: { id?: unknown; text?: unknown; dueAt?: unknown }, now = Date.now(), review?: LocalReviewReference) {
      const id = reminderId(data.id);
      const { text, dueAt } = reminderFields(data);
      const reference = review ? JSON.stringify(review) : null;
      const fingerprint = createHash("sha256").update(JSON.stringify(reference ? [text, dueAt, reference] : [text, dueAt])).digest("hex");
      const existing = previous.get(id);
      if (existing) {
        if (existing.creation_hash !== fingerprint) throw new Error("该提醒编号已用于其他内容。");
        return read();
      }
      const attached = reference && existingReview.get(reference);
      if (attached) {
        if (attached.due_at !== dueAt) throw new Error("此事项已有本地提醒，可在提醒页修改时间。");
        return read();
      }
      requireFuture(dueAt, now);
      insert.run(id, text, dueAt, fingerprint, reference);
      return read();
    },
    change(data: { id?: unknown; version?: unknown; action?: unknown; text?: unknown; dueAt?: unknown; minutes?: unknown }, now = Date.now()) {
      const id = reminderId(data.id);
      const { version, action } = data;
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new Error("请刷新后选择提醒。");
      let changed: number | bigint;
      if (action === "edit") {
        const { text, dueAt } = reminderFields(data);
        requireFuture(dueAt, now);
        changed = edit.run(text, dueAt, id, version).changes;
      } else if (action === "snooze" && (data.minutes === 5 || data.minutes === 15)) {
        changed = snooze.run(now + data.minutes * 60_000, id, version, now).changes;
      } else if (action === "complete" || action === "cancel") {
        changed = end.run(action === "complete" ? "completed" : "cancelled", id, version).changes;
      } else throw new Error("请选择有效的提醒操作。");
      if (!changed) throw new Error("提醒已更新，请刷新后重试。");
      return read();
    },
    pause(paused: unknown) {
      if (typeof paused !== "boolean") throw new Error("请选择暂停或恢复提醒。");
      store.saveSetting(pauseKey, paused);
      return read();
    },
  };
}

import type { DatabaseSync } from "node:sqlite";
import type { IncomingPrivateMessage } from "./im-channel.js";
import type { PiLookup } from "./pi-harness.js";

export type QqPrivateContact = { accountId: string; userId: string };
export const qqPrivateReplyUnavailable = "我在，刚才没能答上来。你可以再说一次。";
export const privateHistoryInstruction = '先看当前发言是否明确指向对话里已经发生的事，或要修改已经说过的内容。只有本轮需要补齐那个具体指代时才调用 read_history。' +
  '请求创作一个新故事、给一个新例子，或直接换了话题时，独立完成本轮，不读取历史，也不沿用旧话题里的人物、物件或情境。' +
  '应由你决定的题材、长短和风格属于创作选择。没有注册工具时，可返回 {"action":"private_history"} 请求确实要用的记录。';

export function privateHistoryLookup(read: () => string | undefined): PiLookup {
  return {
    name: "private_history", argument: "recent", label: "本私聊的近期记录",
    instruction: "历史只用于理解当前明确承接的内容。没有相关历史就如实说明。",
    async execute(signal) {
      signal?.throwIfAborted();
      return read() ?? "";
    },
    merge(messages, result) {
      const request = messages.at(-1);
      if (request?.role === "user" && result) request.content = result;
    },
    replyWithoutModel: result => result ? undefined : "这次没能用历史记录继续，能再说一下你指的是哪一段吗？",
  };
}

export function readPrivateHistoryLookup(output: string, prepare: () => string, allowed: () => boolean): PiLookup | undefined {
  const text = output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu, "$1");
  if (text.startsWith("{")) {
    try { if (JSON.parse(text)?.action !== "private_history") return; }
    catch { return; }
  } else if (!/^<｜DSML｜\s*calls>\s*<｜DSML｜\s*invoke name="private_history">\s*<\/｜DSML｜\s*invoke>\s*<\/｜DSML｜\s*calls>$/u.test(text)) return;
  return privateHistoryLookup(() => allowed() ? prepare() : undefined);
}

export function qqPrivateScope(accountId: string, userId: string) {
  return `qq-private:${accountId}:${userId}`;
}

export function privateRecoveryPermission(db: DatabaseSync) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='qq_private_contact_consent'").get()) return;
  const access = db.prepare(`SELECT COALESCE(consent.allowed_at,0) AS allowed_at FROM qq_private_contacts contact
    LEFT JOIN qq_private_contact_consent consent USING (account_id,user_id) WHERE contact.account_id=? AND contact.user_id=?`);
  return (contact: QqPrivateContact, at: number) => {
    const allowedAt = access.get(contact.accountId, contact.userId)?.allowed_at;
    return typeof allowedAt === "number" && at > allowedAt;
  };
}

export function openQqPrivate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qq_private_contacts (
      account_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(account_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS qq_private_contact_consent (
      account_id TEXT NOT NULL, user_id TEXT NOT NULL, allowed_at INTEGER NOT NULL, PRIMARY KEY(account_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS qq_private_message_references (
      message_row INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      platform_message_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS qq_private_reference_message ON qq_private_message_references(platform_message_id);
    CREATE TRIGGER IF NOT EXISTS track_qq_private_consent AFTER INSERT ON qq_private_contacts BEGIN
      INSERT INTO qq_private_contact_consent VALUES (NEW.account_id,NEW.user_id,CAST(unixepoch('subsec') * 1000 AS INTEGER));
    END;
    CREATE TRIGGER IF NOT EXISTS remove_qq_private_consent AFTER DELETE ON qq_private_contacts BEGIN
      DELETE FROM qq_private_contact_consent WHERE account_id=OLD.account_id AND user_id=OLD.user_id;
    END;
  `);
  const contacts = new Map(db.prepare("SELECT account_id, user_id FROM qq_private_contacts").all().map(row => {
    const contact = { accountId: String(row.account_id), userId: String(row.user_id) };
    return [qqPrivateScope(contact.accountId, contact.userId), contact];
  }));
  const insertContact = db.prepare("INSERT OR IGNORE INTO qq_private_contacts VALUES (?, ?)");
  const deleteContact = db.prepare("DELETE FROM qq_private_contacts WHERE account_id = ? AND user_id = ?");
  const event = db.prepare("INSERT OR IGNORE INTO channel_events VALUES (?, ?, ?, ?, ?, '')");
  const eventSeen = db.prepare("SELECT 1 FROM channel_events WHERE account_id=? AND message_id=?");
  const checkpoint = db.prepare("SELECT MAX(created_at) AS last_seen FROM channel_events WHERE scope=? AND created_at>=?");
  const recoveryAllowed = privateRecoveryPermission(db)!;
  const readHistory = db.prepare(`SELECT author AS role, content FROM messages
    WHERE scope = ? AND role_id = ? AND created_at >= ? ORDER BY created_at DESC,id DESC LIMIT 16`);
  const writeHistory = db.prepare("INSERT INTO messages(scope,role_id,author,content,created_at) VALUES(?,?,?,?,?)");
  const rememberReference = db.prepare("INSERT INTO qq_private_message_references(message_row,platform_message_id) VALUES(?,?)");
  const sentReference = db.prepare("SELECT platform_message_id FROM outbox WHERE scope=? AND event_id=? AND status='sent'");
  const deliveryForReference = db.prepare(`SELECT event_id FROM outbox
    WHERE scope=? AND platform_message_id=? AND status='sent' AND created_at>=? LIMIT 2`);
  const readReference = db.prepare(`SELECT m.author, m.content FROM qq_private_message_references r JOIN messages m ON m.id=r.message_row
    WHERE r.platform_message_id=? AND m.scope=? AND m.role_id=? AND m.created_at>=? LIMIT 2`);
  const clearHistory = db.prepare("DELETE FROM messages WHERE scope = ?");
  const deleteOldMessages = db.prepare("DELETE FROM messages WHERE scope GLOB 'qq-private:*' AND created_at < ?");
  const deleteOldEvents = db.prepare("DELETE FROM channel_events WHERE scope GLOB 'qq-private:*' AND created_at < ?");
  const lastDelivery = db.prepare("SELECT status, created_at FROM outbox WHERE scope = ? ORDER BY id DESC LIMIT 1");

  function saveHistory(scope: string, roleId: string, author: "user" | "assistant", content: string, created: string, eventId: string) {
    const reference = author === "user" ? eventId : sentReference.get(scope, eventId)?.platform_message_id;
    db.exec("SAVEPOINT write_qq_private_history");
    try {
      const { lastInsertRowid } = writeHistory.run(scope, roleId, author, content, created);
      if (typeof reference === "string" && reference) rememberReference.run(lastInsertRowid, reference);
      db.exec("RELEASE write_qq_private_history");
    } catch (error) {
      db.exec("ROLLBACK TO write_qq_private_history; RELEASE write_qq_private_history");
      throw error;
    }
  }

  return {
    get(scope: string) { return contacts.get(scope); },
    list(accountId: string | undefined) {
      return [...contacts.values()].filter(contact => !accountId || contact.accountId === accountId).map(contact => ({
        ...contact, lastDelivery: lastDelivery.get(qqPrivateScope(contact.accountId, contact.userId)) ?? null,
      }));
    },
    allow(contact: QqPrivateContact) {
      if (insertContact.run(contact.accountId, contact.userId).changes) {
        contacts.set(qqPrivateScope(contact.accountId, contact.userId), contact);
      }
    },
    revoke(contact: QqPrivateContact, revokeReminders?: () => void) {
      const scope = qqPrivateScope(contact.accountId, contact.userId);
      db.exec("SAVEPOINT revoke_privately");
      try {
        deleteContact.run(contact.accountId, contact.userId);
        clearHistory.run(scope);
        revokeReminders?.();
        db.exec("RELEASE revoke_privately");
      } catch (error) {
        db.exec("ROLLBACK TO revoke_privately; RELEASE revoke_privately");
        throw error;
      }
      contacts.delete(scope);
    },
    accept(scope: string, message: IncomingPrivateMessage, received: string, beforeRecord?: () => void) {
      const eventId = `private:${message.actorId}:${message.messageId}`;
      if (beforeRecord) {
        if (eventSeen.get(message.accountId, eventId)) return false;
        beforeRecord();
      }
      return event.run(message.accountId, eventId, received, scope, message.actorId).changes === 1;
    },
    recoveryCheckpoints(accountId: string, since: number) {
      return [...contacts.values()].flatMap(contact => {
        if (contact.accountId !== accountId) return [];
        const lastSeen = Date.parse(String(checkpoint.get(qqPrivateScope(accountId, contact.userId), new Date(since).toISOString())?.last_seen));
        return Number.isFinite(lastSeen) && recoveryAllowed(contact, lastSeen) ? [{ contact, lastSeen }] : [];
      });
    },
    archive(scope: string, message: IncomingPrivateMessage, at: number, roleId?: string) {
      const contact = contacts.get(scope);
      if (!contact || !recoveryAllowed(contact, at)) return;
      const received = new Date(at).toISOString();
      db.exec("SAVEPOINT recover_qq_private");
      try {
        const inserted = event.run(message.accountId, `private:${message.actorId}:${message.messageId}`, received, scope, message.actorId).changes;
        if (inserted && roleId) saveHistory(scope, roleId, "user", message.message, received, message.messageId);
        db.exec("RELEASE recover_qq_private");
      } catch (error) {
        db.exec("ROLLBACK TO recover_qq_private; RELEASE recover_qq_private");
        throw error;
      }
    },
    history(scope: string, roleId: string, since: string) {
      const rows = readHistory.all(scope, roleId, since) as { role: "user" | "assistant"; content: string }[];
      const dialogue = rows.reverse().filter(row => row.role !== "assistant" || row.content !== qqPrivateReplyUnavailable);
      return dialogue.filter((row, index) => row.role !== "user" ||
        dialogue[index - 1]?.role !== "user" || dialogue[index - 1]?.content !== row.content);
    },
    quote(scope: string, roleId: string, reference: string, since: string) {
      if (!contacts.has(scope)) return;
      const matches = readReference.all(reference, scope, roleId, since);
      const quoted = matches[0];
      if (matches.length !== 1 || typeof quoted.content !== "string") return;
      if (quoted.author === "user") return { speaker: "联系人", text: quoted.content.slice(0, 550) };
      if (quoted.author !== "assistant") return;
      const delivered = deliveryForReference.all(scope, reference, since);
      if (delivered.length !== 1 || typeof delivered[0].event_id !== "string") return;
      const original = readReference.all(delivered[0].event_id, scope, roleId, since);
      const question = original.length === 1 && original[0].author === "user" && typeof original[0].content === "string"
        ? original[0].content.slice(0, 400) : undefined;
      return { speaker: "机器人", text: quoted.content.slice(0, 550), ...(question ? { original: question } : {}) };
    },
    save: saveHistory,
    prune(since: string) {
      deleteOldMessages.run(since);
      deleteOldEvents.run(since);
    },
  };
}

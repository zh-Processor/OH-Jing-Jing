import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { ChannelHistoryRead, ChannelMessage, IncomingGroupRecall } from "./im-channel.js";
import { resolveImPlugin } from "./im-plugins.js";
import { oneBotPlugin } from "./onebot.js";
import { isQqId } from "./qq-channel.js";
import { privateRecoveryPermission } from "./qq-private.js";

export type QqIngressCursor = { feed: string; sequence: number };
type IngressEvent = ChannelMessage | IncomingGroupRecall;
type IngressEntry<Event extends IngressEvent> = { sequence: number; receivedAt: number; message: Event; recoveredAt?: number };
export type QqIngressPage<Event extends IngressEvent = ChannelMessage> = {
  feed: string; online: boolean; lastSequence: number; missed: boolean; entries: IngressEntry<Event>[];
};
const batchSize = 8;
const retention = 24 * 60 * 60_000;
const maxEntries = 20_000;
const maxRecoveryAttempts = 3;
const maxRecoveryResumes = 1000;
const recoveryRetryMs = 1500;
const tokenPattern = /^[\w.~+-]{24,160}$/u;
const feedPattern = /^[0-9a-f-]{36}$/u;

function hash(text: string) { return createHash("sha256").update(text).digest(); }

function readEntry(entry: IngressEntry<IngressEvent>, accountId: string, groupRecalls: boolean) {
  const { sequence, receivedAt, message, recoveredAt } = entry ?? {};
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || !Number.isSafeInteger(receivedAt) || receivedAt <= 0 ||
      !message || message.accountId !== accountId || !isQqId(message.actorId) ||
      typeof message.messageId !== "string" || message.messageId.length === 0 || message.messageId.length > 120) return false;
  if (message.kind === "group-recall") {
    return groupRecalls && recoveredAt === undefined && isQqId(message.groupId) && message.actorId !== accountId;
  }
  return (recoveredAt === undefined || Number.isSafeInteger(recoveredAt) && recoveredAt > 0 && recoveredAt <= receivedAt) &&
    (message.hasVoice === undefined || message.hasVoice === true) &&
    (message.voiceOnly === undefined || (message.voiceOnly === true && message.hasVoice === true)) &&
    typeof message.message === "string" && message.message.length <= 4000 && (message.kind === "private" ||
      message.kind === "group" && isQqId(message.groupId) && typeof message.name === "string" && message.name.length <= 80);
}

export function openQqIngress<WithRecalls extends boolean = false>(address: string, token: string | undefined, accountId: string | undefined,
    pluginId = oneBotPlugin.manifest.id, groupRecalls?: WithRecalls) {
  type Event = WithRecalls extends true ? IngressEvent : ChannelMessage;
  const url = new URL(address);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/" ||
      !url.port || url.username || url.password || url.search || url.hash || !token || !tokenPattern.test(token) || !isQqId(accountId)) {
    throw new Error("QQ 独立收件需要本机 HTTP 地址、独立令牌和预期账号。");
  }
  return async function read(cursor: QqIngressCursor | null, signal: AbortSignal): Promise<QqIngressPage<Event>> {
    const endpoint = new URL("/inbox", url);
    endpoint.searchParams.set("history", "1");
    endpoint.searchParams.set("privateHistory", "1");
    if (groupRecalls) endpoint.searchParams.set("groupRecalls", "1");
    if (cursor) {
      endpoint.searchParams.set("feed", cursor.feed);
      endpoint.searchParams.set("after", String(cursor.sequence));
    }
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
    if (!response.ok) throw new Error("QQ 独立收件暂不可用。");
    const data = await response.json() as QqIngressPage<Event> & { accountId: string; pluginId?: string };
    const after = cursor?.feed === data?.feed ? cursor!.sequence : 0;
    if (!data || data.accountId !== accountId || (data.pluginId ?? oneBotPlugin.manifest.id) !== pluginId ||
        !feedPattern.test(data.feed) || typeof data.online !== "boolean" ||
        typeof data.missed !== "boolean" || !Number.isSafeInteger(data.lastSequence) || data.lastSequence < after ||
        !Array.isArray(data.entries) || data.entries.length > batchSize || data.entries.some((entry, index) =>
          !readEntry(entry, accountId, groupRecalls === true) ||
          entry.sequence <= (index ? data.entries[index - 1].sequence : after) || entry.sequence > data.lastSequence)) {
      throw new Error("QQ 独立收件返回了无法核对的记录。");
    }
    return data;
  };
}

export type QqIngressCollectorOptions = {
  database: string; gateway: string; accountId: string; groups: string[]; privateContacts: string[];
  token: string; gatewayToken?: string; policyDatabase?: string; recoverHistory?: boolean; pluginId?: string;
};
type PendingRecovery = { kind: ChannelMessage["kind"]; scopeId: string; lastSeen: number; ticket: string; before: number | null };

export async function consumeQqRecoveryPages<T>(read: (request: ChannelHistoryRead) => Promise<T[] | null>,
    since: number, stillAllowed: () => boolean, accept: (rows: T[]) => void) {
  const cursors = new Set<number>();
  let before: number | undefined;
  while (stillAllowed()) {
    let next: number | undefined;
    const rows = await read({ since, before, stillAllowed, onIncomplete: cursor => { next = cursor; } });
    if (!rows || !stillAllowed()) return;
    accept(rows);
    if (next === undefined || cursors.has(next) || cursors.size >= maxRecoveryResumes) return;
    cursors.add(next);
    before = next;
  }
}

function withIntakePolicy<T>(database: string, check: (policy: DatabaseSync, setting: (key: string) => unknown) => T): T {
  const policy = new DatabaseSync(database, { readOnly: true });
  try {
    policy.exec("PRAGMA busy_timeout=1000");
    const setting = (key: string) => policy.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value;
    return check(policy, setting);
  } finally { policy.close(); }
}

function groupPolicyAllows(setting: (key: string) => unknown, accountId: string, groupId: string, watchedGroups: Set<string>, history: boolean) {
  const policies = JSON.parse(String(setting("qqGroupPolicies") ?? "{}"));
  const entry = policies?.[`qq:${accountId}:${groupId}`];
  return entry ? entry.observe === true || !history && entry.reply === true : watchedGroups.has(groupId);
}

function policyAllows(database: string, policyKey: string, message: IngressEvent, watchedGroups: Set<string>, recoveredAt?: number) {
  return withIntakePolicy(database, (policy, setting) => {
    if (setting(policyKey) === "false") return false;
    if (message.kind === "private") {
      if (recoveredAt !== undefined) {
        return privateRecoveryPermission(policy)?.({ accountId: message.accountId, userId: message.actorId }, recoveredAt) === true;
      }
      return !!policy.prepare("SELECT 1 FROM qq_private_contacts WHERE account_id=? AND user_id=?").get(message.accountId, message.actorId);
    }
    return groupPolicyAllows(setting, message.accountId, message.groupId, watchedGroups, recoveredAt !== undefined);
  });
}

export function createQqIngressCollector(options: QqIngressCollectorOptions) {
  const { accountId, groups, privateContacts } = options;
  if (!isQqId(accountId) || !tokenPattern.test(options.token) || (options.gatewayToken && options.gatewayToken === options.token) ||
      (options.recoverHistory !== undefined && typeof options.recoverHistory !== "boolean") ||
      !Array.isArray(groups) || !Array.isArray(privateContacts) || ![...groups, ...privateContacts].every(isQqId)) {
    throw new Error("请核对独立收件配置中的账号、范围和令牌。");
  }
  const plugin = resolveImPlugin(options.pluginId);
  const pluginId = plugin.manifest.id;
  const policyKey = `imChannelEnabled:${pluginId}`;
  const channelSettings = { pluginId, enabled: true, address: options.gateway, groups, roleId: "", modelId: "",
    hasToken: !!options.gatewayToken, expectedBotId: accountId, verifyExpectedBot: true };
  const gateway = plugin.create(channelSettings);
  const secret = hash(options.token);
  const watchedGroups = new Set(groups);
  const watchedContacts = new Set(privateContacts);
  const db = new DatabaseSync(options.database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS qq_ingress_identity (slot INTEGER PRIMARY KEY, feed TEXT NOT NULL, account TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qq_ingress_gateway (slot INTEGER PRIMARY KEY, plugin_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qq_ingress_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE NOT NULL, received_at INTEGER NOT NULL, message TEXT NOT NULL,
      recovered_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS qq_ingress_recovery (
      kind TEXT NOT NULL, scope_id TEXT NOT NULL, last_seen INTEGER NOT NULL, ticket TEXT NOT NULL, resume_before INTEGER,
      PRIMARY KEY(kind,scope_id)
    );`);
  let identity: { feed: string; account: string };
  let gatewayPlugin: unknown;
  try {
    db.exec("BEGIN IMMEDIATE");
    if (!db.prepare("PRAGMA table_info(qq_ingress_messages)").all().some(column => column.name === "recovered_at")) {
      db.exec("ALTER TABLE qq_ingress_messages ADD COLUMN recovered_at INTEGER");
    }
    if (!db.prepare("PRAGMA table_info(qq_ingress_recovery)").all().some(column => column.name === "resume_before")) {
      db.exec("ALTER TABLE qq_ingress_recovery ADD COLUMN resume_before INTEGER");
    }
    const previous = db.prepare("SELECT 1 FROM qq_ingress_identity WHERE slot=1").get();
    db.prepare("INSERT OR IGNORE INTO qq_ingress_identity VALUES (1,?,?)").run(randomUUID(), accountId);
    db.prepare("INSERT OR IGNORE INTO qq_ingress_gateway VALUES (1,?)").run(previous ? oneBotPlugin.manifest.id : pluginId);
    identity = db.prepare("SELECT feed,account FROM qq_ingress_identity WHERE slot=1").get() as { feed: string; account: string };
    gatewayPlugin = db.prepare("SELECT plugin_id FROM qq_ingress_gateway WHERE slot=1").get()?.plugin_id;
    db.exec("COMMIT");
  } catch (error) { db.close(); throw error; }
  if (identity.account !== accountId || gatewayPlugin !== pluginId) {
    db.close();
    throw new Error("独立收件数据库已绑定另一个 QQ 账号或渠道协议。");
  }
  const save = db.prepare(`INSERT INTO qq_ingress_messages(event_key,received_at,message,recovered_at) SELECT ?,?,?,?
    WHERE NOT EXISTS (SELECT 1 FROM qq_ingress_messages WHERE event_key=?)`);
  const prune = db.prepare(`DELETE FROM qq_ingress_messages WHERE received_at<? OR sequence<=
    (SELECT COALESCE(MAX(sequence),0)-? FROM qq_ingress_messages)`);
  const range = db.prepare(`SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='qq_ingress_messages'),0) AS last,
    MIN(sequence) AS first FROM qq_ingress_messages`);
  const batch = db.prepare(`SELECT sequence, received_at AS receivedAt, recovered_at AS recoveredAt, message FROM qq_ingress_messages
    WHERE sequence>? AND (?=1 OR recovered_at IS NULL) AND (?=1 OR recovered_at IS NULL OR event_key GLOB 'group:*')
    AND (?=1 OR event_key NOT GLOB 'group-recall:*')
    ORDER BY sequence LIMIT ?`);
  const recentGroups = db.prepare(`SELECT json_extract(message,'$.groupId') AS groupId,MAX(COALESCE(recovered_at,received_at)) AS lastSeen
    FROM qq_ingress_messages WHERE event_key GLOB 'group:*' AND received_at>=? GROUP BY groupId`);
  const recentContacts = db.prepare(`SELECT json_extract(message,'$.actorId') AS userId,MAX(COALESCE(recovered_at,received_at)) AS lastSeen
    FROM qq_ingress_messages WHERE event_key GLOB 'private:*' AND received_at>=? GROUP BY userId`);
  const recoveryColumns = 'kind,scope_id AS scopeId,last_seen AS lastSeen,ticket,resume_before AS "before"';
  const checkpoint = db.prepare(`SELECT ${recoveryColumns} FROM qq_ingress_recovery WHERE kind=? AND scope_id=?`);
  const pending = db.prepare(`SELECT ${recoveryColumns} FROM qq_ingress_recovery ORDER BY kind,scope_id`);
  const hasPending = db.prepare("SELECT 1 FROM qq_ingress_recovery LIMIT 1");
  const remember = db.prepare(`INSERT INTO qq_ingress_recovery(kind,scope_id,last_seen,ticket) VALUES(?,?,?,?)
    ON CONFLICT(kind,scope_id) DO UPDATE SET last_seen=MIN(last_seen,excluded.last_seen),ticket=excluded.ticket,resume_before=NULL`);
  const resume = db.prepare("UPDATE qq_ingress_recovery SET resume_before=? WHERE kind=? AND scope_id=? AND ticket=?");
  const forget = db.prepare("DELETE FROM qq_ingress_recovery WHERE kind=? AND scope_id=? AND ticket=?");
  const recoveryCursors = new Map<string, Set<number>>();
  let generation = 0;
  let stopping = false;
  let recoveryAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let recovery: Promise<void> | undefined;

  function append(message: IngressEvent, recoveredAt?: number) {
    if (message.accountId !== accountId) return;
    const allowed = options.policyDatabase ? policyAllows(options.policyDatabase, policyKey, message, watchedGroups, recoveredAt)
      : message.kind === "private" ? watchedContacts.has(message.actorId) : watchedGroups.has(message.groupId);
    if (!allowed) return;
    const peer = message.kind === "private" ? message.actorId : message.groupId;
    const key = `${message.kind}:${peer}:${message.messageId}` + (message.kind === "group-recall" ? `:${message.actorId}` : "");
    save.run(key, Date.now(), JSON.stringify(message), recoveredAt ?? null, key);
  }

  function captureCheckpoints() {
    if (!options.recoverHistory) return;
    recoveryCursors.clear();
    const since = Date.now() - retention;
    const ticket = randomUUID();
    try {
      for (const group of recentGroups.all(since)) {
        if (isQqId(group.groupId)) remember.run("group", group.groupId, group.lastSeen, ticket);
      }
      const contacts = recentContacts.all(since);
      if (!contacts.length) return;
      const captureContacts = (allowed: (userId: string, at: number) => boolean) => {
        for (const { userId, lastSeen } of contacts) {
          if (!isQqId(userId) || typeof lastSeen !== "number") continue;
          const saved = checkpoint.get("private", userId) as PendingRecovery | undefined;
          if (saved && !allowed(userId, saved.lastSeen)) forget.run(saved.kind, saved.scopeId, saved.ticket);
          if (allowed(userId, lastSeen)) remember.run("private", userId, lastSeen, ticket);
        }
      };
      if (options.policyDatabase) withIntakePolicy(options.policyDatabase, (policy, setting) => {
        const granted = privateRecoveryPermission(policy);
        const enabled = setting(policyKey) !== "false";
        captureContacts((userId, at) => enabled && granted?.({ accountId, userId }, at) === true);
      });
      else captureContacts(userId => watchedContacts.has(userId));
    } catch { process.stderr.write("QQ ingress could not save recovery checkpoints.\n"); }
  }
  async function recover(records: PendingRecovery[], version: number, onlineAt: number) {
    const current = () => generation === version && gateway.status === "online";
    const login = await gateway.checkLogin();
    if (!current() || login.status !== "confirmed" || login.account?.id !== accountId) return false;
    let advanced = false;
    for (const { kind, scopeId, lastSeen, ticket, before } of records) {
      if (!current()) return advanced;
      const scope = `${kind}:${scopeId}`;
      const done = () => {
        forget.run(kind, scopeId, ticket);
        recoveryCursors.delete(scope);
      };
      const read = kind === "group" ? gateway.readRecentGroup?.bind(gateway) : gateway.readRecentPrivate?.bind(gateway);
      const allowed = () => current() && (options.policyDatabase ? withIntakePolicy(options.policyDatabase, (policy, setting) =>
        setting(policyKey) !== "false" && (kind === "group" ? groupPolicyAllows(setting, accountId, scopeId, watchedGroups, true)
          : privateRecoveryPermission(policy)?.({ accountId, userId: scopeId }, lastSeen) === true))
        : (kind === "group" ? watchedGroups : watchedContacts).has(scopeId));
      if (!read || !allowed()) { done(); continue; }
      const floor = Math.max(onlineAt - retention, lastSeen - 1000);
      let incomplete = false;
      let next: number | undefined;
      const history = await read(scopeId, accountId, { since: floor, before: before ?? undefined, stillAllowed: allowed,
        onIncomplete: cursor => { incomplete = true; next = cursor; } });
      if (!current()) return advanced;
      if (!allowed()) { done(); continue; }
      if (!history) continue;
      for (const { message, at } of history.sort((a, b) => a.at - b.at)) {
        if (message.kind === kind && (message.kind === "group" ? message.groupId : message.actorId) === scopeId &&
            at >= floor && at <= onlineAt) append(message, at);
      }
      if (!incomplete) { done(); continue; }
      if (next === undefined || next === before) continue;
      const cursors = recoveryCursors.get(scope) ?? new Set(before === null ? [] : [before]);
      if (cursors.has(next) || cursors.size >= maxRecoveryResumes) continue;
      if (resume.run(next, kind, scopeId, ticket).changes) {
        cursors.add(next);
        recoveryCursors.set(scope, cursors);
        advanced = true;
      }
    }
    return advanced;
  }
  function recoverPending() {
    if (stopping || !options.recoverHistory || gateway.status !== "online" || recovery || retryTimer || recoveryAttempts >= maxRecoveryAttempts) return;
    const records = pending.all() as PendingRecovery[];
    if (!records.length) return;
    const version = generation;
    recoveryAttempts++;
    recovery = recover(records, version, Date.now()).then(advanced => {
      if (advanced && version === generation) recoveryAttempts = 0;
    }).catch(() => { process.stderr.write("QQ ingress history recovery failed.\n"); }).finally(() => {
      recovery = undefined;
      if (stopping || gateway.status !== "online") return;
      if (version !== generation) { recoverPending(); return; }
      if (recoveryAttempts < maxRecoveryAttempts && hasPending.get()) {
        retryTimer = setTimeout(() => { retryTimer = undefined; recoverPending(); }, recoveryRetryMs).unref();
      }
    });
  }
  const server = createServer((req, res) => {
    const bearer = req.headers.authorization?.match(/^Bearer ([\w.~+-]{24,160})$/u)?.[1];
    res.setHeader("Cache-Control", "no-store");
    if (!bearer || !timingSafeEqual(secret, hash(bearer))) { res.writeHead(401).end(); return; }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/inbox") { res.writeHead(404).end(); return; }
    const after = url.searchParams.get("feed") === identity.feed ? Number(url.searchParams.get("after") ?? "0") : 0;
    if (!Number.isSafeInteger(after) || after < 0) { res.writeHead(400).end(); return; }
    const { first, last } = range.get() as { first: number | null; last: number };
    const rows = batch.all(after, Number(url.searchParams.get("history") === "1"),
      Number(url.searchParams.get("privateHistory") === "1"), Number(url.searchParams.get("groupRecalls") === "1"), batchSize) as
      { sequence: number; receivedAt: number; message: string; recoveredAt: number | null }[];
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ feed: identity.feed, accountId, pluginId, online: gateway.status === "online", lastSequence: last,
      missed: after > 0 && after + 1 < (first ?? last + 1), entries: rows.map(({ recoveredAt, message, ...row }) =>
        ({ ...row, message: JSON.parse(message), ...(recoveredAt !== null ? { recoveredAt } : {}) })) }));
  });
  const timer = setInterval(() => prune.run(Date.now() - retention, maxEntries), 60_000);
  timer.unref();
  captureCheckpoints();
  gateway.start(channelSettings, options.gatewayToken ?? null, message => append(message), () => {
    generation++;
    recoveryAttempts = 0;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    captureCheckpoints();
  }, recoverPending, recall => append(recall));
  return { server, async stop() {
    stopping = true;
    clearInterval(timer);
    clearTimeout(retryTimer);
    generation++;
    gateway.stop();
    await recovery;
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  } };
}

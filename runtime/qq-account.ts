import { createHash } from "node:crypto";
import { isQqId, isQzonePostId, qzoneRights, type QzoneVisibility, type SelfAccountResult, type SelfAccountUpdate } from "./qq-channel.js";
import { readPngAvatar } from "./png-avatar.js";
import type { openStore } from "./store.js";

type Policy = { nickname: boolean; avatar: boolean; signature: boolean; groupCards: string[];
  qzone: boolean; spaceVisibility: QzoneVisibility; spaceComment: boolean; spaceLike: boolean; spaceTargets: string[];
  cooldownSeconds: number };
type Operation = { id: string; account_id: string; kind: SelfAccountUpdate["kind"]; fingerprint: string;
  state: SelfAccountResult["state"] | "running"; requested_nickname: string | null; observed_nickname: string | null;
  group_id: string | null; requested_card: string | null; observed_card: string | null;
  requested_signature: string | null; observed_signature: string | null;
  space_owner_id: string | null; space_post_id: string | null; requested_like: number | null; requested_comment: string | null;
  space_parent_comment_id: string | null; space_reply_to_id: string | null;
  requested_visibility: QzoneVisibility | null; platform_id: string | null;
  started_at: string; finished_at: string | null };
const defaults: Policy = { nickname: false, avatar: false, signature: false, groupCards: [], qzone: false,
  spaceVisibility: "self", spaceComment: false, spaceLike: false, spaceTargets: [], cooldownSeconds: 30 };
const visibility = (value: unknown): value is QzoneVisibility => typeof value === "string" && Object.hasOwn(qzoneRights, value);

export function readSelfAccountUpdate(input: unknown): SelfAccountUpdate {
  const data = input as Partial<Record<"kind" | "nickname" | "avatar" | "signature" | "groupId" | "card" | "content" |
    "visibility" | "targetId" | "postId" | "like" | "parentCommentId" | "replyToId" | "commentOffset", unknown>> | null;
  if (data?.kind === "nickname" && typeof data.nickname === "string") {
    const nickname = data.nickname.trim();
    if (nickname && nickname.length <= 80 && !/[\p{Cc}]/u.test(nickname)) return { kind: "nickname", nickname };
    throw new Error("请输入 1 到 80 字符的单行昵称。");
  }
  if (data?.kind === "avatar") return { kind: "avatar", avatar: readPngAvatar(data.avatar, "QQ 头像") };
  if (data?.kind === "signature" && typeof data.signature === "string" && data.signature.length <= 200 && !/[\p{Cc}]/u.test(data.signature)) {
    return { kind: "signature", signature: data.signature.trim() };
  }
  if (data?.kind === "group-card" && isQqId(data.groupId) && typeof data.card === "string" && data.card.length <= 80 && !/[\p{Cc}]/u.test(data.card)) {
    return { kind: "group-card", groupId: data.groupId, card: data.card.trim() };
  }
  if (data?.kind === "qzone") {
    const content = typeof data.content === "string" ? data.content.trim() : "";
    if (!content || content.length > 2000 || content.includes("\0") || !visibility(data.visibility)) {
      throw new Error("请填写 1 到 2000 字符的动态，并指定可见范围。");
    }
    return { kind: "qzone", content, visibility: data.visibility };
  }
  if (data?.kind === "qzone-comment" || data?.kind === "qzone-reply" || data?.kind === "qzone-like") {
    if (!isQqId(data.targetId) || !isQzonePostId(data.postId)) {
      throw new Error("请选择有效的空间所属账号并填写动态编号。");
    }
    if (data.kind === "qzone-like") {
      if (typeof data.like !== "boolean") throw new Error("请选择点赞或取消点赞。");
      return { kind: data.kind, targetId: data.targetId, postId: data.postId, like: data.like };
    }
    const content = typeof data.content === "string" ? data.content.trim() : "";
    if (!content || content.length > 1000 || content.includes("\0")) throw new Error("请填写 1 到 1000 字符的评论。");
    const target = { targetId: data.targetId, postId: data.postId, content };
    if (data.kind === "qzone-comment") return { kind: data.kind, ...target };
    if (!isQzonePostId(data.parentCommentId) || (data.replyToId !== undefined && !isQzonePostId(data.replyToId))) {
      throw new Error("请选择有效的空间评论或回复。");
    }
    const offset = data.commentOffset ?? 0;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000) {
      throw new Error("评论页码无效。");
    }
    return { kind: data.kind, ...target, parentCommentId: data.parentCommentId, replyToId: data.replyToId, commentOffset: offset };
  }
  throw new Error("请选择更新资料或发布动态。");
}

export function readSelfAccountPolicy(input: unknown, previous = defaults): Policy {
  const data = input as Partial<Policy> | null;
  if (typeof data?.nickname !== "boolean" || typeof data.avatar !== "boolean" || typeof data.cooldownSeconds !== "number" ||
      !Number.isSafeInteger(data.cooldownSeconds) || data.cooldownSeconds < 0 || data.cooldownSeconds > 86400 ||
      (data.qzone !== undefined && typeof data.qzone !== "boolean") ||
      (data.signature !== undefined && typeof data.signature !== "boolean") ||
      (data.spaceComment !== undefined && typeof data.spaceComment !== "boolean") ||
      (data.spaceLike !== undefined && typeof data.spaceLike !== "boolean") ||
      (data.groupCards !== undefined && (!Array.isArray(data.groupCards) || !data.groupCards.every(isQqId))) ||
      (data.spaceTargets !== undefined && (!Array.isArray(data.spaceTargets) || !data.spaceTargets.every(isQqId))) ||
      (data.spaceVisibility !== undefined && !visibility(data.spaceVisibility))) {
    throw new Error("请填写账号操作开关和有效的最短间隔。");
  }
  return { nickname: data.nickname, avatar: data.avatar, signature: data.signature ?? previous.signature,
    groupCards: [...new Set(data.groupCards ?? previous.groupCards)], cooldownSeconds: data.cooldownSeconds,
    spaceComment: data.spaceComment ?? previous.spaceComment, spaceLike: data.spaceLike ?? previous.spaceLike,
    spaceTargets: [...new Set(data.spaceTargets ?? previous.spaceTargets)],
    qzone: data.qzone ?? false, spaceVisibility: data.spaceVisibility ?? "self" };
}

function show(operation: Operation) {
  return { id: operation.id, kind: operation.kind, state: operation.state, requestedNickname: operation.requested_nickname,
    observedNickname: operation.observed_nickname, requestedVisibility: operation.requested_visibility, platformId: operation.platform_id,
    groupId: operation.group_id, requestedCard: operation.requested_card, observedCard: operation.observed_card,
    requestedSignature: operation.requested_signature, observedSignature: operation.observed_signature,
    spaceOwnerId: operation.space_owner_id, spacePostId: operation.space_post_id, requestedComment: operation.requested_comment,
    spaceParentCommentId: operation.space_parent_comment_id, spaceReplyToId: operation.space_reply_to_id,
    requestedLike: operation.requested_like === null ? null : operation.requested_like === 1,
    startedAt: operation.started_at, finishedAt: operation.finished_at };
}

export function openQqAccount(store: ReturnType<typeof openStore>) {
  const { db } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS qq_account_actions (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL,
    state TEXT NOT NULL, requested_nickname TEXT, observed_nickname TEXT, started_at TEXT NOT NULL, finished_at TEXT,
    requested_visibility TEXT, platform_id TEXT, group_id TEXT, requested_card TEXT, observed_card TEXT,
    requested_signature TEXT, observed_signature TEXT, space_owner_id TEXT, space_post_id TEXT,
    requested_like INTEGER, requested_comment TEXT, space_parent_comment_id TEXT, space_reply_to_id TEXT
  );
  CREATE INDEX IF NOT EXISTS qq_account_history ON qq_account_actions(account_id,started_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS qq_account_running ON qq_account_actions(account_id) WHERE state='running';`);
  const columns = new Set(db.prepare("PRAGMA table_info(qq_account_actions)").all().map(row => row.name));
  for (const column of ["requested_visibility", "platform_id", "group_id", "requested_card", "observed_card", "requested_signature",
    "observed_signature", "space_owner_id", "space_post_id", "requested_comment", "space_parent_comment_id", "space_reply_to_id"]) {
    if (!columns.has(column)) db.exec(`ALTER TABLE qq_account_actions ADD COLUMN ${column} TEXT`);
  }
  if (!columns.has("requested_like")) db.exec("ALTER TABLE qq_account_actions ADD COLUMN requested_like INTEGER");
  db.prepare("UPDATE qq_account_actions SET state='unknown',finished_at=? WHERE state='running'").run(new Date().toISOString());
  const lookup = db.prepare("SELECT * FROM qq_account_actions WHERE id=?");
  const active = db.prepare("SELECT 1 FROM qq_account_actions WHERE account_id=? AND state='running'");
  const recent = db.prepare("SELECT finished_at FROM qq_account_actions WHERE account_id=? AND state IN ('verified','accepted','unknown') ORDER BY finished_at DESC LIMIT 1");
  const list = db.prepare("SELECT * FROM qq_account_actions WHERE account_id=? ORDER BY started_at DESC LIMIT 20");
  const record = db.prepare(`INSERT INTO qq_account_actions(id,account_id,kind,fingerprint,state,requested_nickname,started_at,
    requested_visibility,group_id,requested_card,requested_signature,space_owner_id,space_post_id,requested_like,requested_comment,
    space_parent_comment_id,space_reply_to_id) VALUES (?,?,?,?,'running',?,?,?,?,?,?,?,?,?,?,?,?)`);
  const finish = db.prepare(`UPDATE qq_account_actions SET state=?,observed_nickname=?,platform_id=?,observed_card=?,observed_signature=?,finished_at=?
    WHERE id=? AND state='running'`);
  const operation = (id: string) => lookup.get(id) as Operation | undefined;
  const policy = (accountId: string) => ({ ...defaults, ...store.setting<Partial<Policy>>(`qqSelfProfile:${accountId}`, {}) });
  function allows(accountId: string, update: SelfAccountUpdate | { kind: "qzone"; visibility: QzoneVisibility }) {
    const current = policy(accountId);
    if (update.kind === "group-card") return current.groupCards.includes(update.groupId);
    if ("postId" in update) {
      return current[update.kind === "qzone-like" ? "spaceLike" : "spaceComment"] && current.spaceTargets.includes(update.targetId);
    }
    return current[update.kind] && (update.kind !== "qzone" || current.spaceVisibility === update.visibility);
  }
  function waitReason(accountId: string, now = Date.now()) {
    if (active.get(accountId)) return "busy" as const;
    const last = Date.parse(String(recent.get(accountId)?.finished_at ?? ""));
    return now - last < policy(accountId).cooldownSeconds * 1000 ? "cooldown" as const : null;
  }
  return {
    policy, allows, waitReason,
    canListSpace(accountId: string, targetId: string) {
      const current = policy(accountId);
      return (current.spaceComment || current.spaceLike) && current.spaceTargets.includes(targetId);
    },
    operation(id: string) { const row = operation(id); return row ? show(row) : undefined; },
    save(accountId: string, next: Policy) { store.saveSetting(`qqSelfProfile:${accountId}`, next); },
    history(accountId: string) { return (list.all(accountId) as unknown as Operation[]).map(show); },
    begin(id: string, accountId: string, update: SelfAccountUpdate, now = Date.now()) {
      const fingerprint = createHash("sha256").update(JSON.stringify(update)).digest("hex");
      const previous = operation(id);
      if (previous) return previous.account_id === accountId && previous.fingerprint === fingerprint
        ? { previous: show(previous) } : { error: "操作编号已用于其他内容。", status: 409 };
      const allowed = policy(accountId);
      if (update.kind === "qzone" && allowed.qzone && allowed.spaceVisibility !== update.visibility) {
        return { error: "空间可见范围与该账号的授权设置不一致。", status: 409 };
      }
      if (!allows(accountId, update)) return { error: "该账号尚未授权此操作或目标。", status: 409 };
      const reason = waitReason(accountId, now);
      if (reason === "busy") return { error: "账号有正在执行的操作。", status: 409 };
      if (reason === "cooldown") return { error: "账号操作仍在最短间隔内。", status: 429 };
      const space = "postId" in update ? update : undefined;
      record.run(id, accountId, update.kind, fingerprint, update.kind === "nickname" ? update.nickname : null,
        new Date(now).toISOString(), update.kind === "qzone" ? update.visibility : null,
        update.kind === "group-card" ? update.groupId : null, update.kind === "group-card" ? update.card : null,
        update.kind === "signature" ? update.signature : null, space?.targetId ?? null, space?.postId ?? null,
        space?.kind === "qzone-like" ? Number(space.like) : null, space && space.kind !== "qzone-like" ? space.content : null,
        space?.kind === "qzone-reply" ? space.parentCommentId : null, space?.kind === "qzone-reply" ? space.replyToId ?? null : null);
      return { started: true };
    },
    finish(id: string, result: SelfAccountResult) {
      finish.run(result.state, result.nickname ?? null, result.platformId ?? null, result.observedCard ?? null,
        result.observedSignature ?? null, new Date().toISOString(), id);
      return show(operation(id)!);
    },
  };
}

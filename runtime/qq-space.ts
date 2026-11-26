import { setTimeout as delay } from "node:timers/promises";
import type { DeliveryStatus } from "./im-channel.js";
import { isQqId, isQzonePostId, qzoneRights, type QzoneCommentPage, type QzoneInteraction, type QzonePostSummary,
  type SelfAccountResult, type SelfAccountUpdate } from "./qq-channel.js";

export type QqSpaceAction = "send_qzone_msg" | "get_qzone_msg_list" | "get_qzone_msg_detail" |
  "comment_qzone" | "like_qzone" | "unlike_qzone";
type SpaceUpdate = Extract<SelfAccountUpdate, { kind: "qzone" }> | QzoneInteraction;
type Action = (name: QqSpaceAction, params: Record<string, unknown>, timeout?: number) =>
  Promise<{ status: DeliveryStatus; data?: unknown }>;
type ConfirmAccount = (accountId: string) => Promise<boolean>;
type PostTarget = { tid: string; target_uin: number };
type Comment = { id: string; uin: string; name: string; content: string; time: number | null };

const pageSize = 20;
const writeTimeout = 20_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function timestamp(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000 ? value : null;
}

function comment(value: unknown): Comment | undefined {
  const row = record(value);
  const uin = String(row?.uin ?? "");
  if (!isQzonePostId(row?.comment_id) || !isQqId(uin) || typeof row.content !== "string") return;
  return { id: row.comment_id, uin, name: typeof row.name === "string" && row.name.length <= 8192 ? row.name : "",
    content: row.content, time: timestamp(row.time) };
}

function replies(value: unknown, parent: Comment) {
  const raw = record(value)?.replies;
  if (!Array.isArray(raw)) return;
  return raw.slice(0, 100).flatMap(value => {
    const row = record(value);
    const reply = comment(row);
    return reply && row?.parent_comment_id === parent.id && String(row.parent_comment_uin) === parent.uin ? [reply] : [];
  });
}

function validOffset(offset: number) {
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000;
}

export class QqSpace {
  constructor(private readonly action: Action, private readonly confirmAccount: ConfirmAccount,
    private readonly requireAuthor: boolean) {}

  async listPosts(accountId: string, targetId: string): Promise<QzonePostSummary[] | null> {
    if (!isQqId(targetId) || !await this.confirmAccount(accountId)) return null;
    const response = await this.action("get_qzone_msg_list", { target_uin: Number(targetId), format: "native" });
    const list = record(response.data)?.msglist;
    if (response.status !== "sent" || !Array.isArray(list) || !await this.confirmAccount(accountId)) return null;
    return list.slice(0, 50).flatMap(value => {
      const row = record(value);
      if (!isQzonePostId(row?.tid) || String(row?.user_id) !== targetId) return [];
      return [{ id: row.tid, excerpt: typeof row.content === "string" ? row.content.slice(0, 240) : "", time: timestamp(row.time) }];
    });
  }

  private async detail(target: PostTarget, offset: number, limit: number) {
    const response = await this.action("get_qzone_msg_detail", { ...target, pos: offset, num: limit });
    const data = record(response.data);
    return response.status === "sent" && data?.tid === target.tid &&
      ((!this.requireAuthor && data.uin === undefined) || String(data.uin) === String(target.target_uin)) ? data : undefined;
  }

  async listComments(accountId: string, targetId: string, postId: string, offset: number): Promise<QzoneCommentPage | null> {
    if (!isQqId(targetId) || !isQzonePostId(postId) || !validOffset(offset) || !await this.confirmAccount(accountId)) return null;
    const detail = await this.detail({ tid: postId, target_uin: Number(targetId) }, offset, pageSize);
    const comments = detail?.comments;
    if (!Array.isArray(comments) || !await this.confirmAccount(accountId)) return null;
    const summarize = (row: Comment, replyable: boolean) => ({ id: row.id, excerpt: row.content.slice(0, 240),
      time: row.time, author: row.name.trim().slice(0, 80) || "空间用户", replyable });
    const threads = comments.slice(0, pageSize).flatMap(value => {
      const row = comment(value);
      return row ? [{ ...summarize(row, true), replies: (replies(value, row) ?? []).map(reply => summarize(reply, !!reply.name.trim())) }] : [];
    });
    const nextOffset = offset + pageSize;
    return { threads, nextOffset: comments.length >= pageSize && nextOffset <= 1000 ? nextOffset : null };
  }

  async update(accountId: string, update: SpaceUpdate, stillAllowed: () => boolean): Promise<SelfAccountResult> {
    if (!await this.confirmAccount(accountId)) return { state: "account-mismatch" };
    if (!stillAllowed()) return { state: "policy-changed" };
    return update.kind === "qzone" ? this.publish(accountId, update, stillAllowed) : this.interact(accountId, update, stillAllowed);
  }

  private async publish(accountId: string, update: Extract<SpaceUpdate, { kind: "qzone" }>,
    allowed: () => boolean): Promise<SelfAccountResult> {
    const response = await this.action("send_qzone_msg", { content: update.content, ugc_right: qzoneRights[update.visibility] }, writeTimeout);
    if (response.status !== "sent") return { state: response.status };
    if (!allowed() || !await this.confirmAccount(accountId) || !allowed()) return { state: "unknown" };
    const id = record(response.data)?.tid;
    if (!isQzonePostId(id)) return { state: "accepted" };
    const detail = await this.detail({ tid: id, target_uin: Number(accountId) }, 0, 1);
    if (!allowed() || !await this.confirmAccount(accountId) || !allowed()) return { state: "unknown" };
    return { state: detail ? "verified" : "accepted", platformId: id };
  }

  private async interact(accountId: string, update: QzoneInteraction, allowed: () => boolean): Promise<SelfAccountResult> {
    const offset = update.kind === "qzone-reply" ? update.commentOffset : 0;
    if (!isQqId(update.targetId) || !isQzonePostId(update.postId) || !validOffset(offset)) return { state: "failed" };
    const target = { tid: update.postId, target_uin: Number(update.targetId) };
    const readDetail = () => this.detail(target, offset, update.kind === "qzone-like" ? 1 : pageSize);
    const replyTarget = (comments: unknown) => {
      if (update.kind !== "qzone-reply" || !Array.isArray(comments)) return;
      const matches = comments.filter(row => record(row)?.comment_id === update.parentCommentId);
      const parent = matches.length === 1 ? comment(matches[0]) : undefined;
      return parent ? { parent, replies: replies(matches[0], parent) } : undefined;
    };
    const before = await readDetail();
    if (!before) return { state: "failed" };
    if (!await this.confirmAccount(accountId)) return { state: "account-mismatch" };
    if (!allowed()) return { state: "policy-changed" };
    if (update.kind === "qzone-like") {
      const receipt = await this.action(update.like ? "like_qzone" : "unlike_qzone", target, writeTimeout);
      if (receipt.status !== "sent") return { state: receipt.status };
      return { state: allowed() && await this.confirmAccount(accountId) && allowed() ? "accepted" : "unknown" };
    }
    const thread = replyTarget(before.comments);
    if (update.kind === "qzone-reply" && !thread) return { state: "failed" };
    const recipientId = update.kind === "qzone-reply" ? update.replyToId : undefined;
    const recipients = recipientId ? thread?.replies?.filter(row => row.id === recipientId) : undefined;
    const recipient = recipients?.length === 1 && recipients[0].name.trim() ? recipients[0] : undefined;
    if (recipientId && !recipient) return { state: "failed" };
    const sentAt = Math.floor(Date.now() / 1000);
    const receipt = await this.action("comment_qzone", { ...target, content: update.content,
      ...(thread && { comment_id: thread.parent.id, comment_uin: Number(thread.parent.uin) }),
      ...(recipient && { reply_uin: Number(recipient.uin), reply_name: recipient.name }) }, writeTimeout);
    if (receipt.status !== "sent") return { state: receipt.status };
    if (!allowed() || !await this.confirmAccount(accountId) || !allowed()) return { state: "unknown" };
    const data = record(receipt.data);
    const parentMatches = !thread || (data?.parent_comment_id === thread.parent.id && String(data?.parent_comment_uin) === thread.parent.uin);
    const receiptId = parentMatches && isQzonePostId(data?.comment_id) ? data.comment_id : undefined;
    const rowsForOperation = (comments: unknown) => {
      if (thread) {
        const current = replyTarget(comments);
        return current?.parent.uin === thread.parent.uin ? current?.replies : undefined;
      }
      return Array.isArray(comments) ? comments.flatMap(row => comment(row) ?? []) : undefined;
    };
    const previous = rowsForOperation(before.comments)?.map(row => row.id);
    const verifiedId = async () => {
      if (!allowed()) return;
      const rows = rowsForOperation((await readDetail())?.comments);
      const own = rows?.filter(row => row.uin === accountId && (row.content === update.content ||
        (recipient && row.content.startsWith("@{uin:" + recipient.uin + ",nick:") && row.content.endsWith(",auto:1} " + update.content))));
      if (receiptId && own?.some(row => row.id === receiptId && !previous?.includes(row.id))) return receiptId;
      if (!previous) return;
      const recent = own?.filter(row => !previous.includes(row.id) && row.time !== null &&
        row.time >= sentAt - 5 && row.time <= Math.floor(Date.now() / 1000) + 5);
      return recent?.length === 1 ? recent[0].id : undefined;
    };
    const firstMatch = await verifiedId();
    const observed = firstMatch ?? await delay(650).then(verifiedId);
    if (!allowed() || !await this.confirmAccount(accountId) || !allowed()) return { state: "unknown" };
    return { state: observed ? "verified" : "accepted", platformId: observed ?? receiptId };
  }
}

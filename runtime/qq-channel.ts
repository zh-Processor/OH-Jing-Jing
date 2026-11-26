import type { ChannelAccount, ChannelMessage, GroupDelivery } from "./im-channel.js";
import type { QqForwardItem } from "./qq-forward.js";

export function isQqId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{3,15}$/.test(value) && Number.isSafeInteger(Number(value));
}

export const qzoneRights = { self: 64, friends: 4, public: 1 } as const;
export type QzoneVisibility = keyof typeof qzoneRights;
export function isQzonePostId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_-]{1,120}$/iu.test(value);
}
export type QzoneInteraction = { targetId: string; postId: string } & (
  { kind: "qzone-comment"; content: string } | { kind: "qzone-like"; like: boolean } |
  { kind: "qzone-reply"; parentCommentId: string; replyToId?: string; commentOffset: number; content: string }
);
export type SelfAccountUpdate = { kind: "nickname"; nickname: string } | { kind: "avatar"; avatar: string } |
  { kind: "signature"; signature: string } | { kind: "group-card"; groupId: string; card: string } |
  { kind: "qzone"; content: string; visibility: QzoneVisibility } | QzoneInteraction;
export type SelfAccountResult = { state: "verified" | "accepted" | "unknown" | "failed" | "account-mismatch" | "unsupported" | "policy-changed";
  nickname?: string; observedSignature?: string; observedCard?: string; platformId?: string };
export const qqAccountCapabilities = ["nickname", "avatar", "signature", "group-card", "qzone", "qzone-comment", "qzone-like", "qzone-reply"] as const;
export type QqAccountCapability = typeof qqAccountCapabilities[number];
export type QqAccountCapabilities = Record<QqAccountCapability, boolean>;
export type QqAccountContractStatus = "declared" | "unavailable" | "unknown";

export function readQqAccountDeclaration(value: unknown, accountId?: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { version, capabilities, account_id } = value as { version?: unknown; capabilities?: unknown; account_id?: unknown };
  if (version !== 1 || (accountId !== undefined && account_id !== accountId) || !Array.isArray(capabilities) ||
      capabilities.length > 32 || capabilities.some(name => typeof name !== "string" || !/^[a-z][a-z-]{0,31}$/u.test(name))) return;
  return new Set<string>(capabilities);
}

export function qqSpaceContract(declaration: ReadonlySet<string> | undefined) {
  const includes = (feature: string) => declaration?.has(feature) === true;
  const comments = includes("qzone-comments");
  return { posts: includes("qzone-posts"), comments, capabilities: { qzone: includes("qzone"),
    "qzone-comment": comments && includes("qzone-comment"), "qzone-like": includes("qzone-like"),
    "qzone-reply": comments && includes("qzone-reply") } };
}

export type QzonePostSummary = { id: string; excerpt: string; time: number | null };
export type QzoneCommentSummary = QzonePostSummary & { author: string; replyable: boolean };
export type QzoneCommentPage = { threads: (QzoneCommentSummary & { replies: QzoneCommentSummary[] })[]; nextOffset: number | null };
export type QqMessageSource = Pick<ChannelMessage, "accountId" | "actorId" | "messageId"> &
  ({ kind: "group"; groupId: string } | { kind: "private" });
export type QqImageSource = QqMessageSource & Pick<ChannelMessage, "images" | "imageCount">;

export interface QqChannelExtensions {
  checkCapabilities(): Promise<{
    software: { name: string | null; version: string | null; protocolVersion: string | null } | null;
    spaceCapabilityCheck: "responded" | "unavailable" | "unknown";
    accountContract?: QqAccountContractStatus;
  }>;
  selfAccountStatus(): Promise<{ account: ChannelAccount | null; capabilities: QqAccountCapabilities; nicknameReadBack: boolean; currentSignature?: string }>;
  updateSelfAccount(accountId: string, update: SelfAccountUpdate, stillAllowed: () => boolean): Promise<SelfAccountResult>;
  listSpacePosts(accountId: string, targetId: string): Promise<QzonePostSummary[] | null>;
  listSpaceComments(accountId: string, targetId: string, postId: string, offset: number): Promise<QzoneCommentPage | null>;
  refreshImageUrls?(message: QqImageSource, stillAllowed: () => boolean, single?: boolean): Promise<string[]>;
  readForward?(message: QqMessageSource, stillAllowed: () => boolean, withVoice?: boolean): Promise<QqForwardItem[]>;
  readVoice(message: ChannelMessage, stillAllowed: () => boolean): Promise<Buffer | null>;
  deliverVoice(message: ChannelMessage, audio: Buffer, stillAllowed: () => boolean): Promise<GroupDelivery>;
}

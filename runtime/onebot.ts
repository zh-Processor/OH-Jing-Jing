import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { ChannelConnectionIssue, ChannelHistoryRead, ChannelMessage, ChannelStatus, DeliveryStatus, GroupDelivery, GroupExpressionAsset, ImChannelGateway, ImChannelPlugin,
  ImChannelSettings, IncomingGroupMessage, IncomingGroupRecall, IncomingPrivateMessage } from "./im-channel.js";
import { isQqId, qqSpaceContract, readQqAccountDeclaration, type QqAccountCapabilities, type QqChannelExtensions,
  type QqImageSource, type QqMessageSource, type QzoneCommentPage, type QzonePostSummary, type SelfAccountResult, type SelfAccountUpdate } from "./qq-channel.js";
import { qqForwardId, qqForwardPlaceholder, readQqForwardCard, readQqForwardContent } from "./qq-forward.js";
import { QqSpace, type QqSpaceAction } from "./qq-space.js";
import { qqImageUrl, qqMarketplaceImage } from "./qq-media.js";
import { qqCqShareLinks, qqShareLink } from "./qq-share.js";
import { maximumVoiceFrame, readVoiceWav, qqVoicePlaceholder } from "./qq-voice.js";

function messageParts(message: unknown) {
  return Array.isArray(message) ? message.filter((part): part is { type: string; data: Record<string, unknown> } =>
    part && typeof part.type === "string" && part.data && typeof part.data === "object") : [];
}

function textMessage(message: unknown, segments = messageParts(message)) {
  const face = (value: unknown) => typeof value === "string" || Number.isSafeInteger(value)
    ? /^\d{1,5}$/u.test(String(value)) ? `[QQ 表情 #${String(value)}]` : "" : "";
  const text = segments.length ? segments.map(part => part.type === "text" ? String(part.data.text ?? "")
    : part.type === "face" ? face(part.data.id) : "").join("")
    : typeof message === "string" ? message.replace(/\[CQ:face,id=(\d+)(?:,[^\]]+)?\]/gi, (_, id) => face(id)).replace(/\[CQ:[^\]]+\]/g, "") : "";
  const shares = segments.length ? segments.map(part => qqShareLink(part.type, part.type === "share" ? part.data.url : part.data.data))
    : typeof message === "string" ? qqCqShareLinks(message) : [];
  return [text.trim(), ...new Set(shares)].filter(Boolean).join("\n").slice(0, 4000);
}

function imageParts(message: unknown, segments = messageParts(message)) {
  const media = segments.filter(part => part.type === "image" || part.type === "mface");
  const raw = typeof message === "string" ? [...message.matchAll(/\[CQ:(?:image|mface)(?:,([^\]]*))?\]/gi)] : [];
  const urls = [...media.map(({ data }) => typeof data.url === "string" && data.url.trim() ? data.url : qqMarketplaceImage(data.emoji_id)),
    ...raw.map(part => part[1]?.match(/(?:^|,)url=([^,]+)/u)?.[1]?.replace(/&amp;/g, "&") ||
      qqMarketplaceImage(part[1]?.match(/(?:^|,)emoji_id=([^,]+)/u)?.[1]))];
  const images = [...new Set(urls.filter((url): url is string => typeof url === "string" && url.length <= 2048))].slice(0, 3);
  const imageCount = media.length + raw.length;
  return { hasImage: imageCount > 0, images, imageCount };
}

function isRecording(type: string) { return type === "record" || type === "voice"; }
function containsVoice(message: unknown, parts = messageParts(message)) {
  return parts.some(part => isRecording(part.type)) || (typeof message === "string" && /\[CQ:(?:record|voice)[,\]]/iu.test(message));
}

function forwardSegment(message: unknown, parts = messageParts(message)) {
  const card = readQqForwardCard(parts.find(part => part.type === "forward"), "message");
  if (card) return card;
  const tagged = typeof message === "string" ? /\[CQ:forward(?:,([^\]]*))?\]/iu.exec(message) : null;
  return tagged ? { id: qqForwardId(tagged[1]?.match(/(?:^|,)id=([^,]+)/u)?.[1]), content: undefined } : undefined;
}
function voiceFile(message: unknown) {
  const part = messageParts(message).find(({ type }) => isRecording(type));
  const value = part?.data.file ?? part?.data.file_id ??
    (typeof message === "string" ? /\[CQ:(?:record|voice),(?:[^\]]*?,)?file(?:_id)?=([^,\]]+)/iu.exec(message)?.[1] : undefined);
  return voiceFileId(value);
}

function voiceFileId(value: unknown) {
  return typeof value === "string" && /^[a-z0-9_-]{8,128}(?:\.(?:silk|amr|wav|mp3|m4a|ogg))?$/iu.test(value) ? value : undefined;
}

function platformMessageId(value: unknown) {
  return (typeof value === "string" || Number.isSafeInteger(value)) && /^-?\d{1,25}$/.test(String(value))
    ? String(value) : undefined;
}

function messageReference(message: unknown, segments: ReturnType<typeof messageParts>, readReference: typeof platformMessageId) {
  const raw = typeof message === "string" ? /\[CQ:reply,id=(-?\d+)(?:,[^\]]+)?\]/.exec(message)?.[1] : undefined;
  return readReference(segments.find(part => part.type === "reply")?.data.id ?? raw);
}

function groupRecall(event: any): IncomingGroupRecall | undefined {
  if (event?.post_type !== "notice" || event.notice_type !== "group_recall") return;
  const accountId = String(event.self_id), groupId = String(event.group_id), actorId = String(event.user_id);
  const messageId = platformMessageId(event.message_id);
  if (!messageId || !isQqId(accountId) || !isQqId(groupId) || !isQqId(actorId) || actorId === accountId) return;
  return { kind: "group-recall", accountId, groupId, actorId, messageId };
}

export function groupMessage(event: any, readReference = platformMessageId): IncomingGroupMessage | null {
  if (event?.post_type !== "message" || event.message_type !== "group") return null;
  if ([event.message_id, event.group_id, event.user_id, event.self_id].some((id) => id == null) ||
      String(event.user_id) === String(event.self_id)) return null;
  const segments = messageParts(event.message);
  const rawMentions = typeof event.message === "string"
    ? [...event.message.matchAll(/\[CQ:at,qq=(\d+)(?:,[^\]]+)?\]/g)] : [];
  const addressed = segments.some((part) => part.type === "at" && String(part.data.qq) === String(event.self_id)) ||
    rawMentions.some(match => match[1] === String(event.self_id));
  const referenceId = messageReference(event.message, segments, readReference);
  const { hasImage, images, imageCount } = imageParts(event.message, segments);
  const hasVoice = containsVoice(event.message, segments);
  const hasForward = !!forwardSegment(event.message, segments);
  const message = textMessage(event.message, segments);
  if (!message && !addressed && !referenceId && !hasImage && !hasVoice && !hasForward) return null;
  const directed = segments.some(part => part.type === "at" || part.type === "reply") ||
    (typeof event.message === "string" && /\[CQ:(?:at|reply)[,\]]/i.test(event.message));
  return {
    kind: "group", accountId: String(event.self_id), groupId: String(event.group_id),
    messageId: String(event.message_id), actorId: String(event.user_id),
    name: String(event.sender?.card || event.sender?.nickname || event.user_id).slice(0, 80),
    message: message || (hasVoice ? qqVoicePlaceholder : hasImage ? "发了一张图片。" : hasForward ? qqForwardPlaceholder :
      addressed ? "有人 @ 你。" : "引用了上一条消息。"),
    referenceId, hasImage, ...(hasImage ? { imageCount } : {}), ...(images.length ? { images } : {}), ...(hasVoice ? { hasVoice: true as const } : {}),
    ...(hasForward ? { hasForward: true as const } : {}),
    ...(hasVoice && !message && !hasImage ? { voiceOnly: true as const } : {}),
    pingOnly: addressed && !message && !hasImage && !hasVoice && !hasForward && !referenceId,
    addressed, directed, bot: event.sender?.is_bot === true,
  };
}

export function privateMessage(event: any, readReference = platformMessageId): IncomingPrivateMessage | null {
  if (event?.post_type !== "message" || event.message_type !== "private" ||
      (event.sub_type != null && event.sub_type !== "friend") || event.sender?.is_bot === true) return null;
  if (typeof event.message_id !== "string" && !Number.isSafeInteger(event.message_id)) return null;
  const accountId = String(event.self_id);
  const actorId = String(event.user_id);
  const messageId = String(event.message_id ?? "");
  if (!isQqId(accountId) || !isQqId(actorId) || accountId === actorId || !messageId || messageId.length > 120) return null;
  const segments = messageParts(event.message);
  const message = textMessage(event.message, segments);
  const referenceId = messageReference(event.message, segments, readReference);
  const { hasImage, images, imageCount } = imageParts(event.message, segments);
  const hasVoice = containsVoice(event.message, segments);
  const hasForward = !!forwardSegment(event.message, segments);
  return message || hasImage || hasVoice || hasForward ? { kind: "private", accountId, actorId, messageId,
    message: message || (hasVoice ? qqVoicePlaceholder : hasImage ? "发了一张图片。" : qqForwardPlaceholder),
    ...(referenceId ? { referenceId } : {}),
    ...(hasImage ? { hasImage, images, imageCount } : {}), ...(hasForward ? { hasForward: true as const } : {}),
    ...(hasVoice ? { hasVoice: true as const } : {}), ...(hasVoice && !message && !hasImage ? { voiceOnly: true as const } : {}) } : null;
}

export function oneBotEndpoint(address: string): URL {
  const url = new URL(address);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "wss:" && !(local && url.protocol === "ws:")) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("OneBot 地址应为 WSS，或使用本机 WS。");
  }
  return url;
}

type ActionResponse = { status: DeliveryStatus; data?: unknown; retcode?: number; replied?: true };
type GatewayVersion = { app_name?: unknown; protocol_version?: unknown; app_version?: unknown; ohjingjing_account?: unknown };

function accountDeclaration(response: ActionResponse) {
  const version = response.data as GatewayVersion | undefined;
  if (response.status !== "sent" || typeof version?.protocol_version !== "string" || !/^v?11$/iu.test(version.protocol_version)) return;
  return readQqAccountDeclaration(version.ohjingjing_account);
}

type OneBotAction = "send_group_msg" | "send_private_msg" | "get_login_info" | "get_status" | "get_version_info" | "get_group_msg_history" |
  "get_friend_msg_history" | "get_msg" | "get_forward_msg" | "get_record" | "can_send_record" | "get_qzone_public_capabilities" |
  "set_qq_profile" | "set_qq_avatar" | "set_self_longnick" | "set_group_card" | "get_group_member_info" |
  "get_stranger_info" | QqSpaceAction;
const connectionTiming = { pollMs: 20_000, pongMs: 5_000, probeMs: 4_000, reconnectMs: 3_500 };
const historyPageSize = 50;
const recoveryPages = 10;
const recoveryTimeoutMs = 12_000;
type HistoryPacket = { message_id?: unknown; message_seq?: unknown; real_seq?: unknown; time?: unknown;
  self_id?: unknown; user_id?: unknown; target_id?: unknown; group_id?: unknown; post_type?: unknown; message_type?: unknown;
  sender?: { user_id?: unknown } };

function reportsUnavailable(data: unknown): boolean {
  const status = data as { online?: unknown; good?: unknown } | undefined;
  return status?.online === false || status?.good === false;
}

export class OneBotConnection implements ImChannelGateway, QqChannelExtensions {
  status: ChannelStatus = "disabled";
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private statusChanged?: () => void;
  private problem: ChannelConnectionIssue | null = null;
  private problemSocket?: WebSocket;
  private contractAccount?: string;
  private pending = new Map<string, (response: ActionResponse) => void>();

  constructor(private readonly timing = connectionTiming) {}

  get connectionIssue() { return this.problem; }

  private recordIssue(socket: WebSocket, kind: ChannelConnectionIssue["kind"]) {
    if (this.socket !== socket || this.problemSocket === socket) return;
    this.problemSocket = socket;
    if (this.problem?.kind !== kind) this.problem = { kind, detectedAt: new Date().toISOString() };
  }

  private closeWithIssue(socket: WebSocket, kind: ChannelConnectionIssue["kind"]) {
    if (this.socket !== socket) return;
    this.recordIssue(socket, kind);
    socket.terminate();
  }

  private setStatus(status: ChannelStatus) {
    if (this.status === status) return;
    this.status = status;
    this.statusChanged?.();
  }

  start(settings: ImChannelSettings, token: string | null, inbound: (message: ChannelMessage) => void, onDisconnect?: () => void,
      onStatusChange?: () => void, onGroupRecall?: (recall: IncomingGroupRecall) => void) {
    this.stop();
    if (!settings.enabled) return;
    if (settings.qqAccountContract !== undefined) {
      if (settings.qqAccountContract !== "ohjingjing-v1" || !isQqId(settings.expectedBotId)) {
        throw new Error("QQ 账号扩展协议需要受支持的版本和明确的机器人账号。");
      }
      this.contractAccount = settings.expectedBotId;
      settings = { ...settings, verifyExpectedBot: true };
    }
    this.statusChanged = onStatusChange;
    const url = oneBotEndpoint(settings.address);
    const connect = () => {
      this.setStatus("connecting");
      const socket = new WebSocket(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        maxPayload: maximumVoiceFrame,
        handshakeTimeout: 8000,
      });
      this.socket = socket;
      this.problemSocket = undefined;
      socket.on("error", error => {
        this.recordIssue(socket, /^Unexpected server response: (?:401|403)$/u.test(error.message) ? "authorization" : "transport-error");
      });
      socket.addEventListener("open", async () => {
        const problem = settings.verifyExpectedBot ? await this.checkGateway(socket, settings) : null;
        if (!this.isOpen(socket)) return;
        if (problem) { this.closeWithIssue(socket, problem); return; }
        this.problem = null;
        this.problemSocket = undefined;
        this.setStatus("online");
        this.monitor(socket, settings);
      });
      socket.addEventListener("close", () => {
        if (this.socket !== socket) return;
        const wasOnline = this.status === "online";
        this.recordIssue(socket, "connection-closed");
        this.setStatus("disconnected");
        for (const request of this.pending.values()) request({ status: "unknown" });
        this.retry = setTimeout(connect, this.timing.reconnectMs);
        if (wasOnline) onDisconnect?.();
      });
      socket.addEventListener("message", ({ data }) => {
        if (this.socket !== socket || typeof data !== "string" || data.length > maximumVoiceFrame) return;
        try {
          const event = JSON.parse(data);
          const reply = this.pending.get(String(event.echo));
          if (reply) {
            reply({ status: event.status === "ok" && event.retcode === 0 ? "sent" : "failed", data: event.data,
              retcode: Number.isSafeInteger(event.retcode) ? event.retcode : undefined, replied: true });
            return;
          }
          if (data.length > 1_000_000) return;
          if (event.post_type === "meta_event" && event.meta_event_type === "heartbeat" && reportsUnavailable(event.status)) {
            this.closeWithIssue(socket, "gateway-offline");
            return;
          }
          if (this.status !== "online") return;
          const recall = onGroupRecall && groupRecall(event);
          if (recall && (!settings.expectedBotId || recall.accountId === settings.expectedBotId)) {
            onGroupRecall?.(recall);
            return;
          }
          const message = groupMessage(event) ?? privateMessage(event);
          if (message) inbound(message);
        } catch {
          // Gateways may send other event types; malformed payloads are ignored.
        }
      });
    };
    connect();
  }

  private isOpen(socket: WebSocket) {
    return this.socket === socket && socket.readyState === WebSocket.OPEN;
  }

  private async checkGateway(socket: WebSocket, settings: ImChannelSettings): Promise<ChannelConnectionIssue["kind"] | null> {
    const [status, login] = await Promise.all([
      this.action("get_status", {}, socket, this.timing.probeMs),
      settings.verifyExpectedBot ? this.readLogin(socket, this.timing.probeMs) : null,
    ]);
    if (status.status === "sent" && reportsUnavailable(status.data)) return "gateway-offline";
    if (!settings.verifyExpectedBot) return null;
    if (login?.status !== "confirmed" || !login.account) return "login-unconfirmed";
    return login.account.id === settings.expectedBotId ? null : "account-mismatch";
  }

  private waitForPong(socket: WebSocket): Promise<void> {
    const challenge = randomBytes(8);
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(deadline);
        socket.off("pong", onPong);
        socket.off("close", done);
        resolve();
      };
      const onPong = (value: Buffer) => { if (value.equals(challenge)) done(); };
      const deadline = setTimeout(() => this.closeWithIssue(socket, "heartbeat-timeout"), this.timing.pongMs).unref();
      socket.on("pong", onPong);
      socket.once("close", done);
      socket.ping(challenge, true, error => { if (error) this.closeWithIssue(socket, "transport-error"); });
    });
  }

  private monitor(socket: WebSocket, settings: ImChannelSettings) {
    const poll = async () => {
      if (!this.isOpen(socket)) return;
      const [, problem] = await Promise.all([this.waitForPong(socket), this.checkGateway(socket, settings)]);
      if (!this.isOpen(socket)) return;
      if (problem) { this.closeWithIssue(socket, problem); return; }
      timer = setTimeout(poll, this.timing.pollMs).unref();
    };
    let timer = setTimeout(poll, this.timing.pollMs).unref();
    socket.once("close", () => clearTimeout(timer));
  }

  async sendGroup(groupId: string, content: string) {
    return (await this.deliverGroup(groupId, content)).status;
  }

  async deliverGroup(groupId: string, content: string): Promise<GroupDelivery> {
    return this.deliverGroupSegments(groupId, [{ type: "text", data: { text: content } }]);
  }

  private async readHistory<T extends ChannelMessage>(action: "get_group_msg_history" | "get_friend_msg_history", params: object,
      accountId: string, history: ChannelHistoryRead | undefined, inScope: (item: HistoryPacket) => boolean,
      normalize: (item: HistoryPacket) => T | null) {
    const socket = this.socket;
    const since = history?.since;
    const before = history?.before;
    const current = () => !!socket && this.isOpen(socket) && this.status === "online" && (history?.stillAllowed?.() ?? true);
    if (!isQqId(accountId) || (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) ||
        (before !== undefined && (!Number.isSafeInteger(before) || before === 0)) || !current()) return null;
    if (history && (await this.readLogin(socket, this.timing.probeMs)).account?.id !== accountId) return null;
    const entries = new Map<string, { message: T; at: number; order: number }>();
    const seen = new Set(before === undefined ? [] : [before]);
    const deadline = Date.now() + recoveryTimeoutMs;
    let cursor = before;
    const pages = history ? recoveryPages : 1;
    for (let page = 0; page < pages; page++) {
      const timeout = Math.min(8000, deadline - Date.now());
      if (!current()) return null;
      if (timeout <= 0) { history?.onIncomplete?.(cursor); break; }
      const result = await this.action(action, { ...params, count: historyPageSize,
        ...(cursor === undefined ? {} : { message_seq: cursor, reverseOrder: true }) }, socket, timeout);
      if (!current()) return null;
      const items = (result.data as { messages?: unknown } | undefined)?.messages;
      if (result.status !== "sent" || !Array.isArray(items)) {
        if (page === 0) return null;
        history?.onIncomplete?.(cursor);
        break;
      }
      const rows = (items.slice(0, 80) as HistoryPacket[]).flatMap(item => {
        if (!item || typeof item !== "object" || !inScope(item) || (item.self_id != null && String(item.self_id) !== accountId)) return [];
        const at = Number(item.time) * 1000;
        const order = Number(item.real_seq);
        return Number.isSafeInteger(at) && at > 0 ? [{ item, at, order: Number.isSafeInteger(order) ? order : 0 }] : [];
      });
      for (const { item, at, order } of rows) {
        if (since !== undefined && at < since) continue;
        const message = normalize(item);
        if (message && !entries.has(message.messageId)) entries.set(message.messageId, { message, at, order });
      }
      if (since === undefined || !items.length || rows.some(row => row.at < since)) break;
      if (!rows.length) { history?.onIncomplete?.(cursor); break; }
      const oldest = rows.sort((a, b) => a.at - b.at || a.order - b.order)[0].item;
      const id = platformMessageId(oldest.message_id);
      const next = Number(id);
      // The live gateway uses its returned message ID as message_seq; real_seq serves only as a sort key.
      if (!id || id !== String(oldest.message_seq) || !Number.isSafeInteger(next) || !next || seen.has(next)) {
        if (items.length >= historyPageSize) history?.onIncomplete?.(cursor);
        break;
      }
      seen.add(next);
      cursor = next;
      if (page === pages - 1) history?.onIncomplete?.(cursor);
    }
    const recovered = [...entries.values()];
    if (history) recovered.sort((a, b) => a.at - b.at || a.order - b.order);
    return recovered.map(({ message, at }) => ({ message, at }));
  }

  async readRecentGroup(groupId: string, accountId: string, history?: ChannelHistoryRead) {
    if (!isQqId(groupId)) return null;
    return this.readHistory("get_group_msg_history", { group_id: Number(groupId) }, accountId, history,
      item => (item.group_id == null || String(item.group_id) === groupId) && (item.message_type == null || item.message_type === "group"),
      item => groupMessage({ ...item, self_id: accountId, group_id: groupId, post_type: "message", message_type: "group" }));
  }

  async readRecentPrivate(userId: string, accountId: string, history?: ChannelHistoryRead) {
    if (!isQqId(userId) || userId === accountId) return null;
    return this.readHistory("get_friend_msg_history", { user_id: Number(userId) }, accountId, history,
      item => String(item.sender?.user_id ?? item.user_id) === userId && (item.user_id == null || String(item.user_id) === userId) &&
        (item.target_id == null || String(item.target_id) === accountId) && item.group_id == null &&
        (item.post_type == null || item.post_type === "message") && (item.message_type == null || item.message_type === "private"),
      item => privateMessage({ ...item, user_id: userId, self_id: accountId, post_type: "message", message_type: "private" }));
  }

  async deliverGroupExpression(groupId: string, content: string, asset: GroupExpressionAsset): Promise<GroupDelivery> {
    const expression = asset.kind === "qq-face" ? { type: "face", data: { id: String(asset.id) } }
      : { type: "image", data: { file: "base64://" + asset.base64 } };
    return this.deliverGroupSegments(groupId, content ? [{ type: "text", data: { text: content } }, expression] : [expression]);
  }

  private async deliverGroupSegments(groupId: string, message: { type: string; data: object }[]): Promise<GroupDelivery> {
    const response = await this.action("send_group_msg", {
      group_id: Number(groupId), message,
    });
    const data = response.data as { message_id?: unknown } | null | undefined;
    return { status: response.status, messageId: response.status === "sent" ? platformMessageId(data?.message_id) : undefined };
  }

  async sendPrivate(actorId: string, content: string) {
    return (await this.deliverPrivate(actorId, content)).status;
  }

  async deliverPrivate(actorId: string, content: string): Promise<GroupDelivery> {
    if (!isQqId(actorId)) return { status: "failed" };
    const response = await this.action("send_private_msg", {
      user_id: Number(actorId), message: [{ type: "text", data: { text: content } }],
    });
    const data = response.data as { message_id?: unknown } | null | undefined;
    return { status: response.status, messageId: response.status === "sent" ? platformMessageId(data?.message_id) : undefined };
  }

  async deliverVoice(message: ChannelMessage, audio: Buffer, stillAllowed: () => boolean): Promise<GroupDelivery> {
    const socket = this.socket;
    const id = message.kind === "group" ? message.groupId : message.actorId;
    if (!socket || !stillAllowed() || !isQqId(id)) return { status: "failed" };
    const [login, available] = await Promise.all([this.readLogin(socket, 2500), this.action("can_send_record", {}, socket, 2500)]);
    if (login.account?.id !== message.accountId) {
      if (login.account) this.closeWithIssue(socket, "account-mismatch");
      return { status: "unknown" };
    }
    if (!stillAllowed() || available.status !== "sent" || (available.data as { yes?: unknown } | undefined)?.yes !== true) {
      return { status: "failed" };
    }
    const segment = { type: "record", data: { file: "base64://" + audio.toString("base64") } };
    const response = message.kind === "group"
      ? await this.action("send_group_msg", { group_id: Number(id), message: [segment] }, socket)
      : await this.action("send_private_msg", { user_id: Number(id), message: [segment] }, socket);
    const data = response.data as { message_id?: unknown } | undefined;
    const messageId = platformMessageId(data?.message_id);
    if (response.status === "sent" && messageId) return { status: "sent", messageId, format: "voice" };
    if (response.status === "failed" && (!response.replied || response.retcode === 1400 || response.retcode === 1404)) {
      return { status: "failed" };
    }
    return { status: "unknown", format: "voice" };
  }

  async checkLogin() {
    return this.readLogin(this.socket);
  }

  private async readLogin(socket: WebSocket | undefined, timeoutMs?: number): ReturnType<ImChannelGateway["checkLogin"]> {
    const response = await this.action("get_login_info", {}, socket, timeoutMs);
    const entry = response.data as { user_id?: unknown; nickname?: unknown } | null;
    const accountId = String(entry?.user_id ?? "");
    if (response.status !== "sent" || !/^\d{4,20}$/.test(accountId)) {
      return { status: response.status === "sent" ? "failed" : response.status, account: null };
    }
    return {
      status: "confirmed" as const,
      account: { id: accountId, nickname: typeof entry?.nickname === "string" ? entry.nickname.slice(0, 80) : "" },
    };
  }

  private async accountContract(socket: WebSocket | undefined): Promise<{
    capabilities: QqAccountCapabilities; posts: boolean; comments: boolean;
  }> {
    const response = await this.action("get_version_info", {}, socket);
    if (this.contractAccount) {
      const declared = accountDeclaration(response);
      const includes = (feature: string) => declared?.has(feature) === true;
      const { capabilities, ...space } = qqSpaceContract(declared);
      return { ...space, capabilities: { nickname: includes("nickname"), avatar: includes("avatar"),
        signature: includes("signature"), "group-card": includes("group-card"), ...capabilities } };
    }
    const version = response.data as GatewayVersion | undefined;
    const profile = response.status === "sent" && typeof version?.app_name === "string" && /^napcat(?:[. -]onebot)?$/iu.test(version.app_name) &&
      /^v?11$/iu.test(String(version.protocol_version ?? ""));
    const pinnedSeries = /^4\.(\d+)\.(\d+)$/u.exec(String(version?.app_version ?? ""));
    const qzone = profile && !!pinnedSeries && (Number(pinnedSeries[1]) > 18 ||
      (Number(pinnedSeries[1]) === 18 && Number(pinnedSeries[2]) >= 42));
    return {
      capabilities: { nickname: profile, avatar: profile, signature: profile, "group-card": profile, qzone,
        "qzone-comment": qzone, "qzone-like": qzone, "qzone-reply": qzone },
      posts: qzone, comments: qzone,
    };
  }

  async selfAccountStatus() {
    const socket = this.socket;
    const [login, { capabilities }] = await Promise.all([this.readLogin(socket), this.accountContract(socket)]);
    const account = login.account;
    const profile = account && capabilities.nickname && (!this.contractAccount || account.id === this.contractAccount)
      ? await this.readAccountProfile(account.id, socket) : undefined;
    return { account: login.account ? { ...login.account, nickname: profile?.nickname ?? login.account.nickname } : null,
      capabilities, nicknameReadBack: profile?.nickname !== undefined, currentSignature: profile?.signature };
  }

  async updateSelfAccount(accountId: string, update: SelfAccountUpdate, stillAllowed: () => boolean): Promise<SelfAccountResult> {
    if (this.contractAccount && accountId !== this.contractAccount) return { state: "account-mismatch" };
    const socket = this.socket;
    if (!(await this.accountContract(socket)).capabilities[update.kind]) return { state: "unsupported" };
    if (update.kind === "qzone" || "postId" in update) return this.space(socket).update(accountId, update, stillAllowed);
    const login = await this.readLogin(socket);
    if (login.account?.id !== accountId) return { state: "account-mismatch" };
    if (!stillAllowed()) return { state: "policy-changed" };
    if (update.kind === "group-card") return this.updateGroupCard(accountId, update, socket, stillAllowed);
    if (update.kind === "signature") {
      const response = await this.action("set_self_longnick", { longNick: update.signature }, socket, 20_000);
      if (response.status !== "sent") return { state: response.status };
      const data = response.data as { result?: unknown } | undefined;
      if (data?.result !== undefined && data.result !== 0) return { state: "failed" };
      const observedSignature = (await this.readAccountProfile(accountId, socket))?.signature;
      return { state: observedSignature === update.signature ? "verified" : "accepted", observedSignature };
    }
    const response = update.kind === "nickname" ? await this.action("set_qq_profile", { nickname: update.nickname }, socket, 20_000) :
      await this.action("set_qq_avatar", { file: "base64://" + update.avatar.split(",", 2)[1] }, socket, 20_000);
    if (response.status !== "sent") return { state: response.status };
    if (update.kind === "avatar") return { state: "accepted" };
    const nickname = (await this.readAccountProfile(accountId, socket))?.nickname;
    return { state: nickname === update.nickname ? "verified" : "accepted", nickname };
  }

  private async readAccountProfile(accountId: string, socket: WebSocket | undefined) {
    const check = await this.action("get_stranger_info", { user_id: Number(accountId), no_cache: true }, socket);
    const profile = check.data as { user_id?: unknown; nickname?: unknown; long_nick?: unknown; longNick?: unknown } | undefined;
    if (check.status !== "sent" || !profile || String(profile.user_id) !== accountId) return undefined;
    const signatures = [profile.longNick, profile.long_nick].filter((value): value is string => typeof value === "string");
    const signature = signatures[0];
    return { nickname: typeof profile.nickname === "string" ? profile.nickname.slice(0, 80) : undefined,
      signature: signature !== undefined && signature.length <= 200 && signatures.every(value => value === signature) ? signature : undefined };
  }

  private async updateGroupCard(accountId: string, update: Extract<SelfAccountUpdate, { kind: "group-card" }>,
      socket: WebSocket | undefined, stillAllowed: () => boolean): Promise<SelfAccountResult> {
    const { groupId, card } = update;
    const member = { group_id: Number(groupId), user_id: Number(accountId) };
    const readCard = async () => {
      const response = await this.action("get_group_member_info", { ...member, no_cache: true }, socket);
      const data = response.data as { group_id?: unknown; user_id?: unknown; card?: unknown } | undefined;
      return response.status === "sent" && String(data?.group_id) === groupId && String(data?.user_id) === accountId &&
        typeof data?.card === "string" ? data.card : undefined;
    };
    if (await readCard() === undefined) return { state: "failed" };
    if (!stillAllowed()) return { state: "policy-changed" };
    const response = await this.action("set_group_card", { ...member, card }, socket, 20_000);
    if (response.status !== "sent") return { state: response.status };
    const observedCard = await readCard();
    return { state: observedCard === card ? "verified" : "accepted", observedCard };
  }

  private space(socket: WebSocket | undefined) {
    return new QqSpace((action, params, timeout) => this.action(action, params, socket, timeout),
      async accountId => (await this.readLogin(socket)).account?.id === accountId, this.contractAccount !== undefined);
  }

  async listSpacePosts(accountId: string, targetId: string): Promise<QzonePostSummary[] | null> {
    if (this.contractAccount && accountId !== this.contractAccount) return null;
    const socket = this.socket;
    if (!(await this.accountContract(socket)).posts) return null;
    return this.space(socket).listPosts(accountId, targetId);
  }

  private async originalMessage(socket: WebSocket, message: QqMessageSource, stillAllowed: () => boolean) {
    if (!stillAllowed() || !platformMessageId(message.messageId) ||
        (await this.readLogin(socket, 2500)).account?.id !== message.accountId || !stillAllowed()) return null;
    const messageResult = await this.action("get_msg", { message_id: message.messageId }, socket, 3000);
    const original = messageResult.data as { message_id?: unknown; message_type?: unknown; user_id?: unknown;
      sender?: { user_id?: unknown }; group_id?: unknown; self_id?: unknown; message?: unknown } | undefined;
    if (messageResult.status !== "sent" || !original || !stillAllowed() || String(original.message_id) !== message.messageId ||
        original.message_type !== message.kind || String(original.user_id ?? original.sender?.user_id) !== message.actorId ||
        (original.sender?.user_id !== undefined && String(original.sender.user_id) !== message.actorId) ||
        (original.self_id !== undefined && String(original.self_id) !== message.accountId) ||
        (message.kind === "group" && String(original.group_id) !== message.groupId)) return null;
    return original.message ?? null;
  }

  async readForward(message: QqMessageSource, stillAllowed: () => boolean, withVoice = false) {
    const socket = this.socket;
    if (!socket) return [];
    const permitted = () => this.isOpen(socket) && stillAllowed();
    const forward = forwardSegment(await this.originalMessage(socket, message, permitted));
    if (!forward || !permitted()) return [];
    const verified = async () => permitted() && (await this.readLogin(socket, 2500)).account?.id === message.accountId && permitted();
    const content = await readQqForwardContent(forward, "message", async id => {
      if (!await verified()) return;
      const result = await this.action("get_forward_msg", { message_id: id, id }, socket, 3500);
      if (result.status !== "sent" || !permitted()) return;
      const data = result.data as { messages?: unknown; message?: unknown } | undefined;
      return data?.messages ?? data?.message ?? data;
    }, permitted, withVoice ? async data => {
      const file = voiceFileId(data.file) ?? voiceFileId(data.file_id);
      return file && await verified() ? this.readRecord(socket, file, message.accountId, permitted) : null;
    } : undefined);
    return content.length && await verified() ? content : [];
  }

  async refreshImageUrls(message: QqImageSource, stillAllowed: () => boolean, single = false) {
    const socket = this.socket;
    if (!socket) return [];
    const permitted = () => this.isOpen(socket) && stillAllowed();
    const { images, imageCount } = imageParts(await this.originalMessage(socket, message, permitted));
    if ((single && imageCount !== 1) || !images.length || !permitted() ||
        (await this.readLogin(socket, 2500)).account?.id !== message.accountId || !permitted()) return [];
    return images.flatMap(url => qqImageUrl(url)?.href ?? []);
  }

  async readVoice(message: ChannelMessage, stillAllowed: () => boolean): Promise<Buffer | null> {
    const socket = this.socket;
    if (!socket || !message.hasVoice) return null;
    const file = voiceFile(await this.originalMessage(socket, message, stillAllowed));
    return file ? this.readRecord(socket, file, message.accountId, stillAllowed) : null;
  }

  private async readRecord(socket: WebSocket, file: string, accountId: string, stillAllowed: () => boolean) {
    if (!this.isOpen(socket) || !stillAllowed()) return null;
    const record = await this.action("get_record", { file, out_format: "wav" }, socket, 5000);
    if (record.status !== "sent" || !stillAllowed() || (await this.readLogin(socket, 2500)).account?.id !== accountId ||
        !stillAllowed()) return null;
    return readVoiceWav((record.data as { base64?: unknown } | undefined)?.base64);
  }

  async listSpaceComments(accountId: string, targetId: string, postId: string, offset: number): Promise<QzoneCommentPage | null> {
    if (this.contractAccount && accountId !== this.contractAccount) return null;
    const socket = this.socket;
    if (!(await this.accountContract(socket)).comments) return null;
    return this.space(socket).listComments(accountId, targetId, postId, offset);
  }

  async checkCapabilities(): ReturnType<QqChannelExtensions["checkCapabilities"]> {
    const [versionResponse, spaceResponse] = await Promise.all([
      this.action("get_version_info", {}),
      this.action("get_qzone_public_capabilities", {}),
    ]);
    const version = versionResponse.data as GatewayVersion | undefined;
    const field = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
    const software = {
      name: field(version?.app_name),
      version: field(version?.app_version),
      protocolVersion: field(version?.protocol_version),
    };
    const hasResult = spaceResponse.data !== null && typeof spaceResponse.data === "object" && !Array.isArray(spaceResponse.data);
    return {
      software: versionResponse.status === "sent" && (software.name || software.version || software.protocolVersion)
        ? software : null,
      spaceCapabilityCheck: spaceResponse.status === "unknown" ? "unknown"
        : spaceResponse.status === "sent" && hasResult ? "responded" : "unavailable",
      ...(this.contractAccount ? { accountContract: versionResponse.status === "unknown" ? "unknown"
        : accountDeclaration(versionResponse) ? "declared" : "unavailable" } : {}),
    };
  }

  private action(action: OneBotAction, params: object, socket = this.socket, timeoutMs = 8000): Promise<ActionResponse> {
    if (socket !== this.socket || socket?.readyState !== WebSocket.OPEN) return Promise.resolve({ status: "failed" });
    if (this.status !== "online" && action !== "get_login_info" && action !== "get_status") return Promise.resolve({ status: "failed" });
    const echo = crypto.randomUUID();
    return new Promise<ActionResponse>((resolve) => {
      const done = (result: ActionResponse) => {
        clearTimeout(timer);
        this.pending.delete(echo);
        resolve(result);
      };
      const timer = setTimeout(() => done({ status: "unknown" }), timeoutMs);
      this.pending.set(echo, done);
      try {
        socket.send(JSON.stringify({ action, echo, params }));
      } catch {
        done({ status: "failed" });
      }
    });
  }

  stop() {
    clearTimeout(this.retry);
    this.contractAccount = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.problem = null;
    this.problemSocket = undefined;
    socket?.terminate();
    for (const request of this.pending.values()) request({ status: "unknown" });
    this.setStatus("disabled");
    this.statusChanged = undefined;
  }
}

export const oneBotPlugin: ImChannelPlugin = {
  manifest: { id: "qq.onebot", platform: "qq", name: "QQ · OneBot", apiVersion: 1,
    capabilities: ["groupText", "groupExpressions", "privateText", "voiceInput", "voiceOutput", "qqProfile", "qqSpace"] },
  create(settings) {
    if (settings?.enabled) oneBotEndpoint(settings.address);
    return new OneBotConnection();
  },
};

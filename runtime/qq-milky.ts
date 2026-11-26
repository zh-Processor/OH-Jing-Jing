import WebSocket from "ws";
import type { ChannelAccount, ChannelConnectionIssue, ChannelHistoryRead, ChannelMessage, ChannelStatus, GroupDelivery, GroupExpressionAsset,
  ImChannelGateway, ImChannelPlugin, ImChannelSettings, IncomingGroupRecall } from "./im-channel.js";
import { groupMessage, privateMessage } from "./onebot.js";
import { isQqId, qqSpaceContract, readQqAccountDeclaration, type QqAccountCapabilities, type QqAccountContractStatus,
  type QqChannelExtensions, type QqImageSource, type QqMessageSource, type SelfAccountResult, type SelfAccountUpdate } from "./qq-channel.js";
import { readQqForwardCard, readQqForwardContent } from "./qq-forward.js";
import { QqSpace } from "./qq-space.js";
import { qqImageUrl, qqMarketplaceImage } from "./qq-media.js";
import { qqRecordUrl, readQqRecord } from "./qq-record-media.js";
import { maximumVoiceFrame } from "./qq-voice.js";

type Scene = "group" | "friend";
type Fields = Record<string, unknown>;
type Segment = { type: string; data: Fields };
type ApiResult = { status: "sent" | "failed" | "unknown"; data?: Fields; authorization?: boolean; offline?: boolean };
type Session = { accountId: string; endpoint: URL; token: string | null; controller: AbortController; socket: WebSocket;
  spaceContract: boolean; software?: { name: string; version: string; protocolVersion: string }; monitor?: ReturnType<typeof setInterval> };
const networkTiming = { handshake: 5000, reconnect: 3500, monitor: 20_000 };
const historyPageSize = 30;
const historyRecoveryPages = 10;
const historyRecoveryDeadlineMs = 12_000;
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);

function fields(input: unknown): Fields | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Fields : undefined;
}

function isResourceId(value: unknown): value is string {
  return typeof value === "string" && !!value.length && value.length <= 2048 && !/[\p{Cc}]/u.test(value);
}

export function milkyEndpoint(address: string) {
  const url = new URL(address);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback.has(url.hostname))) ||
      url.username || url.password || url.search || url.hash) throw new Error("QQ HTTP 网关需要 HTTPS，或使用回环 HTTP 地址。");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function sequence(value: unknown) {
  return (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && /^(?:0|[1-9]\d{0,15})$/u.test(value) && Number.isSafeInteger(Number(value))) ? String(value) : undefined;
}

function messageId(scene: Scene, peer: string, value: unknown) {
  const seq = sequence(value);
  return seq === undefined ? undefined : `milky:${scene}:${peer}:${seq}`;
}

function incomingSegment(value: unknown, scene: Scene, peer: string): Segment | undefined {
  const segment = fields(value);
  const data = fields(segment?.data);
  if (!data) return;
  switch (segment?.type) {
    case "text": return typeof data.text === "string" ? { type: "text", data: { text: data.text } } : undefined;
    case "mention": return { type: "at", data: { qq: data.user_id } };
    case "mention_all": return { type: "at", data: { qq: "all" } };
    case "face": return { type: "face", data: { id: data.face_id } };
    case "reply": return { type: "reply", data: { id: messageId(scene, peer, data.message_seq) } };
    case "image": return { type: "image", data: { url: data.temp_url } };
    case "market_face": return { type: "mface", data: { url: data.url, emoji_id: data.emoji_id } };
    case "record": return { type: "record", data: {} };
    case "forward": return { type: "forward", data: { id: data.forward_id } };
    case "light_app": return { type: "json", data: { data: data.json_payload } };
    case "markdown": return typeof data.content === "string" ? { type: "text", data: { text: data.content } } : undefined;
    default: return undefined;
  }
}

function normalizeMessage(input: unknown, accountId: string, expected?: { scene: Scene; peer: string }) {
  const row = fields(input);
  if (!row || !Array.isArray(row.segments) || (row.message_scene !== "group" && row.message_scene !== "friend")) return;
  const scene = row.message_scene;
  const sender = String(row.sender_id);
  const peer = String(row.peer_id);
  const id = messageId(scene, peer, row.message_seq);
  const at = typeof row.time === "number" ? row.time * 1000 : NaN;
  if (!isQqId(sender) || !isQqId(peer) || !id || !Number.isSafeInteger(at) || at <= 0 || sender === accountId ||
      (expected && (scene !== expected.scene || peer !== expected.peer)) || (scene === "friend" && peer !== sender)) return;
  const parts = row.segments.slice(0, 128).flatMap(part => incomingSegment(part, scene, peer) ?? []);
  const envelope = { message: parts, post_type: "message", self_id: accountId, message_id: id, user_id: sender };
  const groupMember = fields(row.group_member);
  const reference = (value: unknown) => typeof value === "string" ? value : undefined;
  const message = scene === "group"
    ? groupMessage({ ...envelope, message_type: "group", group_id: peer, sender: { card: groupMember?.card, nickname: groupMember?.nickname } },
      reference)
    : privateMessage({ ...envelope, message_type: "private", sub_type: "friend" }, reference);
  if (!message) return;
  return { message, at };
}

async function jsonResponse(response: Response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 2_000_000) { await reader.cancel(); return; }
      parts.push(next.value);
    }
    return fields(JSON.parse(Buffer.concat(parts, size).toString("utf8")));
  } finally { reader.releaseLock(); }
}

export class MilkyConnection implements ImChannelGateway, Partial<QqChannelExtensions> {
  status: ChannelStatus = "disabled";
  connectionIssue: ChannelConnectionIssue | null = null;
  private session?: Session;
  private reconnect?: ReturnType<typeof setTimeout>;
  private notify?: () => void;

  constructor(private readonly timing = networkTiming) {}

  private setStatus(status: ChannelStatus) {
    if (this.status === status) return;
    this.status = status;
    this.notify?.();
  }

  start(settings: ImChannelSettings, token: string | null, inbound: (message: ChannelMessage) => void,
    onDisconnect?: () => void, onStatusChange?: () => void, onGroupRecall?: (recall: IncomingGroupRecall) => void) {
    this.stop();
    this.notify = onStatusChange;
    if (!settings.enabled || settings.paused) return;
    const accountId = settings.expectedBotId;
    if (!isQqId(accountId) || (settings.qqAccountContract !== undefined && settings.qqAccountContract !== "ohjingjing-v1") ||
        (settings.hasToken && !token)) {
      throw new Error("QQ HTTP 网关要求明确账号、可用的已配置令牌和受支持的协议。");
    }
    const endpoint = milkyEndpoint(settings.address);
    const events = new URL("event", endpoint);
    events.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const connect = () => {
      this.setStatus("connecting");
      const socket = new WebSocket(events, { headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        handshakeTimeout: this.timing.handshake, maxPayload: 1_000_000, followRedirects: false });
      const session: Session = { accountId, endpoint, token, controller: new AbortController(), socket,
        spaceContract: settings.qqAccountContract === "ohjingjing-v1" };
      this.session = session;
      socket.on("error", () => {});
      socket.on("unexpected-response", (_, response) => {
        response.resume();
        this.fail(session, response.statusCode === 401 ? "authorization" : "transport-error");
      });
      socket.on("close", () => {
        if (this.session !== session) return;
        const online = this.status === "online";
        session.controller.abort();
        clearInterval(session.monitor);
        this.session = undefined;
        this.connectionIssue ??= { kind: "connection-closed", detectedAt: new Date().toISOString() };
        this.setStatus("disconnected");
        if (online) onDisconnect?.();
        this.reconnect = setTimeout(connect, this.timing.reconnect);
        this.reconnect.unref();
      });
      socket.on("open", () => { void this.establish(session); });
      socket.on("message", (raw, binary) => {
        if (!this.current(session) || binary) return;
        let event: Fields | undefined;
        try { event = fields(JSON.parse(raw.toString())); } catch { return; }
        if (!event || String(event.self_id) !== session.accountId) return;
        if (event.event_type === "bot_offline") { this.fail(session, "gateway-offline"); return; }
        if (event.event_type === "message_recall" && onGroupRecall) {
          const recall = fields(event.data);
          const groupId = String(recall?.peer_id), actorId = String(recall?.sender_id);
          if (recall?.message_scene === "group" && isQqId(groupId) && isQqId(actorId) && actorId !== session.accountId) {
            const id = messageId("group", groupId, recall.message_seq);
            if (id) onGroupRecall({ kind: "group-recall", accountId: session.accountId, groupId, actorId, messageId: id });
          }
          return;
        }
        if (event.event_type !== "message_receive") return;
        const normalized = normalizeMessage(event.data, session.accountId);
        if (normalized) inbound(normalized.message);
      });
    };
    connect();
  }

  stop() {
    const session = this.session;
    this.session = undefined;
    clearTimeout(this.reconnect);
    clearInterval(session?.monitor);
    session?.controller.abort();
    session?.socket.terminate();
    this.connectionIssue = null;
    this.setStatus("disabled");
    this.notify = undefined;
  }

  private current(session: Session) {
    return this.session === session && this.status === "online" && !session.controller.signal.aborted;
  }

  private fail(session: Session, kind: ChannelConnectionIssue["kind"]) {
    if (this.session !== session) return;
    this.connectionIssue = { kind, detectedAt: new Date().toISOString() };
    session.controller.abort();
    session.socket.terminate();
  }

  private async establish(session: Session) {
    const [login, info] = await Promise.all([this.login(session), this.api(session, "get_impl_info", {})]);
    if (this.session !== session || session.controller.signal.aborted) return;
    if (!login) return;
    const { impl_name: name, impl_version: version, milky_version: protocolVersion } = info.data ?? {};
    if (typeof name !== "string" || !name.trim() || typeof version !== "string" ||
        typeof protocolVersion !== "string" || !/^1\.\d{1,3}$/u.test(protocolVersion)) {
      this.fail(session, info.authorization ? "authorization" : "login-unconfirmed");
      return;
    }
    session.software = { name: name.slice(0, 80), version: version.slice(0, 80), protocolVersion };
    this.connectionIssue = null;
    this.setStatus("online");
    session.monitor = setInterval(() => { void this.login(session); }, this.timing.monitor);
    session.monitor.unref();
  }

  private async api(session: Session, action: string, params: Fields, timeout = this.timing.handshake): Promise<ApiResult> {
    if (this.session !== session || session.controller.signal.aborted) return { status: "failed" };
    try {
      const response = await fetch(new URL(`api/${action}`, session.endpoint), {
        method: "POST", redirect: "error", signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(timeout)]),
        headers: { "Content-Type": "application/json", ...(session.token && { Authorization: `Bearer ${session.token}` }) },
        body: JSON.stringify(params),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return response.status === 401 ? { status: "failed", authorization: true } :
          { status: response.status === 404 ? "failed" : "unknown" };
      }
      const result = await jsonResponse(response);
      const data = fields(result?.data);
      if (result?.status === "ok" && result.retcode === 0 && data) return { status: "sent", data };
      if (result?.status === "failed" && (result.retcode === -403 || result.retcode === -400)) {
        return { status: "failed", offline: result.retcode === -403 };
      }
    } catch { /* A timed-out write may have reached the gateway. */ }
    return { status: "unknown" };
  }

  private async login(session: Session): Promise<ChannelAccount | null> {
    const result = await this.api(session, "get_login_info", {});
    if (this.session !== session || session.controller.signal.aborted) return null;
    const id = String(result.data?.uin ?? "");
    const nickname = result.data?.nickname;
    if (!isQqId(id)) this.fail(session, result.authorization ? "authorization" : result.offline ? "gateway-offline" : "login-unconfirmed");
    else if (id !== session.accountId) this.fail(session, "account-mismatch");
    else return { id, nickname: typeof nickname === "string" ? nickname.slice(0, 80) : "" };
    return null;
  }

  async checkLogin(): ReturnType<ImChannelGateway["checkLogin"]> {
    const session = this.session;
    const account = session && this.current(session) ? await this.login(session) : null;
    return { status: account ? "confirmed" : "unknown", account };
  }

  private async send(scene: Scene, peer: string, message: Segment[], allowed = () => true): Promise<GroupDelivery> {
    const session = this.session;
    if (!session || !isQqId(peer) || !this.current(session) || !allowed() || !await this.login(session) || !this.current(session) || !allowed()) {
      return { status: "failed" };
    }
    const group = scene === "group";
    const result = await this.api(session, group ? "send_group_message" : "send_private_message",
      { [group ? "group_id" : "user_id"]: Number(peer), message }, 12_000);
    const id = messageId(scene, peer, result.data?.message_seq);
    return result.status === "sent" && id ? { status: "sent", messageId: id } :
      { status: result.status === "sent" ? "unknown" : result.status };
  }

  deliverGroup(groupId: string, text: string, allowed?: () => boolean) {
    return this.send("group", groupId, [{ type: "text", data: { text } }], allowed);
  }

  deliverPrivate(userId: string, text: string, allowed?: () => boolean) {
    return this.send("friend", userId, [{ type: "text", data: { text } }], allowed);
  }

  async sendPrivate(userId: string, text: string, allowed?: () => boolean) {
    return (await this.deliverPrivate(userId, text, allowed)).status;
  }

  deliverGroupExpression(groupId: string, text: string, asset: GroupExpressionAsset, allowed?: () => boolean) {
    const expression = asset.kind === "qq-face" ? { type: "face", data: { face_id: String(asset.id) } } :
      { type: "image", data: { uri: `base64://${asset.base64}` } };
    return this.send("group", groupId, text ? [{ type: "text", data: { text } }, expression] : [expression], allowed);
  }

  async deliverVoice(message: ChannelMessage, audio: Buffer, allowed: () => boolean): Promise<GroupDelivery> {
    if (message.accountId !== this.session?.accountId || !audio.length || audio.length > maximumVoiceFrame) return { status: "failed" };
    const result = await this.send(message.kind === "group" ? "group" : "friend",
      message.kind === "group" ? message.groupId : message.actorId, [{ type: "record", data: { uri: `base64://${audio.toString("base64")}` } }], allowed);
    return result.status === "failed" ? result : { ...result, format: "voice" };
  }

  private async originalMessage(session: Session, message: QqMessageSource, allowed: () => boolean) {
    if (session.accountId !== message.accountId) return;
    const scene = message.kind === "group" ? "group" : "friend";
    const peer = message.kind === "group" ? message.groupId : message.actorId;
    const seq = sequence(message.messageId.split(":").at(-1));
    const permitted = () => this.current(session) && allowed();
    if (!isQqId(peer) || seq === undefined || messageId(scene, peer, seq) !== message.messageId || !permitted() ||
        !await this.login(session) || !permitted()) return;
    const reply = await this.api(session, "get_message", { message_scene: scene, peer_id: Number(peer), message_seq: Number(seq) }, 3000);
    if (!permitted()) return;
    const original = fields(reply.data?.message);
    const source = normalizeMessage(original, message.accountId, { scene, peer })?.message;
    if (source?.messageId === message.messageId && source.actorId === message.actorId && Array.isArray(original?.segments)) {
      return original.segments.slice(0, 128);
    }
  }

  async readForward(message: QqMessageSource, allowed: () => boolean, withVoice = false) {
    const session = this.session;
    if (!session) return [];
    const permitted = () => this.current(session) && allowed();
    const original = await this.originalMessage(session, message, permitted);
    const forward = readQqForwardCard(original?.find(value => fields(value)?.type === "forward"), "segments");
    if (!forward || !permitted()) return [];
    const verified = async () => permitted() && await this.login(session) && permitted();
    const content = await readQqForwardContent(forward, "segments", async id => {
      if (!await verified()) return;
      const result = await this.api(session, "get_forwarded_messages", { forward_id: id }, 3500);
      return result.status === "sent" && permitted() ? result.data?.messages : undefined;
    }, permitted, withVoice ? async data => await verified() ? this.readRecord(session, data, permitted) : null : undefined);
    return content.length && await verified() ? content : [];
  }

  async refreshImageUrls(message: QqImageSource, allowed: () => boolean, single = false) {
    const session = this.session;
    if (!session) return [];
    const original = await this.originalMessage(session, message, allowed);
    const permitted = () => this.current(session) && allowed();
    if (!original || !permitted()) return [];
    const images = original.filter(segment => fields(segment)?.type === "image" || fields(segment)?.type === "market_face");
    if (single && images.length !== 1) return [];
    const urls = await Promise.all(images.slice(0, 2).map(async segment => {
      const data = fields(segment.data);
      if (!data || !permitted()) return;
      if (segment.type === "market_face") {
        const url = qqImageUrl(data.url)?.href;
        return url && !message.images?.includes(url) ? url : qqMarketplaceImage(data.emoji_id) ?? url;
      }
      const fresh = isResourceId(data.resource_id) ? await this.api(session, "get_resource_temp_url", { resource_id: data.resource_id }, 2500) : undefined;
      return qqImageUrl(fresh?.data?.url)?.href ?? qqImageUrl(data.temp_url)?.href;
    }));
    const safe = urls.filter((url): url is string => !!url);
    return safe.length && permitted() && await this.login(session) && permitted() ? [...new Set(safe)] : [];
  }

  async readVoice(message: ChannelMessage, allowed: () => boolean) {
    const session = this.session;
    if (!session || !message.hasVoice) return null;
    const original = await this.originalMessage(session, message, allowed);
    const record = fields(original?.find(segment => fields(segment)?.type === "record"));
    const data = fields(record?.data);
    return data ? this.readRecord(session, data, () => this.current(session) && allowed()) : null;
  }

  private async readRecord(session: Session, data: Record<string, unknown>, permitted: () => boolean) {
    if (!permitted() || typeof data.duration === "number" && data.duration > 60) return null;
    const signal = AbortSignal.any([session.controller.signal, AbortSignal.timeout(5000)]);
    const mediaAllowed = () => !signal.aborted && permitted();
    const url = qqRecordUrl(data.temp_url);
    const initial = url && await readQqRecord(url, signal, mediaAllowed);
    if (!mediaAllowed()) return null;
    if (initial) return initial;
    if (!isResourceId(data.resource_id)) return null;
    const resource = await this.api(session, "get_resource_temp_url", { resource_id: data.resource_id }, 2500);
    const renewedUrl = qqRecordUrl(resource.data?.url);
    return renewedUrl && renewedUrl.href !== url?.href && mediaAllowed() ? readQqRecord(renewedUrl, signal, mediaAllowed) : null;
  }

  private async history(scene: Scene, peer: string, accountId: string, history?: ChannelHistoryRead) {
    const session = this.session;
    const since = history?.since;
    const before = history?.before;
    const allowed = history?.stillAllowed ?? (() => true);
    if (!session || !this.current(session) || session.accountId !== accountId || !isQqId(peer) ||
        (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) ||
        (before !== undefined && sequence(before) === undefined) || !allowed() || !await this.login(session)) return null;
    const entries = new Map<string, { message: ChannelMessage; at: number }>();
    const pages = since === undefined ? 1 : historyRecoveryPages;
    const deadline = Date.now() + historyRecoveryDeadlineMs;
    let cursor = before;
    for (let page = 0; page < pages; page++) {
      const timeout = Math.min(this.timing.handshake, deadline - Date.now());
      if (!this.current(session) || !allowed()) return null;
      if (timeout <= 0) { history?.onIncomplete?.(cursor); break; }
      const result = await this.api(session, "get_history_messages", { message_scene: scene, peer_id: Number(peer), limit: historyPageSize,
        ...(cursor === undefined ? {} : { start_message_seq: cursor }) }, timeout);
      const items = result.data?.messages;
      if (!this.current(session) || !allowed()) return null;
      if (!Array.isArray(items)) {
        if (page === 0) return null;
        history?.onIncomplete?.(cursor);
        break;
      }
      const rows = items.slice(0, historyPageSize).flatMap(item => normalizeMessage(item, accountId, { scene, peer }) ?? []);
      for (const row of rows) {
        if ((since === undefined || row.at >= since) && !entries.has(row.message.messageId)) entries.set(row.message.messageId, row);
      }
      const next = sequence(result.data?.next_message_seq);
      if (since === undefined || result.data?.next_message_seq == null || rows.some(row => row.at < since)) break;
      if (next === undefined || (cursor !== undefined && Number(next) >= cursor)) {
        history?.onIncomplete?.(cursor);
        break;
      }
      cursor = Number(next);
      if (page === pages - 1) history?.onIncomplete?.(cursor);
    }
    const order = (message: ChannelMessage) => Number(message.messageId.split(":").at(-1));
    return [...entries.values()].sort((a, b) => a.at - b.at || order(a.message) - order(b.message));
  }

  async readRecentGroup(groupId: string, accountId: string, history?: ChannelHistoryRead) {
    return (await this.history("group", groupId, accountId, history))?.flatMap(({ message, at }) => message.kind === "group" ? [{ message, at }] : []) ?? null;
  }

  async readRecentPrivate(userId: string, accountId: string, history?: ChannelHistoryRead) {
    return (await this.history("friend", userId, accountId, history))?.flatMap(({ message, at }) => message.kind === "private" ? [{ message, at }] : []) ?? null;
  }

  async checkCapabilities(): ReturnType<QqChannelExtensions["checkCapabilities"]> {
    const session = this.session;
    const { status } = await this.spaceContract(session);
    return { software: session && this.current(session) ? session.software ?? null : null,
      spaceCapabilityCheck: status === "declared" ? "responded" : status,
      ...(session?.spaceContract && { accountContract: status }) };
  }

  private async spaceContract(session: Session | undefined): Promise<ReturnType<typeof qqSpaceContract> & { status: QqAccountContractStatus }> {
    if (!session?.spaceContract) return { ...qqSpaceContract(undefined), status: "unavailable" };
    if (!this.current(session)) return { ...qqSpaceContract(undefined), status: "unknown" };
    const response = await this.api(session, "get_impl_info", {});
    if (!this.current(session) || response.status === "unknown") return { ...qqSpaceContract(undefined), status: "unknown" };
    const declaration = response.status === "sent" && response.data?.milky_version === session.software?.protocolVersion
      ? readQqAccountDeclaration(response.data?.ohjingjing_account, session.accountId) : undefined;
    return { ...qqSpaceContract(declaration), status: declaration ? "declared" : "unavailable" };
  }

  private space(session: Session) {
    return new QqSpace((action, params, timeout) => this.api(session, action, params, timeout),
      async accountId => this.current(session) && (await this.login(session))?.id === accountId && this.current(session), true);
  }

  private profileCapabilities(session: Session | undefined): QqAccountCapabilities {
    const online = !!session && this.current(session);
    const extended = online && Number(session.software?.protocolVersion.split(".")[1]) >= 1;
    return { nickname: extended, avatar: extended, signature: extended, "group-card": online,
      ...qqSpaceContract(undefined).capabilities };
  }

  async selfAccountStatus(): ReturnType<QqChannelExtensions["selfAccountStatus"]> {
    const session = this.session;
    const { account } = await this.checkLogin();
    const [profile, space] = session && account ? await Promise.all([
      this.api(session, "get_user_profile", { user_id: Number(account.id) }).then(result => result.data),
      this.spaceContract(session),
    ]) : [];
    return { account: account && typeof profile?.nickname === "string" ? { ...account, nickname: profile.nickname.slice(0, 80) } : account,
      capabilities: { ...this.profileCapabilities(session), ...space?.capabilities }, nicknameReadBack: typeof profile?.nickname === "string",
      currentSignature: typeof profile?.bio === "string" ? profile.bio : undefined };
  }

  async listSpacePosts(accountId: string, targetId: string) {
    const session = this.session;
    if (!session || accountId !== session.accountId || !(await this.spaceContract(session)).posts) return null;
    return this.space(session).listPosts(accountId, targetId);
  }

  async listSpaceComments(accountId: string, targetId: string, postId: string, offset: number) {
    const session = this.session;
    if (!session || accountId !== session.accountId || !(await this.spaceContract(session)).comments) return null;
    return this.space(session).listComments(accountId, targetId, postId, offset);
  }

  private async ownGroupCard(session: Session, groupId: string) {
    const { data } = await this.api(session, "get_group_member_info", {
      group_id: Number(groupId), user_id: Number(session.accountId), no_cache: true,
    });
    const member = fields(data?.member);
    if (String(member?.user_id) === session.accountId && String(member?.group_id) === groupId && typeof member?.card === "string") {
      return member.card;
    }
  }

  async updateSelfAccount(accountId: string, update: SelfAccountUpdate, allowed: () => boolean): Promise<SelfAccountResult> {
    const session = this.session;
    if (!session || accountId !== session.accountId) return { state: "account-mismatch" };
    if (update.kind === "qzone" || "postId" in update) {
      if (!(await this.spaceContract(session)).capabilities[update.kind]) return { state: "unsupported" };
      return this.space(session).update(accountId, update, allowed);
    }
    if (!this.profileCapabilities(session)[update.kind]) return { state: "unsupported" };
    if (!allowed()) return { state: "policy-changed" };
    if (!await this.login(session)) return { state: "account-mismatch" };
    if (!this.current(session) || !allowed()) return { state: "policy-changed" };
    let result: ApiResult;
    if (update.kind === "nickname") result = await this.api(session, "set_nickname", { new_nickname: update.nickname }, 18_000);
    else if (update.kind === "signature") result = await this.api(session, "set_bio", { new_bio: update.signature }, 18_000);
    else if (update.kind === "avatar") result = await this.api(session, "set_avatar", { uri: update.avatar.replace(/^data:image\/png;base64,/u, "base64://") }, 18_000);
    else if (update.kind === "group-card" && isQqId(update.groupId)) {
      const currentCard = await this.ownGroupCard(session, update.groupId);
      if (!this.current(session) || !allowed()) return { state: "policy-changed" };
      if (currentCard === undefined) return { state: "failed" };
      result = await this.api(session, "set_group_member_card",
        { group_id: Number(update.groupId), user_id: Number(accountId), card: update.card }, 18_000);
    }
    else return { state: "unsupported" };
    if (result.status !== "sent") return { state: result.status };
    if (!this.current(session) || !allowed() || !await this.login(session) || !allowed()) return { state: "unknown" };
    if (update.kind === "avatar") return { state: "accepted" };
    if (update.kind === "group-card") {
      const observedCard = await this.ownGroupCard(session, update.groupId);
      if (!this.current(session) || !allowed()) return { state: "unknown" };
      return observedCard === update.card ? { state: "verified", observedCard } : { state: "accepted" };
    }
    const { data } = await this.api(session, "get_user_profile", { user_id: Number(accountId) });
    if (!this.current(session) || !allowed()) return { state: "unknown" };
    if (update.kind === "nickname" && data?.nickname === update.nickname) return { state: "verified", nickname: update.nickname };
    if (update.kind === "signature" && data?.bio === update.signature) return { state: "verified", observedSignature: update.signature };
    return { state: "accepted" };
  }
}

export const milkyPlugin: ImChannelPlugin = {
  manifest: { id: "qq.milky", platform: "qq", name: "QQ · Milky", apiVersion: 1,
    capabilities: ["groupText", "groupExpressions", "privateText", "voiceInput", "voiceOutput", "qqProfile", "qqSpace"] },
  create(settings) {
    if (settings?.enabled && (!isQqId(settings.expectedBotId) ||
        (settings.qqAccountContract !== undefined && settings.qqAccountContract !== "ohjingjing-v1"))) {
      throw new Error("QQ HTTP 网关要求预期机器人账号和受支持的账号扩展协议。");
    }
    if (settings?.enabled) milkyEndpoint(settings.address);
    return new MilkyConnection();
  },
};

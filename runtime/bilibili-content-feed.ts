import { createHash, createHmac, randomUUID } from "node:crypto";
import { feedTitle, type PublicFeedItem } from "./public-content-feed.js";

export type BilibiliCreator = { label: string; clientId: string; appSecret: string; accessToken: string; renewal?: BilibiliGrant };
export type BilibiliGrant = { accessToken: string; refreshToken: string; expiresAt: number };
const accountId = /^[a-z][a-z0-9-]{0,39}$/u;
const credential = /^[\x21-\x7e]{1,512}$/u;
const endpoint = "https://member.bilibili.com/arcopen/fn/archive/viewlist?pn=1&ps=50&status=all";
const renewalEndpoint = "https://api.bilibili.com/x/account-oauth2/v1/refresh_token";
const authErrors = new Set([4001, 4002, 122000, 122001, 127000, 127001, 127002, 127003, 127004, 127005, 127006, 127007, 127008, 127010, 127011, 127304, 127305]);

export function readBilibiliGrant(accessToken: unknown, refreshToken: unknown, expiry: unknown): BilibiliGrant | undefined {
  if (typeof accessToken === "string" && credential.test(accessToken) && typeof refreshToken === "string" && credential.test(refreshToken) &&
      typeof expiry === "number" && Number.isSafeInteger(expiry) && expiry > 0 && expiry <= 8_640_000_000_000) {
    return { accessToken, refreshToken, expiresAt: expiry };
  }
}

export function readBilibiliCreators(value?: string): ReadonlyMap<string, BilibiliCreator> {
  if (!value) return new Map();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return new Map(Object.entries(parsed).map(([id, item]) => {
      const label = feedTitle(item?.label);
      if (!accountId.test(id) || !label || label.length > 48 ||
          ![item?.clientId, item?.appSecret, item?.accessToken].every(secret => typeof secret === "string" && credential.test(secret))) {
        throw new Error();
      }
      const hasRenewal = item.refreshToken !== undefined || item.expiresAt !== undefined;
      const renewal = readBilibiliGrant(item.accessToken, item.refreshToken, item.expiresAt);
      if (hasRenewal && !renewal) throw new Error();
      return [`bilibili:${id}`, { label, clientId: item.clientId, appSecret: item.appSecret, accessToken: item.accessToken, renewal }];
    }));
  } catch {
    throw new Error("OHJINGJING_BILIBILI_CREATORS 必须为已授权创作者的有效 JSON 配置。");
  }
}

type Video = { addit_info?: { state?: unknown }; resource_id?: unknown; title?: unknown; ptime?: unknown };

function publishedVideos(body: unknown): PublicFeedItem[] {
  const response = body as { code?: unknown; data?: { list?: unknown } } | null;
  if (typeof response?.code !== "number") throw new Error("feed-format");
  if (authErrors.has(response.code)) throw new Error("feed-authorization");
  if (response.code === 127009 || response.code === 127306) throw new Error("feed-rate-limited");
  if (response.code !== 0) throw new Error("feed-http");
  if (!Array.isArray(response.data?.list)) throw new Error("feed-format");
  const items = new Map<string, PublicFeedItem & { publishedAt: number }>();
  for (const video of response.data.list.slice(0, 50) as (Video | null)[]) {
    const id = video?.resource_id;
    const timestamp = video?.ptime;
    if (video?.addit_info?.state !== 0 || typeof id !== "string" || !/^BV[A-Za-z0-9]{10}$/u.test(id) ||
        typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > 8_640_000_000_000) continue;
    const title = Array.from(feedTitle(video.title)).slice(0, 180).join("");
    if (!title || items.has(id)) continue;
    const key = createHash("sha256").update(id).digest("hex");
    items.set(id, { key, title, link: `https://www.bilibili.com/video/${id}`, publishedAt: timestamp * 1000 });
  }
  return [...items.values()].sort((first, second) => second.publishedAt - first.publishedAt);
}

export async function loadBilibiliFeed(creator: BilibiliCreator, cancel: AbortSignal): Promise<PublicFeedItem[]> {
  const signed = {
    "x-bili-accesskeyid": creator.clientId,
    "x-bili-content-md5": createHash("md5").digest("hex"),
    "x-bili-signature-method": "HMAC-SHA256",
    "x-bili-signature-nonce": randomUUID(),
    "x-bili-signature-version": "2.0",
    "x-bili-timestamp": String(Math.floor(Date.now() / 1000)),
  };
  const canonical = Object.entries(signed).map(([key, value]) => `${key}:${value}`).sort().join("\n");
  const authorization = createHmac("sha256", creator.appSecret).update(canonical).digest("hex");
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(8000)]);
  const response = await fetch(endpoint, { signal, redirect: "error", headers: {
    ...signed, Accept: "application/json", "Content-Type": "application/json", "Access-Token": creator.accessToken, Authorization: authorization,
  } });
  return publishedVideos(await readResponse(response));
}

export async function renewBilibiliGrant(creator: BilibiliCreator, grant: BilibiliGrant): Promise<BilibiliGrant> {
  const url = new URL(renewalEndpoint);
  url.search = new URLSearchParams({ client_id: creator.clientId, client_secret: creator.appSecret,
    grant_type: "refresh_token", refresh_token: grant.refreshToken }).toString();
  const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" } });
  const body = await readResponse(response) as { code?: unknown; data?: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } } | null;
  if (typeof body?.code !== "number") throw new Error("feed-format");
  if (authErrors.has(body.code) || body.code === 122007 || body.code === 122008) throw new Error("feed-authorization");
  if (body.code === 127009 || body.code === 127306) throw new Error("feed-rate-limited");
  if (body.code !== 0) throw new Error("feed-http");
  const renewed = readBilibiliGrant(body.data?.access_token, body.data?.refresh_token, body.data?.expires_in);
  if (!renewed || renewed.refreshToken === grant.refreshToken || renewed.expiresAt * 1000 <= Date.now() || renewed.expiresAt <= grant.expiresAt) {
    throw new Error("feed-authorization");
  }
  return renewed;
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new Error("feed-authorization");
    if (response.status === 429) throw new Error("feed-rate-limited");
    throw new Error("feed-http");
  }
  const stream = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await stream.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > 512 * 1024) throw new Error("feed-too-large");
      chunks.push(chunk.value);
    }
  } finally {
    await stream.cancel().catch(() => {});
    stream.releaseLock();
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Error("feed-format"); }
}

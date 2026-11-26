import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { SaxesParser } from "saxes";

export type PublicFeedItem = { key: string; title: string; link?: string; publishedAt?: number };
const atomNamespace = "http://www.w3.org/2005/Atom";
const jsonFeedVersions = new Set(["https://jsonfeed.org/version/1", "https://jsonfeed.org/version/1.1"]);
const maxFeedBytes = 512 * 1024;
const maxFeedItems = 80;

export function readPublicFeedUrl(value: unknown, base?: URL) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) return undefined;
  let url: URL;
  try { url = new URL(value.trim(), base); } catch { return undefined; }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.href.length > 2048 ||
      !host.includes(".") || host.endsWith(".") || isIP(host) || /(?:^|\.)(?:localhost|local|localdomain|internal|home\.arpa)$/iu.test(host)) return undefined;
  for (const key of url.searchParams.keys()) {
    if (/^(?:api[_-]?key|access[_-]?token|token|auth|password|secret|signature|x-amz-[\w-]+)$/iu.test(key)) return undefined;
  }
  url.hash = "";
  return url;
}

export function feedTitle(value: unknown) {
  return typeof value === "string" ? value.replace(/<[^>]{0,180}>|\[CQ:[^\]]{0,200}\]/giu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim() : "";
}

function collectFeedItem(found: Map<string, PublicFeedItem>, identity: string | undefined, text: unknown, link?: URL) {
  if (!identity || found.size >= maxFeedItems) return;
  const title = Array.from(feedTitle(text)).slice(0, 180).join("");
  if (!title) return;
  const key = createHash("sha256").update(identity).digest("hex");
  if (!found.has(key)) found.set(key, { key, title, ...(link ? { link: link.href } : {}) });
}

function parseJsonFeed(text: string, source: URL) {
  let feed: { version?: unknown; title?: unknown; items?: unknown } | null;
  try { feed = JSON.parse(text); } catch { throw new Error("feed-format"); }
  if (typeof feed?.version !== "string" || !jsonFeedVersions.has(feed.version) ||
      !feedTitle(feed.title) || !Array.isArray(feed.items)) throw new Error("feed-format");
  const found = new Map<string, PublicFeedItem>();
  for (const item of feed.items) {
    if (found.size >= maxFeedItems) break;
    if (typeof item?.id !== "string" || !item.id.trim()) continue;
    const link = readPublicFeedUrl(item.url, source) ?? readPublicFeedUrl(item.external_url, source);
    const title = feedTitle(item.title) || feedTitle(item.summary) || feedTitle(item.content_text) || (link ? "新条目" : "");
    collectFeedItem(found, item.id, title, link);
  }
  return [...found.values()];
}

export function parsePublicFeed(text: string, source: URL): PublicFeedItem[] {
  if (Buffer.byteLength(text) > maxFeedBytes) throw new Error("feed-too-large");
  if (text.trimStart().startsWith("{")) return parseJsonFeed(text.trimStart(), source);
  const parser = new SaxesParser({ xmlns: true });
  let format: "rss" | "atom" | undefined;
  const stack: { name: string; uri: string; base: URL }[] = [];
  let rssChannel = false;
  const found = new Map<string, PublicFeedItem>();
  let item: { depth: number; title: string; id: string; link?: URL; guidLink: boolean } | undefined;
  let capture: { depth: number; kind: "title" | "id" | "link"; text: string; base: URL } | undefined;
  parser.on("doctype", () => { throw new Error("feed-format"); });
  parser.on("error", () => { throw new Error("feed-format"); });
  parser.on("opentag", tag => {
    const parent = stack.at(-1);
    const inherited = parent?.base ?? source;
    let base = inherited;
    const reference = tag.attributes["xml:base"]?.value;
    if (reference) {
      try { base = new URL(reference, inherited); } catch { throw new Error("feed-format"); }
    }
    stack.push({ name: tag.local, uri: tag.uri, base });
    const depth = stack.length;
    if (depth > 32) throw new Error("feed-format");
    if (depth === 1) {
      if (tag.local === "rss" && !tag.uri && tag.attributes.version?.value === "2.0") format = "rss";
      if (tag.local === "feed" && tag.uri === atomNamespace) format = "atom";
      if (!format) throw new Error("feed-format");
      return;
    }
    const atom = format === "atom";
    if (tag.uri !== (atom ? atomNamespace : "")) return;
    if (!atom && depth === 2 && tag.local === "channel") rssChannel = true;
    if (atom ? depth === 2 && tag.local === "entry" : depth === 3 && parent?.name === "channel" && !parent.uri && tag.local === "item") {
      item = { depth, title: "", id: "", guidLink: false };
      return;
    }
    if (!item || depth !== item.depth + 1) return;
    const kind = tag.local === "title" ? "title" : tag.local === (atom ? "id" : "guid") ? "id" : tag.local === "link" && !atom ? "link" : null;
    if (kind) {
      capture = { depth, kind, text: "", base };
      if (kind === "id" && !atom) item.guidLink = tag.attributes.isPermaLink?.value !== "false";
    } else if (atom && tag.local === "link" && !item.link && [undefined, "alternate"].includes(tag.attributes.rel?.value)) {
      item.link = readPublicFeedUrl(tag.attributes.href?.value, base);
    }
  });
  const append = (text: string) => { if (capture && capture.text.length < 4096) capture.text += text.slice(0, 4096 - capture.text.length); };
  parser.on("text", append);
  parser.on("cdata", append);
  parser.on("closetag", () => {
    const depth = stack.length;
    stack.pop();
    if (item && capture?.depth === depth) {
      if (capture.kind === "link") item.link = readPublicFeedUrl(capture.text, capture.base);
      else item[capture.kind] = capture.text.trim();
      capture = undefined;
    }
    if (item?.depth !== depth) return;
    const link = item.link ?? (item.guidLink ? readPublicFeedUrl(item.id) : undefined);
    collectFeedItem(found, item.id || link?.href, item.title, link);
    item = undefined;
  });
  parser.write(text).close();
  if (!format || (format === "rss" && !rssChannel)) throw new Error("feed-format");
  return [...found.values()];
}

const blocked = new BlockList();
for (const [address, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
  blocked.addSubnet(address, bits);
}
blocked.addAddress("168.63.129.16");
for (const [address, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blocked.addSubnet(address, bits, "ipv6");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicFeedAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address);
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

async function pinFeedAddress(url: URL, signal: AbortSignal) {
  let cancel: () => void = () => {};
  try {
    const abort = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
    const addresses = await Promise.race([lookup(url.hostname, { all: true }), abort]);
    if (!addresses.length || addresses.some(({ address }) => !isPublicFeedAddress(address))) throw new Error("feed-address");
    return addresses.find(({ family }) => family === 4) ?? addresses[0];
  } finally { signal.removeEventListener("abort", cancel); }
}

async function readFeedResponse(url: URL, signal: AbortSignal) {
  const pinned = await pinFeedAddress(url, signal);
  return new Promise<{ data: Buffer } | { redirect: string }>((done, fail) => {
    const outgoing = request(url, { signal, agent: false, family: pinned.family,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      headers: { Accept: "application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, application/json;q=0.8, */*;q=0.1",
        "Accept-Encoding": "identity", "User-Agent": "OHJingJing feed reader" },
    }, response => {
      response.on("error", fail);
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        done({ redirect: response.headers.location });
        response.destroy();
        return;
      }
      if (response.statusCode !== 200 || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) {
        fail(new Error("feed-http"));
        response.destroy();
        return;
      }
      let length = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxFeedBytes) {
          fail(new Error("feed-too-large"));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => done({ data: Buffer.concat(chunks) }));
    });
    outgoing.on("error", fail);
    outgoing.end();
  });
}

export async function loadPublicFeed(source: string, cancel: AbortSignal): Promise<PublicFeedItem[]> {
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(8000)]);
  let url = readPublicFeedUrl(source);
  for (let hop = 0; url && hop <= 2; hop++) {
    const reply = await readFeedResponse(url, signal);
    if ("redirect" in reply) { url = readPublicFeedUrl(reply.redirect, url); continue; }
    let text: string;
    try {
      const { data } = reply;
      const encoding = data[0] === 0xff && data[1] === 0xfe ? "utf-16le" : data[0] === 0xfe && data[1] === 0xff ? "utf-16be"
        : /^\s*<\?xml[^?]*\bencoding\s*=\s*["']([\w-]+)["']/iu.exec(data.subarray(0, 200).toString("latin1"))?.[1] ?? "utf-8";
      text = new TextDecoder(encoding, { fatal: true }).decode(data);
    } catch { throw new Error("feed-format"); }
    return parsePublicFeed(text, url);
  }
  throw new Error("feed-redirect");
}

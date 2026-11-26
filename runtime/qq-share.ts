import { publicPage } from "./public-page.js";

function biliShareLink(value: string) {
  if (value.length > 2048 || /\s/u.test(value) || !/^https?:\/\//iu.test(value)) return;
  const input = URL.parse(value);
  if (!input || input.username || input.password || input.port) return;
  const short = input.hostname === "b23.tv" && /^\/[a-z0-9]{1,24}\/?$/iu.test(input.pathname);
  const video = ["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(input.hostname) &&
    /^\/video\/(?:BV[A-Za-z0-9]{10}|av[0-9]{1,20})\/?$/u.test(input.pathname);
  if (!short && !video) return;
  const link = new URL(`https://${short ? "b23.tv" : "www.bilibili.com"}${input.pathname.replace(/\/$/u, "")}`);
  for (const [key, pattern] of [["p", /^\d{1,6}$/u], ["t", /^\d{1,7}(?:\.\d{1,3})?$/u]] as const) {
    const value = input.searchParams.get(key);
    if (value && pattern.test(value)) link.searchParams.set(key, value);
  }
  return link.href;
}

export function qqShareLink(type: string, data: unknown) {
  if (typeof data !== "string") return;
  if (type === "share") return biliShareLink(data) ?? publicPage(data)?.href;
  if (type !== "json" || data.length > 24_000) return;
  try {
    const card = JSON.parse(data);
    const link = card?.app === "com.tencent.miniapp_01" ? card.meta?.detail_1?.qqdocurl
      : card?.app === "com.tencent.structmsg" ? card.meta?.news?.jumpUrl : undefined;
    return typeof link === "string" ? biliShareLink(link) : undefined;
  } catch { return undefined; }
}

const cqEscapes: Record<string, string> = { "&#44;": ",", "&#91;": "[", "&#93;": "]", "&amp;": "&" };
export function qqCqShareLinks(message: string) {
  return Array.from(message.matchAll(/\[CQ:(share|json),([^\]]*)\]/giu), ([, type, body]) => {
    if (body.length > 72_000) return;
    const kind = type.toLowerCase();
    const key = kind === "share" ? "url=" : "data=";
    const value = body.split(",").find(part => part.startsWith(key))?.slice(key.length);
    return value && qqShareLink(kind, value.replace(/&#44;|&#91;|&#93;|&amp;/gu, entity => cqEscapes[entity]!));
  });
}

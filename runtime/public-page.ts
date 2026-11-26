import { isIP } from "node:net";

export function publicPage(value: string) {
  if (!value || value.length > 2048 || /\s/u.test(value) || !/^https:\/\//iu.test(value)) return;
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.port) return;
  const host = url.hostname.replace(/\.$/u, "").replace(/^\[|\]$/gu, "");
  if (isIP(host) || !host.includes(".") || /\.(local|localhost|internal|lan|home|test|invalid|example|onion|arpa)$/u.test(host)) return;
  if ([...url.searchParams.keys()].some(key => /(?:token|secret|password|api.?key|signature|auth|credential)/iu.test(key))) return;
  url.hash = "";
  return url;
}

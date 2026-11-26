import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readBilibiliGrant, renewBilibiliGrant, type BilibiliCreator, type BilibiliGrant } from "./bilibili-content-feed.js";

const minute = 60_000;
const renewBefore = 60 * minute;
type GrantAccount = { creator: BilibiliCreator; initial: BilibiliGrant; id: string; key: Buffer };
type GrantRow = { sealed: Uint8Array | null; version: number; disabled: number; claimedUntil: number; retryAt: number };

function seal(account: GrantAccount, grant: BilibiliGrant) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", account.key, iv);
  cipher.setAAD(Buffer.from(account.id, "hex"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(grant), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function currentGrant(account: GrantAccount, row: GrantRow): BilibiliGrant | undefined {
  if (row.disabled) return;
  if (row.sealed === null) return account.initial;
  try {
    const stored = Buffer.from(row.sealed);
    const decipher = createDecipheriv("aes-256-gcm", account.key, stored.subarray(0, 12));
    decipher.setAAD(Buffer.from(account.id, "hex"));
    decipher.setAuthTag(stored.subarray(12, 28));
    const grant = JSON.parse(Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]).toString("utf8"));
    return readBilibiliGrant(grant?.accessToken, grant?.refreshToken, grant?.expiresAt);
  } catch { return; }
}

export function openBilibiliAuthorization(db: DatabaseSync, creators: ReadonlyMap<string, BilibiliCreator>) {
  db.exec(`CREATE TABLE IF NOT EXISTS bilibili_authorizations (
    grant_id TEXT PRIMARY KEY, sealed BLOB, version INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0, claimed_until INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0
  )`);
  const insert = db.prepare("INSERT OR IGNORE INTO bilibili_authorizations(grant_id) VALUES(?)");
  const lookup = db.prepare(`SELECT sealed,version,disabled,claimed_until AS claimedUntil,retry_at AS retryAt
    FROM bilibili_authorizations WHERE grant_id=?`);
  const claim = db.prepare(`UPDATE bilibili_authorizations SET claimed_until=?,version=version+1
    WHERE grant_id=? AND version=? AND disabled=0 AND claimed_until<=? AND retry_at<=?`);
  const settle = db.prepare(`UPDATE bilibili_authorizations SET sealed=?,disabled=?,claimed_until=0,retry_at=?
    WHERE grant_id=? AND version=?`);
  const disable = db.prepare(`UPDATE bilibili_authorizations SET sealed=NULL,disabled=1,version=version+1,claimed_until=0,retry_at=0
    WHERE grant_id=? AND version=? AND disabled=0 AND claimed_until<=?`);

  const accounts = new Map<string, GrantAccount>();
  const rotations = new Map<string, { sealed: Buffer; version: number }>();
  for (const [source, creator] of creators) {
    const initial = creator.renewal;
    if (!initial) continue;
    const id = createHmac("sha256", creator.appSecret).update(JSON.stringify([creator.clientId, initial.refreshToken])).digest("hex");
    const key = Buffer.from(hkdfSync("sha256", creator.appSecret, Buffer.from(id, "hex"), "OHJingJing Bilibili token storage", 32));
    accounts.set(source, { creator, initial, id, key });
    insert.run(id);
  }

  function commitRotations() {
    for (const [id, rotation] of rotations) {
      settle.run(rotation.sealed, 0, 0, id, rotation.version);
      rotations.delete(id);
    }
  }

  return {
    hasRenewals: () => accounts.size > 0,
    creator(source: string) {
      const account = accounts.get(source);
      if (!account) return creators.get(source);
      if (rotations.has(account.id)) return;
      const row = lookup.get(account.id) as GrantRow;
      const grant = currentGrant(account, row);
      if (grant && grant.expiresAt * 1000 > Date.now()) return { ...account.creator, accessToken: grant.accessToken };
    },
    invalidate(source: string, accessToken: string | undefined) {
      const account = accounts.get(source);
      if (!account || rotations.has(account.id)) return;
      const now = Date.now();
      const row = lookup.get(account.id) as GrantRow;
      const grant = currentGrant(account, row);
      const currentAccess = grant && grant.expiresAt * 1000 > now ? grant.accessToken : undefined;
      if (currentAccess === accessToken) disable.run(account.id, row.version, now);
    },
    async renewDue() {
      commitRotations();
      const now = Date.now();
      for (const account of accounts.values()) {
        const row = lookup.get(account.id) as GrantRow;
        if (row.disabled || row.claimedUntil > now || row.retryAt > now) continue;
        const grant = currentGrant(account, row);
        if (!grant || grant.expiresAt * 1000 <= now || grant.expiresAt * 1000 - now > renewBefore) continue;
        if (!claim.run(now + 30_000, account.id, row.version, now, now).changes) continue;
        const version = row.version + 1;
        let renewed: BilibiliGrant;
        try {
          renewed = await renewBilibiliGrant(account.creator, grant);
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          const denied = code === "feed-authorization";
          const retry = code === "feed-rate-limited" ? 15 * minute : 5 * minute;
          settle.run(denied ? null : row.sealed, Number(denied), denied ? 0 : Date.now() + retry, account.id, version);
          return;
        }
        rotations.set(account.id, { sealed: seal(account, renewed), version });
        commitRotations();
        return;
      }
    },
  };
}

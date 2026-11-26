import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const groupLimit = 40;
const resultLimit = 8;
const labelPattern = /^[\p{L}\p{N}\p{M} _-]{1,32}$/u;
const idPattern = /^[a-f0-9]{10}$/u;

export const stickerHelp = "同一条消息带一张图和 /收藏表情 标签。用 /找表情 关键词 查看，/发表情 编号 重发，/删除表情 编号 移除。";

export function readGroupStickerQuery(value: unknown) {
  if (typeof value !== "string" || value.length > 96) return;
  const query = value.trim().normalize("NFKC").toLowerCase();
  if (!query || labelPattern.test(query)) return query;
}

export function readStickerCommand(text: string) {
  const match = /^\/(收藏表情|找表情|发表情|删除表情)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return null;
  const value = (match[2] ?? "").trim().normalize("NFKC");
  if (match[1] === "收藏表情" && labelPattern.test(value)) return { action: "collect" as const, label: value };
  if (match[1] === "找表情" && (!value || labelPattern.test(value))) return { action: "find" as const, query: value.toLowerCase() };
  const id = value.toLowerCase();
  if (idPattern.test(id)) {
    if (match[1] === "发表情") return { action: "send" as const, id };
    if (match[1] === "删除表情") return { action: "delete" as const, id };
  }
  return { action: "help" as const };
}

export function openQqGroupStickers(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qq_group_stickers (
      scope TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, label TEXT NOT NULL,
      search_label TEXT NOT NULL, digest TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (scope, id), UNIQUE (scope, digest)
    );
    CREATE INDEX IF NOT EXISTS qq_group_stickers_expiry ON qq_group_stickers(created_at);
  `);
  const prune = db.prepare("DELETE FROM qq_group_stickers WHERE created_at < ?");
  const groupPrune = db.prepare("DELETE FROM qq_group_stickers WHERE scope=? AND created_at < ?");
  const existing = db.prepare("SELECT id,label FROM qq_group_stickers WHERE scope=? AND digest=?");
  const insert = db.prepare(`INSERT INTO qq_group_stickers(scope,id,owner,label,search_label,digest,bytes,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM qq_group_stickers WHERE scope=?) < ?`);
  const search = db.prepare(`SELECT id,label FROM qq_group_stickers WHERE scope=? AND created_at>=? AND instr(search_label,?)>0
    ORDER BY created_at DESC,id LIMIT ?`);
  const read = db.prepare("SELECT label,bytes FROM qq_group_stickers WHERE scope=? AND id=? AND created_at>=?");
  const exists = db.prepare("SELECT 1 FROM qq_group_stickers WHERE scope=? AND id=? AND created_at>=?");
  const remove = db.prepare("DELETE FROM qq_group_stickers WHERE scope=? AND id=? AND created_at>=? AND (owner=? OR ?=1)");

  return {
    prune(cutoff: string) { prune.run(cutoff); },
    collect(scope: string, actor: string, label: string, bytes: Buffer, at: string, cutoff: string) {
      const digest = createHash("sha256").update(bytes).digest("hex");
      groupPrune.run(scope, cutoff);
      const duplicate = existing.get(scope, digest) as { id: string; label: string } | undefined;
      if (duplicate) return { ...duplicate, duplicate: true };
      const id = randomBytes(5).toString("hex");
      const saved = insert.run(scope, id, actor, label, label.toLowerCase(), digest, bytes, at, scope, groupLimit);
      return saved.changes ? { id, label, duplicate: false } : null;
    },
    find(scope: string, query: string, cutoff: string) {
      return search.all(scope, cutoff, query, resultLimit) as { id: string; label: string }[];
    },
    read(scope: string, id: string, cutoff: string) {
      return read.get(scope, id, cutoff) as { label: string; bytes: Uint8Array } | undefined;
    },
    has(scope: string, id: string, cutoff: string) {
      return !!exists.get(scope, id, cutoff);
    },
    remove(scope: string, id: string, cutoff: string, actor: string, isOwner: boolean) {
      return remove.run(scope, id, cutoff, actor, isOwner ? 1 : 0).changes > 0;
    },
  };
}

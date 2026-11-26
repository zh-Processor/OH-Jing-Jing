import { createHash } from "node:crypto";

export type GroupMemberProfile = {
  id: string;
  displayName: string;
  summary: string;
  referenceRevision: string;
  revision?: string;
  updatedAt?: string;
  source?: "manual" | "model-reviewed";
};

export const memberReferenceId = /^[a-z0-9_-]{1,128}$/iu;

export function groupMemberDirectory(input: unknown): GroupMemberProfile[] {
  const { items } = (input ?? {}) as { items?: unknown };
  if (!Array.isArray(items)) throw new Error("群友画像目录格式无效。");
  return items.flatMap(item => {
    if (typeof item?.id !== "string" || !memberReferenceId.test(item.id) ||
        typeof item.displayName !== "string" || !item.displayName.trim() || typeof item.summary !== "string") return [];
    const { id } = item;
    const displayName = item.displayName.slice(0, 80);
    const summary = item.summary.slice(0, 2000);
    const revision = typeof item.revision === "string" ? item.revision : undefined;
    const updatedAt = typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt)) ? item.updatedAt : undefined;
    const source: GroupMemberProfile["source"] = item.source === "manual" || item.source === "model-reviewed" ? item.source : undefined;
    const referenceRevision = createHash("sha256")
      .update(JSON.stringify([id, revision ?? null, updatedAt ?? null, displayName, summary])).digest("hex");
    return [{ id, displayName, summary, revision, updatedAt, source, referenceRevision }];
  });
}

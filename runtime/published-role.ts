import { createHash } from "node:crypto";
import { readRole, type Role } from "./roles.js";

export type PublishedRoleInfo = Pick<Role, "id" | "name" | "version"> & { revision: string };
export type PublishedRole = { info: PublishedRoleInfo; role: Role };

export function createPublishedRole(input: unknown): PublishedRole {
  const role = readRole(input);
  const canonical = JSON.stringify(role, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en")));
  });
  const { id, name, version } = role;
  return { role, info: { id, name, version, revision: createHash("sha256").update(canonical).digest("hex") } };
}

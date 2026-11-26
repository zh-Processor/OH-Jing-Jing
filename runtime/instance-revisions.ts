import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstanceEntry } from "./instance-config.js";
import { readServerConfig } from "./server-config.js";

type Snapshot = { hash: string; data: string };
type Metadata = { version: number; hash: string; operation: "baseline" | "publish" | "rollback"; at: string;
  restoredVersion?: number };
type History = { source: string; revisions: Metadata[] };

const digest = (source: string) => createHash("sha256").update(source).digest("hex");
const credentialFields = /^(?:api[-_]?key|key|token|secret|password|adminToken|channelToken|modelKey|summaryModelKey|groupModelKeys|backupModelKeys|modelProfileKeys)$/iu;

function hasCredentials(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, data]) => credentialFields.test(key) || hasCredentials(data));
}

function snapshot(value: ReturnType<typeof readServerConfig>["config"], database: string): Snapshot {
  if (hasCredentials(value)) throw new Error("实例配置中的凭据应通过环境变量提供。");
  const data = JSON.stringify({ ...value, database }) + "\n";
  return { hash: digest(data), data };
}

export function openInstanceRevisions(manifest: string) {
  const folder = manifest + ".history";
  const index = join(folder, "revisions.json");
  let records = new Map<string, History>();
  if (existsSync(index)) {
    const stored = JSON.parse(readFileSync(index, "utf8")) as [string, History][];
    for (const [id, history] of stored) {
      if (!/^[a-z][a-z0-9-]{0,31}$/u.test(id) || records.has(id) || !history.source ||
          !Array.isArray(history.revisions) || !history.revisions.length ||
          history.revisions.some((entry, index) => !/^[a-f0-9]{64}$/u.test(entry.hash) || entry.version !== index)) {
        throw new Error("实例配置版本记录无效。");
      }
      records.set(id, history);
    }
  }
  const file = (hash: string) => join(folder, hash + ".json");
  const head = (id: string) => records.get(id)?.revisions.at(-1);
  function checkedFile(hash: string) {
    const path = file(hash);
    readServerConfig(path, hash);
    return path;
  }
  function store(value: Snapshot) {
    mkdirSync(folder, { recursive: true });
    const path = file(value.hash);
    if (!existsSync(path)) {
      // Publish a complete file in one rename, including after a manager is interrupted.
      const temp = join(folder, randomUUID() + ".tmp");
      try {
        writeFileSync(temp, value.data, { flag: "wx", mode: 0o600, flush: true });
        renameSync(temp, path);
      } finally { if (existsSync(temp)) unlinkSync(temp); }
    }
    return checkedFile(value.hash);
  }

  function write(id: string, source: string, revisions: Metadata[]) {
    const next = new Map(records).set(id, { source, revisions });
    const temp = join(folder, randomUUID() + ".tmp");
    try {
      writeFileSync(temp, JSON.stringify([...next]) + "\n", { flag: "wx", mode: 0o600, flush: true });
      renameSync(temp, index);
      records = next;
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }

  const versioned = (id: string) => head(id) !== undefined;
  const baseline = (entry: InstanceEntry) => snapshot(JSON.parse(entry.source.toString("utf8").replace(/^\uFEFF/u, "")), entry.database);
  function draft(entry: InstanceEntry) {
    const source = readServerConfig(entry.sourceFile);
    return { expectedHash: source.hash, value: snapshot(source.config, source.database) };
  }
  return {
    selected() { return new Map([...records.keys()].map(id => [id, checkedFile(head(id)!.hash)])); },
    verifySources(entries: ReadonlyArray<InstanceEntry>) {
      for (const entry of entries) {
        const history = records.get(entry.id);
        if (history && history.source !== entry.sourceFile) throw new Error("已有版本记录的实例配置文件路径不能直接改动。");
      }
    },
    draft,
    view(entry: InstanceEntry) {
      const history = records.get(entry.id)?.revisions ?? [];
      const current = head(entry.id);
      const { sourceFile } = entry;
      try {
        const pending = draft(entry);
        return { sourceFile, version: current?.version ?? 0, revision: current?.hash ?? entry.hash,
          draftHash: pending.expectedHash, changed: pending.value.hash !== (current?.hash ?? baseline(entry).hash),
          revisions: history.slice(-30).reverse() };
      } catch {
        return { sourceFile, version: current?.version ?? 0, revision: current?.hash ?? entry.hash,
          draftHash: null, changed: false, revisions: history.slice(-30).reverse() };
      }
    },
    version(id: string) { return head(id)?.version ?? 0; },
    fileAt(id: string, version: number) {
      const restored = records.get(id)?.revisions[version];
      return restored && checkedFile(restored.hash);
    },
    store,
    saveCurrent(entry: InstanceEntry) {
      return versioned(entry.id) ? checkedFile(head(entry.id)!.hash) : store(baseline(entry));
    },
    adoptBaseline(entry: InstanceEntry, previousFile: string) {
      if (versioned(entry.id)) return;
      const { hash } = readServerConfig(previousFile);
      write(entry.id, entry.sourceFile, [{ version: 0, hash, operation: "baseline", at: new Date().toISOString() }]);
    },
    commit(entry: InstanceEntry, restoredVersion?: number) {
      checkedFile(entry.hash);
      const old = records.get(entry.id)!.revisions;
      if (old.at(-1)!.hash === entry.hash) return;
      write(entry.id, entry.sourceFile, [...old, { version: old.length, hash: entry.hash, at: new Date().toISOString(),
        operation: restoredVersion === undefined ? "publish" : "rollback", restoredVersion }]);
    },
  };
}

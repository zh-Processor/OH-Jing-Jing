import type { DatabaseSync } from "node:sqlite";

export const isModelRoute = (value: unknown): value is string => typeof value === "string" &&
  /^(?:default|summary|private|qq:\d{4,20}:\d{4,20})$/.test(value);

export type StandbyMode = "inherit" | "disabled" | "custom";
export type ModelRouteTarget = { bindingId: string | null; fingerprint: string | null;
  standbyMode: StandbyMode; standbyBindingId: string | null; standbyFingerprint: string | null };
const defaults: ModelRouteTarget = { bindingId: null, fingerprint: null, standbyMode: "inherit", standbyBindingId: null, standbyFingerprint: null };
type Revision = ModelRouteTarget & { version: number; operation: "select" | "rollback"; restoredVersion: number | null;
  actor: string; createdAt: string };

export function openServiceModelRoutes(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS service_model_routes (
    route TEXT NOT NULL, version INTEGER NOT NULL, binding_id TEXT, fingerprint TEXT, operation TEXT NOT NULL,
    restored_version INTEGER, actor TEXT NOT NULL, created_at TEXT NOT NULL,
    standby_mode TEXT NOT NULL DEFAULT 'inherit', standby_binding_id TEXT, standby_fingerprint TEXT,
    PRIMARY KEY (route, version)
  )`);
  const existing = new Set(db.prepare("PRAGMA table_info(service_model_routes)").all().map(column => column.name));
  for (const [column, definition] of [["standby_mode", "TEXT NOT NULL DEFAULT 'inherit'"], ["standby_binding_id", "TEXT"], ["standby_fingerprint", "TEXT"]]) {
    if (!existing.has(column)) db.exec(`ALTER TABLE service_model_routes ADD COLUMN ${column} ${definition}`);
  }
  const columns = `version,binding_id AS bindingId,fingerprint,operation,restored_version AS restoredVersion,actor,created_at AS createdAt,
    standby_mode AS standbyMode,standby_binding_id AS standbyBindingId,standby_fingerprint AS standbyFingerprint`;
  const current = db.prepare(`SELECT ${columns} FROM service_model_routes WHERE route=? ORDER BY version DESC LIMIT 1`);
  const one = db.prepare(`SELECT ${columns} FROM service_model_routes WHERE route=? AND version=?`);
  const history = db.prepare(`SELECT ${columns} FROM service_model_routes WHERE route=? ORDER BY version DESC LIMIT 30`);
  const insert = db.prepare(`INSERT INTO service_model_routes(route,version,binding_id,fingerprint,operation,restored_version,actor,created_at,
    standby_mode,standby_binding_id,standby_fingerprint) VALUES (?,?,?,?,?,?,'administrator',?,?,?,?)`);
  const head = (route: string) => current.get(route) as Revision | undefined;
  return {
    current: head,
    revision(route: string, version: number): ModelRouteTarget | undefined {
      return version === 0 ? defaults : one.get(route, version) as Revision | undefined;
    },
    history(route: string) { return history.all(route) as unknown as Revision[]; },
    change(route: string, version: number, target: ModelRouteTarget, restoredVersion: number | null) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = head(route);
        const actual = previous?.version ?? 0;
        if (version !== actual) {
          db.exec("ROLLBACK");
          return { status: "conflict" as const, version: actual };
        }
        const old = previous ?? defaults;
        const changed = old.bindingId !== target.bindingId || old.fingerprint !== target.fingerprint ||
          old.standbyMode !== target.standbyMode || old.standbyBindingId !== target.standbyBindingId || old.standbyFingerprint !== target.standbyFingerprint;
        if (changed) insert.run(route, actual + 1, target.bindingId, target.fingerprint,
          restoredVersion === null ? "select" : "rollback", restoredVersion, new Date().toISOString(),
          target.standbyMode, target.standbyBindingId, target.standbyFingerprint);
        db.exec("COMMIT");
        return { status: "ok" as const, version: changed ? actual + 1 : actual };
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

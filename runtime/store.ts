import { DatabaseSync } from "node:sqlite";

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, role_id TEXT NOT NULL,
      author TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_scope ON messages(scope, role_id, id);
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY, model_id TEXT NOT NULL, model_name TEXT NOT NULL, scope TEXT NOT NULL,
      created_at TEXT NOT NULL, status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
      estimated_cost REAL, currency TEXT, duration_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_snapshots (model_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_events (
      account_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at TEXT NOT NULL,
      scope TEXT NOT NULL, actor_id TEXT NOT NULL, display_name TEXT NOT NULL,
      PRIMARY KEY (account_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS channel_events_scope_time ON channel_events(scope, created_at DESC);
    CREATE TABLE IF NOT EXISTS profiles (
      scope TEXT NOT NULL, subject TEXT NOT NULL, notes TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (scope, subject)
    );
    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, role_id TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, event_id TEXT NOT NULL,
      content TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(scope, event_id)
    );
    UPDATE outbox SET status = 'unknown' WHERE status = 'sending';
  `);
  const outboxColumns = new Set(db.prepare("PRAGMA table_info(outbox)").all().map(column => column.name));
  for (const column of ["platform_message_id", "delivery_format"]) {
    if (!outboxColumns.has(column)) db.exec(`ALTER TABLE outbox ADD COLUMN ${column} TEXT`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS outbox_platform_message ON outbox(scope, platform_message_id) WHERE platform_message_id IS NOT NULL");
  function setting<T>(key: string, fallback: T): T {
    const result = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return result ? JSON.parse(String(result.value)) : fallback;
  }
  function saveSetting(key: string, value: unknown) {
    db.prepare("INSERT OR REPLACE INTO settings VALUES (?, ?)").run(key, JSON.stringify(value));
  }
  return { db, setting, saveSetting };
}

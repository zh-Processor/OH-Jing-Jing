import type { DatabaseSync } from "node:sqlite";
import { changeMood, companionEffects, moodAt, type CompanionEvent, type CompanionSnapshot, type Mood, type MoodProfile } from "./companion-state.js";

type CompanionScope = { scope: string; roleId: string; subject: string; profile?: MoodProfile };
const day = 86_400_000;
const coolOff = 20_000;

export function openCompanionStore(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS role_mood (
      scope TEXT NOT NULL, role_id TEXT NOT NULL, values_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, role_id)
    );
    CREATE TABLE IF NOT EXISTS role_relationship (
      scope TEXT NOT NULL, role_id TEXT NOT NULL, subject TEXT NOT NULL, familiarity REAL NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, role_id, subject)
    );
    CREATE TABLE IF NOT EXISTS role_state_event (
      scope TEXT NOT NULL, role_id TEXT NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (scope, role_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS role_state_event_lookup ON role_state_event(scope, role_id, kind, created_at);
    CREATE INDEX IF NOT EXISTS role_state_event_time ON role_state_event(created_at);
  `);
  const moodRow = db.prepare("SELECT values_json, updated_at FROM role_mood WHERE scope = ? AND role_id = ?");
  const relationship = db.prepare("SELECT familiarity, updated_at FROM role_relationship WHERE scope = ? AND role_id = ? AND subject = ?");
  const recurring = db.prepare("SELECT 1 FROM role_state_event WHERE scope = ? AND role_id = ? AND kind = ? AND created_at > ? LIMIT 1");
  const insertEvent = db.prepare("INSERT OR IGNORE INTO role_state_event VALUES (?, ?, ?, ?, ?)");
  const saveMood = db.prepare("INSERT OR REPLACE INTO role_mood VALUES (?, ?, ?, ?)");
  const saveRelation = db.prepare("INSERT OR REPLACE INTO role_relationship VALUES (?, ?, ?, ?, ?)");
  const deleteMood = db.prepare("DELETE FROM role_mood WHERE scope = ? AND role_id = ?");
  const deleteRelation = db.prepare("DELETE FROM role_relationship WHERE scope = ? AND role_id = ? AND subject = ?");
  const deleteEvents = db.prepare("DELETE FROM role_state_event WHERE scope = ? AND role_id = ?");
  const pruneEvents = db.prepare("DELETE FROM role_state_event WHERE created_at < ?");
  const pruneRelationships = db.prepare("DELETE FROM role_relationship WHERE updated_at < ?");
  const pruneMoods = db.prepare("DELETE FROM role_mood WHERE updated_at < ?");

  function readMood({ scope, roleId, profile }: CompanionScope, now: number) {
    const row = moodRow.get(scope, roleId);
    const previous = row ? { mood: JSON.parse(String(row.values_json)) as Mood, time: Number(row.updated_at) } : undefined;
    return moodAt(profile, now, previous);
  }

  function familiarityAt(state: CompanionScope, now: number) {
    const entry = relationship.get(state.scope, state.roleId, state.subject);
    if (!entry) return { score: 0, time: 0 };
    const time = Number(entry.updated_at);
    const elapsed = Math.max(0, now - time);
    return { score: Number(entry.familiarity) * 2 ** (-elapsed / (30 * day)), time };
  }

  function snapshot(state: CompanionScope, now = Date.now()): CompanionSnapshot {
    const { score } = familiarityAt(state, now);
    return { mood: readMood(state, now), familiarity: score >= 8 ? "熟悉" : score >= 2.5 ? "渐熟" : "初识" };
  }

  function record(scope: CompanionScope, kind: CompanionEvent, eventId: string, now = Date.now()) {
    const { scope: name, roleId, subject } = scope;
    if (kind !== "conversation" && recurring.get(name, roleId, kind, now - coolOff)) return false;
    db.exec("SAVEPOINT companion_event");
    try {
      const result = insertEvent.run(name, roleId, eventId, kind, now);
      if (result.changes) {
        const mood = changeMood(readMood(scope, now), companionEffects[kind]);
        saveMood.run(name, roleId, JSON.stringify(mood), now);
        if (kind !== "rest") {
          const { score, time } = familiarityAt(scope, now);
          if (now - time >= coolOff) saveRelation.run(name, roleId, subject, Math.min(20, score + 1), now);
        }
      }
      db.exec("RELEASE companion_event");
      return result.changes > 0;
    } catch (error) {
      db.exec("ROLLBACK TO companion_event; RELEASE companion_event");
      throw error;
    }
  }

  return {
    snapshot, record,
    reset(state: CompanionScope) {
      deleteMood.run(state.scope, state.roleId);
      deleteRelation.run(state.scope, state.roleId, state.subject);
      deleteEvents.run(state.scope, state.roleId);
    },
    clearScope(scope: string) {
      db.prepare("DELETE FROM role_mood WHERE scope = ?").run(scope);
      db.prepare("DELETE FROM role_relationship WHERE scope = ?").run(scope);
      db.prepare("DELETE FROM role_state_event WHERE scope = ?").run(scope);
    },
    prune(now = Date.now()) {
      pruneEvents.run(now - 7 * day);
      pruneRelationships.run(now - 90 * day);
      pruneMoods.run(now - 30 * day);
    },
  };
}

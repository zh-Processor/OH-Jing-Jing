import { randomUUID } from "node:crypto";
import type { openStore } from "./store.js";
import { defaultSummaryReminderPolicy, readSummaryReminderPolicy } from "./summary-reminder-policy.js";

const watchKey = "groupSummaryWatch";
const cursorKey = "groupSummaryNotices";
const pendingKey = "groupSummaryPending";
const policyKey = "summaryReminderPolicy";
const groupScope = /^qq:\d{1,20}:\d{1,20}$/u;
const maxWatches = 256;

type Cursor = { time: number; id: number };
type FeedGroup = { id: string; summary?: { id?: number; created_at?: string } };
export type SummaryNotice = { groupId: string; token: string };
export type SummaryReminders = ReturnType<ReturnType<typeof openDesktopSummaryReminders>["read"]>;

export function openDesktopSummaryReminders(store: ReturnType<typeof openStore>, connection: () => string | null = () => "legacy") {
  const { db } = store;
  const erase = db.prepare("DELETE FROM settings WHERE key IN (?,?)");
  const watchFor = (id: string | null) => id === "legacy" ? watchKey : `${watchKey}:${id ?? "offline"}`;
  const watchSetting = () => watchFor(connection());
  const watched = () => store.setting<string[] | null>(watchSetting(), null);
  const read = () => ({
    watched: watched() ?? [],
    policy: store.setting(policyKey, defaultSummaryReminderPolicy),
  });
  const cursors = () => store.setting<Record<string, Cursor | null>>(cursorKey, {});
  const pending = () => store.setting<Record<string, string>>(pendingKey, {});
  function forget(groupId: string) {
    const summaries = cursors();
    const notices = pending();
    if (Object.hasOwn(summaries, groupId)) {
      delete summaries[groupId];
      store.saveSetting(cursorKey, summaries);
    }
    if (Object.hasOwn(notices, groupId)) {
      delete notices[groupId];
      store.saveSetting(pendingKey, notices);
    }
  }
  return {
    read,
    migrate(legacy: unknown) {
      if (connection() === "legacy" && watched() === null && Array.isArray(legacy)) {
        const valid = legacy.filter((id): id is string => typeof id === "string" && groupScope.test(id));
        store.saveSetting(watchKey, [...new Set(valid)].slice(0, maxWatches));
      }
      return read();
    },
    setWatch(groupId: unknown, enabled: unknown) {
      if (typeof groupId !== "string" || !groupScope.test(groupId) || typeof enabled !== "boolean") throw new Error("请选择要提醒的群。");
      const selected = new Set(watched() ?? []);
      if (enabled && !selected.has(groupId) && selected.size >= maxWatches) throw new Error("最多关注 256 个群。");
      if (enabled) selected.add(groupId);
      else {
        selected.delete(groupId);
        forget(groupId);
      }
      store.saveSetting(watchSetting(), [...selected]);
      return read();
    },
    savePolicy(input: unknown) {
      store.saveSetting(policyKey, readSummaryReminderPolicy(input));
      return read();
    },
    clearSubscription() { erase.run(cursorKey, pendingKey); },
    clearWatch(id: string) { db.prepare("DELETE FROM settings WHERE key=?").run(watchFor(id)); },
    observe(groups: FeedGroup[]) {
      const watch = watched();
      // An upgrade may fetch the group list before the first webview imports the old watch list.
      if (!watch) return [];
      const selected = new Set(watch);
      const previousCursors = cursors();
      const previousNotices = pending();
      const nextCursors: Record<string, Cursor | null> = {};
      const nextNotices: Record<string, string> = {};
      const visible: SummaryNotice[] = [];
      for (const group of groups) {
        if (!selected.has(group.id)) continue;
        const time = Date.parse(group.summary?.created_at ?? "");
        if (!Number.isFinite(time)) {
          nextCursors[group.id] = previousCursors[group.id] ?? null;
          continue;
        }
        const rawId = group.summary?.id;
        const id = typeof rawId === "number" && Number.isSafeInteger(rawId) ? rawId : 0;
        const previous = previousCursors[group.id];
        const newer = !previous || time > previous.time || (time === previous.time && id > previous.id);
        nextCursors[group.id] = newer ? { time, id } : previous;
        const token = newer && previous !== undefined ? randomUUID() : previousNotices[group.id];
        if (!token) continue;
        nextNotices[group.id] = token;
        const current = nextCursors[group.id];
        if (current?.time === time && current.id === id) visible.push({ groupId: group.id, token });
      }
      if (JSON.stringify(previousCursors) !== JSON.stringify(nextCursors)) store.saveSetting(cursorKey, nextCursors);
      if (JSON.stringify(previousNotices) !== JSON.stringify(nextNotices)) store.saveSetting(pendingKey, nextNotices);
      return visible;
    },
    acknowledge(tokens: unknown) {
      if (!Array.isArray(tokens) || tokens.length > maxWatches || !tokens.every(token => typeof token === "string")) {
        throw new Error("摘要提醒确认无效。");
      }
      const shown = new Set<string>(tokens);
      const notices = pending();
      const remaining = Object.fromEntries(Object.entries(notices).filter(([, token]) => !shown.has(token)));
      if (Object.keys(remaining).length !== Object.keys(notices).length) store.saveSetting(pendingKey, remaining);
      return true;
    },
  };
}

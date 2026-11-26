import { createHash, randomUUID } from "node:crypto";
import type { CredentialFrame, openDesktopCredentials } from "./desktop-credentials.js";
import type { DevelopmentDetailsUpdate, DevelopmentTaskControl } from "./development-tasks.js";
import type { GroupSummary } from "./group-summary-reference.js";
import { summaryReference } from "./group-summary-reference.js";
import { groupSummaryHighlight, type SummaryReaction } from "./group-summary-highlight.js";
import type { LocalReviewReference } from "./desktop-local-reminders.js";
import { groupMemberDirectory, type GroupMemberProfile } from "./group-member-reference.js";
import type { openStore } from "./store.js";
import type { WorkspaceConversation, WorkspaceFeature } from "./workspace-feed.js";
import { defaultSummaryReminderPolicy, readSummaryReminderPolicy, summaryReminderQuiet, workspaceReminderIntervals,
  type SummaryReminderPolicy, type WorkspaceReminderPolicy } from "./summary-reminder-policy.js";

type WorkspaceWatch = { sourceId: string; conversationId: string; since: string };
export type DesktopWorkspace = {
  id: string; name: string; sourceIds: string[]; watched?: WorkspaceWatch[];
  sourceFilter?: string; reminders?: WorkspaceReminderPolicy;
};
type WorkspaceSettings = { activeId: string; items: DesktopWorkspace[] };
type Entry = { id: number; conversationId: string; at: string } & (
  { kind: "message"; message: { text: string } } | { kind: "summary"; summary: GroupSummary });
type FeedPage = { cursor: string; reset: boolean; hasMore: boolean; retainedAfter: string;
  conversations: WorkspaceConversation[]; platform: string; items: Entry[]; features?: WorkspaceFeature[]; featureRevision?: string };
export type WorkspaceSource = { id: string; platform?: string; conversations: WorkspaceConversation[]; items: Entry[];
  state: "ready" | "summary-only" | "stale" | "unauthorized" | "unsupported"; syncedAt?: string;
  features?: WorkspaceFeature[]; featureRevision?: string };
type CachedSource = WorkspaceSource & { credentialSlot: string; cursor?: string };
export type WorkspaceNotice = { token: string; sourceId: string; conversationId: string; label: string; at: string; reaction: SummaryReaction };
export type WorkspaceFeatureItem = { title: string; text: string; followUpId?: string };
export type WorkspaceConversationProfiles = {
  group: Pick<GroupMemberProfile, "displayName" | "summary" | "updatedAt"> | null;
  members: GroupMemberProfile[];
};

function readWorkspaceReminders(input: unknown): WorkspaceReminderPolicy | undefined {
  if (input === null) return undefined;
  const patch = input as Partial<WorkspaceReminderPolicy> | null;
  const interval = workspaceReminderIntervals.find(minutes => minutes === patch?.intervalMinutes);
  if (interval === undefined) throw new Error("请选择可用的工作区提醒频率。");
  const { deferFullscreen: _ignored, ...policy } = readSummaryReminderPolicy({ ...patch, deferFullscreen: true });
  return { ...policy, intervalMinutes: interval };
}

function readPage(value: unknown): FeedPage {
  const page = value as FeedPage;
  if (!page || typeof page.cursor !== "string" || page.cursor.length > 120 || typeof page.platform !== "string" ||
      typeof page.reset !== "boolean" || typeof page.hasMore !== "boolean" || !Number.isFinite(Date.parse(page.retainedAfter)) ||
      !Array.isArray(page.conversations) || !Array.isArray(page.items) || page.items.length > 100 ||
      page.conversations.some(item => !item || typeof item.id !== "string" || typeof item.label !== "string" || typeof item.messageAccess !== "boolean" ||
        item.replyAccess !== undefined && typeof item.replyAccess !== "boolean") ||
      page.items.some(item => !item || !Number.isSafeInteger(item.id) || item.id < 1 || !Number.isFinite(Date.parse(item.at)) ||
        typeof item.conversationId !== "string" || (item.kind === "message" ? typeof item.message?.text !== "string" :
          item.kind !== "summary" || typeof item.summary?.content !== "string"))) throw new Error("服务返回的工作区数据无效。");
  const features = Array.isArray(page.features) ? page.features.filter(item => item && /^[a-z0-9-]{1,60}$/u.test(item.id) &&
    typeof item.title === "string" && item.title.length <= 80 && /^\d+\.\d+\.\d+$/u.test(item.minimumClientVersion) &&
    item.view === "list" && Array.isArray(item.conversationIds) && item.conversationIds.every(id => typeof id === "string")) : [];
  return { ...page, features, featureRevision: typeof page.featureRevision === "string" ? page.featureRevision : undefined };
}

export function openDesktopWorkspaces(store: ReturnType<typeof openStore>, credentials: ReturnType<typeof openDesktopCredentials>) {
  const pending = new Map<string, Promise<WorkspaceSource>>();
  const revisions = new Map<string, number>();
  const empty = (id: string, state: WorkspaceSource["state"] = "stale"): WorkspaceSource => ({ id, state, conversations: [], items: [] });
  const cacheKey = (id: string) => `workspaceFeed:${id}`;
  function configuration() {
    const activeService = credentials.activeServiceId();
    const defaults: WorkspaceSettings = { activeId: "default", items: [{ id: "default", name: "日常", sourceIds: activeService ? [activeService] : [] }] };
    const saved = store.setting<WorkspaceSettings | null>("desktopWorkspaces", null) ?? defaults;
    const available = new Set(credentials.listServices().map(item => item.id));
    return { ...saved, items: saved.items.map(item => ({ ...item, sourceIds: item.sourceIds.filter(id => available.has(id)),
      sourceFilter: item.sourceFilter && available.has(item.sourceFilter) && item.sourceIds.includes(item.sourceFilter) ? item.sourceFilter : undefined,
      watched: item.watched?.filter(watch => available.has(watch.sourceId) && item.sourceIds.includes(watch.sourceId)) })) };
  }

  function cache(id: string, slot: string | null) {
    const cached = store.setting<CachedSource | null>(cacheKey(id), null);
    return slot && cached?.credentialSlot === slot ? cached : undefined;
  }

  function visible(cached: CachedSource): WorkspaceSource {
    const { credentialSlot: _slot, cursor: _cursor, ...view } = cached;
    return view;
  }

  function access(id: string, frame: CredentialFrame) {
    if (!configuration().items.some(item => item.sourceIds.includes(id))) throw new Error("请选择工作区中的服务连接。");
    const { binding, profile } = credentials.serviceProfile(id);
    const key = credentials.key(frame, id === "legacy" ? "service" : `service-profile:${id}`, binding);
    if (!profile || !binding.origin || !binding.slot || !key) return null;
    const revision = revisions.get(id);
    const current = () => revisions.get(id) === revision && credentials.matches(credentials.serviceProfile(id).binding, binding) &&
      configuration().items.some(item => item.sourceIds.includes(id));
    return { key, origin: binding.origin, slot: binding.slot, current };
  }

  async function readLegacySummaries(origin: string, key: string) {
    const result = await fetch(`${origin}/api/groups`, {
      headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(8000),
    });
    if (result.status === 401 || result.status === 403) return "unauthorized" as const;
    if (result.status === 404) return "unsupported" as const;
    if (!result.ok) throw new Error("群摘要暂不可用。");
    const data = await result.json() as { channelPlugin?: { platform?: string }; groups: {
      id: string; profile?: { displayName?: string }; summaries?: GroupSummary[]; summary?: GroupSummary;
    }[] };
    if (!Array.isArray(data.groups)) throw new Error("群摘要数据无效。");
    const conversations: WorkspaceConversation[] = [];
    const items: Entry[] = [];
    for (const group of data.groups) {
      if (typeof group?.id !== "string") continue;
      conversations.push({ id: group.id, label: group.profile?.displayName ?? group.id.split(":").at(-1)!, messageAccess: false });
      for (const summary of group.summaries ?? (group.summary ? [group.summary] : [])) {
        if (!summary || !Number.isSafeInteger(summary.id) || typeof summary.content !== "string" ||
            !Number.isFinite(Date.parse(summary.created_at))) continue;
        items.push({ id: summary.id!, conversationId: group.id, at: summary.created_at, kind: "summary", summary });
      }
    }
    return { platform: data.channelPlugin?.platform, conversations, items: items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 400) };
  }

  async function sync(id: string, frame: CredentialFrame) {
    const source = access(id, frame);
    if (!source) return empty(id, "unauthorized");
    const { key, origin, slot, current } = source;
    const existing = pending.get(slot);
    if (existing) return existing;
    const task = (async () => {
      let cached = cache(id, slot);
      let more = true;
      try {
        for (let i = 0; i < 5 && more; i++) {
          const suffix = cached?.cursor ? `?cursor=${encodeURIComponent(cached.cursor)}` : "";
          const result = await fetch(`${origin}/api/workspace/feed${suffix}`, {
            headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(8000),
          });
          if (!current()) return empty(id);
          if (result.status === 401 || result.status === 403) {
            store.saveSetting(cacheKey(id), null);
            return empty(id, "unauthorized");
          }
          if (result.status === 404) {
            const legacy = await readLegacySummaries(origin, key);
            if (!current()) return empty(id);
            if (typeof legacy === "string") {
              store.saveSetting(cacheKey(id), null);
              return empty(id, legacy);
            }
            cached = { ...legacy, id, credentialSlot: slot, state: "summary-only", syncedAt: new Date().toISOString() };
            store.saveSetting(cacheKey(id), cached);
            return visible(cached);
          }
          if (!result.ok) throw new Error("工作区同步暂不可用。");
          const page = readPage(await result.json());
          if (!current()) return empty(id);
          const permissions = new Map(page.conversations.map(item => [item.id, item.messageAccess]));
          const entries = new Map<number, Entry>();
          for (const item of [...(!page.reset && cached ? cached.items : []), ...page.items]) {
            const evidenceStart = item.kind === "summary" ? item.summary.source_start ?? item.at : item.at;
            if (permissions.has(item.conversationId) && item.at >= page.retainedAfter && evidenceStart >= page.retainedAfter &&
                (item.kind === "summary" || permissions.get(item.conversationId))) entries.set(item.id, item);
          }
          const items = [...entries.values()].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id).slice(0, 400);
          cached = { id, credentialSlot: slot, platform: page.platform, state: "ready", conversations: page.conversations,
            syncedAt: new Date().toISOString(), cursor: page.cursor, items, features: page.features, featureRevision: page.featureRevision };
          store.saveSetting(cacheKey(id), cached);
          more = page.hasMore;
        }
        return cached ? visible(cached) : empty(id);
      } catch {
        return current() && cached ? { ...visible(cached), state: "stale" as const } : empty(id);
      }
    })();
    pending.set(slot, task);
    try { return await task; }
    finally { if (pending.get(slot) === task) pending.delete(slot); }
  }

  async function operation(id: string, frame: CredentialFrame, path: string, request?: object) {
    const source = access(id, frame);
    if (!source) return null;
    const { key, origin, current } = source;
    const response = await fetch(`${origin}${path}`, {
      method: request ? "POST" : "GET", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: request && JSON.stringify(request), redirect: "error", signal: AbortSignal.timeout(8000),
    });
    if (!current() || [401, 403, 404].includes(response.status)) return null;
    if (!response.ok) throw new Error(`服务操作失败（HTTP ${response.status}）。`);
    const data = await response.json();
    return current() ? data : null;
  }

  function candidateNotices(now: number, global: SummaryReminderPolicy) {
    const seen = new Set(store.setting<string[]>("desktopWorkspaceNotified", []));
    const pending = new Map<string, { notice: WorkspaceNotice; workspaces: string[] }>();
    if (global.paused) return pending;
    const after = store.setting<Record<string, number>>("desktopWorkspaceLastNotice", {});
    const clock = new Date(now);
    for (const workspace of configuration().items) {
      const policy = workspace.reminders;
      if (summaryReminderQuiet(policy ? { ...global, ...policy } : global, clock) ||
          (policy?.intervalMinutes && now - (after[workspace.id] ?? -Infinity) < policy.intervalMinutes * 60_000)) continue;
      for (const watch of workspace.watched ?? []) {
        const { binding, profile } = credentials.serviceProfile(watch.sourceId);
        const source = cache(watch.sourceId, binding.slot);
        if (!profile || !source || now - Date.parse(source.syncedAt ?? "") > 120_000) continue;
        const conversation = source.conversations.find(item => item.id === watch.conversationId);
        const summary = source.items.find(item => item.kind === "summary" && item.conversationId === watch.conversationId && item.at > watch.since);
        if (!conversation || summary?.kind !== "summary") continue;
        const token = createHash("sha256").update(JSON.stringify([source.credentialSlot, summary.id, summary.at])).digest("hex");
        if (seen.has(token)) continue;
        const existing = pending.get(token);
        if (existing) existing.workspaces.push(workspace.id);
        else pending.set(token, { workspaces: [workspace.id], notice: { token, sourceId: watch.sourceId, conversationId: conversation.id,
          label: `${profile.name} · ${conversation.label}`, at: summary.at, reaction: groupSummaryHighlight(summary.summary.topics)?.reaction ?? "summary" } });
      }
    }
    return pending;
  }

  return {
    configuration,
    save(input: { id?: unknown; name?: unknown; sourceIds?: unknown; reminders?: unknown }) {
      const saved = configuration();
      const existing = saved.items.find(item => item.id === input.id);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const available = new Set(credentials.listServices().map(item => item.id));
      if (input.id !== undefined && !existing || !name || name.length > 60 || !Array.isArray(input.sourceIds) ||
          input.sourceIds.some(id => typeof id !== "string" || !available.has(id))) throw new Error("请检查工作区名称和服务连接。");
      const sourceIds = [...new Set<string>(input.sourceIds)];
      const sourceFilter = existing?.sourceFilter;
      const item = { id: existing?.id ?? randomUUID(), name, sourceIds, watched: existing?.watched?.filter(watch => sourceIds.includes(watch.sourceId)),
        sourceFilter: sourceFilter && sourceIds.includes(sourceFilter) ? sourceFilter : undefined,
        reminders: input.reminders === undefined ? existing?.reminders : readWorkspaceReminders(input.reminders) };
      const items = existing ? saved.items.map(entry => entry.id === item.id ? item : entry) : [...saved.items, item];
      const next = { activeId: existing ? saved.activeId : item.id, items };
      store.saveSetting("desktopWorkspaces", next);
      return next;
    },
    select(id: unknown) {
      const saved = configuration();
      if (typeof id !== "string" || !saved.items.some(item => item.id === id)) throw new Error("找不到工作区。");
      const next = { ...saved, activeId: id };
      store.saveSetting("desktopWorkspaces", next);
      return next;
    },
    filter(id: unknown, sourceId: unknown) {
      const saved = configuration();
      const workspace = saved.items.find(item => item.id === id);
      if (!workspace || typeof sourceId !== "string" || (sourceId && !workspace.sourceIds.includes(sourceId))) throw new Error("请选择工作区中的来源。");
      const next = { ...saved, items: saved.items.map(item => item === workspace ? { ...item, sourceFilter: sourceId || undefined } : item) };
      store.saveSetting("desktopWorkspaces", next);
      return next;
    },
    watch(workspaceId: string, sourceId: string, conversationId: string, enable: unknown) {
      const saved = configuration();
      const item = saved.items.find(candidate => candidate.id === workspaceId && candidate.sourceIds.includes(sourceId));
      if (!item || typeof enable !== "boolean") throw new Error("工作区或会话不可用。");
      const previous = item.watched?.find(watch => watch.sourceId === sourceId && watch.conversationId === conversationId);
      const watched = (item.watched ?? []).filter(watch => watch !== previous);
      if (enable) {
        const source = cache(sourceId, credentials.serviceProfile(sourceId).binding.slot);
        if (!source?.conversations.some(conversation => conversation.id === conversationId)) throw new Error("没有该会话的查看权限。");
        watched.push(previous ?? { sourceId, conversationId, since: new Date().toISOString() });
      }
      const next = { ...saved, items: saved.items.map(candidate => candidate.id === workspaceId ? { ...candidate, watched } : candidate) };
      store.saveSetting("desktopWorkspaces", next);
      return next;
    },
    notices(now = Date.now(), global = defaultSummaryReminderPolicy) {
      return [...candidateNotices(now, global).values()].map(item => item.notice).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
    },
    async summary(workspaceId: string, sourceIds: string[], frames: NonNullable<CredentialFrame["workspace"]>) {
      const selected = () => {
        const settings = configuration();
        return settings.activeId === workspaceId && settings.items.some(item => item.id === workspaceId &&
          sourceIds.every(id => item.sourceIds.includes(id)));
      };
      if (!selected()) throw new Error("当前工作区或来源范围已变化。");
      const current = await Promise.all(sourceIds.map(async id => {
        const profile = credentials.serviceProfile(id).profile;
        if (!profile || !frames[id]) return [];
        const source = await sync(id, frames[id]);
        if (source.state !== "ready" && source.state !== "summary-only") return [];
        const conversations = new Set<string>();
        return source.items.flatMap(item => {
          if (item.kind !== "summary" || conversations.has(item.conversationId)) return [];
          const reference = summaryReference(item.summary);
          const conversation = source.conversations.find(entry => entry.id === item.conversationId);
          if (!reference || !conversation) return [];
          conversations.add(item.conversationId);
          return [{ source: profile.name.slice(0, 50), conversation: conversation.label.slice(0, 50), time: item.at, revision: reference.revision,
            context: reference.context }];
        }).slice(0, 2);
      }));
      if (!selected()) throw new Error("工作区已切换。");
      const pieces = current.flatMap(items => items[0] ? [items[0], ...(sourceIds.length <= 3 && items[1] ? [items[1]] : [])] : []);
      const contextLength = Math.floor(2200 / (pieces.length || 1));
      return pieces.map(item => ({ ...item, context: item.context.slice(0, contextLength) }));
    },
    acknowledge(tokens: unknown, now = Date.now(), global = defaultSummaryReminderPolicy) {
      if (!Array.isArray(tokens) || tokens.length > 6 || tokens.some(token => typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token))) {
        throw new Error("提醒编号无效。");
      }
      const candidates = candidateNotices(now, global);
      const displayed = new Set(tokens.flatMap(token => candidates.get(token)?.workspaces ?? []));
      const after = store.setting<Record<string, number>>("desktopWorkspaceLastNotice", {});
      if (displayed.size) store.saveSetting("desktopWorkspaceLastNotice", { ...after,
        ...Object.fromEntries([...displayed].map(id => [id, now])) });
      const seen = store.setting<string[]>("desktopWorkspaceNotified", []);
      store.saveSetting("desktopWorkspaceNotified", [...new Set([...seen, ...tokens])].slice(-150));
      return true;
    },
    forget(id: string, identityChanged = false) {
      revisions.set(id, (revisions.get(id) ?? 0) + 1);
      const slot = credentials.serviceProfile(id).binding.slot;
      if (slot) pending.delete(slot);
      store.saveSetting(cacheKey(id), null);
      if (identityChanged) {
        const saved = configuration();
        const items = saved.items.map(item => item.watched?.some(watch => watch.sourceId === id)
          ? { ...item, watched: item.watched.filter(watch => watch.sourceId !== id) } : item);
        if (items.some((item, index) => item !== saved.items[index])) store.saveSetting("desktopWorkspaces", { ...saved, items });
      }
    },
    sync,
    async profiles(id: string, frame: CredentialFrame, conversationId: unknown): Promise<WorkspaceConversationProfiles | null> {
      if (typeof conversationId !== "string" || !/^qq:\d{4,20}:\d{4,20}$/u.test(conversationId)) throw new Error("请选择有效的QQ群会话。");
      const [groups, members] = await Promise.all([
        operation(id, frame, "/api/groups"), operation(id, frame, `/api/groups/${conversationId}/members`),
      ]);
      if (!Array.isArray(groups?.groups) || !members) return null;
      const selected = groups.groups.find((entry: { id?: string } | null) => entry?.id === conversationId);
      if (!selected) return null;
      const { profile } = selected;
      const group = groupMemberDirectory({ items: profile ? [{ ...profile, id: "group" }] : [] })[0];
      return { group: group ? { displayName: group.displayName, summary: group.summary, updatedAt: group.updatedAt } : null,
        members: groupMemberDirectory(members) };
    },
    development(id: string, frame: CredentialFrame, request?: { target: string; requirement: string; requestId: string; acceptance?: string }) {
      return operation(id, frame, "/api/workspace/development/tasks", request);
    },
    developmentAction(id: string, frame: CredentialFrame, request: DevelopmentTaskControl) {
      return operation(id, frame, "/api/workspace/development/tasks/actions", request);
    },
    developmentSupplement(id: string, frame: CredentialFrame, request: DevelopmentDetailsUpdate) {
      return operation(id, frame, "/api/workspace/development/tasks/details", request);
    },
    reply(id: string, frame: CredentialFrame, request: { conversationId: string; text: string; requestId: string }) {
      return operation(id, frame, "/api/workspace/reply", request);
    },
    feature(id: string, frame: CredentialFrame, featureId: string, conversationId: string) {
      if (!/^[a-z0-9-]{1,60}$/u.test(featureId) || typeof conversationId !== "string" || conversationId.length > 100) {
        throw new Error("会话功能标识无效。");
      }
      return operation(id, frame, `/api/workspace/features/${featureId}?conversation=${encodeURIComponent(conversationId)}`);
    },
    async reviewFollowUp(id: string, frame: CredentialFrame, workspaceId: unknown, conversationId: unknown, followUpId: unknown): Promise<LocalReviewReference | null> {
      const belongs = () => configuration().items.some(workspace => workspace.id === workspaceId && workspace.sourceIds.includes(id));
      if (typeof conversationId !== "string" || !/^qq:\d{4,20}:\d{4,20}$/u.test(conversationId) ||
          typeof followUpId !== "string" || !/^[a-f0-9]{64}$/u.test(followUpId) || !belongs()) return null;
      const result = await operation(id, frame, `/api/workspace/features/group-daily-review?conversation=${encodeURIComponent(conversationId)}`);
      return belongs() && Array.isArray(result?.items) && result.items.some((item: WorkspaceFeatureItem | null) => item?.followUpId === followUpId)
        ? { sourceId: id, conversationId, followUpId } : null;
    },
  };
}

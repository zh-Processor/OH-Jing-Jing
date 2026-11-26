import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import type { ModelProfile, Message } from "../runtime/models";
import type { DesktopChatTurn, ServicePermissionChange } from "../runtime/main";
import type { DesktopModelBudget } from "../runtime/desktop-model-budget";
import type { DesktopMemoryCandidate, DesktopMemoryReview } from "../runtime/desktop-memory";
import type { SummaryNotice, SummaryReminders } from "../runtime/desktop-summary-reminders";
import { summaryReminderQuiet, type SummaryReminderPolicy } from "../runtime/summary-reminder-policy";
import type { ImChannelStatus } from "../runtime/im-channel";
import type { ChannelCoverageReport } from "../runtime/channel-coverage";
import type { Role } from "../runtime/roles";
import type { PublishedRole, PublishedRoleInfo } from "../runtime/published-role";
import type { GroupSummary } from "../runtime/group-summary-reference";
import { describePersonality } from "../runtime/personality";
import { careLabels, moodExpression, moodLabels, type CareAction, type CompanionSnapshot, type Mood, type MoodDimension } from "../runtime/companion-state";
import { PersonalityEditor } from "./PersonalityEditor";
import { RoleCardEditor } from "./RoleCardEditor";
import { RoleRehearsal } from "./RoleRehearsal";
import { LocalReminderActions, LocalReminderPanel, useLocalReminders } from "./LocalReminders";
import { call } from "./desktop-ipc";
import { groupSummaryHighlight, summaryReactionLabels, type SummaryReaction } from "../runtime/group-summary-highlight";
import { GroupSummaryExplanation } from "./GroupSummaryExplanation";
import { GroupMemberDirectory } from "./GroupMemberDirectory";
import { ServiceConnections } from "./ServiceConnections";
import { WorkspaceActivity, type WorkspaceConversationTarget } from "./WorkspaceActivity";
import { DesktopInteractionReview } from "./DesktopInteractionReview";
import { DesktopUpdates } from "./DesktopUpdates";
import { ModelBalance } from "./ModelBalance";
import type { DesktopServiceProfile } from "../runtime/desktop-credentials";
import type { DesktopWorkspace, WorkspaceNotice, WorkspaceSource } from "../runtime/desktop-workspaces";
import "./style.css";

type Profile = { displayName: string; summary: string };
type ServiceIdentity = {
  profile: Profile | null;
  account?: { qqId: string; memoryRead: boolean; memoryWrite: boolean };
};
type Group = { id: string; messageCount: number; lastActive: string; profile: Profile | null;
  summary?: GroupSummary; summaryRevision?: string; summaries: GroupSummary[]; publishedRole?: PublishedRoleInfo; followedRole?: PublishedRoleInfo;
  channelCoverage?: ChannelCoverageReport };
type GroupFeed = { groups: Group[]; gatewayStatus: string; channelPlugin?: ImChannelStatus; summaryNotices?: SummaryNotice[];
  channelCoverage?: ChannelCoverageReport };
type Usage = {
  model_id: string; model_name: string; currency: string; requests: number; priced_requests: number; cancelled: number; interrupted: number;
  input_tokens: number | null; output_tokens: number | null; estimated_cost: number | null;
};
type MemorySync = { push: boolean; pull: boolean };
type MemoryPreview = { items: { id: string; version: number; text: string; linked?: true; localText?: string }[]; revision: string };
type DesktopModel = ModelProfile & { backupModelId?: string | null; budget: DesktopModelBudget };
type State = { roles: Role[]; models: DesktopModel[]; usage: Usage[]; serviceAddress: string; pendingModelKeyRemovals: number;
  serviceProfiles: DesktopServiceProfile[]; activeServiceProfile: string | null; serviceEpoch: string; memorySync: MemorySync };
type View = "聊天" | "提醒" | "工作区" | "群动态" | "插件中心" | "设置";
const pluginCategories = ["角色", "IM 渠道"] as const;
type PluginCategory = typeof pluginCategories[number];
const maxRoleFileBytes = 1_048_576;
type RoleImportInspection = { incoming: PublishedRoleInfo; existing: PublishedRoleInfo | null };
const channelCapabilities = { groupText: "群聊文字", groupExpressions: "群聊表情", privateText: "私聊文字",
  voiceInput: "语音转写", voiceOutput: "语音条回复", qqProfile: "QQ 账号资料", qqSpace: "QQ 空间" };
const channelStatuses = { online: "在线", connecting: "连接中", disconnected: "连接断开", disabled: "已停用" };
function ChannelCoverageHint({ report }: { report?: ChannelCoverageReport }) {
  if (!report) return null;
  const duration = (ms: number) => ms >= 60_000 ? `${Math.ceil(ms / 60_000)} 分钟` : `${Math.ceil(ms / 1000)} 秒`;
  const latest = report.gaps[0];
  return <details className="coverage-hint">
    <summary>{report.unavailableMs || report.disabledMs ? "近 24 小时 QQ 网关有覆盖缺口" : "近 24 小时 QQ 网关覆盖"}</summary>
    <p className="meta">在线 {duration(report.onlineMs)} · 断线或连接中 {duration(report.unavailableMs)} · 渠道停用 {duration(report.disabledMs)} · 缺少观测 {duration(report.unobservedMs)}</p>
    {latest && <p className="meta">最近一次{latest.state === "disabled" ? "停用" : "断线或连接中"}从 {new Date(latest.start).toLocaleString()} 到 {new Date(latest.end).toLocaleString()}。</p>}
  </details>;
}
const emptyModel = (): ModelProfile => ({
  id: crypto.randomUUID(), name: "", model: "", baseUrl: "https://api.deepseek.com/v1",
  billing: "deepseek", hasKey: false, inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "",
});

function useDesktopChat(onTurn: (turn: DesktopChatTurn) => void) {
  const callback = useRef(onTurn);
  callback.current = onTurn;
  const current = useRef<DesktopChatTurn | null>(null);
  const observe = useRef<((turn: DesktopChatTurn | null) => void) | null>(null);
  const preparing = useRef(false);
  const [turn, setTurn] = useState<DesktopChatTurn | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let mounted = true;
    let events = 0;
    let reading = false;
    const update = (next: DesktopChatTurn | null) => {
      if (!mounted || (current.current?.id === next?.id && current.current?.status === next?.status &&
          current.current?.backup?.name === next?.backup?.name)) return;
      current.current = next;
      setTurn(next);
      if (next) callback.current(next);
    };
    observe.current = update;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      const version = events;
      try {
        const latest = await call<DesktopChatTurn | null>("chatTurn");
        if (!mounted || version !== events) return;
        const active = current.current;
        update(latest ?? (active?.status === "running"
          ? { ...active, status: "failed", error: "桌宠运行时已重启，可以重试。" } : active));
      } catch { /* Next check can recover an interrupted IPC connection. */ }
      finally { reading = false; }
    };
    const subscription = listen<DesktopChatTurn>("desktop-chat-turn", ({ payload }) => { events++; update(payload); });
    void subscription.then(refresh).catch(refresh);
    const interval = window.setInterval(() => {
      if (current.current?.status === "running") void refresh();
    }, 1500);
    return () => {
      mounted = false;
      observe.current = null;
      window.clearInterval(interval);
      void subscription.then(off => off()).catch(() => {});
    };
  }, []);

  return {
    turn, starting, cancelling, running: turn?.status === "running",
    async start(input: { id: string; roleId: string; modelId: string; text: string }) {
      if (preparing.current || current.current?.status === "running") return false;
      preparing.current = true;
      setStarting(true);
      const previous = current.current;
      try {
        const accepted = await call<DesktopChatTurn>("startChat", input);
        if (current.current === previous) observe.current?.(accepted);
        return true;
      }
      finally { preparing.current = false; setStarting(false); }
    },
    async cancel() {
      const active = current.current;
      if (!active || active.status !== "running" || cancelling) return;
      setCancelling(true);
      try { await call("cancelChat", { id: active.id }); }
      finally { setCancelling(false); }
    },
  };
}
function legacySummaryWatch(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem("groupReactions") ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ?
      Object.keys(value).filter(id => value[id] === true) : [];
  } catch { return []; }
}
function useSummaryReminders() {
  const [reminders, setReminders] = useState<SummaryReminders>();
  useEffect(() => {
    let current = true;
    let revision = 0;
    const refresh = (legacyWatch?: string[]) => {
      const request = ++revision;
      void call<SummaryReminders>("summaryReminders", { legacyWatch })
        .then(value => { if (current && request === revision) setReminders(value); }).catch(() => {});
    };
    const subscription = listen("desktop-summary-reminders-updated", () => refresh());
    const connection = listen("desktop-service-updated", () => { setReminders(undefined); refresh(); });
    const migrate = () => refresh(legacySummaryWatch());
    void subscription.then(migrate).catch(migrate);
    return () => {
      current = false;
      void subscription.then(off => off()).catch(() => {});
      void connection.then(off => off()).catch(() => {});
    };
  }, []);
  return {
    reminders,
    async update(action: "setSummaryWatch" | "saveSummaryReminderPolicy", args: object) {
      const value = await call<SummaryReminders>(action, args);
      setReminders(value);
      void emit("desktop-summary-reminders-updated", {}).catch(() => {});
    },
  };
}

async function canShowSummaryReminder(policy: SummaryReminderPolicy) {
  if (summaryReminderQuiet(policy, new Date())) return false;
  if (!policy.deferFullscreen) return true;
  try {
    return !await invoke<boolean>("system_defers_reminders") && !summaryReminderQuiet(policy, new Date());
  } catch { return false; }
}

function useSummaryReminderAvailability(policy: SummaryReminderPolicy | undefined, active: boolean) {
  const [result, setResult] = useState<{ policy: SummaryReminderPolicy; allowed: boolean; quiet: boolean }>();
  useEffect(() => {
    if (!policy || !active) { setResult(undefined); return; }
    const settings = policy;
    let current = true;
    let checking = false;
    async function check() {
      if (checking) return;
      checking = true;
      try {
        const allowed = await canShowSummaryReminder({ ...settings, quietHours: false });
        const quiet = summaryReminderQuiet(settings, new Date());
        if (current) setResult(previous => previous?.policy === settings && previous.allowed === allowed && previous.quiet === quiet
          ? previous : { policy: settings, allowed, quiet });
      } finally { checking = false; }
    }
    void check();
    const interval = window.setInterval(() => void check(), 1000);
    return () => { current = false; window.clearInterval(interval); };
  }, [policy, active]);
  return active && result?.policy === policy ? result : undefined;
}

function SummaryReminderForm({ policy, busy, onSave }: {
  policy: SummaryReminderPolicy; busy: boolean; onSave: (policy: SummaryReminderPolicy) => void;
}) {
  const [draft, setDraft] = useState(policy);
  return <form className="form-grid" onSubmit={event => { event.preventDefault(); onSave(draft); }}>
    <label className="inline"><input type="checkbox" checked={draft.paused}
      onChange={e => setDraft({ ...draft, paused: e.target.checked })} />暂停摘要气泡</label>
    <label className="inline"><input type="checkbox" checked={draft.quietHours}
      onChange={e => setDraft({ ...draft, quietHours: e.target.checked })} />启用勿扰时段</label>
    <label>勿扰开始<input type="time" required disabled={!draft.quietHours} value={draft.quietStart}
      onChange={e => setDraft({ ...draft, quietStart: e.target.value })} /></label>
    <label>勿扰结束<input type="time" required disabled={!draft.quietHours} value={draft.quietEnd}
      onChange={e => setDraft({ ...draft, quietEnd: e.target.value })} /></label>
    <label className="inline"><input type="checkbox" checked={draft.deferFullscreen}
      onChange={e => setDraft({ ...draft, deferFullscreen: e.target.checked })} />全屏、演示或锁屏时延后</label>
    <button className="primary" disabled={busy}>保存提醒设置</button>
  </form>;
}
const moodDimensions = Object.keys(moodLabels) as MoodDimension[];
const careActions = Object.keys(careLabels) as CareAction[];
function useCompanion(roleId?: string, completedTurnId?: string) {
  const [state, setState] = useState<{ roleId: string; snapshot: CompanionSnapshot }>();
  useEffect(() => {
    if (!roleId) return;
    let current = true;
    const refresh = () => void call<CompanionSnapshot>("companionState", { roleId }).then(snapshot => {
      if (current) setState({ roleId, snapshot });
    }).catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 30000);
    const event = listen("companion-updated", refresh);
    return () => {
      current = false;
      window.clearInterval(timer);
      void event.then(unlisten => unlisten()).catch(() => {});
    };
  }, [roleId, completedTurnId]);
  return state?.roleId === roleId ? state?.snapshot : undefined;
}

function announceCompanionUpdate() {
  void emit("companion-updated", {}).catch(() => {});
}
function openWorkspaceFromPet(target: WorkspaceConversationTarget) {
  const { sourceId, conversationId } = target;
  localStorage.setItem("desktopWorkspacePendingNavigation", JSON.stringify({ sourceId, conversationId }));
  void invoke("show_main").then(() => emit("desktop-workspace-open", {})).catch(() => {});
}
function SummaryTime({ summary }: { summary: GroupSummary }) {
  const { source_start: start, source_end: end } = summary;
  return <span>
    {start && end && <>覆盖 {new Date(start).toLocaleString()} 至 {new Date(end).toLocaleString()} · </>}
    生成于 {new Date(summary.created_at).toLocaleString()}
  </span>;
}
const topicFactNames = { proposal: "提议", decision: "已确认", change: "已确认的变更", open: "待定", retraction: "已撤回" };

function SummaryTopics({ summary }: { summary: GroupSummary }) {
  if (!Array.isArray(summary.topics)) return null;
  return <>{summary.topics.map(topic => <details key={topic.title}>
    <summary>{topic.title}</summary>
    <p>{topic.content}</p>
    {topic.coverage !== "complete" && <p className="meta">{topic.coverage === "partial" ? "部分原文已不可用" : "原文已超出可用范围"}</p>}
    {topic.facts.length > 0 && <ul>{topic.facts.map((fact, index) => <li key={index}>
      <strong>{fact.kind === "change" && fact.reported === true ? "群友报告" :
        fact.kind === "decision" && fact.reaffirms === true ? "原决定仍有效" : topicFactNames[fact.kind]}</strong> · {fact.text}
    </li>)}</ul>}
  </details>)}</>;
}
function SummaryHighlight({ summary }: { summary: GroupSummary }) {
  const highlight = groupSummaryHighlight(summary.topics);
  if (!highlight || highlight.reaction === "topic") return null;
  return <div className="summary-highlight" data-summary-reaction={highlight.reaction}>
    <strong>{summaryReactionLabels[highlight.reaction]} · {highlight.title}</strong>
    {highlight.reaction === "reported-question" && <p>{highlight.report}</p>}
    <p>{highlight.detail}</p>
  </div>;
}
function ProfileCard({ profile }: { profile: Profile }) {
  return <div className="profile"><strong>{profile.displayName}</strong><p>{profile.summary}</p></div>;
}

function ModelBudgetEditor({ model, busy, save }: {
  model: DesktopModel; busy: boolean; save: (limits: DesktopModelBudget["limits"]) => void;
}) {
  const { budget } = model;
  const periods = [{ id: "daily", name: "每日", status: "今日" }, { id: "monthly", name: "每月", status: "本月" }] as const;
  const number = (value: number) => value.toLocaleString(undefined, { maximumSignificantDigits: 8 });
  return <details className="model-budget">
    <summary>本机模型预算</summary>
    <form className="form-grid" key={JSON.stringify([model.id, budget.currency, budget.limits])} onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const value = (name: string) => {
        const raw = data.get(name);
        return typeof raw === "string" && raw !== "" ? Number(raw) : null;
      };
      save({ requests: { daily: value("daily-requests"), monthly: value("monthly-requests") },
        cost: { daily: value("daily-cost"), monthly: value("monthly-cost") } });
    }}>
      {periods.map(({ id, name }) => <React.Fragment key={id}>
        <label>{name}请求上限<input name={`${id}-requests`} type="number" min="0" step="1" placeholder="不限"
          defaultValue={budget.limits.requests[id] ?? ""} /></label>
        <label>{name}估算费用上限（{budget.currency}）<input name={`${id}-cost`} type="number" min="0" step="any" placeholder="不限"
          defaultValue={budget.limits.cost[id] ?? ""} /></label>
      </React.Fragment>)}
      <div className="tools"><button disabled={busy}>保存预算</button></div>
    </form>
    <p className="meta">留空为不限。填 0 暂停该档案。按北京时间结算，费用在请求结束后估算，单次请求可能超过剩余额度。</p>
    {periods.map(({ id, status }) => {
      const used = budget[id];
      const limit = budget.limits;
      return <p className="meta budget-usage" key={id}>{status} · {used.requests}{limit.requests[id] === null ? "" : "/" + limit.requests[id]} 次
        · {budget.currency} {number(used.cost)}{limit.cost[id] === null ? "" : "/" + number(limit.cost[id])}
        {!!used.unpriced && <> · {used.unpriced} 次未计价</>}
        {!!used.pending && <> · {used.pending} 次计量中</>}
      </p>;
    })}
  </details>;
}
function MemoryCandidateEditor({ candidate, busy, decide }: {
  candidate: DesktopMemoryCandidate; busy: boolean; decide: (accept: boolean, text?: string) => void;
}) {
  const [text, setText] = useState(candidate.text);
  return <form className="profile" onSubmit={event => {
    event.preventDefault();
    decide(true, text);
  }}>
    <label>记忆候选<textarea value={text} maxLength={400} rows={2} onChange={event => setText(event.target.value)} /></label>
    <p className="meta">原话「{candidate.excerpt}」</p>
    <div className="tools">
      <button disabled={busy || !text.trim()}>采纳</button>
      <button type="button" disabled={busy} onClick={() => decide(false)}>忽略</button>
    </div>
  </form>;
}

function Pet({ busy, role, mood, care, summaryReaction }: {
  busy: boolean; role?: Role; mood?: Mood; care?: CareAction; summaryReaction?: SummaryReaction;
}) {
  return <div className={`pet ${busy ? "thinking" : ""}`} data-mood={mood ? moodExpression(mood) : undefined}
    data-care={care} data-summary-reaction={summaryReaction} role="img" aria-label={role?.name ?? "大肥鱼"}>
    {role?.avatar ? <img className="pet-avatar" alt="" src={role.avatar} /> :
      <><i className="tail"/><i className="body"/><i className="belly"/><i className="fin"/><i className="eye"/><i className="blush"/></>}
    {care && <span className="pet-effect" aria-hidden="true"><b/><b/><b/></span>}
  </div>;
}
function App() {
  const [view, setView] = useState<View>("聊天");
  const [workspaceNavigation, setWorkspaceNavigation] = useState<WorkspaceConversationTarget>();
  const [pluginCategory, setPluginCategory] = useState<PluginCategory>("角色");
  const [state, setState] = useState<State>({ roles: [], models: [], usage: [], serviceAddress: "", serviceProfiles: [], pendingModelKeyRemovals: 0,
    activeServiceProfile: null, serviceEpoch: "", memorySync: { push: false, pull: false } });
  const [roleId, setRole] = useState(localStorage.getItem("roleId") ?? "ohjingjing.dafeiyu");
  const [modelId, setModelId] = useState(localStorage.getItem("modelId") ?? "");
  const [editing, setEditing] = useState<ModelProfile>(emptyModel);
  const [key, setKey] = useState("");
  const [roleJson, setRoleJson] = useState("");
  const [roleEditing, setRoleEditing] = useState<PublishedRole | null>(null);
  const [roleImport, setRoleImport] = useState<RoleImportInspection | null>(null);
  const [savedMemory, setMemories] = useState<{ roleId: string; items: { id: number; text: string }[] }>();
  const [memoryReview, setMemoryReview] = useState<{ roleId: string; state: DesktopMemoryReview }>();
  const memoryDetails = useRef<HTMLDetailsElement>(null);
  const memoryDetailsPending = useRef(false);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [memoryPreview, setMemoryPreview] = useState<MemoryPreview | null>(null);
  const [memoryId, setMemoryId] = useState<number | null>(null);
  const [history, setHistory] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const chatDraft = useRef<{ id: string; text: string } | undefined>(undefined);
  const [groups, setGroups] = useState<Group[]>([]);
  const groupLoad = useRef(0);
  const [connected, setConnected] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState("");
  const [channelPlugin, setChannelPlugin] = useState<ImChannelStatus>();
  const [rolePreview, setRolePreview] = useState<{ groupId: string; entry: PublishedRole } | null>(null);
  const { reminders, update: updateReminders } = useSummaryReminders();
  const localReminders = useLocalReminders();
  const [mine, setMine] = useState<Profile | null>(null);
  const [identity, setIdentity] = useState<ServiceIdentity["account"]>();
  const [groupId, setGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [includeSelf, setIncludeSelf] = useState(localStorage.getItem("includeSelf") === "true");
  const [modelSaveRevision, setModelSaveRevision] = useState(0);
  const chat = useDesktopChat(next => {
    if (next.status === "running") return;
    if (chatDraft.current?.id === next.id) {
      const sent = chatDraft.current.text;
      chatDraft.current = undefined;
      if (next.status === "completed") setText(current => current === sent ? "" : current);
    }
    void refreshModelUsage().catch(() => {});
  });
  const completedTurn = chat.turn?.status === "completed" ? chat.turn.id : undefined;
  const chatBusy = chat.running || chat.starting;
  const ownTurn = chat.turn?.roleId === roleId ? chat.turn : null;
  const role = state.roles.find(item => item.id === roleId);
  const companion = useCompanion(role?.id, completedTurn);
  const group = groups.find(item => item.id === groupId);
  const publicGroupRole = group?.publishedRole;
  const model = state.models.find(item => item.id === modelId);
  const savedEditing = state.models.find(item => item.id === editing.id);
  const editingBilling = savedEditing && (!!key.trim() || savedEditing.baseUrl !== editing.baseUrl.trim() || savedEditing.billing !== editing.billing);
  const memories = savedMemory?.roleId === roleId ? savedMemory.items : [];
  const review = memoryReview?.roleId === roleId ? memoryReview.state : undefined;
  const memoryTarget = { roleId, serviceEpoch: state.serviceEpoch };

  async function refresh() {
    const next = await call<State>("state");
    setState(next);
    setModelId(current => next.models.some(item => item.id === current) ? current :
      (next.models.find(item => item.hasKey) ?? next.models[0])?.id ?? "");
    setRole(current => next.roles.some(item => item.id === current) ? current : next.roles[0]?.id ?? current);
    return next;
  }
  async function refreshModelUsage() {
    const { models, usage, pendingModelKeyRemovals } = await call<State>("state");
    setState(current => ({ ...current, models, usage, pendingModelKeyRemovals }));
  }
  useEffect(() => { void refresh().catch(error => setNotice(String(error))); }, []);
  useEffect(() => { if (view === "设置") void refreshModelUsage().catch(() => {}); }, [view]);
  useEffect(() => {
    localStorage.setItem("roleId", roleId);
    let active = true;
    void call<Message[]>("history", { roleId }).then(next => { if (active) setHistory(next); })
      .catch(error => { if (active) setNotice(String(error)); });
    return () => { active = false; };
  }, [roleId, completedTurn]);
  useEffect(() => { localStorage.setItem("modelId", modelId); }, [modelId]);

  async function refreshMemory() {
    setMemories({ roleId, items: await call<{ id: number; text: string }[]>("listMemory", { roleId }) });
  }

  function openMemoryReview() {
    if (memoryDetails.current) {
      memoryDetails.current.open = true;
      memoryDetails.current.querySelector("summary")?.focus();
    } else {
      memoryDetailsPending.current = true;
      setView("设置");
    }
  }
  useEffect(() => {
    if (!memoryDetailsPending.current || view !== "设置" || !memoryDetails.current) return;
    memoryDetailsPending.current = false;
    openMemoryReview();
  }, [view]);

  function afterInteractionReview() {
    void refreshModelUsage().catch(() => {});
    void call<DesktopMemoryReview>("memoryReview", { roleId }).then(state => {
      setMemoryReview(current => current && current.roleId !== roleId ? current : { roleId, state });
    }).catch(() => {});
  }

  useEffect(() => {
    setMemoryId(null);
    setMemoryDraft("");
    setMemoryPreview(null);
    if (view !== "设置") return;
    let active = true;
    void call<{ id: number; text: string }[]>("listMemory", { roleId })
      .then(items => { if (active) setMemories({ roleId, items }); })
      .catch(error => { if (active) setNotice(String(error)); });
    return () => { active = false; };
  }, [view, roleId]);
  useEffect(() => {
    if (view !== "设置") return;
    let active = true;
    void call<DesktopMemoryReview>("memoryReview", { roleId })
      .then(state => { if (active) setMemoryReview({ roleId, state }); })
      .catch(error => { if (active) setNotice(String(error)); });
    return () => { active = false; };
  }, [view, roleId, completedTurn]);

  function clearGroupView() {
    setGroups([]);
    setMine(null);
    setIdentity(undefined);
    setConnected(false);
    setGatewayStatus("");
    setChannelPlugin(undefined);
    setRolePreview(null);
  }

  useEffect(() => {
    const subscription = listen<ServicePermissionChange>("desktop-service-permissions", ({ payload }) => {
      if (payload.subscription === false) {
        groupLoad.current++;
        clearGroupView();
        setNotice("服务端订阅已失效，请核对令牌。");
      } else {
        setIdentity(current => current && { ...current,
          memoryRead: current.memoryRead && payload.memoryRead !== false,
          memoryWrite: current.memoryWrite && payload.memoryWrite !== false });
      }
      if (payload.memoryRead === false) setMemoryPreview(null);
      setState(current => ({ ...current, memorySync: {
        pull: current.memorySync.pull && payload.memoryRead !== false,
        push: current.memorySync.push && payload.memoryWrite !== false,
      } }));
    });
    return () => { void subscription.then(off => off()).catch(() => {}); };
  }, []);

  async function loadGroups(silent = false, serviceEpoch = state.serviceEpoch, preferredGroup?: string) {
    const request = ++groupLoad.current;
    try {
      const [result, me] = await Promise.all([
        call<GroupFeed>("groups", { serviceEpoch }),
        call<ServiceIdentity>("self", { serviceEpoch }),
      ]);
      if (request !== groupLoad.current) return;
      setGroups(result.groups.map(group => ({ ...group, channelCoverage: result.channelCoverage })));
      setRolePreview(previous => previous && result.groups.some(item => item.id === previous.groupId &&
        item.publishedRole?.revision === previous.entry.info.revision) ? previous : null);
      setMine(me.profile);
      setIdentity(me.account);
      setConnected(true);
      setGatewayStatus(result.gatewayStatus);
      setChannelPlugin(result.channelPlugin);
      setGroupId(current => {
        const wanted = preferredGroup ?? current;
        return result.groups.some(item => item.id === wanted) ? wanted : result.groups[0]?.id ?? "";
      });
      if (!silent) setNotice(result.gatewayStatus === "online" ? "" : "群网关当前未在线，显示已同步的数据。");
    } catch (error) {
      if (request !== groupLoad.current) return;
      clearGroupView();
      if (!silent) setNotice(String(error));
    }
  }
  useEffect(() => {
    if (!state.serviceAddress) return;
    const active = view === "群动态" || view === "插件中心";
    if (!active) return;
    void loadGroups(view !== "群动态");
    const interval = setInterval(() => void loadGroups(true), 30_000);
    return () => clearInterval(interval);
  }, [view, state.serviceEpoch, state.serviceAddress]);

  async function perform(action: () => Promise<unknown>) {
    setNotice("");
    setBusy(true);
    try { await action(); } catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  }

  function retireModel(model: DesktopModel, removing: boolean) {
    const confirmation = removing ? "移除此模型档案及其本机 API Key？已记录的用量将保留。"
      : "移除此档案的本机 API Key？模型设置和用量将保留。";
    if (!window.confirm("「" + model.name + "」\n" + confirmation)) return;
    void perform(async () => {
      await call(removing ? "removeModel" : "clearModelKey", { modelId: model.id });
      const next = await refresh();
      const preferred = next.models.find(item => item.hasKey) ?? next.models[0];
      const edited = next.models.find(item => item.id === model.id);
      setEditing(current => current.id === model.id ? edited ?? preferred ?? emptyModel() : current);
      setModelId(current => current === model.id ? preferred?.id ?? "" : current);
      setKey("");
      setModelSaveRevision(value => value + 1);
      setNotice(removing ? "模型档案已移除。" : next.pendingModelKeyRemovals ? "本机 API Key 已停用。" : "本机 API Key 已清除。");
    });
  }

  function changeService(operation: () => Promise<unknown>, preferredGroup?: string) {
    void perform(async () => {
      await operation();
      groupLoad.current++;
      clearGroupView();
      setMemoryPreview(null);
      void emit("desktop-service-updated", {}).catch(() => {});
      const next = await refresh();
      if (next.serviceAddress) await loadGroups(false, next.serviceEpoch, preferredGroup);
    });
  }

  function openWorkspaceConversation(sourceId: string, conversationId: string) {
    setView("群动态");
    if (state.activeServiceProfile === sourceId) void loadGroups(false, state.serviceEpoch, conversationId);
    else changeService(() => call("selectServiceProfile", { id: sourceId }), conversationId);
  }

  useEffect(() => {
    function openPending() {
      const stored = localStorage.getItem("desktopWorkspacePendingNavigation");
      if (!stored || !state.serviceProfiles.length) return;
      localStorage.removeItem("desktopWorkspacePendingNavigation");
      let target: WorkspaceConversationTarget;
      try { target = JSON.parse(stored); }
      catch { return; }
      if (typeof target?.conversationId !== "string" || !state.serviceProfiles.some(item => item.id === target.sourceId)) return;
      setView("工作区");
      setWorkspaceNavigation(target);
    }
    openPending();
    const subscribed = listen("desktop-workspace-open", openPending);
    return () => { void subscribed.then(off => off()).catch(() => {}); };
  }, [state.serviceProfiles, state.serviceEpoch]);

  async function useDesktopRole(role: Role, notice: string) {
    await refresh();
    setRole(role.id);
    setNotice(notice);
    void emit("desktop-role-updated", {}).catch(() => {});
  }

  function readImportDraft(): unknown {
    if (new TextEncoder().encode(roleJson).length > maxRoleFileBytes) throw new Error("角色文件不能超过 1 MiB。");
    try { return JSON.parse(roleJson.replace(/^\uFEFF/u, "")); }
    catch { throw new Error("角色 JSON 格式不正确。"); }
  }

  async function importDesktopRole(input: unknown, expectedRevision: string | null, mode: "install" | "replace" | "copy") {
    const saved = await call<Role>("importRole", { role: input, expectedRevision, mode });
    await useDesktopRole(saved, mode === "copy" ? "已导入为独立角色。" : "角色已导入。");
    setRoleJson("");
    setRoleImport(null);
  }

  function setGroupReaction(groupId: string, enabled: boolean) {
    void perform(async () => {
      await updateReminders("setSummaryWatch", { groupId, enabled, serviceEpoch: state.serviceEpoch });
      if (enabled) void call("groups").catch(() => {});
    });
  }
  async function talk(prompt: string) {
    if (!model?.hasKey) { setNotice("请先在设置中为个人聊天配置自己的模型和 API Key。"); return; }
    const value = prompt.trim();
    if (!value || chatBusy || chatDraft.current) return;
    setView("聊天");
    setNotice("");
    const id = crypto.randomUUID();
    chatDraft.current = { id, text: prompt };
    try {
      if (await chat.start({ id, roleId, modelId, text: value })) return;
    } catch (error) { setNotice(String(error)); }
    if (chatDraft.current?.id === id) chatDraft.current = undefined;
  }
  return <main className="layout">
    <aside className="rail">
      <div className="brand"><b>OJ</b><span>OHJingJing</span></div>
      <Pet busy={busy || chatBusy} role={role} mood={companion?.mood} />
      <h1>{role?.name ?? "大肥鱼"}</h1>
      <p>{connected ? "群动态已连接" : "本地陪伴"}</p>
      <button onClick={() => void invoke("show_pet").catch(error => setNotice(String(error)))}>显示桌面宠物</button>
      <nav aria-label="主要页面">{(["聊天", "提醒", "工作区", "群动态", "插件中心", "设置"] as View[]).map(tab =>
        <button key={tab} className={view === tab ? "selected" : ""} onClick={() => { setView(tab); setNotice(""); }}>
          {tab}{tab === "提醒" && localReminders.due.length > 0 && <span className="local-reminder-count"> {localReminders.due.length} 条到期</span>}
        </button>
      )}</nav>
    </aside>
    <section className="pane">
      {notice && <div role="status" className="notice">{notice}</div>}
      <DesktopUpdates active={view === "设置"} chatBusy={busy || chatBusy} />
      {view === "提醒" && <LocalReminderPanel reminders={localReminders} openSettings={() => setView("设置")} openReview={review => {
        setView("工作区");
        setWorkspaceNavigation({ sourceId: review.sourceId, conversationId: review.conversationId });
      }} />}
      <div hidden={view !== "工作区"}>
        <WorkspaceActivity active={view === "工作区"} profiles={state.serviceProfiles} revision={state.serviceEpoch} model={model} roleId={roleId}
          completedTurn={completedTurn} openMemoryReview={openMemoryReview} afterInteractionReview={afterInteractionReview}
          navigation={workspaceNavigation} openSettings={() => setView("设置")}
          openConversation={openWorkspaceConversation} />
      </div>
      {view === "聊天" && <>
        <header><h2>个人聊天</h2><label className="inline">当前模型
          <select value={modelId} disabled={busy || chatBusy} onChange={e => setModelId(e.target.value)}>
            <option value="">选择模型</option>
            {state.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label></header>
        <div className="history" aria-live="polite">
          {history.length === 0 && !chatBusy && <p className="empty">{model?.hasKey ? "说点什么吧。" : "在设置中配置自己的模型和 API Key 后即可试聊。"}</p>}
          {history.map((message, index) => <p className={`bubble ${message.role}`} key={index}>{message.content}</p>)}
          {ownTurn?.status === "running" && <p className="bubble user pending">{ownTurn.question}</p>}
          {chatBusy && <p className="empty">{chat.cancelling ? "正在停止…" : chat.running && !ownTurn ? "另一角色正在生成…" :
            ownTurn?.backup ? `正在使用备用模型「${ownTurn.backup.name}」…` : "正在生成回复…"}</p>}
          {ownTurn?.status === "completed" && ownTurn.backup && <p className="meta">备用模型「{ownTurn.backup.name}」已回复 · 主模型{ownTurn.backup.reason}</p>}
          {!chatBusy && ownTurn?.status === "cancelled" && <p className="empty">已停止生成。</p>}
          {!chatBusy && ownTurn?.status === "failed" && <p className="empty">{ownTurn.error}</p>}
        </div>
        <form className="composer" onSubmit={e => { e.preventDefault(); void talk(text); }}>
          <input placeholder="给桌宠发消息" aria-label="给桌宠发消息" value={text} maxLength={4000}
            onChange={e => setText(e.target.value)} />
          {chat.running ? <button type="button" disabled={chat.cancelling} onClick={() =>
            void chat.cancel().catch(error => setNotice(String(error)))}>停止生成</button> :
            <button className="primary" disabled={busy || chatBusy || !text.trim()}>发送</button>}
        </form>
      </>}
      {view === "群动态" && <>
        <header><h2>群动态</h2><button onClick={() => void loadGroups()}>刷新</button></header>
        {!state.serviceAddress && <p className="empty">配置服务地址和订阅令牌即可查看群摘要和画像。</p>}
        {mine && <section><h3>我的画像</h3><ProfileCard profile={mine} /></section>}
        {groups.length > 0 && <>
          <label>关注的群<select value={groupId} onChange={e => setGroupId(e.target.value)}>
            {groups.map(item => <option key={item.id} value={item.id}>{item.profile?.displayName ?? item.id.split(":").at(-1)}</option>)}
          </select></label>
          {group && <section className="card">
            <h3>{group.profile?.displayName ?? "群聊摘要"}</h3>
            <p className="meta">观察到 {group.messageCount} 条 · {new Date(group.lastActive).toLocaleString()}</p>
            <ChannelCoverageHint report={group.channelCoverage} />
            {group.profile && <p>{group.profile.summary}</p>}
            {group.summary && <SummaryHighlight summary={group.summary} />}
            <p>{group.summary?.content ?? "还没有可查看的摘要。"}</p>
            <label className="inline"><input type="checkbox" disabled={!reminders || busy} checked={reminders?.watched.includes(group.id) ?? false}
              onChange={e => setGroupReaction(group.id, e.target.checked)} />此群有新摘要时让桌宠提醒</label>
            {group.publishedRole && <p className="meta">当前由{group.followedRole
              ? `「${group.followedRole.name}」${group.followedRole.version}` : `本地角色「${role?.name ?? "大肥鱼"}」`}讲解。
              <button type="button" onClick={() => { setPluginCategory("角色"); setView("插件中心"); }}>管理群角色</button>
            </p>}
            {group.summary && <><p className="meta"><SummaryTime summary={group.summary} /></p>
              <SummaryTopics summary={group.summary} />
              {group.summaryRevision && <GroupSummaryExplanation key={JSON.stringify([state.serviceEpoch, group.id, group.summaryRevision, roleId, group.followedRole?.revision])}
                groupId={group.id} revision={group.summaryRevision} roleId={roleId} serviceEpoch={state.serviceEpoch}
                groupRoleRevision={group.followedRole?.revision} />}
            </>}
            {group.summaries?.length > 1 && <details>
              <summary>最近话题回顾</summary>
              {group.summaries.slice(1).map(item => <div className="profile" key={item.id ?? item.created_at}>
                <small><SummaryTime summary={item} /></small>
                <p>{item.content}</p>
                <SummaryTopics summary={item} />
              </div>)}
            </details>}
          </section>}
          {group && <GroupMemberDirectory key={JSON.stringify([state.serviceEpoch, group.id])} groupId={group.id}
            model={model} roleId={roleId} serviceEpoch={state.serviceEpoch} groupRoleRevision={group.followedRole?.revision} />}
        </>}
        {connected && groups.length === 0 && <p className="empty">当前没有获授权的群。</p>}
      </>}
      {view === "插件中心" && <>
        <header><h2>插件中心</h2></header>
        <nav className="tools" aria-label="插件类别">{pluginCategories.map(category =>
          <button type="button" key={category} aria-pressed={pluginCategory === category}
            className={pluginCategory === category ? "primary" : ""}
            onClick={() => setPluginCategory(category)}>{category}</button>)}</nav>
        {pluginCategory === "角色" && <>
        <section className="card plugin-card">
          <h3>本地角色</h3>
          <label>当前角色<select value={roleId} disabled={busy} onChange={e => setRole(e.target.value)}>
            {state.roles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.version}
              {item.id === "ohjingjing.dafeiyu" ? " · 内置" : ""}
            </option>)}
          </select></label>
          {role && <div className="tools">
            {role.id !== "ohjingjing.dafeiyu" && <button disabled={busy} onClick={() => void perform(async () =>
              setRoleEditing(await call<PublishedRole>("getRoleCard", { roleId: role.id })))}>编辑角色</button>}
            <button disabled={busy} onClick={() => void perform(async () => {
              const copy = await call<Role>("copyRole", { roleId: role.id });
              await useDesktopRole(copy, "已复制为独立本地角色。");
            })}>复制为本地角色</button>
            <button disabled={busy} onClick={() => void perform(async () => {
              if (await invoke<boolean>("save_role_file", { roleId: role.id })) setNotice("角色 JSON 已导出。");
            })}>导出角色 JSON</button>
          </div>}
          {role && roleEditing?.role.id === role.id && <RoleCardEditor key={roleEditing.info.revision}
            role={roleEditing.role} busy={busy} onClose={() => setRoleEditing(null)}
            onSave={draft => void perform(async () => {
              const saved = await call<Role>("editRole", { role: draft, expectedRevision: roleEditing.info.revision });
              await useDesktopRole(saved, "角色已更新。");
              setRoleEditing(null);
              announceCompanionUpdate();
            })} />}
          {role && <RoleRehearsal key={role.id} roleId={role.id} models={state.models} initialModel={modelId} />}
          {role && <PersonalityEditor key={JSON.stringify([role.id, role.version, role.personality])}
            personality={role.personality} busy={busy} onSave={personality => void perform(async () => {
              const updated = await call<Role>("setRolePersonality", { roleId: role.id, personality });
              setState(current => ({ ...current, roles: current.roles.map(item => item.id === updated.id ? updated : item) }));
              setNotice(personality ? "已保存当前角色的人格偏好。" : "已恢复角色默认人格。");
              void emit("desktop-role-updated", {}).catch(() => {});
              announceCompanionUpdate();
            })} />}
          {role && companion && <details><summary>当前心情与熟悉度</summary>
            <dl className="mood-values">{moodDimensions.map(key => <div key={key}>
              <dt>{moodLabels[key]}</dt><dd>{Math.round(companion.mood[key])}</dd>
            </div>)}</dl>
            <p className="meta">熟悉度 · {companion.familiarity}</p>
            <button type="button" disabled={busy} onClick={() => {
              if (!window.confirm("将这个角色的本机心情与熟悉度恢复初始状态？")) return;
              void perform(async () => {
                await call("resetCompanion", { roleId: role.id });
                announceCompanionUpdate();
                setNotice("已恢复初始状态。");
              });
            }}>重置相处状态</button>
          </details>}
          <details><summary>新建角色</summary>
            <form className="plugin-card" onSubmit={event => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              void perform(async () => {
                const saved = await call<Role>("createRole", {
                  id: `local.${crypto.randomUUID()}`, name: data.get("name"), persona: data.get("persona"), version: "1.0.0",
                });
                await useDesktopRole(saved, "角色已创建，可继续调整人格。");
                form.reset();
              });
            }}>
              <label>角色名称<input name="name" required maxLength={60} /></label>
              <label>角色设定<textarea name="persona" required maxLength={16000} placeholder="填写角色是谁、喜欢什么、怎样与人相处。" /></label>
              <button disabled={busy}>创建并启用</button>
            </form>
          </details>
          <details><summary>导入角色 JSON</summary>
            <p className="meta">可在角色 JSON 的 avatar 字段加入内嵌 PNG 头像，尺寸最高 512×512。</p>
            <input type="file" accept="application/json,.json" onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              if (file.size > maxRoleFileBytes) { setNotice("角色文件不能超过 1 MiB。"); return; }
              void file.text().then(text => { setRoleJson(text); setRoleImport(null); })
                .catch(() => setNotice("无法读取角色文件。"));
            }} />
            <textarea aria-label="角色 JSON" placeholder='{"id":"my.role","name":"我的角色","version":"1.0.0","persona":"角色设定"}' value={roleJson}
              onChange={e => { setRoleJson(e.target.value); setRoleImport(null); }} />
            <button disabled={busy || !roleJson.trim()} onClick={() => void perform(async () => {
              const input = readImportDraft();
              const inspection = await call<RoleImportInspection>("inspectRoleImport", { role: input });
              if (inspection.existing && inspection.existing.revision !== inspection.incoming.revision) {
                setRoleImport(inspection);
                return;
              }
              await importDesktopRole(input, inspection.existing?.revision ?? null, "install");
            })}>导入</button>
            {roleImport?.existing && <div className="profile">
              <p>角色 ID 已存在。当前为「{roleImport.existing.name}」{roleImport.existing.version}，待导入为「{roleImport.incoming.name}」{roleImport.incoming.version}。</p>
              <div className="tools">
                <button disabled={busy} onClick={() => void perform(() => importDesktopRole(readImportDraft(), null, "copy"))}>导入为独立副本</button>
                {roleImport.incoming.id !== "ohjingjing.dafeiyu" && <button disabled={busy}
                  onClick={() => void perform(() => importDesktopRole(readImportDraft(), roleImport.existing!.revision, "replace"))}>替换已有角色</button>}
              </div>
            </div>}
          </details>
        </section>
        <section className="card plugin-card">
          <header><h3>服务端角色</h3><button disabled={!state.serviceAddress || busy} onClick={() => void loadGroups()}>刷新</button></header>
          {!state.serviceAddress && <button onClick={() => setView("设置")}>配置服务连接</button>}
          {state.serviceAddress && !connected && <p className="meta">连接服务后查看授权群已发布的角色。</p>}
          {connected && !groups.some(item => item.publishedRole) && <p className="meta">授权群还没有发布角色。</p>}
          {groups.some(item => item.publishedRole) && <label>来源群<select value={groupId} onChange={e => {
            setGroupId(e.target.value); setRolePreview(null);
          }}>{groups.map(item => <option key={item.id} value={item.id}>{item.profile?.displayName ?? item.id.split(":").at(-1)}</option>)}</select></label>}
          {group && publicGroupRole && <>
            <p>{publicGroupRole.name} · {publicGroupRole.version}</p>
            {group.followedRole && <p className="meta">本群讲解使用 {group.followedRole.name} · {group.followedRole.version}。
              {group.followedRole.revision !== publicGroupRole.revision && " 有更新内容可预览。"}</p>}
            <div className="tools">
              <button disabled={busy} onClick={() => void perform(async () => {
                const entry = await call<PublishedRole>("previewGroupRole", { groupId: group.id, revision: publicGroupRole.revision, serviceEpoch: state.serviceEpoch });
                setRolePreview({ groupId: group.id, entry });
              })}>预览角色</button>
              {group.followedRole && <button disabled={busy} onClick={() => void perform(async () => {
                await call("unfollowGroupRole", { groupId: group.id, serviceEpoch: state.serviceEpoch });
                await loadGroups(true);
                setNotice("本群讲解已恢复使用本地当前角色。");
              })}>取消跟随</button>}
            </div>
            {rolePreview?.groupId === group.id && rolePreview.entry.info.revision === publicGroupRole.revision &&
              <div className="profile plugin-card">
                <strong>{rolePreview.entry.role.name} · {rolePreview.entry.role.version}</strong>
                <p className="role-description">{rolePreview.entry.role.persona}</p>
                {rolePreview.entry.role.personality && <details><summary>人格与讲解规则</summary>
                  <ul>{describePersonality(rolePreview.entry.role.personality, "reference").map(line => <li key={line}>{line}</li>)}</ul>
                </details>}
                <div className="tools">
                  <button className="primary" disabled={busy} onClick={() => void perform(async () => {
                    await call("followGroupRole", { groupId: group.id, revision: rolePreview.entry.info.revision, serviceEpoch: state.serviceEpoch });
                    await loadGroups(true);
                    setRolePreview(null);
                    setNotice("已应用到该群的摘要和画像讲解。");
                  })}>{group.followedRole ? "更新跟随版本" : "跟随该群角色"}</button>
                  <button disabled={busy} onClick={() => void perform(async () => {
                    await call<Role>("installGroupRole", { groupId: group.id, revision: rolePreview.entry.info.revision, serviceEpoch: state.serviceEpoch });
                    await refresh();
                    setNotice("角色已安装到本机，可在本地角色列表切换使用。");
                  })}>安装桌宠副本</button>
                </div>
              </div>}
          </>}
          {connected && group && !group.publishedRole && groups.some(item => item.publishedRole) &&
            <p className="meta">此群没有发布角色。</p>}
        </section>
        </>}
        {pluginCategory === "IM 渠道" && <section className="card plugin-card">
          <h3>{channelPlugin?.name ?? (connected ? "QQ 渠道" : "服务端渠道")}</h3>
          <p className="meta">{channelPlugin ? (channelPlugin.configured ? channelStatuses[channelPlugin.status] : "等待服务端连接配置")
            : gatewayStatus === "online" ? "在线" : connected ? "网关未在线" : "未连接服务"}</p>
          {!!channelPlugin?.capabilities.length && <p>{channelPlugin.capabilities.map(item => channelCapabilities[item]).join(" · ")}</p>}
          <div className="tools"><button onClick={() => setView("设置")}>设置服务连接</button>
            <button disabled={!state.serviceAddress || busy} onClick={() => void loadGroups()}>刷新状态</button></div>
        </section>}
      </>}
      {view === "设置" && <>
        <header><h2>设置</h2></header>
        <section className="card">
          <h3>Pi 工作区</h3>
          <p className="meta">选择工作目录，在原生 Pi 窗口使用文件工具、终端、会话、扩展和 MCP。</p>
          <button disabled={busy} onClick={() => void perform(async () => {
            if (await invoke<boolean>("open_pi_workspace")) setNotice("已打开 Pi 工作区。");
          })}>选择文件夹并打开</button>
        </section>
        <section className="card">
          <h3>个人模型与 API Key</h3>
          <p className="meta">用于个人聊天和桌宠讲解摘要、画像。</p>
          <div className="tools">
            {state.models.map(item => <button key={item.id} disabled={busy} onClick={() => { setEditing(item); setKey(""); }}>{item.name}</button>)}
            <button disabled={busy} onClick={() => { setEditing(emptyModel()); setKey(""); }}>新建</button>
            <button disabled={busy} onClick={() => {
              setEditing({ ...emptyModel(), name: "Packy DeepSeek", model: "deepseek-v4-flash",
                baseUrl: "https://cf.api.fan/v1", billing: "packy" });
              setKey("");
            }}>Packy DeepSeek 预设</button>
          </div>
          <form className="form-grid" onSubmit={e => { e.preventDefault(); void perform(async () => {
            await call("saveModel", editing, key.trim() || undefined);
            await refresh(); setModelId(editing.id); setKey(""); setModelSaveRevision(value => value + 1); setNotice("模型已保存。");
          }); }}>
            <label>显示名称<input required value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></label>
            <label>模型 ID<input required value={editing.model} onChange={e => setEditing({ ...editing, model: e.target.value })} /></label>
            <label>Base URL<input required value={editing.baseUrl} onChange={e => setEditing({ ...editing, baseUrl: e.target.value })} /></label>
            <label>API Key<input type="password" autoComplete="off" value={key} placeholder={editing.hasKey ? "留空保留已保存的 Key" : "填写你的模型 API Key"} onChange={e => setKey(e.target.value)} /></label>
            <label>估算币种<select value={editing.currency} onChange={e => setEditing({ ...editing, currency: e.target.value })}>
              <option value="CNY">人民币 CNY</option><option value="USD">美元 USD</option>
            </select></label>
            <label>每百万输入 Token 单价<input type="number" min="0" step="any" placeholder="留空为未知" value={editing.inputPrice ?? ""}
              onChange={e => setEditing({ ...editing, inputPrice: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : null })} /></label>
            <label>每百万输出 Token 单价<input type="number" min="0" step="any" placeholder="留空为未知" value={editing.outputPrice ?? ""}
              onChange={e => setEditing({ ...editing, outputPrice: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : null })} /></label>
            <label>对话输入预算<input type="number" min="4096" max="12000" step="1" placeholder="默认 12000 Token"
              value={editing.contextBudget ?? ""} onChange={e => setEditing({ ...editing, contextBudget:
                Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : undefined })} /></label>
            <label>余额接口<select value={editing.billing} onChange={e => setEditing({ ...editing, billing: e.target.value as ModelProfile["billing"] })}>
              <option value="none">不查询</option><option value="deepseek">DeepSeek 账户余额</option><option value="openrouter">OpenRouter Key 额度</option>
              <option value="packy">Packy API Key 额度</option>
            </select></label>
            <div className="tools"><button className="primary" disabled={busy}>保存模型</button>
              <button type="button" title="测试已保存的配置，测试请求计入本机用量"
                disabled={busy || !state.models.some(item => item.id === editing.id)}
                onClick={() => void perform(async () => {
                  try {
                    const result = await call<{ hasText: boolean; durationMs: number }>("testModel", { modelId: editing.id });
                    setNotice(result.hasText ? `已保存的模型配置可用，耗时 ${result.durationMs} 毫秒。` : "接口已响应，但未返回可见文本。");
                  } finally { await refreshModelUsage().catch(() => {}); }
                })}>测试连接</button></div>
          </form>
          {savedEditing && (editingBilling ? <p className="meta">保存地址、余额接口和 API Key 后，可查询当前额度。</p> :
            <ModelBalance key={savedEditing.id + ":" + modelSaveRevision} modelId={savedEditing.id} disabled={busy} />)}
          {savedEditing && <label className="model-backup">个人聊天备用模型
            <select value={savedEditing.backupModelId ?? ""} disabled={busy} onChange={event => {
              const backupModelId = event.target.value || null;
              void perform(async () => {
                await call("saveModelBackup", { modelId: savedEditing.id, backupModelId });
                await refresh();
                setNotice(backupModelId ? "个人聊天备用模型已保存。" : "个人聊天备用模型已关闭。");
              });
            }}>
              <option value="">不启用备用模型</option>
              {state.models.filter(item => item.id !== savedEditing.id).map(item => <option key={item.id} value={item.id} disabled={!item.hasKey}>
                {item.name}{item.hasKey ? "" : "（未配置 Key）"}</option>)}
            </select>
            <small className="meta">主模型临时故障时，备用档案会接收本轮个人聊天上下文。</small>
          </label>}
          {savedEditing && <ModelBudgetEditor model={savedEditing} busy={busy} save={limits => void perform(async () => {
            await call("saveModelBudget", { modelId: savedEditing.id, currency: savedEditing.budget.currency, ...limits });
            await refreshModelUsage();
            setNotice("本机模型预算已保存。");
          })} />}
          {!!state.pendingModelKeyRemovals && <p role="status">Windows 凭据库有 {state.pendingModelKeyRemovals} 条旧 Key 待清理。应用会在读取设置时重试。</p>}
          {savedEditing && <div className="tools">
            {savedEditing.hasKey && <button type="button" disabled={busy || chatBusy} onClick={() => retireModel(savedEditing, false)}>清除本机 API Key</button>}
            <button type="button" disabled={busy || chatBusy} onClick={() => retireModel(savedEditing, true)}>移除模型档案</button>
          </div>}
        </section>
        <ServiceConnections profiles={state.serviceProfiles} activeId={state.activeServiceProfile} epoch={state.serviceEpoch}
          busy={busy} change={changeService} />
        {reminders && <section className="card"><h3>桌宠摘要提醒</h3>
          <p className="meta">勿扰时段和全屏延后同时适用于本地提醒。各类提醒可分别暂停。</p>
          <SummaryReminderForm key={JSON.stringify(reminders.policy)} policy={reminders.policy} busy={busy}
            onSave={policy => void perform(async () => {
              await updateReminders("saveSummaryReminderPolicy", policy);
              setNotice("桌宠提醒设置已保存。");
            })} />
        </section>}
        <DesktopInteractionReview key={roleId} roleId={roleId} model={model} completedTurn={completedTurn}
          openMemory={openMemoryReview} afterGeneration={afterInteractionReview} />
        <section className="card"><h3>{role?.name ?? "当前角色"}的个人记忆</h3>
          <p className="meta">最近保存的最多八条会用于个人聊天，并随请求发给所选模型。群摘要讲解独立运行。</p>
          {memories.map(item => <div className="profile" key={item.id}>
            <p>{item.text}</p>
            <div className="tools">
              <button disabled={busy} onClick={() => { setMemoryId(item.id); setMemoryDraft(item.text); }}>编辑</button>
              <button disabled={busy} onClick={() => {
                if (!window.confirm("删除这条个人记忆？")) return;
                void perform(async () => {
                  await call("deleteMemory", { roleId, id: item.id });
                  if (memoryId === item.id) { setMemoryId(null); setMemoryDraft(""); }
                  await refreshMemory();
                });
              }}>删除</button>
            </div>
          </div>)}
          <form onSubmit={e => {
            e.preventDefault();
            void perform(async () => {
              await call("saveMemory", { roleId, id: memoryId, text: memoryDraft });
              setMemoryId(null); setMemoryDraft(""); await refreshMemory();
            });
          }}>
            <textarea aria-label="个人记忆" placeholder="例如：我习惯晚上十点后安静一点。" maxLength={400}
              value={memoryDraft} onChange={e => setMemoryDraft(e.target.value)} />
            <div className="tools"><button className="primary" disabled={busy || !memoryDraft.trim()}>
              {memoryId === null ? "添加记忆" : "保存修改"}
            </button>{memoryId !== null && <button type="button" onClick={() => {
              setMemoryId(null); setMemoryDraft("");
            }}>取消编辑</button>}</div>
          </form>
          <details className="memory-extraction" ref={memoryDetails}>
            <summary>从个人聊天提取记忆</summary>
            <p className="meta">{model?.hasKey
              ? `用「${model.name}」分析当前角色最近最多 16 条尚未处理的个人发言，计入本机模型预算。`
              : "先在聊天页选择已配置 API Key 的个人模型。"}候选与原话保存在本机，采纳后用于个人聊天。</p>
            <label className="inline"><input type="checkbox" checked={review?.autoAccept ?? false} disabled={busy || !review}
              onChange={event => {
                const enabled = event.target.checked;
                void perform(async () => {
                  const state = await call<DesktopMemoryReview>("setMemoryAutoAccept", { roleId, enabled });
                  setMemoryReview({ roleId, state });
                });
              }} />自动采纳直接说出的常见日常偏好</label>
            <div className="tools"><button type="button" disabled={busy || !model?.hasKey || !review?.ready}
              onClick={() => void perform(async () => {
                try {
                  const result = await call<{ accepted: number; proposed: number }>("extractMemory", { roleId, modelId });
                  const state = await call<DesktopMemoryReview>("memoryReview", { roleId });
                  setMemoryReview({ roleId, state });
                  await refreshMemory();
                  setNotice(result.accepted || result.proposed
                    ? `已新增 ${result.proposed} 条待审候选，自动采纳 ${result.accepted} 条。`
                    : "没有新的记忆候选。");
                } finally { await refreshModelUsage().catch(() => {}); }
              })}>提取记忆</button></div>
            {review && !review.ready && <p className="meta">暂无未处理的个人发言。</p>}
            {review?.candidates.map(candidate => <MemoryCandidateEditor key={candidate.id} candidate={candidate} busy={busy}
              decide={(accept, text) => void perform(async () => {
                const state = await call<DesktopMemoryReview>("decideMemoryCandidate", { roleId, id: candidate.id, accept, text });
                setMemoryReview({ roleId, state });
                if (accept) await refreshMemory();
                setNotice(accept ? "记忆已保存到本机。" : "已忽略这条候选。");
              })} />)}
          </details>
        </section>
        <section className="card"><h3>私有记忆同步</h3>
          <p className="meta">目标：{state.serviceAddress || "请先配置服务连接"}。按当前角色手动操作。</p>
          {identity ? <p>已核对 QQ 身份 {identity.qqId}。读取{identity.memoryRead ? "已授权" : "未授权"}，写入{identity.memoryWrite ? "已授权" : "未授权"}。</p>
            : <p className="meta">请核对服务器返回的账号和记忆权限。</p>}
          <button type="button" disabled={busy || !state.serviceAddress} onClick={() => void perform(async () => {
            setIdentity(undefined);
            setMemoryPreview(null);
            const result = await call<ServiceIdentity>("self", { serviceEpoch: state.serviceEpoch });
            setIdentity(result.account);
            if (!result.account) setNotice("此服务未提供可核对的同步账号。");
          })}>核对同步账号</button>
          {(["push", "pull"] as const).map(direction => <label key={direction} className="inline">
            <input type="checkbox" checked={state.memorySync[direction]} disabled={busy || (!state.memorySync[direction] &&
                !(direction === "push" ? identity?.memoryWrite : identity?.memoryRead))}
              onChange={e => {
                const preferences = { ...state.memorySync, [direction]: e.target.checked };
                void perform(async () => {
                  const memorySync = await call<MemorySync>("syncPreferences", { ...preferences, serviceEpoch: state.serviceEpoch });
                  setMemoryPreview(null);
                  setState(current => ({ ...current, memorySync }));
                });
              }} />
            {direction === "push" ? "允许手动上传我的记忆" : "允许拉取我的记忆"}
          </label>)}
          <div className="tools">
            <button disabled={busy || !state.memorySync.push || !identity?.memoryWrite} onClick={() => {
              if (!identity?.memoryWrite ||
                  !window.confirm(`将「${role?.name ?? roleId}」的本地个人记忆上传到 ${state.serviceAddress} 上 QQ ${identity.qqId} 的私有空间？`)) return;
              void perform(async () => {
                const { uploaded } = await call<{ uploaded: number }>("pushMemory", memoryTarget);
                setNotice(`完成同步，上传 ${uploaded} 条新增或修改的记忆。`);
              });
            }}>上传当前角色记忆</button>
            <button disabled={busy || !state.memorySync.pull || !identity?.memoryRead} onClick={() => void perform(async () => {
              setMemoryPreview(null);
              setMemoryPreview(await call<MemoryPreview>("previewMemory", memoryTarget));
            })}>拉取预览</button>
          </div>
          {memoryPreview && <div className="profile">
            <p>{memoryPreview.items.length ? "服务端个人记忆预览" : "服务端没有可用记忆"}</p>
            {memoryPreview.items.map(item => <div className="profile" key={item.id}>
              <p>{item.localText ? "服务端版本：" : ""}{item.text}</p>
              {item.localText && <>
                <p>本地版本：{item.localText}</p>
                <button disabled={busy || !state.memorySync.push} onClick={() => void perform(async () => {
                  await call("forkMemoryConflict", { ...memoryTarget, id: item.id, version: item.version, localText: item.localText });
                  setMemoryPreview(null);
                  setNotice("本地版本已另存为待上传记录，服务端原记录保留。");
                })}>本地版本另作一条</button>
              </>}
              {state.memorySync.push && identity?.memoryWrite && (!item.linked || item.localText) && <button disabled={busy} onClick={() => {
                if (item.localText && !window.confirm("用服务端版本替换这条本地记忆？")) return;
                void perform(async () => {
                  await call("downloadMemory", { ...memoryTarget, id: item.id, version: item.version, text: item.text,
                    expectedLocalText: item.localText ?? null });
                  await refreshMemory();
                  setMemoryPreview(await call<MemoryPreview>("previewMemory", memoryTarget));
                  setNotice("已保存为可编辑的本地记忆。");
                });
              }}>{item.localText ? "采用服务端版本" : "下载为可编辑记忆"}</button>}
              {state.memorySync.push && <button disabled={busy} onClick={() => {
                if (!window.confirm("删除这条服务端记忆？本地手工保存的记忆会保留。")) return;
                void perform(async () => {
                  await call("deleteRemoteMemory", { ...memoryTarget, id: item.id, version: item.version });
                  setMemoryPreview(null);
                  setMemoryPreview(await call<MemoryPreview>("previewMemory", memoryTarget));
                });
              }}>删除服务端副本</button>}
            </div>)}
            <button disabled={busy} onClick={() => void perform(async () => {
              await call("applyMemory", { ...memoryTarget, revision: memoryPreview.revision });
              setMemoryPreview(null); setNotice("已更新此角色在本机可用的服务端记忆。");
            })}>确认用于个人对话</button>
          </div>}
        </section>
        <section className="card"><h3>隐私</h3>
          <label className="inline"><input type="checkbox" checked={includeSelf} onChange={e => {
            setIncludeSelf(e.target.checked);
            localStorage.setItem("includeSelf", String(e.target.checked));
          }} />群摘要讲解可使用本人画像</label>
        </section>
        <details className="card"><summary>本机模型用量</summary>
          <p className="meta">费用按请求发生时的自填单价估算。</p>
          {state.usage.length === 0 ? <p className="empty">暂无模型请求。</p> : <div className="usage-scroll">
            <table className="usage-table">
              <thead><tr>{["模型", "请求", "停止或中断", "输入 Token", "输出 Token", "估算费用"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
              <tbody>{state.usage.map(row => <tr key={JSON.stringify([row.model_id, row.model_name, row.currency])}>
                <td>{row.model_name}</td><td>{row.requests.toLocaleString()}</td>
                <td>{(row.cancelled + row.interrupted).toLocaleString()}</td>
                <td>{row.input_tokens?.toLocaleString() ?? "未知"}</td><td>{row.output_tokens?.toLocaleString() ?? "未知"}</td>
                <td>{row.estimated_cost === null ? "未知" :
                  row.estimated_cost.toLocaleString(undefined, { style: "currency", currency: row.currency, maximumFractionDigits: 8 }) +
                  (row.priced_requests < row.requests ? `（覆盖 ${row.priced_requests}/${row.requests} 次）` : "")}</td>
              </tr>)}</tbody>
            </table>
          </div>}
          <button disabled={busy} onClick={() => void perform(refresh)}>刷新</button>
        </details>
      </>}
    </section>
  </main>;
}
function FloatingPet() {
  const [activeRole, setActiveRole] = useState<Role>();
  const name = activeRole?.name ?? "大肥鱼";
  const [activity, setActivity] = useState<{ label: string; groupId: string; tokens: string[]; reaction: SummaryReaction } | null>(null);
  const [watchedWorkspaces, setWatchedWorkspaces] = useState<NonNullable<DesktopWorkspace["watched"]>>([]);
  const [workspaceActivity, setWorkspaceActivity] = useState<WorkspaceNotice[]>([]);
  const [activeService, setActiveService] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"chat" | "summaries" | "reminders" | "workspace-reminders">("chat");
  const [serviceAddress, setServiceAddress] = useState("");
  const [serviceEpoch, setServiceEpoch] = useState("");
  const [subscriptionRevision, setSubscriptionRevision] = useState(0);
  const feedPermissionRevision = useRef(0);
  const { reminders } = useSummaryReminders();
  const localReminders = useLocalReminders();
  const [feed, setFeed] = useState<Group[]>([]);
  const [feedGroupId, setFeedGroupId] = useState("");
  const [feedError, setFeedError] = useState("");
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedRefresh, setFeedRefresh] = useState(0);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [selecting, setSelecting] = useState(false);
  const selectingModel = useRef(false);
  const chatDraft = useRef<{ id: string; text: string } | undefined>(undefined);
  const [caring, setCaring] = useState(false);
  const [care, setCare] = useState<CareAction>();
  const [careMessage, setCareMessage] = useState("");
  const careTimer = useRef(0);
  const activityTimer = useRef(0);
  const workspaceActivityTimer = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const chat = useDesktopChat(next => {
    setAnswer("");
    if (next.status === "running" || chatDraft.current?.id !== next.id) return;
    const sent = chatDraft.current.text;
    chatDraft.current = undefined;
    if (next.status === "completed") setQuestion(current => current === sent ? "" : current);
    input.current?.focus();
  });
  const sending = selecting || chat.starting || chat.running;
  const companion = useCompanion(activeRole?.id, chat.turn?.status === "completed" ? chat.turn.id : undefined);
  const ownTurn = chat.turn?.roleId === activeRole?.id ? chat.turn : null;
  const lastAnswer = ownTurn?.status === "completed" ? ownTurn.answer : ownTurn?.status === "failed" ? ownTurn.error :
    ownTurn?.status === "cancelled" ? "已停止生成。" : "";
  const showSummaries = open && panel === "summaries";
  const showLocalReminders = open && panel === "reminders";
  const showWorkspaceReminders = open && panel === "workspace-reminders";
  const watchingSummaries = !!reminders?.watched.length;
  const pollFeed = showSummaries || watchingSummaries;
  const notificationPolicy = reminders?.policy;
  const sharedPolicy = useMemo(() => notificationPolicy && { ...notificationPolicy, paused: false }, [notificationPolicy]);
  const watchedSources = [...new Set(watchedWorkspaces.map(item => item.sourceId))].join(",");
  const availability = useSummaryReminderAvailability(sharedPolicy, watchingSummaries || !!watchedSources || localReminders.due.length > 0);
  const canNotify = availability?.allowed && !availability.quiet;
  const visibleLocalReminder = canNotify && !open && !sending && !localReminders.snapshot?.paused ? localReminders.due[0] : undefined;
  const clearForReminders = !open && !sending && !care && !notificationPolicy?.paused && !visibleLocalReminder;
  const allowNotices = !!canNotify && clearForReminders;
  const allowWorkspaceNotices = !!availability?.allowed && clearForReminders;
  const visibleWorkspace = allowWorkspaceNotices ? workspaceActivity[0] : undefined;
  const workspaceReaction = visibleWorkspace ? workspaceActivity.length > 1 ? "summary" : visibleWorkspace.reaction ?? "summary" : undefined;
  const visibleActivity = allowNotices && !visibleWorkspace && activity && reminders?.watched.includes(activity.groupId) &&
    feed.some(group => group.id === activity.groupId) ? activity : null;
  const feedGroup = feed.find(item => item.id === feedGroupId) ?? feed[0];
  useEffect(() => {
    return () => {
      window.clearTimeout(careTimer.current);
      window.clearTimeout(activityTimer.current);
      window.clearTimeout(workspaceActivityTimer.current);
    };
  }, []);
  useEffect(() => {
    document.documentElement.classList.add("floating");
    async function refreshState() {
      const state = await call<State>("state");
      setActiveRole(state.roles.find(role => role.id === localStorage.getItem("roleId")) ?? state.roles[0]);
      setServiceAddress(state.serviceAddress);
      setServiceEpoch(state.serviceEpoch);
      setActiveService(state.activeServiceProfile);
    }
    const refresh = () => void refreshState().catch(() => {});
    const onStorage = ({ key }: StorageEvent) => {
      if (key === "roleId") refresh();
    };
    refresh();
    window.addEventListener("storage", onStorage);
    const roleChanged = listen("desktop-role-updated", refresh);
    const serviceChanged = listen("desktop-service-updated", () => {
      feedPermissionRevision.current++;
      setServiceAddress("");
      setServiceEpoch("");
      setFeed([]);
      setFeedGroupId("");
      setFeedError("");
      setActivity(null);
      setWorkspaceActivity([]);
      setSubscriptionRevision(value => value + 1);
      refresh();
    });
    const serviceRestricted = listen<ServicePermissionChange>("desktop-service-permissions", ({ payload }) => {
      if (payload.subscription !== false) return;
      feedPermissionRevision.current++;
      setFeed([]);
      setFeedGroupId("");
      setActivity(null);
      setWorkspaceActivity(current => current.filter(item => item.sourceId !== payload.sourceId));
      setFeedError("群动态订阅已失效，请核对令牌。");
    });
    return () => {
      window.removeEventListener("storage", onStorage);
      void roleChanged.then(off => off()).catch(() => {});
      void serviceChanged.then(off => off()).catch(() => {});
      void serviceRestricted.then(off => off()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    let current = true;
    const refresh = () => void call<{ items: DesktopWorkspace[] }>("workspaceSettings").then(value => {
      if (!current) return;
      const watches = value.items.flatMap(item => item.watched ?? []);
      setWatchedWorkspaces(watches);
      setWorkspaceActivity(previous => previous.filter(notice => watches.some(watch => watch.sourceId === notice.sourceId &&
        watch.conversationId === notice.conversationId)));
    }).catch(() => {});
    refresh();
    const workspaceChanged = listen("desktop-workspace-watches-changed", () => { setWorkspaceActivity([]); refresh(); });
    const serviceChanged = listen("desktop-service-updated", refresh);
    return () => {
      current = false;
      void workspaceChanged.then(off => off()).catch(() => {});
      void serviceChanged.then(off => off()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!watchedSources) return;
    let active = true;
    let updating = false;
    async function refresh() {
      if (updating) return;
      updating = true;
      try {
        const sources = await Promise.allSettled(watchedSources.split(",").map(id => call<WorkspaceSource>("syncWorkspaceSource", { id })));
        if (!active) return;
        const checked = new Map(sources.flatMap(source => source.status === "fulfilled" ? [[source.value.id, source.value]] as const : []));
        setWorkspaceActivity(previous => {
          const visible = previous.filter(notice => {
            const source = checked.get(notice.sourceId);
            return !source || source.conversations.some(item => item.id === notice.conversationId);
          });
          return visible.length === previous.length ? previous : visible;
        });
        if (!active || !allowWorkspaceNotices || !notificationPolicy ||
            !(await canShowSummaryReminder({ ...notificationPolicy, quietHours: false }))) return;
        const notices = await call<WorkspaceNotice[]>("workspaceNotices");
        if (!active || !notices.length) return;
        setWorkspaceActivity(notices);
        window.clearTimeout(workspaceActivityTimer.current);
        workspaceActivityTimer.current = window.setTimeout(() => setWorkspaceActivity([]), 6500);
      } finally { updating = false; }
    }
    void refresh().catch(() => {});
    const timer = window.setInterval(() => void refresh().catch(() => {}), 20_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [watchedSources, watchedWorkspaces, allowWorkspaceNotices, notificationPolicy, serviceEpoch]);
  useEffect(() => {
    if (visibleWorkspace) void call("acknowledgeWorkspaceNotices", { tokens: workspaceActivity.map(item => item.token) }).catch(() => {});
  }, [visibleWorkspace, workspaceActivity]);
  useEffect(() => {
    const size = open ? new LogicalSize(340, 405) : new LogicalSize(190, 150);
    void getCurrentWindow().setSize(size).then(() => { if (open && panel === "chat") input.current?.focus(); })
      .catch(() => {});
  }, [open, panel]);
  useEffect(() => {
    if (!serviceAddress || !pollFeed) return;
    let current = true;
    let loading = false;
    async function update() {
      if (loading) return;
      loading = true;
      const permission = feedPermissionRevision.current;
      setFeedLoading(true);
      try {
        const result = await call<GroupFeed>("groups", { serviceEpoch });
        if (!current || permission !== feedPermissionRevision.current) return;
        setFeed(result.groups.map(group => ({ ...group, channelCoverage: result.channelCoverage })));
        setFeedError("");
        if (!allowNotices || !reminders || !result.summaryNotices?.length) return;
        if (!await canShowSummaryReminder(reminders.policy) || !current || permission !== feedPermissionRevision.current) return;
        const notices = new Map(result.summaryNotices.map(notice => [notice.groupId, notice.token]));
        const changed = result.groups.filter(group => notices.has(group.id) && reminders.watched.includes(group.id) &&
          !watchedWorkspaces.some(item => item.sourceId === activeService && item.conversationId === group.id))
          .sort((first, second) => Date.parse(second.summary?.created_at ?? "") - Date.parse(first.summary?.created_at ?? ""));
        const first = changed[0];
        if (first) {
          const reaction = changed.length === 1 ? groupSummaryHighlight(first.summary?.topics)?.reaction ?? "summary" : "summary";
          const label = changed.length > 1 ? `${changed.length} 个关注群有新摘要` :
            `${summaryReactionLabels[reaction]} · ${first.profile?.displayName ?? "关注的群"}`;
          setActivity({ label, groupId: first.id, tokens: changed.map(group => notices.get(group.id)!), reaction });
          window.clearTimeout(activityTimer.current);
          activityTimer.current = window.setTimeout(() => setActivity(null), 6500);
        }
      } catch (error) {
        if (!current || permission !== feedPermissionRevision.current) return;
        setFeed([]);
        setActivity(null);
        setFeedError(String(error));
      } finally {
        loading = false;
        if (current) setFeedLoading(false);
      }
    }
    void update();
    const interval = window.setInterval(() => void update(), 30_000);
    return () => { current = false; window.clearInterval(interval); };
  }, [serviceAddress, serviceEpoch, subscriptionRevision, reminders, pollFeed, allowNotices, feedRefresh, watchedWorkspaces, activeService]);
  useEffect(() => {
    if (!visibleActivity) {
      window.clearTimeout(activityTimer.current);
      setActivity(null);
      return;
    }
    void call("acknowledgeSummaryNotices", { tokens: visibleActivity.tokens }).catch(() => {});
  }, [visibleActivity]);

  async function interact(kind: CareAction) {
    if (!activeRole || caring || care) return;
    setCaring(true);
    setCareMessage("");
    try {
      const result = await call<CompanionSnapshot & { changed: boolean }>("petCare", {
        roleId: activeRole.id, kind, eventId: crypto.randomUUID(),
      });
      if (!result.changed) {
        setCareMessage("等一小会儿再试吧。");
        return;
      }
      announceCompanionUpdate();
      setCare(kind);
      setCareMessage({ feed: "吃到啦，精力恢复了一些。", pet: "摸摸之后放松了下来。", rest: "把动作放慢，歇一会儿。" }[kind]);
      careTimer.current = window.setTimeout(() => setCare(undefined), kind === "rest" ? 2400 : 1600);
    } catch (error) {
      setCareMessage(String(error));
    } finally {
      setCaring(false);
    }
  }

  async function send() {
    const text = question.trim();
    if (!text || sending || selectingModel.current) return;
    selectingModel.current = true;
    setSelecting(true);
    setAnswer("");
    const id = crypto.randomUUID();
    try {
      const state = await call<State>("state");
      const selected = localStorage.getItem("modelId");
      const model = state.models.find(item => item.id === selected) ?? state.models[0];
      if (!model?.hasKey) {
        setAnswer("先在主窗口的设置中配置自己的模型和 API Key。");
        return;
      }
      const selectedRole = localStorage.getItem("roleId");
      const role = state.roles.find(item => item.id === selectedRole) ?? state.roles[0];
      chatDraft.current = { id, text: question };
      if (await chat.start({ id, roleId: role.id, modelId: model.id, text })) return;
    } catch (error) {
      setAnswer(String(error));
    } finally {
      selectingModel.current = false;
      setSelecting(false);
      input.current?.focus();
    }
    if (chatDraft.current?.id === id) chatDraft.current = undefined;
  }

  function openNotice(notice: WorkspaceNotice) {
    openWorkspaceFromPet(notice);
    setWorkspaceActivity(current => current.filter(item => item.token !== notice.token));
    if (workspaceActivity.length <= 1) setOpen(false);
  }

  return <div className={`floating-pet ${open ? "expanded" : ""}`}>
    <div data-tauri-drag-region className="drag" aria-label="拖动桌宠" />
    {open && <section className="pet-chat" aria-label={showWorkspaceReminders ? "工作区摘要提醒" : showLocalReminders ? "桌宠本地提醒" :
      showSummaries ? "桌宠群摘要" : `和${name}聊天`}>
      <div className="pet-chat-header"><strong>{name}</strong>
        <button type="button" onClick={() => {
          if (!showSummaries && !watchingSummaries) {
            setFeed([]);
            setFeedError("");
            setFeedLoading(!!serviceAddress);
          }
          setPanel(showSummaries ? "chat" : "summaries");
        }}>{showSummaries ? "返回聊天" : "群摘要"}</button>
        <button type="button" onClick={() => setPanel(showLocalReminders ? "chat" : "reminders")}>{showLocalReminders ? "返回聊天" : "待办"}</button>
        <button type="button" onClick={() => void invoke("show_main")}>主窗口</button>
        <button type="button" onClick={() => setOpen(false)} aria-label="收起面板">−</button>
      </div>
      {showWorkspaceReminders ? <div className="pet-group-feed pet-local-reminders">
        {workspaceActivity.length ? workspaceActivity.map(item => <div className="pet-local-reminder-row" key={item.token}>
          <button type="button" onClick={() => openNotice(item)}>{item.label}</button>
          <small className="meta">{new Date(item.at).toLocaleTimeString()}</small>
        </div>) : <p>这些摘要提醒已处理。</p>}
      </div> : showLocalReminders ? <div className="pet-group-feed pet-local-reminders">
        {localReminders.error && <p role="alert">{localReminders.error}</p>}
        {localReminders.due.length ? localReminders.due.map(item => <div className="pet-local-reminder-row" key={item.id}>
          <p>{item.text}</p>
          <div className="tools"><LocalReminderActions item={item} reminders={localReminders} due openReview={openWorkspaceFromPet} /></div>
        </div>) : <p>暂无到期提醒。</p>}
      </div> : showSummaries ? <div className="pet-group-feed">
        {!serviceAddress ? <p>在主窗口的设置中配置群动态订阅。</p> : <>
          <div className="pet-group-tools">
            {!!feed.length && <select aria-label="摘要群聊" value={feedGroup?.id ?? ""} onChange={event => setFeedGroupId(event.target.value)}>
              {feed.map(group => <option key={group.id} value={group.id}>{group.profile?.displayName || `QQ群 ${group.id.split(":").at(-1)}`}</option>)}
            </select>}
            <button type="button" disabled={feedLoading} onClick={() => setFeedRefresh(value => value + 1)}>刷新摘要</button>
          </div>
          {feedError ? <p role="status">{feedError}</p>
            : feedLoading && !feed.length ? <p role="status">正在读取群摘要…</p>
            : !feedGroup?.summary ? <p>暂无可看的群摘要。</p>
            : <>
              <ChannelCoverageHint report={feedGroup.channelCoverage} />
              <SummaryHighlight summary={feedGroup.summary} />
              <p className="pet-summary-body">{feedGroup.summary.content}</p>
              <small><SummaryTime summary={feedGroup.summary} /></small>
              {feedGroup.summaryRevision && activeRole && <GroupSummaryExplanation
                key={JSON.stringify([serviceEpoch, feedGroup.id, feedGroup.summaryRevision, activeRole.id, feedGroup.followedRole?.revision])}
                groupId={feedGroup.id} revision={feedGroup.summaryRevision} roleId={activeRole.id} serviceEpoch={serviceEpoch}
                groupRoleRevision={feedGroup.followedRole?.revision} />}
              <SummaryTopics summary={feedGroup.summary} />
              {feedGroup.summaries.slice(1, 4).map((summary, index) => <details key={summary.id ?? `${summary.created_at}:${index}`}>
                <summary>{new Date(summary.created_at).toLocaleString()}</summary>
                <p className="pet-summary-body">{summary.content}</p>
              </details>)}
            </>}
        </>}
      </div> : <>
      <p className="pet-answer" aria-live="polite">{sending ? (chat.cancelling ? "正在停止…" :
        ownTurn?.backup ? `正在使用备用模型「${ownTurn.backup.name}」…` : "正在想怎么回你…") :
        answer || lastAnswer || "我在，今天想聊什么？"}</p>
      {ownTurn?.status === "completed" && ownTurn.backup && <small className="meta">备用模型「{ownTurn.backup.name}」已回复</small>}
      <form onSubmit={event => { event.preventDefault(); void send(); }}>
        <input ref={input} value={question} maxLength={4000} placeholder={`给${name}发消息`}
          aria-label={`给${name}发消息`} onChange={event => setQuestion(event.target.value)} />
        {chat.running ? <button type="button" disabled={chat.cancelling} onClick={() =>
          void chat.cancel().catch(error => setAnswer(String(error)))}>停止生成</button> :
          <button className="primary" disabled={sending || !question.trim()}>发送</button>}
      </form>
      <div className="pet-care" aria-label="陪伴互动">{careActions.map(kind =>
        <button type="button" key={kind} disabled={caring || !!care || sending || !activeRole}
          onClick={() => void interact(kind)}>{careLabels[kind]}</button>)}</div>
      <p className="pet-care-status" role="status">{careMessage}</p>
      </>}
    </section>}
    <button className="pet-button" aria-label={`和${name}聊天`} aria-expanded={open} onClick={() => { if (!open) setPanel("chat"); setOpen(!open); }}>
      <Pet busy={!!visibleLocalReminder || sending} role={activeRole} mood={companion?.mood} care={care}
        summaryReaction={workspaceReaction ?? visibleActivity?.reaction} />
    </button>
    {visibleActivity && <button type="button" className="pet-activity" data-summary-reaction={visibleActivity.reaction} title={visibleActivity.label} onClick={() => {
      setFeedGroupId(visibleActivity.groupId);
      setPanel("summaries");
      setOpen(true);
      setActivity(null);
    }}>{visibleActivity.label}</button>}
    {visibleWorkspace && <button type="button" className="pet-activity" data-summary-reaction={workspaceReaction}
      title={workspaceActivity.length === 1 ? visibleWorkspace.label : undefined} onClick={() => {
      if (workspaceActivity.length === 1) { openNotice(visibleWorkspace); return; }
      window.clearTimeout(workspaceActivityTimer.current);
      setPanel("workspace-reminders");
      setOpen(true);
    }}>{workspaceActivity.length > 1 ? `${workspaceActivity.length} 个会话有新摘要` :
      `${summaryReactionLabels[workspaceReaction ?? "summary"]} · ${visibleWorkspace.label}`}</button>}
    {visibleLocalReminder && <button type="button" className="pet-activity pet-local-activity" onClick={() => {
      setPanel("reminders");
      setOpen(true);
    }}>{localReminders.due.length > 1 ? `${localReminders.due.length} 条待办到期` : `待办 · ${visibleLocalReminder.text}`}</button>}
    <button className="pet-close" aria-label="关闭桌宠" onClick={() => void getCurrentWindow().close()}>×</button>
  </div>;
}
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).has("pet") ? <FloatingPet /> : <App />,
);

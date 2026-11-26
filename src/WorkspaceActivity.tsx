import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { emit, listen } from "@tauri-apps/api/event";
import type { DesktopServiceProfile } from "../runtime/desktop-credentials";
import type { ModelProfile } from "../runtime/models";
import type { DesktopWorkspace, WorkspaceConversationProfiles, WorkspaceFeatureItem, WorkspaceSource } from "../runtime/desktop-workspaces";
import { defaultWorkspaceReminderPolicy, workspaceReminderIntervals, type WorkspaceReminderPolicy } from "../runtime/summary-reminder-policy";
import type { ServicePermissionChange } from "../runtime/main";
import { call } from "./desktop-ipc";
import { MemberCard } from "./GroupMemberDirectory";
import { WorkspaceDevelopment } from "./WorkspaceDevelopment";
import { ReviewReminderForm } from "./LocalReminders";
import { DesktopInteractionReview } from "./DesktopInteractionReview";

type Settings = { activeId: string; items: DesktopWorkspace[] };
export type WorkspaceConversationTarget = { sourceId: string; conversationId: string };
type FeatureResult = { sourceId: string; conversationId: string; featureId: string; revision?: string; title: string; items: WorkspaceFeatureItem[] };
const stateLabels = { ready: "在线", "summary-only": "在线 · 可读群摘要", stale: "待同步或连接中断",
  unsupported: "服务需要更新", unauthorized: "订阅权限失效" };

function supportsVersion(version: string, minimum: string) {
  const current = version.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (current[index] !== required[index]) return current[index] > required[index];
  }
  return true;
}

function ConversationProfiles({ sourceId, conversationId, label }: WorkspaceConversationTarget & { label: string }) {
  const [expanded, setExpanded] = useState(false);
  const [profiles, setProfiles] = useState<WorkspaceConversationProfiles | null>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const result = await call<WorkspaceConversationProfiles | null>("workspaceConversationProfiles", { id: sourceId, conversationId });
        if (active) { setProfiles(result); setError(""); }
      } catch (failure) {
        if (active) { setProfiles(null); setError(String(failure)); }
      } finally { pending = false; }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [expanded, sourceId, conversationId]);
  return <section className="card" aria-label="会话画像">
    <h3>会话画像</h3>
    <p className="meta">{label}</p>
    <button type="button" aria-expanded={expanded} onClick={() => {
      setProfiles(undefined);
      setError("");
      setExpanded(!expanded);
    }}>{expanded ? "收起画像" : "查看已发布画像"}</button>
    {expanded && (error ? <p role="status">{error}</p> : profiles === null ? <p role="status">此会话的画像当前无法读取。</p> :
      profiles === undefined ? <p role="status">正在拉取画像…</p> : <>
        {profiles.group && <MemberCard profile={profiles.group} />}
        {profiles.members.map(item => <MemberCard key={item.id} profile={item} />)}
        {!profiles.group && !profiles.members.length && <p className="empty">此会话暂无已发布的画像。</p>}
      </>)}
  </section>;
}

export function WorkspaceActivity({ active, profiles, revision, model, roleId, completedTurn, navigation, openConversation, openSettings,
  openMemoryReview, afterInteractionReview }: {
  active: boolean;
  profiles: DesktopServiceProfile[];
  revision: string;
  model?: ModelProfile;
  roleId: string;
  completedTurn?: string;
  navigation?: WorkspaceConversationTarget;
  openConversation: (sourceId: string, conversationId: string) => void;
  openSettings: () => void;
  openMemoryReview: () => void;
  afterInteractionReview: () => void;
}) {
  const [settings, setSettings] = useState<Settings>();
  const lastNavigation = useRef<WorkspaceConversationTarget | undefined>(undefined);
  const [sources, setSources] = useState<Record<string, WorkspaceSource>>({});
  const permissionVersions = useRef(new Map<string, number>());
  const [reminderSource, setReminderSource] = useState<{ workspaceId: string; sourceId: string }>();
  const [savingFilter, setSavingFilter] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const [edit, setEdit] = useState<{ id?: string; name: string; sourceIds: string[]; reminders?: WorkspaceReminderPolicy | null } | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [developmentOpen, setDevelopmentOpen] = useState(false);
  const [reply, setReply] = useState<{ sourceId: string; conversationId: string; text: string; requestId: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [clientVersion, setClientVersion] = useState("");
  const [feature, setFeature] = useState<FeatureResult | null>(null);
  const [brief, setBrief] = useState<{ scope: string; answer: string; sources: { source: string; conversation: string; time: string }[] } | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  useEffect(() => { void getVersion().then(setClientVersion).catch(() => {}); }, []);
  const profileKey = profiles.map(profile => profile.id + "=" + profile.address).join("|");
  useEffect(() => {
    const subscription = listen<ServicePermissionChange>("desktop-service-permissions", ({ payload }) => {
      const id = payload.sourceId;
      if (payload.subscription !== false || !id) return;
      permissionVersions.current.set(id, (permissionVersions.current.get(id) ?? 0) + 1);
      setSources(current => ({ ...current, [id]: { id, state: "unauthorized", items: [], conversations: [] } }));
    });
    return () => { void subscription.then(off => off()).catch(() => {}); };
  }, []);
  useEffect(() => {
    let active = true;
    setSources({});
    setReply(null);
    setFeature(null);
    setBrief(null);
    void call<Settings>("workspaceSettings").then(value => { if (active) setSettings(value); })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [revision, profileKey]);
  useEffect(() => {
    if (!navigation || !settings || lastNavigation.current === navigation) return;
    lastNavigation.current = navigation;
    const candidates = settings.items.filter(item => item.sourceIds.includes(navigation.sourceId));
    const target = candidates.find(item => item.id === settings.activeId) ?? candidates.find(item =>
      item.watched?.some(watch => watch.sourceId === navigation.sourceId && watch.conversationId === navigation.conversationId)) ?? candidates[0];
    if (!target) { setError("该提醒的服务连接已不在工作区内。"); return; }
    function show(value: Settings) {
      if (lastNavigation.current !== navigation || !navigation) return;
      setSettings(value);
      setReminderSource({ workspaceId: value.activeId, sourceId: navigation.sourceId });
      setConversationId(`${navigation.sourceId}/${navigation.conversationId}`);
      setReply(null);
      setFeature(null);
      setRefresh(value => value + 1);
      setError("");
    }
    if (target.id === settings.activeId) show(settings);
    else void call<Settings>("selectWorkspace", { id: target.id }).then(show).catch(reason => {
      if (lastNavigation.current === navigation) setError(String(reason));
    });
  }, [navigation, settings]);
  const syncIds = [...new Set(settings?.items.flatMap(workspace => workspace.sourceIds) ?? [])].sort().join(",");
  useEffect(() => {
    if (!syncIds) return;
    let active = true;
    const inFlight = new Set<string>();
    function sync() {
      for (const id of syncIds.split(",")) {
        if (inFlight.has(id)) continue;
        const authorizationVersion = permissionVersions.current.get(id);
        inFlight.add(id);
        void call<WorkspaceSource>("syncWorkspaceSource", { id }).then(value => {
          if (active && permissionVersions.current.get(id) === authorizationVersion) setSources(current => ({ ...current, [id]: value }));
        }).catch(() => {
          if (active && permissionVersions.current.get(id) === authorizationVersion) {
            setSources(current => ({ ...current, [id]: { id, state: "unauthorized", items: [], conversations: [] } }));
          }
        }).finally(() => inFlight.delete(id));
      }
    }
    sync();
    const timer = window.setInterval(sync, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [syncIds, revision, profileKey, refresh]);

  const workspace = settings?.items.find(item => item.id === settings.activeId);
  const sourceId = reminderSource && workspace?.id === reminderSource.workspaceId && workspace.sourceIds.includes(reminderSource.sourceId)
    ? reminderSource.sourceId : workspace?.sourceFilter ?? "";
  const currentProfiles = profiles.filter(profile => workspace?.sourceIds.includes(profile.id));
  const displayed = currentProfiles.filter(profile => !sourceId || profile.id === sourceId);
  const summarizedProfiles = displayed.filter(profile => sources[profile.id]?.items.some(item => item.kind === "summary"));
  const briefScope = JSON.stringify([workspace?.id, revision, sourceId, roleId, model?.id, summarizedProfiles.map(profile => profile.id)]);
  const featureSource = displayed.find(profile => conversationId.startsWith(profile.id + "/"));
  const featureScope = featureSource ? conversationId.slice(featureSource.id.length + 1) : "";
  const selectedConversation = featureSource && sources[featureSource.id]?.conversations.find(item => item.id === featureScope);
  const isWatched = workspace?.watched?.some(item => item.sourceId === featureSource?.id && item.conversationId === featureScope) === true;
  const serviceFeatures = featureSource && sources[featureSource.id]?.state === "ready"
    ? sources[featureSource.id].features?.filter(item => item.conversationIds.includes(featureScope)) ?? [] : [];
  const selectedFeature = featureSource && feature?.sourceId === featureSource.id && feature.conversationId === featureScope &&
    feature.revision === sources[featureSource.id]?.featureRevision ? feature : null;
  const replySource = currentProfiles.find(profile => profile.id === reply?.sourceId);
  const replyConversation = replySource && sources[replySource.id]?.conversations.find(item => item.id === reply?.conversationId && item.replyAccess);
  const items = displayed.flatMap(profile => (sources[profile.id]?.items ?? []).flatMap(item => {
    const scopedId = `${profile.id}/${item.conversationId}`;
    const conversation = sources[profile.id].conversations.find(entry => entry.id === item.conversationId);
    if (!conversation || conversationId && scopedId !== conversationId) return [];
    return [{ item, profile, conversation, platform: sources[profile.id].platform, key: `${profile.id}/${item.id}` }];
  })).sort((a, b) => b.item.at.localeCompare(a.item.at) || a.key.localeCompare(b.key));

  function select(id: string) {
    setReminderSource(undefined);
    setConversationId("");
    setEdit(null);
    setReply(null);
    setFeature(null);
    void call<Settings>("selectWorkspace", { id }).then(setSettings).catch(reason => setError(String(reason)));
  }

  function filterSource(id: string) {
    if (!workspace || savingFilter) return;
    setSavingFilter(true);
    void call<Settings>("filterWorkspaceSource", { id: workspace.id, sourceId: id }).then(value => {
      setSettings(value);
      setReminderSource(undefined);
      setConversationId("");
      setFeature(null);
    }).catch(reason => setError(String(reason))).finally(() => setSavingFilter(false));
  }

  return <>
    <header><h2>工作区</h2><button type="button" onClick={() => setRefresh(value => value + 1)}>刷新消息</button></header>
    {error && <p role="status">{error}</p>}
    {reply && replySource && replyConversation && <form className="card" onSubmit={event => {
      event.preventDefault();
      if (sending || !reply.text.trim()) return;
      setSending(true);
      setError("");
      void call<{ status: string } | null>("sendWorkspaceReply", { id: reply.sourceId, conversationId: reply.conversationId,
        text: reply.text.trim(), requestId: reply.requestId }).then(result => {
        if (!result) throw new Error("该会话的发送权限已变化。");
        if (result.status === "sent") { setReply(null); setError("已送达原会话。"); }
        else setError(result.status === "failed" ? "网关拒绝发送。" : "发送结果待核对。");
      }).catch(reason => setError(String(reason))).finally(() => setSending(false));
    }}>
      <h3>发送消息</h3>
      <p className="meta">{replySource.name} · {replyConversation.label} · 发送账号 {replyConversation.id.split(":")[1]}</p>
      <label>消息正文<textarea value={reply.text} disabled={sending} maxLength={1200} required onChange={event =>
        setReply({ ...reply, text: event.target.value, requestId: crypto.randomUUID() })} /></label>
      <div className="tools"><button className="primary" disabled={sending || !reply.text.trim()}>发送到原会话</button>
        <button type="button" disabled={sending} onClick={() => setReply(null)}>取消</button></div>
    </form>}
    <div className="tools">
      <label className="inline">当前工作区 <select value={workspace?.id ?? ""} disabled={savingFilter} onChange={event => select(event.target.value)}>
        {settings?.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {workspace && <button type="button" onClick={() => setEdit(workspace)}>配置工作区</button>}
      <button type="button" onClick={() => setEdit({ name: "", sourceIds: [] })}>新建工作区</button>
      {currentProfiles.length > 0 && <button type="button" aria-expanded={developmentOpen}
        onClick={() => setDevelopmentOpen(open => !open)}>开发任务</button>}
    </div>
    {developmentOpen && currentProfiles.length > 0 && <WorkspaceDevelopment key={`${workspace?.id}/${revision}`}
      profiles={currentProfiles} sourceFilter={sourceId} />}
    {edit && <form className="card" onSubmit={event => {
      event.preventDefault();
      setError("");
      void call<Settings>("saveWorkspace", edit).then(value => {
        setSettings(value);
        setEdit(null);
        setReminderSource(undefined);
        setConversationId("");
        void emit("desktop-workspace-watches-changed", {}).catch(() => {});
      })
        .catch(reason => setError(String(reason)));
    }}>
      <label>名称<input value={edit.name} required maxLength={60} onChange={event => setEdit({ ...edit, name: event.target.value })} /></label>
      <fieldset><legend>服务连接</legend>
        {profiles.map(profile => <label className="inline" key={profile.id}>
          <input type="checkbox" checked={edit.sourceIds.includes(profile.id)} onChange={event => setEdit({ ...edit,
            sourceIds: event.target.checked ? [...edit.sourceIds, profile.id] : edit.sourceIds.filter(id => id !== profile.id) })} />{profile.name}
        </label>)}
        {!profiles.length && <button type="button" onClick={openSettings}>添加服务连接</button>}
      </fieldset>
      <fieldset><legend>桌宠摘要提醒</legend>
        <label className="inline"><input type="checkbox" checked={!!edit.reminders} onChange={event =>
          setEdit({ ...edit, reminders: event.target.checked ? defaultWorkspaceReminderPolicy : null })} />使用本工作区的提醒设置</label>
        {edit.reminders && <div className="form-grid">
          <label className="inline"><input type="checkbox" checked={edit.reminders.paused} onChange={event =>
            setEdit({ ...edit, reminders: { ...edit.reminders!, paused: event.target.checked } })} />暂停本工作区提醒</label>
          <label>提醒频率<select value={edit.reminders.intervalMinutes} onChange={event => {
            const intervalMinutes = workspaceReminderIntervals.find(value => value === Number(event.target.value));
            if (intervalMinutes !== undefined) setEdit({ ...edit, reminders: { ...edit.reminders!, intervalMinutes } });
          }}>
            <option value={0}>收到新摘要即提醒</option>
            {workspaceReminderIntervals.filter(minutes => minutes > 0).map(minutes => <option key={minutes} value={minutes}>每 {minutes} 分钟最多提醒一次</option>)}
          </select></label>
          <label className="inline"><input type="checkbox" checked={edit.reminders.quietHours} onChange={event =>
            setEdit({ ...edit, reminders: { ...edit.reminders!, quietHours: event.target.checked } })} />启用勿扰时段</label>
          <label>勿扰开始<input type="time" required disabled={!edit.reminders.quietHours} value={edit.reminders.quietStart} onChange={event =>
            setEdit({ ...edit, reminders: { ...edit.reminders!, quietStart: event.target.value } })} /></label>
          <label>勿扰结束<input type="time" required disabled={!edit.reminders.quietHours} value={edit.reminders.quietEnd} onChange={event =>
            setEdit({ ...edit, reminders: { ...edit.reminders!, quietEnd: event.target.value } })} /></label>
        </div>}
      </fieldset>
      <div className="tools"><button className="primary">保存</button><button type="button" onClick={() => setEdit(null)}>取消</button></div>
    </form>}
    {currentProfiles.length ? <>
      <section className="card" aria-label="连接状态">
        {currentProfiles.map(profile => <p className="meta" key={profile.id}>
          {profile.name} · {stateLabels[sources[profile.id]?.state ?? "stale"]}
          {sources[profile.id]?.syncedAt && ` · 最近同步 ${new Date(sources[profile.id].syncedAt!).toLocaleString()}`}
        </p>)}
      </section>
      {workspace && summarizedProfiles.length > 0 && <section className="card">
        <h3>工作区简报</h3>
        <p className="meta">使用当前个人模型解读 {summarizedProfiles.slice(0, 8).map(profile => profile.name).join("、")} 的已发布摘要。</p>
        <button type="button" disabled={summarizing || !model?.hasKey} onClick={() => {
          setSummarizing(true);
          setBrief(null);
          setError("");
          void call<{ answer: string; sources: { source: string; conversation: string; time: string }[] }>("explainWorkspace", {
            workspaceId: workspace.id, sources: summarizedProfiles.slice(0, 8).map(profile => profile.id), roleId, modelId: model?.id,
          }).then(result => setBrief({ ...result, scope: briefScope })).catch(reason => setError(String(reason)))
            .finally(() => setSummarizing(false));
        }}>{summarizing ? "正在生成…" : "用个人模型解读"}</button>
        {brief?.scope === briefScope && <div className="profile"><p>{brief.answer}</p>
          {brief.sources.map((item, index) => <p className="meta" key={index}>
            {item.source} · {item.conversation} · {new Date(item.time).toLocaleString()}
          </p>)}
        </div>}
      </section>}
      <div className="tools">
        <label className="inline">来源 <select value={sourceId} disabled={savingFilter} onChange={event => filterSource(event.target.value)}>
          <option value="">全部服务</option>
          {currentProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select></label>
        <label className="inline">会话 <select value={conversationId} onChange={event => { setConversationId(event.target.value); setFeature(null); }}>
          <option value="">全部会话</option>
          {conversationId && !selectedConversation && <option value={conversationId} disabled>原会话当前不可访问</option>}
          {displayed.flatMap(profile => (sources[profile.id]?.conversations ?? []).map(conversation =>
            <option key={`${profile.id}/${conversation.id}`} value={`${profile.id}/${conversation.id}`}>{profile.name} · {conversation.label}</option>))}
        </select></label>
      </div>
      {workspace && featureSource && selectedConversation && <label className="inline"><input type="checkbox" checked={isWatched}
        onChange={event => void call<Settings>("watchWorkspaceConversation", { workspaceId: workspace.id, sourceId: featureSource.id,
          conversationId: featureScope, enable: event.target.checked }).then(value => {
          setSettings(value);
          void emit("desktop-workspace-watches-changed", {}).catch(() => {});
        }).catch(reason => setError(String(reason)))} />桌宠提醒此会话的新摘要</label>}
      {active && workspace && featureSource && selectedConversation && featureScope.startsWith("qq:") &&
        ["ready", "summary-only"].includes(sources[featureSource.id].state) && <ConversationProfiles
        key={JSON.stringify([workspace.id, featureSource.id, featureScope, revision])} sourceId={featureSource.id}
        conversationId={featureScope} label={`${featureSource.name} · ${selectedConversation.label}`} />}
      {featureSource && serviceFeatures.length > 0 && <section className="card">
        <h3>{featureSource.name}提供的会话功能</h3>
        <div className="tools">{serviceFeatures.map(item => {
          const compatible = supportsVersion(clientVersion, item.minimumClientVersion);
          return <button type="button" key={item.id} disabled={!compatible} onClick={() => {
            const revision = sources[featureSource.id].featureRevision;
            void call<{ items: FeatureResult["items"] } | null>("openWorkspaceFeature", { id: featureSource.id, featureId: item.id,
              conversationId: featureScope }).then(result => {
              if (!result || !Array.isArray(result.items)) throw new Error("该会话功能当前不可用。");
              setFeature({ sourceId: featureSource.id, conversationId: featureScope, featureId: item.id, revision, title: item.title,
                items: result.items.filter(entry => entry && typeof entry.title === "string" && typeof entry.text === "string").slice(0, 100) });
            }).catch(reason => setError(String(reason)));
          }}>{item.title}{!compatible && ` · 需要 ${item.minimumClientVersion}`}</button>;
        })}</div>
        {selectedFeature && <div className="profile"><h4>{selectedFeature.title}</h4>
          {selectedFeature.items.length === 0 && <p className="meta">暂无内容。</p>}
          {selectedFeature.items.map((item, index) => <div key={index}><p className="meta">{item.title}</p><p>{item.text}</p>
            {workspace && selectedFeature.featureId === "group-daily-review" && typeof item.followUpId === "string" && /^[a-f0-9]{64}$/u.test(item.followUpId) &&
              <ReviewReminderForm key={JSON.stringify([selectedFeature.sourceId, selectedFeature.conversationId, item.followUpId])} workspaceId={workspace.id}
                review={{ sourceId: selectedFeature.sourceId, conversationId: selectedFeature.conversationId, followUpId: item.followUpId }} />}
          </div>)}
        </div>}
      </section>}
      {active && selectedFeature?.featureId === "group-daily-review" && <DesktopInteractionReview key={roleId}
        roleId={roleId} model={model} completedTurn={completedTurn} openMemory={openMemoryReview} afterGeneration={afterInteractionReview} />}
      <section aria-label="统一消息">
        {!items.length && <p className="empty">暂无可显示的消息和摘要。</p>}
        {items.slice(0, 100).map(({ item, profile, conversation, platform, key }) => <article className="card" key={key}>
          <div className="meta">{platform === "qq" ? "QQ" : platform === "wechat" ? "微信" : platform} · {profile.name} · {conversation.label} · {new Date(item.at).toLocaleString()}</div>
          <p>{item.kind === "message" ? item.message.text : item.summary.content}</p>
          <button type="button" onClick={() => openConversation(profile.id, conversation.id)}>打开原会话</button>
          {conversation.replyAccess && <button type="button" disabled={sending} onClick={() => setReply({ sourceId: profile.id,
            conversationId: conversation.id, text: "", requestId: crypto.randomUUID() })}>回复到原会话</button>}
        </article>)}
      </section>
    </> : <p className="empty">在「配置工作区」中添加要同时关注的服务。</p>}
  </>;
}

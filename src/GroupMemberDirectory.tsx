import React, { useCallback, useEffect, useRef, useState } from "react";
import type { GroupMemberProfile } from "../runtime/group-member-reference";
import type { ModelProfile } from "../runtime/models";
import { call } from "./desktop-ipc";

type Profile = Pick<GroupMemberProfile, "displayName" | "summary" | "updatedAt">;
type Options = { groupId: string; roleId: string; serviceEpoch: string; groupRoleRevision?: string; model?: ModelProfile };

export function MemberCard({ profile, children }: { profile: Profile; children?: React.ReactNode }) {
  return <article className="profile">
    <strong>{profile.displayName}</strong>
    {profile.summary && <p>{profile.summary}</p>}
    {profile.updatedAt && <small>更新于 {new Date(profile.updatedAt).toLocaleString()}</small>}
    {children}
  </article>;
}

function MemberExplanation({ profile, groupId, roleId, serviceEpoch, groupRoleRevision, model }: Options & { profile: GroupMemberProfile }) {
  const [consent, setConsent] = useState<ModelProfile>();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  function prepare() {
    setAnswer("");
    setError("");
    if (!model?.hasKey) { setError("讲解需要配置个人模型和 API Key。"); return; }
    setConsent(model);
  }

  async function explain() {
    if (!consent || pending.current) return;
    pending.current = true;
    setBusy(true);
    setConsent(undefined);
    try {
      setAnswer(await call<string>("explainGroupMember", {
        groupId, memberId: profile.id, revision: profile.referenceRevision, roleId, serviceEpoch, groupRoleRevision,
        modelId: consent.id, model: { name: consent.name, model: consent.model, baseUrl: consent.baseUrl },
      }));
    } catch (failure) { setError(String(failure)); }
    finally { pending.current = false; setBusy(false); }
  }

  if (!profile.summary.trim()) return null;
  return <div className="summary-explanation">
    {consent ? <div className="summary-consent">
      <p>将这份群内简介发送给个人模型「{consent.name}」（{new URL(consent.baseUrl).host}），仅用于本次讲解。</p>
      <div className="tools">
        <button type="button" className="primary" onClick={() => void explain()}>确认讲解</button>
        <button type="button" onClick={() => setConsent(undefined)}>取消</button>
      </div>
    </div> : <button type="button" disabled={busy} onClick={prepare}>讲讲这位群友</button>}
    {busy && <p role="status">正在准备讲解…</p>}
    {error && <p role="status">{error}</p>}
    {answer && <p className="bubble assistant" aria-live="polite">{answer}</p>}
  </div>;
}

export function GroupMemberDirectory(options: Options) {
  const { groupId, serviceEpoch } = options;
  const [items, setItems] = useState<GroupMemberProfile[]>();
  const [watch, setWatch] = useState(false);
  const [filter, setFilter] = useState("");
  const [directoryError, setDirectoryError] = useState("");
  const [syncedAt, setSyncedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const directoryPending = useRef<symbol | null>(null);
  const [qqId, setQqId] = useState("");
  const [memberQuery, setMemberQuery] = useState<{ id: string }>();
  const [lookup, setLookup] = useState<Profile | null>();
  const [lookupError, setLookupError] = useState("");
  const [lookingUp, setLookingUp] = useState(false);

  const refresh = useCallback(async () => {
    if (directoryPending.current) return;
    const request = Symbol();
    directoryPending.current = request;
    setLoading(true);
    try {
      const result = await call<{ items: GroupMemberProfile[] }>("members", { groupId, serviceEpoch });
      if (directoryPending.current !== request) return;
      setItems(result.items);
      setSyncedAt(Date.now());
      setDirectoryError("");
    } catch (failure) {
      if (directoryPending.current !== request) return;
      setItems(undefined);
      setSyncedAt(0);
      setDirectoryError(String(failure));
    } finally {
      if (directoryPending.current === request) {
        directoryPending.current = null;
        setLoading(false);
      }
    }
  }, [groupId, serviceEpoch]);

  useEffect(() => {
    if (!watch) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [watch, refresh]);

  function stopWatching() {
    directoryPending.current = null;
    setWatch(false);
    setItems(undefined);
    setSyncedAt(0);
    setFilter("");
    setDirectoryError("");
    setLoading(false);
  }

  useEffect(() => {
    if (!memberQuery) return;
    let current = true;
    let pending = false;
    async function refreshMember(id: string) {
      if (pending) return;
      pending = true;
      try {
        const result = await call<{ profile: Profile | null }>("member", { groupId, qqId: id, serviceEpoch });
        if (current) { setLookup(result.profile); setLookupError(""); }
      } catch (failure) {
        if (current) { setLookup(undefined); setLookupError(String(failure)); }
      } finally {
        pending = false;
        if (current) setLookingUp(false);
      }
    }
    void refreshMember(memberQuery.id);
    const timer = setInterval(() => void refreshMember(memberQuery.id), 30_000);
    return () => { current = false; clearInterval(timer); };
  }, [groupId, memberQuery, serviceEpoch]);

  const search = filter.normalize("NFKC").trim().toLocaleLowerCase();
  const matches = items?.filter(item => item.displayName.normalize("NFKC").toLocaleLowerCase().includes(search));
  return <section className="card">
    <h3>群成员画像</h3>
    <div className="tools">
      <button type="button" disabled={loading} onClick={() => watch ? void refresh() : setWatch(true)}>
        {watch ? "刷新群友画像" : "拉取群友画像"}
      </button>
      {watch && <button type="button" onClick={stopWatching}>停止刷新</button>}
      {syncedAt > 0 && <span className="meta">已发布 {items?.length ?? 0} 份 · {new Date(syncedAt).toLocaleTimeString()} 同步</span>}
    </div>
    {loading && !items && <p role="status">正在拉取画像…</p>}
    {directoryError && <p role="status">{directoryError}</p>}
    {!!items?.length && <label>按群内称呼查找<input value={filter} onChange={event => setFilter(event.target.value)} /></label>}
    {matches?.map(item => <MemberCard key={item.referenceRevision} profile={item}>
      <MemberExplanation key={JSON.stringify([options.roleId, options.groupRoleRevision])} {...options} profile={item} />
    </MemberCard>)}
    {items?.length === 0 && <p className="empty">此群暂无已发布的成员画像。</p>}
    {!!items?.length && !matches?.length && <p className="empty">没有找到匹配的群内称呼。</p>}
    <form className="composer" onSubmit={event => {
      event.preventDefault();
      if (lookingUp || !qqId.trim()) return;
      setLookup(undefined);
      setLookupError("");
      setLookingUp(true);
      setMemberQuery({ id: qqId.trim() });
    }}>
      <input aria-label="QQ群成员标识" placeholder="输入群成员 QQ 标识" inputMode="numeric" value={qqId}
        disabled={lookingUp} onChange={event => {
          setQqId(event.target.value);
          setMemberQuery(undefined);
          setLookup(undefined);
          setLookupError("");
        }} />
      <button disabled={lookingUp || !qqId.trim()}>查看</button>
    </form>
    {lookup ? <MemberCard profile={lookup} /> : lookup === null && <p role="status">该成员没有可见画像。</p>}
    {lookupError && <p role="status">{lookupError}</p>}
  </section>;
}

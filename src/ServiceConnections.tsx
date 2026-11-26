import React, { useEffect, useState } from "react";
import type { DesktopServiceProfile } from "../runtime/desktop-credentials";
import { call } from "./desktop-ipc";

type Draft = { id: string; name: string; address: string };
const initialDraft = (): Draft => ({ id: "legacy", name: "默认连接", address: "" });

export function ServiceConnections({ profiles, activeId, epoch, busy, change }: {
  profiles: DesktopServiceProfile[];
  activeId: string | null;
  epoch: string;
  busy: boolean;
  change: (operation: () => Promise<unknown>) => void;
}) {
  const active = profiles.find(profile => profile.id === activeId);
  const [draft, setDraft] = useState<Draft | null>(() => active ?? (profiles.length ? null : initialDraft()));
  const [token, setToken] = useState("");

  useEffect(() => {
    setDraft(active ?? (profiles.length ? null : initialDraft()));
    setToken("");
  }, [active?.id, active?.name, active?.address, profiles.length]);

  return <section className="card service-connections">
    <h3>群动态订阅</h3>
    <p className="meta">选择保存的服务连接，或断开连接后独立使用桌宠。</p>
    {!!profiles.length && <label>当前服务连接
      <select value={activeId ?? ""} disabled={busy} onChange={event => {
        const id = event.target.value || null;
        change(() => call("selectServiceProfile", { id, serviceEpoch: epoch }));
      }}>
        <option value="">未连接</option>
        {profiles.map(profile => <option value={profile.id} key={profile.id}>{profile.name} · {profile.address}</option>)}
      </select>
    </label>}
    <div className="tools">
      <button type="button" disabled={busy} onClick={() => {
        setDraft({ id: crypto.randomUUID(), name: "", address: "" });
        setToken("");
      }}>新增连接</button>
      {active && draft?.id !== active.id && <button type="button" disabled={busy} onClick={() => {
        setDraft(active); setToken("");
      }}>编辑当前连接</button>}
      {active && <button type="button" disabled={busy} onClick={() => {
        if (window.confirm(`移除本机的「${active.name}」连接和订阅令牌？`)) {
          change(() => call("removeServiceProfile", { id: active.id, serviceEpoch: epoch }));
        }
      }}>移除当前连接</button>}
    </div>
    {draft && <form className="form-grid" onSubmit={event => {
      event.preventDefault();
      change(async () => {
        const action = draft.id === "legacy" ? "saveService" : "saveServiceProfile";
        await call(action, { ...draft, serviceEpoch: epoch }, token.trim() || undefined);
        setToken("");
      });
    }}>
      <label>连接名称<input required maxLength={60} value={draft.name}
        onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>服务地址<input type="url" required value={draft.address}
        onChange={event => setDraft({ ...draft, address: event.target.value })} /></label>
      <label>只读订阅令牌<input type="password" autoComplete="off" value={token}
        onChange={event => setToken(event.target.value)} /></label>
      <button className="primary" disabled={busy}>保存并测试</button>
    </form>}
  </section>;
}

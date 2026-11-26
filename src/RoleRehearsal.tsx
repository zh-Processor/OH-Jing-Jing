import React, { useState } from "react";
import { careLabels, type CareAction } from "../runtime/companion-state";
import { rehearsalScenarios, roleScenes, type RehearsalScenario } from "../runtime/personality";
import type { ModelProfile } from "../runtime/models";
import type { RoleRehearsalResult } from "../runtime/role-rehearsal";
import { call } from "./desktop-ipc";

export function RoleRehearsal({ roleId, models, initialModel }: { roleId: string; models: ModelProfile[]; initialModel: string }) {
  const [choice, setChoice] = useState(initialModel);
  const [scenario, setScenario] = useState<RehearsalScenario>("group");
  const [message, setMessage] = useState("");
  const [reference, setReference] = useState("");
  const [care, setCare] = useState<CareAction>("pet");
  const [time, setTime] = useState("21:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RoleRehearsalResult | null>(null);
  const available = models.filter(item => item.hasKey);
  const modelId = available.find(item => item.id === choice)?.id ?? available[0]?.id ?? "";
  const scheduled = scenario === "scheduled";

  async function rehearse() {
    if (busy || !modelId) return;
    setBusy(true);
    setResult(null);
    setError("");
    try {
      const input = scheduled ? { time } : { text: message, reference, ...(scenario === "mood" ? { care } : {}) };
      setResult(await call<RoleRehearsalResult>("rehearseRole", { roleId, modelId, scenario, ...input }));
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  return <details>
    <summary>角色试演</summary>
    <form className="plugin-card" onSubmit={event => { event.preventDefault(); void rehearse(); }}>
      <div className="form-grid">
        <label>试演场景<select value={scenario} disabled={busy}
          onChange={event => setScenario(event.target.value as RehearsalScenario)}>
          {Object.entries(rehearsalScenarios).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>试演模型<select value={modelId} disabled={!available.length || busy} onChange={event => setChoice(event.target.value)}>
          {!available.length && <option value="">请先配置 API Key</option>}
          {available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
      </div>
      {scenario === "mood" && <label>互动动作<select value={care} disabled={busy}
        onChange={event => setCare(event.target.value as CareAction)}>
        {Object.entries(careLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
      </select></label>}
      {scheduled ? <label>模拟本地时刻<input type="time" required value={time} disabled={busy}
        onChange={event => setTime(event.target.value)} /></label> : <>
        <label>测试消息<textarea required rows={3} maxLength={4000} value={message} disabled={busy}
          onChange={event => setMessage(event.target.value)} /></label>
        <label>样本记忆<textarea rows={2} maxLength={600} value={reference} disabled={busy}
          onChange={event => setReference(event.target.value)} /></label>
      </>}
      <div className="tools">
        <button type="submit" disabled={busy || !modelId || (scheduled ? !time : !message.trim())}>{busy ? "生成中…" : "运行试演"}</button>
        <small>调用个人模型 1 次，计入本机用量。试演只读取此处填写的样本。</small>
      </div>
      {error && <p role="alert">{error}</p>}
      {result && <section className="profile" aria-label="试演结果" aria-live="polite">
        <strong>{result.role.name} · {result.role.version}</strong>
        <p className="meta">{rehearsalScenarios[result.scenario]} · {roleScenes[result.scene]}规则 · {result.model}</p>
        <p className="meta">角色版本指纹 <code>{result.role.revision.slice(0, 12)}</code></p>
        <p>{result.reason}</p>
        {result.reference && <p className="role-description">参考记忆 · {result.reference}</p>}
        {result.outcome === "skip" && <p>角色选择保持沉默。</p>}
        {result.outcome === "invalid" && <p>模型没有返回可用的预览。</p>}
        {result.parts.map((part, index) => <p key={index} className="role-description">{part}</p>)}
      </section>}
    </form>
  </details>;
}

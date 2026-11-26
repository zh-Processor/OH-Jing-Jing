import React, { useRef, useState } from "react";
import type { ModelProfile } from "../runtime/models";
import { call } from "./desktop-ipc";

type Props = { groupId: string; revision: string; roleId: string; serviceEpoch?: string; groupRoleRevision?: string };

export function GroupSummaryExplanation({ groupId, revision, roleId, serviceEpoch, groupRoleRevision }: Props) {
  const [model, setModel] = useState<ModelProfile>();
  const [canIncludeSelf, setCanIncludeSelf] = useState(false);
  const [includeSelf, setIncludeSelf] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const pending = useRef(false);

  async function prepare() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setAnswer("");
    try {
      const { models } = await call<{ models: ModelProfile[] }>("state");
      const selected = models.find(item => item.id === localStorage.getItem("modelId")) ?? models[0];
      if (!selected?.hasKey) {
        setError("讲解需要在主窗口配置个人模型和 API Key。你仍可直接阅读摘要。");
        return;
      }
      setIncludeSelf(false);
      setCanIncludeSelf(localStorage.getItem("includeSelf") === "true");
      setModel(selected);
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); pending.current = false; }
  }

  async function explain() {
    if (!model || pending.current) return;
    pending.current = true;
    setBusy(true);
    setModel(undefined);
    setError("");
    try {
      setAnswer(await call<string>("explainGroupSummary", {
        groupId, revision, roleId, serviceEpoch, groupRoleRevision,
        includeSelf: includeSelf && localStorage.getItem("includeSelf") === "true",
        modelId: model.id, model: { name: model.name, model: model.model, baseUrl: model.baseUrl },
      }));
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); pending.current = false; }
  }

  return <div className="summary-explanation">
    {model ? <div className="summary-consent">
      <p>将当前摘要发送给个人模型「{model.name}」（{new URL(model.baseUrl).host}），仅用于本次讲解。</p>
      {canIncludeSelf && <label className="inline"><input type="checkbox" checked={includeSelf}
        onChange={event => setIncludeSelf(event.target.checked)} />同时使用本人可见画像</label>}
      <div className="tools">
        <button type="button" className="primary" onClick={() => void explain()}>确认讲解</button>
        <button type="button" onClick={() => setModel(undefined)}>取消</button>
      </div>
    </div> : <button type="button" className="primary" disabled={busy} onClick={() => void prepare()}>讲给我听</button>}
    {busy && <p role="status">正在准备讲解…</p>}
    {error && <p role="status">{error}</p>}
    {answer && <p className="bubble assistant" aria-live="polite">{answer}</p>}
  </div>;
}

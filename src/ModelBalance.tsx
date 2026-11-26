import React, { useEffect, useRef, useState } from "react";
import type { DesktopModelBalanceSnapshot } from "../runtime/main";
import type { BalanceSnapshot } from "../runtime/models";
import { call } from "./desktop-ipc";

const expiry = 15 * 60_000;

function BalanceValues({ snapshot }: { snapshot: BalanceSnapshot }) {
  const checked = Date.parse(snapshot.checkedAt ?? "");
  const stale = Number.isFinite(checked) && Date.now() - checked >= expiry;
  return <>
    {snapshot.status === "unlimited" && <p>此 Key 未设置额度上限。</p>}
    {snapshot.values?.map(item => <p key={item.currency}>
      {item.currency === "quota" ? "供应商配额单位" : item.currency}
      {snapshot.status !== "unlimited" && <> · 剩余 {item.remaining ?? "未知"}</>}
      {item.limit != null && <> · 上限 {item.limit}</>}
      {item.used != null && <> · 已用 {item.used}</>}
    </p>)}
    {snapshot.effectiveBudget && <p>实际可用预算 · {snapshot.effectiveBudget.currency} {snapshot.effectiveBudget.remaining}</p>}
    {snapshot.checkedAt && <small>{snapshot.source} · {new Date(checked).toLocaleString()}{stale && " · 数据已超过 15 分钟"}</small>}
  </>;
}

export function ModelBalance({ modelId, disabled }: { modelId: string; disabled: boolean }) {
  const [snapshot, setSnapshot] = useState<DesktopModelBalanceSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => {
    const current = ++request.current;
    void call<DesktopModelBalanceSnapshot | null>("balance", { modelId, cachedOnly: true }).then(saved => {
      if (request.current === current) setSnapshot(saved);
    }).catch(() => {});
    return () => { request.current++; };
  }, [modelId]);

  async function refresh() {
    const current = ++request.current;
    setPending(true);
    setError("");
    try {
      const latest = await call<DesktopModelBalanceSnapshot>("balance", { modelId });
      if (request.current === current) setSnapshot(latest);
    } catch (failure) {
      if (request.current === current) {
        setSnapshot(null);
        setError(String(failure));
      }
    } finally {
      if (request.current === current) setPending(false);
    }
  }

  return <>
    <div className="tools"><button type="button" disabled={disabled || pending} onClick={() => void refresh()}>
      {pending ? "正在查询额度…" : "刷新余额"}
    </button></div>
    {error && <p role="status">{error}</p>}
    {snapshot && <div className="profile" role="status">
      {snapshot.status === "unsupported" ? <p>此档案未提供可查询余额。</p> : <>
        <strong>{snapshot.scope === "account" ? "供应商账户余额" : "API Key 额度"}</strong>
        {snapshot.status === "denied" && <p>供应商拒绝查询。请检查 API Key 和查询权限。</p>}
        {snapshot.status === "unavailable" && <p>供应商查询暂时不可用。</p>}
        {snapshot.status === "unknown" && <p>供应商未返回可用余额。</p>}
        {snapshot.previous ? <>
          {snapshot.checkedAt && <p className="meta">本次查询于 {new Date(snapshot.checkedAt).toLocaleString()} 完成</p>}
          <strong>上次成功结果</strong>
          <BalanceValues snapshot={snapshot.previous} />
        </> : <BalanceValues snapshot={snapshot} />}
      </>}
    </div>}
  </>;
}

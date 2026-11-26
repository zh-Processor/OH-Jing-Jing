import { useEffect, useRef, useState } from "react";
import type { DesktopServiceProfile } from "../runtime/desktop-credentials";
import type { DevelopmentTask, DevelopmentTaskView } from "../runtime/development-tasks";
import { call } from "./desktop-ipc";

type Tasks = { target: string; items: DevelopmentTaskView[]; acceptanceInput?: boolean; detailsInput?: boolean };
const labels: Record<DevelopmentTask["state"], string> = { queued: "已受理", developing: "开发中", testing: "测试中", candidate: "待发布",
  publishing: "发布中", published: "已生效", failed: "失败", "rolled-back": "已回滚", cancelled: "已取消", "awaiting-details": "等待补充" };

export function WorkspaceDevelopment({ profiles, sourceFilter }: { profiles: DesktopServiceProfile[]; sourceFilter: string }) {
  const [feeds, setFeeds] = useState<Record<string, Tasks | null>>({});
  const [source, setSource] = useState("");
  const [requirement, setRequirement] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [status, setStatus] = useState("");
  const [revision, setRevision] = useState(0);
  const submission = useRef<{ key: string; id: string } | undefined>(undefined);
  const keys = profiles.map(profile => profile.id).join(",");
  useEffect(() => {
    let active = true;
    const pending = new Set<string>();
    const refresh = () => {
      for (const id of keys ? keys.split(",") : []) {
        if (pending.has(id)) continue;
        pending.add(id);
        void call<Tasks | null>("workspaceDevelopmentTasks", { id }).then(value => {
          if (active) setFeeds(current => ({ ...current, [id]: value }));
        }).catch(() => { if (active) setFeeds(current => ({ ...current, [id]: null })); })
          .finally(() => pending.delete(id));
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [keys, revision]);

  const authorized = profiles.filter(profile => (!sourceFilter || profile.id === sourceFilter) && feeds[profile.id]);
  const selected = authorized.some(profile => profile.id === source) ? feeds[source] : null;
  const acceptsConditions = selected?.acceptanceInput === true;
  const hasConditions = !!acceptance.trim();
  const canSubmit = !!selected && !submitting && (acceptsConditions || !hasConditions);
  async function changeTask(id: string, task: DevelopmentTaskView, details?: string) {
    const operation = details ? "supplement" : task.availableAction;
    if (controlling || !operation) return;
    setControlling(true);
    setStatus("");
    try {
      const result = await call<{ task: DevelopmentTaskView } | null>("workspaceDevelopmentAction", {
        id, target: task.target, taskId: task.id, operation, state: task.state, updatedAt: task.updatedAt, details,
      });
      if (!result) throw new Error("任务或维护权限已变化。");
      setFeeds(current => {
        const feed = current[id];
        return feed?.target === result.task.target
          ? { ...current, [id]: { ...feed, items: feed.items.map(row => row.id === task.id ? result.task : row) } } : current;
      });
      setStatus(operation === "cancel" ? "任务已取消。" : operation === "supplement" ? "补充已保存，任务已重新排队。" : "任务已重新排队。");
    } catch (error) {
      setStatus(String(error).includes("HTTP 409") ? "任务状态已更新，正在刷新。" : String(error));
    } finally {
      setRevision(value => value + 1);
      setControlling(false);
    }
  }
  return <section className="card">
    <h3>开发任务</h3>
    {authorized.length ? <form onSubmit={event => {
      event.preventDefault();
      if (!selected || !canSubmit || !requirement.trim()) return;
      const key = JSON.stringify([source, selected.target, requirement.trim(), acceptance.trim()]);
      if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID() };
      setSubmitting(true);
      setStatus("");
      void call<{ task: DevelopmentTask } | null>("submitWorkspaceDevelopmentTask", { id: source, target: selected.target,
        requirement: requirement.trim(), ...(acceptsConditions && { acceptance: acceptance.trim() }), requestId: submission.current.id }).then(result => {
        if (!result) throw new Error("目标服务的维护权限已变化。");
        setStatus(`已受理 · ${result.task.id}`);
        setRequirement("");
        setAcceptance("");
        submission.current = undefined;
        setRevision(value => value + 1);
      }).catch(error => setStatus(String(error))).finally(() => setSubmitting(false));
    }}>
      <label>目标服务与实例<select disabled={submitting} value={selected ? source : ""} onChange={event => setSource(event.target.value)}>
        <option value="">选择目标</option>
        {authorized.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {feeds[profile.id]?.target}</option>)}
      </select></label>
      <label>功能需求<textarea maxLength={2000} minLength={4} required disabled={submitting} value={requirement}
        onChange={event => setRequirement(event.target.value)} /></label>
      <label>验收条件（选填）<textarea maxLength={1000} disabled={submitting || (!acceptsConditions && !hasConditions)} value={acceptance}
        onChange={event => setAcceptance(event.target.value)} /></label>
      {selected && !acceptsConditions && <p className="meta">当前服务版本只能接收功能需求。</p>}
      <button className="primary" disabled={!canSubmit}>提交需求</button>
    </form> : <p className="meta">等待服务返回可用的维护权限。</p>}
    {status && <p role="status">{status}</p>}
    {authorized.flatMap(profile => (feeds[profile.id]?.items ?? []).map(task =>
      <div className="profile" key={`${profile.id}/${task.id}`}>
        <p>{task.requirement}</p><p className="meta">{profile.name} · {task.target} · {labels[task.state]}{task.version && ` · ${task.version}`}</p>
        <p className="meta">{task.id}</p>{task.result && <p>{task.result}</p>}
        {task.acceptance && <details><summary>验收条件</summary><p>{task.acceptance}</p></details>}
        {task.state === "awaiting-details" && feeds[profile.id]?.detailsInput && <form onSubmit={event => {
          event.preventDefault();
          const details = String(new FormData(event.currentTarget).get("details") ?? "").trim();
          if (details) void changeTask(profile.id, task, details);
        }}>
          <label>补充内容<textarea name="details" maxLength={1000} required disabled={controlling} /></label>
          <button type="submit" disabled={controlling}>提交补充</button>
        </form>}
        {(task.availableAction === "cancel" || task.availableAction === "retry") &&
          <button type="button" disabled={controlling} onClick={() => void changeTask(profile.id, task)}>
            {task.availableAction === "cancel" ? "取消任务" : "重试任务"}
          </button>}
      </div>))}
  </section>;
}

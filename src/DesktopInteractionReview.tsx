import { useEffect, useRef, useState } from "react";
import type { DesktopInteractionReview as Review } from "../runtime/desktop-interaction-review";
import type { ModelProfile } from "../runtime/models";
import { call } from "./desktop-ipc";
import { ReminderFromReview } from "./LocalReminders";

export function DesktopInteractionReview({ roleId, model, completedTurn, openMemory, afterGeneration }: {
  roleId: string;
  model?: ModelProfile;
  completedTurn?: string;
  openMemory: () => void;
  afterGeneration: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [review, setReview] = useState<Review>();
  const [message, setMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    if (!expanded) return;
    const version = ++request.current;
    setReview(undefined);
    setMessage("");
    void call<Review>("interactionReview", { roleId }).then(next => {
      if (version === request.current) setReview(next);
    }).catch(error => {
      if (version === request.current) setMessage(String(error));
    });
    return () => { request.current++; };
  }, [expanded, roleId, completedTurn]);

  async function generate() {
    if (!model?.hasKey || generating) return;
    const version = request.current;
    setMessage("");
    setGenerating(true);
    try {
      const value = await call<Review>("generateInteractionReview", { roleId, modelId: model.id });
      if (version === request.current) {
        setReview(value);
        setMessage(value.recap ? "互动复盘已生成。" : "没有可复盘的个人聊天。");
      }
    } catch (error) {
      if (version === request.current) setMessage(String(error));
    } finally {
      setGenerating(false);
      afterGeneration();
    }
  }

  const recap = review?.recap;
  return <details className="card" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>个人互动复盘</summary>
    {expanded && <>
      {!review && !message && <p role="status">正在读取本机互动…</p>}
      {review && !review.ready && <p className="meta">最近 24 小时没有与当前角色的个人聊天。</p>}
      {review?.ready && !recap && <>
        <p className="meta">{model?.hasKey
          ? `生成时会将最近 24 小时最多 24 条本机对话，以及最多 16 条待分析的本人发言发送给「${model.name}」，计入个人模型用量。`
          : "生成复盘需要为个人模型配置 API Key。"}</p>
        <button type="button" disabled={generating || !model?.hasKey} onClick={() => void generate()}>
          {generating ? "正在复盘…" : "生成个人互动复盘"}
        </button>
      </>}
      {recap && <div className="profile" aria-label="最近互动摘要">
        <p>{recap.overview}</p>
        <p className="meta">生成于 {new Date(recap.generatedAt).toLocaleString()}</p>
        {recap.followUps.map((text, index) => <div className="profile" key={JSON.stringify([recap.revision, index])}>
          <p>{text}</p>
          <ReminderFromReview create={(dueAt, requestId) => call("createInteractionReviewReminder", {
            roleId, revision: recap.revision, index, dueAt, requestId,
          })} />
        </div>)}
      </div>}
      {!!review?.pendingMemory && <button type="button" onClick={openMemory}>查看 {review.pendingMemory} 条待审个人记忆</button>}
      {message && <p role="status">{message}</p>}
    </>}
  </details>;
}

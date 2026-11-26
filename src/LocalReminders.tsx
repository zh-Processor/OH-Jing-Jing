import React, { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { LocalReminder, LocalReminders, LocalReviewReference } from "../runtime/desktop-local-reminders";
import { call } from "./desktop-ipc";

const changed = "desktop-local-reminders-updated";

export function useLocalReminders() {
  const [snapshot, setSnapshot] = useState<LocalReminders>();
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reading = useRef(0);
  const saving = useRef(false);
  const refresh = useCallback(async () => {
    const attempt = ++reading.current;
    try {
      const value = await call<LocalReminders>("localReminders");
      if (attempt === reading.current) {
        setSnapshot(value);
        setNow(Date.now());
      }
    } catch (error) {
      if (attempt === reading.current) setError(String(error));
    }
  }, []);
  useEffect(() => {
    const subscription = listen(changed, () => void refresh());
    void subscription.then(refresh).catch(refresh);
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      reading.current++;
      window.clearInterval(interval);
      void subscription.then(off => off()).catch(() => {});
    };
  }, [refresh]);
  const ticking = !!snapshot?.items.length;
  useEffect(() => {
    if (!ticking) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [ticking]);

  async function update(action: string, args: object) {
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await call(action, args);
      void emit(changed, {}).catch(() => {});
      await refresh();
      return true;
    } catch (error) {
      setError(String(error));
      await refresh();
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return { snapshot, due: (snapshot?.items ?? []).filter(item => item.dueAt <= now), busy, error, update };
}

type RemindersView = ReturnType<typeof useLocalReminders>;

export function LocalReminderActions({ item, reminders, due, openReview }: {
  item: LocalReminder; reminders: RemindersView; due: boolean; openReview?: (review: LocalReviewReference) => void;
}) {
  const action = (name: "complete" | "snooze", minutes?: 5 | 15) =>
    void reminders.update("changeLocalReminder", { id: item.id, version: item.version, action: name, minutes });
  return <>
    {item.review && openReview && <button type="button" onClick={() => openReview(item.review!)}>打开原会话</button>}
    <button type="button" disabled={reminders.busy} onClick={() => action("complete")}>完成</button>
    {due && <>
      <button type="button" disabled={reminders.busy} onClick={() => action("snooze", 5)}>5 分钟后</button>
      <button type="button" disabled={reminders.busy} onClick={() => action("snooze", 15)}>15 分钟后</button>
    </>}
  </>;
}

function localTimeValue(time: number) {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function ReviewReminderForm({ review, workspaceId }: { review: LocalReviewReference; workspaceId: string }) {
  return <ReminderFromReview create={(dueAt, requestId) => call("createWorkspaceReviewReminder", {
    id: review.sourceId, workspaceId, conversationId: review.conversationId, followUpId: review.followUpId, dueAt, requestId,
  })} />;
}

export function ReminderFromReview({ create }: { create: (dueAt: number, requestId: string) => Promise<unknown> }) {
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const request = useRef<{ time: number; id: string } | undefined>(undefined);

  if (saved) return <p role="status">已保存到本地提醒。</p>;
  if (!when) return <button type="button" onClick={() => setWhen(localTimeValue(Date.now() + 30 * 60_000))}>添加本地提醒</button>;
  return <form className="tools" onSubmit={async event => {
    event.preventDefault();
    if (busy) return;
    const dueAt = new Date(when).getTime();
    if (!Number.isFinite(dueAt) || localTimeValue(dueAt) !== when || dueAt <= Date.now()) {
      setMessage("请选择本机时区中未来的有效时间。");
      return;
    }
    if (request.current?.time !== dueAt) request.current = { time: dueAt, id: crypto.randomUUID() };
    setBusy(true);
    setMessage("");
    try {
      await create(dueAt, request.current.id);
      void emit(changed, {}).catch(() => {});
      setSaved(true);
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }}>
    <label>提醒时间<input type="datetime-local" required value={when} onChange={event => setWhen(event.target.value)} /></label>
    <button type="submit" disabled={busy}>保存本地提醒</button>
    <button type="button" disabled={busy} onClick={() => { setWhen(""); setMessage(""); }}>取消</button>
    {message && <p role="status">{message}</p>}
  </form>;
}

export function LocalReminderPanel({ reminders, openSettings, openReview }: {
  reminders: RemindersView; openSettings: () => void; openReview: (review: LocalReviewReference) => void;
}) {
  const [text, setText] = useState("");
  const [when, setWhen] = useState(() => localTimeValue(Date.now() + 30 * 60_000));
  const [editing, setEditing] = useState<LocalReminder>();
  const [inputError, setInputError] = useState("");
  const creation = useRef<{ signature: string; id: string } | undefined>(undefined);
  const due = new Set(reminders.due.map(item => item.id));
  const clearForm = () => {
    setText("");
    setWhen(localTimeValue(Date.now() + 30 * 60_000));
    setEditing(undefined);
    setInputError("");
    creation.current = undefined;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const dueAt = new Date(when).getTime();
    if (!Number.isFinite(dueAt) || localTimeValue(dueAt) !== when) {
      setInputError("请选择本机时区中有效的日期和时间。");
      return;
    }
    setInputError("");
    if (editing) {
      if (await reminders.update("changeLocalReminder", { id: editing.id, version: editing.version, action: "edit", text, dueAt })) clearForm();
      return;
    }
    const signature = JSON.stringify([text.trim(), dueAt]);
    if (creation.current?.signature !== signature) creation.current = { signature, id: crypto.randomUUID() };
    if (await reminders.update("createLocalReminder", { id: creation.current.id, text, dueAt })) clearForm();
  };

  return <>
    <header><h2>本地提醒</h2>
      {reminders.snapshot && <button type="button" disabled={reminders.busy}
        onClick={() => void reminders.update("pauseLocalReminders", { paused: !reminders.snapshot?.paused })}>
        {reminders.snapshot.paused ? "恢复本地提醒" : "暂停本地提醒"}
      </button>}
    </header>
    {reminders.error && <p className="notice" role="alert">{reminders.error}</p>}
    {reminders.snapshot && <>
      <section className="card">
        <p className="meta">提醒按本机时间保存。可在设置中调整勿扰和全屏延后。 <button type="button" onClick={openSettings}>勿扰设置</button></p>
        {reminders.snapshot.paused && <p role="status">本地提醒气泡已暂停。</p>}
        {inputError && <p className="notice" role="alert">{inputError}</p>}
        <form className="form-grid" onSubmit={event => void submit(event)}>
          <label>提醒内容<input required maxLength={120} value={text} onChange={event => setText(event.target.value)} /></label>
          <label>提醒时间<input type="datetime-local" required value={when} onChange={event => setWhen(event.target.value)} /></label>
          <div className="tools">
            <button className="primary" disabled={reminders.busy}>{editing ? "保存修改" : "添加提醒"}</button>
            {editing && <button type="button" onClick={clearForm}>取消编辑</button>}
          </div>
        </form>
      </section>
      {reminders.snapshot.items.length ? <ul className="local-reminder-list">
        {reminders.snapshot.items.map(item => <li className="card" key={item.id}>
          <strong>{item.text}</strong>
          <p className="meta">{new Date(item.dueAt).toLocaleString()}{due.has(item.id) ? " · 已到期" : ""}</p>
          <div className="tools">
            <LocalReminderActions item={item} reminders={reminders} due={due.has(item.id)} openReview={openReview} />
            <button type="button" disabled={reminders.busy} onClick={() => {
              setEditing(item);
              setText(item.text);
              setWhen(localTimeValue(item.dueAt));
              setInputError("");
            }}>编辑</button>
            <button type="button" disabled={reminders.busy} onClick={() => void reminders.update("changeLocalReminder",
              { id: item.id, version: item.version, action: "cancel" })}>取消提醒</button>
          </div>
        </li>)}
      </ul> : <p className="empty">暂无本地提醒。</p>}
    </>}
  </>;
}

import { useState } from "react";
import type { Role } from "../runtime/roles";

export function RoleCardEditor({ role, busy, onSave, onClose }: {
  role: Role;
  busy: boolean;
  onSave: (role: Role) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(role);
  const [examples, setExamples] = useState(role.examples ? JSON.stringify(role.examples, null, 2) : "");
  const [error, setError] = useState("");
  const [readingAvatar, setReadingAvatar] = useState(false);

  function loadAvatar(file?: File) {
    if (!file) return;
    setError("");
    if (file.size > 71_982) {
      setError("PNG 文件最大约 70 KiB。");
      return;
    }
    const reader = new FileReader();
    setReadingAvatar(true);
    reader.onload = () => {
      const base64 = String(reader.result).split(",", 2)[1];
      setDraft(current => ({ ...current, avatar: "data:image/png;base64," + base64 }));
      setReadingAvatar(false);
    };
    reader.onerror = () => { setError("读取头像失败。"); setReadingAvatar(false); };
    reader.readAsDataURL(file);
  }

  return <form className="role-card-editor plugin-card" aria-label="编辑角色卡" onSubmit={event => {
    event.preventDefault();
    setError("");
    let parsed: Role["examples"];
    try {
      parsed = examples.trim() ? JSON.parse(examples) : undefined;
      if (parsed !== undefined && !Array.isArray(parsed)) throw new Error();
    } catch {
      setError("对话示例需要是 JSON 数组。");
      return;
    }
    onSave({ ...draft, examples: parsed });
  }}>
    <div className="form-grid">
      <label>名称<input aria-label="编辑角色名称" value={draft.name} required maxLength={60}
        onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>版本<input value={draft.version} required pattern="[0-9]+[.][0-9]+[.][0-9]+"
        onChange={event => setDraft({ ...draft, version: event.target.value })} /></label>
    </div>
    <label>角色设定<textarea aria-label="编辑角色设定" value={draft.persona} required maxLength={16000}
      onChange={event => setDraft({ ...draft, persona: event.target.value })} /></label>
    <div className="tools">
      <label>PNG 头像<input type="file" accept="image/png,.png" disabled={busy || readingAvatar} onChange={event => loadAvatar(event.target.files?.[0])} /></label>
      {draft.avatar && <button type="button" disabled={busy || readingAvatar} onClick={() => setDraft({ ...draft, avatar: undefined })}>移除头像</button>}
    </div>
    <details>
      <summary>对话示例</summary>
      <textarea aria-label="角色对话示例 JSON" placeholder='[{"user":"在吗","assistant":"在。","scene":"desktop","intent":"greeting"}]'
        value={examples} onChange={event => setExamples(event.target.value)} />
    </details>
    {error && <p role="alert">{error}</p>}
    <div className="tools">
      <button className="primary" disabled={busy || readingAvatar}>保存角色</button>
      <button type="button" disabled={busy} onClick={onClose}>取消编辑</button>
    </div>
  </form>;
}

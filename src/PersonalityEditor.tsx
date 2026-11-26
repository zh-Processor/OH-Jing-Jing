import { useState } from "react";
import { describePersonality, personalityAxes, roleScenes, type Personality, type PersonalityAxis, type RoleScene } from "../runtime/personality";
import { moodLabels, type MoodDimension, type MoodProfile } from "../runtime/companion-state";

const listFields = { values: "价值观（按优先级）", interests: "兴趣", boundaries: "相处边界" } as const;
const listKeys = Object.keys(listFields) as (keyof typeof listFields)[];
const traitKeys = Object.keys(personalityAxes) as PersonalityAxis[];
const sceneKeys = Object.keys(roleScenes) as RoleScene[];
const moodKeys = Object.keys(moodLabels) as MoodDimension[];

export function PersonalityEditor({ personality, busy, onSave }: {
  personality?: Personality;
  busy: boolean;
  onSave: (next: Personality | null) => void;
}) {
  const [traits, setTraits] = useState(personality?.traits ?? {});
  const [lists, setLists] = useState({
    values: personality?.values?.join("\n") ?? "",
    interests: personality?.interests?.join("\n") ?? "",
    boundaries: personality?.boundaries?.join("\n") ?? "",
  });
  const [voice, setVoice] = useState(personality?.voice ?? "");
  const [scenes, setScenes] = useState(personality?.scenes ?? {});
  const [mood, setMood] = useState<MoodProfile | undefined>(personality?.mood);
  const [previewScene, setPreviewScene] = useState<RoleScene>("desktop");

  const sceneRules: Personality["scenes"] = {};
  const draft: Personality = { traits, voice: voice.trim() || undefined, scenes: sceneRules, mood };
  for (const key of listKeys) draft[key] = lists[key].split("\n").map(text => text.trim()).filter(Boolean);
  for (const key of sceneKeys) {
    const rule = scenes[key]?.trim();
    if (rule) sceneRules[key] = rule;
  }
  const preview = describePersonality(draft, previewScene);

  return <details>
    <summary>调整人格</summary>
    <p className="meta">保存后应用到这台设备上的当前角色。</p>
    <form onSubmit={event => { event.preventDefault(); onSave(draft); }}>
      <div className="form-grid">
        {traitKeys.map(key => <label key={key}>{personalityAxes[key].label}
          <select disabled={busy} value={traits[key] ?? ""} onChange={event => {
            const value = event.target.value;
            setTraits(current => ({ ...current, [key]: value ? Number(value) : undefined }));
          }}>
            <option value="">沿用角色文字设定</option>
            {personalityAxes[key].levels.map((label, index) => <option key={label} value={index + 1}>{label}</option>)}
          </select>
        </label>)}
      </div>
      <details>
        <summary>价值观、语言与场景</summary>
        <div className="form-grid">
          {listKeys.map(key => <label key={key}>{listFields[key]}
            <textarea disabled={busy} rows={3} maxLength={1287} placeholder="每行一条，最多 8 条"
              value={lists[key]} onChange={event => setLists({ ...lists, [key]: event.target.value })} />
          </label>)}
          <label>语言习惯<textarea disabled={busy} rows={3} maxLength={600} value={voice} onChange={event => setVoice(event.target.value)} /></label>
          {sceneKeys.map(key => <label key={key}>{roleScenes[key]}
            <textarea disabled={busy} rows={3} maxLength={600} value={scenes[key] ?? ""}
              onChange={event => setScenes({ ...scenes, [key]: event.target.value })} />
          </label>)}
        </div>
      </details>
      <details>
        <summary>心情基线与恢复速度</summary>
        <div className="form-grid">
          {moodKeys.flatMap(key => ([
            { field: "baseline", label: "基线", min: 0, max: 100 },
            { field: "recoveryMinutes", label: "恢复半衰期（分钟）", min: 5, max: 1440 },
          ] as const).map(({ field, label, min, max }) => <label key={`${key}-${field}`}>{moodLabels[key]} · {label}
            <input type="number" min={min} max={max} step={1} disabled={busy}
              value={mood?.[field]?.[key] ?? ""} placeholder="使用默认值" onChange={event => {
                const next = event.target.value === "" ? undefined : event.target.valueAsNumber;
                setMood(current => ({ ...current, [field]: { ...current?.[field], [key]: next } }));
              }} />
          </label>))}
        </div>
      </details>
      <details>
        <summary>预览表达规则</summary>
        <label>预览场景<select value={previewScene} onChange={event => setPreviewScene(event.target.value as RoleScene)}>
          {sceneKeys.map(key => <option value={key} key={key}>{roleScenes[key]}</option>)}
        </select></label>
        {preview.length ? <ul>{preview.map(line => <li key={line}>{line}</li>)}</ul> : <p className="meta">沿用角色文字设定。</p>}
      </details>
      <div className="tools">
        <button disabled={busy}>保存人格</button>
        <button type="button" disabled={busy} onClick={() => onSave(null)}>恢复角色默认</button>
      </div>
    </form>
  </details>;
}

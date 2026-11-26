import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Update = { version: string; notes?: string };
const scheduledKey = "desktopUpdateNextStart";

export function DesktopUpdates({ active, chatBusy }: { active: boolean; chatBusy: boolean }) {
  const [waiting, setWaiting] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [scheduled, setScheduled] = useState(() => localStorage.getItem(scheduledKey) ?? "");
  const [status, setStatus] = useState("");

  async function install(version: string) {
    setWaiting(true);
    setStatus("正在下载并校验 Windows 安装包…");
    try { await invoke("install_desktop_update", { expectedVersion: version }); }
    catch (error) { setStatus(String(error)); }
    finally { setWaiting(false); }
  }

  useEffect(() => {
    const version = localStorage.getItem(scheduledKey);
    if (!version) return;
    localStorage.removeItem(scheduledKey);
    setScheduled("");
    void install(version);
  }, []);

  async function check() {
    setWaiting(true);
    setStatus("");
    setUpdate(null);
    try {
      const result = await invoke<Update | null>("check_desktop_update");
      setUpdate(result);
      if (!result) setStatus("已是当前发布版本。");
    } catch (error) { setStatus(String(error)); }
    finally { setWaiting(false); }
  }

  return <div hidden={!active}><section className="card">
    <h3>桌宠应用更新</h3>
    <button type="button" disabled={waiting} onClick={() => void check()}>检查更新</button>
    {update && <>
      <p>可更新至 {update.version}</p>
      {update.notes && <p className="meta">{update.notes}</p>}
      <div className="tools">
        <button type="button" className="primary" disabled={waiting || chatBusy} onClick={() => void install(update.version)}>现在安装</button>
        <button type="button" disabled={waiting} onClick={() => {
          localStorage.setItem(scheduledKey, update.version);
          setScheduled(update.version);
        }}>下次启动安装</button>
      </div>
    </>}
    {scheduled && <p className="meta">下次启动安装 {scheduled} <button type="button" onClick={() => {
      localStorage.removeItem(scheduledKey);
      setScheduled("");
    }}>取消</button></p>}
    {status && <p role="status" className="meta">{status}</p>}
  </section></div>;
}

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

export function openWindowsRecognition(executable: string | undefined) {
  if (!executable || !isAbsolute(executable) || !executable.toLowerCase().endsWith(".exe") || !existsSync(executable)) {
    throw new Error("请配置 OHJINGJING_WINDOWS_TRANSCRIBER 指向已安装的本机转写程序。");
  }
  let active = false;
  return async (audio: Buffer, signal: AbortSignal): Promise<string | null> => {
    signal.throwIfAborted();
    if (active) return null;
    active = true;
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = execFile(executable, [], { windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024, signal }, (error, stdout) => {
          if (error) {
            reject(signal.aborted ? signal.reason : new Error("Windows 本机语音转写失败。"));
            return;
          }
          resolve(stdout);
        });
        child.stdin?.on("error", () => {});
        child.stdin?.end(audio);
      });
    } finally {
      active = false;
    }
  };
}

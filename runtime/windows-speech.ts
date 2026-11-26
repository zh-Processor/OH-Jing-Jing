import { execFile } from "node:child_process";
import { join } from "node:path";

const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$speaker=[System.Speech.Synthesis.SpeechSynthesizer]::new()
$wave=[IO.MemoryStream]::new()
try {
  $available=@($speaker.GetInstalledVoices() | Where-Object Enabled | ForEach-Object VoiceInfo)
  $voice=$available | Where-Object { [string]::Equals($_.Name,$request.voice,[StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
  if (!$voice) {
    $voice=$available | Where-Object { [string]::Equals($_.Culture.Name,$request.voice,[StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
  }
  if (!$voice) { throw 'Selected Windows speech voice is unavailable.' }
  $speaker.SelectVoice($voice.Name)
  $speaker.SetOutputToWaveStream($wave)
  $speaker.Speak([string]$request.text)
  $speaker.SetOutputToNull()
  [Console]::Write([Convert]::ToBase64String($wave.ToArray()))
} finally { $speaker.Dispose(); $wave.Dispose() }
`;
const encoded = Buffer.from(script, "utf16le").toString("base64");

export function synthesizeWindows(text: string, voice: string, signal: AbortSignal, maxBuffer: number) {
  signal.throwIfAborted();
  const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise<string>((resolve, reject) => {
    const worker = execFile(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 8000, maxBuffer, signal }, (error, stdout) => {
        if (error) reject(new Error("Windows 本机语音合成失败。"));
        else resolve(stdout.trim());
      });
    worker.stdin?.on("error", () => {});
    worker.stdin?.end(JSON.stringify({ text, voice }), "utf8");
  });
}

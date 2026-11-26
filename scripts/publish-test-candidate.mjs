import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const settings = process.env.OHJINGJING_TEST_RELEASE_SETTINGS;
const candidate = process.argv[2];
if (process.platform !== "win32" || !settings || !candidate || !isAbsolute(settings) || !isAbsolute(candidate)) {
  throw new Error("测试发布器需要本机 Windows 任务及明确的目标配置。");
}
const script = fileURLToPath(new URL("./publish-test-candidate.ps1", import.meta.url));
const bootstrap = "$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath; " +
  "& ([scriptblock]::Create([IO.File]::ReadAllText($env:OHJINGJING_RELEASE_SCRIPT))) " +
  "-SettingsPath $env:OHJINGJING_TEST_RELEASE_SETTINGS -CandidatePath $env:OHJINGJING_RELEASE_CANDIDATE";
const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64")];
const processHandle = spawn("powershell.exe", args, { windowsHide: true, stdio: "inherit", env: {
  ...process.env, OHJINGJING_RELEASE_SCRIPT: script, OHJINGJING_RELEASE_CANDIDATE: candidate,
} });
const result = await new Promise((resolve, reject) => {
  processHandle.once("error", reject);
  processHandle.once("exit", resolve);
});
process.exitCode = result === 0 ? 0 : 1;

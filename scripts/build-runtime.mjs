import { build } from "esbuild";
import { access, copyFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const runtimeDir = resolve("src-tauri/runtime");
await access(resolve("pi-workspace/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")).catch(() => {
  throw new Error("Install Pi workspace dependencies with npm --prefix pi-workspace ci --ignore-scripts.");
});
const target = process.env.TAURI_ENV_TARGET_TRIPLE ??
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1]?.trim();

if (!target) throw new Error("Could not determine the native target triple.");

const executable = resolve(runtimeDir, `node-${target}${process.platform === "win32" ? ".exe" : ""}`);
const bundledDsh = process.env.OHJINGJING_BUNDLE_DSH === "1";
if (bundledDsh && (process.platform !== "win32" || target !== "x86_64-pc-windows-msvc")) {
  throw new Error("The bundled desktop DSH runtime requires Windows x64.");
}
const node = bundledDsh ? resolve("dsh-runtime/node_modules/node-win-x64/bin/node.exe") : process.execPath;
await mkdir(dirname(executable), { recursive: true });
await copyFile(node, executable);
await copyFile(resolve("scripts/dsh-text-turn.mjs"), resolve(runtimeDir, "dsh-text-turn.mjs"));
await build({
  entryPoints: ["runtime/main.ts"],
  outfile: resolve(runtimeDir, "runtime.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
});

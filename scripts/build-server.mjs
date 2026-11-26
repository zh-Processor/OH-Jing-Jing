import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist-server", { recursive: true });
await build({
  entryPoints: { server: "runtime/server.ts", "service-data": "runtime/service-data.ts", instances: "runtime/instances.ts",
    "qq-ingress": "runtime/qq-ingress-server.ts" },
  outdir: "dist-server",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
});
await copyFile("server.config.example.json", "dist-server/server.config.example.json");
await copyFile("qq-ingress.example.json", "dist-server/qq-ingress.example.json");
await copyFile("instances.example.json", "dist-server/instances.example.json");
await copyFile("scripts/start-test-server.ps1", "dist-server/start-test-server.ps1");
await copyFile("scripts/windows-service-task.ps1", "dist-server/windows-service-task.ps1");
await copyFile("scripts/start-pi-workspace.ps1", "dist-server/start-pi-workspace.ps1");
await copyFile("scripts/dsh-text-turn.mjs", "dist-server/dsh-text-turn.mjs");
await copyFile("node_modules/silk-wasm/lib/silk.wasm", "dist-server/silk.wasm");
await copyFile("node_modules/silk-wasm/LICENSE", "dist-server/silk-wasm-LICENSE.txt");
await mkdir("dist-server/pi-workspace", { recursive: true });
for (const name of ["package.json", "package-lock.json", "LICENSE"]) {
  await copyFile(`pi-workspace/${name}`, `dist-server/pi-workspace/${name}`);
}
await mkdir("dist-server/dsh-runtime", { recursive: true });
for (const name of ["package.json", "package-lock.json"]) {
  await copyFile(`dsh-runtime/${name}`, `dist-server/dsh-runtime/${name}`);
}

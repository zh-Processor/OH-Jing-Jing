import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { DevelopmentTaskClarification, DevelopmentTaskFailure, openDevelopmentDatabase, openDevelopmentTasks,
  processDevelopmentTask } from "../runtime/development-tasks.ts";

function absolute(variable) {
  const value = process.env[variable];
  if (!value || !isAbsolute(value)) throw new Error(`${variable} 需要绝对路径。`);
  return value;
}

const databasePath = absolute("OHJINGJING_DEVELOPMENT_DATABASE");
const dshNode = absolute("OHJINGJING_DSH_NODE");
const publisher = absolute("OHJINGJING_DEVELOPMENT_TEST_PUBLISHER");
const acceptance = process.env.OHJINGJING_DEVELOPMENT_ACCEPTANCE ? absolute("OHJINGJING_DEVELOPMENT_ACCEPTANCE") : null;
const budget = Number(process.env.OHJINGJING_DEVELOPMENT_MINUTES ?? "15");
if (!Number.isInteger(budget) || budget < 1 || budget > 60) throw new Error("开发任务运行时限须为 1 至 60 分钟。");
const target = process.env.OHJINGJING_DEVELOPMENT_TARGET;
if (!target || !/^[\w-]{1,80}$/u.test(target)) throw new Error("请选择开发任务的目标测试实例。");
const repository = fileURLToPath(new URL("..", import.meta.url));
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const db = openDevelopmentDatabase(databasePath);
const queue = openDevelopmentTasks(db);
const isolatedRoot = join(repository, ".work", "development-jobs", target);
const copied = ["runtime", "src", "tests", "roles"];
const fixedDirectories = ["src", "roles", "scripts", ".baseline-tests"];
await mkdir(isolatedRoot, { recursive: true });
const owner = randomUUID();
if (!queue.acquireWorker(target, owner)) {
  db.close();
  throw new Error("目标实例已有开发进程在运行。");
}
const heartbeat = setInterval(() => {
  try { if (!queue.extendWorker(target, owner)) controller.abort(); }
  catch { controller.abort(); }
}, 20_000);
heartbeat.unref();

async function publication(directory, task, candidate, signal) {
  const manifest = join(directory, "release-candidate.json");
  await command("publish", process.execPath, [publisher, manifest], directory, {
    OHJINGJING_TEST_RELEASE_SETTINGS: process.env.OHJINGJING_TEST_RELEASE_SETTINGS,
  }, signal);
  const result = JSON.parse(await readFile(join(directory, "release-result.json"), "utf8"));
  if (!["published", "rolled-back", "failed"].includes(result.state) || typeof result.report !== "string" || result.version !== candidate.version) {
    throw new Error(`发布器未返回与任务 ${task.id} 候选一致的验收结果。`);
  }
  return result;
}

async function preparePublication(directory, candidate) {
  const intent = join(directory, "release-intent.txt");
  const previous = await readFile(intent, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  if (previous === candidate.version) return true;
  if (candidate.checkout !== await contents(repository, copied)) return false;
  await writeFile(intent, candidate.version);
  return true;
}

const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:SystemRoot|windir|ComSpec|Path|PATHEXT|SystemDrive|OS|NUMBER_OF_PROCESSORS)$/iu.test(name)));
if (process.platform === "win32" && process.env.OHJINGJING_DEVELOPMENT_PRESERVE_PATHS === "1") {
  // The isolated Windows account can traverse its local drive alias without opening the host profile directories.
  env.NODE_OPTIONS = "--preserve-symlinks --preserve-symlinks-main";
}
const modelEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(?:OHJINGJING_DSH_SDK_ROOT|OHJINGJING_DEVELOPMENT_MODEL(?:_URL)?|OHJINGJING_DEVELOPMENT_KEY)$/u.test(name)));
const developmentExit = new Map([[65, "no-candidate"], [69, "model-unavailable"], [75, "transient-model"], [77, "model-authorization"]]);
const verificationFailures = new Map([
  ["typecheck", "候选未通过类型检查。"],
  ["baseline-tests", "候选未通过独立回归。"],
  ["candidate-tests", "候选新增或修改的用例失败。"],
  ["feature-acceptance", "候选未达到目标实例的验收条件。"],
]);

class CandidateVerificationFailure extends DevelopmentTaskFailure {
  constructor(stage) {
    super("no-candidate");
    this.stage = stage;
    this.message = `${verificationFailures.get(stage)}请在隔离任务目录查看 ${stage}.log。任务可重试。`;
  }
}

function command(label, executable, args, cwd, extra, signal) {
  signal.throwIfAborted();
  return new Promise((resolveCommand, reject) => {
    const terminateSubtree = process.platform === "win32" && label !== "publish";
    const child = spawn(executable, args, { cwd, env: { ...env, TEMP: join(cwd, ".temp"), TMP: join(cwd, ".temp"), ...extra },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal: terminateSubtree ? undefined : signal });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", chunk => { output = (output + chunk).slice(-80_000); });
    }
    let error;
    const abort = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      error = new Error("开发任务已中止。");
      const system = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
      if (!system) { child.kill(); return; }
      const kill = spawn(join(system, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true });
      kill.once("error", () => child.kill());
      kill.once("exit", status => { if (status !== 0 && child.exitCode === null && child.signalCode === null) child.kill(); });
    };
    if (terminateSubtree) {
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
    child.once("error", value => { error = value; });
    child.once("close", status => {
      signal.removeEventListener("abort", abort);
      const safe = modelEnv.OHJINGJING_DEVELOPMENT_KEY ? output.split(modelEnv.OHJINGJING_DEVELOPMENT_KEY).join("[credential]") : output;
      void writeFile(join(cwd, `${label}.log`), safe).then(() => {
        const reason = label.startsWith("develop") ? developmentExit.get(status) : undefined;
        if (error) reject(error);
        else if (reason) reject(new DevelopmentTaskFailure(reason));
        else if ((status === 1 || status === 2) && verificationFailures.has(label)) reject(new CandidateVerificationFailure(label));
        else if (status !== 0) reject(new Error(`${label} 退出状态 ${status}`));
        else resolveCommand();
      }, reject);
    });
  });
}

async function contents(root, directories) {
  const hash = createHash("sha256");
  async function visit(directory) {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = join(directory, entry.name);
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) hash.update(relative + "\0").update(await readFile(join(root, relative))).update("\0");
      else throw new Error("候选工作区包含不支持的文件类型。");
    }
  }
  for (const directory of directories) await visit(directory);
  return hash.digest("hex");
}

async function findCandidate(task) {
  const paths = (await readdir(isolatedRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith(`${task.id}-`))
    .map(entry => entry.name).sort().reverse();
  for (const path of paths) {
    const directory = join(isolatedRoot, path);
    const location = join(directory, "release-candidate.json");
    const saved = await readFile(location, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!saved) continue;
    const candidate = JSON.parse(saved);
    if (candidate.taskId === task.id && candidate.target === target && candidate.version === task.version &&
        candidate.artifact === join(directory, "candidate.cjs") && typeof candidate.report === "string") return { directory, candidate };
  }
  return undefined;
}

async function verificationDiagnostics(directory, stage) {
  const log = await readFile(join(directory, stage + ".log"), "utf8");
  return log.split(/\r?\n/u)
    .filter(line => /\berror TS\d{4}:|^\s*not ok\b|^\s*(?:failureType|error|code|location):|\bAssertionError\b|^# fail\b/u.test(line))
    .slice(-14).map(line => line.replaceAll(directory, ".")
      .replace(/https?:\/\/[^\s)]+|file:\/\/[^\s)]+|(?:[A-Z]:[\\/])[^\s):]+/giu, "[地址]")
      .replace(/\b(?:sk-|ghp_|github_pat_|Bearer\s+)[\w.-]+/giu, "[凭据]")
      .replace(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/giu, "[邮箱]")
      .replace(/\b\d{7,20}\b/gu, "[号码]").trim().slice(0, 250));
}

let active;
const driver = {
  async develop(task, signal) {
    const directory = join(isolatedRoot, `${task.id}-${Date.now()}`);
    await mkdir(directory);
    await mkdir(join(directory, ".temp"));
    const checkout = await contents(repository, copied);
    const latest = queue.lastPublished(target);
    const previous = latest ? await findCandidate(latest) : undefined;
    if (latest && (!previous || previous.candidate.checkout !== checkout ||
        previous.candidate.sourceHash !== await contents(previous.directory, copied))) {
      throw new DevelopmentTaskFailure("invalid-baseline");
    }
    const source = previous?.directory ?? repository;
    const base = previous?.candidate.sourceHash ?? checkout;
    for (const part of copied) await cp(join(source, part), join(directory, part), { recursive: true, errorOnExist: true });
    await cp(join(repository, "tests"), join(directory, ".baseline-tests"), { recursive: true, errorOnExist: true });
    await mkdir(join(directory, "scripts"));
    for (const name of ["dsh-text-turn.mjs", "model-thinking.mjs", "model-thinking.d.mts"]) {
      await cp(join(repository, "scripts", name), join(directory, "scripts", name));
    }
    await cp(join(repository, "tsconfig.json"), join(directory, "tsconfig.json"));
    if (base !== await contents(directory, copied)) throw new Error("复制期间代码基线已变化。");
    active = { directory, checkout, base, code: await contents(directory, ["runtime"]),
      fixedSources: await contents(directory, fixedDirectories) };
    await writeFile(join(directory, "development-request.json"), JSON.stringify({ ...task, baseline: base }, null, 2));
    const adapter = [join(repository, "scripts", "dsh-candidate.mjs")];
    try {
      await command("develop", dshNode, adapter, directory, modelEnv, signal);
    } catch (error) {
      if (signal.aborted || !(error instanceof DevelopmentTaskFailure) || error.reason !== "transient-model" ||
          base !== await contents(directory, copied) || active.fixedSources !== await contents(directory, fixedDirectories)) throw error;
      await delay(1500, undefined, { signal });
      await command("develop-retry", dshNode, adapter, directory, modelEnv, signal);
    }
    const result = JSON.parse(await readFile(join(directory, "development-result.json"), "utf8"));
    if (typeof result.clarification === "string") {
      if (base !== await contents(directory, copied) || active.fixedSources !== await contents(directory, fixedDirectories)) {
        throw new DevelopmentTaskFailure("no-candidate");
      }
      throw new DevelopmentTaskClarification(result.clarification);
    }
  },
  async verify(task, signal) {
    try { return await verifyCandidate(task, signal); }
    catch (error) {
      if (signal.aborted || !(error instanceof CandidateVerificationFailure)) throw error;
      const { directory, base } = active;
      const before = await contents(directory, copied);
      const diagnostics = await verificationDiagnostics(directory, error.stage);
      await writeFile(join(directory, "development-request.json"), JSON.stringify({ ...task, baseline: base }, null, 2));
      await writeFile(join(directory, "development-repair.json"), JSON.stringify({ stage: error.stage, diagnostics }));
      try {
        await command("develop-repair", dshNode, [join(repository, "scripts", "dsh-candidate.mjs")], directory, modelEnv, signal);
      } catch {
        signal.throwIfAborted();
        throw error;
      }
      if (before === await contents(directory, copied)) throw error;
      return verifyCandidate(task, signal, true);
    }
  },
  async publish(task, candidate, signal) {
    const { directory, checkout } = active;
    if (!await preparePublication(directory, { ...candidate, checkout })) {
      return { state: "failed", report: "原始代码基线已变化，需要重新构建和验收。" };
    }
    return publication(directory, task, candidate, signal);
  },
};

async function verifyCandidate(task, signal, repaired = false) {
  const { directory, code, fixedSources } = active;
  if (code === await contents(directory, ["runtime"])) throw new DevelopmentTaskFailure("unchanged-candidate");
  if (fixedSources !== await contents(directory, fixedDirectories)) throw new Error("候选修改了服务任务范围之外的文件。");
  const typecheck = join(repository, "node_modules", "typescript", "bin", "tsc");
  const importer = pathToFileURL(join(repository, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const tests = (await readdir(join(directory, ".baseline-tests"))).filter(name => name.endsWith(".test.ts"))
    .map(name => join(directory, ".baseline-tests", name));
  const candidateTests = [];
  for (const name of (await readdir(join(directory, "tests"))).filter(name => name.endsWith(".test.ts"))) {
    const file = join(directory, "tests", name);
    const baseline = await readFile(join(directory, ".baseline-tests", name)).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!baseline || !baseline.equals(await readFile(file))) candidateTests.push(file);
  }
  const configuration = await readFile(join(repository, "tsconfig.json"));
  const sameConfiguration = async () => configuration.equals(await readFile(join(directory, "tsconfig.json")));
  if (!await sameConfiguration()) {
    throw new Error("候选修改了验收配置。");
  }
  const sourceHash = await contents(directory, copied);
  try {
    await command("typecheck", process.execPath, [typecheck, "--noEmit"], directory, {}, signal);
    await command("baseline-tests", process.execPath, ["--import", importer, "--test", ...tests], directory, {}, signal);
    if (candidateTests.length) await command("candidate-tests", process.execPath, ["--import", importer, "--test", ...candidateTests], directory, {}, signal);
    if (acceptance) await command("feature-acceptance", process.execPath, ["--import", importer, acceptance, directory], directory, {}, signal);
    signal.throwIfAborted();
  } finally {
    if (sourceHash !== await contents(directory, copied) || fixedSources !== await contents(directory, fixedDirectories) || !await sameConfiguration()) {
      throw new Error("验收期间候选源码或独立用例发生变化。");
    }
  }
  const artifact = join(directory, "candidate.cjs");
  await build({ entryPoints: [join(directory, "runtime", "server.ts")], outfile: artifact, bundle: true,
    format: "cjs", platform: "node", target: "node22", logLevel: "silent" });
  const version = createHash("sha256").update(await readFile(artifact)).digest("hex");
  const result = JSON.parse(await readFile(join(directory, "development-result.json"), "utf8"));
  const candidate = { version, artifact, report: `${repaired ? "已修复一轮候选并重新验收。" : ""}类型检查和 ${tests.length} 个验收文件通过。${typeof result.summary === "string" ? result.summary : ""}` };
  await writeFile(join(directory, "release-candidate.json"), JSON.stringify({ taskId: task.id, target, baseline: active.base,
    checkout: active.checkout, sourceHash, ...candidate }, null, 2));
  return candidate;
}

async function resumePublish(task, signal) {
  const saved = await findCandidate(task);
  if (saved) {
    const { directory, candidate } = saved;
    try {
      if (candidate.checkout && !await preparePublication(directory, candidate)) {
        queue.transition(target, task.id, "publishing", "failed", "原始代码基线已变化，需要重新构建和验收。");
        return;
      }
      const restored = await publication(directory, task, candidate, signal);
      queue.transition(target, task.id, "publishing", restored.state, `${candidate.report}\n${restored.report}`.slice(0, 3000));
    } catch {
      if (!signal.aborted) process.stderr.write(`${task.id} 发布结果待恢复，见任务目录中的 publish.log。\n`);
    }
    return;
  }
  queue.transition(target, task.id, "publishing", "failed", "未找到完整的候选发布记录。");
}

try {
  queue.requeueBeforePublish(target);
  do {
    for (const task of queue.publishing(target)) {
      await resumePublish(task, AbortSignal.any([controller.signal, AbortSignal.timeout(210_000)]));
    }
    const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(budget * 60_000)]);
    const settled = await processDevelopmentTask(queue, target, driver, deadline);
    if (settled) process.stdout.write(`${settled.id} ${settled.state}\n`);
    if (process.argv.includes("--once")) break;
    if (!settled || settled.state === "publishing") await delay(2500, undefined, { signal: controller.signal });
  } while (!controller.signal.aborted);
} catch (error) {
  if (!controller.signal.aborted) throw error;
} finally {
  clearInterval(heartbeat);
  queue.releaseWorker(target, owner);
  db.close();
}

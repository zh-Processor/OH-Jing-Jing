import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

if (process.platform !== "win32" || !process.argv[2]) {
  throw new Error("Run on Windows: node scripts/test-windows-desktop-app.mjs <NSIS installer> [7z.exe] [--role-rehearsal] [--member-profiles] [--service-profiles] [--workspace-conversations] [--development-controls] [--development-acceptance] [--channel-coverage] [--balance-fixture] [--model-removal] [--packy-key-stdin] [--live-subscription-stdin] [--fresh-install | --fresh-webview2] [--previous-installer <NSIS installer>] [--signed-update <release directory>]");
}
const [, , , ...options] = process.argv;
const previousOption = options.indexOf("--previous-installer");
const updateOption = options.indexOf("--signed-update");
const freshWebView2Mode = options.includes("--fresh-webview2");
const freshInstallMode = freshWebView2Mode || options.includes("--fresh-install");
const liveMode = options.includes("--live-subscription-stdin");
const coverageMode = options.includes("--channel-coverage");
const balanceMode = options.includes("--balance-fixture");
const removalMode = options.includes("--model-removal");
const workspaceConversationMode = options.includes("--workspace-conversations");
const developmentControlsMode = options.includes("--development-controls");
const developmentAcceptanceMode = options.includes("--development-acceptance");
if (developmentAcceptanceMode && !options.includes("--service-profiles")) throw new Error("Use --service-profiles with --development-acceptance.");
const busyUpdate = process.env.OHJINGJING_TEST_BUSY_UPDATE === "1";
const verifyHarnessLayout = process.env.OHJINGJING_TEST_VERIFY_HARNESS_LAYOUT === "1";
if (previousOption !== -1 && (!options[previousOption + 1] || options.includes("--packy-key-stdin"))) {
  throw new Error("Provide a previous installer path. The installation lifecycle uses its own loopback model fixture.");
}
if (updateOption !== -1 && (!options[updateOption + 1] || options[updateOption + 1].startsWith("--"))) {
  throw new Error("The signed update check expects its own test release directory.");
}
if (freshInstallMode && (previousOption !== -1 || updateOption !== -1 || liveMode)) {
  throw new Error("The fresh install check uses a standalone installer and a clean profile.");
}
if (liveMode && options.some(option => option.startsWith("--") && option !== "--live-subscription-stdin")) {
  throw new Error("The live subscription check runs in its own profile with a loopback model fixture.");
}
let live = null;
if (liveMode) {
  try { live = JSON.parse(readFileSync(0, "utf8")); }
  catch { throw new Error("Expected a JSON test configuration on stdin."); }
  if (typeof live?.token !== "string" || live.token.length < 24 ||
      !/^qq:\d{4,20}:\d{4,20}$/u.test(live.scope) || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(live.address)) {
    throw new Error("Provide the temporary subscription token, authorized group scope, and loopback service address on stdin.");
  }
  if (live.waitForNewSummaryMs !== undefined &&
      (!Number.isSafeInteger(live.waitForNewSummaryMs) || live.waitForNewSummaryMs < 30_000 || live.waitForNewSummaryMs > 300_000)) {
    throw new Error("The live summary observation interval must be between 30 and 300 seconds.");
  }
  if (live.roleRevision !== undefined && (live.waitForNewSummaryMs !== undefined || !/^[a-f0-9]{64}$/u.test(live.roleRevision))) {
    throw new Error("The live group-role check requires a published role revision and runs separately from reminder observation.");
  }
  if (live.verifyWorkspace && (live.waitForNewSummaryMs || live.roleRevision || live.verifyChannelCoverage)) {
    throw new Error("The live workspace check runs separately from the single-source checks.");
  }
}
const previousInstaller = previousOption === -1 ? null : resolve(options[previousOption + 1]);
const updateDirectory = updateOption === -1 ? null : resolve(options[updateOption + 1]);
const work = fileURLToPath(new URL("../.work/", import.meta.url));
const dataRoot = resolve(process.env.OHJINGJING_TEST_DESKTOP_DATA_ROOT ?? join(work, "desktop-app-tests"));
await mkdir(dataRoot, { recursive: true });
const scratch = await mkdtemp(join(dataRoot, "gui-"));
const profile = join(scratch, "profile");
const bundle = join(scratch, previousInstaller || freshInstallMode ? "OHJingJing Installed" : "bundle");
const installer = resolve(process.argv[2]);
const sevenZip = options.find((option, i) => !["--fresh-install", "--fresh-webview2", "--packy-key-stdin", "--live-subscription-stdin", "--role-rehearsal", "--member-profiles", "--service-profiles", "--workspace-conversations", "--development-controls", "--development-acceptance", "--channel-coverage", "--balance-fixture", "--model-removal"].includes(option) &&
  (previousOption === -1 || (i !== previousOption && i !== previousOption + 1)) &&
  (updateOption === -1 || (i !== updateOption && i !== updateOption + 1))) ?? join(process.env.ProgramFiles, "7-Zip", "7z.exe");
const packyKey = options.includes("--packy-key-stdin") ? readFileSync(0, "utf8").trim() : "";
const env = { ...process.env, TEMP: scratch, TMP: scratch, OHJINGJING_DATA_DIR: profile };
const model = { id: "gui-" + randomUUID(), name: "窗口联调模型", model: "gui-fixture", billing: "none", hasKey: true };
const token = randomUUID();
const balanceModel = { ...model, id: model.id + "-balance", name: "本机额度联调模型", billing: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1" };
const balanceKey = randomUUID();
const rotatedBalanceKey = randomUUID();
let balanceFailure = false;
let balanceQueries = 0;
const backupModel = { ...model, id: "backup-" + randomUUID(), name: "窗口联调备用模型", model: "gui-backup" };
const backupToken = randomUUID();
const subscriptionToken = randomUUID();
const alternativeToken = randomUUID();
const summaryGroup = "qq:1001:5001";
const alternativeSummary = "第二台服务的授权群摘要。";
let alternateWorkspaceSummary;
let alternateWorkspaceRevoked = false;
let holdUpdaterSync = false;
let updaterSyncPending = false;
let alternativeAddress;
let alternativeReads = 0;
let alternativeWrongToken = false;
const developmentPath = "/api/workspace/development/tasks";
const developmentActions = developmentPath + "/actions";
const firstDevelopment = { target: "primary-fixture", items: [{ id: randomUUID(), target: "primary-fixture", requirement: "主来源原有任务", state: "testing" }] };
const secondDevelopment = { target: "secondary-fixture", acceptanceInput: developmentAcceptanceMode,
  items: [{ id: randomUUID(), target: "secondary-fixture", requirement: "第二来源原有任务", state: "published" }] };
const acted = [];
if (developmentControlsMode) {
  Object.assign(firstDevelopment.items[0], { updatedAt: new Date().toISOString(), availableAction: "cancel" });
  Object.assign(secondDevelopment.items[0], { updatedAt: new Date().toISOString(), state: "rolled-back", availableAction: "retry" });
}

async function controlDevelopmentTask(req, res, development) {
  if (!developmentControlsMode || req.method !== "POST") return res.writeHead(405).end("{}");
  const chunks = [];
  for await (const part of req) chunks.push(part);
  const body = JSON.parse(Buffer.concat(chunks));
  const task = development.items.find(item => item.id === body.taskId);
  if (!task || development.target !== body.target || task.state !== body.state || task.updatedAt !== body.updatedAt ||
      task.availableAction !== body.action) return res.writeHead(409).end("{}");
  acted.push({ target: development.target, action: body.action, id: task.id });
  Object.assign(task, body.action === "cancel" ? { state: "cancelled", availableAction: null }
    : { state: "queued", availableAction: "cancel" });
  return res.end(JSON.stringify({ task }));
}
const desktopRequirement = "从桌宠提交第二实例的联调任务";
const desktopAcceptance = "用法返回帮助，原命令继续显示话题。";
const workspaceFeature = "group-week-topics";
let workspaceFeaturePublished = true;
const workspaceFeatureReads = [];
let alternativeTasksAvailable = true;
const olderSummary = { id: 1, content: "上一份本机联调摘要。", created_at: "2026-01-01T08:00:00Z" };
const initialSummary = { id: 2, content: "重启前的本机联调摘要。", created_at: "2026-01-01T09:00:00Z" };
const topicTitle = "周末解谜约局";
const topicUpdate = "约局已改为周日晚上八点。";
const groupExplanation = "群友把周末解谜约到了周日晚上八点。";
const secondGroupSummary = "另一个群在约周六排练。";
const secondGroup = "qq:1001:5002";
const observedCoverage = { onlineMs: 85_710_000, unavailableMs: 90_000, disabledMs: 0, unobservedMs: 600_000,
  gaps: [{ state: "unavailable", start: "2026-01-01T09:00:00Z", end: "2026-01-01T09:01:30Z" }] };
const primaryPortrait = { id: "a".repeat(64), displayName: "联调群友小林", summary: "在群里分享合作解谜心得。",
  updatedAt: "2026-01-01T09:30:00Z", revision: "fixture-member-revision" };
const neighborPortrait = { id: "b".repeat(64), displayName: "联调群友小齐", summary: "另一位群友的已发布简介。" };
const memberExplanation = "这位群友在群里分享过合作解谜心得。";
let portraits = [primaryPortrait, neighborPortrait];
let memberReads = 0;
const returnedSummary = { id: 3, content: "桌宠关闭期间新生成的摘要。", created_at: "2026-01-01T10:00:00Z", topics: [{
  title: topicTitle, content: "群内确认了约局时间的变更。", from: "2026-01-01T09:01:00Z", to: "2026-01-01T09:58:00Z",
  coverage: "complete", facts: [{ kind: "change", text: topicUpdate, at: "2026-01-01T09:58:00Z" }],
}] };
let summaries = [initialSummary, olderSummary];
let summaryAccessRevoked = false;
let subscriptionRevoked = false;
let holdNextGroupFeed = false;
let heldGroupFeed;
let showSecondGroup = false;
const sharedMemory = { id: randomUUID(), version: 4, text: "用于下载的模拟服务端记忆。" };
const reply = "这是来自本机窗口联调的回复。";
const question = "桌宠窗口直接对话测试";
const cancelFromMain = "从主窗口停止这条悬浮窗消息";
const cancelFromPet = "从悬浮窗停止这条主窗口消息";
const closeAndContinue = "关闭悬浮窗后继续这一轮";
const interruptedQuestion = "退出应用时仍在生成的草稿";
const resumedReply = "这一轮在悬浮窗关闭后也已完成。";
const failoverQuestion = "悬浮窗触发备用模型测试";
const stopDuringBackup = "从悬浮窗停止备用模型";
const backupReply = "这轮由备用档案接着回答。";
const held = new Map();
const aborted = new Set();
const sockets = [];
const calls = [];
let app;
let appDiagnostics = "";
let debugPort;
let installation;
let updateInstallPending = false;
const registeredCredentials = [];
const workspaceCursors = [];
const alternativeService = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.headers.authorization !== `Bearer ${alternativeToken}`) {
    alternativeWrongToken = true;
    res.writeHead(401).end("{}");
    return;
  }
  if (alternateWorkspaceRevoked) { res.writeHead(401).end("{}"); return; }
  alternativeReads++;
  if (req.url === developmentActions) return controlDevelopmentTask(req, res, secondDevelopment);
  if (req.url === developmentPath) {
    if (!alternativeTasksAvailable) res.writeHead(503).end("{}");
    else if (req.method === "GET") res.end(JSON.stringify(secondDevelopment));
    else if (req.method === "POST") {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.target, secondDevelopment.target);
      assert.equal(body.requirement, desktopRequirement);
      if (developmentAcceptanceMode) assert.equal(body.acceptance, desktopAcceptance);
      assert.match(body.requestId, /^[\da-f-]{36}$/u);
      const task = { id: randomUUID(), target: body.target, requirement: body.requirement, acceptance: body.acceptance, state: "queued" };
      secondDevelopment.items.unshift(task);
      res.writeHead(202).end(JSON.stringify({ task }));
    } else res.writeHead(405).end("{}");
  } else if (req.url === "/api/me") {
    res.end(JSON.stringify({ profile: null, account: { qqId: "2002", memoryRead: false, memoryWrite: false } }));
  } else if (req.url === "/api/groups") {
    const summary = alternateWorkspaceSummary ?? { id: 1, content: alternativeSummary, created_at: "2026-01-01T09:00:00Z" };
    const profile = workspaceConversationMode ? { displayName: "联调群", summary: "第二来源的群画像" } : { displayName: "第二台联调群", summary: "" };
    res.end(JSON.stringify({ groups: [{ id: summaryGroup, messageCount: 3, lastActive: summary.created_at,
      profile, summary, summaries: [summary] }], gatewayStatus: "online" }));
  } else if (workspaceConversationMode && req.url === `/api/groups/${summaryGroup}/members`) {
    res.end(JSON.stringify({ items: [{ ...primaryPortrait, summary: "第二来源发布的同名群友画像", privateMemory: "服务内部字段" }] }));
  } else res.writeHead(404).end("{}");
});
const provider = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === developmentActions) {
    if (subscriptionRevoked || req.headers.authorization !== `Bearer ${subscriptionToken}`) return res.writeHead(401).end("{}");
    return controlDevelopmentTask(req, res, firstDevelopment);
  }
  if (req.url === developmentPath) {
    if (subscriptionRevoked || req.headers.authorization !== `Bearer ${subscriptionToken}`) res.writeHead(401).end("{}");
    else if (req.method === "GET") res.end(JSON.stringify(firstDevelopment));
    else res.writeHead(405).end("{}");
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/api/workspace/feed")) {
    if (subscriptionRevoked || req.headers.authorization !== `Bearer ${subscriptionToken}`) {
      res.writeHead(401).end("{}");
      return;
    }
    if (holdUpdaterSync) {
      updaterSyncPending = true;
      res.once("close", () => { updaterSyncPending = false; });
      return;
    }
    workspaceCursors.push(new URL(req.url, "http://127.0.0.1").searchParams.get("cursor"));
    const conversations = summaryAccessRevoked ? [] : [{ id: summaryGroup, label: "联调群", messageAccess: false }];
    const items = conversations.length ? summaries.map(summary => ({ id: summary.id, conversationId: summaryGroup,
      kind: "summary", at: summary.created_at, summary })) : [];
    const features = workspaceFeaturePublished && conversations.length ? [
      { id: workspaceFeature, title: "本周话题", conversationIds: [summaryGroup], minimumClientVersion: "0.1.22", view: "list" },
      { id: "fixture-future", title: "未来会话功能", conversationIds: [summaryGroup], minimumClientVersion: "0.9.0", view: "list" },
    ] : [];
    res.end(JSON.stringify({ platform: "qq", conversations, items, reset: true, hasMore: false,
      cursor: "gui-fixture-workspace", retainedAfter: "2026-01-01T00:00:00Z", features,
      featureRevision: features.length ? "catalog-published" : "catalog-rolled-back" }));
    return;
  }
  if (req.method === "GET" && req.url?.startsWith(`/api/workspace/features/${workspaceFeature}?`)) {
    const scope = new URL(req.url, "http://127.0.0.1").searchParams.get("conversation");
    const status = subscriptionRevoked || req.headers.authorization !== `Bearer ${subscriptionToken}` ? 401
      : !workspaceFeaturePublished || summaryAccessRevoked || scope !== summaryGroup ? 404 : 200;
    workspaceFeatureReads.push({ status, expectedScope: scope === summaryGroup });
    res.writeHead(status).end(status === 200 ? JSON.stringify({ items: [{ title: "当前群的合成话题", text: "用于核验更新后的服务功能。" }] }) : "{}");
    return;
  }
  if (balanceMode && req.url === "/fixture/key-quota") {
    balanceQueries++;
    const auth = req.headers.authorization;
    assert.ok(auth === "Bearer " + balanceKey || auth === "Bearer " + rotatedBalanceKey);
    if (balanceFailure) res.writeHead(503).end("{}");
    else res.end(JSON.stringify({ data: { limit: 50, limit_remaining: auth.endsWith(balanceKey) ? 18 : 27, usage: 13 } }));
    return;
  }
  if (req.url === "/api/groups" || req.url === "/api/me") {
    if (subscriptionRevoked || req.headers.authorization !== `Bearer ${subscriptionToken}`) {
      res.writeHead(401).end(JSON.stringify({ error: "Invalid test subscription" }));
      return;
    }
    const response = JSON.stringify(req.url === "/api/groups" ? {
      groups: summaryAccessRevoked ? [] : [{ id: summaryGroup, messageCount: 4,
        lastActive: summaries[0].created_at, profile: { displayName: "联调群", summary: "合成群数据" },
        summary: summaries[0], summaries }, ...(showSecondGroup ? [{ id: secondGroup, messageCount: 1,
          lastActive: returnedSummary.created_at, profile: { displayName: "另一个群", summary: "第二份合成群数据" },
          summary: { id: 1, content: secondGroupSummary, created_at: returnedSummary.created_at }, summaries: [],
        }] : [])],
      gatewayStatus: "online", channelPlugin: {
        id: "qq.gui-fixture", name: "联调 QQ 渠道", platform: "qq", apiVersion: 1,
        capabilities: ["groupText", "groupExpressions"], status: "online", configured: true, enabled: true,
      }, channelCoverage: coverageMode ? observedCoverage : undefined,
    } : { profile: null, account: { qqId: "2001", memoryRead: true, memoryWrite: true } });
    if (req.url === "/api/groups" && holdNextGroupFeed) {
      holdNextGroupFeed = false;
      res.flushHeaders();
      heldGroupFeed = { res, response };
      return;
    }
    res.end(response);
    return;
  }
  if (req.url === "/api/private-memory/gui.fixture" && req.method === "GET") {
    if (req.headers.authorization !== `Bearer ${subscriptionToken}`) {
      res.writeHead(401).end(JSON.stringify({ error: "Invalid test subscription" }));
    } else {
      res.end(JSON.stringify({ items: [sharedMemory] }));
    }
    return;
  }
  if (req.url?.startsWith(`/api/groups/${summaryGroup}/members`) || req.url?.startsWith(`/api/groups/${secondGroup}/members`)) {
    if (subscriptionRevoked || req.headers.authorization !== `Bearer ${subscriptionToken}`) {
      res.writeHead(401).end(JSON.stringify({ error: "Invalid test subscription" }));
    } else if (summaryAccessRevoked || req.url.startsWith(`/api/groups/${secondGroup}/members`)) {
      res.writeHead(404).end("{}");
    } else {
      memberReads++;
      res.end(JSON.stringify(req.url.endsWith("/2002") ? {
        profile: portraits.find(item => item.id === primaryPortrait.id) ?? null,
      } : { items: portraits }));
    }
    return;
  }
  const parts = [];
  for await (const part of req) parts.push(part);
  const body = JSON.parse(Buffer.concat(parts));
  const viaBackup = req.url === "/backup/chat/completions";
  calls.push({ authorized: req.headers.authorization === `Bearer ${viaBackup ? backupToken : token}`, viaBackup, body });
  const prompt = body.messages.at(-1)?.content;
  if (prompt?.startsWith("用两句话给我讲讲这个群刚才在聊什么。")) {
    finishReply(res, groupExplanation);
    return;
  }
  if (prompt?.startsWith("分别用简短的中文说明各个来源最近聊了什么。")) {
    finishReply(res, "两个来源都有已发布的群聊摘要。");
    return;
  }
  if (prompt?.startsWith("用一句话介绍这位群友。")) {
    finishReply(res, memberExplanation);
    return;
  }
  if (body.messages[0]?.content.startsWith("为当前用户提取长期个人记忆候选")) {
    const sample = JSON.parse(prompt);
    const source = sample.find(item => item.text === question);
    finishReply(res, JSON.stringify({ items: source ? [{ line: source.line, quote: source.text,
      text: "本机候选的界面测试记录。", kind: "other" }] : [] }));
    return;
  }
  if (!viaBackup && [failoverQuestion, stopDuringBackup].includes(prompt)) { res.writeHead(429).end(); return; }
  if (viaBackup && prompt === failoverQuestion) { finishReply(res, backupReply); return; }
  if ([cancelFromMain, cancelFromPet, closeAndContinue, interruptedQuestion, stopDuringBackup].includes(prompt)) {
    held.set(prompt, res);
    res.once("close", () => { if (!res.writableEnded) aborted.add(prompt); });
    return;
  }
  finishReply(res, reply);
});

function finishReply(res, content) {
  res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
}

function run(program, args, input, timeout = 20_000) {
  const result = spawnSync(program, args, { cwd: scratch, env, input, encoding: "utf8", windowsHide: true, timeout });
  assert.equal(result.status, 0, result.error?.message || result.stderr || `${program} failed`);
  return result.stdout;
}

function sessionCredential(target, secret, readPersistence = false) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class TestCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Record {
        public uint Flags, Type;
        public string TargetName, Comment;
        public long LastWritten;
        public uint BlobSize;
        public IntPtr Blob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CredWrite(ref Record entry, uint flags);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CredRead(string target, uint type, uint flags, out IntPtr entry);
    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr entry);
    public static void Save(string target, string secret) {
        var blob = Marshal.StringToHGlobalUni(secret);
        try {
            var entry = new Record {
                TargetName = target, UserName = "OHJingJing GUI test", Type = 1,
                Blob = blob, BlobSize = (uint)secret.Length * 2,
                Persist = 1 // CRED_PERSIST_SESSION
            };
            if (!CredWrite(ref entry, 0)) throw new Win32Exception();
        } finally { Marshal.ZeroFreeGlobalAllocUnicode(blob); }
    }
    public static void Delete(string target) {
        if (!CredDelete(target, 1, 0) && Marshal.GetLastWin32Error() != 1168) throw new Win32Exception();
    }
    public static uint Persistence(string target) {
        IntPtr entry;
        if (!CredRead(target, 1, 0, out entry)) {
            var error = Marshal.GetLastWin32Error();
            if (error == 1168) return 0;
            throw new Win32Exception(error);
        }
        try { return Marshal.PtrToStructure<Record>(entry).Persist; }
        finally { CredFree(entry); }
    }
}
'@
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($data.readPersistence) { [TestCredential]::Persistence($data.target) }
elseif ($data.secret) { [TestCredential]::Save($data.target, $data.secret) }
else { [TestCredential]::Delete($data.target) }
`;
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    JSON.stringify({ target, secret, readPersistence })).trim();
}

function seedModel(profileModel, key) {
  const output = run(join(bundle, "node.exe"), [join(bundle, "runtime.mjs"), profile],
    JSON.stringify({ action: "saveModel", args: profileModel }) + "\n");
  assert.equal(JSON.parse(output).ok, true);
  const target = `model:${profileModel.id}.OHJingJing`;
  sessionCredential(target, key);
  registeredCredentials.push(target);
}

function seedSubscription(address) {
  const slot = "service:" + randomUUID();
  const output = run(join(bundle, "node.exe"), [join(bundle, "runtime.mjs"), profile], JSON.stringify({
    action: "saveService", args: { address }, change: { expected: { origin: null, slot: null }, replacement: slot },
  }) + "\n");
  assert.equal(JSON.parse(output).ok, true);
  const target = slot + ".OHJingJing";
  sessionCredential(target, subscriptionToken);
  registeredCredentials.push(target);
}

function saveThroughDialog(file, suggested) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$probe = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RoleExportDialog {
    private const uint GetText = 0x000D;
    private const uint SetText = 0x000C;
    private const uint Command = 0x0111;
    private const uint AbortIfHung = 2;
    private const int SaveButtonId = 1;
    private delegate bool WindowCallback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(
        IntPtr window, uint message, IntPtr value, StringBuilder text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(
        IntPtr window, uint message, IntPtr value, string text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr value, IntPtr data);

    public static bool Save(uint pid, string title, string suggested, string path) {
        var dialog = IntPtr.Zero;
        var text = new StringBuilder(512);
        EnumWindows((window, _) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != pid) return true;
            GetWindowText(window, text, text.Capacity);
            if (text.ToString() != title) return true;
            GetClassName(window, text, text.Capacity);
            if (text.ToString() != "#32770") return true;
            dialog = window;
            return false;
        }, IntPtr.Zero);
        if (dialog == IntPtr.Zero) return false;

        var save = GetDlgItem(dialog, SaveButtonId);
        if (save == IntPtr.Zero) return false;
        var input = IntPtr.Zero;
        var withoutExtension = System.IO.Path.GetFileNameWithoutExtension(suggested);
        EnumChildWindows(dialog, (window, _) => {
            GetClassName(window, text, text.Capacity);
            if (text.ToString() != "Edit") return true;
            IntPtr result;
            if (SendMessageTimeout(window, GetText, new IntPtr(text.Capacity), text, AbortIfHung, 500, out result) == IntPtr.Zero)
                return true;
            var value = text.ToString();
            if (value != suggested && value != withoutExtension) return true;
            input = window;
            return false;
        }, IntPtr.Zero);
        if (input == IntPtr.Zero) return false;
        IntPtr written;
        return SendMessageTimeout(input, SetText, IntPtr.Zero, path, AbortIfHung, 500, out written) != IntPtr.Zero &&
            written != IntPtr.Zero && PostMessage(dialog, Command, new IntPtr(SaveButtonId), save);
    }
}
'@
$end = (Get-Date).AddSeconds(10)
do {
  if ([RoleExportDialog]::Save([uint32]$probe.pid, '导出角色 JSON', $probe.suggested, $probe.file)) { exit 0 }
  Start-Sleep -Milliseconds 100
} until ((Get-Date) -ge $end)
throw 'The packaged application did not expose the native role export file name and Save controls.'
`;
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    JSON.stringify({ pid: app.pid, file, suggested }));
}

async function until(label, check, durationMs = 12_000, pollMs = 90) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(pollMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function listenerPort(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function launchApp() {
  if (!debugPort) {
    const probe = createServer();
    debugPort = await listenerPort(probe);
    await new Promise(resolve => probe.close(resolve));
  }
  appDiagnostics = "";
  app = spawn(join(bundle, "ohjingjing.exe"), [], {
    cwd: bundle, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debugPort}` },
  });
  app.stderr.setEncoding("utf8").on("data", data => { appDiagnostics = (appDiagnostics + data).slice(-2400); });
  app.stdout.resume();
  await once(app, "spawn");
  return debugPort;
}

async function closeApp(main) {
  const closed = once(app, "exit");
  await main.evaluate(`(function () {
    setTimeout(() => void window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }), 200);
    return true;
  })()`);
  const [code] = await Promise.race([closed, delay(4000, [-1], { ref: false })]);
  assert.equal(code, 0, "Desktop must exit after closing its last window");
  await waitForWebViewShutdown(debugPort);
}

async function waitForWebViewShutdown(port) {
  await until("the previous WebView debug endpoint to stop", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(400) }).catch(() => null);
    return !response;
  }, 20_000);
}

async function showFullscreenFixture() {
  const scriptPath = join(scratch, "fullscreen-probe.ps1");
  const stopPath = join(scratch, "stop-fullscreen-probe-" + randomUUID());
  await writeFile(scriptPath, String.raw`param([string]$StopFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object Windows.Forms.Form
$form.Text = 'OHJingJing fullscreen test'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
$form.BackColor = [Drawing.Color]::DarkSlateBlue
$form.TopMost = $true
$form.ShowInTaskbar = $false
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 150
$deadline = (Get-Date).AddSeconds(19)
$timer.add_Tick({
  if ((Get-Date) -ge $deadline -or (Test-Path -LiteralPath $StopFile)) { $form.Close() }
})
$form.add_Shown({ $form.Activate(); $timer.Start() })
[Windows.Forms.Application]::Run($form)
$timer.Dispose()
$form.Dispose()
`);
  const probe = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-STA", "-File", scriptPath, "-StopFile", stopPath], { cwd: scratch, env, windowsHide: true, stdio: "ignore" });
  const closed = once(probe, "exit");
  await once(probe, "spawn");
  return async () => {
    if (probe.exitCode !== null) return;
    await writeFile(stopPath, "");
    const [code] = await Promise.race([closed, delay(3000, [-1], { ref: false })]);
    if (code === -1) probe.kill();
    await closed;
    assert.equal(code, 0, "The fullscreen test fixture should close cleanly.");
  };
}

async function openPage(port, isPet) {
  const target = await until(isPet ? "floating pet WebView" : "main WebView", async () => {
    if (app.exitCode !== null) throw new Error(`Desktop exited with code ${app.exitCode}${appDiagnostics ? `\n${appDiagnostics}` : ""}`);
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(400) }).catch(() => null);
    if (!response?.ok) return;
    return (await response.json()).find(item =>
      item.type === "page" && /^(?:http:\/\/tauri\.localhost|tauri:\/\/localhost)\//u.test(item.url) &&
      (new URL(item.url).searchParams.get("pet") === "1") === isPet);
  });
  const debugUrl = new URL(target.webSocketDebuggerUrl);
  assert.equal(debugUrl.hostname, "127.0.0.1");
  const socket = new WebSocket(debugUrl, { handshakeTimeout: 2500 });
  sockets.push(socket);
  await once(socket, "open");
  let sequence = 0;
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { socket.off("message", receive); reject(new Error("WebView evaluation timed out")); }, 2500);
    function receive(raw) {
      const frame = JSON.parse(raw);
      if (frame.id !== id) return;
      clearTimeout(timer);
      socket.off("message", receive);
      if (frame.error || frame.result.exceptionDetails) {
        reject(new Error(frame.error?.message || frame.result.exceptionDetails.exception?.description || "WebView evaluation failed"));
        return;
      }
      resolve(frame.result.result.value);
    }
    socket.on("message", receive);
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  return {
    evaluate,
    closed: () => until("closed WebView", () => socket.readyState === WebSocket.CLOSED),
    text: (text, selector = "body") => until(text, () => evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(text)})`)),
    async click(text) {
      await until(`enabled control ${text}`, () => evaluate(`(() => {
        const target = [...document.querySelectorAll("button,summary")].find(el => el.textContent.trim() === ${JSON.stringify(text)});
        if (!target || target.disabled) return false;
        target.click();
        return true;
      })()`));
    },
    async fill(selector, value) {
      await until(`editable field ${selector}`, () => evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input || input.disabled || input.readOnly) return false;
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value").set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`));
    },
  };
}

function runInstallerProbe(action, ...args) {
  const script = fileURLToPath(new URL("./windows-install-probe.ps1", import.meta.url));
  const fileOperation = ["install", "uninstall", "cleanup"].includes(action);
  const largePackage = verifyHarnessLayout || freshWebView2Mode || freshInstallMode && packyKey;
  const timeout = fileOperation && largePackage ? 300_000 : action === "install" ? 180_000 : 55_000;
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-Action", action, "-InstallDirectory", bundle, ...args], undefined, timeout).trim();
}

function nativeAction(page, action, args = {}, secret) {
  const request = JSON.stringify({ action, args, ...(secret ? { secret } : {}) });
  return page.evaluate(`window.__TAURI_INTERNALS__.invoke("run_action", ${request})`);
}

async function verifyInstalledHarnessLayout() {
  const sdk = join(bundle, "dsh-sdk");
  const relative = "@deepseek-ai/dsh-experimental-inspector/lib/devtools/models/issues_manager/descriptions/" +
    "selectElementAccessibilityInteractiveContentAttributesSelectDescendant.md";
  const installed = join(sdk, "node_modules", relative);
  assert.ok(installed.length > 260, "Use an install directory that exercises a Windows long path");
  const original = fileURLToPath(new URL("../dsh-runtime/node_modules/" + relative, import.meta.url));
  const [copy, source] = await Promise.all([readFile(installed), readFile(original)]);
  assert.deepEqual(copy, source);
  assert.ok((await readdir(sdk)).includes(".ohjingjing-managed"));
  console.log(`The installed runtime includes the original ${installed.length}-character dependency path.`);
}

async function verifyFreshInstall() {
  const baseline = freshWebView2Mode ? ["-RequireCleanWebView2"] : [];
  installation = JSON.parse(runInstallerProbe("preflight", "-Installer", installer, ...baseline));
  runInstallerProbe("install", "-Installer", installer, ...baseline);
  if (verifyHarnessLayout) await verifyInstalledHarnessLayout();
  let main = await openPage(await launchApp(), false);
  await main.text("本地陪伴");
  const state = await nativeAction(main, "state");
  assert.ok(state.roles.some(role => role.name === "大肥鱼"));
  assert.deepEqual(state.models, []);
  const readWebView2 = () => runInstallerProbe("verify-webview2", "-WebViewProfile", profile);
  const loadedVersion = freshWebView2Mode
    ? await until("the app's newly installed WebView2 Runtime", readWebView2, 20_000, 1000)
    : readWebView2();
  if (packyKey) main = await verifyInstalledHarness(main);
  await closeApp(main);
  runInstallerProbe("uninstall");
  assert.ok((await readdir(profile)).includes("desktop.db"));
  if (packyKey || verifyHarnessLayout) {
    await assert.rejects(readdir(join(bundle, "dsh-sdk")), { code: "ENOENT" });
  }
  const runtime = freshWebView2Mode ? "newly installed" : "already available";
  console.log(`Fresh setup ${installation.Current} installed, opened its first application profile, and uninstalled with WebView2 ${loadedVersion || installation.WebView2} ${runtime}.`);
  if (loadedVersion) console.log("The test profile loaded the registered WebView2 executable.");
}

async function verifyInstalledHarness(main) {
  const roleId = "ohjingjing.dafeiyu";
  const modelId = "dsh-installed-" + randomUUID();
  await nativeAction(main, "saveModel", { id: modelId, name: "桌宠个人模型联调", model: "deepseek-flash",
    baseUrl: "https://cf.api.fan/v1", billing: "packy", hasKey: true }, packyKey);
  const { binding: { slot } } = await nativeAction(main, "_credentialPlan", { slot: "model:" + modelId });
  registeredCredentials.push(slot + ".OHJingJing");
  assert.ok(Number(sessionCredential(slot + ".OHJingJing", null, true)) >= 2);
  const memory = "我喜欢在窗边放一盏小夜灯。";
  await nativeAction(main, "saveMemory", { roleId, text: memory });
  await closeApp(main);

  const recordPath = join(scratch, "desktop-harness-attempts.jsonl");
  const preload = join(scratch, "desktop-harness-proof.mjs");
  await writeFile(preload, `import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const rpc = createRequire(import.meta.url)('node:child_process');
const original = rpc.spawn;
const record = row => appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(row) + '\\n');
rpc.spawn = function (file, args, ...rest) {
  const child = original.call(this, file, args, ...rest);
  if (Array.isArray(args) && basename(args[0] || '') === 'dsh-text-turn.mjs') {
    record({ stage: 'started', pid: child.pid });
    let output = '';
    child.stdout?.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.once('close', code => {
      let result;
      try { result = JSON.parse(output); } catch {}
      record({ stage: 'finished', pid: child.pid, code, ok: result?.ok === true,
        input: result?.inputTokens, output: result?.outputTokens });
    });
  }
  return child;
};
syncBuiltinESMExports();`);
  for (const name of Object.keys(env)) if (name.startsWith("OHJINGJING_DSH_")) delete env[name];
  env.NODE_OPTIONS = [env.NODE_OPTIONS, "--import=" + pathToFileURL(preload).href].filter(Boolean).join(" ");
  main = await openPage(await launchApp(), false);
  await until("the reopened desktop bridge", () => main.evaluate("typeof window.__TAURI_INTERNALS__?.invoke === 'function'"));
  const attempts = async () => (await readFile(recordPath, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  })).split("\n").slice(0, -1).map(line => JSON.parse(line));
  const run = text => nativeAction(main, "startChat", { id: randomUUID(), roleId, modelId, text });
  const actual = await run("我把小夜灯放哪里？请用我保存的偏好，用一句话回答。");
  const answered = await until("the installed DSH reply", async () => {
    const turn = await nativeAction(main, "chatTurn");
    if (turn.id !== actual.id || turn.status === "running") return false;
    assert.equal(turn.status, "completed", turn.error);
    return turn;
  }, 29_000);
  assert.match(answered.answer, /窗边/u);
  const completed = (await attempts()).filter(item => item.stage === "finished");
  assert.equal(completed.length, 1);
  assert.ok(completed[0].ok && completed[0].code === 0 && completed[0].input > 0 && completed[0].output > 0);

  const cancelled = await run("这是一条将被取消的合成桌宠对话。");
  await until("a second installed DSH process", async () => (await attempts()).filter(item => item.stage === "started").length === 2);
  assert.equal(await nativeAction(main, "cancelChat", { id: cancelled.id }), true);
  await until("the installed harness to finish cancellation", async () => (await nativeAction(main, "chatTurn")).status === "cancelled");
  assert.equal((await nativeAction(main, "state")).serviceAddress, "");
  const history = await nativeAction(main, "history", { roleId });
  assert.equal(history.length, 2);
  const store = new DatabaseSync(join(profile, "desktop.db"), { readOnly: true });
  try {
    assert.deepEqual(store.prepare("SELECT status FROM requests WHERE model_id=? ORDER BY id").all(modelId).map(row => row.status),
      ["ok", "cancelled"]);
    assert.equal(store.prepare("SELECT COUNT(*) AS n FROM memory WHERE role_id=? AND text=?").get(roleId, memory).n, 1);
  } finally { store.close(); }
  assert.deepEqual(await readdir(join(profile, "dsh-turns")), []);
  await nativeAction(main, "saveModel", model, token);
  const alternate = await nativeAction(main, "_credentialPlan", { slot: "model:" + model.id });
  registeredCredentials.push(alternate.binding.slot + ".OHJingJing");
  assert.equal(await nativeAction(main, "chat", { roleId, modelId: model.id, text: "替代个人模型联调" }), reply);
  assert.equal(calls.at(-1)?.authorized, true);
  assert.equal((await attempts()).filter(item => item.stage === "started").length, 2);
  console.log("The installed desktop verified DSH with a saved personal key, local memory, session cleanup, cancellation, and an alternate provider.");
  return main;
}

async function verifyInstallLifecycle() {
  installation = JSON.parse(runInstallerProbe("preflight", "-Installer", installer, "-PreviousInstaller", previousInstaller));
  runInstallerProbe("install", "-Installer", previousInstaller);
  const appFile = join(bundle, "ohjingjing.exe");
  const oldHash = createHash("sha256").update(await readFile(appFile)).digest("hex");
  let old = await openPage(await launchApp(), false);
  await old.text("本地陪伴");
  assert.equal((await nativeAction(old, "state")).models.length, 0, "First launch must use a clean application profile");
  const rememberCredential = async base => {
    const { binding: { slot } } = await nativeAction(old, "_credentialPlan", { slot: base });
    assert.match(slot, new RegExp(`^${base}:[a-f0-9-]{36}$`));
    const target = slot + ".OHJingJing";
    registeredCredentials.push(target);
    assert.ok(Number(sessionCredential(target, null, true)) >= 2, "The installed application must use persistent Windows credentials");
  };
  await nativeAction(old, "saveModel", { ...model, inputPrice: 1, outputPrice: 2, currency: "CNY" }, token);
  await rememberCredential("model:" + model.id);
  await nativeAction(old, "saveService", { address: model.baseUrl }, subscriptionToken);
  await rememberCredential("service");
  let previousWorkspace;
  const secondaryId = randomUUID();
  if (updateDirectory) {
    await nativeAction(old, "saveServiceProfile", { id: secondaryId, name: "升级前的第二来源", address: alternativeAddress }, alternativeToken);
    await rememberCredential(`service-profile:${secondaryId}`);
    await nativeAction(old, "selectServiceProfile", { id: "legacy" });
    previousWorkspace = await nativeAction(old, "saveWorkspace", { name: "升级前的工作区", sourceIds: ["legacy", secondaryId] });
    if (busyUpdate) {
      const { activeId } = previousWorkspace;
      const reminders = { paused: false, quietHours: true, quietStart: "22:00", quietEnd: "07:00", intervalMinutes: 15 };
      await nativeAction(old, "saveWorkspace", { id: activeId, name: "升级前的工作区", sourceIds: ["legacy", secondaryId], reminders });
      previousWorkspace = await nativeAction(old, "filterWorkspaceSource", { id: activeId, sourceId: secondaryId });
      const saved = previousWorkspace.items.find(item => item.id === activeId);
      assert.equal(saved.sourceFilter, secondaryId);
      assert.deepEqual(saved.reminders, reminders);
    }
    assert.equal((await nativeAction(old, "syncWorkspaceSource", { id: "legacy" })).state, "ready");
    assert.equal((await nativeAction(old, "syncWorkspaceSource", { id: secondaryId })).state, "summary-only");
  }
  const fixture = { id: "install.fixture", name: "安装验收角色", version: "1.0.0", persona: "只用于本机安装验收。" };
  const memory = "升级前保存的个人记忆。";
  const prompt = "升级前保存的问答";
  await nativeAction(old, "createRole", fixture);
  await nativeAction(old, "saveMemory", { roleId: fixture.id, text: memory });
  assert.equal(await nativeAction(old, "chat", { roleId: fixture.id, modelId: model.id, text: prompt }), reply);
  assert.equal(calls.at(-1)?.authorized, true);
  assert.equal((await nativeAction(old, "groups")).groups[0]?.id, summaryGroup);
  await closeApp(old);
  old = await openPage(await launchApp(), false);
  await old.click("群动态");
  await old.text(initialSummary.content);
  await until("a group watch in the previous version", async () => {
    const checked = await old.evaluate(`(() => {
      const label = [...document.querySelectorAll("label")].find(item => item.textContent.includes("此群有新摘要时让桌宠提醒"));
      const input = label?.querySelector("input");
      if (!input) return false;
      if (!input.checked && !input.disabled) input.click();
      return input.checked;
    })()`);
    if (!checked) return false;
    const stored = await nativeAction(old, "summaryReminders").catch(() => null);
    if (stored) return stored.watched.includes(summaryGroup);
    return old.evaluate(`!!JSON.parse(localStorage.getItem("groupReactions") ?? "{}")[${JSON.stringify(summaryGroup)}]`);
  });
  console.log(`Setup ${installation.Previous} registered and launched the app with WebView2 ${installation.WebView2}.`);
  if (updateDirectory) {
    const feed = await startUpdateFeed(updateDirectory, false);
    const diagnose = () => JSON.parse(runInstallerProbe("diagnose", "-Installer", installer, "-WebViewProfile", profile));
    let pendingSync;
    try {
      assert.equal(feed.descriptor.version, installation.Current);
      assert.equal(feed.path, installer);
      await old.click("设置");
      await old.click("检查更新");
      await old.text(`可更新至 ${installation.Current}`);
      if (busyUpdate) {
        holdUpdaterSync = true;
        pendingSync = nativeAction(old, "syncWorkspaceSource", { id: "legacy" }).catch(() => null);
        await until("a workspace source request is in flight before the update", () => updaterSyncPending);
        const running = diagnose();
        assert.equal(running.WorkerCount, 1);
        assert.ok(running.BrowserCount > 0, "The Windows probe must recognize the test profile’s WebView processes");
      }
      const exited = once(app, "exit");
      updateInstallPending = true;
      await old.click("现在安装");
      const [code] = await Promise.race([exited, delay(35_000, [-1], { ref: false })]);
      assert.equal(code, 0, "The running app must hand the signed update to the Windows installer");
      const handoff = diagnose();
      console.log(`After updater handoff: ${JSON.stringify(handoff)}`);
      if (busyUpdate) {
        assert.equal(handoff.WorkerCount, 0, "The updater must stop the packaged runtime before starting the installer");
      }
      try {
        await until("the updated Windows registration and installer exit", () => {
          const { Registered, BrowserCount, InstallerCount } = diagnose();
          return Registered === installation.Current && BrowserCount === 0 && InstallerCount === 0;
        }, 480_000, 1200);
      } catch (error) {
        const last = diagnose();
        updateInstallPending = last.InstallerCount > 0;
        throw new Error(`${error.message}. ${JSON.stringify(last)}`);
      }
      updateInstallPending = false;
      assert.equal(runInstallerProbe("verify", "-Installer", installer), "ready");
      await waitForWebViewShutdown(debugPort);
      assert.equal(feed.downloads(), 1);
      console.log(`The native updater downloaded the signed installer and installed ${installation.Current} in the existing test directory.`);
    } finally {
      holdUpdaterSync = false;
      await pendingSync;
      await feed.close();
    }
  } else {
    await closeApp(old);
    runInstallerProbe("install", "-Installer", installer);
  }
  const upgradedHash = createHash("sha256").update(await readFile(appFile)).digest("hex");
  assert.notEqual(upgradedHash, oldHash, "The new setup must replace the application binary");
  if (verifyHarnessLayout) await verifyInstalledHarnessLayout();
  const upgraded = await openPage(await launchApp(), false);
  await upgraded.text("本地陪伴");
  const state = await nativeAction(upgraded, "state");
  assert.ok(state.roles.some(role => role.id === fixture.id && role.name === fixture.name));
  assert.ok(state.models.some(item => item.id === model.id && item.hasKey));
  assert.equal(state.serviceAddress, model.baseUrl);
  assert.equal(state.usage.find(item => item.model_id === model.id)?.requests, 1);
  assert.deepEqual((await nativeAction(upgraded, "history", { roleId: fixture.id })).map(item => item.content), [prompt, reply]);
  assert.equal((await nativeAction(upgraded, "listMemory", { roleId: fixture.id }))[0]?.text, memory);
  assert.equal((await nativeAction(upgraded, "groups")).groups[0]?.summary?.content, initialSummary.content);
  await until("the retained summary watch", async () =>
    (await nativeAction(upgraded, "summaryReminders")).watched.includes(summaryGroup));
  if (previousWorkspace) {
    assert.deepEqual(await nativeAction(upgraded, "workspaceSettings"), previousWorkspace);
    const beforeSync = workspaceCursors.length;
    assert.equal((await nativeAction(upgraded, "syncWorkspaceSource", { id: "legacy" })).state, "ready");
    assert.ok(workspaceCursors.slice(beforeSync).includes("gui-fixture-workspace"));
    assert.equal((await nativeAction(upgraded, "syncWorkspaceSource", { id: secondaryId })).state, "summary-only");
    console.log("The installed update retained both workspace source bindings and resumed the stored feed cursor.");
  }
  await upgraded.click("设置");
  await upgraded.click(model.name);
  await upgraded.click("测试连接");
  await upgraded.text("已保存的模型配置可用");
  assert.equal(calls.at(-1)?.authorized, true);
  await closeApp(upgraded);
  console.log(`Upgrade to ${installation.Current} kept both Windows credentials, the role, memory, configuration, conversation and usage.`);

  runInstallerProbe("uninstall");
  if (verifyHarnessLayout) await assert.rejects(readdir(join(bundle, "dsh-sdk")), { code: "ENOENT" });
  const retained = new DatabaseSync(join(profile, "desktop.db"), { readOnly: true });
  try {
    const transcript = retained.prepare("SELECT content FROM messages WHERE role_id=? ORDER BY id").all(fixture.id);
    assert.deepEqual(transcript.map(item => item.content), [prompt, reply]);
    assert.equal(retained.prepare("SELECT COUNT(*) AS count FROM requests WHERE model_id=?").get(model.id).count, 2);
  } finally { retained.close(); }
  console.log("Uninstall removed the program and Windows Apps registration, and retained the selected data directory.");
}

async function verifyLocalReminders() {
  const title = "本机待办提醒样本";
  const draft = "本机待办初稿";
  const cancelled = "要取消的提醒";
  const textField = 'label:has(input[maxlength="120"]) input';
  const openReminders = page => until("the reminders view", () => page.evaluate(`(() => {
    const button = [...document.querySelectorAll("nav button")].find(item => /^提醒(?:\\s|$)/u.test(item.textContent.trim()));
    if (!button) return false;
    button.click();
    return true;
  })()`));
  let port = await launchApp();
  let main = await openPage(port, false);
  await main.text("本地陪伴");
  const state = await nativeAction(main, "state");
  assert.equal(state.serviceAddress, "");
  assert.deepEqual(state.models, []);
  await openReminders(main);
  await main.fill(textField, draft);
  await main.click("添加提醒");
  await main.text(draft, ".local-reminder-list");
  await main.click("编辑");
  await main.fill(textField, title);
  await main.click("保存修改");
  await main.text(title, ".local-reminder-list");
  await main.fill(textField, cancelled);
  await main.click("添加提醒");
  await main.text(cancelled, ".local-reminder-list");
  await main.evaluate(`[...document.querySelectorAll(".local-reminder-list li")].find(row => row.textContent.includes(${JSON.stringify(cancelled)}))
    .querySelector("button:last-child").click()`);
  await until("the cancelled local reminder clears", async () => (await nativeAction(main, "localReminders")).items.length === 1);
  await main.click("暂停本地提醒");
  await main.text("本地提醒气泡已暂停");
  await closeApp(main);

  const database = join(profile, "desktop.db");
  const offline = new DatabaseSync(database);
  try {
    assert.equal(offline.prepare("UPDATE desktop_local_reminders SET due_at=? WHERE text=?").run(Date.now() - 1000, title).changes, 1);
  } finally { offline.close(); }
  port = await launchApp();
  main = await openPage(port, false);
  await main.text("本地陪伴");
  await openReminders(main);
  await main.text("本地提醒气泡已暂停");
  await main.text("已到期", ".local-reminder-list");
  await main.click("显示桌面宠物");
  const pet = await openPage(port, true);
  await until("floating local reminder controls", () => pet.evaluate('!!document.querySelector(".pet-button")'));
  assert.equal(await pet.evaluate('!!document.querySelector(".pet-local-activity")'), false);
  await pet.evaluate('document.querySelector(".pet-button").click()');
  await pet.click("待办");
  await pet.text(title, ".pet-local-reminders");
  await pet.evaluate('document.querySelector("button[aria-label=收起面板]").click()');

  const systemDefers = () => pet.evaluate('window.__TAURI_INTERNALS__.invoke("system_defers_reminders")');
  await until("ready desktop for local reminder fullscreen fixture", async () => await systemDefers() === false);
  const leaveFullscreen = await showFullscreenFixture();
  try {
    await until("local reminders detect fullscreen", systemDefers);
    await main.click("恢复本地提醒");
    await until("resuming local reminders is persisted", async () => (await nativeAction(main, "localReminders")).paused === false);
    await delay(1300);
    assert.equal(await systemDefers(), true);
    assert.equal(await pet.evaluate('!!document.querySelector(".pet-local-activity")'), false);
  } finally { await leaveFullscreen(); }

  await pet.text(title, ".pet-local-activity");
  await pet.click("待办 · " + title);
  await pet.text(title, ".pet-local-reminders");
  const before = Date.now();
  await pet.click("5 分钟后");
  await pet.text("暂无到期提醒", ".pet-local-reminders");
  const postponed = (await nativeAction(main, "localReminders")).items[0];
  assert.ok(postponed.dueAt >= before + 5 * 60_000);
  await until("the main window updates after the pet postpones", () => main.evaluate(
    '!document.querySelector(".local-reminder-list").textContent.includes("已到期")'));
  await main.click("完成");
  await main.text("暂无本地提醒");
  assert.deepEqual((await nativeAction(pet, "localReminders")).items, []);
  assert.equal(calls.length, 0);
  await pet.evaluate('document.querySelector(".pet-close").click()');
  await pet.closed();
  await closeApp(main);
  const retained = new DatabaseSync(database, { readOnly: true });
  try { assert.equal(retained.prepare("SELECT COUNT(*) AS n FROM desktop_local_reminders WHERE text IS NOT NULL").get().n, 0); }
  finally { retained.close(); }
  console.log("Local reminders were edited, cancelled, deferred in fullscreen, recovered after restart, postponed from the pet, and completed without an API key or subscription.");
}

async function extractApplication() {
  await mkdir(bundle);
  run(sevenZip, ["x", installer, `-o${bundle}`, "ohjingjing.exe", "node.exe", "runtime.mjs", "-y"]);
}

async function startUpdateFeed(directory, damaged) {
  const descriptor = JSON.parse(await readFile(join(directory, "latest.json"), "utf8"));
  const release = descriptor.platforms["windows-x86_64"];
  const download = new URL(release.url);
  assert.equal(download.protocol, "http:");
  assert.equal(download.hostname, "127.0.0.1");
  assert.ok(Number(download.port) > 0 && !download.username && !download.password && !download.search && !download.hash,
    "Use a local signed update feed with an explicit test port");
  assert.match(download.pathname, /^\/OHJingJing_\d+\.\d+\.\d+_x64-setup\.exe$/u);
  const path = join(directory, download.pathname.slice(1));
  const payload = await readFile(path);
  if (damaged) payload[Math.trunc(payload.length / 2)] ^= 1;
  let attemptedDownloads = 0;
  const updateServer = createServer((req, res) => {
    if (req.url === "/latest.json") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(descriptor));
    } else if (req.url === download.pathname) {
      attemptedDownloads++;
      res.writeHead(200, { "Content-Length": payload.length }).end(payload);
    } else res.writeHead(404).end();
  });
  await new Promise((ready, fail) => {
    updateServer.once("error", fail);
    updateServer.listen(Number(download.port), "127.0.0.1", ready);
  });
  return { descriptor, path, downloads: () => attemptedDownloads, close: () => new Promise(resolve => updateServer.close(resolve)) };
}

async function verifySignedUpdate(directory) {
  const feed = await startUpdateFeed(directory, true);
  const { descriptor } = feed;
  try {
    await extractApplication();
    const executable = join(bundle, "ohjingjing.exe");
    const sha256 = async () => createHash("sha256").update(await readFile(executable)).digest("hex");
    const before = await sha256();
    const main = await openPage(await launchApp(), false);
    await main.click("设置");
    await main.click("检查更新");
    await main.text(`可更新至 ${descriptor.version}`);
    await main.click("下次启动安装");
    await main.text(`下次启动安装 ${descriptor.version}`);
    await closeApp(main);
    const restarted = await openPage(await launchApp(), false);
    await restarted.click("设置");
    await until("verification of the modified installer", async () => await restarted.evaluate(`Array.from(document.querySelectorAll('[role="status"]'))
      .some(item => /signature|签名/iu.test(item.textContent) && !item.textContent.includes('正在下载'))`), 30_000);
    assert.equal(feed.downloads(), 1);
    assert.equal(await sha256(), before);
    assert.ok(Array.isArray((await nativeAction(restarted, "state")).models));
    assert.equal(await restarted.evaluate('localStorage.getItem("desktopUpdateNextStart")'), null);
    await closeApp(restarted);
    console.log("The packaged Windows app discovered the signed release, retried the scheduled action on startup, and rejected a modified installer before replacing the app.");
  } finally {
    await feed.close();
  }
}

async function verifyLiveSubscription({ address, token: subscription, scope, waitForNewSummaryMs, roleRevision, verifyChannelCoverage }) {
  async function readSubscriber(path = "/api/groups") {
    return fetch(address + path, { headers: { Authorization: "Bearer " + subscription },
      signal: AbortSignal.timeout(4000) });
  }
  const verifyState = page => nativeAction(page, "state");
  function hasSummary(page, content, selector) {
    return page.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(row => row.textContent === ${JSON.stringify(content)})`);
  }
  async function confirmRevocation(main, pet, content) {
    console.log("OHJINGJING_LIVE_REVOKE_NOW");
    await until("temporary subscription revoked remotely", async () => (await readSubscriber()).status === 401, 20_000);
    await main.click("群动态");
    await main.click("刷新");
    await main.text("服务端订阅已失效");
    await pet.text("群动态订阅已失效", ".pet-group-feed");
    assert.equal(await hasSummary(main, content, ".pane p"), false);
    assert.equal(await pet.evaluate('document.querySelector(".pet-summary-body, .summary-explanation") !== null'), false);
    if (verifyChannelCoverage) {
      for (const page of [main, pet]) assert.equal(await page.evaluate('document.querySelector(".coverage-hint") !== null'), false);
    }
  }
  async function readLiveGroup() {
    const response = await readSubscriber();
    assert.equal(response.status, 200);
    const feed = await response.json();
    assert.ok(feed.groups.length === 1 && feed.groups[0].id === scope && feed.groups[0].summary?.content?.trim(),
      "The read-only token should expose one authorized group with a summary.");
    if (verifyChannelCoverage) {
      const coverage = feed.channelCoverage;
      assert.ok(coverage?.onlineMs > 0, "An authorized feed should include the live online observation.");
      assert.equal(coverage.onlineMs + coverage.unavailableMs + coverage.disabledMs + coverage.unobservedMs, 86_400_000);
    }
    return feed.groups[0];
  }
  await extractApplication();
  const port = await launchApp();
  const main = await openPage(port, false);
  await main.text("本地陪伴");
  assert.deepEqual((await verifyState(main)).models, []);
  assert.equal((await verifyState(main)).serviceAddress, "");
  await main.click("设置");
  await main.click("新增连接");
  await main.fill(".service-connections input[maxlength='60']", "真实群订阅验收");
  await main.fill(".service-connections input[type='url']", address);
  await main.fill(".service-connections input[type='password']", subscription);
  await main.click("保存并测试");
  await until("the saved live service address", async () => (await verifyState(main)).serviceAddress === address);
  const { binding: serviceBinding } = await nativeAction(main, "_credentialPlan", { slot: "service" });
  registeredCredentials.push(serviceBinding.slot + ".OHJingJing");
  assert.equal(JSON.stringify(await verifyState(main)).includes(subscription), false);
  const liveGroup = await readLiveGroup();
  const content = liveGroup.summary.content;
  const personalRole = { id: "fixture.live.personal", name: "桌宠验收本地角色", version: "1.0.0",
    persona: "本机独立角色样本，只负责私人桌面聊天。" };
  let groupRole;
  await main.click("群动态");
  await until("real summary displayed by the main window", () => hasSummary(main, content, ".pane p"));
  if (roleRevision) {
    assert.equal(liveGroup.publishedRole?.revision, roleRevision);
    const response = await readSubscriber(`/api/groups/${scope}/role`);
    assert.equal(response.status, 200);
    groupRole = await response.json();
    assert.equal(groupRole.info.revision, roleRevision);
    await main.click("插件中心");
    await main.click("导入角色 JSON");
    await main.fill('textarea[aria-label="角色 JSON"]', JSON.stringify(personalRole));
    await main.click("导入");
    await main.text(personalRole.name, "h1");
    await main.click("预览角色");
    await until("published persona displayed in live desktop preview", () =>
      hasSummary(main, groupRole.role.persona, ".plugin-card .profile .role-description"));
    await main.click("跟随该群角色");
    await main.text("已应用到该群的摘要和画像讲解", ".notice");
    assert.equal((await nativeAction(main, "groups")).groups[0].followedRole?.revision, roleRevision);
    await main.text(personalRole.name, "h1");
  }
  if (waitForNewSummaryMs) {
    await until("enabling the authorized group's reminder", () => main.evaluate(`(() => {
      const label = [...document.querySelectorAll('.pane label')].find(row => row.textContent.includes('此群有新摘要时让桌宠提醒'));
      const control = label?.querySelector('input[type=checkbox]');
      if (!control || control.disabled) return false;
      if (!control.checked) control.click();
      return true;
    })()`));
    await until("saved watch for the live group", async () => (await nativeAction(main, "summaryReminders")).watched.includes(scope));
    const baseline = (await nativeAction(main, "groups")).groups[0].summary;
    await closeApp(main);
    const closedAt = Date.now();
    console.log("The watched summary baseline is saved. Waiting for the service to archive another batch with the desktop closed.");
    const arrived = await until("a real summary archived while the desktop is closed", async () => {
      const { summary } = await readLiveGroup();
      if (summary.id !== baseline.id && Date.parse(summary.created_at) >= closedAt) return summary;
      await delay(2600);
    }, waitForNewSummaryMs);
    assert.ok(Number.isSafeInteger(arrived.id));
    const reopenedPort = await launchApp();
    const reopened = await openPage(reopenedPort, false);
    await reopened.click("显示桌面宠物");
    const floating = await openPage(reopenedPort, true);
    const reaction = await until("an automatic floating reminder with the panel closed", () =>
      floating.evaluate('document.querySelector(".pet-activity")?.dataset.summaryReaction'), 35_000);
    assert.ok(["summary", "topic", "question", "decision", "change"].includes(reaction));
    assert.equal(await floating.evaluate('document.querySelector(".pet-summary-body") !== null'), false);
    await floating.evaluate('document.querySelector(".pet-activity").click()');
    const displayed = await until("the live summary opened from the reminder", () =>
      floating.evaluate('document.querySelector(".pet-group-feed > .pet-summary-body")?.textContent'));
    const shown = await readLiveGroup();
    assert.ok([shown.summary, ...(shown.summaries ?? [])].some(summary =>
      summary.content === displayed && Date.parse(summary.created_at) >= closedAt), "The opened summary should match a real archive made while the desktop was closed.");
    assert.equal(await floating.evaluate('document.querySelector("select[aria-label=摘要群聊]")?.value === ' + JSON.stringify(scope)), true);
    assert.equal(calls.length, 0);
    console.log("A real summary archived while the desktop was closed produced an automatic bubble and opened the authorized archive without a personal model.");
    await confirmRevocation(reopened, floating, displayed);
    await floating.evaluate('document.querySelector(".pet-close").click()');
    await floating.closed();
    await closeApp(reopened);
    console.log("Revocation cleared the live notification's summary from the desktop.");
    return;
  }
  await main.click("显示桌面宠物");
  const pet = await openPage(port, true);
  await until("floating pet interaction button", () => pet.evaluate(`(() => {
    const button = document.querySelector('.pet-button');
    if (!button) return false;
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    return true;
  })()`));
  await pet.click("群摘要");
  await until("real summary displayed by the floating window", () => hasSummary(pet, content, ".pet-summary-body"));
  if (verifyChannelCoverage) {
    for (const page of [main, pet]) {
      await page.text("近 24 小时 QQ 网关", ".coverage-hint summary");
      await page.text("缺少观测", ".coverage-hint p");
    }
    console.log("Both Windows displayed the live service's separate gateway coverage measurements.");
  }
  await pet.click("讲给我听");
  await pet.text("讲解需要在主窗口配置个人模型和 API Key", ".summary-explanation");
  assert.equal(calls.length, 0);
  console.log("The packaged app displayed the authorized real summary in both windows before a personal model was configured.");

  await main.click("设置");
  await main.click("新建");
  const fields = 'section.card:not(.service-connections) > form.form-grid > ';
  await main.fill(fields + "label:nth-child(1) input", model.name);
  await main.fill(fields + "label:nth-child(2) input", model.model);
  await main.fill(fields + "label:nth-child(3) input", model.baseUrl);
  await main.fill(fields + "label:nth-child(4) input", token);
  await main.click("保存模型");
  await main.text("模型已保存", ".notice");
  const saved = (await verifyState(main)).models.find(item => item.name === model.name);
  assert.ok(saved?.hasKey);
  const { binding: modelBinding } = await nativeAction(main, "_credentialPlan", { slot: `model:${saved.id}` });
  registeredCredentials.push(modelBinding.slot + ".OHJingJing");
  await pet.click("讲给我听");
  await pet.text(model.name, ".summary-consent");
  assert.equal(calls.length, 0);
  await pet.click("确认讲解");
  await pet.text(groupExplanation, ".summary-explanation");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorized, true);
  assert.ok(calls[0].body.messages.at(-1).content.includes(content.slice(0, 900)), "The confirmed request should carry the selected real summary.");
  const initialHistory = await nativeAction(main, "history", { roleId: groupRole ? personalRole.id : "ohjingjing.dafeiyu" });
  assert.equal(initialHistory.length, 0);
  console.log("The confirmed explanation used the local personal endpoint and the authorized summary without writing personal chat history.");

  if (groupRole) {
    const usedPersona = calls[0].body.messages[0].content;
    assert.ok(usedPersona.includes(groupRole.role.persona) && !usedPersona.includes(personalRole.persona),
      "The followed group persona should apply to the summary only.");
    console.log("OHJINGJING_LIVE_WITHDRAW_ROLE_NOW");
    await until("temporary group role withdrawn", async () => (await readSubscriber(`/api/groups/${scope}/role`)).status === 404, 20_000);
    await pet.click("刷新摘要");
    await until("withdrawal clears the followed explanation", async () => !await pet.evaluate(
      'document.querySelector(".summary-explanation .bubble.assistant") !== null'));
    const unchanged = (await nativeAction(main, "groups")).groups[0];
    assert.ok(!unchanged.publishedRole && !unchanged.followedRole && unchanged.summary);
    await main.click("插件中心");
    await main.click("刷新");
    await main.text("授权群还没有发布角色");
    await main.text(personalRole.name, "h1");
    console.log("Live group role withdrawal reset the followed role and cleared the old explanation while the summary remained readable.");
  }

  await confirmRevocation(main, pet, content);

  await main.click("设置");
  await until("disconnecting the saved service", () => main.evaluate(`(() => {
    const select = document.querySelector('.service-connections select');
    if (!select || select.disabled) return false;
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles:true }));
    return true;
  })()`));
  await until("standalone desktop state", async () => (await verifyState(main)).serviceAddress === "");
  await pet.click("返回聊天");
  await pet.fill(".pet-chat input", question);
  await pet.click("发送");
  await pet.text(reply, ".pet-answer");
  await main.click("聊天");
  await main.text(reply, ".history");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].authorized, true);
  assert.equal(calls[1].body.messages.at(-1).content, question);
  assert.ok(!JSON.stringify(calls[1].body.messages).includes(content.slice(0, 90)), "The local chat should have no live summary context.");
  if (groupRole) {
    const usedPersona = calls[1].body.messages[0].content;
    assert.ok(usedPersona.includes(personalRole.persona) && !usedPersona.includes(groupRole.role.persona),
      "Standalone chat should use the selected local persona.");
  }
  await pet.evaluate('document.querySelector(".pet-close").click()');
  await pet.closed();
  await closeApp(main);
  console.log("Remote revocation cleared both windows, and desktop-only chat still worked with the saved personal model.");
}

async function verifyExtractedApplication() {
  await extractApplication();
  await verifyLocalReminders();
  seedSubscription(model.baseUrl);
  const firstPort = await launchApp();
  const firstMain = await openPage(firstPort, false);
  await firstMain.text("本地陪伴");
  assert.equal(await firstMain.evaluate(`(async () => {
    const state = await window.__TAURI_INTERNALS__.invoke("run_action", { action: "state", args: {} });
    return state.models.length;
  })()`), 0);
  await firstMain.click("群动态");
  await firstMain.text(initialSummary.content);
  await until("the summary watch preference", () => firstMain.evaluate(`(() => {
    const label = [...document.querySelectorAll("label")].find(item => item.textContent.includes("此群有新摘要时让桌宠提醒"));
    const input = label?.querySelector("input");
    if (!input || input.disabled) return false;
    if (!input.checked) input.click();
    return true;
  })()`));
  await firstMain.click("显示桌面宠物");
  const firstPet = await openPage(firstPort, true);
  await until("the pet button before configuring a model", () => firstPet.evaluate(
    'document.querySelector(".pet-button")?.getAttribute("aria-label") === "和大肥鱼聊天"'));
  assert.equal(await firstPet.evaluate('document.querySelector(".pet-button").click() ?? true'), true);
  await firstPet.click("群摘要");
  await firstPet.text(initialSummary.content, ".pet-group-feed");
  await firstPet.text(olderSummary.content, ".pet-group-feed");
  if (coverageMode) {
    for (const page of [firstMain, firstPet]) {
      await page.click("近 24 小时 QQ 网关有覆盖缺口");
      await page.text("断线或连接中 2 分钟", ".coverage-hint");
      await page.text("缺少观测 10 分钟", ".coverage-hint");
    }
  }
  await firstPet.click("讲给我听");
  await firstPet.text("你仍可直接阅读摘要", ".summary-explanation");
  assert.equal(calls.length, 0);
  await firstPet.evaluate('document.querySelector(".pet-close").click()');
  await firstMain.click("设置");
  await firstMain.text("桌宠摘要提醒");
  await firstMain.evaluate(`(() => {
    const form = [...document.forms].find(form => form.textContent.includes("保存提醒设置"));
    const checkbox = [...form.querySelectorAll('input[type=checkbox]')].find(input => input.parentElement.textContent.includes("启用勿扰时段"));
    if (!checkbox.checked) checkbox.click();
  })()`);
  const timeFromNow = minutes => {
    const time = new Date(Date.now() + minutes * 60_000);
    return String(time.getHours()).padStart(2, "0") + ":" + String(time.getMinutes()).padStart(2, "0");
  };
  await firstMain.fill('label:has(input[type="time"]):nth-of-type(3) input', timeFromNow(-10));
  await firstMain.fill('label:has(input[type="time"]):nth-of-type(4) input', timeFromNow(15));
  await firstMain.click("保存提醒设置");
  await firstMain.text("桌宠提醒设置已保存。");
  await closeApp(firstMain);

  summaries = [returnedSummary, initialSummary, olderSummary];
  const quietPort = await launchApp();
  const quietMain = await openPage(quietPort, false);
  await quietMain.click("显示桌面宠物");
  const quietPet = await openPage(quietPort, true);
  await until("ready quiet-hours pet", () => quietPet.evaluate('!!document.querySelector(".pet-button")'));
  assert.equal((await nativeAction(quietMain, "summaryReminders")).policy.quietHours, true);
  const pending = await until("the deferred group summary", async () =>
    (await nativeAction(quietMain, "groups")).summaryNotices[0]?.token);
  assert.equal(await quietPet.evaluate('document.querySelector(".pet-activity") !== null'), false);
  await quietPet.evaluate('document.querySelector(".pet-button").click()');
  await quietPet.click("群摘要");
  await quietPet.text(returnedSummary.content, ".pet-group-feed");
  assert.equal((await nativeAction(quietMain, "groups")).summaryNotices[0]?.token, pending);
  await quietPet.evaluate('document.querySelector(".pet-close").click()');
  await quietPet.closed();
  await closeApp(quietMain);

  seedModel(model, token);
  const packy = { ...model, id: model.id + "-packy", name: "Packy 额度联调", billing: "packy",
    baseUrl: "https://cf.api.fan/v1" };
  if (packyKey) seedModel(packy, packyKey);
  if (balanceMode) seedModel(balanceModel, balanceKey);

  const port = await launchApp();
  const main = await openPage(port, false);
  await main.text("本地陪伴");
  await main.text("大肥鱼", "h1");
  await main.click("显示桌面宠物");
  const resumedPet = await openPage(port, true);
  await until("ready pet before fullscreen testing", () => resumedPet.evaluate('!!document.querySelector(".pet-button")'));
  const systemDefers = () => resumedPet.evaluate('window.__TAURI_INTERNALS__.invoke("system_defers_reminders")');
  await until("the regular desktop before fullscreen", async () => await systemDefers() === false);
  const leaveFullscreen = await showFullscreenFixture();
  try {
    await until("native fullscreen detection", systemDefers);
    await main.click("设置");
    await main.text("桌宠摘要提醒");
    await main.evaluate(`(() => {
      const form = [...document.forms].find(form => form.textContent.includes("保存提醒设置"));
      const checkbox = [...form.querySelectorAll('input[type=checkbox]')].find(input => input.parentElement.textContent.includes("启用勿扰时段"));
      if (checkbox.checked) checkbox.click();
    })()`);
    await main.click("保存提醒设置");
    await main.text("桌宠提醒设置已保存。");
    await delay(1300);
    assert.equal(await systemDefers(), true);
    assert.equal(await resumedPet.evaluate('document.querySelector(".pet-activity") !== null'), false);
    assert.equal((await nativeAction(main, "groups")).summaryNotices[0]?.token, pending);
  } finally { await leaveFullscreen(); }
  await until("native fullscreen exit", async () => await systemDefers() === false);
  const summaryBubble = "有已确认的变更 · 联调群";
  await resumedPet.text(summaryBubble, ".pet-activity");
  assert.equal(await resumedPet.evaluate('document.querySelector(".pet").dataset.summaryReaction'), "change");
  assert.equal(await resumedPet.evaluate(`document.body.textContent.includes(${JSON.stringify(topicUpdate)})`), false);
  assert.equal(await resumedPet.evaluate('getComputedStyle(document.querySelector(".pet")).animationName'),
    await resumedPet.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches') ? "none" : "pet-summary-hop");
  await until("the displayed reminder is acknowledged", async () => (await nativeAction(main, "groups")).summaryNotices.length === 0);
  await resumedPet.click(summaryBubble);
  await resumedPet.text(returnedSummary.content, ".pet-group-feed");
  await resumedPet.text(topicTitle, '.pet-group-feed .summary-highlight');
  await resumedPet.text(topicUpdate, '.pet-group-feed .summary-highlight');
  assert.equal(await resumedPet.evaluate('document.querySelector(".pet").hasAttribute("data-summary-reaction")'), false);
  summaryAccessRevoked = true;
  await resumedPet.click("刷新摘要");
  await resumedPet.text("暂无可看的群摘要", ".pet-group-feed");
  assert.equal(await resumedPet.evaluate('document.querySelector(".pet-summary-body, .summary-highlight") !== null'), false);
  summaryAccessRevoked = false;
  await resumedPet.click("刷新摘要");
  await resumedPet.text(returnedSummary.content, ".pet-group-feed");
  await main.click("群动态");
  await main.text(returnedSummary.content);
  await main.text(topicUpdate, '.summary-highlight');
  subscriptionRevoked = true;
  await main.click("刷新");
  await main.text("服务端订阅已失效");
  await resumedPet.text("群动态订阅已失效", ".pet-group-feed");
  if (coverageMode) {
    assert.equal(await main.evaluate('document.querySelector(".coverage-hint") !== null'), false);
    assert.equal(await resumedPet.evaluate('document.querySelector(".coverage-hint") !== null'), false);
    console.log("Both desktop windows distinguished a known gateway gap from unobserved time and cleared the coverage after revocation.");
  }
  assert.equal(await resumedPet.evaluate('document.querySelector(".pet-summary-body, .summary-highlight") !== null'), false);
  assert.equal(await main.evaluate(`document.body.textContent.includes(${JSON.stringify(returnedSummary.content)})`), false);
  assert.equal(await main.evaluate(`document.body.textContent.includes(${JSON.stringify(topicUpdate)})`), false);
  assert.equal(calls.length, 0);
  await resumedPet.evaluate('document.querySelector(".pet-close").click()');
  await resumedPet.closed();
  subscriptionRevoked = false;
  console.log("The pet retained a pending summary across restart and quiet hours, deferred it during a native fullscreen window, and acknowledged it after showing the bubble. Manual reads need no model key, and revocation cleared both windows.");

  assert.equal(await main.evaluate(`(async () => {
    const state = await window.__TAURI_INTERNALS__.invoke("run_action", { action: "state", args: {} });
    return state.models.some(item => item.id === ${JSON.stringify(model.id)});
  })()`), true, "Use the database in the selected data directory");
  await main.click("设置");
  await nativeAction(main, "saveModel", { ...backupModel, baseUrl: model.baseUrl + "/backup" }, backupToken);
  const { binding: spareBinding } = await nativeAction(main, "_credentialPlan", { slot: `model:${backupModel.id}` });
  registeredCredentials.push(spareBinding.slot + ".OHJingJing");
  await main.click(model.name);
  await main.fill("label:has(input) input:first-of-type", "窗口联调模型（已保存）");
  await main.click("保存模型");
  await main.text("模型已保存");
  await main.text("窗口联调模型（已保存）");
  await main.click("测试连接");
  await main.text("已保存的模型配置可用");
  assert.equal(calls[0]?.authorized, true);
  console.log("Main window saved a model and authenticated with a Windows session credential.");
  await main.click("本机模型预算");
  await main.fill('.model-budget input[name="daily-requests"]', "1");
  await main.click("保存预算");
  await main.text("本机模型预算已保存", ".notice");
  await main.text("1/1 次", ".model-budget");
  await main.click("测试连接");
  await main.text("已达今日本机请求上限", ".notice");
  assert.equal(calls.length, 1, "An exhausted desktop budget must prevent the connection test from reaching the provider");
  await main.fill('.model-budget input[name="daily-requests"]', "12");
  await main.click("保存预算");
  await main.text("1/12 次", ".model-budget");
  await until("the saved backup profile option", () => main.evaluate(`(() => {
    const select = document.querySelector('.model-backup select');
    if (!select || select.disabled || ![...select.options].some(option => option.value === ${JSON.stringify(backupModel.id)})) return false;
    select.value = ${JSON.stringify(backupModel.id)};
    select.dispatchEvent(new Event("change", { bubbles:true }));
    return true;
  })()`));
  await main.text("个人聊天备用模型已保存", ".notice");

  if (packyKey) {
    await main.click(packy.name);
    await main.click("刷新余额");
    await main.text("API Key 额度", ".form-grid ~ .profile");
    await main.text("已用", ".form-grid ~ .profile");
    await main.text("www.packyapi.ai", ".form-grid ~ .profile");
    console.log("The packaged desktop displayed live Packy API Key quota.");
  }
  if (balanceMode) {
    await main.click(balanceModel.name);
    await main.click("刷新余额");
    await main.text("剩余 18", ".form-grid ~ .profile");
    assert.equal(balanceQueries, 1);
    await main.fill('.form-grid input[type="password"]', rotatedBalanceKey);
    await main.text("保存地址、余额接口和 API Key 后");
    assert.equal(await main.evaluate('document.querySelector(".form-grid ~ .profile") === null'), true);
    await main.fill('.form-grid input[type="password"]', "");
    await main.text("剩余 18", ".form-grid ~ .profile");
    assert.equal(balanceQueries, 1);
  }

  await main.click("插件中心");
  await main.click("IM 渠道");
  await main.text("联调 QQ 渠道", ".plugin-card");
  await main.text("群聊文字", ".plugin-card");
  await main.text("群聊表情", ".plugin-card");
  await main.text("在线", ".plugin-card");
  await main.click("角色");
  await main.click("复制为本地角色");
  await main.text("大肥鱼（副本）", "h1");
  await main.click("导入角色 JSON");
  await main.fill('textarea[aria-label="角色 JSON"]',
    JSON.stringify({ id: "gui.fixture", name: "联调角色", version: "1.0.0", persona: "窗口联调角色设定。" }));
  await main.click("导入");
  await main.text("联调角色", "h1");
  await main.click("编辑角色");
  await main.fill('textarea[aria-label="编辑角色设定"]', "窗口联调角色设定。保存后的新版。");
  await main.fill(".role-card-editor input[pattern]", "1.1.0");
  await main.click("保存角色");
  await main.text("角色已更新", ".notice");

  const path = join(scratch, "exported-role.json");
  await main.click("导出角色 JSON");
  try { saveThroughDialog(path, "role-gui.fixture.json"); }
  catch (error) {
    const notice = await main.evaluate('document.querySelector(".notice")?.textContent ?? ""');
    throw new Error(`Role export failed. ${notice}\n${error.message}`, { cause: error });
  }
  await main.text("角色 JSON 已导出", ".notice");
  const exported = JSON.parse(await readFile(path, "utf8"));
  assert.equal(exported.id, "gui.fixture");
  assert.equal(exported.version, "1.1.0");
  assert.match(exported.persona, /保存后的新版/u);
  await main.fill('textarea[aria-label="角色 JSON"]', JSON.stringify(exported));
  await main.click("导入");
  await main.text("角色已导入", ".notice");
  await main.fill('textarea[aria-label="角色 JSON"]', JSON.stringify({ ...exported, name: "导入冲突联调", version: "2.0.0" }));
  await main.click("导入");
  await main.text("角色 ID 已存在");
  await main.click("导入为独立副本");
  await main.text("导入冲突联调（副本）", "h1");
  assert.equal(await main.evaluate(`(() => {
    const select = document.querySelector(".plugin-card select");
    if (!select) return false;
    select.value = "gui.fixture";
    select.dispatchEvent(new Event("change", { bubbles:true }));
    return true;
  })()`), true);
  await main.text("联调角色", "h1");
  console.log("The native Save dialog exported an editable JSON card, and the desktop re-imported it safely.");
  await main.click("聊天");
  await main.click("显示桌面宠物");
  const pet = await openPage(port, true);
  await until("the imported role in the floating pet", () => pet.evaluate(
    'document.querySelector(".pet-button")?.getAttribute("aria-label") === "和联调角色聊天"'));
  assert.equal(await pet.evaluate('document.querySelector(".pet-button").click() ?? true'), true);
  await pet.text("我在，今天想聊什么", ".pet-answer");
  await pet.fill(".pet-chat input", cancelFromMain);
  await pet.click("发送");
  await until("the floating chat request", () => held.has(cancelFromMain));
  await main.text(cancelFromMain, ".history .pending");
  await main.click("停止生成");
  await until("the floating model request to close", () => aborted.has(cancelFromMain));
  await pet.text("已停止生成", ".pet-answer");
  assert.equal(await pet.evaluate('document.querySelector(".pet-chat input").value'), cancelFromMain);
  assert.equal(await main.evaluate(`document.querySelector('.history').textContent.includes(${JSON.stringify(cancelFromMain)})`), false);

  await main.fill(".composer input", cancelFromPet);
  await main.click("发送");
  await until("the main chat request", () => held.has(cancelFromPet));
  await pet.click("停止生成");
  await until("the main model request to close", () => aborted.has(cancelFromPet));
  await main.text("已停止生成", ".history");
  assert.equal(await main.evaluate('document.querySelector(".composer input").value'), cancelFromPet);
  await main.fill(".composer input", "");
  console.log("Both windows could stop the other's in-flight model request while preserving the originating draft.");

  await pet.fill(".pet-chat input", question);
  await pet.click("发送");
  await pet.text(reply, ".pet-answer");
  await main.text(question, ".history");
  await main.text(reply, ".history");
  const chatRequest = calls.find(item => item.body.messages.at(-1)?.content === question);
  assert.equal(chatRequest?.authorized, true);
  assert.ok(chatRequest.body.messages.some(item => item.content.includes("保存后的新版")));
  assert.ok(!chatRequest.body.messages.some(item => [cancelFromMain, cancelFromPet].includes(item.content)));
  for (const [button, message, state, animation] of [
    ["投喂", "吃到啦", "feed", "pet-nibble"],
    ["摸摸", "摸摸之后", "pet", "pet-wiggle"],
    ["休息", "歇一会儿", "rest", "pet-breathe"],
  ]) {
    await pet.click(button);
    await pet.text(message, ".pet-care-status");
    assert.equal(await pet.evaluate(`(() => {
      const pet = document.querySelector('.pet[data-care="${state}"]');
      const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
      return !!pet && getComputedStyle(pet).animationName === (reducedMotion ? "none" : "${animation}");
    })()`), true, `Verify the animation for ${button}`);
  }
  assert.equal(calls.length, 4);
  console.log("The floating pet reused the role, synchronized the reply, and played the three care animations.");

  await pet.fill(".pet-chat input", failoverQuestion);
  await pet.click("发送");
  await pet.text(backupReply, ".pet-answer");
  await main.text("备用模型「窗口联调备用模型」已回复", ".history");
  assert.deepEqual(calls.filter(item => item.body.messages.at(-1)?.content === failoverQuestion)
    .map(item => [item.viaBackup, item.authorized]), [[false, true], [true, true]]);
  assert.equal(await main.evaluate(`document.querySelector('.history').textContent.split(${JSON.stringify(backupReply)}).length - 1`), 1);
  await main.fill(".composer input", stopDuringBackup);
  await main.click("发送");
  await until("the backup request before cancelling", () => held.has(stopDuringBackup));
  await pet.text("正在使用备用模型", ".pet-answer");
  await pet.click("停止生成");
  await until("the backup request to close", () => aborted.has(stopDuringBackup));
  await main.text("已停止生成", ".history");
  assert.equal(await main.evaluate('document.querySelector(".composer input").value'), stopDuringBackup);
  console.log("The desktop switched to a separate Windows credential, saved one reply, and cancelled a running backup from the other window.");

  await pet.fill(".pet-chat input", closeAndContinue);
  await pet.click("发送");
  await until("the chat started before the floating window closes", () => held.has(closeAndContinue));
  await pet.evaluate('document.querySelector(".pet-close").click()');
  await pet.closed();
  finishReply(held.get(closeAndContinue), resumedReply);
  await main.text(resumedReply, ".history");
  await main.click("显示桌面宠物");
  const reopenedPet = await openPage(port, true);
  await until("the reopened pet to render", () => reopenedPet.evaluate(`(() => {
    const button = document.querySelector(".pet-button");
    if (!button) return false;
    button.click();
    return true;
  })()`));
  await reopenedPet.text(resumedReply, ".pet-answer");
  await main.evaluate(`(() => {
    setTimeout(() => void window.__TAURI_INTERNALS__.invoke('plugin:window|close', {label:'main'}), 150);
    return true;
  })()`);
  await main.closed();
  await reopenedPet.click("主窗口");
  const returnedMain = await openPage(port, false);
  await returnedMain.text(resumedReply, ".history");
  await reopenedPet.evaluate('document.querySelector(".pet-close").click()');
  await reopenedPet.closed();

  const profileFiles = await readdir(profile);
  assert.ok(profileFiles.includes("desktop.db") && profileFiles.includes("EBWebView"),
    "SQLite and WebView data must both use the selected data directory");
  await returnedMain.fill(".composer input", interruptedQuestion);
  await returnedMain.click("发送");
  await until("the model call that's still running at application exit", () => held.has(interruptedQuestion));
  await closeApp(returnedMain);
  await until("the model connection to close on application exit", () => aborted.has(interruptedQuestion));

  const reopenedPort = await launchApp();
  const reopened = await openPage(reopenedPort, false);
  await reopened.text("联调角色", "h1");
  await reopened.text(question, ".history");
  await reopened.text(reply, ".history");
  await reopened.text(resumedReply, ".history");
  assert.equal(await reopened.evaluate(`document.querySelector('.history').textContent.includes(${JSON.stringify(interruptedQuestion)})`), false);
  const usage = await reopened.evaluate(`(async () => (await window.__TAURI_INTERNALS__.invoke('run_action', {action:'state',args:{}})).usage
    .find(row => row.model_id === ${JSON.stringify(model.id)}))()`);
  assert.deepEqual([usage.requests, usage.cancelled, usage.interrupted], [8, 2, 1]);
  const restartState = await nativeAction(reopened, "state");
  assert.equal(restartState.models.find(item => item.id === model.id).backupModelId, backupModel.id);
  assert.equal(restartState.models.find(item => item.id === model.id).budget.limits.requests.daily, 12);
  const backupUsage = restartState.usage.find(row => row.model_id === backupModel.id);
  assert.deepEqual([backupUsage.requests, backupUsage.cancelled, backupUsage.interrupted], [2, 1, 0]);
  await reopened.click("插件中心");
  await reopened.text("联调角色 · 1.1.0", ".plugin-card select");
  await reopened.click("设置");
  await reopened.click("窗口联调模型（已保存）");
  await reopened.click("测试连接");
  await reopened.text("已保存的模型配置可用");
  assert.equal(calls.at(-1)?.authorized, true);
  const beforeBudgetBlock = calls.length;
  await reopened.click("本机模型预算");
  await reopened.fill('.model-budget input[name="daily-requests"]', "0");
  await reopened.click("保存预算");
  await reopened.text("9/0 次", ".model-budget");
  await reopened.click("聊天");
  await reopened.fill(".composer input", "主窗口预算联调");
  await reopened.click("发送");
  await reopened.text("已达今日本机请求上限", ".history");
  assert.equal(await reopened.evaluate('document.querySelector(".composer input").value'), "主窗口预算联调");
  await reopened.click("显示桌面宠物");
  const budgetPet = await openPage(reopenedPort, true);
  await until("the floating pet chat button", () => budgetPet.evaluate(`(() => {
    const button = document.querySelector(".pet-button");
    if (!button) return false;
    button.click();
    return true;
  })()`));
  await budgetPet.fill(".pet-chat input", "悬浮窗预算联调");
  await budgetPet.click("发送");
  await budgetPet.text("已达今日本机请求上限", ".pet-answer");
  assert.equal(await budgetPet.evaluate('document.querySelector(".pet-chat input").value'), "悬浮窗预算联调");
  assert.equal(calls.length, beforeBudgetBlock);
  console.log("The saved model budget survived restart and blocked both desktop windows before any provider call.");
  await budgetPet.evaluate('document.querySelector(".pet-close").click()');
  await budgetPet.closed();
  await reopened.click("设置");
  await reopened.click("窗口联调模型（已保存）");
  await reopened.click("本机模型预算");
  await reopened.fill('.model-budget input[name="daily-requests"]', "12");
  await reopened.click("保存预算");
  await reopened.text("9/12 次", ".model-budget");
  await reopened.click("从个人聊天提取记忆");
  await reopened.click("提取记忆");
  await reopened.text(question, ".memory-extraction form .meta");
  await reopened.text("已新增 1 条待审候选", ".notice");
  assert.equal(calls.at(-1).authorized, true);
  assert.equal((await nativeAction(reopened, "listMemory", { roleId: "gui.fixture" })).length, 0);
  await reopened.fill(".memory-extraction textarea", "审核后保存的本机记忆。");
  await reopened.click("采纳");
  await reopened.text("记忆已保存到本机", ".notice");
  assert.equal((await nativeAction(reopened, "listMemory", { roleId: "gui.fixture" }))[0].text, "审核后保存的本机记忆。");
  console.log("The desktop extracted an evidenced candidate, applied the approved edit, and kept it in the selected role's local memory.");
  await reopened.click("核对同步账号");
  await reopened.text("读取已授权，写入已授权");
  for (const caption of ["允许手动上传我的记忆", "允许拉取我的记忆"]) {
    await until(`enabled sync preference ${caption}`, () => reopened.evaluate(`(() => {
      const field = [...document.querySelectorAll("label")].find(label => label.textContent.trim() === ${JSON.stringify(caption)});
      const control = field?.querySelector("input");
      if (!control || control.disabled) return false;
      if (!control.checked) control.click();
      return true;
    })()`));
  }
  await reopened.click("拉取预览");
  await reopened.text(sharedMemory.text);
  await reopened.click("下载为可编辑记忆");
  await reopened.text("已保存为可编辑的本地记忆", ".notice");
  assert.equal((await nativeAction(reopened, "listMemory", { roleId: "gui.fixture" }))[0].text, sharedMemory.text);
  console.log("The Windows settings verified the subscription and downloaded a remote note as editable local memory.");
  if (options.includes("--role-rehearsal")) {
    const before = await nativeAction(reopened, "history", { roleId: "gui.fixture" });
    const count = calls.length;
    await reopened.click("插件中心");
    await reopened.click("角色试演");
    await reopened.fill("details[open] textarea[required]", "给联调活动起个名字。");
    await reopened.fill("details[open] textarea:not([required])", "只在试演中使用的样本。");
    await reopened.click("运行试演");
    await reopened.text("联调角色 · 1.1.0", '[aria-label="试演结果"]');
    await reopened.text("群聊规则", '[aria-label="试演结果"]');
    await reopened.text("只在试演中使用的样本", '[aria-label="试演结果"]');
    await reopened.text(reply, '[aria-label="试演结果"]');
    assert.equal(calls.length, count + 1);
    assert.equal(calls.at(-1).authorized, true);
    assert.deepEqual(await nativeAction(reopened, "history", { roleId: "gui.fixture" }), before);
    console.log("Role rehearsal used a saved Windows model credential, displayed the result, and left the conversation unchanged.");
  }
  showSecondGroup = true;
  const explanationHistory = await nativeAction(reopened, "history", { roleId: "gui.fixture" });
  await reopened.click("显示桌面宠物");
  const summaryPet = await openPage(reopenedPort, true);
  await until("the floating pet before summary explanation", () => summaryPet.evaluate(`(() => {
    const button = document.querySelector(".pet-button");
    if (!button) return false;
    if (button.getAttribute("aria-expanded") !== "true") button.click();
    return true;
  })()`));
  await summaryPet.click("群摘要");
  await summaryPet.text(returnedSummary.content, ".pet-group-feed");
  const beforeExplanation = calls.length;
  await summaryPet.click("讲给我听");
  await summaryPet.text("窗口联调模型（已保存）", ".summary-consent");
  assert.equal(calls.length, beforeExplanation);
  await summaryPet.click("取消");
  assert.equal(calls.length, beforeExplanation);
  await summaryPet.click("讲给我听");
  await summaryPet.click("确认讲解");
  await summaryPet.text(groupExplanation, ".summary-explanation");
  assert.equal(calls.length, beforeExplanation + 1);
  assert.equal(calls.at(-1).authorized, true);
  assert.equal(calls.at(-1).viaBackup, false);
  assert.match(calls.at(-1).body.messages.at(-1).content, new RegExp(topicUpdate, "u"));
  assert.ok(!JSON.stringify(calls.at(-1).body.messages).includes(secondGroupSummary));
  assert.ok(!JSON.stringify(calls.at(-1).body.messages).includes(sharedMemory.text));
  await summaryPet.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="摘要群聊"]');
    select.value = ${JSON.stringify(secondGroup)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await summaryPet.text(secondGroupSummary, ".pet-group-feed");
  assert.equal(await summaryPet.evaluate(`document.body.textContent.includes(${JSON.stringify(groupExplanation)})`), false);
  assert.deepEqual(await nativeAction(reopened, "history", { roleId: "gui.fixture" }), explanationHistory);
  await reopened.click("群动态");
  await reopened.text(returnedSummary.content, ".pane");
  await reopened.click("讲给我听");
  await reopened.click("确认讲解");
  if (options.includes("--role-rehearsal")) {
    await reopened.text("已达今日本机请求上限", ".summary-explanation");
    assert.equal(calls.length, beforeExplanation + 1);
    await reopened.click("设置");
    await reopened.click("窗口联调模型（已保存）");
    await reopened.click("本机模型预算");
    await reopened.fill('.model-budget input[name="daily-requests"]', "14");
    await reopened.click("保存预算");
    await reopened.text("12/14 次", ".model-budget");
    await reopened.click("群动态");
    await reopened.text(returnedSummary.content, ".pane");
    await reopened.click("讲给我听");
    await reopened.click("确认讲解");
  }
  await reopened.text(groupExplanation, ".summary-explanation");
  assert.equal(calls.length, beforeExplanation + 2);
  if (options.includes("--member-profiles")) {
    await reopened.click("设置");
    await reopened.click("窗口联调模型（已保存）");
    await reopened.click("本机模型预算");
    await reopened.fill('.model-budget input[name="daily-requests"]', "16");
    await reopened.click("保存预算");
    await reopened.text("/16 次", ".model-budget");
    await reopened.click("群动态");
    await reopened.text(returnedSummary.content, ".pane");
    assert.equal(memberReads, 0, "Opening group updates must leave portrait subscriptions idle.");
    await reopened.click("拉取群友画像");
    await reopened.text(primaryPortrait.displayName, ".pane");
    await reopened.text(neighborPortrait.displayName, ".pane");
    const filter = 'label > input:not([type]):not([aria-label])';
    await reopened.fill(filter, "小林");
    await until("portrait name filter", async () => !await reopened.evaluate(
      `document.querySelector('.pane').textContent.includes(${JSON.stringify(neighborPortrait.displayName)})`));
    await reopened.click("讲讲这位群友");
    await reopened.text("127.0.0.1", ".summary-consent");
    const beforePortrait = calls.length;
    const changed = { ...primaryPortrait, summary: "后来分享了合作解谜心得。" };
    portraits = [changed, neighborPortrait];
    await reopened.click("确认讲解");
    await reopened.text("画像已更新或不可访问", ".pane");
    assert.equal(calls.length, beforePortrait);
    await reopened.click("刷新群友画像");
    await reopened.text(changed.summary, ".pane");
    await reopened.click("讲讲这位群友");
    await reopened.click("确认讲解");
    await reopened.text(memberExplanation, ".pane");
    assert.equal(calls.length, beforePortrait + 1);
    const request = calls.at(-1);
    assert.ok(request.authorized);
    assert.match(request.body.messages.at(-1).content, /后来分享了合作解谜心得/u);
    assert.doesNotMatch(JSON.stringify(request.body), /另一位群友的已发布简介/u);
    await reopened.fill('input[aria-label="QQ群成员标识"]', "2002");
    await reopened.click("查看");
    await until("both portrait reads", async () => (await reopened.evaluate(
      `Array.from(document.querySelectorAll('.profile strong')).filter(item => item.textContent === ${JSON.stringify(primaryPortrait.displayName)}).length`)) === 2);
    portraits = [neighborPortrait];
    await until("withdrawn portrait and explanation disappearing", async () => !await reopened.evaluate(
      `document.querySelector('.pane').textContent.includes(${JSON.stringify(primaryPortrait.displayName)}) ||
      document.querySelector('.pane').textContent.includes(${JSON.stringify(memberExplanation)})`), 38_000);
    await reopened.text("该成员没有可见画像", ".pane");
    await reopened.click("停止刷新");
    await reopened.text("拉取群友画像", ".pane");
    assert.deepEqual(await nativeAction(reopened, "history", { roleId: "gui.fixture" }), explanationHistory);
    console.log("Windows portrait views verified opt-in, name filtering, stale consent rejection, personal model usage, directory and direct-lookup withdrawal, and stopping refresh.");
  }
  if (options.includes("--service-profiles")) {
    await nativeAction(reopened, "setSummaryWatch", { groupId: summaryGroup, enabled: true });
    await reopened.click("设置");
    await reopened.click("窗口联调模型（已保存）");
    await reopened.click("本机模型预算");
    await reopened.fill('.model-budget input[name="daily-requests"]', "18");
    await reopened.click("保存预算");
    await reopened.text("/18 次", ".model-budget");
    await reopened.click("新增连接");
    await reopened.fill(".service-connections input[maxlength='60']", "第二台服务");
    await reopened.fill(".service-connections input[type='url']", alternativeAddress);
    await reopened.fill(".service-connections input[type='password']", alternativeToken);
    await reopened.click("保存并测试");
    const currentState = () => nativeAction(reopened, "state");
    const alternative = await until("second service saved", async () => {
      const state = await currentState();
      return state.serviceAddress === alternativeAddress && state.serviceProfiles.find(item => item.address === alternativeAddress);
    });
    const { binding: { slot } } = await nativeAction(reopened, "_credentialPlan", { slot: "service" });
    assert.match(slot, /^service-profile:/u);
    registeredCredentials.push(slot + ".OHJingJing");
    assert.doesNotMatch(JSON.stringify(await currentState()), new RegExp(alternativeToken, "u"));
    await summaryPet.text(alternativeSummary, ".pet-group-feed");
    assert.equal(await summaryPet.evaluate(`document.body.textContent.includes(${JSON.stringify(returnedSummary.content)})`), false);
    assert.deepEqual((await nativeAction(reopened, "summaryReminders")).watched, []);
    assert.deepEqual((await currentState()).memorySync, { push: false, pull: false });
    await reopened.click("群动态");
    await reopened.text(alternativeSummary, ".pane");
    await reopened.click("工作区");
    await reopened.click("配置工作区");
    await reopened.evaluate(`Array.from(document.querySelectorAll('.pane form fieldset'))
      .filter(fieldset => fieldset.querySelector('legend')?.textContent === '服务连接' && !fieldset.closest('[hidden]'))
      .flatMap(fieldset => Array.from(fieldset.querySelectorAll('input[type="checkbox"]')))
      .filter(input => !input.checked).forEach(input => input.click())`);
    await reopened.click("保存");
    await reopened.text(alternativeSummary, "[aria-label='统一消息']");
    await reopened.text(returnedSummary.content, "[aria-label='统一消息']");
    await reopened.click("用个人模型解读");
    await until("the workspace brief", async () => {
      const result = await reopened.evaluate(`(() => {
        const pane = Array.from(document.querySelectorAll('.pane')).find(item => !item.closest('[hidden]'));
        return { text: pane?.textContent ?? '', error: pane?.querySelector('[role="status"]')?.textContent };
      })()`);
      if (result.error) throw new Error(result.error);
      return result.text.includes("两个来源都有已发布的群聊摘要。");
    });
    assert.match(JSON.stringify(calls.at(-1).body), /第二台服务/u);
    console.log("The Windows workspace merged two authorized sources and produced a source-labelled brief with the personal model.");
    const beforeTask = calls.length;
    await reopened.click("开发任务");
    await reopened.text("主来源原有任务", ".pane");
    await reopened.text("第二来源原有任务", ".pane");
    const field = prefix => `Array.from(document.querySelectorAll('.pane label')).find(item => item.firstChild?.textContent.trim() === ${JSON.stringify(prefix)})?.querySelector('select')`;
    const choose = async (prefix, value) => {
      await until(`available choice ${prefix}`, () => reopened.evaluate(`(() => {
        const select = ${field(prefix)};
        if (!select || select.disabled || !Array.from(select.options).some(option => option.value === ${JSON.stringify(value)} && !option.disabled)) return false;
        select.value = ${JSON.stringify(value)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`));
      if (prefix === "来源") {
        await until("saved service source", async () => {
          const settings = await nativeAction(reopened, "workspaceSettings");
          return (settings.items.find(item => item.id === settings.activeId)?.sourceFilter ?? "") === value &&
            await reopened.evaluate(`(() => {const select=${field(prefix)}; return !!select && !select.disabled && select.value === ${JSON.stringify(value)};})()`);
        });
      }
      return true;
    };
    assert.equal(await choose("来源", alternative.id), true);
    await until("primary source task filtered out", async () => !await reopened.evaluate('document.body.textContent.includes("主来源原有任务")'));
    assert.equal(await choose("目标服务与实例", alternative.id), true);
    await reopened.fill('form textarea[maxlength="2000"]', desktopRequirement);
    if (developmentAcceptanceMode) await reopened.fill('form textarea[maxlength="1000"]', desktopAcceptance);
    await reopened.click("提交需求");
    await reopened.text("已受理 ·", ".pane");
    await reopened.text(desktopRequirement, ".pane");
    assert.equal(firstDevelopment.items.length, 1);
    assert.equal(secondDevelopment.items.length, 2);
    if (developmentAcceptanceMode) {
      assert.equal(secondDevelopment.items[0].acceptance, desktopAcceptance);
      assert.ok(await reopened.evaluate(`Array.from(document.querySelectorAll(".pane details")).some(item => item.textContent.includes(${JSON.stringify(desktopAcceptance)}))`));
    }
    assert.equal(calls.length, beforeTask);
    assert.equal(await choose("来源", ""), true);
    alternativeTasksAvailable = false;
    await until("failed source tasks hidden", () => reopened.evaluate(`!document.body.textContent.includes(${JSON.stringify(desktopRequirement)}) &&
      document.body.textContent.includes('主来源原有任务')`), 14_000);
    alternativeTasksAvailable = true;
    await reopened.text(desktopRequirement, ".pane");
    console.log("Workspace tasks were filtered by source and submitted with the selected server credential and instance.");
    assert.equal(await choose("来源", "legacy"), true);
    assert.equal(await choose("会话", `legacy/${summaryGroup}`), true);
    const incompatible = await until("newer desktop feature visible with its version requirement", () => reopened.evaluate(`(() => {
      const label=${JSON.stringify("未来会话功能 · 需要 0.9.0")};
      const pane=document.querySelector('.pane');
      if (!pane?.textContent.includes(label)) return false;
      const nearest=Array.from(pane.querySelectorAll('*')).filter(element => element.textContent?.includes(label) &&
        !Array.from(element.children).some(child => child.textContent?.includes(label)));
      return nearest.map(element => ({ tag: element.tagName, disabled: element.disabled, type: element.type }));
    })()`));
    assert.deepEqual(incompatible, [{ tag: "BUTTON", disabled: true, type: "button" }]);
    const openTestFeature = async () => {
      const previous = workspaceFeatureReads.length;
      try {
        await until("enabled feature in selected conversation", () => reopened.evaluate(`(() => {
          const button = [...document.querySelectorAll('.pane button')].find(item => !item.closest('[hidden]') && item.textContent.trim() === ${JSON.stringify("本周话题")});
          if (!button || button.disabled) return false;
          button.click(); return true;
        })()`));
        await until("scoped feature request", () => workspaceFeatureReads.length > previous);
        assert.deepEqual(workspaceFeatureReads.slice(previous), [{ status: 200, expectedScope: true }]);
        await reopened.text("当前群的合成话题", ".pane");
      } catch (error) {
        const view = await reopened.evaluate(`({ notices: Array.from(document.querySelectorAll('.pane [role=status]'), element => element.textContent),
          source: (${field("来源")})?.selectedIndex, conversation: (${field("会话")})?.selectedIndex,
          features: Array.from(document.querySelectorAll('.pane .tools button'), item => ({ label:item.textContent.trim(), disabled: item.disabled })) })`);
        throw new Error(`${error.message}; response=${JSON.stringify(workspaceFeatureReads.slice(previous))}; view=${JSON.stringify(view)}`);
      }
    };
    await openTestFeature();
    summaryAccessRevoked = true;
    await reopened.click("刷新消息");
    await until("withdrawn conversation clears its feature view", () => reopened.evaluate(`!document.body.textContent.includes('当前群的合成话题')`));
    summaryAccessRevoked = false;
    await reopened.click("刷新消息");
    await openTestFeature();
    workspaceFeaturePublished = false;
    await reopened.click("刷新消息");
    await until("rolled-back feature and payload removed", () => reopened.evaluate(`!document.body.textContent.includes('当前群的合成话题') &&
      !Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === '本周话题')`));
    console.log("Workspace catalog opened a scoped service feature, gated a newer client requirement, and removed the rolled-back feature.");
    await reopened.click("设置");
    const selectConnection = id => until("editable saved connection choice", () => reopened.evaluate(`(() => {
      const select = document.querySelector('.service-connections select');
      const id = ${JSON.stringify(id)};
      if (!select || select.disabled || !Array.from(select.options).some(option => option.value === id)) return false;
      select.value = id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`));
    await selectConnection("legacy");
    await until("legacy credential reused", async () => (await currentState()).activeServiceProfile === "legacy");
    await summaryPet.text(returnedSummary.content, ".pet-group-feed");
    assert.deepEqual((await nativeAction(reopened, "summaryReminders")).watched, [summaryGroup]);
    await selectConnection("");
    await until("local-only mode", async () => (await currentState()).serviceAddress === "");
    await summaryPet.text("在主窗口的设置中配置群动态订阅", ".pet-group-feed");
    assert.ok((await currentState()).models.some(item => item.id === model.id));
    await selectConnection(alternative.id);
    await until("second credential reused", async () => (await currentState()).activeServiceProfile === alternative.id);
    await summaryPet.text(alternativeSummary, ".pet-group-feed");
    await reopened.evaluate("window.confirm = () => true");
    await reopened.click("移除当前连接");
    await until("removed service is disconnected", async () => {
      const state = await currentState();
      return !state.serviceAddress && state.serviceProfiles.length === 1 && state.serviceProfiles[0].id === "legacy";
    });
    await selectConnection("legacy");
    await until("restored legacy subscription", async () => (await currentState()).activeServiceProfile === "legacy");
    await reopened.click("群动态");
    await reopened.text(returnedSummary.content, ".pane");
    assert.ok(alternativeReads > 0);
    assert.equal(alternativeWrongToken, false);
    console.log("Both Windows switched saved subscriptions with independent system credentials, scoped watches, local-only mode and connection removal.");
  }
  await summaryPet.click("讲给我听");
  await summaryPet.text("窗口联调模型（已保存）", ".summary-consent");
  holdNextGroupFeed = true;
  await reopened.click("刷新");
  const pendingFeed = await until("previously authorized group feed in flight", () => heldGroupFeed);
  assert.match(pendingFeed.response, new RegExp(returnedSummary.content, "u"));
  const previousModelCalls = calls.length;
  subscriptionRevoked = true;
  await summaryPet.click("确认讲解");
  await reopened.text("服务端订阅已失效");
  await summaryPet.text("群动态订阅已失效", ".pet-group-feed");
  pendingFeed.res.end(pendingFeed.response);
  await until("both windows continue to hide a delayed group response", async () =>
    (await nativeAction(reopened, "state")).memorySync.pull === false &&
    await reopened.evaluate("document.querySelector('.summary-explanation') === null") &&
    await summaryPet.evaluate("document.querySelector('.pet-summary-body') === null"));
  assert.equal(calls.length, previousModelCalls);
  assert.equal(await reopened.evaluate('document.querySelector(".summary-explanation") !== null'), false);
  assert.equal(await summaryPet.evaluate('document.querySelector(".summary-explanation") !== null'), false);
  subscriptionRevoked = false;
  await summaryPet.evaluate('document.querySelector(".pet-close").click()');
  await summaryPet.closed();
  console.log("Both windows cleared revoked group content even when an earlier authorized response arrived late.");
  if (balanceMode) {
    await reopened.click("设置");
    await reopened.click(balanceModel.name);
    await reopened.text("剩余 18", ".form-grid ~ .profile");
    assert.equal(balanceQueries, 1);
    balanceFailure = true;
    await reopened.click("刷新余额");
    await reopened.text("供应商查询暂时不可用", ".form-grid ~ .profile");
    await reopened.text("上次成功结果", ".form-grid ~ .profile");
    await reopened.text("剩余 18", ".form-grid ~ .profile");
    assert.equal(balanceQueries, 2);
    await reopened.fill('.form-grid input[type="password"]', rotatedBalanceKey);
    await reopened.click("保存模型");
    await reopened.text("模型已保存。");
    const { binding } = await nativeAction(reopened, "_credentialPlan", { slot: "model:" + balanceModel.id });
    assert.notEqual(binding.slot, "model:" + balanceModel.id);
    registeredCredentials.push(binding.slot + ".OHJingJing");
    assert.equal(await reopened.evaluate('document.querySelector(".form-grid ~ .profile") === null'), true);
    balanceFailure = false;
    await reopened.click("刷新余额");
    await reopened.text("剩余 27", ".form-grid ~ .profile");
    assert.equal(balanceQueries, 3);
    console.log("Desktop quota remained scoped to the saved key, survived restart, displayed its previous success on failure, and reset after rotation.");
  }
  if (removalMode) {
    await reopened.click("设置");
    await reopened.click(backupModel.name);
    const currentState = () => nativeAction(reopened, "state");
    const slot = async id => (await nativeAction(reopened, "_credentialPlan", { slot: "model:" + id })).binding.slot;
    const target = (await slot(backupModel.id)) + ".OHJingJing";
    const unrelated = (await slot(model.id)) + ".OHJingJing";
    const before = await currentState();
    assert.equal(before.models.find(item => item.id === model.id).backupModelId, backupModel.id);
    assert.ok(Number(sessionCredential(target, null, true)) > 0);
    await reopened.evaluate("window.confirm = () => true");
    await reopened.click("清除本机 API Key");
    await reopened.text("本机 API Key 已清除。");
    const cleared = await currentState();
    assert.equal(cleared.models.find(item => item.id === backupModel.id).hasKey, false);
    assert.equal(cleared.models.find(item => item.id === model.id).backupModelId, null);
    assert.equal(cleared.pendingModelKeyRemovals, 0);
    assert.equal(sessionCredential(target, null, true), "0");
    assert.ok(Number(sessionCredential(unrelated, null, true)) > 0);
    await reopened.fill('.form-grid input[type="password"]', randomUUID());
    await reopened.click("保存模型");
    await reopened.text("模型已保存。");
    const replacement = (await slot(backupModel.id)) + ".OHJingJing";
    registeredCredentials.push(replacement);
    assert.ok(Number(sessionCredential(replacement, null, true)) > 0);
    await reopened.click("移除模型档案");
    await reopened.text("模型档案已移除。");
    const after = await currentState();
    assert.ok(after.models.every(item => item.id !== backupModel.id));
    assert.deepEqual(after.usage, before.usage);
    assert.equal(sessionCredential(replacement, null, true), "0");
    const pending = { ...model, id: "removal-pending-" + randomUUID(), name: "等待清理档案" };
    seedModel(pending, randomUUID());
    const pendingSlot = "model:" + pending.id;
    const queued = run(join(bundle, "node.exe"), [join(bundle, "runtime.mjs"), profile], JSON.stringify({
      action: "clearModelKey", args: { modelId: pending.id }, binding: { slot: pendingSlot, origin: model.baseUrl },
    }) + "\n");
    assert.equal(JSON.parse(queued).ok, true);
    assert.ok(Number(sessionCredential(pendingSlot + ".OHJingJing", null, true)) > 0);
    assert.equal((await currentState()).pendingModelKeyRemovals, 0);
    assert.equal(sessionCredential(pendingSlot + ".OHJingJing", null, true), "0");
    const primary = after.models.find(item => item.id === model.id);
    await nativeAction(reopened, "saveModelBudget", { modelId: model.id, currency: primary.currency,
      requests: { daily: null, monthly: null }, cost: { daily: null, monthly: null } });
    const prompt = "移除备用档案后保留的个人聊天";
    const callCount = calls.length;
    await reopened.click("聊天");
    await reopened.fill(".composer input", prompt);
    await reopened.click("发送");
    await reopened.text(prompt, ".history");
    assert.equal(calls.length, callCount + 1);
    assert.equal(calls.at(-1).authorized, true);
    assert.equal(calls.at(-1).viaBackup, false);
    console.log("Windows Credential Manager verified both Key retirement and model removal, with backup links cleared, historical usage preserved and pending cleanup retried.");
  }
  await closeApp(reopened);
  console.log("Restart preserved the role, model settings and conversation in the selected data directory.");
}

async function verifyLiveWorkspace({ address, token: subscription, scope }) {
  const readLiveGroups = () => fetch(`${address}/api/groups`, {
    headers: { Authorization: `Bearer ${subscription}` }, signal: AbortSignal.timeout(4000),
  });
  const response = await readLiveGroups();
  assert.equal(response.status, 200);
  const { groups } = await response.json();
  assert.ok(groups.length === 1 && groups[0].id === scope && groups[0].summary?.content?.trim(),
    "The live subscription must expose one group with an authorized summary");
  const liveText = groups[0].summary.content;
  const [, account, group] = scope.split(":");
  const label = groups[0].profile?.displayName || group;
  const { createGroupService } = await import("../runtime/group-service.ts");
  const adminToken = randomUUID();
  const database = join(scratch, "isolated-workspace.db");
  const isolated = createGroupService({ database, adminToken, observeGroups: [group], summaryGroups: [group] });
  const records = new DatabaseSync(database);
  const olderMessage = "隔离来源归档的测试消息";
  const newMessage = "桌宠关闭后隔离来源收到的新消息";
  const oldSummary = "隔离来源已发布的摘要";
  const newSummary = "桌宠关闭后隔离来源发布的新摘要";
  const isolatedProfile = "隔离服务单独发布的群画像";
  const liveId = randomUUID();
  const isolatedId = randomUUID();
  const liveName = "真实 QQ 来源";
  const isolatedName = "隔离测试来源";
  const feed = "[aria-label='统一消息']";
  const connection = "[aria-label='连接状态']";
  const seenCursors = [];
  let offline = false;
  let nextCursor;
  let port;
  const gate = createServer(async (req, res) => {
    try {
      const request = new URL(req.url, "http://127.0.0.1");
      if (request.pathname === "/api/workspace/feed") seenCursors.push(request.searchParams.get("cursor"));
      if (offline) { res.writeHead(503).end(); return; }
      const reply = await fetch(`http://127.0.0.1:${port}${request.pathname}${request.search}`, {
        headers: { Authorization: req.headers.authorization ?? "" }, signal: AbortSignal.timeout(3000),
      });
      const data = await reply.json();
      if (request.pathname === "/api/workspace/feed" && reply.ok) nextCursor = data.cursor;
      res.writeHead(reply.status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    } catch { res.writeHead(502).end(); }
  });
  function publish(id, message, summary, at) {
    const event = String(id);
    records.prepare("INSERT INTO channel_events VALUES (?,?,?,?,?,?)").run(account, event, at, scope, "2002", "隔离样本群友");
    records.prepare("INSERT INTO group_messages VALUES (?,?,?,?,?,?)").run(id, scope, "2002", message, at, event);
    records.prepare("INSERT INTO group_summaries(scope,first_id,last_id,content,created_at) VALUES (?,?,?,?,?)")
      .run(scope, id, id, summary, at);
  }
  const contains = (page, content, selector = feed) => page.evaluate(
    `!!document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(content)})`);
  const choose = (page, label, value) => until(`workspace control ${label}`, () => page.evaluate(`(() => {
    const control = [...document.querySelectorAll('.pane label')].find(item =>
      item.firstChild?.textContent.trim() === ${JSON.stringify(label)})?.querySelector('select');
    const value = ${JSON.stringify(value)};
    if (!control || control.disabled || ![...control.options].some(option => option.value === value)) return false;
    control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`));
  try {
    port = await listenerPort(isolated.server);
    const isolatedAddress = `http://127.0.0.1:${await listenerPort(gate)}`;
    const administer = (path, method, data) => fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" }, body: JSON.stringify(data) });
    publish(1, olderMessage, oldSummary, new Date(Date.now() - 10_000).toISOString());
    assert.equal((await administer("/admin/profiles", "PUT", { scope, subject: "group", displayName: label, summary: isolatedProfile })).status, 200);
    const grant = await administer("/admin/subscribers", "POST", { qqId: "2003", groups: [scope], messageGroups: [scope] });
    assert.equal(grant.status, 201);
    const { token } = await grant.json();

    await extractApplication();
    let main = await openPage(await launchApp(), false);
    await main.text("本地陪伴");
    const liveSource = { id: liveId, name: liveName, address };
    const isolatedSource = { id: isolatedId, name: isolatedName, address: isolatedAddress };
    async function connect(source, secret) {
      await nativeAction(main, "saveServiceProfile", source, secret);
      const { binding } = await nativeAction(main, "_credentialPlan", { slot: `service-profile:${source.id}` });
      registeredCredentials.push(binding.slot + ".OHJingJing");
    }
    await connect(liveSource, subscription);
    await connect(isolatedSource, token);
    const workspace = await nativeAction(main, "saveWorkspace", { name: "真实与隔离联调", sourceIds: [liveId, isolatedId],
      reminders: { paused: false, quietHours: false, quietStart: "22:00", quietEnd: "07:00", intervalMinutes: 0 } });
    const otherWorkspace = await nativeAction(main, "saveWorkspace", { name: "仅关注真实群", sourceIds: [liveId] });
    await nativeAction(main, "selectWorkspace", { id: workspace.activeId });
    const liveState = await nativeAction(main, "syncWorkspaceSource", { id: liveId });
    assert.equal(liveState.state, "ready");
    assert.ok(liveState.conversations.length === 1 && liveState.conversations[0].id === scope && !liveState.conversations[0].messageAccess);
    assert.ok(liveState.items.some(item => item.kind === "summary") && liveState.items.every(item => item.kind === "summary"));
    assert.equal((await nativeAction(main, "syncWorkspaceSource", { id: isolatedId })).state, "ready");
    await nativeAction(main, "watchWorkspaceConversation", { workspaceId: workspace.activeId, sourceId: isolatedId, conversationId: scope, enable: true });
    await closeApp(main);

    main = await openPage(await launchApp(), false);
    await main.click("工作区");
    await until("both source summaries in one Windows workspace", async () => await contains(main, liveText) && await contains(main, oldSummary));
    await main.text(olderMessage, feed);
    await main.text(liveName, feed);
    await main.text(isolatedName, feed);
    await choose(main, "来源", isolatedId);
    await until("source filter only displays the isolated source", async () =>
      await contains(main, oldSummary) && !await contains(main, liveText));
    await choose(main, "来源", "");
    await until("both sources after clearing the source filter", () => contains(main, liveText));
    await choose(main, "当前工作区", otherWorkspace.activeId);
    await until("only the authorized real source in the second workspace", async () =>
      await contains(main, liveText) && !await contains(main, oldSummary));
    await choose(main, "当前工作区", workspace.activeId);
    await main.text(oldSummary, feed);
    const cursorBefore = nextCursor;
    assert.match(cursorBefore, /^[a-f0-9]{24}\.[1-9]\d*$/u);

    offline = true;
    await main.click("刷新消息");
    await main.text(`${isolatedName} · 待同步或连接中断`, connection);
    await main.text(`${liveName} · 在线`, connection);
    const stillOnline = await nativeAction(main, "syncWorkspaceSource", { id: liveId });
    assert.equal(stillOnline.state, "ready");
    assert.ok(stillOnline.syncedAt > liveState.syncedAt);
    await closeApp(main);

    publish(2, newMessage, newSummary, new Date().toISOString());
    const beforeReopen = seenCursors.length;
    offline = false;
    const reopenedPort = await launchApp();
    main = await openPage(reopenedPort, false);
    await main.click("工作区");
    await main.text(newMessage, feed);
    await main.text(newSummary, feed);
    assert.ok(seenCursors.slice(beforeReopen).includes(cursorBefore), "The revived source must resume its retained event cursor");
    const repeated = await nativeAction(main, "syncWorkspaceSource", { id: isolatedId });
    assert.equal(repeated.items.filter(item => item.kind === "summary" && item.summary.content === newSummary).length, 1);
    assert.equal(repeated.items.filter(item => item.kind === "message" && item.message.text === newMessage).length, 1);
    assert.ok(await contains(main, liveText));
    await main.click("显示桌面宠物");
    const pet = await openPage(reopenedPort, true);
    await until("isolated-source summary reminder", () => pet.evaluate(`(() => {
      const button = [...document.querySelectorAll('.pet-activity')].find(item =>
        item.textContent.startsWith(${JSON.stringify(isolatedName + " · ")}) && item.textContent.endsWith('有新摘要'));
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`));
    await until("the reminder opens the isolated conversation with the shared identifier", async () =>
      await contains(main, newSummary) && !await contains(main, liveText) && await main.evaluate(
        `[...document.querySelectorAll('.pane select')].some(control => control.value === ${JSON.stringify(`${isolatedId}/${scope}`)})`));
    await main.click("查看已发布画像");
    await main.text(isolatedProfile, "[aria-label='会话画像']");

    console.log("OHJINGJING_LIVE_REVOKE_NOW");
    await until("the real source revokes the temporary subscription", async () => (await readLiveGroups()).status === 401, 20_000);
    await main.click("刷新消息");
    await main.text(`${liveName} · 订阅权限失效`, connection);
    await main.text(`${isolatedName} · 在线`, connection);
    await main.text(isolatedProfile, "[aria-label='会话画像']");
    const revoked = await nativeAction(main, "syncWorkspaceSource", { id: liveId });
    assert.equal(revoked.state, "unauthorized");
    assert.equal(revoked.items.length, 0);
    const replacement = await administer("/admin/subscribers", "POST", { qqId: "2004", groups: [] });
    assert.equal(replacement.status, 201);
    await connect(isolatedSource, (await replacement.json()).token);
    await main.click("刷新消息");
    await until("a replacement connection identity hides former data and portraits", async () =>
      !await contains(main, newMessage) && !await contains(main, newSummary) &&
      !await contains(main, isolatedProfile, "[aria-label='会话画像']"));
    const replaced = await nativeAction(main, "syncWorkspaceSource", { id: isolatedId });
    assert.equal(replaced.state, "ready");
    assert.equal(replaced.items.length, 0);
    assert.equal(replaced.conversations.length, 0);
    await pet.evaluate('document.querySelector(".pet-close").click()');
    await pet.closed();
    await closeApp(main);
    console.log("Windows verified two sources, filters and workspace switching, independent outages, deduplicated cursor catch-up, exact pet reminder routing, revocation and identity replacement.");
  } finally {
    if (gate.listening) await new Promise(resolve => gate.close(resolve));
    records.close();
    await isolated.stop();
  }
}

async function verifyWorkspaceConversations() {
  await extractApplication();
  const secondary = randomUUID();
  let port = await launchApp();
  let main = await openPage(port, false);
  await main.text("本地陪伴");
  await until("the unsigned fixture can open without an updater channel", () => main.evaluate(
    'window.__TAURI_INTERNALS__.invoke("check_desktop_update").then(() => false).catch(error => String(error).includes("桌宠更新渠道尚未配置"))'));
  await nativeAction(main, "saveService", { address: model.baseUrl }, subscriptionToken);
  const remember = async slot => {
    const plan = await nativeAction(main, "_credentialPlan", { slot });
    registeredCredentials.push(plan.binding.slot + ".OHJingJing");
  };
  await remember("service");
  await nativeAction(main, "saveServiceProfile", { id: secondary, name: "第二来源", address: alternativeAddress }, alternativeToken);
  await remember(`service-profile:${secondary}`);
  await nativeAction(main, "saveWorkspace", { id: "default", name: "日常", sourceIds: ["legacy", secondary] });
  const additional = await nativeAction(main, "saveWorkspace", { name: "另一工作区", sourceIds: ["legacy"] });
  await nativeAction(main, "selectWorkspace", { id: "default" });
  await closeApp(main);
  port = await launchApp();
  main = await openPage(port, false);
  const field = label => `[...document.querySelectorAll('.pane label')].find(label => label.firstChild?.textContent.trim() === ${JSON.stringify(label)})?.querySelector('select')`;
  async function choose(label, value) {
    await until(`source conversation ${label}`, () => main.evaluate(`(() => {
      const select = ${field(label)};
      const value = ${JSON.stringify(value)};
      if (!select || select.disabled || ![...select.options].some(option => option.value === value && !option.disabled)) return false;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`));
  }
  const confirmFilter = (value) => until("the saved workspace source filter", () => main.evaluate(`(() => {
    const select = ${field("来源")};
    return select && !select.disabled && select.value === ${JSON.stringify(value)};
  })()`));
  await main.click("工作区");
  await main.text(initialSummary.content, "[aria-label='统一消息']");
  await main.text(alternativeSummary, "[aria-label='统一消息']");
  const portraitSelector = "[aria-label='会话画像']";
  await choose("会话", `legacy/${summaryGroup}`);
  assert.equal(memberReads, 0);
  await main.click("查看已发布画像");
  await main.text(primaryPortrait.summary, portraitSelector);
  await main.text("合成群数据", portraitSelector);
  await choose("来源", secondary);
  await confirmFilter(secondary);
  await choose("会话", `${secondary}/${summaryGroup}`);
  await main.click("查看已发布画像");
  await main.text("第二来源发布的同名群友画像", portraitSelector);
  await main.text("第二来源的群画像", portraitSelector);
  const shown = await main.evaluate(`document.querySelector(${JSON.stringify(portraitSelector)}).textContent`);
  assert.doesNotMatch(shown, /服务内部字段|合作解谜心得/u);
  await main.click("配置工作区");
  await until("workspace reminder settings toggle", () => main.evaluate(`(() => {
    const checkbox = [...document.querySelectorAll('.pane form label')]
      .find(label => label.textContent.includes('使用本工作区的提醒设置'))?.querySelector('input[type=checkbox]');
    if (!checkbox) return false;
    if (!checkbox.checked) checkbox.click();
    return true;
  })()`));
  await choose("提醒频率", "15");
  await main.click("保存");
  await until("workspace reminder frequency stored", async () => {
    const settings = await nativeAction(main, "workspaceSettings");
    return settings.items.find(item => item.id === "default")?.reminders?.intervalMinutes === 15;
  });
  await choose("当前工作区", additional.activeId);
  await confirmFilter("");
  await choose("来源", "legacy");
  await confirmFilter("legacy");
  await choose("当前工作区", "default");
  await confirmFilter(secondary);
  for (const [workspaceId, sourceId] of [["default", "legacy"], ["default", secondary], [additional.activeId, "legacy"]]) {
    await nativeAction(main, "watchWorkspaceConversation", { workspaceId, sourceId, conversationId: summaryGroup, enable: true });
  }
  await closeApp(main);

  const at = new Date(Date.now() + 1000).toISOString();
  summaries = [{ id: 77, content: "主来源在关闭后生成的新摘要", created_at: at }];
  alternateWorkspaceSummary = { id: 77, content: "第二来源在关闭后生成的新摘要", created_at: at };
  port = await launchApp();
  main = await openPage(port, false);
  await main.click("工作区");
  await confirmFilter(secondary);
  const settings = await nativeAction(main, "workspaceSettings");
  assert.equal(settings.items.find(item => item.id === "default").reminders.intervalMinutes, 15);
  assert.equal(settings.items.find(item => item.id === additional.activeId).sourceFilter, "legacy");
  await main.click("显示桌面宠物");
  const pet = await openPage(port, true);
  await pet.click("2 个会话有新摘要");
  await pet.text("第二来源 · 联调群", "[aria-label='工作区摘要提醒']");
  await pet.click("第二来源 · 联调群");
  const feed = "[aria-label='统一消息']";
  const scopedFeed = (selectedId, expected, excluded) => until("the reminder opens its exact source conversation", () => main.evaluate(`(() => {
    const visible = document.querySelector(${JSON.stringify(feed)});
    return visible && !visible.closest('[hidden]') && visible.textContent.includes(${JSON.stringify(expected)}) &&
      !visible.textContent.includes(${JSON.stringify(excluded)}) && [...document.querySelectorAll('.pane select')]
        .some(select => select.value === ${JSON.stringify(`${selectedId}/${summaryGroup}`)});
  })()`));
  await scopedFeed(secondary, alternateWorkspaceSummary.content, summaries[0].content);
  await pet.click("默认连接 · 联调群");
  await scopedFeed("legacy", summaries[0].content, alternateWorkspaceSummary.content);
  await until("displayed workspace reminders acknowledged", async () => (await nativeAction(main, "workspaceNotices")).length === 0);
  assert.equal((await nativeAction(main, "workspaceSettings")).items.find(item => item.id === "default").sourceFilter, secondary);

  await choose("来源", secondary);
  await confirmFilter(secondary);
  await choose("会话", `${secondary}/${summaryGroup}`);
  await main.click("查看已发布画像");
  await main.text("第二来源发布的同名群友画像", portraitSelector);
  alternateWorkspaceRevoked = true;
  await main.click("刷新消息");
  await main.text("第二来源 · 订阅权限失效", "[aria-label='连接状态']");
  assert.equal(await main.evaluate(`document.querySelector(${JSON.stringify(portraitSelector)}) === null`), true);
  await choose("来源", "legacy");
  await confirmFilter("legacy");
  await choose("会话", `legacy/${summaryGroup}`);
  await main.click("查看已发布画像");
  await main.text(primaryPortrait.summary, portraitSelector);
  assert.equal(calls.length, 0);
  assert.equal(alternativeWrongToken, false);
  await pet.evaluate('document.querySelector(".pet-close").click()');
  await pet.closed();
  await closeApp(main);
  console.log("Windows verified persisted workspace source and frequency, same-name profile isolation, grouped reminder destinations and independent revocation.");
}

async function verifyDevelopmentControls() {
  await extractApplication();
  let main = await openPage(await launchApp(), false);
  await main.text("本地陪伴");
  const secondary = randomUUID();
  await nativeAction(main, "saveService", { address: model.baseUrl }, subscriptionToken);
  const firstKey = await nativeAction(main, "_credentialPlan", { slot: "service" });
  registeredCredentials.push(firstKey.binding.slot + ".OHJingJing");
  await nativeAction(main, "saveServiceProfile", { id: secondary, name: "第二来源", address: alternativeAddress }, alternativeToken);
  const secondKey = await nativeAction(main, "_credentialPlan", { slot: `service-profile:${secondary}` });
  registeredCredentials.push(secondKey.binding.slot + ".OHJingJing");
  await nativeAction(main, "saveWorkspace", { id: "default", name: "隔离联调", sourceIds: ["legacy", secondary] });
  await closeApp(main);
  main = await openPage(await launchApp(), false);
  await main.click("工作区");
  await main.click("开发任务");
  await main.text("主来源原有任务", ".pane");
  await main.text("第二来源原有任务", ".pane");
  await main.click("取消任务");
  await main.text("任务已取消。", ".pane");
  await main.click("重试任务");
  await main.text("任务已重新排队。", ".pane");
  assert.deepEqual(acted, [
    { target: firstDevelopment.target, action: "cancel", id: firstDevelopment.items[0].id },
    { target: secondDevelopment.target, action: "retry", id: secondDevelopment.items[0].id },
  ]);
  assert.equal(alternativeWrongToken, false);
  assert.equal(calls.length, 0);
  await closeApp(main);
  console.log("The extracted Windows app used the original connection and credential to cancel and retry separate tasks.");
}

try {
  model.baseUrl = `http://127.0.0.1:${await listenerPort(provider)}`;
  if (balanceMode) {
    const preload = join(scratch, "quota-fixture.mjs");
    await writeFile(preload, "const original = globalThis.fetch;\n" +
      "globalThis.fetch = (url, init) => original(url === 'https://openrouter.ai/api/v1/key' ? " +
      JSON.stringify(model.baseUrl + "/fixture/key-quota") + " : url, init);\n");
    env.NODE_OPTIONS = [env.NODE_OPTIONS, "--import=" + pathToFileURL(preload).href].filter(Boolean).join(" ");
  }
  if (workspaceConversationMode || developmentControlsMode || options.includes("--service-profiles") || previousInstaller && updateDirectory) {
    alternativeAddress = `http://127.0.0.1:${await listenerPort(alternativeService)}`;
  }
  if (live?.verifyWorkspace) await verifyLiveWorkspace(live);
  else if (live) await verifyLiveSubscription(live);
  else if (freshInstallMode) await verifyFreshInstall();
  else if (previousInstaller) await verifyInstallLifecycle();
  else if (updateDirectory) await verifySignedUpdate(updateDirectory);
  else if (workspaceConversationMode) await verifyWorkspaceConversations();
  else if (developmentControlsMode) await verifyDevelopmentControls();
  else await verifyExtractedApplication();
} finally {
  for (const socket of sockets) socket.terminate();
  if (app?.pid && app.exitCode === null && app.signalCode === null) {
    const closed = once(app, "exit");
    spawnSync("taskkill.exe", ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 });
    await Promise.race([closed, delay(4000)]);
  }
  try {
    for (const target of registeredCredentials) sessionCredential(target, null);
  } finally {
    try {
      if (installation && !updateInstallPending) {
        runInstallerProbe("cleanup", ...(installation.ManufacturerExisted ? [] : ["-RemoveEmptyManufacturer"]));
      }
    } finally {
      await new Promise(resolve => provider.close(resolve));
      if (alternativeService.listening) await new Promise(resolve => alternativeService.close(resolve));
    }
    if (updateInstallPending) {
      console.error(`Installer handoff did not settle. The isolated test directory was retained at ${scratch}.`);
    } else {
      const absoluteScratch = await realpath(scratch);
      assert.equal(dirname(absoluteScratch), await realpath(dataRoot));
      await rm(absoluteScratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }
}

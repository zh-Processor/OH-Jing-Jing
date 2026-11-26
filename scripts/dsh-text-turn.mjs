import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const cancellation = new AbortController();
const initial = once(lines, "line");
let receivedTurn = false;
lines.on("line", () => {
  if (receivedTurn) cancellation.abort();
  receivedTurn = true;
});
lines.once("close", () => cancellation.abort());
const [first] = await initial;
const turn = JSON.parse(first);
const { profile, key, messages } = turn;
const images = Array.isArray(turn.images) ? turn.images : [];
const sdk = process.env.OHJINGJING_DSH_SDK_ROOT;
if (!sdk || !profile?.model || !key || !Array.isArray(messages)) throw new Error("Invalid DSH turn binding");
const { DeepSeekHarness } = await import(pathToFileURL(resolve(sdk, "node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js")).href);

const cwd = process.cwd();
const home = join(cwd, "state");
await mkdir(home, { recursive: true });
const config = join(cwd, "runtime.patch.yml");
const system = messages.filter(item => item.role === "system").map(item => item.content).join("\n\n");
const conversation = messages.filter(item => item.role !== "system");
const thinkingFormat = turn.thinkingFormat === "deepseek" || turn.thinkingFormat === "openrouter" ? turn.thinkingFormat : undefined;
const groupHistory = typeof turn.groupHistoryUrl === "string";
const historyEndpoint = groupHistory ? turn.groupHistoryUrl : turn.privateHistoryUrl;
const historyUrl = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[a-f0-9-]{36}$/u.test(historyEndpoint ?? "") ? historyEndpoint : undefined;
const disabled = ["tool-fs", "tool-working-directory", "persistent-bash", "persistent-pwsh", ...(historyUrl ? ["mcp-resources"] : [])];
await writeFile(config, JSON.stringify([
  { insert: [{ id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers: { "ohjingjing-turn": {
    apiKeyEnv: "OHJINGJING_DSH_TURN_KEY", api: "openai-completions", baseURL: profile.baseUrl,
    models: [{ id: profile.model, contextWindow: 128000,
      ...(images.length ? { input: ["text", "image"] } : {}),
      ...(thinkingFormat ? { compat: { thinkingFormat }, reasoningEfforts: { max: thinkingFormat === "openrouter" ? "xhigh" : "max" } } : {}) }],
    retryPolicy: { mode: "normal", maxRetries: 0 },
  } } } }, { id: "credentials", name: "@deepseek-ai/dsh-credentials-local" }] },
  { id: "system-prompt", config: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: system } },
  { id: "sandbox-policy", config: { mode: "read-only", workspaceRoot: cwd } },
  ...(historyUrl ? [{ insert: [{ id: groupHistory ? "qq-group-history" : "qq-private-history", name: "@deepseek-ai/dsh-mcp-client", config: {
    serverName: groupHistory ? "qq_group" : "qq_private", transport: "streamable-http", url: historyUrl, headers: {}, startupTimeoutMs: 1800,
    toolCallTimeoutMs: 1500, closeTimeoutMs: 1000, failOnStartupError: true,
  } }] }] : []),
  ...disabled.map(id => ({ id, disabled: true })),
]));

const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(?:SystemRoot|windir|ComSpec|Path|PATHEXT|SystemDrive|OS|TEMP|TMP|HTTPS_PROXY|NO_PROXY|SSL_CERT_FILE)$/iu.test(name)));
const harness = new DeepSeekHarness({ profile: "sdk-minimal", cwd, processCwd: cwd, dshHome: home, patches: [config],
  provider: "ohjingjing-turn", model: profile.model, maxTokens: turn.maxTokens ?? 1500, initializeTimeoutMs: 10_000,
  ...(thinkingFormat ? { reasoningEffort: "max" } : {}),
  env: { ...environment, DSH_PRIMARY_RUNTIME: "", DSH_TELEMETRY: "0", OHJINGJING_DSH_TURN_KEY: key },
});
const deadline = AbortSignal.timeout(turn.timeoutMs ?? 25_000);
const signal = AbortSignal.any([deadline, cancellation.signal]);
const interrupt = () => { void harness.close().catch(() => {}); };
signal.addEventListener("abort", interrupt, { once: true });
let startedTurn = false;
try {
  signal.throwIfAborted();
  await harness.start();
  signal.throwIfAborted();
  const prompt = conversation.length === 1 && conversation[0].role === "user" && !conversation[0].content.trimStart().startsWith("/")
    ? conversation[0].content : `按消息顺序接续下面的对话，只输出助手对最后一条用户消息的回答。\n${JSON.stringify(conversation)}`;
  startedTurn = true;
  const result = await harness.run(images.length ? [{ type: "text", text: prompt }, ...images] : prompt);
  signal.throwIfAborted();
  const measurements = result.events.flatMap(event => event.type === "assistant/message" && event.data.usage ? [event.data.usage] : []);
  const inputTokens = measurements.reduce((sum, item) => sum + item.inputTokens + (item.cacheReadTokens ?? 0) + (item.cacheWriteTokens ?? 0), 0);
  const outputTokens = measurements.reduce((sum, item) => sum + item.outputTokens, 0);
  const completed = ["completed", "max-tokens", "max_tokens"].includes(result.finishReason);
  const end = result.events.findLast(event => event.type === "turn/end")?.data.reason;
  let failure;
  if (end?.kind === "error") {
    const { code, status, message } = end.error;
    // The SDK's OpenAI completions adapter can carry the HTTP status only in its leading status prefix.
    const prefix = typeof message === "string" ? /^([45]\d{2}):[ \t]/u.exec(message)?.[1] : undefined;
    const structuredStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
    failure = { code, status: structuredStatus ?? (prefix ? Number(prefix) : undefined) };
  }
  process.stdout.write(JSON.stringify({ ok: completed, text: completed ? result.finalResponse.trim() : "", inputTokens: measurements.length ? inputTokens : null,
    outputTokens: measurements.length ? outputTokens : null, reason: result.finishReason, failure }) + "\n");
} catch (error) {
  const missingImages = images.length > 0 && error?.name === "JsonRpcResponseError" && error.code === -32603 &&
    /^(?:Could not load the "sharp" module|SDK image prompt requires an attachment store)/u.test(error.message);
  process.stdout.write(JSON.stringify({ ok: false, reason: deadline.aborted ? "timeout" : cancellation.signal.aborted ? "cancelled"
    : startedTurn && !missingImages ? "runtime" : "startup" }) + "\n");
} finally {
  signal.removeEventListener("abort", interrupt);
  lines.close();
  process.stdin.pause();
  await harness.close();
}

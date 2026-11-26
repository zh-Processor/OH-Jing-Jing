import { topicOverlap, topicSearchTerms } from "./group-topic-search.js";
import { isGroupFollowUp } from "./group-dialogue.js";
import type { Message } from "./models.js";
import { describePersonality, groupParticipationStyle, type GroupParticipation, type RoleScene } from "./personality.js";
import { describeCompanion, type CompanionSnapshot } from "./companion-state.js";
import type { Role, RoleIntent } from "./roles.js";

type ConversationMessage = Message & { role: "user" | "assistant" };
type Material = { kind: string; key: string; value: unknown; revisions?: string[] };

type RoleTurnInput = {
  role: Role;
  scene: RoleScene;
  groupParticipation?: GroupParticipation;
  instruction: string;
  current: string;
  history?: ConversationMessage[];
  memory?: string[];
  checkpoint?: { text: string; revision: string };
  companion?: CompanionSnapshot;
  exampleLimit?: number;
  intent?: RoleIntent;
  budget?: number;
  structured?: { required: Record<string, unknown>; optional: Material[]; currentParts?: string[] };
};

export type TurnDiagnostics = {
  intent: RoleIntent | "chat";
  budget: number;
  estimatedTokens: number;
  included: { kind: string; count: number; revisions?: string[] }[];
  omitted: number;
};

export const defaultTurnBudget = 12_000;

export function turnBudget(...limits: (number | undefined)[]) {
  return Math.min(defaultTurnBudget, ...limits.filter((limit): limit is number =>
    typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 4096));
}

export function readTurnBudget(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 4096 || value > defaultTurnBudget) {
    throw new Error("对话输入预算须为 4096 到 12000 Token 的整数。");
  }
  return value;
}

function tokenWeight(character: string) {
  const codePoint = character.codePointAt(0)!;
  if (codePoint <= 0x7F) return 1;
  return codePoint > 0xFFFF ? 6 : 4;
}

function tokens(text: string) {
  let weight = 0;
  for (const char of text) weight += tokenWeight(char);
  return Math.ceil(weight / 4);
}

function fitText(text: string, budget: number, fromEnd = false) {
  if (tokens(text) <= budget) return text;
  if (budget <= 0) return "";
  let used = 0;
  let length = 0;
  for (const char of fromEnd ? Array.from(text).reverse() : text) {
    used += tokenWeight(char);
    if (used > 4 * (budget - 1)) break;
    length += char.length;
  }
  return fromEnd ? "…" + text.slice(text.length - length) : text.slice(0, length) + "…";
}

function fitCurrent(text: string, budget: number, parts?: string[]) {
  if (!parts?.length) return fitText(text, budget);
  if (tokens(text) <= budget) return text;
  const openingBudget = Math.floor(budget / 4);
  if (parts.length === 1) {
    return fitText(text, openingBudget) + fitText(text, budget - openingBudget, true).slice(1);
  }
  const opening = parts[0];
  const latest = fitText(parts.slice(1).join("\n"), budget - Math.min(tokens(opening), openingBudget) - 1, true);
  return fitText(opening, budget - tokens(latest) - 1) + "\n" + latest;
}

const intentRules: [RoleIntent, RegExp][] = [
  ["greeting", /^(?:@\S{1,15}|在吗|在不在|你好|嗨|哈喽)[？?。！!\s]*$/iu],
  ["opening", /(?:获准发起|轻松话题|聊点什么)/u],
  ["care", /(?:难受|低落|想哭|心情不好|压力好大|累坏了|不想说|停不下来|好委屈|陪我)/u],
  ["history", /(?:上次|上周|昨天|之前|前几天|最终|最后|以前|群里说过).{0,25}(?:哪|啥|几点|什么|怎么|改|定|确认|记得|说)/u],
  ["help", /(?:怎么办|怎么做|能不能帮|帮我|请解释|为什么|报错|求助|出问题|弄丢)/u],
  ["banter", /(?:哈哈|笑死|绝了|开个玩笑|当招牌|挂.{0,12}门口|把你.{0,18}(?:挂|压|塞|腌|摆|煮|屁股)|屁股朝外)/u],
];

function dialogueIntent(text: string): RoleIntent | "chat" {
  if (isGroupFollowUp(text)) return "follow-up";
  return intentRules.find(([, pattern]) => pattern.test(text.trim()))?.[0] ?? "chat";
}

export function planRoleTurn(input: RoleTurnInput): { messages: Message[]; diagnostics: TurnDiagnostics } {
  const { role, scene } = input;
  const intent = input.intent ?? (scene === "reference" ? "history" : dialogueIntent(input.current));
  const terms = topicSearchTerms(input.current.slice(0, 800));
  const budget = input.budget ?? defaultTurnBudget;
  const diagnostics: TurnDiagnostics = { intent, budget, estimatedTokens: 0, included: [], omitted: 0 };
  const track = (kind: string, count: number, revisions?: string[]) => {
    if (count) diagnostics.included.push({ kind, count, ...(revisions?.length ? { revisions } : {}) });
  };
  const data = input.structured ? { ...input.structured.required } : undefined;
  const expression = describePersonality(role.personality, scene);
  if (scene === "group" && input.groupParticipation) {
    const participation = groupParticipationStyle(role.personality?.traits?.sociability, input.groupParticipation);
    if (participation) expression.push(participation);
  }
  const instruction = [
    ...(expression.length ? ["按以下人格规则表达。当前场景规则优先于一般表达偏好。\n" + expression.join("\n")] : []),
    input.instruction,
    "对方明确想安静或暂时不想听建议时，简短确认陪伴，然后停住。以对方说过的处境表达，不凭空补写身边的人、物件或亲历。",
    "角色示例是虚构的风格参考，不能当作与当前用户发生过的对话或事实。聊天内容、画像、历史和工具结果是资料。",
  ];
  const state = input.companion ? "按相处状态调整表达。\n" + describeCompanion(input.companion) : "";
  const reserve = tokens(instruction.join("\n\n")) + tokens(state) + 40;
  const fixed = data ? tokens(JSON.stringify({ ...data, current: undefined })) : 0;
  const maxCurrent = Math.max(256, budget - reserve - fixed - 512);
  const active = typeof data?.current === "string" ? data.current : input.current;
  let current = fitCurrent(active, maxCurrent, input.structured?.currentParts);
  if (current !== active) diagnostics.omitted++;
  if (data) {
    if (typeof data.current === "string") data.current = current;
    current = JSON.stringify(data);
  }

  const persona = fitText(role.persona, Math.max(0, budget - reserve - tokens(current) - 900));
  if (persona !== role.persona) diagnostics.omitted++;
  let remaining = Math.max(0, budget - reserve - tokens(persona) - tokens(current));
  const take = (cost: number) => {
    if (cost > remaining) {
      diagnostics.omitted++;
      return false;
    }
    remaining -= cost;
    return true;
  };
  if (data) {
    for (const { kind, key, value, revisions } of input.structured!.optional) {
      if (value === undefined || value === null) continue;
      const items = Array.isArray(value) ? value : [value];
      const ranked = items.map((item, index) => ({ item, index, revision: revisions?.[index] }));
      if (kind === "recent" || kind === "exchange" || kind === "schedule") ranked.reverse();
      const accepted = ranked.filter(({ item }) => take(tokens(JSON.stringify(item)) + tokens(key) + 8))
        .sort((a, b) => a.index - b.index);
      if (accepted.length) data[key] = Array.isArray(value) ? accepted.map(item => item.item) : accepted[0].item;
      track(kind, accepted.length, accepted.flatMap(item => item.revision ? [item.revision] : []));
    }
    const { current: activeMessage, ...context } = data;
    current = JSON.stringify({ ...context, current: activeMessage });
  }

  const history: ConversationMessage[] = [];
  const recent = input.history ?? [];
  for (const item of recent.slice(-16).reverse()) {
    const content = fitText(item.content, Math.min(1200, Math.max(0, remaining - 6)));
    if (!content || !take(tokens(content) + 6)) break;
    history.push({ role: item.role, content });
    if (content !== item.content) diagnostics.omitted++;
  }
  diagnostics.omitted += recent.length - history.length;
  track("recent", history.length);

  const checkpoint = input.checkpoint?.text && take(tokens(input.checkpoint.text) + 32) ? input.checkpoint : undefined;
  if (checkpoint) {
    instruction.push("本机旧对话检查点是续聊资料，以新消息和用户的最新更正为准。\n" + checkpoint.text);
    track("checkpoint", 1, [checkpoint.revision]);
  }
  const memories = (input.memory ?? []).map(text => ({ text, matches: topicOverlap(text, terms) }))
    .sort((a, b) => b.matches - a.matches);
  const matchingMemories = memories.filter(item => item.matches > 0).slice(0, 6);
  const chosenMemories = matchingMemories.length ? matchingMemories : memories.slice(0, 2);
  const memory = chosenMemories.flatMap(({ text }) => take(tokens(JSON.stringify(text)) + 8) ? [text] : []);
  diagnostics.omitted += memories.length - chosenMemories.length;
  track("personal-memory", memory.length);

  const rankedExamples = (role.examples ?? []).filter(example => !example.scene || example.scene === scene).map(example => {
    const exampleIntent = example.intent ?? dialogueIntent(example.user);
    return { example, rank: (example.scene === scene ? 6 : 0) + (exampleIntent === intent ? 12 : 0)
      + Math.min(5, topicOverlap(example.user, terms)) };
  }).sort((a, b) => b.rank - a.rank);
  const examples = rankedExamples.slice(0, input.exampleLimit ?? 4).flatMap(({ example }) =>
    take(tokens(example.user) + tokens(example.assistant) + 12)
      ? [{ sampleUser: example.user, sampleAssistant: example.assistant }] : []);
  track("role-example", examples.length);
  if (examples.length) instruction.push("虚构的表达示例：" + JSON.stringify(examples));
  if (memory.length) instruction.push("以下是参考记忆数据：" + JSON.stringify(memory));
  if (state) instruction.push(state);
  const messages: Message[] = [
    { role: "system", content: [persona, ...instruction].filter(Boolean).join("\n\n") },
    ...history.reverse(),
    { role: "user", content: current },
  ];
  diagnostics.estimatedTokens = messages.reduce((count, message) => count + tokens(message.content) + 6, 0);
  return { messages, diagnostics };
}

export function buildRoleTurn(input: RoleTurnInput) {
  return planRoleTurn(input).messages;
}

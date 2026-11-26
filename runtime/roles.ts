import { readPersonality, roleScenes, type Personality, type RoleScene } from "./personality.js";
import dafeiyu from "../roles/dafeiyu.json" with { type: "json" };
import { readPngAvatar } from "./png-avatar.js";

export const roleIntents = ["greeting", "banter", "follow-up", "help", "care", "history", "opening"] as const;
export type RoleIntent = typeof roleIntents[number];
export type RoleSpeech = { voice: string; direction: string };

export interface Role {
  id: string;
  name: string;
  version: string;
  persona: string;
  personality?: Personality;
  speech?: RoleSpeech;
  avatar?: string;
  examples?: { user: string; assistant: string; scene?: RoleScene; intent?: RoleIntent }[];
}

export const defaultRole = readRole({ ...dafeiyu, id: "ohjingjing.dafeiyu" });

export function readRole(input: unknown): Role {
  if (typeof input !== "object" || input === null) throw new Error("角色包格式不正确。");
  const data = input as Partial<Role>;
  if (typeof data.id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(data.id) ||
      typeof data.name !== "string" || !data.name.trim() || data.name.length > 60 ||
      typeof data.version !== "string" || !/^\d+\.\d+\.\d+$/.test(data.version) ||
      typeof data.persona !== "string" || !data.persona.trim() || data.persona.length > 16_000) {
    throw new Error("角色需要有效的 ID、名称、版本和人设。");
  }
  const avatar = data.avatar === undefined ? undefined : readPngAvatar(data.avatar, "角色头像");
  const speech = data.speech;
  if (speech !== undefined && (!speech || typeof speech.voice !== "string" || !/^[a-z][a-z0-9._-]{0,60}$/u.test(speech.voice) ||
      typeof speech.direction !== "string" || !speech.direction.trim() || speech.direction.length > 240 || /[\p{Cc}]/u.test(speech.direction))) {
    throw new Error("角色声线需要有效的标识和简短的表演方向。");
  }
  const examples = data.examples;
  if (examples !== undefined && (!Array.isArray(examples) || examples.length > 20 ||
      examples.some((example) => !example || typeof example.user !== "string" ||
        typeof example.assistant !== "string" || example.user.length > 1500 || example.assistant.length > 1500 ||
        (example.scene !== undefined && (typeof example.scene !== "string" || !Object.hasOwn(roleScenes, example.scene))) ||
        (example.intent !== undefined && !roleIntents.includes(example.intent))))) {
    throw new Error("角色对话示例格式不正确。");
  }
  return {
    id: data.id, name: data.name.trim(), version: data.version,
    persona: data.persona, avatar,
    personality: data.personality === undefined ? undefined : readPersonality(data.personality),
    ...(speech ? { speech: { voice: speech.voice, direction: speech.direction.trim() } } : {}),
    examples: examples?.map(({ user, assistant, scene, intent }) =>
      ({ user, assistant, ...(scene ? { scene } : {}), ...(intent ? { intent } : {}) })),
  };
}

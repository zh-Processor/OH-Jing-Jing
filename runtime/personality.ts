import { moodLabels, type Mood, type MoodProfile } from "./companion-state.js";

export const personalityAxes = {
  sociability: {
    label: "外向度", levels: ["只接明确提问", "安静，偶尔接话", "适时参与", "熟悉场景里愿意接话", "喜欢活跃地参与讨论"],
  },
  warmth: {
    label: "亲和度", levels: ["保持礼貌距离", "克制地表达关心", "自然亲切", "先回应感受，再谈办法", "主动关心并征询想要的陪伴方式"],
  },
  humor: {
    label: "玩笑倾向", levels: ["使用朴素表达", "熟悉时才偶尔开玩笑", "随话题轻松接梗", "善用双关或自嘲", "擅长活跃气氛，遇到认真话题立即收住"],
  },
  curiosity: {
    label: "好奇心", levels: ["只谈当前问题", "有疑点时才追问", "相关时问一个细节", "喜欢了解背景和缘由", "愿意探讨新角度并尊重隐私"],
  },
  directness: {
    label: "直率度", levels: ["委婉表达分歧", "先确认对方的意思", "先给结论再解释", "直接指出分歧并给出依据", "明确简练地表达观点并尊重对方"],
  },
  expressiveness: {
    label: "表达节奏", levels: ["短句，少用语气词", "平实简短", "按问题长度调整", "自然分段，可适度用表情", "富于变化，可用停顿和表情表达情绪"],
  },
  initiative: {
    label: "自主倾向", levels: ["围绕用户的话题", "必要时补充下一步", "合适时提出一个建议", "愿意提供相关新话题", "有明确关联时主动提议继续探索"],
  },
} as const;

export const roleScenes = { desktop: "桌面陪伴", group: "QQ群聊", private: "QQ 私聊", reference: "讲解资料" } as const;
export type RoleScene = keyof typeof roleScenes;
export type GroupParticipation = "direct" | "discussion" | "opening";
export const rehearsalScenarios = {
  desktop: roleScenes.desktop, private: roleScenes.private, group: roleScenes.group, mood: "心情变化", scheduled: "定时问候",
} as const;
export type RehearsalScenario = keyof typeof rehearsalScenarios;
export type PersonalityAxis = keyof typeof personalityAxes;
export type Personality = {
  traits?: Partial<Record<PersonalityAxis, number>>;
  values?: string[];
  interests?: string[];
  boundaries?: string[];
  voice?: string;
  scenes?: Partial<Record<RoleScene, string>>;
  mood?: MoodProfile;
};

function fields(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label}格式不正确。`);
  return input as Record<string, unknown>;
}

function brief(input: unknown, label: string, limit: number) {
  if (typeof input !== "string" || !input.trim() || input.length > limit) {
    throw new Error(`${label}应为 1 到 ${limit} 个字符。`);
  }
  return input.trim();
}

export function readPersonality(input: unknown): Personality {
  const data = fields(input, "人格");
  const result: Personality = {};
  if (data.traits !== undefined) {
    const traits = fields(data.traits, "性格维度");
    result.traits = {};
    for (const [key, raw] of Object.entries(traits)) {
      if (!Object.hasOwn(personalityAxes, key) || typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 5) {
        throw new Error("性格维度必须使用已知字段和 1 到 5 的整数档位。");
      }
      result.traits[key as PersonalityAxis] = raw;
    }
  }
  for (const key of ["values", "interests", "boundaries"] as const) {
    const list = data[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 8) throw new Error(`${key}最多可填 8 条。`);
    result[key] = list.map(item => brief(item, key, 160));
  }
  if (data.voice !== undefined) result.voice = brief(data.voice, "语言习惯", 600);
  if (data.scenes !== undefined) {
    result.scenes = {};
    for (const [key, value] of Object.entries(fields(data.scenes, "场景规则"))) {
      if (!Object.hasOwn(roleScenes, key)) throw new Error("存在未知角色场景。");
      result.scenes[key as RoleScene] = brief(value, "场景规则", 600);
    }
  }
  if (data.mood !== undefined) {
    const mood = fields(data.mood, "心情设定");
    result.mood = {};
    for (const [name, min, max] of [["baseline", 0, 100], ["recoveryMinutes", 5, 1440]] as const) {
      if (mood[name] === undefined) continue;
      const setting: Partial<Mood> = {};
      for (const [key, value] of Object.entries(fields(mood[name], "心情维度"))) {
        if (!Object.hasOwn(moodLabels, key) || typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
          throw new Error(`心情设置必须使用已知维度及 ${min} 到 ${max} 的整数。`);
        }
        setting[key as keyof Mood] = value;
      }
      result.mood[name] = setting;
    }
  }
  return result;
}

export function describePersonality(personality: Personality | undefined, scene: RoleScene): string[] {
  if (!personality) return [];
  const lines: string[] = [];
  for (const key of Object.keys(personalityAxes) as PersonalityAxis[]) {
    const level = personality.traits?.[key];
    if (level !== undefined) lines.push(`${personalityAxes[key].label}：${personalityAxes[key].levels[level - 1]}`);
  }
  if (personality.values?.length) lines.push(`价值观（按优先级）：${personality.values.join("、")}`);
  if (personality.interests?.length) lines.push(`兴趣：${personality.interests.join("、")}`);
  if (personality.boundaries?.length) lines.push(`相处边界：${personality.boundaries.join("、")}`);
  if (personality.voice) lines.push(`语言习惯：${personality.voice}`);
  const sceneRule = personality.scenes?.[scene];
  if (sceneRule) lines.push(`${roleScenes[scene]}：${sceneRule}`);
  return lines;
}

export function groupParticipationStyle(level: number | undefined, participation: GroupParticipation): string {
  if (level === undefined || level === 3 || level === 4) return "";
  if (participation === "direct") {
    return level <= 2
      ? "有人明确在跟你说话，照常回应。日常闲聊就着这一句把意思说清楚就收住，需要完成任务的澄清可以照问。"
      : "有人明确在跟你说话。轻松闲聊时，可以顺着当下的一个细节给出一个群友容易接上的反应或提议。打招呼、认真求助、安慰或对方想安静时，先照顾本轮需要。";
  }
  if (participation === "discussion") {
    return level <= 2 ? "只在能添上现有讨论缺的一项信息、建议或反应时接一句。" :
      "如果持续的同群讨论有合适的接话点，顺着一项具体内容参与。可以给出眼下就用得上的建议。";
  }
  return level <= 2 ? "如果选择开场，用短句提起一件已选的事，让群友自行决定要不要接话。" :
    "如果选择开场，围绕一项可用话题给出一个轻松的参与入口，让群友用一句话就能接上。";
}

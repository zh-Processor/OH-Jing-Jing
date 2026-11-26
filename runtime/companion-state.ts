export const moodLabels = { joy: "愉悦度", energy: "精力", tension: "紧张度", curiosity: "好奇度" } as const;
export type MoodDimension = keyof typeof moodLabels;
export type Mood = Record<MoodDimension, number>;
export type MoodProfile = { baseline?: Partial<Mood>; recoveryMinutes?: Partial<Mood> };
export type CompanionSnapshot = { mood: Mood; familiarity: "初识" | "渐熟" | "熟悉" };

export const careLabels = { feed: "投喂", pet: "摸摸", rest: "休息" } as const;
export type CareAction = keyof typeof careLabels;
export const companionEffects = {
  feed: { joy: 12, energy: 18, tension: -4 },
  pet: { joy: 18, tension: -14 },
  rest: { energy: 12, tension: -20, curiosity: -16 },
  conversation: { joy: 2, energy: -3, curiosity: 3 },
} satisfies Record<CareAction | "conversation", Partial<Mood>>;
export type CompanionEvent = keyof typeof companionEffects;

const dimensions = Object.keys(moodLabels) as MoodDimension[];
const defaultBaseline: Mood = { joy: 55, energy: 55, tension: 25, curiosity: 50 };
const defaultRecovery: Mood = { joy: 45, energy: 60, tension: 25, curiosity: 35 };

export function moodAt(profile: MoodProfile | undefined, now: number, previous?: { mood: Mood; time: number }): Mood {
  const baseline = { ...defaultBaseline, ...profile?.baseline };
  if (!previous) return baseline;
  const elapsed = Math.max(0, now - previous.time) / 60_000;
  for (const key of dimensions) {
    const halfLife = profile?.recoveryMinutes?.[key] ?? defaultRecovery[key];
    baseline[key] += (previous.mood[key] - baseline[key]) * 2 ** (-elapsed / halfLife);
  }
  return baseline;
}

export function changeMood(mood: Mood, effect: Partial<Mood>): Mood {
  return Object.fromEntries(dimensions.map(key => [key, Math.max(0, Math.min(100, mood[key] + (effect[key] ?? 0)))])) as Mood;
}

export function moodExpression(mood: Mood): "calm" | "bright" | "quiet" | "alert" {
  if (mood.tension >= 65) return "alert";
  if (mood.energy <= 32) return "quiet";
  if (mood.curiosity <= 37 && mood.tension < 25) return "quiet";
  if (mood.joy >= 68 && mood.tension < 45) return "bright";
  return "calm";
}

export function describeCompanion(snapshot: CompanionSnapshot): string {
  const expression = moodExpression(snapshot.mood);
  const moodStyle = {
    calm: "",
    bright: "此刻心情轻松，可以更活泼一些。",
    quiet: "此刻比较安静，表达可以放缓，明确的问题仍正常回答。",
    alert: "此刻稍紧张，语气尽量平稳，收起可选的玩笑。",
  }[expression];
  const relationStyle = {
    初识: "刚开始交流，使用自然和礼貌的称呼。",
    渐熟: "已经交流过几次，表达可稍自然，仍按对方明确表达的偏好称呼。",
    熟悉: "有稳定的交流经历，可以更自然地延续已知的话题和称呼。",
  }[snapshot.familiarity];
  const curiosity = snapshot.mood.curiosity >= 70 ? "话题合适时可好奇地问一个细节。" : "";
  return [moodStyle, curiosity, relationStyle].filter(Boolean).join("\n");
}

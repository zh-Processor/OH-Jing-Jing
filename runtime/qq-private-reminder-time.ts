export type ReminderRecurrence = { weekday: number | null; localTime: string; timeZone: string };
export const reminderMinute = 60_000;
export const reminderDay = 24 * 60 * reminderMinute;
export const occurrenceWindow = 2 * 60 * reminderMinute;
export const reminderClock = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const dayNames = "日一二三四五六";

export function reminderDateLabel(timeZone: string, time: number) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short", hourCycle: "h23" }).format(time);
}

export function recurrenceLabel(rule: ReminderRecurrence) {
  return `${rule.weekday === null ? "每天" : "每周" + dayNames[rule.weekday]} ${rule.localTime}`;
}

function validText(text: string) {
  return !!text && Array.from(text).length <= 120 && !/[\u0000-\u001f\u007f]/u.test(text);
}

function zonedTime(requested: string, timeZone: string) {
  const nominal = Date.parse(requested.replace(" ", "T") + ":00Z");
  if (!Number.isFinite(nominal)) return undefined;
  // A clock change can remove a local time or give it two different instants.
  const possible = new Set([nominal - reminderDay, nominal, nominal + reminderDay].map(probe => {
    const localAsUtc = Date.parse(reminderDateLabel(timeZone, probe).replace(" ", "T") + ":00Z");
    return nominal + probe - localAsUtc;
  }).filter(value => Number.isFinite(value) && reminderDateLabel(timeZone, value) === requested));
  return possible.size === 1 ? [...possible][0] : undefined;
}

export function readPrivateReminderTime(input: string, timeZone: string, now: number) {
  const relative = /^([1-9]\d{0,3})(分钟|小时|天|m|h|d)\s+(.+)$/u.exec(input);
  const absolute = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\s+(.+)$/u.exec(input);
  let dueAt: number | undefined;
  let text = "";
  if (relative) {
    const [, amount, unit, content] = relative;
    dueAt = now + Number(amount) *
      (unit === "天" || unit === "d" ? reminderDay : unit === "小时" || unit === "h" ? 60 * reminderMinute : reminderMinute);
    text = content.trim();
  } else if (absolute && reminderClock.test(absolute[2])) {
    dueAt = zonedTime(absolute[1] + " " + absolute[2], timeZone);
    text = absolute[3].trim();
  }
  if (dueAt === undefined || dueAt <= now || dueAt > now + 366 * reminderDay || !validText(text)) return null;
  return { dueAt, text };
}

export function readPrivateReminderRecurrence(input: string, timeZone: string) {
  const repeat = /^(每天|每周([日天一二三四五六]))\s+(\d{2}:\d{2})\s+(.+)$/u.exec(input);
  if (!repeat || !reminderClock.test(repeat[3]) || !validText(repeat[4].trim())) return null;
  const weekday = repeat[2] ? dayNames.indexOf(repeat[2] === "天" ? "日" : repeat[2]) : null;
  return { weekday, localTime: repeat[3], timeZone, text: repeat[4].trim() };
}

export function nextReminderOccurrence(rule: ReminderRecurrence, after: number) {
  const currentDay = reminderDateLabel(rule.timeZone, after).slice(0, 10);
  const start = Date.parse(currentDay + "T00:00:00Z");
  for (let offset = 0; offset <= 21; offset++) {
    const date = new Date(start + reminderDay * offset);
    if (rule.weekday !== null && date.getUTCDay() !== rule.weekday) continue;
    const slot = zonedTime(date.toISOString().slice(0, 10) + " " + rule.localTime, rule.timeZone);
    if (slot !== undefined && slot > after) return slot;
  }
  throw new Error("Unable to determine the next private reminder occurrence.");
}

export type SummaryReminderPolicy = {
  paused: boolean;
  quietHours: boolean;
  quietStart: string;
  quietEnd: string;
  deferFullscreen: boolean;
};

export const defaultSummaryReminderPolicy: SummaryReminderPolicy = {
  paused: false, quietHours: false, quietStart: "23:00", quietEnd: "08:00", deferFullscreen: true,
};

export const workspaceReminderIntervals = [0, 5, 15, 30, 60] as const;
export type WorkspaceReminderPolicy = Omit<SummaryReminderPolicy, "deferFullscreen"> & { intervalMinutes: typeof workspaceReminderIntervals[number] };
export const defaultWorkspaceReminderPolicy: WorkspaceReminderPolicy = {
  paused: false, quietHours: false, quietStart: defaultSummaryReminderPolicy.quietStart,
  quietEnd: defaultSummaryReminderPolicy.quietEnd, intervalMinutes: 0,
};

const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export function readSummaryReminderPolicy(input: unknown): SummaryReminderPolicy {
  const policy = input as Partial<SummaryReminderPolicy> | null;
  if (typeof policy?.paused !== "boolean" || typeof policy.quietHours !== "boolean" ||
      typeof policy.deferFullscreen !== "boolean" || typeof policy.quietStart !== "string" || !clock.test(policy.quietStart) ||
      typeof policy.quietEnd !== "string" || !clock.test(policy.quietEnd) ||
      (policy.quietHours && policy.quietStart === policy.quietEnd)) {
    throw new Error("请设置有效的勿扰时段，启用时开始和结束时间须不同。");
  }
  const { paused, quietHours, quietStart, quietEnd, deferFullscreen } = policy;
  return { paused, quietHours, quietStart, quietEnd, deferFullscreen };
}

export function summaryReminderQuiet(policy: SummaryReminderPolicy, now: Date) {
  if (policy.paused) return true;
  if (!policy.quietHours) return false;
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const { quietStart: start, quietEnd: end } = policy;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

import { isQqId } from "./qq-channel.js";
import { qqPrivateScope, type QqPrivateContact } from "./qq-private.js";
import type { RequestPurpose } from "./service-budget.js";
import { billingAvailable, type ModelProfile } from "./models.js";

export type TurnBackend = "dsh" | "pi";
const accountPurposes = new Set<RequestPurpose>(["role-diary", "qzone"]);
const servicePurposes = ["reply", "private", "summary", "profile", "proactive", "role-diary", "qzone"] as const;
type ServicePurpose = typeof servicePurposes[number];
export type ServiceHarnessRollout = { purposes: ServicePurpose[]; groups?: string[]; privateContacts?: QqPrivateContact[]; accounts?: string[] };
const desktopPurposes = ["desktop", "desktop-checkpoint", "desktop-interaction-review", "memory-extraction", "summary-explanation", "profile-explanation", "role-rehearsal", "model-test"] as const;
const bundledDesktopPurposes = new Set(["desktop", "desktop-checkpoint", "desktop-interaction-review", "memory-extraction",
  "summary-explanation", "profile-explanation", "role-rehearsal"]);
export const qqAccountHarnessScope = (accountId: string) => `qq-account:${accountId}`;

export function serviceHarnessRollout(input: ServiceHarnessRollout | undefined) {
  if (input === undefined) return undefined;
  if (!input || !Array.isArray(input.purposes) || input.purposes.some(item => !servicePurposes.includes(item)) ||
      (input.groups !== undefined && (!Array.isArray(input.groups) || input.groups.some(group => !isQqId(group)))) ||
      (input.accounts !== undefined && (!Array.isArray(input.accounts) || input.accounts.some(account => !isQqId(account)))) ||
      (input.privateContacts !== undefined && (!Array.isArray(input.privateContacts) || input.privateContacts.some(contact =>
        !isQqId(contact?.accountId) || !isQqId(contact?.userId) || contact.accountId === contact.userId)))) {
    throw new Error("请核对 DSH 试运行的业务范围、QQ 群、账号及私聊联系人。");
  }
  const purposes = new Set<RequestPurpose>(input.purposes);
  const groups = input.groups && new Set(input.groups);
  const privateContacts = input.privateContacts && new Set(input.privateContacts.map(contact => qqPrivateScope(contact.accountId, contact.userId)));
  const accounts = new Set((input.accounts ?? []).map(qqAccountHarnessScope));
  return (purpose: RequestPurpose, scope: string): TurnBackend => {
    if (!purposes.has(purpose === "conversation-preview" ? "proactive" : purpose)) return "pi";
    if (accountPurposes.has(purpose)) return accounts.has(scope) ? "dsh" : "pi";
    if (purpose === "private") return !privateContacts || privateContacts.has(scope) ? "dsh" : "pi";
    if (!groups) return "dsh";
    return scope.startsWith("qq:") && groups.has(scope.split(":").at(-1)!) ? "dsh" : "pi";
  };
}

export function desktopHarnessRollout(value: string | undefined, bundled = false) {
  if (value === undefined) return (purpose: string, profile?: Pick<ModelProfile, "model" | "baseUrl">): TurnBackend | undefined => {
    if (!bundled || !profile || !bundledDesktopPurposes.has(purpose)) return undefined;
    const eligible = /^(?:deepseek-flash|deepseek-v4-flash)$/u.test(profile.model) &&
      billingAvailable({ baseUrl: profile.baseUrl, billing: "packy" });
    return eligible ? "dsh" : "pi";
  };
  const items = new Set(value.split(",").map(item => item.trim()).filter(Boolean));
  if ([...items].some(item => !desktopPurposes.some(purpose => purpose === item))) {
    throw new Error("请核对桌宠 DSH 试运行的业务范围。");
  }
  return (purpose: string): TurnBackend => items.has(purpose) ? "dsh" : "pi";
}

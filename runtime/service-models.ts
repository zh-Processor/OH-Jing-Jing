import { createHash, createHmac } from "node:crypto";
import { billingAvailable, readBillingProvider, validateEndpoint, type ModelProfile } from "./models.js";
import type { GroupServiceOptions } from "./group-service.js";
import type { RequestPurpose } from "./service-budget.js";
import type { openStore } from "./store.js";
import { openServiceModelRoutes, type ModelRouteTarget, type StandbyMode } from "./service-model-routes.js";
import { readTurnBudget } from "./turn.js";

type Binding = {
  id: string;
  groupId?: string;
  backupFor?: string;
  model: ModelProfile;
  key?: string;
  purposes: RequestPurpose[];
  usageKey: string;
  fingerprint: string | null;
};
type RoutedBinding = Binding & { routeBackup: Binding | null };
const summaryPurposes: RequestPurpose[] = ["summary", "profile", "qzone", "role-diary"];
const groupPurposes: RequestPurpose[] = ["reply", "proactive", "conversation-preview", "group-reminder"];
const commonPurposes: RequestPurpose[] = [...groupPurposes, "private", "private-greeting", ...summaryPurposes];

export function openServiceModels(store: ReturnType<typeof openStore>, options: GroupServiceOptions,
    backups: ReturnType<typeof readBackupModels>, profiles: ReturnType<typeof readServiceModelProfiles> = []) {
  const bindings = new Map<string, Binding>();
  const routes = openServiceModelRoutes(store.db);
  function add(id: string, model: ModelProfile | undefined, key: string | undefined, purposes: RequestPurpose[], groupId?: string, backupFor?: string) {
    if (!model) return;
    readTurnBudget(model.contextBudget);
    const usageKey = createHmac("sha256", options.adminToken)
      .update(JSON.stringify([id, model.id, model.baseUrl, model.model, key ?? null])).digest("hex");
    let fingerprint: string | null = null;
    try {
      const endpoint = validateEndpoint(model.baseUrl).href.replace(/\/+$/u, "");
      fingerprint = createHash("sha256").update(JSON.stringify([id, model.id, endpoint, model.model])).digest("hex");
    } catch { /* Still list an invalid configured endpoint so the operator can fix it. */ }
    bindings.set(id, { id, groupId, backupFor, model, key, purposes, usageKey, fingerprint });
  }
  add("default", options.model, options.modelKey,
    options.summaryModel ? ["reply", "proactive", "conversation-preview", "private"] : commonPurposes);
  add("summary", options.summaryModel, options.summaryModelKey, summaryPurposes);
  for (const [groupId, model] of Object.entries(options.groupModels ?? {})) {
    add(`group:${groupId}`, model, options.groupModelKeys?.[groupId], groupPurposes, groupId);
  }
  for (const [id, model] of profiles) add(`profile:${id}`, model, options.modelProfileKeys?.[id], commonPurposes);
  for (const [id, model] of backups) {
    const primary = bindings.get(id)!;
    add(`backup:${id}`, model, options.backupModelKeys?.[id], primary.purposes, primary.groupId, id);
  }
  const usage = store.db.prepare(`SELECT currency, COUNT(*) AS requests, SUM(status IN ('failed','empty','cancelled')) AS failed,
    SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
    SUM(estimated_cost) AS estimated_cost, COUNT(estimated_cost) AS priced_requests
    FROM requests WHERE model_binding = ? AND created_at >= ? GROUP BY currency ORDER BY currency`);
  const lastUsed = store.db.prepare("SELECT MAX(created_at) AS last_used FROM requests WHERE model_binding = ?");

  function available(route: string, binding: Binding) {
    const root = binding.backupFor ?? binding.id;
    return root === "default" || root.startsWith("profile:") || (route === "summary" && root === "summary") ||
      (route.startsWith("qq:") && root === `group:${route.split(":").at(-1)}`);
  }

  function usable(binding: Binding) {
    return !!binding.fingerprint && (!binding.model.hasKey || !!binding.key);
  }

  function target(route: string, id: string | null | undefined, fingerprint: string | null | undefined) {
    const binding = id ? bindings.get(id) : undefined;
    return binding && available(route, binding) && usable(binding) && binding.fingerprint === fingerprint ? binding : undefined;
  }

  function inherited(route: string) {
    if (route === "private") return resolve("default");
    const id = route === "default" || route === "summary" ? route : `group:${route.split(":").at(-1)}`;
    const binding = bindings.get(id);
    if (binding) return { ...binding, routeBackup: configuredBackup(binding) ?? null };
    return route === "default" ? undefined : resolve("default");
  }

  function distinct(primary: Binding, candidate: Binding) {
    if (primary.id === candidate.id) return false;
    if (primary.key !== candidate.key || primary.model.model !== candidate.model.model || !primary.fingerprint) return true;
    return validateEndpoint(primary.model.baseUrl).href.replace(/\/+$/u, "") !==
      validateEndpoint(candidate.model.baseUrl).href.replace(/\/+$/u, "");
  }

  function configuredBackup(primary: Binding) {
    const candidate = bindings.get(`backup:${primary.id}`);
    return candidate && usable(candidate) && distinct(primary, candidate) ? candidate : undefined;
  }

  function explicitBackup(route: string, primary: Binding | undefined, selection: ModelRouteTarget) {
    const candidate = target(route, selection.standbyBindingId, selection.standbyFingerprint);
    return candidate && primary && distinct(primary, candidate) ? candidate : undefined;
  }

  function resolve(route: string): RoutedBinding | undefined {
    const selection = routes.current(route);
    const selected = target(route, selection?.bindingId, selection?.fingerprint);
    const primary = selected ? { ...selected, routeBackup: configuredBackup(selected) ?? null } : inherited(route);
    if (!primary || !selection || selection.standbyMode === "inherit") return primary;
    return { ...primary, routeBackup: selection.standbyMode === "custom" ? explicitBackup(route, primary, selection) ?? null : null };
  }

  function backup(primary: Binding | RoutedBinding) {
    return "routeBackup" in primary ? primary.routeBackup ?? undefined : configuredBackup(primary);
  }

  function vision(route: string) {
    const id = route.startsWith("qq:") ? options.groupVisionProfiles?.[route.split(":").at(-1)!] : undefined;
    const binding = id ? bindings.get(`profile:${id}`) : resolve(route);
    return binding?.model.vision && usable(binding) ? binding : undefined;
  }

  function routeView(route: string) {
    const current = routes.current(route);
    const currentBinding = target(route, current?.bindingId, current?.fingerprint);
    const base = inherited(route);
    const effective = resolve(route);
    return {
      route, version: current?.version ?? 0, selectedBindingId: current?.bindingId ?? null,
      effectiveBindingId: effective?.id ?? null, inheritedBindingId: base?.id ?? null,
      visionBindingId: vision(route)?.id ?? null,
      backupBindingId: (effective && backup(effective)?.id) ?? null, canTest: !!effective && usable(effective),
      selectionUnavailable: !!current?.bindingId && !currentBinding,
      standbyMode: current?.standbyMode ?? "inherit", selectedStandbyBindingId: current?.standbyBindingId ?? null,
      standbyUnavailable: current?.standbyMode === "custom" && !effective?.routeBackup,
      choices: [...bindings.values()].filter(binding => available(route, binding)).map(binding => ({
        id: binding.id, name: binding.model.name, model: binding.model.model, available: usable(binding), vision: binding.model.vision === true,
        host: binding.fingerprint ? validateEndpoint(binding.model.baseUrl).host : null,
      })),
      history: routes.history(route).map(({ fingerprint, standbyFingerprint, ...revision }) => {
        const selected = target(route, revision.bindingId, fingerprint);
        return { ...revision, available: (revision.bindingId === null || !!selected) &&
          (revision.standbyMode !== "custom" || !!explicitBackup(route, selected ?? base, { ...revision, fingerprint, standbyFingerprint })) };
      }),
    };
  }

  return {
    get(id: string) { return bindings.get(id); },
    route: routeView,
    resolveRoute: resolve,
    vision,
    changeRoute(route: string, expectedVersion: number, bindingId: string | null, rollback: number | null,
        standby?: { mode: StandbyMode; bindingId: string | null }) {
      const current = routes.current(route);
      if ((current?.version ?? 0) !== expectedVersion) return { status: "conflict" as const, version: current?.version ?? 0 };
      let selection: ModelRouteTarget;
      if (rollback !== null) {
        const previous = routes.revision(route, rollback);
        if (!previous) return { status: "missing" as const };
        selection = previous;
      } else {
        selection = { bindingId, fingerprint: bindingId ? bindings.get(bindingId)?.fingerprint ?? null : null,
          standbyMode: standby?.mode ?? current?.standbyMode ?? "inherit",
          standbyBindingId: standby ? standby.bindingId : current?.standbyBindingId ?? null,
          standbyFingerprint: standby ? standby.bindingId ? bindings.get(standby.bindingId)?.fingerprint ?? null : null
            : current?.standbyFingerprint ?? null };
      }
      const primary = target(route, selection.bindingId, selection.fingerprint);
      if (selection.bindingId !== null && !primary) return { status: "unavailable" as const };
      if (selection.standbyMode === "custom" && !explicitBackup(route, primary ?? inherited(route), selection)) {
        return { status: "unavailable" as const };
      }
      return routes.change(route, expectedVersion, selection, rollback);
    },
    backup,
    select(purpose: RequestPurpose, scope?: string) {
      if (summaryPurposes.includes(purpose)) return resolve("summary");
      if (purpose === "private") return resolve("private");
      if (groupPurposes.includes(purpose) && scope?.startsWith("qq:")) return resolve(scope);
      return resolve("default");
    },
    all() { return [...bindings.values()]; },
    list(since: string) {
      return [...bindings.values()].map(binding => {
        const { id, groupId, backupFor, model, key, purposes, usageKey } = binding;
        let host = "";
        let hasBalance = false;
        try {
          host = validateEndpoint(model.baseUrl).host;
          hasBalance = !!key && billingAvailable(model);
        } catch { /* An invalid endpoint is still visible for the operator to fix. */ }
        return {
          id, groupId, backupFor, purposes, modelName: model.name, model: model.model, billing: readBillingProvider(model.billing),
          accountLabel: model.billingAccount || null, host, keyConfigured: !!key, hasBalance,
          canTest: !!host && (!model.hasKey || !!key),
          lastUsed: lastUsed.get(usageKey)?.last_used ?? null, usage: usage.all(usageKey, since),
        };
      });
    },
  };
}

function readConfiguredProfile(model: Partial<ModelProfile> | undefined, error: string) {
  if (!model || [model.id, model.name, model.model, model.baseUrl].some(field => typeof field !== "string" || !field.trim()) ||
      typeof model.hasKey !== "boolean" || typeof model.billingAccount !== "string" || !/^[A-Z]{3}$/.test(model.currency ?? "") ||
      (model.vision !== undefined && typeof model.vision !== "boolean") ||
      [model.inputPrice, model.outputPrice].some(price => price !== null && (typeof price !== "number" || !Number.isFinite(price) || price < 0)) ||
      model.billing !== readBillingProvider(model.billing)) throw new Error(error);
  validateEndpoint(model.baseUrl!);
  return model as ModelProfile;
}

export function readServiceModelProfiles(input: unknown) {
  if (input === undefined) return [];
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("modelProfiles 必须是档案标识到模型的对象。");
  return Object.entries(input).map(([id, model]) => {
    if (!/^[\w-]{1,80}$/u.test(id)) throw new Error("共享模型档案标识无效。");
    return [id, readConfiguredProfile(model, `共享模型档案无效：${id}`)] as const;
  });
}

export function readBackupModels(input: unknown, options: Pick<GroupServiceOptions, "model" | "summaryModel" | "groupModels" | "modelProfiles">) {
  if (input === undefined) return [];
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("backupModels 必须是主模型档案到备用档案的对象。");
  const slots = new Set([...(options.model ? ["default"] : []), ...(options.summaryModel ? ["summary"] : []),
    ...Object.keys(options.groupModels ?? {}).map(id => `group:${id}`), ...Object.keys(options.modelProfiles ?? {}).map(id => `profile:${id}`)]);
  return Object.entries(input).map(([id, model]: [string, Partial<ModelProfile> | undefined]) => {
    if (!slots.has(id)) throw new Error(`备用模型档案没有对应的主档案：${id}`);
    return [id, readConfiguredProfile(model, `备用模型档案无效：${id}`)] as const;
  });
}

import type { ModelProfile } from "./models.js";
import { budgetWindows } from "./service-budget.js";
import type { openStore } from "./store.js";

type PeriodLimits = { daily: number | null; monthly: number | null };
const unlimited: PeriodLimits = { daily: null, monthly: null };
const periods = ["daily", "monthly"] as const;
const periodLabel = { daily: "今日", monthly: "本月" };

function readLimits(input: unknown, integers: boolean): PeriodLimits {
  const limits = input as Partial<PeriodLimits> | null;
  const valid = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isFinite(value) &&
    value >= 0 && (integers ? Number.isSafeInteger(value) : value <= Number.MAX_SAFE_INTEGER));
  if (!limits || !valid(limits.daily) || !valid(limits.monthly)) {
    throw new Error(integers ? "请求上限请输入非负整数，留空代表不限额。" : "费用上限请输入非负数字，留空代表不限额。");
  }
  return { daily: limits.daily, monthly: limits.monthly };
}

function atCostLimit(used: number, limit: number) {
  return used >= limit || limit - used <= Number.EPSILON * limit * 8;
}

export function openDesktopModelBudgets(store: ReturnType<typeof openStore>) {
  const { db } = store;
  db.exec("CREATE INDEX IF NOT EXISTS requests_model_time ON requests(model_id, created_at)");
  const totals = db.prepare(`SELECT COUNT(*) AS requests,
    COALESCE(SUM(CASE WHEN currency=$currency AND estimated_cost>=0 THEN estimated_cost END),0) AS cost,
    COUNT(CASE WHEN currency=$currency AND status<>'running' AND (estimated_cost IS NULL OR estimated_cost<0) THEN 1 END) AS unpriced,
    COUNT(CASE WHEN currency=$currency AND status='running' THEN 1 END) AS pending
    FROM requests WHERE model_id=$model AND created_at>=$start AND created_at<$reset`);
  const requestKey = (id: string) => `desktopModelBudget:${id}:requests`;
  const costKey = (model: ModelProfile) => `desktopModelBudget:${model.id}:cost:${model.currency}`;
  function limits(model: ModelProfile) {
    return {
      requests: store.setting(requestKey(model.id), unlimited),
      cost: store.setting(costKey(model), unlimited),
    };
  }
  function usage(model: ModelProfile, window: { start: string; reset: string }) {
    const row = totals.get({ currency: model.currency, model: model.id, ...window })!;
    return { requests: Number(row.requests), cost: Number(row.cost), unpriced: Number(row.unpriced), pending: Number(row.pending) };
  }
  return {
    snapshot(model: ModelProfile, now: number) {
      const windows = budgetWindows(now);
      return {
        currency: model.currency, limits: limits(model),
        daily: usage(model, windows.daily), monthly: usage(model, windows.monthly),
      };
    },
    set(model: ModelProfile, input: { currency?: unknown; requests?: unknown; cost?: unknown }) {
      if (input.currency !== model.currency) throw new Error("模型计费币种已变更，请刷新档案后再保存。");
      const requests = readLimits(input.requests, true);
      const cost = readLimits(input.cost, false);
      store.saveSetting(requestKey(model.id), requests);
      store.saveSetting(costKey(model), cost);
    },
    remove(id: string) {
      db.prepare("DELETE FROM settings WHERE key GLOB ?").run("desktopModelBudget:" + id + ":*");
    },
    check(model: ModelProfile, now: number) {
      const windows = budgetWindows(now);
      const current = limits(model);
      for (const period of periods) {
        const requestLimit = current.requests[period];
        const costLimit = current.cost[period];
        if (requestLimit === null && costLimit === null) continue;
        const used = usage(model, windows[period]);
        const name = `「${model.name}」`;
        if (requestLimit !== null && used.requests >= requestLimit) {
          throw new Error(`${name}已达${periodLabel[period]}本机请求上限。`);
        }
        if (costLimit !== null && atCostLimit(used.cost, costLimit)) {
          throw new Error(`${name}已达${periodLabel[period]}本机估算费用上限（${model.currency}）。`);
        }
        if (costLimit !== null && used.pending > 0) {
          throw new Error(`${name}还有模型请求在计量，完成后可重试。`);
        }
      }
    },
  };
}

export type DesktopModelBudget = ReturnType<ReturnType<typeof openDesktopModelBudgets>["snapshot"]>;

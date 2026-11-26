import type { ModelProfile } from "./models.js";
import type { openStore } from "./store.js";

export type RequestPurpose = "reply" | "summary" | "proactive" | "conversation-preview" | "group-reminder" | "private" | "private-greeting" |
  "profile" | "qzone" | "role-diary" | "model-test" | "voice-transcription" | "voice-synthesis";
type PeriodLimits = { daily: number | null; monthly: number | null };
type CurrencyLimits = PeriodLimits & { currency: string };
type BudgetPolicy = { version: number; warningPercent: number; pauseOnCostLimit: boolean; background: PeriodLimits; currencies: CurrencyLimits[] };
type UsageRow = { currency: string; spent: number; background: number; unpriced: number; running: number };
type UsageResult = { inputTokens: number | null; outputTokens: number | null; estimatedCost: number | null };

const setting = "serviceUsageBudget";
const defaultPolicy: BudgetPolicy = {
  version: 0, warningPercent: 80, pauseOnCostLimit: false,
  background: { daily: null, monthly: null }, currencies: [],
};
const currencyCode = /^[A-Z]{3}$/u;
const periods = ["daily", "monthly"] as const;
const shanghaiOffset = 8 * 60 * 60_000;

export function budgetWindows(timestamp: number) {
  const local = new Date(timestamp + shanghaiOffset);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const date = local.getUTCDate();
  const boundary = (targetMonth: number, day: number) => new Date(Date.UTC(year, targetMonth, day) - shanghaiOffset).toISOString();
  return { daily: { start: boundary(month, date), reset: boundary(month, date + 1) },
    monthly: { start: boundary(month, 1), reset: boundary(month + 1, 1) } };
}

function readLimits(input: unknown, integer: boolean): PeriodLimits {
  const limits = input as PeriodLimits | null;
  const valid = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value) &&
    value >= 0 && (integer ? Number.isSafeInteger(value) : value <= Number.MAX_SAFE_INTEGER));
  if (!limits || !valid(limits.daily) || !valid(limits.monthly)) throw new Error("预算请输入非负数字，留空代表不限额。");
  return { daily: limits.daily, monthly: limits.monthly };
}

function readBudget(input: unknown, version: number): BudgetPolicy {
  const next = input as BudgetPolicy | null;
  if (!next || !Number.isInteger(next.warningPercent) || next.warningPercent < 1 || next.warningPercent > 100 ||
      typeof next.pauseOnCostLimit !== "boolean" || !Array.isArray(next.currencies) || next.currencies.length > 16) {
    throw new Error("请检查预算告警阈值、操作和币种设置。");
  }
  const seen = new Set<string>();
  const currencies = next.currencies.flatMap(entry => {
    if (typeof entry?.currency !== "string" || !currencyCode.test(entry.currency) || seen.has(entry.currency)) {
      throw new Error("请输入互不重复的三位大写币种代码。");
    }
    seen.add(entry.currency);
    const limits = readLimits(entry, false);
    return limits.daily === null && limits.monthly === null ? [] : [{ currency: entry.currency, ...limits }];
  });
  return { version, warningPercent: next.warningPercent, pauseOnCostLimit: next.pauseOnCostLimit,
    background: readLimits(next.background, true), currencies };
}

function meter(used: number, limit: number | null, warn: number) {
  const status = limit === null ? "off" : used >= limit ? "limit" : used >= limit * (warn / 100) ? "warning" : "normal";
  return { used, limit, status, remaining: limit === null ? null : Math.max(0, limit - used) };
}

const periodNames = { daily: "今日", monthly: "本月" };
const backgroundPurposes: RequestPurpose[] = ["summary", "proactive", "conversation-preview", "group-reminder", "private-greeting", "profile", "qzone", "role-diary"];

export function openServiceBudget(store: ReturnType<typeof openStore>, modelCurrencies: string[]) {
  const { db } = store;
  if (!db.prepare("PRAGMA table_info(requests)").all().some(column => column.name === "model_binding")) {
    db.exec("ALTER TABLE requests ADD COLUMN model_binding TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS requests_time ON requests(created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS requests_model_binding_time ON requests(model_binding, created_at) WHERE model_binding IS NOT NULL");
  db.prepare("UPDATE requests SET status='unknown' WHERE status='running'").run();
  const stats = db.prepare(`SELECT currency,
    COALESCE(SUM(CASE WHEN estimated_cost>=0 THEN estimated_cost END),0) AS spent,
    COUNT(CASE WHEN ${backgroundPurposes.map(purpose => `scope GLOB '${purpose}:*'`).join(" OR ")} THEN 1 END) AS background,
    COUNT(CASE WHEN (estimated_cost IS NULL OR estimated_cost<0) AND status<>'running' THEN 1 END) AS unpriced,
    COUNT(CASE WHEN status='running' THEN 1 END) AS running
    FROM requests WHERE created_at>=? AND created_at<? GROUP BY currency`);
  if (!db.prepare("PRAGMA table_info(requests)").all().some(column => column.name === "background_job_id")) {
    db.exec("ALTER TABLE requests ADD COLUMN background_job_id INTEGER");
  }
  const reserve = db.prepare(`INSERT INTO requests (model_id,model_name,scope,created_at,status,currency,duration_ms,model_binding,background_job_id)
    VALUES (?,?,?,?,'running',?,0,?,?)`);
  const settle = db.prepare(`UPDATE requests SET status=?,input_tokens=?,output_tokens=?,estimated_cost=?,duration_ms=?
    WHERE id=? AND status='running'`);
  const release = db.prepare("DELETE FROM requests WHERE id=? AND status='running'");
  const backgroundUsed = (rows: UsageRow[]) => rows.reduce((sum, row) => sum + row.background, 0);
  const policy = () => store.setting<BudgetPolicy>(setting, defaultPolicy);
  function usage(period: { start: string; reset: string }) {
    return stats.all(period.start, period.reset) as unknown as UsageRow[];
  }
  function blocked(currency: string, purpose: RequestPurpose, now = Date.now()) {
    if (!backgroundPurposes.includes(purpose)) return null;
    const current = policy();
    const costs = current.pauseOnCostLimit ? current.currencies.find(row => row.currency === currency) : undefined;
    const windows = budgetWindows(now);
    for (const period of periods) {
      const requests = current.background[period];
      const limit = costs?.[period] ?? null;
      if (requests === null && limit === null) continue;
      const rows = usage(windows[period]);
      if (requests !== null && backgroundUsed(rows) >= requests) return `已达${periodNames[period]}后台请求上限`;
      if (limit !== null && (rows.find(row => row.currency === currency)?.spent ?? 0) >= limit) {
        return `${currency} 已达${periodNames[period]}估算费用上限，后台任务已暂停`;
      }
    }
    return null;
  }

  return {
    blocked,
    update(input: unknown) {
      const current = policy();
      if ((input as { version?: unknown } | null)?.version !== current.version) return false;
      store.saveSetting(setting, readBudget(input, current.version + 1));
      return true;
    },
    start(model: ModelProfile, purpose: RequestPurpose, scope: string, now: number, usageKey?: string, backgroundJobId?: number) {
      const reason = blocked(model.currency, purpose, now);
      if (reason) return { reason };
      return { id: reserve.run(model.id, model.name, `${purpose}:${scope}`, new Date(now).toISOString(), model.currency,
        usageKey ?? null, backgroundJobId ?? null).lastInsertRowid };
    },
    finish(id: number | bigint, status: "ok" | "empty" | "cancelled" | "failed", elapsed: number, result?: UsageResult) {
      const cost = result?.estimatedCost;
      settle.run(status, result?.inputTokens ?? null, result?.outputTokens ?? null,
        typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null, elapsed, id);
    },
    releaseUnused(id: number | bigint) { release.run(id); },
    snapshot(now = Date.now()) {
      const current = policy();
      const windows = budgetWindows(now);
      const daily = usage(windows.daily);
      const monthly = usage(windows.monthly);
      const currencies = [...new Set([...modelCurrencies, ...current.currencies.map(row => row.currency), ...monthly.map(row => row.currency)])]
        .filter(code => currencyCode.test(code)).sort();
      const amount = (rows: UsageRow[], currency: string, limit: number | null) => {
        const found = rows.find(row => row.currency === currency);
        return { ...meter(found?.spent ?? 0, limit, current.warningPercent), unpriced: found?.unpriced ?? 0, running: found?.running ?? 0 };
      };
      return { policy: current, resetsAt: { daily: windows.daily.reset, monthly: windows.monthly.reset },
        background: { daily: meter(backgroundUsed(daily), current.background.daily, current.warningPercent),
          monthly: meter(backgroundUsed(monthly), current.background.monthly, current.warningPercent) },
        currencies: currencies.map(currency => {
          const limit = current.currencies.find(row => row.currency === currency);
          return { currency, daily: amount(daily, currency, limit?.daily ?? null), monthly: amount(monthly, currency, limit?.monthly ?? null) };
        }),
      };
    },
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { budgetWindows, openServiceBudget } from "../runtime/service-budget";
import { openStore } from "../runtime/store";
import type { ModelProfile } from "../runtime/models";

test("budget windows roll over at midnight in Beijing", () => {
  const end = budgetWindows(Date.parse("2026-11-30T15:59:59.999Z"));
  assert.equal(end.daily.reset, "2026-11-30T16:00:00.000Z");
  assert.equal(end.monthly.reset, end.daily.reset);
  const next = budgetWindows(Date.parse(end.monthly.reset));
  assert.equal(next.monthly.start, end.monthly.reset);
  assert.equal(next.monthly.reset, "2026-12-31T16:00:00.000Z");
});

test("budget reserves background requests, separates currencies, and counts unknown cost", () => {
  const store = openStore(":memory:");
  try {
    const ledger = openServiceBudget(store, ["CNY", "USD"]);
    const now = Date.parse("2026-11-24T10:00:00.000Z");
    const model = (currency: string): ModelProfile => ({ id: currency, name: "Mock", model: "mock",
      baseUrl: "http://127.0.0.1:0", billing: "none", billingAccount: "", hasKey: false, inputPrice: null, outputPrice: null, currency });
    const priceLimits = { currency: "CNY", daily: 10, monthly: 20 };
    const policy = { version: 0, warningPercent: 80, pauseOnCostLimit: false,
      background: { daily: 1, monthly: 2 }, currencies: [priceLimits] };
    assert.throws(() => ledger.update({ ...policy, background: { daily: 1.5, monthly: null } }));
    assert.equal(ledger.update(policy), true);
    assert.equal(ledger.update(policy), false);

    const pending = ledger.start(model("CNY"), "summary", "group:example", now);
    assert.notEqual(pending.id, undefined);
    assert.equal(ledger.snapshot(now).background.daily.used, 1);
    assert.equal(ledger.snapshot(now).currencies[0].daily.running, 1);
    assert.match(ledger.start(model("USD"), "profile", "group:example", now).reason!, /今日后台请求上限/);
    const direct = ledger.start(model("CNY"), "reply", "group:example", now);
    assert.notEqual(direct.id, undefined);
    ledger.finish(pending.id!, "failed", 10);
    ledger.finish(direct.id!, "ok", 10, { inputTokens: 1, outputTokens: 1, estimatedCost: 8 });
    const [cny] = ledger.snapshot(now).currencies;
    assert.equal(cny.daily.status, "warning");
    assert.equal(cny.daily.remaining, 2);
    assert.equal(cny.daily.unpriced, 1);

    assert.equal(ledger.update({ ...policy, version: 1, pauseOnCostLimit: true,
      background: { daily: null, monthly: 2 } }), true);
    const capped = ledger.start(model("CNY"), "private", "private:example", now);
    ledger.finish(capped.id!, "ok", 2, { inputTokens: 1, outputTokens: 1, estimatedCost: 2 });
    assert.match(ledger.start(model("CNY"), "summary", "group:example", now).reason!, /CNY.*费用上限/);
    const other = ledger.start(model("USD"), "proactive", "group:example", now);
    assert.notEqual(other.id, undefined);
    assert.equal(ledger.snapshot(now).background.monthly.status, "limit");
    const tomorrow = now + 86_400_000;
    const restarted = openServiceBudget(store, ["CNY", "USD"]);
    assert.equal(restarted.snapshot(tomorrow).background.daily.used, 0);
    assert.equal(restarted.snapshot(tomorrow).background.monthly.used, 2);
    assert.match(restarted.blocked("USD", "summary", tomorrow)!, /本月后台请求上限/);
    assert.equal(restarted.snapshot(now).currencies[1].monthly.unpriced, 1);
    assert.equal(restarted.snapshot(now).currencies[1].monthly.running, 0);
    assert.equal(store.db.prepare("SELECT status FROM requests WHERE id=?").get(other.id!)?.status, "unknown");
    assert.equal(restarted.blocked("CNY", "summary", Date.parse("2026-12-01T00:00:00Z")), null);
  } finally { store.db.close(); }
});

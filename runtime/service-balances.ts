import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { balance, billingAvailable, readBillingProvider, type BalanceSnapshot, type BillingProvider, type ModelProfile } from "./models.js";

type BalanceBinding = { id: string; model: ModelProfile; key?: string };
type Provider = Exclude<BillingProvider, "none">;
type Credential = { id: string; name: string; model: ModelProfile; key: string; ref: string; label: string };
type Subject = { provider: Provider; members: Credential[]; accountLabel: string | null; accountConflict: boolean };
type Saved = { ref: string; attempted_at: string; latest: string; last_successful: string | null };

const freshnessMs = 15 * 60_000;
const successful = (result: BalanceSnapshot) => result.status === "available" || result.status === "unlimited";

function usableProvider(model: ModelProfile) {
  try {
    return billingAvailable(model) ? readBillingProvider(model.billing) : "none";
  } catch { return "none"; }
}

export function openServiceBalances(db: DatabaseSync, bindings: readonly BalanceBinding[], adminToken: string) {
  const byBinding = new Map<string, Credential>();
  const keys = new Map<string, { provider: Provider; members: Credential[] }>();
  for (const { id, model, key } of bindings) {
    const provider = usableProvider(model);
    if (provider === "none" || !key) continue;
    const ref = createHmac("sha256", adminToken).update(JSON.stringify(["provider-balance", provider, key])).digest("hex");
    const label = provider === "deepseek" && typeof model.billingAccount === "string" ? model.billingAccount.trim() : "";
    const member = { id, name: model.name, model, key, ref, label };
    byBinding.set(id, member);
    const group = keys.get(ref);
    if (group) group.members.push(member);
    else keys.set(ref, { provider, members: [member] });
  }
  const accounts = new Map<string, Subject>();
  const subjects: Subject[] = [];
  for (const { provider, members } of keys.values()) {
    const labels = [...new Set(members.map(member => member.label).filter(Boolean))];
    const accountLabel = labels.length === 1 ? labels[0] : null;
    const account = accountLabel ? accounts.get(accountLabel) : undefined;
    if (account) account.members.push(...members);
    else {
      const subject = { provider, members, accountLabel, accountConflict: labels.length > 1 };
      subjects.push(subject);
      if (accountLabel) accounts.set(accountLabel, subject);
    }
  }

  db.exec(`CREATE TABLE IF NOT EXISTS provider_balance_snapshots (
    ref TEXT PRIMARY KEY, attempted_at TEXT NOT NULL, latest TEXT NOT NULL, last_successful TEXT
  )`);
  // Backup inspection starts without model profiles. Keep the snapshots for a later normal start.
  if (bindings.length) {
    db.prepare("DELETE FROM provider_balance_snapshots WHERE ref NOT IN (SELECT value FROM json_each(?))")
      .run(JSON.stringify([...keys.keys()]));
  }
  const rows = db.prepare("SELECT ref, attempted_at, latest, last_successful FROM provider_balance_snapshots");
  const save = db.prepare(`INSERT INTO provider_balance_snapshots(ref, attempted_at, latest, last_successful) VALUES (?,?,?,?)
    ON CONFLICT(ref) DO UPDATE SET attempted_at=excluded.attempted_at, latest=excluded.latest,
      last_successful=COALESCE(excluded.last_successful, provider_balance_snapshots.last_successful)`);
  const active = new Map<string, Promise<BalanceSnapshot>>();
  const controller = new AbortController();
  let batch: Promise<ReturnType<typeof overview>> | undefined;

  function saved() {
    return new Map((rows.all() as unknown as Saved[]).map(entry => [entry.ref, entry]));
  }

  function overview(now = Date.now()) {
    const snapshots = saved();
    return { subjects: subjects.map(({ provider, members, accountLabel, accountConflict }) => {
      const known = [...new Set(members.map(member => member.ref))].flatMap(ref => {
        const snapshot = snapshots.get(ref);
        return snapshot ? [snapshot] : [];
      }).sort((a, b) => b.attempted_at.localeCompare(a.attempted_at));
      const latest = known[0] ? JSON.parse(known[0].latest) as BalanceSnapshot : null;
      const lastSuccessful = known.flatMap(row => row.last_successful ? [JSON.parse(row.last_successful) as BalanceSnapshot] : [])
        .sort((a, b) => (b.checkedAt ?? "").localeCompare(a.checkedAt ?? ""))[0] ?? null;
      return {
        provider, scope: provider === "deepseek" ? "account" as const : "key" as const,
        accountLabel, accountConflict,
        profiles: members.map(member => ({ id: member.id, name: member.name })),
        latest, lastSuccessful: latest && successful(latest) ? null : lastSuccessful,
        stale: !!lastSuccessful?.checkedAt && now - Date.parse(lastSuccessful.checkedAt) >= freshnessMs,
      };
    }) };
  }

  function request(member: Credential) {
    const current = active.get(member.ref);
    if (current) return current;
    const task = balance(member.model, member.key, controller.signal).then(result => {
      if (!controller.signal.aborted && result.checkedAt) {
        const serialized = JSON.stringify(result);
        save.run(member.ref, result.checkedAt, serialized, successful(result) ? serialized : null);
      }
      return result;
    }).finally(() => active.delete(member.ref));
    active.set(member.ref, task);
    return task;
  }

  function refreshAll() {
    if (batch) return batch;
    const queue = subjects.values();
    const lastResults = saved();
    async function worker() {
      for (const subject of queue) {
        if (controller.signal.aborted) return;
        const choices = [...new Map(subject.members.map(member => [member.ref, member])).values()];
        choices.sort((a, b) => Number(!!lastResults.get(b.ref)?.last_successful) - Number(!!lastResults.get(a.ref)?.last_successful));
        for (const member of choices) {
          if (controller.signal.aborted) return;
          const result = await request(member);
          if (result.status !== "denied") break;
        }
      }
    }
    batch = Promise.all(Array.from({ length: Math.min(subjects.length, 3) }, () => worker()))
      .then(() => overview()).finally(() => { batch = undefined; });
    return batch;
  }

  return {
    overview,
    refreshAll,
    async refresh(id: string): Promise<BalanceSnapshot> {
      const member = byBinding.get(id);
      return member ? request(member) : { status: "unsupported" };
    },
    stop() { controller.abort(); },
  };
}

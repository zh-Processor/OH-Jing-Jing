import type { DatabaseSync } from "node:sqlite";

export type UsageFilters = { model: string | null; purpose: string | null; binding: string | null };
type UsageQuery = {
  start: string; end: string | null; scope: string | null;
  model: string | null; purpose: string | null; bindingKey: string | null;
};

export function readUsageFilters(query: URLSearchParams): UsageFilters | undefined {
  const model = query.get("model") || null;
  const purpose = query.get("purpose") || null;
  const binding = query.get("binding") || null;
  if ((purpose && !/^[a-z][a-z-]{0,31}$/u.test(purpose)) ||
      (binding && !/^[\w:-]{1,120}$/u.test(binding))) return undefined;
  return { model, purpose, binding };
}

export function openServiceUsage(db: DatabaseSync) {
  const purpose = "substr(scope,1,instr(scope,':')-1)";
  const matches = `
    FROM requests WHERE created_at >= $start AND ($end IS NULL OR created_at < $end)
      AND ($scope IS NULL OR scope = $scope OR substr(scope,instr(scope,':')+1) = $scope)
      AND ($model IS NULL OR model_id = $model)
      AND ($purpose IS NULL OR ${purpose} = $purpose)
      AND ($bindingKey IS NULL OR model_binding = $bindingKey)
  `;
  const rows = db.prepare(`
    SELECT model_id, model_name, ${purpose} AS purpose, currency,
      COUNT(*) AS requests, SUM(status IN ('failed','empty','cancelled')) AS failed,
      SUM(status='running') AS running, SUM(status='unknown') AS unknown,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(estimated_cost) AS estimated_cost, COUNT(estimated_cost) AS priced_requests
    ${matches}
    GROUP BY model_id,model_name,purpose,currency ORDER BY purpose,model_name,currency
  `);
  const health = db.prepare(`
    WITH measured AS (
      SELECT status, duration_ms, ROW_NUMBER() OVER (ORDER BY duration_ms) AS rank, COUNT(*) OVER () AS samples
      ${matches} AND status IN ('ok','failed','empty')
    )
    SELECT COUNT(*) AS measured, COUNT(*) FILTER (WHERE status='ok') AS succeeded, AVG(status='ok') AS successRate,
      MAX(duration_ms) FILTER (WHERE rank = (samples * 95 + 99) / 100) AS p95Ms
    FROM measured
  `);
  const models = db.prepare("SELECT model_id AS id, MAX(model_name) AS name FROM requests GROUP BY model_id ORDER BY name,id");
  return {
    rows(query: UsageQuery) { return rows.all(query); },
    health(query: UsageQuery) { return health.get(query); },
    models() { return models.all(); },
  };
}

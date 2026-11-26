import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { UsageFilters } from "./service-usage.js";

const columns = [
  ["用途", "purpose"], ["模型标识", "model_id"], ["模型名称", "model_name"], ["币种", "currency"],
  ["请求次数", "requests"], ["失败或取消", "failed"], ["进行中", "running"], ["结果未知", "unknown"],
  ["输入 Token", "input_tokens"], ["输出 Token", "output_tokens"], ["估算费用", "estimated_cost"], ["已计价请求", "priced_requests"],
] as const;

function csvCell(value: SQLOutputValue | undefined) {
  let text = value == null ? "" : String(value);
  if (typeof value === "string" && /^(?:[\s\u0000-\u001f]*[=+@-]|[\t\r\n])/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function formatUsageCsv(rows: Record<string, SQLOutputValue>[], scope: string | null, start: string, exportedAt: string, filters: UsageFilters) {
  const header = ["范围", "起始时间 UTC", "导出时间 UTC", "筛选模型", "筛选用途", "筛选当前模型档案",
    ...columns.map(([label]) => label)].map(csvCell).join(",");
  const values = rows.map(row => [scope ?? "全部用量", start, exportedAt, filters.model, filters.purpose, filters.binding,
    ...columns.map(([, field]) => row[field])].map(csvCell).join(","));
  return "\uFEFF" + [header, ...values].join("\r\n") + "\r\n";
}

export function openUsageExportAudit(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS usage_export_audit (
    id INTEGER PRIMARY KEY, scope TEXT, days TEXT NOT NULL, start TEXT NOT NULL, created_at TEXT NOT NULL,
    rows INTEGER NOT NULL, actor TEXT NOT NULL, filters TEXT NOT NULL DEFAULT '{}'
  )`);
  if (!db.prepare("PRAGMA table_info(usage_export_audit)").all().some(column => column.name === "filters")) {
    db.exec("ALTER TABLE usage_export_audit ADD COLUMN filters TEXT NOT NULL DEFAULT '{}'");
  }
  const record = db.prepare(`INSERT INTO usage_export_audit (scope,days,start,created_at,rows,actor,filters)
    VALUES (?,?,?,?,?,'管理员',?)`);
  const list = db.prepare(`SELECT id,scope,days,start,created_at AS createdAt,rows,actor,filters
    FROM usage_export_audit ORDER BY id DESC LIMIT 20`);
  return {
    record(scope: string | null, days: string, start: string, createdAt: string, rows: number, filters: UsageFilters) {
      record.run(scope, days, start, createdAt, rows, JSON.stringify(filters));
    },
    recent() { return list.all().map(event => ({ ...event, filters: JSON.parse(String(event.filters)) })); },
  };
}

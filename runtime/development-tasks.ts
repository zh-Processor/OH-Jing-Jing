import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const states = ["queued", "developing", "awaiting-details", "testing", "candidate", "publishing", "published", "failed", "rolled-back", "cancelled"] as const;
const taskIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export type DevelopmentTaskState = typeof states[number];
export type DevelopmentTask = { id: string; target: string; actor: string; requirement: string; acceptance: string;
  state: DevelopmentTaskState; createdAt: string; updatedAt: string; result: string | null; version: string | null };
export type DevelopmentTaskAction = "cancel" | "retry";
export type DevelopmentTaskControl = Pick<DevelopmentTask, "target" | "state" | "updatedAt"> & {
  taskId: string; action: DevelopmentTaskAction;
};
export type DevelopmentTaskView = DevelopmentTask & { availableAction?: DevelopmentTaskAction | null };
export type DevelopmentDetailsUpdate = { target: string; taskId: string; updatedAt: string; details: string };

export function developmentTaskAction(state: DevelopmentTaskState): DevelopmentTaskAction | null {
  if (state === "queued" || state === "developing" || state === "awaiting-details" || state === "testing" || state === "candidate") return "cancel";
  if (state === "failed" || state === "rolled-back") return "retry";
  return null;
}

export function readDevelopmentTaskControl(input: unknown): DevelopmentTaskControl | null {
  if (!input || typeof input !== "object") return null;
  const { target, taskId, action, state, updatedAt } = input as Partial<DevelopmentTaskControl>;
  if (typeof target !== "string" || !/^[\w-]{1,80}$/u.test(target) ||
      typeof taskId !== "string" || !taskIdPattern.test(taskId) ||
      !state || !states.includes(state) || !action || action !== developmentTaskAction(state) ||
      typeof updatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(updatedAt) ||
      !Number.isFinite(Date.parse(updatedAt))) return null;
  return { target, taskId, action, state, updatedAt };
}

export function readDevelopmentRequirement(text: unknown) {
  if (typeof text !== "string") return null;
  const requirement = text.trim();
  return requirement.length >= 4 && requirement.length <= 2000 ? requirement : null;
}

export function readDevelopmentAcceptance(text: unknown) {
  if (text === undefined) return "";
  if (typeof text !== "string") return null;
  const acceptance = text.trim();
  return acceptance.length <= 1000 ? acceptance : null;
}

function readSupplement(text: unknown) {
  const details = typeof text === "string" ? text.trim() : "";
  return details.length > 0 && details.length <= 1000 ? details : null;
}

export function readDevelopmentDetailsUpdate(input: unknown): DevelopmentDetailsUpdate | null {
  if (!input || typeof input !== "object") return null;
  const { target, taskId, updatedAt, details } = input as Partial<DevelopmentDetailsUpdate>;
  const valid = readDevelopmentTaskControl({ target, taskId, updatedAt, action: "cancel", state: "awaiting-details" });
  const text = readSupplement(details);
  return valid && text ? { target: valid.target, taskId: valid.taskId, updatedAt: valid.updatedAt, details: text } : null;
}

export function developmentCommand(text: string, quoted?: { id: string; revision: string }) {
  const input = text.trim();
  const create = /^\/开发(?:[ \t]|$)\s*([\s\S]*)$/u.exec(input) ??
    (quoted ? null : /^帮我(?:加一个|新增一个)\s*([\s\S]*(?:功能|指令|入口|按钮|页面)[\s\S]*)$/u.exec(input));
  if (create) {
    const content = create[1];
    const boundary = /\r?\n[ \t]*验收条件[：:][ \t]*/u.exec(content);
    const requirement = readDevelopmentRequirement(boundary ? content.slice(0, boundary.index) : content);
    const acceptance = readDevelopmentAcceptance(boundary ? content.slice(boundary.index + boundary[0].length) : undefined);
    return { action: "create" as const, requirement, acceptance };
  }
  const retry = /^\/开发重试(?:\s+([\s\S]*))?$/u.exec(input);
  if (retry) return { action: "retry" as const, id: taskIdPattern.test(retry[1] ?? "") ? retry[1] : null };
  const supplement = /^\/开发补充(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/u.exec(input);
  if (supplement) return { action: "supplement" as const, id: taskIdPattern.test(supplement[1] ?? "") ? supplement[1] : null,
    details: readSupplement(supplement[2]), revision: undefined };
  const status = /^\/开发状态\s+([a-f0-9-]{36})$/u.exec(input);
  if (status) return { action: "status" as const, id: status[1] };
  return quoted ? { action: "supplement" as const, id: quoted.id, details: readSupplement(input), revision: quoted.revision } : null;
}

export function openDevelopmentDatabase(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openDevelopmentTasks(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS development_tasks (
    id TEXT PRIMARY KEY, target TEXT NOT NULL, actor TEXT NOT NULL, source_event TEXT,
    requirement TEXT NOT NULL, acceptance TEXT NOT NULL, state TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT, version TEXT,
    UNIQUE(target, actor, source_event)
  );
  CREATE INDEX IF NOT EXISTS development_tasks_target_state ON development_tasks(target, state, created_at);
  CREATE INDEX IF NOT EXISTS development_tasks_actor ON development_tasks(target, actor, created_at);
  CREATE TABLE IF NOT EXISTS development_worker_leases (target TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS development_result_notices (
    task_id TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(task_id, revision)
  );
  CREATE TABLE IF NOT EXISTS development_notice_retry (
    task_id TEXT NOT NULL, revision TEXT NOT NULL, retry_at INTEGER NOT NULL, PRIMARY KEY(task_id, revision)
  );
  CREATE TABLE IF NOT EXISTS development_detail_events (
    target TEXT NOT NULL, actor TEXT NOT NULL, source_event TEXT NOT NULL, task_id TEXT NOT NULL,
    PRIMARY KEY(target, actor, source_event)
  );`);
  const projection = `id,target,actor,requirement,acceptance,state,created_at AS createdAt,updated_at AS updatedAt,result,version`;
  const get = db.prepare(`SELECT ${projection} FROM development_tasks WHERE target=? AND actor=? AND id=?`);
  const list = db.prepare(`SELECT ${projection} FROM development_tasks WHERE target=? AND actor=? ORDER BY created_at DESC,id DESC LIMIT 50`);
  const insert = db.prepare(`INSERT INTO development_tasks(id,target,actor,source_event,requirement,acceptance,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'queued',?,?) ON CONFLICT(target,actor,source_event) DO NOTHING`);
  const byEvent = db.prepare(`SELECT ${projection} FROM development_tasks WHERE target=? AND actor=? AND source_event=?`);
  const claim = db.prepare(`UPDATE development_tasks SET state='developing',updated_at=? WHERE id=(
    SELECT queued.id FROM development_tasks AS queued WHERE queued.target=? AND queued.state='queued' AND NOT EXISTS (
      SELECT 1 FROM development_tasks AS running WHERE running.target=queued.target AND running.state IN ('developing','testing','candidate','publishing')
    ) ORDER BY queued.created_at,queued.id LIMIT 1
  ) RETURNING ${projection}`);
  const transition = db.prepare(`UPDATE development_tasks SET state=?,
    updated_at=MAX(?,strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds')),result=?,version=COALESCE(?,version)
    WHERE target=? AND id=? AND state=? RETURNING ${projection}`);
  const changeTask = db.prepare(`UPDATE development_tasks SET state=?,updated_at=?,result=?,version=NULL
    WHERE target=? AND actor=? AND id=? AND state=? AND updated_at=? RETURNING ${projection}`);
  const addDetails = db.prepare(`UPDATE development_tasks SET requirement=?,state='queued',updated_at=?,result=NULL,version=NULL
    WHERE target=? AND actor=? AND id=? AND state='awaiting-details' AND updated_at=? RETURNING ${projection}`);
  const saveDetailEvent = db.prepare("INSERT INTO development_detail_events VALUES (?,?,?,?)");
  const detailEvent = db.prepare("SELECT task_id FROM development_detail_events WHERE target=? AND actor=? AND source_event=?");
  const takeLease = db.prepare(`INSERT INTO development_worker_leases VALUES(?,?,?) ON CONFLICT(target) DO UPDATE
    SET owner=excluded.owner,expires=excluded.expires WHERE development_worker_leases.expires<=?`);
  const extendLease = db.prepare("UPDATE development_worker_leases SET expires=? WHERE target=? AND owner=? AND expires>?");
  const dropLease = db.prepare("DELETE FROM development_worker_leases WHERE target=? AND owner=?");
  const requeue = db.prepare(`UPDATE development_tasks SET state='queued',updated_at=?,result='恢复中断的未发布任务。',version=NULL
    WHERE target=? AND state IN ('developing','testing','candidate')`);
  const publishing = db.prepare(`SELECT ${projection} FROM development_tasks WHERE target=? AND state='publishing'`);
  const lastPublished = db.prepare(`SELECT ${projection} FROM development_tasks WHERE target=? AND state='published'
    ORDER BY updated_at DESC, id DESC LIMIT 1`);
  const notices = db.prepare(`SELECT ${projection}, source_event AS sourceEvent FROM development_tasks WHERE target=?
    AND state IN ('awaiting-details','published','rolled-back','failed','cancelled') AND source_event GLOB ?
    AND NOT EXISTS (SELECT 1 FROM development_result_notices WHERE task_id=development_tasks.id AND revision=development_tasks.updated_at)
    AND NOT EXISTS (SELECT 1 FROM development_notice_retry WHERE task_id=development_tasks.id AND revision=development_tasks.updated_at AND retry_at>?)
    ORDER BY updated_at,id LIMIT 24`);
  const acknowledged = db.prepare("INSERT OR IGNORE INTO development_result_notices VALUES(?,?)");
  const retryNotice = db.prepare(`INSERT INTO development_notice_retry VALUES(?,?,?)
    ON CONFLICT(task_id,revision) DO UPDATE SET retry_at=excluded.retry_at`);
  const clearRetry = db.prepare("DELETE FROM development_notice_retry WHERE task_id=? AND revision=?");
  const activeWorker = db.prepare("SELECT 1 FROM development_worker_leases WHERE target=? AND expires>?");
  const counts = db.prepare("SELECT state,COUNT(*) AS count FROM development_tasks WHERE target=? GROUP BY state ORDER BY state");
  const moves: Record<DevelopmentTaskState, DevelopmentTaskState[]> = {
    queued: ["cancelled"], developing: ["awaiting-details", "testing", "failed", "cancelled"], "awaiting-details": ["queued", "cancelled"],
    testing: ["candidate", "failed", "cancelled"],
    candidate: ["publishing", "failed", "cancelled"], publishing: ["published", "failed", "rolled-back"], published: [],
    failed: ["queued"], "rolled-back": ["queued"], cancelled: [],
  };
  function addSupplement(target: string, actor: string, id: string, details: string, sourceEvent: string, expected?: string) {
    const current = get.get(target, actor, id) as DevelopmentTask | undefined;
    if (!current) return { status: "missing" as const };
    const previous = detailEvent.get(target, actor, sourceEvent);
    if (previous?.task_id === id) return { status: "updated" as const, task: current };
    if (previous || current.state !== "awaiting-details" || (expected && current.updatedAt !== expected)) return { status: "conflict" as const };
    const requirement = readDevelopmentRequirement(`${current.requirement}\n\n补充说明\n${details}`);
    if (!requirement || !readSupplement(details)) return { status: "invalid" as const };
    const revision = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
    const task = addDetails.get(requirement, revision, target, actor, id, current.updatedAt) as DevelopmentTask | undefined;
    if (!task) return { status: "conflict" as const };
    saveDetailEvent.run(target, actor, sourceEvent, id);
    return { status: "updated" as const, task };
  }
  return {
    get(target: string, actor: string, id: string) { return get.get(target, actor, id) as DevelopmentTask | undefined; },
    list(target: string, actor: string) { return list.all(target, actor) as DevelopmentTask[]; },
    enqueue(target: string, actor: string, requirement: string, acceptance: string, sourceEvent: string) {
      const id = randomUUID();
      const now = new Date().toISOString();
      insert.run(id, target, actor, sourceEvent, requirement, acceptance, now, now);
      return byEvent.get(target, actor, sourceEvent) as DevelopmentTask;
    },
    supplement(target: string, actor: string, id: string, details: string, sourceEvent: string, expected?: string) {
      db.exec("SAVEPOINT supplement_development");
      try {
        const result = addSupplement(target, actor, id, details, sourceEvent, expected);
        db.exec("RELEASE supplement_development");
        return result;
      } catch (error) {
        db.exec("ROLLBACK TO supplement_development; RELEASE supplement_development");
        throw error;
      }
    },
    claim(target: string) { return claim.get(new Date().toISOString(), target) as DevelopmentTask | undefined; },
    control(actor: string, request: DevelopmentTaskControl) {
      const { target, taskId, state, updatedAt, action } = request;
      if (!get.get(target, actor, taskId)) return { status: "missing" as const };
      if (developmentTaskAction(state) !== action) return { status: "conflict" as const };
      const cancelling = action === "cancel";
      const revision = new Date(Math.max(Date.now(), Date.parse(updatedAt) + 1)).toISOString();
      const task = changeTask.get(cancelling ? "cancelled" : "queued", revision, cancelling ? "维护者取消了任务。" : null,
        target, actor, taskId, state, updatedAt) as DevelopmentTask | undefined;
      return task ? { status: "updated" as const, task } : { status: "conflict" as const };
    },
    acquireWorker(target: string, owner: string, now = Date.now()) { return takeLease.run(target, owner, now + 90_000, now).changes === 1; },
    extendWorker(target: string, owner: string, now = Date.now()) { return extendLease.run(now + 90_000, target, owner, now).changes === 1; },
    releaseWorker(target: string, owner: string) { dropLease.run(target, owner); },
    requeueBeforePublish(target: string) { return requeue.run(new Date().toISOString(), target).changes; },
    publishing(target: string) { return publishing.all(target) as DevelopmentTask[]; },
    lastPublished(target: string) { return lastPublished.get(target) as DevelopmentTask | undefined; },
    hasNotices(target: string, account?: string, now = Date.now()) {
      return !!notices.get(target, account ? `qq-private:${account}:*` : "qq-private:*", now);
    },
    notices(target: string, account: string, now = Date.now()) {
      return notices.all(target, `qq-private:${account}:*`, now) as (DevelopmentTask & { sourceEvent: string })[];
    },
    deferNotice(task: DevelopmentTask, now = Date.now()) { retryNotice.run(task.id, task.updatedAt, now + 30_000); },
    acknowledge(task: DevelopmentTask) {
      acknowledged.run(task.id, task.updatedAt);
      clearRetry.run(task.id, task.updatedAt);
    },
    status(target: string) {
      const last = lastPublished.get(target) as DevelopmentTask | undefined;
      return { workerOnline: !!activeWorker.get(target, Date.now()), states: counts.all(target),
        lastPublished: last ? { version: last.version, at: last.updatedAt } : null };
    },
    transition(target: string, id: string, previous: DevelopmentTaskState, next: DevelopmentTaskState,
        result: string | null = null, version: string | null = null) {
      if (!moves[previous].includes(next)) throw new Error(`Invalid development task transition ${previous} -> ${next}`);
      return transition.get(next, new Date().toISOString(), result, version, target, id, previous) as DevelopmentTask | undefined;
    },
  };
}

export type DevelopmentCandidate = { version: string; artifact: string; report: string };
const developmentFailureMessages = {
  "no-candidate": "开发阶段未提交可验收的代码改动。请补充具体场景和期望行为后重新提交。",
  "unchanged-candidate": "候选没有修改服务代码。请补充要变更的行为和验收条件后重新提交。",
  "invalid-baseline": "开发阶段无法核对上一次发布的源码基线。需要先恢复基线才能重试。",
  "model-authorization": "开发模型拒绝了访问。请维护者核对测试实例的模型配置和凭据。",
  "model-unavailable": "开发模型未完成请求。请维护者查看开发日志中的错误类别。",
  "transient-model": "开发模型暂时不可用。任务未进入发布，可以从任务面板重试。",
} as const;

export class DevelopmentTaskFailure extends Error {
  constructor(readonly reason: keyof typeof developmentFailureMessages) {
    super(developmentFailureMessages[reason]);
  }
}

export function readDevelopmentQuestion(value: unknown) {
  const question = typeof value === "string" ? value.trim() : "";
  return question.length <= 220 && /[?？。.]$/u.test(question) && /\p{L}/u.test(question) &&
    !/[\p{C}<>@]|\[CQ:|https?:\/\/|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/iu.test(question) ? question : null;
}

export class DevelopmentTaskClarification extends Error {
  constructor(question: string) {
    super(readDevelopmentQuestion(question) ?? "能提供一条脱敏示例，并说明希望产生什么结果吗？");
  }
}

type DevelopmentDriver = {
  develop(task: DevelopmentTask, signal: AbortSignal): Promise<void>;
  verify(task: DevelopmentTask, signal: AbortSignal): Promise<DevelopmentCandidate>;
  publish(task: DevelopmentTask, candidate: DevelopmentCandidate, signal: AbortSignal): Promise<{
    state: "published" | "rolled-back" | "failed"; report: string;
  }>;
};

export async function processDevelopmentTask(queue: ReturnType<typeof openDevelopmentTasks>, target: string,
    driver: DevelopmentDriver, signal: AbortSignal) {
  signal.throwIfAborted();
  let task = queue.claim(target);
  if (!task) return undefined;
  const { id, actor } = task;
  const cancelled = new AbortController();
  const activeSignal = AbortSignal.any([signal, cancelled.signal]);
  const settledCancellation = () => {
    const current = queue.get(target, actor, id);
    return current?.state === "cancelled" ? current : undefined;
  };
  const watch = setInterval(() => {
    if (settledCancellation()) cancelled.abort("operator");
  }, 500);
  function move(next: DevelopmentTaskState, result?: string, version?: string) {
    if (!task) return false;
    task = queue.transition(target, task.id, task.state, next, result?.slice(0, 3000), version);
    return !!task;
  }
  try {
    await driver.develop(task, activeSignal);
    activeSignal.throwIfAborted();
    if (!move("testing") || !task) return settledCancellation();
    const candidate = await driver.verify(task, activeSignal);
    activeSignal.throwIfAborted();
    if (!move("candidate", candidate.report, candidate.version) || !move("publishing", candidate.report) || !task) {
      return settledCancellation();
    }
    clearInterval(watch);
    const outcome = await driver.publish(task, candidate, signal);
    move(outcome.state, `${candidate.report}\n${outcome.report}`);
  } catch (error) {
    const cancellation = settledCancellation();
    if (cancellation) return cancellation;
    if (task && task.state !== "publishing") {
      if (!signal.aborted && task.state === "developing" && error instanceof DevelopmentTaskClarification) {
        move("awaiting-details", error.message);
      } else {
        const developing = task.state === "developing";
        const reason = signal.reason;
        const interruption = reason instanceof DOMException && reason.name === "TimeoutError"
          ? `${developing ? "开发" : "验收"}阶段超过任务时限。任务可重试。` : "任务中断。";
        const result = signal.aborted ? interruption : error instanceof DevelopmentTaskFailure ? error.message :
          developing ? "开发阶段失败，请查看本次任务的开发日志。" : "测试阶段失败，请查看本次任务的验收日志。";
        move("failed", result);
      }
    }
  } finally {
    clearInterval(watch);
  }
  return task;
}

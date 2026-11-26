import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";

const [workspace, configPath, baseline, candidate] = process.argv.slice(2);
assert.ok(workspace && configPath && baseline && candidate, "Pass a scratch directory, model configuration and both service bundles.");
const model = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/u, "")).model;
const key = process.env.OHJINGJING_MODEL_KEY;
delete process.env.OHJINGJING_MODEL_KEY;
assert.ok(model.hasKey && key && new URL(model.baseUrl).protocol === "https:");

const bot = 1001;
const group = 5001;
const otherGroup = 5002;
const scope = `qq:${bot}:${group}`;
const cases = [
  { name: "接梗", text: "把你挂剧院门口，牌子就写今日售罄。", check: answer => answer.length <= 60 &&
    /剧院|招牌|门口|售罄|挂牌|票|场|牌子/u.test(answer) && !/^[（(]/u.test(answer) },
  { name: "认真求助", text: "误删了一份本机文档，现在怎么办？", check: answer => /回收站|版本历史|备份|恢复/u.test(answer) },
  { name: "同人追问", text: "帮我写一句桌游开场白，带上桌游两个字。", follow: "再短一点，保留桌游两个字。",
    check: answer => answer.includes("桌游") && Array.from(answer).length <= 32 },
  { name: "采用同群最新确认", text: "周末桌游最后怎么定的？顺带说一下旧方案。",
    check: answer => /(?:周日|星期日|星期天).{0,8}(?:八点|20[:：]00|8点)/u.test(answer) && !/周一|星期一|21[:：]00/u.test(answer) },
  { name: "撤回旧安排", text: "读书会最后怎么定的？",
    check: answer => /撤回|取消|作废|不再举行/u.test(answer) && !/仍然|照常/u.test(answer) },
];

function seed(db) {
  db.exec("PRAGMA foreign_keys=ON");
  const message = db.prepare("INSERT INTO group_messages(scope,author,content,created_at) VALUES(?,?,?,?)");
  const summary = db.prepare("INSERT INTO group_summaries(scope,first_id,last_id,content,created_at,source_start,source_end) VALUES(?,?,?,?,?,?,?)");
  const topic = db.prepare(`INSERT INTO group_topic_entries(scope,summary_id,topic_key,title,content,first_at,last_at,evidence_count,facts,aliases)
    VALUES(?,?,?,?,?,?,?,1,?,'[]')`);
  const link = db.prepare("INSERT INTO group_topic_sources(topic_id,component,message_id) VALUES(?,?,?)");
  const save = (target, title, text, days, kind) => {
    const at = new Date(Date.now() - days * 86_400_000).toISOString();
    const id = message.run(target, "2001", text, at).lastInsertRowid;
    const batch = summary.run(target, id, id, text, at, at, at).lastInsertRowid;
    const facts = JSON.stringify([{ kind, text, at, evidenceCount: 1 }]);
    const entry = topic.run(target, batch, title, title, text, at, at, facts).lastInsertRowid;
    link.run(entry, 0, id);
    link.run(entry, 1, id);
  };
  save(scope, "周末桌游", "周末桌游原先定在周六晚上七点。", 4, "decision");
  save(scope, "周末桌游", "周末桌游确认改到周日晚上八点。", 3, "change");
  save(`qq:${bot}:${otherGroup}`, "周末桌游", "周末桌游确认定在周一21:00。", 2, "decision");
  save(scope, "读书会", "读书会确认周五晚上七点。", 4, "decision");
  save(scope, "读书会", "读书会确认取消，原安排作废。", 2, "retraction");
}

async function replay(label, entry) {
  const root = join(resolve(workspace), label);
  await mkdir(root, { recursive: true });
  const admin = randomBytes(24).toString("hex");
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const opened = once(gateway, "connection");
  const sent = new Map();
  gateway.on("connection", peer => peer.on("message", input => {
    const frame = JSON.parse(String(input));
    let data = {};
    if (frame.action === "get_status") data = { online: true, good: true };
    if (frame.action === "get_login_info") data = { user_id: bot, nickname: "示例机器人" };
    if (frame.action === "send_group_msg") {
      assert.equal(frame.params.group_id, group);
      const messageId = String(9000 + sent.size + 1);
      sent.set(messageId, frame.params.message.filter(part => part.type === "text").map(part => part.data.text).join(""));
      data = { message_id: messageId };
    }
    peer.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data }));
  }));

  const file = join(root, "config.json");
  const groups = [String(group), String(otherGroup)];
  await writeFile(file, JSON.stringify({ database: "case.db", host: "127.0.0.1", port: 0, model,
    observeGroups: groups, summaryGroups: groups, recallGroups: groups, summarizeAfter: 30, messageRetentionDays: 14,
    channel: { enabled: true, address: `ws://127.0.0.1:${gateway.address().port}`, groups, roleId: "", modelId: model.id,
      hasToken: false, expectedBotId: String(bot) },
  }));
  const worker = fork(resolve(entry), [], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, OHJINGJING_MODEL_KEY: key, OHJINGJING_CONFIG: file, OHJINGJING_ADMIN_TOKEN: admin,
      OHJINGJING_CONFIG_SHA256: "", OHJINGJING_SUPERVISED: "1", OHJINGJING_ONEBOT_TOKEN: "",
      OHJINGJING_GROUP_MODEL_KEYS: "", OHJINGJING_BACKUP_MODEL_KEYS: "", OHJINGJING_MODEL_PROFILE_KEYS: "" },
  });
  const exited = once(worker, "exit");
  let base;
  worker.stdout.on("data", chunk => { base ??= /listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(String(chunk))?.[1]; });
  worker.stderr.resume();
  async function until(check, maxMs = 32_000) {
    const end = Date.now() + maxMs;
    do {
      if (worker.exitCode !== null) throw new Error("The isolated service stopped.");
      const result = await check();
      if (result) return result;
      await delay(100);
    } while (Date.now() < end);
    throw new Error("The isolated service did not complete the fixture.");
  }
  async function request(path, payload) {
    const response = await fetch(base + path, { method: payload ? "PUT" : "GET", signal: AbortSignal.timeout(3500),
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    assert.ok(response.ok, "Fixture administration returned " + response.status);
    return response.json();
  }
  try {
    await until(() => base);
    const [peer] = await opened;
    await until(async () => (await request("/admin/gateway")).matchesExpected);
    const db = new DatabaseSync(join(root, "case.db"));
    try { seed(db); } finally { db.close(); }
    await request("/admin/group-conversation", { scope, mode: "enabled", timeZone: "Asia/Shanghai", quietStart: "00:00",
      quietEnd: "00:00", cooldownMinutes: 30, dailyLimit: 12, rhythm: "balanced", startTopics: false, followUps: true,
      topicIdleMinutes: 180 });
    let id = 50;
    async function exchange(text, addressed) {
      const start = performance.now();
      const messageId = ++id;
      peer.send(JSON.stringify({ post_type: "message", message_type: "group", message_id: messageId,
        group_id: group, self_id: bot, user_id: 2001, sender: { nickname: "示例发言者" },
        message: [...(addressed ? [{ type: "at", data: { qq: String(bot) } }] : []), { type: "text", data: { text } }],
      }));
      const trace = await until(async () => (await request(`/admin/group-reply-traces?eventId=${messageId}`)).items
        .find(item => item.state !== "running"));
      const answer = trace.receipts.map(item => sent.get(String(item.platformMessageId)) ?? "").join("\n");
      return { answer, reason: trace.reason, elapsedMs: Math.round(performance.now() - start), inputTokens: trace.inputTokens,
        requests: trace.modelAttempts?.length ?? (trace.requestId ? 1 : 0), tools: trace.context?.included.map(item => item.kind) ?? [] };
    }
    const results = [];
    for (const sample of cases) {
      const first = await exchange(sample.text, true);
      let result = first;
      if (sample.follow && first.reason === "reply") {
        try { result = await exchange(sample.follow, false); }
        catch { result = { answer: "", reason: "follow-up-not-delivered", elapsedMs: 32_000, inputTokens: null, requests: 0, tools: [] }; }
      }
      results.push({ name: sample.name, passed: (!sample.follow || result !== first) && sample.check(result.answer), ...result,
        ...(sample.follow ? { firstReply: first } : {}) });
    }
    return results;
  } finally {
    if (worker.connected) worker.send("shutdown");
    await exited;
    for (const peer of gateway.clients) peer.terminate();
    await new Promise(resolveClose => gateway.close(resolveClose));
  }
}

const results = { baseline: await replay("baseline", baseline), candidate: await replay("candidate", candidate) };
console.log(JSON.stringify(results));
if (results.candidate.some(result => !result.passed)) process.exitCode = 1;

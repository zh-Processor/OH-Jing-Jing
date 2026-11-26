import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openGroupTopics, readTopicSummary, topicPrompt, topicEvidenceReview, type TopicRecall } from "../runtime/group-topics";
import { groupHistoryReply } from "../runtime/group-history-reply";
import { readTopicReviewCommand, topicReviewReply, topicReviewWindow } from "../runtime/group-topic-review";
import { groupSummaryHighlight } from "../runtime/group-summary-highlight";
import { summaryReference } from "../runtime/group-summary-reference";

test("evidence review keeps a reported change and an independent question, and requires a later direct answer", () => {
  const rows = ["松果编辑器是不是停更了？", "听群友说同步已经开放给基础档了。", "同步是今天开放的吗？", "是，今天开放。"]
    .map((content, i) => ({ content, author: String(i), id: i + 101, created_at: new Date(Date.UTC(2026, 0, 2, 10, i)).toISOString() }));
  const archive = readTopicSummary(JSON.stringify({ overview: "讨论松果编辑器。", topics: [{ title: "松果编辑器", summary: rows[1].content,
    evidence: [2], facts: [] }] }), rows, [], true)!;
  assert.ok(archive);
  const review = topicEvidenceReview(rows, archive)!;
  assert.deepEqual(JSON.parse(review.prompt[1].content).candidates, [
    { line: 1, kind: "question" }, { line: 2, kind: "report" }, { line: 3, kind: "question" },
  ]);
  const pending = { line: 1, disposition: "open", topic: 1, text: "松果编辑器是否停更仍待核实。" };
  const report = { line: 2, disposition: "change", topic: 1, quote: "已经开放给基础档", text: "同步已向基础档开放。" };
  const answered = { line: 3, disposition: "answered", answerLine: 4, answerQuote: "今天开放" };
  const output = (...items: object[]) => JSON.stringify({ items });
  const merged = review.read(output(report, pending, answered))!;
  assert.deepEqual(merged.topics[0].facts.map(fact => [fact.value.kind, fact.sources.map(row => row.id)]), [
    ["change", [102]], ["open", [101]],
  ]);
  assert.deepEqual(merged.topics[0].sources.map(row => row.id), [102, 101]);
  assert.equal(merged.topics[0].facts[0].value.reported, true);
  assert.match(merged.topics[0].facts[0].value.text, /^群友报告/u);
  assert.equal(archive.topics[0].facts.length, 0);
  assert.deepEqual(JSON.parse(topicEvidenceReview(rows, merged)!.prompt[1].content).candidates, [{ line: 3, kind: "question" }]);
  assert.equal(review.read(output(report, pending, { ...answered, answerQuote: "明天开放" })), null);
  assert.equal(review.read(output(report, pending, { ...answered, answerLine: 2, answerQuote: "基础档" })), null);
  assert.equal(review.read(output({ ...report, quote: "同步已向基础档开放" }, pending, answered)), null);
  assert.equal(review.read(output(report, { ...pending, disposition: "change" }, answered)), null);
  assert.equal(review.read(output(pending, answered)), null);
  assert.equal(review.read(output(report, pending, pending)), null);
  assert.equal(review.read(output(report, { ...pending, topic: 2 }, answered)), null);
  const primary = readTopicSummary(JSON.stringify({ overview: archive.content, topics: [{ title: "松果编辑器", summary: rows[1].content,
    evidence: [2], facts: [{ kind: "change", text: report.text, evidence: [2] }] }] }), rows, [], true)!;
  assert.equal(primary.topics[0].facts[0].value.reported, true);
  assert.deepEqual(JSON.parse(topicEvidenceReview(rows, primary)!.prompt[1].content).candidates, [
    { line: 1, kind: "question" }, { line: 3, kind: "question" },
  ]);
  const colloquial = [{ ...rows[1], content: "都把 Sync Panel 下房了。" }];
  const typoReview = topicEvidenceReview(colloquial, { content: archive.content, topics: [] })!;
  const colloquialReport = { ...report, line: 1, topic: null, title: "Sync Panel", quote: "把 Sync Panel 下房了" };
  assert.equal(typoReview.read(output(colloquialReport))?.topics[0].sources[0].content, colloquial[0].content);
  assert.equal(typoReview.read(output({ ...colloquialReport, quote: "把 Sync Panel 下放了" })), null);

  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE group_messages(id INTEGER PRIMARY KEY,scope TEXT,author TEXT,content TEXT,created_at TEXT);
      CREATE TABLE group_summaries(id INTEGER PRIMARY KEY,scope TEXT,first_id INTEGER,last_id INTEGER,content TEXT,created_at TEXT,
        source_start TEXT,source_end TEXT,sample_count INTEGER);`);
    const saved = openGroupTopics(db);
    const scope = "qq:1001:5001";
    const insert = db.prepare("INSERT INTO group_messages VALUES(?,?,?,?,?)");
    rows.forEach(row => insert.run(row.id, scope, row.author, row.content, row.created_at));
    db.prepare("INSERT INTO group_summaries VALUES(1,?,?,?,?,?,?,?,?)").run(scope, rows[0].id, rows[3].id, merged.content,
      rows[3].created_at, rows[0].created_at, rows[3].created_at, rows.length);
    saved.save(scope, 1, merged.topics);
    const period = { from: rows[0].created_at, to: rows[3].created_at };
    const item = saved.review(scope, period, period.from).items[0];
    assert.equal(item.current?.reported, true);
    assert.equal(item.pending?.text, pending.text);
    assert.match(topicReviewReply(7, { items: [item], retentionLimited: false, limited: false }, "Asia/Shanghai"), /群友报告[^\n]*\n待确认/u);
    const [summary] = saved.summaries(scope, period.from);
    assert.ok("topics" in summary);
    assert.deepEqual(groupSummaryHighlight(summary.topics), { reaction: "reported-question", title: "松果编辑器", detail: pending.text,
      report: "群友报告：同步已向基础档开放。" });
    const context = summaryReference(summary)?.context ?? "";
    assert.match(context, /群友报告[^\n]*基础档/u);
    assert.doesNotMatch(context, /已确认的变更/u);
    db.prepare("DELETE FROM group_messages WHERE id=?").run(rows[0].id);
    assert.equal(saved.review(scope, period, period.from).items[0].pending, undefined);
    const [reduced] = saved.summaries(scope, period.from);
    assert.ok("topics" in reduced);
    assert.equal(groupSummaryHighlight(reduced.topics)?.reaction, "reported");
  } finally { db.close(); }
});

test("topic revisions preserve proposals and confirmed changes without using unavailable evidence", () => {
  assert.deepEqual(readTopicSummary("旧摘要正文。", [], []), { content: "旧摘要正文。", topics: [] });
  assert.equal(readTopicSummary("旧摘要正文。", [], [], true), null);
  const at = "2026-01-02T10:00:00.000Z";
  const messages = [{ id: 1, author: "2000", content: "已取消周六解谜约局。", created_at: at }];
  const prior = [{ title: "周末解谜约局", topic_key: "previous-topic", last_at: at }];
  const cancellation = { title: prior[0].title, summary: messages[0].content, previous: 1, evidence: [1],
    facts: [{ kind: "retraction", text: messages[0].content, evidence: [1] }] };
  const output = (topics: unknown[]) => JSON.stringify({ overview: "周末约局的进展。", topics });
  assert.equal(readTopicSummary(output([cancellation]), messages, prior, true)?.topics[0].topicKey, prior[0].topic_key);
  assert.deepEqual(readTopicSummary(output([]), messages, prior, true)?.topics, []);
  assert.equal(readTopicSummary(output([{ ...cancellation, evidence: [2] }]), messages, prior, true), null);
  assert.equal(readTopicSummary(output([{ ...cancellation, previous: 2 }]), messages, prior, true), null);
  assert.equal(readTopicSummary(output([cancellation, cancellation]), messages, prior, true), null);
  const waiting = { ...messages[0], content: "等大家回复后再决定是否改期。" };
  const misclassified = { ...cancellation, summary: waiting.content,
    facts: [{ kind: "decision", text: waiting.content, evidence: [1] }] };
  assert.equal(readTopicSummary(output([misclassified]), [waiting], prior, true)?.topics[0].facts[0].value.kind, "open");
  const reaffirmed = { ...waiting, content: "等大家回复后再决定是否改期，原计划继续有效。" };
  assert.equal(readTopicSummary(output([{ ...misclassified, facts: [{ kind: "decision", text: reaffirmed.content, evidence: [1], reaffirms: true }] }]),
    [reaffirmed], prior, true)?.topics[0].facts[0].value.reaffirms, true);
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE group_messages (id INTEGER PRIMARY KEY,scope TEXT,author TEXT,content TEXT,created_at TEXT);
    CREATE TABLE group_summaries (id INTEGER PRIMARY KEY,scope TEXT,first_id INTEGER,last_id INTEGER,content TEXT,
      created_at TEXT,source_start TEXT,source_end TEXT);
  `);
  try {
    const archive = openGroupTopics(db);
    const scope = "qq:1001:5001";
    const other = "qq:1001:5002";
    const cutoff = "2026-01-01T00:00:00.000Z";
    const title = "周末解谜约局";
    function store(target: string, day: number, lines: string[], facts: object[], previous: number | null, topicTitle = title) {
      const at = new Date(Date.UTC(2026, 0, day, 10)).toISOString();
      const rows = lines.map((content, index) => {
        const author = String(2000 + index);
        const id = Number(db.prepare("INSERT INTO group_messages(scope,author,content,created_at) VALUES(?,?,?,?)")
          .run(target, author, content, at).lastInsertRowid);
        return { id, author, content, created_at: at };
      });
      const previousTopics = archive.prior(target, at);
      const input = JSON.parse(topicPrompt(rows, previousTopics)[1].content);
      assert.equal(input.messages[0].speaker, 1);
      assert.equal(input.messages[0].text.includes("example.com"), false);
      const result = readTopicSummary(JSON.stringify({ overview: "解谜活动的最新讨论。", topics: [{ title: topicTitle,
        summary: "参加者在商量周末合作解谜。", previous, evidence: [1, 2], facts }] }), rows, previousTopics);
      assert.ok(result);
      const entry = db.prepare("INSERT INTO group_summaries(scope,first_id,last_id,content,created_at,source_start,source_end) VALUES(?,?,?,?,?,?,?)")
        .run(target, rows[0].id, rows.at(-1)!.id, result.content, at, at, at);
      archive.save(target, entry.lastInsertRowid, result.topics);
      return rows;
    }

    store(other, 2, ["另一个群定在星期一。", "确认星期一。"], [{ kind: "decision", text: "星期一。", evidence: [1, 2] }], null);
    store(scope, 2, ["提议周六晚上七点合作解谜。", "行，周六晚上七点。"], [
      { kind: "proposal", text: "提议周六晚上七点。", evidence: [1] },
      { kind: "decision", text: "定在周六晚上七点。", evidence: [2] },
    ], null);
    const proposals = store(scope, 3, ["要不改周日？", "先等等其他人。alice@example.com", "改期尚未确认，原定周六晚上七点仍有效。"], [
      { kind: "proposal", text: "提议改周日。", evidence: [1] },
      { kind: "open", text: "其他群友尚未确认。", evidence: [2] },
      { kind: "decision", text: "定在周六晚上七点。", evidence: [3], reaffirms: true },
    ], 1);
    const beforeChange = archive.recall(scope, 1000, "解谜最终时间", cutoff)[0];
    assert.ok("latestDecision" in beforeChange);
    assert.equal(beforeChange.latestDecision?.text, "定在周六晚上七点。");
    const conversational = archive.recall(scope, 1000, "那最后怎么定的", cutoff, { reference: "解谜约局最后怎么安排" })[0];
    assert.ok("latestDecision" in conversational);
    assert.equal(conversational.latestDecision?.text, beforeChange.latestDecision?.text);
    assert.ok(beforeChange.facts.some(fact => fact.kind === "proposal" && fact.text.includes("周日")));
    const reviewWindow = (day: number) => topicReviewWindow(30, Date.UTC(2026, 0, day, 23), cutoff);
    const byDay = (day: number) => archive.review(scope, reviewWindow(day), cutoff);
    const early = byDay(3).items[0];
    assert.equal(early.state, "confirmed");
    assert.equal(early.current?.text, "定在周六晚上七点。");
    assert.equal(early.current?.reaffirms, true);
    assert.equal(early.pending?.text, "其他群友尚未确认。");
    const latestProposal = archive.summaries(scope, cutoff)[0];
    assert.ok("topics" in latestProposal && latestProposal.topics);
    assert.deepEqual(groupSummaryHighlight(latestProposal.topics), {
      reaction: "question", title, detail: "其他群友尚未确认。",
    });
    const changed = store(scope, 4, ["统一改到周日晚上八点。", "就定周日晚上八点。"], [
      { kind: "change", text: "最终改成周日晚上八点。", evidence: [1, 2] },
      { kind: "decision", text: "无效证据不能发布。", evidence: [5] },
    ], 1);
    const current = archive.recall(scope, 1000, "解谜最终时间", cutoff);
    assert.equal(current.length, 1);
    assert.ok("latestDecision" in current[0]);
    assert.equal(current[0].latestDecision?.text, "最终改成周日晚上八点。");
    assert.deepEqual(current[0].evidence?.map(item => item.excerpt), ["就定周日晚上八点。", "统一改到周日晚上八点。"]);
    assert.ok(!JSON.stringify(current).includes("星期一"));
    assert.ok(!JSON.stringify(current).includes("无效证据"));
    assert.equal(byDay(4).items[0].current?.text, "最终改成周日晚上八点。");
    assert.equal(byDay(4).items[0].pending, undefined);
    assert.equal(archive.review(scope, reviewWindow(4), cutoff, reviewWindow(3).to).items[0].current?.text, "定在周六晚上七点。");
    store(other, 4, ["取消周一活动。", "确认取消。"], [{ kind: "retraction", text: "周一活动已取消。", evidence: [1, 2] }], 1);
    const cancelled = archive.review(other, reviewWindow(4), cutoff).items[0];
    assert.equal(cancelled.state, "retracted");
    assert.equal(cancelled.current?.kind, "retraction");
    assert.doesNotMatch(topicReviewReply(30, { ...archive.review(other, reviewWindow(4), cutoff), ...reviewWindow(4) }, "Asia/Shanghai"), /已确认/u);
    assert.equal(archive.recall(scope, proposals[0].id, "解谜最终时间", cutoff).length, 1);
    assert.ok(!JSON.stringify(archive.recall(scope, proposals[0].id, "解谜最终时间", cutoff)).includes("周日"));
    assert.deepEqual(archive.recall(scope, 1000, "柚子辣椒", cutoff), []);

    const latest = archive.summaries(scope, cutoff)[0];
    assert.ok("topics" in latest && latest.topics);
    assert.equal(latest.topics[0].facts.length, 1);
    assert.equal(latest.topics[0].coverage, "complete");
    assert.deepEqual(groupSummaryHighlight(latest.topics), { reaction: "change", title, detail: "最终改成周日晚上八点。" });
    const original = archive.summaries(scope, cutoff)[2];
    assert.ok("topics" in original && original.topics);
    assert.equal(groupSummaryHighlight(original.topics)?.reaction, "decision");
    db.prepare("DELETE FROM group_messages WHERE id=?").run(changed[1].id);
    const incomplete = archive.recall(scope, 1000, "解谜最终时间", cutoff)[0];
    assert.ok("latestDecision" in incomplete);
    assert.equal(incomplete.latestDecision, undefined);
    assert.equal(incomplete.missingDecisionEvidence, true);
    assert.equal(incomplete.coverage, "partial");
    assert.equal(incomplete.content, "");
    assert.equal(incomplete.evidence, undefined);
    assert.ok(!incomplete.facts.some(fact => fact.kind === "decision" || fact.kind === "change"));
    const unsafeReview = { ...byDay(4), ...reviewWindow(4) };
    assert.equal(unsafeReview.items[0].state, "unknown");
    const reply = topicReviewReply(30, unsafeReview, "Asia/Shanghai");
    assert.match(reply, /原文不足，待核对/u);
    assert.doesNotMatch(reply, /星期一|周六晚上七点|周日晚上八点|example\.com/u);
    const partial = archive.summaries(scope, cutoff)[0];
    assert.ok("topics" in partial && partial.topics);
    assert.deepEqual(groupSummaryHighlight(partial.topics), { reaction: "topic", title, detail: "" });
    db.prepare("DELETE FROM group_messages WHERE id=?").run(changed[0].id);
    const expired = archive.summaries(scope, cutoff)[0];
    assert.ok("topics" in expired && expired.topics);
    assert.equal(groupSummaryHighlight(expired.topics), undefined);
    assert.equal(groupSummaryHighlight(undefined), undefined);
    for (let day = 5; day < 17; day++) store(scope, day, ["合成讨论一", "合成讨论二"], [], day === 5 ? null : 1, "下月排练");
    const reviewed = byDay(17).items.find(item => item.title === title && item.state === "unknown");
    assert.ok(reviewed, "An older episode survives more than ten intervening summary batches");
  } finally { db.close(); }
});

test("review commands bound time spans and report when the requested range exceeds source retention", () => {
  assert.equal(readTopicReviewCommand("/话题复盘"), 7);
  assert.equal(readTopicReviewCommand("/话题复盘 近一天。"), 1);
  assert.equal(readTopicReviewCommand("/话题复盘 30天"), 30);
  assert.equal(readTopicReviewCommand("/话题复盘 365天"), undefined);
  assert.equal(readTopicReviewCommand("转发 /话题复盘 30天"), undefined);
  const to = "2026-01-17T00:00:00.000Z";
  const cutoff = "2026-01-10T00:00:00.000Z";
  assert.deepEqual(topicReviewWindow(30, Date.parse(to), cutoff), { from: cutoff, to, retentionLimited: true });
  assert.deepEqual(topicReviewWindow(7, Date.parse(to), cutoff), { from: cutoff, to, retentionLimited: false });
});

test("group recall follows alternate topic wording and a verified reference without exposing stale or foreign history", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE group_messages (id INTEGER PRIMARY KEY,scope TEXT,author TEXT,content TEXT,created_at TEXT);
      CREATE TABLE group_summaries (id INTEGER PRIMARY KEY,scope TEXT,first_id INTEGER,last_id INTEGER,content TEXT,
        created_at TEXT,source_start TEXT,source_end TEXT);
    `);
    const archive = openGroupTopics(db);
    const own = "qq:1001:5001";
    const other = "qq:1001:5002";
    const otherAccount = "qq:1002:5001";
    const cutoff = "2026-11-17T00:00:00.000Z";
    function store(scope: string, day: number, content: string, title?: string, aliases?: string[], decision?: string, followTopic = false) {
      const at = new Date(Date.UTC(2026, 10, day, 12)).toISOString();
      const row = { id: Number(db.prepare("INSERT INTO group_messages(scope,author,content,created_at) VALUES(?,?,?,?)")
        .run(scope, "2001", content, at).lastInsertRowid), author: "2001", content, created_at: at };
      const summary = db.prepare("INSERT INTO group_summaries(scope,first_id,last_id,content,created_at,source_start,source_end) VALUES(?,?,?,?,?,?,?)")
        .run(scope, row.id, row.id, content, at, at, at).lastInsertRowid;
      if (title) {
        const earlier = archive.prior(scope, at);
        const previous = followTopic ? earlier.findIndex(topic => topic.title === title) + 1 : null;
        if (followTopic) assert.ok(previous);
        const result = readTopicSummary(JSON.stringify({ overview: content, topics: [{
          title, aliases, previous, summary: content, evidence: [1], facts: decision ? [{ kind: "decision", text: decision, evidence: [1] }] : [],
        }] }), [row], earlier);
        assert.ok(result);
        archive.save(scope, summary, result.topics);
      }
      return row.id;
    }
    const meal = store(own, 19, "最终聚餐定在周五19:00，报名链接 https://example.invalid/secret。", "周末聚餐",
      ["夜宵小队", "活动", "https://example.invalid/alias"], "定在周五19:00。");
    store(own, 20, "之前讨论过时间和地点，最终定了周日20:00。", "市民剧场彩排", ["排演"], "定在周日20:00。");
    store(own, 20, "只在旧式摘要能读到的拼图比赛。");
    store(other, 20, "另一个群约饭在周日21:00。", "周末聚餐", ["夜宵小队"], "周日21:00。");
    store(otherAccount, 20, "另一个机器人所在群定在周一22:00。", "周末聚餐", ["夜宵小队"], "周一22:00。");
    const expiredLegacy = store(own, 15, "过期旧刊交流的约定。");
    const recall = (query: string, reference?: string) => archive.recall(own, 10_000, query, cutoff, { reference });
    for (const query of ["上周一起吃饭最后定了几点？", "夜宵小队什么时候来？"]) {
      const result = recall(query);
      assert.equal(result.length, 1);
      assert.ok("latestDecision" in result[0]);
      assert.equal(result[0].latestDecision?.text, "定在周五19:00。");
      assert.match(result[0].evidence?.[0].excerpt ?? "", /周五19:00.*\[链接\]/u);
      assert.doesNotMatch(JSON.stringify(result), /21:00|22:00|example\.invalid|周日20:00/u);
    }
    const followUp = recall("那最后定几点？", "夜宵小队");
    assert.ok("latestDecision" in followUp[0]);
    assert.equal(followUp[0].latestDecision?.text, "定在周五19:00。");
    assert.deepEqual(recall("那最后定几点？"), []);
    assert.deepEqual(recall("招领处最后定几点？", "夜宵小队"), []);
    assert.deepEqual(recall("过期旧刊交流几点？"), []);
    assert.ok("legacy" in recall("拼图比赛是什么？")[0]);
    assert.deepEqual(recall("活动"), []);
    assert.deepEqual(archive.recall(own, meal, "夜宵小队", cutoff), []);
    const latestDecisionSource = store(own, 24, "这周末聚餐改在周六18:00。", "周末聚餐", [], "周六18:00。", true);
    for (let revision = 0; revision < 8; revision++) {
      store(own, 24, `聚餐讨论第 ${revision + 1} 次。`, "周末聚餐", [], undefined, true);
    }
    const current = recall("夜宵小队最后几点？")[0];
    assert.ok("latestDecision" in current);
    assert.equal(current.latestDecision?.text, "周六18:00。");
    const calendar = { now: Date.parse("2026-11-23T17:00:00Z"), timeZone: "Asia/Shanghai" };
    db.prepare("DELETE FROM group_messages WHERE id=?").run(latestDecisionSource);
    const lostLatest = recall("夜宵小队最后几点？")[0];
    assert.ok("missingDecisionEvidence" in lostLatest);
    assert.equal(lostLatest.missingDecisionEvidence, true);
    assert.equal(lostLatest.latestDecision, undefined);
    assert.doesNotMatch(JSON.stringify(lostLatest), /19:00|18:00/u);
    assert.equal(groupHistoryReply({ query: "夜宵小队最后几点？", related: [lostLatest], conversation: [], additions: [], quoted: false }).reply?.reason,
      "history-evidence-missing");
    for (let index = 0; index < 155; index++) {
      store(own, 24, "本日值班杂项。", `值班记录 ${index + 1}`);
      if (index < 55) store(own, 24, "没有结论的普通通知。");
    }
    const priorWeek = archive.recall(own, 10_000, "上周饭局最后几点？", cutoff, {
      calendar,
    });
    assert.equal(priorWeek.length, 1);
    assert.ok("latestDecision" in priorWeek[0]);
    assert.equal(priorWeek[0].latestDecision?.text, "定在周五19:00。");
    assert.doesNotMatch(JSON.stringify(priorWeek), /18:00/u);
    const priorLegacy = archive.recall(own, 10_000, "上周拼图比赛是什么？", cutoff, { calendar });
    assert.ok(priorLegacy[0] && "legacy" in priorLegacy[0]);
    assert.deepEqual(archive.recall(own, 10_000, "那最后周几", cutoff, {
      reference: "上周饭局最后几点？",
      calendar,
    }), priorWeek);
    db.prepare("DELETE FROM group_messages WHERE id=?").run(meal);
    const missing = archive.recall(own, 10_000, "上周夜宵小队最后几点？", cutoff, { calendar });
    assert.deepEqual(missing.map(item => item.content), [""]);
    assert.doesNotMatch(JSON.stringify(missing), /周五19:00|example\.invalid/u);
    assert.equal(db.prepare("SELECT id FROM group_messages WHERE id=?").get(expiredLegacy)?.id, expiredLegacy);
  } finally { db.close(); }
});

test("a final time lookup only sends the verified time and yields when newer members add context", () => {
  const at = "2026-11-20T12:00:00.000Z";
  const history = {
    title: "周末聚餐", content: "最终改成周五19:00。", from: at, to: at, createdAt: at, coverage: "complete",
    missingDecisionEvidence: false, latestDecision: { kind: "change", text: "最终改成周五19:00。", at },
    facts: [], evidence: [{ at, excerpt: "确认改到星期五19：00。" }],
  } satisfies TopicRecall;
  const base = { query: "那最后几点？", reference: "夜宵小队", related: [history],
    conversation: [], additions: [], quoted: false };
  const decided = { text: "按群里的确认记录，是周五19:00。", reason: "history-decision" };
  assert.deepEqual(groupHistoryReply(base).reply, decided);
  assert.equal(groupHistoryReply({ ...base, related: [{ ...history, latestDecision: { ...history.latestDecision, reported: true } }] }).reply, undefined);
  assert.equal(groupHistoryReply({ ...base, query: "聚餐最后定哪天？" }).reply?.text, "按群里的确认记录，是周五。");
  assert.equal(groupHistoryReply({ ...base, query: "那最后周几" }).reply?.text, "按群里的确认记录，是周五。");
  assert.equal(groupHistoryReply({ ...base, query: "聚餐最后几点？也讲讲怎么报名。" }).reply, undefined);
  assert.equal(groupHistoryReply({ ...base, query: "讲讲怎么报名，顺便问聚餐最后几点？" }).reply, undefined);
  assert.equal(groupHistoryReply({ ...base, quoted: true }).reply, undefined);
  assert.equal(groupHistoryReply({ ...base, related: [history, { ...history, title: "别的活动" }] }).reply, undefined);
  for (const bad of ["要不改到周五19:00？", "大家没确定周五19:00。", "就定周五20:00。", "周五19:00还是20:00"]) {
    assert.equal(groupHistoryReply({ ...base, related: [{ ...history, evidence: [{ at, excerpt: bad }] }] }).reply, undefined);
  }
  const later = { time: Date.parse(at) + 1000, role: "member" as const, text: "聚餐确认改到周六20:00。" };
  const recency = { newer: [later], reply: { text: "刚有群友确认，是周六20:00。", reason: "recent-schedule-confirmation" } };
  assert.deepEqual(groupHistoryReply({ ...base, conversation: [later] }), recency);
  const calendar = { now: Date.parse("2026-11-23T17:00:00Z"), timeZone: "Asia/Shanghai" };
  const thisWeek = { ...later, time: calendar.now - 1, text: "本周聚餐确认改到周一21:00。" };
  const lastWeekQuestion = { ...base, calendar, query: "上周聚餐最后几点？" };
  assert.deepEqual(groupHistoryReply({ ...lastWeekQuestion, conversation: [thisWeek] }).reply, decided);
  assert.deepEqual(groupHistoryReply({ ...lastWeekQuestion, conversation: [later, thisWeek] }), {
    newer: [later], reply: { text: "群友后来确认，是周六20:00。", reason: "recent-schedule-confirmation" },
  });
  assert.deepEqual(groupHistoryReply({
    ...base, calendar, reference: lastWeekQuestion.query, conversation: [thisWeek],
  }).reply, decided);
  const tentative = { ...later, text: "要不聚餐改到周六20:00？" };
  assert.deepEqual(groupHistoryReply({ ...base, conversation: [later, tentative] }), { newer: [later, tentative] });
  const rumor = { ...later, text: "听说聚餐确认改到周六20:00了。" };
  assert.deepEqual(groupHistoryReply({ ...base, conversation: [rumor] }), { newer: [rumor] });
  assert.deepEqual(groupHistoryReply({ ...base, conversation: [{ ...later, role: "bot" }] }).reply, decided);
  assert.deepEqual(groupHistoryReply({ ...base, conversation: [{ ...later, text: "联机改到周日21:00。" }] }).reply, decided);
  assert.equal(groupHistoryReply({ ...base, additions: [{ ...later, text: "刚听说要改到周六。" }] }).reply, undefined);
  const missing = { ...history, latestDecision: undefined, missingDecisionEvidence: true, evidence: [] };
  assert.equal(groupHistoryReply({ ...base, related: [missing] }).reply?.reason, "history-evidence-missing");
  assert.deepEqual(groupHistoryReply({ ...base, related: [missing], conversation: [later] }), recency);
});

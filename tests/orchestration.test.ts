import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { planRoleTurn } from "../runtime/turn.js";
import { defaultRole } from "../runtime/roles.js";
import { prepareGroupLookup, readGroupHistoryRequest, selectGroupHistoryContext } from "../runtime/group-context-lookup.js";
import { runPiTurn } from "../runtime/pi-harness.js";
import { openGroupTopics, readTopicSummary } from "../runtime/group-topics.js";
import { openDesktopCheckpoints } from "../runtime/desktop-checkpoints.js";
import { readProfileSuggestion } from "../runtime/group-profiles.js";
import { type ModelProfile } from "../runtime/models.js";

const model: ModelProfile = { id: "fixture", name: "fixture", model: "fixture", baseUrl: "https://example.org/v1",
  hasKey: false, billing: "none", inputPrice: null, outputPrice: null, currency: "CNY", billingAccount: "" };

test("the group context keeps the current turn and quote under load and chooses scene-appropriate examples", () => {
  const current = "把你挂在剧院门口当招牌。";
  const required = { current, quote: { speaker: "群友一", text: "之前说的是便携招牌。" } };
  const noisy = Array.from({ length: 12 }, (_, index) => ({ text: String(index) + "重复闲聊".repeat(170) }));
  const budget = 4096;
  const planned = planRoleTurn({ role: defaultRole, scene: "group", instruction: "按当前请求回答。", current, budget, exampleLimit: 1,
    structured: { required, optional: [
      { kind: "recent", key: "recent", value: noisy },
      { kind: "group-profile", key: "groupProfile", value: "无关资料".repeat(800) },
    ] } });
  const actual = JSON.parse(planned.messages.at(-1)!.content);
  assert.equal(actual.current, current);
  assert.deepEqual(actual.quote, required.quote);
  assert.ok(planned.diagnostics.estimatedTokens <= budget);
  assert.ok(!actual.groupProfile);
  assert.ok(planned.diagnostics.omitted > 0);
  assert.equal(planned.diagnostics.intent, "banter");
  assert.match(actual.recent.at(-1).text, /^11/u);
  const noNoise = planRoleTurn({ role: defaultRole, scene: "group", instruction: "回复。", current, exampleLimit: 1 });
  assert.match(noNoise.messages[0].content, /便利店门口/u);
  assert.deepEqual(noNoise.messages.slice(1), [{ role: "user", content: current }]);
  const followUp = planRoleTurn({ role: defaultRole, scene: "group", instruction: "回复。", current: "再短一点，保留桌游。",
    exampleLimit: 1 });
  assert.match(followUp.messages[0].content, /开场白/u);
  const care = planRoleTurn({ role: defaultRole, scene: "desktop", instruction: "回复。", current: "我现在不想说话。", exampleLimit: 1 });
  assert.match(care.messages[0].content, /不想说/u);
  assert.match(care.messages[0].content, /简短确认陪伴，然后停住/u);
  const socialRole = { ...defaultRole, personality: { ...defaultRole.personality, traits: { sociability: 5 } } };
  const groupTurn = { role: socialRole, scene: "group" as const, instruction: "回复。", current };
  const direct = planRoleTurn({ ...groupTurn, groupParticipation: "direct" });
  assert.match(direct.messages[0].content, /认真求助、安慰或对方想安静时，先照顾本轮需要/u);
  const opening = planRoleTurn({ ...groupTurn, groupParticipation: "opening" });
  assert.match(opening.messages[0].content, /用一句话就能接上/u);
  const followUpPlan = planRoleTurn(groupTurn);
  assert.doesNotMatch(followUpPlan.messages[0].content, /有人明确在跟你说话|用一句话就能接上/u);
});

test("Pi reads the same group evidence without giving a text model a scope selector", async () => {
  const text = "回顾活动";
  const messages = [{ role: "system" as const, content: "群角色" }, { role: "user" as const,
    content: JSON.stringify({ current: text, related: [{ title: "只在本群出现的话题" }], speakerProfile: "本群画像" }) }];
  let allowed = true;
  const lookup = prepareGroupLookup(messages, text, () => allowed);
  assert.ok(lookup);
  assert.ok(!messages.at(-1)!.content.includes("本群画像"));
  const seen: string[] = [];
  const generator = async (transcript: typeof messages) => {
    seen.push(transcript.at(-1)!.content);
    return { text: "收到。", inputTokens: 12, outputTokens: 5, refused: false };
  };
  await runPiTurn(model, messages, async transcript => generator(transcript as typeof messages), undefined, lookup);
  assert.match(seen[0], /只在本群出现的话题/u);
  allowed = false;
  await runPiTurn(model, messages, async transcript => generator(transcript as typeof messages), undefined, lookup);
  assert.equal(JSON.parse(seen[1]).speakerProfile, undefined);
  assert.deepEqual(JSON.parse(seen[1]).related, []);
});

test("a DSH group turn starts with its current request and exposes old context only through its bound tool", async () => {
  const current = "大肥鱼，你用语音讲个故事";
  const quote = { speaker: "群友一", text: "明确引用的内容" };
  const related = [{ title: "群助手提示词" }];
  const recent = [{ speaker: "群友二", text: "不相关的最近发言" }];
  const previousExchange = [{ question: "聊另一个话题", answer: "这是旧回复" }];
  const messages = [{ role: "user" as const, content: JSON.stringify({ current, quote, related, recent, previousExchange }) }];
  let allowed = true;
  const tool = prepareGroupLookup(messages, current, () => allowed, true);
  assert.ok(tool?.hasEvidence);
  assert.deepEqual(JSON.parse(messages[0].content), { current, quote, related: [], recent: [] });
  assert.deepEqual(JSON.parse(tool.read()), { related, recent, previousExchange });
  assert.equal(readGroupHistoryRequest('{"action":"group_history"}'), true);
  assert.equal(readGroupHistoryRequest('{"action":"group_history","scope":"另一个群"}'), false);
  assert.equal(readGroupHistoryRequest('{"action":"reply","parts":["聊一个新故事"]}'), false);
  allowed = false;
  assert.equal(tool.read(), "{}");
});

test("a new self-contained request does not offer unrelated group history, while confirmed references still have context", () => {
  const recent = [{ speaker: "群友一", text: "合成纸桥选题留到下周聊。" },
    { speaker: "群友二", text: "周末桌游改到周日晚上八点。" }];
  const exchange = [{ question: "帮我写句桌游开场白。", answer: "桌游开局，先掷骰子。" }];
  const current = "刚刚误删了一份本机文档，现在怎么办？";
  assert.deepEqual(selectGroupHistoryContext(current, recent, exchange, false), { recent: [], exchange: [] });
  const messages = [{ role: "user" as const, content: JSON.stringify({ current, speakerProfile: "常参加桌游" }) }];
  const irrelevant = prepareGroupLookup(messages, current, () => true, true);
  assert.equal(irrelevant?.hasEvidence, false);
  assert.equal(irrelevant?.read(), "{}");
  assert.equal(JSON.parse(messages[0].content).speakerProfile, undefined);

  assert.deepEqual(selectGroupHistoryContext("周末桌游怎么改的？", recent, exchange, false),
    { recent: [recent[1]], exchange: [] });
  assert.deepEqual(selectGroupHistoryContext("那后来怎么说？", recent, undefined, false, "合成纸桥选题"),
    { recent: [recent[0]], exchange: undefined });
  assert.deepEqual(selectGroupHistoryContext("再短一点。", recent, exchange, true), { recent: [], exchange });
});

test("a confirmed retraction replaces an old decision and loss of its evidence never revives the old decision", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE group_messages(id INTEGER PRIMARY KEY,scope TEXT,author TEXT,content TEXT,created_at TEXT);
      CREATE TABLE group_summaries(id INTEGER PRIMARY KEY,scope TEXT,first_id INT,last_id INT,content TEXT,created_at TEXT,
        source_start TEXT,source_end TEXT,sample_count INTEGER)`);
    const topics = openGroupTopics(db);
    const scope = "qq:1000:1001";
    const title = "周末桌游";
    const cutoff = "2026-01-01T00:00:00Z";
    const save = (id: number, content: string, kind: string, previous: number | null) => {
      const at = `2026-01-0${id + 1}T00:00:00Z`;
      db.prepare("INSERT INTO group_messages VALUES(?,?,?,?,?)").run(id, scope, "member", content, at);
      db.prepare("INSERT INTO group_summaries VALUES(?,?,?,?,?,?,?,?,?)").run(id, scope, id, id, content, at, at, at, 1);
      const prior = topics.prior(scope, at);
      const draft = readTopicSummary(JSON.stringify({ overview: content,
        topics: [{ title, summary: content, previous, evidence: [1], facts: [{ kind, text: content, evidence: [1] }] }] }),
      [{ id, author: "member", content, created_at: at }], prior);
      assert.ok(draft);
      topics.save(scope, id, draft.topics);
    };
    save(1, "确认周末桌游周六晚上七点。", "decision", null);
    save(2, "周末桌游确认取消，原安排作废。", "retraction", 1);
    const first = topics.recall(scope, 3, "周末桌游最后定的结果是什么", cutoff)[0];
    assert.ok("effective" in first);
    assert.equal(first.effective, "retracted");
    assert.equal(first.latestDecision, undefined);
    const revision = topics.summaries(scope, cutoff, true)[0];
    assert.match(revision.content, /确认取消/u);
    db.prepare("DELETE FROM group_messages WHERE id=2").run();
    const expired = topics.recall(scope, 3, "周末桌游最后定的结果是什么", cutoff)[0];
    assert.ok("effective" in expired);
    assert.equal(expired.effective, "unknown");
    assert.equal(expired.latestDecision, undefined);
    assert.equal(topics.summaries(scope, cutoff, true)[0].evidenceAvailable, false);
  } finally { db.close(); }
});

test("profile revisions require scoped evidence per proposed change", () => {
  const sample = [
    { id: 1, author: "a", content: "我也喜欢合作解谜。", created_at: "2026-01-01" },
    { id: 2, author: "b", content: "周末继续合作解谜。", created_at: "2026-01-02" },
  ];
  const proposal = { summary: "群里约合作解谜。", evidence: [1, 2],
    changes: [{ kind: "revise", text: "群里改约合作解谜。", evidence: [1, 2] }] };
  assert.deepEqual(readProfileSuggestion(JSON.stringify(proposal), sample, true)?.changes?.[0].evidenceIds, [1, 2]);
  proposal.changes[0].evidence = [1, 1];
  assert.equal(readProfileSuggestion(JSON.stringify(proposal), sample, true), null);
});

test("desktop checkpoints preserve recent original messages and advance only for a matching role revision", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY,scope TEXT,role_id TEXT,author TEXT,content TEXT)");
    const insert = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)");
    for (let id = 1; id <= 24; id++) insert.run(id, "desktop", "role", "user", "原话" + id);
    insert.run(25, "other", "role", "user", "其他范围");
    const checkpoints = openDesktopCheckpoints(db);
    const batch = checkpoints.batch("role", "v1")!;
    assert.equal(batch.through, 8);
    assert.doesNotMatch(batch.messages[1].content, /原话9|其他范围/u);
    assert.equal(checkpoints.save("role", "v1", batch.through, '{"checkpoint":"保留早先约定"}'), true);
    assert.equal(checkpoints.read("role", "v1")?.text, "保留早先约定");
    assert.equal(checkpoints.read("role", "v2"), undefined);
    assert.equal(checkpoints.batch("role", "v1"), undefined);
  } finally { db.close(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { openQqAccount } from "../runtime/qq-account";
import { openQqAccountSchedules } from "../runtime/qq-account-schedule";
import { openQqSpaceDiary } from "../runtime/qq-space-diary";
import { openQqDiaryOpeningTopics } from "../runtime/qq-diary-opening-topics";
import { openQqSpaceInteractions, readSpaceInteractionRule } from "../runtime/qq-space-interaction";
import { openStore } from "../runtime/store";

test("space interaction windows are claimed once and recover without resending uncertain writes", () => {
  const store = openStore(":memory:");
  try {
    let account = openQqAccount(store);
    let interactions = openQqSpaceInteractions(store);
    const accountId = "1001";
    const day = 86_400_000;
    const at = Date.parse("2026-01-01T04:00:00Z");
    const rule = readSpaceInteractionRule({ mode: "enabled", targetIds: ["2001", "2001"], comment: true,
      like: false, nextAt: at, intervalDays: 1, windowMinutes: 5 });
    assert.deepEqual(rule.targetIds, ["2001"]);
    assert.equal(interactions.save(accountId, 0, undefined, rule, at - 1), "saved");
    const original = interactions.read(accountId)!;
    assert.equal(interactions.claim(accountId, "role-a", original, at + 6 * 60_000), undefined);
    assert.equal(interactions.read(accountId)?.nextAt, at + day);
    assert.equal(interactions.save(accountId, 1, at, rule, at), "conflict");
    const upcoming = interactions.read(accountId)!;
    const started = interactions.claim(accountId, "role-a", upcoming, at + day)!;
    assert.equal(interactions.claim(accountId, "role-a", upcoming, at + day), undefined);
    assert.equal(interactions.bind(started.id, "2001", "retained-post"), true);
    const policy = account.policy(accountId);
    account.save(accountId, { ...policy, spaceComment: true, spaceTargets: ["2001"] });
    assert.deepEqual(account.begin(started.id, accountId, { kind: "qzone-comment", targetId: "2001",
      postId: "retained-post", content: "运行中" }), { started: true });
    account = openQqAccount(store);
    interactions = openQqSpaceInteractions(store);
    assert.equal(interactions.history(accountId)[0].state, "submitted");
    assert.equal(account.operation(started.id)?.state, "unknown");
    assert.equal(interactions.seen(accountId, "enabled", "2001", "retained-post"), true);
    assert.equal(interactions.due(at + day).length, 0);
  } finally { store.db.close(); }
});

test("diary opening grants are independent of space sharing and scoped, versioned and expiring", () => {
  const store = openStore(":memory:");
  try {
    const diary = openQqSpaceDiary(store);
    const revoked = new Set<number>();
    const open = () => openQqDiaryOpeningTopics(store.db, id => !revoked.has(id));
    const grants = open();
    const scope = "qq:1001:5001";
    const role = "fixture.role";
    const revision = "role-a";
    const at = 1_800_000_000_000;
    const make = (account = "1001") => diary.create(account, role, { text: "仅供后台查看", shareable: false });
    const first = make();
    assert.equal(grants.save(scope, role, revision, make("1002"), 1, 0, "别的账号", at), "stale");
    assert.equal(grants.save(scope, role, revision, first, 1, 0, "纸飞机", at), "saved");
    assert.equal(grants.save(scope, role, revision, first, 1, 0, "旧界面", at), "stale");
    assert.equal(grants.save(scope, role, revision, make(), 1, 0, "纸飞机", at), "duplicate");
    assert.deepEqual(grants.active("qq:1001:5002", role, revision, at), []);
    assert.deepEqual(grants.active(scope, role, "role-b", at), []);
    assert.equal(diary.read("1001", role).entries.find(item => item.id === first)?.shareable, false);
    const before = open().active(scope, role, revision, at);
    assert.deepEqual(before.map(item => item.label), ["纸飞机"]);
    assert.equal(grants.remove(scope, first, 1), true);
    assert.equal(grants.remove(scope, first, 1), false);
    assert.equal(grants.save(scope, role, revision, first, 1, 2, "纸飞机", at), "saved");
    assert.notDeepEqual(grants.active(scope, role, revision, at), before);
    assert.deepEqual(grants.active(scope, role, revision, at + 7 * 86_400_000), []);
    assert.equal(diary.edit("1001", role, first, 1, { text: "已经编辑", shareable: false }), true);
    assert.deepEqual(grants.active(scope, role, revision, at), []);
    assert.equal(grants.save(scope, role, revision, first, 2, 3, "新题", at), "saved");
    revoked.add(first);
    assert.equal(grants.read(scope, role, revision, at).grants[0].state, "revoked");
    assert.deepEqual(grants.active(scope, role, revision, at), []);
    grants.revokeEntry(first);
    assert.equal(grants.read(scope, role, revision, at).grants[0].label, "");
    assert.equal(grants.save(scope, role, revision, first, 2, 4, "恢复旧来源", at), "stale");
    for (let i = 0; i < 3; i++) assert.equal(grants.save(scope, role, revision, make(), 1, 0, "选题 " + i, at), "saved");
    assert.equal(grants.save(scope, role, revision, make(), 1, 0, "第四个选题", at), "limit");
  } finally { store.db.close(); }
});

test("diary rules consume one scoped source per live window without replaying missed windows", () => {
  const store = openStore(":memory:");
  try {
    openQqAccount(store);
    const schedules = openQqAccountSchedules(store);
    let diary = openQqSpaceDiary(store);
    const account = "1001";
    const role = "fixture.first";
    const day = 86_400_000;
    const firstAt = Date.parse("2026-01-01T04:00:00Z");
    const input = { enabled: true, nextAt: firstAt, intervalDays: 1, windowMinutes: 1, visibility: "self" } as const;
    const privateEntry = diary.create(account, role, { text: "本地日记", shareable: false });
    diary.create("2001", role, { text: "另外的账号", shareable: true });
    diary.create(account, "fixture.second", { text: "其他角色", shareable: true });
    const first = diary.create(account, role, { text: "第一条可用素材", shareable: true });
    const second = diary.create(account, role, { text: "第二条可用素材", shareable: true });
    assert.equal(diary.save(account, 0, input, firstAt - 1000), "saved");

    type Event = Parameters<Parameters<typeof diary.dispatch>[2]>[0];
    const events: Event[] = [];
    function dispatch(now: number, permitted = true, fail = false) {
      diary.dispatch(now, (id, visibility) => permitted && id === account && visibility === "self" ? role : null, event => {
        const created = schedules.create(event.id, event.accountId, { kind: "qzone", mode: "generate", material: event.material,
          visibility: event.visibility, diary: event.source }, { dueAt: now, expiresAt: event.expiresAt }, now);
        assert.ok(created.plan);
        if (fail) throw new Error("Fixture rollback");
        events.push(event);
      });
    }
    dispatch(firstAt - 1);
    assert.equal(events.length, 0);
    assert.throws(() => dispatch(firstAt, true, true), /Fixture rollback/);
    assert.equal(schedules.pending(), false);
    assert.equal(diary.read(account, role).rule?.nextAt, firstAt);
    dispatch(firstAt);
    assert.equal(events.length, 1);
    assert.equal(events[0].source.entryId, first);
    assert.equal(events[0].expiresAt, firstAt + 60_000);
    assert.equal(diary.eligible(account, events[0].id, role, events[0].source), true);
    assert.equal(diary.eligible("2001", events[0].id, role, events[0].source), false);
    assert.equal(diary.eligible(account, events[0].id, "fixture.second", events[0].source), false);
    assert.equal(schedules.get(events[0].id)?.state, "diary-queued");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM qq_account_schedules WHERE state IN ('queued','generation-queued')").get()?.n, 0);
    diary = openQqSpaceDiary(store);
    dispatch(firstAt + 4000);
    assert.equal(events.length, 1);
    assert.equal(diary.read(account, role).entries.find(entry => entry.id === privateEntry)?.selected, false);
    assert.equal(diary.save(account, 1, { ...input, enabled: false }, firstAt, firstAt), "conflict");
    assert.equal(diary.edit(account, role, first, 1, { text: "撤下原授权", shareable: false }), true);
    assert.equal(diary.edit(account, role, first, 1, { text: "已过期的编辑", shareable: true }), false);
    assert.equal(diary.eligible(account, events[0].id, role, events[0].source), false);

    dispatch(firstAt + 3 * day + 60_000);
    assert.equal(events.length, 1);
    const nextAt = firstAt + 4 * day;
    assert.equal(diary.read(account, role).rule?.nextAt, nextAt);
    assert.equal(diary.read(account, role).rule?.lastResult, "window-ended");
    dispatch(nextAt, false);
    assert.equal(diary.read(account, role).rule?.lastResult, "waiting-permission");
    dispatch(nextAt + 1000);
    assert.equal(events[1].source.entryId, second);
    assert.equal(diary.eligible(account, events[1].id, role, events[1].source), true);
    const after = diary.read(account, role).rule!;
    assert.equal(diary.save(account, after.version, { ...input, nextAt: after.nextAt }, nextAt + 1000, after.nextAt), "saved");
    assert.equal(diary.eligible(account, events[1].id, role, events[1].source), true);
    assert.equal(diary.save(account, after.version, { ...input, nextAt: after.nextAt, enabled: false }, nextAt + 1000, after.nextAt), "saved");
    assert.equal(diary.eligible(account, events[1].id, role, events[1].source), false);
    dispatch(firstAt + 10 * day);
    assert.equal(events.length, 2);
  } finally {
    store.db.close();
  }
});

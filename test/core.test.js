// node --test site/test/*.test.js  — rules of the serverless student site (mirror of r2c/policy.py decide()).
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../core.js");

const POL = { min_attempt_chars: 30, hint_min_interval_s: 60 };
const A = "데이터를 불러와서 결측값을 확인했는데 평균으로 채워야 할지 모르겠어요.";
const T = 1_700_000_000_000;

test("a hint needs a new attempt first", () => {
  const st = C.newState("x");
  assert.equal(C.reveal(st, 0, 0, T, POL).reason, "need_attempt");
  assert.ok(C.addAttempt(st, 0, A, T, POL).ok);
  const r = C.reveal(st, 0, 0, T, POL);
  assert.ok(r.ok && r.level === 1);
  assert.equal(C.reveal(st, 0, 1, T + 120e3, POL).reason, "need_attempt"); // one reveal per attempt, any stuck point
});

test("short and duplicate attempts are refused", () => {
  const st = C.newState("x");
  assert.equal(C.addAttempt(st, 0, "몰라요", T, POL).reason, "attempt_too_short");
  assert.ok(C.addAttempt(st, 0, A, T, POL).ok);
  assert.equal(C.addAttempt(st, 0, "  " + A + " ", T, POL).reason, "duplicate");
});

test("minimum interval between hints", () => {
  const st = C.newState("x");
  C.addAttempt(st, 0, A, T, POL);
  C.reveal(st, 0, 0, T, POL);
  C.addAttempt(st, 0, A + " 중앙값도 써 봤어요", T + 1000, POL);
  assert.equal(C.reveal(st, 0, 0, T + 30e3, POL).reason, "too_fast");
  const r = C.reveal(st, 0, 0, T + 61e3, POL);
  assert.ok(r.ok && r.level === 2);
});

test("ladder stops at level 3, per stuck point", () => {
  const st = C.newState("x");
  for (let k = 0; k < 3; k++) {
    C.addAttempt(st, 0, `${A} 시도 ${k}`, T + k * 120e3, POL);
    assert.equal(C.reveal(st, 0, 0, T + k * 120e3 + 1, POL).level, k + 1);
  }
  C.addAttempt(st, 0, `${A} 시도 3`, T + 400e3, POL);
  assert.equal(C.reveal(st, 0, 0, T + 500e3, POL).reason, "max_level");
  assert.equal(C.reveal(st, 0, 1, T + 500e3, POL).level, 1); // another stuck point starts at 1
});

test("distress text is never stored and blocks hints", () => {
  const st = C.newState("x");
  const r = C.addAttempt(st, 0, "요즘 너무 힘들어서 죽고 싶다는 생각이 들어요. 과제도 못 하겠어요.", T, POL);
  assert.equal(r.reason, "concern");
  assert.equal(C.ms(st, 0).attempts.length, 0);
  const sent = st.outbox.filter((e) => e.kind === "flag");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].detail, ""); // the operator sees a flag, not the text
});

test("submit only the current milestone; it opens the next", () => {
  const st = C.newState("x");
  assert.equal(C.submit(st, 1, 3, "https://drive/x", T).reason, "not_current");
  assert.equal(C.submit(st, 0, 3, " ", T).reason, "submit_empty");
  assert.ok(C.submit(st, 0, 3, "https://drive/x", T).ok);
  assert.equal(C.current(st, 3), 1);
  assert.equal(C.addAttempt(st, 0, A, T, POL).reason, "done");
});

test("quiz: first result is the diagnosis, retakes are practice", () => {
  const st = C.newState("x");
  const qs = [{ concept: "a", answer: 1 }, { concept: "a", answer: 0 }, { concept: "b", answer: 2 }];
  const g = C.grade(qs, { 0: 1, 1: 3, 2: 2 });
  assert.deepEqual([g.correct, g.total, g.weak], [2, 3, ["a"]]);
  C.recordQuiz(st, g, { 0: 1 }, T);
  C.recordQuiz(st, C.grade(qs, { 0: 1, 1: 0, 2: 2 }), {}, T + 1);
  assert.equal(st.quiz.first.result.correct, 2);
  assert.equal(st.quiz.last.result.correct, 3);
  assert.equal(st.quiz.tries, 2);
});

test("activity log caps detail length and records milestone", () => {
  const st = C.newState("x");
  C.addAttempt(st, 2, "가".repeat(3000), T, POL);
  const e = st.outbox[0];
  assert.equal(e.kind, "attempt");
  assert.equal(e.milestone, 2);
  assert.equal(e.detail.length, 1500);
});

test("pack validation", () => {
  const ok = { v: 1, code: "c", project: {}, milestones: [{ stuck: [{ label: "l", hints: ["1", "2", "3"] }] }] };
  assert.ok(C.validPack(ok));
  assert.ok(!C.validPack({ ...ok, v: 2 }));
  assert.ok(!C.validPack({ ...ok, milestones: [{ stuck: [{ label: "l", hints: ["1", "2"] }] }] }));
  assert.ok(!C.validPack({ ...ok, milestones: [] }));
});

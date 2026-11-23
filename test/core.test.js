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
  const ok = { v: 1, code: "c", project: { title: "t" }, policy: POL, milestones: [{ title: "m", stuck: [{ label: "l", hints: ["1", "2", "3"] }] }] };
  assert.ok(C.validPack(ok));
  assert.ok(!C.validPack({ ...ok, v: 2 }));
  assert.ok(!C.validPack({ ...ok, milestones: [{ title: "m", stuck: [{ label: "l", hints: ["1", "2"] }] }] }));
  assert.ok(!C.validPack({ ...ok, milestones: [] }));
});

test("the unsent log is bounded so an unconfigured or offline site cannot fill browser storage", () => {
  const st = C.newState("x");
  for (let k = 0; k < C.OUTBOX_MAX + 50; k++) C.addAttempt(st, 0, A + " 시도 " + k, T + k, POL);
  assert.equal(st.outbox.length, C.OUTBOX_MAX);
  assert.ok(st.outbox[st.outbox.length - 1].detail.endsWith("시도 " + (C.OUTBOX_MAX + 49)));  // newest kept
  assert.equal(C.ms(st, 0).attempts.length, C.OUTBOX_MAX + 50);                                // progress itself untouched
});

test("distress check: spacing variants, more phrases, research vocabulary let through", () => {
  for (const t of ["죽 고 싶 어", "그냥 사라지고 싶어요", "살고 싶지 않아", "자해를 했어", "I want to end my life", "I might hurt myself"])
    assert.ok(C.concern(t), t);
  for (const t of ["국가별 자살률 데이터를 정리했어요", "자살 예방 정책 논문", "suicide rate by region", "과제 때문에 힘들어 죽겠다"])
    assert.ok(!C.concern(t), t);
});

test("distress text in a submission is not stored either", () => {
  const st = C.newState("x");
  assert.equal(C.submit(st, 0, 3, "다 그만두고 죽고 싶어요", T).reason, "concern");
  assert.equal(C.ms(st, 0).submitted, null);
  assert.deepEqual(st.outbox.map((e) => [e.kind, e.detail]), [["flag", ""]]);
});

test("a clock moved back stops the action once and is logged", () => {
  const st = C.newState("x");
  assert.ok(C.addAttempt(st, 0, A, T, POL).ok);
  const back = T - C.CLOCK_SLACK_MS - 60e3;
  assert.equal(C.addAttempt(st, 0, A + " 다시", back, POL).reason, "clock");
  assert.equal(st.outbox[st.outbox.length - 1].kind, "clock");
  assert.ok(C.addAttempt(st, 0, A + " 다시", back + 1, POL).ok);       // asked once, then it goes through
  assert.ok(C.addAttempt(st, 0, A + " 조금 뒤", T - 30e3, POL).ok);      // small drift is fine
});

test("every log entry has a growing sequence number; old saved states get one", () => {
  const st = C.newState("x");
  C.addAttempt(st, 0, A, T, POL); C.reveal(st, 0, 0, T, POL);
  assert.deepEqual(st.outbox.map((e) => e.seq), [1, 2]);
  assert.ok(st.sid && st.sid.length >= 8);
  const old = { v: 1, code: "x", pid: "P1", consent: true, ms: {}, quiz: null, outbox: [{ kind: "attempt", milestone: 0, detail: "", at: "" }] };
  const m = C.migrate(old);
  assert.ok(m.sid && m.outbox[0].seq === 1 && m.seq === 1);
});

const fs = require("fs"), path = require("path");
const PLAIN = { v: 1, code: "demo-x", project: { title: "t" }, policy: POL,
  milestones: [{ title: "m", deliverable: "d", weeks: 2, stuck: [{ label: "l", hints: ["방향 힌트", "개념 힌트", "예시 힌트"] }] }],
  quiz: [{ concept: "c", question: "q", options: ["a", "b", "c"], answer: 2, explanation: "왜냐하면" }],
  guides: [{ concept: "c", why: "w", summary: "s", steps: ["1"], practice: "p", keywords: ["k"] }] };

test("sealed packs hide hints and answers and read back exactly", () => {
  const s = C.sealPack(PLAIN);
  const raw = JSON.stringify(s);
  assert.ok(!raw.includes("힌트") && !raw.includes("왜냐하면") && !/"answer":2/.test(raw));
  assert.ok(C.validPack(s));
  assert.deepEqual([0, 1, 2].map((k) => C.hintText(s, 0, 0, k)), PLAIN.milestones[0].stuck[0].hints);
  assert.equal(C.quizKey(s)[0].answer, 2);
  assert.equal(C.quizKey(s)[0].explanation, "왜냐하면");
  assert.equal(C.sealPack(s), s);                       // sealing twice is a no-op
  assert.equal(C.hintText(PLAIN, 0, 0, 1), "개념 힌트");  // plain packs still work
});

test("pack validation catches what the screens would trip over", () => {
  assert.ok(C.validPack(PLAIN));
  const bad = [
    { ...PLAIN, policy: undefined },
    { ...PLAIN, policy: { min_attempt_chars: "30", hint_min_interval_s: 60 } },
    { ...PLAIN, project: {} },
    { ...PLAIN, milestones: [{ ...PLAIN.milestones[0], title: "" }] },
    { ...PLAIN, quiz: [{ ...PLAIN.quiz[0], answer: 3 }] },
    { ...PLAIN, quiz: [{ ...PLAIN.quiz[0], options: ["only"] }] },
    { ...PLAIN, guides: [{ ...PLAIN.guides[0], steps: "1" }] },
    { ...PLAIN, sealed: 2 },
  ];
  bad.forEach((p, k) => assert.ok(!C.validPack(p), "case " + k));
});

test("every published pack is valid", () => {
  const dir = path.join(__dirname, "..", "packs");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")))
    assert.ok(C.validPack(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))), f);
});

const ECG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "packs", "ecg.json"), "utf8"));

test("suggestion: the attempt is matched to the closest stuck point from the labels alone", () => {
  const m = ECG.milestones[0];
  assert.equal(C.recommend(m, "I tried to load the .dat files with wfdb but python says file not found"), 0);
  assert.equal(C.recommend(m, "the plot of lead II is just noise, cannot see any beats"), 2);
  assert.equal(C.recommend(m, "오늘은 그냥 아무것도 안 했어요 정말로요 진짜로"), -1);  // nothing close: no suggestion
});

test("suggestion is stored with the attempt, shown until a hint is opened, and logged with that hint", () => {
  const st = C.newState("ecg"), m = ECG.milestones[0];
  assert.ok(C.addAttempt(st, 0, "I tried to load the .dat files with wfdb but python says file not found", T, POL, m).ok);
  assert.equal(C.suggestion(st, 0), 0);
  C.reveal(st, 0, 2, T, POL);
  assert.equal(C.suggestion(st, 0), -1);
  assert.deepEqual(JSON.parse(st.outbox[st.outbox.length - 1].detail), { stuck: 2, level: 1, rec: 0 });
});

test("mined signals steer the suggestion where the labels alone cannot", () => {
  const m = { stuck: [{ label: "막힌 지점 A", hints: ["1", "2", "3"] }, { label: "막힌 지점 B", hints: ["1", "2", "3"] }] };
  assert.equal(C.recommend(m, "결측값을 평균으로 채웠어요"), -1);
  const m2 = { stuck: [{ ...m.stuck[0], signals: { "결측": 2, "측값": 2 } }, { ...m.stuck[1], signals: { "정규": 2, "스케": 2 } }] };
  assert.equal(C.recommend(m2, "결측값을 평균으로 채웠어요"), 0);
  assert.equal(C.recommend(m2, "정규화 스케일을 맞췄어요"), 1);
  assert.ok(C.validPack({ ...PLAIN, milestones: [{ ...PLAIN.milestones[0], stuck: [{ ...PLAIN.milestones[0].stuck[0], signals: { ab: 1 } }] }] }));
  assert.ok(!C.validPack({ ...PLAIN, milestones: [{ ...PLAIN.milestones[0], stuck: [{ ...PLAIN.milestones[0].stuck[0], signals: { ab: "1" } }] }] }));
});

test("mining: labels from attempt -> hint pairs, fragments from fewer than 3 students never reach the pack", () => {
  const os = require("os"), { execFileSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mine-"));
  const packs = path.join(dir, "packs"); fs.mkdirSync(packs);
  const pack = { v: 1, code: "t1", project: { title: "t" }, policy: POL, milestones: [{ title: "m",
    stuck: [{ label: "막힌 지점 A", hints: ["1", "2", "3"] }, { label: "막힌 지점 B", hints: ["1", "2", "3"] }] }] };
  fs.writeFileSync(path.join(packs, "t1.json"), JSON.stringify(pack));
  const rows = [["pid", "code", "kind", "milestone", "detail", "at", "seq"]];
  const add = (pid, sid, seq, kind, detail) => rows.push([pid, "t1", kind, "1", detail, "", sid + ":" + seq]);
  ["P1", "P2", "P3", "P4"].forEach((pid, k) => {
    add(pid, "s" + k, 1, "attempt", "결측값이 많아서 평균으로 채워 봤어요, \"따옴표\", 쉼표");
    add(pid, "s" + k, 2, "hint", JSON.stringify({ stuck: 0, level: 1 }));
    add(pid, "s" + k, 3, "attempt", "정규화 스케일을 맞추는 법을 모르겠어요");
    add(pid, "s" + k, 4, "hint", JSON.stringify({ stuck: 1, level: 1 }));
  });
  add("P1", "s0", 5, "attempt", "비밀단어쿼크를 써 봤어요");  // one student only
  add("P1", "s0", 6, "hint", JSON.stringify({ stuck: 0, level: 2 }));
  const csv = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(",")).join("\r\n");
  fs.writeFileSync(path.join(dir, "log.csv"), "﻿" + csv);
  const out = execFileSync("node", [path.join(__dirname, "..", "scripts", "mine_signals.js"), path.join(dir, "log.csv"), "--write", "--packs", packs], { encoding: "utf8" });
  assert.match(out, /9 labelled attempts, 4 students/);
  assert.match(out, /labels only: right - of 0 shown \| with signals: right 100% of 9 shown/);
  const got = JSON.parse(fs.readFileSync(path.join(packs, "t1.json"), "utf8"));
  const sig = got.milestones[0].stuck.map((s) => s.signals || {});
  assert.ok(sig[0]["결측"] > 0 && sig[1]["정규"] > 0);
  const all = Object.keys(sig[0]).concat(Object.keys(sig[1]));
  for (const g of ["비밀", "밀단", "단어", "어쿼", "쿼크", "비밀단", "단어쿼"]) assert.ok(!all.includes(g), g + " came from one student only");
  assert.ok(all.every((g) => g.length <= 3), "fragments only, no sentences");
  assert.ok(C.validPack(got) && C.recommend(got.milestones[0], "결측값 처리") === 0);
});

test("restore from a backup file: same project and participant, never less progress, no resent rows", () => {
  const old = C.newState("demo"); old.pid = "P07"; old.consent = true;
  C.addAttempt(old, 0, A, T, POL); C.reveal(old, 0, 0, T, POL); C.submit(old, 0, 3, "https://drive/x", T);
  const file = JSON.parse(JSON.stringify(old));
  const r = C.restoreFrom(C.newState("demo"), file, "demo", T + 10);
  assert.ok(r.ok && r.state.pid === "P07" && r.state.consent && C.current(r.state, 3) === 1);
  assert.deepEqual(r.state.outbox.map((e) => e.kind), ["restore"], "the file's old unsent rows are not sent again");
  assert.ok(r.state.outbox[0].seq > old.seq, "sequence keeps counting");
  assert.equal(C.restoreFrom(r.state, C.newState("demo"), "demo", T).reason, "restore_older");
  assert.equal(C.restoreFrom(C.newState("ecg"), file, "ecg", T).reason, "restore_bad");
  assert.equal(C.restoreFrom({ ...C.newState("demo"), pid: "P99" }, file, "demo", T).reason, "restore_other");
  assert.equal(C.restoreFrom(C.newState("demo"), { ...file, ms: { 0: { attempts: "x", reveals: [] } } }, "demo", T).reason, "restore_bad");
  assert.equal(C.restoreFrom(C.newState("demo"), null, "demo", T).reason, "restore_bad");
});

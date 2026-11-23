// End to end: simulated students go through the real client rules (core.js), their logs become a Form export, and the
// report must recover what was planted: which hint variant works better, which hint needs review.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), { execFileSync } = require("child_process");
const C = require("../core.js");

const POL = { min_attempt_chars: 10, hint_min_interval_s: 0 };
const PACK = { v: 1, code: "abx", project: { title: "t" }, policy: POL, milestones: [{ title: "m", stuck: [
  { label: "데이터를 불러오지 못해요", hints: ["원래 힌트 1", "힌트 2", "힌트 3"], variants: [["새로 쓴 힌트 1"], [], []] },
  { label: "그래프가 이상해요", hints: ["그래프 힌트 1", "그래프 힌트 2", "그래프 힌트 3"] },
  { label: "드물게 막히는 곳", hints: ["드문 힌트 1", "드문 힌트 2", "드문 힌트 3"] }] }] };

function rng(seed) { let a = seed; return () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; }; }

function simulate() {
  const r = rng(7), rows = [["pid", "code", "kind", "milestone", "detail", "at", "seq"]];
  for (let k = 0; k < 80; k++) {
    const pid = "S" + k, st = C.newState("abx"); st.pid = pid;
    let t = Date.UTC(2026, 10, 1) + k * 1e6;
    const step = () => (t += 60000);
    const stuck = k < 50 ? 0 : k < 78 ? 1 : 2;          // 50 students on stuck 0, 28 on stuck 1, 2 on the rare one
    C.addAttempt(st, 0, "처음 시도: 학생 고유 문장 비밀XYZ " + k, step(), POL, PACK.milestones[0]);
    const v = C.variantOf(PACK, pid, 0, stuck, 0);
    C.reveal(st, 0, stuck, step(), POL, v);
    // Planted truth: on stuck 0 the new wording (variant 1) resolves 85%, the original 30%; stuck 1 level 1 only 15%.
    const p = stuck === 0 ? (v === 1 ? 0.85 : 0.3) : stuck === 1 ? 0.15 : 0.6;
    const ok = r() < p;
    C.rate(st, 0, stuck, ok, step());
    if (!ok) {
      C.addAttempt(st, 0, "두 번째 시도는 완전히 다른 방법으로 해 봤어요 " + k, step(), POL, PACK.milestones[0]);
      C.reveal(st, 0, stuck, step(), POL, C.variantOf(PACK, pid, 0, stuck, 1));
    }
    if (k % 10 !== 9 || ok) C.submit(st, 0, 1, "https://drive.example/" + k, step());  // a few never finish
    st.outbox.forEach((e) => rows.push([pid, "abx", e.kind, String(e.milestone + 1), e.detail, e.at, st.sid + ":" + e.seq]));
  }
  return rows.map((row) => row.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(",")).join("\n");
}

test("hint report recovers the planted winner and the weak hint, and promotes the winner into a sealed pack", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-")), packs = path.join(dir, "packs");
  fs.mkdirSync(packs);
  fs.writeFileSync(path.join(packs, "abx.json"), JSON.stringify(C.sealPack(PACK)));
  fs.writeFileSync(path.join(dir, "log.csv"), simulate());
  const script = path.join(__dirname, "..", "scripts", "hint_report.js");

  const json = JSON.parse(execFileSync("node", [script, path.join(dir, "log.csv"), "--packs", packs, "--json"], { encoding: "utf8" }));
  const x = json.experiments.find((e) => e.s === 0 && e.level === 1);
  assert.equal(x.winner, 1, "variant 1 (new wording) wins");
  assert.ok(x.variants[1].pBest >= 0.95 && x.variants.every((v) => v.students >= 10));
  assert.equal(x.variants[1].text, "새로 쓴 힌트 1");                       // sealed text is read back for the reviewer
  const weak = json.hints.find((h) => h.s === 1 && h.level === 1);
  assert.ok(weak.review && weak.pLow >= 0.9, "the weak hint is queued for review");
  assert.ok(json.hints.find((h) => h.s === 0 && h.level === 1).review === false);
  assert.ok(json.hints.filter((h) => h.review)[0].s === 1, "the review queue starts with the weak hint");
  assert.ok(!json.hints.find((h) => h.s === 2).enough, "groups under 3 students get no numbers");
  assert.ok(weak.up + weak.down > 0 && weak.novelty > 0.3, "ratings and attempt change are measured");

  const md = execFileSync("node", [script, path.join(dir, "log.csv"), "--packs", packs], { encoding: "utf8" });
  assert.match(md, /승자: 변형 1/);
  assert.match(md, /검토가 필요한 힌트 \(\d+\)/);
  assert.ok(!md.includes("비밀XYZ") && !md.includes("drive.example"), "no student text in the report");

  const before = fs.readFileSync(path.join(packs, "abx.json"), "utf8");
  execFileSync("node", [script, path.join(dir, "log.csv"), "--packs", packs, "--apply"], { encoding: "utf8", stdio: "pipe" });
  assert.equal(fs.readFileSync(path.join(packs, "abx.json"), "utf8"), before, "--apply without --write changes nothing");
  execFileSync("node", [script, path.join(dir, "log.csv"), "--packs", packs, "--apply", "--write"], { encoding: "utf8", stdio: "pipe" });
  const after = JSON.parse(fs.readFileSync(path.join(packs, "abx.json"), "utf8"));
  assert.ok(after.sealed === 1 && C.validPack(after));
  assert.equal(C.hintText(after, 0, 0, 0), "새로 쓴 힌트 1");
  assert.equal(after.milestones[0].stuck[0].variants, undefined, "the experiment is over");
  assert.equal(C.hintText(after, 0, 1, 0), "그래프 힌트 1", "other hints untouched");
});

test("variants: stable per student, roughly even split, sealed, and the shown variant is logged", () => {
  const counts = [0, 0];
  for (let k = 0; k < 400; k++) counts[C.variantOf(PACK, "P" + k, 0, 0, 0)]++;
  assert.ok(counts[0] > 160 && counts[1] > 160, "split " + counts);
  assert.equal(C.variantOf(PACK, "P1", 0, 0, 0), C.variantOf(PACK, "P1", 0, 0, 0));
  assert.equal(C.variantOf(PACK, "P1", 0, 1, 0), null, "no alternatives, no experiment");
  const sealed = C.sealPack(PACK);
  assert.ok(!JSON.stringify(sealed).includes("새로 쓴") && C.hintText(sealed, 0, 0, 0, 1) === "새로 쓴 힌트 1");
  assert.deepEqual(C.unsealPack(sealed), JSON.parse(JSON.stringify(PACK)));
  const st = C.newState("abx");
  C.addAttempt(st, 0, "충분히 긴 첫 번째 시도예요", 1, POL);
  C.reveal(st, 0, 0, 2, POL, 1);
  assert.deepEqual(JSON.parse(st.outbox.pop().detail), { stuck: 0, level: 1, v: 1 });
  assert.ok(C.rate(st, 0, 0, true, 3).ok && !C.rate(st, 0, 0, false, 4).ok, "rated once");
  assert.deepEqual(JSON.parse(st.outbox.pop().detail), { stuck: 0, level: 1, up: true, v: 1 });
  assert.ok(!C.validPack({ ...PACK, milestones: [{ ...PACK.milestones[0], stuck: [{ ...PACK.milestones[0].stuck[0], variants: [["a"], []] }] }] }));
});

test("a log whose columns don't match says which ones are missing and how to map them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cols-"));
  fs.writeFileSync(path.join(dir, "form.csv"), "타임스탬프,참여 번호,과제 코드,종류,마일스톤,내용\nx,P1,abx,attempt,1,hello\n");
  for (const s of ["hint_report.js", "mine_signals.js"]) {
    let err = "";
    try { execFileSync("node", [path.join(__dirname, "..", "scripts", s), path.join(dir, "form.csv")], { stdio: "pipe" }); } catch (e) { err = String(e.stderr); }
    assert.match(err, /missing columns: pid/, s);
    assert.match(err, /"참여 번호"/, s);
    assert.match(err, /--cols/, s);
  }
  const ok = execFileSync("node", [path.join(__dirname, "..", "scripts", "hint_report.js"), path.join(dir, "form.csv"),
    "--cols", "pid=참여 번호,code=과제 코드,kind=종류,milestone=마일스톤,detail=내용", "--json"], { encoding: "utf8" });
  assert.equal(JSON.parse(ok).meta.rows, 1);
});

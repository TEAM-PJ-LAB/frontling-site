// Which hints work? Reads the activity log and reports, for every hint (project, milestone, stuck point, level,
// variant), what students did after opening it; picks winners of hint experiments and can promote them into the packs.
//   node scripts/hint_report.js <log.csv> [--final] [--out report.md] [--json] [--cols ...] [--packs dir] [--apply --write]
//
// After a hint is opened, within the same milestone:
//   resolved  - the milestone was submitted without opening the next level of that stuck point
//   escalated - the next level of that stuck point was opened (this one was not enough)
//   open      - neither yet (still working, or stopped); left out of the rates until it is decided
// --final (the cohort has ended): an open hint is a failure too ("stopped": the student never got past it).
// The last level has no next level, so it can only fail by stopping: without --final it gets no resolve-rate
// judgement (no review by rate, no experiment winner), only ratings.
// Also: the student's own rating ("rate" rows), minutes until the next attempt, and how much that attempt changed
// from the one before the hint (0 = same words, 1 = all new).
//
// Statistics: a hint's resolve rate has a Beta(1 + resolved, 1 + failed) posterior (failed = escalated, plus stopped with --final). A hint is queued for review
// when it is probably (>= 90%) below the average of hints at the same level in the project, or when most ratings are
// negative. Variants are assigned at random (by participant), so comparing them is a fair experiment: a variant wins
// when it is the best with >= 95% probability and every variant has >= 10 decided cases.
// Privacy: numbers only for groups of at least 3 students; no student text is printed.
const fs = require("fs"), path = require("path");
const C = require("../core.js");
const L = require("./lib/log.js");

const MIN_STUDENTS = 3, REVIEW_P = 0.9, REVIEW_MIN = 5, WIN_P = 0.95, WIN_MIN = 10, DRAWS = 4000;

// ---------- statistics (seeded, so the same log always gives the same report) ----------
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function normal(r) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
function gamma(r, k) {  // Marsaglia-Tsang, k >= 1 (always true here: the prior adds 1)
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v; do { x = normal(r); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function beta(r, a, b) { const x = gamma(r, a); return x / (x + gamma(r, b)); }
function pBelow(res, esc, base, r) { let n = 0; for (let k = 0; k < DRAWS; k++) if (beta(r, 1 + res, 1 + esc) < base) n++; return n / DRAWS; }
function pBest(groups, r) {
  const wins = groups.map(() => 0);
  for (let k = 0; k < DRAWS; k++) {
    let best = -1, bi = 0;
    groups.forEach((g, i) => { const x = beta(r, 1 + g.resolved, 1 + g.failed); if (x > best) { best = x; bi = i; } });
    wins[bi]++;
  }
  return wins.map((w) => w / DRAWS);
}
const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
function novelty(a, b) {
  const x = Object.keys(C.grams(a)), y = new Set(Object.keys(C.grams(b)));
  if (!x.length && !y.size) return 0;
  let both = 0; x.forEach((g) => { if (y.has(g)) both++; });
  return 1 - both / (x.length + y.size - both);
}

// ---------- outcomes of every opened hint ----------
function outcomes(lines) {
  const out = [];
  lines.forEach((list) => list.forEach((e, k) => {
    if (e.kind !== "hint" || !e.data || !Number.isInteger(e.data.stuck) || !Number.isInteger(e.data.level)) return;
    const s = e.data.stuck, lv = e.data.level, after = list.slice(k + 1).filter((x) => x.m === e.m);
    const before = list.slice(0, k).filter((x) => x.m === e.m && x.kind === "attempt").pop();
    const submitAt = after.findIndex((x) => x.kind === "submit");
    const upto = submitAt >= 0 ? after.slice(0, submitAt) : after;
    const escalated = upto.some((x) => x.kind === "hint" && x.data && x.data.stuck === s && x.data.level === lv + 1);
    const rating = after.find((x) => x.kind === "rate" && x.data && x.data.stuck === s && x.data.level === lv);
    const next = upto.find((x) => x.kind === "attempt");
    out.push({
      code: e.code, pid: e.pid, m: e.m, s, lv, v: Number.isInteger(e.data.v) ? e.data.v : 0, experiment: Number.isInteger(e.data.v),
      outcome: escalated ? "escalated" : submitAt >= 0 ? "resolved" : "open",
      up: rating ? !!rating.data.up : null,
      minutes: next && !isNaN(next.at) && !isNaN(e.at) ? (next.at - e.at) / 60000 : null,
      novelty: next && before ? novelty(before.detail, next.detail) : null,
    });
  }));
  return out;
}

function summarize(list, final) {
  const students = new Set(list.map((x) => x.pid)).size;
  const resolved = list.filter((x) => x.outcome === "resolved").length, escalated = list.filter((x) => x.outcome === "escalated").length;
  const open = list.length - resolved - escalated, failed = escalated + (final ? open : 0);
  const rated = list.filter((x) => x.up !== null);
  return {
    opened: list.length, students, resolved, escalated, open, failed,
    rate: (1 + resolved) / (2 + resolved + failed),  // posterior mean
    up: rated.filter((x) => x.up).length, down: rated.filter((x) => !x.up).length,
    minutes: median(list.map((x) => x.minutes).filter((x) => x !== null && x >= 0)),
    novelty: median(list.map((x) => x.novelty).filter((x) => x !== null)),
  };
}

// ---------- analysis ----------
function analyse(events, packs, opts = {}) {
  const final = !!opts.final, judged = (lv) => final || lv < C.MAX_LEVEL;  // see --final above
  const r = rng(20261117), hints = [], experiments = [];
  const key = (x) => [x.code, x.m, x.s, x.lv].join("|");
  const groups = new Map();
  events.forEach((x) => { const k = key(x); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); });
  // Baseline: resolve rate of all hints at the same level in the same project.
  const base = {};
  events.forEach((x) => {
    const b = base[x.code + "|" + x.lv] || (base[x.code + "|" + x.lv] = { resolved: 0, failed: 0 });
    if (x.outcome === "resolved") b.resolved++; else if (x.outcome === "escalated" || final) b.failed++;
  });
  const baseRate = (code, lv) => { const b = base[code + "|" + lv]; return (1 + b.resolved) / (2 + b.resolved + b.failed); };

  groups.forEach((list, k) => {
    const [code, m, s, lv] = k.split("|"), M = +m, S = +s, LV = +lv, pack = packs[code];
    const sum = summarize(list, final), b = baseRate(code, LV);
    const label = pack && pack.milestones[M] && pack.milestones[M].stuck[S] ? pack.milestones[M].stuck[S].label : "(unknown stuck point)";
    const text = (v) => { try { return pack ? C.hintText(pack, M, S, LV - 1, v) : ""; } catch (e) { return ""; } };
    const enough = sum.students >= MIN_STUDENTS;
    const decided = sum.resolved + sum.failed;
    const pLow = enough && judged(LV) && decided >= REVIEW_MIN ? pBelow(sum.resolved, sum.failed, b, r) : null;
    const disliked = sum.up + sum.down >= REVIEW_MIN && sum.down / (sum.up + sum.down) >= 0.5;
    hints.push({ code, m: M, s: S, level: LV, label, text: text(0), ...sum, baseline: b, pLow, enough,
      review: !!((pLow !== null && pLow >= REVIEW_P) || (enough && disliked)), impact: decided * Math.max(0, b - sum.rate) });

    // Experiment: compare the variants of this hint.
    if (!list.some((x) => x.experiment)) return;
    const byV = new Map(); list.forEach((x) => { if (!byV.has(x.v)) byV.set(x.v, []); byV.get(x.v).push(x); });
    const vs = [...byV.keys()].sort((a, c) => a - c).map((v) => ({ v, text: text(v), ...summarize(byV.get(v), final) }));
    const p = vs.length > 1 ? pBest(vs, r) : vs.map(() => 1);
    vs.forEach((x, i) => { x.pBest = p[i]; });
    const best = vs.reduce((a, c) => (c.pBest > a.pBest ? c : a));
    const ready = judged(LV) && vs.length > 1 && vs.every((x) => x.resolved + x.failed >= WIN_MIN && x.students >= MIN_STUDENTS);
    experiments.push({ code, m: M, s: S, level: LV, label, variants: vs, winner: ready && best.pBest >= WIN_P ? best.v : null });
  });
  hints.sort((a, c) => c.review - a.review || c.impact - a.impact || a.code.localeCompare(c.code) || a.m - c.m || a.s - c.s || a.level - c.level);
  return { hints, experiments };
}

// ---------- report ----------
const pct = (x) => (x === null || x === undefined ? "-" : Math.round(x * 100) + "%");
const num = (x, d = 1) => (x === null || x === undefined ? "-" : x.toFixed(d));
const cut = (t, n = 70) => { t = String(t || "").replace(/\s+/g, " "); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const where = (h) => `${h.code} M${h.m + 1} · ${cut(h.label, 40)} · ${h.level}단계`;

function markdown(res, meta) {
  const out = [`# 힌트 효과 보고서`, ``, `${meta.rows}행, 학생 ${meta.students}명, 힌트 열람 ${meta.opened}회 · 생성 ${meta.when}`, ``,
    `해결 = 그 지점의 다음 단계 없이 마일스톤 제출, 상승 = 다음 단계를 엶, 진행 중 = 아직 결정 안 됨(비율에서 제외).`,
    `해결률은 사후 평균(작은 표본을 과장하지 않음)이고, 기준선은 같은 과제·같은 단계 힌트 전체의 해결률이에요.`,
    `학생 ${MIN_STUDENTS}명 미만 묶음은 숫자를 보여 주지 않아요.`,
    meta.final ? `기수 종료 기준(--final): 진행 중으로 남은 힌트는 실패(멈춤)로 셉니다.`
      : `진행 중 기준: 마지막 단계 힌트는 다음 단계가 없어 해결률로 판정하지 않아요(평가만). 기수가 끝나면 --final로 다시 돌리세요.`, ``];
  const queue = res.hints.filter((h) => h.review);
  out.push(`## 1. 검토가 필요한 힌트 (${queue.length})`, ``);
  if (!queue.length) out.push(`없음. 데이터가 더 쌓이면 다시 확인하세요.`, ``);
  queue.forEach((h, i) => {
    const why = [];
    if (h.pLow !== null && h.pLow >= REVIEW_P) why.push(`해결률 ${pct(h.rate)} < 기준선 ${pct(h.baseline)} (확률 ${pct(h.pLow)})`);
    if (h.up + h.down >= REVIEW_MIN && h.down / (h.up + h.down) >= 0.5) why.push(`"도움 안 됨" ${h.down}/${h.up + h.down}`);
    out.push(`${i + 1}. **${where(h)}** — ${why.join(", ")}`, `   > ${cut(h.text, 160)}`,
      `   열람 ${h.opened} · 해결 ${h.resolved} · 상승 ${h.escalated} · 진행 중 ${h.open} · 다음 시도까지 ${num(h.minutes)}분 · 시도 변화 ${pct(h.novelty)}`, ``);
  });
  out.push(`## 2. 힌트 실험 (${res.experiments.length})`, ``);
  if (!res.experiments.length) out.push(`진행 중인 실험 없음. 팩의 막힌 지점에 \`variants\`를 넣으면 시작돼요.`, ``);
  res.experiments.forEach((x) => {
    const status = x.winner !== null ? `**승자: 변형 ${x.winner}** (\`--apply --write\`로 반영)` : `결정 전 (변형마다 결정된 사례 ${WIN_MIN}건, 승리 확률 ${pct(WIN_P)} 필요)`;
    out.push(`### ${where(x)} — ${status}`, ``, `| 변형 | 학생 | 해결 | 상승 | 해결률 | 최고일 확률 | 👍/👎 | 문구 |`, `|---|---|---|---|---|---|---|---|`);
    x.variants.forEach((v) => {
      const show = v.students >= MIN_STUDENTS;
      out.push(`| ${v.v} | ${v.students} | ${show ? v.resolved : "·"} | ${show ? v.escalated : "·"} | ${show ? pct(v.rate) : "·"} | ${show ? pct(v.pBest) : "·"} | ${show ? v.up + "/" + v.down : "·"} | ${cut(v.text, 60).replace(/\|/g, "\\|")} |`);
    });
    out.push(``);
  });
  out.push(`## 3. 모든 힌트`, ``, `| 위치 | 학생 | 열람 | 해결 | 상승 | 진행 중 | 해결률 | 기준선 | 👍/👎 | 다음 시도(분) | 시도 변화 |`, `|---|---|---|---|---|---|---|---|---|---|---|`);
  res.hints.slice().sort((a, c) => a.code.localeCompare(c.code) || a.m - c.m || a.s - c.s || a.level - c.level).forEach((h) => {
    if (!h.enough) return out.push(`| ${where(h)} | <${MIN_STUDENTS} | · | · | · | · | · | · | · | · | · |`);
    out.push(`| ${where(h)}${h.review ? " ⚠️" : ""} | ${h.students} | ${h.opened} | ${h.resolved} | ${h.escalated} | ${h.open} | ${pct(h.rate)} | ${pct(h.baseline)} | ${h.up}/${h.down} | ${num(h.minutes)} | ${pct(h.novelty)} |`);
  });
  return out.join("\n") + "\n";
}

// ---------- promote winners ----------
function apply(res, packs, files, write) {
  const changed = new Set();
  res.experiments.filter((x) => x.winner !== null).forEach((x) => {
    const sealed = packs[x.code].sealed === 1, p = C.unsealPack(packs[x.code]);
    const sp = p.milestones[x.m].stuck[x.s], k = x.level - 1;
    if (x.winner > 0) sp.hints[k] = sp.variants[k][x.winner - 1];
    sp.variants[k] = [];
    if (sp.variants.every((l) => !l.length)) delete sp.variants;
    packs[x.code] = sealed ? C.sealPack(p) : p;
    changed.add(x.code);
    console.error(`promote: ${where(x)} -> variant ${x.winner}`);
  });
  changed.forEach((code) => {
    if (!C.validPack(packs[code])) throw new Error(code + ": pack invalid after promotion");
    if (write) fs.writeFileSync(files[code], JSON.stringify(packs[code]));
  });
  return [...changed];
}

// ---------- run ----------
if (require.main === module) {
  const args = process.argv.slice(2), csvPath = L.positional(args);
  if (!csvPath) { console.error("usage: node scripts/hint_report.js <log.csv> [--out report.md] [--json] [--cols ...] [--packs dir] [--apply --write]"); process.exit(2); }
  const dir = L.option(args, "packs", path.join(__dirname, "..", "packs")), cols = L.columns(L.option(args, "cols", ""));
  const rows = L.parseCsv(fs.readFileSync(csvPath, "utf8"));
  try { L.requireColumns(rows, cols, ["pid", "code", "kind", "milestone", "detail"]); } catch (e) { console.error("log: " + e.message); process.exit(2); }
  const lines = L.timelines(rows, cols), events = outcomes(lines);
  const packs = {}, files = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (C.validPack(p)) { packs[p.code] = p; files[p.code] = path.join(dir, f); }
  }
  const res = analyse(events, packs, { final: args.includes("--final") });
  const meta = { rows: rows.length, students: new Set(events.map((x) => x.code + "/" + x.pid)).size, opened: events.length, when: new Date().toISOString().slice(0, 10), final: args.includes("--final") };
  const body = args.includes("--json") ? JSON.stringify({ meta, ...res }, null, 1) + "\n" : markdown(res, meta);
  const out = L.option(args, "out", null);
  if (out) fs.writeFileSync(out, body); else process.stdout.write(body);
  if (args.includes("--apply")) {
    const changed = apply(res, packs, files, args.includes("--write"));
    console.error(changed.length ? (args.includes("--write") ? "packs updated: " : "would update (add --write): ") + changed.join(", ") : "no experiment has a winner yet");
  }
}

module.exports = { outcomes, analyse, markdown, apply, novelty };

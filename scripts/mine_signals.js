// Learn which words point to which stuck point, from the activity log, and write them into the project files.
//   node scripts/mine_signals.js <log.csv> [--write] [--min-students 3] [--top 40] [--followed 0.5] [--cols pid=Participant,kind=Kind,...]
// <log.csv> is the Google Form's response export. Columns default to pid, code, kind, milestone, detail, at, seq
// (use --cols to map them to the Form's question titles). Without --write it only reports.
//
// Labels: an "attempt" row followed by a "hint" row in the same milestone, with no other attempt in between, means
// "after writing this, the student chose this stuck point". Each attempt is counted once.
// Feedback loop: the site marks a suggested stuck point, and some students simply take it. Learning from those choices
// at full weight would teach the model its own guesses, right or wrong. An example where the student chose the shown
// suggestion counts --followed (default 0.5); one where no suggestion was shown, or the student chose another stuck
// point, counts 1. Accuracy is also reported on attempts with no suggestion shown, the only unbiased check.
// Privacy: only 2-3 character fragments go into the pack, never sentences, and only fragments that at least
// --min-students different students wrote for that stuck point. Fragments made of digits only are dropped.
// Report: leave-one-student-out accuracy of the suggestion with labels only vs labels + mined signals.
const fs = require("fs"), path = require("path");
const C = require("../core.js");

const L = require("./lib/log.js");

const args = process.argv.slice(2);
const csvPath = L.positional(args);
if (!csvPath) { console.error("usage: node scripts/mine_signals.js <log.csv> [--write] [--min-students 3] [--top 40] [--cols ...] [--packs dir]"); process.exit(2); }
const WRITE = args.includes("--write"), MIN_STUDENTS = +L.option(args, "min-students", 3), TOP = +L.option(args, "top", 40);
const FOLLOWED = +L.option(args, "followed", 0.5);
const PACKS = L.option(args, "packs", path.join(__dirname, "..", "packs"));
const cols = L.columns(L.option(args, "cols", ""));

// ---------- labelled examples ----------
// An attempt followed by a hint in the same milestone, with no other attempt in between: "after writing this, the
// student chose this stuck point". Each attempt is counted once.
function examples(rows) {
  const out = [];
  L.timelines(rows, cols).forEach((list) => {
    const last = {};
    list.forEach((e) => {
      if (e.kind === "attempt") last[e.m] = e.detail;
      else if (e.kind === "hint" && last[e.m] && e.data && Number.isInteger(e.data.stuck)) {
        const rec = Number.isInteger(e.data.rec) ? e.data.rec : -1;  // suggestion shown before this hint (-1: none)
        out.push({ code: e.code, pid: e.pid, m: e.m, s: e.data.stuck, text: last[e.m], rec, w: rec === e.data.stuck ? FOLLOWED : 1 });
        last[e.m] = null;
      }
    });
  });
  return out;
}

// ---------- signals: log-odds of a fragment for one stuck point against the others of the milestone ----------
function learn(milestone, exs) {
  const n = milestone.stuck.length, docs = [], pids = [], total = new Array(n).fill(0);
  for (let s = 0; s < n; s++) { docs.push({}); pids.push({}); }
  exs.forEach((e) => {
    if (e.s < 0 || e.s >= n) return;
    const w = e.w === undefined ? 1 : e.w;
    total[e.s] += w;
    Object.keys(C.grams(e.text)).forEach((g) => {
      docs[e.s][g] = (docs[e.s][g] || 0) + w;
      (pids[e.s][g] || (pids[e.s][g] = new Set())).add(e.pid);
    });
  });
  const all = total.reduce((a, b) => a + b, 0);
  return milestone.stuck.map((_, s) => {
    const cand = [];
    Object.keys(docs[s]).forEach((g) => {
      if (pids[s][g].size < MIN_STUDENTS) return;
      let other = 0; for (let t = 0; t < n; t++) if (t !== s) other += docs[t][g] || 0;
      const ps = (docs[s][g] + 0.5) / (total[s] + 1), po = (other + 0.5) / (all - total[s] + 1);
      const w = Math.log(ps / po);
      if (w > 0) cand.push([g, w * Math.log(1 + docs[s][g])]);
    });
    cand.sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(cand.slice(0, TOP).map(([g, w]) => [g, Math.round(w * 100) / 100]));
  });
}

function withSignals(milestone, sig) {
  return { ...milestone, stuck: milestone.stuck.map((s, k) => ({ ...s, signals: sig ? sig[k] : undefined })) };
}

// ---------- run ----------
const rows = L.parseCsv(fs.readFileSync(csvPath, "utf8"));
try { L.requireColumns(rows, cols, ["pid", "code", "kind", "milestone", "detail"]); } catch (e) { console.error("log: " + e.message); process.exit(2); }
const exs = examples(rows);
const codes = [...new Set(exs.map((e) => e.code))];
console.log(`${rows.length} log rows, ${exs.length} labelled attempts, ${new Set(exs.map((e) => e.pid)).size} students, projects: ${codes.join(", ") || "none"}`);
let bad = 0;
for (const code of codes) {
  const f = path.join(PACKS, code + ".json");
  if (!fs.existsSync(f)) { console.log(`  ${code}: no pack file, skipped`); continue; }
  const pack = JSON.parse(fs.readFileSync(f, "utf8"));
  const read = C.attachHints(JSON.parse(fs.readFileSync(f, "utf8")));  // hints feed the matcher; never written back
  pack.milestones.forEach((m, i) => {
    const mex = exs.filter((e) => e.code === code && e.m === i);
    if (!mex.length) return;
    // Leave-one-student-out: learn from everyone else, suggest for this student's attempts.
    let base = 0, mined = 0, baseShown = 0, minedShown = 0, free = 0, freeBase = 0, freeMined = 0;
    const plain = withSignals(m, null), hints = read.milestones[i]._hints;
    const withHints = (ms) => Object.defineProperty(ms, "_hints", { value: hints, enumerable: false });
    withHints(plain);
    for (const pid of new Set(mex.map((e) => e.pid))) {
      const trained = withHints(withSignals(m, learn(m, mex.filter((e) => e.pid !== pid))));
      mex.filter((e) => e.pid === pid).forEach((e) => {
        const a = C.recommend(plain, e.text), b = C.recommend(trained, e.text);
        if (a >= 0) { baseShown++; if (a === e.s) base++; }
        if (b >= 0) { minedShown++; if (b === e.s) mined++; }
        if (e.rec < 0) { free++; if (C.rankStuck(plain, e.text)[0].s === e.s) freeBase++; if (C.rankStuck(trained, e.text)[0].s === e.s) freeMined++; }
      });
    }
    const pct = (x, y) => (y ? Math.round((100 * x) / y) + "%" : "-");
    const followed = mex.filter((e) => e.rec >= 0 && e.rec === e.s).length;
    console.log(`  ${code} M${i + 1}: ${mex.length} attempts (${followed} took the suggestion) | labels only: right ${pct(base, baseShown)} of ${baseShown} shown | with signals: right ${pct(mined, minedShown)} of ${minedShown} shown` +
      (free ? ` | no suggestion shown (${free}): top guess right ${pct(freeBase, free)} -> ${pct(freeMined, free)}` : ""));
    const sig = learn(m, mex);
    m.stuck.forEach((s, k) => { if (Object.keys(sig[k]).length) s.signals = sig[k]; else delete s.signals; });
  });
  if (!C.validPack(pack)) { console.error(`  ${code}: the pack would become invalid, not written`); bad++; continue; }
  if (WRITE) { fs.writeFileSync(f, JSON.stringify(pack)); console.log(`  ${code}: signals written to ${path.relative(process.cwd(), f)}`); }
}
if (!WRITE) console.log("report only; add --write to update the packs");
process.exit(bad ? 1 : 0);

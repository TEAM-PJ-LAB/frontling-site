// End-to-end check of the static site in a simulated browser: NODE_PATH=<dir with jsdom> node site/test/dom.smoke.js
// Exits non-zero on the first failed expectation.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const SITE = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8").replace(/<script[^>]*>[\s\S]*?<\/script>/g, "");
const sent = [], packFetches = [];
let inFlight = 0, maxInFlight = 0, failPosts = false;
const dom = new JSDOM(html, { url: "https://example.org/site/#demo", runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
w.fetch = (url, opt) => {
  if (String(url).startsWith("packs/")) {
    packFetches.push(String(url));
    const f = path.join(SITE, url.split("?")[0]);
    return Promise.resolve(fs.existsSync(f) ? { ok: true, json: () => Promise.resolve(JSON.parse(fs.readFileSync(f, "utf8"))) } : { ok: false, status: 404 });
  }
  if (failPosts) return Promise.reject(new TypeError("offline"));
  sent.push(Object.fromEntries(new w.URLSearchParams(opt.body)));
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  return new Promise(r => setTimeout(() => { inFlight--; r({}); }, 50));  // slower than tick(): actions overlap an in-flight POST
};
for (const f of ["config.js", "i18n.js", "core.js"]) w.eval(fs.readFileSync(path.join(SITE, f), "utf8"));
w.R2C_CONFIG.log = { action: "https://docs.google.com/forms/d/e/X/formResponse", fields: { pid: "entry.1", code: "entry.2", kind: "entry.3", milestone: "entry.4", detail: "entry.5", at: "entry.6", seq: "entry.7" } };
w.R2C_CONFIG.preTest = "https://forms.gle/pre?pid={pid}";
w.eval(fs.readFileSync(path.join(SITE, "app.js"), "utf8"));
const d = w.document, tick = () => new Promise(r => setTimeout(r, 30));
const text = () => d.getElementById("app").textContent, flash = () => d.getElementById("flash").textContent;
const submit = (form) => form.dispatchEvent(new w.Event("submit", { cancelable: true }));
const assert = require("node:assert/strict");
let C2;
const check = (name, ok) => { assert.ok(ok, name); console.log("ok", name); };
(async () => {
  await tick();
  check("join screen", text().includes("참여 번호"));
  let f = d.querySelector("form"); f.elements.pid.value = "P07"; submit(f); await tick();
  check("consent required", flash().includes("동의"));
  f = d.querySelector("form"); f.elements.pid.value = "P07"; f.elements.consent.checked = true; submit(f); await tick();
  check("main screen", text().includes("M1") && text().includes("어디서 막혔나요"));
  check("pre-test link with pid", !!d.querySelector('a[href*="pid=P07"]'));
  d.querySelector("button[type=button]").click(); await tick();
  check("hint needs attempt", flash().includes("새 시도"));
  f = d.querySelector("form.composer"); f.elements.body.value = "짧아요"; submit(f); await tick();
  check("short attempt refused", flash().includes("구체적"));
  f = d.querySelector("form.composer"); f.elements.body.value = "데이터를 불러와서 결측값을 확인했는데 평균으로 채워야 할지 모르겠어요."; submit(f); await tick();
  check("attempt saved", flash() === "저장했어요.");
  // Unsent input must survive every re-render (opening a hint, the log finishing, the hint timer).
  d.getElementById("body").value = "쓰던 초안"; d.getElementById("work").value = "draft-link";
  const guide = [...d.querySelectorAll("details")].find(x => x.querySelector("dl")); guide.open = true;
  const quizPick = d.querySelector("input[name=q1][value='2']"); quizPick.checked = true;
  d.getElementById("body").focus();
  d.querySelector("button[type=button]").click(); await tick();
  check("opening a hint is announced", flash().includes("힌트를 열었어요"));
  check("level-1 hint shown", text().includes("예측하려는 값은 어느 열에") && d.querySelector(".entry-hint .chip").textContent === "1/3");
  const kept = () => d.getElementById("body").value === "쓰던 초안" && d.getElementById("work").value === "draft-link" &&
    [...d.querySelectorAll("details")].find(x => x.querySelector("dl")).open && d.querySelector("input[name=q1][value='2']").checked;
  check("drafts, open guide and quiz picks survive a re-render", kept());
  check("focus stays on the hint button that was clicked", d.activeElement === d.getElementById("hint-btn-0-0"));
  d.getElementById("body").focus(); w.dispatchEvent(new w.Event("online")); await tick();
  check("focus stays in the box being typed in", d.activeElement === d.getElementById("body"));
  await tick(); await tick(); await tick();
  check("drafts survive the activity log finishing", kept() && d.activeElement === d.getElementById("body"));
  d.getElementById("body").value = "";
  f = d.querySelector("form.submit-box"); f.elements.work.value = "모든 게 싫어서 죽고 싶어요"; submit(f); await tick();
  check("distress text in a submission is stopped and not kept", flash().includes("걱정되는") && d.getElementById("work").value === "" &&
    !JSON.parse(w.localStorage.getItem("r2c:demo")).ms[0].submitted);
  f = d.querySelector("form.submit-box"); f.elements.work.value = "https://drive.example/x"; submit(f); await tick();
  check("submit opens M2", flash().includes("제출했어요") && d.querySelector(".is-now .trail-step").textContent.trim().startsWith("M2"));
  check("the next milestone starts with empty boxes", d.getElementById("work").value === "" && d.getElementById("body").value === "");
  const qf = [...d.querySelectorAll("form")].find(x => x.querySelector(".quiz-q"));
  qf.querySelectorAll("input[value='0']").forEach(i => i.checked = true); submit(qf); await tick();
  check("quiz graded", /4문제 중 \d문제/.test(text()));
  for (let k = 0; k < 12; k++) await tick();
  check("activity log sent once each, in order", sent.map(s => s["entry.3"]).join(",") === "attempt,hint,flag,submit,quiz" && sent.every(s => s["entry.1"] === "P07" && s["entry.2"] === "demo"));
  const seqs = sent.map(s => s["entry.7"]), sid = seqs[0].split(":")[0];
  check("each entry carries sid:seq with no gaps", seqs.every((x, k) => x === sid + ":" + (k + 1)));
  // Another tab of the same project saves an attempt: this tab shows it and does not post that tab's entry twice.
  const other = JSON.parse(w.localStorage.getItem("r2c:demo"));
  C2 = w.R2CCore; C2.addAttempt(other, 1, "다른 탭에서 저장한 시도예요. 기준 모델 학습 코드를 돌려 봤는데 결과가 달라요.", Date.now(), { min_attempt_chars: 30, hint_min_interval_s: 60 });
  other.outbox = [];  // that tab already sent its own entry
  w.localStorage.setItem("r2c:demo", JSON.stringify(other));
  w.dispatchEvent(new w.StorageEvent("storage", { key: "r2c:demo" })); await tick();
  check("progress saved in another tab shows up here", text().includes("내 시도 (1)"));
  const nSent = sent.length;
  f = d.querySelector("form.composer"); f.elements.body.value = "이 탭에서 하나 더 해 봤어요. 학습률을 낮춰서 다시 돌렸는데도 차이가 나요."; submit(f);
  for (let k = 0; k < 6; k++) await tick();
  check("an action here keeps the other tab's attempt and posts only its own entry",
    JSON.parse(w.localStorage.getItem("r2c:demo")).ms[1].attempts.length === 2 && sent.length === nSent + 1 && sent[nSent]["entry.3"] === "attempt");
  // A long offline stretch: rows pile up, nothing is lost while sending fails, then they go out a few at a time.
  failPosts = true;
  for (let k = 0; k < 10; k++) {
    f = d.querySelector("form.composer"); f.elements.body.value = "오프라인에서 저장한 시도 " + k + "번째예요. 데이터를 다시 불러와 봤어요."; submit(f); await tick();
  }
  check("rows stay queued while sending fails", JSON.parse(w.localStorage.getItem("r2c:demo")).outbox.length === 10);
  failPosts = false; maxInFlight = 0; const n0 = sent.length;
  w.dispatchEvent(new w.Event("online"));
  for (let k = 0; k < 20; k++) await tick();
  const batch = sent.slice(n0).map(s => Number(s["entry.7"].split(":")[1]));
  check("queued rows are sent in parallel, a few at a time, in order, once each",
    batch.length === 10 && maxInFlight > 1 && maxInFlight <= 4 && batch.every((x, k) => k === 0 || x === batch[k - 1] + 1));
  const saved = JSON.parse(w.localStorage.getItem("r2c:demo"));
  check("progress stored, outbox drained", saved.outbox.length === 0 && saved.ms[0].attempts.length === 1 && saved.ms[1].attempts.length === 12);
  w.location.hash = "#nope"; await tick(); await tick();
  check("unknown code shows an error", text().includes("찾지 못했어요") || text().includes("couldn't find"));
  // The project file that index.html started downloading is used once, without a second request.
  const ecg = JSON.parse(fs.readFileSync(path.join(SITE, "packs/ecg.json"), "utf8"));
  w.R2C_PACK = { code: "ecg", p: Promise.resolve({ ok: true, json: () => Promise.resolve(ecg) }) };
  const before = packFetches.length;
  w.location.hash = "#ecg"; await tick(); await tick();
  check("early download is used", text().includes(ecg.project.title) && packFetches.length === before && w.R2C_PACK === null);
  w.location.hash = "#demo"; await tick(); await tick();
  check("later links fetch normally", packFetches.length === before + 1 && text().includes("M2"));
  w.location.hash = "#%"; await tick(); await tick();
  check("a malformed link asks for the code instead of breaking", !!d.getElementById("code") && !text().includes("찾지 못했어요"));
})().catch((e) => { console.error(e.message); process.exit(1); });

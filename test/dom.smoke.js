// End-to-end check of the static site in a simulated browser: NODE_PATH=<dir with jsdom> node site/test/dom.smoke.js
// Exits non-zero on the first failed expectation.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path");
const SITE = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8").replace(/<script src="[^"]+"><\/script>/g, "");
const sent = [];
const dom = new JSDOM(html, { url: "https://example.org/site/#demo", runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
w.fetch = (url, opt) => {
  if (String(url).startsWith("packs/")) {
    const f = path.join(SITE, url.split("?")[0]);
    return Promise.resolve(fs.existsSync(f) ? { ok: true, json: () => Promise.resolve(JSON.parse(fs.readFileSync(f, "utf8"))) } : { ok: false, status: 404 });
  }
  sent.push(Object.fromEntries(new w.URLSearchParams(opt.body)));
  return new Promise(r => setTimeout(() => r({}), 50));  // slower than tick(): actions overlap an in-flight POST
};
for (const f of ["config.js", "i18n.js", "core.js"]) w.eval(fs.readFileSync(path.join(SITE, f), "utf8"));
w.R2C_CONFIG.log = { action: "https://docs.google.com/forms/d/e/X/formResponse", fields: { pid: "entry.1", code: "entry.2", kind: "entry.3", milestone: "entry.4", detail: "entry.5", at: "entry.6" } };
w.R2C_CONFIG.preTest = "https://forms.gle/pre?pid={pid}";
w.eval(fs.readFileSync(path.join(SITE, "app.js"), "utf8"));
const d = w.document, tick = () => new Promise(r => setTimeout(r, 30));
const text = () => d.getElementById("app").textContent, flash = () => d.getElementById("flash").textContent;
const submit = (form) => form.dispatchEvent(new w.Event("submit", { cancelable: true }));
const assert = require("node:assert/strict");
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
  check("level-1 hint shown", text().includes("예측하려는 값은 어느 열에") && d.querySelector(".entry-hint .chip").textContent === "1/3");
  const kept = () => d.getElementById("body").value === "쓰던 초안" && d.getElementById("work").value === "draft-link" &&
    [...d.querySelectorAll("details")].find(x => x.querySelector("dl")).open && d.querySelector("input[name=q1][value='2']").checked;
  check("drafts, open guide and quiz picks survive a re-render", kept());
  check("focus stays in the box being typed in", d.activeElement === d.getElementById("body"));
  await tick(); await tick(); await tick();
  check("drafts survive the activity log finishing", kept() && d.activeElement === d.getElementById("body"));
  d.getElementById("body").value = "";
  f = d.querySelector("form.submit-box"); f.elements.work.value = "https://drive.example/x"; submit(f); await tick();
  check("submit opens M2", flash().includes("제출했어요") && d.querySelector(".is-now .trail-step").textContent.trim().startsWith("M2"));
  check("the next milestone starts with empty boxes", d.getElementById("work").value === "" && d.getElementById("body").value === "");
  const qf = [...d.querySelectorAll("form")].find(x => x.querySelector(".quiz-q"));
  qf.querySelectorAll("input[value='0']").forEach(i => i.checked = true); submit(qf); await tick();
  check("quiz graded", /4문제 중 \d문제/.test(text()));
  for (let k = 0; k < 12; k++) await tick();
  check("activity log sent once each, in order", sent.map(s => s["entry.3"]).join(",") === "attempt,hint,submit,quiz" && sent.every(s => s["entry.1"] === "P07" && s["entry.2"] === "demo"));
  const saved = JSON.parse(w.localStorage.getItem("r2c:demo"));
  check("progress stored, outbox drained", saved.outbox.length === 0 && saved.ms[0].attempts.length === 1);
  w.location.hash = "#nope"; await tick(); await tick();
  check("unknown code shows an error", text().includes("찾지 못했어요") || text().includes("couldn't find"));
})().catch((e) => { console.error(e.message); process.exit(1); });

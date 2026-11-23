// The built site (dist/, from scripts/build.js) works as one file: NODE_PATH=<dir with jsdom>/node_modules node test/dist.smoke.js
// Runs the page's own inline scripts, like a browser would, with the network replaced by local files.
const { JSDOM } = require("jsdom");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const assert = require("node:assert/strict");
const DIST = path.join(__dirname, "..", "dist");
const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
const check = (name, ok) => { assert.ok(ok, name); console.log("ok", name); };

const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check("two inline scripts (bootstrap, bundle), no external script or stylesheet", inline.length === 2 && !/<script[^>]+src=|<link rel="stylesheet"/.test(html));
check("every inline script is allowed by the CSP", inline.every((s) => html.includes("'sha256-" + crypto.createHash("sha256").update(s, "utf8").digest("base64") + "'")));
check("the CSP is otherwise unchanged", /script-src 'self' 'sha256-[^']+' 'sha256-[^']+'; connect-src 'self' https:\/\/docs\.google\.com;/.test(html) && !/unsafe-inline[^;]*;[^"]*script/.test(html.match(/script-src[^;]*/)[0]));
check("the worker has a build version", /"[0-9a-f]{12}"/.test(fs.readFileSync(path.join(DIST, "sw.js"), "utf8")));

const sent = [], packFetches = [];
const dom = new JSDOM(html, {
  url: "https://example.org/site/#demo", runScripts: "dangerously", pretendToBeVisual: true,
  beforeParse(w) {
    w.fetch = (url, opt) => {
      if (String(url).startsWith("packs/")) {
        packFetches.push(String(url));
        const f = path.join(DIST, String(url));
        return Promise.resolve(fs.existsSync(f) ? { ok: true, json: () => Promise.resolve(JSON.parse(fs.readFileSync(f, "utf8"))) } : { ok: false, status: 404 });
      }
      sent.push(Object.fromEntries(new w.URLSearchParams(opt.body)));
      return Promise.resolve({});
    };
  },
});
const w = dom.window, d = w.document, tick = () => new Promise((r) => setTimeout(r, 30));
const text = () => d.getElementById("app").textContent, flash = () => d.getElementById("flash").textContent;
const submit = (form) => form.dispatchEvent(new w.Event("submit", { cancelable: true }));

(async () => {
  await tick();
  check("the early download is the only pack request", packFetches.length === 1 && packFetches[0] === "packs/demo.json");
  check("join screen", text().includes("참여 번호"));
  let f = d.querySelector("form"); f.elements.pid.value = "P01"; f.elements.consent.checked = true; submit(f); await tick();
  check("main screen", text().includes("M1"));
  f = d.querySelector("form.composer"); f.elements.body.value = "데이터를 불러와서 결측값을 확인했는데 평균으로 채워야 할지 모르겠어요."; submit(f); await tick();
  d.getElementById("hint-btn-0-0").click(); await tick();
  check("sealed hint opens and reads correctly", text().includes("예측하려는 값은 어느 열에"));
  await tick(); await tick();
  check("activity log goes to the configured form", sent.length >= 2 && sent[0]["entry.252289093"] === "P01");
  check("no suggestion when no stuck point is clearly closer (demo labels are all alike)", !d.querySelector(".chip-rec"));
  w.location.hash = "#ecg"; await tick(); await tick();
  f = d.querySelector("form"); f.elements.pid.value = "P01"; f.elements.consent.checked = true; submit(f); await tick();
  f = d.querySelector("form.composer"); f.elements.body.value = "The plot of lead II is just noise and I cannot see any heartbeats in it."; submit(f); await tick();
  const chip = d.querySelector(".chip-rec");
  check("the closest stuck point is marked as suggested", chip && chip.closest("article").id === "hint-card-0-2" && d.getElementById("rec-note"));
  d.getElementById("hint-btn-0-2").click(); await tick(); await tick();
  const hintRow = sent.filter((x) => x["entry.1875538486"] === "hint").pop();
  check("the hint log records what was suggested", JSON.parse(hintRow["entry.1184939382"]).rec === 2 && !d.querySelector(".chip-rec"));
  check("the newest hint asks whether it helped", !!d.getElementById("rate-up-0-2") && d.getElementById("rate-up-0-2").closest("[role=group]"));
  d.getElementById("rate-down-0-2").click(); await tick(); await tick();
  const rateRow = sent.filter((x) => x["entry.1875538486"] === "rate").pop();
  check("the answer is logged once and the question goes away, focus stays in the card",
    rateRow && JSON.parse(rateRow["entry.1184939382"]).up === false && !d.getElementById("rate-up-0-2") &&
    d.activeElement === d.getElementById("hint-card-0-2") && flash().includes("Thanks"));
  // New device: nothing saved, the join screen offers to load the file saved on the old one.
  const backupFile = w.localStorage.getItem("r2c:ecg");
  w.localStorage.removeItem("r2c:ecg"); w.location.hash = "#demo"; await tick(); w.location.hash = "#ecg"; await tick(); await tick();
  check("join screen offers restore", (text().includes("참여 번호") || text().includes("Participant number")) && !!d.getElementById("restore-btn"));
  const input = d.querySelector("input[type=file]");
  Object.defineProperty(input, "files", { value: [new w.File([backupFile], "frontling-ecg-P01.json", { type: "application/json" })] });
  input.dispatchEvent(new w.Event("change")); for (let k = 0; k < 4; k++) await tick();
  check("the saved file brings the progress back", !!d.getElementById("body") && flash().includes("back") &&
    JSON.parse(w.localStorage.getItem("r2c:ecg")).ms[0].attempts.length === 1);
  check("the logo is inlined", d.querySelector(".brand img").getAttribute("src").startsWith("data:image/svg+xml"));
  w.close();
})().catch((e) => { console.error(e.message); process.exit(1); });

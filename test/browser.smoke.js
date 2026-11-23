// The built site in real Chrome: CSP, accessibility (axe), layout at phone width, the offline worker and its kill switch.
//   CHROME_PATH=<chrome> NODE_PATH=<dir with puppeteer-core, axe-core, esbuild>/node_modules node test/browser.smoke.js
// Needs dist/ (scripts/build.js). Serves it locally with a delay on every request, like slow school Wi-Fi.
// Checks behaviour, not timings: CI machines are too uneven for millisecond limits.
const puppeteer = require("puppeteer-core");
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path"), { execFileSync } = require("child_process");
const assert = require("node:assert/strict");
const SRC = path.join(__dirname, ".."), axeSrc = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const check = (name, ok) => { assert.ok(ok, name); console.log("ok", name); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A copy of dist/ that the test can change (to play a reviewer's fix or a new deploy) behind a slow static server.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
fs.cpSync(path.join(SRC, "dist"), root, { recursive: true });
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
  const f = path.join(root, p);
  setTimeout(() => {
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream", "cache-control": "max-age=600" });
    res.end(fs.readFileSync(f));
  }, 150);
}).listen(0, "127.0.0.1");

(async () => {
  await new Promise((r) => server.once("listening", r));
  const base = `http://localhost:${server.address().port}/`;
  const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ["--no-sandbox"] });
  try {
    // ---------- page, CSP and accessibility ----------
    for (const scheme of ["light", "dark"]) {
      const ctx = await b.createBrowserContext(), p = await ctx.newPage(), errors = [];
      p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); }); p.on("pageerror", (e) => errors.push(String(e)));
      await p.setViewport({ width: 390, height: 844 }); await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await p.goto(base + "#ecg", { waitUntil: "networkidle0" });
      await p.type("#pid", "P01"); await p.click("input[name=consent]"); await p.click("form button"); await p.waitForSelector("#body");
      await p.type("#body", "The plot of lead II is just noise and I cannot see any heartbeats in it."); await p.click("form.composer button");
      await p.waitForSelector(".chip-rec"); await p.click("#hint-btn-0-2"); await p.waitForSelector("#rate-up-0-2");
      await p.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
      await p.evaluate(axeSrc);
      const r = await p.evaluate(() => axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] }));
      check(`${scheme}: no accessibility violations (${r.violations.map((v) => v.id).join(",") || "none"})`, r.violations.length === 0);
      check(`${scheme}: no console errors, so nothing was blocked by the CSP (${errors.join(" | ") || "none"})`, errors.length === 0);
      check(`${scheme}: nothing wider than a phone screen`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      check(`${scheme}: focus stays on the hint card after the last action`, await p.evaluate(() => /^hint-(btn|card)-0-2$/.test(document.activeElement.id)));
      await ctx.close();
    }

    // ---------- offline worker ----------
    const ctx = await b.createBrowserContext(), p = await ctx.newPage();
    const visit = async (needle) => { await p.goto("about:blank"); const res = await p.goto(base + "#demo");
      await p.waitForFunction((n) => n ? document.getElementById("app").textContent.includes(n) : !!document.querySelector("#pid, #body"), { timeout: 15000 }, needle);
      return res; };
    const title = JSON.parse(fs.readFileSync(path.join(root, "packs/demo.json"), "utf8")).project.title;
    await visit(title);
    await p.evaluate(() => navigator.serviceWorker.ready); await wait(1500);
    check("repeat visit: the page comes from the worker", (await visit(title)).fromServiceWorker());
    await p.setOfflineMode(true);
    check("offline visit still opens the project", (await visit(title)).fromServiceWorker());
    await p.setOfflineMode(false);
    const pk = JSON.parse(fs.readFileSync(path.join(root, "packs/demo.json"), "utf8")); pk.project.title = "검토자가 고친 제목";
    fs.writeFileSync(path.join(root, "packs/demo.json"), JSON.stringify(pk));
    // Wait for a usable page, not the old title: the fix can replace it before the test gets to look.
    await visit(null);
    await p.waitForFunction(() => document.getElementById("app").textContent.includes("검토자가 고친 제목"), { timeout: 10000 });
    check("a fixed project file replaces the saved one without a reload", true);
    fs.writeFileSync(path.join(root, "index.html"), fs.readFileSync(path.join(root, "index.html"), "utf8").replace("<span>Frontling</span>", "<span>Frontling next</span>"));
    fs.writeFileSync(path.join(root, "sw.js"), fs.readFileSync(path.join(root, "sw.js"), "utf8").replace(/"[0-9a-f]{12}"/, '"0000000000ab"'));
    await visit("검토자가 고친 제목"); await wait(2500); await visit("검토자가 고친 제목");
    check("a new deploy is used from the next visit", (await p.evaluate(() => document.querySelector(".brand").textContent)) === "Frontling next");

    // ---------- kill switch: offline: false in config.js, built and deployed over the running site ----------
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kill-"));
    for (const f of fs.readdirSync(SRC)) if (!["dist", ".git", "node_modules", ".aura", ".vscode"].includes(f)) fs.cpSync(path.join(SRC, f), path.join(tmp, f), { recursive: true });
    fs.writeFileSync(path.join(tmp, "config.js"), fs.readFileSync(path.join(tmp, "config.js"), "utf8").replace("offline: true", "offline: false"));
    const out = execFileSync("node", [path.join(tmp, "scripts", "build.js")], { encoding: "utf8", env: process.env });
    check("the build ships the kill switch", /KILL SWITCH/.test(out));
    fs.cpSync(path.join(tmp, "dist"), root, { recursive: true });
    // (the kill build also brought back the original project file, so only wait for a usable page here)
    await visit(null); await wait(3000); await visit(null); await wait(500);
    const state = await p.evaluate(async () => ({ regs: (await navigator.serviceWorker.getRegistrations()).length,
      caches: (await caches.keys()).filter((k) => k.indexOf("frontling-") === 0).length, controlled: !!navigator.serviceWorker.controller }));
    check(`after the kill switch: no worker, no caches, page from the network (${JSON.stringify(state)})`, state.regs === 0 && state.caches === 0 && !state.controlled);
    check("the site still works without it", (await p.evaluate(() => !!document.getElementById("body") || !!document.getElementById("pid"))));
    await ctx.close();
  } finally {
    await b.close(); server.close();
  }
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });

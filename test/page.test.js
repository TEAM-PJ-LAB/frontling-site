// node --test site/test/*.test.js  — index.html loading contract: parallel scripts, pinned inline bootstrap.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const SITE = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
const app = fs.readFileSync(path.join(SITE, "app.js"), "utf8");

test("the inline bootstrap matches the hash pinned in the CSP", () => {
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(inline.length, 1);
  const want = "sha256-" + crypto.createHash("sha256").update(inline[0], "utf8").digest("base64");
  assert.ok(html.includes("script-src 'self' '" + want + "'"), "update the CSP hash in index.html to '" + want + "'");
  assert.ok(!/script-src[^;"]*unsafe-inline/.test(html));
});

test("scripts load in parallel and run in order", () => {
  const tags = [...html.matchAll(/<script([^>]*)src="([^"]+)"[^>]*><\/script>/g)];
  assert.deepEqual(tags.map(m => m[2]), ["config.js", "i18n.js", "core.js", "app.js"]);
  assert.ok(tags.every(m => /\bdefer\b/.test(m[0])), "a script without defer blocks the parser and loads one at a time");
});

test("the bootstrap and app.js agree on what a project code is and how the file is fetched", () => {
  const rule = "/^[a-z0-9-]{3,40}$/";
  const opts = '{ cache: "no-cache" }';
  assert.ok(html.includes(rule) && app.includes(rule));
  assert.ok(html.includes('{cache:"no-cache"}') && app.includes(opts));
});

test("published packs are sealed, so hints and answers can't be read from the file", () => {
  const dir = path.join(SITE, "packs");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.equal(p.sealed, 1, f + " is not sealed: run node scripts/seal_packs.js");
  }
});

test("the offline cache lists every file index.html loads", () => {
  const sw = fs.readFileSync(path.join(SITE, "sw.js"), "utf8");
  const loaded = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m => m[1]).filter(u => !/^https?:/.test(u));
  for (const u of loaded) assert.ok(sw.includes('"' + u.replace(/^\.\//, "") + '"') || u === "./", u + " missing from SHELL in sw.js");
});

test("the AI note in index.html matches the Korean string, so nothing shifts when the scripts run", () => {
  global.window = {}; require("../i18n.js");
  const ko = global.window.R2C_I18N.ko;
  assert.ok(html.includes('aria-label="' + ko.note_label + '">' + ko.brand_note + "</aside>"));
});

test("the privacy page is complete before the join screen links to it, and has no scripts", () => {
  const page = fs.readFileSync(path.join(SITE, "privacy.html"), "utf8");
  assert.ok(!/<script/i.test(page) && /default-src 'none'/.test(page), "static page, nothing runs");
  const cfg = fs.readFileSync(path.join(SITE, "config.js"), "utf8").match(/privacy:\s*"([^"]*)"/)[1];
  const blanks = page.match(/［[^］]*］/g) || [];
  if (cfg) assert.deepEqual(blanks, [], "fill these in privacy.html before setting config.js privacy: " + blanks.join(", "));
  if (cfg) assert.ok(/^https:\/\/.+\/privacy\.html$/.test(cfg), "config.js privacy points at the published privacy.html");
});

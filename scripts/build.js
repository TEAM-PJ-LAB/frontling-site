// Build the deployable site into dist/: one HTML file with the CSS and all scripts inlined and minified, the logo as a
// data URI, the offline worker with a content-hash version, and the (sealed) project files.
//   NODE_PATH=<dir with esbuild>/node_modules node scripts/build.js
// First visit: the HTML and the project file are the only two requests, and they start in parallel.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const esbuild = require("esbuild");
const C = require("../core.js");

const SRC = path.join(__dirname, ".."), OUT = path.join(SRC, "dist");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("base64");
const fail = (msg) => { console.error("build: " + msg); process.exit(1); };

let html = read("index.html");

// 1. Scripts: the same files, in the same order, as one script at the end of <body> (what defer did).
const srcs = [...html.matchAll(/<script defer src="([^"]+)"><\/script>\n?/g)];
if (srcs.map((m) => m[1]).join() !== "config.js,i18n.js,core.js,app.js") fail("unexpected script tags in index.html");
const js = esbuild.transformSync(srcs.map((m) => read(m[1])).join(";\n"), { loader: "js", minify: true, target: "es2017", legalComments: "none" }).code.trim();
if (js.includes("</script")) fail("bundle contains </script");
for (const m of srcs) html = html.replace(m[0], "");

// 2. Styles: app.css and the small inline block, minified into one <style> in <head> (no render-blocking request).
const inlineStyle = html.match(/<style>([\s\S]*?)<\/style>\n?/);
const cssIn = read("app.css") + "\n" + (inlineStyle ? inlineStyle[1] : "");
const css = esbuild.transformSync(cssIn, { loader: "css", minify: true, target: ["chrome90", "safari14", "firefox90"] }).code.trim();
if (inlineStyle) html = html.replace(inlineStyle[0], "");
html = html.replace(/<link rel="stylesheet" href="app.css">\n?/, "<style>" + css + "</style>\n");

// 3. Logo as a data URI (img and favicon): one request fewer.
const logo = "data:image/svg+xml;base64," + Buffer.from(read("logo.svg").trim()).toString("base64");
html = html.split('"logo.svg"').join('"' + logo + '"');

// 4. Comments out, bundle in, bundle hash added to the CSP next to the bootstrap's.
html = html.replace(/<!--[\s\S]*?-->\n?/g, "");
html = html.replace("</body>", "<script>" + js + "</script>\n</body>");
const bundleHash = "'sha256-" + sha256(js) + "'";
const csp = html.match(/script-src 'self' ('sha256-[^']+')/);
if (!csp) fail("CSP script-src with the bootstrap hash not found");
html = html.replace(csp[0], csp[0] + " " + bundleHash);
html = html.replace(/\n\s+/g, "\n");

// Every inline script must be covered by a hash in the CSP, or the browser refuses to run it.
for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g))
  if (!html.includes("'sha256-" + sha256(m[1]) + "'")) fail("an inline script is missing from the CSP");
if (/(src|href)="(?!data:|https?:|#|\.\/)[^"]+"/.test(html)) fail("index.html still references a local file: " + html.match(/(src|href)="(?!data:|https?:|#|\.\/)[^"]+"/)[0]);

// 5. Offline worker: versioned by the page content, so every deploy replaces the cached page.
//    With offline: false in config.js the worker is a kill switch instead: it clears the caches, unregisters itself and
//    reloads open pages, which then come from the network (browsers check for a new sw.js on every visit).
const cfg = {}; require("vm").runInNewContext(read("config.js"), { window: cfg });
const OFFLINE = cfg.R2C_CONFIG.offline !== false;
const KILL = `self.addEventListener("install",function(){self.skipWaiting()});
self.addEventListener("activate",function(e){e.waitUntil(caches.keys().then(function(k){return Promise.all(k.filter(function(n){return n.indexOf("frontling-")===0}).map(function(n){return caches.delete(n)}))}).then(function(){return self.registration.unregister()}).then(function(){return self.clients.matchAll({type:"window"})}).then(function(c){c.forEach(function(w){w.navigate(w.url)})}))});`;
const version = crypto.createHash("sha256").update(html).digest("hex").slice(0, 12);
let sw = OFFLINE ? read("sw.js") : KILL + "\n// kill switch " + version + "\n";
if (OFFLINE) sw = sw
  .replace(/var VERSION = "dev";/, 'var VERSION = "' + version + '";')
  .replace(/var SHELL = \[[^\]]*\];/, 'var SHELL = ["./", "index.html"];');
if (!sw.includes(version)) fail("could not set VERSION in sw.js");
if (OFFLINE) sw = esbuild.transformSync(sw, { loader: "js", minify: true, target: "es2017", legalComments: "none" }).code;

// 6. Write dist/.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "packs"), { recursive: true });
fs.writeFileSync(path.join(OUT, "index.html"), html);
fs.writeFileSync(path.join(OUT, "sw.js"), sw);
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
fs.copyFileSync(path.join(SRC, "logo.svg"), path.join(OUT, "logo.svg"));  // kept for links people may have saved
for (const f of fs.readdirSync(path.join(SRC, "packs")).filter((x) => x.endsWith(".json"))) {
  const p = JSON.parse(read("packs/" + f));
  if (!C.validPack(p) || p.sealed !== 1) fail("packs/" + f + " is invalid or not sealed");
  fs.writeFileSync(path.join(OUT, "packs", f), JSON.stringify(p));
}

const kb = (n) => (n / 1024).toFixed(1) + " KB";
const gz = (s) => require("zlib").gzipSync(s).length;
const before = ["index.html", "app.css", "config.js", "i18n.js", "core.js", "app.js", "logo.svg"].reduce((n, f) => n + Buffer.byteLength(read(f)), 0);
console.log(`dist/index.html ${kb(Buffer.byteLength(html))} (gzip ${kb(gz(html))}), was 7 files ${kb(before)}; sw ${OFFLINE ? version : "KILL SWITCH (offline: false)"}`);

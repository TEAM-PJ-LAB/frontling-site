/* Offline support and instant repeat visits.
   - Built site (scripts/build.js sets VERSION to a content hash): the page is served from the cache at once and the
     browser checks for a new sw.js in the background; a new deploy changes VERSION, so the next visit gets it.
   - Project files (packs/): the saved copy is shown at once and refreshed in the background (see packFetch).
   - Source checkout (VERSION "dev"): network first for everything, so edits show up on reload.
   Only same-origin GETs are handled: the activity log POST to Google Forms never passes through here. */
"use strict";
var VERSION = "dev";
var SHELL = ["./", "index.html", "app.css", "config.js", "i18n.js", "core.js", "app.js", "logo.svg"];
var CACHE = "frontling-" + VERSION;
var PACKS = "frontling-packs";  // not versioned: a new deploy keeps the saved project files

function abs(u) { return new URL(u, self.registration.scope).href; }

self.addEventListener("install", function (ev) {
  // cache: "reload" skips the HTTP cache (GitHub Pages keeps files for 10 minutes), so a new version saves new files.
  ev.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: "reload" }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (ev) {
  ev.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("frontling-") === 0 && k !== CACHE && k !== PACKS; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function store(req, res) {
  if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { return c.put(req, copy); }); }
  return res;
}

function networkFirst(req) {
  return fetch(req).then(function (res) { return store(req, res); }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) {
      return hit || (req.mode === "navigate" ? caches.match(abs("./")) : Response.error());
    });
  });
}

function cacheFirst(req, key) {
  return caches.match(key || req, { ignoreSearch: true }).then(function (hit) {
    return hit || networkFirst(req);
  });
}

// Saved copy at once, download in the background. When the download differs from what was shown, every open page is
// told ("pack-updated") and redraws with the new file, so a reviewer's fix reaches students within seconds.
function packFetch(ev) {
  var req = ev.request;
  // The saved response goes to the page; its text is read from a clone taken first (a body can be read only once).
  var saved = caches.match(req, { ignoreSearch: true }).then(function (hit) {
    return { res: hit, text: hit ? hit.clone().text() : Promise.resolve(null) };
  });
  var net = fetch(req).then(function (res) {
    if (!res.ok) return res;
    var forCache = res.clone(), forCompare = res.clone();
    return saved.then(function (old) {
      return Promise.all([old.text, forCompare.text()]).then(function (t) {
        return caches.open(PACKS).then(function (c) { return c.put(req, forCache); }).then(function () {
          if (t[0] !== null && t[0] !== t[1]) return self.clients.matchAll({ type: "window" }).then(function (cs) {
            cs.forEach(function (c) { c.postMessage({ type: "pack-updated", url: req.url }); });
          });
        });
      });
    }).then(function () { return res; });
  });
  ev.waitUntil(net.catch(function () { /* offline */ }));
  return saved.then(function (s) { return s.res || net; }).catch(function () { return Response.error(); });
}

self.addEventListener("fetch", function (ev) {
  var req = ev.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  var inShell = SHELL.some(function (u) { return abs(u) === url.origin + url.pathname; });
  if (url.pathname.indexOf("/packs/") >= 0) ev.respondWith(packFetch(ev));
  // Only the page itself is answered from the cache; any other address (logo.svg, sw.js...) goes to the network.
  else if (VERSION !== "dev" && inShell) ev.respondWith(cacheFirst(req, req.mode === "navigate" ? abs("./") : null));
  else ev.respondWith(networkFirst(req));
});

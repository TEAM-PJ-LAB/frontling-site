/* Frontling student site (static, no server). Loads packs/<code>.json, keeps progress in localStorage,
   and sends an activity log to a Google Form when one is configured (config.js). */
(function () {
  "use strict";
  var C = window.R2CCore, CFG = window.R2C_CONFIG || {}, I18N = window.R2C_I18N;
  var root = document.getElementById("app"), flashEl = document.getElementById("flash");
  var pack = null, st = null, lang = "ko", hintTimer = 0, shown = -1;

  function _(key, kw) {
    var s = (I18N[lang] && I18N[lang][key]) || I18N.ko[key] || key;
    Object.keys(kw || {}).forEach(function (k) { s = s.split("{" + k + "}").join(kw[k]); });
    return s;
  }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      (Array.isArray(c) ? c : [c]).forEach(function (x) {
        if (x === null || x === undefined || x === false) return;
        el.appendChild(typeof x === "string" ? document.createTextNode(x) : x);
      });
    }
    return el;
  }

  function safeUrl(u) { return /^https?:\/\//i.test(u || "") ? u : ""; }
  function flash(key) { flashEl.textContent = key ? _(key) : ""; flashEl.hidden = !key; if (key) flashEl.focus(); }

  // ---------- storage + activity log ----------
  function storeKey() { return "r2c:" + pack.code; }
  function save(s) { s = s || st; try { localStorage.setItem("r2c:" + s.code, JSON.stringify(s)); } catch (e) { /* private mode: in-memory only */ } }
  function load() {
    try { var s = JSON.parse(localStorage.getItem(storeKey()) || "null"); if (s && s.v === 1) return s; } catch (e) { /* ignore */ }
    return C.newState(pack.code);
  }

  function logReady() {
    var l = CFG.log || {}, f = l.fields || {};
    return !!(l.action && f.pid && f.kind);
  }

  // One sender at a time, oldest first. Entries logged while it runs are picked up by the same loop,
  // so nothing is posted twice and the screen is not rebuilt under the student when a POST returns.
  var sending = false;
  function flush() {
    if (sending || !logReady() || !st || !st.outbox.length || navigator.onLine === false) return;
    var l = CFG.log, f = l.fields, mine = st;
    sending = true;
    (function next() {
      var e = mine.outbox[0];
      if (!e || mine !== st) return Promise.resolve();  // another project was opened: its own flush takes over
      var body = new URLSearchParams();
      body.append(f.pid, mine.pid);
      if (f.code) body.append(f.code, mine.code);
      body.append(f.kind, e.kind);
      if (f.milestone) body.append(f.milestone, String(e.milestone + 1));
      if (f.detail) body.append(f.detail, e.detail);
      if (f.at) body.append(f.at, e.at);
      // Google Forms accepts a cross-origin POST; the response is opaque, so success is "no network error".
      return fetch(l.action, { method: "POST", mode: "no-cors", body: body, keepalive: true }).then(function () {
        var k = mine.outbox.indexOf(e);
        if (k >= 0) mine.outbox.splice(k, 1);
        save(mine);
        return next();
      });
    })().catch(function () { /* offline or blocked: retried on the next action */ }).then(function () {
      sending = false;
      var el = document.getElementById("sync");
      if (el && st) el.textContent = syncNote();
    });
  }

  function backup() {
    var blob = new Blob([JSON.stringify(st, null, 1)], { type: "application/json" });
    var a = h("a", { href: URL.createObjectURL(blob), download: "frontling-" + pack.code + "-" + (st.pid || "me") + ".json" });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function testLink(key) {
    var u = CFG[key];
    return u ? u.split("{pid}").join(encodeURIComponent(st.pid)).split("{code}").join(encodeURIComponent(pack.code)) : "";
  }

  // ---------- screens ----------
  function codeScreen(err) {
    root.replaceChildren(h("div", { class: "panel stack narrow-box" },
      h("h1", { text: _("code_h") }),
      err ? h("p", { class: "note note-warn", role: "alert", text: _("pack_error") }) : null,
      h("form", { class: "inline-form", onsubmit: function (ev) {
        ev.preventDefault();
        var v = ev.target.elements.code.value.trim().toLowerCase();
        if (v) location.hash = v;
      } },
        h("div", {}, h("label", { for: "code", text: _("code_label") }), h("input", { id: "code", name: "code", autocomplete: "off", required: true })),
        h("button", { text: _("code_btn") })),
      h("p", { class: "help", text: _("code_help") })));
  }

  function joinScreen() {
    root.replaceChildren(h("div", { class: "panel stack narrow-box" },
      h("h1", { text: pack.project.title }),
      h("h2", { class: "h-sm", text: _("join_h") }),
      h("form", { class: "stack", onsubmit: function (ev) {
        ev.preventDefault();
        var pid = ev.target.elements.pid.value.trim();
        if (!pid || !ev.target.elements.consent.checked) { flash("msg.join"); return; }
        st.pid = pid.slice(0, 40); st.consent = true; save(); flash(""); render();
      } },
        h("div", { class: "field" }, h("label", { for: "pid", text: _("pid_label") }),
          h("input", { id: "pid", name: "pid", autocomplete: "off", maxlength: "40", required: true }),
          h("p", { class: "help", text: _("pid_help") })),
        h("label", { class: "check-row" }, h("input", { type: "checkbox", name: "consent" }), " " + _("consent_label")),
        safeUrl(CFG.privacy) ? h("p", { class: "small" }, h("a", { href: CFG.privacy, target: "_blank", rel: "noopener noreferrer", text: _("privacy_link") })) : null,
        h("div", {}, h("button", { text: _("join_btn") })))));
  }

  function trail(n, cur) {
    return h("ol", { class: "trail", "aria-label": _("milestones") }, pack.milestones.map(function (m, i) {
      var cls = i < cur ? "is-done" : i === cur ? "is-now" : "is-next";
      return h("li", { class: "trail-node " + cls, "aria-current": i === cur ? "step" : null },
        h("span", { class: "trail-dot" }),
        h("span", { class: "trail-step" }, "M" + (i + 1), h("span", { class: "sr-only", text: i < cur ? " (" + _("done") + ")" : i === cur ? " (" + _("now") + ")" : "" })),
        h("span", { class: "trail-title", text: m.title }),
        h("span", { class: "trail-meta", text: m.deliverable + ", " + _("weeks", { n: m.weeks }) }));
    }));
  }

  function aside(cur) {
    var p = pack.paper, url = safeUrl(p.url);
    return h("aside", { class: "route" },
      h("p", { class: "paper-link" }, _("paper") + ": ", url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: p.title }) : p.title),
      h("h1", { text: pack.project.title }),
      h("dl", { class: "facts" }, h("dt", { text: _("question") }), h("dd", { text: pack.project.question }),
        h("dt", { text: _("hypothesis") }), h("dd", { text: pack.project.hypothesis })),
      trail(pack.milestones.length, cur));
  }

  function act(res, okKey) { flash(res.ok ? okKey : "msg." + res.reason); save(); render(); flush(); }

  function workPanel(i) {
    var m = pack.milestones[i], ms = C.ms(st, i), pol = pack.policy, now = Date.now();
    var shown = [];
    ms.reveals.forEach(function (r) { shown.push(r); });
    return h("section", { class: "panel stack", "aria-labelledby": "mh" },
      h("div", { class: "desk-head" }, h("span", { class: "m-mark", text: "M" + (i + 1) }), h("h2", { id: "mh", text: m.title })),
      h("p", { class: "muted" }, _("deliverable") + ": " + m.deliverable),
      h("form", { class: "composer stack", onsubmit: function (ev) {
        ev.preventDefault();
        var r = C.addAttempt(st, i, ev.target.elements.body.value, Date.now(), pol);
        if (r.ok || r.reason === "concern") ev.target.elements.body.value = "";
        act(r, "msg.saved");
      } },
        h("label", { for: "body", text: _("attempt_label") }),
        h("textarea", { id: "body", name: "body", rows: "4", required: true }),
        h("div", { class: "composer-row" }, h("p", { class: "help", text: _("attempt_help") }), h("button", { text: _("attempt_btn") }))),
      ms.attempts.length ? h("details", {}, h("summary", { text: _("attempts") + " (" + ms.attempts.length + ")" }),
        h("div", { class: "log" }, ms.attempts.slice().reverse().map(function (a) {
          return h("article", { class: "entry entry-attempt" }, h("header", {}, h("b", { text: _("attempts") }), h("time", { text: new Date(a.at).toLocaleString() })), a.body);
        }))) : null,
      h("h3", { class: "h-sm", text: _("stuck_h") }),
      h("p", { class: "help", text: _("stuck_help") }),
      h("div", { class: "stack" }, m.stuck.map(function (s, si) {
        var lv = C.level(st, i, si), can = C.canReveal(st, i, si, now, pol);
        return h("article", { class: "entry entry-hint" },
          h("header", {}, h("b", { text: s.label }), h("span", { class: "chip", text: lv + "/" + C.MAX_LEVEL })),
          s.hints.slice(0, lv).map(function (txt, k) {
            return h("div", { class: "stack" }, h("span", { class: "chip chip-lilac", text: _("level_" + (k + 1)) }), h("p", { class: "prose-pre", text: txt }));
          }),
          lv < C.MAX_LEVEL
            ? h("button", { class: "btn-quiet", type: "button", "aria-disabled": can.ok ? null : "true", onclick: function () {
                act(C.reveal(st, i, si, Date.now(), pol), "");
              }, text: _("open_hint", { level: _("level_" + (lv + 1)) }) })
            : h("p", { class: "help", text: _("all_open") }));
      })),
      h("form", { class: "submit-box", onsubmit: function (ev) {
        ev.preventDefault();
        act(C.submit(st, i, pack.milestones.length, ev.target.elements.work.value, Date.now()), "msg.submitted");
      } },
        h("label", { for: "work", text: _("submit_h", { n: i + 1 }) }),
        h("div", { class: "inline-form" }, h("input", { id: "work", name: "work", placeholder: _("submit_ph"), required: true }),
          h("button", { class: "btn-quiet", text: _("submit_btn") })),
        h("p", { class: "help", text: _("submit_help") })));
  }

  function quizPanel() {
    var qs = pack.quiz || [];
    if (!qs.length) return null;
    var last = st.quiz && st.quiz.last;
    return h("section", { class: "panel stack" },
      h("div", { class: "section-title" }, h("h2", { text: _("quiz_h") })),
      h("p", { class: "muted", text: _("quiz_intro") }),
      last ? h("p", { class: "num" }, h("b", { text: _("quiz_score", { correct: last.result.correct, total: last.result.total }) })) : null,
      last && last.result.weak.length ? h("p", { class: "small muted", text: _("quiz_weak") + ": " + last.result.weak.join(", ") }) : last ? h("p", { class: "small muted", text: _("quiz_ok") }) : null,
      h("form", { class: "stack", onsubmit: function (ev) {
        ev.preventDefault();
        var ans = {};
        qs.forEach(function (q, k) { var c = ev.target.querySelector("input[name=q" + k + "]:checked"); if (c) ans[k] = Number(c.value); });
        C.recordQuiz(st, C.grade(qs, ans), ans, Date.now());
        save(); render(); flush();
      } }, qs.map(function (q, k) {
        var mine = last && last.answers[k];
        return h("fieldset", { class: "quiz-q" }, h("legend", { text: (k + 1) + ". " + q.question }),
          q.options.map(function (o, oi) {
            return h("label", { class: "quiz-opt" }, h("input", { type: "radio", name: "q" + k, value: String(oi), checked: mine === oi }), " " + o);
          }),
          last ? h("p", { class: "help", text: _("answer") + ": " + q.options[q.answer] + (q.explanation ? " — " + q.explanation : "") }) : null);
      }), h("div", {}, h("button", { text: _("quiz_btn") }))));
  }

  function guidesPanel() {
    var gs = pack.guides || [];
    if (!gs.length) return null;
    return h("section", { class: "panel stack" }, h("div", { class: "section-title" }, h("h2", { text: _("guides_h") })),
      h("p", { class: "help", text: _("guide_note") }),
      gs.map(function (g) {
        return h("details", {}, h("summary", { text: g.concept }),
          h("dl", { class: "facts" },
            h("dt", { text: _("why") }), h("dd", { text: g.why }),
            h("dt", { text: _("summary") }), h("dd", { text: g.summary }),
            h("dt", { text: _("steps") }), h("dd", {}, h("ol", {}, (g.steps || []).map(function (x) { return h("li", { text: x }); }))),
            h("dt", { text: _("practice") }), h("dd", { text: g.practice }),
            h("dt", { text: _("keywords") }), h("dd", { text: (g.keywords || []).join(", ") })));
      }));
  }

  // The screen is rebuilt after every action. What the student has typed or opened but not sent must not be lost with it.
  function keep() {
    var k = { cur: shown, val: {}, radio: {}, open: {}, focus: null }, a = document.activeElement;
    root.querySelectorAll("textarea[id], input[id]").forEach(function (el) { k.val[el.id] = el.value; });
    root.querySelectorAll("input[type=radio]:checked").forEach(function (el) { k.radio[el.name] = el.value; });
    root.querySelectorAll("details[open] > summary").forEach(function (el) { k.open[el.textContent.replace(/ \(\d+\)$/, "")] = true; });
    if (a && a.id && root.contains(a)) k.focus = { id: a.id, start: a.selectionStart, end: a.selectionEnd };
    return k;
  }

  function restore(k, cur) {
    if (k.cur === cur) Object.keys(k.val).forEach(function (id) { var el = document.getElementById(id); if (el) el.value = k.val[id]; });
    Object.keys(k.radio).forEach(function (name) {
      root.querySelectorAll("input[type=radio]").forEach(function (el) { if (el.name === name) el.checked = el.value === k.radio[name]; });
    });
    root.querySelectorAll("details > summary").forEach(function (el) {
      if (k.open[el.textContent.replace(/ \(\d+\)$/, "")]) el.parentNode.open = true;
    });
    var f = k.focus && k.cur === cur && document.getElementById(k.focus.id);
    if (f) {
      f.focus({ preventScroll: true });
      try { f.setSelectionRange(k.focus.start, k.focus.end); } catch (e) { /* not a text field */ }
    }
  }

  // A hint button that is waiting out the minimum interval turns usable on its own, without a page action.
  function armHintTimer(cur) {
    clearTimeout(hintTimer); hintTimer = 0;
    if (cur >= pack.milestones.length) return;
    var m = C.ms(st, cur), lastR = m.reveals[m.reveals.length - 1];
    var wait = lastR ? lastR.at + pack.policy.hint_min_interval_s * 1000 - Date.now() : 0;
    if (wait > 0) hintTimer = setTimeout(render, wait + 50);
  }

  function syncNote() {
    return st.outbox.length && logReady() ? _("sync_pending", { n: st.outbox.length }) + " · " : "";
  }

  function mainScreen() {
    var n = pack.milestones.length, cur = C.current(st, n), kept = keep();
    var pre = testLink("preTest"), post = testLink("postTest");
    root.replaceChildren(h("div", { class: "workspace" }, aside(cur),
      h("div", { class: "stack-lg" },
        pre && cur === 0 ? h("p", { class: "note" }, h("a", { href: pre, target: "_blank", rel: "noopener noreferrer", text: _("pretest") })) : null,
        cur < n ? workPanel(cur) : h("section", { class: "panel stack" }, h("p", { class: "done-state", text: _("all_done") }),
          post ? h("p", {}, h("a", { class: "btn", href: post, target: "_blank", rel: "noopener noreferrer", text: _("posttest") })) : null),
        quizPanel(), guidesPanel(),
        h("p", { class: "small muted" }, h("span", { id: "sync", text: syncNote() }),
          h("a", { href: "#" + pack.code, onclick: function (ev) { ev.preventDefault(); backup(); }, text: _("backup") })))));
    restore(kept, cur);
    shown = cur;
    armHintTimer(cur);
  }

  function render() {
    clearTimeout(hintTimer); hintTimer = 0;
    if (!pack) { shown = -1; return codeScreen(false); }
    if (!st.pid || !st.consent) { shown = -1; return joinScreen(); }
    mainScreen();
  }

  function setLang(l) {
    lang = I18N[l] ? l : "ko";
    document.documentElement.lang = lang;
    document.getElementById("note").textContent = _("brand_note");
  }

  function open() {
    var code = decodeURIComponent(location.hash.slice(1)).trim().toLowerCase();
    pack = null; shown = -1; clearTimeout(hintTimer); flash("");
    if (!/^[a-z0-9-]{3,40}$/.test(code)) { setLang((navigator.language || "ko").slice(0, 2)); return codeScreen(false); }
    fetch("packs/" + code + ".json", { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (p) {
      if (!C.validPack(p) || p.code !== code) throw new Error("invalid pack");
      pack = p; setLang(p.lang); st = load(); render(); flush();
    }).catch(function () { setLang((navigator.language || "ko").slice(0, 2)); codeScreen(true); });
  }

  window.addEventListener("hashchange", open);
  window.addEventListener("online", function () { if (st) flush(); });
  open();
})();

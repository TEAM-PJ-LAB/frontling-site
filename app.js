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
  // keepFocus: announce through the live region without pulling focus away from the control the student just used.
  function flash(key, kw, keepFocus) {
    flashEl.textContent = key ? _(key, kw) : ""; flashEl.hidden = !key;
    if (key && !keepFocus) flashEl.focus();
  }

  // ---------- storage + activity log ----------
  // Several tabs can have the same project open. Each action re-reads the saved state, changes it and saves it at once,
  // so one tab never overwrites what another tab saved. Without storage (private mode) the in-memory state is used.
  function storeKey() { return "r2c:" + pack.code; }
  function save(s) { s = s || st; try { localStorage.setItem("r2c:" + s.code, JSON.stringify(s)); } catch (e) { /* private mode: in-memory only */ } }
  function stored(code) {
    try { var s = JSON.parse(localStorage.getItem("r2c:" + code) || "null"); if (s && s.v === 1 && s.code === code) return C.migrate(s); } catch (e) { /* ignore */ }
    return null;
  }
  function load() { var s = stored(pack.code); if (!s) { s = C.newState(pack.code); save(s); } return s; }
  function fresh() { return (pack && stored(pack.code)) || st; }
  function mutate(fn) { st = fresh(); var r = fn(st); save(); return r; }

  function logReady() {
    var l = CFG.log || {}, f = l.fields || {};
    return !!(l.action && f.pid && f.kind);
  }

  // One sender at a time across all tabs (navigator.locks where available), oldest first. Each step re-reads the saved
  // outbox and removes the sent entry by its sequence number, so an entry is posted once even with two tabs open.
  // Every entry carries "<sid>:<seq>" (config field `seq`): reviewers can spot gaps (lost entries) and repeats.
  // Google Forms answers a cross-origin POST with an opaque response, so success only means "no network error";
  // the student's backup file holds the full record to reconcile against.
  var sending = false;
  function withLock(name, fn) {
    if (navigator.locks && navigator.locks.request) return navigator.locks.request(name, fn);
    return fn();
  }
  var SEND_AT_ONCE = 4;  // a long offline stretch can leave hundreds of rows; send a few in parallel, not one by one
  function post(l, f, s, e) {
    var body = new URLSearchParams();
    body.append(f.pid, s.pid);
    if (f.code) body.append(f.code, s.code);
    body.append(f.kind, e.kind);
    if (f.milestone) body.append(f.milestone, String(e.milestone + 1));
    if (f.detail) body.append(f.detail, e.detail);
    if (f.at) body.append(f.at, e.at);
    if (f.seq) body.append(f.seq, s.sid + ":" + e.seq);
    return fetch(l.action, { method: "POST", mode: "no-cors", body: body, keepalive: true })
      .then(function () { return e.seq; }, function () { return null; });
  }
  function flush() {
    if (sending || !logReady() || !st || !st.outbox.length || navigator.onLine === false) return;
    var l = CFG.log, f = l.fields, code = st.code;
    sending = true;
    function next() {
      if (!pack || pack.code !== code) return Promise.resolve();  // another project was opened: its own flush takes over
      var s = fresh(), batch = s.outbox.slice(0, SEND_AT_ONCE);
      st = s;
      if (!batch.length) return Promise.resolve();
      // Rows are posted in seq order; each one that went out is removed, one that failed stays for the next try.
      return Promise.all(batch.map(function (e) { return post(l, f, s, e); })).then(function (done) {
        var sent = done.filter(function (x) { return x !== null; });
        if (pack && pack.code === code && sent.length)
          mutate(function (s2) { s2.outbox = s2.outbox.filter(function (x) { return sent.indexOf(x.seq) < 0; }); });
        if (sent.length < batch.length) throw new Error("offline");
        return next();
      });
    }
    Promise.resolve().then(function () { return withLock("r2c-flush:" + code, next); })
      .catch(function () { /* offline or blocked: retried on the next action */ }).then(function () {
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

  // Read a backup file back in (new device, cleared browser data). A hidden file input opened by a real button,
  // so it works from the keyboard.
  function restoreControl() {
    var input = h("input", { type: "file", accept: ".json,application/json", class: "sr-only", tabindex: "-1", "aria-hidden": "true", onchange: function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var imported = null;
        try { imported = JSON.parse(String(reader.result)); } catch (e) { /* reported below */ }
        st = fresh();
        var r = C.restoreFrom(st, imported, pack.code, Date.now());
        if (r.ok) { st = r.state; save(); }
        flash(r.ok ? "msg.restored" : "msg." + r.reason); render(); flush();
      };
      reader.readAsText(file);
    } });
    return h("span", {}, input, h("button", { type: "button", class: "btn-link", id: "restore-btn", onclick: function () { input.value = ""; input.click(); }, text: _("restore") }));
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
        mutate(function (s) { s.pid = pid.slice(0, 40); s.consent = true; }); flash(""); render();
        // Ask the browser to keep this site's data under storage pressure (Chrome, Firefox, Safari 15.2+).
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
      } },
        h("div", { class: "field" }, h("label", { for: "pid", text: _("pid_label") }),
          h("input", { id: "pid", name: "pid", autocomplete: "off", maxlength: "40", required: true }),
          h("p", { class: "help", text: _("pid_help") })),
        h("label", { class: "check-row" }, h("input", { type: "checkbox", name: "consent" }), " " + _("consent_label")),
        safeUrl(CFG.privacy) ? h("p", { class: "small" }, h("a", { href: CFG.privacy, target: "_blank", rel: "noopener noreferrer", text: _("privacy_link") })) : null,
        h("div", {}, h("button", { text: _("join_btn") }))),
      h("p", { class: "help" }, _("join_restore") + " ", restoreControl())));
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

  // The state change already happened (and was saved) inside mutate(); this shows the outcome and sends the log.
  function act(res, okKey, okKw, keepFocus) { flash(res.ok ? okKey : "msg." + res.reason, res.ok ? okKw : null, keepFocus); render(); flush(); }

  // Variants are assigned by participant number, so a student sees the same wording on every device.
  function who(s) { return s.pid || s.sid; }
  // The variant of an opened hint: the one recorded when it was opened (what the student actually saw).
  function shownVariant(i, si, k) {
    var r = C.ms(st, i).reveals.filter(function (x) { return x.s === si && x.level === k + 1; })[0];
    if (r && typeof r.v === "number" && r.v < C.variantCount(pack, i, si, k)) return r.v;
    return C.variantOf(pack, who(st), i, si, k) || 0;
  }

  function workPanel(i) {
    var m = pack.milestones[i], ms = C.ms(st, i), pol = pack.policy, now = Date.now(), rec = C.suggestion(st, i);
    return h("section", { class: "panel stack", "aria-labelledby": "mh" },
      h("div", { class: "desk-head" }, h("span", { class: "m-mark", text: "M" + (i + 1) }), h("h2", { id: "mh", text: m.title })),
      h("p", { class: "muted" }, _("deliverable") + ": " + m.deliverable),
      h("form", { class: "composer stack", onsubmit: function (ev) {
        ev.preventDefault();
        var text = ev.target.elements.body.value;
        var r = mutate(function (s) { return C.addAttempt(s, i, text, Date.now(), pol, m); });
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
      rec >= 0 ? h("p", { class: "help", id: "rec-note", text: _("rec_help") }) : null,
      h("div", { class: "stack" }, m.stuck.map(function (s, si) {
        var lv = C.level(st, i, si), can = C.canReveal(st, i, si, now, pol);
        // Hints are unsealed only once opened. The button keeps an id so focus stays on it after the re-render;
        // when the last hint is opened the card itself (tabindex -1) takes the focus instead.
        return h("article", { class: "entry entry-hint", id: "hint-card-" + i + "-" + si, tabindex: "-1", "aria-label": s.label },
          h("header", {}, h("b", { text: s.label }),
            si === rec ? h("span", { class: "chip chip-rec", "aria-describedby": "rec-note", text: _("rec_chip") }) : null,
            h("span", { class: "chip", text: lv + "/" + C.MAX_LEVEL })),
          [0, 1, 2].slice(0, lv).map(function (k) {
            return h("div", { class: "stack" }, h("span", { class: "chip chip-lilac", text: _("level_" + (k + 1)) }), h("p", { class: "prose-pre", text: C.hintText(pack, i, si, k, shownVariant(i, si, k)) }));
          }),
          C.canRate(st, i, si) ? h("div", { class: "rate-row", role: "group", "aria-labelledby": "rate-q-" + i + "-" + si },
            h("span", { class: "help", id: "rate-q-" + i + "-" + si, text: _("rate_q") }),
            [true, false].map(function (up) {
              return h("button", { class: "btn-quiet btn-sm", type: "button", id: (up ? "rate-up-" : "rate-down-") + i + "-" + si, onclick: function (ev) {
                ev.currentTarget.focus();
                act(mutate(function (st2) { return C.rate(st2, i, si, up, Date.now()); }), "msg.rated", null, true);
              }, text: _(up ? "rate_up" : "rate_down") });
            })) : null,
          lv < C.MAX_LEVEL
            ? h("button", { class: "btn-quiet", type: "button", id: "hint-btn-" + i + "-" + si, "aria-disabled": can.ok ? null : "true", onclick: function (ev) {
                ev.currentTarget.focus();  // Safari does not focus a clicked button; the re-render restores this focus
                var r = mutate(function (st2) { return C.reveal(st2, i, si, Date.now(), pol, C.variantOf(pack, who(st2), i, si, C.level(st2, i, si))); });
                act(r, "msg.hint_opened", { label: s.label, level: r.ok ? _("level_" + r.level) : "" }, r.ok);
              }, text: _("open_hint", { level: _("level_" + (lv + 1)) }) })
            : h("p", { class: "help", text: _("all_open") }));
      })),
      h("form", { class: "submit-box", onsubmit: function (ev) {
        ev.preventDefault();
        var work = ev.target.elements.work.value;
        var r = mutate(function (s) { return C.submit(s, i, pack.milestones.length, work, Date.now()); });
        if (r.reason === "concern") ev.target.elements.work.value = "";
        act(r, "msg.submitted");
      } },
        h("label", { for: "work", text: _("submit_h", { n: i + 1 }) }),
        h("div", { class: "inline-form" }, h("input", { id: "work", name: "work", placeholder: _("submit_ph"), required: true }),
          h("button", { class: "btn-quiet", text: _("submit_btn") })),
        h("p", { class: "help", text: _("submit_help") })));
  }

  function quizPanel() {
    var qs = pack.quiz || [];
    var key = null;  // answers are unsealed only after the first check

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
        var graded = C.grade(C.quizKey(pack), ans);
        mutate(function (s) { C.recordQuiz(s, graded, ans, Date.now()); });
        render(); flush();
      } }, qs.map(function (q, k) {
        var mine = last && last.answers[k];
        return h("fieldset", { class: "quiz-q" }, h("legend", { text: (k + 1) + ". " + q.question }),
          q.options.map(function (o, oi) {
            return h("label", { class: "quiz-opt" }, h("input", { type: "radio", name: "q" + k, value: String(oi), checked: mine === oi }), " " + o);
          }),
          last ? (function () {
            var kq = (key || (key = C.quizKey(pack)))[k];
            return h("p", { class: "help", text: _("answer") + ": " + kq.options[kq.answer] + (kq.explanation ? " — " + kq.explanation : "") });
          })() : null);
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
    // A hint button disappears once its last hint is open: keep the student in the same card.
    if (!f && k.focus && k.cur === cur && /^(hint-btn|rate-up|rate-down)-/.test(k.focus.id)) f = document.getElementById(k.focus.id.replace(/^(hint-btn|rate-up|rate-down)-/, "hint-card-"));
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
          h("a", { href: "#" + pack.code, onclick: function (ev) { ev.preventDefault(); backup(); }, text: _("backup") }), " · ", restoreControl()))));
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
    var note = document.getElementById("note");
    note.textContent = _("brand_note"); note.setAttribute("aria-label", _("note_label"));
  }

  function open() {
    var code = "";
    try { code = decodeURIComponent(location.hash.slice(1)).trim().toLowerCase(); } catch (e) { /* malformed link: ask for the code */ }
    pack = null; shown = -1; clearTimeout(hintTimer); flash("");
    if (!/^[a-z0-9-]{3,40}$/.test(code)) { setLang((navigator.language || "ko").slice(0, 2)); return codeScreen(false); }
    // index.html starts this download before the scripts arrive; use it once, otherwise fetch here.
    var early = window.R2C_PACK;
    window.R2C_PACK = null;
    (early && early.code === code ? early.p : fetch("packs/" + code + ".json", { cache: "no-cache" })).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (p) {
      if (code !== currentCode()) return;  // the link changed while this was loading
      if (!C.validPack(p) || p.code !== code) { if (window.console) console.warn("Frontling: invalid project file", code); throw new Error("invalid pack"); }
      pack = p; setLang(p.lang); st = load(); render(); flush();
      if (updatedWhileLoading === code) { updatedWhileLoading = ""; refreshPack(code); }
    }).catch(function () { if (code === currentCode()) { setLang((navigator.language || "ko").slice(0, 2)); codeScreen(true); } });
  }

  var updatedWhileLoading = "";
  function refreshPack(code) {
    fetch("packs/" + code + ".json", { cache: "no-cache" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (p) {
      if (p && pack && pack.code === code && C.validPack(p) && p.code === code) { pack = p; setLang(p.lang); render(); }
    }).catch(function () { /* keep the copy on screen */ });
  }

  function currentCode() {
    try { return decodeURIComponent(location.hash.slice(1)).trim().toLowerCase(); } catch (e) { return ""; }
  }

  // Offline support (sw.js). Skipped where service workers are missing or blocked, e.g. file:// and some private modes.
  if ("serviceWorker" in navigator && CFG.offline === false) {
    // Switched off in config.js: remove the worker and everything it saved.
    navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { r.unregister(); }); }).catch(function () {});
    if (window.caches) caches.keys().then(function (ks) { ks.forEach(function (k) { if (k.indexOf("frontling-") === 0) caches.delete(k); }); }).catch(function () {});
  } else if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").then(function (reg) {
      return reg.update();  // look for a new deploy on every visit; it is used from the next visit on
    }).catch(function () { /* online-only */ }); });
    // On the very first visit the project file arrived before the worker took over; fetch it once more through the
    // worker so it is saved and the next visit opens instantly.
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (pack) fetch("packs/" + pack.code + ".json", { cache: "no-cache" }).catch(function () { /* next time */ });
    });
  }
  // sw.js shows the saved project file at once; when the fresh download turns out to be different, redraw with it.
  // The notice can arrive before the first copy is on screen; it is remembered and applied once that copy is.
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener("message", function (ev) {
    var d = ev.data || {}, m = /packs\/([a-z0-9-]{3,40})\.json/.exec(String(d.url));
    if (d.type !== "pack-updated" || !m) return;
    if (pack && pack.code === m[1]) refreshPack(m[1]); else updatedWhileLoading = m[1];
  });
  window.addEventListener("hashchange", open);
  window.addEventListener("online", function () { if (st) flush(); });
  // Another tab saved this project: show its progress here too (drafts in this tab are kept by render()).
  window.addEventListener("storage", function (ev) {
    if (!pack || !st || ev.key !== storeKey()) return;
    var s = stored(pack.code);
    if (s) { st = s; render(); }
  });
  open();
})();

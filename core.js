/* Frontling student site: pure logic, no DOM. Same rules as the server's policy layer (r2c/policy.py decide()):
   a new attempt before every hint, a minimum interval, the ladder stops at level 3 (no answer level).
   Works in the browser (window.R2CCore) and in Node (module.exports) so it can be tested with `node --test`.
   Limits of a serverless site (see README): everything here runs on the student's device, so the rules keep honest
   students on the ladder but cannot stop a determined one. The activity log is what reviewers should trust. */
(function (root) {
  "use strict";
  var MAX_LEVEL = 3;
  var DETAIL_MAX = 1500;
  var OUTBOX_MAX = 500;  // unsent log entries kept; progress itself (attempts, reveals, submissions) is never trimmed
  var CLOCK_SLACK_MS = 2 * 60 * 1000;  // device clocks drift and get corrected; only a larger step back counts

  // ---------- distress check ----------
  // Korean patterns are matched with whitespace removed, so "죽 고 싶 어" and "죽고싶어" both match.
  // Research vocabulary ("자살률", "자살 예방", "suicide rate") is not a disclosure and is let through.
  // Colloquial "힘들어 죽겠다" is deliberately not matched: it is everyday speech and would stop students constantly.
  var CONCERN_KO = /자살(?!률|율|예방|통계|데이터|관련연구|위험요인|사망률)|자해|죽고싶|죽어버리|죽을래|죽어야겠|살기싫|살고싶지않|사라지고싶|없어지고싶|목숨을끊|극단적(인)?선택|손목을?긋|뛰어내리고싶|목매/;
  var CONCERN_EN = /\bsuicid(?!e\s+(rate|prevention|data|statistics|risk))|\bkill\s+myself\b|\bself[-\s]?harm|\bwant\s+to\s+die\b|\bend\s+my\s+life\b|\bhurt\s+myself\b/i;

  function concern(text) {
    var t = String(text || "");
    return CONCERN_EN.test(t) || CONCERN_KO.test(t.replace(/\s+/g, ""));
  }

  // ---------- sealed pack content ----------
  // Hints and quiz answers are XOR-sealed with a keystream derived from the project code and their position, so they
  // are not readable by opening packs/<code>.json. This is obfuscation, not encryption: the key is in this file.
  function fnv1a(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h || 1;
  }
  // Works on "binary strings" (one char per byte) so it needs only btoa/atob, which every browser and Node 16+ have.
  function xorStream(bin, seed) {
    var x = seed >>> 0, out = "";
    for (var i = 0; i < bin.length; i++) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      out += String.fromCharCode(bin.charCodeAt(i) ^ (x & 0xff));
    }
    return out;
  }
  function utf8(s) { return unescape(encodeURIComponent(s)); }
  function fromUtf8(bin) { return decodeURIComponent(escape(bin)); }
  function seal(code, where, text) { return btoa(xorStream(utf8(String(text)), fnv1a(code + "|" + where))); }
  function unseal(code, where, sealed) { return fromUtf8(xorStream(atob(sealed), fnv1a(code + "|" + where))); }

  // ---------- hint variants (A/B) ----------
  // A stuck point may carry `variants`: for each level, a list of alternative wordings of that hint. Variant 0 is the
  // hint in `hints`, variant j >= 1 is variants[level][j - 1]. Each student always gets the same variant of a hint
  // (a hash of who they are and where the hint is), the log records which one, and scripts/hint_report.js compares them.
  function variantCount(pack, i, s, k) {
    var v = pack.milestones[i].stuck[s].variants;
    return 1 + (v && v[k] ? v[k].length : 0);
  }
  // The variant this student sees, or null when the hint has no alternatives (nothing to compare, nothing logged).
  function variantOf(pack, who, i, s, k) {
    var n = variantCount(pack, i, s, k);
    return n > 1 ? fnv1a(String(who) + "|" + pack.code + "|" + i + "." + s + "." + k) % n : null;
  }

  // The text of hint k (0-based) of stuck point s in milestone i, variant v (default 0); plain packs are read as they are.
  function hintText(pack, i, s, k, v) {
    var sp = pack.milestones[i].stuck[s];
    if (v) {
      var raw = sp.variants[k][v - 1];
      return pack.sealed === 1 ? unseal(pack.code, "v" + i + "." + s + "." + k + "." + v, raw) : raw;
    }
    return pack.sealed === 1 ? unseal(pack.code, "h" + i + "." + s + "." + k, sp.hints[k]) : sp.hints[k];
  }
  // Quiz questions with the answer and explanation readable, for grading after the student checks.
  function quizKey(pack) {
    return (pack.quiz || []).map(function (q, k) {
      if (pack.sealed !== 1) return q;
      var o = {}; Object.keys(q).forEach(function (x) { o[x] = q[x]; });
      o.answer = Number(unseal(pack.code, "qa" + k, q.answer));
      if (q.explanation) o.explanation = unseal(pack.code, "qe" + k, q.explanation);
      return o;
    });
  }
  // Used by scripts/seal_packs.js before publishing. Sealing a sealed pack returns it unchanged.
  function sealPack(p) {
    if (p.sealed === 1) return p;
    var o = JSON.parse(JSON.stringify(p));
    o.milestones.forEach(function (m, i) {
      m.stuck.forEach(function (s, si) {
        s.hints = s.hints.map(function (h, k) { return seal(o.code, "h" + i + "." + si + "." + k, h); });
        if (s.variants) s.variants = s.variants.map(function (list, k) {
          return list.map(function (h, j) { return seal(o.code, "v" + i + "." + si + "." + k + "." + (j + 1), h); });
        });
      });
    });
    (o.quiz || []).forEach(function (q, k) {
      q.answer = seal(o.code, "qa" + k, String(q.answer));
      if (q.explanation) q.explanation = seal(o.code, "qe" + k, q.explanation);
    });
    o.sealed = 1;
    return o;
  }
  // The inverse, for tools that edit published packs (scripts/hint_report.js --apply). Plain packs come back as copies.
  function unsealPack(p) {
    var o = JSON.parse(JSON.stringify(p));
    if (p.sealed !== 1) return o;
    o.milestones.forEach(function (m, i) {
      m.stuck.forEach(function (s, si) {
        s.hints = s.hints.map(function (_, k) { return hintText(p, i, si, k, 0); });
        if (s.variants) s.variants = s.variants.map(function (list, k) { return list.map(function (_, j) { return hintText(p, i, si, k, j + 1); }); });
      });
    });
    o.quiz = quizKey(p);
    if (!p.quiz) delete o.quiz;
    delete o.sealed;
    return o;
  }

  // ---------- stuck-point matching ----------
  // Ranks a milestone's stuck points by how close they are to what the student wrote, on the device.
  // Text becomes character 2- and 3-grams (robust to Korean spacing and English word endings). A stuck point's profile is
  // its label, plus `signals` when the pack has them: n-gram weights mined from past students' attempts and the hint they
  // opened next (scripts/mine_signals.js). The code is generic; the signals come from our own logs and only get better.
  var REC_MIN = 0.06, REC_MARGIN = 1.25;

  function grams(text) {
    var t = " " + String(text || "").toLowerCase().replace(/[^0-9a-z\uac00-\ud7a3\u3131-\u318e]+/g, " ").replace(/\s+/g, " ").trim() + " ";
    var g = {};
    for (var n = 2; n <= 3; n++) for (var i = 0; i + n <= t.length; i++) {
      var k = t.substr(i, n);
      if (k.trim().length < 2 || /^[\s0-9]+$/.test(k)) continue;
      g[k] = (g[k] || 0) + 1;
    }
    return g;
  }

  function profiles(milestone) {
    if (milestone._profiles) return milestone._profiles;
    var lab = milestone.stuck.map(function (s) { return grams(s.label); }), df = {}, n = lab.length;
    lab.forEach(function (g) { Object.keys(g).forEach(function (k) { df[k] = (df[k] || 0) + 1; }); });
    var out = milestone.stuck.map(function (s, si) {
      var w = {};
      // A label n-gram shared by every stuck point says nothing about which one it is.
      Object.keys(lab[si]).forEach(function (k) { var idf = Math.log((n + 1) / df[k]); if (idf > 0.01) w[k] = idf; });
      Object.keys(s.signals || {}).forEach(function (k) { w[k] = (w[k] || 0) + s.signals[k]; });
      var norm = 0; Object.keys(w).forEach(function (k) { norm += w[k] * w[k]; });
      return { w: w, norm: Math.sqrt(norm) || 1 };
    });
    Object.defineProperty(milestone, "_profiles", { value: out, enumerable: false });  // cached, never saved or sent
    return out;
  }

  // [{s, score}] best first; score is a cosine similarity in [0, 1].
  function rankStuck(milestone, text) {
    var a = grams(text), an = 0;
    Object.keys(a).forEach(function (k) { a[k] = Math.min(a[k], 2); an += a[k] * a[k]; });
    an = Math.sqrt(an) || 1;
    return profiles(milestone).map(function (p, s) {
      var dot = 0; Object.keys(a).forEach(function (k) { if (p.w[k]) dot += a[k] * p.w[k]; });
      return { s: s, score: dot / (an * p.norm) };
    }).sort(function (x, y) { return y.score - x.score || x.s - y.s; });
  }

  // The stuck point to suggest, or -1 when the text is not clearly closer to one of them.
  function recommend(milestone, text) {
    if (!milestone || !milestone.stuck || milestone.stuck.length < 2) return -1;
    var r = rankStuck(milestone, text);
    return r[0].score >= REC_MIN && r[0].score >= REC_MARGIN * r[1].score ? r[0].s : -1;
  }

  // ---------- state ----------
  function norm(s) { return String(s || "").trim().split(/\s+/).join(" ").toLowerCase(); }
  function randomId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

  function newState(code) {
    return { v: 1, code: code, sid: randomId(), seq: 0, lastAt: 0, pid: "", consent: false, ms: {}, quiz: null, outbox: [] };
  }

  // States saved before sid/seq existed get them now, so every log entry can be told apart and gaps show up.
  function migrate(st) {
    if (!st.sid) st.sid = randomId();
    if (typeof st.seq !== "number") st.seq = 0;
    if (typeof st.lastAt !== "number") st.lastAt = 0;
    (st.outbox || (st.outbox = [])).forEach(function (e) { if (typeof e.seq !== "number") e.seq = ++st.seq; });
    return st;
  }

  function ms(st, i) {
    if (!st.ms[i]) st.ms[i] = { attempts: [], reveals: [], submitted: null };
    return st.ms[i];
  }

  function current(st, n) {
    for (var i = 0; i < n; i++) if (!ms(st, i).submitted) return i;
    return n;
  }

  function log(st, kind, i, detail, now) {
    var d = typeof detail === "string" ? detail : JSON.stringify(detail || {});
    st.seq = (st.seq || 0) + 1;
    st.outbox.push({ seq: st.seq, kind: kind, milestone: i, detail: d.slice(0, DETAIL_MAX), at: new Date(now).toISOString() });
    if (st.outbox.length > OUTBOX_MAX) st.outbox.splice(0, st.outbox.length - OUTBOX_MAX);
  }

  // A device clock that jumps back (for example after being set forward to skip the hint interval) stops the action
  // and leaves a "clock" entry in the log for the reviewer.
  function clockOk(st, i, now) {
    if (st.lastAt && now < st.lastAt - CLOCK_SLACK_MS) {
      log(st, "clock", i, { back_s: Math.round((st.lastAt - now) / 1000) }, now);
      st.lastAt = now;  // ask once; the next action goes through
      return false;
    }
    if (now > (st.lastAt || 0)) st.lastAt = now;
    return true;
  }

  // milestone (optional): the pack's milestone, to remember which stuck point the attempt was closest to.
  function addAttempt(st, i, text, now, policy, milestone) {
    var body = String(text || "").trim();
    if (concern(body)) { log(st, "flag", i, "", now); return { ok: false, reason: "concern" }; }  // never stored or sent
    if (body.length < policy.min_attempt_chars) return { ok: false, reason: "attempt_too_short" };
    var m = ms(st, i);
    if (m.submitted) return { ok: false, reason: "done" };
    var last = m.attempts[m.attempts.length - 1];
    if (last && norm(last.body) === norm(body)) return { ok: false, reason: "duplicate" };
    if (!clockOk(st, i, now)) return { ok: false, reason: "clock" };
    var att = { body: body, at: now };
    if (milestone) att.rec = recommend(milestone, body);
    m.attempts.push(att);
    log(st, "attempt", i, body, now);
    return { ok: true };
  }

  function level(st, i, s) {
    var lv = 0;
    ms(st, i).reveals.forEach(function (r) { if (r.s === s && r.level > lv) lv = r.level; });
    return lv;
  }

  function canReveal(st, i, s, now, policy) {
    var m = ms(st, i);
    if (m.submitted) return { ok: false, reason: "done" };
    var next = level(st, i, s) + 1;
    if (next > MAX_LEVEL) return { ok: false, reason: "max_level" };
    var lastR = m.reveals[m.reveals.length - 1];
    var since = m.attempts.length - (lastR ? lastR.after : 0);
    if (since < 1) return { ok: false, reason: "need_attempt" };
    if (lastR && now - lastR.at < policy.hint_min_interval_s * 1000) return { ok: false, reason: "too_fast" };
    return { ok: true, level: next };
  }

  // v: the hint variant shown (variantOf), recorded with the reveal and logged; null or undefined when not an experiment.
  function reveal(st, i, s, now, policy, v) {
    var d = canReveal(st, i, s, now, policy);
    if (d.ok) {
      if (!clockOk(st, i, now)) return { ok: false, reason: "clock" };
      var m = ms(st, i);
      var rv = { s: s, level: d.level, at: now, after: m.attempts.length };
      if (typeof v === "number") rv.v = v;
      m.reveals.push(rv);
      // rec = what was suggested for the attempt before this hint (-1 none): the log shows how often students agree.
      var lastA = m.attempts[m.attempts.length - 1], ev = { stuck: s, level: d.level };
      if (lastA && typeof lastA.rec === "number") ev.rec = lastA.rec;
      if (typeof v === "number") ev.v = v;
      log(st, "hint", i, ev, now);
    }
    return d;
  }

  // ---------- "did this hint help?" ----------
  // One tap under the newest hint of a stuck point. Asked once per hint; the answer goes to the log for hint_report.js.
  function latestReveal(st, i, s) {
    var rs = ms(st, i).reveals, r = null;
    rs.forEach(function (x) { if (x.s === s && (!r || x.level > r.level)) r = x; });
    return r;
  }
  function canRate(st, i, s) { var r = latestReveal(st, i, s); return !!(r && !r.rated && !ms(st, i).submitted); }
  function rate(st, i, s, up, now) {
    if (!canRate(st, i, s)) return { ok: false, reason: "rate_none" };
    var r = latestReveal(st, i, s), ev = { stuck: s, level: r.level, up: !!up };
    r.rated = up ? 1 : -1;
    if (typeof r.v === "number") ev.v = r.v;
    log(st, "rate", i, ev, now);
    return { ok: true };
  }

  // The suggestion to show now: the latest attempt's, while no hint has been opened since it.
  function suggestion(st, i) {
    var m = ms(st, i), lastR = m.reveals[m.reveals.length - 1], lastA = m.attempts[m.attempts.length - 1];
    if (!lastA || typeof lastA.rec !== "number" || lastA.rec < 0) return -1;
    if (lastR && lastR.after >= m.attempts.length) return -1;
    return lastA.rec;
  }

  function submit(st, i, n, work, now) {
    var body = String(work || "").trim();
    if (i !== current(st, n)) return { ok: false, reason: "not_current" };
    if (concern(body)) { log(st, "flag", i, "", now); return { ok: false, reason: "concern" }; }  // never stored or sent
    if (body.length < 3) return { ok: false, reason: "submit_empty" };
    if (!clockOk(st, i, now)) return { ok: false, reason: "clock" };
    ms(st, i).submitted = { body: body, at: now };
    log(st, "submit", i, body, now);
    return { ok: true };
  }

  function grade(questions, answers) {
    var by = {}, correct = 0;
    questions.forEach(function (q, i) {
      var ok = answers[i] === q.answer;
      if (ok) correct++;
      var c = by[q.concept] || (by[q.concept] = [0, 0]);
      c[0] += ok ? 1 : 0; c[1] += 1;
    });
    var weak = Object.keys(by).filter(function (c) { return by[c][0] < by[c][1]; });
    return { correct: correct, total: questions.length, weak: weak };
  }

  function recordQuiz(st, result, answers, now) {
    // The first result is the diagnosis; retakes come after the answer key was shown and are practice.
    if (!st.quiz) st.quiz = { first: { result: result, answers: answers, at: now }, last: null, tries: 0 };
    st.quiz.last = { result: result, answers: answers, at: now };
    st.quiz.tries += 1;
    log(st, "quiz", -1, { correct: result.correct, total: result.total, first: st.quiz.tries === 1 }, now);
  }

  // ---------- restore from a backup file ----------
  // "Save my log to a file" writes the whole state; this reads it back (new device, cleared browser data).
  // The file must be this project's, for the same participant if one is set here, and must not have less progress
  // than what is here already. Unsent log rows of this browser are kept; the file's own unsent rows are dropped,
  // because they may have been sent since (sid:seq keeps counting from the higher of the two).
  function progress(x) {
    var n = 0;
    Object.keys(x.ms || {}).forEach(function (k) { var m = x.ms[k]; n += (m.submitted ? 1000 : 0) + m.attempts.length + m.reveals.length; });
    return n + (x.quiz ? x.quiz.tries : 0);
  }
  function validState(x, code) {
    return !!(x && x.v === 1 && x.code === code && x.ms && typeof x.ms === "object" && Object.keys(x.ms).every(function (k) {
      var m = x.ms[k];
      return /^\d+$/.test(k) && m && Array.isArray(m.attempts) && Array.isArray(m.reveals) &&
        m.attempts.every(function (a) { return a && typeof a.body === "string" && typeof a.at === "number"; }) &&
        m.reveals.every(function (r) { return r && Number.isInteger(r.s) && Number.isInteger(r.level) && r.level >= 1 && r.level <= MAX_LEVEL; });
    }));
  }
  function restoreFrom(cur, imported, code, now) {
    if (!validState(imported, code)) return { ok: false, reason: "restore_bad" };
    if (cur.pid && imported.pid && cur.pid !== imported.pid) return { ok: false, reason: "restore_other" };
    if (progress(imported) < progress(cur)) return { ok: false, reason: "restore_older" };
    var s = JSON.parse(JSON.stringify(imported));
    s.sid = cur.sid; s.seq = Math.max(cur.seq || 0, imported.seq || 0); s.outbox = cur.outbox.slice();
    s.lastAt = Math.max(cur.lastAt || 0, imported.lastAt || 0);
    if (!s.pid) s.pid = cur.pid;
    s.consent = !!(imported.consent || cur.consent);
    migrate(s);
    log(s, "restore", -1, { progress: progress(imported) }, now);
    return { ok: true, state: s };
  }

  // ---------- pack validation ----------
  // Everything the screens read is checked here, so a broken export shows "project not found" instead of a blank page.
  function str(x) { return typeof x === "string" && x.trim().length > 0; }
  function strOrEmpty(x) { return x === undefined || typeof x === "string"; }
  function strList(x) { return x === undefined || (Array.isArray(x) && x.every(function (y) { return typeof y === "string"; })); }
  function posNum(x) { return typeof x === "number" && isFinite(x) && x >= 0; }

  function validPack(p) {
    if (!(p && p.v === 1 && str(p.code) && p.project && typeof p.project === "object")) return false;
    if (p.sealed !== undefined && p.sealed !== 1) return false;
    if (!(str(p.project.title) && strOrEmpty(p.project.question) && strOrEmpty(p.project.hypothesis))) return false;
    if (p.paper !== undefined && !(p.paper && typeof p.paper === "object" && strOrEmpty(p.paper.title) && strOrEmpty(p.paper.url))) return false;
    if (!(p.policy && posNum(p.policy.min_attempt_chars) && posNum(p.policy.hint_min_interval_s))) return false;
    if (!(Array.isArray(p.milestones) && p.milestones.length)) return false;
    var msOk = p.milestones.every(function (m) {
      return m && str(m.title) && strOrEmpty(m.deliverable) && (m.weeks === undefined || posNum(m.weeks)) &&
        Array.isArray(m.stuck) && m.stuck.length && m.stuck.every(function (s) {
          return s && str(s.label) && Array.isArray(s.hints) && s.hints.length === MAX_LEVEL && s.hints.every(str) &&
            (s.variants === undefined || (Array.isArray(s.variants) && s.variants.length === MAX_LEVEL &&
              s.variants.every(function (l) { return Array.isArray(l) && l.every(str); }))) &&
            (s.signals === undefined || (s.signals && typeof s.signals === "object" && !Array.isArray(s.signals) &&
              Object.keys(s.signals).every(function (k) { return typeof s.signals[k] === "number" && isFinite(s.signals[k]); })));
        });
    });
    if (!msOk) return false;
    if (p.quiz !== undefined) {
      if (!Array.isArray(p.quiz)) return false;
      var key;
      try { key = quizKey(p); } catch (e) { return false; }  // a sealed answer that does not decode
      var qOk = key.every(function (q) {
        return q && str(q.question) && Array.isArray(q.options) && q.options.length >= 2 && q.options.every(str) &&
          Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length && strOrEmpty(q.explanation) &&
          (q.concept === undefined || typeof q.concept === "string");
      });
      if (!qOk) return false;
    }
    if (p.guides !== undefined) {
      if (!Array.isArray(p.guides)) return false;
      if (!p.guides.every(function (g) {
        return g && str(g.concept) && strOrEmpty(g.why) && strOrEmpty(g.summary) && strOrEmpty(g.practice) && strList(g.steps) && strList(g.keywords);
      })) return false;
    }
    return true;
  }

  var api = { MAX_LEVEL: MAX_LEVEL, OUTBOX_MAX: OUTBOX_MAX, CLOCK_SLACK_MS: CLOCK_SLACK_MS, newState: newState, migrate: migrate,
              ms: ms, current: current, addAttempt: addAttempt, level: level, canReveal: canReveal, reveal: reveal, submit: submit,
              grade: grade, recordQuiz: recordQuiz, validPack: validPack, concern: concern,
              sealPack: sealPack, hintText: hintText, quizKey: quizKey,
              grams: grams, rankStuck: rankStuck, recommend: recommend, suggestion: suggestion,
              unsealPack: unsealPack, restoreFrom: restoreFrom, variantCount: variantCount, variantOf: variantOf, canRate: canRate, rate: rate, latestReveal: latestReveal };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.R2CCore = api;
})(this);

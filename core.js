/* Frontling student site: pure logic, no DOM. Same rules as the server's policy layer (r2c/policy.py decide()):
   a new attempt before every hint, a minimum interval, the ladder stops at level 3 (no answer level).
   Works in the browser (window.R2CCore) and in Node (module.exports) so it can be tested with `node --test`. */
(function (root) {
  "use strict";
  var MAX_LEVEL = 3;
  var CONCERN = /자살|죽고\s*싶|자해|목숨을\s*끊|살기\s*싫|suicid|kill\s+myself|self[-\s]?harm|want\s+to\s+die/i;
  var DETAIL_MAX = 1500;
  var OUTBOX_MAX = 500;  // unsent log entries kept; progress itself (attempts, reveals, submissions) is never trimmed

  function norm(s) { return String(s || "").trim().split(/\s+/).join(" ").toLowerCase(); }

  function newState(code) {
    return { v: 1, code: code, pid: "", consent: false, ms: {}, quiz: null, outbox: [] };
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
    st.outbox.push({ kind: kind, milestone: i, detail: d.slice(0, DETAIL_MAX), at: new Date(now).toISOString() });
    if (st.outbox.length > OUTBOX_MAX) st.outbox.splice(0, st.outbox.length - OUTBOX_MAX);
  }

  function concern(text) { return CONCERN.test(String(text || "")); }

  function addAttempt(st, i, text, now, policy) {
    var body = String(text || "").trim();
    if (concern(body)) { log(st, "flag", i, "", now); return { ok: false, reason: "concern" }; }  // never stored or sent
    if (body.length < policy.min_attempt_chars) return { ok: false, reason: "attempt_too_short" };
    var m = ms(st, i);
    if (m.submitted) return { ok: false, reason: "done" };
    var last = m.attempts[m.attempts.length - 1];
    if (last && norm(last.body) === norm(body)) return { ok: false, reason: "duplicate" };
    m.attempts.push({ body: body, at: now });
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
    var lastA = m.attempts[m.attempts.length - 1];
    if (concern(lastA && lastA.body)) return { ok: false, reason: "concern" };
    if (lastR && now - lastR.at < policy.hint_min_interval_s * 1000) return { ok: false, reason: "too_fast" };
    return { ok: true, level: next };
  }

  function reveal(st, i, s, now, policy) {
    var d = canReveal(st, i, s, now, policy);
    if (d.ok) {
      var m = ms(st, i);
      m.reveals.push({ s: s, level: d.level, at: now, after: m.attempts.length });
      log(st, "hint", i, { stuck: s, level: d.level }, now);
    }
    return d;
  }

  function submit(st, i, n, work, now) {
    var body = String(work || "").trim();
    if (i !== current(st, n)) return { ok: false, reason: "not_current" };
    if (body.length < 3) return { ok: false, reason: "submit_empty" };
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

  function validPack(p) {
    return !!(p && p.v === 1 && p.code && p.project && Array.isArray(p.milestones) && p.milestones.length &&
      p.milestones.every(function (m) {
        return Array.isArray(m.stuck) && m.stuck.length && m.stuck.every(function (s) {
          return s.label && Array.isArray(s.hints) && s.hints.length === MAX_LEVEL;
        });
      }));
  }

  var api = { MAX_LEVEL: MAX_LEVEL, OUTBOX_MAX: OUTBOX_MAX, newState: newState, ms: ms, current: current, addAttempt: addAttempt, level: level,
              canReveal: canReveal, reveal: reveal, submit: submit, grade: grade, recordQuiz: recordQuiz,
              validPack: validPack, concern: concern };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.R2CCore = api;
})(this);

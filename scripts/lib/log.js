// Reading the activity log (Google Form response export, CSV) for the analysis scripts.
// Columns default to pid, code, kind, milestone, detail, at, seq; map them to the Form's question titles with
// --cols pid=Participant,kind=Kind,...  Rows come back grouped per student and project, in the order they were logged.

// RFC 4180: quotes, doubled quotes, commas and newlines inside quotes, CRLF, a UTF-8 BOM.
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const head = rows.shift().map((h) => h.replace(/^﻿/, "").trim());
  return rows.filter((r) => r.some((x) => x !== "")).map((r) => Object.fromEntries(head.map((h, k) => [h, r[k] || ""])));
}

function columns(spec) {
  const cols = { pid: "pid", code: "code", kind: "kind", milestone: "milestone", detail: "detail", at: "at", seq: "seq" };
  String(spec || "").split(",").filter(Boolean).forEach((kv) => { const [k, v] = kv.split("="); cols[k.trim()] = v.trim(); });
  return cols;
}

// Events in a normal shape: { code, pid, kind, m (0-based milestone, -1 for the quiz), detail, data (parsed JSON or
// null), at (ms or NaN), order }. Grouped by code + pid and sorted by sid:seq when present (exact), else device time,
// else row order.
function timelines(rows, cols) {
  const by = new Map();
  rows.forEach((r, k) => {
    const e = { code: r[cols.code], pid: r[cols.pid], kind: r[cols.kind], m: +r[cols.milestone] - 1, detail: r[cols.detail],
      at: Date.parse(r[cols.at]), row: k };
    try { e.data = /^[[{]/.test(e.detail) ? JSON.parse(e.detail) : null; } catch (err) { e.data = null; }
    const s = /^(.+):(\d+)$/.exec(r[cols.seq] || "");
    e.key = s ? [s[1], +s[2]] : ["", isNaN(e.at) ? k : e.at];
    const g = e.code + "\u0000" + e.pid;
    if (!by.has(g)) by.set(g, []);
    by.get(g).push(e);
  });
  const out = [];
  by.forEach((list) => {
    list.sort((a, b) => (a.key[0] < b.key[0] ? -1 : a.key[0] > b.key[0] ? 1 : a.key[1] - b.key[1]));
    out.push(list);
  });
  return out;
}

// Stops with a clear message when the export does not have the columns the analysis needs (a Form whose questions have
// other titles would otherwise give an empty report without saying why).
function requireColumns(rows, cols, needed) {
  if (!rows.length) throw new Error("the log file has no rows");
  const have = Object.keys(rows[0]), missing = needed.filter((k) => !have.includes(cols[k]));
  if (missing.length) {
    throw new Error("missing columns: " + missing.map((k) => `${k} (looked for "${cols[k]}")`).join(", ") +
      "\ncolumns in the file: " + have.map((h) => `"${h}"`).join(", ") +
      "\nmap them with --cols, e.g. --cols " + missing.map((k) => `${k}=<column title>`).join(","));
  }
  const kinds = new Set(rows.map((r) => r[cols.kind]));
  if (![...kinds].some((k) => ["attempt", "hint", "submit", "rate", "quiz", "flag"].includes(k)))
    throw new Error(`column "${cols.kind}" has no known kinds (attempt, hint, submit...): is it the right column?`);
}

function option(args, name, dflt) { const k = args.indexOf("--" + name); return k >= 0 ? args[k + 1] : dflt; }
// The first argument that is neither a --flag nor the value of one (--write and --apply take no value).
function positional(args) {
  const bare = new Set(["--write", "--apply", "--json"]);
  return args.find((a, k) => !a.startsWith("--") && !(k > 0 && args[k - 1].startsWith("--") && !bare.has(args[k - 1])));
}

module.exports = { parseCsv, columns, timelines, option, positional, requireColumns };

// Seal hints and quiz answers in project files so they can't be read by opening packs/<code>.json.
//   node scripts/seal_packs.js [packs/*.json]   (default: every pack in packs/)
// Run it on exported packs before they are published (scripts/publish_site.sh in the source repository).
// Already sealed packs are left as they are. Exits non-zero if a pack is invalid before or after sealing.
const fs = require("fs"), path = require("path");
const C = require("../core.js");
const dir = path.join(__dirname, "..", "packs");
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f));
let bad = 0;
for (const f of files) {
  const p = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!C.validPack(p)) { console.error("invalid pack:", f); bad++; continue; }
  if (p.sealed === 1) { console.log("already sealed:", f); continue; }
  const s = C.sealPack(p);
  if (!C.validPack(s)) { console.error("sealing broke the pack:", f); bad++; continue; }
  fs.writeFileSync(f, JSON.stringify(s));
  console.log("sealed:", f);
}
process.exit(bad ? 1 : 0);

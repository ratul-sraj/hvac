// Baseline: how good are the CURRENT rules at typing rooms and deciding whether a space is
// air conditioned? Runs js/calc.js (guessSpaceType + NON_AC_WORDS) over the labelled set in
// tests/samples/room-types.csv.
//
//   cd D:/webhvac && node tools/roomtype-baseline.mjs [csv] [--verbose]
//
// Prints type accuracy, include accuracy, a per-group breakdown (English drawing names,
// multilingual names, regressions) and every mismatch. This is the yardstick any smarter
// classifier (e.g. Laya) has to beat before it goes anywhere near the app.
import fs from "node:fs";
import { guessSpaceType, NON_AC_WORDS, SPACE_TYPES } from "../js/calc.js";

const csvPath = process.argv[2] || "tests/samples/room-types.csv";
const verbose = process.argv.includes("--verbose");

function parseCsv(text) {
  const out = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); out.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}

const rows = parseCsv(fs.readFileSync(csvPath, "utf8")).filter((r) => r.length >= 4 && r[0] && r[0] !== "name");
const cases = rows.map(([name, nameEn, type, include]) => ({
  name, nameEn, wantType: type.trim(), wantInclude: include.trim() === "true",
}));

const group = (c) => (/[\u0600-\u06FF]/.test(c.name) ? "arabic/urdu" :
  /[\u0900-\u097F]/.test(c.name) ? "devanagari" :
  /\b(salle|bureau|toilettes|recepción|sala)\b/i.test(c.name) ? "european" : "english");

const stats = {};
for (const c of cases) {
  const gotType = guessSpaceType(c.name);
  const excluded = NON_AC_WORDS.test(c.name);
  const gotInclude = !excluded;
  c.okType = gotType === c.wantType;
  c.okInclude = gotInclude === c.wantInclude;
  const g = group(c);
  stats[g] = stats[g] || { n: 0, type: 0, inc: 0 };
  stats[g].n++;
  if (c.okType) stats[g].type++;
  if (c.okInclude) stats[g].inc++;
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "-");
const typeOk = cases.filter((c) => c.okType).length;
const incOk = cases.filter((c) => c.okInclude).length;

console.log(`cases: ${cases.length}   types: ${new Set(cases.map((c) => c.wantType)).size}   space types available: ${Object.keys(SPACE_TYPES).length}`);
console.log(`type accuracy   : ${typeOk}/${cases.length} = ${pct(typeOk, cases.length)}`);
console.log(`include accuracy: ${incOk}/${cases.length} = ${pct(incOk, cases.length)}`);
console.log("\nby group:");
for (const [g, s] of Object.entries(stats).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${g.padEnd(12)} n=${String(s.n).padStart(3)}  type ${pct(s.type, s.n).padStart(6)}  include ${pct(s.inc, s.n).padStart(6)}`);
}
console.log("\nmismatches:");
for (const c of cases) {
  if (c.okType && c.okInclude) continue;
  const bits = [];
  if (!c.okType) bits.push(`type got "${guessSpaceType(c.name)}" want "${c.wantType}"`);
  if (!c.okInclude) bits.push(`include got ${!NON_AC_WORDS.test(c.name)} want ${c.wantInclude}`);
  console.log(`  ${c.name.padEnd(26)} ${bits.join("; ")}`);
}
if (verbose) {
  console.log("\nall cases:");
  for (const c of cases) {
    console.log(`  ${(c.okType && c.okInclude ? "ok " : "BAD")} ${c.name.padEnd(26)} -> ${guessSpaceType(c.name).padEnd(11)} include=${!NON_AC_WORDS.test(c.name)}`);
  }
}
const failed = typeOk === cases.length && incOk === cases.length;
fs.writeFileSync("tests/qa/roomtype-baseline.json", JSON.stringify({ cases, stats, typeOk, incOk }, null, 1));
console.log(`\nwritten to tests/qa/roomtype-baseline.json`);
process.exit(failed ? 0 : 0);   // a baseline is a measurement, not a gate

// tests/test-area-source.mjs — every area in the table says WHERE IT CAME FROM.
//
// The scale banner claims "areas use 1:228, taken from the sheet's own printed room areas", and the
// owner's (correct) objection was that this is unverifiable from the table: a number sits in the Area
// column with nothing saying whether it was printed on his drawing, measured from its linework, typed
// by him, or imported. This file pins the per-row answer.
//
// js/app.js is a browser script with no exports, so the pure function is lifted out of its source text
// by brace-matching (the same technique as tests/qa/scale-banner-hq.mjs) and compiled here. That means
// this test reads the SHIPPED text, not a copy of it.
//
//   node tests/test-area-source.mjs
import fs from "node:fs";

const src = fs.readFileSync(new URL("../js/app.js", import.meta.url), "utf8");

function lift(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in js/app.js`);
  let depth = 0, end = -1, seen = false;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") { depth += 1; seen = true; }
    else if (c === "}") { depth -= 1; if (seen && depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error(`could not brace-match ${name}`);
  return src.slice(start, end);
}

const areaSourceOf = new Function(`${lift("areaSourceOf")}; return areaSourceOf;`)();

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("area provenance: every area says where it came from");
{
  const printed = areaSourceOf({ area: 24.5, source: "label", page: 2 });
  eq("a label-parsed area is 'printed'", printed && printed.label, "printed");
  ok("its tooltip names the page it was read from", /page 2/.test(printed.title), printed.title);
  ok("its tooltip says it was NOT measured", /not measured/.test(printed.title), printed.title);
  eq("a table-parsed area is 'printed'", areaSourceOf({ area: 12, source: "table", page: 1 }).label, "printed");
  eq("a pdf-sourced area is 'printed'", areaSourceOf({ area: 12, source: "pdf" }).label, "printed");

  eq("a hand-typed area is 'typed'", areaSourceOf({ area: 12, source: "manual" }).label, "typed");
  eq("a CSV area says CSV/Excel", areaSourceOf({ area: 12, source: "schedule" }).label, "CSV/Excel");
  eq("an OCR area says OCR", areaSourceOf({ area: 12, source: "ocr" }).label, "OCR");
  eq("a hand-drawn shape says drawn", areaSourceOf({ area: 12, source: "drawn" }).label, "drawn");
}

console.log("\narea provenance: no chip where it would be noise or a guess");
{
  eq("a traced-fill area is left to areaBadge() (no double badge)",
    areaSourceOf({ area: 10, source: "label", areaFromDrawing: true }), null);
  eq("no area => nothing to attribute", areaSourceOf({ area: null, source: "label" }), null);
  eq("zero area => nothing to attribute", areaSourceOf({ area: 0, source: "label" }), null);
  eq("a negative area is not attributed", areaSourceOf({ area: -5, source: "label" }), null);
  eq("an unknown source is not guessed at", areaSourceOf({ area: 10, source: "martian" }), null);
  eq("no room object", areaSourceOf(null), null);
  eq("a room with no source field is not guessed at", areaSourceOf({ area: 10 }), null);
}

console.log("\narea provenance: the tooltip is text, never markup");
{
  const t = areaSourceOf({ area: 1, source: "label", page: 3 }).title;
  ok("no angle brackets can be injected", !/[<>]/.test(t), t);
}

console.log(`\narea source: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("ALL AREA-SOURCE CHECKS PASSED");

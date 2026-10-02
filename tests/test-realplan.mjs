// Real-world regression for a floor plan that prints room NAMES but NO AREAS.
//
// The sheet is a public-domain office plan from Wikimedia Commons — "LEVEL_11_FLOOR_PLAN.pdf.pdf"
// (a Level 11 floor plan, "SCALE 1:100", CC BY-SA 4.0) — that carried a vector text layer of 70
// strings but not a single area figure. Before the fix this produced ZERO rooms ("no rooms found in
// this PDF"), which is the worst possible first impression for a plan a user paid traffic to reach.
//
// The file lives in infra/.tmp/plans/ (it is NOT committed). The test SKIPS LOUDLY, by name, when the
// file is absent — so a checkout without the plan still goes green rather than failing on a missing
// artefact — and asserts hard against it when it is present (the dev machine).
//
//   cd D:/webhvac && node tests/test-realplan.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUpload } from "../lib/parse.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.join(HERE, "..", "infra", ".tmp", "plans", "LEVEL_11_FLOOR_PLAN.pdf.pdf");

if (!fs.existsSync(PDF)) {
  console.log(
    `SKIP  ${path.basename(PDF)} is not on disk — the real-world plan suite did not run.\n` +
      `      It is a public-domain fixture kept in infra/.tmp/plans/ and deliberately not committed.\n` +
      `      Everything else in this repo still gates; this one suite only runs where the plan exists.`
  );
  process.exit(0);
}

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, null]); }
  catch (err) { checks.push([name, err]); }
};

const buf = fs.readFileSync(PDF);
// the SAME code path the Express server uses (/api/parse -> lib/parse.js -> js/pdfparse.js)
const out = await parseUpload({ originalname: "LEVEL_11_FLOOR_PLAN.pdf.pdf", buffer: buf });

const rooms = out.rooms || [];

check("the sheet parses as one page", () => assert.equal(out.pages, 1));
check("the parser recovers a large room list (measured 56; the sheet prints only 70 text strings)", () =>
  assert.ok(rooms.length >= 40, `expected >= 40 rooms, got ${rooms.length}`));
check("every recovered room carries a name of at least two letters", () => {
  for (const r of rooms) {
    assert.equal(typeof r.name, "string", `room ${r.id} has no name`);
    assert.ok(/[A-Za-z]{2}/.test(r.name), `room ${r.id} has a junk name ${JSON.stringify(r.name)}`);
  }
});
check("no room fabricates an area: every area is explicitly unknown (area null + areaUnknown)", () => {
  for (const r of rooms) {
    assert.equal(r.area, null, `room "${r.name}" carries area ${r.area} — must be null`);
    assert.equal(r.areaUnknown, true, `room "${r.name}" is not flagged areaUnknown`);
  }
});
check("no room carries a finite positive area anywhere in the record", () => {
  for (const r of rooms) {
    assert.ok(!(typeof r.area === "number" && r.area > 0), `room "${r.name}" invented area ${r.area}`);
  }
});
check("unknown-area rooms are excluded from the load (include false)", () => {
  for (const r of rooms) assert.equal(r.include, false, `room "${r.name}" is include:true with no area`);
});
check("every room keeps the point that names it (a finite at{x,y} for the plan overlay)", () => {
  for (const r of rooms) {
    assert.ok(r.at && Number.isFinite(r.at.x) && Number.isFinite(r.at.y),
      `room "${r.name}" has no usable position: ${JSON.stringify(r.at)}`);
  }
});
check("the known room names from the sheet are present", () => {
  const names = new Set(rooms.map((r) => r.name));
  for (const n of ["MEETING ROOM", "CONFERENCE ROOM", "PRESS SEATING", "TRANSCRIPT ROOM",
    "PUBLIC SEATING", "HEARING ROOM", "QUIET ROOM", "BLACK SATURDAY GALLERY"]) {
    assert.ok(names.has(n), `expected room name "${n}" — got ${JSON.stringify([...names].sort())}`);
  }
});
check("a plain area warning names the count and the remedy", () => {
  const n = rooms.filter((r) => r.areaUnknown).length;
  const re = new RegExp(`no printed areas found - ${n} room names? detected`);
  const hit = (out.warnings || []).find((w) => re.test(w));
  assert.ok(hit, `no warning matching ${re} in ${JSON.stringify(out.warnings)}`);
  assert.ok(/typing it in the table|trac(e|ing) the plan/i.test(hit), `the warning names no remedy: ${hit}`);
});
check("the parse does not fall through to 'no rooms found in this PDF'", () =>
  assert.ok(!(out.warnings || []).some((w) => /no rooms found/i.test(w))));
check("rooms come back through lib/parse.js with the file stamped and the count intact", () => {
  assert.equal(out.roomCount, rooms.length);
  assert.ok(rooms.every((r) => r.sourceFile === "LEVEL_11_FLOOR_PLAN.pdf.pdf"));
  assert.ok(rooms.every((r) => r.source === "label"));
});

// ---------------------------------------------------------------- report
let pass = 0;
const failures = [];
for (const [name, err] of checks) {
  if (err) { failures.push(name); console.log(`  FAIL  ${name}`); console.log("        " + (err.message || err)); }
  else { pass++; console.log(`  PASS  ${name}`); }
}
console.log(`\nreal-world plan (NAME-only sheet): rooms ${rooms.length}, all areas unknown`);
console.log(`${pass}/${checks.length} real-plan checks passed`);
if (failures.length) process.exit(1);
console.log("ALL REAL-PLAN CHECKS PASSED");

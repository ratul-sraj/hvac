// tests/test-basis.mjs — the design basis must never let an unsourced figure pass as settled.
import * as basis from "../js/basis.js";
import { DEFAULT_PROJECT } from "../js/calc.js";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass += 1; console.log("  ok  " + name); }
  else { fail += 1; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
}

console.log("basis: a fresh basis is entirely unconfirmed");
const b0 = basis.makeBasis();
ok("every field has an entry", basis.BASIS_FIELDS.every((f) => b0.entries[f.id]));
ok("nothing is confirmed yet", Object.values(b0.entries).every((e) => e.status === "unconfirmed" || e.status === "missing"));
ok("the load is blocked", basis.basisStats(b0).complete === false);
ok("the gate names the gap count", basis.basisGaps(b0).length > 0);
ok("the line says INCOMPLETE", /INCOMPLETE/.test(basis.basisLine(b0)));

console.log("basis: every figure without a code citation says so in words");
const uncited = basis.BASIS_FIELDS.filter((f) => f.kind === "practice");
ok("practice figures exist", uncited.length > 0);
ok("each practice figure carries a note explaining its provenance",
  uncited.every((f) => typeof f.cite === "string" && f.cite.length > 20),
  uncited.filter((f) => !(f.cite || "").length).map((f) => f.id).join(","));
ok("the ventilation figure states there is no code rate",
  /NO code citation/.test(basis.BASIS_FIELDS.find((f) => f.id === "oap").cite));

console.log("basis: values come from the project, so the two cannot disagree");
const b1 = basis.basisFromProject(Object.assign({}, DEFAULT_PROJECT));
ok("wall U is the project's", b1.entries.uWall.value === Number(DEFAULT_PROJECT.uWall));
ok("outdoor dry bulb is the project's", b1.entries.outDb.value === Number(DEFAULT_PROJECT.outDb));
ok("an unconfirmed project value still blocks the total", basis.basisStats(b1).complete === false);
ok("the gap reason names a practice value",
  basis.basisGaps(b1).some((g) => g.id === "uWall" && /practice/.test(g.reason)));

console.log("basis: a climate row carries its station provenance");
const b2 = basis.basisFromProject(Object.assign({}, DEFAULT_PROJECT), {
  db: 34.6, wb: 27.8, station: "KOCHI/CIAL", cite: "ASHRAE 2021 Fundamentals Ch.14 (via js/climates.js)",
});
ok("the climate figure is marked as climate-sourced", b2.entries.outDb.kind === "climate");
ok("the station is recorded", /KOCHI/.test(b2.entries.outDb.station || ""));
ok("a climate figure with a station does not need hand-confirming",
  !basis.basisGaps(b2).some((g) => g.id === "outDb" || g.id === "outWb"));
const b2i = basis.basisFromProject(Object.assign({}, DEFAULT_PROJECT), { db: 34.6, wb: 27.8, indicative: true, station: "Kochi (estimated)" });
ok("an INDICATIVE climate row does block, and says why",
  basis.basisGaps(b2i).some((g) => g.id === "outDb" && /no station/.test(g.reason)));
const b2n = basis.basisFromProject(Object.assign({}, DEFAULT_PROJECT));
ok("outdoor conditions with no provenance at all block too",
  basis.basisGaps(b2n).some((g) => g.id === "outDb" && /no station/.test(g.reason)));

console.log("basis: confirming every figure completes it, and it says so");
const b3 = basis.basisFromProject(Object.assign({}, DEFAULT_PROJECT));
for (const g of basis.basisGaps(b3)) basis.confirmField(b3, g.id, "Ratul S", "2026-10-16");
ok("no gaps remain", basis.basisGaps(b3).length === 0);
ok("complete", basis.basisStats(b3).complete === true);
ok("the line reports the provenance mix", /Design basis complete/.test(basis.basisLine(b3)) &&
  /confirmed by the engineer/.test(basis.basisLine(b3)));

console.log("basis: a deleted figure blocks again, whatever was confirmed before");
const b4 = basis.basisFromProject(Object.assign({}, DEFAULT_PROJECT));
for (const g of basis.basisGaps(b4)) basis.confirmField(b4, g.id, "Ratul S", "2026-10-16");
b4.entries.uWall.value = null; b4.entries.uWall.status = "missing";
ok("a blanked figure is a gap again", basis.basisGaps(b4).some((g) => g.id === "uWall" && g.reason === "no value"));
ok("and the basis is not complete", basis.basisStats(b4).complete === false);

console.log("basis: a hand-typed figure is recorded as theirs, never as sourced");
const b5 = basis.basisFromProject(Object.assign({}, DEFAULT_PROJECT));
basis.setField(b5, "uWall", 0.42, "Ratul S", "2026-10-16", "ECBC-compliant assembly from the spec.");
ok("value took", b5.entries.uWall.value === 0.42);
ok("marked typed, not cited", b5.entries.uWall.status === "typed");
ok("kind downgraded to practice", b5.entries.uWall.kind === "practice");
ok("the note keeps the reason", /spec/.test(b5.entries.uWall.note));

console.log("\nbasis: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

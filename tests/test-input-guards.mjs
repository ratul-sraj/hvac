// Input-guard tests for js/calc.js — negative geometry, comma numbers, impossible design
// conditions and the area<=0 rule. Pure Node, no DOM, no pdf.js.
//
//   cd D:/webhvac && node tests/test-input-guards.mjs
//
// These are the P1/P2 defects from the engine review: a room could come out with a NEGATIVE TR and
// silently subtract from the project total, "1,249.3" was read as 1 m², and an impossible design
// pair printed "outdoor RH 137 %". Each check below pins the fixed behaviour.
import assert from "node:assert/strict";
import {
  num, calcRoom, calcProject, projectWarnings, DEFAULT_PROJECT, wFromDbRh,
} from "../js/calc.js";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const allNonNegative = (obj) => Object.values(obj).every((v) => Number.isFinite(v) && v >= 0);
const P = DEFAULT_PROJECT;

// ---------- comma-aware number parsing ----------------------------------------
// parseFloat alone stops at the comma: "1,249.3" used to become 1, and 1 m² gives 0.211 TR.
ok('plain decimal still parses', num("1249.3") === 1249.3 && num(45.5) === 45.5);
ok('comma thousands + dot decimal parses (1,249.3 -> 1249.3)', num("1,249.3") === 1249.3);
ok('dot thousands + comma decimal parses (1.249,3 -> 1249.3)', num("1.249,3") === 1249.3);
ok('single comma + 1-2 digits is a decimal comma (12,5 -> 12.5)', num("12,5") === 12.5);
ok('a 3-digit comma group is read as thousands (1,249 -> 1249)', num("1,249") === 1249);
ok('blank/NaN falls back to the default', num("") === 0 && num("abc", 7) === 7);

const typedComma = calcRoom({ name: "Office", area: "1,249.3" }, P);
const typedPlain = calcRoom({ name: "Office", area: 1249.3 }, P);
ok('area typed "1,249.3" loads as 1249.3 m2, not 1 m2',
  near(num(typedComma.room.area), 1249.3) && near(typedComma.tr, typedPlain.tr, 0.01) && typedComma.tr > 30,
  `${typedComma.tr.toFixed(3)} TR`);
const euroComma = calcRoom({ name: "Office", area: "12,5" }, P);
const euroPlain = calcRoom({ name: "Office", area: 12.5 }, P);
ok('area typed "12,5" loads as 12.5 m2 (European decimal comma)',
  near(num(euroComma.room.area), 12.5) && near(euroComma.tr, euroPlain.tr, 0.01),
  `${euroComma.tr.toFixed(3)} TR`);

// ---------- P1: negative geometry can no longer subtract from a total ----------
const negArea = calcRoom({ name: "Office", area: -50 }, P);
ok('negative area gives 0 TR, not the old -0.844 TR',
  negArea.tr === 0 && negArea.totalW === 0, `${negArea.tr.toFixed(3)} TR`);
ok('negative-area room carries no people, no fresh air, no supply air',
  negArea.room.people === 0 && negArea.oaLs === 0 && negArea.supplyLs === 0);
ok('negative-area room warns plainly', negArea.warnings.some((w) => /negative/i.test(w) && /area/i.test(w)),
  negArea.warnings.join(" | "));

const negHeight = calcRoom({ name: "Office", length: 10, width: 10, height: -3 }, P);
ok('negative height gives a positive load, not the old -1.928 TR',
  negHeight.tr > 0 && Number.isFinite(negHeight.tr), `${negHeight.tr.toFixed(3)} TR`);
ok('negative height is clamped into the 0.5–10 m band', negHeight.room.height === 0.5,
  `${negHeight.room.height} m`);
ok('negative height warns plainly', negHeight.warnings.some((w) => /height/i.test(w)));
ok('negative-height room has no negative heat-gain term',
  allNonNegative(negHeight.sensible) && allNonNegative(negHeight.latent));

// glass clamp direction: it used to pick the MORE negative of (glass, extWall), so an 18 m² wall
// with 200 m² of glass clamped to 18 — but -9 vs -30 clamped to -30 and went negative.
const bigGlass = calcRoom({ name: "Office", area: 100, glass: 200, extWall: 18 }, P);
ok('glass larger than its wall is clamped to the wall (18 m²)',
  near(bigGlass.sensible.glassSolar, 18 * 470 * 0.6), bigGlass.sensible.glassSolar.toFixed(1));
ok('clamped glass leaves no negative net wall', bigGlass.sensible.wall === 0);

const negGlass = calcRoom({ name: "Office", area: 100, glass: -5, extWall: 30 }, P);
ok('negative glass contributes no solar and no conduction',
  negGlass.sensible.glassSolar === 0 && negGlass.sensible.glassCond === 0);
ok('negative glass leaves the full wall to conduct',
  near(negGlass.sensible.wall, 30 * 2.0 * 15), negGlass.sensible.wall.toFixed(1));

const negBoth = calcRoom({ name: "Office", length: 10, width: 10, height: -3, glass: -30, extWall: -30 }, P);
ok('negative glass AND negative wall still cannot make the room negative',
  negBoth.tr > 0 && allNonNegative(negBoth.sensible), `${negBoth.tr.toFixed(3)} TR`);

const negLoads = calcRoom({ name: "Office", area: 100, people: -5, light: -10, equip: -3 }, P);
ok('negative people/light/equip are treated as 0',
  near(negLoads.tr, calcRoom({ name: "Office", area: 100, people: 0, light: 0, equip: 0 }, P).tr),
  `${negLoads.tr.toFixed(3)} TR`);
ok('negative people/light/equip warn plainly', negLoads.warnings.some((w) => /negative/i.test(w)));

// ---------- area <= 0: the room contributes 0 load (guide: "no area, no load") ----------
const zeroArea = calcRoom({ name: "Office", area: 0 }, P);
ok('a 0 m² room contributes 0 TR (it used to add 0.075 TR)',
  zeroArea.tr === 0 && zeroArea.totalW === 0, `${zeroArea.tr.toFixed(4)} TR`);
ok('a 0 m² room has 0 people and no fresh air',
  zeroArea.room.people === 0 && zeroArea.oaLs === 0 && zeroArea.oaSens === 0 && zeroArea.oaLat === 0);
ok('a 0 m² room has 0 supply air and no NaN', zeroArea.supplyLs === 0 && zeroArea.sqftPerTr === 0);
ok('a 0 m² room warns that it counts as no load', zeroArea.warnings.some((w) => /no area/i.test(w)));

const one = calcProject([{ name: "Office A", area: 100, orient: "W" }], P);
const onePlusZero = calcProject([
  { name: "Office A", area: 100, orient: "W" },
  { name: "Office B", area: 0, orient: "W" },
], P);
ok('a 0 m² room cannot change the project total',
  near(onePlusZero.totals.tr, one.totals.tr) && near(onePlusZero.totals.area, one.totals.area),
  `${one.totals.tr.toFixed(3)} vs ${onePlusZero.totals.tr.toFixed(3)} TR`);
const onePlusNeg = calcProject([
  { name: "Office A", area: 100, orient: "W" },
  { name: "Office B", area: -250, orient: "W" },
], P);
ok('a negative-area room cannot shrink the project total or the conditioned area',
  near(onePlusNeg.totals.tr, one.totals.tr) && near(onePlusNeg.totals.area, one.totals.area),
  `${onePlusNeg.totals.area.toFixed(1)} m²`);

// ---------- P2: impossible design conditions warn and stay physical ----------
const hotWb = calcProject([{ name: "Office", area: 100, orient: "W" }], { ...P, outWb: 40 });
ok('outWb > outDb is warned about', hotWb.warnings.some((w) => /wet bulb/i.test(w)),
  hotWb.warnings.join(" | "));
ok('outWb > outDb can no longer print an outdoor RH above 100 %',
  hotWb.totals.outRh <= 100.0001 && hotWb.totals.outRh > 99,
  `${hotWb.totals.outRh.toFixed(1)} %`);
ok('outWb > outDb keeps every project total finite',
  Object.values(hotWb.totals).every((v) => typeof v !== "number" || Number.isFinite(v)));
ok('projectWarnings() reports the same (the app\'s warnings channel)',
  projectWarnings({ ...P, outWb: 40 }).length === 1);

const coldOut = calcRoom({ name: "Office", length: 10, width: 10 }, { ...P, outDb: 30, inDb: 35 });
ok('outDb <= inDb is warned about',
  projectWarnings({ ...P, outDb: 30, inDb: 35 }).some((w) => /dry bulb/i.test(w)));
ok('outDb <= inDb clamps reverse conduction to zero instead of keeping a negative gain',
  coldOut.sensible.glassCond === 0 && coldOut.sensible.infiltration === 0 && coldOut.oaSens === 0);
ok('outDb <= inDb still gives a physical (positive) load', coldOut.tr > 0, `${coldOut.tr.toFixed(3)} TR`);

const wet = calcProject([{ name: "Office", area: 100, orient: "W" }], { ...P, inRh: 120 });
ok('indoor RH > 100 % is warned about', wet.warnings.some((w) => /rh/i.test(w)));
ok('indoor RH > 100 % is computed at saturation',
  near(wet.totals.wIn, wFromDbRh(P.inDb, 100), 0.0005),
  `wIn ${wet.totals.wIn.toFixed(5)}`);

// ---------- no false positives on a clean project ----------
const clean = calcProject([
  { name: "Office", area: 100, orient: "W" },
  { name: "MEETING RM.", length: 10, width: 10 },
], P);
ok('a normal project produces no warnings', clean.warnings.length === 0,
  clean.warnings.join(" | "));
ok('the default reference room is unchanged (5.14 TR, SHF 0.855)',
  calcRoom({ name: "Office", length: 10, width: 10, orient: "W", roof: true }, P).tr.toFixed(2) === "5.14" &&
  calcRoom({ name: "Office", length: 10, width: 10, orient: "W", roof: true }, P).shf.toFixed(3) === "0.855");
ok('an excluded room adds no warning', calcProject([{ name: "Toilet", area: 0 }], P).warnings.length === 0);
ok('calcProject always returns a warnings array',
  Array.isArray(calcProject([], P).warnings) && Array.isArray(projectWarnings()));

// touch assert so the import is not dead if the checks above are ever refactored away
assert.equal(typeof num, "function");

console.log(`\n${pass}/${pass + fail} input-guard checks passed`);
if (fail) { console.log(`${fail} FAILED`); process.exit(1); }
console.log("ALL INPUT-GUARD CHECKS PASSED");

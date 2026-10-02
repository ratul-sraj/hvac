// Tests for the safety-factor guard in js/calc.js.
//
//   cd D:/webhvac && node tests/test-calc-safety.mjs
//
// The bug these guard against: `js/calc.js` computed the room heat with `1 + p.safety / 100` straight
// from the raw project field. An imported project with a NON-NUMERIC safety made the whole project
// total NaN (every room's load, the reported TR and the CSV), and a NEGATIVE safety was accepted
// unclamped — so a "safety" allowance silently REDUCED the load. A safety factor can only ever add.
import { calcProject, calcRoom, normalizeRoom, projectWarnings, safeSafetyPct, SAFETY_MIN, SAFETY_MAX, DEFAULT_PROJECT }
  from "../js/calc.js";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const rooms = [
  { id: "r1", name: "Office A", level: "Ground", area: 30, height: 3, type: "office", orient: "W", include: true, people: 3 },
  { id: "r2", name: "Office B", level: "Ground", area: 20, height: 3, type: "office", orient: "S", include: true, people: 2 },
];
const base = { ...DEFAULT_PROJECT, name: "Safety guard test" };

// ---- the reference: a normal 10 % project ------------------------------------------------
const ten = calcProject(rooms, base);
ok("a normal project computes a finite total", Number.isFinite(ten.totals.tr) && ten.totals.tr > 0,
  `${ten.totals.tr.toFixed(2)} TR`);
ok("the reported safety percentage is 10", ten.totals.safetyPct === 10, String(ten.totals.safetyPct));

// ---- 1. a non-numeric safety must not NaN the whole project ------------------------------
const abc = calcProject(rooms, { ...base, safety: "abc" });
ok("a non-numeric safety no longer NaNs the total",
  Number.isFinite(abc.totals.tr) && abc.totals.tr > 0, `${abc.totals.tr} TR`);
ok("a non-numeric safety falls back to the default 10 % (same load as 10 %)",
  near(abc.totals.tr, ten.totals.tr, 0.001), `${abc.totals.tr.toFixed(4)} vs ${ten.totals.tr.toFixed(4)} TR`);
ok("every room's own load is finite too",
  abc.results.every((r) => Number.isFinite(r.tr) && Number.isFinite(r.rsh)),
  abc.results.map((r) => r.tr).join(", "));

// ---- 2. a wild value is clamped, in both directions --------------------------------------
const huge = calcProject(rooms, { ...base, safety: 5000 });
const capped = calcProject(rooms, { ...base, safety: SAFETY_MAX });
ok(`a wild safety (5000 %) is clamped to ${SAFETY_MAX} %`,
  near(huge.totals.tr, capped.totals.tr, 0.001) && huge.totals.safetyPct === SAFETY_MAX,
  `${huge.totals.tr.toFixed(4)} TR, reported ${huge.totals.safetyPct} %`);

const neg = calcProject(rooms, { ...base, safety: -25 });
const zero = calcProject(rooms, { ...base, safety: 0 });
ok("a negative safety is clamped to 0 % (never reduces the load)",
  near(neg.totals.tr, zero.totals.tr, 0.001) && neg.totals.safetyPct === SAFETY_MIN,
  `${neg.totals.tr.toFixed(4)} TR, reported ${neg.totals.safetyPct} %`);
ok("the clamped total is never below the raw project's total",
  neg.totals.tr >= zero.totals.tr - 1e-9, `${neg.totals.tr.toFixed(4)} vs ${zero.totals.tr.toFixed(4)}`);

// ---- 3. safeSafetyPct is the one place the rule lives ------------------------------------
ok("safeSafetyPct('abc') is the default", safeSafetyPct({ safety: "abc" }) === DEFAULT_PROJECT.safety,
  String(safeSafetyPct({ safety: "abc" })));
ok("safeSafetyPct(undefined) is the default", safeSafetyPct({}) === DEFAULT_PROJECT.safety);
ok("safeSafetyPct(-5) is 0", safeSafetyPct({ safety: -5 }) === 0);
ok("safeSafetyPct(1e9) is the cap", safeSafetyPct({ safety: 1e9 }) === SAFETY_MAX);
ok("a normal value passes through unchanged", safeSafetyPct({ safety: 12.5 }) === 12.5);

// ---- 4. the warning channel says what was changed ----------------------------------------
const warned = projectWarnings({ ...base, safety: -25 });
ok("projectWarnings() explains a clamped safety factor",
  warned.some((w) => /safety factor/i.test(w) && /0\s*%/.test(w)), warned.join(" | ").slice(0, 160));
const clean = projectWarnings(base);
ok("projectWarnings() is silent for a normal safety factor",
  !clean.some((w) => /safety factor/i.test(w)), clean.join(" | ").slice(0, 160));

console.log(`\n${pass}/${pass + fail} safety-guard checks passed`);
if (fail) process.exit(1);
console.log("ALL SAFETY GUARD CHECKS PASSED");

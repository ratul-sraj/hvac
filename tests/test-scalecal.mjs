// tests/test-scalecal.mjs — the drawing-scale decision rule (js/scalecal.js).
//
// This file pins WHICH estimate wins. That rule was deliberately NOT changed: a strong E2 (the
// sheet's own printed m² figures) wins, E3 only when there is no usable note, and E1 alone is a
// medium read. It also pins the owner's real HQ case — the title-block note says 1:200 while the
// sheet's own printed areas only reconcile at ~1:228 — so a future tweak cannot silently flip it.
//
// Node only: scalecal.js is pure (no DOM, no pdf.js), so this gates in CI with no browser.
import { calibrateScale, scaleTextEstimate, replotFlag } from "../js/scalecal.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("scalecal: the HQ case — the sheet's own printed areas beat the title-block note");
{
  // MEASURED on C:/Users/Aorus/Downloads/HEADQUARTERS FLOOR DUCTING.pdf (zone-accuracy --split, 403 s):
  //   E1 {denom 200, count 1, distinct 1}  E2 {denom 228, strong true, n 18, total 25}
  //   E3 {denom 144, band 127-178, n 4}    -> scale(1:228, E2, conflict)
  const E1 = { values: [200], count: 1, distinct: 1 };
  const E2 = { denom: 228, strong: true, n: 18, total: 25 };
  const E3 = { denom: 144, band: { lo: 127, hi: 178 }, n: 4 };
  const cal = calibrateScale({ E1, E2, E3, box: null });
  eq("the applied scale is the sheet's printed areas, 1:228", cal.denom, 228);
  eq("source names E2", cal.source, "E2");
  eq("the note-vs-areas disagreement is reported as a conflict (LOUD)", cal.confidence, "conflict");
  ok("the conflict names the note (its value is available to the banner)",
    cal.estimates.E1.denom === 200 && /200/.test(cal.conflict.note), cal.conflict && cal.conflict.note);
}

console.log("scalecal: a repeated note still does NOT outrank the arcs (rule unchanged)");
{
  // Two identical notes and a strong arc window that disagrees: E3 still wins. This is the rule the
  // owner explicitly asked to keep — the note never overrides the object prior by itself.
  const E1twice = scaleTextEstimate([{ str: "1 :200" }, { str: "1 :200" }]);
  ok("E1 really carries the note twice", E1twice.count === 2 && E1twice.distinct === 1);
  const strong = calibrateScale({ E1: E1twice, E2: null, E3: { denom: 226, band: { lo: 218, hi: 236 }, n: 12 }, box: null });
  eq("with a strong arc window (n>=8) E3 wins", strong.denom, 226);
  eq("source E3", strong.source, "E3");
  eq("confidence conflict", strong.confidence, "conflict");

  const weak = calibrateScale({ E1: E1twice, E2: null, E3: { denom: 226, band: { lo: 218, hi: 236 }, n: 3 }, box: null });
  eq("with a weak arc window (n<8) NO automatic scale is applied", weak.denom, null);
  eq("confidence none", weak.confidence, "none");
}

console.log("scalecal: the remaining paths are unchanged");
{
  const E1 = { values: [100], count: 1, distinct: 1 };
  const agree = calibrateScale({ E1, E2: null, E3: { denom: 100, band: { lo: 85, hi: 129 }, n: 21 }, box: null });
  eq("E1 and E3 agree => E1+E3 high", `${agree.denom}/${agree.source}/${agree.confidence}`, "100/E1+E3/high");

  const e2win = calibrateScale({ E1: { values: [200], count: 1, distinct: 1 }, E2: { denom: 250, strong: true, n: 10, total: 12 }, E3: { denom: 226, band: { lo: 218, hi: 236 }, n: 12 }, box: null });
  eq("a strong E2 wins regardless of E1", e2win.denom, 250);
  eq("source E2", e2win.source, "E2");

  const e1only = calibrateScale({ E1: { values: [200], count: 1, distinct: 1 }, E2: null, E3: null, box: null });
  eq("E1 with no arcs is E1/medium", `${e1only.denom}/${e1only.source}/${e1only.confidence}`, "200/E1/medium");

  const e3only = calibrateScale({ E1: null, E2: null, E3: { denom: 226, band: { lo: 218, hi: 236 }, n: 12 }, box: null });
  eq("E3 with no note is E3/medium", `${e3only.denom}/${e3only.source}/${e3only.confidence}`, "226/E3/medium");

  // E4 is a rejection only: a page whose extent x N leaves the 5-300 m building band is unusable.
  const tiny = calibrateScale({ E1: { values: [200], count: 1, distinct: 1 }, E2: null, E3: null, box: { x0: 0, y0: 0, x1: 10, y1: 20 } });
  eq("E4 rejects a denominator that is physically insane for the page", tiny.denom, null);
  eq("...and reports confidence none", tiny.confidence, "none");
}

console.log("scalecal: pure and deterministic");
{
  const args = { E1: { values: [200], count: 1, distinct: 1 }, E2: { denom: 228, strong: true, n: 18, total: 25 }, E3: { denom: 144, band: { lo: 127, hi: 178 }, n: 4 }, box: null };
  ok("same input => byte-identical output",
    JSON.stringify(calibrateScale(args)) === JSON.stringify(calibrateScale(args)));
  eq("replotFlag is exposed for callers (2.0 for an exact double)", replotFlag(200, 400), 2);
}

console.log(`\nscalecal: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("ALL SCALECAL CHECKS PASSED");

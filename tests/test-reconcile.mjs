// tests/test-reconcile.mjs — an area that cannot be checked must never read like one that was.
import { reconcileAreas, reconcileRoom, reconcileLine, areaSources } from "../js/reconcile.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass += 1; console.log("  ok  " + name); }
  else { fail += 1; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
};
const room = (extra) => Object.assign({ id: "r1", name: "TEST ROOM", include: true, height: 3, type: "office" }, extra);

console.log("reconcile: two independent figures, inside tolerance");
const agree = reconcileRoom(room({ areaStated: 20, area: 20.4, areaFromDrawing: true, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] }));
ok("verdict is agree", agree.verdict === "agree", agree.verdict);
ok("the gap is measured in percent", Math.abs(agree.diffPct - 2) < 0.01, String(agree.diffPct));
ok("the note names both figures", /20\.4/.test(agree.note) && /20/.test(agree.note), agree.note);

console.log("reconcile: two independent figures, outside tolerance is a FLAG, not a rounding");
const flag = reconcileRoom(room({ areaStated: 20, area: 23.5, areaFromDrawing: true, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] }));
ok("verdict is flag", flag.verdict === "flag", flag.verdict);
ok("the percentage is kept", Math.abs(flag.diffPct - 17.5) < 0.01, String(flag.diffPct));
ok("the note states the disagreement in words", /17\.5% apart/.test(flag.note), flag.note);
ok("a 5% gap is exactly on the line (agree)", reconcileRoom(room({ areaStated: 20, area: 21, areaFromDrawing: true, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] })).verdict === "agree");
ok("a 5.1% gap is over it (flag)", reconcileRoom(room({ areaStated: 20, area: 21.02, areaFromDrawing: true, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] })).verdict === "flag");

console.log("reconcile: a placed box is NOT an independent check");
const box = room({ areaStated: 42, area: 42, rect: { x: 0, y: 0, w: 7, h: 6, placed: true }, areaFromDrawing: false });
const boxRow = reconcileRoom(box);
ok("a box is never called agreement", boxRow.verdict === "sheet-derived", boxRow.verdict);
ok("and it says why", /cannot check it/.test(boxRow.note), boxRow.note);
ok("its own sources show a sheet figure and no geometry", (() => { const s = areaSources(box); return s.sheet === 42 && s.geometry === null; })());

console.log("reconcile: geometry with no printed figure is unchecked, and says so");
const geoOnly = reconcileRoom(room({ area: 16.2, areaFromDrawing: true, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] }));
ok("verdict is unchecked", geoOnly.verdict === "unchecked", geoOnly.verdict);
ok("the note says the sheet prints no area", /prints no area/.test(geoOnly.note), geoOnly.note);

console.log("reconcile: a hand-entered figure is the engineer's, and is labelled as such");
const typed = reconcileRoom(room({ area: 18, areaTyped: true }));
ok("verdict is typed", typed.verdict === "typed", typed.verdict);
ok("labelled 'entered by hand'", /entered by hand/.test(typed.note), typed.note);
ok("a typed figure beats a geometry measurement", (() => {
  const r = reconcileRoom(room({ area: 18, areaTyped: true, areaStated: 20, area: 30, areaFromDrawing: true, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] }));
  return r.verdict === "typed";
})(), "typed wins");

console.log("reconcile: a room with no area at all");
ok("verdict none", reconcileRoom(room({})).verdict === "none");
ok("an excluded room is left out of the sheet summary", (() => {
  const res = reconcileAreas([room({}), room({ id: "r2", include: false, area: 10 })]);
  return res.summary.rooms === 1;
})(), "");

console.log("reconcile: the sheet-level summary");
const res = reconcileAreas([
  room({ id: "a", areaStated: 20, area: 20.3, areaFromDrawing: true, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] }),
  room({ id: "b", areaStated: 30, area: 36, areaFromDrawing: true, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] }),
  room({ id: "c", area: 12.5, areaFromDrawing: true, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] }),
  room({ id: "d", areaStated: 15, rect: { x: 0, y: 0, w: 5, h: 3, placed: true } }),
  room({ id: "e", area: 9, areaTyped: true }),
  room({ id: "f" }),
]);
const s = res.summary;
ok("rooms counted", s.rooms === 6, String(s.rooms));
ok("checkable = agree + flag", s.checkable === 2, String(s.checkable));
ok("one flagged", s.flag === 1 && s.agree === 1);
ok("the flagged one is the worst, and first in the list", s.flagRows[0].id === "b", JSON.stringify(s.flagRows.map((r) => r.id)));
// the two checkable gaps are 1.5% (20.3 vs 20) and 20.0% (36 vs 30), so the median is 10.75%
ok("median of the checkable gaps is reported", Math.abs(s.medianAbsDiff - 10.75) < 0.01, String(s.medianAbsDiff));
ok("the other buckets are counted", s.unchecked === 1 && s.sheetDerived === 1 && s.typed === 1 && s.none === 1,
  JSON.stringify({ u: s.unchecked, d: s.sheetDerived, t: s.typed, n: s.none }));
ok("the sheet does have an independent source", s.independentSourceExists === true);

console.log("reconcile: a sheet that prints no areas at all says exactly that");
const noSheet = reconcileAreas([
  room({ id: "a", area: 20, areaFromDrawing: true, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] }),
  room({ id: "b", area: 12, areaFromDrawing: true, poly: [[0, 0], [1, 0], [1, 1], [0, 1]] }),
]);
ok("no independent source is reported", noSheet.summary.independentSourceExists === false);
ok("nothing is claimed to agree", noSheet.summary.agree === 0 && noSheet.summary.checkable === 0);
ok("the line says no area can be checked", /prints no room areas/.test(reconcileLine(noSheet)), reconcileLine(noSheet).slice(0, 160));

console.log("reconcile: the line reads like a sentence, with the numbers in it");
const line = reconcileLine(res);
ok("it names the checkable count and the tolerance", /2 of 6 rooms/.test(line) && /within 5%/.test(line), line.slice(0, 120));
ok("it names the disagreement", /disagree by more than 5%/.test(line), line.slice(0, 200));
ok("it names what could not be checked", /Not checkable/.test(line), line.slice(120, 260));
console.log("\n   " + line + "\n");

console.log("reconcile: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

// tests/test-report.mjs — the sheet an engineer would stamp. It must carry the cited basis, the area
// reconciliation, the band and the cross-check, and it must REFUSE to issue at all when the basis is
// not confirmed. Node only: the report is a string, so this gates in CI with no browser.
import fs from "node:fs";
import { calcProject } from "../js/calc.js";
import { BASIS_FIELDS, savedBasis, basisGaps, confirmField } from "../js/basis.js";
import { monteCarlo } from "../js/uncertainty.js";
import { crossCheck, peakLoadHour } from "../js/crosscheck.js";
import { buildReportHtml, crossCheckExplain, TERM_LABEL, refusalHtml } from "../js/report.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};

const climate = { db: 35, wb: 28, src: "ASHRAE 2021 Fundamentals Ch.14", station: "TEST STATION 433360", indicative: false };
const PER_TYPE = new Set(["oap", "oaa", "light", "equip", "m2pp", "ps", "pl"]);
const project = {
  name: "TEST PROJECT", country: "India", city: "Test City", outDb: 35, outWb: 28, inDb: 24, inRh: 50,
  uWall: 2.0, uRoof: 2.0, uGlass: 5.8, uPart: 2.2, sc: 0.6, roofEtd: 22, wwr: 30, infilAch: 0.5,
  safety: 10, supplyDt: 11, units: "si",
};
const rooms = [];
for (let i = 0; i < 24; i += 1) {
  rooms.push({
    id: "r" + i, name: "ROOM " + i, level: "L1", number: String(101 + i),
    type: ["office", "conference", "cabin", "reception", "general"][i % 5],
    area: 15 + (i % 6) * 8, height: 3, orient: ["N", "E", "S", "W"][i % 4],
    extWall: 8 + (i % 5) * 2, glass: 3 + (i % 3), roof: i % 4 === 0, include: true,
  });
}

console.log("report: an unconfirmed basis REFUSES to issue");
{
  const bare = { ...project };
  const b = savedBasis(bare, climate, { perType: PER_TYPE });
  const gaps = basisGaps(b);
  ok("the basis has gaps to start with", gaps.length > 0, `${gaps.length} gap(s)`);
  const html = buildReportHtml(bare, calcProject(rooms, bare), { climate, basis: b });
  ok("the document says it is NOT ISSUED", /NOT ISSUED/.test(html));
  ok("it prints no tonnage anywhere", !/[0-9]+(\.[0-9]+)?\s*TR/.test(html.replace(/<[^>]+>/g, " ")));
  ok("it lists what is outstanding", /What is still outstanding/.test(html) && gaps.length > 0);
  ok("the refusal names no load summary at all", !/Load summary/.test(html));
  ok("a caller can opt out of the gate, and then it issues", !/NOT ISSUED/.test(
    buildReportHtml(bare, calcProject(rooms, bare), { climate, basis: b, enforceBasis: false })));
}

console.log("report: a confirmed basis issues the whole sheet");
let html = "", confirming = null;
{
  const p = { ...project };
  const b = savedBasis(p, climate, { perType: PER_TYPE });
  for (const f of BASIS_FIELDS) confirmField(b, f.id, "Test engineer", "2026-10-16");
  p.basis = {};
  for (const f of BASIS_FIELDS) {
    const e = b.entries[f.id];
    p.basis[f.id] = { status: e.status, confirmedAt: e.confirmedAt, value: e.value, note: e.note };
  }
  const baked = savedBasis(p, climate, { perType: PER_TYPE });
  ok("nothing is outstanding once every figure is confirmed", basisGaps(baked).length === 0);
  const epw = fs.readFileSync("tests/samples/design-day-cochin.epw", "utf8");
  const day = peakLoadHour(epw, rooms, p);
  const calc = calcProject(rooms, p);
  const mc = monteCarlo(rooms, p, { n: 2000 });
  const cc = crossCheck(rooms, p, day);
  html = buildReportHtml(p, calc, { climate, basis: baked, uncertainty: mc, crosscheck: cc });
  confirming = { day, mc, cc };
  ok("the sheet carries all ten sections, in order", (() => {
    const want = ["1. Project", "2. Assumptions", "3. Room wise", "4. Load summary", "5. Level wise",
      "6. Design basis", "7. Room areas", "8. How wide", "9. Independent cross-check", "10. Important notes"];
    let at = -1;
    return want.every((w) => { const i = html.indexOf(w); if (i < 0 || i < at) return false; at = i; return true; });
  })());
  ok("every figure in the basis is listed with its status", BASIS_FIELDS.every((f) => html.indexOf(f.label) >= 0),
    `${BASIS_FIELDS.length} figures`);
  ok("no term key leaks into the printed table", (() => {
    const body = html.replace(/<[^>]+>/g, " ");
    return !/glassSolar|glassCond|peopleS|peopleL|infil\b|termCompare/.test(body);
  })());
  ok("the term table is labelled in plain words, and is not near-empty", (() => {
    const body = html.replace(/<[^>]+>/g, " ");
    // The table prints every term that carries a real load; a term worth under a kilowatt either way is
    // left out of the sheet rather than padded in with a 0.
    const shown = Object.keys(TERM_LABEL).filter((k) =>
      cc.termCompare.some((t) => t.term === k && (Math.abs(t.appW) > 1 || Math.abs(t.xW) > 1)));
    return shown.length >= 5 && shown.every((k) => body.indexOf(TERM_LABEL[k]) >= 0);
  })());
  ok("the band and its drivers are printed", html.indexOf(mc.tr.p50.toFixed(2)) >= 0 &&
    /Middle 90%/.test(html) && /widest drivers/i.test(html));
  ok("the two methods and the delta are printed", html.indexOf(cc.totals.appTr.toFixed(2)) >= 0 &&
    html.indexOf(cc.totals.xTr.toFixed(2)) >= 0 && html.indexOf(Math.abs(cc.totals.deltaPct).toFixed(1)) >= 0,
    `${cc.totals.appTr.toFixed(2)} vs ${cc.totals.xTr.toFixed(2)} TR (${cc.totals.deltaPct.toFixed(1)}%)`);
  ok("the gap over 10% gets a written explanation", /Explanation of the difference:/.test(html) &&
    crossCheckExplain(cc).length > 120, crossCheckExplain(cc).slice(0, 110) + "...");
  ok("the guideline it cannot meet is named as a gap", /Guideline 14/.test(html) &&
    /NMBE/.test(html) && /Nothing is calibrated/.test(html));
  ok("the sheet still ends with a signature block", /Prepared by/.test(html) && /Checked by/.test(html));
}
console.log(`\nreport: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

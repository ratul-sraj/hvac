// Tests for the exported report's supply-air units — js/report.js.
//
//   cd D:/webhvac && node tests/test-report-units.mjs
//
// The bug these guard against: the "5. Level wise subtotal" table heads its supply column
// "Supply CFM" but was filled with `g.ls` (L/s), and the grand total with `totals.ls` — while the
// summary table a few lines above correctly showed supply in CFM. The printed/exported report
// therefore contradicted itself and an engineer sizing ducts read ~47% of the true flow. These
// tests pin every supply figure in the report to ONE unit (CFM, the aggregated value) and keep the
// "-" placeholder when supply is incalculable.
import { calcProject, DEFAULT_PROJECT } from "../js/calc.js";
import { buildReportHtml, groupByLevel, fmt } from "../js/report.js";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};

const num = (s) => Number(String(s).replace(/,/g, ""));

// the body rows (td cells only; the header row uses th) of the table that follows a heading
function tableRows(html, heading) {
  const start = html.indexOf(heading);
  const end = html.indexOf("</table>", start);
  const body = html.slice(start, end);
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].trim()))
    .filter((cells) => cells.length > 0); // skip the <th>-only header row
}

const rooms = [
  { id: "r1", name: "Office A", level: "Ground", area: 25, height: 3, type: "office", orient: "W", include: true, people: 4 },
  { id: "r2", name: "Office B", level: "Ground", area: 20, height: 3, type: "office", orient: "S", include: true, people: 2 },
  { id: "r3", name: "Room C", level: "First", area: 30, height: 3, type: "office", orient: "N", include: true, people: 3 },
];
const project = { ...DEFAULT_PROJECT, name: "Unit test", supplyDt: 11, units: "ip" };

const calc = calcProject(rooms, project);
const totals = calc.totals;
const levels = groupByLevel(calc.results);
const html = buildReportHtml(project, calc, { generatedAt: new Date(0) });

/* ---------- the summary is the reference ------------------------------------------- */
const summaryMatch = html.match(/Supply air quantity<\/th><td>([^<]*)<\/td>/);
ok("the summary shows supply in CFM", !!summaryMatch && /CFM/.test(summaryMatch[1]),
  summaryMatch ? summaryMatch[1] : "not found");
const summaryCfm = num((summaryMatch[1] || "").replace(/[^\d.,]/g, ""));
ok("the summary supply figure equals the aggregated totals.cfm", summaryCfm === Math.round(totals.cfm),
  `summary ${summaryCfm} vs totals.cfm ${totals.cfm}`);
ok("the L/s and CFM figures genuinely differ (so the unit is testable)",
  Math.round(totals.ls) !== Math.round(totals.cfm),
  `ls ${Math.round(totals.ls)} vs cfm ${Math.round(totals.cfm)}`);

/* ---------- the level table must agree --------------------------------------------- */
ok("the level table's supply column is headed 'Supply air (CFM)'",
  /Supply air \(CFM\)/.test(html.slice(html.indexOf("5. Level wise subtotal"))));
const levelRows = tableRows(html, "5. Level wise subtotal");
ok("the level table has one row per level plus a grand total", levelRows.length === levels.length + 1,
  `${levelRows.length} rows, ${levels.length} levels`);

let levelSupplyOk = true;
let grandSupply = null;
for (const row of levelRows) {
  const supply = row[4]; // [Level, Rooms, Area, TR, Supply, Fresh air]
  if (row[0] === "Grand total") { grandSupply = supply; continue; }
  const g = levels.find((x) => x.level === row[0]);
  const want = fmt(g.cfm, 0);
  if (supply !== want) {
    levelSupplyOk = false;
    console.log(`      level ${row[0]}: report says ${supply}, expected ${want} CFM (L/s was ${fmt(g.ls, 0)})`);
  }
}
ok("every level's supply cell is the CFM value (not L/s)", levelSupplyOk);

ok("the level table's grand total is in CFM and equals the summary",
  grandSupply !== null && num(grandSupply) === summaryCfm && grandSupply === fmt(totals.cfm, 0),
  `grand ${grandSupply}, summary ${summaryCfm}, fmt(totals.cfm)=${fmt(totals.cfm, 0)}`);
ok("no supply cell in the level table is the L/s figure",
  levelRows.every((r) => r[0] === "Grand total" || r[4] !== fmt((levels.find((x) => x.level === r[0]) || {}).ls, 0)));

/* ---------- the '-' placeholder when supply is incalculable ------------------------ */
const noDt = { ...DEFAULT_PROJECT, name: "No supply", supplyDt: 0, units: "ip" };
const calcNo = calcProject(rooms, noDt);
ok("a zero supply dT makes supply incalculable", calcNo.totals.supplyOk === false);
const htmlNo = buildReportHtml(noDt, calcNo, { generatedAt: new Date(0) });
const summaryNo = htmlNo.match(/Supply air quantity<\/th><td>([^<]*)<\/td>/);
ok("the summary shows '-' when supply is incalculable",
  !!summaryNo && summaryNo[1].trim() === "-", summaryNo ? summaryNo[1] : "not found");
const levelRowsNo = tableRows(htmlNo, "5. Level wise subtotal");
ok("every level supply cell is '-' when supply is incalculable",
  levelRowsNo.length > 0 && levelRowsNo.every((r) => r[4] === "-"),
  levelRowsNo.map((r) => r[4]).join(","));
const grandNo = levelRowsNo.find((r) => r[0] === "Grand total");
ok("the level grand total is '-' when supply is incalculable", !!grandNo && grandNo[4] === "-");

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);

// Tests that the level-wise subtotal table (js/app.js renderSummary + app.html header) keeps ONE
// unit for fresh air down a column, rows and total alike.
//
//   cd D:/webhvac && node tests/test-calc-level-units.mjs
//
// The bug these guard against: app.html heads the 7th column "Fresh air L/s", but js/app.js filled
// the per-level rows with `g.oaCfm` (CFM — 2.11888x too big) while the SAME column's Total row showed
// `t.oaLs` in L/s. The table visibly contradicted itself and an engineer reading the level rows got
// ~112 % of the true fresh-air flow. Fresh air is in L/s everywhere else in the app (the summary
// card, the room breakdown), so the rows must be L/s too.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { calcProject, DEFAULT_PROJECT } from "../js/calc.js";
import { groupByLevel } from "../js/report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const CFM_PER_LS = 2.11888;   // the app's own conversion (js/calc.js)

const rooms = [
  { id: "r1", name: "Office A", level: "Ground", area: 25, height: 3, type: "office", orient: "W", include: true, people: 4 },
  { id: "r2", name: "Office B", level: "Ground", area: 20, height: 3, type: "office", orient: "S", include: true, people: 2 },
  { id: "r3", name: "Room C", level: "First", area: 30, height: 3, type: "office", orient: "N", include: true, people: 3 },
  { id: "r4", name: "Room D", level: "First", area: 15, height: 3, type: "office", orient: "E", include: true, people: 1 },
];
const project = { ...DEFAULT_PROJECT, name: "Level unit test" };
const calc = calcProject(rooms, project);
const totals = calc.totals;
const levels = groupByLevel(calc.results);

// ---- the data really is in two different units -------------------------------------------
ok("the fixture has at least two levels", levels.length >= 2, levels.map((g) => g.level).join(", "));
ok("oaCfm is genuinely ~2.11888x oaLs (so the unit is testable)",
  near(levels[0].oaCfm, levels[0].oaLs * CFM_PER_LS, 1e-3),
  `${levels[0].oaLs.toFixed(1)} L/s vs ${levels[0].oaCfm.toFixed(1)} CFM`);

// ---- the level rows sum to the total, in L/s ----------------------------------------------
const sumLs = levels.reduce((a, g) => a + g.oaLs, 0);
ok("the per-level fresh-air rows sum to the project total, in L/s",
  near(sumLs, totals.oaLs, 1e-6), `${sumLs.toFixed(4)} vs totals.oaLs ${totals.oaLs.toFixed(4)}`);
const sumCfm = levels.reduce((a, g) => a + g.oaCfm, 0);
ok("THE BUG: summing the rows in CFM does NOT equal the total in L/s",
  !near(sumCfm, totals.oaLs, 1),
  `sum oaCfm ${sumCfm.toFixed(1)} vs totals.oaLs ${totals.oaLs.toFixed(1)} (would be ${(sumCfm / totals.oaLs).toFixed(3)}x)`);

// ---- the header and the two rendered cells are read from the real source -------------------
const html = fs.readFileSync(join(ROOT, "app.html"), "utf8");
const headerCells = (html.match(/<th[^>]*>[^<]*<\/th>/g) || [])
  .map((h) => h.replace(/<[^>]+>/g, "").replace(/&sup2;/g, "²").trim());
const freshHeader = headerCells.find((h) => /fresh air/i.test(h));
ok("the level table's fresh-air column is headed in L/s (app.html)",
  !!freshHeader && /L\/s/.test(freshHeader) && !/CFM/i.test(freshHeader), String(freshHeader));

const app = fs.readFileSync(join(ROOT, "js", "app.js"), "utf8");
// Isolate the level-table template inside renderSummary.
const start = app.indexOf("el.levelBody.innerHTML = levels.length");
const end = app.indexOf(": '<tr><td class=\"l\" colspan=\"8\">", start);
const levelTemplate = start >= 0 && end > start ? app.slice(start, end) : "";
ok("found the level-table template in js/app.js", levelTemplate.length > 0, `${levelTemplate.length} chars`);
ok("the per-level fresh-air cell renders g.oaLs (L/s), not g.oaCfm",
  /fmt\(\s*g\.oaLs\s*,\s*0\s*\)/.test(levelTemplate) && !/g\.oaCfm/.test(levelTemplate),
  (levelTemplate.match(/<td>\$\{fmt\([^}]*\}\)<\/td>/g) || []).join(" "));
ok("the Total row renders t.oaLs (the same L/s unit)",
  /fmt\(\s*t\.oaLs\s*,\s*0\s*\)/.test(levelTemplate), "Total row fresh-air cell");

console.log(`\n${pass}/${pass + fail} level-unit checks passed`);
if (fail) process.exit(1);
console.log("ALL LEVEL UNIT CHECKS PASSED");

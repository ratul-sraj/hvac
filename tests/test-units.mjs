// Tests for the LoadLens unit system (metric SI / imperial IP): js/units.js, js/calc.js, js/report.js.
//
//   cd D:/webhvac && node tests/test-units.mjs
//
// The two hard rules of docs/UNITS-PLAN.md:
//   1. the load is ALWAYS computed in SI - a conversion only DISPLAYS the same number;
//   2. a converted figure always carries its unit, the report/CSV state the basis in words, and no
//      table mixes the two systems.
// This suite pins the factors, the formatter honesty (an unknown load is "-", never "NaN"), that the
// two systems really differ, that the imperial totals are the SI totals times the factor, that a
// project saved before this feature (no `units` field) still calculates as before, and that the
// imperial report / CSV speak one system (CFM / BTU/h / ft², never a bare m² header).
import { calcProject, DEFAULT_PROJECT } from "../js/calc.js";
import { buildReportHtml, toCsv, fmt } from "../js/report.js";
import {
  K, normSystem, systemLabel, conversionNote,
  air, airUnit, power, powerUnit, area, areaUnit, density, densityUnit,
  temp, tempUnit, tempDelta, tempDeltaUnit, length, lengthUnit,
  uValue, uValueUnit, areaPerTr, areaPerTrUnit, capacity, capacityUnit,
  fmtValue, fmtAir, fmtPower, fmtArea, fmtDensity, header,
} from "../js/units.js";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

/* ---------------- the factors and round-trips ---------------- */
ok("1 L/s = 2.118880 CFM", K.lsToCfm === 2.118880, String(K.lsToCfm));
ok("1 W = 3.412142 BTU/h", K.wToBtuh === 3.412142, String(K.wToBtuh));
ok("1 m² = 10.763910 ft²", K.m2ToFt2 === 10.763910, String(K.m2ToFt2));
ok("1 W/m² = 0.316998 BTU/(h·ft²)", K.wm2ToBtuhFt2 === 0.316998, String(K.wm2ToBtuhFt2));
ok("1 TR = 3.516853 kW", K.wPerTr === 3516.853, String(K.wPerTr));
ok("1 TR = 12,000 BTU/h", K.btuhPerTr === 12000, String(K.btuhPerTr));

ok("air: 1 L/s = 2.118880 CFM", near(air(1, "ip"), 2.118880), String(air(1, "ip")));
ok("air: SI is the identity", near(air(50, "si"), 50));
ok("air round-trips through the factor", near(air(37.5, "ip") / K.lsToCfm, 37.5));
ok("power: 1 W = 3.412142 BTU/h", near(power(1, "ip"), 3.412142));
ok("power round-trips through the factor", near(power(900, "ip") / K.wToBtuh, 900));
ok("area: 1 m² = 10.763910 ft²", near(area(1, "ip"), 10.763910));
ok("area round-trips through the factor", near(area(45, "ip") / K.m2ToFt2, 45));
ok("density: 1 W/m² = 0.316998 BTU/(h·ft²)", near(density(1, "ip"), 0.316998));
ok("temp: 0 °C = 32 °F", near(temp(0, "ip"), 32));
ok("temp: 100 °C = 212 °F", near(temp(100, "ip"), 212));
ok("temp is the identity in SI", near(temp(24, "si"), 24));
ok("tempDelta has NO 32° offset: 1 K = 1.8 °F", near(tempDelta(1, "ip"), 1.8));
ok("tempDelta: 11 K = 19.8 °F", near(tempDelta(11, "ip"), 19.8));
ok("length: 1 m = 3.280840 ft", near(length(1, "ip"), 3.280840));
ok("uValue: 5.678263 W/m²K = 1 BTU/(h·ft²·°F)", near(uValue(5.678263, "ip"), 1, 1e-4));
ok("areaPerTr: 10 m²/TR = 107.6 ft²/TR", near(areaPerTr(10, "ip"), 10 * K.m2ToFt2));
ok("capacity is TR in both systems (no conversion)", capacity(5, "ip") === 5 && capacity(5, "si") === 5 && capacityUnit() === "TR");

/* ---------------- system names & units ---------------- */
ok("normSystem falls back to SI for a missing/garbage value",
  normSystem(undefined) === "si" && normSystem(null) === "si" && normSystem("") === "si" && normSystem("xyz") === "si");
ok("normSystem recognises IP, case- and space-insensitively",
  normSystem("ip") === "ip" && normSystem("IP") === "ip" && normSystem(" ip ") === "ip");
ok("systemLabel names both systems", systemLabel("si") === "Metric (SI)" && systemLabel("ip") === "Imperial (IP)");
ok("unit labels differ between the systems",
  airUnit("si") === "L/s" && airUnit("ip") === "CFM" &&
  powerUnit("si") === "W" && powerUnit("ip") === "BTU/h" &&
  areaUnit("si") === "m²" && areaUnit("ip") === "ft²");
ok("header() carries the unit: 'Area (m²)' / 'Area (ft²)'",
  header("Area", "m²") === "Area (m²)" && header("Area", "ft²") === "Area (ft²)");

/* ---------------- formatter honesty: NaN / Infinity never leak ---------------- */
ok("fmtValue(NaN) is '-'", fmtValue(NaN) === "-", fmtValue(NaN));
ok("fmtValue(Infinity) is '-'", fmtValue(Infinity) === "-" && fmtValue(-Infinity) === "-");
ok("fmtValue(undefined) is '-'", fmtValue(undefined) === "-");
ok("fmtArea(NaN) is '-' not a confident 0", fmtArea(NaN, "ip") === "-", fmtArea(NaN, "ip"));
ok("fmtAir(Infinity) is '-'", fmtAir(Infinity, "si") === "-", fmtAir(Infinity, "si"));
ok("fmtPower(NaN) is '-'", fmtPower(NaN, "ip") === "-", fmtPower(NaN, "ip"));
ok("fmtDensity(NaN) is '-'", fmtDensity(NaN, "si") === "-", fmtDensity(NaN, "si"));
ok("no formatter ever emits the string 'NaN'",
  ![fmtValue(NaN), fmtArea(NaN, "si"), fmtAir(NaN, "ip"), fmtPower(Infinity, "ip")].some((s) => /NaN/.test(s)));

/* ---------------- the two systems genuinely differ ---------------- */
ok("fmtAir differs between systems", fmtAir(50, "si") === fmtValue(50) && fmtAir(50, "ip") === fmtValue(50 * K.lsToCfm)
  && fmtAir(50, "si") !== fmtAir(50, "ip"), `${fmtAir(50, "si")} vs ${fmtAir(50, "ip")}`);
ok("fmtPower differs between systems", fmtPower(2000, "si") === fmtValue(2000) && fmtPower(2000, "ip") === fmtValue(2000 * K.wToBtuh)
  && fmtPower(2000, "si") !== fmtPower(2000, "ip"), `${fmtPower(2000, "si")} vs ${fmtPower(2000, "ip")}`);
ok("fmtArea differs between systems", fmtArea(8, "si") === fmtValue(8, 1) && fmtArea(8, "ip") === fmtValue(8 * K.m2ToFt2, 1)
  && fmtArea(8, "si") !== fmtArea(8, "ip"), `${fmtArea(8, "si")} vs ${fmtArea(8, "ip")}`);

/* ---------------- the basis sentence ---------------- */
const noteSi = conversionNote("si"), noteIp = conversionNote("ip");
ok("conversionNote is non-empty for SI", noteSi.length > 0, noteSi);
ok("conversionNote is non-empty for Imperial", noteIp.length > 0, noteIp);
ok("the SI basis names metric/SI", /metric|SI/.test(noteSi), noteSi);
ok("the imperial basis names imperial/IP", /imperial|IP/i.test(noteIp), noteIp);
ok("each basis names the SI calculation it came from",
  /computed in SI/i.test(noteSi) && /computed in SI/i.test(noteIp));
ok("the two bases are not the same text", noteSi !== noteIp);
ok("no basis text says NaN/undefined", !/NaN|undefined|null/.test(noteSi + noteIp));

/* ---------------- the engine: imperial totals are the SI totals × factor ---------------- */
const rooms = [
  { id: "r1", name: "Office A", level: "Ground", area: 25, height: 3, type: "office", orient: "W", include: true, people: 4 },
  { id: "r2", name: "Office B", level: "Ground", area: 20, height: 3, type: "office", orient: "S", include: true, people: 2 },
  { id: "r3", name: "Room C", level: "First", area: 30, height: 3, type: "office", orient: "N", include: true, people: 3 },
];
const si = { ...DEFAULT_PROJECT, name: "Units SI", units: "si" };
const ip = { ...DEFAULT_PROJECT, name: "Units IP", units: "ip" };
const calcSi = calcProject(rooms, si);
const calcIp = calcProject(rooms, ip);

ok("DEFAULT_PROJECT declares units 'si'", DEFAULT_PROJECT.units === "si");
ok("calcProject normalises totals.units", calcSi.totals.units === "si" && calcIp.totals.units === "ip");
ok("the load itself is identical in both systems (the maths never converts)",
  near(calcIp.totals.totalW, calcSi.totals.totalW) && near(calcIp.totals.tr, calcSi.totals.tr)
  && near(calcIp.totals.ls, calcSi.totals.ls) && near(calcIp.totals.area, calcSi.totals.area),
  `${calcIp.totals.totalW} vs ${calcSi.totals.totalW} W`);

ok("power(totals.totalW, 'ip') equals totals.totalW × 3.412142",
  near(power(calcSi.totals.totalW, "ip"), calcSi.totals.totalW * K.wToBtuh));
ok("totals.totalBtuh equals the SI total × 3.412142",
  near(calcIp.totals.totalBtuh, calcSi.totals.totalW * K.wToBtuh),
  `${calcIp.totals.totalBtuh} vs ${calcSi.totals.totalW * K.wToBtuh}`);
ok("totals.rshBtuh / rlhBtuh / safetyBtuh are the SI figures × 3.412142",
  near(calcIp.totals.rshBtuh, calcSi.totals.rsh * K.wToBtuh) &&
  near(calcIp.totals.rlhBtuh, calcSi.totals.rlh * K.wToBtuh) &&
  near(calcIp.totals.safetyBtuh, calcSi.totals.safetyW * K.wToBtuh));
ok("totals.cfm equals the SI supply flow × 2.118880",
  near(calcIp.totals.cfm, calcSi.totals.ls * K.lsToCfm, 1e-5),
  `${calcIp.totals.cfm} vs ${calcSi.totals.ls * K.lsToCfm}`);
ok("totals.oaCfm equals the SI outdoor flow × 2.118880",
  near(calcIp.totals.oaCfm, calcSi.totals.oaLs * K.lsToCfm, 1e-5));
ok("totals.areaSqft equals the SI area × 10.763910", near(calcIp.totals.areaSqft, calcSi.totals.area * K.m2ToFt2, 1e-4));
ok("per-room totalBtuh equals the room totalW × 3.412142",
  near(calcIp.results[0].totalBtuh, calcIp.results[0].totalW * K.wToBtuh));
ok("per-room areaFt2 equals the room area × 10.763910",
  near(calcIp.results[0].areaFt2, parseFloat(calcIp.results[0].room.area) * K.m2ToFt2, 1e-4));
ok("the per-room area-per-ton pair agrees at the factor",
  near(calcIp.results[0].m2PerTr * K.m2ToFt2, calcIp.results[0].sqftPerTr, 1e-4),
  `${calcIp.results[0].m2PerTr} m²/TR vs ${calcIp.results[0].sqftPerTr} ft²/TR`);

/* ---------------- a saved project with no `units` field keeps working ---------------- */
const legacy = { ...DEFAULT_PROJECT, name: "Legacy project" };
delete legacy.units;
const calcLegacy = calcProject(rooms, legacy);
ok("a project with no units field reads as SI", calcLegacy.totals.units === "si");
ok("a project with no units field computes EXACTLY as before",
  near(calcLegacy.totals.totalW, calcSi.totals.totalW) && near(calcLegacy.totals.tr, calcSi.totals.tr)
  && near(calcLegacy.totals.ls, calcSi.totals.ls) && near(calcLegacy.totals.rsh, calcSi.totals.rsh)
  && near(calcLegacy.totals.oaLs, calcSi.totals.oaLs),
  `${calcLegacy.totals.totalW} vs ${calcSi.totals.totalW} W`);
ok("even a bare {} project does not throw and defaults to SI",
  calcProject(rooms, {}).totals.units === "si");

/* ---------------- the report + CSV follow the system, in words and in units ---------------- */
const htmlIp = buildReportHtml(ip, calcIp, { generatedAt: new Date(0) });
const htmlSi = buildReportHtml(si, calcSi, { generatedAt: new Date(0) });
const csvIp = toCsv(ip, calcIp);
const csvSi = toCsv(si, calcSi);
const thCells = (h) => (h.match(/<th[^>]*>([\s\S]*?)<\/th>/g) || [])
  .map((c) => c.replace(/<[^>]+>/g, "").trim());

ok("the imperial report carries CFM headings", /CFM/.test(htmlIp));
ok("the imperial report carries BTU/h headings", /BTU\/h/.test(htmlIp));
ok("the imperial report carries ft² headings", /ft²|ft2/.test(htmlIp));
ok("the imperial report has NO bare m²/m2 header",
  thCells(htmlIp).every((t) => !/m²|m2/i.test(t)), thCells(htmlIp).join(" | "));
ok("the imperial report carries no NaN and no Infinity",
  !/NaN/.test(htmlIp) && !/Infinity/.test(htmlIp));
ok("the imperial report states the basis in words (conversionNote)",
  htmlIp.includes("computed in SI") && htmlIp.includes("Imperial (IP)"));
ok("the imperial report really converts the area (25 m² → 269.1 ft²)",
  htmlIp.includes("269.1") && !htmlIp.includes(">25.0<"));

ok("the SI report keeps m² headings and shows no CFM/BTU/h",
  thCells(htmlSi).some((t) => /m²/.test(t)) && !/CFM|BTU\/h/.test(htmlSi), thCells(htmlSi).join(" | "));
ok("the SI report really shows the SI area", htmlSi.includes(">25.0<"));

const headerRow = (csv) => (csv.split(/\r?\n/).find((l) => /^Include,/.test(l)) || "").replace(/^\ufeff/, "");
const headLineIp = headerRow(csvIp);
const headLineSi = headerRow(csvSi);
ok("the imperial CSV header carries CFM, BTU/h and ft2",
  /CFM/.test(headLineIp) && /BTU\/h/.test(headLineIp) && /ft2/.test(headLineIp), headLineIp);
ok("the imperial CSV header has no m2 column at all", !/m2/i.test(headLineIp), headLineIp);
ok("the imperial CSV supply column stays at index 20 and is the CFM value",
  headLineIp.split(",")[20] === "Supply air CFM", headLineIp.split(",")[20]);
ok("the imperial CSV states the basis in words (conversionNote)",
  csvIp.includes("computed in SI") && csvIp.includes("Imperial (IP)"));
ok("the SI CSV header is in SI (m2, L/s, W, no CFM/BTU)",
  /m2/i.test(headLineSi) && /Supply air L\/s/.test(headLineSi) && !/CFM|BTU\/h/.test(headLineSi), headLineSi);
ok("the CSV carries no NaN and no Infinity in either system",
  !/NaN/.test(csvIp + csvSi) && !/Infinity/.test(csvIp + csvSi));

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);
console.log("ALL UNIT CHECKS PASSED");

// tests/test-crosscheck.mjs — the second method must be genuinely independent, its psychrometrics must
// be right, and its delta must be reported rather than smoothed away.
import fs from "node:fs";
import {
  crossCheck, crossCheckLine, designHourFromEpw, peakLoadHour, parseEpwHours, sunPosition,
  surfaceIrradiance, humidityRatioFromDewPoint, humidityRatioFromRh, humidityRatioFromWetBulb,
  enthalpy, MODEL,
} from "../js/crosscheck.js";
import { DEFAULT_PROJECT, calcProject } from "../js/calc.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass += 1; console.log("  ok  " + name); }
  else { fail += 1; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("crosscheck: it is a different method, not a second copy of the engine");
const src = fs.readFileSync(new URL("../js/crosscheck.js", import.meta.url), "utf8");
// Only real code counts here: the header comment names these constants for the reader.
ok("it never uses the engine's tabulated solar constants", !/\bSOLAR\s*\[|\bWALL_ETD\s*\[/.test(src));
ok("it computes the sun's position itself", /function sunPosition/.test(src) && /declination/.test(src));
ok("it works from psychrometric enthalpy, not the fixed 3010 factor",
  /enthalpy\(/.test(src) && !/[^0-9.]3010\s*\*/.test(src));
ok("its physical constants are stated, not hidden", MODEL.hOut > 10 && MODEL.alphaRoof > 0 && MODEL.scToShgc === 0.87);

console.log("crosscheck: psychrometrics against hand-computed values");
// At 0 °C the saturation pressure is 0.61078 kPa, so W = 0.621945 * 0.611 / (101.325 - 0.611) = 0.003771
ok("humidity ratio at 0 °C / 0 °C dew point", near(humidityRatioFromDewPoint(0, 0), 0.003771, 1e-6),
  String(humidityRatioFromDewPoint(0, 0)));
ok("humidity ratio at 100% RH equals the saturation value", near(humidityRatioFromRh(30, 100), humidityRatioFromDewPoint(30, 30), 1e-9));
ok("enthalpy of dry air at 20 °C is 20.1 kJ/kg", near(enthalpy(20, 0), 20.12, 0.02), String(enthalpy(20, 0)));
// moist air at 30 °C, W = 0.02: h = 1.006*30 + 0.02*(2501 + 1.86*30) = 30.18 + 51.14 = 81.32
ok("enthalpy of moist air at 30 °C, W=0.02", near(enthalpy(30, 0.02), 81.32, 0.05), String(enthalpy(30, 0.02)));

console.log("crosscheck: solar geometry is plausible where it can be checked");
const noon = sunPosition(10.15, 172, 12);            // Kochi lat, late June, solar noon
ok("at solar noon near the equator in June the sun is high", noon.altitude > 70, `${noon.altitude.toFixed(1)}°`);
// Kochi, 21 June: at 8 am the sun is east-north-east, at 1.30 pm it is west of south, at 5 pm west.
const morning = sunPosition(10.15, 172, 8);
ok("at 8 am the sun is east of north", morning.azimuth > 55 && morning.azimuth < 85, `${morning.azimuth.toFixed(0)}°`);
// February (declination ~ -15°, i.e. south of the equator) is the ordinary case for this latitude.
const earlyAfternoon = sunPosition(10.15, 41, 13.5);
ok("in February at 1.30 pm the sun is west of south", earlyAfternoon.azimuth > 200 && earlyAfternoon.azimuth < 260,
  `${earlyAfternoon.azimuth.toFixed(0)}°`);
// ...and the tropical case that catches a naive solar model: at the June solstice the declination
// (+23.4°) EXCEEDS the latitude (10.15°), so the sun passes north of the station and the north wall is
// the sunlit one at midday. A model that assumes "afternoon = north-west" fails this.
const juneNoon = sunPosition(10.15, 172, 12);
ok("at the June solstice at 10°N the midday sun is nearly overhead and slightly north",
  juneNoon.altitude > 75 && (juneNoon.azimuth < 20 || juneNoon.azimuth > 340),
  `alt ${juneNoon.altitude.toFixed(0)}°, az ${juneNoon.azimuth.toFixed(0)}°`);
const evening = sunPosition(10.15, 172, 17);
ok("at 5 pm the sun is west-north-west", evening.azimuth > 265 && evening.azimuth < 300, `${evening.azimuth.toFixed(0)}°`);
ok("at 6 am the sun is east of north too", (() => { const m = sunPosition(10.15, 172, 6); return m.azimuth > 55 && m.azimuth < 90; })(),
  `${sunPosition(10.15, 172, 6).azimuth.toFixed(0)}°`);
const febAfternoon = { altitude: earlyAfternoon.altitude, azimuth: earlyAfternoon.azimuth };
ok("a wall facing away from the sun gets less than one facing it, but still sky and ground",
  surfaceIrradiance(febAfternoon, 90, 0, 900, 700, 150) < surfaceIrradiance(febAfternoon, 90, 180, 900, 700, 150),
  `north ${surfaceIrradiance(febAfternoon, 90, 0, 900, 700, 150).toFixed(0)} vs south ${surfaceIrradiance(febAfternoon, 90, 180, 900, 700, 150).toFixed(0)} W/m²`);
ok("even a shaded wall still receives diffuse and ground-reflected light (it is never zero)",
  surfaceIrradiance(febAfternoon, 90, 0, 900, 700, 150) > 50,
  `${surfaceIrradiance(febAfternoon, 90, 0, 900, 700, 150).toFixed(0)} W/m²`);
ok("a horizontal surface takes the file's own measured GHI, not a decomposition of it",
  surfaceIrradiance(noon, 0, 0, 900, 700, 150) === 900, String(surfaceIrradiance(noon, 0, 0, 900, 700, 150)));
ok("the default design hour is the highest moist-air enthalpy, not the sunniest hour", (() => {
  const epwText = fs.readFileSync("tests/qa/epw/IND_KL_Nedumbassery.Cochin.Int.AP.433360_TMYx.2009-2023.epw", "utf8");
  const dflt = designHourFromEpw(epwText);
  const sunny = designHourFromEpw(epwText, "peakSun");
  return dflt.picked === "peakEnthalpy" && dflt.dpt > sunny.dpt + 8;
})(), "a humid design hour, not a dry sunny one");

// The zones both methods are judged on: office, meeting, cabin, reception and general space, four
// orientations, a quarter of them under the roof.
const rooms = [];
const types = ["office", "conference", "cabin", "reception", "general"];
for (let i = 0; i < 40; i += 1) {
  rooms.push({
    id: "r" + i, name: "ROOM " + i, type: types[i % types.length],
    area: 12 + (i % 7) * 9, height: 3.0, orient: ["N", "E", "S", "W"][i % 4],
    extWall: 8 + (i % 5) * 2, glass: 3 + (i % 3), roof: i % 4 === 0, include: true,
  });
}

console.log("crosscheck: the weather file supplies the design hour");
// tests/samples/design-day-cochin.epw is REAL data: the 24 hours of one design day, cut out of
// IND_KL_Nedumbassery.Cochin.Int.AP.433360_TMYx.2009-2023.epw (climate.onebuilding.org, TMYx from
// NCEI ISD/ERA5, period of record 2009-2021). It is committed so the cross-check gates in CI; the full
// multi-year file (if it is on this machine) is used for the analysis itself.
const EPW_FIXTURE = "tests/samples/design-day-cochin.epw";
const EPW_FULL = "tests/qa/epw/IND_KL_Nedumbassery.Cochin.Int.AP.433360_TMYx.2009-2023.epw";
const epw = fs.readFileSync(EPW_FIXTURE, "utf8");
const fullEpw = fs.existsSync(EPW_FULL) ? fs.readFileSync(EPW_FULL, "utf8") : null;
// The design hour is the hour the BUILDING peaks, found by running the method for every daylight hour.
const day = peakLoadHour(epw, rooms, DEFAULT_PROJECT);
const byEnthalpy = designHourFromEpw(epw);
ok("a design hour was found", !!day && day.rows === 24, `${day && day.rows} hourly rows`);
ok("the design hour is a daylight hour with real sun on it", day.ghi > 0, `GHI ${day.ghi} W/m² at ${day.hour}:30`);
ok("it is the peak of the building's own load, not the sunniest or the most humid hour", (() => {
  const peak = Math.max.apply(null, day.hourly.map((h) => h.tr));
  return Math.abs(peak - day.peakTr) < 1e-9 && day.picked === "peakLoad";
})(), `${day.peakTr.toFixed(2)} TR`);
ok("picking on outdoor enthalpy alone would have chosen a NON-daylight hour (the trap)",
  byEnthalpy.ghi <= 0 || byEnthalpy.hour !== day.hour,
  `enthalpy hour ${byEnthalpy.hour}:30 GHI ${byEnthalpy.ghi} vs load hour ${day.hour}:30 GHI ${day.ghi}`);
ok("the station is named", /Cochin|Ernakulam|Nedumbassery/i.test(day.station), day.station);
ok("the latitude is Kerala's", near(day.lat, 10.15, 0.01), String(day.lat));
ok("the hour carries solar and dry bulb", day.ghi > 300 && day.db > 25, `${day.ghi} W/m², ${day.db} °C`);
// EPW pressure is in Pa; the psychrometrics work in kPa. Getting this wrong kills the latent load.
ok("the station pressure was converted from Pa to kPa", day.pressure > 95 && day.pressure < 106, `${day.pressure} kPa`);
if (fullEpw) {
  const sunny = designHourFromEpw(fullEpw, "peakSun");
  ok("over a full year, the sunniest hour is a DRY one and the default avoids it",
    designHourFromEpw(fullEpw).dpt > sunny.dpt + 8,
    `enthalpy hour dpt ${designHourFromEpw(fullEpw).dpt} vs sunniest ${sunny.dpt}`);
  const peakDb = designHourFromEpw(fullEpw, "peakDryBulb");
  ok("picking by dry bulb over a full year gives yet another hour",
    peakDb.hour !== sunny.hour || peakDb.month !== sunny.month,
    `${peakDb.day}/${peakDb.month} ${peakDb.hour}h DB ${peakDb.db}`);
} else {
  console.log("  SKIP  (the full multi-year weather file is not on this machine)");
}

console.log("crosscheck: the two methods on the same zones and the same basis");
const x = crossCheck(rooms, DEFAULT_PROJECT, day);
ok("every room was worked twice", x.rows.length === 40, String(x.rows.length));
ok("the app's own total is reproduced from the engine", near(x.totals.appTr, calcProject(rooms, DEFAULT_PROJECT).totals.tr, 1e-9));
ok("the second method gives a positive load", x.totals.xTr > 0, `${x.totals.xTr.toFixed(2)} TR`);
ok("the delta is reported, with sign", x.totals.deltaPct != null && Number.isFinite(x.totals.deltaPct),
  `${x.totals.deltaPct.toFixed(1)}%`);
ok("rooms over 10% apart are counted", Number.isInteger(x.totals.overTenPct), String(x.totals.overTenPct));
ok("the terms add up to the second method's total (order of magnitude)", (() => {
  const t = Object.values(x.terms).reduce((a, b) => a + b, 0);
  return Math.abs(t / 3517 - x.totals.xTr) / x.totals.xTr < 0.15;   // safety factor explains the rest
})(), "");
ok("the air states are the weather file's own", x.airStates.hOut > x.airStates.hIn,
  `hOut ${x.airStates.hOut.toFixed(1)} vs hIn ${x.airStates.hIn.toFixed(1)} kJ/kg`);
ok("the line names both totals and the design hour", (() => {
  const l = crossCheckLine(x);
  return /Second method/.test(l) && /Design hour/.test(l) && /Cochin|Erdumbassery|Nedumbassery/i.test(l);
})(), "");
ok("the term-by-term says WHERE the two methods part company", (() => {
  const top = x.termCompare[0];
  const shared = x.termCompare.filter((t) => t.term === "glassCond" || t.term === "peopleS" || t.term === "light");
  return top && Math.abs(top.deltaW) > 0 && shared.every((t) => Math.abs(t.deltaW) < 1);
})(), "the shared terms must agree exactly; the method-specific ones must not");
ok("the outdoor-air term, worked two different ways, agrees within 5%", (() => {
  const oa = x.termCompare.find((t) => t.term === "oa");
  return Math.abs(oa.deltaW) / oa.appW < 0.05;
})(), "enthalpy difference vs sensible+latent factors");

console.log("\n   term-by-term (kW, app vs second method):");
x.termCompare.forEach((t) => console.log(
  `      ${t.term.padEnd(11)} app ${(t.appW / 1000).toFixed(1).padStart(7)}   x ${(t.xW / 1000).toFixed(1).padStart(7)}   delta ${(t.deltaW / 1000).toFixed(1).padStart(7)}`));
console.log("\n   app total      " + x.totals.appTr.toFixed(2) + " TR");
console.log("   second method  " + x.totals.xTr.toFixed(2) + " TR   (" + x.totals.deltaPct.toFixed(1) + "%)");
console.log("   rooms over 10% apart: " + x.totals.overTenPct + " of " + x.totals.rooms);
console.log("   terms (kW): " + Object.entries(x.terms).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(" · "));
console.log("\n   worst rooms:");
x.worst.slice(0, 6).forEach((r) => console.log(
  `      ${r.name.padEnd(10)} ${r.orient}  app ${r.appTr.toFixed(2)}  x ${r.xTr.toFixed(2)}  ${r.deltaPct.toFixed(0)}%` +
  `   (glass solar ${(r.terms.glassSolar / 1000).toFixed(2)} kW, oa ${(r.terms.oa / 1000).toFixed(2)} kW)`));
console.log("\n   " + crossCheckLine(x) + "\n");

console.log("crosscheck: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

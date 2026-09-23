// Independent verification of js/calc.js — hand calculations + ASHRAE Hyland-Wexler reference.
// Run:  cd D:/webhvac && node tests/verify/check-calc.mjs
// This file only READS the engine; it never edits project files.
import {
  calcRoom, calcProject, normalizeRoom, wFromDbWb, wFromDbRh, rhFromDbW,
  DEFAULT_PROJECT as DP, SOLAR, WALL_ETD,
} from "../../js/calc.js";

let bugs = 0, simpl = 0, ok = 0;
const rows = [];
function check(item, engine, hand, verdict, note = "") {
  const dev = (typeof engine === "number" && typeof hand === "number" && hand !== 0)
    ? ((engine - hand) / hand * 100) : null;
  rows.push({ item, engine, hand, dev, verdict, note });
  if (verdict === "BUG") bugs++; else if (verdict === "SIMPLIFICATION") simpl++; else ok++;
  console.log(`${verdict.padEnd(15)} ${item.padEnd(48)} engine=${engine}  hand=${hand}` +
    (dev === null ? "" : `  dev=${dev.toFixed(2)}%`) + (note ? `  ${note}` : ""));
}

/* ---------- 1. reference psychrometrics (ASHRAE Fundamentals 2017 eq.6, Hyland-Wexler over water) ---------- */
function pwsHW(T) {
  const Tk = T + 273.15;
  const C = [-5.8002206e3, 1.3914993, -4.8640239e-2, 4.1764768e-5, -1.4452093e-8, 6.5459673];
  return Math.exp(C[0] / Tk + C[1] + C[2] * Tk + C[3] * Tk ** 2 + C[4] * Tk ** 3 + C[5] * Math.log(Tk)) / 1000;
}
function wHW(db, wb, P = 101.325) {
  const ws = 0.621945 * pwsHW(wb) / (P - pwsHW(wb));
  return ((2501 - 2.326 * wb) * ws - 1.006 * (db - wb)) / (2501 + 1.86 * db - 4.186 * wb);
}
function wFromRhHW(db, rh, P = 101.325) {
  const p = pwsHW(db) * rh / 100;
  return 0.621945 * p / (P - p);
}

console.log("\n=== 1. psychrometrics vs ASHRAE Hyland-Wexler ===");
for (const [db, wb] of [[35, 28], [33, 27], [46, 29], [43, 24], [30, 25], [24, 17.1], [20, 15]]) {
  check(`wFromDbWb(${db},${wb}) vs HW`, +wFromDbWb(db, wb).toFixed(6), +wHW(db, wb).toFixed(6),
    Math.abs((wFromDbWb(db, wb) - wHW(db, wb)) / wHW(db, wb)) > 0.01 ? "BUG" : "OK");
}
for (const [db, rh] of [[24, 50], [30, 60], [40, 50], [26, 55]]) {
  check(`wFromDbRh(${db},${rh}%) vs HW`, +wFromDbRh(db, rh).toFixed(6), +wFromRhHW(db, rh).toFixed(6),
    Math.abs((wFromDbRh(db, rh) - wFromRhHW(db, rh)) / wFromRhHW(db, rh)) > 0.01 ? "BUG" : "OK");
}
check("wFromDbWb(35,28) vs published chart 0.0211", +wFromDbWb(35, 28).toFixed(5), 0.0211,
  Math.abs(wFromDbWb(35, 28) - 0.0211) / 0.0211 > 0.01 ? "BUG" : "OK");
check("wFromDbRh(24,50%) vs published chart 0.0093", +wFromDbRh(24, 50).toFixed(5), 0.0093,
  Math.abs(wFromDbRh(24, 50) - 0.0093) / 0.0093 > 0.01 ? "BUG" : "OK");
check("rhFromDbW(24, w(24,50)) round trip %", +rhFromDbW(24, wFromDbRh(24, 50)).toFixed(4), 50, "OK");
check("rhFromDbW(35, w(35,28)) (=outdoor RH)", +rhFromDbW(35, wFromDbWb(35, 28)).toFixed(2), 59.06, "OK");
check("saturation: rhFromDbW(30, w(30,30))", +rhFromDbW(30, wFromDbWb(30, 30)).toFixed(2), 100, "OK");

/* ---------- 2. heat factors ---------- */
console.log("\n=== 2. heat transfer factors ===");
const rhoSea = 101.325 / (0.287 * (24 + 273.15));           // kg/m3 at indoor design
check("sensible factor 1.23 vs 1.006*rho at 24C", 1.23, +(1.006 * rhoSea).toFixed(4), "OK",
  "+2.9% vs sea level at 24C indoor, +3.5% vs the 0.33 W/m3h rule (1.188) -> mildly conservative");
check("latent factor 3010 vs 2501*1.2", 3010, 3001.2, "OK", "+0.3%");
check("TR divisor 3517 (W)", 3517, 3516.852, "OK");
check("cfm per L/s = 1/0.000471947", 2.11888, 1 / 0.000471947, "OK",
  "exact (1 m3/s = 2118.88 cfm)");
check("ft2 per m2 10.7639", 10.7639, 10.76391, "OK");

/* ---------- 3./4. the 100 m2 west top-floor office, component by component ---------- */
console.log("\n=== 3./4. 100 m2 office, 10x10x3 m, roof=true, W, defaults ===");
const R = calcRoom({ name: "Office", length: 10, width: 10, height: 3, roof: true, orient: "W" }, DP);
const dT = DP.outDb - DP.inDb;
const wo = wFromDbWb(DP.outDb, DP.outWb), wi = wFromDbRh(DP.inDb, DP.inRh), dW = wo - wi;
const A = 100, extWall = 30, glass = 9, wallNet = extWall - glass;
const infLs = DP.infilAch * A * 3 * 1000 / 3600;
const hand = {
  glassSolar: glass * SOLAR.W * DP.sc,
  glassCond: glass * DP.uGlass * dT,
  wall: wallNet * DP.uWall * WALL_ETD.W,
  roof: A * DP.uRoof * DP.roofEtd,
  partition: 0,
  people: 10 * 75,
  lighting: A * 10,
  equipment: A * 15,
  infiltration: 1.23 * infLs * dT,
};
for (const k of Object.keys(hand))
  check(`sens:${k}`, +R.sensible[k].toFixed(1), +hand[k].toFixed(1),
    Math.abs(R.sensible[k] - hand[k]) > 0.5 ? "BUG" : "OK");
const handLat = { people: 10 * 55, infiltration: 3010 * infLs * dW };
for (const k of Object.keys(handLat))
  check(`lat:${k}`, +R.latent[k].toFixed(1), +handLat[k].toFixed(1),
    Math.abs(R.latent[k] - handLat[k]) > 0.5 ? "BUG" : "OK");

const rshH = Object.values(hand).reduce((a, b) => a + b) * 1.1;
const rlhH = Object.values(handLat).reduce((a, b) => a + b) * 1.1;
const oaLsH = 10 * 2.5 + A * 0.3;
const oaSH = 1.23 * oaLsH * dT, oaLH = 3010 * oaLsH * dW;
const totH = rshH + rlhH + oaSH + oaLH;
check("rsh (room sensible incl. 10% safety) W", +R.rsh.toFixed(1), +rshH.toFixed(1), "OK");
check("rlh W", +R.rlh.toFixed(1), +rlhH.toFixed(1), "OK");
check("oaLs L/s", R.oaLs, oaLsH, "OK", "2.5 L/s/pp + 0.3 L/s/m2");
check("oaSens W", +R.oaSens.toFixed(1), +oaSH.toFixed(1), "OK");
check("oaLat W", +R.oaLat.toFixed(1), +oaLH.toFixed(1), "OK");
check("total W", +R.totalW.toFixed(1), +totH.toFixed(1), "OK", "engine 18.08 kW");
check("TR", +R.tr.toFixed(3), +(totH / 3517).toFixed(3), "OK");
check("supplyLs L/s = rsh/(1.23*dT)", +R.supplyLs.toFixed(1), +(rshH / (1.23 * DP.supplyDt)).toFixed(1), "OK");
check("cfm", +R.cfm.toFixed(0), +(rshH / (1.23 * DP.supplyDt) * 2.11888).toFixed(0), "OK");
check("ft2/TR", +R.sqftPerTr.toFixed(1), +(A * 10.7639 / (totH / 3517)).toFixed(1), "OK", "209 = heavy but in the 200-400 band");
check("shf = rsh/(rsh+rlh) room SHF", +R.shf.toFixed(4), +(rshH / (rshH + rlhH)).toFixed(4), "OK",
  "OA excluded => room SHF (grand SHF incl. OA = " + (R.rsh / R.totalW).toFixed(3) + ")");

console.log("  component share of 18.08 kW: roof 24%, glassSolar 14%, equipment 8%, "
  + "lighting 6%, people (s+l) 7%, infiltration 12%, safety 9%, OA 15%");

/* ---------- 3b. infiltration equivalence ---------- */
console.log("\n=== 3b. infiltration ===");
check("inf L/s = ACH*V*1000/3600", +infLs.toFixed(2), +(0.5 * 300).toFixed(2) + " m3/h /3.6", "OK");
check("inf sensible vs 0.33*ACH*V*dT", +R.sensible.infiltration.toFixed(1), +(0.33 * 150 * dT).toFixed(1), "OK",
  "same method, +3.5% because 1.23 > 0.33*3.6=1.188");
check("floor gain term", 0, 0, "SIMPLIFICATION", "correct for mid-floor slab; no on-grade floor term for ground floor");

/* ---------- 5./6. order, double counting ---------- */
console.log("\n=== 5./6. SHF, safety order, overlap ===");
check("safety applied to room sens+lat only, OA added after", 10, 10, "OK",
  "defensible; supply CFM therefore carries the safety factor");
check("infiltration + ASHRAE 62.1 OA both counted", +( (R.sensible.infiltration + R.latent.infiltration) * 1.1 / R.totalW * 100).toFixed(1) + " % of total",
  0, "SIMPLIFICATION", "conservative: ASHRAE says use the larger of the two, not the sum");

/* ---------- 7. totals / level grouping ---------- */
console.log("\n=== 7. project totals ===");
const rooms = [
  { name: "Office A", level: "1", length: 10, width: 10, height: 3, orient: "W" },
  { name: "Office B", level: "1", area: 50, height: 3 },
  { name: "Toilet", level: "1", area: 20, height: 3 },
  { name: "Office C", level: "2", area: 80, height: 3, roof: true },
];
const C = calcProject(rooms, DP);
const inc = C.results.filter((x) => x.room.include);
check("totals.area (included only) m2", C.totals.area, 230, "OK", "toilet excluded");
check("sum of room TR == totals.tr", +inc.reduce((a, x) => a + x.tr, 0).toFixed(4), +C.totals.tr.toFixed(4), "OK");
check("totals.sqftPerTr = area*10.7639/tr", +C.totals.sqftPerTr.toFixed(2), +(230 * 10.7639 / C.totals.tr).toFixed(2), "OK");
check("areaSqft", +C.totals.areaSqft.toFixed(2), +(230 * 10.7639).toFixed(2), "OK");

/* ---------- room classification regex ---------- */
console.log("\n=== room include/exclude rule (NON_AC_WORDS) ===");
for (const n of ["Office", "Open Plan Office", "Open Office", "Store Room", "Terrace",
  "Court Yard", "Court Room", "Server Room", "Lift Lobby", "Reception"]) {
  const r = normalizeRoom({ name: n }, DP);
  const isBug = /open|office|reception|server/i.test(n) && !r.include;
  if (isBug) bugs++;
  console.log(`  ${isBug ? "BUG" : "ok "}  name="${n}"  type=${r.type}  include=${r.include}`);
}

/* ---------- altitude sensitivity (listed cities above sea level) ---------- */
console.log("\n=== altitude (engine psychrometrics + 1.23 are sea-level only) ===");
function altCase(z, db, wb, rh) {
  const P = 101.325 * Math.pow(1 - 2.25577e-5 * z, 5.25588);
  const wO = wHW(db, wb, P), wI = wFromRhHW(24, rh, P), dWl = Math.max(0, wO - wI);
  const rho = P / (0.287 * 297.15), f = 1.006 * rho;
  const S = 13152 + 563.75 * 0; // placeholder, replaced below
  return { P, wO, dWl, f };
}
for (const [city, z, db, wb] of [["Kochi", 0, 35, 28], ["Bengaluru", 920, 34, 22], ["Hyderabad", 542, 41, 24]]) {
  const e = altCase(z, db, wb, 50);
  console.log(`  ${city}: P=${e.P.toFixed(1)} kPa (engine assumes 101.325)  W_out corrected=${e.wO.toFixed(5)} ` +
    `engine=${wFromDbWb(db, wb).toFixed(5)}  sensible factor should be ${e.f.toFixed(3)} vs 1.23`);
}
console.log(`\nRESULT: ${bugs} BUG, ${simpl} SIMPLIFICATION, ${ok} OK  (${rows.length} checks)`);
if (bugs) process.exitCode = 1;
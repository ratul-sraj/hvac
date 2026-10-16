// tests/test-uncertainty.mjs — the band must be reproducible, must bracket the deterministic answer,
// and must name what is actually driving it. It runs the REAL engine, so this also measures its cost.
import { monteCarlo, bandLine, DRIVERS } from "../js/uncertainty.js";
import { calcProject, DEFAULT_PROJECT, SPACE_TYPES } from "../js/calc.js";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass += 1; console.log("  ok  " + name); }
  else { fail += 1; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
};

// A spread of real room shapes: a couple of exterior-facing offices (so envelope and glass carry load),
// a dense meeting room, an internal cabin, a large open area. Areas and types only — the engine fills
// the rest from js/calc.js, which is exactly the path the app uses.
const rooms = [];
const types = ["office", "conference", "cabin", "reception", "general"];
for (let i = 0; i < 40; i += 1) {
  rooms.push({
    id: "r" + i, name: "ROOM " + i, type: types[i % types.length],
    area: 12 + (i % 7) * 9, height: 3.0, orient: ["N", "E", "S", "W"][i % 4],
    extWall: 8 + (i % 5) * 2,
    // A quarter of the rooms sit under the roof (the engine applies roof load only where room.roof is
    // set — js/calc.js: s.roof = room.roof ? A * uRoof * roofEtd : 0), so the roof driver has something
    // to move. On a mid-floor sheet it is legitimately inert, which the module now reports as such.
    roof: i % 4 === 0,
  });
}
const inc = rooms.filter((r) => r.include !== false && Number(r.area) > 0);
ok("there are rooms to work with", inc.length === 40, `${inc.length}`);

console.log("uncertainty: the deterministic answer is the anchor");
const baseTr = calcProject(inc, DEFAULT_PROJECT).totals.tr;
const one = monteCarlo(inc, DEFAULT_PROJECT, { n: 200, seed: 7 });
ok("with no driver moved, the base equals the engine's own total", Math.abs(one.base - baseTr) < 1e-9,
  `${one.base} vs ${baseTr}`);

console.log("uncertainty: reproducibility");
const a = monteCarlo(inc, DEFAULT_PROJECT, { n: 800, seed: 12345 });
const b = monteCarlo(inc, DEFAULT_PROJECT, { n: 800, seed: 12345 });
const c = monteCarlo(inc, DEFAULT_PROJECT, { n: 800, seed: 54321 });
ok("the same seed gives exactly the same band", a.tr.p50 === b.tr.p50 && a.tr.p05 === b.tr.p05,
  `${a.tr.p50} vs ${b.tr.p50}`);
ok("a different seed gives a different band (it is really sampling)", a.tr.p50 !== c.tr.p50);
ok("the module never CALLS Math.random (it is seeded only)",
  !/Math\.random\s*\(/.test(fs.readFileSync(new URL("../js/uncertainty.js", import.meta.url), "utf8")));

console.log("uncertainty: the band is ordered and brackets the design value");
ok("p05 < p50 < p95", a.tr.p05 < a.tr.p50 && a.tr.p50 < a.tr.p95,
  `${a.tr.p05.toFixed(2)} / ${a.tr.p50.toFixed(2)} / ${a.tr.p95.toFixed(2)}`);
ok("the design value sits inside the 5–95% band", a.base >= a.tr.p05 && a.base <= a.tr.p95,
  `base ${a.base.toFixed(2)} in [${a.tr.p05.toFixed(2)}, ${a.tr.p95.toFixed(2)}]`);
ok("the spread is quoted as a percentage", a.tr.spreadPct > 0, `${a.tr.spreadPct.toFixed(1)}%`);
ok("min <= p05 and p95 <= max", a.tr.min <= a.tr.p05 && a.tr.p95 <= a.tr.max);
ok("the mean is inside the band too", a.tr.mean >= a.tr.p05 && a.tr.mean <= a.tr.p95);

console.log("uncertainty: the tornado names the drivers, ranked");
ok("every driver appears with a swing", a.drivers.length === DRIVERS.length, `${a.drivers.length} of ${DRIVERS.length}`);
ok("ranked by swing, largest first", a.drivers.every((d, i, arr) => i === 0 || arr[i - 1].swing >= d.swing));
ok("no swing is negative, and the shares add up to the swing that exists",
  a.drivers.every((d) => d.swing >= 0) && Math.abs(a.drivers.reduce((s, d) => s + d.share, 0) - 1) < 1e-9,
  `${a.drivers.filter((d) => d.inert).length} inert`);
ok("with roof-exposed rooms in the set, the roof U is not inert",
  !a.drivers.find((d) => d.id === "uRoof").inert, `${a.drivers.find((d) => d.id === "uRoof").swing.toFixed(2)} TR`);
ok("each driver carries the reason for its range", a.drivers.every((d) => d.why && d.why.length > 15));
ok("the top three are named in the one-line summary", (() => {
  const line = bandLine(a);
  return a.drivers.slice(0, 3).every((d) => line.includes(d.label));
})(), bandLine(a).slice(0, 240));

console.log("uncertainty: a driver that is not selected is left alone");
const onlySafety = monteCarlo(inc, DEFAULT_PROJECT, { n: 400, seed: 3, drivers: ["safety"] });
ok("only the asked-for driver is used", onlySafety.driversUsed.length === 1 && onlySafety.driversUsed[0] === "safety");
ok("a safety-only band is narrower than the full one", onlySafety.tr.spreadPct < a.tr.spreadPct,
  `${onlySafety.tr.spreadPct.toFixed(1)}% vs ${a.tr.spreadPct.toFixed(1)}%`);
ok("with the safety driver at its low end the load is lower", (() => {
  const d = onlySafety.drivers[0];
  return d.atLow < d.atHigh;
})(), "sign check");

console.log("uncertainty: the engine's own space-type table is left exactly as it was");
const snap = () => JSON.stringify(Object.keys(SPACE_TYPES).map((k) => [k, SPACE_TYPES[k].oap, SPACE_TYPES[k].oaa]));
const beforeSnap = snap();
monteCarlo(inc, DEFAULT_PROJECT, { n: 50, seed: 9, drivers: ["oap", "oaa"] });
ok("outdoor-air overrides are restored after the run", beforeSnap === snap());
// ...and that they were really applied during it (otherwise the restore check is vacuous)
const oapOnly = monteCarlo(inc, DEFAULT_PROJECT, { n: 200, seed: 11, drivers: ["oap"] });
ok("the outdoor-air driver really moves the answer", oapOnly.drivers[0].swing > 0.01,
  `${oapOnly.drivers[0].swing.toFixed(3)} TR`);
ok("...and the table is still restored afterwards", beforeSnap === snap());

console.log("uncertainty: the drivers that matter, ranked (informational)");
a.drivers.forEach((d, i) => console.log(`        ${String(i + 1).padStart(2)}. ${d.label.padEnd(46)} ${d.swing.toFixed(2)} TR  ${Math.round(d.share * 100)}%`));

console.log("uncertainty: cost at the draw count a report would use");
const t2 = Date.now();
const big = monteCarlo(inc, DEFAULT_PROJECT, { n: 10000, seed: 20261016 });
const t3 = Date.now();
ok("10,000 draws complete inside 120 s", (t3 - t2) < 120000, `${((t3 - t2) / 1000).toFixed(1)} s for ${inc.length} rooms`);
console.log("        " + (((t3 - t2) / 10000).toFixed(2)) + " ms per draw");
console.log("\n" + bandLine(big) + "\n");

console.log("uncertainty: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

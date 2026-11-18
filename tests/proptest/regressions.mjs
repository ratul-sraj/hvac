// tests/proptest/regressions.mjs — one deterministic test per property finding.
//
//   node tests/proptest/regressions.mjs
//
// Each block is written the way a reviewer reads it: the trigger, what the code does, and what the
// contract says it should do. A failing line here is a REAL bug, not a fuzzer disagreement — the
// numbers are fixed, no randomness. This file is deliberately NOT wired into tests/run.mjs: it stays
// red until the bug is fixed, and the main suite must stay green.
import { num, calcProject, calcRoom, DEFAULT_PROJECT } from "../../js/calc.js";
import { reconcileAreas } from "../../js/reconcile.js";
import { toCsv } from "../../js/report.js";
import { createBucket } from "../../lib/ratelimit.js";

let fails = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  fails += 1;
  console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ""}`);
};

console.log("\nBUG 1 — a plain 3-decimal number is multiplied by 1000 (js/calc.js num())");
console.log("  The doc block says: a comma AND a dot where the comma follows the dot means thousands.");
console.log("  A dot on its own is the decimal point. But the dot-thousands branch does not require");
console.log("  the comma, so any plain n.mmm value is read as thousands.");
ok('num("0.125") === 0.125', num("0.125") === 0.125, `got ${num("0.125")}`);
ok('num("2.750") === 2.75', num("2.750") === 2.75, `got ${num("2.750")}`);
ok('num("12.345") === 12.345', num("12.345") === 12.345, `got ${num("12.345")}`);
ok('num("100.125") === 100.125', num("100.125") === 100.125, `got ${num("100.125")}`);

console.log("\nBUG 1 — so a room typed as 12.345 m2 is calculated as 12,345 m2");
{
  const room = { id: "1", name: "Office", type: "office", height: 3, people: 4, light: 10, equip: 5, orient: "W", extWall: 12, glass: 4, partition: 0, roof: false };
  const typed = calcProject([{ ...room, area: "12.345" }], DEFAULT_PROJECT).totals.tr;
  const real = calcProject([{ ...room, area: 12.345 }], DEFAULT_PROJECT).totals.tr;
  ok("a typed 12.345 m2 room loads the same as a numeric 12.345 m2 room", Math.abs(typed - real) < 0.01, `${typed.toFixed(2)} TR vs ${real.toFixed(2)} TR (${(typed / real).toFixed(0)}x)`);
}

console.log("\nBUG 1 — and the CSV prints the small area beside the huge load");
{
  const room = { id: "1", name: "Office", type: "office", area: "12.345", height: 3, people: 4, light: 10, equip: 5, orient: "W", extWall: 12, glass: 4, partition: 0, roof: false };
  const res = calcProject([room], DEFAULT_PROJECT);
  const row = toCsv(DEFAULT_PROJECT, res).split("\r\n").find((r) => r.startsWith("yes")).split(",");
  const areaCell = Number(row[5]);          // Area m2 column
  const trCell = Number(row[19]);           // TR column
  ok("the exported area cell and the exported TR belong to the same room size", areaCell > 1000 === trCell > 50, `area ${areaCell} m2 with TR ${trCell} — one of the two is wrong`);
}

console.log("\nBUG 1 (same family) — the export's area cell used parseFloat instead of the engine's parser");
console.log("  A comma-thousands area was read as 1 by parseFloat while the load used 1249.3, so the CSV");
console.log("  printed area 1.00 alongside a load computed for 1,249 m2.");
{
  const room = { id: "1", name: "Office", type: "office", area: "1,249.3", height: 3, people: 4, light: 10, equip: 5, orient: "W", extWall: 12, glass: 4, partition: 0, roof: false };
  const res = calcProject([room], DEFAULT_PROJECT);
  const row = toCsv(DEFAULT_PROJECT, res).split("\r\n").find((r) => r.startsWith("yes")).split(",");
  ok("a 1,249.3 m2 room exports an area cell of 1249.30", Math.abs(Number(row[5]) - 1249.3) < 0.01, `got ${row[5]}`);
}

console.log("\nBUG 2 — the rate-limit store can hold one more entry than maxKeys (lib/ratelimit.js)");
console.log("  prune() returns early when excess <= 0, and it is called at size >= maxKeys, so the");
console.log("  insert that follows is allowed to overshoot by one.");
{
  const b = createBucket({ max: 5, windowMs: 60000, now: () => 0, maxKeys: 3 });
  for (const k of ["a", "b", "c", "d"]) b.take(k);
  ok("size() <= maxKeys after more distinct keys than maxKeys", b.size() <= 3, `kept ${b.size()} with maxKeys 3`);
}

console.log("\nBUG 3 — reconcileAreas() counts rooms the load excluded (latent: js/report.js filters first)");
console.log("  reconcileAreas filters r.include !== false on the RAW room, but include is only derived in");
console.log("  calc.js normalizeRoom(). Called with un-normalised rooms it reports rooms the load dropped.");
{
  const raw = [{ id: "x", name: "Stair 2", area: 28.96, areaStated: 29 }];
  const reported = reconcileAreas(raw).rows.length;
  const counted = calcProject(raw, DEFAULT_PROJECT).totals.rooms;
  ok("reconcileAreas(raw) reports the number of rooms the load counted", reported === counted, `${reported} vs ${counted}`);
}

console.log(`\n${fails ? `${fails} failing assertion(s) — these are the open findings` : "all regression checks pass"}`);
process.exit(fails ? 1 : 0);

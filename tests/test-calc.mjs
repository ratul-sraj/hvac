// Engine tests for js/calc.js — regression + sanity numbers.
import assert from "node:assert/strict";
import {
  calcProject, calcRoom, normalizeRoom, guessSpaceType, NON_AC_WORDS,
  wFromDbWb, wFromDbRh, rhFromDbW, DEFAULT_PROJECT, COUNTRIES, CLIMATES,
} from "../js/calc.js";

// ---- room classification (regression: "Open Plan Office" was dropped from totals) ----
export function testOpenPlanOfficeIsConditioned() {
  assert.equal(NON_AC_WORDS.test("Open Plan Office"), false, "Open Plan Office must be air conditioned");
  assert.equal(NON_AC_WORDS.test("OPEN OFFICE"), false, "OPEN OFFICE must be air conditioned");
  assert.equal(NON_AC_WORDS.test("Open Office Area"), false);
  assert.equal(guessSpaceType("Open Plan Office"), "office");
  assert.equal(normalizeRoom({ name: "Open Plan Office", area: 100 }).include, true);
}

export function testCourtRoomIsConditioned() {
  assert.equal(NON_AC_WORDS.test("Court Room"), false, "a court room is air conditioned");
  assert.equal(NON_AC_WORDS.test("Court Hall"), false);
  // the courtyard itself is still excluded
  assert.equal(NON_AC_WORDS.test("Court Yard"), true);
  assert.equal(NON_AC_WORDS.test("COURTYARD"), true);
}

export function testNonAcRoomsStillExcluded() {
  for (const name of ["Toilet", "W.C", "Store Room", "Terrace", "Open Terrace", "Lift Lobby",
    "Corridor", "Parking", "Staircase", "Electrical Room", "Kitchen", "Balcony", "Void", "Ramp"]) {
    assert.equal(NON_AC_WORDS.test(name), true, `${name} should be excluded`);
  }
  for (const name of ["Office", "Server Room", "Reception", "WORKSTATIONS", "Meeting Room",
    "Chief Office", "Conference Room", "Bedroom", "Gym"]) {
    assert.equal(NON_AC_WORDS.test(name), false, `${name} should be included`);
  }
}

// ---- psychrometrics ----
export function testPsychrometrics() {
  const near = (a, b, pct = 1) =>
    assert.ok(Math.abs(a - b) / b * 100 < pct, `${a} vs ${b} (${((a - b) / b * 100).toFixed(2)}%)`);
  near(wFromDbWb(35, 28), 0.0211);      // Kochi design condition, ASHRAE chart value
  near(wFromDbRh(24, 50), 0.0093);      // indoor design condition
  near(wFromDbRh(30, 60), 0.01604);
  near(rhFromDbW(24, wFromDbRh(24, 50)), 50, 0.1);
  near(rhFromDbW(30, wFromDbRh(30, 100)), 100, 0.1);
}

// ---- reference room: 100 m², 10x10x3 m, top floor, west facing, defaults ----
export function testReferenceRoom() {
  const r = calcRoom({ name: "Office", length: 10, width: 10, orient: "W", roof: true }, DEFAULT_PROJECT);
  assert.equal(r.room.area, 100);
  assert.equal(r.room.people, 10);
  assert.equal(Math.round(r.totalW), 18076);       // 18.08 kW
  assert.equal(r.tr.toFixed(2), "5.14");           // 5.14 TR
  assert.equal(Math.round(r.cfm), 2060);
  assert.equal(r.sqftPerTr.toFixed(0), "209");
  // component checks (hand calculated)
  assert.equal(Math.round(r.sensible.glassSolar), 2538);   // 9 x 470 x 0.6
  assert.equal(Math.round(r.sensible.wall), 630);          // 21 x 2.0 x 15 (W ETD)
  assert.equal(Math.round(r.sensible.roof), 4400);         // 100 x 2.0 x 22
  assert.equal(Math.round(r.sensible.lighting), 1000);
  assert.equal(Math.round(r.sensible.equipment), 1500);
  assert.equal(Math.round(r.oaLat), 1950);
  assert.equal(r.shf.toFixed(3), "0.855");
}

export function testExcludedRoomsNotInTotals() {
  const p = calcProject([{ name: "Office", area: 100, orient: "W" }, { name: "Toilet", area: 10 }], DEFAULT_PROJECT);
  assert.equal(p.totals.rooms, 1);
  assert.equal(p.totals.area, 100);
  assert.equal(p.results.length, 2);   // non-AC room still shown, just not counted
}

export function testLevelTotalsAndClimates() {
  assert.ok(Object.keys(COUNTRIES).length >= 10);
  assert.equal(CLIMATES.Dubai.country, "United Arab Emirates");
  assert.equal(CLIMATES.Dubai.db, 46);
  assert.equal(DEFAULT_PROJECT.country, "India");
  const p = calcProject([
    { name: "Office A", area: 100, level: "Ground Floor", orient: "W" },
    { name: "Office B", area: 100, level: "L1 Floor", orient: "E" },
  ], DEFAULT_PROJECT);
  assert.equal(p.totals.rooms, 2);
  // two 100 m² offices, no roof exposure: ~7.4 TR, i.e. ~290 ft²/TR (normal band for offices)
  assert.ok(p.totals.tr > 7 && p.totals.tr < 8, `tr=${p.totals.tr}`);
  assert.ok(p.totals.sqftPerTr > 250 && p.totals.sqftPerTr < 320, `ft2/TR=${p.totals.sqftPerTr}`);
  // a top-floor room must be heavier than the same room without roof exposure
  const withRoof = calcRoom({ name: "Office", area: 100, orient: "W", roof: true }, DEFAULT_PROJECT);
  assert.ok(withRoof.tr > calcRoom({ name: "Office", area: 100, orient: "W" }, DEFAULT_PROJECT).tr);
}
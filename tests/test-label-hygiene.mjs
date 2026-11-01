// Label hygiene on NAME-ONLY sheets: obvious non-room text (drawing notes, license/title-page
// prose, sentence fragments) must not become room rows — and genuine room names must survive
// untouched, including unusual names, short tags, foreign names and repeated rooms.
//
// Every fixture string and placement below is copied verbatim from the text layer of a real
// drawing in the corpus (`.cache/corpus/plans/`) — the entrance-foyer notice sheet, the Farmhouse
// drawing set (cover/license page), the Queensland Stock Institute sheet and the 1921 garden
// apartments newspaper page. The parser sees exactly what those sheets print; nothing is invented.
//
// The shipped sample plans (samples/level-11-floor-plan.pdf, samples/waller-estate-floor-plan.pdf,
// tests/samples/sample-plan.pdf) are parsed whole, so a hygiene rule that eats a real label fails
// here as a row-count change instead of shipping.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseText, parsePdf } from "../js/pdfparse.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const it = (str, x, y, page = 1, h = 10, w = 0) => ({ str, x, y, h, w, page });
const names = (rooms) => rooms.map((r) => r.name);
const reasons = (skipped) => skipped.map((s) => s.reason);

// ---------------------------------------------------------------- the regression (real corpus)

/** The real "Floor Plan - Entrance Foyer (with blocked area)" sheet has 11 text strings and NO
 *  area figures: 9 of them are a venue notice ("Keys:", "Area cannot" / "be blocked", a height
 *  limit, three wrapped sentences), one is a date stamp, one page-number/notice line the parser
 *  already refuses (§SHEET_RE). Only "passage" — the wrapped tail of the notice sentence, but a
 *  plausible room word on its own — may survive; a note line must never become a room name. */
export function testRealFoyerNotesAreNotRooms() {
  const items = [
    it("Keys:", 43.56, 93.86, 1, 15),
    it("Area cannot", 43.56, 124.94, 1, 15),
    it("be blocked", 43.56, 145.94, 1, 15),
    it("-Height limit: 8 ft.", 390.07, 654.58, 1, 11.04),
    it("-All exits and corridors must not be", 390.07, 679.92, 1, 11.04),
    it("blocked and at least 1-metre space", 390.07, 695.28, 1, 11.04),
    it("needs to be reserved for each", 390.07, 710.76, 1, 11.04),
    it("passage", 390.07, 726.36, 1, 11.04),
    it("Updated on 8 Mar 2013 by KC", 9.24, 18.96, 1, 11.04),
    it("Points to note:", 390.07, 627.94, 1, 14.04),
    it("**All set up and layout plan should be subject to venue\u2019s separate approval", 43.92, 772.44, 1, 15.96),
  ];
  const { rooms, skipped } = parseText(items);
  assert.deepEqual(names(rooms), ["passage"],
    `only the ambiguous room word may survive the notice page, got ${JSON.stringify(names(rooms))}`);
  assert.ok(skipped.length >= 8, `the note lines are reported as skipped, got ${skipped.length}`);
  for (const s of skipped) {
    assert.equal(typeof s.name, "string");
    assert.equal(typeof s.reason, "string");
    assert.equal(s.page, 1);
  }
}

/** License / title-page prose from three real sheets must not become rooms, while a real room
 *  name printed on the same page still does. */
export function testLicenseAndTitleProseIsNotRooms() {
  const items = [
    // Farmhouse Drawing Set V-001, page 1 (the CC license block under the cover)
    it("COMMONS ATTRIBUTION SHARE-ALIKE LICENSE. TO", 897.88, 703.96, 1, 6.24),
    it("HTTP://CREATIVECOMMONS.ORG/LICENSES/BY-SA/3.0 . IN", 897.76, 719.08, 1, 6.24),
    it("ATTRIBUTION", 1115.92, 74.92, 1, 4.68),
    it("SHARE-ALIKE", 1161.69, 74.92, 1, 4.68),
    // Queensland Stock Institute sheet, page 2: a heritage-citation caption
    it("Buildings:", 642.84, 445.74, 2, 3.5),
    it("and Resource Management) 2012, using Quantum GIS (QGIS) version 1.7.4.", 642.84, 465.29, 2, 3.5),
    it("\u00a9 Bootstrap Heritage", 642.84, 473.12, 2, 3.5),
    // Twenty-six Garden Apartment Houses (1921 newspaper page), page 3: masthead metadata
    it("Published: September 25, 1921", 681.69, 2461.0, 3, 14),
    it("Copyright \u00a9 The New York Times", 675.4, 2479.0, 3, 14),
    // control: a genuine room name on the same sheet must still come through
    it("MEETING ROOM", 400, 300, 1, 12),
  ];
  const { rooms, skipped } = parseText(items);
  assert.deepEqual(names(rooms), ["MEETING ROOM"],
    `license/title prose must not be rooms; got ${JSON.stringify(names(rooms))}`);
  assert.ok(skipped.length >= 9, `all license/title lines are reported, got ${skipped.length}`);
  assert.ok(reasons(skipped).includes("metadata"), "the \u00a9/URL lines are skipped as metadata");
  assert.ok(reasons(skipped).includes("heading"), "the \"Buildings:\" caption is skipped as a heading");
}

// ---------------------------------------------------------------- negative controls

/** Real room names — including the ones a blunt rule would eat (COURT OPERATOR's second word,
 *  short tags WC/STORE/IN/OUT, a possessive, lower-case house tags) — must all survive the
 *  name-only fallback, and repeated names at distinct positions must stay distinct rows. */
export function testGenuineRoomNamesSurviveNameOnlyFallback() {
  const keep = [
    "PUBLIC FOYER", "BLACK SATURDAY GALLERY", "COURT OPERATOR", "ANTHECHAMBER", "ANTEROOM",
    "GALLERY", "WC", "STORE", "DINING", "KITCHEN", "MEETING ROOM", "SECURE STORE",
    "COMMISSIONERS\u2019 BENCH", "EMERGENCY EXIT", "BED ROOM 3", "SEW", "IN", "OUT",
    "balcony", "bedroom", "ensuit", "bathroom", "HERR.", "SOVEROM", "SALLE \u00c0 MANGER",
  ];
  const items = keep.map((n, i) => it(n, 60 + (i % 4) * 260, 40 + Math.floor(i / 4) * 34, 1, 10));
  const { rooms, skipped } = parseText(items);
  const got = new Set(names(rooms));
  for (const n of keep) assert.ok(got.has(n), `genuine name "${n}" must survive; skipped=${JSON.stringify(skipped)}`);
  assert.equal(skipped.length, 0, `no genuine name may be skipped: ${JSON.stringify(skipped)}`);

  // repeated rooms at distinct positions stay distinct rows (L11 really prints MEETING ROOM x4 —
  // an unknown-area room is deduped by name + the point the sheet names it at, which comes from
  // atPdf on a real sheet, so each fixture row carries the position its tag has)
  const at = (x, y) => ({ str: "MEETING ROOM", x, y, h: 10, page: 1, atPdf: { x, y: 900 - y } });
  const repeated = parseText([
    at(100, 100), at(500, 100), at(100, 400), at(500, 400),
  ]);
  assert.equal(repeated.rooms.length, 4, "four MEETING ROOM tags at four spots are four rows");
  assert.equal(repeated.skipped.length, 0);
}

// These are deliberately adversarial valid-name controls, not corpus-derived fixtures.
// Weak clues (word count, an article, a colon, or a word also used as a verb) cannot by themselves
// prove that a label is prose. A false exclusion makes a real room disappear from coverage.
export function testPlausibleRoomNamesSurviveWeakNoteClues() {
  const keep = [
    "SPECIAL NEEDS CLASSROOM",
    "THE LOUNGE",
    "HOT AND COLD WATER PUMP ROOM",
    "SALA DO PROFESSOR",
    "NO BREAK UPS ROOM",
    "MEETING ROOM: EAST",
    "SALLE DE REUNION DU PERSONNEL MEDICAL",
  ];
  for (const name of keep) {
    const result = parseText([
      { str: name, x: 100, y: 100, h: 10, page: 1, atPdf: { x: 100, y: 900 } },
    ]);
    assert.deepEqual(names(result.rooms), [name],
      `a plausible room name must be retained, not guessed away: ${JSON.stringify(result.skipped)}`);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.rooms[0].area, null);
    assert.equal(result.rooms[0].areaUnknown, true);
    assert.equal(result.rooms[0].include, false);
  }
}

/** Punctuation alone never removes a label: a name that ends in ":" or opens with a list dash is
 *  still a room. Both forms occur in real plans as part of the printed name, so MEETING ROOM: and
 *  - STORE must survive on name alone. */
export function testPunctuatedLabelsSurvive() {
  for (const name of ["MEETING ROOM:", "- STORE"]) {
    const result = parseText([
      { str: name, x: 100, y: 100, h: 10, page: 1, atPdf: { x: 100, y: 900 } },
    ]);
    assert.deepEqual(names(result.rooms), [name],
      `punctuation alone must not remove a label: ${JSON.stringify(result.skipped)}`);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.rooms[0].area, null);
    assert.equal(result.rooms[0].areaUnknown, true);
    assert.equal(result.rooms[0].include, false);
  }
}

/** Name-only rows keep their contract: area stays null + areaUnknown, include stays false, and
 *  the hygiene rules never touch a label that carries a printed area. */
export function testNameOnlyRowsKeepUnknownAreaContract() {
  const nameOnly = parseText([
    { str: "PUBLIC FOYER", x: 100, y: 100, h: 10, page: 1, atPdf: { x: 640.5, y: 498.25 } },
  ]);
  assert.equal(nameOnly.rooms.length, 1);
  const r = nameOnly.rooms[0];
  assert.equal(r.area, null, "a name-only room has no area");
  assert.equal(r.areaUnknown, true);
  assert.equal(r.include, false, "an unknown area is never included in the load");
  assert.deepEqual(r.at, { x: 640.5, y: 498.25 }, "the position the sheet names it at is kept");

  // a label that DOES carry an area goes down the unchanged path, even if its text reads oddly
  const withArea = parseText([
    it("MEETING ROOM", 100, 200, 1, 10), it("33.5 m\u00b2", 100, 216, 1, 10),
  ]);
  assert.equal(withArea.rooms.length, 1);
  assert.equal(withArea.rooms[0].area, 33.5);
  assert.equal(withArea.rooms[0].include, true);
  assert.equal("areaUnknown" in withArea.rooms[0], false);
}

// ---------------------------------------------------------------- shipped sample plans

const loadPdf = async (file) => {
  const buf = fs.readFileSync(file);
  return parsePdf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { pdfjs });
};

export async function testShippedSamplePlansKeepTheirRowCounts() {
  const L11 = path.join(HERE, "..", "samples", "level-11-floor-plan.pdf");
  const WALLER = path.join(HERE, "..", "samples", "waller-estate-floor-plan.pdf");
  const SAMPLE = path.join(HERE, "samples", "sample-plan.pdf");
  const missing = [L11, WALLER, SAMPLE].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.log(`  SKIP  shipped sample plans not on disk: ${missing.map((f) => path.basename(f)).join(", ")}`);
    return;
  }

  // L11 prints 56 names and no areas: the parser must keep all 56 rows and skip nothing
  const l11 = await loadPdf(L11);
  assert.equal(l11.rooms.length, 56, `L11 must stay 56 rows, got ${l11.rooms.length}`);
  assert.equal((l11.skipped || []).length, 0,
    `no L11 label may be classified as a note: ${JSON.stringify(l11.skipped)}`);
  assert.ok(l11.rooms.every((r) => r.area === null && r.areaUnknown === true && r.include === false),
    "every L11 row stays area-unknown and out of the load");
  const l11Names = names(l11.rooms);
  for (const n of ["PUBLIC FOYER", "BLACK SATURDAY GALLERY", "COURT OPERATOR", "MEETING ROOM",
    "COMMISSIONERS\u2019 BENCH", "IN", "OUT", "MONITOR"]) {
    assert.ok(l11Names.includes(n), `L11 still carries "${n}"`);
  }
  for (const n of ["MEETING ROOM", "COURT OPERATOR", "MONITOR"]) {
    assert.equal(l11Names.filter((x) => x === n).length, { "MEETING ROOM": 4, "COURT OPERATOR": 2, MONITOR: 7 }[n],
      `L11 prints "${n}" more than once and each row must stay`);
  }

  // Waller house plan: 10 names, no areas
  const waller = await loadPdf(WALLER);
  assert.equal(waller.rooms.length, 10, `Waller must stay 10 rows, got ${waller.rooms.length}`);
  assert.equal((waller.skipped || []).length, 0, `no Waller label may be skipped: ${JSON.stringify(waller.skipped)}`);
  for (const n of ["WC", "PORCH", "BED ROOM 3", "BATH", "DINING ROOM", "GALLERY", "LOUNGE", "KITCHEN"]) {
    assert.ok(names(waller.rooms).includes(n), `Waller still carries "${n}"`);
  }

  // the synthetic shipped fixture prints its areas in schedules/tags: 159 rows, unchanged path
  const sample = await loadPdf(SAMPLE);
  assert.equal(sample.rooms.length, 159, `sample-plan.pdf must stay 159 rows, got ${sample.rooms.length}`);
  assert.ok(sample.rooms.some((r) => r.area > 0), "printed areas still come through");
}

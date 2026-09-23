// Pure unit tests for parseText() / the small helpers — no PDF needed.
// items are in display coordinates (x right, y DOWN), like reading the page.
import assert from "node:assert/strict";
import { parseText, parseDims, parseAreaToken, detectLevelTitle } from "../js/pdfparse.js";

const it = (str, x, y, page = 1, h = 8) => ({ str, x, y, h, page });
const byName = (rooms, name) => rooms.find((r) => r.name === name);

// ---------------------------------------------------------------- helpers

export function testAreaTokenParsing() {
  assert.equal(parseAreaToken("33.5 m²").value, 33.5);
  assert.equal(parseAreaToken("1,249.3 m²").value, 1249.3, "thousands separator");
  assert.equal(parseAreaToken("OFFICE 22.4 m²").value, 22.4, "area embedded in a longer string");
  assert.equal(parseAreaToken("45.5 m2").value, 45.5);
  assert.equal(parseAreaToken("12.0 sq m").value, 12);
  assert.ok(Math.abs(parseAreaToken("500 sq ft").value - 46.45) < 0.01, "ft² -> m²");
  assert.equal(parseAreaToken("Nothing"), null);
}

export function testDimensionParsing() {
  assert.deepEqual(parseDims("4.5 x 3.6"), { length: 4.5, width: 3.6 });
  assert.deepEqual(parseDims("4500x3600"), { length: 4.5, width: 3.6 }, "mm -> m");
  const fi = parseDims(`12'-0" x 10'-6"`);
  assert.ok(Math.abs(fi.length - 3.658) < 0.01, `12'-0" = 3.658 m, got ${fi && fi.length}`);
  assert.ok(Math.abs(fi.width - 3.2) < 0.01, `10'-6" = 3.2 m, got ${fi && fi.width}`);
  assert.equal(parseDims("400 mmx350 mm"), null, "a duct size is not a room size");
}

export function testLevelTitles() {
  assert.equal(detectLevelTitle("GROUND FLOOR LAYOUT").title, "Ground Floor");
  assert.equal(detectLevelTitle("L1 FLOOR LAYOUT").title, "L1 Floor");
  assert.equal(detectLevelTitle("2ND FLOOR PLAN").title, "2nd Floor");
  assert.equal(detectLevelTitle("BASEMENT LEVEL").title, "Basement Floor");
  assert.equal(detectLevelTitle("GF Sheet Ducting Layout"), null, "a sheet title is not a level");
  assert.equal(detectLevelTitle("ø205 mm"), null);
}

// ---------------------------------------------------------------- room schedule (table)

export function testRoomScheduleTable() {
  // y grows DOWN the page, so the header row has the smallest y
  const items = [
    it("ROOM", 50, 20), it("LENGTH", 150, 20), it("WIDTH", 230, 20), it("AREA", 310, 20),

    it("Office 1", 50, 40), it("4.5 x 3.6", 150, 40), it("16.2 m²", 310, 40),

    it("Conference", 50, 60), it("6.0", 150, 60), it("4.5", 230, 60), it("27.0", 310, 60),

    it("Board Room", 50, 80), it(`12'-0" x 10'-6"`, 150, 80),

    it("101 Lobby", 50, 100), it("45.5 m2", 310, 100),

    it("Toilet", 50, 120), it("4500x3600", 150, 120),

    it("Store", 50, 140), it("3.0", 150, 140), it("2.4", 230, 140), it("7.2", 310, 140),
  ];
  const { rooms, warnings } = parseText(items);
  assert.equal(rooms.length, 6, `expected 6 schedule rows, got ${rooms.map((r) => r.name)}`);
  assert.ok(rooms.every((r) => r.source === "table"), "schedule rows are source:table");
  assert.ok(rooms.every((r) => r.id && r.type && typeof r.include === "boolean"));

  const office = byName(rooms, "Office 1");
  assert.equal(office.area, 16.2);
  assert.equal(office.length, 4.5);
  assert.equal(office.width, 3.6);
  assert.equal(office.type, "office");

  const conf = byName(rooms, "Conference");
  assert.equal(conf.area, 27, "bare number column = area");
  assert.equal(conf.length, 6);
  assert.equal(conf.width, 4.5);

  const board = byName(rooms, "Board Room");
  assert.ok(Math.abs(board.length - 3.658) < 0.01, "feet-inch length");
  assert.ok(Math.abs(board.width - 3.2) < 0.01, "feet-inch width");
  assert.ok(Math.abs(board.area - 11.71) < 0.05, `area from L×W = 11.71 m², got ${board.area}`);

  const lobby = byName(rooms, "Lobby");
  assert.ok(lobby, "leading room number split off the name cell");
  assert.equal(lobby.number, "101", "room number taken from the name cell");
  assert.equal(lobby.area, 45.5);
  assert.equal(lobby.type, "reception");

  const toilet = byName(rooms, "Toilet");
  assert.equal(toilet.area, 16.2, "4500x3600 mm = 4.5 x 3.6 m");
  assert.equal(toilet.length, 4.5);
  assert.equal(toilet.include, false, "toilet excluded from the AC load");

  assert.equal(byName(rooms, "Store").include, false);
  assert.ok(Array.isArray(warnings));
}

// ---------------------------------------------------------------- drawing room tags (label)

export function testDrawingTagsStacked() {
  const items = [
    // ground floor title
    it("GROUND FLOOR LAYOUT", 900, 1400, 1, 10),
    // room tag: name (may wrap), number, area
    it("MEETING RM.", 200, 200), it("24", 202, 208), it("33.5 m²", 204, 216),
    it("400 mmx350 mm", 205, 196), // duct label just above the tag — must be ignored
    // two-line name
    it("ENTERTAINMENT &", 230, 300), it("RECREATION", 232, 310), it("29", 236, 318), it("115.4 m²", 238, 326),
    // no number, name + area only
    it("PL 1", 260, 400), it("7.8 m²", 262, 408),
    // "Not Enclosed" instead of an area -> skipped with a warning
    it("ST. 03", 300, 500), it("S03", 302, 508), it("Not Enclosed", 304, 516),
  ];
  const { rooms, warnings } = parseText(items);
  const meeting = byName(rooms, "MEETING RM.");
  assert.ok(meeting, `MEETING RM. tag found, got ${rooms.map((r) => r.name)}`);
  assert.equal(meeting.area, 33.5);
  assert.equal(meeting.number, "24");
  assert.equal(meeting.level, "Ground Floor");
  assert.equal(meeting.source, "label");

  const ent = byName(rooms, "ENTERTAINMENT & RECREATION");
  assert.ok(ent, "multi-line name joined top-to-bottom with a space");
  assert.equal(ent.number, "29");
  assert.equal(ent.area, 115.4);

  const pl = byName(rooms, "PL 1");
  assert.ok(pl, "PL 1 has no room number");
  assert.equal(pl.area, 7.8);
  assert.equal(pl.include, false, "PL = plumbing shaft");

  assert.ok(!rooms.some((r) => r.name.includes("ST. 03")), "Not Enclosed tag skipped");
  assert.ok(warnings.some((w) => /Not Enclosed/i.test(w)), `warning about Not Enclosed, got ${JSON.stringify(warnings)}`);
  assert.ok(!rooms.some((r) => /mm|L\/S/.test(r.name)), "duct labels are not rooms");
}

export function testDuplicateLabelsDeduped() {
  const items = [
    it("OFFICE", 200, 200), it("22.4 m²", 204, 216),
    it("OFFICE", 400, 200), it("22.4 m²", 404, 216),
  ];
  const { rooms, warnings } = parseText(items);
  assert.equal(rooms.length, 1, "identical name+area on the same page kept once");
  assert.ok(warnings.some((w) => /duplicate/i.test(w)));
}

export function testEmptyInput() {
  const { rooms, warnings } = parseText([]);
  assert.deepEqual(rooms, []);
  assert.ok(warnings.length);
}
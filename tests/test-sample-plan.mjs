// Tests for the sample drawing that ships with the product: tests/samples/sample-plan.pdf.
// It is SYNTHETIC (built by tools/make-sample-plan.mjs — no client data, safe to publish) and
// shaped like the real sheets it replaces: 3 levels, room tags written as NAME / NUMBER / AREA
// stacked top-to-bottom. Every number below is MEASURED from that fixture, never invented.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { parsePdf } from "../js/pdfparse.js";
import { calcProject, DEFAULT_PROJECT } from "../js/calc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.join(HERE, "samples", "sample-plan.pdf");

// measured on this machine (node tests/_probe-style run over the fixture)
const MEASURED = { pages: 3, rooms: 159, perPage: [55, 52, 52] };

let cache = null;
const progress = [];

export async function load() {
  if (cache) return cache;
  assert.ok(fs.existsSync(PDF), `${PDF} missing — build it with: node tools/make-sample-plan.mjs`);
  const buf = fs.readFileSync(PDF);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  progress.length = 0;
  cache = await parsePdf(ab, { pdfjs, onProgress: (p, t) => progress.push([p, t]) });
  return cache;
}

const onPage = (res, page) => res.rooms.filter((r) => r.page === page);
const find = (rooms, name, area) =>
  rooms.find((r) => r.name === name && Math.abs(r.area - area) < 0.05);

export async function testSamplePlanPagesCountAndProgress() {
  const res = await load();
  assert.equal(res.pages, MEASURED.pages, `sample-plan.pdf has ${MEASURED.pages} pages`);
  assert.equal(res.rooms.length, MEASURED.rooms, `measured ${res.rooms.length} rooms`);
  assert.ok(res.rooms.length > 120, "the sample must stay a >120-room drawing");
  assert.ok(typeof res.text === "string" && res.text.length > 5000, "debug text dump returned");
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]], "onProgress(pageNo, totalPages) called per page");
  assert.ok(Array.isArray(res.warnings), "warnings is an array");
}

export async function testTransformsAreUsableDisplayCoordinates() {
  const res = await load();
  // raw pdf.js transforms are y-up; after the viewport fix the dump must read y-down, left to right,
  // and a room tag must stack with the name ABOVE its number and area.
  assert.ok(!/\[\s*NaN/.test(res.text), "no NaN coordinates in the dump");
  const name = res.text.match(/\[(\d+\.\d),(\d+\.\d)\]\s+MEETING RM\./);
  assert.ok(name, "MEETING RM. found in display coordinates");
  const y = parseFloat(name[2]);
  const near = res.text.match(new RegExp(`\\[${name[1]},${(y + 16).toFixed(1)}\\]\\s+2\\b`));
  assert.ok(near, `the tag number 2 must sit 16 pt below the name (dump: ${res.text.split("\n").find((l) => l.includes("MEETING RM."))})`);
}

export async function testPageOneRooms() {
  const res = await load();
  const p1 = onPage(res, 1);

  const meeting = find(p1, "MEETING RM.", 33.5);
  assert.ok(meeting, "page 1: MEETING RM. 33.5 m² found");
  assert.equal(meeting.number, "2", "page 1 MEETING RM. tag number is 2");
  assert.equal(meeting.type, "conference", "MEETING RM. guessed as conference");

  const ws = find(p1, "WORKSTATIONS", 167.6);
  assert.ok(ws, "page 1: WORKSTATIONS 167.6 m² found");
  assert.equal(ws.type, "office");
  assert.equal(ws.number, "16");

  const atrium = find(p1, "ATRIUM", 1249.3);
  assert.ok(atrium, "page 1: ATRIUM 1,249.3 m² found (thousands separator)");
  assert.equal(atrium.include, true, "ATRIUM is an air-conditioned space");

  const ent = find(p1, "ENTERTAINMENT & RECREATION", 115.4);
  assert.ok(ent, "page 1: two-line name ENTERTAINMENT & RECREATION joined");

  const srv = find(p1, "SERVER RM.", 11.9);
  assert.ok(srv, "page 1: SERVER RM. 11.9 m² found");
  assert.equal(srv.type, "server");
  assert.equal(srv.include, true);

  const ftl = find(p1, "F. TL.", 22.1);
  assert.ok(ftl, "page 1: F. TL. 22.1 m² found");
  assert.equal(ftl.include, false, "F. TL. (female toilet) excluded from the load");
}

export async function testJunkLabelsNeverBecomeRooms() {
  const res = await load();
  for (const r of res.rooms) {
    assert.ok(!/\bmm\b|x\s*\d+\s*mm|L\s*\/\s*S\b|ø|\u00F8/i.test(r.name), `duct label leaked into a room name: "${r.name}"`);
    assert.ok(!/^(scale|date|project|checked|drawn|no\.)$/i.test(r.name), `title block text leaked: "${r.name}"`);
    assert.ok(r.name.length >= 2 && r.name.length <= 40, `room name looks wrong: "${r.name}"`);
    assert.ok(r.area > 0, `room "${r.name}" has area ${r.area}`);
    assert.ok(r.type && typeof r.type === "string", `room "${r.name}" has a space type`);
    assert.ok(r.id.startsWith("r"), "room id");
    assert.equal(r.source, "label", "drawing tags are source:label");
  }
  // the sheet furniture (level title, SCALE/DATE text, duct sizes, "NOT ENCLOSED") is on page 1
  const furniture = ["GROUND FLOOR PLAN", "SCALE 1:100", "300 x 300 mm", "\u00F8175", "NOT ENCLOSED"];
  for (const f of furniture) {
    assert.ok(!res.rooms.some((r) => r.name === f), `"${f}" must not be a room`);
  }
  // every room from a tag must carry the sheet level it belongs to
  assert.ok(res.rooms.every((r) => r.level), "every room has a level");
}

export async function testLevelsDetected() {
  const res = await load();
  const l1 = onPage(res, 1)[0].level;
  const l2 = onPage(res, 2)[0].level;
  const l3 = onPage(res, 3)[0].level;
  assert.equal(l1, "Ground Floor");
  assert.equal(l2, "L1 Floor");
  assert.equal(l3, "L2 Floor");
  assert.equal(new Set([l1, l2, l3]).size, 3, "levels differ per page");
}

export async function testIncludeFlagsOnGroundFloor() {
  const res = await load();
  const p1 = onPage(res, 1);
  const excluded = p1.filter((r) => !r.include).map((r) => r.name);
  for (const name of ["F. TL.", "M. TL.", "FHC", "KIT.", "IDF/TEL", "ST. 01", "STORE 01", "ELEC. RM.", "ARCH. RM.", "PL 1"]) {
    assert.ok(excluded.includes(name), `${name} should be include:false, got ${JSON.stringify(excluded)}`);
  }
  const included = p1.filter((r) => r.include).map((r) => r.name);
  for (const name of ["WORKSTATIONS", "ATRIUM", "MEETING RM.", "RECEPTION", "SERVER RM.", "COFFEE SHOP"]) {
    assert.ok(included.includes(name), `${name} should be include:true`);
  }
}

export async function testPerPageCounts() {
  const res = await load();
  assert.deepEqual([1, 2, 3].map((p) => onPage(res, p).length), MEASURED.perPage);
  assert.equal(res.rooms.length, new Set(res.rooms.map((r) => r.id)).size, "ids are unique");
  // numbers are drawn per sheet, so no two rooms share (page, name, area)
  const keys = new Set(res.rooms.map((r) => `${r.page}|${r.name}|${r.area}`));
  assert.equal(keys.size, res.rooms.length, "parser kept every tag (no duplicate labels)");
}

export async function testSyntheticSampleProducesASaneLoad() {
  // selftest.html asserts these ranges in the browser; the fixture must keep satisfying them, so
  // the numbers are checked here too (a fixture that parses but loads to 3 TR is not a sample).
  const res = await load();
  const t = calcProject(res.rooms, DEFAULT_PROJECT).totals;
  assert.ok(t.tr > 50 && t.tr < 600, `total load in a sane range, got ${t.tr.toFixed(1)} TR`);
  assert.ok(t.sqftPerTr > 150 && t.sqftPerTr < 500, `area per tonne sane, got ${t.sqftPerTr.toFixed(0)} ft²/TR`);
  assert.ok(t.area > 5000 && t.area < 12000, `conditioned area sane, got ${t.area.toFixed(0)} m²`);
  assert.ok(t.rooms > 80 && t.rooms < res.rooms.length, `${t.rooms} conditioned of ${res.rooms.length} rooms`);
  assert.ok(t.ls > 2000 && t.ls < 100000, `supply air sane, got ${t.ls.toFixed(0)} L/s`);
  assert.ok(Object.values(t).every((v) => typeof v !== "number" || Number.isFinite(v)), "no NaN in totals");
}

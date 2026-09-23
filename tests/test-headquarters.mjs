// Tests for the real sample drawing: tests/samples/headquarters.pdf
// (3 sheets of a building, the sheets are rotated 90°, room tags are
//  NAME / NUMBER / AREA stacked top-to-bottom).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { parsePdf } from "../js/pdfparse.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.join(HERE, "samples", "headquarters.pdf");

let cache = null;
const progress = [];

export async function load() {
  if (cache) return cache;
  const buf = fs.readFileSync(PDF);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  progress.length = 0;
  cache = await parsePdf(ab, { pdfjs, onProgress: (p, t) => progress.push([p, t]) });
  return cache;
}

const onPage = (res, page) => res.rooms.filter((r) => r.page === page);
const find = (rooms, name, area) =>
  rooms.find((r) => r.name === name && Math.abs(r.area - area) < 0.05);

export async function testHeadquartersPagesCountAndProgress() {
  const res = await load();
  assert.equal(res.pages, 3, "headquarters.pdf has 3 pages");
  assert.ok(res.rooms.length >= 120, `expected >= 120 rooms, got ${res.rooms.length}`);
  assert.ok(typeof res.text === "string" && res.text.length > 5000, "debug text dump returned");
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]], "onProgress(pageNo, totalPages) called per page");
  assert.ok(Array.isArray(res.warnings), "warnings is an array");
}

export async function testRotationIsUndone() {
  // raw pdf.js transforms are [0,7,-8,0,...]; after the viewport fix the text must
  // read left to right and the room tags must stack with the name ABOVE the area.
  const res = await load();
  assert.ok(!/\[\s*NaN/.test(res.text), "no NaN coordinates in the dump");
  const m = res.text.match(/\[1[0-9]{3}\.[0-9],[0-9]{3}\.[0-9]\]\s+MEETING RM\./);
  assert.ok(m, "MEETING RM. found in display coordinates");
}

export async function testPageOneRooms() {
  const res = await load();
  const p1 = onPage(res, 1);
  const meeting = find(p1, "MEETING RM.", 33.5);
  assert.ok(meeting, "page 1: MEETING RM. 33.5 m² found");
  assert.equal(meeting.number, "24", "page 1 MEETING RM. tag number is 24");
  assert.equal(meeting.type, "conference", "MEETING RM. guessed as conference");

  const ws = find(p1, "WORKSTATIONS", 210.2);
  assert.ok(ws, "page 1: WORKSTATIONS 210.2 m² found");
  assert.equal(ws.type, "office");

  const atrium = find(p1, "ATRIUM", 1249.3);
  assert.ok(atrium, "page 1: ATRIUM 1,249.3 m² found (thousands separator)");
  assert.equal(atrium.include, true, "ATRIUM is an air-conditioned space");

  const ent = find(p1, "ENTERTAINMENT & RECREATION", 115.4);
  assert.ok(ent, "page 1: two-line name ENTERTAINMENT & RECREATION joined");

  const srv = find(p1, "SERVER RM.", 29);
  assert.ok(srv, "page 1: SERVER RM. 29.0 m² found");
  assert.equal(srv.type, "server");
  assert.equal(srv.include, true);

  const ftl = find(p1, "F. TL.", 20.5);
  assert.ok(ftl, "page 1: F. TL. 20.5 m² found");
  assert.equal(ftl.include, false, "F. TL. (female toilet) excluded from the load");
}

export async function testDuctLabelsNeverBecomeRooms() {
  const res = await load();
  for (const r of res.rooms) {
    assert.ok(!/\bmm\b|x\s*\d+\s*mm|L\s*\/\s*S\b/i.test(r.name), `duct label leaked into a room name: "${r.name}"`);
    assert.ok(!/^(scale|date|project|checked|drawn|no\.)$/i.test(r.name), `title block text leaked: "${r.name}"`);
    assert.ok(r.name.length >= 2 && r.name.length <= 40, `room name looks wrong: "${r.name}"`);
    assert.ok(r.area > 0, `room "${r.name}" has area ${r.area}`);
    assert.ok(r.type && typeof r.type === "string", `room "${r.name}" has a space type`);
    assert.ok(r.id.startsWith("r"), "room id");
    assert.equal(r.source, "label", "drawing tags are source:label");
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
  for (const name of ["F. TL.", "M. TL.", "ADA", "FHC", "KIT.", "IDF/TEL", "ST. 01"]) {
    assert.ok(excluded.includes(name), `${name} should be include:false, got ${JSON.stringify(excluded)}`);
  }
  const included = p1.filter((r) => r.include).map((r) => r.name);
  for (const name of ["WORKSTATIONS", "ATRIUM", "MEETING RM.", "RECEPTION", "SERVER RM.", "COFFEE SHOP"]) {
    assert.ok(included.includes(name), `${name} should be include:true`);
  }
}

export async function testPerPageCounts() {
  const res = await load();
  assert.equal(onPage(res, 1).length, 45);
  assert.ok(onPage(res, 2).length >= 45, `page 2 has ${onPage(res, 2).length} rooms`);
  assert.ok(onPage(res, 3).length >= 50, `page 3 has ${onPage(res, 3).length} rooms`);
  assert.equal(res.rooms.length, new Set(res.rooms.map((r) => r.id)).size, "ids are unique");
}
// End-to-end: build tests/samples/schedule-sample.pdf by hand, then parse it back
// with pdf.js through parsePdf(). Proves the PDF path works without any extra deps.
import assert from "node:assert/strict";
import fs from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { parsePdf } from "../js/pdfparse.js";
import { writeSample, SAMPLE_PATH } from "./make-sample.mjs";

const byName = (rooms, name) => rooms.find((r) => r.name === name);

export async function testGeneratedSamplePdf() {
  writeSample();
  assert.ok(fs.existsSync(SAMPLE_PATH), "schedule-sample.pdf written");
  const raw = fs.readFileSync(SAMPLE_PATH);
  assert.equal(raw.subarray(0, 5).toString("latin1"), "%PDF-", "looks like a PDF");
  assert.ok(raw.length > 400 && raw.length < 20000, `hand-built PDF is small (${raw.length} bytes)`);
  assert.ok(raw.toString("latin1").includes("%%EOF"), "PDF ends with %%EOF");

  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const seen = [];
  const res = await parsePdf(ab, { pdfjs, onProgress: (p, t) => seen.push(`${p}/${t}`) });

  assert.equal(res.pages, 1);
  assert.deepEqual(seen, ["1/1"], "onProgress called");
  assert.equal(res.rooms.length, 6, `6 schedule rooms, got ${res.rooms.map((r) => r.name).join(", ")}`);
  assert.ok(res.rooms.every((r) => r.source === "table"), "schedule rows are source:table");
  assert.equal(res.text.includes("Meeting Room"), true, "debug text contains the rows");
}

export async function testGeneratedSampleRooms() {
  const ab = fs.readFileSync(SAMPLE_PATH);
  const res = await parsePdf(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength), { pdfjs });

  const office = byName(res.rooms, "Office");
  assert.ok(office, "Office row found");
  assert.equal(office.area, 27);
  assert.equal(office.length, 6);
  assert.equal(office.width, 4.5);
  assert.equal(office.type, "office");
  assert.equal(office.include, true);

  const lobby = byName(res.rooms, "Lobby");
  assert.ok(lobby, "room number was split off the name cell");
  assert.equal(lobby.number, "101");
  assert.equal(lobby.area, 22);

  const toilet = byName(res.rooms, "Toilet");
  assert.ok(toilet, "Toilet row found");
  assert.equal(toilet.include, false, "toilet is not air conditioned");
  assert.equal(toilet.area, 3);

  assert.equal(byName(res.rooms, "Store").include, false);
  assert.equal(byName(res.rooms, "Meeting Room").type, "conference");
  assert.ok(res.rooms.every((r) => r.area > 0 && r.id && r.id.startsWith("r")));
  assert.equal(res.rooms.length, new Set(res.rooms.map((r) => r.id)).size, "ids unique");
}
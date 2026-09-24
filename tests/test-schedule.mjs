// Tests for js/schedule.js (CSV / TSV / XLSX room-schedule import).
//   cd D:/webhvac && node tests/test-schedule.mjs
// Plain node, no framework: prints PASS/FAIL per check and exits 1 on failure.
// Also exports its tests as test*() so a runner can pick them up.
//
// The .xlsx fixture is GENERATED here with a small hand-written zip writer, and the entries are
// really DEFLATE-compressed with node's zlib, so the imported .xlsx exercises the reader's own
// inflate + SpreadsheetML parsing rather than a fixture someone else produced.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  SCHEDULE_EXTENSIONS, isScheduleFile, parseSchedule,
  detectColumnKey, parseAreaValue, parseLengthValue, inflateRaw,
} from "../js/schedule.js";
import { calcProject, guessSpaceType, ORIENTS } from "../js/calc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_CSV = path.join(HERE, "samples", "schedule.csv");
const SAMPLE_XLSX = path.join(HERE, "samples", "schedule.xlsx");

const byName = (rooms, name) => rooms.find((r) => r.name === name);
const hasWarn = (warnings, re) => warnings.some((w) => re.test(w));
const arrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// The 9 rooms the CSV fixture should yield, name -> area in m².
const EXPECTED = {
  "Reception": 45.5,
  "Conference Room": 27,
  "Open Plan Office": 1249.3,
  "Cabin A": 45.52,           // 490 ft²
  "MD Cabin": 11.61,          // 12'-6" x 10'
  "Server Room": 16.2,        // 4500 x 3600 mm
  "Toilet - Male": 12,
  "Staircase": 18,
  "Pantry": 9.5,
};

// ---------------------------------------------------------------------------
// .xlsx fixture writer (zip + SpreadsheetML)
// ---------------------------------------------------------------------------

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const data = f.deflate ? zlib.deflateRawSync(raw, { level: 9 }) : raw; // real DEFLATE streams
    const method = f.deflate ? 8 : 0;
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x2821, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x2821, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }
  const cds = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cds.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cds, eocd]);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const colLetter = (i) => {
  let s = "";
  i++;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = (i - r - 1) / 26; }
  return s;
};

// rows: array of arrays; a cell is a string, a number, or { inline: "text" } / { formula, value }
function sheetXml(rows, sharedIndex) {
  const out = rows.map((row, ri) => {
    const cells = [];
    row.forEach((v, ci) => {
      if (v === undefined || v === null || v === "") return;   // sparse: blank cells are simply absent
      const ref = `${colLetter(ci)}${ri + 1}`;
      if (typeof v === "number") cells.push(`<c r="${ref}"><v>${v}</v></c>`);
      else if (typeof v === "object" && v.inline !== undefined)
        cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v.inline)}</t></is></c>`);
      else if (typeof v === "object" && v.formula)
        cells.push(`<c r="${ref}"><f>${esc(v.formula)}</f><v>${esc(v.value)}</v></c>`);
      else cells.push(`<c r="${ref}" t="s"><v>${sharedIndex(v)}</v></c>`);
    });
    return cells.length ? `<row r="${ri + 1}" spans="1:12">${cells.join("")}</row>` : `<row r="${ri + 1}"/>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:L15"/><sheetData>${out}</sheetData><mergeCells count="1"><mergeCell ref="A1:L1"/></mergeCells></worksheet>`;
}

export function writeXlsxFixture(file = SAMPLE_XLSX) {
  const shared = [];
  const idx = new Map();
  const sRef = (s) => {
    const key = String(s);
    if (!idx.has(key)) { idx.set(key, shared.length); shared.push(key); }
    return idx.get(key);
  };

  const header = ["Room No", "Room Name", "Level", "Area", "Height (mm)", "Space Type", "People",
    "Orientation", "Glass (m²)", "Roof", "Lighting W/m²", "Equipment W/m²"];
  const data = [
    ["G-01", "Reception", "Ground Floor", 45.5, 3000, "Reception", 8, "W", 12.5, "no", 12, 5],
    ["G-02", "Conference Room", "Ground Floor", "6.0 x 4.5", 3000, "Conference", 12, "West", 5.4, "no", 12, 5],
    ["G-03", "Open Plan Office", "Ground Floor", 1249.3, 3000, "Office", 110, "W", 45, "no", 10, 15],
    ["101", "Cabin A", "First Floor", "490 ft²", 3000, "Cabin", 2, "E", 8, "no", 10, 15],
    ["102", "MD Cabin", "First Floor", `12'-6" x 10'`, 3000, "Cabin", 2, "N", 6, "no", 10, 15],
    ["103", "Server Room", "First Floor", "4500x3600", 3000, "Server/IT Room", 0, "S", 0, "no", 10, 300],
  ];
  const sheet1 = [
    ["ROOM SCHEDULE — HQ BLOCK A (merged title row above the header)"],
    header,
    ...data,
    [],                                              // blank row
    data[0].slice(),                                 // exact duplicate of G-01
    ["G-04", "Toilet - Male", "Ground Floor", "12 m²", 3000, "Toilet", 0, "", 0, "no", 6, 0],
    header.slice(),                                  // repeated header row
    ["G-05", "Staircase", "Ground Floor", "18 m²", 3500, "Stair", 0, "", 0, "no", 8, 0],
    ["G-06", { inline: "Pantry" }, "First Floor", "9.5 m²", 3000, "Pantry", 0, "", 0, "no", 8, 2],
    ["", "TOTAL", "", { formula: "SUM(D3:D12)", value: "1380.3" }],
  ];
  const sheet2 = [["Notes"], ["Prepared by", "HVAC Dept"], ["Area", "m2"]];

  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Room Schedule" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    { name: "xl/sharedStrings.xml", data: "" },
    { name: "xl/worksheets/sheet1.xml", data: () => sheetXml(sheet1, sRef), deflate: true },
    { name: "xl/worksheets/sheet2.xml", data: () => sheetXml(sheet2, sRef) },
  ];

  // serialise the sheets first (they fill the shared-string table), then the sharedStrings part
  const sheet1Xml = sheetXml(sheet1, sRef);
  const sheet2Xml = sheetXml(sheet2, sRef);
  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`;
  files.find((f) => f.name === "xl/worksheets/sheet1.xml").data = sheet1Xml;
  files.find((f) => f.name === "xl/worksheets/sheet2.xml").data = sheet2Xml;
  files.find((f) => f.name === "xl/sharedStrings.xml").data = sharedXml;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zip(files.map((f) => ({ name: f.name, data: f.data, deflate: !!f.deflate }))));
  return file;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

export function testApiSurface() {
  assert.deepEqual(SCHEDULE_EXTENSIONS, [".csv", ".tsv", ".xlsx"]);
  for (const n of ["a.csv", "B.CSV", "room schedule.tsv", "HQ.xlsx", "hq.XLSX"])
    assert.equal(isScheduleFile(n), true, `${n} should be a schedule file`);
  for (const n of ["hq.pdf", "notes.txt", "old.xls", "", undefined, "csv"])
    assert.equal(isScheduleFile(n), false, `${n} should NOT be a schedule file`);
  assert.equal(typeof parseSchedule, "function");
  assert.equal(detectColumnKey("Room Area (m²)"), "area");
  assert.equal(detectColumnKey("Area Name"), "name");
  assert.equal(detectColumnKey("Room No."), "number");
}

export function testUnits() {
  // areas
  assert.equal(parseAreaValue("45.5 m²").value, 45.5);
  assert.equal(parseAreaValue("45.5 m2").value, 45.5);
  assert.equal(parseAreaValue("490 ft2").value, 45.52);
  assert.equal(parseAreaValue("490 sq ft").value, 45.52);
  assert.equal(parseAreaValue("490 SF").value, 45.52);
  assert.equal(parseAreaValue("1,249.3").value, 1249.3);
  assert.equal(parseAreaValue("6.0 x 4.5").value, 27);
  assert.equal(parseAreaValue("4500x3600").value, 16.2);
  assert.equal(parseAreaValue(`12'-6" x 10'`).value, 11.61);
  assert.equal(parseAreaValue("24.5 m2").value, 24.5);
  assert.equal(parseAreaValue("5000").value, 5000);            // bare number = m²
  assert.equal(parseAreaValue("900", 0.092903).value, 83.61);  // header said ft²
  assert.equal(parseAreaValue("").value, null);
  // unknown unit keeps the number and reports the unit
  const unk = parseAreaValue("45 kN");
  assert.equal(unk.value, 45);
  assert.equal(unk.unit, "kN");
  // lengths
  assert.equal(parseLengthValue("6.0").value, 6);
  assert.equal(parseLengthValue("4500").value, 4.5);           // >100 -> mm
  assert.equal(parseLengthValue("3000 mm").value, 3);
  assert.equal(parseLengthValue("3.0 m").value, 3);
  assert.equal(parseLengthValue(`12'-6"`).value, 3.81);        // feet-inches
  assert.equal(parseLengthValue("10'").value, 3.048);
  assert.equal(parseLengthValue("30\"").value, 0.762);
  assert.equal(parseLengthValue("5 ft").value, 1.524);
  assert.equal(parseLengthValue("30 cm").value, 0.3);
}

export function testCsvFixture() {
  assert.ok(fs.existsSync(SAMPLE_CSV), "tests/samples/schedule.csv exists");
  const res = parseSchedule(fs.readFileSync(SAMPLE_CSV), { filename: "schedule.csv" });

  assert.equal(res.rooms.length, 9, `9 rooms, got ${res.rooms.map((r) => r.name).join(" | ")}`);
  assert.deepEqual(res.rooms.map((r) => r.name).sort(), Object.keys(EXPECTED).sort());
  assert.equal(res.headerRow, 2, "header row is line 2 (title row above it)");
  assert.equal(res.rowCount, 10, "10 data rows read (blank/totals/duplicate/header excluded from rooms)");
  assert.equal(res.sheetName, "", "csv has no sheet name");
  assert.deepEqual(res.columns, { number: 0, name: 1, level: 2, area: 3, height: 4, type: 5, people: 6, orient: 7, glass: 8, roof: 9, light: 10, equip: 11 });
  assert.equal(res.columnHeaders.name, "Room Name");
  assert.ok(res.rooms.every((r) => r.source === "schedule"), "every room is source:'schedule'");
  assert.equal(new Set(res.rooms.map((r) => r.id)).size, 9, "ids unique");

  for (const [name, area] of Object.entries(EXPECTED)) {
    const r = byName(res.rooms, name);
    assert.ok(r, `${name} found`);
    assert.equal(r.area, area, `${name} area`);
  }

  const recep = byName(res.rooms, "Reception");
  assert.equal(recep.number, "G-01");
  assert.equal(recep.level, "Ground Floor");
  assert.equal(recep.type, "reception");
  assert.equal(recep.orient, "W");
  assert.equal(recep.glass, 12.5);
  assert.equal(recep.roof, false);
  assert.equal(recep.people, 8);
  assert.equal(recep.height, 3);
  assert.equal(recep.light, 12);
  assert.equal(recep.equip, 5);
  assert.equal(recep.include, true);

  const conf = byName(res.rooms, "Conference Room");
  assert.equal(conf.type, "conference");
  assert.equal(conf.orient, "W", "'West' -> W");
  assert.equal(conf.height, 3, "'3000' (mm) -> 3 m");

  const office = byName(res.rooms, "Open Plan Office");
  assert.equal(office.type, "office");
  assert.equal(office.people, 110);
  assert.equal(office.level, "Ground Floor");

  const cabinA = byName(res.rooms, "Cabin A");
  assert.equal(cabinA.level, "First Floor");
  assert.equal(cabinA.orient, "E");
  assert.equal(cabinA.type, "cabin");
  assert.equal(cabinA.spaceType, "Cabin", "the schedule's own type/usage column is kept");

  const server = byName(res.rooms, "Server Room");
  assert.equal(server.type, "server");
  assert.equal(server.equip, 300);

  assert.equal(byName(res.rooms, "Toilet - Male").include, false, "toilet is not air conditioned");
  assert.equal(byName(res.rooms, "Staircase").include, false, "staircase is not air conditioned");
  assert.equal(byName(res.rooms, "Pantry").include, false, "pantry is not air conditioned");
  for (const n of ["Reception", "Conference Room", "Open Plan Office", "Cabin A", "MD Cabin", "Server Room"])
    assert.equal(byName(res.rooms, n).include, true, `${n} is air conditioned`);

  assert.ok(hasWarn(res.warnings, /duplicate of row 3/), `duplicate warning: ${res.warnings.join(" | ")}`);
  assert.ok(hasWarn(res.warnings, /repeated header row skipped/), "repeated header warning");
  assert.ok(hasWarn(res.warnings, /9 rooms imported/), "import summary warning");
  assert.ok(res.warnings.every((w) => typeof w === "string" && w.length > 0));
}

export function testXlsxFixture() {
  const file = writeXlsxFixture();
  assert.ok(fs.existsSync(file), "tests/samples/schedule.xlsx exists");
  const raw = fs.readFileSync(file);
  assert.equal(raw.subarray(0, 2).toString("latin1"), "PK", "xlsx is a zip");

  const res = parseSchedule(arrayBuffer(raw), { filename: "schedule.xlsx" });
  assert.equal(res.sheetName, "Room Schedule");
  assert.equal(res.rooms.length, 9, `9 rooms, got ${res.rooms.map((r) => r.name).join(" | ")}`);
  assert.equal(res.headerRow, 2, "header is spreadsheet row 2 (merged title in row 1)");
  assert.equal(res.rowCount, 10);
  for (const [name, area] of Object.entries(EXPECTED)) {
    const r = byName(res.rooms, name);
    assert.ok(r, `${name} found in xlsx`);
    assert.equal(r.area, area, `${name} area from xlsx`);
  }
  assert.equal(byName(res.rooms, "Reception").glass, 12.5);
  assert.equal(byName(res.rooms, "Reception").height, 3, "'Height (mm)' 3000 -> 3 m");
  assert.equal(byName(res.rooms, "MD Cabin").level, "First Floor");
  assert.equal(byName(res.rooms, "Pantry").spaceType, "Pantry", "inlineStr cell read");
  assert.ok(res.rooms.every((r) => r.type in { office: 1, conference: 1, cabin: 1, reception: 1, retail: 1, restaurant: 1, bedroom: 1, living: 1, classroom: 1, hospital: 1, server: 1, gym: 1, general: 1 }), "every type is a calc.js SPACE_TYPES key");
  assert.ok(hasWarn(res.warnings, /totals row "TOTAL" skipped/), `totals row skipped: ${res.warnings.join(" | ")}`);
  assert.ok(hasWarn(res.warnings, /duplicate/), "duplicate warning");
  assert.ok(hasWarn(res.warnings, /repeated header/), "repeated header warning");

  // sheet selection
  const notes = parseSchedule(arrayBuffer(raw), { filename: "schedule.xlsx", sheet: 1 });
  assert.equal(notes.sheetName, "Notes");
  assert.equal(notes.rooms.length, 0, "the Notes sheet is not a schedule");
  assert.ok(hasWarn(notes.warnings, /No header row|no room name/i), "Notes sheet warns instead of crashing");
  const named = parseSchedule(arrayBuffer(raw), { filename: "schedule.xlsx", sheet: "Room Schedule" });
  assert.equal(named.rooms.length, 9);
  const missing = parseSchedule(arrayBuffer(raw), { filename: "schedule.xlsx", sheet: 7 });
  assert.equal(missing.rooms.length, 9, "missing sheet index falls back to the first sheet");
  assert.ok(hasWarn(missing.warnings, /sheet 7 not found/));
}

export function testXlsxMatchesCsv() {
  const csv = parseSchedule(fs.readFileSync(SAMPLE_CSV), { filename: "schedule.csv" });
  const xlsx = parseSchedule(arrayBuffer(fs.readFileSync(SAMPLE_XLSX)), { filename: "schedule.xlsx" });
  const map = (rooms) => Object.fromEntries(rooms.map((r) => [r.name, r.area]));
  assert.deepEqual(map(xlsx.rooms), map(csv.rooms), "xlsx and csv agree on names and areas");
}

export function testDelimitersQuotingBom() {
  // semicolons + CRLF + BOM + quoted fields containing the delimiter and a comma
  const semi = "\ufeffRoom Name;Level;Area\r\n"
    + 'Reception;Ground Floor;"45,5 m2"\r\n'
    + '"Conference Room, Large";Ground Floor;6.0 x 4.5\r\n'
    + "MD Cabin;First Floor;12'-6\" x 10'\r\n";
  const res = parseSchedule(semi, { filename: "rooms.csv" });
  assert.equal(res.rooms.length, 3, res.warnings.join(" | "));
  assert.equal(byName(res.rooms, "Reception").area, 45.5, "quoted '45,5 m2' -> 45.5");
  assert.equal(byName(res.rooms, "Conference Room, Large").area, 27, "comma inside a quoted name");
  assert.equal(byName(res.rooms, "MD Cabin").area, 11.61);

  // tab separated, with a units row under the header
  const tsv = "Room No\tRoom Name\tArea\nno.\t(designation)\tm²\nG-01\tReception\t45.5\nG-02\tLobby\t22\n";
  const t = parseSchedule(tsv, { filename: "rooms.tsv" });
  assert.equal(t.rooms.length, 2, t.warnings.join(" | "));
  assert.equal(byName(t.rooms, "Reception").area, 45.5);

  // semicolon detection on a .txt name is still fine (extension only decides the reader, not the delimiter)
  const s = parseSchedule("Room Name;Area\nOffice;100\n", { filename: "" });
  assert.equal(s.rooms.length, 1);
  assert.equal(s.rooms[0].area, 100);
}

export function testHeaderlessTwoColumns() {
  const res = parseSchedule("Reception,45.5\nConference Room,27\nMD Cabin,11.61\n", { filename: "rooms.csv" });
  assert.equal(res.rooms.length, 3, res.warnings.join(" | "));
  assert.equal(res.headerRow, 0, "no header row");
  assert.equal(res.rooms[0].name, "Reception");
  assert.equal(res.rooms[0].area, 45.5);
  assert.equal(byName(res.rooms, "Conference Room").area, 27);
  assert.ok(hasWarn(res.warnings, /assuming|No header row/i));
  assert.ok(res.rooms.every((r) => r.id && r.source === "schedule" && r.type));

  // a WIDE table without a schedule header must NOT be mistaken for a name+area list
  const wide = parseSchedule("Part No,Desc,Material,Qty,Rate,Amount\nA-1,Bracket,MS,12,45,540\nA-2,Shaft,SS,3,120,360\n", { filename: "bom.csv" });
  assert.deepEqual(wide.rooms, [], "a bill of materials is not a room schedule: " + wide.warnings.join(" | "));
  assert.ok(hasWarn(wide.warnings, /Nothing imported|no room name/i));
}

export function testWarningsMissingAreaUnitLevel() {
  const csv = [
    "Room No,Room Name,Level,Area,Glass",
    "G-01,Reception,Ground Floor,45.5 m²,",
    "G-02,Store Room,Area Schedule,45 kN,10",
    "G-03,Conference Room,As per drawing,,",
    "TOTAL,,,45.5,",
  ].join("\n");
  const res = parseSchedule(csv, { filename: "odd.csv" });
  assert.equal(res.rooms.length, 2, "Reception and Store Room have readable areas: " + res.warnings.join(" | "));
  assert.equal(res.rooms[0].name, "Reception");
  assert.equal(res.rooms[0].area, 45.5);
  const store = byName(res.rooms, "Store Room");
  assert.equal(store.area, 45, "an unknown unit keeps the bare number");
  assert.equal(store.include, false, "a store room is not air conditioned");
  assert.ok(hasWarn(res.warnings, /unknown unit "kN"/), "unknown unit warning");
  assert.ok(hasWarn(res.warnings, /no area for "Conference Room"/), "missing area warning");
  assert.ok(hasWarn(res.warnings, /unknown level "As per drawing"/), "unknown level warning");
  assert.ok(hasWarn(res.warnings, /totals row "TOTAL" skipped/), "totals row warning");
  assert.equal(byName(res.rooms, "Conference Room"), undefined, "a row with no usable area is not imported");
}

export function testJunkAndEmptyFilesDoNotCrash() {
  const junk = parseSchedule("this is just some notes\nnothing to see here\n", { filename: "notes.txt" });
  assert.deepEqual(junk.rooms, []);
  assert.ok(junk.warnings.length > 0, "a junk file warns instead of crashing");
  assert.ok(junk.warnings.some((w) => /no room name|No header row/i.test(w)), junk.warnings.join(" | "));

  const empty = parseSchedule("", { filename: "empty.csv" });
  assert.deepEqual(empty.rooms, []);
  assert.ok(hasWarn(empty.warnings, /empty/i));

  const binary = parseSchedule(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x00, 0x00]), { filename: "scan.xlsx" });
  assert.deepEqual(binary.rooms, []);
  assert.ok(hasWarn(binary.warnings, /Could not read|not a zip/i), binary.warnings.join(" | "));

  const wrongName = parseSchedule("Room Name,Area\nOffice,100\n", { filename: "rooms.xlsx" });
  assert.deepEqual(wrongName.rooms, []);
  assert.ok(wrongName.warnings.length > 0, "text with an .xlsx name warns and returns no rooms");

  const noArgs = parseSchedule();
  assert.deepEqual(noArgs.rooms, []);
  assert.ok(noArgs.warnings.length > 0);
}

export function testEngineIntegration() {
  assert.equal(guessSpaceType("Open Plan Office"), "office");
  const res = parseSchedule(fs.readFileSync(SAMPLE_CSV), { filename: "schedule.csv" });
  for (const r of res.rooms) if (r.orient) assert.ok(ORIENTS.includes(r.orient), `${r.orient} is an ORIENTS value`);
  const { totals, results } = calcProject(res.rooms);
  assert.equal(totals.rooms, 6, "6 of the 9 rooms are air conditioned");
  assert.equal(results.length, 9);
  assert.equal(Math.round(totals.area), 1395, `conditioned area 1395 m², got ${totals.area}`);
  assert.ok(totals.tr > 40 && totals.tr < 50, `TR in a sane band, got ${totals.tr}`);
  assert.ok(results.every((r) => r.totalW >= 0 && Number.isFinite(r.totalW)));
}

export function testInflateMatchesZlib() {
  const cases = [];
  const rnd = (n, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => ((seed * 1103515245 + i * 12345) >>> 8) & 0xff));
  cases.push(Buffer.alloc(0));
  cases.push(Buffer.from("hello xlsx"));
  cases.push(Buffer.from("<sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c></row></sheetData>".repeat(200)));
  cases.push(rnd(5000));
  cases.push(rnd(70000, 7));                    // > 32 kB window
  for (let level = 0; level <= 9; level++) {
    for (const src of cases) {
      const deflated = zlib.deflateRawSync(src, { level });
      const back = Buffer.from(inflateRaw(deflated));
      assert.equal(back.length, src.length, `inflate length (level ${level}, ${src.length} bytes)`);
      assert.equal(back.toString("latin1"), src.toString("latin1"), `inflate content (level ${level})`);
    }
  }
}

export function testBrowserSafeModule() {
  const src = fs.readFileSync(path.join(HERE, "..", "js", "schedule.js"), "utf8");
  for (const bad of [/\brequire\s*\(/, /from\s+["']node:/, /\bprocess\./, /\bwindow\./, /\bdocument\./, /\blocalStorage\b/])
    assert.equal(bad.test(src), false, `js/schedule.js must not use ${bad} (browser path must stay dependency-free)`);
  assert.ok(/^import \{ ORIENTS, guessSpaceType, NON_AC_WORDS \} from "\.\/calc\.js";$/m.test(src), "only imports js/calc.js");
  const imports = [...src.matchAll(/^\s*import\s.*$/gm)].map((m) => m[0]);
  assert.equal(imports.length, 1, `exactly one static import, got ${imports.length}`);
}

// ---------------------------------------------------------------------------
// runner (also usable via `node tests/test-schedule.mjs`)
// ---------------------------------------------------------------------------

const TESTS = {
  testApiSurface, testUnits, testCsvFixture, testXlsxFixture, testXlsxMatchesCsv,
  testDelimitersQuotingBom, testHeaderlessTwoColumns, testWarningsMissingAreaUnitLevel,
  testJunkAndEmptyFilesDoNotCrash, testEngineIntegration, testInflateMatchesZlib, testBrowserSafeModule,
};

export function runScheduleTests() {
  let pass = 0;
  const failures = [];
  for (const [name, fn] of Object.entries(TESTS)) {
    try {
      fn();
      console.log(`  PASS  ${name}`);
      pass++;
    } catch (err) {
      failures.push(name);
      console.log(`  FAIL  ${name}`);
      console.log("        " + String((err && err.message) || err).split("\n").join("\n        "));
    }
  }
  return { pass, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("schedule import (js/schedule.js)");
  const { pass, failures } = runScheduleTests();
  const total = pass + failures.length;
  console.log(`\n${pass}/${total} schedule checks passed`);
  if (failures.length) {
    console.log("failed:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  console.log("ALL SCHEDULE TESTS PASSED");
}

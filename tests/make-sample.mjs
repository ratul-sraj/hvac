// Builds a tiny room-schedule PDF by hand (no extra dependencies) so the tests
// have a real file to feed to parsePdf().
//
//   node tests/make-sample.mjs          -> writes tests/samples/schedule-sample.pdf
//   import { writeSample } from "./make-sample.mjs"

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Room schedule: header + 6 rooms. Columns: ROOM | LENGTH | WIDTH | AREA
const COL_X = [60, 220, 310, 390];
const HEADER = ["ROOM", "LENGTH", "WIDTH", "AREA"];
const ROWS = [
  ["Office", "6.0", "4.5", "27.0"],
  ["Conference", "8.0", "6.0", "48.0"],
  ["101 Lobby", "5.5", "4.0", "22.0"],
  ["Toilet", "2.0", "1.5", "3.0"],
  ["Store", "4.0", "3.0", "12.0"],
  ["Meeting Room", "7.0", "5.0", "35.0"],
];

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function contentStream() {
  const out = ["BT", "/F1 10 Tf", "12 TL"];
  let y = 780;
  const row = (cells) => {
    for (let i = 0; i < cells.length; i++) {
      out.push(`1 0 0 1 ${COL_X[i]} ${y} Tm (${esc(cells[i])}) Tj`);
    }
    y -= 18;
  };
  row(HEADER);
  y -= 2;
  for (const r of ROWS) row(r);
  out.push("ET");
  return out.join("\n") + "\n";
}

/** @returns {Buffer} complete PDF bytes */
export function buildSamplePdf() {
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
    "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>";
  // explicit widths so pdf.js never needs to fetch standard-font metrics
  const widths = Array.from({ length: 95 }, () => 556).join(" ");
  objs[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding " +
    `/FirstChar 32 /LastChar 126 /Widths [${widths}] >>`;
  const stream = contentStream();
  objs[5] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`;

  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  let offset = chunks[0].length;
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    const body = Buffer.from(`${i} 0 obj\n${objs[i]}\nendobj\n`, "latin1");
    offsets[i] = offset;
    offset += body.length;
    chunks.push(body);
  }
  const xrefStart = offset;
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  xref += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

export const SAMPLE_PATH = path.join(HERE, "samples", "schedule-sample.pdf");

export function writeSample(file = SAMPLE_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildSamplePdf());
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("wrote " + writeSample());
}
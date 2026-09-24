// Builds the scanned (image-only) fixtures for the OCR path.
//
//   cd D:/webhvac && node tests/make-scanned-fixture.mjs
//
// It drives the Edge already installed on this PC (see tests/browser-check.mjs for the launch
// options) and does, in a real browser:
//   1. the DRAWING fixture — render tests/samples/headquarters.pdf page 1 into a canvas at
//      scale 3 (page 1 is a 90°-rotated sheet in the file; pdf.js's viewport puts it upright on
//      the canvas), turn that canvas into a JPEG (quality 0.8), and save it with page.pdf() as
//      tests/samples/headquarters-scanned.pdf — a real image-only scan with no text layer.
//   2. the SCHEDULE fixture — draw a small room schedule (text, no PDF text layer) and save it
//      as tests/qa/schedule-scanned.pdf. This one is legible on purpose: it proves the
//      OCR -> js/pdfparse.js parseText() pipeline can really build rooms when the page is
//      readable, which the dense drawing sheet is not.
//   3. the BLANK fixture — tests/qa/blank-scanned.pdf, an empty white page (no text at all).
//
// The intermediate rasters stay in tests/qa/ (git-ignored) so tests/test-ocr.mjs can also feed
// the very same pixels to tesseract.js through its own Node worker.
//
//   import { makeScannedFixture, makeScannedSchedule, makeBlankScan, serveStatic } from "./make-scanned-fixture.mjs";

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const QA = path.join(HERE, "qa");
export const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

export const SOURCE_PDF = path.join(HERE, "samples", "headquarters.pdf");
export const SCANNED_PDF = path.join(HERE, "samples", "headquarters-scanned.pdf");
export const SCAN_JPEG = path.join(QA, "hq-p1-scan.jpg");
export const SCHEDULE_PDF = path.join(QA, "schedule-scanned.pdf");
export const SCHEDULE_JPEG = path.join(QA, "schedule-scan.jpg");
export const BLANK_PDF = path.join(QA, "blank-scanned.pdf");
export const ROTATED_PDF = path.join(QA, "hq-p1-sideways.pdf");
export const SCAN_PAGE = 1;
export const SCAN_SCALE = 3;

// The schedule the OCR test reads back. "m²" and "m2" and "sq m" are mixed on purpose:
// a Revit/Excel export writes the unit all three ways and OCR treats them very differently.
export const SCHEDULE_ROWS = [
  ["ROOM NAME", "LENGTH", "WIDTH", "AREA"],
  ["Office", "6.0", "4.5", "27.0 m2"],
  ["Conference Room", "8.0", "6.0", "48.0 m²"],
  ["Meeting Room", "7.0", "5.0", "35.0 m2"],
  ["Server Room", "4.0", "3.0", "12.0 m²"],
  ["Store", "3.0", "2.5", "7.5 sq m"],
];

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gz": "application/gzip", ".json": "application/json",
  ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
};

/** A tiny static file server for D:/webhvac — ES modules need http://, not file://. */
export function serveStatic(root = ROOT) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    const file = path.resolve(base, rel);
    const inside = !path.relative(base, file).startsWith("..");
    if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found: " + rel);
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

export function closeStatic(server) {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

export async function launchEdge() {
  return puppeteer.launch({
    executablePath: EDGE,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--window-size=1400,1000"],
    protocolTimeout: 300000,
  });
}

/** Decode a data URL ("data:image/jpeg;base64,....") to a Buffer. */
const dataUrlToBuffer = (url) => Buffer.from(String(url).split(",")[1], "base64");

/** Wrap a JPEG in a one-page image-only PDF (no text layer at all). */
async function jpegToPdf(browser, jpegDataUrl, width, height, style = "display:block;width:100%") {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;padding:0}</style>` +
        `<img src="${jpegDataUrl}" style="${style}">`,
      { waitUntil: "load", timeout: 60000 }
    );
    return await page.pdf({
      width: `${width}px`, height: `${height}px`,
      printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  } finally {
    await page.close();
  }
}

const drawHarness = (body, script) => `<!doctype html><meta charset="utf-8"><title>scan fixture</title>
<body style="margin:0">${body}
<script type="module">
${script}
<\/script>`;

// ---------------------------------------------------------------- 1. drawing sheet

const HARNESS = drawHarness("", `
import * as pdfjs from "/vendor/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
window.__scan = (async () => {
  try {
    const res = await fetch("/tests/samples/headquarters.pdf");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
    const page = await doc.getPage(${SCAN_PAGE});
    const viewport = page.getViewport({ scale: ${SCAN_SCALE} });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const textItems = (await page.getTextContent()).items.filter((i) => i.str && i.str.trim());
    return { ok: true, jpeg: canvas.toDataURL("image/jpeg", 0.8), width: canvas.width, height: canvas.height, textItems: textItems.length };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
})();`);

/**
 * Render page 1 of the source PDF to a JPEG and wrap it in an image-only PDF.
 * @returns {{pdf:string, jpeg:string, width:number, height:number, pdfBytes:number, jpegBytes:number, textItems:number}}
 */
export async function makeScannedFixture({ browser = null } = {}) {
  fs.mkdirSync(QA, { recursive: true });
  const harnessPath = path.join(QA, "ocr-fixture.html");   // temporary, deleted below
  fs.writeFileSync(harnessPath, HARNESS);

  const { server, port } = await serveStatic(ROOT);
  const own = browser || await launchEdge();
  const page = await own.newPage();
  try {
    await page.setViewport({ width: 1400, height: 1000 });
    await page.goto(`http://127.0.0.1:${port}/tests/qa/ocr-fixture.html`, { waitUntil: "load", timeout: 60000 });
    const r = await page.waitForFunction(() => window.__scan !== undefined, { timeout: 300000 })
      .then(() => page.evaluate(() => window.__scan));
    if (!r || !r.ok) throw new Error("fixture render failed: " + (r && r.error));

    const jpegBuffer = dataUrlToBuffer(r.jpeg);
    fs.writeFileSync(SCAN_JPEG, jpegBuffer);
    const pdfBuffer = await jpegToPdf(own, r.jpeg, r.width, r.height);
    fs.writeFileSync(SCANNED_PDF, pdfBuffer);

    return {
      pdf: SCANNED_PDF, jpeg: SCAN_JPEG,
      width: r.width, height: r.height,
      pdfBytes: pdfBuffer.length, jpegBytes: jpegBuffer.length,
      textItems: r.textItems,
    };
  } finally {
    await page.close();
    await closeStatic(server);
    fs.rmSync(harnessPath, { force: true });   // keep tests/qa tidy: harness is throw-away
  }
}

// ---------------------------------------------------------------- 2. sideways scan

const ROT_HARNESS = drawHarness("", `
import * as pdfjs from "/vendor/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
window.__scan = (async () => {
  try {
    const res = await fetch("/tests/samples/headquarters.pdf");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
    const page = await doc.getPage(${SCAN_PAGE});
    const viewport = page.getViewport({ scale: ${SCAN_SCALE} });
    const src = document.createElement("canvas");
    src.width = Math.ceil(viewport.width);
    src.height = Math.ceil(viewport.height);
    const sctx = src.getContext("2d");
    sctx.fillStyle = "#ffffff";
    sctx.fillRect(0, 0, src.width, src.height);
    await page.render({ canvasContext: sctx, viewport }).promise;
    // turn the sheet 90° clockwise, exactly like feeding a drawing through the scanner sideways
    const out = document.createElement("canvas");
    out.width = src.height;
    out.height = src.width;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return { ok: true, jpeg: out.toDataURL("image/jpeg", 0.8), width: out.width, height: out.height };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
})();`);

/** The same sheet scanned sideways: OCR has to rotate the raster to read it. */
export async function makeRotatedScan({ browser = null } = {}) {
  fs.mkdirSync(QA, { recursive: true });
  const harnessPath = path.join(QA, "ocr-rotated.html");
  fs.writeFileSync(harnessPath, ROT_HARNESS);
  const { server, port } = await serveStatic(ROOT);
  const own = browser || await launchEdge();
  const page = await own.newPage();
  try {
    await page.setViewport({ width: 1400, height: 1000 });
    await page.goto(`http://127.0.0.1:${port}/tests/qa/ocr-rotated.html`, { waitUntil: "load", timeout: 60000 });
    const r = await page.waitForFunction(() => window.__scan !== undefined, { timeout: 300000 })
      .then(() => page.evaluate(() => window.__scan));
    if (!r || !r.ok) throw new Error("rotated fixture render failed: " + (r && r.error));
    const pdfBuffer = await jpegToPdf(own, r.jpeg, r.width, r.height);
    fs.writeFileSync(ROTATED_PDF, pdfBuffer);
    return { pdf: ROTATED_PDF, width: r.width, height: r.height, pdfBytes: pdfBuffer.length };
  } finally {
    await page.close();
    await closeStatic(server);
    fs.rmSync(harnessPath, { force: true });
  }
}

// ---------------------------------------------------------------- 3. legible schedule

const scheduleHtml = () => `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; background: #fff; font-family: Arial, Helvetica, sans-serif; color: #111; }
  h1 { font-size: 34px; margin: 28px 40px 6px; font-weight: 700; }
  p  { font-size: 20px; margin: 0 40px 20px; }
  table { border-collapse: collapse; margin: 0 40px; }
  td { font-size: 28px; padding: 8px 26px 8px 0; border-bottom: 1px solid #999; white-space: nowrap; }
  tr:first-child td { font-weight: 700; border-bottom: 2px solid #333; }
</style>
<h1>ROOM SCHEDULE &mdash; GROUND FLOOR</h1>
<p>Revit export, printed and scanned</p>
<table>
${SCHEDULE_ROWS.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("\n")}
</table>`;

/** A legible, text-only "scanned room schedule": JPEG of a table + image-only PDF around it. */
export async function makeScannedSchedule({ browser = null } = {}) {
  fs.mkdirSync(QA, { recursive: true });
  const own = browser || await launchEdge();
  const page = await own.newPage();
  try {
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 2 });
    await page.setContent(scheduleHtml(), { waitUntil: "load", timeout: 60000 });
    const box = await page.evaluate(() => {
      const t = document.querySelector("table").getBoundingClientRect();
      const h = document.querySelector("h1").getBoundingClientRect();
      return { x: 0, y: 0, width: Math.ceil(Math.max(t.right, h.right) + 40), height: Math.ceil(t.bottom + 40) };
    });
    const jpegBuffer = await page.screenshot({ type: "jpeg", quality: 0.9, clip: box, captureBeyondViewport: true });
    fs.writeFileSync(SCHEDULE_JPEG, jpegBuffer);
    const dataUrl = "data:image/jpeg;base64," + jpegBuffer.toString("base64");
    const pdfBuffer = await jpegToPdf(own, dataUrl, box.width * 2, box.height * 2);
    fs.writeFileSync(SCHEDULE_PDF, pdfBuffer);
    return { pdf: SCHEDULE_PDF, jpeg: SCHEDULE_JPEG, width: box.width * 2, height: box.height * 2, pdfBytes: pdfBuffer.length, jpegBytes: jpegBuffer.length };
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------- 4. blank page

/** An image-only PDF with nothing on it — the "OCR must not throw" case. */
export async function makeBlankScan({ browser = null } = {}) {
  fs.mkdirSync(QA, { recursive: true });
  const own = browser || await launchEdge();
  const page = await own.newPage();
  try {
    // a plain white page: no text, no image, nothing for OCR to find
    await page.setContent(
      "<!doctype html><style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#fff}</style>",
      { waitUntil: "load", timeout: 60000 }
    );
    const pdfBuffer = await page.pdf({
      width: "1200px", height: "900px",
      printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    fs.writeFileSync(BLANK_PDF, pdfBuffer);
    return { pdf: BLANK_PDF, pdfBytes: pdfBuffer.length };
  } finally {
    await page.close();
    if (!browser) await own.close();
  }
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mb = (n) => (n / 1048576).toFixed(2) + " MB";
  const before = Date.now();
  const browser = await launchEdge();
  try {
    const drawing = await makeScannedFixture({ browser });
    console.log(`rendered page ${SCAN_PAGE} at scale ${SCAN_SCALE} -> ${drawing.width}x${drawing.height} px`);
    console.log(`wrote ${drawing.jpeg}  (${mb(drawing.jpegBytes)})`);
    console.log(`wrote ${drawing.pdf}  (${mb(drawing.pdfBytes)}, image-only; the source page had ${drawing.textItems} text items)`);

    const rotated = await makeRotatedScan({ browser });
    console.log(`wrote ${rotated.pdf}  (${mb(rotated.pdfBytes)}, same sheet scanned 90° sideways)`);

    const schedule = await makeScannedSchedule({ browser });
    console.log(`wrote ${schedule.jpeg} (${mb(schedule.jpegBytes)}) and ${schedule.pdf} (${mb(schedule.pdfBytes)}, ${schedule.width}x${schedule.height} px)`);

    const blank = await makeBlankScan({ browser });
    console.log(`wrote ${blank.pdf}  (${mb(blank.pdfBytes)})`);
  } finally {
    await browser.close();
  }
  console.log(`took ${((Date.now() - before) / 1000).toFixed(1)} s`);
}

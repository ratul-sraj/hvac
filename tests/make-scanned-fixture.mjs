// Builds the scanned (image-only) test fixture for the OCR path.
//
//   cd D:/webhvac && node tests/make-scanned-fixture.mjs
//
// It drives the Edge already installed on this PC (see tests/browser-check.mjs for the launch
// options) and does, in a real browser:
//   1. render tests/samples/headquarters.pdf page 1 into a canvas at scale 3 (page 1 is a
//      90°-rotated sheet in the file — pdf.js's viewport puts it upright on the canvas),
//   2. turn that canvas into a JPEG (quality 0.8),
//   3. hand the JPEG to a bare <img> page and save it with page.pdf() as
//      tests/samples/headquarters-scanned.pdf — a real, image-only scan: no text layer at all.
//
// The intermediate raster is kept at tests/qa/hq-p1-scan.jpg so tests/test-ocr.mjs can also feed
// the very same pixels to tesseract.js through its own Node worker (tests/qa/ is git-ignored).
//
//   import { makeScannedFixture, serveStatic } from "./make-scanned-fixture.mjs";

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
export const SCAN_PAGE = 1;
export const SCAN_SCALE = 3;

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

const HARNESS = `<!doctype html><meta charset="utf-8"><title>scan fixture</title>
<body style="margin:0">
<script type="module">
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
})();
<\/script>`;

/**
 * Render page 1 of the source PDF to a JPEG and wrap it in an image-only PDF.
 * @returns {{pdf:string, jpeg:string, width:number, height:number, pdfBytes:number, jpegBytes:number, textItems:number}}
 */
export async function makeScannedFixture({ quiet = false } = {}) {
  fs.mkdirSync(QA, { recursive: true });
  const harnessPath = path.join(QA, "ocr-fixture.html");   // temporary, deleted below
  fs.writeFileSync(harnessPath, HARNESS);

  const { server, port } = await serveStatic(ROOT);
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--window-size=1400,1000"],
    protocolTimeout: 180000,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.goto(`http://127.0.0.1:${port}/tests/qa/ocr-fixture.html`, { waitUntil: "load", timeout: 60000 });
    const r = await page.waitForFunction(() => window.__scan !== undefined, { timeout: 180000 })
      .then(() => page.evaluate(() => window.__scan));
    if (!r || !r.ok) throw new Error("fixture render failed: " + (r && r.error));

    const b64 = String(r.jpeg).split(",")[1];
    const jpegBuffer = Buffer.from(b64, "base64");
    fs.writeFileSync(SCAN_JPEG, jpegBuffer);

    // now the image-only PDF: a page that contains nothing but that JPEG
    const imgPage = await browser.newPage();
    await imgPage.setContent(
      `<!doctype html><style>html,body{margin:0;padding:0}</style><img src="${r.jpeg}" style="display:block;width:100%">`,
      { waitUntil: "load", timeout: 60000 }
    );
    const pdfBuffer = await imgPage.pdf({
      width: `${r.width}px`,
      height: `${r.height}px`,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    fs.writeFileSync(SCANNED_PDF, pdfBuffer);

    return {
      pdf: SCANNED_PDF, jpeg: SCAN_JPEG,
      width: r.width, height: r.height,
      pdfBytes: pdfBuffer.length, jpegBytes: jpegBuffer.length,
      textItems: r.textItems,
    };
  } finally {
    await browser.close();
    await closeStatic(server);
    fs.rmSync(harnessPath, { force: true });   // keep tests/qa tidy: harness is throw-away
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const before = Date.now();
  const info = await makeScannedFixture();
  const mb = (n) => (n / 1048576).toFixed(2) + " MB";
  console.log(`rendered page ${SCAN_PAGE} at scale ${SCAN_SCALE} -> ${info.width}x${info.height} px`);
  console.log(`wrote ${info.jpeg}  (${mb(info.jpegBytes)})`);
  console.log(`wrote ${info.pdf}  (${mb(info.pdfBytes)}, image-only, ${info.textItems} text items in the page it was made from)`);
  console.log(`took ${((Date.now() - before) / 1000).toFixed(1)} s`);
}

// js/ocr.js — OCR path for scanned / image-only PDF drawing sheets.
//
//   export function isProbablyScanned(items, { minItems = 12 }) -> boolean
//   export async function ocrPdfPage({ pdfjs, page, pageNo, scale, langs, onProgress })
//        -> { items, words, ms, rotation, warnings }
//   export async function ocrPdf(arrayBuffer, { pdfjs, onProgress, langs, force })
//        -> { rooms, pages, text, warnings, items, usedOcr, rotations, ms }
//   export function configureOcr({ workerPath, corePath, langPath, logger, ... }) -> void
//   export async function ocrImage(source, { langs, onProgress }) -> { items, words, ms, rotation: 0 }
//   export async function terminateOcr() -> void
//
// How it works
//  1. A pdf.js page is rendered to an OffscreenCanvas (or a detached <canvas>) with
//     page.getViewport({ scale }) — this already undoes the sheet's /Rotate, so a 90°-rotated
//     sheet comes out upright. The long edge is capped (MEGA pixels are what kills OCR jobs).
//  2. The raster goes to tesseract.js (vendored under vendor/tesseract/, no CDN at runtime)
//     asking for word bounding boxes.
//  3. Words with confidence < 40 and the sheet/duct junk annotations are dropped, and the rest
//     are converted to the SAME item shape js/pdfparse.js already consumes:
//         [{ str, x, y, h, w, page, confidence }]     x right, y DOWN, page points (scale 1)
//     so OCR items and text-layer items are directly comparable.
//  4. Rooms are made by parseText() from js/pdfparse.js — the room rules live in ONE place.
//
// Rotation: if the first pass finds almost nothing (a scan of a sideways drawing), the raster is
// re-OCR'd at 90/180/270 and the orientation with the most words wins; the chosen rotation is
// reported on `rotation` and explained in `warnings`.
//
// tesseract.js is loaded lazily (only when OCR is actually used) with a dynamic import, so a
// browser that never ticks "read scanned drawings" never downloads the wasm core.

import { parseText } from "./pdfparse.js";

const HERE = import.meta.url;
const isNodeEnv =
  typeof process !== "undefined" && !!(process.versions && process.versions.node) &&
  typeof document === "undefined";

/** site-relative path -> absolute URL (relative to THIS module, so /hvac/js/../vendor/... works) */
const abs = (p) => {
  try { return new URL(p, HERE).href; } catch { return String(p); }
};

const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const clampStr = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- junk filter
// These four regexes mirror the ones inside js/pdfparse.js (DUCT_RE, SHEET_RE, NOT_ENCLOSED_RE,
// JUNK_NAME_RE). They are duplicated here on purpose: pdfparse.js does not export them and it is
// owned by the PLANNER (read-only for this worker). They are only a pre-filter — parseText()
// applies its own copies again, so it stays the final authority on what becomes a room.
const DUCT_RE =
  /(?:\d\s*mm\b)|(?:\bmm\s*[x×])|(?:\bmm\b)|ø|L\s*\/\s*S\b|SLSD|SCD\b|\bCFM\b|\bNOS\b|\bWIDTH\b|\bSLOT\b|\bGRILLE\b|\bDIFFUSER\b|\bVD\b|\bFD\b|\bBD\b/i;
const SHEET_RE =
  /\b(SHEET|DRAWING|DWG|SCALE|LAYOUT|PLAN|DATE|PROJECT|CHECKED|DRAWN|REVISION|REV|SCHEMATIC|DESIGN|LEGEND|LEGENDS|NOTES?|STAMP|OF)\b/i;
const NOT_ENCLOSED_RE = /not\s*enclosed/i;
const JUNK_NAME_RE = /^[?.,:;*\-\u2013\u2014|/\\]+$/;

/** True when an OCR word is sheet furniture / duct annotation, never a room name. */
export function isJunkWord(str) {
  const s = clampStr(str).replace(/\s+/g, "");
  if (!s) return true;
  if (JUNK_NAME_RE.test(s)) return true;
  if (DUCT_RE.test(s)) return true;
  if (SHEET_RE.test(s)) return true;
  if (NOT_ENCLOSED_RE.test(s)) return true;
  return false;
}

// ---------------------------------------------------------------- configuration

export const OCR_DEFAULTS = {
  scale: 4,             // render scale for the raster (scale 4 ≈ 300 dpi for an A1 sheet)
  maxEdge: 4000,        // hard cap on the raster's long edge (px) — OCR is memory hungry
  langs: "eng",         // tesseract language(s)
  minItems: 12,         // isProbablyScanned(): fewer non-empty text items than this = a scan
  minConfidence: 40,    // drop OCR words below this confidence
  minWords: 40,         // a pass with fewer kept words than this is reported as "thin"
  minAlphaWords: 10,    // fewer readable words than this = try the raster at 90/180/270
  oem: 1,               // 1 = LSTM_ONLY (the default engine of tesseract.js v7)
  psm: "11",            // 11 = SPARSE TEXT: floor plans are scattered tags, not prose
  cacheMethod: "none",  // no IndexedDB / disk cache: the traineddata is already local
  searchRotations: true, // a sideways scan is re-read at 90/180/270 and the best pass wins
  mapRotationBack: false, // false = keep OCR words in the frame they were read in (readable)
  logger: null,         // tesseract progress logger, if the caller wants one
};

const cfg = { ...OCR_DEFAULTS };
// vendored tesseract assets, resolved once against this module's own URL
const VENDOR = {
  workerPath: abs("../vendor/tesseract/worker.min.js"),
  corePath: abs("../vendor/tesseract/"),
  langPath: abs("../vendor/tesseract/"),
  moduleURL: abs("../vendor/tesseract/tesseract.esm.min.js"),
};

/**
 * Point OCR at the vendored tesseract assets. Call it before the first OCR run
 * (the UI worker calls it lazily, only when the user ticks the OCR checkbox).
 * Paths may be site-relative ("../vendor/tesseract/") or absolute URLs.
 */
export function configureOcr({
  workerPath, corePath, langPath, tesseract, tesseractModuleURL,
  logger, scale, maxEdge, langs, psm, oem, minConfidence, minWords, minItems, minAlphaWords,
  searchRotations, mapRotationBack, cacheMethod, workerBlobURL, userDefinedDpi,
} = {}) {
  if (workerPath !== undefined) cfg.workerPath = abs(workerPath);
  if (corePath !== undefined) cfg.corePath = abs(corePath);
  if (langPath !== undefined) cfg.langPath = abs(langPath);
  if (tesseractModuleURL !== undefined) cfg.moduleURL = abs(tesseractModuleURL);
  if (tesseract !== undefined) cfg.tesseract = tesseract;
  if (logger !== undefined) cfg.logger = logger;
  if (scale !== undefined) cfg.scale = scale;
  if (maxEdge !== undefined) cfg.maxEdge = maxEdge;
  if (langs !== undefined) cfg.langs = langs;
  if (psm !== undefined) cfg.psm = String(psm);
  if (oem !== undefined) cfg.oem = oem;
  if (minConfidence !== undefined) cfg.minConfidence = minConfidence;
  if (minWords !== undefined) cfg.minWords = minWords;
  if (minItems !== undefined) cfg.minItems = minItems;
  if (minAlphaWords !== undefined) cfg.minAlphaWords = minAlphaWords;
  if (searchRotations !== undefined) cfg.searchRotations = !!searchRotations;
  if (mapRotationBack !== undefined) cfg.mapRotationBack = !!mapRotationBack;
  if (cacheMethod !== undefined) cfg.cacheMethod = cacheMethod;
  if (workerBlobURL !== undefined) cfg.workerBlobURL = workerBlobURL;
  if (userDefinedDpi !== undefined) cfg.userDefinedDpi = userDefinedDpi;
  // a caller that sets paths itself overrides the vendored defaults
  if (workerPath !== undefined || corePath !== undefined || langPath !== undefined) {
    if (workerPath !== undefined) VENDOR.workerPath = abs(workerPath);
    if (corePath !== undefined) VENDOR.corePath = abs(corePath);
    if (langPath !== undefined) VENDOR.langPath = abs(langPath);
  }
}

/** @returns the resolved configuration (for debugging / the tests) */
export function ocrConfig() {
  return { ...cfg, vendor: { ...VENDOR }, node: isNodeEnv };
}

// ---------------------------------------------------------------- scan detection

/**
 * True when a page's text layer is empty / nearly empty, i.e. the page is probably a scan.
 * `textItems` is anything with a `str`, exactly what pdf.js getTextContent() gives us.
 */
export function isProbablyScanned(textItems, { minItems = cfg.minItems } = {}) {
  const list = Array.isArray(textItems) ? textItems : [];
  let n = 0;
  for (const it of list) {
    if (!it) continue;
    const s = clampStr(it.str ?? it.text ?? "");
    if (s) n++;
    if (n >= minItems) return false;
  }
  return true;
}

// ---------------------------------------------------------------- canvas helpers

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  }
  throw new Error("ocr: no canvas available (need OffscreenCanvas or a <canvas> element)");
}

/** Render a pdf.js page into a fresh canvas. Returns { canvas, scale, width, height }. */
async function renderPage(page, scale, maxEdge) {
  const base = page.getViewport({ scale: 1 });
  const cap = maxEdge > 0 ? maxEdge / Math.max(base.width, base.height) : Infinity;
  const s = Math.max(0.2, Math.min(scale, cap));
  const viewport = page.getViewport({ scale: s });   // honours the sheet's /Rotate
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  if (!ctx) throw new Error("ocr: could not get a 2d context for the page raster");
  ctx.fillStyle = "#ffffff";                         // scans have a white page background
  ctx.fillRect(0, 0, width, height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return { canvas, scale: s, width, height };
}

/** Rotate a raster clockwise by 0/90/180/270 degrees. */
function rotateCanvas(src, deg) {
  const d = ((deg % 360) + 360) % 360;
  if (!d) return src;
  const swap = d === 90 || d === 270;
  const width = swap ? src.height : src.width;
  const height = swap ? src.width : src.height;
  const out = makeCanvas(width, height);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.translate(width / 2, height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2, src.width, src.height);
  return out;
}

/**
 * Map a word box from the rotated raster back into the un-rotated page raster,
 * so OCR items and pdf.js text items live in the same frame (y down, page upright).
 */
export function unrotateBox(box, deg, srcW, srcH) {
  const d = ((deg % 360) + 360) % 360;
  const { x, y, w, h } = box;
  if (!d) return { x, y, w, h };
  if (d === 90) return { x: y, y: srcH - (x + w), w: h, h: w };
  if (d === 180) return { x: srcW - (x + w), y: srcH - (y + h), w, h };
  return { x: srcW - (y + h), y: x, w: h, h: w };  // 270
}

// ---------------------------------------------------------------- tesseract

let TESS = null;
let workerPromise = null;
let workerKey = "";

async function loadTesseract() {
  if (TESS) return TESS;
  if (cfg.tesseract) { TESS = cfg.tesseract; return TESS; }
  let mod;
  if (isNodeEnv) {
    // Node: tesseract.js's own node worker + wasm core from node_modules.
    mod = await import("tesseract.js");
  } else {
    // Browser: the vendored ESM bundle — no CDN, no bundler.
    // (that bundle has a single default export, the node build has named exports)
    mod = await import(cfg.moduleURL || VENDOR.moduleURL);
  }
  TESS = mod && typeof mod.createWorker === "function" ? mod : (mod && mod.default) || mod;
  if (!TESS || typeof TESS.createWorker !== "function")
    throw new Error("ocr: tesseract.js module has no createWorker() — check configureOcr({ tesseractModuleURL })");
  return TESS;
}

/** In Node the langPath must be a real filesystem path (the browser wants a URL). */
async function nodeLangPath() {
  if (!isNodeEnv) return cfg.langPath;
  try {
    const { fileURLToPath } = await import("node:url");
    const fs = await import("node:fs");
    const dir = fileURLToPath(VENDOR.langPath);       // .../vendor/tesseract/
    if (fs.existsSync(`${dir}/${cfg.langs}.traineddata.gz`)) return dir.replace(/[\\/]+$/, "");
  } catch { /* fall through to the CDN default */ }
  return cfg.langPath;
}

async function getWorker(langs) {
  const key = `${langs}|${cfg.psm}|${cfg.oem}`;
  if (workerPromise && workerKey === key) return workerPromise;
  if (workerPromise) await terminateOcr();
  workerKey = key;
  workerPromise = (async () => {
    const { createWorker } = await loadTesseract();
    const options = {
      gzip: true,                                    // eng.traineddata.gz is what we vendored
      cacheMethod: cfg.cacheMethod,
      logger: cfg.logger || (() => {}),
    };
    if (!isNodeEnv) {
      options.workerPath = VENDOR.workerPath;
      options.corePath = VENDOR.corePath;
      options.langPath = VENDOR.langPath;
      if (cfg.workerBlobURL !== undefined) options.workerBlobURL = cfg.workerBlobURL;
    } else {
      const lp = await nodeLangPath();
      if (lp) options.langPath = lp;
    }
    const worker = await createWorker(langs, cfg.oem, options);
    const params = { tessedit_pageseg_mode: String(cfg.psm), preserve_interword_spaces: "1" };
    if (cfg.userDefinedDpi) params.user_defined_dpi = String(cfg.userDefinedDpi);
    await worker.setParameters(params);
    return worker;
  })();
  return workerPromise;
}

/** Stop the OCR worker (frees the wasm heap). */
export async function terminateOcr() {
  const p = workerPromise;
  workerPromise = null;
  workerKey = "";
  if (!p) return;
  try { const w = await p; await w.terminate(); } catch { /* already gone */ }
}

/** tesseract.js `blocks` JSON -> flat word list. */
function wordsFromBlocks(data) {
  const out = [];
  const blocks = (data && data.blocks) || [];
  for (const b of blocks) {
    for (const para of b.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) {
          const bb = w.bbox || {};
          out.push({
            str: String(w.text ?? ""),
            x: num(bb.x0), y: num(bb.y0),
            w: Math.max(0, num(bb.x1) - num(bb.x0)),
            h: Math.max(0, num(bb.y1) - num(bb.y0)),
            confidence: num(w.confidence),
          });
        }
      }
    }
  }
  return out;
}

/** TSV fallback (level 5 = word rows) — used if a page segmentation mode returns no blocks. */
function wordsFromTsv(tsv) {
  const out = [];
  if (typeof tsv !== "string") return out;
  const lines = tsv.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    if (c.length < 12 || c[0] !== "5") continue;
    const left = num(c[6]), top = num(c[7]), width = num(c[8]), height = num(c[9]);
    out.push({
      str: c.slice(11).join("\t"),
      x: left, y: top, w: width, h: height, confidence: num(c[10]),
    });
  }
  return out;
}

/**
 * OCR raster pixels -> word boxes + drawing items. Env-agnostic: takes anything tesseract.js
 * accepts (an OffscreenCanvas / <canvas> / Blob in the browser, a PNG/JPEG path or bytes in Node).
 */
export async function ocrImage(source, {
  langs = cfg.langs, psm, onProgress, scale = 1, rotation = 0, page = 1, rasterW = 0, rasterH = 0,
} = {}) {
  const worker = await getWorker(langs);
  const t0 = Date.now();
  const out = { text: true, blocks: true, tsv: true };
  const opts = {};
  if (psm !== undefined) opts.tessedit_pageseg_mode = String(psm);
  const res = await worker.recognize(source, opts, out);
  const raw = wordsFromBlocks(res.data);
  const words = raw.length ? raw : wordsFromTsv(res.data.tsv);
  const { items, dropped } = toItems(words, { page, scale, rotation, rasterW, rasterH });
  const ms = Date.now() - t0;
  if (typeof onProgress === "function") onProgress({ phase: "ocr", page: page, pages: 1, progress: 1 });
  return { words, items, dropped, raw: res.data, ms, scale, rotation, page };
}

/** Words -> js/pdfparse.js items, dropping low-confidence and junk words. */
function toItems(words, { page = 1, scale = 1, rotation = 0, rasterW = 0, rasterH = 0 } = {}) {
  const items = [];
  let dropped = 0;
  for (const w of words) {
    const str = clampStr(w.str).replace(/\s+/g, "");
    if (!str) { dropped++; continue; }
    if (num(w.confidence, 0) < cfg.minConfidence) { dropped++; continue; }
    if (isJunkWord(str)) { dropped++; continue; }
    // When the raster had to be rotated to be readable, the words are kept in that readable
    // frame by default: that is the frame a person reads the sheet in, and js/pdfparse.js's tag
    // rule ("the name sits ABOVE the area") only works there. Set mapRotationBack to put them
    // back in the page frame (matching pdf.js display coordinates) instead.
    const box = cfg.mapRotationBack
      ? unrotateBox({ x: w.x, y: w.y, w: w.w, h: w.h }, rotation, rasterW, rasterH)
      : { x: w.x, y: w.y, w: w.w, h: w.h };
    const s = scale > 0 ? scale : 1;
    items.push({
      str,
      x: +(box.x / s).toFixed(2),
      y: +(box.y / s).toFixed(2),
      h: +Math.max(1, box.h / s).toFixed(2),
      w: +Math.max(0, box.w / s).toFixed(2),
      page,
      confidence: Math.round(num(w.confidence)),
    });
  }
  return { items, dropped };
}

/** Words that clearly read as words: 3+ letters, decent confidence. Used to tell a readable
 *  orientation from a sideways one ("ia]", "£3", "El" score 0). */
function readableWords(items) {
  let n = 0;
  for (const it of items) {
    if (it.confidence >= 60 && /^[A-Za-z]{3,}[.,]?$/.test(it.str)) n++;
  }
  return n;
}

// ---------------------------------------------------------------- one page

/**
 * OCR one already-loaded pdf.js page.
 * @returns {{items:object[], words:number, ms:number, rotation:number, warnings:string[]}}
 */
export async function ocrPdfPage({
  pdfjs, page, pageNo = 1, scale = cfg.scale, langs = cfg.langs, onProgress, maxEdge = cfg.maxEdge,
} = {}) {
  if (!page || typeof page.getViewport !== "function")
    throw new Error("ocrPdfPage: pass a pdf.js page object as { page }");
  const warnings = [];
  const t0 = Date.now();
  const report = (phase, progress) => {
    if (typeof onProgress === "function")
      onProgress({ phase, page: pageNo, pages: 1, progress });
  };

  report("render", 0);
  const raster = await renderPage(page, scale, maxEdge);
  report("render", 1);

  const rotations = cfg.searchRotations ? [0, 90, 180, 270] : [0];
  let best = null;
  for (const deg of rotations) {
    report(deg ? "rotate" : "ocr", 0);
    const rotated = deg ? rotateCanvas(raster.canvas, deg) : raster.canvas;
    const raw = await ocrImage(rotated, {
      langs, scale: raster.scale, rotation: deg, page: pageNo,
      rasterW: raster.width, rasterH: raster.height,
      onProgress: (p) => report(deg ? "rotate" : "ocr", p.progress),
    });
    const result = {
      items: raw.items, words: raw.items.length, rawWords: raw.words.length,
      dropped: raw.dropped, rotation: deg, ms: raw.ms, alpha: readableWords(raw.items),
    };
    if (!best || result.alpha > best.alpha || (result.alpha === best.alpha && result.words > best.words)) best = result;
    report(deg ? "rotate" : "ocr", 1);
    // A 90°-rotated sheet is rendered upright by pdf.js, so rotation 0 normally wins and we stop.
    // Only when the upright pass finds almost no readable words (a scan of a sideways drawing,
    // no /Rotate in the file) do we pay for re-reading the raster at 90/180/270.
    if (!deg && result.alpha >= cfg.minAlphaWords) break;
  }
  const thin = best.words < cfg.minWords;

  const words = best.rawWords || 0;
  if (best.rotation) {
    warnings.push(
      `Page ${pageNo}: the sheet had to be read rotated ${best.rotation}° (the scan is sideways) — ` +
        `room tags were read at that angle.`
    );
  }
  if (!best.items.length && !words) {
    warnings.push(`Page ${pageNo}: no text found on this page (the OCR pass found nothing to read).`);
  } else if (!best.items.length) {
    warnings.push(`Page ${pageNo}: OCR found ${words} word(s) but none survived the confidence/junk filter.`);
  } else if (thin) {
    warnings.push(`Page ${pageNo}: OCR kept only ${best.items.length} word(s) — this scan is small or faint, so expect only part of the rooms.`);
  }
  return {
    items: best.items,
    words: best.items.length,
    rawWords: best.rawWords,
    dropped: best.dropped,
    ms: Date.now() - t0,
    rotation: best.rotation,
    raster: { width: raster.width, height: raster.height, scale: raster.scale },
    warnings,
  };
}

// ---------------------------------------------------------------- whole document

/**
 * Whole document: OCR only the pages that look scanned; pages with a text layer use pdf.js text.
 * Rooms come from js/pdfparse.js parseText() so the room rules stay in ONE place.
 */
export async function ocrPdf(arrayBuffer, { pdfjs, onProgress, langs = cfg.langs, force = false, maxEdge = cfg.maxEdge } = {}) {
  if (!pdfjs || typeof pdfjs.getDocument !== "function")
    throw new Error("ocrPdf: pass the pdf.js module as { pdfjs }");
  if (!arrayBuffer) throw new Error("ocrPdf: arrayBuffer is required");

  const t0 = Date.now();
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  const total = doc.numPages;
  const items = [];
  const textParts = [];
  const warnings = [];
  const usedOcr = [];
  const rotations = {};
  const stats = [];

  for (let p = 1; p <= total; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });   // undo sheet rotation/offset
    const tc = await page.getTextContent();
    const textItems = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const m = pdfjs.Util.transform(viewport.transform, it.transform);
      textItems.push({
        str: it.str,
        x: m[4],
        y: m[5],
        h: Math.hypot(m[2], m[3]),
        w: Number.isFinite(it.width) ? it.width : 0,
        page: p,
      });
    }

    let pageItems = textItems;
    let rotation = 0;
    if (force || isProbablyScanned(textItems, { minItems: cfg.minItems })) {
      const ocr = await ocrPdfPage({
        pdfjs, page, pageNo: p, scale: cfg.scale, langs, maxEdge,
        onProgress: (e) => {
          if (typeof onProgress === "function") onProgress({ ...e, pages: total, progress: (p - 1 + (e.progress || 0)) / total });
        },
      });
      pageItems = ocr.items;
      rotation = ocr.rotation;
      usedOcr.push(p);
      rotations[p] = rotation;
      stats.push({ page: p, words: ocr.words, rawWords: ocr.rawWords, dropped: ocr.dropped, rotation, ms: ocr.ms });
      warnings.push(...ocr.warnings);
      warnings.push(
        `Page ${p}: read with OCR (the page has no text layer) — ${ocr.words} word(s) kept` +
          (rotation ? `, drawn rotated ${rotation}°` : "") + "."
      );
    }

    const lines = [];
    for (const it of pageItems) {
      items.push(it);
      lines.push(`[${num(it.x).toFixed(1)},${num(it.y).toFixed(1)}] ${it.str}`);
    }
    textParts.push(`----- page ${p}${usedOcr.includes(p) ? " (OCR)" : ""} -----\n` + lines.join("\n"));
    if (typeof onProgress === "function") onProgress({ phase: "page", page: p, pages: total, progress: p / total });
  }

  const { rooms, warnings: parseWarnings } = parseText(items);
  for (const w of parseWarnings) if (!warnings.includes(w)) warnings.push(w);
  // rooms that came off an OCR'd page are marked so the UI can show where they came from
  for (const r of rooms) if (usedOcr.includes(num(r.page, 1))) r.source = "ocr";
  if (!rooms.length && usedOcr.length && items.length) {
    warnings.push(
      `OCR read ${items.length} word(s) on page(s) ${usedOcr.join(", ")} but js/pdfparse.js could not build a room from them: ` +
        `a room needs a readable NAME and AREA, and on a scanned drawing the area tags ("96.0 m²") are the first thing OCR loses. ` +
        `A CSV/XLSX room schedule exported from Revit/Excel is far more accurate for scanned sheets.`
    );
  }

  return {
    rooms,
    pages: total,
    text: textParts.join("\n"),
    warnings,
    items,
    usedOcr,
    rotations,
    stats,
    ms: Date.now() - t0,
  };
}

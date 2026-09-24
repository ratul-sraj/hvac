// Server-side PDF parsing: wraps js/pdfparse.js (read-only, shared with the
// browser) and turns an uploaded file into the room list the UI expects.
//
// pdf.js is passed in by the caller because pdfparse.js must not import it
// itself: the browser loads vendor/pdf.min.mjs, Node loads the legacy build.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { parsePdf } from "../js/pdfparse.js";

export { pdfjs };

// Node Buffer -> ArrayBuffer view slice (pdf.js wants a plain ArrayBuffer).
export const toArrayBuffer = (buf) =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// A PDF must begin with the %PDF- magic bytes. Some producers pad a little, so
// we accept the marker anywhere in the first kilobyte but nothing later.
export function looksLikePdf(buf) {
  if (!buf || buf.length < 5) return false;
  const head = buf.subarray(0, 1024).toString("latin1");
  return head.includes("%PDF-");
}

// True for ".pdf" filename or the application/pdf mimetype.
export function isPdfUpload(file) {
  const name = String((file && file.originalname) || "").toLowerCase();
  const mime = String((file && file.mimetype) || "").toLowerCase();
  return name.endsWith(".pdf") || mime === "application/pdf";
}

/**
 * Parse one uploaded file.
 * @returns {Promise<{name,pages,rooms,warnings,levelCount,roomCount,ms}>}
 * `rooms` here are the raw parser rooms with `sourceFile` stamped on them.
 */
export async function parseUpload(file) {
  const started = Date.now();
  const name = file.originalname || "upload.pdf";
  const buf = file.buffer;

  if (!buf || !buf.length) {
    const err = new Error(`${name}: the file is empty`);
    err.status = 400;
    throw err;
  }
  if (!looksLikePdf(buf)) {
    const err = new Error(`${name}: not a PDF (the file does not start with %PDF)`);
    err.status = 400;
    throw err;
  }

  let parsed;
  try {
    parsed = await parsePdf(toArrayBuffer(buf), { pdfjs });
  } catch (cause) {
    const err = new Error(`${name}: could not read the PDF (${(cause && cause.message) || cause})`);
    err.status = 400;
    throw err;
  }

  const rooms = (parsed.rooms || []).map((r) => ({ ...r, sourceFile: name }));
  const warnings = (parsed.warnings || []).map((w) => `${name}: ${w}`);
  const levels = new Set(rooms.map((r) => r.level).filter(Boolean));

  return {
    name,
    pages: parsed.pages || 0,
    rooms,
    warnings,
    levelCount: levels.size,
    roomCount: rooms.length,
    ms: Date.now() - started,
  };
}

/**
 * viewer.js — VIEWER agent. Renders a PDF page into a <canvas> so the plan is visible.
 *
 * Owner: VIEWER agent. No other module may edit this file. It renders ONE page at a time into a
 * single canvas, lazily, and caches the painted bitmap per (page, scale). The overlay module
 * (js/overlay.js) draws the coloured room rectangles on top, using the pdf.js PageViewport that
 * getViewport() hands back — screen coordinates are never computed or stored here.
 *
 * CONTRACT (the overlay and app are written against exactly this):
 *
 *   export function createViewer(rootEl, {
 *     pdfjsUrl  = './vendor/pdf.min.mjs',       // ES module to import
 *     workerUrl = './vendor/pdf.worker.min.mjs',
 *     maxScale  = 2,                            // clamp so a huge CAD sheet cannot blow up memory
 *     minScale  = 0.25,
 *   } = {}) -> Viewer
 *
 *   Viewer:
 *     async load(bytes)        ArrayBuffer | Uint8Array. -> { pages }. Rejects with a readable
 *                              Error on a non-PDF (the %PDF- magic bytes are checked first).
 *     async showPage(n)        1-based. Renders lazily; the painted bitmap is cached per
 *                              (page, scale), so revisiting a page is a blit, not a re-render.
 *     async getPageSize(n?)    { width, height } in PDF POINTS (unscaled) for page n (default current).
 *     getViewport()            the pdf.js PageViewport of the CURRENTLY SHOWN page. Exposes
 *                              convertToViewportPoint/convertToPdfPoint (overlay relies on them), or
 *                              null before the first paint.
 *     getCurrentPage()         number, 1-based.
 *     setScale(s) / getScale() setScale re-renders the current page; the value is clamped to
 *                              [minScale, maxScale].
 *     async fitWidth()         pick a scale so the page fits the element width (capped at maxScale),
 *                              then render. Prefer calling this on first paint.
 *     isReady()                true once a page has actually painted.
 *     on(event, cb)            'rendered'   -> cb({ page, viewport })  AFTER the canvas is painted
 *                              'pagechange' -> cb({ page })           as soon as showPage starts
 *                              Returns an unsubscribe function.
 *     destroy()                cancel any in-flight render, drop the pdf document and the DOM.
 *
 * DOM created inside rootEl:
 *   <div class="viewer-wrap" style="position:relative">  ...  <canvas id="planCanvas">  ...  </div>
 * Nothing else. The canvas CSS size equals viewport.width x viewport.height (the backing store is
 * that size times devicePixelRatio, and pdf.js is told to scale the drawing by the same factor so
 * it stays crisp) — the overlay positions itself against exactly this box and reads the viewport
 * that produced it.
 */

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
/** Real PDFs may carry junk before the header; the spec tolerates up to 1024 bytes of it. */
const MAGIC_SCAN_BYTES = 1024;
/** How many (page, scale) bitmaps to keep. Enough for a few pages at a couple of zoom levels. */
const CACHE_LIMIT = 12;

/** Coerce load() input to a Uint8Array view over the same bytes (no copy where possible). */
function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new Error(
    'load() needs an ArrayBuffer or Uint8Array of PDF bytes, got ' +
      (bytes === null ? 'null' : typeof bytes)
  );
}

/**
 * Find the "%PDF-" header. Returns its byte offset, or -1. Scans the first 1024 bytes so files
 * with a leading BOM/comment still open, while a genuinely non-PDF blob is rejected.
 */
function findPdfHeader(u8) {
  const limit = Math.min(u8.length, MAGIC_SCAN_BYTES);
  outer: for (let i = 0; i + PDF_MAGIC.length <= limit; i++) {
    for (let j = 0; j < PDF_MAGIC.length; j++) {
      if (u8[i + j] !== PDF_MAGIC[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** A short, printable rendering of the first bytes, for the error message. */
function previewBytes(u8) {
  const n = Math.min(u8.length, 12);
  let out = '';
  for (let i = 0; i < n; i++) {
    const c = u8[i];
    out += c >= 32 && c < 127 ? String.fromCharCode(c) : '.';
  }
  return out || '(empty)';
}

export function createViewer(rootEl, options = {}) {
  const {
    pdfjsUrl = './vendor/pdf.min.mjs',
    workerUrl = './vendor/pdf.worker.min.mjs',
    maxScale = 2,
    minScale = 0.25,
  } = options;

  if (!rootEl || typeof rootEl.appendChild !== 'function') {
    throw new Error('createViewer(rootEl): rootEl must be a DOM element');
  }

  // ---- DOM: a relative wrapper holding exactly one canvas ----
  const wrapper = document.createElement('div');
  wrapper.className = 'viewer-wrap';
  wrapper.style.position = 'relative';
  wrapper.style.lineHeight = '0';

  const canvas = document.createElement('canvas');
  canvas.id = 'planCanvas';
  canvas.style.display = 'block';

  wrapper.appendChild(canvas);
  rootEl.appendChild(wrapper);

  // ---- state ----
  let pdfjs = null;          // imported pdf.js module
  let doc = null;            // the open PDFDocumentProxy
  let currentPage = 1;
  let scale = 1;
  let currentViewport = null;
  let ready = false;         // true once a page has actually painted
  let renderTask = null;     // in-flight RenderTask, for cancellation
  let destroyed = false;
  const cache = new Map();   // `${page}:${scale}` -> <canvas> copy of the painted bitmap
  const listeners = new Map(); // event name -> Set<fn>

  // ---- tiny event emitter ----
  function on(event, cb) {
    if (typeof cb !== 'function') return () => {};
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => off(event, cb);
  }
  function off(event, cb) {
    const set = listeners.get(event);
    if (set) set.delete(cb);
  }
  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try { cb(payload); } catch (e) { console.error(`viewer: '${event}' listener threw`, e); }
    }
  }

  function clampScale(s) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return scale;
    return Math.min(maxScale, Math.max(minScale, n));
  }

  function cacheSet(key, cnv) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, cnv);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  function ensureDoc() {
    if (!doc) throw new Error('viewer: no PDF loaded — call await load(bytes) first');
    return doc;
  }

  /** Size the canvas (and wrapper) to the viewport, in CSS px; backing store gets the dpr factor. */
  function sizeCanvas(viewport) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = viewport.width;
    const cssH = viewport.height;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    wrapper.style.width = cssW + 'px';
    wrapper.style.height = cssH + 'px';
    return dpr;
  }

  /** Render pageNum at scale sc into the canvas, using (and filling) the bitmap cache. */
  async function paint(pageNum, sc) {
    const page = await doc.getPage(pageNum);
    if (destroyed) return;
    const viewport = page.getViewport({ scale: sc });
    currentViewport = viewport;
    const dpr = sizeCanvas(viewport);
    const ctx = canvas.getContext('2d');
    const key = `${pageNum}:${sc}`;
    const cached = cache.get(key);
    const usable =
      cached && cached.width === canvas.width && cached.height === canvas.height;

    if (usable) {
      // cache hit: a cheap blit, no re-render
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(cached, 0, 0);
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
      const task = page.render({ canvasContext: ctx, viewport, transform });
      renderTask = task;
      try {
        await task.promise;
      } catch (e) {
        // A cancelled render is expected when the user pages/zooms before it finishes.
        if (destroyed || e?.name === 'RenderingCancelledException') return;
        throw e;
      } finally {
        if (renderTask === task) renderTask = null;
      }
      if (destroyed) return;
      // keep a copy of the freshly painted bitmap so revisiting this (page, scale) is a blit
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const cctx = copy.getContext('2d');
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.drawImage(canvas, 0, 0);
      cacheSet(key, copy);
    }

    ready = true;
    emit('rendered', { page: pageNum, viewport });
  }

  // ------------------------------------------------------------------ API

  async function load(bytes) {
    if (destroyed) throw new Error('viewer: destroyed');
    const u8 = toBytes(bytes);

    const headerAt = findPdfHeader(u8);
    if (headerAt < 0) {
      throw new Error(
        `Not a PDF file: expected the bytes to start with "%PDF-" but found "${previewBytes(u8)}". ` +
          'Choose a PDF drawing (.pdf).'
      );
    }
    const data = headerAt === 0 ? u8 : u8.subarray(headerAt);

    if (!pdfjs) {
      // The default paths are PAGE-relative (e.g. './vendor/pdf.min.mjs' from a page at the repo
      // root), so resolve them against the document base — not against this module's /js/ URL.
      const pdfUrl = new URL(pdfjsUrl, document.baseURI).href;
      pdfjs = await import(/* @vite-ignore */ pdfUrl);
      // pdf.js throws 'No "GlobalWorkerOptions.workerSrc" specified' unless this is set BEFORE getDocument.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(workerUrl, document.baseURI).href;
    }

    // Replacing a previously loaded document: tear it down first.
    if (doc) { try { await doc.destroy(); } catch { /* ignore */ } doc = null; }
    cache.clear();
    ready = false;
    currentViewport = null;
    currentPage = 1;

    const task = pdfjs.getDocument({ data });
    doc = await task.promise;
    if (destroyed) { try { await doc.destroy(); } catch { /* ignore */ } }
    return { pages: doc.numPages };
  }

  async function showPage(n) {
    ensureDoc();
    const num = Math.trunc(Number(n));
    if (!Number.isFinite(num) || num < 1 || num > doc.numPages) {
      throw new Error(`showPage(${n}): page must be between 1 and ${doc.numPages}`);
    }
    currentPage = num;
    emit('pagechange', { page: num }); // as soon as showPage starts
    await paint(num, scale);
  }

  async function getPageSize(n) {
    ensureDoc();
    const num = n == null ? currentPage : Math.trunc(Number(n));
    if (!Number.isFinite(num) || num < 1 || num > doc.numPages) {
      throw new Error(`getPageSize(${n}): page must be between 1 and ${doc.numPages}`);
    }
    const page = await doc.getPage(num);
    const vp = page.getViewport({ scale: 1 });
    return { width: vp.width, height: vp.height }; // PDF points, unscaled
  }

  function getViewport() {
    return currentViewport;
  }

  function getCurrentPage() {
    return currentPage;
  }

  function getScale() {
    return scale;
  }

  async function setScale(s) {
    ensureDoc();
    const next = clampScale(s);
    scale = next;
    if (ready) await paint(currentPage, scale); // re-render the current page
    return scale;
  }

  async function fitWidth() {
    ensureDoc();
    const page = await doc.getPage(currentPage);
    const vp1 = page.getViewport({ scale: 1 });
    // element content width; fall back to the wrapper, then a sane default
    const avail =
      rootEl.clientWidth || wrapper.clientWidth || rootEl.getBoundingClientRect?.().width || 800;
    const target = clampScale(avail / vp1.width);
    scale = target;
    await paint(currentPage, scale);
    return scale;
  }

  function isReady() {
    return ready;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (renderTask) {
      try { renderTask.cancel(); } catch { /* ignore */ }
      renderTask = null;
    }
    if (doc) { try { doc.destroy(); } catch { /* ignore */ } doc = null; }
    cache.clear();
    listeners.clear();
    if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
  }

  return {
    load,
    showPage,
    getPageSize,
    getViewport,
    getCurrentPage,
    setScale,
    getScale,
    fitWidth,
    isReady,
    on,
    destroy,
    // handy handles for the overlay/tests (not part of the required contract, cheap to expose)
    canvas,
    element: wrapper,
  };
}

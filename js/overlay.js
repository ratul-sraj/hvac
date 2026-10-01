/**
 * overlay.js — the transparent SVG layer that sits ON TOP of the plan canvas.
 *
 * OVERLAY agent-owned. It is the interaction layer for drawing rooms on the plan:
 *   • it paints one coloured box (+ name label) per drawn Room on the current page,
 *   • a box that is selected gets a clearly different, thicker outline,
 *   • in `draw` mode a pointer drag creates a NEW room by rubber-banding a rectangle,
 *     which is handed to the app as a PDF-space rectangle (never screen pixels).
 *
 * All geometry comes from the planner-owned, read-only module js/planview.js — this file
 * reimplements neither the maths nor the hit-testing. Screen coordinates are NEVER stored:
 * every render converts PDF points through the pdf.js viewport (rectToViewBox), so zoom,
 * pan and /Rotate can never corrupt the model.
 *
 * CONTRACT (the app is written against this exactly):
 *
 *   createOverlay(rootEl, {
 *     getViewport,     // () => pdf.js PageViewport of the current page (or null)
 *     getRooms,        // () => Room[]   (ALL rooms; we filter with roomsOnPage)
 *     getPage,         // () => number   current page, 1-based
 *     getSelectedId,   // () => string|null
 *     getScaleDenom,   // () => number   drawing scale N in 1:N (for the live area readout)
 *     getMode,         // () => 'draw' | 'select'
 *     onDraw,          // (rect, {page}) => void   rect = {x,y,w,h} PDF points; only when usable
 *     onSelect,        // (room|null) => void      click in select mode
 *     onHover,         // (room|null) => void      optional; cursor/label feedback
 *     onRoomMoved,     // (id, rectPt) => void     LIVE: every pointermove of a move/resize drag
 *     onRoomMoveEnd,   // (id, rectPt) => void     on release: the app persists here
 *     onDelete,        // (id) => void             Delete/Backspace with a selection
 *   }) -> Overlay
 *
 *   Overlay: render() | setMode('draw'|'select') | resize() | destroy() | el (the <svg>)
 *
 * STAGE 2 (move / resize / delete / pan) — frozen 2026-10-01:
 *   • This module NEVER writes room state. A drag only calls onRoomMoved(id, rectPt) live and
 *     onRoomMoveEnd(id, rectPt) once on release; the app decides what to store. So the box follows
 *     the pointer only if the app applies the reported rect and re-renders.
 *   • select mode: a pointerdown within HANDLE_PX of a corner of the SELECTED room starts a RESIZE;
 *     a pointerdown inside any room box body starts a MOVE. The grab test is
 *     planview.handleAtPoint(), with the pixel radius converted to PDF points through the viewport
 *     (so a handle covers 9 px at every zoom); the new rect is planview.moveRect()/resizeRect() and
 *     is clamped with clampRectToPage(). A body drag can never resize and a handle drag can never
 *     move — the grabbed corner decides, once, at pointerdown.
 *   • a pointerup within CLICK_SLOP_PX of the pointerdown is still a click: it fires onSelect (the
 *     Stage-1 behaviour) and never onRoomMoveEnd. Beyond the slop it is a drag: it fires
 *     onRoomMoveEnd and never onSelect.
 *   • Delete/Backspace fires onDelete(selectedId) — but only when the focus is not in a text field
 *     (an <input>/<textarea>/<select> or contenteditable), so a table cell never loses a keystroke.
 *   • pan (BOTH modes): middle-button drag, or Space held + primary drag. Panning scrolls the
 *     scroll box (rootEl) itself and emits NO room callback and starts no draft.
 *   • Escape / pointercancel during a drag restores the rect the drag started from (one more
 *     onRoomMoved back to the original) and never fires onRoomMoveEnd.
 *
 *   class names added by Stage 2: plan-room-handle (+ is-nw/is-ne/is-se/is-sw) on the four corner
 *   grips of the selected room, is-dragging on a room during a move/resize, is-pan on the overlay
 *   while panning. Extra DOM: <g class="plan-handles"> inside the selected room's <g class="plan-room">.
 *
 * DOM created inside rootEl:
 *   <svg class="plan-overlay">
 *     <g class="rooms"/>   one <g class="plan-room"> per drawn room
 *     <g class="draft"/>   the rubber-band rectangle + the live readout, while dragging
 *
 * ---------------------------------------------------------------------------------------
 * CSS the app must provide (css/style.css — planner-owned; this file adds no stylesheet).
 * These are the only class names this module uses:
 *
 *   .plan-overlay            { position:absolute; inset:0; touch-action:none; overflow-anchor:none; }
 *   .plan-overlay.is-draw    { cursor:crosshair; }
 *   .plan-overlay.is-select  { cursor:default; }
 *   .plan-room               { cursor:pointer; }
 *   .plan-room-box           { fill:rgba(56,132,255,.18); stroke:#2f6fed; stroke-width:1; }
 *   .plan-room.is-excluded .plan-room-box { fill:rgba(120,120,120,.14); stroke:#8a8a8a; }
 *   .plan-room.is-selected .plan-room-box { stroke:#ff8a00; stroke-width:2.5; }
 *   .plan-room.is-dragging { cursor:grabbing; }
 *   .plan-room-handle        { fill:#fff; stroke:#ff8a00; stroke-width:1.5; pointer-events:none; }
 *   .plan-overlay.is-pan     { cursor:grabbing; }
 *   .plan-room-label         { font:11px system-ui; fill:#12243d; pointer-events:none; }
 *   .plan-draft-box          { fill:rgba(47,111,237,.15); stroke:#2f6fed; stroke-width:1.5;
 *                              stroke-dasharray:5 3; }
 *   .plan-overlay-readout    { font:12px system-ui; fill:#101820; paint-order:stroke;
 *                              stroke:#fff; stroke-width:3; pointer-events:none; }
 * ---------------------------------------------------------------------------------------
 */

import {
  normalizeRect,       // two drag corners (any order) -> {x,y,w,h} positive
  rectIsUsable,        // big enough to be a room? (MIN_RECT_PT)
  areaFromRect,        // PDF rect + drawing scale -> m²
  roomAtPoint,         // smallest drawn room under a PDF point on a page
  roomsOnPage,         // drawn rooms of one page, biggest first
  isDrawnRoom,         // has rect geometry? (parsed/scheduled rooms have none)
  rectToViewBox,       // PDF rect -> SVG box in view pixels, rotation-safe
  viewPointToPdf,      // view pixel -> PDF point
  handleAtPoint,       // which corner grip a PDF point grabs (the ONLY grab test allowed)
  moveRect,            // PDF rect moved by a delta
  resizeRect,          // PDF rect with one corner dragged, opposite corner pinned
  clampRectToPage,     // keep a PDF rect on the sheet
} from './planview.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A pointerup this close (view px) to the pointerdown counts as a click, not a drag. */
const CLICK_SLOP_PX = 4;
/** Corner grips: grab radius in view pixels (converted to PDF points through the viewport), and the
 *  drawn size of the grip square in view pixels. */
const HANDLE_PX = 9;

/** <input> types you actually type text into. Everything else (checkbox, radio, button, range, color)
 *  can receive focus without being a text field, and Delete must still reach the drawing from there. */
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'email', 'url', 'tel', 'password', 'number',
  'date', 'time', 'datetime-local', 'month', 'week',
]);
const HANDLE_DRAW_PX = 9;
/** Labels are hidden rather than drawn illegibly. */
const MIN_LABEL_PX = 6;
const MAX_LABEL_PX = 12;
const HANDLE_NAMES = ['nw', 'ne', 'se', 'sw'];

/** Trim float dust and render a small, stable SVG number. */
function num(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return String(Math.round(v * 100) / 100);
}

export function createOverlay(rootEl, {
  getViewport = () => null,
  getRooms = () => [],
  getPage = () => 1,
  getSelectedId = () => null,
  getScaleDenom = () => 100,
  getMode = () => 'select',
  onDraw = null,
  onSelect = null,
  onHover = null,
  onRoomMoved = null,
  onRoomMoveEnd = null,
  onDelete = null,
} = {}) {
  if (!rootEl) throw new Error('createOverlay: rootEl is required');

  /* ---------------------------------------------------------------- DOM */
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'plan-overlay');

  const roomsG = document.createElementNS(SVG_NS, 'g');
  roomsG.setAttribute('class', 'rooms');

  const draftG = document.createElementNS(SVG_NS, 'g');
  draftG.setAttribute('class', 'draft');

  svg.append(roomsG, draftG);
  rootEl.appendChild(svg);

  /* -------------------------------------------------------------- state */
  let mode = safeString(getMode) === 'draw' ? 'draw' : 'select';
  let size = { w: 0, h: 0 };
  // Active rubber band: PDF start/end points (y-up) + the last pointer position in view px.
  let draft = null;      // { page, startPdf, endPdf, cursorView }
  let downAt = null;     // view px of the pointerdown (click vs drag)
  let captureId = null;
  let hoverId = null;
  let destroyed = false;
  // Stage 2 gesture state.
  let drag = null;       // { kind:'move'|'resize', id, handle, startRect, startPdf, startView,
                         //   lastRect, dragged }   — null when no move/resize is in flight
  let pan = null;        // { startClientX, startClientY, scrollLeft, scrollTop }
  let spaceHeld = false; // Space is down (pan modifier)

  /* ------------------------------------------------------------ helpers */
  function safeString(fn) {
    try { return fn(); } catch { return null; }
  }
  function safeCall(fn, ...args) {
    if (typeof fn !== 'function') return undefined;
    try { return fn(...args); } catch (err) { console.error('plan-overlay:', err); return undefined; }
  }
  /** The current viewport, or null. Never throws. */
  function viewport() {
    const vp = safeCall(getViewport);
    return vp && typeof vp.convertToViewportPoint === 'function' ? vp : null;
  }
  /** Pointer position in view pixels relative to the overlay box (== the canvas box). */
  function localPoint(e) {
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  /** Clamp an SVG box to the canvas for DISPLAY only; the room model is never touched. */
  function clampBox(box) {
    const x = Math.max(0, Math.min(box.x, size.w));
    const y = Math.max(0, Math.min(box.y, size.h));
    const right = Math.min(size.w, box.x + box.w);
    const bottom = Math.min(size.h, box.y + box.h);
    return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
  }
  function rectOf(d) {
    if (!d) return null;
    return normalizeRect(d.startPdf, d.endPdf);
  }
  /** The selected room, but only when it is a drawn room on the current page (else null). */
  function selectedRoom() {
    const id = safeCall(getSelectedId);
    if (id == null) return null;
    const page = safeCall(getPage) ?? 1;
    for (const room of safeCall(getRooms) || []) {
      if (room && String(room.id) === String(id) && isDrawnRoom(room) && room.rect.page === page) return room;
    }
    return null;
  }
  /** The grab radius of a corner handle, in PDF points: HANDLE_PX view pixels measured through the
   *  viewport's own scale, so the grip covers the same distance under the finger at every zoom.
   *  (pdf.js /Rotate is always a multiple of 90°, so a pixel offset maps to an axis-aligned PDF
   *  offset and one scalar tolerance is exact.) Falls back to matrix probing for a viewport with no
   *  numeric scale. */
  function handleTolPt(vp) {
    const scale = Number(vp && vp.scale);
    if (Number.isFinite(scale) && scale > 0) return HANDLE_PX / scale;
    const o = viewPointToPdf(vp, { x: 0, y: 0 });
    const px = viewPointToPdf(vp, { x: HANDLE_PX, y: 0 });
    const py = viewPointToPdf(vp, { x: 0, y: HANDLE_PX });
    const tol = Math.max(Math.abs(px.x - o.x), Math.abs(px.y - o.y),
      Math.abs(py.x - o.x), Math.abs(py.y - o.y));
    return tol > 0 ? tol : HANDLE_PX;
  }
  /** The page size in PDF points, from the viewport's viewBox (the unrotated PDF box, which is the
   *  space `rect` lives in). null when it cannot be known — the caller then skips clamping rather
   *  than guessing a page. */
  function pageSizeOf(vp) {
    const vb = vp && vp.viewBox;
    if (!Array.isArray(vb) || vb.length < 4) return null;
    const w = Math.abs(Number(vb[2]) - Number(vb[0]));
    const h = Math.abs(Number(vb[3]) - Number(vb[1]));
    return (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) ? { width: w, height: h } : null;
  }
  /** The element a pan must scroll: the nearest scrollable box at or above rootEl (the plan lives in
   *  a scroll container, and that is where a grab-pan has to act). rootEl when there is none. */
  function scrollBox() {
    let el = rootEl;
    for (let i = 0; el && i < 6; i += 1) {
      const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
      const scrolls = cs && /(auto|scroll|overlay)/.test(`${cs.overflow}${cs.overflowX}${cs.overflowY}`);
      const overflow = el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
      if (scrolls && overflow) return el;
      el = el.parentElement;
    }
    return rootEl;
  }
  /** Is this element a text-entry field? Delete/Backspace must never be stolen from one.
   *  Only real text entry counts. A checkbox, radio or button is an <input> but not a place you type,
   *  and the mode radio keeps focus after it is clicked — clicking a room no longer blurs it (the drag
   *  cancels the default so the browser never moves focus), so treating every <input> as a text field
   *  meant Delete did nothing at all after switching to Select mode. */
  function isTextEntry(el) {
    if (!el || el === document) return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable === true) return true;
    if (tag !== 'INPUT') return false;
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
  function isSpaceKey(e) {
    return e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
  }
  function idOf(room) {
    return room && room.id != null ? room.id : null;
  }

  /* ---------------------------------------------------------- rendering */
  function roomShape(room, box, selected, dragging) {
    const g = document.createElementNS(SVG_NS, 'g');
    const excluded = room.include === false;
    g.setAttribute('class',
      'plan-room' + (excluded ? ' is-excluded' : ' is-included')
      + (selected ? ' is-selected' : '') + (dragging ? ' is-dragging' : ''));
    g.setAttribute('data-room-id', room.id == null ? '' : String(room.id));
    g.setAttribute('data-include', excluded ? 'false' : 'true');
    if (selected) g.setAttribute('data-selected', 'true');

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'plan-room-box');
    rect.setAttribute('x', num(box.x));
    rect.setAttribute('y', num(box.y));
    rect.setAttribute('width', num(box.w));
    rect.setAttribute('height', num(box.h));
    rect.setAttribute('vector-effect', 'non-scaling-stroke');
    g.appendChild(rect);

    const label = roomLabel(room, box);
    if (label) g.appendChild(label);
    // The four corner grips, only on the selected room — the room the resize gesture can act on.
    // They are drawn from the SAME view box as the outline, and are presentational only: the grab
    // test is geometric (handleAtPoint on PDF points), never a hit on this DOM.
    if (selected) g.appendChild(handleShape(box));
    return g;
  }

  /** The four corner grips of a room's view box, as a <g class="plan-handles">. */
  function handleShape(box) {
    const wrap = document.createElementNS(SVG_NS, 'g');
    wrap.setAttribute('class', 'plan-handles');
    const half = HANDLE_DRAW_PX / 2;
    const corners = {
      nw: { x: box.x, y: box.y },
      ne: { x: box.x + box.w, y: box.y },
      se: { x: box.x + box.w, y: box.y + box.h },
      sw: { x: box.x, y: box.y + box.h },
    };
    for (const name of HANDLE_NAMES) {
      const c = corners[name];
      const h = document.createElementNS(SVG_NS, 'rect');
      h.setAttribute('class', `plan-room-handle is-${name}`);
      h.setAttribute('x', num(c.x - half));
      h.setAttribute('y', num(c.y - half));
      h.setAttribute('width', num(HANDLE_DRAW_PX));
      h.setAttribute('height', num(HANDLE_DRAW_PX));
      wrap.appendChild(h);
    }
    return wrap;
  }

  /** The room name, centred in the box — or null when the box cannot fit it. */
  function roomLabel(room, box) {
    const name = String(room.name == null ? '' : room.name).trim();
    if (!name || box.w < 8 || box.h < 8) return null;
    // shrink to fit, and give up rather than draw something illegible
    const fitted = Math.min(MAX_LABEL_PX, box.h * 0.4, (box.w * 0.92) / Math.max(1, name.length * 0.55));
    if (fitted < MIN_LABEL_PX) return null;
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('class', 'plan-room-label');
    t.setAttribute('x', num(box.x + box.w / 2));
    t.setAttribute('y', num(box.y + box.h / 2));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'middle');
    t.setAttribute('font-size', num(fitted));
    t.textContent = name;
    return t;
  }

  /** The rubber band + the live size/area readout. Only drawn while a drag is in progress. */
  function renderDraft(vp) {
    draftG.replaceChildren();
    if (!draft || destroyed) return;
    const rect = rectOf(draft);
    if (!rect) return;

    const box = clampBox(rectToViewBox(vp, rect));
    const band = document.createElementNS(SVG_NS, 'rect');
    band.setAttribute('class', 'plan-draft-box');
    band.setAttribute('x', num(box.x));
    band.setAttribute('y', num(box.y));
    band.setAttribute('width', num(box.w));
    band.setAttribute('height', num(box.h));
    band.setAttribute('vector-effect', 'non-scaling-stroke');
    draftG.appendChild(band);

    // Real-world size: a 1x1 pt square at scale 1:N is (denom/72 × 0.0254) m on a side, so the
    // metres-per-point factor comes straight out of the planner's area function.
    const denom = Number(safeCall(getScaleDenom)) || 100;
    const mPerPt = Math.sqrt(areaFromRect({ x: 0, y: 0, w: 1, h: 1 }, denom));
    const wM = rect.w * mPerPt;
    const hM = rect.h * mPerPt;
    const area = areaFromRect(rect, denom);

    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('class', 'plan-overlay-readout');
    t.setAttribute('text-anchor', 'start');
    t.setAttribute('data-w-m', num(wM));
    t.setAttribute('data-h-m', num(hM));
    t.setAttribute('data-area-m2', num(area));
    t.textContent = `${wM.toFixed(2)} × ${hM.toFixed(2)} m · ${area.toFixed(2)} m²`;
    // near the cursor, nudged below-right of the crosshair, kept on the canvas
    const cur = draft.cursorView || { x: box.x + box.w, y: box.y };
    t.setAttribute('x', num(Math.max(2, Math.min(cur.x + 12, size.w - 4))));
    t.setAttribute('y', num(Math.max(14, Math.min(cur.y + 20, size.h - 4))));
    draftG.appendChild(t);
  }

  function render() {
    if (destroyed) return;
    roomsG.replaceChildren();
    const vp = viewport();
    if (!vp) { draftG.replaceChildren(); return; }   // no page rendered yet: draw nothing, throw nothing

    const page = safeCall(getPage) ?? 1;
    const rooms = roomsOnPage(safeCall(getRooms) || [], page).filter(isDrawnRoom);
    const selectedId = safeCall(getSelectedId) ?? null;

    for (const room of rooms) {
      const box = clampBox(rectToViewBox(vp, room.rect));
      if (box.w <= 0 || box.h <= 0) continue;        // wholly off-page: nothing visible to draw
      const dragging = !!drag && drag.dragged && String(drag.id) === String(room.id);
      roomsG.appendChild(roomShape(room, box, room.id === selectedId, dragging));
    }
    renderDraft(vp);
  }

  let observed = null;
  let observer = null;

  function resize() {
    // Measure the DRAWING, not the window. rootEl is a scroll container as soon as the sheet is
    // zoomed past fit-width, and a layer sized to the visible box scrolls away with the content:
    // the parts of the drawing that need scrolling to then take no pointer events at all, so rooms
    // could not be drawn there (reported from real use: "above 70% I can no longer draw").
    // The canvas box IS the scrollable content; rootEl is only the fallback.
    const canvas = rootEl.querySelector('canvas');
    const box = canvas && canvas.clientWidth ? canvas : rootEl;
    const w = Math.max(0, Math.round(box.clientWidth || 0));
    const h = Math.max(0, Math.round(box.clientHeight || 0));
    watch(box);
    if (w === size.w && h === size.h) return;   // nothing changed: leave the DOM alone
    size = { w, h };
    svg.setAttribute('width', String(size.w));
    svg.setAttribute('height', String(size.h));
    svg.setAttribute('viewBox', `0 0 ${size.w} ${size.h}`);
    render();
  }

  /** Follow the drawing's own size instead of waiting to be told about it.
   *  Zooming re-sizes the canvas asynchronously (it has to paint first), so a caller that resizes this
   *  layer right after asking for a zoom can measure the PREVIOUS canvas and leave the layer stale
   *  while the drawing has already grown — the rooms then sit bunched toward the top-left corner and
   *  the scroll extents are wrong. That is what a fast double-click on zoom produced: four clicks
   *  landing in one tick each re-sized the canvas, and the layer was left at the old size until the
   *  final paint happened to fix it ("if I give it a moment it behaves normally afterwards").
   *  Watching the element removes the whole class of bug, whatever re-sizes it — zoom, fit, a page
   *  change, or the window. */
  function watch(el) {
    if (el === observed) return;
    if (observer) { try { observer.disconnect(); } catch { /* nothing to do */ } observer = null; }
    observed = el;
    if (typeof ResizeObserver !== 'function' || !el || typeof el.addEventListener !== 'function') return;
    observer = new ResizeObserver(() => { resize(); });
    try { observer.observe(el); } catch { observer = null; }
  }

  /* ------------------------------------------------------------- cursor */
  function setHover(room) {
    const id = room && room.id != null ? String(room.id) : null;
    if (id === hoverId) return;
    hoverId = id;
    safeCall(onHover, room || null);
  }

  /* ------------------------------------------------------------- drafting */
  function releaseCapture(e) {
    if (captureId == null) return;
    try { svg.releasePointerCapture(captureId); } catch { /* already released */ }
    captureId = null;
    if (e && typeof e.pointerId === 'number') { /* nothing else to do */ }
  }

  function startDraft(e) {
    const vp = viewport();
    if (!vp) return;
    const p = localPoint(e);
    const pdf = viewPointToPdf(vp, p);
    draft = { page: safeCall(getPage) ?? 1, startPdf: { ...pdf }, endPdf: { ...pdf }, cursorView: p };
    downAt = p;
    try { svg.setPointerCapture(e.pointerId); captureId = e.pointerId; } catch { /* ignore */ }
    render();
  }

  function updateDraft(e) {
    const vp = viewport();
    if (!vp) return;
    const p = localPoint(e);
    draft.endPdf = viewPointToPdf(vp, p);
    draft.cursorView = p;
    render();
  }

  /** Commit the rubber band: exactly one onDraw, and only when the rectangle is usable. */
  function finishDraft(e) {
    if (!draft) return;
    const rect = rectOf(draft);
    const page = draft.page;
    releaseCapture(e);
    draft = null;
    downAt = null;
    render();
    if (rectIsUsable(rect)) safeCall(onDraw, rect, { page });
    // otherwise: a stray click. Discard silently — never create a 1 mm room.
  }

  function cancelDraft() {
    if (!draft) return;
    releaseCapture();
    draft = null;
    downAt = null;
    render();
  }

  /* ------------------------------------------------------------- gestures */
  /** Middle button, or primary while Space is held: a PAN. Decided before the mode, so a Space-drag
   *  never starts a draft, and it works in both modes. */
  function isPanStart(e) {
    if (e.pointerType === 'mouse' && e.button === 1) return true;
    return spaceHeld && e.button === 0;
  }

  function startPan(e) {
    const box = scrollBox();
    pan = {
      box,
      startClientX: e.clientX,
      startClientY: e.clientY,
      scrollLeft: box.scrollLeft || 0,
      scrollTop: box.scrollTop || 0,
    };
    // Nothing in flight survives a pan: no draft, no move/resize, no selection change.
    if (draft) cancelDraft();
    drag = null;
    downAt = null;
    setHover(null);
    svg.classList.add('is-pan');
    try { svg.setPointerCapture(e.pointerId); captureId = e.pointerId; } catch { /* ignore */ }
    e.preventDefault?.();
  }

  function updatePan(e) {
    if (!pan) return;
    const box = pan.box || rootEl;
    box.scrollLeft = pan.scrollLeft - (e.clientX - pan.startClientX);
    box.scrollTop = pan.scrollTop - (e.clientY - pan.startClientY);
    e.preventDefault?.();
  }

  function endPan(e) {
    if (!pan) return;
    releaseCapture(e);
    pan = null;
    svg.classList.remove('is-pan');
  }

  /** Begin a move (handle=null) or a resize (handle='nw'|'ne'|'se'|'sw') of one room. */
  function startDrag(e, kind, room, handle, p, pdf) {
    e.preventDefault?.();   // dragging a box must not start a text selection / browser drag
    drag = {
      kind,
      id: idOf(room),
      handle: handle || null,
      startRect: { ...room.rect },
      startPdf: { ...pdf },
      startView: p,
      lastRect: { ...room.rect },
      dragged: false,
    };
    downAt = p;
    try { svg.setPointerCapture(e.pointerId); captureId = e.pointerId; } catch { /* ignore */ }
    render();
  }

  /** The rect this drag would produce for a pointer PDF point, clamped to the sheet. moveRect() and
   *  resizeRect() (planner-owned) do the geometry; the only things added here are the page (a rect
   *  must stay on its page — resizeRect returns x/y/w/h only) and the clamp. */
  function dragRect(pdf, vp) {
    const base = drag.startRect;
    // resizeRect() returns a bare {x,y,w,h}: put the page back, or the room would leave its page.
    const rect = drag.kind === 'move'
      ? moveRect(base, pdf.x - drag.startPdf.x, pdf.y - drag.startPdf.y)
      : { ...resizeRect(base, drag.handle, pdf), page: base.page };
    return clampRectToPage(rect, pageSizeOf(vp));
  }

  function updateDrag(e) {
    const vp = viewport();
    if (!vp) return;
    const p = localPoint(e);
    if (!drag.dragged) {
      // Stay a click until the pointer actually leaves the click slop — a twitch on a room body
      // must still select it, not emit a 1 px move.
      if (Math.abs(p.x - drag.startView.x) <= CLICK_SLOP_PX
        && Math.abs(p.y - drag.startView.y) <= CLICK_SLOP_PX) return;
      drag.dragged = true;
    }
    const rect = dragRect(viewPointToPdf(vp, p), vp);
    drag.lastRect = rect;
    safeCall(onRoomMoved, drag.id, rect);   // live: every pointermove, no persistence here
    render();
  }

  /** Abandon a drag: put the app's rect back, and never fire onRoomMoveEnd. */
  function cancelDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    downAt = null;
    releaseCapture();
    if (d.dragged) safeCall(onRoomMoved, d.id, { ...d.startRect });
    render();
  }

  function onPointerDown(e) {
    if (destroyed) return;
    if (isPanStart(e)) { startPan(e); return; }
    // mouse only reacts to the primary button; touch/pen have button 0 too
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (mode === 'draw') {
      e.preventDefault?.();
      startDraft(e);
      return;
    }
    // select mode
    const vp = viewport();
    const p = localPoint(e);
    if (!vp) {
      downAt = p;
      try { svg.setPointerCapture(e.pointerId); captureId = e.pointerId; } catch { /* ignore */ }
      return;
    }
    const pdf = viewPointToPdf(vp, p);
    // 1. a corner of the SELECTED room → resize. The grab test is planview.handleAtPoint() with the
    //    pixel radius converted to PDF points through the viewport; never re-derived here.
    const selected = selectedRoom();
    const handle = selected ? handleAtPoint(selected.rect, pdf, handleTolPt(vp)) : null;
    if (handle) { startDrag(e, 'resize', selected, handle, p, pdf); return; }
    // 2. the body of any drawn room → move. The grabbed target decides once, so a body drag can
    //    never resize and vice versa.
    const room = roomAtPoint(safeCall(getRooms) || [], safeCall(getPage) ?? 1, pdf);
    if (room && isDrawnRoom(room)) { startDrag(e, 'move', room, null, p, pdf); return; }
    // 3. empty sheet: the Stage-1 click-to-select / click-to-deselect path
    downAt = p;
    try { svg.setPointerCapture(e.pointerId); captureId = e.pointerId; } catch { /* ignore */ }
  }

  function onPointerMove(e) {
    if (destroyed) return;
    if (pan) { updatePan(e); return; }
    if (drag) { updateDrag(e); return; }
    if (mode === 'draw') {
      if (draft) updateDraft(e);
      return;
    }
    const vp = viewport();
    if (!vp) { setHover(null); return; }
    setHover(roomAtPoint(safeCall(getRooms) || [], safeCall(getPage) ?? 1, viewPointToPdf(vp, localPoint(e))));
  }

  function onPointerUp(e) {
    if (destroyed) return;
    if (pan) { endPan(e); return; }
    const p = localPoint(e);
    const vp = viewport();
    const roomUnder = () => (vp
      ? roomAtPoint(safeCall(getRooms) || [], safeCall(getPage) ?? 1, viewPointToPdf(vp, p))
      : null);

    if (drag) {
      const d = drag;
      drag = null;
      downAt = null;
      releaseCapture(e);
      const room = roomUnder();
      if (d.dragged) {
        // a real drag: report the final rect for persistence, never a selection change
        safeCall(onRoomMoveEnd, d.id, d.lastRect);
      } else {
        // no movement beyond the slop: it was a click — exactly the Stage-1 behaviour
        safeCall(onSelect, room || null);
      }
      setHover(room || null);
      render();
      return;
    }

    if (mode === 'draw') { finishDraft(e); return; }
    releaseCapture(e);
    const wasClick = downAt
      && Math.abs(p.x - downAt.x) <= CLICK_SLOP_PX
      && Math.abs(p.y - downAt.y) <= CLICK_SLOP_PX;
    downAt = null;
    if (!wasClick) return;
    const room = roomUnder();
    safeCall(onSelect, room || null);
    setHover(room || null);
  }

  function onPointerCancel(e) {
    if (destroyed) return;
    if (pan) { endPan(e); return; }
    if (drag) { cancelDrag(); return; }
    if (mode === 'draw') { cancelDraft(); return; }
    releaseCapture(e);
    downAt = null;
  }

  function onKeyDown(e) {
    if (destroyed) return;
    if (e.key === 'Escape') {
      if (drag) cancelDrag();
      else if (draft) cancelDraft();
      return;
    }
    if (isSpaceKey(e)) {
      // Space is the pan modifier. Never steal it from a text field.
      if (!isTextEntry(document.activeElement)) spaceHeld = true;
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    // NEVER steal Delete from a text field or a contenteditable cell.
    if (isTextEntry(document.activeElement) || isTextEntry(e.target)) return;
    if (drag || pan) return;                    // mid-gesture: a stray Delete does nothing
    const id = safeCall(getSelectedId);
    if (id == null) return;
    e.preventDefault?.();                       // Backspace must not act as "go back"
    safeCall(onDelete, id);
  }

  function onKeyUp(e) {
    if (isSpaceKey(e)) spaceHeld = false;
  }
  function onWindowBlur() { spaceHeld = false; }
  /** Chrome's middle-click AUTOSCROLL is started by mousedown, and cancelling only the pointerdown
   *  does not stop it: the compass appears and the view keeps scrolling long after the pan ended.
   *  A pan gesture's mousedown must be cancelled too. */
  function onMouseDown(e) {
    if (e.button === 1 || (spaceHeld && e.button === 0)) e.preventDefault();
  }

  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerCancel);
  svg.addEventListener('pointerleave', () => { if (mode !== 'draw' && !drag && !pan) setHover(null); });
  svg.addEventListener('mousedown', onMouseDown);
  svg.addEventListener('mouseup', onMouseDown);
  svg.addEventListener('auxclick', onMouseDown);
  // Chrome's middle-click AUTOSCROLL is started by mousedown, and cancelling only the pointerdown
  // does not stop it: the compass appears and the page keeps scrolling, long after the pan ended.
  // A pan gesture's mousedown must therefore be cancelled too.
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onWindowBlur);

  /* --------------------------------------------------------------- public */
  function setMode(m) {
    mode = m === 'draw' ? 'draw' : 'select';
    svg.classList.toggle('is-draw', mode === 'draw');
    svg.classList.toggle('is-select', mode !== 'draw');
    cancelDrag();
    cancelDraft();
    setHover(null);
    render();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (observer) { try { observer.disconnect(); } catch { /* nothing to do */ } observer = null; }
    observed = null;
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onWindowBlur);
    svg.removeEventListener('pointerdown', onPointerDown);
    svg.removeEventListener('pointermove', onPointerMove);
    svg.removeEventListener('pointerup', onPointerUp);
    svg.removeEventListener('pointercancel', onPointerCancel);
    svg.removeEventListener('mousedown', onMouseDown);
    releaseCapture();
    draft = null;
    drag = null;
    pan = null;
    spaceHeld = false;
    downAt = null;
    svg.classList.remove('is-pan');
    if (svg.parentNode) svg.parentNode.removeChild(svg);
  }

  // initial state: mode class + a box that matches the canvas
  svg.classList.toggle('is-draw', mode === 'draw');
  svg.classList.toggle('is-select', mode !== 'draw');
  resize();

  return { render, setMode, resize, destroy, el: svg };
}

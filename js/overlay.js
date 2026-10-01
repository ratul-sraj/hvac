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
 *   }) -> Overlay
 *
 *   Overlay: render() | setMode('draw'|'select') | resize() | destroy() | el (the <svg>)
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
 *   .plan-overlay            { position:absolute; inset:0; touch-action:none; }
 *   .plan-overlay.is-draw    { cursor:crosshair; }
 *   .plan-overlay.is-select  { cursor:default; }
 *   .plan-room               { cursor:pointer; }
 *   .plan-room-box           { fill:rgba(56,132,255,.18); stroke:#2f6fed; stroke-width:1; }
 *   .plan-room.is-excluded .plan-room-box { fill:rgba(120,120,120,.14); stroke:#8a8a8a; }
 *   .plan-room.is-selected .plan-room-box { stroke:#ff8a00; stroke-width:2.5; }
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
} from './planview.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A pointerup this close (view px) to the pointerdown counts as a click, not a drag. */
const CLICK_SLOP_PX = 4;
/** Labels are hidden rather than drawn illegibly. */
const MIN_LABEL_PX = 6;
const MAX_LABEL_PX = 12;

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

  /* ---------------------------------------------------------- rendering */
  function roomShape(room, box, selected) {
    const g = document.createElementNS(SVG_NS, 'g');
    const excluded = room.include === false;
    g.setAttribute('class',
      'plan-room' + (excluded ? ' is-excluded' : ' is-included') + (selected ? ' is-selected' : ''));
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
    return g;
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
      roomsG.appendChild(roomShape(room, box, room.id === selectedId));
    }
    renderDraft(vp);
  }

  function resize() {
    // Measure the DRAWING, not the window. rootEl is a scroll container as soon as the sheet is
    // zoomed past fit-width, and a layer sized to the visible box scrolls away with the content:
    // the parts of the drawing that need scrolling to then take no pointer events at all, so rooms
    // could not be drawn there (reported from real use: "above 70% I can no longer draw").
    // The canvas box IS the scrollable content; rootEl is only the fallback.
    const canvas = rootEl.querySelector('canvas');
    const box = canvas && canvas.clientWidth ? canvas : rootEl;
    size = {
      w: Math.max(0, Math.round(box.clientWidth || 0)),
      h: Math.max(0, Math.round(box.clientHeight || 0)),
    };
    svg.setAttribute('width', String(size.w));
    svg.setAttribute('height', String(size.h));
    svg.setAttribute('viewBox', `0 0 ${size.w} ${size.h}`);
    render();
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
  function onPointerDown(e) {
    if (destroyed) return;
    // mouse only reacts to the primary button; touch/pen have button 0 too
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (mode === 'draw') {
      e.preventDefault?.();
      startDraft(e);
      return;
    }
    downAt = localPoint(e);
    try { svg.setPointerCapture(e.pointerId); captureId = e.pointerId; } catch { /* ignore */ }
  }

  function onPointerMove(e) {
    if (destroyed) return;
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
    if (mode === 'draw') { finishDraft(e); return; }
    const p = localPoint(e);
    releaseCapture(e);
    const wasClick = downAt
      && Math.abs(p.x - downAt.x) <= CLICK_SLOP_PX
      && Math.abs(p.y - downAt.y) <= CLICK_SLOP_PX;
    downAt = null;
    if (!wasClick) return;
    const vp = viewport();
    const room = vp
      ? roomAtPoint(safeCall(getRooms) || [], safeCall(getPage) ?? 1, viewPointToPdf(vp, p))
      : null;
    safeCall(onSelect, room || null);
    setHover(room || null);
  }

  function onPointerCancel(e) {
    if (destroyed) return;
    if (mode === 'draw') { cancelDraft(); return; }
    releaseCapture(e);
    downAt = null;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && draft) cancelDraft();
  }

  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerCancel);
  svg.addEventListener('pointerleave', () => { if (mode !== 'draw') setHover(null); });
  window.addEventListener('keydown', onKeyDown);

  /* --------------------------------------------------------------- public */
  function setMode(m) {
    mode = m === 'draw' ? 'draw' : 'select';
    svg.classList.toggle('is-draw', mode === 'draw');
    svg.classList.toggle('is-select', mode !== 'draw');
    cancelDraft();
    setHover(null);
    render();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener('keydown', onKeyDown);
    svg.removeEventListener('pointerdown', onPointerDown);
    svg.removeEventListener('pointermove', onPointerMove);
    svg.removeEventListener('pointerup', onPointerUp);
    svg.removeEventListener('pointercancel', onPointerCancel);
    releaseCapture();
    draft = null;
    downAt = null;
    if (svg.parentNode) svg.parentNode.removeChild(svg);
  }

  // initial state: mode class + a box that matches the canvas
  svg.classList.toggle('is-draw', mode === 'draw');
  svg.classList.toggle('is-select', mode !== 'draw');
  resize();

  return { render, setMode, resize, destroy, el: svg };
}

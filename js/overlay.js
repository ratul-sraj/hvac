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
 *     getDrawingId,    // () => string|null  identity of the drawing now loaded; a shape tagged with a
 *                      //   DIFFERENT drawing (room.polyDrawing / room.rectDrawing) is NOT painted —
 *                      //   see shapesOnPage(). null (no identity in play) filters nothing.
 *     getMode,         // () => 'draw' | 'select'
 *     onDraw,          // (rect, {page}) => void   rect = {x,y,w,h} PDF points; only when usable
 *     onDrawShape,     // (ring, {page}) => void   a hand-drawn polygon (PDF space); see DRAWN SHAPES
 *     onSelect,        // (room|null) => void      click in select mode
 *     onHover,         // (room|null) => void      optional; cursor/label feedback
 *     onRoomMoved,     // (id, rectPt) => void     LIVE: every pointermove of a move/resize drag
 *                      //   ...or (id, { id, poly, page, kind:'move'|'vertex' }) for a polygon room
 *     onRoomMoveEnd,   // (id, rectPt) => void     on release: the app persists here
 *                      //   ...or (id, { id, poly, page, kind:'move'|'vertex' }) for a polygon room
 *                      //      kind:'vertex' means a hand-edited ring (the AREA may have changed)
 *     onDelete,        // (id) => void             Delete/Backspace with a selection
 *   }) -> Overlay
 *
 *   Overlay: render() | setMode('draw'|'shape'|'select') | resize() | destroy() | el (the <svg>)
 *            hasDraft() -> boolean   true while a shape is being drawn (the app uses it to keep its
 *                                    own Escape handling away from an in-progress shape)
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
 *     (an <input>/<textarea>/<select> or contenteditable) and not on ANY form control inside a data
 *     table (a row checkbox, a row dropdown, the × button), so a table cell never loses a keystroke.
 *   • pan (BOTH modes): middle-button drag, or Space held + primary drag. Panning scrolls the
 *     scroll box (rootEl) itself and emits NO room callback and starts no draft.
 *   • Escape / pointercancel during a drag restores the rect the drag started from (one more
 *     onRoomMoved back to the original) and never fires onRoomMoveEnd.
 *
 *   class names added by Stage 2: plan-room-handle (+ is-nw/is-ne/is-se/is-sw) on the four corner
 *   grips of the selected room, is-dragging on a room during a move/resize, is-pan on the overlay
 *   while panning. Extra DOM: <g class="plan-handles"> inside the selected room's <g class="plan-room">.
 *
 * TRACED OUTLINES (room.poly) — see the helper block further down:
 *   • A room with a usable `room.poly` ring (PDF space, y up) whose `room.polyPage` (falling back to
 *     `room.rect.page`) is the current page draws as an SVG <polygon class="plan-room-box"> instead of
 *     a <rect>, inside the SAME <g class="plan-room"> with the SAME data-room-id, data-include, state
 *     classes and click/hover/include behaviour. Every point goes through pdfPointToView — the same
 *     adapter rectToViewBox uses — so zoom/pan//Rotate are unchanged.
 *   • The <g> carries data-shape="poly" (rectangles carry data-shape="rect") so tests and CSS can
 *     tell the two apart; the polygon path is `.plan-room[data-shape="poly"] .plan-room-box` in CSS.
 *   • Dragging an outline MOVES it: every ring point is translated by the same PDF delta and the shape
 *     is preserved exactly. onRoomMoved/onRoomMoveEnd report `{ id, poly, page }`.
 *   • Resize handles are ONLY for rect rooms. An outline has no box to drag; it is never converted to
 *     a rectangle.
 *
 * DRAWN SHAPES (mode 'shape' — a hand-drawn polygon with any number of edges):
 *   • In 'shape' mode a click ADDS a vertex to the in-progress ring; the last segment follows the
 *     cursor as a dashed preview and the live shoelace area is shown next to it. Clicking the first
 *     vertex (within SHAPE_CLOSE_PX), DOUBLE-CLICKING, or pressing Enter CLOSES the shape and fires
 *     onDrawShape(ring, {page}) — a ring in PDF space, the very space room.poly uses, so the app
 *     stores it exactly like a traced outline. Backspace removes the last vertex; Escape cancels the
 *     whole in-progress shape (and nothing else). Fewer than 3 vertices is not a shape.
 *   • A closed shape and a traced outline are the SAME kind of thing to the overlay (room.poly);
 *     the app marks a hand-drawn one with source:'drawn', which shows as data-source="drawn" on the
 *     <g class="plan-room"> so CSS can give it a distinct look (see css/style.css).
 *   • VERTEX EDITING (select mode) — a SELECTED polygon room shows a small square handle on every
 *     vertex and a small diamond on every edge midpoint. Drag a vertex handle to move that vertex;
 *     drag an edge midpoint to insert a vertex there and drag it. Holding Alt while releasing a
 *     dragged vertex ON ANOTHER EDGE removes that vertex (a vertex cannot be dropped on the two
 *     edges that already touch it). Alt is the documented gesture; it is not reserved by the system
 *     on Windows, where this app is used. Holding Alt is read from the releasing pointerup event, so
 *     no extra key state has to be tracked.
 *   • Vertex edits are reported through the SAME callbacks as a move: onRoomMoved(id, {id, poly,
 *     page, kind:'vertex'}) live and onRoomMoveEnd(...) on release, so the app owns the state exactly
 *     as it does for a translated ring. The overlay never re-derives an AREA — that is the app's job
 *     (js/trace.js's shoelace is imported here only to MEASURE a ring for the readout).
 *
 * PLACED LOCATORS (a rect room with `rect.placed === true`, from planview.isPlacedRoom):
 *   • A locator box is sized BACK from the room's stated area and is NOT a traced boundary. On a page
 *     with many of them (the 3-floor sample names 50+ rooms per page) full-area rectangles pile up and
 *     hide the drawing's own walls and labels, so past PLACED_MARKER_LIMIT placed shapes on a page each
 *     is drawn as a small fixed-size diamond at the room's `at` point instead — <polygon
 *     class="plan-room-box"> inside the SAME <g class="plan-room">, carrying data-shape="marker" and
 *     data-placed="true". A marker keeps every class/data attribute and the click/move/include
 *     behaviour of the rectangle (hit-testing is still geometric, on the PDF rect). A placed box drawn
 *     as a full rectangle carries data-placed="true" and data-shape="rect"; CSS draws it lighter and
 *     dashed so it reads as a locator, not a wall.
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
 *   .plan-overlay.is-shape   { cursor:crosshair; }
 *   .plan-overlay.is-select  { cursor:default; }
 *   .plan-room               { cursor:pointer; }
 *   .plan-room-box           { fill:rgba(56,132,255,.18); stroke:#2f6fed; stroke-width:1; }
 *   .plan-room.is-excluded .plan-room-box { fill:rgba(120,120,120,.14); stroke:#8a8a8a; }
 *   .plan-room.is-selected .plan-room-box { stroke:#ff8a00; stroke-width:2.5; }
 *   .plan-room.is-dragging { cursor:grabbing; }
 *   .plan-room-handle        { fill:#fff; stroke:#ff8a00; stroke-width:1.5; pointer-events:none; }
 *   .plan-vertex-handle      { fill:#fff; stroke:#ff8a00; stroke-width:1.5; pointer-events:none; }
 *   .plan-edge-handle        { fill:#ffd9a8; stroke:#ff8a00; stroke-width:1; pointer-events:none; }
 *   .plan-room[data-shape="poly"][data-source="drawn"] .plan-room-box { solid stroke + stronger fill }
 *   .plan-draft-ring         { fill:rgba(47,111,237,.12); stroke:#2f6fed; stroke-width:1.5;
 *                              stroke-dasharray:5 3; }
 *   .plan-draft-close        { stroke:#2f6fed; stroke-width:1; stroke-dasharray:3 3; fill:none; }
 *   .plan-vertex             { fill:#fff; stroke:#2f6fed; stroke-width:1.5; }
 *   .plan-vertex.is-first    { fill:#2f6fed; }
 *   .plan-vertex.is-close    { fill:#ff8a00; stroke:#ff8a00; }
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
  isDrawnRoom,         // has rect geometry? (parsed/scheduled rooms have none)
  rectContainsPoint,   // PDF point inside a PDF rect
  rectToViewBox,       // PDF rect -> SVG box in view pixels, rotation-safe
  pdfPointToView,      // PDF point -> view pixel (the SAME adapter rectToViewBox uses)
  viewPointToPdf,      // view pixel -> PDF point
  handleAtPoint,       // which corner grip a PDF point grabs (the ONLY grab test allowed)
  moveRect,            // PDF rect moved by a delta
  resizeRect,          // PDF rect with one corner dragged, opposite corner pinned
  clampRectToPage,     // keep a PDF rect on the sheet
  isPlacedRoom,        // a locator box (sized back from stated area), not a hand-drawn room
} from './planview.js';
// Pure, planner-owned tracing maths. polygonAreaPt2 is the shoelace area in square points — the very
// definition js/trace.js uses to accept a traced outline, so the overlay measures an outline the same
// way the tracer did. Importing it keeps a single definition of "area of a ring".
import { polygonAreaPt2 } from './trace.js';
// Pure ring maths for a hand-drawn SHAPE (area, simplicity, vertex/edge edits) — the same helpers
// js/app.js uses to give a drawn room its area and to refuse a nonsense shape. No DOM in that module,
// so it is unit-testable in plain Node (tests/test-polyshape.mjs).
import {
  polyAreaM2,
  ringMidpoint,
  ringVertexAt,
  ringMidpointAt,
  ringEdgeNotTouching,
  ringMoveVertex,
  ringInsertVertex,
  ringRemoveVertex,
} from './polyshape.js';

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
/** Placed LOCATOR boxes (isPlacedRoom): a page with this many of them (the 3-floor sample has 50+
 *  per page) draws them as small diamonds at the point that names each room instead of full-area
 *  rectangles, because 50 overlapping boxes hide the drawing's own walls and labels (UX review, item
 *  3). A page below the limit keeps real boxes — lighter and dashed, see css/style.css. */
const PLACED_MARKER_LIMIT = 40;
/** A placed box smaller than this on screen is unreadable anyway: a diamond reads better. */
const PLACED_MARKER_MIN_PX = 14;
/** Diamond radius in view pixels — fixed, so a marker stays the same clickable size at every zoom. */
const MARKER_PX = 9;
/** The FOCUS POINTER for a SELECTED room that has NO drawn boundary — a room read from a PDF label
 *  carries only `at`, the point the sheet names it, and no ring/rect. It is a pointer, not a
 *  measurement: a dashed ring (radius, view px) plus a crosshair arm length (view px). */
const FOCUS_RING_PX = 9;
const FOCUS_CROSS_PX = 13;

/* --- 'Draw shape' (a hand-drawn polygon) --------------------------------------------------------- */
/** Click within this many view pixels of the FIRST vertex closes the shape. */
const SHAPE_CLOSE_PX = 8;
/** A new vertex closer than this to the last one is ignored (this is also what makes a double-click
 *  add a single vertex, not two). */
const MIN_VERTEX_PX = 3;
/** Grab radius of a vertex / edge-midpoint handle, in view pixels (converted to PDF through the
 *  viewport, exactly like the rect corner grips). */
const VERTEX_PX = 9;
/** Drawn size of a vertex handle square and an edge-midpoint diamond, in view pixels. */
const VERTEX_DRAW_PX = 8;
const EDGE_DRAW_PX = 7;
/** A ring whose area is below this (square PDF points, ~2×2 pt) cannot be a room: refuse it. */
export const MIN_POLY_AREA_PT2 = 4;

/** Trim float dust and render a small, stable SVG number. */
function num(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return String(Math.round(v * 100) / 100);
}

/** The three interaction modes. Anything unrecognised is Select/edit (the safe default). */
function normalizeMode(m) {
  return (m === 'draw' || m === 'shape') ? m : 'select';
}

/* ---------------------------------------------------- traced outlines (room.poly)
 * A room may carry `room.poly`, a CLOSED ring of {x,y} points in PDF user space (y up, points) — the
 * same space `room.rect` uses. It is produced by js/trace.js and accepted only when the enclosed
 * region holds exactly one room label and its area matches the stated one (AGENTS.md). The overlay
 * DRAWS it (never invents it): a room with a usable ring on the current page renders as a polygon
 * path through the same viewport adapter the rectangles use, keeps every class/data/behaviour of a
 * rect room, and can be MOVED. It cannot be resized: an outline has no box to drag, and silently
 * replacing it with a rectangle would be a lie about the room's shape, so it gets no grips.
 * The overlay never writes state: a move reports the translated ring, exactly as it reports a moved
 * rectangle, and the app persists it. room.polyPage is the ring's page; room.polyArea/polyRatio are
 * verification fields the overlay never reads or touches.
 * ---------------------------------------------------------------------------------------------- */

/** The ring a room carries, or null. Points must be finite; fewer than 3 points is not a ring. */
function ringOfRoom(room) {
  if (!room || !Array.isArray(room.poly)) return null;
  const ring = room.poly.filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)));
  return ring.length >= 3 ? ring : null;
}

/** The page an outline belongs to: room.polyPage, falling back to the room's rect page. */
function polyPageOf(room) {
  const n = Number(room.polyPage);
  if (Number.isFinite(n)) return n;
  const r = Number(room && room.rect && room.rect.page);
  return Number.isFinite(r) ? r : null;
}

/** Deep-enough copy of a ring (plain {x,y} objects). */
function copyRing(ring) {
  return ring.map((p) => ({ x: p.x, y: p.y }));
}

/** Translate EVERY point of a ring by the same delta — the shape is preserved exactly. */
function translateRing(ring, dx, dy) {
  return ring.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** Even-odd ray cast: is a PDF-space point inside a closed ring? (Hit-testing only.) */
function pointInRing(ring, pt) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (((a.y > pt.y) !== (b.y > pt.y))
      && (pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x)) inside = !inside;
  }
  return inside;
}

/** PDF ring -> view-pixel points through the same pdfPointToView adapter the rect path uses. */
function ringToView(vp, ring) {
  return ring.map((p) => pdfPointToView(vp, p));
}

/* The polygon geometry (area, simplicity, vertex/edge edits) lives in js/polyshape.js — see the
 * import at the top of this file. Nothing here re-derives it. */

/** Bounding box of a list of view-pixel points, or null when empty. */
function viewBoxOfPoints(pts) {
  if (!pts || !pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The area of one render entry in square PDF points, for draw order and smallest-wins hit testing. */
function shapeAreaPt2(entry) {
  if (entry.ring) return polygonAreaPt2(entry.ring);
  const r = entry.room.rect;
  return Math.abs(r.w * r.h);
}

/** Does a shape tagged with `tag` belong to the drawing now loaded (`drawingId`)? A tag that was never
 *  recorded (a project saved before drawing identity existed) belongs to every drawing, so an upgrade
 *  never makes a user's shape vanish; with no drawing id in play (the overlay harness) nothing is
 *  filtered either. A recorded tag that differs is geometry measured on an EARLIER drawing: it must
 *  not be painted on the sheet now loaded. */
function belongsToDrawing(tag, drawingId) {
  if (tag == null || drawingId == null) return true;
  return String(tag) === String(drawingId);
}

/** Rooms of one page that can be drawn — outlines first-class, rectangles unchanged — biggest first
 *  so small rooms stay clickable and labels stay readable. THE single paint gate: a shape whose
 *  recorded drawing (room.polyDrawing / room.rectDrawing) is not the drawing now loaded is left out,
 *  so a previous drawing's outline or box is never painted on a new sheet. */
function shapesOnPage(rooms, page, drawingId) {
  const out = [];
  for (const room of rooms || []) {
    if (!room) continue;
    const ring = ringOfRoom(room);
    if (ring) {
      // A traced outline belongs to its own page. A ring whose page is elsewhere is not this page's.
      if (polyPageOf(room) === page && belongsToDrawing(room.polyDrawing, drawingId)) out.push({ room, ring });
      continue;
    }
    if (isDrawnRoom(room) && room.rect.page === page
        && belongsToDrawing(room.rectDrawing, drawingId)) out.push({ room, ring: null });
  }
  out.sort((a, b) => shapeAreaPt2(b) - shapeAreaPt2(a));
  return out;
}

/** Smallest drawn shape (outline or rectangle) under a PDF point on a page. This is planview's
 *  roomAtPoint extended to outlines: a click INSIDE a traced ring picks that room, and a click in
 *  the notch of an L-shaped room's bounding box does NOT. */
function roomAtPointShaped(rooms, page, pt) {
  let best = null;
  let bestArea = Infinity;
  for (const room of rooms || []) {
    if (!room) continue;
    const ring = ringOfRoom(room);
    if (ring) {
      if (polyPageOf(room) !== page || !pointInRing(ring, pt)) continue;
      const a = polygonAreaPt2(ring);
      if (a < bestArea) { bestArea = a; best = room; }
      continue;
    }
    if (!isDrawnRoom(room) || room.rect.page !== page) continue;
    if (!rectContainsPoint(room.rect, pt)) continue;
    const a = Math.abs(room.rect.w * room.rect.h);
    if (a < bestArea) { bestArea = a; best = room; }
  }
  return best;
}


export function createOverlay(rootEl, {
  getViewport = () => null,
  getRooms = () => [],
  getPage = () => 1,
  getSelectedId = () => null,
  getScaleDenom = () => 100,
  getDrawingId = () => null,
  getMode = () => 'select',
  onDraw = null,
  onDrawShape = null,
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
  let mode = normalizeMode(safeString(getMode));
  let size = { w: 0, h: 0 };
  // Active rubber band: PDF start/end points (y-up) + the last pointer position in view px.
  let draft = null;      // { page, startPdf, endPdf, cursorView }
  // Active 'shape' draft: the vertices already placed (PDF points) + the cursor in view pixels.
  let shapeDraft = null; // { page, pts:[{x,y}], cursorView:{x,y} }
  // Did the CURRENT shape-mode press begin the draft (no corners placed before it)? A plain click
  // that lands inside a room with geometry selects instead of drawing, but only when it is the FIRST
  // corner; a later corner of a shape already in progress must never be hijacked.
  let shapePressFresh = false;
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
  /** The selected room, but only when it is drawable on the current page (rect or traced outline). */
  function selectedRoom() {
    const id = safeCall(getSelectedId);
    if (id == null) return null;
    const page = safeCall(getPage) ?? 1;
    for (const room of safeCall(getRooms) || []) {
      if (!room || String(room.id) !== String(id)) continue;
      if (ringOfRoom(room)) { if (polyPageOf(room) === page) return room; continue; }
      if (isDrawnRoom(room) && room.rect.page === page) return room;
    }
    return null;
  }
  /** The grab radius of a corner handle, in PDF points: HANDLE_PX view pixels measured through the
   *  viewport's own scale, so the grip covers the same distance under the finger at every zoom.
   *  (pdf.js /Rotate is always a multiple of 90°, so a pixel offset maps to an axis-aligned PDF
   *  offset and one scalar tolerance is exact.) Falls back to matrix probing for a viewport with no
   *  numeric scale. */
  function handleTolPt(vp) {
    return tolPtFor(vp, HANDLE_PX);
  }
  /** A pixel grab radius (view px) as a distance in PDF points, through the viewport's own scale —
   *  so a vertex or edge grip covers the same distance under the finger at every zoom. Falls back to
   *  matrix probing for a viewport with no numeric scale. */
  function tolPtFor(vp, px) {
    const scale = Number(vp && vp.scale);
    if (Number.isFinite(scale) && scale > 0) return px / scale;
    const o = viewPointToPdf(vp, { x: 0, y: 0 });
    const qx = viewPointToPdf(vp, { x: px, y: 0 });
    const qy = viewPointToPdf(vp, { x: 0, y: px });
    const tol = Math.max(Math.abs(qx.x - o.x), Math.abs(qx.y - o.y),
      Math.abs(qy.x - o.x), Math.abs(qy.y - o.y));
    return tol > 0 ? tol : px;
  }
  /** Is the cursor (view px) within `px` of a PDF point on the current viewport? */
  function nearViewPoint(vp, pt, cursorView, px) {
    const v = pdfPointToView(vp, pt);
    const dx = v.x - cursorView.x, dy = v.y - cursorView.y;
    return (dx * dx + dy * dy) <= px * px;
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
  /** Is this element a control INSIDE a data table (the row's In checkbox, a dropdown, a sort header
   *  or the × button)? Delete/Backspace must never be stolen from a table cell: pressing Delete with
   *  the focus on a row checkbox used to remove the selected plan room with no warning (UX review,
   *  item 4). A text entry is covered by isTextEntry already; this adds the OTHER form controls.
   *  Deliberately scoped to tables: the plan panel's own controls (the mode radio, the toolbar
   *  buttons) are not in a table, and Delete must still reach the drawing from there — clicking a room
   *  does not blur them, so blocking every non-text control made Delete silently do nothing. */
  function isTableControl(el) {
    if (!el || el === document || typeof el.closest !== 'function') return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (!['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag)) return false;
    return !!el.closest('table');
  }
  function isSpaceKey(e) {
    return e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
  }
  function idOf(room) {
    return room && room.id != null ? room.id : null;
  }

  /* ---------------------------------------------------------- rendering */
  /** One room's <g class="plan-room">. `ring`, when given, is the traced outline in VIEW pixels and
   *  the shape is a <polygon>; otherwise the rect view `box` is drawn as a <rect>. Everything else —
   *  classes, data attributes, label, and whether grips are added — is identical for both, except
   *  that ONLY a rectangle gets the four resize grips (an outline has no box to resize). */
  function roomShape(room, box, ring, selected, dragging) {
    const g = document.createElementNS(SVG_NS, 'g');
    const excluded = room.include === false;
    const isPoly = !!ring;
    g.setAttribute('class',
      'plan-room' + (excluded ? ' is-excluded' : ' is-included')
      + (selected ? ' is-selected' : '') + (dragging ? ' is-dragging' : ''));
    g.setAttribute('data-room-id', room.id == null ? '' : String(room.id));
    g.setAttribute('data-include', excluded ? 'false' : 'true');
    // data-shape tells a traced outline from an ordinary rectangle (tests + CSS).
    g.setAttribute('data-shape', isPoly ? 'poly' : 'rect');
    // A HAND-DRAWN polygon is marked so CSS can give it a distinct look from a traced outline.
    if (isPoly && room.source === 'drawn') g.setAttribute('data-source', 'drawn');
    if (isPlacedRoom(room)) g.setAttribute('data-placed', 'true');
    if (selected) g.setAttribute('data-selected', 'true');

    const shape = document.createElementNS(SVG_NS, isPoly ? 'polygon' : 'rect');
    shape.setAttribute('class', 'plan-room-box');
    if (isPoly) {
      shape.setAttribute('points', ring.map((p) => `${num(p.x)},${num(p.y)}`).join(' '));
    } else {
      shape.setAttribute('x', num(box.x));
      shape.setAttribute('y', num(box.y));
      shape.setAttribute('width', num(box.w));
      shape.setAttribute('height', num(box.h));
    }
    shape.setAttribute('vector-effect', 'non-scaling-stroke');
    g.appendChild(shape);

    const label = roomLabel(room, box);
    if (label) g.appendChild(label);
    // The four corner grips, only on the selected RECTANGLE — the room the resize gesture can act on.
    // They are drawn from the SAME view box as the outline, and are presentational only: the grab
    // test is geometric (handleAtPoint on PDF points), never a hit on this DOM. An OUTLINE gets its
    // own VERTEX + EDGE-MIDPOINT grips instead (see polyHandleShape): it has no box to drag, and
    // silently turning it into a rectangle would be a lie about its shape.
    if (selected && !isPoly) g.appendChild(handleShape(box));
    else if (selected && isPoly) g.appendChild(polyHandleShape(ring));
    return g;
  }

  /** The vertex squares (+ edge-midpoint diamonds) of a SELECTED polygon room, as a
   *  <g class="plan-handles">. Presentational only: pointer-events:none, because the grab test is
   *  geometric (ringVertexAt / ringMidpointAt on PDF points), exactly like the rect corner grips. */
  function polyHandleShape(ringView) {
    const wrap = document.createElementNS(SVG_NS, 'g');
    wrap.setAttribute('class', 'plan-handles');
    const halfV = VERTEX_DRAW_PX / 2;
    const halfE = EDGE_DRAW_PX / 2;
    // edge midpoints first, so a vertex square always draws on top of a midpoint diamond
    for (let i = 0; i < ringView.length; i += 1) {
      const a = ringView[i], b = ringView[(i + 1) % ringView.length];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const d = document.createElementNS(SVG_NS, 'path');
      d.setAttribute('class', 'plan-edge-handle');
      d.setAttribute('d',
        `M ${num(mx)},${num(my - halfE)} L ${num(mx + halfE)},${num(my)} ` +
        `L ${num(mx)},${num(my + halfE)} L ${num(mx - halfE)},${num(my)} Z`);
      wrap.appendChild(d);
    }
    for (const p of ringView) {
      const h = document.createElementNS(SVG_NS, 'rect');
      h.setAttribute('class', 'plan-vertex-handle');
      h.setAttribute('x', num(p.x - halfV));
      h.setAttribute('y', num(p.y - halfV));
      h.setAttribute('width', num(VERTEX_DRAW_PX));
      h.setAttribute('height', num(VERTEX_DRAW_PX));
      wrap.appendChild(h);
    }
    return wrap;
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

  /** A PLACED locator whose page is crowded, drawn as a small fixed-size diamond at the room's own
   *  `at` point (the place the sheet names it) instead of a full-area rectangle people mistake for a
   *  real boundary. Same <g class="plan-room">, same data-room-id / include / selected state and the
   *  same click-to-open behaviour; the name is shown only when the room is selected, because the
   *  drawing's own text already names every room and 50 labels would clash. */
  function markerShape(room, pt, selected, dragging) {
    const g = document.createElementNS(SVG_NS, 'g');
    const excluded = room.include === false;
    g.setAttribute('class',
      'plan-room' + (excluded ? ' is-excluded' : ' is-included')
      + (selected ? ' is-selected' : '') + (dragging ? ' is-dragging' : ''));
    g.setAttribute('data-room-id', room.id == null ? '' : String(room.id));
    g.setAttribute('data-include', excluded ? 'false' : 'true');
    g.setAttribute('data-shape', 'marker');
    g.setAttribute('data-placed', 'true');
    if (selected) g.setAttribute('data-selected', 'true');

    const h = MARKER_PX;
    const poly = document.createElementNS(SVG_NS, 'polygon');
    poly.setAttribute('class', 'plan-room-box');
    poly.setAttribute('points',
      `${num(pt.x)},${num(pt.y - h)} ${num(pt.x + h)},${num(pt.y)} ${num(pt.x)},${num(pt.y + h)} ${num(pt.x - h)},${num(pt.y)}`);
    poly.setAttribute('vector-effect', 'non-scaling-stroke');
    g.appendChild(poly);

    const name = String(room.name == null ? '' : room.name).trim();
    if (selected && name) {
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('class', 'plan-room-label');
      t.setAttribute('x', num(pt.x));
      t.setAttribute('y', num(pt.y - h - 3));
      t.setAttribute('text-anchor', 'middle');
      t.textContent = name;
      g.appendChild(t);
    }
    return g;
  }

  /** The SELECTED room when it is NOT one the shapes loop drew: a room that carries a label position
   *  (`at`, PDF space, y up) on the CURRENT page — the case that needs the focus pointer because there
   *  is no ring or rect to outline. Null when the room is not on this page or has no usable `at`. */
  function focusRoomOnPage(rooms, selectedId, page) {
    for (const room of rooms || []) {
      if (!room || String(room.id) !== String(selectedId)) continue;
      const at = room.at;
      if (!at || !Number.isFinite(Number(at.x)) || !Number.isFinite(Number(at.y))) return null;
      // room.page, then at.page, defaulting to 1 — the same page rule the app stores the room on.
      const n = Number(room.page != null ? room.page : (at.page != null ? at.page : 1));
      return (Number.isFinite(n) ? n : 1) === page ? room : null;
    }
    return null;
  }

  /** The FOCUS POINTER <g class="plan-room plan-focus">: a dashed ring, a small crosshair and the room
   *  name, at `pt` (the view-pixel point the sheet names the room). Presentational only — CSS gives it
   *  pointer-events:none — so it is never a drawing target, and it is deliberately NOT part of
   *  shapesOnPage()/roomAtPointShaped(), so no existing shape or gesture is affected. Its shape reads
   *  as a pointer (a dashed ring + crosshair), not as a measured boundary. */
  function focusShape(room, pt, page) {
    const g = document.createElementNS(SVG_NS, 'g');
    const excluded = room.include === false;
    g.setAttribute('class', 'plan-room plan-focus' + (excluded ? ' is-excluded' : ' is-included'));
    g.setAttribute('data-shape', 'focus');
    g.setAttribute('data-room-id', room.id == null ? '' : String(room.id));
    g.setAttribute('data-page', String(page));
    g.setAttribute('data-selected', 'true');

    // A soft halo circle (pulses in CSS) behind the crisp dashed ring.
    const halo = document.createElementNS(SVG_NS, 'circle');
    halo.setAttribute('class', 'plan-focus-halo');
    halo.setAttribute('cx', num(pt.x));
    halo.setAttribute('cy', num(pt.y));
    halo.setAttribute('r', num(FOCUS_RING_PX));
    g.appendChild(halo);

    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('class', 'plan-focus-ring');
    ring.setAttribute('cx', num(pt.x));
    ring.setAttribute('cy', num(pt.y));
    ring.setAttribute('r', num(FOCUS_RING_PX));
    ring.setAttribute('vector-effect', 'non-scaling-stroke');
    g.appendChild(ring);

    const a = FOCUS_CROSS_PX;
    const cross = document.createElementNS(SVG_NS, 'path');
    cross.setAttribute('class', 'plan-focus-cross');
    cross.setAttribute('d',
      `M ${num(pt.x - a)},${num(pt.y)} L ${num(pt.x + a)},${num(pt.y)} ` +
      `M ${num(pt.x)},${num(pt.y - a)} L ${num(pt.x)},${num(pt.y + a)}`);
    cross.setAttribute('vector-effect', 'non-scaling-stroke');
    g.appendChild(cross);

    const name = String(room.name == null ? '' : room.name).trim();
    if (name) {
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('class', 'plan-room-label');
      t.setAttribute('x', num(pt.x));
      t.setAttribute('y', num(pt.y - FOCUS_RING_PX - 4));
      t.setAttribute('text-anchor', 'middle');
      t.textContent = name;
      g.appendChild(t);
    }
    return g;
  }

  /** The rubber band + the live size/area readout. Only drawn while a drag is in progress. */
  function renderDraft(vp) {
    draftG.replaceChildren();
    if (destroyed) return;
    if (shapeDraft) { renderShapeDraft(vp); return; }
    // A closed shape still waiting for the app's choice stays visible, so the user can see exactly what
    // they are assigning to a room.
    if (pendingRing && pendingRing.page === (safeCall(getPage) ?? 1)) renderPendingRing(vp);
    if (!draft) return;
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

  /** The in-progress 'Draw shape' polygon: the vertices placed so far, the segment that follows the
   *  cursor, a dashed line showing where clicking the first vertex would close the ring, the vertex
   *  squares, and the live shoelace area (computed through the SAME points→m² conversion the placed
   *  rectangles use, see polyAreaM2). */
  /** The closed ring awaiting the app's "which room is this?" choice. Dashed and slightly stronger than
   *  the live draft, so it reads as a finished boundary rather than something still being drawn. */
  function renderPendingRing(vp) {
    const view = pendingRing.ring.map((p) => pdfPointToView(vp, p));
    if (view.length < 3) return;
    const poly = document.createElementNS(SVG_NS, 'polygon');
    poly.setAttribute('class', 'plan-pending-ring');
    poly.setAttribute('points', view.map((p) => `${num(p.x)},${num(p.y)}`).join(' '));
    poly.setAttribute('vector-effect', 'non-scaling-stroke');
    draftG.appendChild(poly);
  }

  function renderShapeDraft(vp) {
    const pts = shapeDraft.pts;
    const cursor = shapeDraft.cursorView || null;
    const view = pts.map((p) => pdfPointToView(vp, p));
    const denom = Number(safeCall(getScaleDenom)) || 100;

    if (view.length >= 2) {
      const ring = cursor ? view.concat([cursor]) : view;
      const pl = document.createElementNS(SVG_NS, 'polyline');
      pl.setAttribute('class', 'plan-draft-ring');
      pl.setAttribute('points', ring.map((p) => `${num(p.x)},${num(p.y)}`).join(' '));
      pl.setAttribute('vector-effect', 'non-scaling-stroke');
      draftG.appendChild(pl);
    }
    if (view.length >= 3 && cursor) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'plan-draft-close');
      line.setAttribute('x1', num(cursor.x));
      line.setAttribute('y1', num(cursor.y));
      line.setAttribute('x2', num(view[0].x));
      line.setAttribute('y2', num(view[0].y));
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      draftG.appendChild(line);
    }
    const closeNow = view.length >= 3 && cursor
      && Math.hypot(view[0].x - cursor.x, view[0].y - cursor.y) <= SHAPE_CLOSE_PX + MIN_VERTEX_PX;
    view.forEach((p, i) => {
      const half = VERTEX_DRAW_PX / 2;
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('class', 'plan-vertex'
        + (i === 0 ? ' is-first' : '')
        + (i === 0 && closeNow ? ' is-close' : ''));
      r.setAttribute('x', num(p.x - half));
      r.setAttribute('y', num(p.y - half));
      r.setAttribute('width', num(VERTEX_DRAW_PX));
      r.setAttribute('height', num(VERTEX_DRAW_PX));
      r.setAttribute('vector-effect', 'non-scaling-stroke');
      draftG.appendChild(r);
    });

    if (view.length < 2) return;
    // live area: shoelace of the vertices placed so far (the segment still following the cursor is
    // NOT counted — it is not part of the shape until it is clicked in). Shown next to the cursor.
    const area = polyAreaM2(pts, denom);
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('class', 'plan-overlay-readout');
    t.setAttribute('text-anchor', 'start');
    t.setAttribute('data-vertices', String(pts.length));
    t.setAttribute('data-area-m2', num(area));
    t.setAttribute('data-close', closeNow ? 'true' : 'false');
    t.textContent = closeNow
      ? `click to close · ${area.toFixed(2)} m²`
      : `${pts.length} side(s) · close: click the first point · ${area.toFixed(2)} m²`;
    const cur = cursor || view[view.length - 1];
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
    const shapes = shapesOnPage(safeCall(getRooms) || [], page, safeCall(getDrawingId));
    const selectedId = safeCall(getSelectedId) ?? null;
    // How many PLACED locators share this page? Past the limit they pile up and hide the sheet, so
    // they are drawn as small diamonds (see markerShape).
    let placedOnPage = 0;
    for (const s of shapes) if (!s.ring && isPlacedRoom(s.room)) placedOnPage += 1;
    const crowded = placedOnPage >= PLACED_MARKER_LIMIT;

    let selectedDrawn = false;
    for (const { room, ring } of shapes) {
      if (selectedId != null && String(room.id) === String(selectedId)) selectedDrawn = true;
      const dragging = !!drag && drag.dragged && String(drag.id) === String(room.id);
      if (ring) {
        // A traced outline: every point through the SAME viewport adapter the rectangles use.
        const viewRing = ringToView(vp, ring);
        const box = viewBoxOfPoints(viewRing);
        if (!box || box.w <= 0 || box.h <= 0) continue;
        roomsG.appendChild(roomShape(room, box, viewRing, room.id === selectedId, dragging));
        continue;
      }
      const box = clampBox(rectToViewBox(vp, room.rect));
      if (box.w <= 0 || box.h <= 0) continue;        // wholly off-page: nothing visible to draw
      const placed = isPlacedRoom(room);
      if (placed && (crowded || Math.min(box.w, box.h) < PLACED_MARKER_MIN_PX)) {
        // the room's `at` point in view space == its (unclamped) box centre
        const full = rectToViewBox(vp, room.rect);
        roomsG.appendChild(markerShape(room, { x: full.x + full.w / 2, y: full.y + full.h / 2 },
          room.id === selectedId, dragging));
        continue;
      }
      roomsG.appendChild(roomShape(room, box, null, room.id === selectedId, dragging));
    }
    // A SELECTED room the loop above did NOT draw still gets marked: a room read from a PDF label
    // carries only `at` — the point that names it — and no ring or rect, so clicking its table row
    // used to draw nothing at all. The focus pointer shows WHERE the sheet names the room. It is a
    // pointer, not a boundary: clearly different from a real shape, pointer-events:none in CSS, and
    // never added to shapesOnPage()/roomAtPointShaped(), so every existing shape and gesture is
    // unchanged. A room the loop already drew is skipped (no double outline).
    if (selectedId != null && !selectedDrawn) {
      const focusRoom = focusRoomOnPage(safeCall(getRooms) || [], selectedId, page);
      if (focusRoom) roomsG.appendChild(focusShape(focusRoom, pdfPointToView(vp, focusRoom.at), page));
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

  /* ------------------------------------------------ 'Draw shape': a polygon with any number of edges
   * A click adds a vertex; the last segment follows the cursor with a dashed preview and a live area.
   * The shape closes on a click near the first vertex, a double-click, or Enter. Backspace removes the
   * last vertex; Escape throws the whole in-progress shape away. The overlay only measures the ring —
   * the APP decides whether it is a usable shape (simple, non-degenerate) and shows the refusal. */
  /** Add a vertex at a PDF point, unless it lands on the previous one (that is what makes a
   *  double-click add ONE vertex: its second pointerdown is within MIN_VERTEX_PX of the first). */
  function addShapeVertex(vp, pdf, view) {
    if (!shapeDraft) return false;
    const pts = shapeDraft.pts;
    const last = pts[pts.length - 1];
    if (last && nearViewPoint(vp, last, view, MIN_VERTEX_PX)) return false;
    // a click near the FIRST vertex (with 3+ already placed) CLOSES the shape
    if (pts.length >= 3 && nearViewPoint(vp, pts[0], view, SHAPE_CLOSE_PX)) {
      finishShape();
      return true;
    }
    pts.push({ x: pdf.x, y: pdf.y });
    shapeDraft.cursorView = view;
    return true;
  }

  function startShape(e) {
    const vp = viewport();
    if (!vp) return;
    const p = localPoint(e);
    const pdf = viewPointToPdf(vp, p);
    if (!shapeDraft) shapeDraft = { page: safeCall(getPage) ?? 1, pts: [], cursorView: p };
    addShapeVertex(vp, pdf, p);
    downAt = p;
    render();
  }

  function updateShapeCursor(e) {
    if (!shapeDraft) return;
    const vp = viewport();
    if (!vp) return;
    shapeDraft.cursorView = localPoint(e);
    render();
  }

  /** Commit the drawn ring: exactly one onDrawShape, and only when it has 3+ vertices. Usability
   *  (self-crossing / zero area) is the app's call — it owns the message the user sees. */
  function finishShape() {
    if (!shapeDraft) return;
    const ring = copyRing(shapeDraft.pts);
    const page = shapeDraft.page;
    shapeDraft = null;
    downAt = null;
    render();
    if (ring.length >= 3) safeCall(onDrawShape, ring, { page });
  }

  function cancelShape() {
    if (!shapeDraft) return;
    shapeDraft = null;
    shapePressFresh = false;
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

  /** Begin a move (handle=null) or a resize (handle='nw'|'ne'|'se'|'sw') of one room. A traced
   *  outline or a drawn polygon is snapshotted as its ring; a rectangle as its rect. The two never
   *  mix. `extra.poly` overrides the snapshot (the edge-midpoint gesture inserts a vertex first) and
   *  `extra.vertex` marks a VERTEX edit: every move then moves exactly that one ring point. */
  function startDrag(e, kind, room, handle, p, pdf, extra = null) {
    e.preventDefault?.();   // dragging a box must not start a text selection / browser drag
    const ring = extra && extra.poly ? extra.poly : ringOfRoom(room);
    drag = {
      kind,
      id: idOf(room),
      handle: handle || null,
      vertex: extra && Number.isInteger(extra.vertex) ? extra.vertex : null,
      startRect: room.rect ? { ...room.rect } : null,
      startPoly: ring ? copyRing(ring) : null,
      startPdf: { ...pdf },
      startView: p,
      lastRect: room.rect ? { ...room.rect } : null,
      lastPoly: ring ? copyRing(ring) : null,
      page: polyPageOf(room) ?? (safeCall(getPage) ?? 1),
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

  /** The payload this drag reports for a traced outline or hand-drawn polygon: the ring, with the
   *  ONE dragged vertex moved when this is a vertex edit, or TRANSLATED by the pointer's PDF delta
   *  when it is a move — every point by the SAME delta, so the shape (and its area) is preserved
   *  exactly. No clamp is applied — a clamp would break the one-delta rule — and the page rides along
   *  so the app can store the ring against its page, exactly as a rect carries `page`. `kind` tells
   *  the app whether the AREA may have changed (a vertex edit) or cannot have (a move). */
  function dragPoly(pdf) {
    const poly = drag.vertex != null
      ? ringMoveVertex(drag.startPoly, drag.vertex, pdf)
      : translateRing(drag.startPoly, pdf.x - drag.startPdf.x, pdf.y - drag.startPdf.y);
    return {
      id: drag.id,
      poly,
      page: drag.page,
      kind: drag.vertex != null ? 'vertex' : 'move',
    };
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
    const pdf = viewPointToPdf(vp, p);
    if (drag.startPoly) {
      // a traced outline: report the translated ring live, exactly as a rect room reports its rect
      const payload = dragPoly(pdf);
      drag.lastPoly = payload.poly;
      safeCall(onRoomMoved, drag.id, payload);
    } else {
      const rect = dragRect(pdf, vp);
      drag.lastRect = rect;
      safeCall(onRoomMoved, drag.id, rect);   // live: every pointermove, no persistence here
    }
    render();
  }

  /** Abandon a drag: put the app's geometry back, and never fire onRoomMoveEnd. */
  function cancelDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    downAt = null;
    releaseCapture();
    if (d.dragged) {
      safeCall(onRoomMoved, d.id,
        d.startPoly ? { id: d.id, poly: d.startPoly, page: d.page } : { ...d.startRect });
    }
    render();
  }

  function onPointerDown(e) {
    if (destroyed) return;
    if (isPanStart(e)) { startPan(e); return; }
    // mouse only reacts to the primary button; touch/pen have button 0 too
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (mode === 'shape') {
      e.preventDefault?.();
      const wasDrawing = !!(shapeDraft && shapeDraft.pts.length);
      startShape(e);
      shapePressFresh = !wasDrawing;
      return;
    }
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
    // 1. a corner of the SELECTED RECTANGLE → resize. The grab test is planview.handleAtPoint() with
    //    the pixel radius converted to PDF points through the viewport; never re-derived here.
    //    A traced OUTLINE never resizes: it has no corner box, so it is skipped entirely and a
    //    pointerdown on it falls through to a MOVE.
    const selected = selectedRoom();
    const handle = selected && !ringOfRoom(selected)
      ? handleAtPoint(selected.rect, pdf, handleTolPt(vp)) : null;
    if (handle) { startDrag(e, 'resize', selected, handle, p, pdf); return; }
    // 1b. a VERTEX or EDGE-MIDPOINT grip of the SELECTED polygon room → edit the ring. Vertices win
    //     over midpoints (they are checked first), so a grip is grabbed exactly as it is aimed at.
    const selRing = selected ? ringOfRoom(selected) : null;
    if (selRing) {
      const tolV = tolPtFor(vp, VERTEX_PX);
      const vi = ringVertexAt(selRing, pdf, tolV);
      if (vi >= 0) { startDrag(e, 'vertex', selected, null, p, pdf, { vertex: vi }); return; }
      const ei = ringMidpointAt(selRing, pdf, tolV);
      if (ei >= 0) {
        // insert a vertex at that edge's midpoint, then drag the new point: the ring the drag reports
        // already carries the new vertex, so even a bare click-drag leaves it in place.
        const base = ringInsertVertex(selRing, ei, ringMidpoint(selRing, ei));
        startDrag(e, 'vertex', selected, null, p, pdf, { vertex: ei + 1, poly: base });
        return;
      }
    }
    // 2. the body of any drawn room or traced outline → move. The grabbed target decides once, so a
    //    body drag can never resize and vice versa.
    const room = roomAtPointShaped(safeCall(getRooms) || [], safeCall(getPage) ?? 1, pdf);
    if (room) { startDrag(e, 'move', room, null, p, pdf); return; }
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
    setHover(roomAtPointShaped(safeCall(getRooms) || [], safeCall(getPage) ?? 1, viewPointToPdf(vp, localPoint(e))));
  }

  function onPointerUp(e) {
    if (destroyed) return;
    if (pan) { endPan(e); return; }
    const p = localPoint(e);
    const vp = viewport();
    const roomUnder = () => (vp
      ? roomAtPointShaped(safeCall(getRooms) || [], safeCall(getPage) ?? 1, viewPointToPdf(vp, p))
      : null);

    if (drag) {
      const d = drag;
      drag = null;
      downAt = null;
      releaseCapture(e);
      const room = roomUnder();
      if (d.dragged) {
        // a real drag: report the final geometry for persistence, never a selection change. A rect
        // reports its rect; a polygon room reports its NEW ring (with the page) so the app stores it.
        if (d.startPoly) {
          let poly = d.lastPoly;
          let kind = d.vertex != null ? 'vertex' : 'move';
          // Alt + drop a dragged vertex ON ANOTHER EDGE removes that vertex (merging two edges into
          // one). Only a NON-adjacent edge counts — a vertex always lies on its own two edges. Never
          // let the ring fall below 3 points.
          if (d.vertex != null && vp && e && e.altKey && d.startPoly.length > 3) {
            const pdf = viewPointToPdf(vp, p);
            const ei = ringEdgeNotTouching(d.startPoly, d.vertex, pdf, tolPtFor(vp, VERTEX_PX));
            if (ei >= 0) { poly = ringRemoveVertex(d.lastPoly, d.vertex); kind = 'vertex'; }
          }
          safeCall(onRoomMoveEnd, d.id, { id: d.id, poly, page: d.page, kind });
        } else {
          safeCall(onRoomMoveEnd, d.id, d.lastRect);
        }
      } else {
        // no movement beyond the slop: it was a click — exactly the Stage-1 behaviour
        safeCall(onSelect, room || null);
      }
      setHover(room || null);
      render();
      return;
    }

    if (mode === 'shape') {
      // A plain click (no drag) that lands INSIDE an existing room selects it instead of starting a
      // many-corner shape — the same click-to-select Select/edit has, and what makes the room's
      // Delete reachable from the default Draw shape mode. Only a FRESH press (this click began the
      // draft, no corners were placed before it) that finds a room with geometry qualifies: a click
      // that adds a corner to a shape already in progress is left alone, and a click on empty sheet
      // still starts a shape. A drawing gesture's first corner is a click with no movement, so the
      // "inside an existing room" test — not the movement alone — is what tells the two apart.
      const wasClick = !!downAt
        && Math.abs(p.x - downAt.x) <= CLICK_SLOP_PX
        && Math.abs(p.y - downAt.y) <= CLICK_SLOP_PX;
      const fresh = shapePressFresh;
      shapePressFresh = false;
      if (wasClick && fresh) {
        const room = roomUnder();
        if (room) {
          cancelShape();                 // never leave a stray 1-vertex draft behind
          safeCall(onSelect, room);
          setHover(room);
          return;
        }
      }
      downAt = null;
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

  /** A DOUBLE-CLICK closes the in-progress shape — the other half of "click the first point". The
   *  second pointerdown of the double-click is within MIN_VERTEX_PX of the first, so it added no
   *  extra vertex (see addShapeVertex); here the ring is simply committed. */
  function onDoubleClick(e) {
    if (destroyed) return;
    if (mode !== 'shape' || !shapeDraft) return;
    if (shapeDraft.pts.length >= 3) {
      e.preventDefault?.();
      finishShape();
    }
  }

  function onKeyDown(e) {
    if (destroyed) return;
    if (e.key === 'Escape') {
      if (shapeDraft) cancelShape();       // an in-progress shape is the innermost thing to cancel
      else if (drag) cancelDrag();
      else if (draft) cancelDraft();
      return;
    }
    // While a shape is being drawn the keyboard belongs to the SHAPE: Enter closes it, Backspace
    // takes back the last vertex. Never steal either from a text field.
    if (shapeDraft && !isTextEntry(document.activeElement) && !isTextEntry(e.target)) {
      if (e.key === 'Enter') {
        e.preventDefault?.();
        if (shapeDraft.pts.length >= 3) finishShape();
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault?.();               // Backspace must not act as "go back"
        if (shapeDraft.pts.length) shapeDraft.pts.pop();
        render();
        return;
      }
    }
    if (isSpaceKey(e)) {
      // Space is the pan modifier. Never steal it from a text field.
      if (!isTextEntry(document.activeElement)) spaceHeld = true;
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    // NEVER steal Delete from a text field or a contenteditable cell... nor from any control inside a
    // data table (the row's In checkbox, its dropdowns, the × button) — the guide promises the
    // keystroke is ignored while the focus is in a table cell.
    if (isTextEntry(document.activeElement) || isTextEntry(e.target)) return;
    if (isTableControl(document.activeElement) || isTableControl(e.target)) return;
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
  svg.addEventListener('dblclick', onDoubleClick);
  svg.addEventListener('pointerleave', () => { if (mode !== 'draw' && mode !== 'shape' && !drag && !pan) setHover(null); });
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
    mode = normalizeMode(m);
    svg.classList.toggle('is-draw', mode === 'draw');
    svg.classList.toggle('is-shape', mode === 'shape');
    svg.classList.toggle('is-select', mode === 'select');
    cancelDrag();
    cancelDraft();
    cancelShape();
    setHover(null);
    render();
  }

  /** A CLOSED shape the app is asking about ("This shape is room:"). The draft is gone by then, so
   *  without this the user chooses a room while the shape they just drew has vanished from the screen -
   *  they cannot check what they are assigning. Kept by the app, drawn by the overlay. */
  let pendingRing = null;   // { ring:[{x,y}], page } | null

  /** Is a 'Draw shape' polygon being drawn right now? The app checks this so its own Escape handling
   *  (close the report / the room breakdown) never fights the in-progress shape. */
  function hasDraft() {
    return !!shapeDraft;
  }

  /** Show a closed shape the app is asking about, or take it off the screen. */
  function setPendingRing(ring, page) {
    pendingRing = (Array.isArray(ring) && ring.length >= 3)
      ? { ring: ring.map((p) => ({ x: p.x, y: p.y })), page: page != null ? page : (safeCall(getPage) ?? 1) }
      : null;
    render();
  }

  function clearPendingRing() {
    if (!pendingRing) return;
    pendingRing = null;
    render();
  }

  /** How many corners the in-progress shape has (0 when none). The app shows this as a live count:
   *  without it a click that lands on the plan looks like it did nothing at all, and a user who cannot
   *  see the shape taking form falls back to dragging rectangles. */
  function draftCount() {
    return shapeDraft ? shapeDraft.pts.length : 0;
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
    svg.removeEventListener('dblclick', onDoubleClick);
    svg.removeEventListener('mousedown', onMouseDown);
    releaseCapture();
    draft = null;
    shapeDraft = null;
    drag = null;
    pan = null;
    spaceHeld = false;
    downAt = null;
    svg.classList.remove('is-pan');
    if (svg.parentNode) svg.parentNode.removeChild(svg);
  }

  // initial state: mode class + a box that matches the canvas
  svg.classList.toggle('is-draw', mode === 'draw');
  svg.classList.toggle('is-shape', mode === 'shape');
  svg.classList.toggle('is-select', mode === 'select');
  resize();

  return {
    render, setMode, resize, destroy, hasDraft, draftCount, el: svg,
    setPendingRing, clearPendingRing,
  };
}

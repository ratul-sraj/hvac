/**
 * planview.js — geometry for drawing rooms directly on the plan.
 *
 * PLANNER-OWNED. Pure functions only: no DOM, no pdf.js import, no state. Everything here is
 * testable in plain Node (tests/test-planview.mjs) and is the single source of truth for two
 * things the UI must not reimplement:
 *
 *   1. Where a rectangle IS, in PDF user space (points, origin bottom-left, y grows upward).
 *   2. How many square METRES it represents on the real building, which depends on the drawing
 *      scale (1:100 etc.) and is therefore something the user must supply or confirm.
 *
 * A room that was drawn on the plan carries:
 *   rect:  { page, x, y, w, h }   // PDF points, y-up; w/h always positive
 *   scaleDenom: 100               // the drawing scale it was measured at (1:100)
 *   source: 'manual'
 * and an ordinary `area` in m² so every existing consumer (table, calc, CSV) needs no change.
 *
 * Screen coordinates are NOT stored anywhere. The overlay converts to view pixels on every
 * render via the pdf.js viewport's own matrices, so zoom, pan and /Rotate can never corrupt the
 * model — see pdfPointToView()/viewPointToPdf() below for the one adapter that touches pdf.js.
 */

/** PDF user space is 1/72 inch. */
export const PT_PER_INCH = 72;
/** Metres per inch (exact). */
export const M_PER_INCH = 0.0254;
/** Square inches per square metre (exact: 1/0.0254²). */
export const SQIN_PER_SQM = 1 / (M_PER_INCH * M_PER_INCH);

/** Drawing scales offered in the UI. `denom` is the N in 1:N. */
export const DRAWING_SCALES = [
  { denom: 20, label: '1:20' },
  { denom: 50, label: '1:50' },
  { denom: 100, label: '1:100' },
  { denom: 200, label: '1:200' },
  { denom: 500, label: '1:500' },
];
export const DEFAULT_SCALE_DENOM = 100;

/** A drag shorter than this (PDF points) is a stray click, not a room: ~1 mm of paper. */
export const MIN_RECT_PT = 3;

/** Normalise two drag corners (any order) into {x, y, w, h} with positive w/h. */
export function normalizeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** True when the rectangle is big enough to be meant as a room. */
export function rectIsUsable(rect, min = MIN_RECT_PT) {
  return !!rect && rect.w >= min && rect.h >= min;
}

/**
 * Real-world area of a PDF-space rectangle, in m², for a drawing at scale 1:denom.
 * A length of `p` points on the paper is (p/72) inches of paper, which represents
 * (p/72)×denom inches of building.
 */
export function areaFromRect(rect, denom = DEFAULT_SCALE_DENOM) {
  if (!rect) return 0;
  const wIn = (rect.w / PT_PER_INCH) * denom;
  const hIn = (rect.h / PT_PER_INCH) * denom;
  return (wIn * hIn) / SQIN_PER_SQM;
}

/** The two side lengths of a PDF-space rectangle in real metres, for a drawing scale. */
export function dimsFromRect(rect, denom = DEFAULT_SCALE_DENOM) {
  if (!rect) return { length: 0, width: 0 };
  const a = ((rect.w / PT_PER_INCH) * denom) * M_PER_INCH;
  const b = ((rect.h / PT_PER_INCH) * denom) * M_PER_INCH;
  // length = the longer side, so a rotated box still reads the same way round
  return a >= b ? { length: a, width: b } : { length: b, width: a };
}

/** Clamp a rectangle so it stays inside a page of `pageSize` = {width, height} points. */
export function clampRectToPage(rect, pageSize) {
  if (!rect || !pageSize) return rect;
  const w = Math.min(rect.w, pageSize.width);
  const h = Math.min(rect.h, pageSize.height);
  const x = Math.max(0, Math.min(rect.x, pageSize.width - w));
  const y = Math.max(0, Math.min(rect.y, pageSize.height - h));
  return { ...rect, x, y, w, h };
}

/** Centre of a rectangle. */
export function rectCenter(rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** Is a PDF-space point inside a rectangle (inclusive)? */
export function rectContainsPoint(rect, pt) {
  return !!rect && pt.x >= rect.x && pt.x <= rect.x + rect.w && pt.y >= rect.y && pt.y <= rect.y + rect.h;
}

/** Move a rectangle by a delta (PDF points). */
export function moveRect(rect, dx, dy) {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

export const RESIZE_HANDLES = ['nw', 'ne', 'se', 'sw'];

/**
 * Resize by dragging one corner to `pt`, keeping the opposite corner pinned and the rectangle
 * positive. Returns a new rect; never mutates.
 */
export function resizeRect(rect, handle, pt, min = MIN_RECT_PT) {
  const right = rect.x + rect.w;
  const top = rect.y + rect.h;
  let x1 = rect.x, y1 = rect.y, x2 = right, y2 = top;
  if (handle === 'nw' || handle === 'sw') x1 = pt.x; else x2 = pt.x;
  if (handle === 'nw' || handle === 'ne') y2 = pt.y; else y1 = pt.y;
  let out = normalizeRect({ x: x1, y: y1 }, { x: x2, y: y2 });
  if (out.w < min) out = { ...out, w: min };
  if (out.h < min) out = { ...out, h: min };
  return out;
}

/** The four draggable corner positions of a rect, in PDF space. */
export function handlePoints(rect) {
  return {
    nw: { x: rect.x, y: rect.y + rect.h },
    ne: { x: rect.x + rect.w, y: rect.y + rect.h },
    se: { x: rect.x + rect.w, y: rect.y },
    sw: { x: rect.x, y: rect.y },
  };
}

/**
 * Which corner handle of `rect`, if any, a PDF-space point is grabbing — 'nw'|'ne'|'se'|'sw', or null
 * for "not on a handle", which is the caller's cue to MOVE the box instead of resizing it.
 * `tolPt` is the grab radius in PDF points: the overlay derives it from a pixel radius through the
 * viewport, so a handle covers the same distance under the finger at every zoom.
 * Grab areas are square and checked nearest-first, so overlapping areas resolve to the corner the
 * user aimed at rather than to whichever corner happened to be listed first.
 */
export function handleAtPoint(rect, pt, tolPt) {
  if (!rect || !pt) return null;
  const tol = Number.isFinite(tolPt) && tolPt > 0 ? tolPt : 0;
  const handles = handlePoints(rect);
  let best = null;
  let bestD = Infinity;
  for (const name of RESIZE_HANDLES) {
    const h = handles[name];
    const d = Math.max(Math.abs(h.x - pt.x), Math.abs(h.y - pt.y));
    if (d <= tol && d < bestD) { bestD = d; best = name; }
  }
  return best;
}

/**
 * Which room, if any, sits under a PDF-space point on a given page.
 * Smallest-area match wins, so a box drawn inside a big one stays clickable.
 * Skips rooms with no rect (parsed/scheduled rooms have no geometry) and other pages.
 */
export function roomAtPoint(rooms, page, pt) {
  let best = null;
  let bestArea = Infinity;
  for (const room of rooms || []) {
    if (!room || !room.rect || room.rect.page !== page) continue;
    if (!rectContainsPoint(room.rect, pt)) continue;
    const a = room.rect.w * room.rect.h;
    if (a < bestArea) { bestArea = a; best = room; }
  }
  return best;
}

/** Rooms on one page that carry geometry, in draw order (biggest first, so labels stay readable). */
export function roomsOnPage(rooms, page) {
  return (rooms || [])
    .filter((r) => r && r.rect && r.rect.page === page)
    .sort((a, b) => (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h));
}

/**
 * A PLACED region for a room that has no drawn geometry: a rectangle centred on the point where the
 * plan names the room, sized from the room's OWN area at the drawing scale.
 *
 * This is a locator, not a traced boundary. The plan's text layer says "CONFERENCE ROOM 24.5 M2" at a
 * point on the sheet; it says nothing about where the walls are. So the box is sized BACK from the
 * area the table already carries — which is why placing rooms can never change the load: the area is
 * the input here, not the output. Move or resize a placed box by hand and it becomes a hand-drawn one
 * (the app re-reads its area from the rectangle instead).
 *
 * `at` is PDF user space (points, y up) — the same space a room's `rect` uses.
 * Pass `length`/`width` (metres) to keep a known room's proportions; otherwise it is a square.
 */
export function rectFromLabel(at, areaM2, denom = DEFAULT_SCALE_DENOM, { length, width } = {}) {
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  const a = Number(areaM2);
  if (!Number.isFinite(a) || a <= 0) return null;
  const mPerPt = ((Number(denom) || DEFAULT_SCALE_DENOM) * M_PER_INCH) / PT_PER_INCH;
  if (!(mPerPt > 0)) return null;
  const l = Number(length), w = Number(width);
  let sideXm, sideYm;
  if (Number.isFinite(l) && Number.isFinite(w) && l > 0 && w > 0) {
    sideXm = Math.max(l, w);
    sideYm = Math.min(l, w);
  } else {
    sideXm = Math.sqrt(a);
    sideYm = sideXm;
  }
  const wPt = sideXm / mPerPt;
  const hPt = sideYm / mPerPt;
  return {
    x: round2(at.x - wPt / 2),
    y: round2(at.y - hPt / 2),
    w: round2(wPt),
    h: round2(hPt),
    placed: true,
  };
}

/** Does this room carry a placed (label-derived) region? */
export function isPlacedRoom(room) {
  return !!(room && room.rect && room.rect.placed === true);
}

/**
 * Build a Room from a drawn rectangle. The returned object satisfies the shared Room contract in
 * AGENTS.md, so addRooms()/calcProject()/the table accept it unchanged.
 * `name` is left for the caller to fill or ask for.
 */
export function roomFromRect(rect, { id, name, level, page, denom = DEFAULT_SCALE_DENOM, include = true, orient } = {}) {
  const dims = dimsFromRect(rect, denom);
  const room = {
    id,
    name: name || '',
    level: level || '',
    area: round2(areaFromRect(rect, denom)),
    length: round2(dims.length),
    width: round2(dims.width),
    scaleDenom: denom,
    rect: { page: page ?? rect.page ?? 1, x: round2(rect.x), y: round2(rect.y), w: round2(rect.w), h: round2(rect.h) },
    source: 'manual',
    include: include !== false,
  };
  if (orient) room.orient = orient;
  return room;
}

/** Round to 2 decimals without float dust (0.1+0.2 style). */
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Does this room carry drawn geometry (as opposed to parsed text or a schedule row)? */
export function isDrawnRoom(room) {
  return !!(room && room.rect && typeof room.rect.x === 'number');
}

/* ------------------------------------------------------------------ *
 * The only pdf.js-aware part: viewport adapters.
 *
 * A pdf.js PageViewport exposes convertToViewportPoint(x, y) and convertToPdfPoint(x, y), which
 * already account for scale, offset and /Rotate — so we use them instead of hand-rolled matrix
 * maths. Tests pass a tiny fake viewport with the same two methods.
 * View points are CSS pixels from the canvas' top-left, y growing DOWN.
 * ------------------------------------------------------------------ */

/** PDF point (y-up) -> view pixel (y-down). */
export function pdfPointToView(viewport, pt) {
  if (!viewport || typeof viewport.convertToViewportPoint !== 'function') return { x: 0, y: 0 };
  const [x, y] = viewport.convertToViewportPoint(pt.x, pt.y);
  return { x, y };
}

/** View pixel (y-down) -> PDF point (y-up). */
export function viewPointToPdf(viewport, pt) {
  if (!viewport || typeof viewport.convertToPdfPoint !== 'function') return { x: 0, y: 0 };
  const [x, y] = viewport.convertToPdfPoint(pt.x, pt.y);
  return { x, y };
}

/**
 * A PDF-space rectangle as an SVG-ready view rectangle {x, y, w, h} in CSS pixels.
 * Converts all four corners and re-normalises, which is what makes rotated pages work.
 */
export function rectToViewBox(viewport, rect) {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ].map((p) => pdfPointToView(viewport, p));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

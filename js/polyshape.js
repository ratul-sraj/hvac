/**
 * polyshape.js — pure geometry for a hand-drawn room SHAPE (a polygon with any number of edges).
 *
 * No DOM, no canvas, no pdf.js, no state: this file is importable in plain Node (see
 * tests/test-polyshape.mjs) and is the ONE place the ring maths lives. It does not re-invent any
 * conversion — the area of a ring is js/trace.js's own shoelace (polygonAreaPt2, the very definition
 * the tracer accepts an outline with) converted to m² through planview's areaFromRect, i.e. the SAME
 * points→metres scale conversion a placed rectangle uses.
 *
 * PDF user space: points, origin bottom-left, y grows upward — the same space `room.rect` and
 * `room.poly` use, so nothing here ever sees a screen pixel.
 *
 * The 'Draw shape' tool (js/overlay.js) uses these to render/edit a ring; js/app.js uses
 * polyAreaM2()/polygonIsSimple() to give a drawn room its area and to refuse a nonsense shape.
 */

import { polygonAreaPt2 } from './trace.js';
import { areaFromRect } from './planview.js';

/** A ring whose area is below this (square PDF points, ~2×2 pt of paper) cannot be a room: refuse it. */
export const MIN_POLY_AREA_PT2 = 4;

/**
 * Real-world area (m²) of a PDF-space ring at drawing scale 1:denom.
 * areaFromRect({0,0,1,1}, denom) is the m² one square point covers — a 1×1 pt square at 1:N is
 * (denom/72 × 0.0254) m on a side, so its area is that squared — and a shoelace area in square
 * points just multiplies by it. The rectangle conversion is reused, never re-derived.
 */
export function polyAreaM2(ring, denom = 100) {
  const m2PerPt2 = areaFromRect({ x: 0, y: 0, w: 1, h: 1 }, denom);
  return Math.abs(polygonAreaPt2(Array.isArray(ring) ? ring : [])) * m2PerPt2;
}

/** The ring's area in square PDF points (the shoelace, absolute value). */
export function polyAreaPt2(ring) {
  return Math.abs(polygonAreaPt2(Array.isArray(ring) ? ring : []));
}

/** Twice the signed area of triangle abc (the cross product used by the segment test). */
function orient2(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Do two closed segments properly cross? (Touching endpoints do not count — adjacent edges share one.) */
function segmentsCross(a, b, c, d) {
  const o1 = orient2(a, b, c), o2 = orient2(a, b, d);
  const o3 = orient2(c, d, a), o4 = orient2(c, d, b);
  return ((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0));
}

/**
 * Is the ring a simple (non-self-intersecting) polygon? O(n²) over the edges, skipping the two edges
 * that share an endpoint with each one. A ring with fewer than 3 finite points is NOT usable.
 */
export function polygonIsSimple(ring) {
  const pts = Array.isArray(ring) ? ring : [];
  if (pts.length < 3) return false;
  for (const p of pts) {
    if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return false;
  }
  const n = pts.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if ((i + 1) % n === j || (j + 1) % n === i) continue; // edges sharing a vertex never count
      if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** Could this ring be a room? 3+ vertices, simple, and more than a speck of area. */
export function ringIsUsable(ring, denom = 100) {
  const pts = Array.isArray(ring) ? ring : [];
  if (pts.length < 3) return false;
  if (polyAreaPt2(pts) <= MIN_POLY_AREA_PT2) return false;
  return polygonIsSimple(pts);
}

/** Squared distance between two PDF points. */
function dist2(a, b) {
  const dx = Number(a.x) - Number(b.x), dy = Number(a.y) - Number(b.y);
  return dx * dx + dy * dy;
}

/** Squared distance from point p to segment ab. */
function pointSegDist2(a, b, p) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0) return dist2(a, p);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist2({ x: a.x + t * dx, y: a.y + t * dy }, p);
}

/** Midpoint of ring edge i (from vertex i to vertex i+1). */
export function ringMidpoint(ring, i) {
  const n = ring.length;
  const a = ring[((i % n) + n) % n], b = ring[(((i + 1) % n) + n) % n];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Index of the ring vertex within `tolPt` of a PDF point (nearest wins), or -1. */
export function ringVertexAt(ring, pt, tolPt) {
  const pts = Array.isArray(ring) ? ring : [];
  const tol2 = tolPt * tolPt;
  let best = -1, bestD = tol2;
  pts.forEach((p, i) => { const d = dist2(p, pt); if (d <= bestD) { bestD = d; best = i; } });
  return best;
}

/** Index of the edge whose MIDPOINT is within `tolPt` of a PDF point (nearest wins), or -1. */
export function ringMidpointAt(ring, pt, tolPt) {
  const pts = Array.isArray(ring) ? ring : [];
  const tol2 = tolPt * tolPt;
  let best = -1, bestD = tol2;
  for (let i = 0; i < pts.length; i += 1) {
    const d = dist2(ringMidpoint(pts, i), pt);
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Index of an edge within `tolPt` of a PDF point that does NOT touch vertex `vi` (so dropping a
 *  vertex there merges it onto a NON-adjacent edge), or -1. */
export function ringEdgeNotTouching(ring, vi, pt, tolPt) {
  const pts = Array.isArray(ring) ? ring : [];
  const n = pts.length;
  const tol2 = tolPt * tolPt;
  for (let i = 0; i < n; i += 1) {
    if (i === vi || (i + 1) % n === vi) continue;
    if (pointSegDist2(pts[i], pts[(i + 1) % n], pt) <= tol2) return i;
  }
  return -1;
}

/** A copy of the ring with vertex `i` moved to `pt`. */
export function ringMoveVertex(ring, i, pt) {
  return ring.map((p, k) => (k === i ? { x: pt.x, y: pt.y } : { x: p.x, y: p.y }));
}

/** A copy of the ring with `pt` inserted as a new vertex after edge `edgeIndex`. */
export function ringInsertVertex(ring, edgeIndex, pt) {
  const out = ring.map((p) => ({ x: p.x, y: p.y }));
  const at = Math.max(0, Math.min(out.length, edgeIndex + 1));
  out.splice(at, 0, { x: pt.x, y: pt.y });
  return out;
}

/** A copy of the ring with vertex `i` removed. */
export function ringRemoveVertex(ring, i) {
  return ring.filter((_, k) => k !== i).map((p) => ({ x: p.x, y: p.y }));
}

/** The bounding box of a ring in PDF space: {x, y, w, h} (positive w/h), or null. */
export function ringBBox(ring) {
  const pts = Array.isArray(ring) ? ring : [];
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Round to 2 decimals without float dust, for the ring points the app stores. */
export function roundRing(ring) {
  return ring.map((p) => ({ x: Math.round((p.x + Number.EPSILON) * 100) / 100,
    y: Math.round((p.y + Number.EPSILON) * 100) / 100 }));
}

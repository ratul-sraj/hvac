/**
 * js/autotrace.js — give named rooms an area from the plan's OWN traced outlines, but ONLY when
 * the match is unambiguous, and say plainly why every other room was left alone.
 *
 * WHY THIS EXISTS
 * A sheet that prints room NAMES but no areas parses into rooms with `area: null` (see
 * js/pdfparse.js) — honest, but not useful until those rooms have areas. js/trace.js already turns
 * the plan's vector linework into enclosed regions and refuses to invent a shape it cannot trust.
 * This module takes those regions plus the named rooms and fills in an area ONLY where a single
 * room name sits inside a single closed region of a sane size. A wrong area is worse than no area,
 * so every ambiguous case is skipped and every skip carries a stable CODE and a plain-English
 * sentence. Stairwells are never conditioned (the owner's rule) and are never assigned or included.
 *
 * CONTRACT
 * - Pure: no DOM, no canvas, no pdf.js, no imports. Everything is testable in Node.
 * - Deterministic: the same inputs give byte-identical JSON. Input order is the output order; no
 *   randomness; the assignment decision uses no floating-point tolerance beyond the area band.
 * - Never mutates its inputs: it returns assignments to apply, it does not write them.
 *
 * INPUT SHAPES (matched to what js/trace.js really produces, not invented)
 *   rooms   [{ id, name, at:{x,y}, area, areaUnknown, include }]  — js/pdfparse.js output. `at` is
 *           the label position in PDF user space (y up, points), the same space region rings use.
 *   regions [{ id, rings, areaM2?, closed?, cells? }]  — one traced enclosed area. `rings` is what
 *           js/trace.js outlineFromRegion() returns: an array of closed rings in PDF space, the
 *           outer boundary plus any holes. A region may instead carry `polygon` (one ring).
 *           `areaM2` is the region's real area; when absent it is computed from the rings with
 *           `options.m2PerSquareUnit`. `closed` defaults to true (a flood-filled trace region is
 *           closed by construction); pass false for an outline that leaked.
 *   options { minAreaM2, maxAreaM2, m2PerSquareUnit, eps }
 *
 * m2PerSquareUnit: square PDF points -> square metres. It is the same factor the app already uses
 * for a traced region: metresPerPt(denom)² = ((0.0254 * denom) / 72)² (see js/trace.js pt2ToM2 and
 * js/planview.js areaFromRect). At the app default 1:100 it is 0.001244522, i.e. one traced region
 * of 100 pt² is 0.1245 m². The probe states the denom it used and where it came from.
 *
 * ASSIGNMENT RULE — a room gets a region's area only when ALL of these hold:
 *   1. the region is closed;
 *   2. exactly ONE room name lies inside it (holes are honoured — a name in a courtyard does not
 *      count as inside);
 *   3. that room has no area yet and is not a stairwell;
 *   4. the region's area is within the sane band (default 2 m² .. 2000 m²);
 *   5. the name is strictly inside, not exactly on the outline (a name on a wall line is ambiguous);
 *   6. the region does not overlap another region that is also being assigned.
 */

// ---------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------

/** A region below this (m²) is a pocket between strokes, not a room. */
export const MIN_AREA_M2 = 2;
/** A region above this (m²) is an open area or a leak, not a single room. */
export const MAX_AREA_M2 = 2000;

/** Stairwells are never conditioned (the owner's rule): never assigned, never included. */
export const STAIR_RE = /\bstair(?:s|well|case|way)?\b/i;

/** How close to an outline a name counts as sitting ON it (PDF points). */
export const ON_EDGE_EPS = 1e-6;

// ---------------------------------------------------------------------------------------------
// Fixed, documented reason set
// ---------------------------------------------------------------------------------------------
// Codes are stable machine values; the UI counts by code and renders the label. Every room and
// every region that is not assigned carries exactly one of these.
export const CODES = {
  // rooms
  noPosition: 'no-position',
  noOutline: 'no-outline',
  shared: 'shared',
  open: 'open',
  badArea: 'bad-area',
  overlap: 'overlap',
  already: 'already',
  stairwell: 'stairwell',
  onEdge: 'on-edge',
  // regions
  unused: 'unused',
};

/** Short labels for a status line, keyed by code. */
export const REASON_LABEL = {
  'no-position': 'no position on the sheet',
  'no-outline': 'no outline contains the name',
  'shared': 'several names in one outline',
  'open': 'outline is not closed',
  'bad-area': 'outline area looks wrong',
  'overlap': 'outline overlaps another',
  'already': 'already had an area',
  'stairwell': 'stairwell - never conditioned',
  'on-edge': 'name sits on the outline',
  'unused': 'no name inside the outline',
};

/** Plain-English sentence for a skip. `detail` carries the numbers a person needs. */
function reasonText(code, detail) {
  switch (code) {
    case 'no-position': return 'the plan gives no position for this name';
    case 'no-outline': return 'no traced outline contains this name';
    case 'shared': return `this outline contains ${detail} room names - assign by hand`;
    case 'open': return 'outline is not closed';
    case 'bad-area': return `outline area looks wrong (${detail} m2)`;
    case 'overlap': return 'this outline overlaps another traced outline - assign by hand';
    case 'already': return 'this room already had an area';
    case 'stairwell': return 'stairwell - never conditioned';
    case 'on-edge': return 'its name sits on the outline - assign by hand';
    case 'unused': return 'no room name inside this outline';
    default: return 'the outline could not be verified';
  }
}

/** True when a room name is a stair / stairwell / exit-stair: never conditioned. */
export function isStairwellName(name) {
  return STAIR_RE.test(String(name == null ? '' : name));
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/** Shoelace area of one ring (absolute), in whatever unit the coordinates are. */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Even-odd point-in-polygon for one ring. */
function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is (px,py) within eps of any edge of this ring? (A name printed on a wall line.) */
function pointOnRing(px, py, ring, eps) {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j].x, ay = ring[j].y, bx = ring[i].x, by = ring[i].y;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    if (Math.hypot(px - qx, py - qy) <= eps) return true;
  }
  return false;
}

/** Normalise a region's rings (accepts `rings` or a single `polygon`). */
export function regionRings(region) {
  if (!region) return [];
  if (Array.isArray(region.rings) && region.rings.length) return region.rings;
  if (Array.isArray(region.polygon) && region.polygon.length) return [region.polygon];
  return [];
}

/**
 * Where is a point relative to a region?
 * @returns {'in'|'out'|'edge'} 'edge' means it sits on (within eps of) any ring — a real ambiguity
 *   that must never be guessed. Holes are honoured via the even-odd rule, so a point in a courtyard
 *   (inside the outer ring, inside a hole) comes back 'out'.
 */
export function pointInRegion(px, py, rings, eps = ON_EDGE_EPS) {
  if (!Array.isArray(rings) || !rings.length) return 'out';
  for (const r of rings) if (r && r.length >= 2 && pointOnRing(px, py, r, eps)) return 'edge';
  let inside = false;
  for (const r of rings) if (r && r.length >= 3 && pointInRing(px, py, r)) inside = !inside;
  return inside ? 'in' : 'out';
}

/** Bounding box of a ring set: {x0,y0,x1,y1} or null. */
export function ringsBBox(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
  for (const r of rings || []) {
    for (const p of r || []) {
      any = true;
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
  }
  return any ? { x0, y0, x1, y1 } : null;
}

function orient(ax, ay, bx, by, cx, cy) {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** A point strictly inside a ring set (holes honoured), never merely on the boundary. */
function strictlyInside(px, py, rings) {
  return pointInRegion(px, py, rings) === 'in';
}

/** Centroid of the first ring — used to catch two IDENTICAL regions (no vertex is strictly inside). */
function firstRingCentroid(rings) {
  const r = rings && rings.find((ring) => ring && ring.length >= 3);
  if (!r) return null;
  let x = 0, y = 0;
  for (const p of r) { x += p.x; y += p.y; }
  return { x: x / r.length, y: y / r.length };
}

/**
 * Do two ring sets share a POSITIVE area? Touching along an edge (two adjacent rooms) is NOT
 * overlap — only a real interior crossing, a vertex strictly inside the other, or identical
 * centroids count. Conservative in the safe direction: when in doubt it says they overlap, which
 * makes the caller skip rather than guess.
 */
export function ringsOverlap(aRings, bRings) {
  const a = ringsBBox(aRings), b = ringsBBox(bRings);
  if (!a || !b) return false;
  if (a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0) return false;
  // A proper edge crossing (interiors on opposite sides of both edges) == shared area.
  for (const ra of aRings) {
    for (let i = 0; i < ra.length; i += 1) {
      const p1 = ra[i], p2 = ra[(i + 1) % ra.length];
      for (const rb of bRings) {
        for (let j = 0; j < rb.length; j += 1) {
          const p3 = rb[j], p4 = rb[(j + 1) % rb.length];
          const o1 = orient(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
          const o2 = orient(p1.x, p1.y, p2.x, p2.y, p4.x, p4.y);
          const o3 = orient(p3.x, p3.y, p4.x, p4.y, p1.x, p1.y);
          const o4 = orient(p3.x, p3.y, p4.x, p4.y, p2.x, p2.y);
          if (o1 * o2 < 0 && o3 * o4 < 0) return true;
        }
      }
    }
  }
  // One wholly inside the other: a vertex (or centroid, for identical rings) strictly inside.
  for (const rb of bRings) for (const p of rb) if (rb.length >= 3 && strictlyInside(p.x, p.y, aRings)) return true;
  for (const ra of aRings) for (const p of ra) if (ra.length >= 3 && strictlyInside(p.x, p.y, bRings)) return true;
  const ca = firstRingCentroid(aRings), cb = firstRingCentroid(bRings);
  if (ca && strictlyInside(ca.x, ca.y, bRings)) return true;
  if (cb && strictlyInside(cb.x, cb.y, aRings)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------------

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Match traced regions to named rooms, conservatively.
 * @param {object} p
 * @param {Array} p.rooms
 * @param {Array} p.regions
 * @param {object} [p.options]
 * @returns {{assignments:Array, skipped:Array, stats:object}}
 */
export function matchRoomsToRegions(p = {}) {
  const rooms = Array.isArray(p.rooms) ? p.rooms : [];
  const regions = Array.isArray(p.regions) ? p.regions : [];
  const o = p.options || {};
  const minArea = Number.isFinite(o.minAreaM2) ? o.minAreaM2 : MIN_AREA_M2;
  const maxArea = Number.isFinite(o.maxAreaM2) ? o.maxAreaM2 : MAX_AREA_M2;
  const eps = Number.isFinite(o.eps) ? o.eps : ON_EDGE_EPS;
  const m2PerUnit = Number.isFinite(o.m2PerSquareUnit) ? o.m2PerSquareUnit : null;

  // ---- per-room facts -------------------------------------------------------------------
  const roomInfo = rooms.map((r, i) => {
    const at = r && r.at;
    const hasPos = !!(at && Number.isFinite(at.x) && Number.isFinite(at.y));
    const area = Number(r && r.area);
    const hasArea = Number.isFinite(area) && area > 0;
    return {
      i, room: r, id: r && r.id != null ? r.id : i, name: (r && r.name) || '',
      hasPos, hasArea,
      stair: isStairwellName(r && r.name),
    };
  });

  // ---- per-region geometry --------------------------------------------------------------
  const regionInfo = regions.map((r, i) => {
    const rings = regionRings(r);
    const closed = !(r && r.closed === false);
    let areaM2 = r && Number.isFinite(r.areaM2) ? r.areaM2 : null;
    if (areaM2 == null && m2PerUnit != null) {
      const pt2 = rings.reduce((s, ring) => s + ringArea(ring), 0);
      areaM2 = pt2 * m2PerUnit;
    }
    return { i, region: r, id: r && r.id != null ? r.id : i, rings, closed, areaM2, members: [] };
  });

  // ---- which names sit in which region --------------------------------------------------
  for (const g of regionInfo) {
    if (!g.rings.length) continue;
    for (const info of roomInfo) {
      if (!info.hasPos) continue;
      const where = pointInRegion(info.room.at.x, info.room.at.y, g.rings, eps);
      if (where !== 'out') g.members.push({ info, where });
    }
  }

  // ---- first pass: is a region a candidate at all? --------------------------------------
  const status = new Array(regionInfo.length).fill(null);
  for (let gi = 0; gi < regionInfo.length; gi += 1) {
    const g = regionInfo[gi];
    const detailArea = g.areaM2 == null ? '?' : round2(g.areaM2);
    if (!g.closed) { status[gi] = { code: CODES.open }; continue; }
    if (g.areaM2 == null || g.areaM2 < minArea || g.areaM2 > maxArea) {
      status[gi] = { code: CODES.badArea, detail: detailArea };
      continue;
    }
    if (g.members.length === 0) { status[gi] = { code: CODES.unused }; continue; }
    if (g.members.length > 1) { status[gi] = { code: CODES.shared, detail: g.members.length }; continue; }
    const m = g.members[0];
    if (m.info.stair) { status[gi] = { code: CODES.stairwell }; continue; }
    if (m.info.hasArea) { status[gi] = { code: CODES.already }; continue; }
    if (m.where === 'edge') { status[gi] = { code: CODES.onEdge }; continue; }
    status[gi] = { code: null, candidate: true, room: m.info };   // otherwise valid
  }

  // ---- overlap: two otherwise-valid regions that overlap are both refused -----------------
  const candidates = regionInfo.map((g, i) => (status[i].candidate ? i : -1)).filter((i) => i >= 0);
  const overlapFlag = new Set();
  for (let a = 0; a < candidates.length; a += 1) {
    for (let b = a + 1; b < candidates.length; b += 1) {
      const ga = regionInfo[candidates[a]], gb = regionInfo[candidates[b]];
      if (ringsOverlap(ga.rings, gb.rings)) { overlapFlag.add(candidates[a]); overlapFlag.add(candidates[b]); }
    }
  }
  for (const gi of overlapFlag) status[gi] = { code: CODES.overlap };

  // ---- finalise: assignments + skipped --------------------------------------------------
  const assignments = [];
  const assignedRoom = new Set();
  const skipped = [];
  const roomReason = new Map();     // room index -> { code, detail }
  const regionReason = new Map();   // region index -> { code, detail }

  for (let gi = 0; gi < regionInfo.length; gi += 1) {
    const st = status[gi];
    if (st.candidate) {
      const info = st.room;
      assignedRoom.add(info.i);
      assignments.push({ roomId: info.id, regionId: regionInfo[gi].id, name: info.name, areaM2: round2(regionInfo[gi].areaM2) });
      continue;
    }
    regionReason.set(gi, { code: st.code, detail: st.detail });
  }

  // A room not assigned gets a reason from the regions that contain it, most-ambiguous first.
  const ROOM_PRIORITY = [CODES.shared, CODES.overlap, CODES.open, CODES.badArea, CODES.onEdge, CODES.stairwell, CODES.already, CODES.unused];
  for (const info of roomInfo) {
    if (assignedRoom.has(info.i)) continue;
    if (info.stair) { roomReason.set(info.i, { code: CODES.stairwell }); continue; }
    if (info.hasArea) { roomReason.set(info.i, { code: CODES.already }); continue; }
    if (!info.hasPos) { roomReason.set(info.i, { code: CODES.noPosition }); continue; }
    let chosen = null;
    for (let gi = 0; gi < regionInfo.length; gi += 1) {
      const g = regionInfo[gi];
      if (!g.members.some((m) => m.info.i === info.i)) continue;
      const st = status[gi];
      const code = st.candidate ? null : st.code;
      if (!code) continue;
      const rank = ROOM_PRIORITY.indexOf(code);
      if (!chosen || rank < chosen.rank) chosen = { code, detail: st.detail, rank };
    }
    roomReason.set(info.i, chosen ? { code: chosen.code, detail: chosen.detail } : { code: CODES.noOutline });
  }

  // ---- stable, input-ordered output -----------------------------------------------------
  for (const info of roomInfo) {
    if (assignedRoom.has(info.i)) continue;
    const rr = roomReason.get(info.i) || { code: CODES.noOutline };
    skipped.push({ kind: 'room', id: info.id, name: info.name, code: rr.code,
      reason: reasonText(rr.code, rr.detail), detail: rr.detail });
  }
  for (let gi = 0; gi < regionInfo.length; gi += 1) {
    if (status[gi].candidate) continue;
    const rr = regionReason.get(gi) || { code: CODES.unused };
    skipped.push({ kind: 'region', id: regionInfo[gi].id, code: rr.code,
      reason: reasonText(rr.code, rr.detail), detail: rr.detail });
  }

  // ---- stats: counts by reason, so a UI can say "auto-filled N; M need attention" --------
  const roomReasons = {};
  for (const info of roomInfo) {
    if (assignedRoom.has(info.i)) continue;
    const rr = roomReason.get(info.i) || { code: CODES.noOutline };
    roomReasons[rr.code] = (roomReasons[rr.code] || 0) + 1;
  }
  const regionReasons = {};
  for (let gi = 0; gi < regionInfo.length; gi += 1) {
    if (status[gi].candidate) continue;
    const rr = regionReason.get(gi) || { code: CODES.unused };
    regionReasons[rr.code] = (regionReasons[rr.code] || 0) + 1;
  }

  const stats = {
    rooms: roomInfo.length,
    regions: regionInfo.length,
    assignedRooms: assignedRoom.size,
    assignedRegions: assignments.length,
    needAttention: roomInfo.length - assignedRoom.size,
    unusedRegions: regionInfo.length - assignments.length,
    roomReasons,
    regionReasons,
    reasonLabels: REASON_LABEL,
    minAreaM2: minArea,
    maxAreaM2: maxArea,
  };

  return { assignments, skipped, stats };
}

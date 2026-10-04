/**
 * js/splitregion.js — split ONE traced region that contains SEVERAL room names into one sub-region
 * per name, by a SEEDED WATERSHED on the distance transform, and hand back only the sub-regions
 * whose boundary really is on the drawing.
 *
 * WHY THIS EXISTS
 * A flood fill on the rasterised wall lines (js/trace.js traceRegions / extractRegions / regionAt)
 * returns one region per connected pocket of free space. In an open-plan floor the rooms are joined
 * through doorways and openings, so one pocket can contain several room names and
 * js/autotrace.js matchRoomsToRegions — correctly — refuses to guess which area belongs to which
 * name. Closing the gaps (morphClose, closeGaps) only bridges openings up to ~2*radius px and does
 * NOT help once the openings are wider than a door (measured on the real LEVEL 11 sheet: the free
 * space stays one component until closeGaps ~ 10).
 *
 * THE METHOD (the standard room-segmentation method for robot maps)
 *  1. Inside one region's cell set, compute the DISTANCE TRANSFORM: each cell's distance to the
 *     nearest wall or non-region cell (a BFS is exact for the 4-connected grid used here).
 *  2. Seed one label per room name that lies inside the region. The seed is the cell under the
 *     name's `at` point; if that cell is a wall or outside the region, the nearest region cell.
 *  3. Grow all seeds together with a priority flood, highest distance first — the watershed of the
 *     NEGATED distance. Cells reached by two labels become the cut. Because the flood grows from
 *     the room centres (high distance) outwards, the boundaries settle on the narrow necks
 *     (doorways and normal openings), not in the middle of a room.
 *  4. NECK SAFETY TEST — a wrong area is worse than a blank. A sub-region is ACCEPTED only when
 *     (a) EVERY cut it shares with a sibling is at most NECK_MAX_M metres long (doors and normal
 *     openings are under 1 m; see the measured note on NECK_MAX_M), (b) its area is inside the sane
 *     band (2 m² .. 2000 m²), and (c) it is not a stairwell. Anything else is refused, so the caller
 *     can say "open to the next space" instead of inventing a boundary that is not on the drawing.
 *
 * CONTRACT
 * - Pure: no DOM, no canvas, no pdf.js. Deterministic: the same input gives byte-identical output.
 *   Ties in the priority flood are broken by cell order, so there is no floating-point drift and no
 *   randomness. Inputs are never mutated.
 * - The only import is the geometry it must share with the tracer (rings, areas, cell<->point), so
 *   a sub-region's area is measured exactly the way js/trace.js measures a whole region.
 * - Coordinates are PDF user space (y up, points), the same space room.at and region rings use.
 */

import {
  outlineFromRegion, outlineAreaPt2, pt2ToM2, metresPerPt, pointToCell, cellToPoint,
} from './trace.js';
import { isStairwellName } from './autotrace.js';

// ---------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------

/** A cut longer than this (metres) is a WIDE opening, not a door: the boundary is not on the
 *  drawing, so the sub-region is refused. Doors and normal internal openings are under 1 m; the
 *  MEASURED default is 1.0 m, not the 2.0 m the method starts from, because on the ground-truth
 *  fixture (tests/samples/sample-plan.pdf, 159 rooms with printed areas) 1.5 m and above admit a
 *  false fill: a bare room tag sitting in OPEN floor gets a 2 m-wide watershed cut and is filled
 *  62% too large, whereas 1.0 m refuses it (WRONG stays at the baseline 0). See
 *  tests/qa/split-accuracy.mjs. Raise it only against a sheet where you can check the result. */
export const NECK_MAX_M = 1.0;
/** A sub-region below this (m²) is a pocket / a furniture label, not a room. */
export const SPLIT_MIN_AREA_M2 = 2;
/** A sub-region above this (m²) is an open area or a leak, not a single room. */
export const SPLIT_MAX_AREA_M2 = 2000;

/** The stable code a caller reports for a sub-region refused by the neck safety test. */
export const OPEN_PLAN_CODE = 'open-plan';
/** The plain-English sentence that goes with it. */
export const OPEN_PLAN_REASON =
  'This room is open to the next space along a wide edge, so its boundary is not on the drawing. Draw its shape.';

/** The stable code for a sub-region refused because a NAMELESS space (a hall, a wardrobe strip, a
 *  corridor) hangs off it through a door-sized neck, so the part cannot be trimmed to one room. */
export const UNNAMED_SPACE_CODE = 'unnamed-space';
/** The plain-English sentence that goes with it. */
export const UNNAMED_SPACE_REASON =
  'This room is joined through a doorway to a space with no name, so its boundary cannot be told from the drawing. Draw its shape.';

const STAIR_RE = /\bstair(?:s|well|case|way)?\b/i;   // mirrors js/autotrace.js STAIR_RE
const isStair = (name) => STAIR_RE.test(String(name == null ? '' : name));

// ---------------------------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------------------------

/** The 4-neighbours of a raster cell that lie on the page. */
function neighbors(c, w, h) {
  const x = c % w;
  const out = [];
  if (x > 0) out.push(c - 1);
  if (x < w - 1) out.push(c + 1);
  if (c >= w) out.push(c - w);
  if (c < w * (h - 1)) out.push(c + w);
  return out;
}

/**
 * A binary max-heap over local cell indices ordered by (distance DESC, index ASC). The index
 * tie-break is what makes the flood deterministic: two cells at the same distance are always
 * processed in raster order, so the same input gives the same labels every time.
 */
function makeHeap(dist) {
  const H = [];
  const before = (a, b) => (dist[a] > dist[b] || (dist[a] === dist[b] && a < b));
  return {
    get size() { return H.length; },
    push(v) {
      H.push(v);
      let i = H.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!before(H[i], H[p])) break;
        const t = H[p]; H[p] = H[i]; H[i] = t; i = p;
      }
    },
    pop() {
      const top = H[0];
      const last = H.pop();
      if (H.length) {
        H[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < H.length && before(H[l], H[m])) m = l;
          if (r < H.length && before(H[r], H[m])) m = r;
          if (m === i) break;
          const t = H[m]; H[m] = H[i]; H[i] = t; i = m;
        }
      }
      return top;
    },
  };
}

/** Bounding box of a list of global cell indices. */
function cellsBBox(cells, w) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cells) {
    const x = c % w, y = (c - x) / w;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * 4-connected components of a set of global cells. Deterministic: components come back in the order
 * their first cell appears in `cellList`, and a component's cells in DFS order.
 */
function cellComponents(cellList, w, h) {
  const set = new Set(cellList);
  const seen = new Set();
  const comps = [];
  for (const c of cellList) {
    if (seen.has(c)) continue;
    seen.add(c);
    const comp = [];
    const stack = [c];
    while (stack.length) {
      const u = stack.pop();
      comp.push(u);
      for (const g of neighbors(u, w, h)) if (set.has(g) && !seen.has(g)) { seen.add(g); stack.push(g); }
    }
    comps.push(comp);
  }
  return comps;
}

/** Multi-source BFS over a part: label every cell with the index of the nearest core component. */
function nearestCore(cellList, comps, w, h) {
  const set = new Set(cellList);
  const owner = new Map();
  const q = [];
  for (let ci = 0; ci < comps.length; ci += 1) for (const g of comps[ci]) if (!owner.has(g)) { owner.set(g, ci); q.push(g); }
  let head = 0;
  while (head < q.length) {
    const u = q[head]; head += 1; const cu = owner.get(u);
    for (const g of neighbors(u, w, h)) if (set.has(g) && !owner.has(g)) { owner.set(g, cu); q.push(g); }
  }
  return owner;
}

/** Geodesic dilation: every part cell within `r` 4-connected steps of some `startCells` cell. */
function geodesicDilate(startCells, inPart, r, w, h) {
  const out = new Set(startCells);
  let frontier = startCells.slice();
  for (let step = 0; step < r && frontier.length; step += 1) {
    const next = [];
    for (const u of frontier) for (const g of neighbors(u, w, h)) {
      if (inPart.has(g) && !out.has(g)) { out.add(g); next.push(g); }
    }
    frontier = next;
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------
// The split
// ---------------------------------------------------------------------------------------------

/**
 * Split one region's cells into one sub-region per seed room.
 *
 * @param {object} p
 * @param {number[]} p.cells   global raster cell indices of the region (js/trace.js regionAt.cells)
 * @param {number} p.w         raster width
 * @param {number} p.h         raster height
 * @param {{x0,y0,x1,y1}} p.box  page box in PDF space (same as traceRegions)
 * @param {number} p.pxPerPt   raster resolution
 * @param {number} p.denom     drawing scale denominator (100 for 1:100)
 * @param {Array<{id:any,name:string,at:{x:number,y:number}}>} p.rooms  rooms whose names are inside
 * @param {number} [p.neckMaxM]      max acceptable cut length in metres (default NECK_MAX_M)
 * @param {number} [p.minAreaM2]     default SPLIT_MIN_AREA_M2
 * @param {number} [p.maxAreaM2]     default SPLIT_MAX_AREA_M2
 * @returns {{parts:Array, seeds:number, cellSizeM:number}|null} `parts` is one entry per seed room,
 *   in room order, each { label, roomId, name, cells, bbox, rings, areaPt2, areaM2, accepted,
 *   code, reason, cuts }. Returns null when there is nothing to split (fewer than two usable seeds).
 *   The whole result is deterministic: same input -> byte-identical JSON.
 */
export function splitRegion(p) {
  const cells = Array.isArray(p && p.cells) ? p.cells : [];
  const w = p && p.w, h = p && p.h, box = p && p.box;
  const pxPerPt = (p && p.pxPerPt) || 2;
  const denom = (p && p.denom) || 100;
  const rooms = (p && p.rooms) || [];
  const neckMaxM = Number.isFinite(p && p.neckMaxM) ? p.neckMaxM : NECK_MAX_M;
  const minArea = Number.isFinite(p && p.minAreaM2) ? p.minAreaM2 : SPLIT_MIN_AREA_M2;
  const maxArea = Number.isFinite(p && p.maxAreaM2) ? p.maxAreaM2 : SPLIT_MAX_AREA_M2;
  if (!cells.length || !(w > 0) || !(h > 0) || !box || rooms.length < 2) return null;

  const n = cells.length;
  const localOf = new Map();                 // global cell index -> local index (0..n-1)
  for (let i = 0; i < n; i += 1) localOf.set(cells[i], i);

  // ---- 1. distance transform: BFS inward from every cell that touches a wall / non-region cell --
  const dist = new Int32Array(n);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let i = 0; i < n; i += 1) {
    let boundary = false;
    for (const g of neighbors(cells[i], w, h)) if (!localOf.has(g)) { boundary = true; break; }
    if (boundary) { dist[i] = 1; queue[qt] = i; qt += 1; }
  }
  while (qh < qt) {
    const i = queue[qh]; qh += 1;
    const nd = dist[i] + 1;
    for (const g of neighbors(cells[i], w, h)) {
      const j = localOf.get(g);
      if (j !== undefined && dist[j] === 0) { dist[j] = nd; queue[qt] = j; qt += 1; }
    }
  }
  // A region is 4-connected by construction, so every cell is reached; guard anyway.
  for (let i = 0; i < n; i += 1) if (dist[i] === 0) dist[i] = 1;

  // ---- 2. seeds: one per room name inside the region -----------------------------------------
  const seeds = [];
  const taken = new Set();
  for (let r = 0; r < rooms.length; r += 1) {
    const room = rooms[r];
    const at = room && room.at;
    let idx = -1;
    if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
      const c = pointToCell(at.x, at.y, box, pxPerPt);
      if (c.cx >= 0 && c.cy >= 0 && c.cx < w && c.cy < h) {
        const g = c.cy * w + c.cx;
        if (localOf.has(g)) idx = localOf.get(g);
      }
      if (idx < 0 || taken.has(idx)) {
        // nearest region cell to the name's point (deterministic: first minimum in cell order)
        let best = -1, bestD = Infinity;
        for (let i = 0; i < n; i += 1) {
          if (taken.has(i)) continue;            // never hand two names the same seed cell
          const g = cells[i]; const x = g % w;
          const cp = cellToPoint(x, (g - x) / w, box, pxPerPt);
          const d = (cp.x - at.x) * (cp.x - at.x) + (cp.y - at.y) * (cp.y - at.y);
          if (d < bestD - 1e-12) { bestD = d; best = i; }
        }
        idx = best;
      }
    }
    if (idx < 0) continue;                     // no position, or no free cell to seed from
    taken.add(idx);
    seeds.push({ room, idx, label: seeds.length });
  }
  if (seeds.length < 2) return null;

  // ---- 3. seeded watershed: priority flood, highest distance first ---------------------------
  const label = new Int32Array(n).fill(-1);
  const heap = makeHeap(dist);
  for (const s of seeds) { label[s.idx] = s.label; heap.push(s.idx); }
  while (heap.size) {
    const u = heap.pop();
    const lu = label[u];
    for (const g of neighbors(cells[u], w, h)) {
      const j = localOf.get(g);
      if (j !== undefined && label[j] === -1) { label[j] = lu; heap.push(j); }
    }
  }

  // ---- 4. neck safety test + unnamed-space test, per sub-region -----------------------------
  // The morphological-opening radius: how far (in cells) a cell must sit from every wall to survive
  // an opening that severs a neck up to NECK_MAX_M wide. +1 absorbs the raster's rounding.
  const cellSizeM = metresPerPt(denom) / pxPerPt;
  const rOpen = Math.ceil((neckMaxM / 2) / cellSizeM) + 1;
  const cellM2 = cellSizeM * cellSizeM;
  // Gather each label's cells in ONE pass (a per-seed scan would be O(n x names)).
  const membersByLabel = new Map();
  for (let i = 0; i < n; i += 1) {
    const L = label[i];
    if (L < 0) continue;
    let arr = membersByLabel.get(L);
    if (!arr) { arr = []; membersByLabel.set(L, arr); }
    arr.push(cells[i]);
  }
  const parts = [];
  // Would this part pass the neck/area rules on its own? The unnamed-space trim only REFINES a part
  // that already stands up (removes a nameless space from it); it must never turn a part the rules
  // already refuse into an accepted one, because a wrong area is worse than a blank.
  const untrimmedOk = (memberCells, room, L) => {
    if (isStair(room && room.name)) return false;
    const b0 = cellsBBox(memberCells, w);
    const r0 = outlineFromRegion({ cells: memberCells, bbox: b0 }, w, box, pxPerPt);
    const a0 = pt2ToM2(outlineAreaPt2(r0), denom);
    if (a0 < minArea || a0 > maxArea) return false;
    const edge = new Map();
    for (const gc of memberCells) for (const g of neighbors(gc, w, h)) {
      const gj = localOf.get(g);
      if (gj === undefined) continue;
      const lj = label[gj];
      if (lj === L) continue;
      edge.set(lj, (edge.get(lj) || 0) + 1);
    }
    for (const count of edge.values()) if (count * cellSizeM > neckMaxM + 1e-9) return false;
    return true;
  };
  for (const s of seeds) {
    const L = s.label;
    const memberCells = membersByLabel.get(L) || [];
    if (!memberCells.length) continue;

    // ---- 4a. unnamed-space test: does this part hold more than one space? ---------------------
    // Morphological opening: drop every cell within rOpen of a wall, then count what is left. A
    // doorway (a neck up to NECK_MAX_M wide) is severed, so a room joined to a nameless hall or
    // wardrobe strip through a door leaves TWO cores. The part's own room is the core that holds
    // the name (or the nearest one); every other core is a space no name claims.
    let used = memberCells;
    let unnamed = false;
    const core = [];
    for (const gc of memberCells) {
      const li = localOf.get(gc);
      if (li !== undefined && dist[li] > rOpen) core.push(gc);
    }
    const big = cellComponents(core, w, h).filter((c) => c.length * cellM2 > SPLIT_MIN_AREA_M2);
    if (big.length > 1 && untrimmedOk(memberCells, s.room, L)) {
      const partSet = new Set(memberCells);
      const compOf = new Map();
      big.forEach((c, ci) => { for (const g of c) compOf.set(g, ci); });
      const seedG = cells[s.idx];
      let chosen = compOf.has(seedG) ? compOf.get(seedG) : -1;
      let ambiguous = false;
      if (chosen < 0) {
        // The name sits off its own core (in the band near a wall): assign by geodesic distance
        // within the part. Two cores reached at the SAME distance means the name is in the neck.
        const dBfs = new Map([[seedG, 0]]);
        const q = [seedG];
        let head = 0;
        const nearest = new Array(big.length).fill(-1);
        while (head < q.length) {
          const u = q[head]; head += 1; const du = dBfs.get(u);
          if (compOf.has(u)) { const ci = compOf.get(u); if (nearest[ci] < 0) nearest[ci] = du; }
          for (const g of neighbors(u, w, h)) if (partSet.has(g) && !dBfs.has(g)) { dBfs.set(g, du + 1); q.push(g); }
        }
        let bestD = Infinity, ties = 0;
        for (let ci = 0; ci < big.length; ci += 1) {
          const d = nearest[ci];
          if (d < 0) continue;
          if (d < bestD) { bestD = d; chosen = ci; ties = 1; }
          else if (d === bestD) ties += 1;
        }
        if (ties > 1) ambiguous = true;
      }
      if (chosen < 0 || ambiguous) unnamed = true;                   // 4b. refuse
      else {
        // 4a. TRIM: geodesic dilation by r from the room's own core, limited to the cells that
        // belong to that core (not to a nameless space across the neck). The room keeps its edge.
        const owner = nearestCore(memberCells, big, w, h);
        used = geodesicDilate(big[chosen], partSet, rOpen, w, h).filter((g) => owner.get(g) === chosen);
      }
    }

    const bbox = cellsBBox(used, w);
    const rings = outlineFromRegion({ cells: used, bbox }, w, box, pxPerPt);
    const areaPt2 = outlineAreaPt2(rings);
    const areaM2 = pt2ToM2(areaPt2, denom);

    // ---- 4c. cuts to siblings, from the (possibly trimmed) cells -----------------------------
    const cutEdges = new Map();
    for (const gc of used) {
      for (const g of neighbors(gc, w, h)) {
        const gj = localOf.get(g);
        if (gj === undefined) continue;
        const lj = label[gj];
        if (lj === L) continue;
        cutEdges.set(lj, (cutEdges.get(lj) || 0) + 1);
      }
    }
    const cuts = [...cutEdges].map(([lab, count]) => ({ label: lab, metres: count * cellSizeM }))
      .sort((a, b) => (a.label - b.label));
    const wide = cuts.find((c) => c.metres > neckMaxM + 1e-9) || null;
    const stair = isStair(s.room && s.room.name);
    const areaOk = areaM2 >= minArea && areaM2 <= maxArea;
    const accepted = !unnamed && !stair && areaOk && !wide;
    let code = null, reason = null;
    if (!accepted) {
      if (unnamed) { code = UNNAMED_SPACE_CODE; reason = UNNAMED_SPACE_REASON; }
      else {
        code = OPEN_PLAN_CODE;
        reason = stair ? 'stairwell - never conditioned'
          : wide ? OPEN_PLAN_REASON
            : `its area (${Math.round(areaM2 * 100) / 100} m2) is outside the ${minArea}-${maxArea} m2 band`;
      }
    }
    parts.push({
      label: L, roomId: s.room && s.room.id != null ? s.room.id : L, name: (s.room && s.room.name) || '',
      cells: used, bbox, rings, areaPt2, areaM2, accepted, code, reason, cuts,
    });
  }
  if (!parts.length) return null;
  return { parts, seeds: seeds.length, cellSizeM };
}

/** Convenience: the sub-regions that passed the neck safety test. */
export function acceptedParts(result) {
  return (result && result.parts ? result.parts : []).filter((x) => x.accepted);
}
/**
 * js/trace.js — real room outlines read from a floor plan's own linework.
 *
 * WHY THIS EXISTS
 * A placed region used to be a rectangle sized back from the room's stated area, because only the
 * PDF's TEXT layer (room names + areas) was read. The walls are the PDF's VECTOR PATHS. This module
 * turns those paths into enclosed areas and hands back a real outline for the rooms whose outline can
 * be TRUSTED — and nothing at all for the rest, so a shape is never invented.
 *
 * CONTRACT
 * - Pure: no DOM, no canvas, no pdf.js. Everything is testable in Node.
 * - All coordinates are PDF user space (y up, points) — the same space room.at and room.rect use,
 *   so the overlay can draw the result with no extra conversion.
 * - A traced outline is ACCEPTED only when both hold:
 *     1. the enclosed region contains exactly ONE room label, and
 *     2. its area, converted at the drawing scale, agrees with the area the plan states for that room
 *        within TRACE_BAND.
 *   A region that swallows two rooms fails test 1; a leak through a door fails both. Everything that
 *   fails keeps its rectangle.
 * - The load is never touched: the outline is display + verification only. room.area stays the figure
 *   the plan (or the user) gave.
 *
 * MEASURED ON A REAL A1 SHEET (748 kB, 149 rooms): all 149 paths read in 0.4 s, raster 2-13 ms,
 * 149 flood fills in 17-230 ms. With every path stroked, 27% of labels sit ON a wall line and 8
 * regions held several rooms; isolating the plan's own line class took reached labels from 109 to 125
 * of 149 and rooms agreeing on one drawing scale from 34% to 57%. That is why the module refuses the
 * rooms it cannot verify, and why the caller runs it on a filtered class of lines and falls back.
 */

// Curve flattening: how many straight pieces one Bezier is cut into. Walls are drawn as lines and
// rectangles in practice; curves (door swings, rounded corners) only need to be smooth enough that a
// 1-2 px stroke is continuous.
export const CURVE_STEPS = 8;

// How far the traced area may sit from the area the plan states. The traced region is bounded by wall
// CENTRELINES, so it is systematically a little larger than a net internal area: on the measured sheet
// the inflation was ~+9% (220 mm walls round a 6x5 m room), and the p25-p75 spread was 224.7-238.5
// against a median implied denominator of 229. Hence an asymmetric band, generous upwards.
export const TRACE_BAND = { lo: 0.8, hi: 1.35 };

// A region smaller than this many cells is noise (a pocket between two strokes), not a room.
export const MIN_REGION_CELLS = 24;

// ---------------------------------------------------------------------------------------------
// 1. Paths -> segments
// ---------------------------------------------------------------------------------------------

/** Apply a pdf.js-style 2-D matrix [a,b,c,d,e,f] to a point. */
export function applyMatrix(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Compose two pdf.js matrices the way pdf.js's own Util.transform does (m1 then m2 = m1 x m2). */
export function mulMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** Flatten one cubic Bezier into CURVE_STEPS straight segments. */
function flattenCurve(x0, y0, x1, y1, x2, y2, x3, y3, out, mx) {
  let px = x0, py = y0;
  for (let i = 1; i <= CURVE_STEPS; i += 1) {
    const t = i / CURVE_STEPS, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    const x = a * x0 + b * x1 + c * x2 + d * x3;
    const y = a * y0 + b * y1 + c * y2 + d * y3;
    out.push({ x1: px, y1: py, x2: x, y2: y, ...mx });
    px = x; py = y;
  }
}

/**
 * Pull wall segments out of a pdf.js operator list.
 * @param {Array} fnArray   opList.fnArray
 * @param {Array} argsArray opList.argsArray
 * @param {object} OPS      the same module's OPS map (to identify constructPath etc.)
 * @param {number[]} ctm    matrix to apply to every point (see caller: required to land inside the page box)
 * @returns {{segments: Array, styled: number}} segments carry {x1,y1,x2,y2,width,color} where
 *   width/color are whatever the graphics state held when the path was constructed (they are how the
 *   plan's own line class is told apart from symbols, hatching and the title block).
 */
export function segmentsFromOperatorList(fnArray, argsArray, OPS, ctm) {
  let m = ctm || [1, 0, 0, 1, 0, 0];
  const mx = { width: 1, color: null };
  const segments = [];
  const stack = [];
  let width = 1, color = null;
  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) { stack.push(m); continue; }
    if (fn === OPS.restore) { m = stack.pop() || (ctm || [1, 0, 0, 1, 0, 0]); continue; }
    // A CAD sheet places most of its content with a transform (and often a form XObject), so the
    // running matrix must be tracked per path — one fixed matrix for the whole list would put most
    // geometry in the wrong place.
    if (fn === OPS.transform) { m = mulMatrix(m, args); continue; }
    if (fn === OPS.paintFormXObjectBegin) { stack.push(m); if (args && args[0]) m = mulMatrix(m, args[0]); continue; }
    if (fn === OPS.paintFormXObjectEnd) { m = stack.pop() || (ctm || [1, 0, 0, 1, 0, 0]); continue; }
    if (fn === OPS.setLineWidth) { width = args[0]; continue; }
    if (fn === OPS.setStrokeRGBColor) { color = args; continue; }
    if (fn === OPS.setStrokeGray) { color = [args[0], args[0], args[0]]; continue; }
    if (fn !== OPS.constructPath) continue;
    // args: [pathOps, pathCoords] (pdf.js 4.x). Older/newer builds may nest them one level deeper.
    let ops = args[0], coords = args[1];
    if (ops && !Array.isArray(ops) && Array.isArray(ops[0])) { ops = args[0][0]; coords = args[0][1] != null ? args[0][1] : args[1]; }
    if (!Array.isArray(ops) || !Array.isArray(coords)) continue;
    const style = { width, color: color ? color.slice(0, 3) : null };
    let at = 0, startX = 0, startY = 0, curX = 0, curY = 0;
    for (const op of ops) {
      const p = (n) => { const x = coords[at]; const y = coords[at + 1];
        at += 2; const t = applyMatrix(m, x, y); return t; };
      if (op === OPS.moveTo) { const t = p(); curX = startX = t.x; curY = startY = t.y; continue; }
      if (op === OPS.lineTo) { const t = p(); segments.push({ x1: curX, y1: curY, x2: t.x, y2: t.y, ...style }); curX = t.x; curY = t.y; continue; }
      if (op === OPS.curveTo) {
        const c1 = p(), c2 = p(), to = p();
        flattenCurve(curX, curY, c1.x, c1.y, c2.x, c2.y, to.x, to.y, segments, style);
        curX = to.x; curY = to.y; continue;
      }
      if (op === OPS.curveTo2) {
        const c2 = p(), to = p();
        flattenCurve(curX, curY, curX, curY, c2.x, c2.y, to.x, to.y, segments, style);
        curX = to.x; curY = to.y; continue;
      }
      if (op === OPS.curveTo3) {
        const c1 = p(), to = p();
        flattenCurve(curX, curY, c1.x, c1.y, to.x, to.y, to.x, to.y, segments, style);
        curX = to.x; curY = to.y; continue;
      }
      // `re` linework. In the vendored pdf.js 4.10.38 the op is OPS.rectangle (=19); OPS.rect does
      // not exist there (the old branch was dead code, so every `re` wall was silently dropped). pdf.js
      // emits FOUR numbers for it (x, y, w, h), not the eight a naive rename would read — so expand
      // them into the same four corner points the historical form implied and emit one segment per
      // edge. `OPS.rect` is kept for older/synthetic op maps; either way the width and height are
      // validated first, so a malformed rect can never push a NaN segment (a NaN makes rasterizeWalls'
      // Bresenham loop spin to its 1e7 guard).
      if (op === OPS.rectangle || op === OPS.rect) {
        const rx = coords[at], ry = coords[at + 1], rw = coords[at + 2], rh = coords[at + 3];
        at += 4;
        if ([rx, ry, rw, rh].every(Number.isFinite)) {
          const pts = [
            applyMatrix(m, rx, ry),
            applyMatrix(m, rx + rw, ry),
            applyMatrix(m, rx + rw, ry + rh),
            applyMatrix(m, rx, ry + rh),
          ];
          for (let k = 0; k < 4; k += 1) {
            const a = pts[k], b = pts[(k + 1) % 4];
            segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...style });
          }
          curX = startX = pts[3].x; curY = startY = pts[3].y;
        }
        continue;
      }
      if (op === OPS.closePath) {
        if (curX !== startX || curY !== startY) segments.push({ x1: curX, y1: curY, x2: startX, y2: startY, ...style });
        curX = startX; curY = startY; continue;
      }
      // Any other path op (quadratic curves, etc.) is ignored: walls do not use them.
    }
  }
  return { segments, styled: segments.filter((s) => s.color).length };
}

/** The most common (width, colour) class in a segment list — how the plan's own linework is picked
 *  out from hatching, symbols and the title block without knowing anything about the sheet. */
export function dominantStyle(segments) {
  const counts = new Map();
  for (const s of segments) {
    const key = `${s.width}|${s.color ? s.color.join(',') : 'none'}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [key, n] of counts) if (n > bestN) { best = key; bestN = n; }
  return best;
}

/** Line classes in a segment list, most common first: `[[key, count], ...]`. */
export function styleCounts(segments) {
  const counts = new Map();
  for (const s of segments) {
    const key = `${s.width}|${s.color ? s.color.join(',') : 'none'}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Keep only the segments of one (width, colour) class. */
export function filterByStyle(segments, key) {
  return segments.filter((s) => `${s.width}|${s.color ? s.color.join(',') : 'none'}` === key);
}

// ---------------------------------------------------------------------------------------------
// 2. Raster
// ---------------------------------------------------------------------------------------------

/**
 * Stroke the segments onto a grid of wall pixels.
 * @param {Array} segments
 * @param {{x0:number,y0:number,x1:number,y1:number}} box  PDF-space window (the page MediaBox)
 * @param {number} pxPerPt
 * @param {number} thickness pixels of wall stroke (a hairline needs >=1)
 * @returns {{w:number,h:number,grid:Uint8Array}} grid value 1 = wall, 0 = free
 */
export function rasterizeWalls(segments, box, pxPerPt, thickness = 1) {
  const w = Math.max(1, Math.ceil((box.x1 - box.x0) * pxPerPt));
  const h = Math.max(1, Math.ceil((box.y1 - box.y0) * pxPerPt));
  const grid = new Uint8Array(w * h);
  const cx = (x) => Math.round((x - box.x0) * pxPerPt);
  const cy = (y) => Math.round((y - box.y0) * pxPerPt);          // y up in PDF space == y up here
  const half = Math.max(0, Math.floor((thickness - 1) / 2));
  for (const s of segments) {
    let x0 = cx(s.x1), y0 = cy(s.y1), x1 = cx(s.x2), y1 = cy(s.y2);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (let guard = 0; guard < 1e7; guard += 1) {
      for (let oy = -half; oy <= half; oy += 1) {
        for (let ox = -half; ox <= half; ox += 1) {
          const px = x0 + ox, py = y0 + oy;
          if (px >= 0 && py >= 0 && px < w && py < h) grid[py * w + px] = 1;
        }
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }
  return { w, h, grid };
}

/** PDF-space point -> raster cell. */
export function pointToCell(x, y, box, pxPerPt) {
  return { cx: Math.round((x - box.x0) * pxPerPt), cy: Math.round((y - box.y0) * pxPerPt) };
}

/** Raster cell -> PDF-space point (cell centre). */
export function cellToPoint(cx, cy, box, pxPerPt) {
  return { x: box.x0 + (cx + 0.5) / pxPerPt, y: box.y0 + (cy + 0.5) / pxPerPt };
}

// ---------------------------------------------------------------------------------------------
// 2b. Small-gap closing (OPT-IN)
// ---------------------------------------------------------------------------------------------
// A door opening is a deliberate hole in the wall linework: free space leaks straight through it, so
// the flood fill that extracts one room's region walks out of the door and swallows the neighbour. A
// morphological CLOSE — grow the wall mask by r pixels, then shrink it back by r — bridges any gap up
// to ~2r wide and leaves every wall and every room the same size, except that the doorway is sealed.
// It is OPT-IN (closeGaps: <pixels>, default 0 = off) so nothing that exists today changes.

/**
 * Grayscale/binary box MAX (dilation by a (2r+1)x(2r+1) square) along rows then columns. Exact for a
 * square structuring element, and O(w*h) per pass regardless of r (two directional distance sweeps),
 * so a radius of 6 costs no more than a radius of 1 — important because this runs in the browser.
 * @returns {Uint8Array} a NEW grid (the input is never mutated)
 */
function boxDilate(src, w, h, r) {
  const row = new Uint8Array(w * h);
  const dw = new Int32Array(w);
  for (let y = 0; y < h; y += 1) {
    const base = y * w;
    let last = -1e9;
    for (let x = 0; x < w; x += 1) { if (src[base + x]) last = x; dw[x] = x - last; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x -= 1) {
      if (src[base + x]) last = x;
      row[base + x] = Math.min(dw[x], last - x) <= r ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  const dh = new Int32Array(h);
  for (let x = 0; x < w; x += 1) {
    let last = -1e9;
    for (let y = 0; y < h; y += 1) { if (row[y * w + x]) last = y; dh[y] = y - last; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y -= 1) {
      if (row[y * w + x]) last = y;
      out[y * w + x] = Math.min(dh[y], last - y) <= r ? 1 : 0;
    }
  }
  return out;
}

/**
 * Morphological close of a wall grid: dilate by `radius` px, then erode by `radius` px. Seals gaps up
 * to roughly 2*radius pixels wide (the rasterised door opening and small breaks in the linework)
 * without moving a wall or shrinking a room by more than the stroke it already had.
 * @param {Uint8Array} grid wall mask (1 = wall)
 * @param {number} radius pixels; <= 0 returns the grid unchanged (so the default path is a no-op)
 * @returns {Uint8Array} a NEW grid, or the input when radius <= 0
 */
export function morphClose(grid, w, h, radius) {
  const r = Math.round(Number(radius) || 0);
  if (r <= 0) return grid;
  const dilated = boxDilate(grid, w, h, r);
  const free = new Uint8Array(w * h);
  for (let i = 0; i < free.length; i += 1) free[i] = dilated[i] ? 0 : 1;
  const grownFree = boxDilate(free, w, h, r);               // erode(walls) == NOT dilate(NOT walls)
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i += 1) out[i] = grownFree[i] ? 0 : 1;
  return out;
}

/**
 * Measured, recommended opt-in radius for closeGaps. Swept 0,1,2,3,4,6 against both real sheets:
 * every radius in 1..6 leaves the LEVEL 11 name-only plan's auto-fill (21 of 56) and the 159-room
 * fixture's trace coverage (105 of 159 accepted, 40 L-shaped rings) EXACTLY unchanged, while still
 * bridging genuine hairline breaks up to ~2*6 px (6 pt ≈ 0.21 m at 1:100). Larger radii are needed to
 * bridge a full ~0.8 m door, but on the measured LEVEL 11 sheet those rooms are joined by openings
 * far wider than any door (the free space is one 3.0 M-cell component until r≈10), so no radius turns
 * the merges into single rooms — see the module report. The DEFAULT stays 0 (off).
 */
export const RECOMMENDED_CLOSE_GAPS = 6;

// ---------------------------------------------------------------------------------------------
// 3. Regions
// ---------------------------------------------------------------------------------------------

/**
 * Flood fill the free space (4-connected) around a cell.
 * 4-connected on purpose: free space joined only diagonally is joined through a wall joint, and
 * treating that as one room would merge two rooms across a corner.
 * @returns {{cells:number[], areaPx:number, bbox:{x0,y0,x1,y1}}|null} null if the cell is a wall or outside
 */
export function regionAt(grid, w, h, cx, cy, opts = {}) {
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return null;
  const start = cy * w + cx;
  if (grid[start]) return null;                       // the label sits ON a wall line
  // A caller tracing many labels MUST pass one shared `seen` array: a fresh 16-million-cell buffer per
  // label is what makes this slow on a real sheet (149 of them dwarf the actual flood filling).
  const seen = opts.seen || new Uint8Array(w * h);
  const stack = [start];
  seen[start] = 1;
  const cells = [];
  let x0 = cx, y0 = cy, x1 = cx, y1 = cy;
  while (stack.length) {
    const c = stack.pop();
    cells.push(c);
    const px = c % w, py = (c - px) / w;
    if (px < x0) x0 = px; if (px > x1) x1 = px;
    if (py < y0) y0 = py; if (py > y1) y1 = py;
    if (px > 0 && !seen[c - 1] && !grid[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
    if (px < w - 1 && !seen[c + 1] && !grid[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
    if (py > 0 && !seen[c - w] && !grid[c - w]) { seen[c - w] = 1; stack.push(c - w); }
    if (py < h - 1 && !seen[c + w] && !grid[c + w]) { seen[c + w] = 1; stack.push(c + w); }
    if (opts.maxCells && cells.length > opts.maxCells) return { cells, areaPx: cells.length, bbox: { x0, y0, x1, y1 }, over: true };
  }
  return { cells, areaPx: cells.length, bbox: { x0, y0, x1, y1 }, over: false };
}

/** Is a raster cell inside a region? */
export function regionHasCell(region, cx, cy, w) {
  if (!region) return false;
  const c = cy * w + cx;
  for (let i = 0; i < region.cells.length; i += 1) if (region.cells[i] === c) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// 4. Outline
// ---------------------------------------------------------------------------------------------

/**
 * Trace the boundary of a region as polygons in PDF space, using the region's own cells against its
 * complement (marching squares on cell edges, so the outline follows the wall faces).
 * @returns {Array<Array<{x:number,y:number}>>} one or more closed rings, PDF space
 */
export function outlineFromRegion(region, w, box, pxPerPt, opts = {}) {
  if (!region || !region.cells || !region.cells.length) return [];
  const bw = region.bbox.x1 - region.bbox.x0 + 2;
  const bh = region.bbox.y1 - region.bbox.y0 + 2;
  const mask = new Uint8Array(bw * bh);
  const at = (x, y) => (x < 0 || y < 0 || x >= bw || y >= bh ? 0 : mask[y * bw + x]);
  for (const c of region.cells) {
    const px = (c % w) - region.bbox.x0 + 1;
    const py = ((c - (c % w)) / w) - region.bbox.y0 + 1;
    mask[py * bw + px] = 1;
  }
  // Every cell edge that separates inside from outside, emitted as a DIRECTED edge in a consistent
  // orientation (interior always on the left). Consistency is what makes stitching exact: from any
  // vertex there is exactly one outgoing boundary edge to follow.
  const edges = [];
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      if (!at(x, y)) continue;
      if (!at(x, y + 1)) edges.push([x, y + 1, x + 1, y + 1]);   // top, left to right
      if (!at(x + 1, y)) edges.push([x + 1, y + 1, x + 1, y]);   // right, top to bottom
      if (!at(x, y - 1)) edges.push([x + 1, y, x, y]);           // bottom, right to left
      if (!at(x - 1, y)) edges.push([x, y, x, y + 1]);           // left, bottom to top
    }
  }
  const outFrom = new Map();
  const key = (x, y) => `${x},${y}`;
  edges.forEach((e, i) => {
    const k = key(e[0], e[1]);
    if (!outFrom.has(k)) outFrom.set(k, []);
    outFrom.get(k).push(i);
  });
  const used = new Uint8Array(edges.length);
  const rings = [];
  for (let i = 0; i < edges.length; i += 1) {
    if (used[i]) continue;
    const ring = [];
    let cur = i;
    for (let guard = 0; guard <= edges.length && cur != null; guard += 1) {
      if (used[cur]) break;
      used[cur] = 1;
      const e = edges[cur];
      ring.push({ x: e[0], y: e[1] });
      const next = (outFrom.get(key(e[2], e[3])) || []).find((j) => !used[j]);
      cur = next == null ? null : next;
    }
    if (ring.length > 2) rings.push(ring);
  }
  // Drop collinear runs (a long wall becomes one segment) and convert to PDF space.
  const out = [];
  for (const ring of rings) {
    const simp = [];
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[(i - 1 + ring.length) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross !== 0) simp.push(b);
    }
    if (simp.length < 3) continue;
    out.push(simp.map((p) => cellToPoint(p.x - 1 + region.bbox.x0, p.y - 1 + region.bbox.y0, box, pxPerPt)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 5. Area, scale and the accept rules
// ---------------------------------------------------------------------------------------------

/** Shoelace area of a closed ring, in square points. */
export function polygonAreaPt2(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Total area of a multi-ring outline (outer rings only; holes are not used by this module). */
export function outlineAreaPt2(rings) {
  return (rings || []).reduce((sum, r) => sum + polygonAreaPt2(r), 0);
}

/**
 * Square points -> square metres on the real building.
 * 1 pt = 1/72 inch of paper; at 1:denom one paper inch is denom real inches.
 */
export function pt2ToM2(areaPt2, denom) {
  const m = (0.0254 * denom) / 72;
  return areaPt2 * m * m;
}

/** Metres per PDF point at a drawing scale (used by the overlay for nothing, but handy in tests). */
export function metresPerPt(denom) {
  return (0.0254 * denom) / 72;
}

/**
 * The single decision this module exists to make: is this traced outline trustworthy for this room?
 * @param {number} tracedM2 area of the enclosed region at the drawing scale
 * @param {number} statedArea the area the plan states for the room
 * @param {number} labelsInRegion how many room labels fell inside this region
 * @param {{lo:number,hi:number}} band
 * @returns {{ok:boolean, code:string|null, ratio:number, reason:string}} `code` is a STABLE machine
 *   code ('shared' | 'no-area' | 'area-mismatch', or null when accepted) so callers categorise a
 *   refusal by code instead of regex-parsing the English `reason`.
 */
export function judgeTrace(tracedM2, statedArea, labelsInRegion, band = TRACE_BAND) {
  if (labelsInRegion > 1) {
    return { ok: false, code: 'shared', ratio: statedArea ? tracedM2 / statedArea : NaN,
      reason: `its area is shared with ${labelsInRegion - 1} other room(s)` };
  }
  if (!statedArea || !(statedArea > 0)) return { ok: false, code: 'no-area', ratio: NaN, reason: 'the room has no stated area' };
  const ratio = tracedM2 / statedArea;
  if (ratio < band.lo || ratio > band.hi) {
    return { ok: false, code: 'area-mismatch', ratio, reason: `traced area ${Math.round(ratio * 100)}% of the stated one` };
  }
  return { ok: true, code: null, ratio, reason: '' };
}

/**
 * The region-extraction core, shared by traceRooms() and traceRegions() so the two can never drift.
 * Rasterise the walls (optionally closing small gaps first), flood fill the free space once, and pair
 * every room label with the region it sits in.
 * @returns {{w,h,pxPerPt,denom,box,grid,closeGaps,regions,labelsPerRegion,regionByRoom,regionOf,seeds}}
 *   `regions` are raw internal regions ({cells, areaPx, bbox, index, key}); callers add rings/areas.
 */
function extractRegions(p) {
  const pxPerPt = p.pxPerPt || 2;
  const denom = p.denom || 100;
  const box = p.box;
  const rast = rasterizeWalls(p.segments, box, pxPerPt, p.thickness || 2);
  const { w, h } = rast;
  // OPT-IN gap closing: only when a caller asks (closeGaps > 0). Default 0 leaves the grid untouched,
  // so every existing caller and test keeps its exact behaviour.
  const gap = Math.round(Number(p.closeGaps) || 0);
  const grid = gap > 0 ? morphClose(rast.grid, w, h, gap) : rast.grid;
  // A region far larger than any room in the table is an open area or a leak, not a room. Capping the
  // flood fill at a few times the largest stated area also keeps a hopeless line class (symbols instead
  // of walls) from spending ten seconds wallowing across the whole sheet.
  const mPerCell = metresPerPt(denom) / pxPerPt;
  const biggest = p.rooms.reduce((m, r) => Math.max(m, Number(r.area) || 0), 0);
  const maxCells = p.maxCells
    || Math.max(MIN_REGION_CELLS * 4, Math.ceil((biggest * (p.overFactors || 3)) / (mPerCell * mPerCell)));
  // Seed every label once; a label on a wall line has no region.
  const seeds = p.rooms.map((r) => {
    const c = pointToCell(r.at.x, r.at.y, box, pxPerPt);
    return { room: r, cell: c.cx >= 0 && c.cy >= 0 && c.cx < w && c.cy < h ? c.cy * w + c.cx : -1, cx: c.cx, cy: c.cy };
  });
  const regionByRoom = new Map();
  const labelsPerRegion = new Map();
  // Flood each enclosed area ONCE (sharing one `seen` buffer) instead of once per label, and record
  // which region each cell belongs to, so the label-to-region assignment is exact.
  const seen = new Uint8Array(w * h);
  const regionOf = new Int32Array(w * h).fill(-1);
  const counts = [];
  const regions = [];
  for (const s of seeds) {
    if (s.cell < 0 || grid[s.cell] || seen[s.cell]) continue;     // off-page, on a wall, or already flooded
    const region = regionAt(grid, w, h, s.cx, s.cy, { seen, maxCells });
    if (region && region.over) {
      // Too big to be a room: mark its cells so its labels get a clear reason, and keep nothing.
      for (const c of region.cells) regionOf[c] = -2;
      continue;
    }
    if (!region || region.areaPx < MIN_REGION_CELLS) continue;
    const index = counts.length;
    counts.push(0);
    for (const c of region.cells) regionOf[c] = index;
    region.index = index;
    region.key = index;                                           // canonical per area, not per label
    regions.push(region);
  }
  for (const s of seeds) {
    if (s.cell < 0) continue;
    const index = regionOf[s.cell];
    if (index < 0) continue;
    regionByRoom.set(s.room, regions[index]);
    counts[index] += 1;
    labelsPerRegion.set(index, counts[index]);
  }
  return { w, h, pxPerPt, denom, box, grid, closeGaps: gap, regions, labelsPerRegion, regionByRoom, regionOf, seeds };
}

// On a NAME-ONLY plan (the case this feature exists for) no room states an area, so traceRooms' cap —
// a few times the largest STATED area — collapses to noise size and would discard every real room.
// traceRegions() therefore caps at the whole raster instead: bounded, and it never invents a region.
export const REGION_MAX_CELLS = 20_000_000;

/**
 * The enclosed regions themselves — rings, area and cell count — with no per-room verdict. This is the
 * shape js/autotrace.js consumes directly: `{ id, rings, polygon, areaPt2, areaM2, closed, cells,
 * labels, bbox }`. `closed` is true when the outline came back as at least one ring.
 * @param {object} p  the same input as traceRooms (segments, box, rooms, denom, pxPerPt, thickness,
 *   maxCells, and the opt-in closeGaps). When `maxCells` is omitted it defaults to REGION_MAX_CELLS so
 *   a name-only plan (no stated areas) still yields its rooms.
 * @returns {{regions: Array, stats: object}}
 */
export function traceRegions(p) {
  const pxPerPt = p.pxPerPt || 2;
  const bw = Math.max(1, Math.ceil((p.box.x1 - p.box.x0) * pxPerPt));
  const bh = Math.max(1, Math.ceil((p.box.y1 - p.box.y0) * pxPerPt));
  const core = extractRegions({ ...p, maxCells: p.maxCells != null ? p.maxCells : Math.min(REGION_MAX_CELLS, bw * bh) });
  const { w, box, pxPerPt: px, denom, regions, labelsPerRegion } = core;
  const out = [];
  for (const region of regions) {
    const rings = outlineFromRegion(region, w, box, px);
    const areaPt2 = outlineAreaPt2(rings);
    out.push({
      id: `reg${region.index}`,
      rings,
      polygon: rings[0] || [],
      areaPt2,
      areaM2: pt2ToM2(areaPt2, denom),
      closed: rings.length > 0,
      cells: region.areaPx,
      labels: labelsPerRegion.get(region.key) || 0,
      bbox: region.bbox,
    });
  }
  return { regions: out, stats: {
    regions: out.length, labels: p.rooms.length, closeGaps: core.closeGaps,
    pxPerPt: px, denom, raster: `${core.w}x${core.h}`,
  } };
}

/**
 * The whole job for one page: walls + rooms -> an outline per room, or a reason why not.
 * @param {object} p
 * @param {Array} p.segments wall segments (already filtered to the plan's line class if desired)
 * @param {{x0,y0,x1,y1}} p.box  page MediaBox in PDF space
 * @param {Array<{id:any, at:{x,y}, area:number, name?:string}>} p.rooms  rooms that have a position
 * @param {number} p.denom drawing scale denominator (100 for 1:100)
 * @param {number} [p.pxPerPt] raster resolution (2 keeps a 3 px wall at 1:250 visible)
 * @param {number} [p.thickness] wall stroke in pixels
 * @param {number} [p.closeGaps] OPT-IN: close wall gaps up to ~2x this many pixels (0 = off, the default)
 * @param {object} [p.band]
 * @returns {{results: Array, stats: object}}
 */
export function traceRooms(p) {
  const core = extractRegions(p);
  const { w, box, pxPerPt, denom, regions, labelsPerRegion, regionByRoom, regionOf, seeds } = core;
  const results = [];
  for (const s of seeds) {
    const region = regionByRoom.get(s.room);
    if (!region) {
      const index = s.cell < 0 ? -1 : regionOf[s.cell];
      const tooBig = index === -2;
      results.push({
        id: s.room.id, ok: false, rings: [], statedM2: s.room.area,
        code: tooBig ? 'too-big' : 'no-region',
        reason: tooBig
          ? 'the space around its name is far larger than any single room (open plan or a leak)'
          : 'no enclosed area around its name',
      });
      continue;
    }
    const labels = labelsPerRegion.get(region.key) || 0;
    const rings = outlineFromRegion(region, w, box, pxPerPt);
    const tracedM2 = pt2ToM2(outlineAreaPt2(rings), denom);
    const verdict = judgeTrace(tracedM2, s.room.area, labels, p.band);
    results.push({
      id: s.room.id, ok: verdict.ok, code: verdict.code || null, reason: verdict.reason, ratio: verdict.ratio,
      tracedM2, statedM2: s.room.area, rings: verdict.ok ? rings : [], cells: region.areaPx,
    });
  }
  const accepted = results.filter((r) => r.ok).length;
  const scale = impliedDenom(results, denom);
  return { results, stats: {
    labels: p.rooms.length, reached: regionByRoom.size, accepted,
    refused: results.length - accepted, impliedDenom: scale.denom, impliedFrom: scale.n,
    raster: `${w}x${core.h}`, pxPerPt, denom,
  } };
}

/**
 * What drawing scale do the outlines imply? For every area that was reached, dividing the area the plan
 * states by the area traced gives (scale factor)^2, so each room implies a denominator. A consistent
 * trace gives a tight cluster — and if that cluster is far from the scale the app is using, the honest
 * answer is to tell the user their scale is wrong rather than to accept shapes against a bad one.
 */
export function impliedDenom(results, denom) {
  const implied = (results || [])
    .filter((r) => r.tracedM2 > 0 && r.statedM2 > 0)
    .map((r) => denom * Math.sqrt(r.statedM2 / r.tracedM2))
    .sort((a, b) => a - b);
  if (!implied.length) return { denom: null, n: 0 };
  const mid = implied[Math.floor(implied.length / 2)];
  return {
    denom: Math.round(mid), n: implied.length,
    p25: Math.round(implied[Math.floor(implied.length * 0.25)]),
    p75: Math.round(implied[Math.floor(implied.length * 0.75)]),
  };
}

/**
 * Choose which lines to treat as the plan, BY RESULT rather than by how common a class is. On a real
 * MEP sheet the symbol hatch outnumbered the walls on two of three pages, so "most common class" traced
 * symbols and merged rooms. Trying the few most common classes (and every line as a last resort) and
 * keeping whichever accepts the most rooms is sheet-agnostic.
 * @returns {{key:string, stats:object, results:Array, tried:Array<{key,n}>}}
 */
export function pickWallLines(segments, opts) {
  const candidates = styleCounts(segments).slice(0, opts.topN || 3).map(([key]) => ({ key, segs: filterByStyle(segments, key) }));
  candidates.push({ key: 'all lines', segs: segments });
  let best = null;
  const tried = [];
  for (const c of candidates) {
    const out = traceRooms({ ...opts, segments: c.segs });
    tried.push({ key: c.key, accepted: out.stats.accepted, labels: out.stats.labels });
    if (!best || out.stats.accepted > best.stats.accepted) best = { key: c.key, ...out };
  }
  return { ...best, tried };
}

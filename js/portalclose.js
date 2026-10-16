/**
 * js/portalclose.js — close the openings a drawing leaves between spaces, at the wall ends that frame
 * them, so a space that is open to its neighbour can still be traced along its OWN walls.
 *
 * WHY THIS EXISTS
 *   A plans's free space is one connected blob wherever an opening joins two spaces. The region tracer
 *   hands that blob to the splitter, which can only cut at a neck narrower than a door (NECK_MAX_M), so
 *   a space joined to its neighbour through a WIDE opening cannot be separated at all — and a boundary
 *   drawn there follows a watershed line through open floor, not a wall. Measured on the built-in sample:
 *   the centre LOBBY shares one blob with SECURITY, PUBLIC LIFT LOBBY and two ESCAPE ONLY labels, all in
 *   one opened core, i.e. joined by openings wider than a metre.
 *
 * WHAT IT DOES
 *   Finds the FREE ENDS of walls (an end no other line touches) and joins the two ends that frame an
 *   opening, adding that join as a wall. Re-extracting the regions then yields spaces closed along their
 *   own walls, with the join standing in for the opening — exactly the "close the portal, then re-trace"
 *   step docs/ZONE-DETECTION-RESEARCH.md calls for.
 *
 * WHAT IT REFUSES TO DO
 *   Every join must satisfy all of: the two ends are within `maxPt`; each wall points at the other end
 *   (the opening continues the wall's own line, within ~35°); and the join itself crosses NO existing
 *   line (so it truly passes through open space). An end is used at most once, and a join is never added
 *   twice. It closes openings; it does not invent rooms, and it never moves or deletes a line.
 */

const fin = (v) => Number.isFinite(v);

/** Proper crossing of open line a->b with segment s (shared endpoints do not count). */
function crosses(a, b, s) {
  const d1 = (b.x - a.x) * (s.y1 - a.y) - (b.y - a.y) * (s.x1 - a.x);
  const d2 = (b.x - a.x) * (s.y2 - a.y) - (b.y - a.y) * (s.x2 - a.x);
  const d3 = (s.x2 - s.x1) * (a.y - s.y1) - (s.y2 - s.y1) * (a.x - s.x1);
  const d4 = (s.x2 - s.x1) * (b.y - s.y1) - (s.y2 - s.y1) * (b.x - s.x1);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * @param {Array} segments  {x1,y1,x2,y2} in PDF points (several may share an endpoint)
 * @param {object} [opts]   maxPt: widest opening to close (pt); mergeTol: endpoints this close are one
 *                          junction (pt); angleCos: how straight the wall line must continue (0.82 ~ 35°);
 *                          maxAdded: safety cap.
 * @returns {Array} the joins to ADD as walls: [{x1,y1,x2,y2,portal:true}]
 */
export function closeOpenings(segments, opts = {}) {
  const maxPt = Number(opts.maxPt) || 110;
  const mergeTol = Number(opts.mergeTol) || 1.5;
  const angleCos = Number(opts.angleCos) || 0.82;
  const maxAdded = Number(opts.maxAdded) || 600;
  // A join shorter than this is not an opening: it is the thickness of one wall (this drawing's walls
  // measure ~0.4 m between their two parallel lines, and the first corner-rule run produced 265 joins
  // with a 0.41 m median - i.e. it was drawing over walls). A real opening here is >= ~0.8 m.
  const minPt = Number(opts.minPt) || 0;
  const segs = (segments || [])
    .map((s) => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 }))
    .filter((s) => fin(s.x1) && fin(s.y1) && fin(s.x2) && fin(s.y2)
      && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 1e-6);
  if (segs.length < 2) return [];

  // ---- 1. junctions: endpoints that coincide are the same point of the drawing -------------------
  const nodes = [];
  const nodeOf = [];                       // segments -> [nodeA, nodeB]
  for (let i = 0; i < segs.length; i += 1) {
    nodeOf[i] = [];
    for (const p of [[segs[i].x1, segs[i].y1], [segs[i].x2, segs[i].y2]]) {
      let hit = -1;
      for (let n = 0; n < nodes.length; n += 1) {
        const nd = nodes[n];
        if (Math.abs(nd.x - p[0]) <= mergeTol && Math.abs(nd.y - p[1]) <= mergeTol) { hit = n; break; }
      }
      if (hit < 0) { nodes.push({ x: p[0], y: p[1], ends: [] }); hit = nodes.length - 1; }
      nodes[hit].ends.push(i);
      nodeOf[i].push(hit);
    }
  }

  // ---- 2. free ends: a wall that simply STOPS (exactly one line touches the point) ----------------
  const free = [];
  for (let n = 0; n < nodes.length; n += 1) {
    const nd = nodes[n];
    if (nd.ends.length !== 1) continue;     // a junction or a corner: not the side of an opening
    const i = nd.ends[0];
    const s = segs[i];
    const other = (nodeOf[i][0] === n) ? nodeOf[i][1] : nodeOf[i][0];
    const o = nodes[other];
    const len = Math.hypot(o.x - nd.x, o.y - nd.y);
    if (len < 1e-6) continue;
    // direction INTO the wall from this end: the opening must continue that line
    free.push({ n, i, x: nd.x, y: nd.y, dx: (o.x - nd.x) / len, dy: (o.y - nd.y) / len });
  }
  if (free.length < 2) return [];

  // ---- 2b. corner-framed openings -----------------------------------------------------------------
  // A wall does not always STOP at an opening: on this drawing the walls are drawn as two parallel
  // lines that turn a corner, so the opening between two spaces is framed by two CORNERS facing each
  // other (measured at the sample's centre lobby: every wall point within 6 m has 2-4 lines meeting,
  // i.e. no free end to pair). Such a pair also frames an opening, so it is a candidate too: the two
  // walls run roughly PARALLEL and each runs roughly ACROSS the join (`acrossMin`), and the join itself
  // crosses nothing. Kept separate from the continuation rule so either can be switched off alone.
  // `acrossMax` is |cos| between a wall's own direction and the join: near 0 means the join runs ACROSS
  // the wall (what closing an opening looks like), near 1 means it runs along it (which would just draw
  // over a wall, and was the first version of this test - it produced 395 joins, median 0.39 m).
  const acrossMax = Number(opts.acrossMax) || 0.34;
  const parallelMin = Number(opts.parallelMin) || 0.7; // the two walls face each other: roughly parallel
  if (opts.cornerOpenings !== false) {
    const corpus = [];                                // candidate wall ends, from ALL wall points
    for (let n = 0; n < nodes.length; n += 1) {
      const nd = nodes[n];
      let best = null;
      for (const i of nd.ends) {
        const s = segs[i];
        const other = (nodeOf[i][0] === n) ? nodeOf[i][1] : nodeOf[i][0];
        const o = nodes[other];
        const len = Math.hypot(o.x - nd.x, o.y - nd.y);
        if (len < 2) continue;                        // ignore stubs: a real wall line, not a cap
        if (!best || len > best.len) best = { i, len, dx: (o.x - nd.x) / len, dy: (o.y - nd.y) / len, n };
      }
      if (best) corpus.push({ ...best, x: nd.x, y: nd.y, corner: true });
    }
    for (let a = 0; a < corpus.length; a += 1) {
      for (let b = a + 1; b < corpus.length; b += 1) {
        const A = corpus[a], B = corpus[b];
        const d = Math.hypot(B.x - A.x, B.y - A.y);
        if (d <= minPt || d > maxPt) continue;
        const ux = (B.x - A.x) / d, uy = (B.y - A.y) / d;
        if (Math.abs(A.dx * ux + A.dy * uy) > acrossMax) continue;      // A must run across the join
        if (Math.abs(B.dx * ux + B.dy * uy) > acrossMax) continue;      // B must run across the join
        if (Math.abs(A.dx * B.dx + A.dy * B.dy) < parallelMin) continue; // the walls face each other
        // support the corpus entries with the same shape as the free ends
        free.push({ n: A.n, i: A.i, x: A.x, y: A.y, dx: A.dx, dy: A.dy, corner: true });
        free.push({ n: B.n, i: B.i, x: B.x, y: B.y, dx: B.dx, dy: B.dy, corner: true });
        break;
      }
    }
  }

  // ---- 3. join the ends that frame an opening ----------------------------------------------------
  const used = new Set();
  const added = [];
  const seen = new Set();
  const pairs = [];
  for (let a = 0; a < free.length; a += 1) {
    for (let b = a + 1; b < free.length; b += 1) {
      const A = free[a], B = free[b];
      const d = Math.hypot(B.x - A.x, B.y - A.y);
      if (d <= minPt || d > maxPt) continue;
      const ux = (B.x - A.x) / d, uy = (B.y - A.y) / d;
      // each wall must point at the other end: the opening continues the wall's own line
      if (A.dx * ux + A.dy * uy > -angleCos) continue;
      if (B.dx * -ux + B.dy * -uy > -angleCos) continue;
      pairs.push({ A, B, d, ux, uy });
    }
  }
  pairs.sort((p, q) => p.d - q.d);        // closest first: the most obvious openings win
  for (const { A, B, d } of pairs) {
    if (added.length >= maxAdded) break;
    if (used.has(A.i) || used.has(B.i)) continue;
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    let blocked = false;
    for (let i = 0; i < segs.length && !blocked; i += 1) {
      if (i === A.i || i === B.i) continue;
      if (crosses(A, B, segs[i]) || crosses(A, mid, segs[i]) || crosses(mid, B, segs[i])) blocked = true;
    }
    if (blocked) continue;                 // a line is in the way: not an opening
    const key = `${A.x.toFixed(2)},${A.y.toFixed(2)}|${B.x.toFixed(2)},${B.y.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    used.add(A.i); used.add(B.i);
    added.push({ x1: A.x, y1: A.y, x2: B.x, y2: B.y, portal: true, portalWidth: d });
  }
  return added;
}

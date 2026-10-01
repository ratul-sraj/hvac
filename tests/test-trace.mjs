// js/trace.js — reading real room outlines out of a plan's linework.
// Run: node tests/test-trace.mjs      (also run by tests/run.mjs)
import {
  segmentsFromOperatorList, dominantStyle, filterByStyle,
  rasterizeWalls, pointToCell, cellToPoint, regionAt, regionHasCell,
  outlineFromRegion, polygonAreaPt2, outlineAreaPt2, pt2ToM2, metresPerPt,
  judgeTrace, traceRooms, impliedDenom, pickWallLines, styleCounts, TRACE_BAND,
} from '../js/trace.js';

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? '  — ' + detail : ''}`); process.exitCode = 1; }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------------ synthetic sheets
const DENOM = 100;
const MPP = metresPerPt(DENOM);                 // metres per PDF point at 1:100
const box = (x1, y1) => ({ x0: 0, y0: 0, x1, y1 });
/** A square room, walls drawn as four lines of thickness t pt, with an optional gap (door). */
function roomWalls(x, y, sidePt, gapPt = 0) {
  const s = [];
  const push = (x1, y1, x2, y2) => s.push({ x1, y1, x2, y2, width: 1, color: [136, 136, 136] });
  push(x, y, x + sidePt, y);                                  // bottom
  if (gapPt) {                                                // bottom with a door gap
    s.pop();
    push(x, y, x + gapPt * 0.4, y);
    push(x + gapPt * 0.6, y, x + sidePt, y);
  }
  push(x + sidePt, y, x + sidePt, y + sidePt);                // right
  push(x + sidePt, y + sidePt, x, y + sidePt);                // top
  push(x, y + sidePt, x, y);                                  // left
  return s;
}
const sideFor = (areaM2) => (areaM2 / (MPP * MPP)) ** 0.5;    // square side in points

// ------------------------------------------------------------------ operator list -> segments
// The op ids mirror the vendored pdf.js 4.10.38: the `re` rectangle op is OPS.rectangle (=19). There is
// deliberately NO OPS.rect here (it is undefined in that build), so a regression that matches only
// `OPS.rect` fails these checks instead of silently dropping every `re` wall.
const OPS = {
  setLineWidth: 1, setStrokeRGBColor: 2, setStrokeGray: 3, constructPath: 4,
  moveTo: 10, lineTo: 11, curveTo: 12, curveTo2: 13, curveTo3: 14, rectangle: 19, closePath: 16,
  save: 20, restore: 21, transform: 22, paintFormXObjectBegin: 23, paintFormXObjectEnd: 24,
};
{
  const fnArray = [OPS.setLineWidth, OPS.setStrokeRGBColor, OPS.constructPath, OPS.constructPath];
  const argsArray = [[1], [136, 136, 136],
    [[OPS.moveTo, OPS.lineTo], [0, 0, 10, 0]],
    [[OPS.rectangle], [0, 0, 4, 4]]];
  const { segments, styled } = segmentsFromOperatorList(fnArray, argsArray, OPS, [1, 0, 0, 1, 0, 0]);
  ok('a line path becomes one segment', segments.length === 5, `${segments.length} segments (1 line + 4 rect sides)`);
  ok('a rect path becomes its four sides', segments.filter((s) => s.x1 === 0 || s.x2 === 0 || s.y1 === 0 || s.y2 === 0).length >= 1);
  // The rect is emitted as FOUR numbers (x, y, w, h); a naive rename that read eight would push NaN.
  const rectSides = segments.slice(1);
  ok('the four sides of a 4x4 rect are read from its 4 numbers, with no NaN',
    rectSides.length === 4
      && rectSides.every((s) => [s.x1, s.y1, s.x2, s.y2].every(Number.isFinite))
      && rectSides.some((s) => s.x1 === 0 && s.y1 === 0 && s.x2 === 4 && s.y2 === 0)
      && rectSides.some((s) => s.x1 === 4 && s.y1 === 4 && s.x2 === 0 && s.y2 === 4),
    rectSides.map((s) => `${s.x1},${s.y1}->${s.x2},${s.y2}`).join(' '));
  ok('each segment remembers the line class it was drawn with',
    segments.every((s) => s.width === 1 && s.color && s.color[0] === 136), `${styled} styled`);
  const moved = segmentsFromOperatorList([OPS.constructPath], [[[OPS.moveTo, OPS.lineTo], [1, 2, 3, 4]]], OPS, [1, 0, 0, 1, 10, 20]);
  ok('the page matrix is applied to every point',
    moved.segments[0].x1 === 11 && moved.segments[0].y1 === 22, `start ${moved.segments[0].x1},${moved.segments[0].y1}`);
  // A CAD sheet places its content with transforms: the running matrix must be tracked, and restored.
  const shifted = segmentsFromOperatorList(
    [OPS.save, OPS.transform, OPS.constructPath, OPS.restore, OPS.constructPath],
    [[], [1, 0, 0, 1, 100, 50], [[OPS.moveTo, OPS.lineTo], [0, 0, 10, 0]], [], [[OPS.moveTo, OPS.lineTo], [0, 0, 10, 0]]],
    OPS, [1, 0, 0, 1, 0, 0]);
  ok('a transform is tracked and applied to the path inside it',
    shifted.segments[0].x1 === 100 && shifted.segments[0].y1 === 50 && shifted.segments[0].x2 === 110,
    `${shifted.segments[0].x1},${shifted.segments[0].y1} -> ${shifted.segments[0].x2},${shifted.segments[0].y2}`);
  ok('and restore puts the matrix back for the next path',
    shifted.segments[1].x1 === 0 && shifted.segments[1].y1 === 0,
    `${shifted.segments[1].x1},${shifted.segments[1].y1}`);
}
{
  const segs = [
    { x1: 0, y1: 0, x2: 1, y2: 0, width: 1, color: [136, 136, 136] },
    { x1: 0, y1: 1, x2: 1, y2: 1, width: 1, color: [136, 136, 136] },
    { x1: 0, y1: 2, x2: 1, y2: 2, width: 2.5, color: [0, 0, 0] },
  ];
  const key = dominantStyle(segs);
  ok('the plan\u2019s own line class is found as the most common one', key === '1|136,136,136', key);
  ok('filtering keeps only that class', filterByStyle(segs, key).length === 2);
}

// ------------------------------------------------------------------ a rect-only wall set
{
  // A wall drawing whose ONLY linework is one PDF `re` rectangle for the room boundary: before the fix
  // every `re` op was dropped in the vendored pdf.js (OPS.rect is undefined), so this page produced 0
  // segments and no outline. It must now produce the four edges and trace the room.
  const side = sideFor(25);
  const fnArray = [OPS.setLineWidth, OPS.setStrokeGray, OPS.constructPath];
  const argsArray = [[1], [0.5], [[OPS.rectangle], [10, 20, side, side]]];
  const { segments } = segmentsFromOperatorList(fnArray, argsArray, OPS, [1, 0, 0, 1, 0, 0]);
  ok('a rect-only wall set produces segments (not 0)', segments.length === 4,
    `${segments.length} segment(s) from one re op`);
  ok('no segment from the rect carries a NaN', segments.every((s) => [s.x1, s.y1, s.x2, s.y2].every(Number.isFinite)));
  const out = traceRooms({
    segments, box: box(200, 200), denom: DENOM, pxPerPt: 2, thickness: 2,
    rooms: [{ id: 'r', name: 'OFFICE', area: 25, at: { x: 10 + side / 2, y: 20 + side / 2 } }],
  });
  ok('the rect-only room traces to a sane, accepted outline',
    out.stats.accepted === 1 && out.results[0].ok && out.results[0].tracedM2 > 0 && Number.isFinite(out.results[0].tracedM2),
    `accepted ${out.stats.accepted}, traced ${out.results[0].tracedM2 && out.results[0].tracedM2.toFixed(2)} m²`);
}

// ------------------------------------------------------------------ raster + regions
{
  const side = sideFor(25);                       // a 5 x 5 m room
  const rast = rasterizeWalls(roomWalls(10, 20, side), box(200, 200), 2, 2);
  ok('walls land on the raster', rast.grid.includes(1), `${rast.w}x${rast.h}, ${rast.grid.filter(Boolean).length} wall pixels`);
  const c = pointToCell(10 + side / 2, 20 + side / 2, box(200, 200), 2);
  const region = regionAt(rast.grid, rast.w, rast.h, c.cx, c.cy);
  ok('the inside of the room is one enclosed region', !!region && region.areaPx > 100, `${region && region.areaPx} cells`);
  const back = cellToPoint(c.cx, c.cy, box(200, 200), 2);
  ok('raster cells convert back to the same point', near(back.x, 10 + side / 2, 0.5) && near(back.y, 20 + side / 2, 0.5));
}
{
  // two rooms joined by a DOOR GAP: free space leaks through, and that must be detectable
  const side = sideFor(20);
  const wall = roomWalls(10, 20, side);
  const wall2 = roomWalls(10 + side + 15, 20, side);         // a second room, 15 pt away
  // connect them through the 15 pt gap in the middle: a shared opening in both inner walls
  const joined = wall.filter((s) => !(s.x1 === 10 + side && s.y1 === 20)).concat(wall2);
  const rast = rasterizeWalls(joined, box(400, 400), 2, 2);
  const a = pointToCell(10 + side / 2, 20 + side / 2, box(400, 400), 2);
  const b = pointToCell(10 + side + 15 + side / 2, 20 + side / 2, box(400, 400), 2);
  const ra = regionAt(rast.grid, rast.w, rast.h, a.cx, a.cy);
  const rb = regionAt(rast.grid, rast.w, rast.h, b.cx, b.cy);
  ok('a wall with an opening does not enclose its room (the measure is honest about leaks)',
    !!ra && !!rb && (ra.areaPx !== rb.areaPx || !regionHasCell(rb, a.cx, a.cy, rast.w)),
    ra && rb ? `regions of ${ra.areaPx} and ${rb.areaPx} cells` : 'no region');
}
{
  const side = sideFor(16);
  const rast = rasterizeWalls(roomWalls(10, 10, side), box(200, 200), 2, 2);
  const onWall = pointToCell(10, 10, box(200, 200), 2);      // exactly on the corner
  ok('a name sitting on a wall line yields no region', regionAt(rast.grid, rast.w, rast.h, onWall.cx, onWall.cy) === null);
  ok('a point outside the page yields no region', regionAt(rast.grid, rast.w, rast.h, -5, 0) === null);
}

// ------------------------------------------------------------------ outline + area
{
  const side = sideFor(25);
  const rast = rasterizeWalls(roomWalls(10, 20, side), box(200, 200), 2, 2);
  const c = pointToCell(10 + side / 2, 20 + side / 2, box(200, 200), 2);
  const region = regionAt(rast.grid, rast.w, rast.h, c.cx, c.cy);
  const rings = outlineFromRegion(region, rast.w, box(200, 200), 2);
  ok('the region traces to a closed outline', rings.length === 1 && rings[0].length >= 4,
    `${rings.length} ring(s), ${rings[0] ? rings[0].length : 0} corners`);
  const cellAreaPt2 = 1 / (2 * 2);                            // one cell = 1/(pxPerPt^2) pt^2
  const outlined = outlineAreaPt2(rings);
  ok('the outline covers the region it came from',
    near(outlined, region.areaPx * cellAreaPt2, region.areaPx * cellAreaPt2 * 0.06),
    `${outlined.toFixed(1)} pt² vs ${(region.areaPx * cellAreaPt2).toFixed(1)} pt² of cells`);
  const m2 = pt2ToM2(outlined, DENOM);
  ok('and its area is the room\u2019s real area, within the wall thickness',
    near(m2, 25, 2.5), `${m2.toFixed(2)} m² traced against 25.00 m² stated`);
  const exactSide = (25 / (MPP * MPP)) ** 0.5;      // the side a 25 m² square must have
  ok('a square of that side is exactly 25 m² at 1:100',
    near(pt2ToM2(exactSide * exactSide, 100), 25, 1e-9), `${pt2ToM2(exactSide * exactSide, 100)} m²`);
  ok('the scale factor is right', near(MPP, 0.0352778, 1e-6), `${MPP} m per point at 1:100`);
}
{
  const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  ok('polygon area is the shoelace area', polygonAreaPt2(tri) === 50, `${polygonAreaPt2(tri)} pt²`);
}

// ------------------------------------------------------------------ the accept decision
{
  const yes = judgeTrace(25, 25, 1);
  ok('a traced area matching the stated one is accepted', yes.ok);
  ok('an accepted verdict carries no refusal code', yes.code === null, `code ${yes.code}`);
  ok('a trace 9% larger (wall centrelines) is accepted', judgeTrace(27.25, 25, 1).ok, `ratio ${judgeTrace(27.25, 25, 1).ratio.toFixed(2)}`);
  const low = judgeTrace(19, 25, 1);
  ok('a trace 24% smaller is refused', !low.ok, low.reason);
  ok('a too-small trace is refused with the area-mismatch code', low.code === 'area-mismatch', `code ${low.code}`);
  const high = judgeTrace(40, 25, 1);
  ok('a trace 60% larger is refused', !high.ok, high.reason);
  ok('a too-large trace is refused with the area-mismatch code', high.code === 'area-mismatch', `code ${high.code}`);
  const shared = judgeTrace(25, 25, 2);
  ok('a region shared with another room is refused outright', !shared.ok, shared.reason);
  ok('a shared region is refused with the shared code', shared.code === 'shared', `code ${shared.code}`);
  ok('the band is an asymmetric window', TRACE_BAND.lo === 0.8 && TRACE_BAND.hi === 1.35);
  const noArea = judgeTrace(25, 0, 1);
  ok('a room with no stated area is refused', !noArea.ok);
  ok('a room with no stated area is refused with the no-area code', noArea.code === 'no-area', `code ${noArea.code}`);
}

// ------------------------------------------------------------------ the whole job for one page
{
  const side = sideFor(25);
  const rooms = [
    { id: 'a', name: 'OFFICE', area: 25, at: { x: 10 + side / 2, y: 20 + side / 2 } },   // clean room
    { id: 'b', name: 'STORE', area: 25, at: { x: 10 + side + 40, y: 20 + side / 2 } },   // on empty paper
    { id: 'c', name: 'WC', area: 25, at: { x: 10, y: 20 } },                             // on a wall line
  ];
  const out = traceRooms({ segments: roomWalls(10, 20, side), box: box(400, 400), rooms, denom: DENOM, pxPerPt: 2, thickness: 2 });
  const by = Object.fromEntries(out.results.map((r) => [r.id, r]));
  ok('the one room the plan actually encloses is accepted', by.a.ok, `${by.a.tracedM2 && by.a.tracedM2.toFixed(2)} m², ratio ${by.a.ratio && by.a.ratio.toFixed(2)}`);
  ok('a room with no enclosed area is refused with a plain reason', !by.b.ok, by.b.reason);
  ok('a label on empty paper is refused with the too-big code (an open area)', by.b.code === 'too-big', `code ${by.b.code}`);
  ok('a name sitting on a wall is refused', !by.c.ok, by.c.reason);
  ok('a name on a wall line also carries the no-region code', by.c.code === 'no-region', `code ${by.c.code}`);
  ok('an accepted room carries no refusal code', by.a.code === null, `code ${by.a.code}`);
  ok('an accepted room carries its outline', by.a.rings.length === 1 && by.a.rings[0].length >= 4);
  ok('a refused room carries no outline', by.b.rings.length === 0 && by.c.rings.length === 0);
  ok('the stats say what happened', out.stats.accepted === 1 && out.stats.labels === 3,
    JSON.stringify(out.stats));
}
{
  // a leak: two labels in one big region -> BOTH refused, even before the area test
  const side = sideFor(30);
  const rooms = [
    { id: 'a', name: 'A', area: 30, at: { x: 12, y: 30 } },
    { id: 'b', name: 'B', area: 30, at: { x: 18, y: 30 } },
  ];
  const out = traceRooms({ segments: roomWalls(10, 20, side), box: box(400, 400), rooms, denom: DENOM, pxPerPt: 2, thickness: 2 });
  const accepted = out.results.filter((r) => r.ok);
  ok('two names inside one enclosed area are both refused', accepted.length === 0,
    out.results.map((r) => `${r.id}: ${r.reason}`).join(' | '));
  ok('and both are refused with the shared code',
    out.results.every((r) => r.code === 'shared'), out.results.map((r) => `${r.id}:${r.code}`).join(', '));
}

// ------------------------------------------------------------------ choosing the plan's lines, and the scale
{
  const side = sideFor(25);
  const rooms = [{ id: 'a', area: 25, at: { x: 10 + side / 2, y: 20 + side / 2 } }];
  // a NOISY sheet: the wall class is outnumbered by symbol-like short segments scattered about
  const walls = roomWalls(10, 20, side);
  const noise = [];
  for (let i = 0; i < 400; i += 1) {
    noise.push({ x1: 300 + (i % 20) * 3, y1: 300 + Math.floor(i / 20) * 3, x2: 302.5 + (i % 20) * 3, y2: 300 + Math.floor(i / 20) * 3, width: 2.5, color: [0, 0, 0] });
  }
  const picked = traceRooms({ segments: walls.concat(noise), box: box(600, 600), rooms, denom: DENOM, pxPerPt: 2, thickness: 2 });
  ok('all lines together still trace the one enclosed room', picked.stats.accepted === 1, JSON.stringify(picked.stats));
  const choose = pickWallLines(walls.concat(noise), { box: box(600, 600), rooms, denom: DENOM, pxPerPt: 2, thickness: 2 });
  ok('the wall lines are chosen by RESULT, not by how many segments they have',
    choose.key === '1|136,136,136' && choose.stats.accepted === 1,
    `chose "${choose.key}" (${choose.tried.map((t) => `${t.key}=${t.accepted}`).join(', ')})`);
  ok('it reports what it tried', choose.tried.length >= 2 && choose.tried.some((t) => t.key === 'all lines'));
}
{
  const scale = impliedDenom([
    { tracedM2: 39.0625, statedM2: 25 },     // a room measured 1.25x too big at the scale in use
    { tracedM2: 39.0625, statedM2: 25 },
    { tracedM2: 0, statedM2: 25 },           // never reached: ignored
  ], 250);
  ok('the outlines tell you what scale they imply', scale.denom === 200 && scale.n === 2,
    `implied 1:${scale.denom} from ${scale.n} room(s)`);
  ok('no reached rooms means no scale claim', impliedDenom([{ tracedM2: 0, statedM2: 10 }], 100).denom === null);
}
{
  // an open area far bigger than any room must be refused, and fast
  const huge = sideFor(10000);                 // 100 m x 100 m of enclosed space
  const rooms = [{ id: 'a', area: 25, at: { x: 10 + huge / 2, y: 10 + huge / 2 } }];
  const t0 = Date.now();
  const out = traceRooms({ segments: roomWalls(10, 10, huge), box: box(huge + 40, huge + 40), rooms, denom: DENOM, pxPerPt: 2, thickness: 2 });
  const ms = Date.now() - t0;
  ok('space far larger than any room is refused with a clear reason',
    out.stats.accepted === 0 && /far larger/.test(out.results[0].reason),
    `${out.results[0].reason} (${ms} ms)`);
  ok('and it is refused with the too-big code', out.results[0].code === 'too-big', `code ${out.results[0].code}`);
  ok('and the flood fill does not run away across it', ms < 4000, `${ms} ms`);
}

console.log(`\n${pass}/${pass + fail} trace checks passed`);
if (!process.exitCode) console.log('ALL TRACE CHECKS PASSED');

// js/splitregion.js — the seeded-watershed region splitter and its neck safety test.
// Run: node tests/test-splitregion.mjs
//
// Small synthetic rasters, built directly (no PDF), assert the ONE thing the module promises: a
// region that contains several names is split into one sub-region per name ONLY where the cut is a
// narrow neck (a door / a normal opening), and everything else is refused with the 'open-plan' code
// so a wrong area is never produced. Plus determinism.
import { splitRegion, acceptedParts, NECK_MAX_M, OPEN_PLAN_CODE, OPEN_PLAN_REASON } from '../js/splitregion.js';
import { traceRegions, metresPerPt } from '../js/trace.js';
import { matchRoomsToRegions } from '../js/autotrace.js';

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? '  — ' + detail : ''}`); process.exitCode = 1; }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const DENOM = 100, PX = 1;
const CELL_M = metresPerPt(DENOM) / PX;              // metres per raster cell

/**
 * A raster with two rooms side by side, separated by a 1-cell wall that has a door gap of
 * `doorCells` cells. The whole free space is ONE connected region (the door joins the rooms).
 */
function twoRoomGrid({ doorCells, w = 402, h = 200, wallX = 200 }) {
  const wall = new Uint8Array(w * h);
  for (let x = 0; x < w; x += 1) { wall[x] = 1; wall[(h - 1) * w + x] = 1; }
  for (let y = 0; y < h; y += 1) { wall[y * w] = 1; wall[y * w + (w - 1)] = 1; }
  const cy = Math.floor(h / 2), half = Math.floor(doorCells / 2);
  for (let y = 0; y < h; y += 1) if (Math.abs(y - cy) > half) wall[y * w + wallX] = 1;
  const cells = [];
  for (let i = 0; i < w * h; i += 1) if (!wall[i]) cells.push(i);
  return { w, h, cells };
}
const doorCellsFor = (metres) => Math.round(metres / CELL_M);

const box = (w, h) => ({ x0: 0, y0: 0, x1: w, y1: h });
const twoRooms = (w, h) => [
  { id: 'A', name: 'OFFICE', at: { x: 100, y: 100 } },
  { id: 'B', name: 'STORE', at: { x: 300, y: 100 } },
];

// ------------------------------------------------------------------ 1. a 1 m door splits cleanly
// A literal 1 m door rasterises to a cut of ~1.02 m, which the module's strict default (1.0 m) is
// deliberately BELOW: on the ground-truth fixture a ~1.06 m watershed cut through open floor is
// indistinguishable from a 1 m door and would be a wrong fill. So this test states the neck it is
// testing; the default's own behaviour on a normal 0.9 m door is checked just below.
{
  const door = doorCellsFor(1.0);                    // ~28 cells = 0.99 m
  const { w, h, cells } = twoRoomGrid({ doorCells: door });
  const rooms = twoRooms(w, h);
  const res = splitRegion({ cells, w, h, box: box(w, h), pxPerPt: PX, denom: DENOM, rooms, neckMaxM: 1.5 });
  ok('a region with two names splits into two sub-regions', !!res && res.parts.length === 2, `${res && res.parts.length} parts`);
  const acc = acceptedParts(res);
  ok('both sub-regions pass the neck safety test', acc.length === 2, JSON.stringify(res.parts.map((p) => `${p.roomId}:${p.accepted}:${p.code}`)));
  const A = res.parts.find((p) => p.roomId === 'A');
  const B = res.parts.find((p) => p.roomId === 'B');
  // Each room is ~199 x 199 cells = 49.3 m2; the cut takes a few door cells from one of them.
  ok('the left room keeps about its own area (~49 m2)', near(A.areaM2, 49.3, 3), `${A.areaM2.toFixed(2)} m2`);
  ok('the right room keeps about its own area (~49 m2)', near(B.areaM2, 49.3, 3), `${B.areaM2.toFixed(2)} m2`);
  ok('the two sub-regions add up to the whole region', Math.abs(A.areaM2 + B.areaM2 - (w * h - (2 * w + 2 * h - 4) - door * 1) * CELL_M * CELL_M) < 6,
    `${(A.areaM2 + B.areaM2).toFixed(2)} m2`);
  ok('the cut is the ~1 m doorway, well under NECK_MAX_M', A.cuts.length === 1 && A.cuts[0].metres > 0.8 && A.cuts[0].metres < 1.2,
    JSON.stringify(A.cuts.map((c) => `${c.metres.toFixed(3)} m`)));
  ok('the boundary is between the two rooms, not in the middle of one', A.cuts[0].label === B.label);
}

// ------------------------------------------------------------------ 1b. the DEFAULT neck on a 0.9 m door
{
  const { w, h, cells } = twoRoomGrid({ doorCells: doorCellsFor(0.9) });
  const res = splitRegion({ cells, w, h, box: box(w, h), pxPerPt: PX, denom: DENOM, rooms: twoRooms(w, h) });
  ok('a normal 0.9 m door splits at the DEFAULT neck (NECK_MAX_M = 1.0 m)', acceptedParts(res).length === 2,
    `NECK_MAX_M=${NECK_MAX_M}, cuts ${JSON.stringify(res.parts.map((p) => p.cuts.map((c) => +c.metres.toFixed(3))))}`);
}

// ------------------------------------------------------------------ 2. a 6 m opening is refused
{
  const door = doorCellsFor(6.0);                    // ~170 cells = 6.0 m
  const { w, h, cells } = twoRoomGrid({ doorCells: door });
  const rooms = twoRooms(w, h);
  const res = splitRegion({ cells, w, h, box: box(w, h), pxPerPt: PX, denom: DENOM, rooms });
  ok('two zones joined by a 6 m opening yield NO accepted sub-region', acceptedParts(res).length === 0,
    JSON.stringify(res.parts.map((p) => `${p.roomId}:${p.code}`)));
  ok('every refused sub-region carries the open-plan code', res.parts.every((p) => p.code === OPEN_PLAN_CODE));
  ok('the refusal explains the wide edge in plain English', res.parts.every((p) => p.reason === OPEN_PLAN_REASON), res.parts[0].reason);
  ok('the measured cut really is the wide opening (> 2 m)', res.parts.every((p) => p.cuts.some((c) => c.metres > NECK_MAX_M)));
}

// ------------------------------------------------------------------ 3. the neck threshold is the only switch
{
  const { w, h, cells } = twoRoomGrid({ doorCells: doorCellsFor(1.0) });
  const rooms = twoRooms(w, h);
  const strict = splitRegion({ cells, w, h, box: box(w, h), pxPerPt: PX, denom: DENOM, rooms, neckMaxM: 0.5 });
  ok('a 1 m door is refused when NECK_MAX_M is tightened below it', acceptedParts(strict).length === 0);
  const loose = splitRegion({ cells, w, h, box: box(w, h), pxPerPt: PX, denom: DENOM, rooms, neckMaxM: 3.0 });
  ok('and accepted when NECK_MAX_M is loosened above it', acceptedParts(loose).length === 2);
}

// ------------------------------------------------------------------ 4. stairwells are refused
{
  const { w, h, cells } = twoRoomGrid({ doorCells: doorCellsFor(1.0) });
  const rooms = [{ id: 'A', name: 'STAIRWELL', at: { x: 100, y: 100 } }, { id: 'B', name: 'STORE', at: { x: 300, y: 100 } }];
  const res = splitRegion({ cells, w, h, box: box(w, h), pxPerPt: PX, denom: DENOM, rooms });
  const stair = res.parts.find((p) => p.roomId === 'A');
  ok('a stairwell sub-region is never accepted', stair && !stair.accepted, stair && stair.code);
}

// ------------------------------------------------------------------ 5. a bad band is refused
{
  const { w, h, cells } = twoRoomGrid({ doorCells: doorCellsFor(1.0) });
  const rooms = twoRooms(w, h);
  const res = splitRegion({ cells, w, h, box: box(w, h), pxPerPt: PX, denom: DENOM, rooms, minAreaM2: 60 });
  ok('a sub-region under the area band is refused', acceptedParts(res).length === 0);
}

// ------------------------------------------------------------------ 6. determinism
{
  const { w, h, cells } = twoRoomGrid({ doorCells: doorCellsFor(1.0) });
  const args = { cells, w, h, box: box(w, h), pxPerPt: PX, denom: DENOM, rooms: twoRooms(w, h) };
  ok('the same input gives byte-identical output twice', JSON.stringify(splitRegion(args)) === JSON.stringify(splitRegion(args)));
  ok('splitRegion never mutates its input cells', cells.length === splitRegion(args).parts.reduce((s, p) => s + p.cells.length, 0));
}

// ------------------------------------------------------------------ 7. integration: traceRegions + matchRoomsToRegions
{
  const MPP = metresPerPt(DENOM);
  const side = 4 / MPP;                              // a 4 m x 4 m room, in points
  const doorPt = 1 / MPP;                            // a 1 m door
  const segs = [];
  const push = (x1, y1, x2, y2) => segs.push({ x1, y1, x2, y2, width: 1, color: [136, 136, 136] });
  const x = 10, y = 20;
  push(x, y, x + 2 * side, y);
  push(x + 2 * side, y, x + 2 * side, y + side);
  push(x + 2 * side, y + side, x, y + side);
  push(x, y + side, x, y);
  const mx = x + side;
  push(mx, y, mx, y + (side - doorPt) / 2);
  push(mx, y + (side + doorPt) / 2, mx, y + side);
  const b = { x0: 0, y0: 0, x1: 2 * side + 40, y1: side + 40 };
  const rooms = [
    { id: 'L', name: 'OFFICE', at: { x: x + side / 2, y: y + side / 2 } },
    { id: 'R', name: 'STORE', at: { x: x + side + side / 2, y: y + side / 2 } },
  ];
  const base = { segments: segs, box: b, rooms, denom: DENOM, pxPerPt: 2, thickness: 2, closeGaps: 6 };

  const off = matchRoomsToRegions({ rooms, regions: traceRegions(base).regions });
  ok('splitShared OFF: the two door-joined rooms are one shared outline, neither filled',
    off.assignments.length === 0, JSON.stringify(off.stats.roomReasons));

  const on = matchRoomsToRegions({ rooms, regions: traceRegions({ ...base, splitShared: true, neckMaxM: 1.5 }).regions });
  ok('splitShared ON: both rooms are filled', on.assignments.length === 2, JSON.stringify(on.stats.roomReasons));
  ok('both filled areas are the real 4x4 m rooms', on.assignments.every((a) => near(a.areaM2, 16, 2.5)),
    on.assignments.map((a) => `${a.name} ${a.areaM2}`).join(', '));
  ok('each assignment is marked source:split', on.assignments.every((a) => a.source === 'split'),
    JSON.stringify(on.assignments.map((a) => a.source)));

  // A single-label region is untouched: the default output is byte-identical.
  const oneSeg = [];
  {
    const p = (x1, y1, x2, y2) => oneSeg.push({ x1, y1, x2, y2, width: 1, color: [136, 136, 136] });
    const s2 = 5 / MPP, ox = 10, oy = 20;
    p(ox, oy, ox + s2, oy); p(ox + s2, oy, ox + s2, oy + s2); p(ox + s2, oy + s2, ox, oy + s2); p(ox, oy + s2, ox, oy);
  }
  const oneRoom = [{ id: 'X', name: 'PLANT', at: { x: 10 + (5 / MPP) / 2, y: 20 + (5 / MPP) / 2 } }];
  const p1 = { segments: oneSeg, box: { x0: 0, y0: 0, x1: 200, y1: 200 }, rooms: oneRoom, denom: DENOM, pxPerPt: 2, thickness: 2 };
  const a = traceRegions(p1).regions, c = traceRegions({ ...p1, splitShared: true }).regions;
  ok('a single-name region is emitted byte-identically with splitShared on', JSON.stringify(a) === JSON.stringify(c));
  ok('the whole traceRegions result (incl. stats) is byte-identical with splitShared off/false',
    JSON.stringify(traceRegions(p1)) === JSON.stringify(traceRegions({ ...p1, splitShared: false })));
}

// ------------------------------------------------------------------ helpers for a plan raster
/** A rectangular raster with straight walls; each wall may carry one centered door gap (cells). */
function planGrid({ w, h, vwalls = [], hwalls = [] }) {
  const wall = new Uint8Array(w * h);
  for (let x = 0; x < w; x += 1) { wall[x] = 1; wall[(h - 1) * w + x] = 1; }
  for (let y = 0; y < h; y += 1) { wall[y * w] = 1; wall[y * w + (w - 1)] = 1; }
  for (const v of vwalls) for (let y = 0; y < h; y += 1) if (!(v.gap && y >= v.gap[0] && y <= v.gap[1])) wall[y * w + v.x] = 1;
  for (const hw of hwalls) for (let x = 0; x < w; x += 1) if (!(hw.gap && x >= hw.gap[0] && x <= hw.gap[1])) wall[hw.y * w + x] = 1;
  const cells = [];
  for (let i = 0; i < w * h; i += 1) if (!wall[i]) cells.push(i);
  return { w, h, cells };
}
const gap = (center, cellCount) => [center - Math.floor(cellCount / 2), center + Math.floor(cellCount / 2)];
const DOOR = doorCellsFor(0.9);

// ------------------------------------------------------------------ 8. a nameless HALL between two named rooms
// A | 0.9 m door | HALL | 0.9 m door | B, in a row, only A and B named. The hall belongs to nobody: A
// and B must come back with their OWN areas, not room + half the hall.
{
  const AW = 85, HW = 71, HH = 170;                 // 3 m x 6 m rooms, a 2.5 m x 6 m hall (cells)
  const w = 4 + 2 * AW + HW, h = HH + 2;
  const xA = 1, wallA = xA + AW, xHall = wallA + 1, wallB = xHall + HW, xB = wallB + 1;
  const cy = Math.floor(h / 2);
  const grid = planGrid({ w, h, vwalls: [{ x: wallA, gap: gap(cy, DOOR) }, { x: wallB, gap: gap(cy, DOOR) }] });
  const rooms = [
    { id: 'A', name: 'OFFICE', at: { x: xA + Math.floor(AW / 2), y: cy } },
    { id: 'B', name: 'STORE', at: { x: xB + Math.floor(AW / 2), y: cy } },
  ];
  const truth = AW * HH * CELL_M * CELL_M;
  const res = splitRegion({ cells: grid.cells, w, h, box: box(w, h), pxPerPt: PX, denom: DENOM, rooms });
  const A = res && res.parts.find((p) => p.roomId === 'A');
  const B = res && res.parts.find((p) => p.roomId === 'B');
  ok('hall row: both named rooms come back as accepted sub-regions', acceptedParts(res).length === 2,
    JSON.stringify(res.parts.map((p) => `${p.roomId}:${p.accepted}:${p.code}`)));
  ok('hall row: A keeps its own 3x6 m room (within 10%)', A && near(A.areaM2, truth, 0.1 * truth), A && `${A.areaM2.toFixed(2)} vs ${truth.toFixed(2)} m2`);
  ok('hall row: B keeps its own 3x6 m room (within 10%)', B && near(B.areaM2, truth, 0.1 * truth), B && `${B.areaM2.toFixed(2)} vs ${truth.toFixed(2)} m2`);
  ok('hall row: the hall is assigned to nobody (A+B do not grow by it)',
    A && B && (A.areaM2 + B.areaM2) < 2 * truth * 1.05, A && (A.areaM2 + B.areaM2).toFixed(2));
  ok('hall row: neither sub-region reaches across the hall into the other room',
    A && B && (A.bbox.x1 - A.bbox.x0) <= AW + 6 && (B.bbox.x1 - B.bbox.x0) <= AW + 6,
    A && `${A.bbox.x1 - A.bbox.x0}, ${B.bbox.x1 - B.bbox.x0} cells wide`);
}

// ------------------------------------------------------------------ 9. a wardrobe strip behind a 0.9 m opening
// A named 4x4 m room with an UNNAMED wardrobe strip hanging off it behind a 0.9 m opening, and a
// second named room below. The room's area must exclude the strip. (A space can only be separated
// when it is wider than the opening radius ~NECK_MAX_M/2 either side, so the strip here is 2 m.)
{
  const RA = 113, SW = 57;                           // 4 m room, 2 m-wide strip (cells)
  const w = 4 + RA + SW, h = 3 + 2 * RA;
  const wallV = 1 + RA, xS = wallV + 1, wallH = 1 + RA;
  const cy = Math.floor((1 + RA) / 2), cx = Math.floor((1 + RA) / 2);
  const grid = planGrid({ w, h, vwalls: [{ x: wallV, gap: gap(cy, DOOR) }], hwalls: [{ y: wallH, gap: gap(cx, DOOR) }] });
  const rooms = [
    { id: 'A', name: 'BED ROOM', at: { x: cx, y: cy } },
    { id: 'B', name: 'STORE', at: { x: cx, y: wallH + 1 + Math.floor(RA / 2) } },
  ];
  const roomTruth = RA * RA * CELL_M * CELL_M;
  const stripTruth = SW * RA * CELL_M * CELL_M;
  const res = splitRegion({ cells: grid.cells, w, h, box: box(w, h), pxPerPt: PX, denom: DENOM, rooms });
  const A = res && res.parts.find((p) => p.roomId === 'A');
  ok('wardrobe strip: the named room is accepted', !!A && A.accepted, A && `${A.areaM2.toFixed(2)} m2 code=${A.code}`);
  ok('wardrobe strip: the room area excludes the strip (within 10% of the room alone)',
    A && near(A.areaM2, roomTruth, 0.1 * roomTruth), A && `${A.areaM2.toFixed(2)} vs ${roomTruth.toFixed(2)} m2 (strip alone ${stripTruth.toFixed(2)})`);
  ok('wardrobe strip: the room does not grow a lobe into the strip', A && A.areaM2 < roomTruth + stripTruth * 0.5,
    A && `${A.areaM2.toFixed(2)} < ${(roomTruth + stripTruth * 0.5).toFixed(2)} m2`);
}

// ------------------------------------------------------------------ 10. determinism of the unnamed-space trim
{
  const AW = 85, HW = 71, HH = 170;
  const w = 4 + 2 * AW + HW, h = HH + 2;
  const xA = 1, wallA = xA + AW, xHall = wallA + 1, wallB = xHall + HW, xB = wallB + 1;
  const cy = Math.floor(h / 2);
  const grid = planGrid({ w, h, vwalls: [{ x: wallA, gap: gap(cy, DOOR) }, { x: wallB, gap: gap(cy, DOOR) }] });
  const rooms = [
    { id: 'A', name: 'OFFICE', at: { x: xA + Math.floor(AW / 2), y: cy } },
    { id: 'B', name: 'STORE', at: { x: xB + Math.floor(AW / 2), y: cy } },
  ];
  const args = { cells: grid.cells, w, h, box: box(w, h), pxPerPt: PX, denom: DENOM, rooms };
  const snapshot = grid.cells.slice();
  splitRegion(args);
  ok('the unnamed-space trim is byte-identical twice', JSON.stringify(splitRegion(args)) === JSON.stringify(splitRegion(args)));
  ok('the unnamed-space trim never mutates the input cells',
    snapshot.length === grid.cells.length && snapshot.every((v, i) => v === grid.cells[i]),
    `${grid.cells.length} cells unchanged`);
}

console.log(`\n${pass}/${pass + fail} splitregion checks passed`);
if (fail) { console.log('SOME SPLITREGION CHECKS FAILED'); process.exit(1); }
console.log('ALL SPLITREGION CHECKS PASSED');
// js/autotrace.js — the conservative room<->region matcher.
// Run: node tests/test-autotrace.mjs
//
// Every case builds a tiny synthetic sheet in PDF space (y up, points) and asserts the ONE thing
// the module promises: an area is filled in only when the match is unambiguous, and every skip
// carries the right stable code and plain-English reason.
import {
  matchRoomsToRegions, isStairwellName, pointInRegion, ringsOverlap,
  CODES, REASON_LABEL, MIN_AREA_M2, MAX_AREA_M2,
} from '../js/autotrace.js';
import { traceRegions } from '../js/trace.js';

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? '  — ' + detail : ''}`); process.exitCode = 1; }
};

/** A closed square ring in PDF space. */
const sq = (x, y, s) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
const region = (id, rings, extra = {}) => ({ id, rings, closed: true, ...extra });
const room = (id, name, x, y, extra = {}) =>
  ({ id, name, at: { x, y }, area: null, areaUnknown: true, include: false, ...extra });

/** The skip entry for one room id. */
const roomSkip = (out, id) => out.skipped.find((s) => s.kind === 'room' && s.id === id);
const regionSkip = (out, id) => out.skipped.find((s) => s.kind === 'region' && s.id === id);

// ------------------------------------------------------------------ 1. the happy path
{
  const out = matchRoomsToRegions({
    rooms: [room('a1', 'OFFICE', 5, 5)],
    regions: [region('r1', [sq(0, 0, 10)], { areaM2: 100 })],
  });
  ok('a square region holding exactly one name is assigned', out.assignments.length === 1, JSON.stringify(out.assignments));
  ok('the region area is assigned exactly', out.assignments[0] && out.assignments[0].areaM2 === 100, `area ${out.assignments[0] && out.assignments[0].areaM2}`);
  ok('the assignment names the room and the region', out.assignments[0] && out.assignments[0].roomId === 'a1' && out.assignments[0].regionId === 'r1');
  ok('nothing is skipped', out.skipped.length === 0, JSON.stringify(out.skipped));
  ok('stats: 1 room, 1 region, 1 assigned, 0 need attention',
    out.stats.assignedRooms === 1 && out.stats.assignedRegions === 1 && out.stats.needAttention === 0);
}

// ------------------------------------------------------------------ 2. two names in one region
{
  const out = matchRoomsToRegions({
    rooms: [room('a1', 'OFFICE', 3, 5), room('a2', 'STORE', 7, 5)],
    regions: [region('r1', [sq(0, 0, 10)], { areaM2: 100 })],
  });
  ok('a region holding two names assigns NEITHER room', out.assignments.length === 0);
  const s1 = roomSkip(out, 'a1'), s2 = roomSkip(out, 'a2');
  ok('both rooms get the shared-outline reason', s1 && s2 && s1.code === CODES.shared && s2.code === CODES.shared,
    `${s1 && s1.code} / ${s2 && s2.code}`);
  ok('the reason says how many names are in the outline', s1 && /contains 2 room names/.test(s1.reason), s1 && s1.reason);
  ok('the region itself is skipped as shared', (regionSkip(out, 'r1') || {}).code === CODES.shared);
  ok('stats count 2 shared rooms', out.stats.roomReasons[CODES.shared] === 2, JSON.stringify(out.stats.roomReasons));
}

// ------------------------------------------------------------------ 3. a name outside every region
{
  const out = matchRoomsToRegions({
    rooms: [room('a1', 'OFFICE', 50, 50)],
    regions: [region('r1', [sq(0, 0, 10)], { areaM2: 100 })],
  });
  ok('a name outside every region is not assigned', out.assignments.length === 0);
  const s = roomSkip(out, 'a1');
  ok('it is skipped with the no-outline reason', s && s.code === CODES.noOutline && s.reason === 'no traced outline contains this name', s && s.reason);
  ok('the unused region is skipped as having no name', (regionSkip(out, 'r1') || {}).code === CODES.unused);
}

// ------------------------------------------------------------------ 4. an unclosed outline
{
  const out = matchRoomsToRegions({
    rooms: [room('a1', 'OFFICE', 5, 5)],
    regions: [region('r1', [sq(0, 0, 10)], { areaM2: 100, closed: false })],
  });
  ok('an unclosed region assigns nothing', out.assignments.length === 0);
  const s = roomSkip(out, 'a1');
  ok('the room is skipped because the outline is not closed', s && s.code === CODES.open && s.reason === 'outline is not closed', s && s.reason);
  ok('the region is skipped for the same reason', (regionSkip(out, 'r1') || {}).code === CODES.open);
}

// ------------------------------------------------------------------ 5. areas out of the sane band
{
  const out = matchRoomsToRegions({
    rooms: [room('a1', 'CUPBOARD', 5, 5), room('a2', 'HALL', 55, 5)],
    regions: [
      region('tiny', [sq(0, 0, 10)], { areaM2: 0.4 }),
      region('huge', [sq(50, 0, 10)], { areaM2: 5000 }),
    ],
  });
  ok('a tiny region (0.4 m2) is not assigned', out.assignments.length === 0);
  const s1 = roomSkip(out, 'a1'), s2 = roomSkip(out, 'a2');
  ok('the tiny region yields the area-looks-wrong reason', s1 && s1.code === CODES.badArea && /0\.4 m2/.test(s1.reason), s1 && s1.reason);
  ok('the huge region yields the area-looks-wrong reason too', s2 && s2.code === CODES.badArea && /5000 m2/.test(s2.reason), s2 && s2.reason);
  ok('both regions are skipped as bad-area',
    (regionSkip(out, 'tiny') || {}).code === CODES.badArea && (regionSkip(out, 'huge') || {}).code === CODES.badArea);
  ok('the band is documented and exported', MIN_AREA_M2 === 2 && MAX_AREA_M2 === 2000);
}

// ------------------------------------------------------------------ 6. stairwells are never conditioned
{
  const stair = room('a1', 'STAIRWELL', 5, 5);
  const out = matchRoomsToRegions({
    rooms: [stair],
    regions: [region('r1', [sq(0, 0, 10)], { areaM2: 100 })],
  });
  ok('isStairwellName catches the stair words but not ordinary rooms',
    isStairwellName('STAIRWELL') && isStairwellName('EXIT STAIR') && isStairwellName('STAIRS')
    && !isStairwellName('OFFICE') && !isStairwellName('MECHANICAL ROOM'));
  ok('a stairwell is never assigned', out.assignments.length === 0);
  const s = roomSkip(out, 'a1');
  ok('it is skipped as a stairwell', s && s.code === CODES.stairwell && s.reason === 'stairwell - never conditioned', s && s.reason);
  ok('the input room is not mutated (include stays false)', stair.include === false && stair.area === null);
  ok('the region is skipped as a stairwell', (regionSkip(out, 'r1') || {}).code === CODES.stairwell);
}

// ------------------------------------------------------------------ 7. a room that already had an area
{
  const existing = room('a1', 'OFFICE', 5, 5, { area: 25, areaUnknown: false, include: true });
  const out = matchRoomsToRegions({
    rooms: [existing],
    regions: [region('r1', [sq(0, 0, 10)], { areaM2: 100 })],
  });
  ok('a room with an area is not re-assigned', out.assignments.length === 0);
  const s = roomSkip(out, 'a1');
  ok('it is skipped as already having an area', s && s.code === CODES.already && s.reason === 'this room already had an area', s && s.reason);
  ok('the room object is untouched', existing.area === 25 && existing.include === true);
  ok('the region is skipped as already-area', (regionSkip(out, 'r1') || {}).code === CODES.already);
}

// ------------------------------------------------------------------ 8. a name exactly on the boundary
// A name printed ON a wall line is a real ambiguity: it may belong to either side. The chosen
// behaviour is to NEVER guess — the name and the outline are both skipped with the on-edge reason.
{
  const out = matchRoomsToRegions({
    rooms: [room('a1', 'OFFICE', 0, 5)],   // exactly on the left edge of the square
    regions: [region('r1', [sq(0, 0, 10)], { areaM2: 100 })],
  });
  ok('a name exactly on the outline is not assigned', out.assignments.length === 0);
  const s = roomSkip(out, 'a1');
  ok('it is skipped as on-edge', s && s.code === CODES.onEdge && s.reason === 'its name sits on the outline - assign by hand', s && s.reason);
  ok('the region is skipped as on-edge too', (regionSkip(out, 'r1') || {}).code === CODES.onEdge);
  // and the raw geometry helper agrees it is an edge, not inside
  ok('pointInRegion reports the boundary as edge, not in', pointInRegion(0, 5, [sq(0, 0, 10)]) === 'edge');
}

// ------------------------------------------------------------------ 9. holes are honoured
{
  const rings = [sq(0, 0, 10), sq(4, 4, 2)];   // outer 10x10 with a 2x2 courtyard
  const out = matchRoomsToRegions({
    rooms: [room('in', 'OFFICE', 2, 2), room('court', 'COURTYARD', 5, 5)],
    regions: [region('r1', rings, { areaM2: 96 })],
  });
  ok('a name in the courtyard is NOT inside the region', pointInRegion(5, 5, rings) === 'out');
  ok('only the name in the real room is assigned', out.assignments.length === 1 && out.assignments[0].roomId === 'in');
  ok('the courtyard name is skipped as having no outline', (roomSkip(out, 'court') || {}).code === CODES.noOutline);
}

// ------------------------------------------------------------------ 10. overlapping regions
{
  const out = matchRoomsToRegions({
    rooms: [room('a1', 'OFFICE', 2, 2), room('a2', 'STORE', 12, 12)],
    regions: [
      region('r1', [sq(0, 0, 10)], { areaM2: 100 }),
      region('r2', [sq(5, 5, 10)], { areaM2: 100 }),
    ],
  });
  ok('ringsOverlap detects two squares that share area', ringsOverlap([sq(0, 0, 10)], [sq(5, 5, 10)]) === true);
  ok('ringsOverlap says adjacent squares do NOT overlap', ringsOverlap([sq(0, 0, 10)], [sq(10, 0, 10)]) === false);
  ok('two otherwise-valid regions that overlap assign nothing', out.assignments.length === 0);
  ok('both rooms are skipped as overlapping',
    (roomSkip(out, 'a1') || {}).code === CODES.overlap && (roomSkip(out, 'a2') || {}).code === CODES.overlap);
}

// ------------------------------------------------------------------ 11. area computed from rings
{
  // A 100x100 pt square is 10 000 pt²; at the app's 1:100 factor that is 12.445216... m².
  const m2PerSquareUnit = ((0.0254 * 100) / 72) ** 2;
  const out = matchRoomsToRegions({
    rooms: [room('a1', 'OFFICE', 50, 50)],
    regions: [region('r1', [sq(0, 0, 100)])],   // no areaM2 -> computed
    options: { m2PerSquareUnit },
  });
  ok('a region with no areaM2 is measured from its rings', out.assignments.length === 1);
  ok('the computed area matches pt2ToM2 at 1:100', out.assignments[0] && Math.abs(out.assignments[0].areaM2 - 12.45) < 0.01,
    out.assignments[0] && `${out.assignments[0].areaM2} m2`);
}

// ------------------------------------------------------------------ 12. determinism
{
  const input = {
    rooms: [room('a1', 'OFFICE', 5, 5), room('a2', 'STORE', 55, 5), room('a3', 'PLANT', 100, 100)],
    regions: [region('r1', [sq(0, 0, 10)], { areaM2: 100 }), region('r2', [sq(50, 0, 10)], { areaM2: 100 })],
  };
  const one = JSON.stringify(matchRoomsToRegions(input));
  const two = JSON.stringify(matchRoomsToRegions(input));
  ok('the same input gives byte-identical output twice', one === two);
}

// ------------------------------------------------------------------ 13. stats add up
{
  const out = matchRoomsToRegions({
    rooms: [
      room('a1', 'OFFICE', 5, 5),           // assigned
      room('a2', 'STORE', 55, 5),           // assigned
      room('a3', 'HALL', 300, 300),         // no outline
      room('a4', 'STAIRWELL', 105, 105),    // stairwell (region r4)
      room('a5', 'PLANT', 205, 205, { area: 9 }),  // already has area (region r5)
    ],
    regions: [
      region('r1', [sq(0, 0, 10)], { areaM2: 100 }),
      region('r2', [sq(50, 0, 10)], { areaM2: 100 }),
      region('r3', [sq(400, 400, 10)], { areaM2: 100 }),   // unused
      region('r4', [sq(100, 100, 10)], { areaM2: 100 }),   // stairwell
      region('r5', [sq(200, 200, 10)], { areaM2: 100 }),   // already area
    ],
  });
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  ok('assigned rooms + need-attention == all rooms',
    out.stats.assignedRooms + out.stats.needAttention === out.stats.rooms,
    `${out.stats.assignedRooms} + ${out.stats.needAttention} vs ${out.stats.rooms}`);
  ok('assigned regions + unused regions == all regions',
    out.stats.assignedRegions + out.stats.unusedRegions === out.stats.regions,
    `${out.stats.assignedRegions} + ${out.stats.unusedRegions} vs ${out.stats.regions}`);
  ok('every skipped room is counted in roomReasons', sum(out.stats.roomReasons) === out.stats.needAttention);
  ok('every skipped region is counted in regionReasons', sum(out.stats.regionReasons) === out.stats.unusedRegions);
  ok('every skipped entry carries a code and a reason sentence',
    out.skipped.every((s) => typeof s.code === 'string' && typeof s.reason === 'string' && s.reason.length > 0));
  ok('every reason code has a short label for a UI', out.skipped.every((s) => typeof REASON_LABEL[s.code] === 'string'));
}

// ------------------------------------------------------------------ 14. regions straight from the tracer
// The whole point of the new traceRegions(): js/autotrace.js consumes its regions DIRECTLY — no
// rebuilding rings from the tracer's primitives. A two-room, one-door sheet is one shared outline by
// default; closing the door with the opt-in closeGaps splits it, and the auto-fill goes 0 -> 2.
{
  const DENOM = 100;
  const MPP = ((0.0254 * DENOM) / 72);
  const side = (25 / (MPP * MPP)) ** 0.5;
  const segs = [];
  const push = (x1, y1, x2, y2) => segs.push({ x1, y1, x2, y2, width: 1, color: [136, 136, 136] });
  push(10, 20, 10 + 2 * side, 20);
  push(10 + 2 * side, 20, 10 + 2 * side, 20 + side);
  push(10 + 2 * side, 20 + side, 10, 20 + side);
  push(10, 20 + side, 10, 20);
  push(10 + side, 20, 10 + side, 20 + (side - 3) / 2);            // shared wall with a 3 pt door gap
  push(10 + side, 20 + (side + 3) / 2, 10 + side, 20 + side);
  const box = { x0: 0, y0: 0, x1: 2 * side + 40, y1: side + 40 };
  const rooms = [room('L', 'OFFICE', 10 + side / 2, 20 + side / 2), room('R', 'STORE', 10 + side + side / 2, 20 + side / 2)];
  const base = { segments: segs, box, rooms, denom: DENOM, pxPerPt: 2, thickness: 2 };

  const open = matchRoomsToRegions({ rooms, regions: traceRegions(base).regions });
  ok('tracer regions feed the matcher directly: one shared outline fills neither room',
    open.assignments.length === 0 && open.stats.roomReasons[CODES.shared] === 2,
    JSON.stringify(open.stats.roomReasons));

  const sealed = matchRoomsToRegions({ rooms, regions: traceRegions({ ...base, closeGaps: 3 }).regions });
  ok('closing the door splits the outline and both rooms are auto-filled from the tracer regions',
    sealed.assignments.length === 2 && sealed.assignments.every((a) => Math.abs(a.areaM2 - 25) < 3),
    sealed.assignments.map((a) => `${a.name} ${a.areaM2}m2`).join(', '));
}

// ------------------------------------------------------------------ report
console.log(`\n${pass}/${pass + fail} autotrace checks passed`);
if (fail) { console.log('SOME AUTOTRACE CHECKS FAILED'); process.exit(1); }
console.log('ALL AUTOTRACE CHECKS PASSED');

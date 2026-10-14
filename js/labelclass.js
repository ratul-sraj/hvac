/**
 * js/labelclass.js — tell a ROOM NAME from an ANNOTATION LABEL inside a room.
 *
 * WHY THIS EXISTS
 * A drawing prints more than room names: a hearing room carries MONITOR, COUNSEL, WITNESS and
 * COMMISSIONERS' BENCH; a gallery carries SEATING and IN/OUT; a lobby carries ESCAPE ONLY. The
 * parser (js/pdfparse.js) honestly reads every one as a "room" (a name with no area), so a traced
 * outline that holds a real room AND its fittings holds SEVERAL names and js/autotrace.js — correctly
 * — refuses it as `shared`. On the real LEVEL 11 sheet 26 of the 56 detected "rooms" are such
 * labels, and they are the main cause of the "one outline holds several room names" refusals
 * (docs/ZONE-DETECTION-RESEARCH.md section 2 step 0).
 *
 * THE RULE (two passes, neither of which guesses from the name alone)
 *   1. A fitting word is a sub-zone when the SAME region also holds a label that is not a fitting
 *      word — that other label is the parent ROOM.
 *   2. A fitting word in a region of its OWN is still a sub-zone when its centre lies inside a region
 *      that DOES hold a room label. Pass 1 alone cannot see this case, and it is the common one: the
 *      tracer SPLITS a region holding several labels into one piece per label (js/splitregion.js), so
 *      the fitting ends up alone in its piece and its parent's name sits in a different piece. That is
 *      exactly how "IN" (11.06 m2) and two "COMMISSIONERS' BENCH" rows (28.57 / 29.76 m2) kept an
 *      area on the real sheet — a fitting sized with a room's area.
 *
 * A sub-zone is marked with `parentId`, is NEVER given an area and is NEVER counted in the load: an
 * area on "MONITOR" is a wrong area. Coverage is therefore always reported over REAL rooms.
 *
 * CONTRACT
 * - Pure and deterministic: same input -> same output. No DOM, no pdf.js, no imports beyond the
 *   geometry test the tracer already uses (js/autotrace.js pointInRegion), so a label is judged in
 *   the SAME region the matcher will use.
 * - Never mutates its inputs: it returns the set of sub-zone ids and, optionally, the parent map.
 */

import { pointInRegion, regionRings } from "./autotrace.js";

// Fittings, seats, bays, benches, the "in"/"out" door markers and "escape only" zones. Deliberately
// does NOT include real space words (LOBBY, EXIT, FOYER, COURT OPERATOR, ...): a word is a sub-zone
// only when a traced region ties it to a room, so a stray match can never drop a real room on its own.
// The word test is whole-word ("COUNSELLING ROOM" is not "COUNSEL"; "WITNESS ROOM" would still match
// "witness", which is why the geometry above decides and this list only nominates).
const SUBZONE_WORDS =
  /(?:^|[^a-z])(?:monitor|seating|escape only|wheelchair bay|commissioners['\u2019]? bench|counsel|witness|bench|bay|in|out)(?![a-z])/i;

/** A word that CAN be a fitting / zone label (not necessarily one — see the two passes above). */
export function isSubZoneWord(name) {
  const n = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
  if (!n) return false;
  return SUBZONE_WORDS.test(n);
}

/** Names that are NEVER a room name, whatever region they fall in — the whole name, not a word in it.
 *  On the real LEVEL 11 sheet this exact set is 26 of the 56 detected "rooms" (SEATING x3, MONITOR x7,
 *  IN, OUT, ESCAPE ONLY x3, PRESS SEATING x2, PUBLIC SEATING x2, WHEELCHAIR BAY x2, COUNSEL x2,
 *  WITNESS, COMMISSIONERS' BENCH x2) and it is the set the standalone probe has always classified.
 *  A geometry test cannot decide these on its own: the tracer splits a room holding several labels
 *  into one piece per label, so a bench ends up alone in its piece with its room's name elsewhere,
 *  and a label in a refused (open-plan) region — "IN" was one — is in no region at all and was
 *  therefore never classified, which is how it kept an 11.06 m2 area in the load.
 *  A room with a modifier ("WITNESS ROOM", "COUNSELLING ROOM", "MONITOR ROOM") does NOT match: the
 *  comparison is the whole normalised name. Anything excluded this way stays in the table, greyed and
 *  marked, and one click in the room list puts it back, so an odd sheet cannot cost a real room. */
const FITTING_NAMES = new Set([
  "in", "out", "monitor", "seating", "public seating", "press seating", "escape only",
  "wheelchair bay", "counsel", "witness", "bench", "commissioners bench", "commissioner bench",
]);

const normalizeName = (name) => String(name == null ? "" : name)
  .toLowerCase().replace(/[\u2018\u2019']/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Is this name, on its own, a fitting rather than a room? */
export function isFittingName(name) {
  const n = normalizeName(name);
  return !!n && FITTING_NAMES.has(n);
}

/** Centroid of the first usable ring — a point that represents the region when testing containment. */
function centroidOf(rings) {
  const r = (rings || []).find((ring) => ring && ring.length >= 3);
  if (!r) return null;
  let x = 0, y = 0;
  for (const p of r) { x += p.x; y += p.y; }
  return { x: x / r.length, y: y / r.length };
}

/**
 * Classify the labels of one page against the traced regions.
 * @param {Array<{id:any,name:string,at?:{x:number,y:number}}>} rooms
 * @param {Array<{id:any,rings?:Array,polygon?:Array,closed?:boolean}>} regions
 * @returns {{subZoneIds:Set<any>, realRoomIds:Set<any>, parentOf:Map<any,any>,
 *            subZones:number, realRooms:number, byRegion:Array<{regionId:any,real:any[],sub:any[]}>}}
 */
export function classifyLabels(rooms, regions) {
  const list = Array.isArray(rooms) ? rooms : [];
  const regs = Array.isArray(regions) ? regions : [];
  const subZoneIds = new Set();
  const realRoomIds = new Set();
  const parentOf = new Map();
  const byRegion = [];

  const info = list.map((r, i) => ({
    room: r, id: r && r.id != null ? r.id : i, name: (r && r.name) || "",
    sub: isSubZoneWord(r && r.name),
    exact: isFittingName(r && r.name),
  }));
  // Pass 0: a name that is a fitting word and nothing else is never a room, whatever region it falls
  // in (or in none). Everything else is decided by the geometry below.
  for (const it of info) if (it.exact) subZoneIds.add(it.id);

  for (const g of regs) {
    if (!g || g.closed === false) continue;
    const rings = regionRings(g);
    if (!rings.length) continue;
    const real = [], sub = [];
    for (const it of info) {
      const at = it.room && it.room.at;
      if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
      if (pointInRegion(at.x, at.y, rings) === "out") continue;
      (it.sub ? sub : real).push(it);
    }
    byRegion.push({ regionId: g.id, real, sub, rings, center: centroidOf(rings) });
  }

  // Pass 1: a fitting word sharing a region with a room label IS that room's annotation.
  for (const g of byRegion) {
    if (!g.real.length) continue;
    for (const s of g.sub) { subZoneIds.add(s.id); parentOf.set(s.id, g.real[0].id); }
  }

  // Pass 2: a fitting word alone in its region, whose region sits INSIDE a region that holds a room
  // label, belongs to that room. Geometry decides, never the name: a "WITNESS" that really is a room
  // of its own has its own region that no room's region contains, so it stays a room.
  const parents = byRegion.filter((g) => g.real.length && g.center);
  for (const g of byRegion) {
    if (g.real.length || !g.sub.length || !g.center) continue;
    const host = parents.find((p) => pointInRegion(g.center.x, g.center.y, p.rings) !== "out");
    if (!host) continue;
    for (const s of g.sub) { subZoneIds.add(s.id); parentOf.set(s.id, host.real[0].id); }
  }

  for (const it of info) {
    if (subZoneIds.has(it.id)) continue;
    realRoomIds.add(it.id);
  }
  return {
    subZoneIds, realRoomIds, parentOf, byRegion,
    subZones: subZoneIds.size, realRooms: realRoomIds.size,
  };
}

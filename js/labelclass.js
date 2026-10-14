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
 * THE RULE
 *   isSubZone(L) = lexicon(L.name)  &&  the region around L also holds a label that is NOT lexicon
 *                  (that other label is the parent ROOM)
 * A sub-zone is marked with `parentId` and is NEVER given an area and NEVER counted in the load: an
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
// only when it ALSO shares a traced region with a parent room, so a stray match can never drop a real
// room on its own.
const SUBZONE_WORDS =
  /(?:^|[^a-z])(?:monitor|seating|escape only|wheelchair bay|commissioners['\u2019]? bench|counsel|witness|bench|bay|in|out)(?![a-z])/i;

/** A word is a fitting / zone label, not a room name. */
export function isSubZoneWord(name) {
  const n = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
  if (!n) return false;
  return SUBZONE_WORDS.test(n);
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
  }));

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
    byRegion.push({ regionId: g.id, real, sub });
    // A fitting word is a sub-zone ONLY when a real room shares its region — that real room is the
    // parent, and the fitting's own area would be a wrong area.
    if (real.length) {
      const parent = real[0];
      for (const s of sub) { subZoneIds.add(s.id); parentOf.set(s.id, parent.id); }
    }
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

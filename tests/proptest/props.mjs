// tests/proptest/props.mjs — the property catalogue.
//
// Each property = { gen(rng) -> case, check(case) -> {ok, why?}, simplify(case) -> [cases] }.
// The oracle is INDEPENDENT of the implementation wherever possible: a strict RFC-4180 reader written
// here, a shoelace area recomputed here, semantic rate-limit contracts instead of the bucket's own maths.
//
// Discovery suite: it may be repetitive and unoptimised. Per-bug regression tests live in tests/.

import * as calc from "../../js/calc.js";
import * as poly from "../../js/polyshape.js";
import * as rec from "../../js/reconcile.js";
import { createBucket } from "../../lib/ratelimit.js";
import { toCsv, buildReportHtml } from "../../js/report.js";
import { monteCarlo } from "../../js/uncertainty.js";
import { parseAreaValue, parseLengthValue } from "../../js/schedule.js";
import { calibrateScale } from "../../js/scalecal.js";
import { makeBasis, basisStatements, basisGaps, openStatements } from "../../js/basis.js";
import { parseCsvStrict, stripBom, convexHull } from "./lib.mjs";

export const props = [];
const prop = (name, target, spec) => props.push({ name, target, ...spec });

const round2 = (v) => Math.round(v * 100) / 100;
const near = (a, b, rel = 1e-9, abs = 1e-9) =>
  Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));

/* ============================ generators ================================= */

/** A simple polygon, guaranteed: the CONVEX HULL of random points (Andrew's monotone chain).
 *  Sorting vertices by angle around a point is only simple while no two are nearly collinear with it;
 *  rounding to 2 dp can flip a razor-thin wedge into a crossing, which made the first generator lie. */
function genRing(rng, size = 1) {
  const n = rng.int(4, 8 + 2 * size);
  const cx = rng.float(0, 200), cy = rng.float(0, 200);
  const maxR = 8 + 60 * size;
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const a = rng.float(0, Math.PI * 2), r = rng.float(maxR * 0.45, maxR);
    pts.push({ x: round2(cx + r * Math.cos(a)), y: round2(cy + r * Math.sin(a)) });
  }
  const hull = convexHull(pts);
  return hull.length >= 3 ? hull : [{ x: cx, y: cy }, { x: cx + maxR, y: cy }, { x: cx, y: cy + maxR }];
}

const ROOM_NAMES = ["Office", "Meeting Room", "Manager Cabin", "Conference 3", "Lab", "Studio", "Training Room"];
const ORIENTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function genRoom(rng, size = 1) {
  return {
    id: `r${rng.int(1, 99)}`,
    name: rng.pick(ROOM_NAMES),
    type: "office",
    area: rng.decimal(1, 40 * size, rng.int(0, 2)),
    height: rng.decimal(2.6, 4.0, 2),
    people: rng.int(0, 15),
    light: rng.decimal(0, 18, 1),
    equip: rng.decimal(0, 25, 1),
    orient: rng.pick(ORIENTS),
    extWall: rng.decimal(0, 60, 2),
    glass: rng.decimal(0, 30, 2),
    partition: rng.decimal(0, 40, 2),
    roof: rng.bool(0.3),
  };
}

const HOSTILE_NAMES = [
  "Office", "Reception / Lobby", 'say "hi"', "a,b", "line\nbreak", "=1+1", "@cmd",
  "+SUM(A1)", "-2+3", " leading space", "semi;colon", "Tab\there", "CR\rhere", "100% fresh",
  "Café Müller", "会议室 3", "<b>bold</b>",
];

/* ============================== geometry ================================= */

prop("geometry/area is invariant under a cyclic rotation of the vertex list", "polyshape", {
  gen: (rng) => ({ ring: genRing(rng, rng.int(1, 3)), k: rng.int(0, 5) }),
  check: ({ ring, k }) => {
    const n = ring.length, shift = ((k % n) + n) % n;
    const rotated = ring.slice(shift).concat(ring.slice(0, shift));
    return near(poly.polyAreaPt2(rotated), poly.polyAreaPt2(ring))
      ? { ok: true } : { ok: false, why: `area ${poly.polyAreaPt2(ring)} vs rotated ${poly.polyAreaPt2(rotated)}` };
  },
  simplify: (c) => (c.ring.length > 3 ? [{ ...c, ring: c.ring.slice(0, c.ring.length - 1), k: c.k % (c.ring.length - 1) }] : []),
});

prop("geometry/area is invariant under reversing the winding", "polyshape", {
  gen: (rng) => ({ ring: genRing(rng, rng.int(1, 3)) }),
  check: ({ ring }) => {
    const rev = ring.slice().reverse();
    return near(poly.polyAreaPt2(rev), poly.polyAreaPt2(ring))
      ? { ok: true } : { ok: false, why: `${poly.polyAreaPt2(ring)} vs reversed ${poly.polyAreaPt2(rev)}` };
  },
  simplify: (c) => (c.ring.length > 3 ? [{ ring: c.ring.slice(0, c.ring.length - 1) }] : []),
});

prop("geometry/area is invariant under translation (a drawing offset must not change m2)", "polyshape", {
  gen: (rng) => ({ ring: genRing(rng, rng.int(1, 3)), dx: rng.decimal(-500, 500, 2), dy: rng.decimal(-500, 500, 2) }),
  check: ({ ring, dx, dy }) => {
    const moved = ring.map((p) => ({ x: round2(p.x + dx), y: round2(p.y + dy) }));
    return near(poly.polyAreaPt2(moved), poly.polyAreaPt2(ring), 1e-6, 1e-6)
      ? { ok: true } : { ok: false, why: `${poly.polyAreaPt2(ring)} vs moved ${poly.polyAreaPt2(moved)} (dx=${dx}, dy=${dy})` };
  },
  simplify: (c) => [{ ...c, dx: Math.round(c.dx / 10), dy: Math.round(c.dy / 10) }].filter((x) => x.dx !== c.dx || x.dy !== c.dy),
});

prop("geometry/area scales with the square of a uniform scale factor", "polyshape", {
  gen: (rng) => ({ ring: genRing(rng, rng.int(1, 2)), k: rng.decimal(0.25, 4, 2) }),
  check: ({ ring, k }) => {
    if (!(k > 0)) return { ok: true };
    const scaled = ring.map((p) => ({ x: p.x * k, y: p.y * k }));
    const want = poly.polyAreaPt2(ring) * k * k;
    return near(poly.polyAreaPt2(scaled), want, 2e-4, 2e-4)
      ? { ok: true } : { ok: false, why: `area(k*ring)=${poly.polyAreaPt2(scaled)} but k^2*area=${want} (k=${k})` };
  },
  simplify: (c) => [{ ...c, k: 2 }, { ...c, k: 1 }].filter((x) => x.k !== c.k),
});

prop("geometry/inserting a vertex on an edge then removing it restores the ring", "polyshape", {
  gen: (rng) => ({ ring: genRing(rng, rng.int(1, 3)), edge: rng.int(0, 5), t: rng.decimal(0.1, 0.9, 2) }),
  check: ({ ring, edge, t }) => {
    const hold = Math.max(0, Math.min(ring.length, edge + 1));
    const e = hold % ring.length;
    const a = ring[e], b = ring[(e + 1) % ring.length];
    const mid = { x: round2(a.x + (b.x - a.x) * t), y: round2(a.y + (b.y - a.y) * t) };
    const withV = poly.ringInsertVertex(ring, e, mid);
    const back = poly.ringRemoveVertex(withV, e + 1);
    const same = back.length === ring.length && back.every((p, i) => p.x === ring[i].x && p.y === ring[i].y);
    if (!same) return { ok: false, why: `round trip changed the ring: ${JSON.stringify(ring)} -> ${JSON.stringify(back)}` };
    return { ok: true };
  },
  simplify: (c) => (c.ring.length > 3 ? [{ ring: c.ring.slice(0, c.ring.length - 1), edge: c.edge, t: c.t }] : []),
});

prop("geometry/roundRing is idempotent", "polyshape", {
  gen: (rng) => ({ ring: genRing(rng, rng.int(1, 2)).map((p) => ({ x: p.x + rng.float(-0.004, 0.004), y: p.y + rng.float(-0.004, 0.004) })) }),
  check: ({ ring }) => {
    const once = poly.roundRing(ring), twice = poly.roundRing(once);
    const same = JSON.stringify(once) === JSON.stringify(twice);
    return same ? { ok: true } : { ok: false, why: `roundRing not idempotent: ${JSON.stringify(once)} vs ${JSON.stringify(twice)}` };
  },
  simplify: (c) => (c.ring.length > 3 ? [{ ring: c.ring.slice(0, c.ring.length - 1) }] : []),
});

prop("geometry/a ring of sorted-angle vertices is simple", "polyshape", {
  gen: (rng) => ({ ring: genRing(rng, rng.int(1, 3)) }),
  check: ({ ring }) => (poly.polygonIsSimple(ring) ? { ok: true } : { ok: false, why: `refused a simple ring: ${JSON.stringify(ring)}` }),
  simplify: (c) => (c.ring.length > 3 ? [{ ring: c.ring.slice(0, c.ring.length - 1) }] : []),
});

prop("geometry/a self-crossing ring is refused", "polyshape", {
  gen: (rng) => {
    // bowtie: two segments that must cross, plus a random translation
    const dx = rng.decimal(-50, 50, 1), dy = rng.decimal(-50, 50, 1), s = rng.decimal(1, 50, 1);
    return { ring: [{ x: dx, y: dy }, { x: dx + s, y: dy + s }, { x: dx + s, y: dy }, { x: dx, y: dy + s }] };
  },
  check: ({ ring }) => (poly.polygonIsSimple(ring) ? { ok: false, why: `accepted a bowtie: ${JSON.stringify(ring)}` } : { ok: true }),
  simplify: (c) => [{ ring: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }] }],
});

prop("geometry/ringBBox contains every vertex", "polyshape", {
  gen: (rng) => ({ ring: genRing(rng, rng.int(1, 2)) }),
  check: ({ ring }) => {
    const b = poly.ringBBox(ring);
    const inside = ring.every((p) => p.x >= b.x - 1e-9 && p.x <= b.x + b.w + 1e-9 && p.y >= b.y - 1e-9 && p.y <= b.y + b.h + 1e-9);
    if (!inside) return { ok: false, why: `bbox ${JSON.stringify(b)} misses a vertex of ${JSON.stringify(ring)}` };
    if (!(b.w >= 0 && b.h >= 0)) return { ok: false, why: `negative bbox extent ${JSON.stringify(b)}` };
    return { ok: true };
  },
  simplify: (c) => (c.ring.length > 3 ? [{ ring: c.ring.slice(0, c.ring.length - 1) }] : []),
});

/* =============================== engine ================================== */

const PROJ = { ...calc.DEFAULT_PROJECT };

prop("engine/results add up to the project total (no room can be lost or double counted)", "calc", {
  gen: (rng) => ({ rooms: Array.from({ length: rng.int(1, 6) }, () => genRoom(rng, rng.int(1, 3))) }),
  check: ({ rooms }) => {
    const res = calc.calcProject(rooms, PROJ);
    const sum = res.results.filter((x) => x.room.include).reduce((a, x) => a + x.tr, 0);
    return near(sum, res.totals.tr, 1e-12)
      ? { ok: true } : { ok: false, why: `sum of rooms ${sum} vs totals.tr ${res.totals.tr}` };
  },
  simplify: (c) => (c.rooms.length > 1 ? [{ rooms: c.rooms.slice(0, -1) }] : []),
});

prop("engine/the order rooms are listed in cannot change the total", "calc", {
  gen: (rng) => ({ rooms: Array.from({ length: rng.int(2, 6) }, () => genRoom(rng, rng.int(1, 2))) }),
  check: ({ rooms }) => {
    const a = calc.calcProject(rooms, PROJ).totals.tr;
    const b = calc.calcProject(rooms.slice().reverse(), PROJ).totals.tr;
    return near(a, b, 1e-12) ? { ok: true } : { ok: false, why: `forward ${a} vs reversed ${b}` };
  },
  simplify: (c) => (c.rooms.length > 2 ? [{ rooms: c.rooms.slice(0, -1) }] : []),
});

prop("engine/giving a room more floor area never lowers its load", "calc", {
  gen: (rng) => ({ room: genRoom(rng, rng.int(1, 3)), k: rng.decimal(1.01, 4, 2) }),
  check: ({ room, k }) => {
    const small = calc.calcRoom(room, PROJ).totalW;
    const big = calc.calcRoom({ ...room, area: round2(room.area * k) }, PROJ).totalW;
    return big >= small - 1e-9 ? { ok: true } : { ok: false, why: `area x${k} gave ${big} W, below ${small} W` };
  },
  simplify: (c) => [{ ...c, k: 2 }, { ...c, k: 1.5 }].filter((x) => x.k < c.k),
});

prop("engine/a room with no area carries no load", "calc", {
  gen: (rng) => ({ room: genRoom(rng, rng.int(1, 3)) }),
  check: ({ room }) => {
    const w = calc.calcRoom({ ...room, area: 0, length: undefined, width: undefined }, PROJ).totalW;
    return Math.abs(w) < 1e-9 ? { ok: true } : { ok: false, why: `zero-area room produced ${w} W` };
  },
  simplify: () => [],
});

prop("engine/a negative area cannot subtract from the project", "calc", {
  gen: (rng) => ({ room: genRoom(rng, rng.int(1, 2)), neg: rng.decimal(-500, -1, 2) }),
  check: ({ room, neg }) => {
    const one = calc.calcProject([{ ...room, area: neg }], PROJ);
    if (one.totals.tr < -1e-12) return { ok: false, why: `negative area produced ${one.totals.tr} TR` };
    if (one.totals.area < 0) return { ok: false, why: `negative quoted area ${one.totals.area}` };
    const w = calc.calcRoom({ ...room, area: neg }, PROJ).totalW;
    return Math.abs(w) < 1e-9 ? { ok: true } : { ok: false, why: `negative area produced ${w} W` };
  },
  simplify: (c) => [{ ...c, neg: -1 }, { ...c, neg: -10 }].filter((x) => x.neg > c.neg),
});

prop("engine/the safety allowance is clamped to 0–100 %, or falls back to the default", "calc", {
  gen: (rng) => ({ room: genRoom(rng, rng.int(1, 2)), wild: rng.pick([-1000, -50, -0.5, 101, 1000, 1e9, "abc", null]) }),
  check: ({ room, wild }) => {
    // documented contract (js/calc.js): "a parseable number, clamped to a sane band"; a value that
    // does not parse at all falls back to DEFAULT_PROJECT.safety, it is not forced to an edge.
    const parsed = Number.isFinite(Number(wild)) && wild !== null && wild !== "" ? Number(wild) : null;
    const want = parsed == null ? calc.DEFAULT_PROJECT.safety : Math.min(calc.SAFETY_MAX, Math.max(calc.SAFETY_MIN, parsed));
    const base = calc.calcProject([room], { ...PROJ, safety: wild }).totals.tr;
    const edge = calc.calcProject([room], { ...PROJ, safety: want }).totals.tr;
    return near(base, edge, 1e-12) ? { ok: true } : { ok: false, why: `safety ${fmt(wild)} gave ${base} TR, an explicit ${want}% gives ${edge} TR` };
  },
  simplify: () => [],
});
const fmt = (v) => JSON.stringify(v);

prop("engine/TR is the total watts over 3517", "calc", {
  gen: (rng) => ({ room: genRoom(rng, rng.int(1, 3)) }),
  check: ({ room }) => {
    const r = calc.calcRoom(room, PROJ);
    const want = r.totalW / 3517;
    return near(r.tr, want, 1e-12) ? { ok: true } : { ok: false, why: `tr ${r.tr} vs totalW/3517 ${want}` };
  },
  simplify: () => [],
});

/* ============================ psychrometrics ============================= */

prop("psychrometrics/relative humidity survives a w -> RH round trip", "calc", {
  gen: (rng) => ({ db: rng.decimal(-5, 48, 1), rh: rng.decimal(2, 100, 1) }),
  check: ({ db, rh }) => {
    const w = calc.wFromDbRh(db, rh);
    const back = calc.rhFromDbW(db, w);
    return near(back, rh, 1e-6, 1e-6) ? { ok: true } : { ok: false, why: `RH ${rh}% at ${db}C came back as ${back}%` };
  },
  simplify: (c) => [{ ...c, rh: Math.round(c.rh) }, { ...c, db: Math.round(c.db) }],
});

prop("psychrometrics/humidity ratio rises with wet bulb and saturates at 100% RH", "calc", {
  gen: (rng) => ({ db: rng.decimal(10, 45, 1), a: rng.float(0, 0.5), b: rng.float(0.5, 1) }),
  check: ({ db, a, b }) => {
    const w1 = calc.wFromDbWb(db, db * a), w2 = calc.wFromDbWb(db, db * b);
    if (!(w2 >= w1 - 1e-12)) return { ok: false, why: `w(wb=${db * b}) ${w2} < w(wb=${db * a}) ${w1}` };
    const sat = calc.wFromDbRh(db, 100), wet = calc.wFromDbWb(db, db);
    return near(wet, sat, 1e-9, 1e-9) ? { ok: true } : { ok: false, why: `wet bulb = dry bulb gave w=${wet}, 100% RH gives ${sat}` };
  },
  simplify: () => [],
});

/* ============================= reconcile ================================= */

prop("reconcile/agreement is exactly 'diff <= tolerance', and diff is never negative", "reconcile", {
  gen: (rng) => ({ sheet: rng.decimal(5, 400, 2), geom: rng.decimal(1, 500, 2), tol: rng.decimal(0, 20, 1) }),
  check: ({ sheet, geom, tol }) => {
    const row = rec.reconcileRoom({ id: "x", name: "R", areaStated: sheet, area: geom, poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], areaFromDrawing: true }, { tolerance: tol });
    if (row.diffPct == null) return { ok: false, why: "no diffPct for two independent figures" };
    if (row.diffPct < 0) return { ok: false, why: `negative diffPct ${row.diffPct}` };
    const wantAgree = row.diffPct <= tol;
    const gotAgree = row.verdict === "agree";
    return wantAgree === gotAgree ? { ok: true } : { ok: false, why: `diff ${row.diffPct}% against tol ${tol}% gave verdict '${row.verdict}'` };
  },
  simplify: (c) => [{ ...c, tol: 5 }, { ...c, geom: c.sheet }],
});

// INVESTIGATED AND DROPPED: "swapping which figure is printed and which is measured gives the same
// gap". It does not, and it should not: reconcileRoom divides by the SHEET's figure, so the gap is a
// percentage of the printed area (77% vs 43.5% for the same pair). That is the documented wording
// ("measured X against the sheet's Y — N% apart"), not a defect.

prop("reconcile/a hand-typed area is never reconciled away", "reconcile", {
  gen: (rng) => ({ sheet: rng.decimal(5, 400, 2), geom: rng.decimal(1, 500, 2) }),
  check: ({ sheet, geom }) => {
    const row = rec.reconcileRoom({ areaStated: sheet, area: geom, areaTyped: true, poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], areaFromDrawing: true });
    return row.verdict === "typed" ? { ok: true } : { ok: false, why: `verdict '${row.verdict}' for a typed area` };
  },
  simplify: () => [],
});

prop("reconcile/the number of rooms it reports equals the number the load counted", "reconcile", {
  gen: (rng) => ({
    rooms: Array.from({ length: rng.int(2, 6) }, () => {
      const r = genRoom(rng, rng.int(1, 2));
      return { ...r, name: rng.bool(0.35) ? rng.pick(["Toilet", "Stair 2", "Lift Lobby", "Store", "Pantry"]) : r.name };
    }),
  }),
  check: ({ rooms }) => {
    // the way js/report.js:418 actually calls it — normalised results, included rooms only
    const res = calc.calcProject(rooms, PROJ);
    const counted = res.totals.rooms;
    const reported = rec.reconcileAreas(res.results.filter((r) => r.room.include).map((r) => r.room), { tolerance: 5 }).rows.length;
    return counted === reported ? { ok: true } : { ok: false, why: `the load counted ${counted} rooms but reconcile reports ${reported}` };
  },
  simplify: (c) => (c.rooms.length > 1 ? [{ rooms: c.rooms.slice(0, -1) }] : []),
});

prop("reconcile/a room the load excluded (a toilet, a stair) is not reconciled as a load room", "reconcile", {
  gen: (rng) => ({
    rooms: Array.from({ length: rng.int(1, 4) }, () => {
      const r = genRoom(rng, rng.int(1, 2));
      return { ...r, name: rng.pick(["Office", "Toilet", "Stair 2", "Lift Lobby", "Store", "Pantry"]) };
    }),
  }),
  check: ({ rooms }) => {
    const counted = calc.calcProject(rooms, PROJ).totals.rooms;
    const fromRaw = rec.reconcileAreas(rooms, {}).rows.length;      // raw rooms, include not yet derived
    if (counted === fromRaw) return { ok: true };
    return { ok: false, why: `raw rooms: the load counts ${counted}, reconcileAreas(raw) reports ${fromRaw} (the report is only correct because js/report.js filters first)` };
  },
  simplify: (c) => (c.rooms.length > 1 ? [{ rooms: c.rooms.slice(0, -1) }] : []),
});

prop("reconcile/the verdict buckets partition the rows", "reconcile", {
  gen: (rng) => ({ rooms: Array.from({ length: rng.int(1, 6) }, () => ({ ...genRoom(rng, rng.int(1, 2)), areaStated: rng.bool(0.6) ? rng.decimal(1, 300, 1) : undefined })) }),
  check: ({ rooms }) => {
    const s = rec.reconcileAreas(rooms).summary;
    const parts = s.agree + s.flag + s.unchecked + s.sheetDerived + s.typed + s.none;
    if (parts !== s.rooms) return { ok: false, why: `buckets sum to ${parts} but there are ${s.rooms} rows` };
    if (s.checkable !== s.agree + s.flag) return { ok: false, why: `checkable ${s.checkable} != agree+flag ${s.agree + s.flag}` };
    return { ok: true };
  },
  simplify: (c) => (c.rooms.length > 1 ? [{ rooms: c.rooms.slice(0, -1) }] : []),
});

/* ============================= rate limit ================================ */

prop("ratelimit/a fresh bucket allows exactly `max` and then refuses", "ratelimit", {
  gen: (rng) => ({ max: rng.int(1, 12), windowMs: rng.pick([1000, 60000]) }),
  check: ({ max, windowMs }) => {
    let t = 0;
    const b = createBucket({ max, windowMs, now: () => t, maxKeys: 1e6 });
    for (let i = 0; i < max; i += 1) {
      const r = b.take("k");
      if (!r.allowed) return { ok: false, why: `take ${i + 1} of ${max} refused` };
    }
    const over = b.take("k");
    return over.allowed === false ? { ok: true } : { ok: false, why: `take ${max + 1} allowed on an empty-clock bucket` };
  },
  simplify: (c) => [{ ...c, max: 1 }].filter((x) => x.max < c.max),
});

prop("ratelimit/retryAfterMs is truthful: waiting that long is accepted", "ratelimit", {
  gen: (rng) => ({ max: rng.int(1, 8), windowMs: rng.pick([100, 1000, 60000]), burns: rng.int(6, 40) }),
  check: ({ max, windowMs, burns }) => {
    let t = 0;
    const b = createBucket({ max, windowMs, now: () => t, maxKeys: 1e6 });
    let refused = null;
    for (let i = 0; i < burns; i += 1) {
      t += 0.7;
      const r = b.take("k");
      if (!r.allowed) { refused = r; break; }
    }
    if (!refused) return { ok: true };
    t += refused.retryAfterMs;
    const after = b.take("k");
    return after.allowed ? { ok: true } : { ok: false, why: `waited the promised ${refused.retryAfterMs} ms and was still refused` };
  },
  simplify: (c) => [{ ...c, burns: 6 }],
});

prop("ratelimit/keys do not interfere with each other", "ratelimit", {
  gen: (rng) => ({ max: rng.int(1, 6), windowMs: 60000, ops: Array.from({ length: rng.int(2, 20) }, () => ({ key: rng.pick(["a", "b", "c"]), dt: rng.pick([0, 1, 100, 1000]) })) }),
  check: ({ max, windowMs, ops }) => {
    const together = new Map(); const alone = new Map();
    let t = 0;
    const bt = createBucket({ max, windowMs, now: () => t, maxKeys: 1e6 });
    for (const op of ops) {
      t += op.dt;
      together.set(`${op.key}@${t}`, bt.take(op.key).allowed);
    }
    for (const key of ["a", "b", "c"]) {
      let t2 = 0;
      const ba = createBucket({ max, windowMs, now: () => t2, maxKeys: 1e6 });
      let i = 0;
      for (const op of ops) {
        t2 += op.dt;
        if (op.key === key) alone.set(`${key}@${t2}`, ba.take(key).allowed);
        i += 1;
      }
    }
    for (const [k, v] of alone) if (together.get(k) !== v) return { ok: false, why: `key ${k} decided ${together.get(k)} alongside others, ${v} alone` };
    return { ok: true };
  },
  simplify: (c) => (c.ops.length > 2 ? [{ ...c, ops: c.ops.slice(0, -1) }] : []),
});

prop("ratelimit/the store never holds more than maxKeys entries", "ratelimit", {
  gen: (rng) => ({ maxKeys: rng.int(2, 8), n: rng.int(5, 30) }),
  check: ({ maxKeys, n }) => {
    let t = 0;
    const b = createBucket({ max: 5, windowMs: 60000, now: () => t, maxKeys });
    for (let i = 0; i < n; i += 1) { t += 1; b.take(`key-${i}`); }
    const size = b.size();
    return size <= maxKeys ? { ok: true } : { ok: false, why: `${size} entries kept with maxKeys ${maxKeys}` };
  },
  simplify: (c) => [{ ...c, n: Math.max(3, c.n - 5) }, { ...c, maxKeys: 2 }].filter((x) => x.n !== c.n || x.maxKeys !== c.maxKeys),
});

/* ================================= CSV ================================== */

function csvCase(rng) {
  const n = rng.int(1, 5);
  const rooms = Array.from({ length: n }, () => {
    const r = genRoom(rng, rng.int(1, 2));
    return { ...r, name: rng.pick(HOSTILE_NAMES), number: rng.pick(["101", "A,1", 'q"x', "=1"]), level: rng.pick(["L1", "Ground", ""]) };
  });
  const project = { ...PROJ, name: rng.pick(["Project", "a,b", "=cmd"]), city: "Kochi", units: rng.pick(["si", "ip"]) };
  return { rooms, project };
}

function parseExport({ rooms, project }) {
  const res = calc.calcProject(rooms, project);
  const csv = toCsv(project, res);
  const rows = parseCsvStrict(csv);
  const headAt = rows.findIndex((r) => r[0] === "Include");
  if (headAt < 0) throw new Error("no header row in the export");
  const head = rows[headAt];
  // data rows stop at the first line whose first cell starts with '#'
  const data = [];
  for (let i = headAt + 1; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r.length || String(r[0]).startsWith("#") || r[0] === "") break;
    data.push(r);
  }
  return { csv, rows, head, data, res };
}

prop("csv/every row has the same number of columns as the header", "report", {
  gen: csvCase,
  check: (c) => {
    const { head, data } = parseExport(c);
    const bad = data.find((r) => r.length !== head.length);
    return bad ? { ok: false, why: `row has ${bad.length} cells, header has ${head.length}: ${JSON.stringify(bad).slice(0, 200)}` } : { ok: true };
  },
  simplify: (c) => (c.rooms.length > 1 ? [{ ...c, rooms: c.rooms.slice(0, -1) }] : []),
});

prop("csv/a room name survives the export unchanged (quotes, commas, newlines, unicode)", "report", {
  gen: csvCase,
  check: (c) => {
    const { head, data } = parseExport(c);
    const nameAt = head.indexOf("Name");
    if (nameAt < 0) return { ok: false, why: "no Name column" };
    const out = data.map((r) => r[nameAt]);
    const want = c.rooms.map((r) => r.name);
    for (let i = 0; i < want.length; i += 1) {
      if (out[i] !== want[i]) {
        const neutralised = "'" + want[i] === out[i];
        if (!neutralised) return { ok: false, why: `name ${JSON.stringify(want[i])} came back as ${JSON.stringify(out[i])}` };
      }
    }
    return { ok: true };
  },
  simplify: (c) => (c.rooms.length > 1 ? [{ ...c, rooms: c.rooms.slice(0, -1) }] : []),
});

prop("csv/no emitted cell can start with a formula character", "report", {
  gen: csvCase,
  check: (c) => {
    const { head, data } = parseExport(c);
    const unsafe = [];
    for (const r of data) {
      r.forEach((cell, i) => {
        if (/^[=+@]/.test(cell) || (/^-/.test(cell) && !/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cell))) {
          unsafe.push({ column: head[i], cell });
        }
      });
    }
    return unsafe.length ? { ok: false, why: `formula-leading cells survived: ${JSON.stringify(unsafe).slice(0, 300)}` } : { ok: true };
  },
  simplify: (c) => (c.rooms.length > 1 ? [{ ...c, rooms: c.rooms.slice(0, -1) }] : []),
});

prop("csv/the TR column reads back the number the engine produced", "report", {
  gen: csvCase,
  check: (c) => {
    const { head, data, res } = parseExport(c);
    const trAt = head.indexOf("TR");
    if (trAt < 0) return { ok: false, why: "no TR column" };
    const inc = res.results;
    if (data.length !== inc.length) return { ok: false, why: `${data.length} data rows for ${inc.length} results` };
    for (let i = 0; i < inc.length; i += 1) {
      const got = Number(data[i][trAt]);
      if (!near(got, inc[i].tr, 0, 0.005)) return { ok: false, why: `row ${i} TR ${got} vs engine ${inc[i].tr}` };
    }
    return { ok: true };
  },
  simplify: (c) => (c.rooms.length > 1 ? [{ ...c, rooms: c.rooms.slice(0, -1) }] : []),
});

/* ============================== number parsing =========================== */

prop("numbers/a plain decimal string reads back as the same number", "calc", {
  gen: (rng) => ({ v: rng.decimal(0.001, 5000, rng.int(0, 3)) }),
  check: ({ v }) => {
    const s = String(v);
    const got = calc.num(s);
    return near(got, v, 1e-12, 1e-12) ? { ok: true } : { ok: false, why: `num(${JSON.stringify(s)}) = ${got}, expected ${v}` };
  },
  simplify: (c) => [{ ...c, v: 0.125 }, { ...c, v: Math.round(c.v * 10) / 10 }, { ...c, v: 1 }].filter((x) => x.v !== c.v),
});

/* =============================== Monte Carlo ============================= */

prop("uncertainty/the percentiles are ordered and the run is reproducible", "uncertainty", {
  gen: (rng) => ({ rooms: Array.from({ length: rng.int(1, 3) }, () => genRoom(rng, rng.int(1, 2))), seed: rng.int(1, 9999) }),
  check: ({ rooms, seed }) => {
    const mc = monteCarlo(rooms, PROJ, { n: 200, seed });
    const t = mc.tr;
    const order = [t.min, t.p05, t.p25, t.p50, t.p75, t.p95, t.max];
    for (let i = 1; i < order.length; i += 1) {
      if (order[i] < order[i - 1] - 1e-9) return { ok: false, why: `percentiles out of order: ${order.join(" <= ")}` };
    }
    const again = monteCarlo(rooms, PROJ, { n: 200, seed });
    return again.tr.p50 === t.p50 ? { ok: true } : { ok: false, why: `same seed gave p50 ${t.p50} then ${again.tr.p50}` };
  },
  simplify: (c) => (c.rooms.length > 1 ? [{ ...c, rooms: c.rooms.slice(0, -1) }] : []),
});

/* ===================== round 2: hostile input, injection, units ===================== */

/** Values that have turned up in real spreadsheets and typed cells. */
const NASTY = [NaN, Infinity, -Infinity, -5, 0, "", "abc", null, undefined, 1e9, -1e9, "12,5", "1.249,3", []];

prop("engine/no hostile cell can produce a NaN, a negative or an infinite load", "calc", {
  gen: (rng) => {
    const room = genRoom(rng, rng.int(1, 2));
    const field = rng.pick(["area", "height", "people", "light", "equip", "extWall", "glass", "partition"]);
    return { room: { ...room, [field]: rng.pick(NASTY) }, field };
  },
  check: ({ room, field }) => {
    const r = calc.calcRoom(room, PROJ);
    const terms = { rsh: r.rsh, rlh: r.rlh, oaSens: r.oaSens, oaLat: r.oaLat, totalW: r.totalW, supplyLs: r.supplyLs };
    for (const [k, v] of Object.entries(terms)) {
      if (!Number.isFinite(v)) return { ok: false, why: `${field} = ${fmt(room[field])} made ${k} = ${v}` };
      if (v < -1e-9) return { ok: false, why: `${field} = ${fmt(room[field])} made ${k} negative (${v})` };
    }
    if (!(r.shf >= 0 && r.shf <= 1)) return { ok: false, why: `${field} = ${fmt(room[field])} gave SHF ${r.shf}` };
    if (!r.supplyOk && r.supplyLs !== 0) return { ok: false, why: `supply not calculable but supplyLs ${r.supplyLs}` };
    return { ok: true };
  },
  simplify: () => [],
});

prop("numbers/a plain decimal written without a comma is read as that decimal", "calc", {
  gen: (rng) => ({ s: rng.pick(["0.125", "1.005", "2.750", "12.345", "100.125", "0.001", "7.007", "1.234", "2.5", "3.10", "1234.5", String(rng.decimal(0.01, 900, 3))]) }),
  check: ({ s }) => {
    const want = Number(s);
    const got = calc.num(s);
    return near(got, want, 1e-12, 1e-12) ? { ok: true } : { ok: false, why: `num(${JSON.stringify(s)}) = ${got}, expected ${want}` };
  },
  simplify: (c) => [{ s: "0.125" }, { s: "2.750" }, { s: "1.234" }].filter((x) => x.s !== c.s),
});

prop("numbers/the documented thousands forms still parse", "calc", {
  gen: (rng) => ({ v: rng.decimal(1000, 999999, 1) }),
  check: ({ v }) => {
    const whole = Math.round(v);
    const withComma = whole.toLocaleString("en-US");            // 12,345
    if (calc.num(withComma) !== whole) return { ok: false, why: `num(${JSON.stringify(withComma)}) = ${calc.num(withComma)}, expected ${whole}` };
    if (calc.num("1.249,3") !== 1249.3) return { ok: false, why: `num("1.249,3") = ${calc.num("1.249,3")}` };
    if (calc.num("12,5") !== 12.5) return { ok: false, why: `num("12,5") = ${calc.num("12,5")}` };
    return { ok: true };
  },
  simplify: () => [],
});

prop("schedule/an area written with its unit converts to m2", "report", {
  gen: (rng) => ({ n: rng.decimal(0.5, 900, 2), unit: rng.pick(["m2", "m²", "sqm", "ft2", "sqft"]) }),
  check: ({ n, unit }) => {
    const res = parseAreaValue(`${n} ${unit}`);
    if (res.value == null) return { ok: false, why: `could not parse "${n} ${unit}"` };
    const factor = /ft/.test(unit) ? 0.09290304 : 1;
    const want = n * factor;
    // parseAreaValue rounds to 2 dp, so the accepted error is that rounding, not a physics allowance
    return Math.abs(res.value - want) <= 0.0051 ? { ok: true } : { ok: false, why: `"${n} ${unit}" = ${res.value} m2, expected ${want}` };
  },
  simplify: (c) => [{ ...c, n: 10 }, { ...c, n: 1 }].filter((x) => x.n !== c.n),
});

prop("schedule/feet-and-inches reads as metres", "report", {
  gen: (rng) => ({ ft: rng.int(1, 40), inch: rng.int(0, 11) }),
  check: ({ ft, inch }) => {
    const res = parseLengthValue(`${ft}'-${inch}"`);
    const want = ft * 0.3048 + inch * 0.0254;
    return res.value != null && near(res.value, want, 1e-3, 1e-3) ? { ok: true } : { ok: false, why: `${ft}'-${inch}" = ${res.value}, expected ${want}` };
  },
  simplify: (c) => [{ ...c, inch: 0 }, { ...c, ft: 1, inch: 0 }],
});

prop("scalecal/the chosen denominator is always one of the estimates, never invented", "scalecal", {
  gen: (rng) => ({
    E1: { values: [rng.int(50, 400)], count: 1, distinct: 1 },
    E2: { denom: rng.int(50, 400), strong: rng.bool(0.6), n: rng.int(2, 30), total: 30 },
    E3: { denom: rng.bool(0.5) ? rng.int(50, 400) : null, band: null, n: rng.int(0, 12) },
  }),
  check: ({ E1, E2, E3 }) => {
    const out = calibrateScale({ E1, E2, E3 });
    if (out.denom == null) return { ok: true };
    const pool = [E1.values[0], E2.denom, E3.denom].filter((v) => v != null);
    if (!pool.includes(out.denom)) return { ok: false, why: `denom ${out.denom} is not one of ${JSON.stringify(pool)}` };
    if (!(out.denom > 0)) return { ok: false, why: `non-positive denominator ${out.denom}` };
    return { ok: true };
  },
  simplify: (c) => [{ ...c, E3: { denom: null, band: null, n: 0 } }],
});

prop("basis/every statement is settled exactly when no figure it needs is still a gap", "basis", {
  gen: (rng) => {
    const b = makeBasis();
    const ids = Object.keys(b.entries);
    for (const id of ids) if (rng.bool(0.2)) b.entries[id] = { ...b.entries[id], status: rng.pick(["missing", "practice", "confirmed", "cited", "typed"]) };
    return { basis: b };
  },
  check: ({ basis }) => {
    const gaps = new Set(basisGaps(basis).map((g) => g.id));
    const st = basisStatements(basis);
    for (const s of st) {
      const want = s.ids.filter((id) => gaps.has(id)).length === 0;
      if (s.settled !== want) return { ok: false, why: `statement ${s.id} settled=${s.settled}, gaps say ${want}` };
    }
    const open = openStatements(basis).length;
    return open === st.filter((s) => !s.settled).length ? { ok: true } : { ok: false, why: `${open} open statements, ${st.filter((s) => !s.settled).length} unsettled` };
  },
  simplify: () => [],
});

prop("report/no room name can inject markup into the printable report", "report", {
  gen: (rng) => ({ rooms: [{ ...genRoom(rng, 1), name: rng.pick(["<script>alert(1)</script>", '"><img src=x onerror=alert(1)>', "<style>*{display:none}</style>", "Office & Co"]) }] }),
  check: ({ rooms }) => {
    const res = calc.calcProject(rooms, PROJ);
    let html;
    try { html = buildReportHtml({ ...PROJ, name: rooms[0].name }, res, {}); } catch (e) { return { ok: false, why: `buildReportHtml threw: ${e.message}` }; }
    const body = html.slice(html.indexOf("<body"));
    if (/<script>alert\(1\)<\/script>/.test(body)) return { ok: false, why: "a room name injected a live <script> into the report" };
    if (/<img src=x onerror=/.test(body)) return { ok: false, why: "a room name injected an event-handler tag into the report" };
    if (/<style>\*\{display:none\}/.test(body)) return { ok: false, why: "a room name injected a <style> block into the report" };
    return { ok: true };
  },
  simplify: () => [],
});

prop("report/it refuses to print a tonnage until the design basis is complete", "report", {
  gen: (rng) => ({ rooms: Array.from({ length: rng.int(1, 4) }, () => genRoom(rng, rng.int(1, 2))) }),
  check: ({ rooms }) => {
    const res = calc.calcProject(rooms, PROJ);
    const html = buildReportHtml({ ...PROJ }, res, {});           // default basis: practice values unconfirmed
    const refused = html.includes("NOT ISSUED");
    const total = res.totals.tr.toFixed(2);
    if (!refused) return { ok: false, why: `issued a report from an unconfirmed basis (total ${total} TR)` };
    if (html.includes(total + " TR") || new RegExp(total.replace(".", "\\.") + "\\s*TR\\b").test(html)) {
      return { ok: false, why: `the refusal document still printed a tonnage (${total} TR)` };
    }
    return { ok: true };
  },
  simplify: (c) => (c.rooms.length > 1 ? [{ rooms: c.rooms.slice(0, -1) }] : []),
});

prop("report/with every basis figure confirmed it issues the engine's total", "report", {
  gen: (rng) => ({ rooms: Array.from({ length: rng.int(1, 4) }, () => genRoom(rng, rng.int(1, 2))) }),
  check: ({ rooms }) => {
    const res = calc.calcProject(rooms, PROJ);
    const basis = makeBasis();
    for (const id of Object.keys(basis.entries)) basis.entries[id].status = "confirmed";
    const html = buildReportHtml({ ...PROJ }, res, { basis });
    if (html.includes("NOT ISSUED")) return { ok: false, why: "still refused with every figure confirmed" };
    const total = res.totals.tr.toFixed(2);
    if (!html.includes(total)) return { ok: false, why: `issued but never printed the total ${total} TR` };
    return { ok: true };
  },
  simplify: (c) => (c.rooms.length > 1 ? [{ rooms: c.rooms.slice(0, -1) }] : []),
});

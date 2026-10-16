/**
 * js/uncertainty.js — the load as a DISTRIBUTION, not a number.
 *
 * WHY THIS EXISTS
 *   A single tonnage hides the only question a client actually asks: how sure are you? Almost every
 *   figure in the design basis is a range in reality — as-built envelope values differ from nominal,
 *   the outdoor design condition depends on which exceedance level and which station you pick, plug
 *   loads are barely known before fit-out, and occupancy is a guess about people. This module answers
 *   with the app's OWN engine: it draws every driver from its plausible range, runs the real
 *   calculation thousands of times, and reports the resulting TR distribution plus a tornado ranking of
 *   which assumption is actually moving the answer.
 *
 * WHAT THIS IS NOT
 *   It is not new physics and it does not replace the design basis: the ranges below are the *breadth*
 *   of each figure, not a source for it. If the basis is wrong, this correctly reports that the answer
 *   is confidently wrong. Correlations between drivers are NOT modelled (each is drawn independently),
 *   and because the drivers are drawn uniformly the extreme thousandth of the distribution is not a
 *   meaningful number — read the band, not the tail.
 *
 * DETERMINISM
 *   Seeded, never Math.random: the same project, seed and draw count give exactly the same band, so a
 *   report can be re-run and checked. The write-up must state the seed and the draw count.
 */

import { SPACE_TYPES, calcProject } from "./calc.js";

/** Small, fast, seeded PRNG (mulberry32) — reproducible bands matter more than statistical elegance. */
function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The drivers, their plausible ranges, and why each range is what it is.
 *   kind 'mul'  value x factor      (factor sampled uniformly in [lo, hi])
 *   kind 'abs'  value + delta       (delta sampled uniformly in [lo, hi], same unit as the value)
 */
export const DRIVERS = [
  { id: "outDb", label: "Outdoor design dry bulb", kind: "abs", lo: -1, hi: 1, unit: "K",
    why: "The 0.4% vs 1% annual exceedance choice, and station-to-nearby-station variation." },
  { id: "outWb", label: "Coincident wet bulb", kind: "abs", lo: -1, hi: 1, unit: "K",
    why: "Same choice; the wet bulb sets the outdoor-air enthalpy, which is the largest term here." },
  { id: "inDb", label: "Indoor dry bulb", kind: "abs", lo: -1, hi: 1, unit: "K",
    why: "ASHRAE 55 summer comfort band 23–26 °C: the setpoint sits inside a range, not on a point." },
  { id: "uWall", label: "Opaque wall U", kind: "mul", lo: 0.75, hi: 1.25, unit: "×",
    why: "As-built vs nominal assembly values: workmanship, moisture content, unmodelled thermal bridges." },
  { id: "uRoof", label: "Roof U", kind: "mul", lo: 0.75, hi: 1.25, unit: "×",
    why: "As-built vs nominal, plus wet insulation after monsoon." },
  { id: "uGlass", label: "Fenestration U", kind: "mul", lo: 0.85, hi: 1.15, unit: "×",
    why: "Frame and spacer effects on an assembly value." },
  { id: "sc", label: "Shading coefficient", kind: "mul", lo: 0.7, hi: 1.3, unit: "×",
    why: "Whether blinds are drawn, and how the glass actually performs against its rated SHGC." },
  { id: "wwr", label: "Glazing fraction (where glass area is unknown)", kind: "abs", lo: -10, hi: 10, unit: "pp",
    why: "Only used for rooms with no glass area given: the fraction of wall that is glazed is a guess." },
  { id: "infilAch", label: "Infiltration", kind: "mul", lo: 0.5, hi: 1.5, unit: "×",
    why: "Leakage is the least predictable envelope property of all." },
  { id: "light", label: "Lighting power density", kind: "mul", lo: 0.8, hi: 1.2, unit: "×",
    why: "Code caps the installed power, but the design and the control strategy vary within it." },
  { id: "equip", label: "Plug / equipment load", kind: "mul", lo: 0.5, hi: 1.5, unit: "×",
    why: "ECBC excludes plug loads from its scope (PDF p.36), so this is the tenancy's, and it is barely known." },
  { id: "occupancy", label: "Occupancy density", kind: "mul", lo: 0.5, hi: 1.5, unit: "×",
    why: "People per m² is a tenancy assumption, and it drives both the internal gains and the outdoor air." },
  { id: "oap", label: "Outdoor air per person", kind: "mul", lo: 0.5, hi: 2.0, unit: "×",
    why: "ECBC 2017 §5.2.1 delegates the rate to NBC 2016 Part 9 and states none itself; ASHRAE 62.1 office rates are about twice the app's default." },
  { id: "oaa", label: "Outdoor air per floor area", kind: "mul", lo: 0.5, hi: 2.0, unit: "×",
    why: "Same delegation — no rate in the Indian code for this app to cite." },
  { id: "safety", label: "Safety allowance", kind: "abs", lo: -5, hi: 5, unit: "pp",
    why: "Not a physical uncertainty but a decision: 5–15% is the usual spread of practice on the same building." },
];

const DRIVER_BY_ID = new Map(DRIVERS.map((d) => [d.id, d]));

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Where each driver is written. The engine resolves per-room gains from the room itself when present
 *  (js/calc.js normalizeRoom), so internal gains can be varied without touching the engine — except the
 *  outdoor-air rates, which the engine reads straight off SPACE_TYPES. Those two are applied by
 *  temporarily scaling that table, and restored in a finally: the loop is synchronous, so nothing else
 *  can observe the scaled table. */
function applyPicks(rooms, project, picks) {
  const p = Object.assign({}, project);
  const out = rooms.map((r) => Object.assign({}, r));
  const restore = [];
  for (const d of DRIVERS) {
    const f = picks[d.id];
    if (f === undefined || !Number.isFinite(f)) continue;
    switch (d.id) {
      case "light":
      case "equip":
        out.forEach((r) => {
          const st = SPACE_TYPES[r.type] || SPACE_TYPES.general;
          const base = (r[d.id] === undefined || r[d.id] === "") ? st[d.id] : num(r[d.id]);
          r[d.id] = base * f;
        });
        break;
      case "occupancy":
        out.forEach((r) => {
          const st = SPACE_TYPES[r.type] || SPACE_TYPES.general;
          const base = (r.people === undefined || r.people === "" || r.people === null)
            ? (num(r.area) > 0 ? Math.max(1, Math.ceil(num(r.area) / st.m2pp)) : 0)
            : num(r.people);
          r.people = base * f;
        });
        break;
      case "oap":
      case "oaa":
        for (const key of Object.keys(SPACE_TYPES)) {
          if (SPACE_TYPES[key][d.id] === 0) continue;      // 0 means "not applicable to this use"
          restore.push([key, d.id, SPACE_TYPES[key][d.id]]);
          SPACE_TYPES[key][d.id] = SPACE_TYPES[key][d.id] * f;
        }
        break;
      default: {
        const d0 = DRIVER_BY_ID.get(d.id);
        const base = num(project[d.id]);
        // a knob that sits at 0 cannot be scaled: an absolute shift is the only meaningful move
        if (d0 && d0.kind === "abs") p[d.id] = base + f;
        else if (d0 && d0.kind === "mul" && base !== 0) p[d.id] = base * f;
        else if (d0 && d0.kind === "mul") p[d.id] = base + (f - 1);
        break;
      }
    }
  }
  return { project: p, rooms: out, restore };
}

function runOnce(rooms, project, picks) {
  const applied = applyPicks(rooms, project, picks);
  try {
    return num(calcProject(applied.rooms, applied.project).totals.tr);
  } finally {
    for (const [key, field, value] of applied.restore) SPACE_TYPES[key][field] = value;
  }
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Run the calculation thousands of times over the drivers' plausible ranges.
 * @returns {{n:number, seed:number, base:number, tr:object, drivers:Array, notes:string[]}}
 */
export function monteCarlo(rooms, project, opts = {}) {
  const n = Math.max(200, Math.min(50000, opts.n || 10000));
  const seed = opts.seed == null ? 20261016 : opts.seed;
  const active = opts.drivers && opts.drivers.length
    ? DRIVERS.filter((d) => opts.drivers.includes(d.id))
    : DRIVERS.slice();
  const usable = (rooms || []).filter((r) => r && r.include !== false && num(r.area) > 0);

  const base = runOnce(usable, project, {});           // zero drivers = the deterministic answer
  const rng = mulberry32(seed);
  const draws = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const picks = {};
    for (const d of active) picks[d.id] = d.lo + (d.hi - d.lo) * rng();
    draws[i] = runOnce(usable, project, picks);
  }
  const sorted = draws.slice().sort((a, b) => a - b);
  const mean = draws.reduce((a, b) => a + b, 0) / (draws.length || 1);
  const variance = draws.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (draws.length || 1);

  // Tornado: move ONE driver to each end of its own range, everything else at the design value. The
  // swing is how much TR that single assumption is worth — this is what "which figure matters" means.
  const tornado = active.map((d) => {
    const low = runOnce(usable, project, { [d.id]: d.lo });
    const high = runOnce(usable, project, { [d.id]: d.hi });
    return {
      id: d.id, label: d.label, unit: d.unit, why: d.why,
      atLow: low, atHigh: high, swing: Math.abs(high - low),
    };
  }).sort((a, b) => b.swing - a.swing);
  // A driver can be inert for a given project — the roof U is worth nothing on a mid-floor sheet with
  // no roof-exposed room. Those are kept in the list (so the report can say the assumption was examined
  // and found irrelevant HERE) but they take no share: the shares are of the swing that actually exists.
  tornado.forEach((t) => { t.inert = t.swing < 1e-9; });
  const totalSwing = tornado.reduce((a, t) => a + (t.inert ? 0 : t.swing), 0) || 1;
  tornado.forEach((t) => { t.share = t.inert ? 0 : t.swing / totalSwing; });

  return {
    n, seed, driversUsed: active.map((d) => d.id), base,
    tr: {
      mean, sd: Math.sqrt(variance),
      p05: quantile(sorted, 0.05), p25: quantile(sorted, 0.25), p50: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75), p95: quantile(sorted, 0.95),
      min: sorted[0], max: sorted[sorted.length - 1],
      // how wide the middle 90% is, relative to the central value — the one number to quote
      spreadPct: quantile(sorted, 0.5) ? (quantile(sorted, 0.95) - quantile(sorted, 0.05)) / quantile(sorted, 0.5) * 100 : 0,
    },
    drivers: tornado,
    rooms: usable.length,
    notes: [
      "Drivers are drawn independently and uniformly over the stated ranges: correlations between them are not modelled.",
      "The ranges describe how far each figure could reasonably move, not where it came from — the design basis is the source.",
      "Read the band, not the tail: with uniform draws the extreme thousandth is not a meaningful number.",
      "A driver with a zero swing does not affect THIS project at all (the roof U on a sheet with no roof-exposed room, for instance); it is listed so the report can say it was examined.",
    ],
  };
}

/** One line for a report: the band, and what is driving it. */
export function bandLine(mc) {
  const f = (x) => Number(x).toFixed(2);
  const top = mc.drivers.slice(0, 3).map((d, i) => `${i + 1}. ${d.label} (${f(d.swing)} TR, ${Math.round(d.share * 100)}%)`);
  return `${f(mc.tr.p50)} TR (5th–95th percentile ${f(mc.tr.p05)}–${f(mc.tr.p95)} TR, i.e. ±${(mc.tr.spreadPct / 2).toFixed(0)}% around the middle). ` +
    `Top drivers: ${top.join("; ")}. Seeded Monte Carlo, ${mc.n} draws, seed ${mc.seed}, ${mc.driversUsed.length} drivers, ${mc.rooms} rooms.`;
}

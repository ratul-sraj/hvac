/**
 * js/scalecal.js — read the drawing scale OFF THE SHEET instead of trusting a panel setting.
 *
 * WHY THIS EXISTS
 * The drawing scale is the one input every area depends on, and nothing ever checked it against the
 * sheet: `pdfparse.detectScaleText` only classified a `1:N` note as metric-vs-imperial, the number N
 * was never parsed, and `trace.impliedDenom` needs printed areas the sheet may not have. A wrong scale
 * therefore passed silently and made every area wrong by (N_wrong/N_true)^2 — on the real LEVEL 11
 * sheet a session at 1:200 gave areas exactly 4x too big, and on the owner's HQ sheet a missing scale
 * left the default 1:100, which is 6x too small.
 *
 * The key fact that makes this cheap: a region's area in SQUARE POINTS does not depend on the scale.
 * So calibration runs on ONE region pass, in pt^2, before any metre-based accept band or neck test,
 * and the number it produces is applied to everything downstream.
 *
 * ESTIMATORS (all deterministic, no DOM, no pdf.js, no network)
 *   E1 scale text   parse N from `1:N` / `SCALE 1:N` / `1 :200` (and `1/4" = 1'-0"` -> 48).
 *   E2 area labels  for each single-name closed region with a printed m^2:
 *                   N_i = (72/0.0254) * sqrt(A_printed_i / A_pt2_i); take the DENSEST +-8% window.
 *   E3 object priors door arcs: a real door leaf is 0.75-1.05 m, so each arc radius implies a scale.
 *   E4 paper sanity  page extent x N must be a plausible building footprint (5-300 m). Rejection only.
 *
 * CONTRACT
 * - Pure and deterministic: same input -> byte-identical output.
 * - `null` denom means "no trustworthy scale" — the caller must NOT write an area at that scale.
 */

import { polygonAreaPt2 } from "./trace.js";
import { parseScaleDenom } from "./pdfparse.js";

export const PT_PER_INCH = 72;
export const M_PER_INCH = 0.0254;

/** Metres per PDF point at 1:N (mirrors trace.metresPerPt). */
export const metresPerDenom = (n) => (M_PER_INCH * Number(n)) / PT_PER_INCH;

/** N implied by a known real length over a known paper length in points. */
const denomFromLengths = (realM, ptLen) => (realM * PT_PER_INCH) / (M_PER_INCH * ptLen);

// ---------------------------------------------------------------------------------------------
// E1 — scale text
// ---------------------------------------------------------------------------------------------

/**
 * E1: every `1:N` note in the text layer, as a list of estimates.
 * @param {Array<{str:string,x?:number,y?:number,page?:number}>} items
 * @returns {{values:number[], count:number, distinct:number, sample:string|null}}
 */
export function scaleTextEstimate(items) {
  const values = [];
  let sample = null;
  for (const it of Array.isArray(items) ? items : []) {
    const s = String((it && it.str) || "");
    const hit = parseScaleDenom(s);
    if (hit) { values.push(hit.denom); if (!sample) sample = hit.raw; }
  }
  const distinct = new Set(values).size;
  return { values, count: values.length, distinct, sample };
}

// ---------------------------------------------------------------------------------------------
// E2 — printed area labels
// ---------------------------------------------------------------------------------------------

const M2_PER_PT2_TO_DENOM = PT_PER_INCH / M_PER_INCH;   // 72/0.0254 = 2834.65

/**
 * E2: what denominator do the printed m^2 figures imply?
 * @param {Array<{rings?:Array, areaPt2?:number, rooms?:Array}>} regions  single-name closed regions
 * @returns {{denom:number|null, window:{lo:number,hi:number}|null, n:number, total:number, inlierFraction:number, strong:boolean}}
 */
export function areaScaleEstimate(regions) {
  const implied = [];
  for (const g of Array.isArray(regions) ? regions : []) {
    if (!g || g.closed === false) continue;
    const rooms = g.rooms || [];
    if (rooms.length !== 1) continue;
    const printed = Number(rooms[0] && rooms[0].area);
    if (!(printed > 2)) continue;
    let pt2 = Number(g.areaPt2);
    if (!Number.isFinite(pt2) || pt2 <= 0) pt2 = (g.rings || []).reduce((s, r) => s + polygonAreaPt2(r), 0);
    if (!(pt2 > 0)) continue;
    const n = M2_PER_PT2_TO_DENOM * Math.sqrt(printed / pt2);
    if (Number.isFinite(n) && n > 2 && n < 5000) implied.push(n);
  }
  const total = implied.length;
  if (total < 3) return { denom: null, window: null, n: 0, total, inlierFraction: 0, strong: false };
  const sorted = [...implied].sort((a, b) => a - b);
  // Densest +-8% window (a sliding count in log space is exact for a multiplicative band).
  const W = 1.08;
  let best = { n: 0, lo: 0, hi: 0 };
  for (let i = 0; i < sorted.length; i += 1) {
    const lo = sorted[i], hi = lo * W;
    let j = i;
    while (j < sorted.length && sorted[j] <= hi) j += 1;
    if (j - i > best.n) best = { n: j - i, lo, hi };
  }
  const inliers = sorted.filter((v) => v >= best.lo && v <= best.hi);
  const denom = inliers[Math.floor(inliers.length / 2)];
  const inlierFraction = best.n / total;
  // "Strong" per the spec: the window holds at least 5 inliers AND at least 25% of all labels.
  const strong = best.n >= 5 && inlierFraction >= 0.25;
  return {
    denom: Math.round(denom), window: { lo: Math.round(best.lo), hi: Math.round(best.hi) },
    n: best.n, total, inlierFraction, strong,
  };
}

// ---------------------------------------------------------------------------------------------
// E3 — object priors (door arcs)
// ---------------------------------------------------------------------------------------------

/** A real door leaf (hinge to the far edge of the swing) is 0.75-1.05 m, ~0.85 m in practice. */
export const DOOR_LEAF_M = { lo: 0.75, hi: 1.05, mode: 0.85 };

/** The cubic-Bezier control distance for a quarter circle: k = 4/3 * tan(pi/8) = 0.5523. */
const QUARTER_K = 0.5522847498;

/**
 * Radii of the door swings in a raw curve list (see trace.segmentsFromOperatorList `curves`).
 * A door swing is drawn as ONE curveTo. For the quarter-circle Bezier an architect's tool emits, the
 * control point sits at k*r from the start (and from the end), so r = |start - c1| / k. A curve is
 * kept only when both ends agree (within 25%) and the chord fits a plausible sweep (40-150 deg).
 * @param {Array<{x0,y0,x1,y1,x2,y2,x3,y3}>} curves
 * @returns {number[]} radii in PDF points
 */
export function detectArcRadii(curves) {
  const radii = [];
  for (const c of Array.isArray(curves) ? curves : []) {
    const r1 = Math.hypot(c.x1 - c.x0, c.y1 - c.y0) / QUARTER_K;
    const r2 = Math.hypot(c.x3 - c.x2, c.y3 - c.y2) / QUARTER_K;
    if (!(r1 > 1) || !(r2 > 1)) continue;
    if (Math.abs(r1 - r2) / Math.min(r1, r2) > 0.25) continue;
    const r = (r1 + r2) / 2;
    const chord = Math.hypot(c.x3 - c.x0, c.y3 - c.y0);
    const ratio = chord / r;
    if (ratio < 0.70 || ratio > 1.90) continue;
    radii.push(+r.toFixed(3));
  }
  return radii;
}

/**
 * E3: denominator implied by door-swing radii.
 * A door leaf of `mode` metres on paper spans `r` points, so N = leaf / metresPerDenom(1) / r.
 * Arc radii are turned into implied denominators and the DENSEST +-8% window is kept, which rejects
 * the decorative curves (chair backs, rounded corners) that do not cluster like a repeated door.
 * @param {Array<{x0,y0,x1,y1,x2,y2,x3,y3}>} curves
 * @returns {{denom:number|null, band:{lo:number,hi:number}|null, n:number, radii:number[]}}
 */
export function objectScaleEstimate(curves) {
  const radii = detectArcRadii(curves);
  if (!radii.length) return { denom: null, band: null, n: 0, radii };
  const implied = radii
    .map((r) => denomFromLengths(DOOR_LEAF_M.mode, r))
    .filter((n) => n > 40 && n < 500)
    .sort((a, b) => a - b);
  if (!implied.length) return { denom: null, band: null, n: 0, radii };
  const W = 1.08;
  let best = { n: 0, lo: 0, hi: 0 };
  for (let i = 0; i < implied.length; i += 1) {
    const hi = implied[i] * W;
    let j = i;
    while (j < implied.length && implied[j] <= hi) j += 1;
    if (j - i > best.n) best = { n: j - i, lo: implied[i], hi: implied[j - 1] };
  }
  const inliers = implied.filter((v) => v >= best.lo && v <= best.hi);
  const denom = inliers[Math.floor(inliers.length / 2)];
  // The band from the leaf range: the widest and narrowest arc in the kept window bracket it.
  const keptRadii = radii.filter((r) => { const n = denomFromLengths(DOOR_LEAF_M.mode, r); return n >= best.lo && n <= best.hi; });
  const maxR = keptRadii.length ? Math.max(...keptRadii) : Math.max(...radii);
  const minR = keptRadii.length ? Math.min(...keptRadii) : Math.min(...radii);
  const band = { lo: Math.round(denomFromLengths(DOOR_LEAF_M.lo, maxR)), hi: Math.round(denomFromLengths(DOOR_LEAF_M.hi, minR)) };
  return { denom: Math.round(denom), band, n: inliers.length, radii };
}

// ---------------------------------------------------------------------------------------------
// E4 — paper sanity (rejection only)
// ---------------------------------------------------------------------------------------------

/** A few standard sheet sizes (points), rotation-agnostic (short x long). */
const PAPERS = [
  { name: "A4", s: 595, l: 842 }, { name: "A3", s: 842, l: 1191 },
  { name: "A2", s: 1191, l: 1684 }, { name: "A1", s: 1684, l: 2384 },
  { name: "A0", s: 2384, l: 3370 },
  { name: "ANSI D", s: 1728, l: 2448 }, { name: "ANSI E", s: 2448, l: 3168 },
  { name: "ANSI C", s: 1224, l: 1584 }, { name: "ANSI B", s: 792, l: 1224 },
];

/** Which standard paper is this MediaBox? Nearest by short/long side, within 3%. */
export function paperKind(box) {
  if (!box) return null;
  const a = Math.abs(box.x1 - box.x0), b = Math.abs(box.y1 - box.y0);
  const s = Math.min(a, b), l = Math.max(a, b);
  let best = null, bestErr = Infinity;
  for (const p of PAPERS) {
    const err = Math.abs(s - p.s) / p.s + Math.abs(l - p.l) / p.l;
    if (err < bestErr) { bestErr = err; best = p; }
  }
  return bestErr <= 0.06 ? best.name : null;
}

/** E4: is a denominator physically sane for this page? (footprint = page extent x N, 5-300 m) */
export function paperSanity(box, denom) {
  if (!box || !(denom > 0)) return { ok: false, footprintM: null };
  const longPt = Math.max(Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
  const m = longPt * metresPerDenom(denom);
  return { ok: m >= 5 && m <= 300, footprintM: +m.toFixed(1) };
}

// ---------------------------------------------------------------------------------------------
// The decision rule
// ---------------------------------------------------------------------------------------------

const AGREES = (a, b) => {
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) / Math.min(a, b) <= 0.07;   // within +-7% linear
};
/** Exported so the app can test two estimates itself (e.g. "do the note and the arcs disagree?"). */
export const agrees = AGREES;

/** Is `n` inside an E3 object-prior band (the leaf range bracketed by the kept arcs)? */
const inBand = (n, band) => !!(band && n >= band.lo && n <= band.hi);

/** Is this ratio within 3% of a common re-plot factor (sqrt2, 2, 2.5, 4)? */
export function replotFlag(a, b) {
  if (!(a > 0) || !(b > 0)) return null;
  const r = Math.max(a, b) / Math.min(a, b);
  for (const f of [Math.SQRT2, 2, 2.5, 4]) if (Math.abs(r - f) / f <= 0.03) return f;
  return null;
}

/**
 * The decision rule from docs/ZONE-DETECTION-RESEARCH.md section 3.
 * @param {object} p
 * @param {{values:number[],count:number,distinct:number}} [p.E1]
 * @param {{denom:number|null,strong:boolean,n:number,total:number}} [p.E2]
 * @param {{denom:number|null,band:{lo:number,hi:number}|null,n:number}} [p.E3]
 * @param {{x0,y0,x1,y1}} [p.box]
 * @returns {{denom:number|null, confidence:'high'|'medium'|'conflict'|'none', source:string,
 *            agree:string|null, conflict:object|null, replot:number|null, estimates:object}}
 */
export function calibrateScale({ E1, E2, E3, box } = {}) {
  const e1 = E1 && E1.values && E1.values.length
    ? E1.values.slice().sort((a, b) => a - b)[Math.floor(E1.values.length / 2)] : null;
  const e2 = E2 && E2.strong ? E2.denom : null;
  const e3 = E3 && E3.denom ? E3.denom : null;
  const estimates = {
    E1: e1 == null ? null : { denom: e1, count: E1.count, distinct: E1.distinct },
    E2: E2 ? { denom: E2.denom, strong: !!E2.strong, n: E2.n, total: E2.total } : null,
    E3: E3 ? { denom: e3, band: E3.band, n: E3.n } : null,
  };

  let denom = null, confidence = "none", source = "", agree = null, conflict = null;

  if (e2 != null) {
    denom = e2; source = "E2";
    const e3Agrees = e3 != null && (AGREES(e3, e2) || inBand(e2, E3.band));
    if ((e1 != null && AGREES(e1, e2)) || e3Agrees) confidence = "high";
    else {
      confidence = "conflict";
      const others = [];
      if (e1 != null) others.push(`the sheet's note says 1:${e1}`);
      if (e3 != null) others.push(`door sizes say 1:${e3}`);
      conflict = { winner: e2, note: others.join("; "), wouldBeFactor: e1 != null ? replotFlag(e1, e2) : (e3 != null ? replotFlag(e3, e2) : null) };
    }
  } else if (e1 != null && e3 != null) {
    if (AGREES(e1, e3) || inBand(e1, E3.band)) { denom = e1; source = "E1+E3"; confidence = "high"; agree = "E3"; }
    else {
      denom = (E3 && E3.n >= 8) ? e3 : null;
      source = denom == null ? "" : "E3";
      confidence = denom == null ? "none" : "conflict";
      conflict = { winner: denom, note: `the sheet's note says 1:${e1}, door sizes say 1:${e3}`, wouldBeFactor: replotFlag(e1, e3) };
    }
  } else if (e1 != null) { denom = e1; source = "E1"; confidence = "medium"; }
  else if (e3 != null) { denom = e3; source = "E3"; confidence = "medium"; }

  // E4 rejection: a denominator whose footprint leaves the building-size band is not usable.
  if (denom != null && box) {
    const sanity = paperSanity(box, denom);
    if (!sanity.ok) { denom = null; confidence = "none"; source = ""; }
  }
  const replot = conflict ? conflict.wouldBeFactor : null;
  return { denom, confidence, source, agree, conflict, replot, estimates };
}

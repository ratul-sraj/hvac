// tests/proptest/lib.mjs — tiny, dependency-free property-testing machinery.
// No framework: a seeded PRNG, generators, a strict RFC-4180 CSV reader, and a greedy shrinker.
// Kept in-repo (not a devDependency) so the suite runs on any machine with node, like the rest of tests/.

/** mulberry32 — same PRNG the product uses for the Monte Carlo, so runs are reproducible. */
export function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) { this.next = mulberry32(seed >>> 0); }
  float(lo = 0, hi = 1) { return lo + (hi - lo) * this.next(); }
  int(lo, hi) { return Math.floor(this.float(lo, hi + 1)); }
  pick(arr) { return arr[this.int(0, arr.length - 1)]; }
  bool(p = 0.5) { return this.next() < p; }
  /** A number with a controlled number of decimals — so shrinking can remove float noise. */
  decimal(lo, hi, dp) {
    const f = 10 ** dp;
    return Math.round(this.float(lo, hi) * f) / f;
  }
}

/* ------------------------------- CSV -------------------------------------- */

/** Strip the UTF-8 BOM the export prepends. */
export const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/**
 * A strict RFC-4180 reader: quoted fields, doubled quotes, CRLF or LF, no trimming, and it THROWS on a
 * quote in the middle of an unquoted field. Written independently of js/report.js so the round-trip
 * check is not the exporter checking itself.
 */
export function parseCsvStrict(text) {
  const s = stripBom(String(text));
  const rows = [];
  let row = [], field = "", i = 0, quoted = false, inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; quoted = true; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') {
      if (field.length) throw new Error(`bare quote inside an unquoted field at offset ${i}`);
      inQuotes = true; quoted = false; i += 1; continue;
    }
    if (c === ",") { pushField(); i += 1; continue; }
    if (c === "\r" && s[i + 1] === "\n") { pushRow(); i += 2; continue; }
    if (c === "\n") { pushRow(); i += 1; continue; }
    field += c; quoted = false; i += 1;
  }
  if (inQuotes) throw new Error("unterminated quoted field");
  if (field.length || row.length) pushRow();
  // drop the empty trailing row produced by a file ending in a newline
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return rows;
}

/* ------------------------------ reporting --------------------------------- */

export const fmt = (v) => {
  try { return JSON.stringify(v); } catch { return String(v); }
};

/** Greedy shrinking: repeatedly take the first simpler case that still fails. */
export function shrink(initialFailure, simplify, maxSteps = 80) {
  let best = initialFailure;
  let steps = 0;
  while (steps < maxSteps) {
    const candidates = simplify(best.arg) || [];
    let moved = false;
    for (const c of candidates) {
      let res;
      try { res = best.check(c); } catch (e) { res = { ok: false, why: `threw: ${e.message}` }; }
      if (res && res.ok === false) { best = { arg: c, check: best.check, res, detail: res.why }; moved = true; break; }
    }
    if (!moved) break;
    steps += 1;
  }
  return best;
}

/* ------------------------------ geometry --------------------------------- */

/** Andrew's monotone chain. Returns the hull in counter-clockwise order — a ring that is ALWAYS simple. */
export function convexHull(points) {
  const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

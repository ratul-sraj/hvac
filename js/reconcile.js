/**
 * js/reconcile.js — can each area be CHECKED, and does it agree?
 *
 * WHY THIS EXISTS
 *   An area is the single largest driver of the load, and the app produces two kinds of figure: the
 *   number the DRAWING prints for the room, and a number MEASURED from the drawing's geometry. If only
 *   one of those exists, nothing about that room can be checked — and the app must say so rather than
 *   present an unverifiable number with the same confidence as a verified one.
 *
 * WHAT IS ACTUALLY AN INDEPENDENT SOURCE (this is the whole point, so it is written down):
 *   - The sheet's own printed area (the architect's figure). Independent of this app's geometry.
 *   - A ring measured from the drawing — traced automatically, or drawn by hand. Independent of the
 *     sheet's printed figure.
 *   A PLACED BOX IS NOT INDEPENDENT: the app sizes a placed box BACK FROM the printed area (see
 *   `roomFromRect`/`rectFromLabel`), so comparing a box against the printed figure compares a number
 *   with itself. It is reported as `sheet-derived`, never as agreement.
 *
 * MEASURED FACT ABOUT THE SHEETS THIS APP SEES (see docs/DESIGN-BASIS.md and tests/qa/dim-probe.mjs):
 *   NONE of the available sheets carries dimension chains or gridlines — the numbers in a PDF text
 *   layer are room tags (101, 102 …), not millimetres. So the "compare against the dimension chain"
 *   check has no material to work with on these drawings, and the sheet's printed area is the only
 *   independent figure that exists. Where a sheet prints no areas at all (the LEVEL 11 sample prints
 *   none), nothing can be checked and this module says exactly that.
 *
 * THE 5% RULE
 *   A disagreement over 5% between two independent measurements of the same room is a DATA DEFECT to
 *   surface, not a rounding to hide: either the geometry was misread (a mis-scaled sheet, a piece of
 *   wall mistaken for a boundary) or the printed figure is stale. Either way the engineer decides, not
 *   the app — so the row carries both figures and the percentage.
 */

export const DEFAULT_TOLERANCE_PCT = 5;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Which sources exist for this room. Never invents one. */
export function areaSources(room) {
  const r = room || {};
  const sheet = num(r.areaStated);                                     // the drawing's own printed figure
  const ring = Array.isArray(r.poly) && r.poly.length > 2;
  const measured = !!r.areaFromDrawing && ring;                        // measured from the drawing
  const drawn = r.source === "drawn" && ring;                          // measured, but by hand
  const box = !!(r.rect && r.rect.placed);                             // sized BACK FROM the printed area
  return {
    sheet,
    geometry: measured ? "traced" : (drawn ? "drawn" : null),
    geometryValue: (measured || drawn) ? num(r.area) : null,
    sheetDerivedBox: box,
    typed: !!r.areaTyped,
    value: num(r.area),
    unknown: !!r.areaUnknown || num(r.area) == null,
  };
}

/** One room's reconciliation row. */
export function reconcileRoom(room, opts = {}) {
  const tol = Number.isFinite(opts.tolerance) ? opts.tolerance : DEFAULT_TOLERANCE_PCT;
  const s = areaSources(room);
  const row = {
    id: (room && room.id) || "", name: (room && room.name) || "",
    sheet: s.sheet, geometry: s.geometryValue, geometryKind: s.geometry,
    typed: s.typed, value: s.value,
    diffPct: null, verdict: "none", note: "",
  };
  if (s.unknown && s.sheet == null) { row.verdict = "none"; return row; }
  if (s.typed) {
    // The engineer's own figure wins outright and is never silently replaced, so there is nothing to
    // reconcile — but it is not an audited number either, and the report says so.
    row.verdict = "typed";
    row.note = "entered by hand";
    return row;
  }
  if (s.sheet != null && s.geometryValue != null) {
    const d = s.sheet !== 0 ? Math.abs(s.geometryValue - s.sheet) / Math.abs(s.sheet) * 100 : 0;
    row.diffPct = d;
    row.verdict = d <= tol ? "agree" : "flag";
    row.note = d <= tol
      ? `measured ${s.geometryValue} m² vs the sheet's ${s.sheet} m²`
      : `measured ${s.geometryValue} m² against the sheet's ${s.sheet} m² — ${d.toFixed(1)}% apart`;
    return row;
  }
  if (s.geometryValue != null) {
    row.verdict = "unchecked";
    row.note = "measured from the drawing; this sheet prints no area to check it against";
    return row;
  }
  if (s.sheet != null) {
    row.verdict = s.sheetDerivedBox ? "sheet-derived" : "unchecked";
    row.note = s.sheetDerivedBox
      ? "a placed box sized back from the sheet's own figure — it cannot check it"
      : "the sheet's printed figure only; nothing independent to check it against";
    return row;
  }
  row.verdict = "none";
  return row;
}

/** Every room, plus what the whole sheet is capable of. */
export function reconcileAreas(rooms, opts = {}) {
  const tol = Number.isFinite(opts.tolerance) ? opts.tolerance : DEFAULT_TOLERANCE_PCT;
  const rows = (rooms || []).filter((r) => r && r.include !== false).map((r) => reconcileRoom(r, opts));
  const by = (v) => rows.filter((r) => r.verdict === v);
  const agreed = by("agree"), flagged = by("flag");
  const diffs = agreed.concat(flagged).map((r) => r.diffPct).filter((d) => d != null).sort((a, b) => a - b);
  const median = diffs.length
    ? (diffs.length % 2 ? diffs[(diffs.length - 1) / 2]
      : (diffs[diffs.length / 2 - 1] + diffs[diffs.length / 2]) / 2)
    : null;
  const summary = {
    tolerance: tol,
    rooms: rows.length,
    withSheet: rows.filter((r) => r.sheet != null).length,
    withGeometry: rows.filter((r) => r.geometry != null).length,
    // The number that matters: how many rooms could be checked AT ALL, i.e. hold two independent figures.
    checkable: agreed.length + flagged.length,
    agree: agreed.length,
    flag: flagged.length,
    unchecked: by("unchecked").length,
    sheetDerived: by("sheet-derived").length,
    typed: by("typed").length,
    none: by("none").length,
    medianAbsDiff: median,
    maxAbsDiff: diffs.length ? diffs[diffs.length - 1] : null,
    // Can this sheet be checked at all? If it prints no areas, the honest answer is no.
    independentSourceExists: rows.some((r) => r.sheet != null),
    flagRows: flagged.slice().sort((a, b) => b.diffPct - a.diffPct),
  };
  return { rows, summary };
}

/** One plain sentence for the report. */
export function reconcileLine(res) {
  const s = res.summary;
  if (!s.rooms) return "No rooms are included in the load.";
  if (!s.independentSourceExists) {
    return `${s.rooms} room${s.rooms === 1 ? "" : "s"} in the load. This drawing prints no room areas, ` +
      `so no area here can be checked against an independent figure — the areas come from the drawing's ` +
      `own geometry alone${s.typed ? `, and ${s.typed} ${s.typed === 1 ? "was" : "were"} typed by hand` : ""}.`;
  }
  const base = `${s.checkable} of ${s.rooms} room${s.rooms === 1 ? "" : "s"} carry two independent areas ` +
    `(the sheet's printed figure and a measurement from the drawing): ${s.agree} agree within ${s.tolerance}%` +
    (s.medianAbsDiff != null ? ` (median ${s.medianAbsDiff.toFixed(1)}%, worst ${s.maxAbsDiff.toFixed(1)}%)` : "") +
    `${s.flag ? `, and ${s.flag} disagree by more than ${s.tolerance}%` : ""}.`;
  const rest = [];
  if (s.unchecked) rest.push(`${s.unchecked} measured from geometry with no printed figure to check against`);
  if (s.sheetDerived) rest.push(`${s.sheetDerived} carrying the sheet's figure only`);
  if (s.typed) rest.push(`${s.typed} entered by hand`);
  return base + (rest.length ? ` Not checkable: ${rest.join("; ")}.` : "");
}

// js/unitdetect.js — "does this drawing talk in metric or imperial?"
//
// Reads the RAW evidence the parser recorded (js/pdfparse.js -> `unitEvidence`, carried on the parse
// result as `.evidence`): the unit each accepted area figure was written in, the format of each
// dimension run, and any scale note. It never re-reads the PDF and never invents evidence, so what
// it reports can never disagree with what the parser actually accepted.
//
// The rules (docs/UNITS-PLAN.md):
//   * imperial evidence = ft²/sft/sq ft areas, feet-inch dimensions, `1/4" = 1'-0"` scale notes;
//     metric evidence   = m²/sqm areas, mm-style dimensions, `1:100` scale notes.
//   * agreement (>= 2 pieces, nothing contradicting) -> high confidence; one piece -> low.
//   * nothing at all -> system 'unknown', confidence 'none'.
//   * contradiction (both systems present) -> low confidence with the counts, reported honestly,
//     never resolved by guessing.
//
// It never throws and always returns a non-empty `reason`: a null, empty, or odd parse result is
// simply "unknown", not a crash.

export const SAMPLE_LIMIT = 5;

const empty = () => ({
  areaUnits: { m2: 0, ft2: 0 },
  dims: { metric: 0, feet: 0 },
  scaleText: { metric: 0, imperial: 0 },
  samples: [],
});

/** Positive integer count, or 0. Never NaN, never negative, never a string. */
const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** Read the evidence off whatever the caller passed; tolerate a bare evidence object, null, junk. */
function normalize(parseResult) {
  let src = {};
  try {
    if (parseResult && typeof parseResult === "object") {
      src = parseResult.evidence && typeof parseResult.evidence === "object"
        ? parseResult.evidence
        : parseResult; // also accept a bare evidence record
    }
    const au = src.areaUnits && typeof src.areaUnits === "object" ? src.areaUnits : {};
    const dm = src.dims && typeof src.dims === "object" ? src.dims : {};
    const st = src.scaleText && typeof src.scaleText === "object" ? src.scaleText : {};
    const samples = Array.isArray(src.samples)
      ? src.samples
          .filter((s) => typeof s === "string" && s.trim())
          .map((s) => s.replace(/\s+/g, " ").trim())
          .slice(0, SAMPLE_LIMIT)
      : [];
    return {
      areaUnits: { m2: count(au.m2), ft2: count(au.ft2) },
      dims: { metric: count(dm.metric), feet: count(dm.feet) },
      scaleText: { metric: count(st.metric), imperial: count(st.imperial) },
      samples,
    };
  } catch {
    return empty();
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Human phrases for the pieces of evidence that support one system (e.g. "4 ft² area figures"). */
function phrases(system, ev) {
  const out = [];
  if (system === "ip") {
    if (ev.areaUnits.ft2) out.push(plural(ev.areaUnits.ft2, "ft² area figure", "ft² area figures"));
    if (ev.dims.feet) out.push(plural(ev.dims.feet, "feet-inch dimension", "feet-inch dimensions"));
    if (ev.scaleText.imperial) out.push(plural(ev.scaleText.imperial, '1/4" = 1\'-0" scale note', '1/4" = 1\'-0" scale notes'));
  } else {
    if (ev.areaUnits.m2) out.push(plural(ev.areaUnits.m2, "m² area figure", "m² area figures"));
    if (ev.dims.metric) out.push(plural(ev.dims.metric, "mm-style dimension", "mm-style dimensions"));
    if (ev.scaleText.metric) out.push(plural(ev.scaleText.metric, "1:100-style scale note", "1:100-style scale notes"));
  }
  return out;
}

const join = (arr) => (arr.length <= 1 ? arr.join("") : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1]);

/**
 * Detect the unit system a parsed sheet speaks.
 * @param {{evidence?:object}|object|null} parseResult the parse result (js/pdfparse.js) or a bare evidence record
 * @returns {{system:'si'|'ip'|'unknown', confidence:'high'|'low'|'none',
 *            evidence:{areaUnits:{m2:number,ft2:number},dims:{metric:number,feet:number},
 *                      scaleText:{metric:number,imperial:number},samples:string[]}, reason:string}}
 */
export function detectUnits(parseResult) {
  const ev = normalize(parseResult);
  const imp = ev.areaUnits.ft2 + ev.dims.feet + ev.scaleText.imperial;
  const met = ev.areaUnits.m2 + ev.dims.metric + ev.scaleText.metric;

  const out = (system, confidence, reason) => ({ system, confidence, evidence: ev, reason });

  // ---- nothing at all -----------------------------------------------------
  if (imp === 0 && met === 0) {
    return out("unknown", "none",
      "No unit evidence found: the sheet prints no areas, dimensions or scale notes this tool " +
      "recognises, so its unit system is unknown.");
  }

  // ---- contradictory evidence: say so, do not guess -----------------------
  if (imp > 0 && met > 0) {
    const system = imp > met ? "ip" : met > imp ? "si" : "unknown";
    const reason =
      `Conflicting units on this sheet: imperial evidence (${join(phrases("ip", ev))}) and metric ` +
      `evidence (${join(phrases("si", ev))}) both appear, so it is reported as uncertain rather than ` +
      `guessed. ${imp} imperial vs ${met} metric piece${imp + met === 1 ? "" : "s"} of evidence.`;
    return out(system, "low", reason);
  }

  // ---- one system only ----------------------------------------------------
  const system = imp > 0 ? "ip" : "si";
  const n = imp > 0 ? imp : met;
  const label = system === "ip" ? "imperial" : "metric";
  if (n >= 2) {
    const reason =
      `Sheet reads as ${label}: ${join(phrases(system, ev))} agree, with no ${system === "ip" ? "metric" : "imperial"} ` +
      `evidence at all on this sheet.`;
    return out(system, "high", reason);
  }
  const reason =
    `Sheet looks ${label} but on a single piece of evidence: ${join(phrases(system, ev))}. ` +
    `One figure is not enough to be sure, so confidence is low.`;
  return out(system, "low", reason);
}

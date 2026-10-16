/**
 * js/basis.js — THE DESIGN BASIS: every figure the load depends on, with where it came from.
 *
 * WHY THIS EXISTS
 *   The engine (js/calc.js) multiplies areas by a dozen hard-coded constants and prints a tonnage. Those
 *   constants are plausible engineering practice, but none of them carries a source, and the app totals
 *   the load whether or not anybody ever confirmed them. A load nobody can trace to a standard is not a
 *   design document — it is a guess with decimals. This module makes each figure an explicit, sourced,
 *   user-confirmed entry, and lets the app REFUSE to total a load built on an unconfirmed basis.
 *
 * THE THREE KINDS OF SOURCE (a figure is one of these, never nothing):
 *   'code'     a published requirement or default, cited with the document, table and page
 *   'climate'  an outdoor design condition, carrying the station provenance from js/climates.js
 *   'practice' a value from engineering practice with NO standard behind it — allowed, but it must be
 *              confirmed by the engineer, and the report says so in those words
 *
 * WHAT THE CITATIONS ARE (all verified against the published documents, not recalled):
 *   Envelope (warm and humid zone — Kerala) from ECBC 2017 (Bureau of Energy Efficiency, India):
 *     roof assembly U        <= 0.33 W/m2K   Table 4-4, printed p.25  (PDF p.57)
 *     opaque wall U          <= 0.40 W/m2K   Table 4-7, printed p.26  (PDF p.58)
 *     fenestration U         <= 3.00 W/m2K   Table 4-10, printed p.27 (PDF p.59)
 *     SHGC (non-North)       <= 0.27         Table 4-10, warm and humid
 *     SHGC (North, lat>=15)  <= 0.50         Table 4-10, warm and humid
 *     WWR                    <= 40%          §4.3.3 (PDF p.58)
 *     VLT                    >= 0.27         §4.3.3 (PDF p.58)
 *   Lighting: office building LPD 9.5 W/m2, ECBC 2017 Table 6-1 (Building Area Method, printed p.64 /
 *     PDF p.96).
 *   Ventilation: ECBC 2017 §5.2.1 (PDF p.75) requires outdoor air "as per NBC" — the Code itself does
 *     not state a rate. The app's per-person and per-m2 figures therefore carry NO code citation and are
 *     marked 'practice': they must be confirmed against NBC 2016 Part 9 (or ASHRAE 62.1) for the project.
 *   Plug loads: ECBC 2017 (PDF p.36) states the Code does not apply to plug loads at all, so the figure
 *     comes from the tenancy brief — 'practice', and named as such.
 *   Comfort: ASHRAE Standard 55 summer office range 23-26 C / 30-60% RH; ASHRAE Handbook (HVAC
 *     Applications, Educational Facilities) gives offices 24.1-26.9 C at 50% RH in summer.
 *
 * NOTHING HERE CHANGES THE MATHS: the engine keeps its own defaults. This module records what those
 * numbers ARE, where they could come from, and whether a human has stood behind them yet.
 */

export const BASIS_VERSION = 1;

const CODE = "code";
const CLIMATE = "climate";
const PRACTICE = "practice";

/** Every figure the load depends on. `required` = the load cannot be totalled without it being confirmed. */
export const BASIS_FIELDS = [
  // ---- outdoor design conditions (js/climates.js carries per-row station provenance) --------------
  { id: "outDb", group: "Outdoor design conditions", label: "Summer design dry bulb", unit: "°C", required: true, kind: CLIMATE },
  { id: "outWb", group: "Outdoor design conditions", label: "Coincident wet bulb", unit: "°C", required: true, kind: CLIMATE },
  // ---- indoor design conditions -------------------------------------------------------------------
  {
    id: "inDb", group: "Indoor design conditions", label: "Indoor dry bulb", unit: "°C", required: true, kind: PRACTICE,
    cite: "ASHRAE 55 summer office comfort band 23-26 °C (ASHRAE Handbook, HVAC Applications: offices 24.1-26.9 °C at 50% RH)",
  },
  {
    id: "inRh", group: "Indoor design conditions", label: "Indoor relative humidity", unit: "%", required: true, kind: PRACTICE,
    cite: "ASHRAE 55 comfort band 30-60% RH",
  },
  // ---- outdoor air / ventilation ------------------------------------------------------------------
  {
    id: "oap", group: "Outdoor air", label: "Outdoor air per person", unit: "L/s·person", required: true, kind: PRACTICE,
    cite: "NO code citation. ECBC 2017 §5.2.1 (PDF p.75) delegates outdoor air to NBC 2016 Part 9 and states no rate itself. Verify against NBC 9 or ASHRAE 62.1 for this project.",
  },
  {
    id: "oaa", group: "Outdoor air", label: "Outdoor air per floor area", unit: "L/s·m²", required: true, kind: PRACTICE,
    cite: "NO code citation, see above (NBC 2016 Part 9 / ASHRAE 62.1).",
  },
  // ---- envelope -----------------------------------------------------------------------------------
  {
    id: "uWall", group: "Envelope", label: "Opaque wall assembly U", unit: "W/m²K", required: true, kind: PRACTICE,
    cite: "Default 2.0 = 230 mm brick, plastered (practice, unverified). ECBC 2017 Table 4-7 (PDF p.58) caps this at 0.40 W/m²K in the warm and humid zone.",
    limit: { value: 0.4, cite: "ECBC 2017 Table 4-7, warm and humid, ECBC-compliant" },
  },
  {
    id: "uRoof", group: "Envelope", label: "Roof assembly U", unit: "W/m²K", required: true, kind: PRACTICE,
    cite: "Default 2.0 = RCC slab with waterproofing (practice, unverified). ECBC 2017 Table 4-4 (PDF p.57) caps this at 0.33 W/m²K in the warm and humid zone.",
    limit: { value: 0.33, cite: "ECBC 2017 Table 4-4, warm and humid, ECBC-compliant" },
  },
  {
    id: "uGlass", group: "Envelope", label: "Fenestration assembly U", unit: "W/m²K", required: true, kind: PRACTICE,
    cite: "Default 5.8 = single clear glass (practice, unverified). ECBC 2017 Table 4-10 (PDF p.59) caps this at 3.00 W/m²K in the warm and humid zone.",
    limit: { value: 3.0, cite: "ECBC 2017 Table 4-10, warm and humid, ECBC-compliant" },
  },
  {
    id: "sc", group: "Envelope", label: "Shading coefficient (SC)", unit: "—", required: true, kind: PRACTICE,
    cite: "Default 0.6 = clear glass with internal blinds (practice, unverified). ECBC 2017 Table 4-10 (PDF p.59) limits SHGC to 0.27 non-North and 0.50 North (lat ≥ 15°N) in the warm and humid zone — with SHGC ≈ SC × 0.87 that is SC ≤ 0.31 and ≤ 0.57.",
    limit: { value: 0.31, cite: "ECBC 2017 Table 4-10: SHGC ≤ 0.27 non-North ⇒ SC ≤ 0.31" },
  },
  {
    id: "roofEtd", group: "Envelope", label: "Roof effective temperature difference", unit: "K", required: false, kind: PRACTICE,
    cite: "Practice value; no code figure. Check against ASHRAE Fundamentals roof CLTD/ETD tables for the actual roof construction and orientation.",
  },
  {
    id: "uPart", group: "Envelope", label: "Partition U (to non-air-conditioned space)", unit: "W/m²K", required: false, kind: PRACTICE,
    cite: "Practice value for a plastered masonry partition; no code figure.",
  },
  { id: "wwr", group: "Envelope", label: "Window-to-wall ratio used when glass area is unknown", unit: "%", required: false, kind: PRACTICE,
    cite: "ECBC 2017 §4.3.3 (PDF p.58) allows at most 40% by the prescriptive path; the app's 30% is a practice figure. Best replaced by the drawing's real glazing areas." },
  // ---- internal gains -----------------------------------------------------------------------------
  {
    id: "light", group: "Internal gains", label: "Lighting power density", unit: "W/m²", required: true, kind: PRACTICE,
    cite: "Default 10 W/m² (practice). ECBC 2017 Table 6-1 (PDF p.96) allows 9.5 W/m² for an office building by the Building Area Method.",
    limit: { value: 9.5, cite: "ECBC 2017 Table 6-1: office building 9.5 W/m²" },
  },
  {
    id: "equip", group: "Internal gains", label: "Plug / equipment load", unit: "W/m²", required: true, kind: PRACTICE,
    cite: "ECBC 2017 (PDF p.36) states the Code does not apply to plug loads, so no code figure exists. Take this from the tenancy brief.",
  },
  {
    id: "m2pp", group: "Internal gains", label: "Occupancy density", unit: "m²/person", required: true, kind: PRACTICE,
    cite: "No code figure in ECBC 2017. Take the density from the tenancy brief or the drawing's room data schedule.",
  },
  {
    id: "ps", group: "Internal gains", label: "Person sensible heat", unit: "W/person", required: false, kind: PRACTICE,
    cite: "Practice value for sedentary office work; check against ASHRAE Fundamentals Ch.18 metabolic rate tables (1.2 met ≈ 120 W total).",
  },
  {
    id: "pl", group: "Internal gains", label: "Person latent heat", unit: "W/person", required: false, kind: PRACTICE,
    cite: "Practice value, see above.",
  },
  // ---- system / method ----------------------------------------------------------------------------
  {
    id: "infilAch", group: "Method", label: "Infiltration", unit: "air changes/h", required: true, kind: PRACTICE,
    cite: "Practice value. ECBC 2017 states no infiltration rate for air-conditioned spaces (its §5.2.1 covers outdoor air through mechanical systems).",
  },
  {
    id: "safety", group: "Method", label: "Safety allowance on room sensible and latent heat", unit: "%", required: true, kind: PRACTICE,
    cite: "Engineering practice, NOT a standard figure. Keep it explicit and small; a large safety factor hides a wrong assumption.",
  },
  {
    id: "supplyDt", group: "Method", label: "Room-to-supply air temperature difference", unit: "K", required: false, kind: PRACTICE,
    cite: "Design choice (a common practice value is 11 K); it sets the supply airflow, so it must be stated.",
  },
];

const byId = new Map(BASIS_FIELDS.map((f) => [f.id, f]));

/** A fresh basis: every figure present, every one unconfirmed. */
export function makeBasis() {
  const entries = {};
  for (const f of BASIS_FIELDS) {
    entries[f.id] = {
      value: null,
      kind: f.kind,
      status: "unconfirmed",
      cite: f.cite || "",
      note: "",
      confirmedAt: null,
    };
  }
  return { version: BASIS_VERSION, entries };
}

/**
 * Build the basis for a project: every figure the app would actually use, taken from the project so the
 * two can never disagree, plus the climate provenance for the outdoor design conditions.
 * @param {object} project the project settings
 * @param {object} [climate] the resolved climate row (js/climates.js) with { db, wb, src, station, indicative }
 */
export function basisFromProject(project, climate) {
  const b = makeBasis();
  const put = (id, value, extra = {}) => {
    const e = b.entries[id];
    if (!e) return;
    e.value = value == null ? null : Number(value);
    Object.assign(e, extra);
    if (e.value == null || !Number.isFinite(e.value)) e.status = "missing";
  };
  const p = project || {};
  // A climate figure is only SOURCED when it carries a station record. The app can also resolve a city
  // from the visitor's timezone, which is a guess wearing a city name — that one must be confirmed.
  const cCite = !climate
    ? "No station resolved: the project's outdoor design conditions carry no provenance."
    : climate.indicative
      // An estimate wearing a place name is the most dangerous kind of default, so it is labelled as one.
      ? `INDICATIVE, not a station value${climate.why ? ": " + climate.why : ""}. ` +
        "ASHRAE 2021 Ch.14 lists station records only, so nothing published backs this figure — " +
        "confirm it against a station, a local weather file (EPW), or the client's own design brief."
      : (climate.cite || climate.citeLine ||
         [climate.station ? "station " + climate.station : "", climate.src || ""].filter(Boolean).join(" — ") ||
         "ASHRAE 2021 Fundamentals Ch.14 climatic design conditions (via js/climates.js)");
  const cStatus = climate && !climate.indicative && (climate.station || climate.src) ? "cited" : "unconfirmed";
  put("outDb", p.outDb, { kind: "climate", status: cStatus, cite: cCite, station: (climate && climate.station) || "" });
  put("outWb", p.outWb, { kind: "climate", status: cStatus, cite: cCite, station: (climate && climate.station) || "" });
  for (const id of ["inDb", "inRh", "uWall", "uRoof", "uGlass", "sc", "roofEtd", "uPart", "wwr",
    "infilAch", "safety", "supplyDt"]) {
    put(id, p[id]);
  }
  // The internal-gain and outdoor-air figures live per room TYPE in the engine, so the project does not
  // carry one value: record the office row as the reference and say so.
  for (const id of ["oap", "oaa", "light", "equip", "m2pp", "ps", "pl"]) {
    const f = byId.get(id);
    b.entries[id].value = null;
    b.entries[id].note = `Per room type (js/calc.js ROOM_TYPES): ${f ? f.label : id} differs by use — stated per row in the report.`;
  }
  return b;
}

/** Figures that BLOCK the total: no value at all, or a 'practice' value nobody has confirmed. */
export function basisGaps(basis) {
  const out = [];
  for (const f of BASIS_FIELDS) {
    const e = basis && basis.entries ? basis.entries[f.id] : null;
    if (!e) continue;
    if (e.status === "missing") out.push({ ...f, reason: "no value" });
    else if (e.status === "cited") continue;   // a published figure is not a silent default
    else if (e.status === "confirmed" || e.status === "typed") continue;  // a human stood behind it
    else if (f.required) {
      out.push({
        ...f,
        reason: e.kind === CLIMATE ? "climate value with no station behind it"
          : e.kind === PRACTICE ? "unconfirmed practice value" : "unconfirmed",
      });
    }
  }
  return out;
}

export function basisStats(basis) {
  let cited = 0, confirmed = 0, typed = 0, unconfirmed = 0, missing = 0;
  for (const f of BASIS_FIELDS) {
    const e = basis && basis.entries ? basis.entries[f.id] : null;
    if (!e) continue;
    if (e.status === "missing") missing += 1;
    else if (e.status === "confirmed") confirmed += 1;
    else if (e.status === "typed") typed += 1;
    else if (e.kind === CODE || e.kind === CLIMATE) cited += 1;
    else unconfirmed += 1;
  }
  const gaps = basisGaps(basis);
  return { total: BASIS_FIELDS.length, cited, confirmed, typed, unconfirmed, missing, gaps: gaps.length, complete: gaps.length === 0 };
}

/** Mark one figure as stood-behind by the engineer (this is the acknowledgement the gate wants). */
export function confirmField(basis, id, who, when) {
  const e = basis && basis.entries ? basis.entries[id] : null;
  if (!e) return basis;
  e.status = "confirmed";
  e.note = `${e.note ? e.note + " " : ""}Confirmed${who ? " by " + who : ""}${when ? " on " + when : ""}.`;
  e.confirmedAt = when || null;
  return basis;
}

/** The engineer replaced the figure: it is theirs now, recorded as typed, and can never pass as sourced. */
export function setField(basis, id, value, who, when, why) {
  const e = basis && basis.entries ? basis.entries[id] : null;
  if (!e) return basis;
  e.value = Number(value);
  e.status = Number.isFinite(e.value) ? "typed" : "missing";
  e.kind = "practice";
  e.note = `${why ? why + " " : ""}Entered${who ? " by " + who : ""}${when ? " on " + when : ""}.`;
  e.confirmedAt = when || null;
  return basis;
}

/** One line for the report: what the load's provenance actually is. */
export function basisLine(basis) {
  const s = basisStats(basis);
  if (s.complete) {
    const rest = s.unconfirmed ? `, and ${s.unconfirmed} more that the total does not depend on still unconfirmed` : "";
    return `Design basis complete: ${s.total} figures — ${s.cited} from cited sources, ` +
      `${s.confirmed} confirmed by the engineer, ${s.typed} entered by hand${rest}.`;
  }
  return `Design basis INCOMPLETE: ${s.gaps} of ${s.total} figures are unconfirmed or unset, so the ` +
    `load must not be totalled.`;
}

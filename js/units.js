// Unit handling for LoadLens: ONE place that knows every conversion and every label, so the screen,
// the printed report and the CSV export can never disagree about what a number means.
//
// The load itself is always computed in SI (W, L/s, m²) - see js/calc.js. Everything here is a
// display conversion of an already-computed result, never a second calculation. That is why the
// report states the basis plainly instead of implying the room was recalculated in another system.

export const SYSTEMS = ['si', 'ip'];
export const SYSTEM_LABEL = { si: 'Metric (SI)', ip: 'Imperial (IP)' };

// Exact factors (not rounded intermediates):
//   1 L/s  = 2.118880 CFM          (1 CFM = 0.4719474 L/s)
//   1 W    = 3.412142 BTU/h
//   1 m²   = 10.763910 ft²
//   1 W/m² = 0.316998 BTU/(h·ft²)
//   1 TR   = 3.516853 kW = 12,000 BTU/h   (ton of refrigeration - used in BOTH systems)
export const K = {
  lsToCfm: 2.118880,
  wToBtuh: 3.412142,
  m2ToFt2: 10.763910,
  wm2ToBtuhFt2: 0.316998,
  wPerTr: 3516.853,
  btuhPerTr: 12000,
};

/** Anything we do not recognise is 'si' (the app's default), never a silent switch to imperial. */
export function normSystem(s) {
  return String(s == null ? '' : s).trim().toLowerCase() === 'ip' ? 'ip' : 'si';
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isIp = (sys) => normSystem(sys) === 'ip';

// ---- quantities ---------------------------------------------------------------------------------
export function air(ls, sys) { return isIp(sys) ? num(ls) * K.lsToCfm : num(ls); }
export function airUnit(sys) { return isIp(sys) ? 'CFM' : 'L/s'; }

export function power(w, sys) { return isIp(sys) ? num(w) * K.wToBtuh : num(w); }
export function powerUnit(sys) { return isIp(sys) ? 'BTU/h' : 'W'; }

export function area(m2, sys) { return isIp(sys) ? num(m2) * K.m2ToFt2 : num(m2); }
export function areaUnit(sys) { return isIp(sys) ? 'ft²' : 'm²'; }

export function density(wm2, sys) { return isIp(sys) ? num(wm2) * K.wm2ToBtuhFt2 : num(wm2); }
export function densityUnit(sys) { return isIp(sys) ? 'BTU/h·ft²' : 'W/m²'; }

/** Capacity: TR is the trade unit in both systems (1 TR = 12,000 BTU/h = 3.516853 kW). */
export function capacity(tr, sys) { return num(tr); }
export function capacityUnit() { return 'TR'; }

/**
 * Area served per ton. The caller passes the m² value (the SI figure the engine computes); in SI mode
 * it comes back as m²/TR and in imperial mode as ft²/TR - one quantity, one unit, per system.
 */
export function areaPerTr(m2PerTr, sys) {
  return isIp(sys) ? num(m2PerTr) * K.m2ToFt2 : num(m2PerTr);
}
export function areaPerTrUnit(sys) { return isIp(sys) ? 'ft²/TR' : 'm²/TR'; }

export function temp(c, sys) { return isIp(sys) ? num(c) * 9 / 5 + 32 : num(c); }
export function tempUnit(sys) { return isIp(sys) ? '°F' : '°C'; }

/**
 * A temperature DIFFERENCE (ΔT, ETD, supply-air ΔT): 0 °C to 1 °C is 1 K, but 1 K = 1.8 °F - no 32°
 * offset. Kept separate from temp() so a difference is never converted as an absolute temperature.
 */
export function tempDelta(k, sys) { return isIp(sys) ? num(k) * 9 / 5 : num(k); }
export function tempDeltaUnit(sys) { return isIp(sys) ? '°F' : 'K'; }

/** Linear dimensions (room height, wall length): 1 m = 3.280840 ft. */
export function length(m, sys) { return isIp(sys) ? num(m) * 3.280840 : num(m); }
export function lengthUnit(sys) { return isIp(sys) ? 'ft' : 'm'; }

// U-values follow the system too: W/m²K <-> BTU/(h·ft²·°F)
export function uValue(wm2k, sys) { return isIp(sys) ? num(wm2k) / 5.678263 : num(wm2k); }
export function uValueUnit(sys) { return isIp(sys) ? 'BTU/h·ft²·°F' : 'W/m²K'; }

// ---- display ------------------------------------------------------------------------------------
/** Plain number for a table cell: thousands separators, honest "-" for NaN/Infinity (never "NaN"). */
export function fmtValue(v, dp = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  const d = dp == null ? (Math.abs(n) >= 100 ? 0 : 1) : dp;
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// The quantity helpers coerce a non-finite input to 0 (they are arithmetic, and callers rely on a
// number). The DISPLAY helpers must not: a load that is unknown has to read as "-", never "NaN" nor a
// confident 0.00 that looks like a real zero load.
const fin = (v) => Number.isFinite(Number(v));
export function fmtAir(ls, sys) { return fin(ls) ? fmtValue(air(ls, sys)) : '-'; }
export function fmtPower(w, sys) { return fin(w) ? fmtValue(power(w, sys)) : '-'; }
export function fmtArea(m2, sys, dp = 1) { return fin(m2) ? fmtValue(area(m2, sys), dp) : '-'; }
export function fmtDensity(wm2, sys) { return fin(wm2) ? fmtValue(density(wm2, sys), 1) : '-'; }
export function fmtWithUnit(v, unit, dp = null) { return fin(v) ? `${fmtValue(v, dp)} ${unit}` : '-'; }

/** Unit of the level/room table headers, e.g. "Supply air (CFM)". */
export function header(label, unit) { return `${label} (${unit})`; }

/**
 * One honest sentence naming the system and the exact factors, for the report and the CSV footer.
 * The load is computed in SI and converted for display - say so rather than implying a recalculation.
 */
export function conversionNote(sys) {
  if (!isIp(sys)) {
    return 'Results in metric (SI): W, L/s, m², °C. The load is computed in SI units.';
  }
  return 'Results in imperial (IP): BTU/h, CFM, ft², °F, converted from the SI calculation '
    + '(1 L/s = 2.118880 CFM, 1 W = 3.412142 BTU/h, 1 m² = 10.763910 ft², 1 TR = 12,000 BTU/h). '
    + 'The load itself is always computed in SI.';
}

/** Short form for a UI chip: "Metric (SI)" / "Imperial (IP)". */
export function systemLabel(sys) { return SYSTEM_LABEL[normSystem(sys)]; }

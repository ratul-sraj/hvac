/**
 * js/crosscheck.js — the same zones and the same assumptions, worked a SECOND way.
 *
 * WHY THIS EXISTS
 *   One implementation agreeing with itself proves nothing. This module takes the identical rooms and the
 *   identical design basis and computes the load by a different textbook method, so the two answers can be
 *   set side by side. Where they disagree by more than 10% the report must say so, in words, rather than
 *   present either number as the truth.
 *
 * WHAT IS ACTUALLY DIFFERENT (this is what makes it a cross-check and not a second copy):
 *   the app's engine (js/calc.js)                this method
 *   -------------------------------------------  ------------------------------------------------
 *   tabulated per-orientation WALL_ETD constants  sol-air temperature from computed solar geometry
 *   tabulated per-orientation SOLAR constants     incident irradiance computed for the sun's actual
 *     (× shading coefficient)                       position, split beam / diffuse / ground-reflected
 *   fixed latent factors (1.23 W·s/L·K, 3010)      full psychrometric enthalpy difference from the
 *                                                   weather file's own dry bulb and dew point
 *   one fixed design day for every surface         the weather file's real peak-solar hour
 *
 * WHAT IS SHARED, AND THEREFORE NOT CROSS-CHECKED: the room geometry and areas, the U values, the lighting
 * and plug densities, the occupancy, the outdoor-air rates, the setpoints and the safety allowance. Those
 * come from the design basis — this module cannot validate them, and does not pretend to. A wrong basis
 * gives two implementations that agree on the wrong answer.
 *
 * The physical constants below (absorptance, outside film coefficient, ground reflectance) are STATED
 * parameters of this second model, not cited requirements: they are the usual engineering values for a
 * dark roof and a plastered wall, and they are the honest place to look when the two methods differ.
 */

import { SPACE_TYPES, calcProject } from "./calc.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const DEG = Math.PI / 180;

export const MODEL = {
  hOut: 22.7,        // outside surface heat-transfer coefficient, W/m2K (summer, moderate wind)
  alphaRoof: 0.85,   // solar absorptance, dark bituminous / membrane roof
  alphaWall: 0.60,   // solar absorptance, medium-coloured plastered wall
  emissivity: 0.9,
  skyView: 0.5,      // vertical surface: half sky, half ground
  groundReflect: 0.2,
  // The app stores a shading COEFFICIENT; ECBC and ASHRAE table SHGC. The standard relation between them
  // is SHGC = SC x 0.87, and the mapping is stated here rather than hidden in a conversion.
  scToShgc: 0.87,
  airDensity: 1.2,   // kg/m3
};

/** Solar altitude and azimuth (degrees) for a place and a moment. Cooper's declination, standard geometry. */
export function sunPosition(latDeg, dayOfYear, solarHour) {
  const lat = latDeg * DEG;
  const decl = 23.45 * Math.sin(360 * (284 + dayOfYear) / 365 * DEG);
  const d = decl * DEG;
  const omega = 15 * (solarHour - 12) * DEG;
  const sinAlt = Math.sin(lat) * Math.sin(d) + Math.cos(lat) * Math.cos(d) * Math.cos(omega);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAlt = Math.cos(alt);
  // The standard relation yields the azimuth measured FROM SOUTH, positive towards the west. It is
  // negative in the morning (sun east of south) and positive in the afternoon. Converting it to the
  // north-clockwise convention that surface azimuths use is 180 + that value — and getting this wrong
  // puts the afternoon sun in the north, which lights up every north wall in the building.
  let az = 0;
  if (Math.abs(cosAlt) > 1e-6) {
    const cosAz = Math.max(-1, Math.min(1, (sinAlt * Math.sin(lat) - Math.sin(d)) / (cosAlt * Math.cos(lat))));
    let azFromSouth = Math.acos(cosAz) / DEG;
    if (omega < 0) azFromSouth = -azFromSouth;
    az = 180 + azFromSouth;
    if (az < 0) az += 360;
    if (az >= 360) az -= 360;
  }
  return { altitude: alt / DEG, azimuth: az, declination: decl };
}

/** Irradiance on a surface of a given azimuth: W/m2. Vertical surfaces take sky + ground halves. */
export function surfaceIrradiance(sun, tiltDeg, azimuthDeg, ghi, dni, dhi, opts = {}) {
  const m = Object.assign({}, MODEL, opts);
  if (sun.altitude <= 0) return 0;
  // A horizontal surface is the one case where the file hands over the answer directly: GHI is measured,
  // so decomposing it back into beam + diffuse would only introduce error.
  if (tiltDeg === 0) return ghi;
  const alt = sun.altitude * DEG, tilt = tiltDeg * DEG;
  // cosine of the angle of incidence on a tilted surface (Duffie & Beckman's standard form)
  const cosInc = Math.cos(alt) * Math.sin(tilt) * Math.cos((sun.azimuth - azimuthDeg) * DEG) +
    Math.sin(alt) * Math.cos(tilt);
  const beam = Math.max(0, cosInc) * dni;
  const diffuse = dhi * (1 + Math.cos(tilt)) / 2;
  const reflected = ghi * m.groundReflect * (1 - Math.cos(tilt)) / 2;
  return beam + diffuse + reflected;
}

/** Saturation vapour pressure, kPa (Magnus form, as used throughout the psychrometric literature). */
function pSat(tC) { return 0.61078 * Math.exp(17.2694 * tC / (tC + 237.29)); }

/** Humidity ratio (kg/kg) from dry bulb and dew point, at a stated station pressure. */
export function humidityRatioFromDewPoint(tC, dewC, pressureKPa = 101.325) {
  const pw = pSat(dewC);
  return 0.621945 * pw / Math.max(1e-6, pressureKPa - pw);
}

/** Humidity ratio from dry bulb and WET bulb — the standard psychrometric relation (ASHRAE Ch.1):
 *  W = ((2501 - 2.326·Twb)·Ws(Twb) - 1.006·(Tdb - Twb)) / (2501 + 1.86·Tdb - 4.186·Twb). */
export function humidityRatioFromWetBulb(tC, wbC, pressureKPa = 101.325) {
  const ws = (t) => { const pw = pSat(t); return 0.621945 * pw / Math.max(1e-6, pressureKPa - pw); };
  const numr = (2501 - 2.326 * wbC) * ws(wbC) - 1.006 * (tC - wbC);
  const den = 2501 + 1.86 * tC - 4.186 * wbC;
  return Math.max(0, numr / den);
}

/** Humidity ratio from dry bulb and relative humidity. */
export function humidityRatioFromRh(tC, rhPct, pressureKPa = 101.325) {
  const pw = Math.min(pSat(tC), (rhPct / 100) * pSat(tC));
  return 0.621945 * pw / Math.max(1e-6, pressureKPa - pw);
}

/** Moist-air enthalpy, kJ/kg dry air. */
export function enthalpy(tC, w) { return 1.006 * tC + w * (2501 + 1.86 * tC); }

const ORIENT_AZIMUTH = { N: 0, E: 90, S: 180, W: 270, NE: 45, SE: 135, SW: 225, NW: 315 };

/**
 * Read one design hour out of an EPW weather file (the file is a CSV with 8 header rows).
 * @param {string} text the whole .epw file
 * @param {"peakEnthalpy"|"peakSun"|"peakDryBulb"} pick which hour to use as the design hour.
 *   "peakEnthalpy" (the default) is the right one for a COOLING load: the hour whose outdoor moist air
 *   carries the most energy, which couples the dry bulb with the humidity instead of picking a dry, sunny
 *   afternoon. Selecting on peak sun alone lands on a clear February day with a 13 °C dew point and
 *   understates the latent load five-fold — a mistake this app made once while being written.
 */
/** Parse every hourly row of an EPW into objects (the file is CSV with 8 header rows). */
export function parseEpwHours(text) {
  const lines = String(text).split(/\r?\n/);
  const loc = (lines[0] || "").split(",");
  const rows = [];
  for (let i = 8; i < lines.length; i += 1) {
    const f = lines[i].split(",");
    if (f.length < 20) continue;
    const g = (k) => { const v = parseFloat(f[k]); return Number.isFinite(v) && v < 999900 ? v : 0; };
    // EPW column 9 is the station pressure in PASCALS (101000 at sea level, not 101.0). The psychrometric
    // helpers work in kPa, and getting this wrong silences the latent load almost completely — which is
    // exactly how it first went wrong here, and why the term-by-term comparison was worth building.
    const pRaw = g(9);
    const pressure = pRaw > 5000 ? pRaw / 1000 : (pRaw || 101.325);
    rows.push({
      month: parseInt(f[1], 10), day: parseInt(f[2], 10), hour: parseInt(f[3], 10),
      db: g(6), dpt: g(7), rh: g(8), pressure,
      ghi: g(13), dni: g(14), dhi: g(15),
    });
  }
  return { station: loc[1] || "", wmo: loc[5] || "", lat: parseFloat(loc[6]) || 0, lon: parseFloat(loc[7]) || 0,
    tz: parseFloat(loc[8]) || 0, rows };
}

/** One hour as the design hour, by a stated rule (kept for callers that only have the file). */
export function designHourFromEpw(text, pick = "peakEnthalpy") {
  const { station, wmo, lat, lon, tz, rows } = parseEpwHours(text);
  if (!rows.length) return null;
  const score = (r) => {
    if (pick === "peakDryBulb") return r.db;
    if (pick === "peakSun") return r.ghi + r.dni;
    if (pick === "peakEnthalpy") return enthalpy(r.db, humidityRatioFromDewPoint(r.db, r.dpt, r.pressure));
    return r.db;
  };
  let best = rows[0];
  for (const r of rows) if (score(r) > score(best)) best = r;
  const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return {
    station, wmo, lat, lon, tz, rows: rows.length,
    month: best.month, day: best.day, hour: best.hour,
    dayOfYear: cum[Math.max(0, Math.min(11, best.month - 1))] + best.day,
    db: best.db, dpt: best.dpt, pressure: best.pressure, ghi: best.ghi, dni: best.dni, dhi: best.dhi,
    picked: pick,
  };
}

/**
 * The design hour that actually matters: the hour this building's load peaks, found by running the
 * second method for every hour of the file and keeping the largest. Picking on dry bulb, or on solar,
 * or even on outdoor enthalpy alone, all land on the wrong hour for a real load — the enthalpy peak is
 * a humid evening with no sun, and the solar peak can be a dry clear morning. The building decides.
 */
export function peakLoadHour(text, rooms, project, opts = {}) {
  const { station, wmo, lat, lon, tz, rows } = parseEpwHours(text);
  if (!rows.length) return null;
  const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const dayOfYearOf = (r) => cum[Math.max(0, Math.min(11, r.month - 1))] + r.day;
  const hourly = [];
  let best = null, bestTr = -1;
  for (const r of rows) {
    if (r.ghi <= 0 && r.dni <= 0) continue;                 // a night hour can never be the design hour
    const day = {
      station, wmo, lat, lon, tz, rows: rows.length,
      month: r.month, day: r.day, hour: r.hour, dayOfYear: dayOfYearOf(r),
      db: r.db, dpt: r.dpt, pressure: r.pressure, ghi: r.ghi, dni: r.dni, dhi: r.dhi,
      picked: "peakLoad",
    };
    const tr = crossCheck(rooms, project, day, opts).totals.xTr;
    hourly.push({ month: r.month, day: r.day, hour: r.hour, db: r.db, ghi: r.ghi, tr });
    if (tr > bestTr) { bestTr = tr; best = day; }
  }
  if (!best) return null;
  best.hourly = hourly;
  best.peakTr = bestTr;
  return best;
}

/**
 * The second calculation, room by room, for one design hour.
 * @returns {{rows:Array, totals:object, model:object, day:object}}
 */
export function crossCheck(rooms, project, day, opts = {}) {
  const m = Object.assign({}, MODEL, opts);
  const p = project || {};
  const inDb = num(p.inDb) || 24;
  const inRh = num(p.inRh) || 50;
  const wIn = humidityRatioFromRh(inDb, inRh, day.pressure);
  const hIn = enthalpy(inDb, wIn);
  // SAME ASSUMPTIONS, DIFFERENT METHOD. The outdoor air state is the design basis's own (design dry bulb
  // and wet bulb), not whatever hour the solar happened to come from — otherwise this compares two
  // different days and calls the difference a method error. Pass airFromFile to use the file's hour.
  const outDb = opts.airFromFile ? day.db : (num(p.outDb) || day.db);
  const outWb = num(p.outWb);
  const wOut = opts.airFromFile
    ? (day.dpt ? humidityRatioFromDewPoint(day.db, day.dpt, day.pressure) : humidityRatioFromRh(day.db, day.rh || 60, day.pressure))
    : humidityRatioFromWetBulb(outDb, outWb || outDb - 4, day.pressure);
  const hOut = enthalpy(outDb, wOut);

  // how much of the outside air is the room given: the engine's own contract (per person + per area)
  const sun = sunPosition(day.lat, day.dayOfYear, day.hour + 0.5);
  const usable = (rooms || []).filter((r) => r && r.include !== false && num(r.area) > 0);
  const app = calcProject(usable, p);
  const appTr = new Map(app.results.map((x) => [x.room.id, x.tr]));

  const rows = [];
  for (const room of usable) {
    const A = num(room.area);
    const H = num(room.height) || 3.0;
    const st = SPACE_TYPES[room.type] || SPACE_TYPES.general;
    const orient = ORIENT_AZIMUTH[room.orient] != null ? room.orient : "W";
    const az = ORIENT_AZIMUTH[orient];
    const glass = Math.max(0, Math.min(num(room.glass), Math.max(0, num(room.extWall))));
    const wallNet = Math.max(0, num(room.extWall) - glass);

    // --- conduction by SOL-AIR temperature (roof horizontal, wall on its own orientation) ---------
    const iRoof = day.ghi;                       // measured horizontal irradiance, straight from the file
    const iWall = surfaceIrradiance(sun, 90, az, day.ghi, day.dni, day.dhi, m);
    const solAirRoof = outDb + (m.alphaRoof * iRoof) / m.hOut;
    const solAirWall = outDb + (m.alphaWall * iWall) / m.hOut;
    const roofArea = room.roof ? A : 0;
    const qRoof = roofArea * num(p.uRoof) * Math.max(0, solAirRoof - inDb);
    const qWall = wallNet * num(p.uWall) * Math.max(0, solAirWall - inDb);
    const qGlassCond = glass * num(p.uGlass) * Math.max(0, outDb - inDb);
    // --- solar through the glass: SHGC x the irradiance actually falling on that orientation --------
    const shgc = num(p.sc) * m.scToShgc;
    const qGlassSolar = glass * shgc * iWall;

    // --- internal gains (same figures as the basis, worked directly) --------------------------------
    const ppl = num(room.people) || (A > 0 ? Math.max(1, Math.ceil(A / st.m2pp)) : 0);
    const qPeopleS = ppl * st.ps, qPeopleL = ppl * st.pl;
    const qLight = A * num(room.light != null && room.light !== "" ? room.light : st.light);
    const qEquip = A * num(room.equip != null && room.equip !== "" ? room.equip : st.equip);

    // --- outdoor air and leakage, by ENTHALPY at this hour's real air state -------------------------
    const oaLs = ppl * st.oap + A * st.oaa;                     // L/s, the engine's own contract
    const qOa = m.airDensity * (oaLs / 1000) * (hOut - hIn) * 1000;   // W
    const infLs = num(p.infilAch) * A * H * 1000 / 3600;         // L/s
    const qInf = m.airDensity * (infLs / 1000) * (hOut - hIn) * 1000;  // W

    const sensX = qRoof + qWall + qGlassCond + qGlassSolar + qPeopleS + qLight + qEquip;
    const latX = qPeopleL;
    const sf = 1 + num(p.safety) / 100;
    // the engine applies the safety factor to the ROOM heat, and adds the outdoor-air load outside it;
    // the same convention is used here so the comparison is like for like
    const totalX = (sensX + latX) * sf + qOa + qInf;
    const xTr = totalX / 3517;

    const aTr = appTr.get(room.id) || 0;
    rows.push({
      id: room.id, name: room.name, orient, area: A,
      appTr: aTr, xTr, deltaTr: xTr - aTr,
      deltaPct: aTr > 0 ? (xTr - aTr) / aTr * 100 : null,
      terms: {
        roof: qRoof, wall: qWall, glassCond: qGlassCond, glassSolar: qGlassSolar,
        peopleS: qPeopleS, peopleL: qPeopleL, light: qLight, equip: qEquip, oa: qOa, infil: qInf,
      },
      irradiance: { roof: iRoof, wall: iWall },
      solAir: { roof: solAirRoof, wall: solAirWall },
    });
  }

  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const termSums = {};
  for (const k of Object.keys(rows[0] ? rows[0].terms : {})) termSums[k] = rows.reduce((a, r) => a + r.terms[k], 0);

  // Where do the two methods actually part company? The engine returns its own term breakdown per room
  // (js/calc.js calcRoom -> sensible/latent/oaSens/oaLat), so the same terms can be put side by side.
  // This is what makes "explain any gap over 10%" a sentence instead of an apology.
  const appTerms = {
    roof: 0, wall: 0, glassCond: 0, glassSolar: 0,
    peopleS: 0, peopleL: 0, light: 0, equip: 0, oa: 0, infil: 0,
  };
  for (const x of app.results) {
    const s = x.sensible || {}, l = x.latent || {};
    appTerms.roof += s.roof || 0;
    appTerms.wall += (s.wall || 0) + (s.partition || 0);
    appTerms.glassCond += s.glassCond || 0;
    appTerms.glassSolar += s.glassSolar || 0;
    appTerms.peopleS += s.people || 0;
    appTerms.peopleL += l.people || 0;
    appTerms.light += s.lighting || 0;
    appTerms.equip += s.equipment || 0;
    // the engine adds the safety allowance to the room heat, so the comparison carries it the same way
    appTerms.oa += (x.oaSens || 0) + (x.oaLat || 0);
    appTerms.infil += ((s.infiltration || 0) + (l.infiltration || 0)) * (1 + num(p.safety) / 100);
  }
  const termCompare = Object.keys(termSums).map((k) => ({
    term: k, appW: appTerms[k] || 0, xW: termSums[k],
    deltaW: termSums[k] - (appTerms[k] || 0),
  })).sort((a, b) => Math.abs(b.deltaW) - Math.abs(a.deltaW));
  const appTotal = sum("appTr"), xTotal = sum("xTr");
  const worst = rows.filter((r) => r.deltaPct != null).sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));

  return {
    rows,
    model: m,
    day,
    sun,
    airStates: { inDb, inRh, wIn, wOut, hIn, hOut },
    terms: termSums,
    termCompare,
    totals: {
      rooms: rows.length, appTr: appTotal, xTr: xTotal,
      deltaTr: xTotal - appTotal,
      deltaPct: appTotal > 0 ? (xTotal - appTotal) / appTotal * 100 : null,
      overTenPct: worst.filter((r) => Math.abs(r.deltaPct) > 10).length,
    },
    worst: worst.slice(0, 10),
  };
}

/** The sentence a report needs: the delta, and which terms explain it. */
export function crossCheckLine(x) {
  const f = (v) => Number(v).toFixed(2);
  const t = x.totals;
  const sign = t.deltaPct >= 0 ? "higher" : "lower";
  const terms = Object.entries(x.terms).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k} ${Math.round(v / 1000)} kW`);
  const head = t.deltaPct == null ? "No load to compare."
    : `Second method: ${f(t.xTr)} TR against the app's ${f(t.appTr)} TR — ${f(Math.abs(t.deltaTr))} TR ` +
      `(${Math.abs(t.deltaPct).toFixed(1)}%) ${sign}, on the same zones and the same basis. ` +
      `${t.overTenPct} of ${t.rooms} rooms differ by more than 10%. Largest terms in the second method: ${terms.join(", ")}.`;
  return head + ` Design hour: ${x.day.station} ${x.day.day}/${x.day.month} ${String(x.day.hour).padStart(2, "0")}:30, ` +
    `dry bulb ${x.day.db} °C, dew point ${x.day.dpt} °C, GHI ${x.day.ghi} DNI ${x.day.dni} W/m².`;
}

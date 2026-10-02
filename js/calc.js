// HVAC cooling load engine (simplified ASHRAE / Carrier E-20 style, SI units).
// Pure module: works in browser and Node.

// Summer design conditions (outdoor dry bulb / coincident wet bulb, °C) as commonly used
// in design practice (ISHRAE / ASHRAE / local authority values). Check against your code.
export const COUNTRIES = {
  "India": {
    "Kochi": { db: 35, wb: 28 }, "Thiruvananthapuram": { db: 34, wb: 27.5 },
    "Kozhikode": { db: 35, wb: 28 }, "Thrissur": { db: 36, wb: 27.5 },
    "Kannur": { db: 35, wb: 28 }, "Kollam": { db: 34, wb: 27.5 },
    "Kottayam": { db: 35, wb: 27.5 }, "Palakkad": { db: 38, wb: 26 },
    "Mangaluru": { db: 35, wb: 27.5 }, "Coimbatore": { db: 36, wb: 24 },
    "Chennai": { db: 38, wb: 28 }, "Bengaluru": { db: 34, wb: 22 },
    "Hyderabad": { db: 41, wb: 24 }, "Mumbai": { db: 35, wb: 27.5 },
    "Pune": { db: 38, wb: 23 }, "Ahmedabad": { db: 43, wb: 25 },
    "Delhi": { db: 43, wb: 24 }, "Jaipur": { db: 44, wb: 24 },
    "Kolkata": { db: 38, wb: 28 },
  },
  "United Arab Emirates": {
    "Dubai": { db: 46, wb: 29 }, "Abu Dhabi": { db: 46, wb: 29 },
    "Sharjah": { db: 46, wb: 29 }, "Ajman": { db: 46, wb: 29 },
    "Ras Al Khaimah": { db: 46, wb: 29 }, "Fujairah": { db: 44, wb: 30 },
    "Al Ain": { db: 48, wb: 26 },
  },
  "Saudi Arabia": {
    "Riyadh": { db: 46, wb: 22 }, "Jeddah": { db: 43, wb: 29 },
    "Dammam": { db: 46, wb: 28 }, "Makkah": { db: 46, wb: 26 },
    "Madinah": { db: 46, wb: 22 },
  },
  "Qatar": { "Doha": { db: 46, wb: 28 } },
  "Oman": { "Muscat": { db: 46, wb: 29 }, "Sohar": { db: 45, wb: 29 }, "Salalah": { db: 36, wb: 28 } },
  "Kuwait": { "Kuwait City": { db: 48, wb: 24 } },
  "Bahrain": { "Manama": { db: 43, wb: 29 } },
  "Sri Lanka": { "Colombo": { db: 33, wb: 27 } },
  "Maldives": { "Malé": { db: 32, wb: 27 } },
  "Singapore": { "Singapore": { db: 33, wb: 26.5 } },
  "Malaysia": { "Kuala Lumpur": { db: 34, wb: 27 } },
  "Custom": { "Custom": { db: 35, wb: 28 } },
};

// Flat city lookup kept for older saved projects: CLIMATES[city] -> {db, wb, country}
export const CLIMATES = Object.fromEntries(
  Object.entries(COUNTRIES).flatMap(([country, cities]) =>
    Object.entries(cities).map(([city, v]) => [city, { ...v, country }]))
);

// Peak solar heat gain through glass for ~10°N latitude, W/m² (already includes storage effect ~CLF)
export const SOLAR = { N: 110, NE: 300, E: 440, SE: 300, S: 130, SW: 350, W: 470, NW: 300, H: 650 };
// Equivalent temperature difference (sol-air) for 230 mm brick wall, K
export const WALL_ETD = { N: 7, NE: 10, E: 12, SE: 11, S: 9, SW: 13, W: 15, NW: 12 };
export const ORIENTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

// Space-type defaults: m² per person, lighting W/m², equipment W/m², people sensible/latent W,
// outdoor air per person L/s, per area L/s·m² (ASHRAE 62.1)
export const SPACE_TYPES = {
  office:     { label: "Office",            m2pp: 10,  light: 10, equip: 15, ps: 75, pl: 55, oap: 2.5, oaa: 0.3 },
  conference: { label: "Conference/Meeting",m2pp: 2.5, light: 12, equip: 5,  ps: 75, pl: 55, oap: 2.5, oaa: 0.3 },
  cabin:      { label: "Cabin/Manager",     m2pp: 8,   light: 10, equip: 15, ps: 75, pl: 55, oap: 2.5, oaa: 0.3 },
  reception:  { label: "Reception/Lobby",   m2pp: 7,   light: 12, equip: 5,  ps: 75, pl: 55, oap: 2.5, oaa: 0.3 },
  retail:     { label: "Retail/Shop",       m2pp: 6,   light: 20, equip: 5,  ps: 75, pl: 55, oap: 3.8, oaa: 0.6 },
  restaurant: { label: "Restaurant/Dining", m2pp: 1.5, light: 12, equip: 10, ps: 80, pl: 80, oap: 3.8, oaa: 0.9 },
  bedroom:    { label: "Bedroom",           m2pp: 7,   light: 6,  equip: 5,  ps: 70, pl: 35, oap: 2.5, oaa: 0.3 },
  living:     { label: "Living/Family",     m2pp: 6,   light: 8,  equip: 8,  ps: 70, pl: 45, oap: 2.5, oaa: 0.3 },
  classroom:  { label: "Classroom",         m2pp: 2,   light: 10, equip: 5,  ps: 70, pl: 45, oap: 5.0, oaa: 0.6 },
  hospital:   { label: "Patient Room/Ward", m2pp: 8,   light: 10, equip: 10, ps: 70, pl: 45, oap: 12,  oaa: 0 },
  server:     { label: "Server/IT Room",    m2pp: 30,  light: 10, equip: 300,ps: 75, pl: 55, oap: 2.5, oaa: 0.3 },
  gym:        { label: "Gym",               m2pp: 5,   light: 10, equip: 10, ps: 210,pl: 315,oap: 10,  oaa: 0.3 },
  general:    { label: "General",           m2pp: 10,  light: 10, equip: 10, ps: 75, pl: 55, oap: 2.5, oaa: 0.3 },
};

// Room names arrive written as drawings write them: "M. TL.", "ELEC. C.", "CORR.", "ST. 01",
// "PL 1". Punctuation breaks the usual \b boundaries (a pattern ending in "elec\." cannot match
// "ELEC. C." because "." and " " are both non-word), so normalise first: lowercase, and turn
// punctuation into spaces, which makes every abbreviation a whole word.
export function normName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[.,;:()[\]{}\/\\|&"'_+\-]+/g, " ")   // kEEP hyphens? no: treat as space for matching
    .replace(/\s+/g, " ")
    .trim();
}

// Words that mean "this space is not cooled" (service, circulation, wet, outdoor, plant).
// Built so that drawing abbreviations work directly: a plain \b fails on "M. TL." / "ELEC. C."
// because "." is a non-word character, so the pattern uses lookarounds and allows optional dots
// between the letters of an abbreviation.
const NON_AC_PATTERN = [
  "toilets?", "w\\.?c", "bath(?:room)?s?", "washrooms?", "lavatory", "showers?",
  "t\\.?l", "m\\.? ?t\\.?l", "f\\.? ?t\\.?l", "j\\.? ?c", "ada",   // male/female toilet, janitor, accessible
  "stores?", "storage", "sto", "arch(?:ive)?", "garb(?:age)?", "fhc", "tel\\.? ?c",
  "shafts?", "ducts?", "risers?", "p\\.?l ?\\d+",                  // risers / plumbing shafts
    "stairs?", "staircase", "st\\.? ?\\d+",
  "lifts?", "elevators?", "escalators?",
  // NOTE: corridors are deliberately NOT here: in a fully air-conditioned building a corridor
  // is inside the conditioned envelope and is normally cooled. Stairs, toilets, shafts, stores and
  // plant rooms stay excluded.
  "circulation",
  "kits?", "kitchens?", "kitchenettes?", "pantr(?:y|ies)", "ablutions?",
  "utility", "plant", "elec", "electrical", "switch", "transformer", "generator",
  "balcon(?:y|ies)", "sit ?-? ?outs?", "sitouts?", "verandah?s?", "porch(?:es)?",
  "parking", "garage", "drive", "ramps?", "terrace", "voids?", "court ?yards?", "courtyards?",
  "open(?! ?(?:plan|office))", "dress", "dressing", "dhobi", "laundry",
].join("|");
export const NON_AC_WORDS = new RegExp(`(?:^|[^a-z0-9])(?:${NON_AC_PATTERN})(?![a-z0-9])`, "i");

// Space typing. ORDER MATTERS: the specific patterns must come before the general ones
// ("Coffee Shop" is a restaurant, not retail; "Video Display Hall" is a conference room, not retail;
// "Manager Office" is a cabin, not a generic office).
export function guessSpaceType(name) {
  const compact = normName(name);
  const n = compact.replace(/\s+/g, "");
  const has = (re) => re.test(compact) || re.test(n);
  const rules = [
    [/server|data ?cent|it ?room|hub|ups|comms|idf|bms|telecom|switch ?room/, "server"],
    [/coffee|cafe|cafeteria|canteen|restaurant|dining|food ?court|pantry|kits?|kitchen|mess/, "restaurant"],
    [/conf|meeting|board|discussion|training|multipurpose|auditorium|display|hall/, "conference"],
    [/gym|fitness|yoga|entertainment|recreation|sports|play/, "gym"],
    [/ward|patient|icu|opd|consult|clinic|operation|hospital|nurse/, "hospital"],
    [/class|lecture|lab|laboratory|library|study/, "classroom"],
    [/majlis|istiqbal|recep|lobby|foyer|waiting|entrance/, "reception"],
    [/cabin|manager|director|chief|md|ceo|advisor|chamber|executive|secretary/, "cabin"],
    [/bed|master|guest ?room|kids|suite/, "bedroom"],
    [/living|family|lounge|drawing|tv|home ?theat|majlis/, "living"],
    [/retail|shop|showroom|supermarket|market|boutique/, "retail"],
    [/office|work ?station|workstat|admin|account|(?<![a-z])hr(?![a-z])|staff|filing|record|copy|print|security|control|(?<![a-z])fm(?![a-z])|off ?man|store ?front/, "office"],
  ];
  for (const [re, t] of rules) if (has(re)) return t;
  return "general";
}

// ---------- psychrometrics (sea level) ----------
const P = 101.325;
function pws(T) { return 0.61094 * Math.exp((17.625 * T) / (T + 243.04)); } // kPa
function wSat(T) { const p = pws(T); return 0.621945 * p / (P - p); }
export function wFromDbWb(db, wb) {
  const ws = wSat(wb);
  return ((2501 - 2.326 * wb) * ws - 1.006 * (db - wb)) / (2501 + 1.86 * db - 4.186 * wb);
}
export function wFromDbRh(db, rh) { const p = pws(db) * rh / 100; return 0.621945 * p / (P - p); }
export function rhFromDbW(db, w) { const p = w * P / (0.621945 + w); return 100 * p / pws(db); }

export const DEFAULT_PROJECT = {
  name: "HVAC Load Calculation",
  country: "India",
  city: "Kochi",
  outDb: 35, outWb: 28,
  inDb: 24, inRh: 50,
  uWall: 2.0,   // W/m²K 230 mm brick, plastered
  uGlass: 5.8,  // single clear glass
  sc: 0.6,      // shading coefficient (clear glass + internal blinds)
  uRoof: 2.0,   // RCC slab with waterproofing/weathering course
  roofEtd: 22,  // K
  uPart: 2.2,   // partition to non-AC space
  infilAch: 0.5,
  safety: 10,   // %
  supplyDt: 11, // K room − supply air
  wwr: 30,      // % glazing of exposed wall when glass area not given
};

// Number parsing for anything a schedule or a typed table cell can contain.
// The rule (the same semantics as cleanNumber() in js/schedule.js — copied, not imported, so the
// engine stays a standalone module with no parser coupling):
//   "1249.3"  -> 1249.3   plain
//   "1,249.3" -> 1249.3   comma is a thousands separator, dot is the decimal point
//   "1.249,3" -> 1249.3   dot is a thousands separator, comma is the decimal point (European)
//   "12,5"    -> 12.5     a comma followed by 1-2 digits is a decimal comma
//   "1,249"   -> 1249     ambiguous (also 1.249 in Europe): a 3-digit group is read as thousands,
//                         which is what a room-area schedule means
// A comma AND a dot where the comma follows the dot means thousands; a lone comma with 1-2 digits
// after it means a decimal comma. parseFloat alone stops at the comma and reads 1,249.3 as 1.
export function num(v, d = 0) {
  if (typeof v === "number") return Number.isFinite(v) ? v : d;
  let t = String(v == null ? "" : v).replace(/\s+/g, "");
  if (!t) return d;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, ".");
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : d;
}

// Keep a value inside a sane band. Used so no single typed cell can drive a room negative.
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// The safety allowance is a percentage added to every room's sensible and latent heat. It is a raw
// project field, so it can arrive non-numeric or wildly wrong from an imported/edited project: a
// non-numeric value used to turn the WHOLE project total into NaN, and a negative value silently
// REDUCED the load. Both are impossible for a safety allowance, so it is sanitised exactly like the
// neighbouring numeric settings (see safeConditions): a parseable number, clamped to a sane band.
export const SAFETY_MIN = 0;    // a safety factor can never reduce a load
export const SAFETY_MAX = 100;  // a 100 % allowance is already extreme; anything above is a typo
export function safeSafetyPct(proj) {
  return clamp(num((proj || {}).safety, DEFAULT_PROJECT.safety), SAFETY_MIN, SAFETY_MAX);
}

// Project settings with every default filled in (older saved projects and partial test projects
// must not produce NaN).
function withDefaults(proj) { return { ...DEFAULT_PROJECT, ...(proj || {}) }; }

// Design conditions reduced to physically possible values. The user's typed numbers are NOT
// overwritten anywhere — projectWarnings() reports what was changed, and these safe values are what
// the load arithmetic uses so the report can never show a 137 % outdoor RH or a negative conduction.
function safeConditions(p) {
  const db = num(p.outDb, DEFAULT_PROJECT.outDb);
  const inDb = num(p.inDb, DEFAULT_PROJECT.inDb);
  const rh = clamp(num(p.inRh, DEFAULT_PROJECT.inRh), 0, 100);   // humidity above saturation is impossible
  const wb = Math.min(num(p.outWb, DEFAULT_PROJECT.outWb), db);  // wet bulb can never exceed dry bulb
  const dT = Math.max(0, db - inDb);                             // no cooling load is negative
  // The supply-air temperature difference divides the room sensible heat to give the supply flow, so a
  // zero (or negative) figure would divide by zero and print Infinity. Physics is not the point here:
  // the honest answer is "cannot be calculated", not a made-up number.
  const supplyDt = num(p.supplyDt, DEFAULT_PROJECT.supplyDt);
  const supplyOk = Number.isFinite(supplyDt) && supplyDt > 0;
  return { db, inDb, rh, wb, dT, supplyDt, supplyOk, wo: wFromDbWb(db, wb), wi: wFromDbRh(inDb, rh) };
}

// Plain-language notes for design conditions that are physically impossible. The app shows these
// the same way it shows the parser notes; the numbers the user typed are left as typed.
export function projectWarnings(proj = DEFAULT_PROJECT) {
  const p = withDefaults(proj);
  const n = (v) => (Number.isInteger(v) ? String(v) : String(+v.toFixed(2)));
  // Report the SAME numbers the arithmetic uses (safeConditions fills a blank field with its default),
  // so a warning can never contradict the maths: a blank outDb is 35 °C here exactly as it is there.
  const db = num(p.outDb, DEFAULT_PROJECT.outDb);
  const wb = num(p.outWb, DEFAULT_PROJECT.outWb);
  const inDb = num(p.inDb, DEFAULT_PROJECT.inDb);
  const rh = num(p.inRh, DEFAULT_PROJECT.inRh);
  const supplyDt = num(p.supplyDt, DEFAULT_PROJECT.supplyDt);
  const out = [];
  if (wb > db)
    out.push(`Outdoor wet bulb ${n(wb)} \u00b0C is above dry bulb ${n(db)} \u00b0C \u2014 using saturated air (100% RH).`);
  if (db <= inDb)
    out.push(`Outdoor dry bulb ${n(db)} \u00b0C is not above indoor ${n(inDb)} \u00b0C \u2014 conduction gain taken as zero.`);
  if (rh > 100)
    out.push(`Indoor RH ${n(rh)}% is above 100% \u2014 using 100%.`);
  if (!(Number.isFinite(supplyDt) && supplyDt > 0))
    out.push(`Supply air \u0394T ${n(supplyDt)} K is not above 0 K \u2014 the supply air flow cannot be calculated, ` +
      `so it is shown as "-".`);
  const safety = num(p.safety, DEFAULT_PROJECT.safety);
  if (!(safety >= SAFETY_MIN && safety <= SAFETY_MAX))
    out.push(`Safety factor ${n(safety)} % is outside ${SAFETY_MIN}\u2013${SAFETY_MAX} % \u2014 using ` +
      `${safeSafetyPct(p)} % (a safety allowance can never reduce a load).`);
  return out;
}

// Per-room notes for geometry that had to be clamped so the room cannot subtract from a total.
// `raw` is what the user typed; `room` is the normalised room (its area may have been derived from
// length × width, so the area check must read the normalised value).
function geometryWarnings(raw, room) {
  const who = room.name || "Room";
  const out = [];
  const a = num(room.area);
  if (a < 0) out.push(`${who}: area ${a} m\u00b2 is negative \u2014 counted as 0 m\u00b2 (no load).`);
  else if (a === 0) out.push(`${who}: no area \u2014 counted as 0 m\u00b2 (no load).`);
  const h = num(raw.height);
  if (h !== 0 && (h < 0.5 || h > 10)) out.push(`${who}: height ${h} m is outside 0.5\u201310 m \u2014 using ${clamp(h, 0.5, 10)} m.`);
  const neg = [];
  if (num(raw.glass) < 0) neg.push("glass");
  if (num(raw.extWall) < 0) neg.push("ext wall");
  if (num(raw.partition) < 0) neg.push("partition");
  if (num(raw.people) < 0) neg.push("people");
  if (num(raw.light) < 0) neg.push("light");
  if (num(raw.equip) < 0) neg.push("equip");
  if (neg.length) out.push(`${who}: negative ${neg.join(", ")} ignored (using 0).`);
  return out;
}

// Fill blank/derived room fields
export function normalizeRoom(r, proj = DEFAULT_PROJECT) {
  const room = { ...r };
  room.type = room.type || guessSpaceType(room.name);
  const st = SPACE_TYPES[room.type] || SPACE_TYPES.general;
  if (!num(room.area) && num(room.length) && num(room.width)) room.area = +(num(room.length) * num(room.width)).toFixed(2);
  room.height = clamp(num(room.height) || 3.0, 0.5, 10);   // no negative or absurd room height
  if (room.people === undefined || room.people === "" || room.people === null)
    room.people = num(room.area) > 0 ? Math.max(1, Math.ceil(num(room.area) / st.m2pp)) : 0;
  if (room.light === undefined || room.light === "") room.light = st.light;
  if (room.equip === undefined || room.equip === "") room.equip = st.equip;
  room.orient = room.orient || "W";
  if (room.extWall === undefined || room.extWall === "") {
    // assume one side of the room is exposed: longer side length × height
    const side = Math.max(num(room.length), num(room.width)) || Math.sqrt(Math.max(0, num(room.area) || 0));
    room.extWall = +(side * room.height).toFixed(2);
  }
  if (room.glass === undefined || room.glass === "") room.glass = +(num(room.extWall) * num((proj || {}).wwr, DEFAULT_PROJECT.wwr) / 100).toFixed(2);
  if (room.roof === undefined) room.roof = false;
  if (room.include === undefined) room.include = !NON_AC_WORDS.test(room.name || "");
  return room;
}

export function calcRoom(r, proj = DEFAULT_PROJECT) {
  const p = withDefaults(proj);
  const room = normalizeRoom(r, p);
  const st = SPACE_TYPES[room.type] || SPACE_TYPES.general;
  const warnings = geometryWarnings(r, room);
  // Geometry is clamped to physically sensible numbers so one bad cell can never make a room
  // SUBTRACT from the project total (a negative area, height or glass used to give a negative TR).
  const A = Math.max(0, num(room.area));              // floor area is never negative
  const H = clamp(num(room.height) || 3.0, 0.5, 10);  // sane room height, 0.5–10 m
  const vol = A * H;
  const areaOk = A > 0;                               // a room with no area carries no load at all
  const c = safeConditions(p);
  const dT = c.dT, wo = c.wo, wi = c.wi;              // dT >= 0: conduction never flows backwards
  const dW = Math.max(0, wo - wi);
  const ext = Math.max(0, num(room.extWall));
  const rawGlass = Math.max(0, num(room.glass));
  // glass can never exceed the wall it sits in, and neither may be negative: the old
  // Math.min(glass, extWall || glass) clamp picked the MORE negative of two bad numbers
  const glass = areaOk ? Math.min(rawGlass, Math.max(0, ext || rawGlass)) : 0;
  const wallNet = areaOk ? Math.max(0, ext - glass) : 0;
  const o = ORIENTS.includes(room.orient) ? room.orient : "W";

  const s = {};
  s.glassSolar = glass * SOLAR[o] * p.sc;
  s.glassCond = glass * p.uGlass * dT;
  s.wall = wallNet * p.uWall * WALL_ETD[o];
  s.roof = room.roof ? A * p.uRoof * p.roofEtd : 0;
  s.partition = areaOk ? Math.max(0, num(room.partition)) * p.uPart * Math.max(0, dT - 3) : 0;
  const ppl = areaOk ? Math.max(0, num(room.people)) : 0;
  s.people = ppl * st.ps;
  s.lighting = A * Math.max(0, num(room.light));
  s.equipment = A * Math.max(0, num(room.equip));
  const infLs = p.infilAch * vol * 1000 / 3600;
  s.infiltration = 1.23 * infLs * dT;
  const roomSensible = Object.values(s).reduce((a, b) => a + b, 0);

  const l = {};
  l.people = ppl * st.pl;
  l.infiltration = 3010 * infLs * dW;
  const roomLatent = l.people + l.infiltration;

  const oaLs = ppl * st.oap + A * st.oaa;
  const oaSens = 1.23 * oaLs * dT;
  const oaLat = 3010 * oaLs * dW;

  const sf = 1 + safeSafetyPct(p) / 100;
  const rsh = roomSensible * sf, rlh = roomLatent * sf;
  const total = rsh + rlh + oaSens + oaLat;
  // supply flow needs a positive supply-air ΔT to divide by; when it is zero or negative the honest
  // value is "not calculable" (screen / report / CSV show "-"), never Infinity from a division by zero.
  const supplyLs = c.supplyOk ? rsh / (1.23 * c.supplyDt) : 0;
  return {
    room,
    warnings,
    sensible: s, latent: l,
    rsh, rlh, oaSens, oaLat, oaLs,
    // what the safety factor ADDED to this room, so the summary can show the allowance as a number
    // rather than only as a percentage in the settings
    safetyW: (roomSensible + roomLatent) * (sf - 1),
    totalW: total,
    tr: total / 3517,
    shf: rsh / (rsh + rlh || 1),
    supplyLs, supplyOk: c.supplyOk, supplyDt: c.supplyDt,
    cfm: supplyLs * 2.11888, oaCfm: oaLs * 2.11888,
    sqftPerTr: total > 0 ? (A * 10.7639) / (total / 3517) : 0,
  };
}

export function calcProject(rooms, proj = DEFAULT_PROJECT) {
  const p = withDefaults(proj);
  const c = safeConditions(p);
  const results = (rooms || []).map((r) => calcRoom(r, p));
  const inc = results.filter((x) => x.room.include);
  const sum = (k) => inc.reduce((a, x) => a + x[k], 0);
  const area = inc.reduce((a, x) => a + Math.max(0, num(x.room.area)), 0);   // negative areas cannot shrink the area
  const tr = sum("tr");
  // The same warnings channel the parser notes use: impossible design conditions first, then the
  // rooms whose geometry had to be clamped.
  const warnings = [...projectWarnings(p)];
  for (const x of inc) for (const w of x.warnings) warnings.push(w);
  return {
    results,
    warnings,
    totals: {
      rooms: inc.length, area, areaSqft: area * 10.7639,
      totalW: sum("totalW"), tr, ls: sum("supplyLs"), oaLs: sum("oaLs"), cfm: sum("cfm"), oaCfm: sum("oaCfm"),
      rsh: sum("rsh"), rlh: sum("rlh"),
      safetyW: sum("safetyW"), safetyPct: safeSafetyPct(p),
      sqftPerTr: tr ? (area * 10.7639) / tr : 0,
      wOut: c.wo, wIn: c.wi,
      outRh: rhFromDbW(c.db, c.wo),
      // false when the supply-air ΔT made the supply flow incalculable; the UI prints "-" rather than 0
      supplyOk: c.supplyOk, supplyDt: c.supplyDt,
    },
  };
}

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

export const NON_AC_WORDS = /\b(toilet|wc|w\.c|bath|washroom|lavatory|store|storage|shaft|duct|stair|staircase|lift|elevator|corridor|passage|utility|balcony|sit[- ]?out|verandah|veranda|porch|parking|garage|electrical|elec\.|janitor|jan\.|pantry|kitchen|wash|dress|dressing|court\s*yard|terrace|open(?!\s+(plan|office))|void|ramp|drive)\b/i;

export function guessSpaceType(name) {
  const n = (name || "").toLowerCase();
  const rules = [
    [/server|data|it room|hub|ups|comms/, "server"],
    [/conf|meeting|board|discussion|training/, "conference"],
    [/cabin|manager|md|ceo|director|chamber/, "cabin"],
    [/recep|lobby|waiting|foyer|entrance/, "reception"],
    [/shop|retail|showroom|store front|display/, "retail"],
    [/restaurant|dining|cafe|cafeteria|canteen|food/, "restaurant"],
    [/bed|master|guest room|kids/, "bedroom"],
    [/living|family|lounge|drawing|hall|home theat/, "living"],
    [/class|lecture|lab|library|study/, "classroom"],
    [/ward|patient|icu|opd|consult|clinic|ot\b|operation/, "hospital"],
    [/gym|fitness|yoga/, "gym"],
    [/office|work|admin|account|hr\b|staff|open plan|workstation/, "office"],
  ];
  for (const [re, t] of rules) if (re.test(n)) return t;
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

export function num(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

// Fill blank/derived room fields
export function normalizeRoom(r, proj = DEFAULT_PROJECT) {
  const room = { ...r };
  room.type = room.type || guessSpaceType(room.name);
  const st = SPACE_TYPES[room.type] || SPACE_TYPES.general;
  if (!num(room.area) && num(room.length) && num(room.width)) room.area = +(num(room.length) * num(room.width)).toFixed(2);
  room.height = num(room.height) || 3.0;
  if (room.people === undefined || room.people === "" || room.people === null)
    room.people = Math.max(1, Math.ceil(num(room.area) / st.m2pp));
  if (room.light === undefined || room.light === "") room.light = st.light;
  if (room.equip === undefined || room.equip === "") room.equip = st.equip;
  room.orient = room.orient || "W";
  if (room.extWall === undefined || room.extWall === "") {
    // assume one side of the room is exposed: longer side length × height
    const side = Math.max(num(room.length), num(room.width)) || Math.sqrt(num(room.area) || 0);
    room.extWall = +(side * room.height).toFixed(2);
  }
  if (room.glass === undefined || room.glass === "") room.glass = +(num(room.extWall) * proj.wwr / 100).toFixed(2);
  if (room.roof === undefined) room.roof = false;
  if (room.include === undefined) room.include = !NON_AC_WORDS.test(room.name || "");
  return room;
}

export function calcRoom(r, proj = DEFAULT_PROJECT) {
  const room = normalizeRoom(r, proj);
  const st = SPACE_TYPES[room.type] || SPACE_TYPES.general;
  const A = num(room.area), H = num(room.height), vol = A * H;
  const dT = proj.outDb - proj.inDb;
  const wo = wFromDbWb(proj.outDb, proj.outWb), wi = wFromDbRh(proj.inDb, proj.inRh);
  const dW = Math.max(0, wo - wi);
  const glass = Math.min(num(room.glass), num(room.extWall) || num(room.glass));
  const wallNet = Math.max(0, num(room.extWall) - glass);
  const o = ORIENTS.includes(room.orient) ? room.orient : "W";

  const s = {};
  s.glassSolar = glass * SOLAR[o] * proj.sc;
  s.glassCond = glass * proj.uGlass * dT;
  s.wall = wallNet * proj.uWall * WALL_ETD[o];
  s.roof = room.roof ? A * proj.uRoof * proj.roofEtd : 0;
  s.partition = num(room.partition) * proj.uPart * Math.max(0, dT - 3);
  const ppl = num(room.people);
  s.people = ppl * st.ps;
  s.lighting = A * num(room.light);
  s.equipment = A * num(room.equip);
  const infLs = proj.infilAch * vol * 1000 / 3600;
  s.infiltration = 1.23 * infLs * dT;
  const roomSensible = Object.values(s).reduce((a, b) => a + b, 0);

  const l = {};
  l.people = ppl * st.pl;
  l.infiltration = 3010 * infLs * dW;
  const roomLatent = l.people + l.infiltration;

  const oaLs = ppl * st.oap + A * st.oaa;
  const oaSens = 1.23 * oaLs * dT;
  const oaLat = 3010 * oaLs * dW;

  const sf = 1 + proj.safety / 100;
  const rsh = roomSensible * sf, rlh = roomLatent * sf;
  const total = rsh + rlh + oaSens + oaLat;
  const supplyLs = rsh / (1.23 * proj.supplyDt);
  return {
    room,
    sensible: s, latent: l,
    rsh, rlh, oaSens, oaLat, oaLs,
    totalW: total,
    tr: total / 3517,
    shf: rsh / (rsh + rlh || 1),
    supplyLs, cfm: supplyLs * 2.11888, oaCfm: oaLs * 2.11888,
    sqftPerTr: total > 0 ? (A * 10.7639) / (total / 3517) : 0,
  };
}

export function calcProject(rooms, proj = DEFAULT_PROJECT) {
  const results = rooms.map((r) => calcRoom(r, proj));
  const inc = results.filter((x) => x.room.include);
  const sum = (k) => inc.reduce((a, x) => a + x[k], 0);
  const area = inc.reduce((a, x) => a + num(x.room.area), 0);
  const tr = sum("tr");
  return {
    results,
    totals: {
      rooms: inc.length, area, areaSqft: area * 10.7639,
      totalW: sum("totalW"), tr, ls: sum("supplyLs"), oaLs: sum("oaLs"), cfm: sum("cfm"), oaCfm: sum("oaCfm"),
      rsh: sum("rsh"), rlh: sum("rlh"),
      sqftPerTr: tr ? (area * 10.7639) / tr : 0,
      wOut: wFromDbWb(proj.outDb, proj.outWb), wIn: wFromDbRh(proj.inDb, proj.inRh),
      outRh: rhFromDbW(proj.outDb, wFromDbWb(proj.outDb, proj.outWb)),
    },
  };
}

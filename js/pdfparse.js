// js/pdfparse.js — extract rooms from architectural / MEP PDF drawings.
//
//   export async function parsePdf(arrayBuffer, { pdfjs, onProgress }) -> { rooms, pages, text, warnings }
//   export function parseText(items) -> { rooms, warnings }   // pure + testable
//
// `items` are in DISPLAY coordinates: x to the right, y DOWN, page coordinates at scale 1
// (exactly what pdfjs.Util.transform(viewport.transform, item.transform) gives us). Each item also
// carries `atPdf` — the same point in PDF user space (y UP), which is what a room's `rect` uses.
// parsePdf never imports pdf.js itself — the caller passes the module in (`{ pdfjs }`).
// Room objects follow the shared contract in AGENTS.md.

import { guessSpaceType, NON_AC_WORDS } from "./calc.js";

const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const clampStr = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- area labels

// One area figure with its unit. Feet-based units are converted to m².
const AREA_TOKEN =
  /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(m²|m\^2|m2|sq\.?\s*met(?:re|er)s?|sqm|sq\.?\s*m|ft²|ft\^2|ft2|sft|sq\.?\s*ft|sq\.?\s*feet)/i;

/** @returns {{value:number, ft:boolean, start:number, end:number, raw:string}|null} */
export function parseAreaToken(str) {
  const s = clampStr(str);
  const m = s.match(AREA_TOKEN);
  if (!m) return null;
  // "sq m" without the dot must not be read out of a word like "squash"
  const after = s.charAt(m.index + m[0].length);
  if (/[a-z]/i.test(after)) return null;
  const v = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(v) || v <= 0) return null;
  const u = m[2].toLowerCase();
  const ft = /ft|sft/.test(u);
  return { value: ft ? +(v * 0.092903).toFixed(3) : v, ft, start: m.index, end: m.index + m[0].length, raw: m[0] };
}

// Duct / airflow / size annotations — never room names.
const DUCT_RE =
  /(?:\d\s*mm\b)|(?:\bmm\s*[x×])|(?:\bmm\b)|ø|L\s*\/\s*S\b|SLSD|SCD\b|\bCFM\b|\bNOS\b|\bWIDTH\b|\bSLOT\b|\bGRILLE\b|\bDIFFUSER\b|\bVD\b|\bFD\b|\bBD\b/i;
// Title-block / sheet annotation words — never room names.
const SHEET_RE =
  /\b(SHEET|DRAWING|DWG|SCALE|LAYOUT|PLAN|DATE|PROJECT|CHECKED|DRAWN|REVISION|REV|SCHEMATIC|DESIGN|LEGEND|LEGENDS|NOTES?|STAMP|OF)\b/i;
const NOT_ENCLOSED_RE = /not\s*enclosed/i;
// Pure room-number tokens: "24", "05", "S01", "S03", "27", "A1".
const NUMBER_TOKEN_RE = /^[A-Za-z]{0,3}[0-9]{1,4}[A-Za-z]?$/;
// Titles we must never treat as a room name.
const JUNK_NAME_RE = /^[?.,:;*\-\u2013\u2014|/\\]+$/;

// ---------------------------------------------------------------- level titles

const FLOOR_WORDS = {
  ground: "Ground", first: "First", second: "Second", third: "Third", fourth: "Fourth",
  fifth: "Fifth", sixth: "Sixth", seventh: "Seventh", eighth: "Eighth", ninth: "Ninth",
  tenth: "Tenth", eleventh: "Eleventh", twelfth: "Twelfth", basement: "Basement",
  mezzanine: "Mezzanine", mezz: "Mezzanine", penthouse: "Penthouse", terrace: "Terrace",
  roof: "Roof", lowerground: "Lower Ground", upperground: "Upper Ground",
};
const SHORT_LEVEL = { gf: "Ground", ff: "First", sf: "Second", tf: "Third", bf: "Basement" };

/** Read a floor/level title out of one text string. Higher score = more trustworthy. */
export function detectLevelTitle(str) {
  const s = clampStr(str);
  if (!s || s.length > 90) return null;
  let title = null, score = 0;

  // "GROUND FLOOR", "FIRST FLOOR LAYOUT", "LOWER GROUND LEVEL", "3RD FLOOR PLAN"
  let m = s.match(
    /\b(lower\s+ground|upper\s+ground|ground|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|basement|mezzanine|penthouse|terrace|roof)\s+(floor|level|storey|story)\b/i
  );
  if (m) {
    const key = m[1].toLowerCase().replace(/\s+/g, "");
    title = (FLOOR_WORDS[key] || m[1]) + " Floor";
    score = 100;
  }
  if (!title) {
    m = s.match(/\b([0-9]{1,2})(?:st|nd|rd|th)\s+(floor|level|storey|story)\b/i);
    if (m) { title = ordinate(parseInt(m[1], 10)) + " Floor"; score = 95; }
  }
  if (!title) {
    // "L1 FLOOR LAYOUT", "LEVEL 02", "L01"
    m = s.match(/\b(?:L|LVL|LEVEL)[\s.\-]?([0-9]{1,2})\b/i);
    if (m) { title = "L" + parseInt(m[1], 10) + " Floor"; score = 80; }
  }
  if (!title) {
    m = s.match(/^(GF|FF|SF|TF|BF)$/i);
    if (m) { title = (SHORT_LEVEL[m[1].toLowerCase()] || m[1]) + " Floor"; score = 45; }
  }
  if (!title) return null;

  // A sheet title ("GF Sheet Ducting Layout") is a weak hint, not a floor plan title.
  if (/\b(DUCT|DUCTING|SHEET|DRAWING|DETAIL|SECTION|SCHEDULE|VIEW|TITLE)\b/i.test(s)) score -= 60;
  if (/\b(LAYOUT|PLAN)\b/i.test(s)) score += 10;
  if (s.length > 40) score -= 10;
  return score >= 60 ? { title, score } : null;
}

function ordinate(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function detectLevels(items) {
  const best = new Map(); // page -> {title, score}
  for (const it of items) {
    const hit = detectLevelTitle(it.str);
    if (!hit) continue;
    const cur = best.get(it.page);
    if (!cur || hit.score > cur.score) best.set(it.page, hit);
  }
  const out = new Map();
  for (const [page, hit] of best) out.set(page, hit.title);
  return out;
}

// ---------------------------------------------------------------- dimensions

/** "4.5 x 3.6", "4500x3600" (mm), "12'-0\" x 10'-6\"" -> {length, width} in metres. */
export function parseDims(str) {
  const s = clampStr(str);
  if (!s) return null;
  // duct / airflow annotations are sizes, not room dimensions
  if (/ø|\bmm\b|L\s*\/\s*S/i.test(s)) return null;
  let m = s.match(/([0-9]+)\s*'\s*[-–]?\s*([0-9]+(?:\.[0-9]+)?)?\s*"?\s*[x×]\s*([0-9]+)\s*'\s*[-–]?\s*([0-9]+(?:\.[0-9]+)?)?\s*"?/i);
  if (m) {
    // feet + inches -> metres
    const a = (parseInt(m[1], 10) + (m[2] ? parseFloat(m[2]) : 0) / 12) * 0.3048;
    const b = (parseInt(m[3], 10) + (m[4] ? parseFloat(m[4]) : 0) / 12) * 0.3048;
    if (a > 0 && b > 0) return { length: +a.toFixed(3), width: +b.toFixed(3) };
  }
  m = s.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:m|mm)?\s*[x×]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:m|mm)?/i);
  if (m) {
    let a = parseFloat(m[1]), b = parseFloat(m[2]);
    if (a > 100 && b > 100) { a /= 1000; b /= 1000; } // millimetres
    if (a > 0 && b > 0 && a < 500 && b < 500) return { length: +a.toFixed(3), width: +b.toFixed(3) };
  }
  return null;
}

// ---------------------------------------------------------------- include rules

const NON_AC_EXTRA =
  /(?:^|[^a-z0-9])(?:PL \d|FHC|VOID|ATRIUM VOID|ST\.? ?\d+|IDF|ELEC\.? ?C|TEL\.? ?C|J\. ?C|ABLUTION|F\. ?TL|M\. ?TL|ADA|KIT\.?)(?![a-z0-9])/i;

function includeRoom(name, area, source) {
  const n = clampStr(name);
  if (!n || JUNK_NAME_RE.test(n)) return false;
  if (NON_AC_EXTRA.test(n)) return false;
  if (NON_AC_WORDS.test(n)) return false;
  if (!(num(area) > 2)) return false;
  if (/^(void|pl|fhc|shaft)$/i.test(n.replace(/[.\s]+$/, ""))) return false;
  return true;
}

// ---------------------------------------------------------------- geometry

function itemSpan(it) {
  const h = it.h || 8;
  const w = Number.isFinite(it.w) && it.w > 0 ? it.w : Math.max(h * 0.5, it.str.length * h * 0.5);
  return { x0: it.x, x1: it.x + w, h };
}
const itemCenterX = (it) => { const s = itemSpan(it); return (s.x0 + s.x1) / 2; };

// ---------------------------------------------------------------- row grouping (schedules)

function groupRows(items) {
  const rows = [];
  for (const it of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let row = null;
    for (const r of rows) {
      const tol = Math.max(2, Math.min(it.h || 8, r.h || 8) / 2);
      if (Math.abs(r.y - it.y) <= tol) { row = r; break; }
    }
    if (!row) { row = { y: it.y, h: it.h || 8, items: [] }; rows.push(row); }
    row.items.push(it);
  }
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    // glue together glyph runs that pdf.js emitted separately ("4.5" "x" "3.6")
    const glued = [];
    for (const it of r.items) {
      const last = glued[glued.length - 1];
      if (last) {
        const sp = itemSpan(last);
        if (it.x - sp.x1 < 0.3 * (it.h || 8) && it.x >= sp.x0 - 1) {
          last.str = clampStr(last.str + it.str);
          last.w = Number.isFinite(it.w) ? sp.x1 - sp.x0 + it.w : last.w;
          continue;
        }
      }
      glued.push({ ...it });
    }
    r.items = glued;
    r.text = r.items.map((i) => i.str).join("  ");
  }
  return rows.sort((a, b) => a.y - b.y);
}

const HEAD_NAME = /\b(ROOM|ROOM NAME|NAME|SPACE|SPACE NAME|AREA NAME|DESCRIPTION|FUNCTION|ROOM TYPE)\b/i;
const HEAD_AREA = /\b(AREA|AREA M2|M2|M²|SQ\.?\s?M|SQFT|SQ\.?\s?FT|FT2)\b/i;
const HEAD_DIM = /\b(LENGTH|WIDTH|L\s*[x/]\s*W|W\s*[x/]\s*L|DIMENSIONS?|DIMENSIONS|DIMNS?|SIZE\s*MM)\b/i;

/** Try to read a room schedule table on one page. */
function parseSchedule(items, levelByPage, warnings) {
  const rows = groupRows(items);
  let head = -1;
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].text;
    if (HEAD_NAME.test(t) && (HEAD_AREA.test(t) || HEAD_DIM.test(t))) { head = i; break; }
  }
  if (head < 0) return null;

  const header = rows[head];
  const textOfCol = (col) => (header.items[col] ? header.items[col].str : "");
  let nameCol = -1, areaCol = -1, lCol = -1, wCol = -1, numCol = -1;
  header.items.forEach((it, c) => {
    const s = it.str;
    if (nameCol < 0 && HEAD_NAME.test(s)) nameCol = c;
    else if (areaCol < 0 && HEAD_AREA.test(s)) areaCol = c;
    else if (lCol < 0 && /\b(LENGTH|L)\b/i.test(s) && !HEAD_NAME.test(s)) lCol = c;
    else if (wCol < 0 && /\b(WIDTH|W)\b/i.test(s) && !HEAD_NAME.test(s)) wCol = c;
    else if (numCol < 0 && /\b(NO\.?|NUMBER|RM NO\.?|SR\.?|S\.?\s?NO)\b/i.test(s)) numCol = c;
  });
  if (nameCol < 0) nameCol = 0;

  const rooms = [];
  for (let i = head + 1; i < rows.length; i++) {
    const row = rows[i];
    const cells = row.items.map((it) => it.str);
    if (!cells.length) continue;
    const plain = row.text;
    // Skip a REPEATED HEADER row only when it really looks like a header: at least two
    // header-ish cells and nothing that parses as a number/area. A data row such as
    // "Meeting Room  27.0 m2" also contains a name word and "m2" and must NOT be dropped.
    const headerCells = cells.filter((c) => HEAD_NAME.test(c) || HEAD_AREA.test(c) || HEAD_DIM.test(c)).length;
    const looksNumeric = cells.some((c) => parseAreaToken(c) || /^\s*\d+([.,]\d+)?\s*$/.test(c));
    if (headerCells >= 2 && !looksNumeric) continue;             // repeated header
    if (!/[A-Za-z]{2}/.test(plain)) continue;                    // no name text at all

    let name = "", number = "", area = 0, length = 0, width = 0;
    const numerics = [];
    const rest = [];
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c];
      const at = parseAreaToken(cell);
      const dims = parseDims(cell);
      if (at && cell.replace(AREA_TOKEN, "").replace(/[\s.,;:()]/g, "") === "") {
        if (!area) area = at.value;
        continue;
      }
      if (dims) { if (!length) { length = dims.length; width = dims.width; } continue; }
      if (NUMBER_TOKEN_RE.test(cell.replace(/[\s.]/g, ""))) {
        if (numCol >= 0 && c === numCol) number = cell.replace(/[\s.]/g, "");
        else numerics.push(cell);
        continue;
      }
      // "101 Lobby 45.5 m2" in one cell: split the leading number / trailing area
      let text = cell;
      const lead = text.match(/^([0-9]{1,4}[A-Za-z]?)[\s.\-]+(.+)$/);
      if (lead && !number && /[A-Za-z]{2}/.test(lead[2])) { number = lead[1]; text = lead[2]; }
      const trail = parseAreaToken(text);
      if (trail && text.slice(0, trail.start).replace(/[\s.,;:()]/g, "").length > 0) {
        area = area || trail.value;
        text = text.slice(0, trail.start);
      }
      rest.push({ c, text: clampStr(text) });
    }

    // numbers with no unit: a leading integer is the room number, then L, W, area
    const pool = numerics.map((s) => ({ s, v: parseFloat(s) }));
    const plainInt = (x) => /^[0-9]{1,4}[A-Za-z]?$/.test(x.s) && x.v > 0;
    if (!number && pool.length && plainInt(pool[0]) && (pool.length >= 3 || (pool.length === 2 && !length)))
      number = pool.shift().s;
    if (!area && pool.length >= 3) {
      length = length || pool[0].v;
      width = width || pool[1].v;
      area = pool[pool.length - 1].v;
    }
    if (!length && !width && pool.length >= 2) { length = pool[0].v; width = pool[1].v; }
    if (!area && pool.length === 2) {
      const [a, b] = pool;
      if (plainInt(a) && !plainInt(b)) { number = number || a.s; area = b.v; }
      else area = b.v >= 2 ? b.v : a.v;
    }
    if (!area && pool.length === 1 && pool[0].v >= 2) area = pool[0].v;
    if (!area && length && width) area = +(length * width).toFixed(2);

    for (const r of rest) if (r.text && !name) name = r.text;
    if (!name) name = rest.map((r) => r.text).filter(Boolean).join(" ");
    name = clampStr(name);
    if (!name || !/[A-Za-z]{2}/.test(name)) continue;
    if (!(area > 0) && !(length && width)) continue;

    rooms.push(makeRoom({ name, number, area: area || +(length * width).toFixed(2), length, width, level: levelByPage.get(row.items[0].page) || "", source: "table", page: row.items[0].page }));
  }

  if (!rooms.length) return null;
  if (rooms.length < 2) warnings.push(`Page ${rooms[0].page}: room schedule table looked incomplete (only 1 row)`);
  return { rooms, page: rooms[0].page };
}

// ---------------------------------------------------------------- label tags

/** Group leftover name-only lines into printed room names.
 *  A line continues the name above it only when it is a SINGLE word sitting within a line-height
 *  below and centred on that line — exactly how a wrapped room name reads ("ROOM" under
 *  "COMMUNICATION", "STORE" under "SECURE"). A whole name ("BLACK SATURDAY GALLERY") starts its own
 *  tag: it is multi-word, so it can never be swallowed as a continuation of a neighbour. */
function clusterNameTags(candidates) {
  const list = [...candidates].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const used = new Set();
  const tags = [];
  for (const c of list) {
    if (used.has(c)) continue;
    used.add(c);
    const lines = [c];
    let anchor = c;
    for (;;) {
      const ah = anchor.h || 8;
      const acx = itemCenterX(anchor);
      let next = null, bestDy = Infinity;
      for (const o of list) {
        if (used.has(o) || o.page !== anchor.page) continue;
        const dy = o.y - anchor.y;
        if (dy <= 0.5 || dy > 1.5 * ah) continue;
        if (/\s/.test(clampStr(o.str))) continue;                 // only a single short word continues
        if (Math.abs(itemCenterX(o) - acx) > Math.max(1.2 * ah, 8)) continue;
        if (dy < bestDy) { bestDy = dy; next = o; }
      }
      if (!next) break;
      used.add(next);
      lines.push(next);
      anchor = next;
    }
    tags.push(lines);
  }
  return tags;
}

/** Rooms from drawing room tags: NAME line(s), NUMBER, AREA stacked top-to-bottom. */
function parseLabels(items, levelByPage, warnings, usedSet) {
  const areas = [];
  const candidates = [];
  for (const it of items) {
    if (NOT_ENCLOSED_RE.test(it.str)) continue;
    const at = parseAreaToken(it.str);
    const stripped = it.str.replace(AREA_TOKEN, "").replace(/[\s.,;:()|]/g, "");
    if (at && stripped === "") { areas.push({ it, value: at.value, embedded: "" }); continue; }
    if (at && stripped.length > 0) {
      areas.push({ it, value: at.value, embedded: clampStr(it.str.slice(0, at.start)) });
      continue;
    }
    if (DUCT_RE.test(it.str) || SHEET_RE.test(it.str) || JUNK_NAME_RE.test(it.str)) continue;
    candidates.push(it);
  }
  const notEnclosedItems = items.filter((it) => NOT_ENCLOSED_RE.test(it.str));

  // A text line belongs to the ONE area label it sits closest to
  // (tags of neighbouring rooms can be as little as 40 pt apart).
  const slackX = (h) => Math.max(26, 2.2 * h);
  const upLimit = (h) => Math.min(42, 3.6 * h);
  const dist = (a, c, h) => Math.hypot(Math.abs(c.x - a.it.x) / slackX(h), Math.abs(a.it.y - c.y) / upLimit(h));

  const owner = new Map(); // candidate -> area
  for (const c of candidates) {
    if (usedSet.has(c)) continue;
    const h = c.h || 8;
    let best = null, bestD = Infinity;
    for (const a of areas) {
      if (a.it.page !== c.page) continue;
      const dy = a.it.y - c.y;
      if (dy <= 0.5 || dy > upLimit(h)) continue;
      if (Math.abs(c.x - a.it.x) > slackX(h)) continue;
      const d = dist(a, c, h);
      if (d < bestD) { bestD = d; best = a; }
    }
    if (best) owner.set(c, best);
  }

  const mine = new Map(); // area -> candidates
  for (const [c, a] of owner) {
    if (!mine.has(a)) mine.set(a, []);
    mine.get(a).push(c);
  }

  const rooms = [];
  const orphan = new Map(); // page -> count of area labels without any name
  for (const a of [...areas].sort((x, y) => x.it.page - y.it.page || x.it.y - y.it.y || x.it.x - y.it.x)) {
    const page = a.it.page;
    const h = a.it.h || 8;
    const near = (mine.get(a) || []).sort((p, q) => (a.it.y - p.y) - (a.it.y - q.y) || Math.abs(p.x - a.it.x) - Math.abs(q.x - a.it.x));

    // Nearest lines first; stop at a vertical gap (whatever is higher belongs elsewhere).
    const picked = [];
    let prevDy = 0;
    for (const c of near) {
      const dy = a.it.y - c.y;
      if (prevDy && dy - prevDy > 2.4 * h) break;
      picked.push(c);
      prevDy = dy;
    }

    let number = "";
    const nameLines = [];
    for (const c of picked) {
      // room number: a short alpha-numeric token with no space ("24", "05", "S01", "27")
      if (!number && c.str.length <= 5 && NUMBER_TOKEN_RE.test(c.str)) {
        number = c.str;
        usedSet.add(c);
        continue;
      }
      nameLines.push(c);
    }
    if (a.embedded) nameLines.push({ str: a.embedded, x: a.it.x, y: a.it.y + h, h, page });

    nameLines.sort((p, q) => p.y - q.y || p.x - q.x);
    const parts = [];
    for (const c of nameLines) {
      const t = clampStr(c.str);
      if (!t || DUCT_RE.test(t) || SHEET_RE.test(t) || JUNK_NAME_RE.test(t)) continue;
      // a fragment already contained in the name we built ("PL 3" + "PL") is not a new line
      const norm = t.toLowerCase().replace(/[^a-z0-9]/g, "");
      const joined = parts.join(" ").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (norm && joined && joined.includes(norm)) { usedSet.add(c); continue; }
      parts.push(t);
      usedSet.add(c);
    }
    const name = clampStr(parts.join(" "));

    if (!name) { orphan.set(page, (orphan.get(page) || 0) + 1); continue; }
    usedSet.add(a.it);
    rooms.push(makeRoom({
      name, number, area: a.value, level: levelByPage.get(page) || "", source: "label", page,
      // where on the sheet this room is named, in PDF user space (y up). Lets the app place every
      // room of the table on the plan instead of only the ones the user drew by hand.
      at: a.it && a.it.atPdf ? { x: +a.it.atPdf.x.toFixed(2), y: +a.it.atPdf.y.toFixed(2) } : undefined,
    }));
  }

  // ---- name-only rooms ----------------------------------------------------
  // A sheet that prints room NAMES but no AREA figures used to come back empty: every candidate
  // line needs an area label under it to become a room. Real drawings often print names only (and a
  // scan's small area text may not survive), so when a page has (almost) no areas its leftover name
  // candidates are clustered into rooms of their own. Such a room's area is explicitly UNKNOWN:
  // `area: null` plus `areaUnknown: true`. null can never be misread as a measured 0, and js/calc.js
  // reads a null area as "no area" (areaOk = false), so an unknown area contributes no load at all.
  const areasOnPage = new Map();
  for (const a of areas) areasOnPage.set(a.it.page, (areasOnPage.get(a.it.page) || 0) + 1);
  const candsOnPage = new Map();
  for (const c of candidates) candsOnPage.set(c.page, (candsOnPage.get(c.page) || 0) + 1);
  const fewAreas = (page) => {
    const na = areasOnPage.get(page) || 0, nc = candsOnPage.get(page) || 0;
    return nc > 0 && na < Math.max(1, Math.floor(nc * 0.2));
  };
  const leftovers = candidates.filter((c) => !usedSet.has(c) && fewAreas(c.page));
  for (const lines of clusterNameTags(leftovers)) {
    let number = "";
    const parts = [];
    lines.forEach((c, i) => {
      const t = clampStr(c.str);
      if (!t || DUCT_RE.test(t) || SHEET_RE.test(t) || JUNK_NAME_RE.test(t)) return;
      // a bare number below the name is the room number, never part of the name
      if (!number && i > 0 && NUMBER_TOKEN_RE.test(t.replace(/[\s.]/g, ""))) {
        number = t.replace(/[\s.]/g, "");
        return;
      }
      const norm = t.toLowerCase().replace(/[^a-z0-9]/g, "");
      const joined = parts.join(" ").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (norm && joined && joined.includes(norm)) return;
      parts.push(t);
    });
    const name = clampStr(parts.join(" "));
    if (!name || !/[A-Za-z]{2}/.test(name)) continue;   // a lone number / dimension is not a room
    const top = lines[0];
    for (const c of lines) usedSet.add(c);
    rooms.push(makeRoom({
      name, number, areaUnknown: true, level: levelByPage.get(top.page) || "", source: "label", page: top.page,
      at: top.atPdf ? { x: +top.atPdf.x.toFixed(2), y: +top.atPdf.y.toFixed(2) } : undefined,
    }));
  }

  for (const [page, n] of [...orphan].sort((x, y) => x[0] - y[0]))
    warnings.push(`Page ${page}: ${n} area label${n > 1 ? "s" : ""} without a room name`);
  const nePages = [...new Set(notEnclosedItems.map((it) => it.page))].sort();
  for (const p of nePages)
    warnings.push(`Page ${p}: ${notEnclosedItems.filter((it) => it.page === p).length} "Not Enclosed" label(s) skipped (no area)`);
  return rooms;
}

// ---------------------------------------------------------------- assembly

function makeRoom({ name, number, area, length, width, level, source, page, at, areaUnknown }) {
  const a = num(area) || (num(length) && num(width) ? +(num(length) * num(width)).toFixed(2) : 0);
  const room = {
    id: "",
    name,
    level: level || "",
    // An unknown area is `null` (never a fabricated 0 that could read as measured): the app shows a
    // blank cell, js/calc.js treats it as "no area" and adds no load, and `areaUnknown` marks it.
    area: areaUnknown ? null : +a.toFixed(2),
    type: guessSpaceType(name),
    include: areaUnknown ? false : includeRoom(name, a, source),
    source,
    page,
  };
  if (areaUnknown) room.areaUnknown = true;
  if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) room.at = { x: at.x, y: at.y };
  if (number) room.number = String(number);
  if (num(length)) room.length = num(length);
  if (num(width)) room.width = num(width);
  return room;
}

function finalize(rooms, warnings) {
  // dedupe exact duplicates (same page + name + area). Two unknown-area rooms carry no area to tell
  // them apart, so the spot the sheet prints them at (at) is the key instead — the same name drawn
  // in two different places stays two rooms.
  const seen = new Set();
  const out = [];
  for (const r of rooms) {
    const where = r.area == null
      ? (r.at ? `@${r.at.x.toFixed(1)},${r.at.y.toFixed(1)}` : "")
      : r.area.toFixed(2);
    const key = `${r.page}|${r.name.toLowerCase()}|${where}`;
    if (seen.has(key)) {
      warnings.push(`Page ${r.page}: duplicate room label ignored ("${r.name}" ${r.area == null ? "(area unknown)" : r.area + " m\u00b2"})`);
      continue;
    }
    seen.add(key);
    out.push(r);
  }
  out.forEach((r, i) => { r.id = "r" + (i + 1); });
  return out;
}

/**
 * Pure text -> rooms. `items`: [{str, x, y, page, h, w}] in display coordinates (y down).
 */
export function parseText(items) {
  const warnings = [];
  const list = (items || [])
    .map((raw, k) => ({
      str: clampStr(raw && raw.str),
      x: num(raw && raw.x),
      y: num(raw && raw.y),
      page: num(raw && raw.page, 1) || 1,
      h: num(raw && raw.h) || 8,
      w: num(raw && raw.w),
      // carried through: the item's position in PDF user space (y up), used to place a room on the plan
      atPdf: raw && raw.atPdf && Number.isFinite(raw.atPdf.x) && Number.isFinite(raw.atPdf.y)
        ? { x: raw.atPdf.x, y: raw.atPdf.y } : null,
      _k: k,
    }))
    .filter((it) => it.str);
  if (!list.length) return { rooms: [], warnings: ["no text items"] };

  const levelByPage = detectLevels(list);
  const pages = [...new Set(list.map((i) => i.page))].sort((a, b) => a - b);

  const rooms = [];
  const labelItems = [];
  for (const page of pages) {
    const pageItems = list.filter((i) => i.page === page);
    const table = parseSchedule(pageItems, levelByPage, warnings);
    if (table && table.rooms.length >= 2) {
      rooms.push(...table.rooms);
      continue; // schedule wins over drawing tags on this page
    }
    labelItems.push(...pageItems);
  }

  const usedSet = new Set();
  rooms.push(...parseLabels(labelItems, levelByPage, warnings, usedSet));

  const finalized = finalize(rooms, warnings);
  // Say plainly how many rooms came from names alone with no printed area, and what to do about it.
  // Same warnings channel the rest of the parser uses, so the app surfaces it with no new plumbing.
  const unknownByPage = new Map();
  for (const r of finalized) if (r.areaUnknown) unknownByPage.set(r.page, (unknownByPage.get(r.page) || 0) + 1);
  for (const [page, n] of [...unknownByPage].sort((a, b) => a[0] - b[0]))
    warnings.push(
      `Page ${page}: no printed areas found - ${n} room name${n > 1 ? "s" : ""} detected. ` +
      `Their areas are unknown, so they are left out of the load; set each area by tracing the plan ` +
      `or typing it in the table, then tick its Include box.`
    );
  if (!finalized.length) warnings.push("no rooms found in this PDF");
  return { rooms: finalized, warnings };
}

/**
 * PDF -> rooms. `pdfjs` is the imported pdf.js module (never imported here).
 */
export async function parsePdf(arrayBuffer, { pdfjs, onProgress } = {}) {
  if (!pdfjs || typeof pdfjs.getDocument !== "function")
    throw new Error("parsePdf: pass the pdf.js module as { pdfjs }");
  if (!arrayBuffer) throw new Error("parsePdf: arrayBuffer is required");

  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  const total = doc.numPages;
  const items = [];
  const textParts = [];

  for (let p = 1; p <= total; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 }); // undo sheet rotation/offset
    const tc = await page.getTextContent();
    const lines = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const m = pdfjs.Util.transform(viewport.transform, it.transform);
      // Where this text sits in PDF USER SPACE (points, origin bottom-left, y UP) — the same
      // convention a drawn room's `rect` uses, so a room can later be placed where the plan names
      // it. pdf.js's own inverse transform does the work, so a /Rotate page needs no special case.
      let atPdf = null;
      try {
        const [px, py] = viewport.convertToPdfPoint(m[4], m[5]);
        if (Number.isFinite(px) && Number.isFinite(py)) atPdf = { x: px, y: py };
      } catch { atPdf = null; }
      items.push({
        str: it.str,
        x: m[4],
        y: m[5],                                  // y down, like reading the page
        h: Math.hypot(m[2], m[3]),                // font size after un-rotation
        w: Number.isFinite(it.width) ? it.width : 0,
        page: p,
        atPdf,
      });
      lines.push("[" + m[4].toFixed(1) + "," + m[5].toFixed(1) + "] " + it.str);
    }
    textParts.push(`----- page ${p} -----\n` + lines.join("\n"));
    if (typeof onProgress === "function") onProgress(p, total);
  }

  const { rooms, warnings } = parseText(items);
  return { rooms, pages: total, text: textParts.join("\n"), warnings };
}
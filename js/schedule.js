// Room-schedule import: .csv / .tsv / .xlsx  ->  Room objects (AGENTS.md contract).
// Spec: AGENTS-OCR-SCHEDULE.md "Contract 2 — js/schedule.js".
//
// Pure ES module: runs in the browser (plain import, no build step, no CDN) and in Node (tests).
// It imports NOTHING except ./calc.js and uses NO Node built-ins and NO browser-only API.
//
// .xlsx is read here directly — ZIP central directory + a small DEFLATE (RFC 1951) implementation
// + SpreadsheetML parsing — instead of vendoring the SheetJS UMD bundle. That keeps the contract's
// SYNCHRONOUS signature (no Promise, no await in app.js) and adds zero bytes of vendor code.
// See vendor/xlsx/README.md for why, and tests/test-schedule.mjs for the round-trip proof
// (it deflates fixture entries with node's zlib and checks this reader inflates them back).
//
// Forgiving about real Revit/Excel exports: title rows above the header, merged header cells,
// quoted fields, `,` / `;` / tab delimiters, CRLF, a BOM, blank rows, totals rows, repeated header
// rows, duplicate rows and a headerless 2-column (name, area) file.

import { ORIENTS, guessSpaceType, NON_AC_WORDS } from "./calc.js";

export const SCHEDULE_EXTENSIONS = [".csv", ".tsv", ".xlsx"];

export function isScheduleFile(name) {
  const n = String(name == null ? "" : name).toLowerCase().trim();
  return SCHEDULE_EXTENSIONS.some((ext) => n.endsWith(ext));
}

const M_PER_FT = 0.3048;
const M_PER_IN = 0.0254;
const M2_PER_FT2 = 0.092903; // spec: ft² -> m² ×0.092903
const MAX_ROWS = 20000;
const MAX_COLS = 256;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const stripBom = (s) => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

function decodeUtf8(u8) {
  if (typeof TextDecoder === "function") {
    try { return new TextDecoder("utf-8", { fatal: false }).decode(u8); } catch { /* fall through */ }
  }
  // tiny fallback: latin1 (only hit on ancient runtimes)
  let out = "";
  for (let i = 0; i < u8.length; i++) out += String.fromCharCode(u8[i]);
  return out;
}

function toBytes(data) {
  if (data == null) return null;
  if (typeof data === "string") {
    if (data.slice(0, 2) === "PK") { // a zip read as a latin1/binary string
      const u8 = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) u8[i] = data.charCodeAt(i) & 0xff;
      return u8;
    }
    return null;
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function toText(data) {
  if (typeof data === "string") return data;
  const u8 = toBytes(data);
  return u8 ? decodeUtf8(u8) : "";
}

const cellText = (v) => stripBom(String(v == null ? "" : v)).trim();

// "Area (m²)" -> "area m2"  (case, punctuation and unit punctuation insensitive)
function normHeader(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/²/g, "2").replace(/³/g, "3").replace(/\^2/g, "2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// "1,249.3" -> 1249.3 ; "1.249,3" -> 1249.3 ; "45,5" -> 45.5
function cleanNumber(s) {
  let t = String(s == null ? "" : s).replace(/\s+/g, "");
  if (!t) return NaN;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, ".");
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : NaN;
}

// first number inside free text: "12 nos" -> 12, "12 W/m2" -> 12
function firstNumber(s) {
  const m = String(s == null ? "" : s).replace(/(\d)[,\s](?=\d{3}\b)/g, "$1").match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

const r2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// DEFLATE (RFC 1951) — raw inflate, used by the ZIP reader for .xlsx
// ---------------------------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// canonical Huffman table (puff-style: code/length counts, then index)
function buildHuff(lengths) {
  const count = new Array(16).fill(0);
  for (const l of lengths) if (l) count[l]++;
  const offs = new Array(16).fill(0);
  for (let i = 1; i < 15; i++) offs[i + 1] = offs[i] + count[i];
  const symbol = new Array(lengths.length).fill(0);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}

export function inflateRaw(input) {
  let p = 0, bitbuf = 0, bitcnt = 0;
  let out = new Uint8Array(Math.max(input.length * 3, 1024));
  let olen = 0;

  const need = (n) => { if (olen + n > out.length) { let cap = out.length; while (cap < olen + n) cap *= 2; const n2 = new Uint8Array(cap); n2.set(out.subarray(0, olen)); out = n2; } };
  const bits = (n) => {
    while (bitcnt < n) { if (p >= input.length) throw new Error("deflate: out of input"); bitbuf |= input[p++] << bitcnt; bitcnt += 8; }
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n; bitcnt -= n;
    return v;
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const cnt = h.count[len];
      if (code - first < cnt) return h.symbol[index + (code - first)];
      index += cnt; first = (first + cnt) << 1; code <<= 1;
    }
    throw new Error("deflate: bad huffman code");
  };

  let fixedLit = null, fixedDist = null;
  for (;;) {
    const last = bits(1);
    const type = bits(2);
    if (type === 0) { // stored
      bitcnt = 0; bitbuf = 0; // discard to the byte boundary
      const len = input[p] | (input[p + 1] << 8);
      p += 4;
      need(len);
      out.set(input.subarray(p, p + len), olen);
      olen += len; p += len;
    } else if (type === 1 || type === 2) {
      let lit, dist;
      if (type === 1) {
        if (!fixedLit) {
          const l = new Array(288);
          for (let i = 0; i < 144; i++) l[i] = 8;
          for (let i = 144; i < 256; i++) l[i] = 9;
          for (let i = 256; i < 280; i++) l[i] = 7;
          for (let i = 280; i < 288; i++) l[i] = 8;
          fixedLit = buildHuff(l);
          fixedDist = buildHuff(new Array(30).fill(5));
        }
        lit = fixedLit; dist = fixedDist;
      } else {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const clen = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = bits(3);
        const ch = buildHuff(clen);
        const lens = [];
        while (lens.length < hlit + hdist) {
          const s = decode(ch);
          if (s < 16) lens.push(s);
          else if (s === 16) { const prev = lens[lens.length - 1]; let n = 3 + bits(2); while (n--) lens.push(prev); }
          else if (s === 17) { let n = 3 + bits(3); while (n--) lens.push(0); }
          else { let n = 11 + bits(7); while (n--) lens.push(0); }
        }
        lit = buildHuff(lens.slice(0, hlit));
        dist = buildHuff(lens.slice(hlit, hlit + hdist));
      }
      for (;;) {
        const s = decode(lit);
        if (s < 256) { need(1); out[olen++] = s; continue; }
        if (s === 256) break;
        const li = s - 257;
        if (li >= LEN_BASE.length) throw new Error("deflate: bad length code");
        const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const ds = decode(dist);
        if (ds >= DIST_BASE.length) throw new Error("deflate: bad distance code");
        const d = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
        if (d > olen) throw new Error("deflate: distance beyond output");
        need(len);
        for (let i = 0; i < len; i++, olen++) out[olen] = out[olen - d];
      }
    } else {
      throw new Error("deflate: bad block type");
    }
    if (last) break;
  }
  return out.subarray(0, olen);
}

// ---------------------------------------------------------------------------
// ZIP reader (a .xlsx is a zip)
// ---------------------------------------------------------------------------

function readZip(u8) {
  let eocd = -1;
  const min = Math.max(0, u8.length - 66000);
  for (let i = u8.length - 22; i >= min; i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (p === 0xffffffff) throw new Error("zip64 files are not supported");
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = decodeUtf8(u8.subarray(p + 46, p + 46 + nlen));
    files.set(name, { method, csize, usize, lho });
    p += 46 + nlen + elen + clen;
  }
  return {
    has: (n) => files.has(n),
    names: () => [...files.keys()],
    read(n) {
      const e = files.get(n);
      if (!e) return null;
      const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const nlen = d.getUint16(e.lho + 26, true);
      const elen = d.getUint16(e.lho + 28, true);
      const start = e.lho + 30 + nlen + elen;
      const comp = u8.subarray(start, start + e.csize);
      if (e.method === 0) return comp;
      if (e.method === 8) return inflateRaw(comp, e.usize);
      throw new Error(`unsupported zip compression method ${e.method} for ${n}`);
    },
  };
}

// ---------------------------------------------------------------------------
// SpreadsheetML (.xlsx)
// ---------------------------------------------------------------------------

const XML_ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function unescapeXml(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(XML_ENT, e) ? XML_ENT[e] : m;
  });
}

// all <t> runs inside an <si>/<is> element, concatenated
function textOfRuns(xml) {
  let out = "";
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += unescapeXml(m[1]);
  return out;
}

function parseSharedStrings(xml) {
  const out = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1] ? textOfRuns(m[1]) : "");
  return out;
}

const colIndex = (ref) => {
  let n = 0, seen = false;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) { n = n * 26 + (c - 64); seen = true; }
    else if (c >= 97 && c <= 122) { n = n * 26 + (c - 96); seen = true; }
    else break;
  }
  return seen ? n - 1 : -1;
};

// A worksheet -> { grid, rowNums } (grid[r][c] = cell text, rowNums[r] = real sheet row number)
function parseSheet(xml, shared) {
  const grid = [], rowNums = [];
  const rowRe = /<row(\s[^>]*)?(\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  while ((rm = rowRe.exec(xml)) && grid.length < MAX_ROWS) {
    const attrs = rm[1] || "";
    if (/hidden="(1|true)"/.test(attrs)) continue;
    const rnum = /r="(\d+)"/.exec(attrs);
    const body = rm[3] || "";
    const row = [];
    if (body) {
      const cRe = /<c(\s[^>]*)?(\/>|>([\s\S]*?)<\/c>)/g;
      let cm, auto = 0;
      while ((cm = cRe.exec(body))) {
        const cAttrs = cm[1] || "";
        const inner = cm[3] || "";
        const ref = /\br="([A-Za-z]+\d+)"/.exec(cAttrs);
        let idx = ref ? colIndex(ref[1]) : auto;
        if (idx < 0) idx = auto;
        auto = idx + 1;
        if (idx >= MAX_COLS) continue;
        const t = /\bt="([a-z]+)"/.exec(cAttrs);
        const type = t ? t[1] : "n";
        let val = "";
        if (type === "inlineStr") {
          const is = /<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/.exec(inner);
          val = is ? textOfRuns(is[1]) : "";
        } else {
          const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
          const raw = v ? unescapeXml(v[1]) : "";
          if (type === "s") {
            const k = parseInt(raw, 10);
            val = Number.isFinite(k) && shared[k] != null ? shared[k] : "";
          } else if (type === "b") {
            val = raw === "1" ? "1" : "0";
          } else if (type === "e") {
            val = ""; // error cell -> empty, the row parser then warns
          } else {
            val = raw;
          }
        }
        row[idx] = cellText(val);
      }
    }
    while (row.length && (row[row.length - 1] === undefined || row[row.length - 1] === "")) row.pop();
    if (row.length === 0) { rowNums.push(rnum ? +rnum[1] : grid.length + 1); grid.push([]); continue; }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = "";
    grid.push(row);
    rowNums.push(rnum ? +rnum[1] : grid.length);
  }
  return { grid, rowNums };
}

function readWorkbook(u8, sheetSel, warnings) {
  const zip = readZip(u8);
  if (!zip.has("xl/workbook.xml")) throw new Error("no xl/workbook.xml inside the xlsx (is this really .xlsx?)");
  const shared = zip.has("xl/sharedStrings.xml") ? parseSharedStrings(decodeUtf8(zip.read("xl/sharedStrings.xml"))) : [];

  // workbook.xml <sheet name= r:id= ...>
  const wb = decodeUtf8(zip.read("xl/workbook.xml"));
  const sheets = [];
  const sRe = /<sheet\b([^>]*)\/?>/g;
  let m;
  while ((m = sRe.exec(wb))) {
    const a = m[1];
    const name = (/\bname="([^"]*)"/.exec(a) || [, ""])[1];
    const rid = (/\br:id="([^"]*)"/.exec(a) || [, ""])[1];
    sheets.push({ name: unescapeXml(name), rid });
  }
  if (!sheets.length) throw new Error("the workbook has no sheets");

  // rels rId -> target
  const rels = new Map();
  if (zip.has("xl/_rels/workbook.xml.rels")) {
    const rx = decodeUtf8(zip.read("xl/_rels/workbook.xml.rels"));
    const re = /<Relationship\b([^>]*)\/?>/g;
    while ((m = re.exec(rx))) {
      const a = m[1];
      const id = (/\bId="([^"]*)"/.exec(a) || [, ""])[1];
      const target = (/\bTarget="([^"]*)"/.exec(a) || [, ""])[1];
      if (id && target) rels.set(id, unescapeXml(target));
    }
  }

  let idx = 0;
  if (typeof sheetSel === "string" && sheetSel.trim()) {
    const want = sheetSel.trim().toLowerCase();
    const found = sheets.findIndex((s) => s.name.toLowerCase() === want);
    if (found < 0) throw new Error(`no sheet named "${sheetSel}" (sheets: ${sheets.map((s) => s.name).join(", ")})`);
    idx = found;
  } else {
    idx = Math.max(0, Math.floor(Number(sheetSel) || 0));
    if (idx >= sheets.length) { warnings.push(`sheet ${idx} not found — used "${sheets[0].name}"`); idx = 0; }
  }
  const chosen = sheets[idx];

  let path = null;
  const target = rels.get(chosen.rid);
  if (target) path = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
  if (!path || !zip.has(path)) {
    // fall back to the conventional name, then to any worksheet
    const byOrder = `xl/worksheets/sheet${idx + 1}.xml`;
    if (zip.has(byOrder)) path = byOrder;
    else path = zip.names().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[idx] || null;
  }
  if (!path || !zip.has(path)) throw new Error(`worksheet "${chosen.name}" not found in the xlsx`);

  const { grid, rowNums } = parseSheet(decodeUtf8(zip.read(path)), shared);
  return { grid, rowNums, sheetName: chosen.name, sheets: sheets.map((s) => s.name) };
}

// ---------------------------------------------------------------------------
// delimited text (.csv / .tsv)
// ---------------------------------------------------------------------------

function pickDelimiter(text, ext) {
  if (ext === ".tsv") return "\t";
  const sample = text.slice(0, 8192).split(/\r?\n/).slice(0, 25);
  const count = (ch) => sample.reduce((a, l) => a + (l.split(ch).length - 1), 0);
  const tab = count("\t"), semi = count(";"), comma = count(",");
  if (tab > 0 && tab >= comma && tab >= semi) return "\t";
  if (ext === ".csv") return semi > comma ? ";" : ",";
  if (comma >= semi) return comma ? "," : (semi ? ";" : ",");
  return ";";
}

function parseDelimited(text, delim) {
  text = stripBom(String(text));
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field.trim() === "") { quoted = true; field = ""; }
    else if (c === delim) { row.push(cellText(field)); field = ""; }
    else if (c === "\n") { row.push(cellText(field)); rows.push(row); row = []; field = ""; }
    else if (c === "\r") {
      if (text[i + 1] !== "\n") { row.push(cellText(field)); rows.push(row); row = []; field = ""; } // lone CR = line end
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(cellText(field)); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// value parsing (units)
// ---------------------------------------------------------------------------

const AREA_UNITS = {
  m2: 1, sqm: 1, sqmtr: 1, mtr2: 1, squarem: 1, squaremetre: 1, squaremetres: 1, squaremeter: 1, squaremeters: 1,
  mm2: 1e-6, sqmm: 1e-6,
  cm2: 1e-4, sqcm: 1e-4,
  ft2: M2_PER_FT2, sqft: M2_PER_FT2, sf: M2_PER_FT2, squarefoot: M2_PER_FT2, squarefeet: M2_PER_FT2,
  in2: 0.00064516, sqin: 0.00064516,
  yd2: 0.83612736, sqyd: 0.83612736, sqyard: 0.83612736, sqyards: 0.83612736,
  ha: 10000, hectare: 10000, hectares: 10000,
  acre: 4046.8564224, acres: 4046.8564224, ac: 4046.8564224,
};

// -> m² per unit ; null when the unit text is not recognised
function areaUnitFactor(u) {
  const k = String(u == null ? "" : u).toLowerCase().replace(/²/g, "2").replace(/\^2/g, "2").replace(/[.\s]/g, "");
  if (!k) return null;
  return Object.prototype.hasOwnProperty.call(AREA_UNITS, k) ? AREA_UNITS[k] : null;
}

// factor hinted by the column header, e.g. "Area (ft²)" -> 0.092903 ; "Area (mm²)" -> 1e-6
export function unitFactorFromHeader(header) {
  const h = normHeader(header);
  if (!h) return 1;
  if (/\bmm2\b/.test(h)) return 1e-6;
  if (/\bcm2\b/.test(h)) return 1e-4;
  if (/\b(ft2|sqft|sf|sq ft)\b/.test(h)) return M2_PER_FT2;
  if (/\b(m2|sqm|sq m)\b/.test(h)) return 1;
  return 1;
}

function lengthHeaderFactor(header) {
  const h = normHeader(header);
  if (/\bmm\b/.test(h)) return 0.001;
  if (/\bcm\b/.test(h)) return 0.01;
  if (/\b(ft|feet|foot)\b/.test(h)) return M_PER_FT;
  if (/\b(in|inch|inches)\b/.test(h)) return M_PER_IN;
  return 1;
}

// -> { value: metres|null, unit: string|null (unrecognised unit text) }
export function parseLengthValue(raw, headerFactor = 1) {
  const s = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  if (!s) return { value: null, unit: null };
  // 12'-6" , 12' 6" , 12'6" , 12 ft 6 in
  let m = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:'|′|ft|feet|foot)\s*(?:-|\s)?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|″|in|inch|inches)?)?$/i);
  if (m) return { value: (+m[1]) * M_PER_FT + (m[2] ? (+m[2]) * M_PER_IN : 0), unit: "ft-in" };
  m = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:"|″|in|inch|inches)$/i);
  if (m) return { value: (+m[1]) * M_PER_IN, unit: "in" };
  m = s.match(/^(-?[\d.,\s]+?)\s*([a-zA-Zµ²"']+)?$/);
  if (!m) {
    const v = firstNumber(s);
    return Number.isFinite(v) ? { value: v, unit: null } : { value: null, unit: null };
  }
  const n = cleanNumber(m[1]);
  if (!Number.isFinite(n)) return { value: null, unit: null };
  const u = String(m[2] || "").toLowerCase().replace(/²/g, "2").replace(/[.\s]/g, "");
  if (!u) return { value: n > 100 ? n / 1000 : n * headerFactor, unit: null }; // >100 mm -> m
  if (/^(mm|millimetre|millimetres|millimeter|millimeters)$/.test(u)) return { value: n / 1000, unit: null };
  if (/^(cm|centimetre|centimetres|centimeter|centimeters)$/.test(u)) return { value: n / 100, unit: null };
  if (/^(m|mtr|mtrs|meter|meters|metre|metres)$/.test(u)) return { value: n, unit: null };
  if (/^(ft|feet|foot)$/.test(u)) return { value: n * M_PER_FT, unit: null };
  if (/^(in|inch|inches)$/.test(u)) return { value: n * M_PER_IN, unit: null };
  return { value: n, unit: String(m[2]).trim() };
}

// -> { value: m²|null, unit: string|null, dims: [l,w]|null, looksLikeLength: boolean }
export function parseAreaValue(raw, headerFactor = 1) {
  const out = { value: null, unit: null, dims: null, looksLikeLength: false, text: String(raw == null ? "" : raw).trim() };
  const s = out.text.replace(/\s+/g, " ");
  if (!s) return out;

  // 6.0 x 4.5   |   4500x3600   |   12'-6" x 10'
  const dm = s.match(/^(.*?)\s*[x×*]\s*(.+)$/i);
  if (dm && /\d/.test(dm[1]) && /\d/.test(dm[2])) {
    const a = parseLengthValue(dm[1]);
    const b = parseLengthValue(dm[2]);
    if (a.value && b.value) {
      if (a.unit) out.unit = a.unit;
      if (b.unit) out.unit = b.unit;
      out.dims = [r2(a.value), r2(b.value)];
      out.value = r2(a.value * b.value);
      return out;
    }
  }

  // a bare feet-inch value in an area column is a length, not an area
  if (/['′"″]/.test(s) && !/\d\s*[x×*]/.test(s)) {
    if (/^\d+(?:\.\d+)?\s*(?:'|′).*$/.test(s)) { out.looksLikeLength = true; return out; }
  }

  const m = s.match(/^(-?[\d][\d.,\s]*?)\s*([a-zA-Zµ²³"']+)?$/);
  if (!m) {
    const v = cleanNumber(s);
    if (Number.isFinite(v)) { out.value = r2(v * headerFactor); return out; }
    return out;
  }
  const n = cleanNumber(m[1]);
  if (!Number.isFinite(n)) return out;
  const unitText = m[2] ? m[2].trim() : "";
  if (!unitText) {
    out.value = r2(n * headerFactor);
    return out;
  }
  const f = areaUnitFactor(unitText);
  if (f == null) {
    out.unit = unitText;                       // unknown unit -> warn, keep the bare number
    out.value = r2(n * headerFactor);
    return out;
  }
  out.value = r2(n * f);
  out.unit = null;
  return out;
}

function parsePeople(raw) {
  const s = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/^\d+\s*(nos?|no\.?|pax|pers(on)?s?)$/i.test(s)) return parseInt(s, 10);
  const n = cleanNumber(s);
  if (Number.isFinite(n)) return Math.round(n);
  const v = firstNumber(s);
  return Number.isFinite(v) ? Math.round(v) : null;
}

function parseDensity(raw) {
  const s = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  if (!s) return null;
  const n = cleanNumber(s);
  if (Number.isFinite(n)) return n;
  const v = firstNumber(s);
  return Number.isFinite(v) ? v : null;
}

function parseBool(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!s) return null;
  if (/^(y|yes|true|1|x|✓|✔|roof|top|exposed|是)$/.test(s)) return true;
  if (/^(n|no|false|0|-|–|none|nil|否)$/.test(s)) return false;
  return null;
}

function parseOrient(raw) {
  const s = String(raw == null ? "" : raw).trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return null;
  const map = {
    N: "N", NORTH: "N", NE: "NE", NORTHEAST: "NE", E: "E", EAST: "E", SE: "SE", SOUTHEAST: "SE",
    S: "S", SOUTH: "S", SW: "SW", SOUTHWEST: "SW", W: "W", WEST: "W", NW: "NW", NORTHWEST: "NW",
  };
  return map[s] || null;
}

const LEVEL_RE = /(ground|flr|floor|storey|story|level|lvl|base|cellar|mezz|terr|roof|zone|block|wing|tower|gf|ff|sf|tf|\d)/i;

// ---------------------------------------------------------------------------
// column detection
// ---------------------------------------------------------------------------

const EXACT = {
  number: ["number", "no", "num", "room no", "room number", "room num", "space no", "space number", "tag", "room tag", "ref", "reference", "room ref", "id", "code", "room id", "room code", "rno", "room no "],
  name: ["name", "room", "space", "room name", "space name", "area name", "room description", "space description", "description", "room no name", "room no + name", "room na", "title", "room title"],
  level: ["level", "floor", "storey", "story", "lvl", "level name", "floor name", "floor level", "zone", "block", "wing"],
  area: ["area", "area m2", "area m 2", "net area", "room area", "space area", "floor area", "gross area", "carpet area", "area sqm", "area sq m", "area sqmtr", "area ft2", "area sqft", "area sq ft", "area sf", "area mm2", "room area m2", "area m2 gross"],
  length: ["length", "length m", "length mm", "len", "depth", "l", "length m2"],
  width: ["width", "width m", "width mm", "wid", "breadth", "b", "w", "depth width"],
  height: ["height", "height m", "height mm", "ceiling", "ceiling height", "soffit", "clear height", "floor to ceiling height", "ht", "clear ceiling height"],
  type: ["type", "space type", "room type", "usage", "use", "function", "activity", "department", "dept", "room function", "room use"],
  people: ["people", "occupancy", "occupants", "person", "persons", "pax", "no of persons", "no of people", "number of persons", "number of people", "occupant load", "capacity", "seats", "no of occupants"],
  orient: ["orient", "orientation", "facing", "exposure", "direction", "facade", "façade", "side", "glazing orientation"],
  glass: ["glass", "glazing", "window", "windows", "window area", "glazing area", "glass area", "glass m2", "window m2", "glazed area", "glass wallpaper no"],
  roof: ["roof", "exposed roof", "top floor", "roof exposed", "is roof", "roof y n", "roof yes no", "topmost floor"],
  light: ["lighting", "lighting w m2", "light", "light w m2", "lighting load", "lpd", "lighting density", "lighting power density", "lighting w sqm"],
  equip: ["equipment", "equipment w m2", "equip", "plug", "plug load", "power density", "equipment load", "equipment density", "appliance", "appliances", "equipment w sqm"],
};

const KEY_ORDER = ["number", "name", "level", "area", "length", "width", "height", "type", "people", "orient", "glass", "roof", "light", "equip"];

export function detectColumnKey(header) {
  const h = normHeader(header);
  if (!h) return null;
  for (const key of KEY_ORDER) {
    if (EXACT[key].includes(h)) return key;
  }
  // fallbacks on the normalised header
  if (/^(rm|room|space|area|unit|flat)? ?(no|num|number|id|code|tag|ref)$/.test(h)) return "number";
  if (/^(no|num|tag|ref)\b/.test(h)) return "number";
  if (/\bname\b|\bdescriptions?\b|^room$|^space$|^rooms$|^spaces$/.test(h)) return "name";
  if (/\b(glass|glazing|windows?)\b/.test(h)) return "glass";
  if (/\broof\b|^top floor$|exposed roof/.test(h)) return "roof";
  if (/\bceiling\b|soffit|clear height|\bheight\b|^ht$/.test(h)) return "height";
  if (/\blighting\b|^light\b|\blight\b|\blpd\b|lighting density/.test(h)) return "light";
  if (/equip|plug|power density|appliance/.test(h)) return "equip";
  if (/people|occupan|person|pax|capacity|seats|occupant load/.test(h)) return "people";
  if (/orient|facing|exposure|facade|direction/.test(h)) return "orient";
  if (/\barea\b|sqm|sq ft|sqft|ft2|\bm2\b|^sf$|^sqm$/.test(h)) return "area";
  if (/level|storey|story|zone|block|wing|floor/.test(h)) return "level";
  if (/length|depth|^len$|^l$/.test(h)) return "length";
  if (/width|breadth|^wid$|^w$|^b$/.test(h)) return "width";
  if (/type|usage|^use$|function|activity|department|dept/.test(h)) return "type";
  return null;
}

// how many distinct known columns a row looks like (a repeated header row looks like >= 2)
const knownKeysIn = (cells) => {
  const keys = new Set();
  for (const c of cells) {
    if (!c) continue;
    if (/^-?[\d.,\s]+$/.test(c)) continue; // a bare number is data, never a header
    const k = detectColumnKey(c);
    if (k) keys.add(k);
  }
  return keys;
};

const TOTALS_RE = /^(grand )?(total|totals|sub ?total|sum|overall total|合计|总计)\b/i;
const UNITROW_RE = /^(m|mm|cm|ft|feet|ft2|ft²|sqm|sq m|sqft|sq ft|sf|m2|m²|mm2|inch|in|nos?|no\.?|w\/m2|w\/m²|w\/sq ?m|deg|°)$/i;

// ---------------------------------------------------------------------------
// grid -> rooms
// ---------------------------------------------------------------------------

function gridToRooms(grid, rowNums, warnings, { sheetName = "", headerlessHint = true } = {}) {
  const empty = { rooms: [], columns: {}, headers: [], columnHeaders: {}, headerRow: 0, rowCount: 0 };

  // 1) find the header row: first row that matches >= 2 known headers (title rows above are skipped)
  let headerIdx = -1, columns = {}, headers = [];
  const scan = Math.min(grid.length, 25);
  for (let i = 0; i < scan; i++) {
    const row = grid[i];
    if (!row || !row.length) continue;
    const keys = knownKeysIn(row);
    if (keys.size < 2) continue;
    const found = {};
    row.forEach((c, ci) => {
      const key = detectColumnKey(c);
      if (key && found[key] === undefined) found[key] = ci;
    });
    headerIdx = i; columns = found; headers = row.slice();
    break;
  }

  let firstData = 0;
  if (headerIdx < 0) {
    // 2) headerless 2-column file: name, area
    if (!headerlessHint) { warnings.push("No header row found (no room name / area columns)."); return empty; }
    let looks = false;
    for (let i = 0; i < Math.min(grid.length, 5); i++) {
      const row = grid[i] || [];
      if (row.length >= 2 && row[0] && !Number.isFinite(cleanNumber(row[0])) && parseAreaValue(row[1]).value != null) { looks = true; break; }
    }
    if (!looks) {
      warnings.push("No header row found — no room name / area columns in this file. Nothing imported.");
      return empty;
    }
    columns = { name: 0, area: 1 };
    headerIdx = -1;
    firstData = 0;
    warnings.push("No header row found — reading column 1 as the room name and column 2 as the area (m²).");
  } else {
    firstData = headerIdx + 1;
    // skip a units row directly under the header ("m²", "mm", "nos", ...)
    const next = grid[firstData] || [];
    if (next.length && next.filter((c) => c).length >= 2 && next.every((c) => !c || UNITROW_RE.test(c))) {
      headers = next.map((c, i) => (headers[i] ? `${headers[i]} ${c}` : c));
      firstData++;
    }
  }

  const headerRow = headerIdx < 0 ? 0 : (rowNums[headerIdx] || headerIdx + 1);
  const columnHeaders = {};
  for (const [k, c] of Object.entries(columns)) columnHeaders[k] = headers[c] || "";

  const nameCol = columns.name !== undefined ? columns.name : columns.number;
  if (nameCol === undefined) {
    warnings.push("No room-name column found in the header row (looked for room / space / name / description).");
    return { ...empty, columns, headers, columnHeaders, headerRow };
  }

  const headerFactor = { area: 1, length: 1, width: 1, height: 1 };
  if (columns.area !== undefined) headerFactor.area = unitFactorFromHeader(headers[columns.area] || "");
  for (const k of ["length", "width", "height"]) {
    if (columns[k] !== undefined) headerFactor[k] = lengthHeaderFactor(headers[columns[k]] || "");
  }

  const rooms = [];
  const seen = new Map();
  let rowCount = 0;
  const cell = (row, key) => (columns[key] === undefined ? "" : cellText(row[columns[key]]));
  const warnUnit = (i, what, unit) =>
    warnings.push(`Row ${rowNums[i] || i + 1}: unknown unit "${unit}" in the ${what} column — read as written.`);
  const lengthOf = (i, key) => {
    if (columns[key] === undefined) return null;
    const v = parseLengthValue(cell(grid[i], key), headerFactor[key]);
    if (v.unit) warnUnit(i, key, v.unit);
    return v.value;
  };

  for (let i = firstData; i < grid.length && i < firstData + MAX_ROWS; i++) {
    const row = grid[i] || [];
    if (!row.some((c) => c)) continue;                                  // blank row
    const n = rowNums[i] || i + 1;
    const name = cell(row, "name") || (columns.name === undefined ? cell(row, "number") : "");
    if (knownKeysIn(row).size >= 2) { warnings.push(`Row ${n}: repeated header row skipped.`); continue; }
    if (TOTALS_RE.test(row[0] || "")) { warnings.push(`Row ${n}: totals row "${row[0]}" skipped.`); continue; }
    if (!name) { warnings.push(`Row ${n}: no room name — row skipped.`); continue; }
    if (TOTALS_RE.test(name)) { warnings.push(`Row ${n}: totals row "${name}" skipped.`); continue; }
    rowCount++;

    const number = cell(row, "number") || undefined;
    let level = cell(row, "level");
    if (level && !LEVEL_RE.test(level)) warnings.push(`Row ${n}: unknown level "${level}" — kept as written.`);
    level = level || undefined;

    let length = lengthOf(i, "length");
    let width = lengthOf(i, "width");
    // a combined "6.0 x 4.5" cell can land in either the length or the width column
    if (columns.length !== undefined && /[x×*]/i.test(cell(row, "length"))) {
      const d = parseAreaValue(cell(row, "length")).dims;
      if (d) [length, width] = d;
    } else if (columns.width !== undefined && /[x×*]/i.test(cell(row, "width"))) {
      const d = parseAreaValue(cell(row, "width")).dims;
      if (d) [length, width] = d;
    }

    let height = null;
    if (columns.height !== undefined) {
      const hv = parseLengthValue(cell(row, "height"), headerFactor.height);
      if (hv.unit) warnUnit(i, "height", hv.unit);
      height = hv.value;
    }

    // area
    let area = null;
    if (columns.area !== undefined) {
      const av = parseAreaValue(cell(row, "area"), headerFactor.area);
      if (av.unit) warnUnit(i, "area", av.unit);
      if (av.looksLikeLength) warnings.push(`Row ${n}: the area cell "${av.text}" looks like a length, not an area.`);
      area = av.value;
    }
    if (area == null && length && width) area = r2(length * width);
    if (area == null || !(area > 0)) {
      warnings.push(`Row ${n}: no area for "${name}" — row skipped.`);
      continue;
    }

    const dupKey = [name, number || "", level || "", area].join("|").toLowerCase().replace(/\s+/g, " ");
    if (seen.has(dupKey)) {
      warnings.push(`Row ${n}: duplicate of row ${seen.get(dupKey)} ("${name}", ${area} m²) — dropped.`);
      continue;
    }
    seen.set(dupKey, n);

    const glassRaw = cell(row, "glass");
    let glass = null;
    if (glassRaw) {
      const g = parseAreaValue(glassRaw);
      if (g.unit) warnUnit(i, "glass", g.unit);
      glass = g.value;
      if (glass == null) warnings.push(`Row ${n}: could not read the glass/window area "${glassRaw}".`);
    }

    const roofRaw = cell(row, "roof");
    const roof = roofRaw ? parseBool(roofRaw) : null;

    const orientRaw = cell(row, "orient");
    const orient = orientRaw ? parseOrient(orientRaw) : null;
    if (orientRaw && !orient) warnings.push(`Row ${n}: unknown orientation "${orientRaw}" — using the default.`);

    const people = columns.people !== undefined ? parsePeople(cell(row, "people")) : null;
    const light = columns.light !== undefined ? parseDensity(cell(row, "light")) : null;
    const equip = columns.equip !== undefined ? parseDensity(cell(row, "equip")) : null;

    // type: the schedule's own type/usage column wins; otherwise guess from the name
    const typeText = cell(row, "type");
    let type = "general";
    if (typeText) {
      const fromType = guessSpaceType(typeText);
      type = fromType !== "general" ? fromType : guessSpaceType(name);
    } else {
      type = guessSpaceType(name);
    }

    const room = {
      id: `s${rooms.length + 1}`,
      name,
      number,
      level,
      area,
      length: length || undefined,
      width: width || undefined,
      height: height || undefined,
      type,
      orient: orient || undefined,
      glass: glass == null ? undefined : glass,
      roof: columns.roof === undefined ? undefined : (roof == null ? false : roof),
      people: people == null ? undefined : people,
      light: light == null ? undefined : light,
      equip: equip == null ? undefined : equip,
      include: !NON_AC_WORDS.test(name),
      source: "schedule",
      row: n,
    };
    if (typeText) room.spaceType = typeText; // what the schedule said, for the UI
    rooms.push(room);
  }

  if (rooms.length) {
    warnings.push(`${rooms.length} room${rooms.length === 1 ? "" : "s"} imported from ${sheetName ? `sheet "${sheetName}"` : "the schedule"} (${rowCount} data row${rowCount === 1 ? "" : "s"} read).`);
  } else {
    warnings.push("No rooms imported — no row had both a room name and an area.");
  }
  return { rooms, warnings, columns, headers, columnHeaders, headerRow, rowCount };
}

// ---------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------

export function parseSchedule(fileData, { filename = "", sheet = 0 } = {}) {
  const own = [];
  const name = String(filename || "").toLowerCase();
  const ext = SCHEDULE_EXTENSIONS.find((e) => name.endsWith(e)) || "";
  const bytes = toBytes(fileData);

  let grid = [], rowNums = [], sheetName = "";
  try {
    if (ext === ".xlsx" || (!ext && bytes && bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      if (!bytes) {
        own.push("This looks like an Excel file but no binary data was given — nothing imported.");
        grid = [];
      } else {
        const wb = readWorkbook(bytes, sheet, own);
        grid = wb.grid; rowNums = wb.rowNums; sheetName = wb.sheetName;
      }
    } else {
      const text = toText(fileData);
      if (!text || !text.trim()) {
        own.push("The file is empty — nothing imported.");
      } else if (/^PK\x03\x04/.test(text) || /\x00/.test(text.slice(0, 2000))) {
        own.push("This file looks binary (probable .xlsx renamed) — open it with its .xlsx name so it is read as a workbook.");
        grid = [];
      } else {
        grid = parseDelimited(text, pickDelimiter(text, ext));
        rowNums = grid.map((_, i) => i + 1);
      }
    }

    if (grid.length && !sheetName) {
      // a lone-column file (no delimiter at all)
      const cols = Math.max(...grid.map((r) => r.length));
      if (cols < 2) own.push("Only one column found — a room schedule needs at least a name and an area column.");
    }

    const res = gridToRooms(grid, rowNums, own, { sheetName });
    return {
      rooms: res.rooms,
      warnings: own,
      columns: res.columns,
      headers: res.headers,
      columnHeaders: res.columnHeaders,
      headerRow: res.headerRow,
      rowCount: res.rowCount,
      sheetName,
    };
  } catch (err) {
    own.push(`Could not read the schedule: ${(err && err.message) || err}`);
    return { rooms: [], warnings: own, columns: {}, headers: [], columnHeaders: {}, headerRow: 0, rowCount: 0, sheetName };
  }
}

export default { SCHEDULE_EXTENSIONS, isScheduleFile, parseSchedule };

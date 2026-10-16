// LoadLens — printable report HTML + CSV export.
// Pure string builders: no DOM access at import time, no DOM access when called.
// Both exports take (project, calcResult) where calcResult = calcProject(rooms, project).

import { SPACE_TYPES } from './calc.js';
import {
  normSystem, systemLabel, conversionNote,
  area, areaUnit, air, airUnit, power, powerUnit,
  density, densityUnit, length, lengthUnit, temp, tempUnit,
  tempDelta, tempDeltaUnit, uValue, uValueUnit,
  areaPerTr, areaPerTrUnit, header,
} from './units.js';

/* ---------------- small helpers ---------------- */

import { BASIS_FIELDS, savedBasis, basisGaps, basisStats, basisLine, basisStatements } from './basis.js';
import { reconcileAreas, reconcileLine } from './reconcile.js';

export function fmt(n, d = 0) {
  const v = parseFloat(n);
  if (!Number.isFinite(v)) return '-';
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function typeLabel(key) {
  const st = SPACE_TYPES[key];
  return st ? st.label : (key || 'General');
}

// Group calc results by level -> { level, rooms, tr, ls, oaLs, cfm, area, areaSqft }
// Only included rooms are counted (same rule as calc.js totals).
export function groupByLevel(results) {
  const map = new Map();
  for (const r of results) {
    if (!r.room.include) continue;
    const level = (r.room.level || '').trim() || 'Unspecified';
    if (!map.has(level)) map.set(level, { level, rooms: 0, tr: 0, ls: 0, oaLs: 0, cfm: 0, oaCfm: 0, area: 0, areaSqft: 0, supplyOk: true });
    const g = map.get(level);
    g.rooms += 1;
    g.tr += r.tr;
    g.ls += r.supplyLs;
    if (r.supplyOk === false) g.supplyOk = false;   // a zero supply ΔT makes the flow incalculable
    g.oaLs += r.oaLs;
    g.cfm += r.cfm;
    g.oaCfm += r.oaCfm;
    g.area += parseFloat(r.room.area) || 0;
    g.areaSqft += (parseFloat(r.room.area) || 0) * 10.7639;
  }
  const list = [...map.values()];
  list.sort((a, b) => a.level.localeCompare(b.level, undefined, { numeric: true }));
  return list;
}

// Heat-gain components of one result, in W. Used by the screen detail panel and the report.
export function breakdown(r) {
  const s = r.sensible || {};
  const l = r.latent || {};
  const roomSens = ['glassSolar', 'glassCond', 'wall', 'roof', 'partition', 'people', 'lighting', 'equipment', 'infiltration']
    .reduce((a, k) => a + (s[k] || 0), 0);
  const roomLat = (l.people || 0) + (l.infiltration || 0);
  const safeSens = r.rsh - roomSens;
  const safeLat = r.rlh - roomLat;
  return [
    { key: 'glassSolar', label: 'Glass — solar', group: 'Sensible', w: s.glassSolar || 0 },
    { key: 'glassCond', label: 'Glass — conduction', group: 'Sensible', w: s.glassCond || 0 },
    { key: 'wall', label: 'External wall', group: 'Sensible', w: s.wall || 0 },
    { key: 'roof', label: 'Roof', group: 'Sensible', w: s.roof || 0 },
    { key: 'partition', label: 'Partition to non-AC space', group: 'Sensible', w: s.partition || 0 },
    { key: 'people', label: 'People — sensible', group: 'Sensible', w: s.people || 0 },
    { key: 'lighting', label: 'Lighting', group: 'Sensible', w: s.lighting || 0 },
    { key: 'equipment', label: 'Equipment / power', group: 'Sensible', w: s.equipment || 0 },
    { key: 'infiltration', label: 'Infiltration — sensible', group: 'Sensible', w: s.infiltration || 0 },
    { key: 'latPeople', label: 'People — latent', group: 'Latent', w: l.people || 0 },
    { key: 'latInfil', label: 'Infiltration — latent', group: 'Latent', w: l.infiltration || 0 },
    { key: 'safeSens', label: `Safety factor (sensible)`, group: 'Safety', w: safeSens },
    { key: 'safeLat', label: `Safety factor (latent)`, group: 'Safety', w: safeLat },
    { key: 'oaSens', label: 'Outdoor / fresh air — sensible', group: 'Fresh air', w: r.oaSens || 0 },
    { key: 'oaLat', label: 'Outdoor / fresh air — latent', group: 'Fresh air', w: r.oaLat || 0 },
  ];
}

/* ---------------- CSV ---------------- */

function csvCell(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Plain-text units for the CSV: the screen and the report can afford the typographic '²' and '·',
// but a spreadsheet column heading reads better in ASCII ('ft2', 'BTU/h.ft2', 'm2/TR').
const csvUnit = (u) => String(u).replace(/²/g, '2').replace(/·/g, '.');

// A project setting printed in the chosen system: blank input stays blank, and a value that is not a
// number prints as nothing rather than "NaN".
const conv = (v, f, d) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '';
  return Number(f(n)).toFixed(d);
};

export function toCsv(project, calcResult) {
  const p = project || {};
  const res = calcResult && calcResult.results ? calcResult.results : [];
  const sys = normSystem(p.units);            // a project saved before this feature reads as 'si'
  const uArea = csvUnit(areaUnit(sys));
  const uLen = csvUnit(lengthUnit(sys));
  const uPow = csvUnit(powerUnit(sys));
  const uAir = csvUnit(airUnit(sys));
  const uDen = csvUnit(densityUnit(sys));
  const uApt = csvUnit(areaPerTrUnit(sys));
  const dU = csvUnit(tempUnit(sys));
  const eU = csvUnit(tempDeltaUnit(sys));
  const kU = csvUnit(uValueUnit(sys));
  // One column per fact and ONE unit per column: the export never carries m² beside ft² (or W beside
  // BTU/h) in the same sheet. The TR column stays at index 19 and supply air at index 20 — the saved
  // browser suite reads those positions.
  const head = [
    'Include', 'Level', 'No.', 'Name', 'Space type',
    `Area ${uArea}`, `Height ${uLen}`, 'People', `Light ${uDen}`, `Equip ${uDen}`,
    'Orientation', `Ext wall ${uArea}`, `Glass ${uArea}`, 'Roof', `Partition ${uArea}`,
    `Sensible ${uPow}`, `Latent ${uPow}`, `Total ${uPow}`, `Safety ${uPow}`,
    'TR', `Supply air ${uAir}`, `Fresh air ${uAir}`, `Area per TR ${uApt}`, 'SHF',
  ];
  const rows = [head];
  for (const r of res) {
    const room = r.room;
    const a = parseFloat(room.area) || 0;
    rows.push([
      room.include ? 'yes' : 'no',
      room.level || '',
      room.number || '',
      room.name || '',
      typeLabel(room.type),
      a ? area(a, sys).toFixed(2) : '',
      room.height ? length(room.height, sys).toFixed(1) : '',
      room.people,
      conv(room.light, (n) => density(n, sys), 2),
      conv(room.equip, (n) => density(n, sys), 2),
      room.orient || '',
      conv(room.extWall, (n) => area(n, sys), 2),
      conv(room.glass, (n) => area(n, sys), 2),
      room.roof ? 'yes' : 'no', conv(room.partition, (n) => area(n, sys), 2),
      power(r.rsh, sys).toFixed(0), power(r.rlh, sys).toFixed(0),
      power(r.totalW, sys).toFixed(0), power(r.safetyW, sys).toFixed(0),
      r.tr.toFixed(2),
      (r.supplyOk === false ? '-' : air(r.supplyLs, sys).toFixed(0)),
      air(r.oaLs, sys).toFixed(0),
      areaPerTr(r.m2PerTr, sys).toFixed(0),
      r.shf.toFixed(3),
    ]);
  }
  // project header lines (prefixed so they do not look like room rows). The unit basis is stated in
  // words here too, so a spreadsheet opened on its own still says which system and what it came from.
  const meta = [
    ['# LoadLens cooling load export'],
    ['# Project', p.name || ''],
    ['# Country', p.country || ''],
    ['# City', p.city || ''],
    ['# Unit system', systemLabel(sys)],
    ['# Units basis', conversionNote(sys)],
    [`# Outdoor dry bulb (${dU})`, conv(p.outDb, (n) => temp(n, sys), 1)],
    [`# Outdoor wet bulb (${dU})`, conv(p.outWb, (n) => temp(n, sys), 1)],
    [`# Indoor dry bulb (${dU})`, conv(p.inDb, (n) => temp(n, sys), 1)],
    ['# Indoor RH (%)', p.inRh],
    [`# U wall (${kU})`, conv(p.uWall, (n) => uValue(n, sys), 3)],
    [`# U glass (${kU})`, conv(p.uGlass, (n) => uValue(n, sys), 3)],
    ['# SC', p.sc],
    [`# U roof (${kU})`, conv(p.uRoof, (n) => uValue(n, sys), 3)],
    [`# Roof ETD (${eU})`, conv(p.roofEtd, (n) => tempDelta(n, sys), 1)],
    [`# U partition (${kU})`, conv(p.uPart, (n) => uValue(n, sys), 3)],
    ['# Infiltration ACH', p.infilAch], ['# Safety (%)', p.safety],
    [`# Supply air dT (${eU})`, conv(p.supplyDt, (n) => tempDelta(n, sys), 1)],
    ['# Glazing (% of wall)', p.wwr],
    [],
  ];
  // One trailing comment line carries the tool's own address. The '#' prefix matches the header
  // block, and the wording deliberately carries no comma, so the line stays a genuine unquoted '#'
  // comment — a parser that reads the data rows (they start with 'yes,' / 'no,') is untouched, and a
  // human opening the file in Excel sees it clearly as a note. See docs/USER-GUIDE.md.
  const credit = [['# Calculated with LoadLens - loadlens.net - free and runs in your browser. Your drawing is never sent to a third party; on loadlens.net it is posted to this site\'s own server so it can be read faster. It is not stored and nothing from it is logged.']];
  const body = meta.concat(rows, credit).map((r) => r.map(csvCell).join(',')).join('\r\n');
  return '\ufeff' + body + '\r\n';
}

/* ---------------- printable report ---------------- */

function kvRows(pairs) {
  return pairs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
}

const REPORT_CSS = `
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
         font-size: 13px; color: #1b2430; margin: 24px; background: #fff; }
  h1 { font-size: 21px; margin: 0 0 2px; }
  h2 { font-size: 15px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #1b5e9c; color: #14456f; }
  h3 { font-size: 13px; margin: 14px 0 6px; }
  .sub { color: #5b6774; margin: 0 0 4px; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 6px; }
  th, td { border: 1px solid #c8d2dc; padding: 4px 6px; text-align: right; vertical-align: top; }
  th { background: #eef3f8; font-weight: 600; text-align: center; }
  td.t, th.t, td.l, th.l { text-align: left; }
  .kv th { width: 34%; text-align: left; background: #f6f9fc; }
  .kv td { text-align: left; }
  .kv { width: 100%; }
  .cols { display: flex; gap: 18px; align-items: flex-start; }
  .cols > div { flex: 1; }
  tfoot td, tr.total td { font-weight: 700; background: #eef3f8; }
  .grand td { font-weight: 700; background: #dce9f6; font-size: 14px; }
  .notes { margin-top: 18px; padding: 10px 12px; border: 1px solid #d8b25a; background: #fdf7e6; }
  .notes ul { margin: 6px 0 0 18px; padding: 0; }
  .notes li { margin-bottom: 4px; }
  .muted { color: #5b6774; }
  /* The tool's own credit: small and muted at the very foot of the sheet, after the signature block,
     so it never competes with the calculation. It is a plain line of text, not a graphical advert. */
  .credit { margin: 10px 0 0; color: #8a97a3; font-size: 11px; }
  .sig { margin-top: 26px; display: flex; gap: 40px; }
  .sig div { flex: 1; border-top: 1px solid #444; padding-top: 4px; color: #444; }
  .btnbar { margin-bottom: 14px; }
  .btnbar button { font: inherit; padding: 6px 14px; border: 1px solid #1b5e9c; background: #1b5e9c;
                   color: #fff; border-radius: 4px; cursor: pointer; }
  /* The report is shown inside the app's own report view, whose bar carries Print / Save as PDF,
     so the button inside the document is a duplicate on screen. It was already hidden when
     printing; hide it on screen too, and the printed sheet stays clean either way. */
  .btnbar { display: none; }
  .v-cited, .v-confirmed { color: #146c43; }
  .v-typed { color: #8a6116; }
  .v-unconfirmed, .v-missing, .v-practice, .v-flag { color: #b02a37; font-weight: 600; }
  @media print {
    body { margin: 8mm; font-size: 11px; }
    .btnbar { display: none; }
    h2 { break-after: avoid; }
    table { break-inside: auto; }
    tr { break-inside: avoid; }
    thead { display: table-header-group; }
    @page { size: A4 landscape; margin: 10mm; }
  }
`;

/** Plain names for the cross-check's term keys, so the printed table reads like a calculation. */
export const TERM_LABEL = {
  oa: 'Outdoor (fresh) air', infil: 'Infiltration', glassSolar: 'Solar through glazing',
  glassCond: 'Conduction through glazing', wall: 'Opaque walls', roof: 'Roof', partition: 'Partitions',
  peopleS: 'People (sensible)', peopleL: 'People (latent)', light: 'Lighting', equip: 'Equipment',
};

/** Why two methods disagree — read off the term table, not assumed. */
export function crossCheckExplain(cc) {
  const terms = (cc && cc.termCompare) || [];
  const big = terms.filter((t) => Math.abs(t.deltaW) > 500 && Math.abs(t.appW) > 100)
    .sort((a, b) => Math.abs(b.deltaW) - Math.abs(a.deltaW));
  const agree = terms.filter((t) => Math.abs(t.appW) > 1000 && Math.abs(t.deltaW) / Math.abs(t.appW) < 0.1);
  const pct = (t) => (t.appW ? fmt((t.deltaW / t.appW) * 100, 0) : '-') + '%';
  const L = (t) => TERM_LABEL[t.term] || t.term;
  const bits = [];
  if (agree.length) {
    bits.push(`The two methods agree on ${agree.map((t) => L(t).toLowerCase()).join(', ')} ` +
      `(within 10%), so the difference is not in those terms.`);
  }
  if (big.length) {
    bits.push(`Almost all of it sits in ${big.map((t) => `${L(t).toLowerCase()} ` +
      `(${fmt(t.appW / 1000, 1)} kW against ${fmt(t.xW / 1000, 1)} kW, ${pct(t)})`).join(' and ')}.`);
    const glazing = big.find((t) => t.term === 'glassSolar');
    if (glazing) {
      bits.push('The glazing figure differs because this tool uses one tabulated peak solar value per ' +
        'orientation, whatever the hour, while the second method computes the sun\'s real position at the ' +
        'design hour: on a west-facing sheet the two cannot agree, and no single hour can put every ' +
        'orientation at its own peak at once.');
    }
    const opaque = big.filter((t) => /roof|wall|part/i.test(t.term));
    if (opaque.length) {
      bits.push('Those are the opaque surfaces, and the reason is stated in the table: this tool pairs a ' +
        'high U value with a mild effective temperature difference, while the second method builds a ' +
        'sol-air temperature from the design day\'s sun and the surface\'s colour. For a dark, uninsulated ' +
        'roof in full sun those two are inconsistent, and the tool is the low one. This is the figure in ' +
        'this report most worth a second opinion.');
    }
  }
  if (!bits.length) bits.push('The two methods agree within the reporting tolerance on every term.');
  return bits.join(' ');
}

/** The report that is NOT issued. */
export function refusalHtml(project, basis, gaps, when) {
  const p = project || {};
  const rows = gaps.map((g) => `<tr><td class="l">${esc(g.label || g.id)}</td><td>${esc(String(g.reason || 'unconfirmed'))}</td>
    <td class="l">${esc(g.cite || '')}</td></tr>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Not issued &mdash; design basis incomplete</title>
<style>${REPORT_CSS}</style></head>
<body>
<h1>${esc(p.name || 'HVAC Load Calculation')}</h1>
<p class="sub">${esc(when)}</p>
<h2>This report is NOT ISSUED</h2>
<div class="notes">
  <strong>The design basis for this project is not complete, so the load has not been totalled and no
  tonnage is printed anywhere in this document.</strong>
  <ul>
    <li>A cooling load is only as good as the figures it stands on. ${gaps.length} of them are neither
        sourced from a published standard nor confirmed by a person for this project.</li>
    <li>Filling in a silent default would produce a number that looks finished and cannot be defended.
        Listing the gap is the honest output.</li>
    <li>Open the project in the calculator, read each figure in the Design basis panel, and either cite
        it or confirm it. Then this report will issue with the full calculation.</li>
  </ul>
</div>
<h2>What is still outstanding</h2>
<table>
  <thead><tr><th class="l">Figure</th><th class="l">Why it is a gap</th><th class="l">What is missing</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="3" class="l">-</td></tr>'}</tbody>
</table>
<p class="sub">${esc(basisLine(basis))}</p>
<p class="credit">Calculated with LoadLens - loadlens.net</p>
</body></html>`;
}

export function buildReportHtml(project, calcResult, opts = {}) {
  const p = Object.assign({}, project || {});
  const res = (calcResult && calcResult.results) || [];
  const totals = (calcResult && calcResult.totals) || {};
  // When the supply-air ΔT is zero/negative the supply flow is incalculable (calc.js returns 0 and a
  // warning); the report shows "-" in every supply column rather than a misleading 0.
  const supplyOk = totals.supplyOk !== false;
  const generated = opts.generatedAt || new Date();
  const when = generated.toLocaleString ? generated.toLocaleString('en-GB') : String(generated);
  const included = res.filter((r) => r.room.include);
  const levels = groupByLevel(res);
  // The chosen display system. Everything below converts an already-computed SI result with js/units.js;
  // no figure is re-derived and no table mixes the two systems.
  const sys = normSystem(p.units);
  const AU = areaUnit(sys), LU = lengthUnit(sys), PU = powerUnit(sys);
  const QU = airUnit(sys), APTU = areaPerTrUnit(sys), TU = tempUnit(sys), DTU = tempDeltaUnit(sys);
  // In SI the companion cell can show the same quantity in m³/s (still SI); in imperial it is a
  // plain-language note instead, so no table ever carries two systems at once.
  const supplyAlt = sys === 'ip'
    ? 'computed from the room sensible heat and the supply &Delta;T'
    : `${fmt((totals.ls || 0) * 0.001, 3)} m&sup3;/s`;
  const oaAlt = sys === 'ip'
    ? 'outdoor air per the space types (ASHRAE 62.1)'
    : `${fmt((totals.oaLs || 0) * 0.001, 3)} m&sup3;/s`;

  // ================================================================================================
  // THE EVIDENCE LAYER
  // A tonnage nobody can check is a guess with a decimal point. Before any figure is printed, the
  // report states what the calculation stands on, whether each area can be checked at all, how wide
  // the answer really is, and — if the basis is not confirmed — it REFUSES to issue at all.
  // ================================================================================================
  const basis = opts.basis || savedBasis(p, opts.climate);
  const gaps = basisGaps(basis);
  const bstats = basisStats(basis);
  if (opts.enforceBasis !== false && gaps.length) {
    return refusalHtml(p, basis, gaps, when);
  }

  const STATUS_WORD = {
    cited: 'cited', confirmed: 'confirmed', typed: 'hand-entered', practice: 'UNSOURCED',
    unconfirmed: 'NOT CONFIRMED', missing: 'NO VALUE', indicative: 'INDICATIVE',
  };
  const perType = new Set(['oap', 'oaa', 'light', 'equip', 'm2pp', 'ps', 'pl']);
  const basisRows = BASIS_FIELDS.map((f) => {
    const e = basis.entries[f.id];
    if (!e) return '';
    const v = perType.has(f.id) ? '-' : (e.value == null ? '-' : fmt(e.value, 2));
    const st = STATUS_WORD[e.status] || e.status;
    const when2 = e.confirmedAt ? ` <span class="muted">on ${esc(String(e.confirmedAt))}</span>` : '';
    return `<tr>
      <td class="l">${esc(f.label)}</td>
      <td>${v}</td>
      <td class="l">${esc(f.unit || '')}</td>
      <td class="l">${esc(e.cite || f.cite || '')}${e.note ? ` <em>${esc(e.note)}</em>` : ''}</td>
      <td class="l v-${esc(e.status)}">${esc(st)}${when2}</td>
    </tr>`;
  }).join('');
  const stmts = basisStatements(basis);
  const basisSection = `
<h2>6. Design basis &mdash; what this calculation stands on</h2>
<p class="sub">${esc(basisLine(basis))}</p>
<p class="sub">In plain words, the calculation stands on ${stmts.length} statements:
  ${stmts.map((s) => `${esc(s.label)}${s.settled ? ' (settled)' : ' &mdash; NOT confirmed'}`).join(' &middot; ')}.</p>
<table class="basis">
  <thead><tr><th class="l">Figure</th><th>Value</th><th class="l">Unit</th>
    <th class="l">Source, as stated</th><th class="l">Status</th></tr></thead>
  <tbody>${basisRows}</tbody>
</table>
<div class="notes">
  <strong>Every figure above is either sourced, confirmed by a person, or listed as a gap.</strong>
  <ul>
    <li>A <em>cited</em> figure carries a published source (ECBC 2017, ASHRAE, IECC). A
        <em>confirmed</em> figure is one a person stood behind for this project, with the date recorded.
        A <em>hand-entered</em> figure was typed by hand and is not audited.</li>
    <li>${esc(bstats.byKindLine ? bstats.byKindLine : '')} ${gaps.length
        ? `${gaps.length} figure(s) are still unconfirmed.`
        : 'Nothing is outstanding: the basis is complete for this project.'}</li>
    <li>The room-type figures (outdoor air per person and per m&sup2;, lighting, equipment, occupancy
        density, and the sensible/latent heat per person) are per-use values and are listed with the
        calculation, not here, because they differ from room to room.</li>
  </ul>
</div>`;

  // ---- area reconciliation ----------------------------------------------------------------------
  const rec = reconcileAreas(res.filter((r) => r.room.include).map((r) => r.room), { tolerance: 5 });
  const rs = rec.summary;
  // The reconciliation rows carry the room's id and name, not the whole room: look up the sheet facts
  // (its level and number) from the calculation so the printed row matches the room table above.
  const roomById = new Map();
  for (const r of res) if (r.room && r.room.id != null) roomById.set(String(r.room.id), r.room);
  const recRows = rec.rows.filter((r) => r.verdict !== 'none').slice(0, 400).map((r) => {
    const rm = roomById.get(String(r.id)) || {};
    return `<tr>
      <td>${esc(rm.level || '-')}</td>
      <td class="l">${esc(rm.number || '-')}</td>
      <td class="l">${esc(rm.name || r.name || '-')}</td>
      <td>${r.geometry == null ? '-' : fmt(area(r.geometry, sys), 1)}</td>
      <td>${r.sheet == null ? '-' : fmt(area(r.sheet, sys), 1)}</td>
      <td>${r.diffPct == null ? '-' : fmt(Math.abs(r.diffPct), 1) + '%'}</td>
      <td class="l v-${esc(r.verdict)}">${esc(r.verdict === 'flag' ? 'OVER TOLERANCE'
        : r.verdict === 'agree' ? 'agrees' : r.verdict === 'sheet-derived' ? 'box sized from the sheet'
        : r.verdict === 'typed' ? 'typed in' : 'not checkable')}</td>
    </tr>`;
  }).join('');
  const recSection = `
<h2>7. Room areas &mdash; checked against the drawing's own figures</h2>
<p class="sub">${esc(reconcileLine(rec))}</p>
${rs.independentSourceExists ? '' : `<div class="notes">
  <strong>No room area on this sheet can be independently checked.</strong>
  <ul><li>The drawing does not state an area for any room, and it carries no dimension chains, so the
      only figure that exists is the one this tool measured from the drawing's own linework. That is a
      single source, not two, and it is reported as such rather than dressed up as agreement.</li>
      <li>A room whose box was placed by hand is <em>not</em> counted as agreement either: the box is
      sized back from the printed area, so comparing them would compare a number with itself.</li></ul>
</div>`}
<table>
  <thead><tr><th>Level</th><th class="l">No.</th><th class="l">Room</th>
    <th>${esc(header('Measured', AU))}</th><th>${esc(header('On the sheet', AU))}</th>
    <th>Difference</th><th class="l">Verdict</th></tr></thead>
  <tbody>${recRows || '<tr><td colspan="7" class="l">-</td></tr>'}</tbody>
  <tfoot><tr class="total"><td class="l" colspan="3">${rs.checkable} of ${rs.rooms} rooms could be checked</td>
    <td colspan="2">${rs.flag} over ${fmt(rs.tolerance, 0)}%</td>
    <td>${rs.medianAbsDiff == null ? '-' : fmt(rs.medianAbsDiff, 1) + '%'}</td>
    <td class="l">median difference</td></tr></tfoot>
</table>`;

  // ---- the band ---------------------------------------------------------------------------------
  const mc = opts.uncertainty || null;
  const spread = mc ? mc.tr.spreadPct : null;
  const topDrivers = mc ? mc.drivers.filter((d) => !d.inert).slice(0, 3) : [];
  const bandSection = `
<h2>8. How wide the answer is</h2>
${mc ? `
<p class="sub">The single tonnage on page one is the middle of this range, not the answer.</p>
<table>
  <tbody>
    <tr><th class="l">Central value</th><td>${fmt(mc.tr.p50, 2)} TR</td>
        <td class="l">median of ${fmt(mc.n, 0)} draws</td></tr>
    <tr><th class="l">Middle 90%</th><td>${fmt(mc.tr.p05, 2)} &ndash; ${fmt(mc.tr.p95, 2)} TR</td>
        <td class="l">5th to 95th percentile, i.e. &plusmn;${fmt(spread / 2, 0)}% around the middle</td></tr>
    <tr><th class="l">Widest drivers</th><td colspan="2" class="l">${topDrivers.map((d, i) =>
      `${i + 1}. ${esc(d.label || d.id)} (${fmt(d.share * 100, 0)}% of the swing)`).join(' &middot; ') || '-'}</td></tr>
  </tbody>
</table>
<div class="notes"><strong>The three figures that move this answer most are ${topDrivers.length
  ? esc(topDrivers.map((d) => String(d.label || d.id).toLowerCase()).join(', ')) : '-'}.</strong>
  <ul>${mc.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`
  : `<p class="sub">Not computed for this report. The tool can run it (10,000 draws, a second or two);
      it is omitted here rather than replaced with an assumed range.</p>`}`;

  // ---- the second method ------------------------------------------------------------------------
  const cc = opts.crosscheck || null;
  const ccSection = `
<h2>9. Independent cross-check, and what is NOT verified</h2>
${cc ? `
<p class="sub">The same rooms on the same basis, worked a second way: sol-air temperature and computed
solar geometry from a weather file, against the engine's tabulated per-orientation values.</p>
<table>
  <thead><tr><th class="l">Term</th><th>This tool</th><th>Second method</th><th>Difference</th></tr></thead>
  <tbody>${cc.termCompare.filter((t) => Math.abs(t.appW) > 1 || Math.abs(t.xW) > 1).map((t) => `<tr>
      <td class="l">${esc(TERM_LABEL[t.term] || t.term)}</td><td>${fmt(t.appW / 1000, 1)} kW</td>
      <td>${fmt(t.xW / 1000, 1)} kW</td>
      <td>${t.appW ? (t.deltaW / t.appW >= 0 ? '+' : '') + fmt((t.deltaW / t.appW) * 100, 0) + '%' : '-'}</td>
    </tr>`).join('')}
    <tr class="grand"><td class="l">Total</td><td>${fmt(cc.totals.appTr, 2)} TR</td>
      <td>${fmt(cc.totals.xTr, 2)} TR</td>
      <td>${cc.totals.xTr >= cc.totals.appTr ? '+' : ''}${fmt(cc.totals.deltaPct, 1)}%</td></tr>
  </tbody>
</table>
<p class="sub">Design hour taken from ${esc(cc.day.station || 'the weather file')}:
  ${cc.day.day}/${cc.day.month} at ${cc.day.hour}:30, dry bulb ${fmt(cc.day.db, 1)} &deg;C,
  global horizontal ${fmt(cc.day.ghi, 0)} W/m&sup2;. It is the hour this building's own load peaks,
  found by running the second method for every daylight hour in the file.</p>
<p><strong>Explanation of the difference:</strong> ${esc(crossCheckExplain(cc))}</p>`
  : `<p class="sub">Not run for this report. It needs a weather file (EPW) for the site; without one the
      cross-check is omitted rather than invented.</p>`}
<div class="notes">
  <strong>What this report does not prove.</strong>
  <ul>
    <li><strong>Nothing is calibrated.</strong> These projects have no meter data and no energy bills, so
        the Guideline 14 metrics (NMBE within &plusmn;5%, CV(RMSE) under 15%) cannot be computed. They are
        named here so the absence is obvious: this is an uncalibrated calculation.</li>
    <li><strong>The geometry is not independently reconciled where the sheet offers nothing.</strong>
        Room faces come from the drawing's own linework. Dimension chains and gridlines are not parsed,
        and no second geometry engine was run, so a systematic error in reading the drawing would not be
        caught by this report.</li>
    <li><strong>No second engineering tool was run.</strong> EnergyPlus / OpenStudio or HAP / TRACE would
        be the independent implementation; the cross-check above is a second <em>method</em>, written
        here, using the same inputs. It catches method errors, not input errors.</li>
  </ul>
</div>`;

  const roomRows = included.map((r, i) => {
    const room = r.room;
    return `<tr>
      <td>${i + 1}</td>
      <td class="l">${esc(room.level || '-')}</td>
      <td class="l">${esc(room.number || '-')}</td>
      <td class="l">${esc(room.name || '-')}</td>
      <td class="l">${esc(typeLabel(room.type))}</td>
      <td>${fmt(area(room.area, sys), 1)}</td>
      <td>${fmt(length(room.height, sys), 1)}</td>
      <td>${fmt(room.people, 0)}</td>
      <td>${esc(room.orient || '-')}</td>
      <td>${fmt(area(room.glass, sys), 1)}</td>
      <td>${room.roof ? 'Yes' : '-'}</td>
      <td>${fmt(power(r.rsh, sys), 0)}</td>
      <td>${fmt(power(r.rlh, sys), 0)}</td>
      <td>${fmt(power((r.oaSens || 0) + (r.oaLat || 0), sys), 0)}</td>
      <td>${fmt(power(r.totalW, sys), 0)}</td>
      <td>${fmt(r.tr, 2)}</td>
      <td>${r.supplyOk === false ? '-' : fmt(air(r.supplyLs, sys), 0)}</td>
      <td>${fmt(areaPerTr(r.m2PerTr, sys), 0)}</td>
    </tr>`;
  }).join('');

  const levelRows = levels.map((g) => `<tr>
      <td class="l">${esc(g.level)}</td>
      <td>${g.rooms}</td>
      <td>${fmt(area(g.area, sys), 1)}</td>
      <td>${fmt(g.tr, 2)}</td>
      <td>${g.supplyOk === false ? '-' : fmt(air(g.ls, sys), 0)}</td>
      <td>${fmt(air(g.oaLs, sys), 0)}</td>
    </tr>`).join('');

  const skipped = res.filter((r) => !r.room.include);
  const skippedNote = skipped.length
    ? `<p class="muted">Not air conditioned (excluded from totals): ${esc(skipped.map((r) => r.room.name).join(', '))}</p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(p.name || 'HVAC report')} — cooling load report</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="btnbar"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>

<h1>${esc(p.name || 'HVAC Load Calculation')}</h1>
<p class="sub"><strong>LoadLens</strong> &mdash; the lens on your cooling load, from a floor plan PDF to tonnes, airflow and heat load.</p>
<p class="sub">Cooling load estimate — room wise. Results shown in <strong>${esc(systemLabel(sys))}</strong>. Generated by LoadLens on ${esc(when)}.</p>
<p class="sub">${esc(conversionNote(sys))}</p>

<h2>1. Project and design conditions</h2>
<div class="cols">
  <div>
    <table class="kv">
      <tr><th>Project</th><td>${esc(p.name || '-')}</td></tr>
      <tr><th>Country</th><td>${esc(p.country || '-')}</td></tr>
      <tr><th>City / region</th><td>${esc(p.city || '-')}</td></tr>
      <tr><th>Outdoor dry bulb</th><td>${fmt(temp(p.outDb, sys), 1)} ${esc(TU)}</td></tr>
      <tr><th>Outdoor wet bulb</th><td>${fmt(temp(p.outWb, sys), 1)} ${esc(TU)}</td></tr>
      <tr><th>Outdoor RH (from DB/WB)</th><td>${fmt(totals.outRh, 0)} %</td></tr>
      <tr><th>Outdoor humidity ratio</th><td>${fmt(totals.wOut, 4)} kg/kg</td></tr>
    </table>
  </div>
  <div>
    <table class="kv">
      <tr><th>Indoor dry bulb</th><td>${fmt(temp(p.inDb, sys), 1)} ${esc(TU)}</td></tr>
      <tr><th>Indoor RH</th><td>${fmt(p.inRh, 0)} %</td></tr>
      <tr><th>Indoor humidity ratio</th><td>${fmt(totals.wIn, 4)} kg/kg</td></tr>
      <tr><th>Room &minus; outdoor &Delta;T</th><td>${fmt(tempDelta((p.outDb || 0) - (p.inDb || 0), sys), 1)} ${esc(DTU)}</td></tr>
      <tr><th>Supply air &Delta;T</th><td>${fmt(tempDelta(p.supplyDt, sys), 1)} ${esc(DTU)}</td></tr>
      <tr><th>Safety factor</th><td>${fmt(p.safety, 0)} %</td></tr>
    </table>
  </div>
</div>

<h2>2. Assumptions used</h2>
<div class="cols">
  <div>
    <table class="kv">
      <tr><th>Wall U value</th><td>${fmt(uValue(p.uWall, sys), 2)} ${esc(uValueUnit(sys))} (230 mm brick, plastered)</td></tr>
      <tr><th>Glass U value</th><td>${fmt(uValue(p.uGlass, sys), 2)} ${esc(uValueUnit(sys))} (single clear glass)</td></tr>
      <tr><th>Shading coefficient</th><td>${fmt(p.sc, 2)} (clear glass + internal blinds)</td></tr>
      <tr><th>Roof U value</th><td>${fmt(uValue(p.uRoof, sys), 2)} ${esc(uValueUnit(sys))} (RCC slab + weathering)</td></tr>
    </table>
  </div>
  <div>
    <table class="kv">
      <tr><th>Roof equivalent &Delta;T (ETD)</th><td>${fmt(tempDelta(p.roofEtd, sys), 1)} ${esc(DTU)}</td></tr>
      <tr><th>Partition U value</th><td>${fmt(uValue(p.uPart, sys), 2)} ${esc(uValueUnit(sys))}</td></tr>
      <tr><th>Infiltration</th><td>${fmt(p.infilAch, 2)} air changes per hour</td></tr>
      <tr><th>Glazing assumed</th><td>${fmt(p.wwr, 0)} % of exposed wall (when glass area is blank)</td></tr>
    </table>
  </div>
</div>
<p class="muted">Solar gain and wall equivalent temperature differences are peak values for about 10&deg; north latitude.
Fresh air (outdoor air) rates follow ASHRAE 62.1 type-of-use values per person plus a small allowance per unit of floor area.</p>

<h2>3. Room wise load</h2>
<table>
  <thead>
    <tr>
      <th>#</th><th class="l">Level</th><th class="l">No.</th><th class="l">Room</th><th class="l">Space type</th>
      <th>${esc(header('Area', AU))}</th><th>${esc(header('Height', LU))}</th><th>People</th><th>Orient.</th>
      <th>${esc(header('Glass', AU))}</th><th>Roof</th>
      <th>${esc(header('Sensible', PU))}</th><th>${esc(header('Latent', PU))}</th>
      <th>${esc(header('Fresh air', PU))}</th><th>${esc(header('Total', PU))}</th>
      <th>TR</th><th>${esc(header('Supply air', QU))}</th><th>${esc(header('Area per TR', APTU))}</th>
    </tr>
  </thead>
  <tbody>
    ${roomRows || '<tr><td colspan="18" class="l">No air conditioned rooms.</td></tr>'}
  </tbody>
  <tfoot>
    <tr class="total">
      <td colspan="5" class="l">Total — ${included.length} room(s)</td>
      <td>${fmt(area(totals.area, sys), 1)}</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>
      <td>${fmt(power(totals.rsh, sys), 0)}</td><td>${fmt(power(totals.rlh, sys), 0)}</td>
      <td>${fmt(power((totals.totalW || 0) - (totals.rsh || 0) - (totals.rlh || 0), sys), 0)}</td>
      <td>${fmt(power(totals.totalW, sys), 0)}</td>
      <td>${fmt(totals.tr, 2)}</td><td>${supplyOk ? fmt(air(totals.ls, sys), 0) : '-'}</td>
      <td>${fmt(areaPerTr(totals.m2PerTr, sys), 0)}</td>
    </tr>
  </tfoot>
</table>
${skippedNote}

<h2>4. Load summary</h2>
<table>
  <tbody>
    <tr><th class="l">Total cooling load</th><td>${fmt(totals.tr, 2)} TR</td>
        <td class="l">${fmt(power(totals.totalW, sys), 0)} ${esc(PU)}${sys === 'ip' ? '' : ` = ${fmt((totals.totalW || 0) / 1000, 1)} kW`}</td></tr>
    <tr><th class="l">Room sensible heat (incl. safety)</th><td>${fmt(power(totals.rsh, sys), 0)} ${esc(PU)}</td>
        <td class="l">Room latent heat (incl. safety) ${fmt(power(totals.rlh, sys), 0)} ${esc(PU)}</td></tr>
    <tr><th class="l">Safety allowance (${fmt(totals.safetyPct, 0)}%)</th><td>+${fmt(power(totals.safetyW, sys), 0)} ${esc(PU)}</td>
        <td class="l">inside the room heat above; fresh air is added afterwards</td></tr>
    <tr><th class="l">Supply air quantity</th><td>${supplyOk ? fmt(air(totals.ls, sys), 0) + ' ' + esc(QU) : '-'}</td>
        <td class="l">${supplyOk ? supplyAlt : '-'}</td></tr>
    <tr><th class="l">Fresh / outdoor air</th><td>${fmt(air(totals.oaLs, sys), 0)} ${esc(QU)}</td>
        <td class="l">${oaAlt}</td></tr>
    <tr><th class="l">Conditioned floor area</th><td>${fmt(area(totals.area, sys), 1)} ${esc(AU)}</td>
        <td class="l">of the air conditioned rooms only</td></tr>
    <tr><th class="l">Area per tonne</th><td>${fmt(areaPerTr(totals.m2PerTr, sys), 0)} ${esc(APTU)}</td>
        <td class="l">area served per ton of refrigeration</td></tr>
  </tbody>
</table>

<h2>5. Level wise subtotal</h2>
<table>
  <thead>
    <tr><th class="l">Level</th><th>Rooms</th><th>${esc(header('Area', AU))}</th>
        <th>TR</th><th>${esc(header('Supply air', QU))}</th><th>${esc(header('Fresh air', QU))}</th></tr>
  </thead>
  <tbody>
    ${levelRows || '<tr><td colspan="6" class="l">-</td></tr>'}
  </tbody>
  <tfoot>
    <tr class="grand">
      <td class="l">Grand total</td><td>${included.length}</td>
      <td>${fmt(area(totals.area, sys), 1)}</td>
      <td>${fmt(totals.tr, 2)}</td><td>${supplyOk ? fmt(air(totals.ls, sys), 0) : '-'}</td>
      <td>${fmt(air(totals.oaLs, sys), 0)}</td>
    </tr>
  </tfoot>
</table>

${basisSection}
${recSection}
${bandSection}
${ccSection}

<h2>10. Important notes</h2>
<div class="notes">
  <strong>This is a simplified estimate. It must be checked by a qualified HVAC engineer before use.</strong>
  <ul>
    <li>Units: results are shown in <strong>${esc(systemLabel(sys))}</strong>. ${esc(conversionNote(sys))}</li>
    <li>Method: simplified ASHRAE / Carrier E-20 style. Peak solar gain through glass (with storage effect)
        and sol-air equivalent temperature differences (ETD / CLTD) are used, <em>not</em> a full hourly RTS
        (radiant time series) calculation.</li>
    <li>Solar values and wall ETD are peak values for about 10&deg; north latitude (India / Gulf). For other
        locations and orientations the real peak hours differ.</li>
    <li>Areas, heights, glass areas and people counts come from the PDF drawing or from what you typed.
        Confirm them against the actual architectural drawing and the room schedule.</li>
    <li>Shading (overhangs, external fins, adjacent buildings), internal blinds, sky and ground reflected
        radiation, and glass framing are covered only by the single shading coefficient value.</li>
    <li>Infiltration is a simple air-change-per-hour estimate. It does not model door openings, stack effect,
        or fresh-air duct leakage.</li>
    <li>No duct heat gain / leak loss, no fan heat, no ventilation of toilets / staircases, and no diversity
        factor on people and equipment are included. Add these when selecting the equipment.</li>
    <li>Equipment selection must also consider altitude, part load, redundancy, controls and the actual
        building construction and ventilation code (e.g. ASHRAE 62.1, NBC India, ECBC).</li>
  </ul>
</div>

<div class="sig">
  <div>Prepared by</div>
  <div>Checked by</div>
  <div>Date</div>
</div>

<p class="muted">LoadLens &mdash; <a href="https://loadlens.net/">loadlens.net</a> &middot;
Source on GitHub: <a href="https://github.com/ratul-sraj/hvac">github.com/ratul-sraj/hvac</a></p>

<p class="credit">${esc(conversionNote(sys))} Calculated with LoadLens - loadlens.net &middot; free, runs in your browser, your drawing is never sent to a third party. On loadlens.net it is posted to this site's own server so it can be read faster; it is not stored and nothing from it is logged.</p>
</body>
</html>`;
  return html;
}
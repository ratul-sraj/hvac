// WebHVAC — printable report HTML + CSV export.
// Pure string builders: no DOM access at import time, no DOM access when called.
// Both exports take (project, calcResult) where calcResult = calcProject(rooms, project).

import { SPACE_TYPES } from './calc.js';

/* ---------------- small helpers ---------------- */

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

// Group calc results by level -> { level, rooms, tr, cfm, area, areaSqft }
// Only included rooms are counted (same rule as calc.js totals).
export function groupByLevel(results) {
  const map = new Map();
  for (const r of results) {
    if (!r.room.include) continue;
    const level = (r.room.level || '').trim() || 'Unspecified';
    if (!map.has(level)) map.set(level, { level, rooms: 0, tr: 0, cfm: 0, oaCfm: 0, area: 0, areaSqft: 0 });
    const g = map.get(level);
    g.rooms += 1;
    g.tr += r.tr;
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

export function toCsv(project, calcResult) {
  const p = project || {};
  const res = calcResult && calcResult.results ? calcResult.results : [];
  const head = [
    'Include', 'Level', 'No.', 'Name', 'Space type', 'Area m2', 'Area ft2', 'Height m',
    'People', 'Light W/m2', 'Equip W/m2', 'Orientation', 'Ext wall m2', 'Glass m2',
    'Roof', 'Partition m2',
    'Sensible W', 'Latent W', 'Total W', 'TR', 'CFM', 'Fresh air CFM', 'ft2/TR', 'SHF',
  ];
  const rows = [head];
  for (const r of res) {
    const room = r.room;
    const area = parseFloat(room.area) || 0;
    rows.push([
      room.include ? 'yes' : 'no',
      room.level || '',
      room.number || '',
      room.name || '',
      typeLabel(room.type),
      area ? area.toFixed(2) : '',
      area ? (area * 10.7639).toFixed(2) : '',
      room.height || '',
      room.people, room.light, room.equip,
      room.orient || '',
      room.extWall, room.glass,
      room.roof ? 'yes' : 'no', room.partition || 0,
      r.rsh.toFixed(0), r.rlh.toFixed(0), r.totalW.toFixed(0),
      r.tr.toFixed(2), r.cfm.toFixed(0), r.oaCfm.toFixed(0),
      r.sqftPerTr.toFixed(0), r.shf.toFixed(3),
    ]);
  }
  // project header lines (prefixed so they do not look like room rows)
  const meta = [
    ['# WebHVAC cooling load export'],
    ['# Project', p.name || ''],
    ['# Country', p.country || ''],
    ['# City', p.city || ''],
    ['# Outdoor DB (C)', p.outDb], ['# Outdoor WB (C)', p.outWb],
    ['# Indoor DB (C)', p.inDb], ['# Indoor RH (%)', p.inRh],
    ['# U wall', p.uWall], ['# U glass', p.uGlass], ['# SC', p.sc],
    ['# U roof', p.uRoof], ['# Roof ETD', p.roofEtd], ['# U partition', p.uPart],
    ['# Infiltration ACH', p.infilAch], ['# Safety %', p.safety],
    ['# Supply dT (K)', p.supplyDt], ['# Glazing % of wall', p.wwr],
    [],
  ];
  const body = meta.concat(rows).map((r) => r.map(csvCell).join(',')).join('\r\n');
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
  .sig { margin-top: 26px; display: flex; gap: 40px; }
  .sig div { flex: 1; border-top: 1px solid #444; padding-top: 4px; color: #444; }
  .btnbar { margin-bottom: 14px; }
  .btnbar button { font: inherit; padding: 6px 14px; border: 1px solid #1b5e9c; background: #1b5e9c;
                   color: #fff; border-radius: 4px; cursor: pointer; }
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

export function buildReportHtml(project, calcResult, opts = {}) {
  const p = Object.assign({}, project || {});
  const res = (calcResult && calcResult.results) || [];
  const totals = (calcResult && calcResult.totals) || {};
  const generated = opts.generatedAt || new Date();
  const when = generated.toLocaleString ? generated.toLocaleString('en-GB') : String(generated);
  const included = res.filter((r) => r.room.include);
  const levels = groupByLevel(res);

  const roomRows = included.map((r, i) => {
    const room = r.room;
    const area = parseFloat(room.area) || 0;
    return `<tr>
      <td>${i + 1}</td>
      <td class="l">${esc(room.level || '-')}</td>
      <td class="l">${esc(room.number || '-')}</td>
      <td class="l">${esc(room.name || '-')}</td>
      <td class="l">${esc(typeLabel(room.type))}</td>
      <td>${fmt(area, 1)}</td>
      <td>${fmt(room.height, 1)}</td>
      <td>${fmt(room.people, 0)}</td>
      <td>${esc(room.orient || '-')}</td>
      <td>${fmt(room.glass, 1)}</td>
      <td>${room.roof ? 'Yes' : '-'}</td>
      <td>${fmt(r.rsh, 0)}</td>
      <td>${fmt(r.rlh, 0)}</td>
      <td>${fmt(r.oaSens + r.oaLat, 0)}</td>
      <td>${fmt(r.totalW, 0)}</td>
      <td>${fmt(r.tr, 2)}</td>
      <td>${fmt(r.cfm, 0)}</td>
      <td>${fmt(r.sqftPerTr, 0)}</td>
    </tr>`;
  }).join('');

  const levelRows = levels.map((g) => `<tr>
      <td class="l">${esc(g.level)}</td>
      <td>${g.rooms}</td>
      <td>${fmt(g.area, 1)}</td>
      <td>${fmt(g.areaSqft, 0)}</td>
      <td>${fmt(g.tr, 2)}</td>
      <td>${fmt(g.cfm, 0)}</td>
      <td>${fmt(g.oaCfm, 0)}</td>
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
<p class="sub">Cooling load estimate — room wise. Generated by WebHVAC on ${esc(when)}.</p>

<h2>1. Project and design conditions</h2>
<div class="cols">
  <div>
    <table class="kv">
      <tr><th>Project</th><td>${esc(p.name || '-')}</td></tr>
      <tr><th>Country</th><td>${esc(p.country || '-')}</td></tr>
      <tr><th>City / region</th><td>${esc(p.city || '-')}</td></tr>
      <tr><th>Outdoor dry bulb</th><td>${fmt(p.outDb, 1)} &deg;C</td></tr>
      <tr><th>Outdoor wet bulb</th><td>${fmt(p.outWb, 1)} &deg;C</td></tr>
      <tr><th>Outdoor RH (from DB/WB)</th><td>${fmt(totals.outRh, 0)} %</td></tr>
      <tr><th>Outdoor humidity ratio</th><td>${fmt(totals.wOut, 4)} kg/kg</td></tr>
    </table>
  </div>
  <div>
    <table class="kv">
      <tr><th>Indoor dry bulb</th><td>${fmt(p.inDb, 1)} &deg;C</td></tr>
      <tr><th>Indoor RH</th><td>${fmt(p.inRh, 0)} %</td></tr>
      <tr><th>Indoor humidity ratio</th><td>${fmt(totals.wIn, 4)} kg/kg</td></tr>
      <tr><th>Room &minus; outdoor &Delta;T</th><td>${fmt((p.outDb || 0) - (p.inDb || 0), 1)} K</td></tr>
      <tr><th>Supply air &Delta;T</th><td>${fmt(p.supplyDt, 1)} K</td></tr>
      <tr><th>Safety factor</th><td>${fmt(p.safety, 0)} %</td></tr>
    </table>
  </div>
</div>

<h2>2. Assumptions used</h2>
<div class="cols">
  <div>
    <table class="kv">
      <tr><th>Wall U value</th><td>${fmt(p.uWall, 2)} W/m&sup2;K (230 mm brick, plastered)</td></tr>
      <tr><th>Glass U value</th><td>${fmt(p.uGlass, 2)} W/m&sup2;K (single clear glass)</td></tr>
      <tr><th>Shading coefficient</th><td>${fmt(p.sc, 2)} (clear glass + internal blinds)</td></tr>
      <tr><th>Roof U value</th><td>${fmt(p.uRoof, 2)} W/m&sup2;K (RCC slab + weathering)</td></tr>
    </table>
  </div>
  <div>
    <table class="kv">
      <tr><th>Roof equivalent &Delta;T (ETD)</th><td>${fmt(p.roofEtd, 1)} K</td></tr>
      <tr><th>Partition U value</th><td>${fmt(p.uPart, 2)} W/m&sup2;K</td></tr>
      <tr><th>Infiltration</th><td>${fmt(p.infilAch, 2)} air changes per hour</td></tr>
      <tr><th>Glazing assumed</th><td>${fmt(p.wwr, 0)} % of exposed wall (when glass area is blank)</td></tr>
    </table>
  </div>
</div>
<p class="muted">Solar gain and wall equivalent temperature differences are peak values for about 10&deg; north latitude.
Fresh air (outdoor air) rates follow ASHRAE 62.1 type-of-use values per person plus per m&sup2; of floor.</p>

<h2>3. Room wise load</h2>
<table>
  <thead>
    <tr>
      <th>#</th><th class="l">Level</th><th class="l">No.</th><th class="l">Room</th><th class="l">Space type</th>
      <th>Area<br>m&sup2;</th><th>Height<br>m</th><th>People</th><th>Orient.</th><th>Glass<br>m&sup2;</th><th>Roof</th>
      <th>Sensible<br>W</th><th>Latent<br>W</th><th>Fresh air<br>W</th><th>Total<br>W</th>
      <th>TR</th><th>CFM</th><th>ft&sup2;/TR</th>
    </tr>
  </thead>
  <tbody>
    ${roomRows || '<tr><td colspan="18" class="l">No air conditioned rooms.</td></tr>'}
  </tbody>
  <tfoot>
    <tr class="total">
      <td colspan="5" class="l">Total — ${included.length} room(s)</td>
      <td>${fmt(totals.area, 1)}</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>
      <td>${fmt(totals.rsh, 0)}</td><td>${fmt(totals.rlh, 0)}</td>
      <td>${fmt((totals.totalW || 0) - (totals.rsh || 0) - (totals.rlh || 0), 0)}</td>
      <td>${fmt(totals.totalW, 0)}</td>
      <td>${fmt(totals.tr, 2)}</td><td>${fmt(totals.cfm, 0)}</td><td>${fmt(totals.sqftPerTr, 0)}</td>
    </tr>
  </tfoot>
</table>
${skippedNote}

<h2>4. Load summary</h2>
<table>
  <tbody>
    <tr><th class="l">Total cooling load</th><td>${fmt(totals.tr, 2)} TR</td>
        <td class="l">${fmt(totals.totalW, 0)} W = ${fmt((totals.totalW || 0) / 1000, 1)} kW</td></tr>
    <tr><th class="l">Room sensible heat (incl. safety)</th><td>${fmt(totals.rsh, 0)} W</td>
        <td class="l">Room latent heat (incl. safety) ${fmt(totals.rlh, 0)} W</td></tr>
    <tr><th class="l">Supply air quantity</th><td>${fmt(totals.cfm, 0)} CFM</td>
        <td class="l">${fmt((totals.cfm || 0) * 0.000471947, 3)} m&sup3;/s</td></tr>
    <tr><th class="l">Fresh / outdoor air</th><td>${fmt(totals.oaCfm, 0)} CFM</td>
        <td class="l">${fmt((totals.oaCfm || 0) * 0.000471947, 3)} m&sup3;/s</td></tr>
    <tr><th class="l">Conditioned floor area</th><td>${fmt(totals.area, 1)} m&sup2;</td>
        <td class="l">${fmt(totals.areaSqft, 0)} ft&sup2;</td></tr>
    <tr><th class="l">Area per tonne</th><td>${fmt(totals.sqftPerTr, 0)} ft&sup2;/TR</td>
        <td class="l">${fmt(totals.tr ? totals.area / totals.tr : 0, 1)} m&sup2;/TR</td></tr>
  </tbody>
</table>

<h2>5. Level wise subtotal</h2>
<table>
  <thead>
    <tr><th class="l">Level</th><th>Rooms</th><th>Area m&sup2;</th><th>Area ft&sup2;</th>
        <th>TR</th><th>Supply CFM</th><th>Fresh air CFM</th></tr>
  </thead>
  <tbody>
    ${levelRows || '<tr><td colspan="7" class="l">-</td></tr>'}
  </tbody>
  <tfoot>
    <tr class="grand">
      <td class="l">Grand total</td><td>${included.length}</td>
      <td>${fmt(totals.area, 1)}</td><td>${fmt(totals.areaSqft, 0)}</td>
      <td>${fmt(totals.tr, 2)}</td><td>${fmt(totals.cfm, 0)}</td><td>${fmt(totals.oaCfm, 0)}</td>
    </tr>
  </tfoot>
</table>

<h2>6. Important notes</h2>
<div class="notes">
  <strong>This is a simplified estimate. It must be checked by a qualified HVAC engineer before use.</strong>
  <ul>
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
</body>
</html>`;
  return html;
}
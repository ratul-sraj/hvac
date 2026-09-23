// WebHVAC — app state, room table, events, rendering.
// No frameworks, no build step. Plain ES modules.

import {
  COUNTRIES, CLIMATES, ORIENTS, SPACE_TYPES, DEFAULT_PROJECT,
  normalizeRoom, calcRoom, calcProject, guessSpaceType,
} from './calc.js';
import { buildReportHtml, toCsv, fmt, groupByLevel, breakdown, esc, typeLabel } from './report.js';
import { parsePdf } from './pdfparse.js';
import * as pdfjs from '../vendor/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

/* ------------------------------------------------------------------ */
/* state                                                              */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = 'webhvac.state.v1';
const NUM_FIELDS = ['area', 'height', 'people', 'light', 'equip', 'extWall', 'glass', 'partition'];

const state = {
  project: { ...DEFAULT_PROJECT },
  rooms: [],
  warnings: [],
  ui: {
    q: '',
    level: 'all',
    sort: { key: null, dir: 1 },
    openId: null,
    order: [],
    busy: false,
  },
};

const $ = (sel) => document.querySelector(sel);
const el = {
  roomsBody: $('#roomsBody'),
  roomsTable: $('#roomsTable'),
  roomsEmpty: $('#roomsEmpty'),
  roomsCount: $('#roomsCount'),
  summaryCards: $('#summaryCards'),
  levelBody: $('#levelBody'),
  levelTable: $('#levelTable'),
  detailPanel: $('#detailPanel'),
  detailBody: $('#detailBody'),
  filterName: $('#filterName'),
  filterLevel: $('#filterLevel'),
  dropzone: $('#dropzone'),
  fileInput: $('#fileInput'),
  progressBox: $('#progressBox'),
  progressText: $('#progressText'),
  progressFill: $('#progressFill'),
  statusBox: $('#statusBox'),
  warnBox: $('#warnBox'),
  warnList: $('#warnList'),
  warnCount: $('#warnCount'),
  bulkOrient: $('#bulkOrient'),
  bulkRoof: $('#bulkRoof'),
  jsonInput: $('#jsonInput'),
};

const PROJ_FIELDS = [
  ['name', 'text'],
  ['outDb', 'num'], ['outWb', 'num'], ['inDb', 'num'], ['inRh', 'num'],
  ['uWall', 'num'], ['uGlass', 'num'], ['sc', 'num'], ['uRoof', 'num'], ['roofEtd', 'num'],
  ['uPart', 'num'], ['infilAch', 'num'], ['safety', 'num'], ['supplyDt', 'num'], ['wwr', 'num'],
];

const projInput = (key) => document.getElementById('proj-' + key);

/* ------------------------------------------------------------------ */
/* small helpers                                                      */
/* ------------------------------------------------------------------ */

let idSeq = 0;
function newId() {
  idSeq += 1;
  return 'r' + Date.now().toString(36) + idSeq.toString(36);
}

function setStatus(kind, msg) {
  if (!msg) { el.statusBox.classList.add('hidden'); el.statusBox.textContent = ''; return; }
  el.statusBox.className = 'status ' + (kind || '');
  el.statusBox.textContent = msg;
  el.statusBox.classList.remove('hidden');
}

function setProgress(text, pct) {
  if (text === null) { el.progressBox.classList.add('hidden'); return; }
  el.progressBox.classList.remove('hidden');
  el.progressText.textContent = text;
  el.progressFill.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
}

function currentCalc() {
  return calcProject(state.rooms, state.project);
}

/* ------------------------------------------------------------------ */
/* persistence                                                        */
/* ------------------------------------------------------------------ */

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function saveNow() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, project: state.project, rooms: state.rooms }));
  } catch (e) {
    /* storage full or blocked: not fatal */
  }
}

function loadStored() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      if (data.project) {
        state.project = mergeProject(data.project);  // older files have no country -> derived from the city
        state.project.country = inferCountry(state.project);
      }
      if (Array.isArray(data.rooms)) state.rooms = data.rooms.filter((r) => r && typeof r === 'object');
      return true;
    }
  } catch (e) { /* ignore bad data */ }
  return false;
}

/* ------------------------------------------------------------------ */
/* project settings panel                                             */
/* ------------------------------------------------------------------ */

function fillCountrySelect() {
  projInput('country').innerHTML = Object.keys(COUNTRIES)
    .map((c) => `<option value="${esc(c)}">${esc(c)}${c === 'Custom' ? ' (type your own DB / WB)' : ''}</option>`)
    .join('');
}

function citiesOf(country) {
  return Object.keys(COUNTRIES[country] || {}).sort((a, b) => a.localeCompare(b));
}

// Fill the city list for the selected country and keep the stored city if possible.
function fillCitySelect() {
  const country = state.project.country;
  let cities = citiesOf(country);
  if (!cities.length) cities = citiesOf('Custom');
  if (state.project.city && !cities.includes(state.project.city)) cities = cities.concat(state.project.city);
  if (!state.project.city || !cities.includes(state.project.city)) {
    state.project.city = (country === 'India' && cities.includes('Kochi')) ? 'Kochi' : cities[0];
  }
  projInput('city').innerHTML = cities.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  projInput('city').value = state.project.city;
}

// Copy the climate table values of the selected city into the outdoor DB / WB inputs.
function applyClimate() {
  const cl = CLIMATES[state.project.city];
  if (cl && state.project.country !== 'Custom') {
    state.project.outDb = cl.db;
    state.project.outWb = cl.wb;
    projInput('outDb').value = cl.db;
    projInput('outWb').value = cl.wb;
  }
}

// Old saved projects have no country: take it from the flat CLIMATES table (city -> country).
// If a saved country does not contain the saved city, the city wins (the country was changed by hand).
function inferCountry(proj) {
  const list = proj.country ? COUNTRIES[proj.country] : null;
  if (list && list[proj.city]) return proj.country;
  const cl = CLIMATES[proj.city];
  if (cl && COUNTRIES[cl.country]) return cl.country;
  if (list) return proj.country;
  return DEFAULT_PROJECT.country || 'India';
}

// Merge a project loaded from localStorage / a .json file with the defaults.
// A missing country is left undefined so inferCountry() can derive it from the city.
function mergeProject(saved) {
  const p = { ...DEFAULT_PROJECT, ...(saved || {}) };
  if (!saved || !saved.country) delete p.country;
  return p;
}

function syncProjectInputs() {
  for (const [key, kind] of PROJ_FIELDS) {
    const input = projInput(key);
    if (!input) continue;
    input.value = state.project[key] === undefined || state.project[key] === null ? '' : state.project[key];
  }
  state.project.country = inferCountry(state.project);
  projInput('country').value = state.project.country;
  fillCitySelect();
}

function readProjectInput(key, kind) {
  const raw = projInput(key).value;
  if (kind === 'text') {
    state.project[key] = raw;
    return;
  }
  const n = parseFloat(raw);
  state.project[key] = Number.isFinite(n) ? n : DEFAULT_PROJECT[key];
}

// If the user types his own outdoor values, the climate becomes "Custom".
function checkCustomClimate() {
  const cl = CLIMATES[state.project.city];
  if (!cl) return;
  if (Math.abs(cl.db - state.project.outDb) < 0.001 && Math.abs(cl.wb - state.project.outWb) < 0.001) return;
  state.project.country = 'Custom';
  state.project.city = 'Custom';
  projInput('country').value = 'Custom';
  fillCitySelect();
}

/* ------------------------------------------------------------------ */
/* rooms: add / delete / bulk                                         */
/* ------------------------------------------------------------------ */

function sameRoom(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(a.name) === norm(b.name)
    && String(a.level || '') === String(b.level || '')
    && Math.abs((parseFloat(a.area) || 0) - (parseFloat(b.area) || 0)) < 0.05;
}

function addRooms(rooms, opts = {}) {
  let added = 0, skipped = 0;
  for (const src of rooms || []) {
    if (!src || typeof src !== 'object') continue;
    const room = { ...src };
    if (!room.name) room.name = 'Room ' + (state.rooms.length + 1);
    if (!room.id) room.id = newId();
    if (state.rooms.some((r) => r.id === room.id)) room.id = newId();
    if (state.rooms.some((r) => sameRoom(r, room))) { skipped += 1; continue; }
    state.rooms.push(room);
    added += 1;
  }
  return { added, skipped };
}

function deleteRoom(idx) {
  const room = state.rooms[idx];
  if (!room) return;
  if (state.ui.openId === room.id) closeDetail();
  state.rooms.splice(idx, 1);
  renderAll();
  saveSoon();
}

function visibleIndices() {
  const q = state.ui.q.trim().toLowerCase();
  const lvl = state.ui.level;
  const idc = [];
  state.rooms.forEach((r, i) => {
    const rn = normalizeRoom(r, state.project);
    if (lvl !== 'all' && ((rn.level || '').trim() || 'Unspecified') !== lvl) return;
    if (q && !String(rn.name || '').toLowerCase().includes(q)) return;
    idc.push(i);
  });
  return idc;
}

function sortedIndices(calc) {
  const list = visibleIndices();
  const { key, dir } = state.ui.sort;
  if (!key) return list;
  const val = (i) => {
    const r = calc.results[i], room = r.room;
    switch (key) {
      case 'include': return room.include ? 1 : 0;
      case 'roof': return room.roof ? 1 : 0;
      case 'name': return String(room.name || '').toLowerCase();
      case 'level': return String(room.level || '').toLowerCase();
      case 'number': return String(room.number || '');
      case 'type': return typeLabel(room.type).toLowerCase();
      case 'orient': return String(room.orient || '');
      case 'sensible': return r.rsh;
      case 'latent': return r.rlh;
      case 'total': return r.totalW;
      case 'tr': return r.tr;
      case 'cfm': return r.cfm;
      case 'sqftPerTr': return r.sqftPerTr;
      default: return parseFloat(room[key]) || 0;
    }
  };
  return list.sort((a, b) => {
    const va = val(a), vb = val(b);
    let c;
    if (typeof va === 'number' && typeof vb === 'number') c = va - vb;
    else c = String(va).localeCompare(String(vb), undefined, { numeric: true });
    return c * dir;
  });
}

/* ------------------------------------------------------------------ */
/* table rendering                                                    */
/* ------------------------------------------------------------------ */

function defaultText(key, rn) {
  switch (key) {
    case 'area': return rn.area ? fmt(rn.area, 2) : '';
    case 'height': return fmt(rn.height, 2);
    case 'people': return String(rn.people);
    case 'light': return String(rn.light);
    case 'equip': return String(rn.equip);
    case 'extWall': return fmt(rn.extWall, 2);
    case 'glass': return fmt(rn.glass, 2);
    case 'partition': return '0';
    default: return '';
  }
}

function numInput(room, field, rn, label) {
  const v = room[field];
  const val = v === undefined || v === null ? '' : String(v);
  return `<input type="text" inputmode="decimal" data-field="${field}" value="${esc(val)}"
    placeholder="${esc(defaultText(field, rn))}" aria-label="${esc(label)}">`;
}

function rowHtml(idx, calc) {
  const r = calc.results[idx];
  const room = r.room;            // normalised values (defaults filled in)
  const raw = state.rooms[idx];   // only what the user / parser set
  const inc = room.include !== false;
  const nm = room.name || 'room';
  return `<tr data-idx="${idx}" data-id="${esc(raw.id)}" class="clickable${inc ? '' : ' excluded'}">
    <td class="c-include"><input type="checkbox" data-field="include" ${inc ? 'checked' : ''}
      aria-label="Include ${esc(nm)} in the load"></td>
    <td class="l c-lv"><input type="text" data-field="level" value="${esc(raw.level || '')}"
      placeholder="-" aria-label="Level of ${esc(nm)}"></td>
    <td class="c-num"><input type="text" data-field="number" value="${esc(raw.number || '')}"
      placeholder="-" aria-label="Room number of ${esc(nm)}"></td>
    <td class="l c-name"><input type="text" data-field="name" value="${esc(raw.name || '')}"
      placeholder="Room name" aria-label="Room name"></td>
    <td class="c-type"><select data-field="type" aria-label="Space type of ${esc(nm)}">
      ${Object.keys(SPACE_TYPES).map((k) =>
        `<option value="${k}"${room.type === k ? ' selected' : ''}>${esc(SPACE_TYPES[k].label)}</option>`).join('')}
    </select></td>
    <td class="c-num">${numInput(raw, 'area', room, 'Area m2 of ' + nm)}</td>
    <td class="c-num">${numInput(raw, 'height', room, 'Height m of ' + nm)}</td>
    <td class="c-num">${numInput(raw, 'people', room, 'People in ' + nm)}</td>
    <td class="c-num">${numInput(raw, 'light', room, 'Lighting W/m2 of ' + nm)}</td>
    <td class="c-num">${numInput(raw, 'equip', room, 'Equipment W/m2 of ' + nm)}</td>
    <td><select data-field="orient" aria-label="Orientation of ${esc(nm)}">
      ${ORIENTS.map((o) => `<option value="${o}"${room.orient === o ? ' selected' : ''}>${o}</option>`).join('')}
    </select></td>
    <td class="c-num">${numInput(raw, 'extWall', room, 'External wall m2 of ' + nm)}</td>
    <td class="c-num">${numInput(raw, 'glass', room, 'Glass m2 of ' + nm)}</td>
    <td class="c-include"><input type="checkbox" data-field="roof" ${room.roof ? 'checked' : ''}
      aria-label="${esc(nm)} has an exposed roof"></td>
    <td class="c-num">${numInput(raw, 'partition', room, 'Partition m2 of ' + nm)}</td>
    <td class="res v-sensible">${fmt(r.rsh, 0)}</td>
    <td class="res v-latent">${fmt(r.rlh, 0)}</td>
    <td class="res hi v-total">${fmt(r.totalW, 0)}</td>
    <td class="res hi v-tr">${fmt(r.tr, 2)}</td>
    <td class="res v-cfm">${fmt(r.cfm, 0)}</td>
    <td class="res v-sqftPerTr">${fmt(r.sqftPerTr, 0)}</td>
    <td class="c-del"><button type="button" class="btn-del" data-act="del"
      title="Delete ${esc(nm)}" aria-label="Delete ${esc(nm)}">&times;</button></td>
  </tr>`;
}

function renderTable() {
  const calc = currentCalc();
  state.ui.order = sortedIndices(calc);
  if (!state.rooms.length) {
    el.roomsBody.innerHTML = '';
    el.roomsEmpty.classList.remove('hidden');
    el.roomsCount.textContent = '';
    return;
  }
  el.roomsEmpty.classList.add('hidden');
  el.roomsBody.innerHTML = state.ui.order.map((i) => rowHtml(i, calc)).join('');

  const inc = state.rooms.filter((r) => normalizeRoom(r, state.project).include !== false).length;
  const shown = state.ui.order.length;
  el.roomsCount.textContent =
    `${shown} shown of ${state.rooms.length} room(s) | ${inc} included in the load`;
}

function renderSortHeaders() {
  el.roomsTable.querySelectorAll('th[data-sort]').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === state.ui.sort.key) {
      th.classList.add(state.ui.sort.dir === 1 ? 'sort-asc' : 'sort-desc');
    }
  });
}

/* update only the computed cells + placeholders (keeps focus while typing) */
function updateLive() {
  const calc = currentCalc();
  el.roomsBody.querySelectorAll('tr').forEach((tr) => {
    const idx = parseInt(tr.dataset.idx, 10);
    const r = calc.results[idx];
    if (!r) return;
    const raw = state.rooms[idx];
    tr.querySelector('.v-sensible').textContent = fmt(r.rsh, 0);
    tr.querySelector('.v-latent').textContent = fmt(r.rlh, 0);
    tr.querySelector('.v-total').textContent = fmt(r.totalW, 0);
    tr.querySelector('.v-tr').textContent = fmt(r.tr, 2);
    tr.querySelector('.v-cfm').textContent = fmt(r.cfm, 0);
    tr.querySelector('.v-sqftPerTr').textContent = fmt(r.sqftPerTr, 0);
    for (const f of NUM_FIELDS) {
      const inp = tr.querySelector(`input[data-field="${f}"]`);
      if (inp) inp.placeholder = defaultText(f, r.room);
    }
    // keep the two dropdowns in step with the guessed defaults while nothing was chosen by hand
    const typeSel = tr.querySelector('select[data-field="type"]');
    if (typeSel && raw.type === undefined) typeSel.value = r.room.type;
    const orSel = tr.querySelector('select[data-field="orient"]');
    if (orSel && raw.orient === undefined) orSel.value = r.room.orient;
    tr.classList.toggle('excluded', r.room.include === false);
    if (raw && r.room.include !== false) {
      const cb = tr.querySelector('input[data-field="include"]');
      if (cb) cb.checked = true;
    }
  });
  renderSummary(calc);
  if (state.ui.openId) renderDetail(calc);
}

/* ------------------------------------------------------------------ */
/* summary                                                            */
/* ------------------------------------------------------------------ */

function card(k, v, unit, hero) {
  return `<div class="scard${hero ? ' hero' : ''}"><div class="k">${esc(k)}</div>
    <div class="v">${v}${unit ? ` <small>${esc(unit)}</small>` : ''}</div></div>`;
}

function renderSummary(calc) {
  const t = calc.totals;
  el.summaryCards.innerHTML = [
    card('Total cooling load', fmt(t.tr, 2), 'TR', true),
    card('Total heat', fmt(t.totalW, 0), 'W', true),
    card('Supply air', fmt(t.cfm, 0), 'CFM'),
    card('Fresh / outdoor air', fmt(t.oaCfm, 0), 'CFM'),
    card('Conditioned area', fmt(t.area, 1), 'm²'),
    card('Area', fmt(t.areaSqft, 0), 'ft²'),
    card('Area per tonne', fmt(t.sqftPerTr, 0), 'ft²/TR'),
    card('Rooms included', String(t.rooms), ''),
    card('Room sensible heat', fmt(t.rsh, 0), 'W'),
    card('Room latent heat', fmt(t.rlh, 0), 'W'),
  ].join('');

  const levels = groupByLevel(calc.results);
  el.levelBody.innerHTML = levels.length
    ? levels.map((g) => `<tr>
        <td class="l">${esc(g.level)}</td>
        <td>${g.rooms}</td>
        <td>${fmt(g.area, 1)}</td>
        <td>${fmt(g.areaSqft, 0)}</td>
        <td>${fmt(g.tr, 2)}</td>
        <td>${fmt(g.cfm, 0)}</td>
        <td>${fmt(g.oaCfm, 0)}</td>
        <td>${fmt(g.tr ? g.areaSqft / g.tr : 0, 0)}</td>
      </tr>`).join('') +
      `<tr class="total-row">
        <td class="l">Total</td><td>${t.rooms}</td><td>${fmt(t.area, 1)}</td><td>${fmt(t.areaSqft, 0)}</td>
        <td>${fmt(t.tr, 2)}</td><td>${fmt(t.cfm, 0)}</td><td>${fmt(t.oaCfm, 0)}</td>
        <td>${fmt(t.sqftPerTr, 0)}</td>
      </tr>`
    : '<tr><td class="l" colspan="8">No rooms included yet.</td></tr>';
}

/* ------------------------------------------------------------------ */
/* detail breakdown                                                   */
/* ------------------------------------------------------------------ */

function renderDetail(calc) {
  const idx = state.rooms.findIndex((r) => r.id === state.ui.openId);
  if (idx < 0) { closeDetail(); return; }
  const r = calc.results[idx];
  const room = r.room;
  const area = parseFloat(room.area) || 0;
  const base = r.totalW || 1;
  const rows = breakdown(r);
  const max = Math.max(...rows.map((x) => Math.abs(x.w)), 1);

  const groups = ['Sensible', 'Latent', 'Safety', 'Fresh air'];
  let body = '';
  for (const g of groups) {
    const list = rows.filter((x) => x.group === g);
    if (!list.length) continue;
    body += `<div class="bd-group"><h3>${esc(g)}</h3>` + list.map((x) => {
      const pct = (x.w / base) * 100;
      const width = Math.abs(x.w) / max * 100;
      return `<div class="bd-row">
        <div class="lbl">${esc(x.label)}</div>
        <div class="w">${fmt(x.w, 0)} W</div>
        <div class="bd-bar"><div class="s-${g.replace(' ', '')}" style="width:${width.toFixed(1)}%"></div></div>
        <div class="pct">${fmt(pct, 1)}%</div>
      </div>`;
    }).join('') + '</div>';
  }

  el.detailBody.innerHTML = `
    <div class="bd-head">
      <div class="bd-title">${esc(room.name || 'Room')}</div>
      <div class="bd-meta">
        ${esc((room.level || 'Unspecified'))} &middot; ${esc(typeLabel(room.type))} &middot;
        ${fmt(area, 1)} m&sup2; (${fmt(area * 10.7639, 0)} ft&sup2;) &middot;
        height ${fmt(room.height, 2)} m &middot;
        ${fmt(room.people, 0)} people &middot; ${esc(room.orient)} facing &middot;
        glass ${fmt(room.glass, 1)} m&sup2; ${room.roof ? '&middot; roof exposed' : ''}
        ${room.include === false ? '&middot; <strong>excluded from totals</strong>' : ''}
      </div>
    </div>
    <div class="bd-total">
      <div><div class="k">Cooling load</div><div class="v">${fmt(r.tr, 2)} TR</div></div>
      <div><div class="k">Total heat</div><div class="v">${fmt(r.totalW, 0)} W</div></div>
      <div><div class="k">Supply air</div><div class="v">${fmt(r.cfm, 0)} CFM</div></div>
      <div><div class="k">Fresh air</div><div class="v">${fmt(r.oaCfm, 0)} CFM</div></div>
      <div><div class="k">SHF</div><div class="v">${fmt(r.shf, 2)}</div></div>
      <div><div class="k">Area / tonne</div><div class="v">${fmt(r.sqftPerTr, 0)} ft&sup2;/TR</div></div>
    </div>
    ${body}
    <div class="bd-row bd-total-row">
      <div class="lbl">Total cooling load</div>
      <div class="w">${fmt(r.totalW, 0)} W</div>
      <div></div>
      <div class="pct">100%</div>
    </div>
    <p class="bd-note">
      Bar length is scaled to the biggest component; the percentage is the share of the total load.
      "Safety factor" is the extra allowance on the room sensible and latent heat
      (${fmt(state.project.safety, 0)}% in the project settings).
    </p>`;
}

function openDetail(id) {
  state.ui.openId = id;
  el.detailPanel.classList.remove('hidden');
  el.roomsBody.querySelectorAll('tr').forEach((tr) =>
    tr.classList.toggle('selected', tr.dataset.id === id));
  renderDetail(currentCalc());
  el.detailPanel.scrollIntoView({ block: 'nearest' });
}

function closeDetail() {
  state.ui.openId = null;
  el.detailPanel.classList.add('hidden');
  el.roomsBody.querySelectorAll('tr').forEach((tr) => tr.classList.remove('selected'));
}

/* ------------------------------------------------------------------ */
/* edit events                                                        */
/* ------------------------------------------------------------------ */

function onTableInput(ev) {
  const t = ev.target;
  const field = t.dataset.field;
  if (!field) return;
  const tr = t.closest('tr');
  const idx = parseInt(tr.dataset.idx, 10);
  const room = state.rooms[idx];
  if (!room) return;

  if (field === 'include' || field === 'roof') {
    room[field] = t.checked;
  } else if (field === 'type') {
    const guess = guessSpaceType(room.name);
    if (t.value === guess) delete room.type; else room.type = t.value;
  } else if (field === 'orient') {
    room.orient = t.value;
  } else {
    const v = t.value.trim();
    if (v === '') delete room[field]; else room[field] = v;
  }
  saveSoon();
  if (field === 'include' || field === 'roof' || field === 'type') renderAll();
  else { updateLive(); if (field === 'name') renderFilters(); }
}

function onTableClick(ev) {
  const tr = ev.target.closest('tr[data-idx]');
  if (!tr) return;
  const idx = parseInt(tr.dataset.idx, 10);

  if (ev.target.dataset.act === 'del') {
    ev.stopPropagation();
    deleteRoom(idx);
    return;
  }
  if (ev.target.matches('input, select, button, option, label')) return;
  const id = tr.dataset.id;
  if (state.ui.openId === id) closeDetail(); else openDetail(id);
}

/* ------------------------------------------------------------------ */
/* filters, sorting, bulk                                             */
/* ------------------------------------------------------------------ */

function renderFilters() {
  const levels = [...new Set(state.rooms.map((r) => {
    const n = normalizeRoom(r, state.project);
    return (n.level || '').trim() || 'Unspecified';
  }))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const cur = state.ui.level;
  el.filterLevel.innerHTML = '<option value="all">All levels</option>' +
    levels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
  if (levels.includes(cur)) el.filterLevel.value = cur; else { state.ui.level = 'all'; el.filterLevel.value = 'all'; }
}

function bulkTargets() {
  return state.ui.order.length ? state.ui.order : visibleIndices();
}

function onHeaderClick(ev) {
  const th = ev.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  const s = state.ui.sort;
  if (s.key !== key) { s.key = key; s.dir = 1; }
  else if (s.dir === 1) { s.dir = -1; }
  else { s.key = null; s.dir = 1; }
  renderAll();
}

/* ------------------------------------------------------------------ */
/* render all                                                         */
/* ------------------------------------------------------------------ */

function renderAll() {
  renderFilters();
  renderTable();
  renderSortHeaders();
  renderSummary(currentCalc());
}

// Everything that must be refreshed after a project setting changed.
function afterProjectChange() {
  if (state.rooms.length) {
    renderTable();
    renderSortHeaders();
  }
  renderSummary(currentCalc());
  if (state.ui.openId) renderDetail(currentCalc());
  saveSoon();
}

/* ------------------------------------------------------------------ */
/* PDF upload                                                         */
/* ------------------------------------------------------------------ */

// pdfparse.js calls onProgress(page, total) (see the pdfparse contract).
function onParseProgress(info, fileName, fileIdx, fileCount, total2) {
  let page = 0, pages = 0, phase = 'reading';
  if (typeof info === 'number') {
    page = info;
    pages = Number(total2) || 0;
  } else if (info && typeof info === 'object') {
    page = info.page || info.pageNumber || info.num || 0;
    pages = info.pages || info.pageCount || info.total || 0;
    phase = info.phase || info.status || info.stage || 'reading';
  }
  const pct = pages ? (100 * page) / pages : (page ? 15 : 5);
  setProgress(
    `File ${fileIdx + 1} of ${fileCount}: ${fileName} — ${phase} ${page ? `page ${page}` : ''}${pages ? ` of ${pages}` : ''}`.replace(/\s+/g, ' '),
    pct,
  );
}

async function parseOne(arrayBuffer, fileName, fileIdx, fileCount) {
  return parsePdf(arrayBuffer, {
    pdfjs,
    onProgress: (page, total) => onParseProgress(page, fileName, fileIdx, fileCount, total),
  });
}

function pushWarnings(list) {
  if (!list || !list.length) return;
  state.warnings = state.warnings.concat(list);
  el.warnBox.classList.remove('hidden');
  el.warnCount.textContent = String(state.warnings.length);
  el.warnList.innerHTML = state.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
}

async function handleFiles(fileList) {
  if (state.ui.busy) return;
  const files = [...fileList].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) {
    setStatus('err', 'No PDF file found. Please choose a .pdf drawing file.');
    return;
  }
  state.ui.busy = true;
  el.dropzone.classList.add('busy');
  setStatus(null);
  let added = 0, skipped = 0, failed = 0;
  const notes = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    setProgress(`File ${i + 1} of ${files.length}: ${f.name} — opening`, 3);
    try {
      const buf = await f.arrayBuffer();
      const out = await parseOne(buf, f.name, i, files.length);
      const res = addRooms(out.rooms);
      added += res.added;
      skipped += res.skipped;
      if (out.warnings && out.warnings.length) {
        pushWarnings(out.warnings.map((w) => `${f.name}: ${w}`));
      }
      notes.push(`${f.name}: ${res.added} room(s)${out.pages ? ` from ${out.pages} page(s)` : ''}`);
    } catch (err) {
      failed += 1;
      const msg = (err && err.message) ? err.message : String(err);
      pushWarnings([`${f.name}: could not be read — ${msg}`]);
      notes.push(`${f.name}: FAILED`);
    }
  }

  state.ui.busy = false;
  el.dropzone.classList.remove('busy');
  setProgress(null);
  renderAll();
  saveSoon();

  const parts = [`${added} room(s) added`];
  if (skipped) parts.push(`${skipped} looked like duplicates and were skipped`);
  if (failed) parts.push(`${failed} file(s) could not be read`);
  setStatus(failed && !added ? 'err' : (failed || skipped ? 'warn' : 'ok'),
    `${parts.join(', ')}. ${notes.join(' | ')}`);
}

async function loadSample() {
  if (state.ui.busy) return;
  state.ui.busy = true;
  setStatus(null);
  setProgress('Downloading the sample drawing ...', 5);
  const paths = ['samples/headquarters.pdf', 'tests/samples/headquarters.pdf'];
  let buf = null, used = '';
  let lastErr = null;
  for (const path of paths) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      buf = await res.arrayBuffer();
      used = path;
      break;
    } catch (err) { lastErr = err; }
  }
  if (!buf) {
    setProgress(null);
    state.ui.busy = false;
    setStatus('warn',
      'Could not load the sample drawing (samples/headquarters.pdf). ' +
      'This is normal if the file is not present. Please upload your own PDF or use "Add room manually". ' +
      `(${(lastErr && lastErr.message) || lastErr})`);
    return;
  }
  try {
    setProgress(`Reading ${used} ...`, 15);
    const out = await parseOne(buf, used, 0, 1);
    const r = addRooms(out.rooms);
    if (out.warnings && out.warnings.length) pushWarnings(out.warnings);
    setProgress(null);
    renderAll();
    saveSoon();
    setStatus('ok', r.added
      ? `Sample drawing loaded: ${r.added} room(s) added${r.skipped ? `, ${r.skipped} duplicate(s) skipped` : ''}. Please check the areas.`
      : 'The sample drawing was read but no rooms were found. Please add rooms manually.');
  } catch (err) {
    setProgress(null);
    setStatus('err', `The sample drawing could not be read (${(err && err.message) || err}).`);
  } finally {
    state.ui.busy = false;
  }
}

/* ------------------------------------------------------------------ */
/* export / import                                                    */
/* ------------------------------------------------------------------ */

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function safeName() {
  return String(state.project.name || 'webhvac').replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '') || 'webhvac';
}

function exportCsv() {
  if (!state.rooms.length) { setStatus('warn', 'There are no rooms to export yet.'); return; }
  download(safeName() + '-cooling-load.csv', toCsv(state.project, currentCalc()), 'text/csv;charset=utf-8');
  setStatus('ok', 'CSV downloaded.');
}

function printReport() {
  if (!state.rooms.length) { setStatus('warn', 'There are no rooms to report yet.'); return; }
  const html = buildReportHtml(state.project, currentCalc());
  const w = window.open('', '_blank');
  if (!w) {
    setStatus('err', 'The report window was blocked. Please allow pop-ups for this page and try again.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch (e) { /* user can press the button */ } }, 500);
  setStatus('ok', 'Report opened in a new window. Use "Print / Save as PDF" there.');
}

function saveProjectFile() {
  download(safeName() + '.json',
    JSON.stringify({ app: 'WebHVAC', v: 1, savedAt: new Date().toISOString(), project: state.project, rooms: state.rooms }, null, 2),
    'application/json');
  setStatus('ok', 'Project file saved.');
}

function openProjectFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      const rooms = Array.isArray(data.rooms) ? data.rooms : (Array.isArray(data) ? data : null);
      if (!rooms) throw new Error('no rooms list in this file');
      state.project = mergeProject(data.project);
      state.rooms = rooms.filter((r) => r && typeof r === 'object');
      state.ui.sort = { key: null, dir: 1 };
      state.ui.level = 'all';
      state.ui.q = '';
      el.filterName.value = '';
      closeDetail();
      syncProjectInputs();
      renderAll();
      saveNow();
      setStatus('ok', `Project opened: ${state.rooms.length} room(s).`);
    } catch (err) {
      setStatus('err', `Could not open this file as a WebHVAC project (${(err && err.message) || err}).`);
    }
  };
  reader.onerror = () => setStatus('err', 'Could not read the file.');
  reader.readAsText(file);
}

/* ------------------------------------------------------------------ */
/* wiring                                                             */
/* ------------------------------------------------------------------ */

function wire() {
  // project inputs
  for (const [key, kind] of PROJ_FIELDS) {
    const input = projInput(key);
    if (!input) continue;
    input.addEventListener('input', () => {
      readProjectInput(key, kind);
      if (key === 'outDb' || key === 'outWb') checkCustomClimate();
      afterProjectChange();
    });
  }

  projInput('country').addEventListener('change', () => {
    state.project.country = projInput('country').value;
    const cities = citiesOf(state.project.country);
    if (state.project.country === 'Custom') state.project.city = 'Custom';
    else if (state.project.country === 'India' && cities.includes('Kochi')) state.project.city = 'Kochi';
    else state.project.city = cities[0];
    fillCitySelect();
    applyClimate();
    afterProjectChange();
    setStatus('ok', `Climate changed to ${state.project.country} — ${state.project.city}. Outdoor ${state.project.outDb}°C DB / ${state.project.outWb}°C WB.`);
  });

  projInput('city').addEventListener('change', () => {
    state.project.city = projInput('city').value;
    applyClimate();
    afterProjectChange();
  });

  $('#btnResetProject').addEventListener('click', () => {
    state.project = { ...DEFAULT_PROJECT };
    syncProjectInputs();
    renderAll();
    if (state.ui.openId) renderDetail(currentCalc());
    saveSoon();
    setStatus('ok', 'Design conditions reset to the default values.');
  });

  // upload
  el.dropzone.addEventListener('click', () => el.fileInput.click());
  el.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
  });
  el.fileInput.addEventListener('change', () => {
    if (el.fileInput.files && el.fileInput.files.length) handleFiles(el.fileInput.files);
    el.fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) => el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); el.dropzone.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); el.dropzone.classList.remove('over');
  }));
  el.dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) handleFiles(dt.files);
  });
  // also allow dropping anywhere on the page
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.target.closest('#dropzone')) return;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  $('#btnSample').addEventListener('click', loadSample);

  $('#btnManual').addEventListener('click', () => {
    const room = { id: newId(), name: 'New Room', level: state.ui.level === 'all' ? '' : state.ui.level, area: 20, height: 3, type: 'office', include: true, source: 'manual' };
    state.rooms.push(room);
    state.ui.q = '';
    el.filterName.value = '';
    if (state.ui.level !== 'all') { /* keep the level filter as the user set it */ }
    renderAll();
    saveSoon();
    const tr = el.roomsBody.querySelector(`tr[data-id="${room.id}"]`);
    if (tr) {
      tr.scrollIntoView({ block: 'center' });
      const inp = tr.querySelector('input[data-field="name"]');
      if (inp) { inp.focus(); inp.select(); }
    }
    openDetail(room.id);
  });

  $('#btnClear').addEventListener('click', () => {
    if (!state.rooms.length) { setStatus('warn', 'The room list is already empty.'); return; }
    if (!window.confirm(`Delete all ${state.rooms.length} room(s)? This cannot be undone.`)) return;
    state.rooms = [];
    state.warnings = [];
    el.warnBox.classList.add('hidden');
    closeDetail();
    renderAll();
    saveNow();
    setStatus('ok', 'All rooms cleared.');
  });

  // table
  el.roomsBody.addEventListener('input', onTableInput);
  el.roomsBody.addEventListener('change', onTableInput);
  el.roomsBody.addEventListener('click', onTableClick);
  el.roomsTable.querySelector('thead').addEventListener('click', onHeaderClick);

  // filters
  el.filterName.addEventListener('input', () => {
    state.ui.q = el.filterName.value;
    renderTable();
    renderSortHeaders();
  });
  el.filterLevel.addEventListener('change', () => {
    state.ui.level = el.filterLevel.value;
    renderTable();
    renderSortHeaders();
  });

  el.bulkOrient.innerHTML = '<option value="">-- choose --</option>' +
    ORIENTS.map((o) => `<option value="${o}">${o}</option>`).join('');

  $('#btnIncludeAll').addEventListener('click', () => {
    bulkTargets().forEach((i) => { state.rooms[i].include = true; });
    renderAll(); saveSoon();
    setStatus('ok', 'All shown rooms are now included in the load.');
  });
  $('#btnIncludeNone').addEventListener('click', () => {
    bulkTargets().forEach((i) => { state.rooms[i].include = false; });
    renderAll(); saveSoon();
    setStatus('ok', 'All shown rooms are now excluded from the load.');
  });
  $('#btnBulkOrient').addEventListener('click', () => {
    const v = el.bulkOrient.value;
    if (!v) { setStatus('warn', 'Choose an orientation first.'); return; }
    const t = bulkTargets();
    if (!t.length) { setStatus('warn', 'No rows are shown. Change the filters.'); return; }
    t.forEach((i) => { state.rooms[i].orient = v; });
    renderAll(); saveSoon();
    setStatus('ok', `Orientation ${v} applied to ${t.length} room(s).`);
  });
  $('#btnBulkRoof').addEventListener('click', () => {
    const v = el.bulkRoof.value;
    if (!v) { setStatus('warn', 'Choose yes or no for the roof first.'); return; }
    const t = bulkTargets();
    if (!t.length) { setStatus('warn', 'No rows are shown. Change the filters.'); return; }
    t.forEach((i) => { state.rooms[i].roof = v === 'yes'; });
    renderAll(); saveSoon();
    setStatus('ok', `Roof set to "${v === 'yes' ? 'has roof' : 'no roof'}" for ${t.length} room(s).`);
  });

  // detail
  $('#btnCloseDetail').addEventListener('click', closeDetail);

  // export / import
  $('#btnCsv').addEventListener('click', exportCsv);
  $('#btnCsv2').addEventListener('click', exportCsv);
  $('#btnPrint').addEventListener('click', printReport);
  $('#btnPrint2').addEventListener('click', printReport);
  $('#btnSave').addEventListener('click', saveProjectFile);
  $('#btnOpen').addEventListener('click', () => el.jsonInput.click());
  el.jsonInput.addEventListener('change', () => {
    if (el.jsonInput.files && el.jsonInput.files[0]) openProjectFile(el.jsonInput.files[0]);
    el.jsonInput.value = '';
  });

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
}

/* ------------------------------------------------------------------ */
/* start                                                              */
/* ------------------------------------------------------------------ */

function start() {
  fillCountrySelect();
  const restored = loadStored();
  syncProjectInputs();
  wire();
  renderAll();
  if (restored && state.rooms.length) {
    setStatus('ok', `Restored your last work from this browser: ${state.rooms.length} room(s).`);
  } else {
    setStatus(null);
  }
}

start();

/* keep a couple of internals reachable for quick console debugging */
window.webhvac = { state, currentCalc, renderAll, addRooms, buildReportHtml, toCsv, calcRoom, normalizeRoom };
// LoadLens — app state, room table, events, rendering.
// No frameworks, no build step. Plain ES modules.

import {
  COUNTRIES, CLIMATES, ORIENTS, SPACE_TYPES, DEFAULT_PROJECT,
  normalizeRoom, calcRoom, calcProject, guessSpaceType,
} from './calc.js';
import { buildReportHtml, toCsv, fmt, groupByLevel, breakdown, esc, typeLabel } from './report.js';
import { parsePdf } from './pdfparse.js';
import * as pdfjs from '../vendor/pdf.min.mjs';
import {
  roomFromRect, areaFromRect, dimsFromRect, round2, isDrawnRoom,
  rectFromLabel, isPlacedRoom,
  DRAWING_SCALES, DEFAULT_SCALE_DENOM,
} from './planview.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

/* ------------------------------------------------------------------ */
/* the two new readers: room schedules (js/schedule.js) and OCR        */
/* (js/ocr.js). Both are loaded on demand, NOT with a top-level        */
/* static import:                                                      */
/*   1. a browser that never ticks the OCR box must never download     */
/*      the tesseract wasm (the spec asks for that);                   */
/*   2. if one of those two files is not in this build yet, the page   */
/*      still loads and the upload panel says so instead of dying.     */
/* Nothing is requested until a schedule file is dropped or the box    */
/* is ticked.                                                          */
/* ------------------------------------------------------------------ */

const MISSING_SCHEDULE = 'the room-schedule reader (js/schedule.js) is not in this build';
const MISSING_OCR = 'the OCR reader (js/ocr.js) is not in this build';
const MISSING_TRACE = 'the outline tracer (js/trace.js) is not in this build';

// vendored tesseract files, served from the site (no CDN at runtime)
const OCR_VENDOR = new URL('../vendor/tesseract/', import.meta.url).href;

let scheduleMod = null, scheduleTried = false;
let ocrMod = null, ocrTried = false;
let traceMod = null, traceTried = false;

async function loadScheduleModule() {
  if (!scheduleMod && !scheduleTried) {
    scheduleTried = true;
    try { scheduleMod = await import('./schedule.js'); } catch (e) { scheduleMod = null; }
  }
  if (!scheduleMod || typeof scheduleMod.parseSchedule !== 'function') throw new Error(MISSING_SCHEDULE);
  return scheduleMod;
}

async function loadOcrModule() {
  if (!ocrMod && !ocrTried) {
    ocrTried = true;
    try { ocrMod = await import('./ocr.js'); } catch (e) { ocrMod = null; }
  }
  if (!ocrMod || typeof ocrMod.ocrPdf !== 'function') throw new Error(MISSING_OCR);
  return ocrMod;
}

/** js/trace.js — pure geometry: the plan's vector paths -> real room outlines. Loaded on demand like
 *  the widgets above, so a build without it still runs the calculator (the plan panel is an
 *  enhancement, and the outline tracer is an enhancement INSIDE it). */
async function loadTraceModule() {
  if (!traceMod && !traceTried) {
    traceTried = true;
    try { traceMod = await import('./trace.js'); } catch (e) { traceMod = null; }
  }
  if (!traceMod || typeof traceMod.traceRooms !== 'function') throw new Error(MISSING_TRACE);
  return traceMod;
}

/* ------------------------------------------------------------------ */
/* state                                                              */
/* ------------------------------------------------------------------ */

// KEEP the old brand in this key: renaming it would throw away every user's saved project.
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
  // Filled once on load by probeServer(): is the Express server (server.js) there?
  server: { available: false, version: null, checked: false },
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
  parseWhere: $('#parseWhere'),
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
  ocrCheck: $('#chkOcr'),
  ocrOption: $('#ocrOption'),
  planCard: $('#planCard'),
  planView: $('#planView'),
  planPage: $('#planPage'),
  planPages: $('#planPages'),
  planPrev: $('#planPrev'),
  planNext: $('#planNext'),
  planZoomIn: $('#planZoomIn'),
  planZoomOut: $('#planZoomOut'),
  planZoomPct: $('#planZoomPct'),
  planFit: $('#planFit'),
  planScale: $('#planScale'),
  planModeDraw: $('#planModeDraw'),
  planModeSelect: $('#planModeSelect'),
  planPlaceAll: $('#planPlaceAll'),
  planPlaceClear: $('#planPlaceClear'),
  planTraceOutlines: $('#planTraceOutlines'),
  planTraceClear: $('#planTraceClear'),
  planHint: $('#planHint'),
  reportView: $('#reportView'),
  reportFrame: $('#reportFrame'),
  reportPrint: $('#reportPrint'),
  reportClose: $('#reportClose'),
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
      case 'source': return String(room.source || '').toLowerCase();
      case 'sensible': return r.rsh;
      case 'latent': return r.rlh;
      case 'total': return r.totalW;
      case 'tr': return r.tr;
      case 'ls': return r.supplyLs;
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

// Where a row came from, in plain words. Anything unknown shows nothing.
const SOURCE_LABEL = {
  schedule: 'CSV/Excel',
  ocr: 'OCR',
  label: 'PDF',
  table: 'PDF',
  pdf: 'PDF',
  manual: 'manual',
};

function sourceLabel(src) {
  return SOURCE_LABEL[String(src || '').toLowerCase()] || '';
}

/** The little badge that says what shape this room has on the plan: a real outline traced from the
 *  drawing's own linework, or a box (placed locator or hand-drawn). Nothing when it has neither.
 *  The title spells out traced-vs-stated, because that difference is the whole point of the trace. */
function shapeBadge(raw) {
  const hasPoly = !!(raw && Array.isArray(raw.poly) && raw.poly.length > 2);
  const hasRect = !!(raw && raw.rect);
  if (hasPoly) {
    const traced = Number(raw.polyArea), stated = Number(raw.area);
    const title = Number.isFinite(traced) && traced > 0 && Number.isFinite(stated) && stated > 0
      ? `outline traced from the drawing: ${fmt(traced, 1)} m² traced against ${fmt(stated, 1)} m² stated`
      : 'outline traced from the drawing';
    return ` <span class="row-badge is-outline" title="${esc(title)}">outline</span>`;
  }
  if (hasRect) {
    const title = isPlacedRoom(raw)
      ? 'box placed where the plan names the room, sized back from the stated area'
      : 'box drawn on the plan';
    return ` <span class="row-badge is-box" title="${esc(title)}">box</span>`;
  }
  return '';
}

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
      placeholder="Room name" aria-label="Room name">${shapeBadge(raw)}</td>
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
    <td class="res v-ls">${fmt(r.supplyLs, 0)}</td>
    <td class="res v-sqftPerTr">${fmt(r.sqftPerTr, 0)}</td>
    <td class="c-src" title="Where this room came from">${esc(sourceLabel(raw.source))}</td>
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
/** Refresh everything an in-table edit can change EXCEPT the table itself — rebuilding that would
 *  take the caret out of the cell the user is typing in, which is why this exists next to renderAll().
 *  That includes the parts of the screen that show the same room: the summary cards, the open room's
 *  description under the table, and the room's box label on the drawing. The drawing one was missing,
 *  so renaming a room left its box on the plan still labelled with the old name. */
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
    tr.querySelector('.v-ls').textContent = fmt(r.supplyLs, 0);
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
  // the box label on the plan is drawn from room.name, so it has to be redrawn too — otherwise the
  // drawing keeps showing the name the room had before the edit
  if (plan.overlay) plan.overlay.render();
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
    card('Supply air', fmt(t.ls, 0), 'L/s'),
    card('Fresh / outdoor air', fmt(t.oaLs, 0), 'L/s'),
    card('Conditioned area', fmt(t.area, 1), 'm²'),
    card('Area', fmt(t.areaSqft, 0), 'ft²'),
    card('Area per tonne', fmt(t.sqftPerTr, 0), 'ft²/TR'),
    card('Rooms included', String(t.rooms), ''),
    card('Room sensible heat', fmt(t.rsh, 0), 'W'),
    card('Room latent heat', fmt(t.rlh, 0), 'W'),
    // the safety factor has always been applied to the room heat; this shows what it is worth, so it
    // is visible at a glance instead of only living in the project settings
    card(`Safety allowance (+${fmt(t.safetyPct, 0)}%)`, fmt(t.safetyW, 0), 'W'),
  ].join('');

  const levels = groupByLevel(calc.results);
  el.levelBody.innerHTML = levels.length
    ? levels.map((g) => `<tr>
        <td class="l">${esc(g.level)}</td>
        <td>${g.rooms}</td>
        <td>${fmt(g.area, 1)}</td>
        <td>${fmt(g.areaSqft, 0)}</td>
        <td>${fmt(g.tr, 2)}</td>
        <td>${fmt(g.ls, 0)}</td>
        <td>${fmt(g.oaCfm, 0)}</td>
        <td>${fmt(g.tr ? g.areaSqft / g.tr : 0, 0)}</td>
      </tr>`).join('') +
      `<tr class="total-row">
        <td class="l">Total</td><td>${t.rooms}</td><td>${fmt(t.area, 1)}</td><td>${fmt(t.areaSqft, 0)}</td>
        <td>${fmt(t.tr, 2)}</td><td>${fmt(t.ls, 0)}</td><td>${fmt(t.oaLs, 0)}</td>
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
      <div><div class="k">Supply air</div><div class="v">${fmt(r.supplyLs, 0)} L/s</div></div>
      <div><div class="k">Fresh air</div><div class="v">${fmt(r.oaLs, 0)} L/s</div></div>
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

/** Open a room's load breakdown.
 *  keepView: leave the page where it is. Set by the plan panel — the user is looking at the DRAWING,
 *  and scrolling down to the breakdown there would yank the sheet out of view after every room they
 *  draw (it looked like the drawing only worked near the top of the page). Clicking a table row still
 *  scrolls to the breakdown, because there the breakdown IS what was asked for. */
function openDetail(id, opts) {
  state.ui.openId = id;
  el.detailPanel.classList.remove('hidden');
  el.roomsBody.querySelectorAll('tr').forEach((tr) =>
    tr.classList.toggle('selected', tr.dataset.id === id));
  renderDetail(currentCalc());
  if (!(opts && opts.keepView)) el.detailPanel.scrollIntoView({ block: 'nearest' });
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
  // the plan overlay draws straight from state.rooms, so refresh it with every re-render
  renderFilters();
  renderTable();
  renderSortHeaders();
  renderSummary(currentCalc());
  if (state.ui.openId) renderDetail(currentCalc());
  if (plan.overlay) plan.overlay.render();
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

/* ------------------------------------------------------------------ */
/* the new readers: which file is which, and who read it              */
/* ------------------------------------------------------------------ */

// Plain words for the status line: who read the file.
const READER_LABEL = {
  server: 'the server',
  browser: 'your browser',
  ocr: 'OCR in your browser',
  schedule: 'the room-schedule reader',
};

const NO_FILES_MSG = 'No supported file found. Please choose a floor plan .pdf drawing, ' +
  'or a room schedule in .csv, .tsv or .xlsx.';

// Exactly one clear line, shown when a PDF has no text layer and OCR is off.
const SCANNED_MSG = "This PDF looks scanned (no text layer). " +
  "Tick 'Read scanned drawings with OCR' and try again.";

// Exactly one clear line, shown when OCR ran, the page(s) were read, and 0 rooms came out.
// Simple English, no jargon: say what OCR could not do and what to do instead.
const OCR_NO_ROOMS_MSG = "OCR read the page but could not recover the room names and areas " +
  "(the small area labels on a scanned drawing are usually unreadable). " +
  "For a scanned sheet, importing an Excel or CSV room schedule gives a much better result.";

// ".csv" / ".tsv" / ".xlsx" -> the room-schedule reader; ".pdf" -> pdf.js or OCR.
const isScheduleUpload = (f) => /\.(csv|tsv|xlsx)$/i.test(f.name || '');
const isPdfUpload = (f) => /\.pdf$/i.test(f.name || '') || f.type === 'application/pdf';

// Keep the source a reader already set ("label", "table", "schedule", "ocr", …)
// and only fill it in when it is missing, so the table can show where a row came from.
function withSource(rooms, source) {
  return (rooms || [])
    .filter((r) => r && typeof r === 'object')
    .map((r) => (r.source ? r : { ...r, source }));
}

function joinWords(list) {
  if (list.length < 2) return list[0] || '';
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

// Short reason for the status line (the full text stays in the warnings box).
function shortReason(msg) {
  const s = String(msg == null ? '' : msg).replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 137) + '...' : s;
}

/* --- one .csv / .tsv / .xlsx room schedule, always here in the browser ---- */

// The worker accepts a string or an ArrayBuffer. Try the natural one for the
// file type first (.xlsx is binary, .csv / .tsv is text) and the other one if
// that throws, so either shape of parseSchedule() works.
async function parseScheduleFile(file) {
  const mod = await loadScheduleModule();
  const buf = await file.arrayBuffer();
  const text = new TextDecoder('utf-8').decode(buf).replace(/^\uFEFF/, '');
  const binary = /\.xlsx$/i.test(file.name || '');
  const opts = { filename: file.name };
  try {
    return await mod.parseSchedule(binary ? buf : text, opts);
  } catch (err) {
    try { return await mod.parseSchedule(binary ? text : buf, opts); } catch (e2) { throw err; }
  }
}

/* --- OCR, only when the user ticks the box ------------------------ */

// onProgress({ phase: 'render'|'ocr'|'rotate', page, pages, progress }) from js/ocr.js
const OCR_PHASE = {
  render: 'making the page image of',
  ocr: 'reading with OCR',
  rotate: 'checking the rotation of',
};

function onOcrProgress(info, fileName, fileIdx, fileCount) {
  const i = (info && typeof info === 'object') ? info : {};
  const phase = OCR_PHASE[i.phase] || 'reading with OCR';
  const page = i.page || 0;
  const pages = i.pages || 0;
  const inner = typeof i.progress === 'number' ? Math.max(0, Math.min(1, i.progress)) : 0;
  const part = pages ? ((page ? page - 1 : 0) + inner) / pages : inner;
  setProgress(
    `File ${fileIdx + 1} of ${fileCount}: ${fileName} — ${phase}${page ? ` page ${page}${pages ? ` of ${pages}` : ''}` : ''}`.replace(/\s+/g, ' '),
    part * 100,
  );
}

// The tesseract worker, its wasm core and eng.traineddata.gz are served from the
// repo under vendor/tesseract/ (see js/ocr.js), so nothing comes from a CDN.
// This runs at most once, and only after the user asked for OCR.
let ocrConfigured = false;
async function configureOcrOnce(mod) {
  if (ocrConfigured) return;
  ocrConfigured = true;
  const opts = {
    workerPath: OCR_VENDOR + 'worker.min.js',
    corePath: OCR_VENDOR,   // folder: the OCR worker picks the wasm core inside it
    langPath: OCR_VENDOR,   // folder holding eng.traineddata.gz
    // js/ocr.js does `import(cfg.moduleURL)` in the browser, and that value is
    // only set when the caller names the file, so we pass the vendored bundle.
    tesseractModuleURL: OCR_VENDOR + 'tesseract.esm.min.js',
  };
  // That bundle exports tesseract.js as a *default* export (it is the CommonJS
  // build), while js/ocr.js looks for named exports such as createWorker. Load it
  // here as well — still only now, never for a user who leaves the box off — and
  // hand the module in, so the first OCR run does not fail with
  // "createWorker is not a function". Harmless once js/ocr.js unwraps .default.
  try {
    const bundle = await import(/* webpackIgnore: true */ opts.tesseractModuleURL);
    const tess = bundle && (typeof bundle.createWorker === 'function' ? bundle : bundle.default);
    if (tess && typeof tess.createWorker === 'function') opts.tesseract = tess;
  } catch (e) {
    /* js/ocr.js tries its own import; a failure is reported by the upload path */
  }
  if (typeof mod.configureOcr === 'function') mod.configureOcr(opts);
}

async function parseOneWithOcr(arrayBuffer, fileName, fileIdx, fileCount) {
  const mod = await loadOcrModule();
  await configureOcrOnce(mod);
  return mod.ocrPdf(arrayBuffer, {
    pdfjs,
    onProgress: (info) => onOcrProgress(info, fileName, fileIdx, fileCount),
  });
}

// A PDF with no text layer is a scan (or an image-only export). The browser
// path has the whole text, the server path only its warnings. Used only to
// decide about the one clear OCR line — the OCR run itself always comes from
// isProbablyScanned() inside js/ocr.js.
async function pdfLooksScanned(out) {
  if (!out) return false;
  const empty = typeof out.text === 'string'
    ? out.text.trim().length === 0
    : (out.warnings || []).some((w) => /no text items/i.test(String(w)));
  if (!empty) return false;
  let mod = null;
  try { mod = await loadOcrModule(); } catch (e) { mod = null; }
  if (mod && typeof mod.isProbablyScanned === 'function') {
    // no text layer at all -> the item list for the check is empty
    const items = String(out.text || '').trim()
      ? String(out.text).trim().split(/\s+/).map((str) => ({ str }))
      : [];
    return mod.isProbablyScanned(items) === true;
  }
  return true;   // nothing was read from the page: it is a scan or an image-only PDF
}

/* --- the Express server (server.js) is used only when it answers ---------- */

// One GET /api/health on load, with a short timeout. A static host answers 404
// or HTML: then we simply stay local. Nothing here may break the page, so every
// failure (no server, timeout, wrong answer) is swallowed.
const HEALTH_TIMEOUT_MS = 1500;

async function probeServer() {
  let answer = { available: false, version: null, checked: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  try {
    // relative URL, so it also works when the app is served from a sub-path
    const res = await fetch('api/health', { signal: ctrl.signal, cache: 'no-store' });
    const type = res.headers.get('content-type') || '';
    if (res.ok && /json/i.test(type)) {
      const data = await res.json();
      if (data && data.ok === true && data.serverSideParse === true) {
        answer = { available: true, version: data.version || null, checked: true };
      }
    }
  } catch (e) {
    /* no server / timeout / not JSON: keep reading the PDFs in the browser */
  } finally {
    clearTimeout(timer);
  }
  state.server = answer;
  updateParseWhere();
}

// The short honest line in the upload panel saying where a file is read.
// The Express server parses text-layer PDFs only; room schedules and OCR
// always run here in the browser.
function updateParseWhere() {
  if (!el.parseWhere) return;
  const ocrOn = !!(el.ocrCheck && el.ocrCheck.checked);
  if (ocrOn) {
    el.parseWhere.textContent = 'PDF drawings: OCR in your browser (slow). ' +
      'CSV / TSV / Excel room schedules: in your browser.';
    return;
  }
  el.parseWhere.textContent = state.server.available
    ? 'PDF drawings: on the server (faster). CSV / TSV / Excel room schedules: in your browser.'
    : 'PDF drawings and CSV / TSV / Excel room schedules: in your browser.';
}

// The server takes at most 10 files per request, so a bigger selection is split.
const SERVER_FILES_PER_REQUEST = 10;

// POST the files as multipart/form-data, one field named "files" per file, and
// merge the answer of every batch into one { rooms, warnings, files }.
// Errors (400 bad PDF, 413 too big, network, bad answer) throw with a short message.
async function parseFilesOnServer(files) {
  const rooms = [], warnings = [], fileInfos = [];
  for (let i = 0; i < files.length; i += SERVER_FILES_PER_REQUEST) {
    const batch = files.slice(i, i + SERVER_FILES_PER_REQUEST);
    const body = new FormData();
    for (const f of batch) body.append('files', f, f.name);
    const res = await fetch('api/parse', { method: 'POST', body });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      // 400 and 413 come back as { error: "..." } — show the server's own words
      throw new Error((data && data.error) ? data.error : `the server answered HTTP ${res.status}`);
    }
    if (!data || typeof data !== 'object') throw new Error('the server sent an unexpected answer');
    if (Array.isArray(data.rooms)) rooms.push(...data.rooms);
    if (Array.isArray(data.warnings)) warnings.push(...data.warnings);
    if (Array.isArray(data.files)) fileInfos.push(...data.files);
  }
  return { rooms, warnings, files: fileInfos };
}

// Same ending for all readers, so the status wording stays the same.
// `readers` = who read the files (server / browser / OCR / room schedule),
// `scanned` = a PDF came back with 0 rooms and no text layer while OCR was off,
// `ocrEmpty` = OCR ran, the page(s) were read, and 0 rooms came out of them.
function finishUpload(added, skipped, failed, notes, serverError, readers, scanned, ocrEmpty) {
  state.ui.busy = false;
  el.dropzone.classList.remove('busy');
  setProgress(null);
  renderAll();
  saveSoon();

  const parts = [`${added} room(s) added`];
  if (skipped) parts.push(`${skipped} looked like duplicates and were skipped`);
  if (failed) parts.push(`${failed} file(s) could not be read`);
  let msg = parts.join(', ') + '. ';
  const readerWords = [...(readers || [])].map((k) => READER_LABEL[k] || k);
  if (readerWords.length) msg += `Read by ${joinWords(readerWords)}. `;
  msg += notes.join(' | ');
  if (scanned) msg += ` ${SCANNED_MSG}`;
    if (ocrEmpty) msg += ` | ${OCR_NO_ROOMS_MSG}`;
    if (serverError) msg = `Server: ${serverError}. These files were read in your browser. ${msg}`;
    setStatus(scanned || ocrEmpty ? 'warn' : (failed && !added ? 'err' : (failed || skipped || serverError ? 'warn' : 'ok')), msg);
}

async function handleFiles(fileList) {
  if (state.ui.busy) return;
  const all = [...fileList];
  // Route by extension: room schedules (.csv / .tsv / .xlsx) go to js/schedule.js,
  // PDF drawings to the server-or-browser path (or to OCR when the box is ticked).
  const schedules = all.filter(isScheduleUpload);
  const pdfs = all.filter(isPdfUpload);
  if (!pdfs.length && !schedules.length) {
    setStatus('err', NO_FILES_MSG);
    return;
  }
  state.ui.busy = true;
  el.dropzone.classList.add('busy');
  setStatus(null);
  let added = 0, skipped = 0, failed = 0;
  const notes = [];
  const readers = new Set();
  let serverError = '';
  let scanned = false;
  // OCR was on, the page(s) were read, and 0 rooms came out of them.
  let ocrEmpty = false;
  // OCR is a choice for this upload: with it on, PDFs are read here in the
  // browser with tesseract, also when the Express server is there.
  const useOcr = !!(el.ocrCheck && el.ocrCheck.checked);

  // --- 1. room schedules: always read here in the browser ------------------
  for (let i = 0; i < schedules.length; i++) {
    const f = schedules[i];
    setProgress(`File ${i + 1} of ${schedules.length}: ${f.name} — reading the room schedule`, 8);
    try {
      const out = await parseScheduleFile(f);
      const res = addRooms(withSource(out.rooms, 'schedule'));
      added += res.added;
      skipped += res.skipped;
      if (out.warnings && out.warnings.length) {
        pushWarnings(out.warnings.map((w) => `${f.name}: ${w}`));
      }
      readers.add('schedule');
      const bits = [`${res.added} room(s) from the schedule`];
      if (out.rowCount) bits.push(`${out.rowCount} row(s) read`);
      if (out.sheetName) bits.push(`sheet "${out.sheetName}"`);
      notes.push(`${f.name}: ${bits.join(', ')}`);
    } catch (err) {
      failed += 1;
      const msg = (err && err.message) ? err.message : String(err);
      pushWarnings([`${f.name}: could not be read — ${msg}`]);
      notes.push(`${f.name}: FAILED — ${shortReason(msg)}`);
    }
  }

  // --- 2. PDF drawings -----------------------------------------------------
  // Server path: text-layer PDFs only, and never when the user asked for OCR.
  if (pdfs.length && !useOcr && state.server.available) {
    setProgress(pdfs.length === 1
      ? `Uploading file 1 of 1: ${pdfs[0].name} …`
      : `Uploading ${pdfs.length} files to the server …`, 10);
    // the server reads the whole file at once and answers in one piece,
    // so after the upload we only have one line left to show
    const readingTimer = setTimeout(() => setProgress('Reading PDF on the server …', 60), 500);
    // the plan panel needs the bytes too; the parse below reads the File itself
    if (pdfs[0] && pdfs[0].size <= 25 * 1024 * 1024) {
      pdfs[0].arrayBuffer().then(openPlan).catch(() => {});
    }
    try {
      const out = await parseFilesOnServer(pdfs);
      clearTimeout(readingTimer);
      // merge exactly like the local path: addRooms() for the rooms
      // (same duplicate guard), pushWarnings() for the notes
      const res = addRooms(withSource(out.rooms, 'pdf'));
      added = res.added;
      skipped = res.skipped;
      if (out.warnings && out.warnings.length) pushWarnings(out.warnings);
      readers.add('server');
      if (out.files && out.files.length) {
        for (const info of out.files) {
          const n = (typeof info.roomCount === 'number')
            ? info.roomCount
            : (Array.isArray(info.rooms) ? info.rooms.length : 0);
          notes.push(`${info.name}: ${n} room(s)${info.pages ? ` from ${info.pages} page(s)` : ''}`);
          if (!n && await pdfLooksScanned(info)) scanned = true;
        }
      } else {
        notes.push(`${pdfs.length} file(s) read on the server`);
      }
      finishUpload(added, skipped, failed, notes, '', readers, scanned);
      return;
    } catch (err) {
      clearTimeout(readingTimer);
      serverError = (err && err.message) ? err.message : String(err);
      setStatus('warn', `Server: ${serverError}. Reading the file(s) in your browser instead.`);
      // fall through to the local path below, the user still gets a result
    }
  }

  // --- local path: pdf.js, or tesseract OCR when the box is ticked ---------
  for (let i = 0; i < pdfs.length; i++) {
    const f = pdfs[i];
    setProgress(`File ${i + 1} of ${pdfs.length}: ${f.name} — ${useOcr ? 'preparing OCR' : 'opening'}`, 3);
    try {
      const buf = await f.arrayBuffer();
      if (i === 0) openPlan(buf, { name: f.name });   // show the drawing while it is being read
      const out = useOcr
        ? await parseOneWithOcr(buf, f.name, i, pdfs.length)
        : await parseOne(buf, f.name, i, pdfs.length);
      const res = addRooms(withSource(out.rooms, useOcr ? 'ocr' : 'pdf'));
      added += res.added;
      skipped += res.skipped;
      readers.add(useOcr ? 'ocr' : 'browser');
      if (out.warnings && out.warnings.length) {
        pushWarnings(out.warnings.map((w) => `${f.name}: ${w}`));
      }
      const ocrPages = (useOcr && Array.isArray(out.usedOcr) && out.usedOcr.length)
        ? `, OCR on page(s) ${out.usedOcr.join(', ')}` : '';
      notes.push(`${f.name}: ${res.added} room(s)${out.pages ? ` from ${out.pages} page(s)` : ''}${ocrPages}`);
      // no rooms and no text layer: one clear line about the OCR box
      if (!useOcr && (!out.rooms || !out.rooms.length) && await pdfLooksScanned(out)) scanned = true;
      // OCR ran and read the page(s) but found no rooms: say why, and what works better.
      if (useOcr && !res.added && out.pages) {
        ocrEmpty = true;
        pushWarnings([`${f.name}: ${OCR_NO_ROOMS_MSG}`]);
      }
    } catch (err) {
      failed += 1;
      const msg = (err && err.message) ? err.message : String(err);
      pushWarnings([`${f.name}: could not be read — ${msg}`]);
      notes.push(`${f.name}: FAILED — ${shortReason(msg)}`);
    }
  }

  finishUpload(added, skipped, failed, notes, serverError, readers, scanned, ocrEmpty);
}

async function loadSample() {
  if (state.ui.busy) return;
  state.ui.busy = true;
  setStatus(null);
  setProgress('Downloading the sample drawing ...', 5);
  const paths = ['samples/sample-plan.pdf', 'tests/samples/sample-plan.pdf'];
  let buf = null, used = '';
  let lastErr = null;
  for (const path of paths) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      buf = await res.arrayBuffer();
      // A 200 does not prove it is a PDF: on a static host a missing sample can be answered by the
      // single-page-app fallback with index.html, and pdf.js then fails with a cryptic
      // "Invalid PDF structure". Check the magic bytes and treat anything else as "not available".
      const magic = new Uint8Array(buf, 0, Math.min(5, buf.byteLength));
      const isPdf = magic.length === 5 && String.fromCharCode(...magic) === '%PDF-';
      if (!isPdf) {
        lastErr = new Error(`not a PDF (${res.headers.get('content-type') || 'unknown type'})`);
        buf = null;
        continue;
      }
      used = path;
      break;
    } catch (err) { lastErr = err; }
  }
  if (!buf) {
    setProgress(null);
    state.ui.busy = false;
    setStatus('warn',
      'The sample drawing is not part of this deployment, so there is nothing to load here. ' +
      'Upload your own PDF, import a room schedule (Excel/CSV), or use "Add room manually". ' +
      `(${(lastErr && lastErr.message) || lastErr})`);
    return;
  }
  try {
    openPlan(buf, { name: used });   // show the sample drawing straight away
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
/* plan view — draw rooms straight onto the drawing                    */
/* ------------------------------------------------------------------ */
/* js/viewer.js paints the PDF page into a canvas and js/overlay.js draws the coloured room boxes on
 * top of it. Both are imported on demand: the panel only appears once a drawing is open, and if
 * either module is unavailable the calculator behaves exactly as it did before (the static build must
 * never break because an enhancement is missing).
 *
 * The geometry lives in the planner-owned js/planview.js — a drawn room stores its rectangle in PDF
 * points plus the drawing scale it was measured at, never screen pixels, so zoom and page rotation
 * cannot corrupt it. */
const plan = {
  mods: null, viewer: null, overlay: null, bytes: null, traceBytes: null,
  page: 1, pages: 1, wired: false, unavailable: false,
};

async function ensurePlanModules() {
  if (plan.mods || plan.unavailable) return plan.mods;
  try {
    const [viewerMod, overlayMod] = await Promise.all([import('./viewer.js'), import('./overlay.js')]);
    if (typeof viewerMod.createViewer !== 'function' || typeof overlayMod.createOverlay !== 'function') {
      throw new Error('createViewer/createOverlay missing');
    }
    plan.mods = { createViewer: viewerMod.createViewer, createOverlay: overlayMod.createOverlay };
  } catch (err) {
    // enhancement only — say nothing to the user, keep the calculator working
    plan.unavailable = true;
    return null;
  }
  return plan.mods;
}

function planScaleDenom() {
  const n = Number(state.project.planScale);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SCALE_DENOM;
}

function planHintText() {
  // A PLACED room (a locator box sized back from its own area, see planPlaceAllRooms) carries a rect
  // too, so isDrawnRoom() alone cannot tell it from a hand-drawn one — planview.isPlacedRoom() can.
  const drawn = state.rooms.filter((r) => isDrawnRoom(r) && !isPlacedRoom(r)).length;
  const placed = state.rooms.filter(isPlacedRoom).length;
  if (state.ui.planMode === 'select') {
    return `Click a room box to open its load breakdown. Drag a room to move it, drag a corner to ` +
      `resize, Delete to remove, middle-drag or hold Space to pan. ` +
      `${drawn} hand-drawn and ${placed} placed room box(es) on the plan.`;
  }
  return `Drag a rectangle over a room in the drawing to add it as a room, or use ` +
    `"Place all rooms on the plan" to give every room the drawing names a locator box. ` +
    `Areas are measured at 1:${planScaleDenom()} — change the drawing scale above if the sheet differs. ` +
    `${drawn} room(s) drawn so far, ${placed} placed. Switch to Select / edit to move, resize or delete a box.`;
}

function planSync() {
  if (!el.planCard) return;
  el.planPage.textContent = String(plan.page);
  el.planPages.textContent = String(plan.pages);
  if (el.planZoomPct && plan.viewer && typeof plan.viewer.getScale === 'function') {
    el.planZoomPct.textContent = String(Math.round((plan.viewer.getScale() || 1) * 100));
  }
  if (el.planPrev) el.planPrev.disabled = plan.page <= 1;
  if (el.planNext) el.planNext.disabled = plan.page >= plan.pages;
  if (el.planHint) el.planHint.textContent = planHintText();
}

function planSelectRoom(room) {
  if (room) openDetail(room.id, { keepView: true }); else closeDetail();
  if (plan.overlay) plan.overlay.render();
}

/* ---- Stage 2: the overlay reports, the app owns the state (see AGENTS.md) --------------------
 * The overlay moves/resizes the box and reports the new rectangle in PDF points. It never writes a
 * room. Each callback here puts the room back in step: the rectangle is the source of truth for a
 * drawn room, so its area and length/width are re-derived from THAT rectangle with the room's own
 * drawing scale (never the screen). Nothing is re-derived in the overlay. */

/** The drawing scale a room was measured at — its own `scaleDenom`, falling back to the panel's. */
function roomDenom(room) {
  const n = Number(room && room.scaleDenom);
  return Number.isFinite(n) && n > 0 ? n : planScaleDenom();
}

/** A room in state by id (the overlay reports ids, never the room object). */
function roomById(id) {
  const want = id && typeof id === 'object' ? id.id : id;
  return state.rooms.find((r) => r.id === want) || null;
}

/** Live, on every pointermove of a move/resize drag: write the reported rectangle into the room and
 *  redraw the boxes only. Deliberately NO recalculation and NO table rebuild here — this runs dozens
 *  of times a second, and the full project calc over a large table (159 sample rooms) is far too
 *  heavy to repeat per move. The row's area cell, the totals and the summary are refreshed once, in
 *  planRoomMoveEnd(). Keeping the live path this small is what makes the box follow the pointer. */
function planRoomMoved(id, rect) {
  const room = roomById(id);
  if (!room || !rect) return;
  room.rect = {
    page: rect.page != null ? rect.page : (room.rect && room.rect.page) || plan.page || 1,
    x: rect.x, y: rect.y, w: rect.w, h: rect.h,
  };
  if (plan.overlay) plan.overlay.render();
}

/** On release: the real update. Write the new rectangle into the room, re-derive its area and
 *  length/width from THAT rectangle at its own scale, refresh its row (the area cell the table still
 *  shows), recalculate, refresh the summary and the open description, redraw the map and persist.
 *  updateLive() is the same no-table-rebuild refresh the in-table edits use, so the table keeps the
 *  room's row and the user's focus instead of being thrown away and rebuilt. */
function planRoomMoveEnd(id, rect) {
  const room = roomById(id);
  if (!room || !rect) return;
  const denom = roomDenom(room);
  // store the rectangle the same rounded way roomFromRect() does, so a move matches a fresh draw
  const next = {
    page: rect.page != null ? rect.page : (room.rect && room.rect.page) || plan.page || 1,
    x: round2(rect.x), y: round2(rect.y), w: round2(rect.w), h: round2(rect.h),
  };
  room.rect = next;
  room.scaleDenom = denom;
  if (!room.source) room.source = 'manual';
  const dims = dimsFromRect(next, denom);
  room.area = round2(areaFromRect(next, denom));
  room.length = round2(dims.length);
  room.width = round2(dims.width);

  // the area cell shows room.area, so it has to be re-typed into the input as well (updateLive()
  // refreshes the computed cells and placeholders, but never overwrites a field's value)
  const inp = el.roomsBody.querySelector(`tr[data-id="${room.id}"] input[data-field="area"]`);
  if (inp) inp.value = String(room.area);

  updateLive();   // recalculates, refreshes computed cells, summary, description and the boxes
  saveSoon();
}

/** Delete/Backspace on a selection: drop the room from state and from the table, recalculate,
 *  refresh the summary and the description, redraw the boxes and persist. */
function planDeleteRoom(id) {
  const room = roomById(id);
  if (!room) return;
  const idx = state.rooms.indexOf(room);
  if (idx < 0) return;
  deleteRoom(idx);   // splices state, closes the description if it showed this room, renderAll + save
}

/* ---- "Place all rooms on the plan": a locator box for every room the sheet names -----------------
 * The plan's text layer says where a room is NAMED ("CONFERENCE ROOM 24.5 M2") but nothing about
 * where its walls are, so a placed box is a LOCATOR, not a traced boundary: it is centred on that
 * point and sized BACK from the room's own area at the drawing scale (planview.rectFromLabel). The
 * area is the INPUT to the box, never an output of it — so placing rooms can never change a load
 * figure. A room the plan does not name has no point to sit on and stays in the table only; so does
 * a room with no usable area (nothing to size a box from). Both are counted and said out loud.
 * Rooms are placed on THEIR OWN page (room.page), not the page being viewed. */

/** Give every table room that the drawing names a clickable locator box on its own page. */
async function planPlaceAllRooms() {
  if (!state.rooms.length) {
    setStatus('warn', 'There are no rooms in the table to place yet. Load a drawing or add rooms first.');
    return;
  }

  // A project saved before the parser recorded WHERE the sheet names each room has no `at`, so
  // nothing can be placed and the user is told the sheet does not name the rooms — even though it
  // does, and re-uploading the same drawing works. The drawing is still kept in this browser
  // (drawstore/IndexedDB), so when not one room has a position, read it again and recover them.
  let rehydrated = 0;
  if (!state.rooms.some((r) => r.at)) {
    rehydrated = await rehydratePositions();
    if (rehydrated) saveSoon();
  }
  const rehydrateNote = rehydrated
    ? 'Re-read the drawing to find where the rooms are named (this table was saved by an older version). '
    : '';

  const denom = planScaleDenom();
  let placed = 0, noAt = 0, noArea = 0, already = 0, handDrawn = 0;
  for (const room of state.rooms) {
    if (isPlacedRoom(room)) { already += 1; continue; }        // already has a locator box
    if (isDrawnRoom(room)) { handDrawn += 1; continue; }        // a hand-drawn box already sits where it was traced
    if (!room.at) { noAt += 1; continue; }                      // the plan does not name this room
    const area = Number(room.area);
    if (!Number.isFinite(area) || area <= 0) { noArea += 1; continue; }
    const rect = rectFromLabel(room.at, area, denom, { length: room.length, width: room.width });
    if (!rect) { noArea += 1; continue; }
    // each room's box goes on ITS OWN page, not the page the user happens to be looking at
    room.rect = { ...rect, page: room.page || 1 };
    placed += 1;
  }

  const notes = [];
  if (noAt) notes.push(`${noAt} ${noAt === 1 ? 'is' : 'are'} not named on the sheet, so ${noAt === 1 ? 'it stays' : 'they stay'} in the table only`);
  if (noArea) notes.push(`${noArea} ${noArea === 1 ? 'has' : 'have'} no usable area to size a box from, so ${noArea === 1 ? 'it stays' : 'they stay'} in the table only`);
  if (handDrawn) notes.push(`${handDrawn} hand-drawn box(es) were left where you traced them`);
  if (already) notes.push(`${already} ${already === 1 ? 'is' : 'are'} already on the plan`);

  if (!placed) {
    if (!notes.length) {
      setStatus('warn', 'No room to place — none of the rooms carries a usable area to size a box from.');
      return;
    }
    // nothing new, but say WHY rather than a flat "done": rooms already placed, and rooms that have
    // nowhere to sit (the sheet does not name them) or nothing to size a box from.
    if (already && notes.length === 1) {
      setStatus('ok', rehydrateNote + `All ${already} room(s) the drawing names are already on the plan.`);
      return;
    }
    setStatus('warn', rehydrateNote + `No room to place: ${notes.join('; ')}.`);
    return;
  }

  planSync();     // refresh the hint (draw counts changed)
  renderAll();    // rebuild the table + summary and redraw the boxes (the table rows do not change)
  saveSoon();

  let msg = rehydrateNote + `Placed ${placed} room(s) on the plan. `;
  msg += notes.length ? `${notes.join('; ')}.` : 'Each box is a locator centred on the point that names the room, sized back from its own area — the load has not changed.';
  setStatus('ok', msg);
}

/** Remove ONLY the locator boxes made by "Place all rooms on the plan". Hand-drawn rooms and rooms
 *  that were never placed are untouched: their rectangle, area, name and include flag all stay. */
function planClearPlaced() {
  let removed = 0;
  for (const room of state.rooms) {
    if (!isPlacedRoom(room)) continue;
    delete room.rect;       // area, name, include and source are deliberately left alone
    removed += 1;
  }
  if (!removed) {
    setStatus('warn', 'There are no placed rooms on the plan to remove.');
    return;
  }
  planSync();
  renderAll();
  saveSoon();
  setStatus('ok', `Removed ${removed} placed room(s) from the plan. Hand-drawn boxes were left alone; ` +
    `the rooms and the load are unchanged.`);
}

/* ---- "Trace real outlines": the plan's OWN wall linework -> a real shape per room -----------------
 * A placed box is a LOCATOR: it is centred on where the sheet NAMES a room and sized back from the
 * area the table already carries. The walls are the PDF's vector paths, and js/trace.js (pure, frozen
 * — see AGENTS.md "trace.js contract") turns those paths into enclosed regions and hands back an
 * outline ONLY for the rooms it can verify: exactly one room label inside the region AND a traced area
 * within TRACE_BAND of the stated one. Everything else keeps its box.
 *
 * This file does the part that needs a browser: read each page's operator list, transform every point
 * into the page MediaBox — the SAME PDF user space room.at uses — and assert it did. If the assertion
 * fails we skip that page and say so rather than store a shape in the wrong space.
 *
 * The load is untouched by construction: only room.poly / polyPage / polyArea / polyRatio are written,
 * and calc.js reads none of them. */

const TRACE_PX_PER_PT = 2;      // raster resolution the module was measured at (see trace.js)
const TRACE_THICKNESS = 2;      // wall stroke, in raster pixels

/** Every line segment of one page, in PDF user space, tagged with its line width and stroke colour.
 *  trace.js tracks the page's own save/restore/transform (and form XObjects) from a base matrix, so
 *  the base is the identity: the page content stream starts in the page's user space, which is the
 *  space room.at lives in. */
function lineSegmentsForPage(fnArray, argsArray, OPS, trace) {
  const out = trace.segmentsFromOperatorList(fnArray, argsArray, OPS, [1, 0, 0, 1, 0, 0]);
  return out.segments;
}

/** Do ALL of these segment endpoints lie inside the page box (with a small tolerance)? If not, the
 *  transform we used is not the one that lands points in the MediaBox and the page must be skipped. */
function segmentsInBox(segments, box, tol) {
  const t = Number.isFinite(tol) ? tol : 2;
  for (const s of segments) {
    if (!(s.x1 >= box.x0 - t && s.x1 <= box.x1 + t && s.y1 >= box.y0 - t && s.y1 <= box.y1 + t)) return false;
    if (!(s.x2 >= box.x0 - t && s.x2 <= box.x1 + t && s.y2 >= box.y0 - t && s.y2 <= box.y1 + t)) return false;
  }
  return true;
}

/** The ring the room's own name sits inside (falling back to the biggest ring). A region can return
 *  more than one ring — the outer boundary plus any holes — and the label is inside the outer one. */
function ringFor(rings, at, trace) {
  if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
    for (const r of rings) {
      let inside = false;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const xi = r[i].x, yi = r[i].y, xj = r[j].x, yj = r[j].y;
        if (((yi > at.y) !== (yj > at.y)) && (at.x < ((xj - xi) * (at.y - yi)) / (yj - yi) + xi)) inside = !inside;
      }
      if (inside) return r;
    }
  }
  return largestRing(rings, trace);
}

/** The biggest ring of an outline (the module can return more than one; holes are never used). */
function largestRing(rings, trace) {
  let best = rings[0], bestA = -1;
  for (const r of rings) {
    const a = trace.polygonAreaPt2(r);
    if (a > bestA) { bestA = a; best = r; }
  }
  return best;
}

/** A plain-language bucket for a refusal, so the status line can count categories not rooms. */
function traceReasonBucket(reason) {
  const r = String(reason || '');
  if (/far larger than any single room/i.test(r)) return 'had no enclosed space around the name (open plan or a gap in the walls)';
  if (/no enclosed area/i.test(r)) return 'had their name on a wall line';
  if (/shared with/i.test(r)) return 'share their area with another room';
  if (/traced area/i.test(r)) return 'did not match their stated area';
  return r || 'the tracer could not verify them';
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

/** Rooms that can be traced at all: a position on the sheet and an area to check the outline against. */
function positionedRooms() {
  return state.rooms.filter((r) => r && r.at && Number.isFinite(r.at.x) && Number.isFinite(r.at.y) && Number(r.area) > 0);
}

/** The drawing's bytes: the copy held in memory, or the one this browser keeps (drawstore/IndexedDB). */
async function drawingBytesForTrace() {
  const mem = plan.traceBytes;
  if (mem && mem.byteLength) return { bytes: mem };
  try {
    const mod = await import('./drawstore.js');
    const rec = await mod.getDrawing();
    if (rec && rec.bytes && rec.bytes.byteLength) return rec;
  } catch (err) { /* no store: fall through to null */ }
  return null;
}

/** Let the browser paint the "tracing…" status before the (synchronous, heavy) trace begins. */
function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 30);
  });
}

/** Disable the plan buttons while a trace runs (it blocks the main thread for a second or two). */
function planTraceBusy(on) {
  state.ui.traceBusy = !!on;
  for (const b of [el.planPlaceAll, el.planPlaceClear, el.planTraceOutlines, el.planTraceClear]) {
    if (b) b.disabled = !!on;
  }
}

/** Read the plan's own linework and give every room it can verify a real outline. */
async function planTraceOutlines() {
  if (state.ui.traceBusy) return;
  if (!state.rooms.length) {
    setStatus('warn', 'There are no rooms to trace yet. Load a drawing or add rooms first.');
    return;
  }
  if (!plan.viewer || plan.unavailable) {
    setStatus('warn', 'Open a drawing in the plan view first, then trace its outlines.');
    return;
  }

  // A project saved before the parser recorded WHERE the sheet names each room has no `at`; recover
  // the positions exactly like Place all rooms does, so tracing works on such a project too.
  let withPos = positionedRooms();
  if (!withPos.length) {
    const n = await rehydratePositions();
    if (n) saveSoon();
    withPos = positionedRooms();
  }
  if (!withPos.length) {
    setStatus('warn', 'No room carries both a position on the sheet and an area, so there is nothing to trace. ' +
      'Upload the drawing again if the rooms have no position.');
    return;
  }
  const noAt = state.rooms.filter((r) => !r.at || !Number.isFinite(r.at.x) || !Number.isFinite(r.at.y)).length;

  const denom = planScaleDenom();
  let trace;
  try { trace = await loadTraceModule(); } catch (err) { setStatus('err', (err && err.message) || String(err)); return; }

  planTraceBusy(true);
  setStatus(null, "Tracing the plan's linework… this can take a second or two on a big sheet.");
  await nextFrame();

  try {
    const rec = await drawingBytesForTrace();
    if (!rec) {
      setStatus('warn', 'The drawing is not kept in this browser any more, so its linework cannot be read. ' +
        'Upload it again and try.');
      return;
    }

    const doc = await pdfjs.getDocument({ data: rec.bytes.slice(0), verbosity: 0 }).promise;
    try {
      // Every room we are about to re-check loses any outline from an EARLIER trace: a shape that this
      // run refuses must not survive as a stale outline from the last one. Boxes are never touched.
      for (const r of withPos) { delete r.poly; delete r.polyPage; delete r.polyArea; delete r.polyRatio; }

      const byPage = new Map();
      for (const r of withPos) {
        const p = Number(r.page) || 1;
        if (!byPage.has(p)) byPage.set(p, []);
        byPage.get(p).push(r);
      }

      const winKeys = new Set();
      const allResults = [];
      const reasonCount = new Map();
      const ratios = [];
      let accepted = 0, refused = 0, refusedWithRect = 0, emptyPages = 0, badPages = 0;

      for (const p of [...byPage.keys()].sort((a, b) => a - b)) {
        const list = byPage.get(p);
        if (p < 1 || p > doc.numPages) {
          refused += list.length;
          refusedWithRect += list.filter((r) => r.rect).length;
          list.forEach(() => bump(reasonCount, 'are on a page the drawing does not have'));
          continue;
        }
        const pg = await doc.getPage(p);
        const v = pg.view;
        const box = { x0: v[0], y0: v[1], x1: v[2], y1: v[3] };
        const opList = await pg.getOperatorList();
        const segs = lineSegmentsForPage(opList.fnArray, opList.argsArray, pdfjs.OPS, trace);
        if (!segs.length) {
          emptyPages += 1;
          refused += list.length;
          refusedWithRect += list.filter((r) => r.rect).length;
          list.forEach(() => bump(reasonCount, 'are on a page with no wall lines'));
          continue;
        }
        if (!segmentsInBox(segs, box, 2)) {
          badPages += 1;
          refused += list.length;
          refusedWithRect += list.filter((r) => r.rect).length;
          list.forEach(() => bump(reasonCount, 'could not be placed in the sheet’s own space'));
          console.warn(`[trace] skipped page ${p}: the linework falls outside the page MediaBox — ` +
            `the app and the tracer disagree on the page space, so no shape is stored for it.`);
          continue;
        }

        const roomsIn = list.map((r) => ({ id: r.id, at: { x: r.at.x, y: r.at.y }, area: Number(r.area) }));
        // Which lines are the plan's WALLS is decided by result, not by how common a class is: on a real
        // MEP sheet the symbol hatch outnumbered the walls, so "most common class" traced symbols and
        // merged rooms. pickWallLines tries the few most common classes plus every line and keeps
        // whichever verifies the most rooms; the winner's class is named in the status line.
        const out = trace.pickWallLines(segs, {
          box, rooms: roomsIn, denom, pxPerPt: TRACE_PX_PER_PT, thickness: TRACE_THICKNESS, topN: 3,
        });
        winKeys.add(out.key);

        for (const res of out.results) {
          const room = roomById(res.id);
          if (!room) continue;
          allResults.push(res);
          if (res.ok && Array.isArray(res.rings) && res.rings.length) {
            const ring = ringFor(res.rings, room.at, trace);
            room.poly = ring.map((pt) => ({ x: round2(pt.x), y: round2(pt.y) }));
            room.polyPage = p;
            // the module's own verdict numbers: the traced area the accept rule was judged on
            room.polyArea = round2(Number(res.tracedM2) || 0);
            room.polyRatio = Number((Number(res.ratio) || 0).toFixed(3));
            ratios.push(room.polyRatio);
            accepted += 1;
          } else {
            refused += 1;
            if (room.rect) refusedWithRect += 1;
            bump(reasonCount, traceReasonBucket(res.reason));
          }
        }
      }

      planTraceBusy(false);
      renderAll();
      saveSoon();

      // The implied scale only means something for a region that held exactly ONE label: a region that
      // merged several rooms, or one far larger than any single room, says nothing about the scale.
      // Filtering those out first is what makes the hint point at the real scale instead of at the junk.
      const scaleSet = allResults.filter((r) => r
        && !/shared with|no enclosed area|far larger than any single room/i.test(String(r.reason || '')));
      const implied = trace.impliedDenom(scaleSet.length >= 5 ? scaleSet : allResults, denom);
      // a small debug handle (same spirit as the viewer's exposed canvas): what the last trace found
      plan.lastTrace = {
        accepted, attempted: withPos.length, denom, implied, keys: [...winKeys],
        reasons: [...reasonCount.entries()],
      };
      const parts = [...reasonCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`);
      const few = accepted < Math.max(1, Math.ceil(withPos.length * 0.5));
      const scaleOff = !!(implied && implied.denom && implied.n >= 5
        && Math.abs(implied.denom - denom) / denom > 0.15);
      // Offer the implied scale in the list, so fixing it is one click. Nothing is stored until chosen.
      const offered = scaleOff ? planOfferScale(implied.denom) : false;

      let msg;
      const noLinework = byPage.size > 0 && emptyPages === byPage.size;
      if (noLinework) {
        msg = 'This drawing has no wall lines for the tracer to read (a scan, or a plan that is text ' +
          'only), so no outline could be stored. ';
      } else if (scaleOff && few) {
        // The honest answer when almost nothing agrees: say what scale the outlines imply and let the
        // user set it. Never quietly retry at another scale — a wrong scale silently changes every area.
        msg = `Only ${accepted} of ${withPos.length} room(s) traced: this drawing's outlines point to about ` +
          `1:${implied.denom} (the middle of ${implied.n} room${implied.n === 1 ? '' : 's'}), but the drawing ` +
          `scale is set to 1:${denom}. Set the drawing scale to 1:${implied.denom} and trace again. ` +
          (offered ? `(1:${implied.denom} is now in the drawing-scale list.) ` : '');
      } else {
        msg = `Real outlines for ${accepted} of ${withPos.length} room(s) (traced from the plan's own linework, ` +
          `using ${passLabel(winKeys)}). `;
      }
      if (!scaleOff && few && implied && implied.n >= 5) {
        // Almost nothing was accepted and the rooms that did trace do not agree on one scale either.
        // Say so plainly and point at the scale first — never quietly retry at another one.
        msg += `Almost nothing was accepted, so check the drawing scale first: the rooms that did trace ` +
          `imply a scale between about 1:${implied.p25} and 1:${implied.p75}, against the 1:${denom} in use. `;
      }
      if (refused) {
        const kept = refusedWithRect === refused
          ? `${refused} kept ${refused === 1 ? 'its box' : 'their box'}`
          : `${refusedWithRect} of the ${refused} kept their box`;
        msg += `${kept}${parts.length ? ': ' + parts.join(', ') : ''}. `;
      }
      if (noAt) msg += `${noAt} room(s) the sheet does not name ${noAt === 1 ? 'was' : 'were'} left alone. `;
      if (emptyPages) msg += `The drawing has no wall lines on ${emptyPages} page(s). `;
      if (badPages) msg += `${badPages} page(s) were skipped: their lines did not sit inside the sheet. `;
      if (accepted) {
        const r = ratios.slice().sort((a, b) => a - b);
        msg += `Traced area against stated: ${fmt(r[0], 2)}× to ${fmt(r[r.length - 1], 2)}× ` +
          `(middle ${fmt(r[Math.floor(r.length / 2)], 2)}×). The load is unchanged.`;
      } else {
        msg += 'No outline was stored, so nothing on the plan changed and the load is unchanged.';
      }
      setStatus(accepted ? 'ok' : 'warn', msg.replace(/\s+$/, ''));
    } finally {
      try { await doc.destroy(); } catch (e) { /* ignore */ }
    }
  } catch (err) {
    console.warn('[trace] tracing failed:', (err && err.message) || err);
    setStatus('err', `Tracing the plan's linework failed (${(err && err.message) || err}). ` +
      `The rooms and the load are unchanged.`);
  } finally {
    planTraceBusy(false);
  }
}

/** Offer the scale the outlines imply, as "1:225 (from the drawing)", at the end of the drawing-scale
 *  list — so the fix is one click. It is only OFFERED: nothing is stored until the user picks it, and
 *  picking it re-runs the trace (see planWire). Returns true when the option is in the list. */
function planOfferScale(implied) {
  const sel = el.planScale;
  if (!sel || !(implied > 0)) return false;
  const v = String(Math.round(implied));
  let opt = [...sel.options].find((o) => o.value === v);
  if (!opt) { opt = document.createElement('option'); opt.value = v; sel.appendChild(opt); }
  opt.textContent = `1:${v} (from the drawing)`;
  opt.dataset.fromDrawing = '1';
  return true;
}

/** Which line class(es) the trace used, in words (one class, or a different winner per page). */
function passLabel(keys) {
  const list = [...(keys || [])];
  const name = (k) => (k === 'all lines' ? 'all the linework' : `the wall-line class "${k}"`);
  if (!list.length) return 'all the linework';
  if (list.length === 1) return name(list[0]);
  return list.map(name).join(' and ');
}

/** Remove ONLY the traced outlines. The rooms, their boxes, areas and the load are all untouched. */
function planTraceClear() {
  let removed = 0;
  for (const room of state.rooms) {
    if (!room.poly) continue;
    delete room.poly;
    delete room.polyPage;
    delete room.polyArea;
    delete room.polyRatio;
    removed += 1;
  }
  if (!removed) {
    setStatus('warn', 'There are no traced outlines to remove.');
    return;
  }
  renderAll();
  saveSoon();
  setStatus('ok', `Removed ${removed} traced outline(s). Their boxes, if any, and the load are unchanged.`);
}

/** A level for a room drawn on page N: the levels the parser found, in the order it found them,
 *  usually correspond to the pages in order. Best effort — the user can retype it in the editor. */
function planLevelForPage(page) {
  const seen = [];
  for (const r of state.rooms) {
    const lv = (r.level || '').trim();
    if (lv && !seen.includes(lv)) seen.push(lv);
  }
  return seen[page - 1] || (seen.length ? seen[seen.length - 1] : '');
}

function planDrawRoom(rect, info) {
  const page = (info && info.page) || plan.page || 1;
  const denom = planScaleDenom();
  const n = state.rooms.filter((r) => isDrawnRoom(r) && !isPlacedRoom(r)).length + 1;
  const room = roomFromRect(rect, {
    id: newId(),
    name: `Drawn room ${n}`,
    level: planLevelForPage(page),
    page,
    denom,
    include: true,
  });
  const res = addRooms([room]);
  renderAll();
  saveSoon();
  if (res.added) {
    setStatus('ok', `${room.name} added — ${room.length} × ${room.width} m, ${room.area} m² at 1:${denom}. ` +
      `Set its name, orientation and glazing below; the load already uses it.`);
    planSelectRoom(room);
  }
}

/** The drawing scale is the one input the whole panel depends on, so changing it re-measures every
 *  room that was drawn (their areas are derived from the rectangle, not typed). PLACED rooms are
 *  deliberately skipped: their box was computed BACK from the room's own area, so their area is the
 *  input, not the output — re-measuring them from the box at a new scale would silently change the
 *  load. Only hand-drawn rooms (a real traced boundary) own their area through their rectangle. */
function planApplyScale(denom) {
  const n = Number(denom) || DEFAULT_SCALE_DENOM;
  state.project.planScale = n;
  let changed = 0;
  for (const r of state.rooms) {
    if (!isDrawnRoom(r) || isPlacedRoom(r)) continue;
    const dims = dimsFromRect(r.rect, n);
    r.scaleDenom = n;
    r.area = round2(areaFromRect(r.rect, n));
    r.length = round2(dims.length);
    r.width = round2(dims.width);
    changed += 1;
  }
  renderAll();
  saveSoon();
  setStatus('ok', changed
    ? `Drawing scale 1:${n} — ${changed} drawn room(s) re-measured from their rectangles.`
    : `Drawing scale set to 1:${n}. Rooms you draw are measured at this scale.`);
}

/* ------------------------------------------------------------------ */
/* the drawing, remembered in this browser                             */
/* ------------------------------------------------------------------ */

/** Keep the drawing in this browser so a refresh does not lose it. Never fatal: a browser without
 *  IndexedDB, or a full quota, costs the user nothing beyond the drawing not coming back — the rooms,
 *  the table and the load are all saved separately and are unaffected. */
async function storeDrawing(bytes, name) {
  try {
    const mod = await import('./drawstore.js');
    // owned: true — this buffer is our own private copy, so it need not be copied again
    const res = await mod.putDrawing({ name: name || 'drawing.pdf', bytes, page: plan.page, owned: true });
    if (res.ok) {
      plan.stored = true;
    } else if (res.reason === 'too-big') {
      setStatus('warn', `This drawing is ${Math.round((res.size || 0) / 1048576)} MB — too large to keep in this ` +
        `browser, so it will be gone after a refresh. Your rooms, the table and the load are still saved.`);
    } else if (res.reason === 'quota') {
      setStatus('warn', 'This browser has no room to keep the drawing, so it will be gone after a refresh. ' +
        'Your rooms, the table and the load are still saved.');
    }
  } catch (err) {
    console.warn('[plan] could not keep the drawing for next time:', (err && err.message) || err);
  }
}

/** Put the drawing back on screen after a reload: the rooms come from the saved project, the sheet
 *  itself from this browser's storage. */
async function restoreDrawing() {
  if (!el.planCard) return;
  try {
    const mod = await import('./drawstore.js');
    const rec = await mod.getDrawing();
    if (!rec) return;
    // magic bytes: never hand pdf.js something that is not a PDF, and never keep a bad one (a stored
    // HTML error page once reached this path and surfaced as "Invalid PDF structure")
    const head = new Uint8Array(rec.bytes.slice(0, 5));
    const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d;
    if (!isPdf) { await mod.clearDrawing(); return; }
    await openPlan(rec.bytes, {
      name: rec.name,
      page: rec.page || state.project.planPage,
      restoring: true,
      skipStore: true,
    });
    plan.stored = true;
  } catch (err) {
    console.warn('[plan] could not restore the drawing:', (err && err.message) || err);
  }
}

/** A normalised room name for matching: trimmed, inner whitespace collapsed, case-insensitive. */
function normalizeRoomName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Recover the positions of rooms in a project saved before the parser recorded where the sheet names
 * them. The drawing is still in this browser (drawstore/IndexedDB), so parse it again with the same
 * browser-side call an upload uses, and hand each existing room that is missing `at` the point the
 * fresh parse found for it. ONLY `at` is copied: the user's name, area, size, type, include flag,
 * editing and any rectangle are left exactly as they were.
 * @returns {Promise<number>} how many rooms gained a position (0 when there is no stored drawing or
 *                            nothing matched).
 */
async function rehydratePositions() {
  const missing = state.rooms.filter((r) => r && typeof r === 'object' && !r.at);
  if (!missing.length) return 0;

  let rec = null;
  try {
    const mod = await import('./drawstore.js');
    rec = await mod.getDrawing();
  } catch (err) {
    rec = null;
  }
  if (!rec || !rec.bytes) return 0;

  let out = null;
  try {
    // pdf.js DETACHES the buffer it is handed, so parse a private copy and leave the record usable.
    const buf = rec.bytes.slice(0);
    out = await parseOne(buf, rec.name || 'drawing.pdf', 0, 1);
  } catch (err) {
    console.warn('[plan] could not re-read the drawing to find room positions:', (err && err.message) || err);
    return 0;
  }

  // Match a fresh room to an existing one by page + area + normalised name — the three things a
  // saved room and the drawing must agree on. Keep the first match per key.
  const atKey = (room) => `${Number(room.page) || 1}|${Number(room.area)}|${normalizeRoomName(room.name)}`;
  const byKey = new Map();
  for (const r of (out && out.rooms) || []) {
    if (!r || !r.at || !Number.isFinite(r.at.x) || !Number.isFinite(r.at.y)) continue;
    const k = atKey(r);
    if (!byKey.has(k)) byKey.set(k, r.at);
  }

  let found = 0;
  for (const room of missing) {
    const at = byKey.get(atKey(room));
    if (!at) continue;
    room.at = { x: at.x, y: at.y };   // ONLY the position — every other field is the user's
    found += 1;
  }
  return found;
}

async function planGoTo(n) {
  if (!plan.viewer || plan.unavailable) return;
  const target = Math.max(1, Math.min(plan.pages, n));
  if (target === plan.page) return;
  plan.page = target;
  planSync();
  // remember which page the user is on: a refresh should hand the sheet back where they left it
  state.project.planPage = target;
  saveSoon();
  try {
    await plan.viewer.showPage(target);
    if (plan.overlay) { plan.overlay.resize(); plan.overlay.render(); }
  } catch (err) {
    setStatus('warn', `Could not show page ${target} (${(err && err.message) || err}).`);
  }
  planSync();
}

let zoomBusy = false;
let zoomFactor = 1;

/** Zoom by a factor, coalescing clicks that land faster than a repaint — without losing any of them.
 *  Each setScale cancels the render in flight and paints the page again (half a second on a real CAD
 *  sheet), so one repaint per click queues work that is immediately thrown away and leaves the drawing
 *  showing an intermediate state. Here the counts are accumulated instead: every click multiplies
 *  zoomFactor, and the accumulated factor is applied once to the scale actually in effect. Reading the
 *  factor rather than a target scale is deliberate — several clicks can arrive in the same tick, when
 *  they would all read the same committed scale and the extra steps would be silently lost. */
async function planZoomBy(factor) {
  if (!plan.viewer || plan.unavailable) return;
  zoomFactor *= factor;
  if (zoomBusy) return;
  zoomBusy = true;
  try {
    while (zoomFactor !== 1) {
      const f = zoomFactor;
      zoomFactor = 1;
      await plan.viewer.setScale((plan.viewer.getScale() || 1) * f);
      if (plan.overlay) { plan.overlay.resize(); plan.overlay.render(); }
      planSync();
    }
  } catch (err) {
    setStatus('warn', `Could not zoom (${(err && err.message) || err}).`);
  } finally {
    zoomBusy = false;
  }
}

async function planFitWidth() {
  if (!plan.viewer || plan.unavailable) return;
  try {
    await plan.viewer.fitWidth();
    if (plan.overlay) { plan.overlay.resize(); plan.overlay.render(); }
    planSync();
  } catch (err) {
    setStatus('warn', `Could not fit the drawing (${(err && err.message) || err}).`);
  }
}

function planSetMode(mode) {
  state.ui.planMode = mode === 'select' ? 'select' : 'draw';
  if (plan.overlay) { plan.overlay.setMode(state.ui.planMode); plan.overlay.render(); }
  planSync();
  saveSoon();
}

function planWire() {
  if (plan.wired) return;
  plan.wired = true;
  if (el.planScale) {
    el.planScale.innerHTML = DRAWING_SCALES
      .map((s) => `<option value="${s.denom}">${s.label}</option>`).join('');
    el.planScale.value = String(planScaleDenom());
    el.planScale.addEventListener('change', () => {
      const opt = el.planScale.options[el.planScale.selectedIndex];
      const fromDrawing = !!(opt && opt.dataset && opt.dataset.fromDrawing);
      planApplyScale(el.planScale.value);
      // Choosing the scale the outlines imply re-runs the trace straight away — that is the whole point
      // of offering it. Any other scale change keeps its old behaviour exactly.
      if (fromDrawing) planTraceOutlines();
    });
  }
  if (el.planPrev) el.planPrev.addEventListener('click', () => planGoTo(plan.page - 1));
  if (el.planNext) el.planNext.addEventListener('click', () => planGoTo(plan.page + 1));
  if (el.planZoomIn) el.planZoomIn.addEventListener('click', () => planZoomBy(1.25));
  if (el.planZoomOut) el.planZoomOut.addEventListener('click', () => planZoomBy(1 / 1.25));
  if (el.planFit) el.planFit.addEventListener('click', planFitWidth);
  if (el.planModeDraw) el.planModeDraw.addEventListener('change', () => planSetMode('draw'));
  if (el.planModeSelect) el.planModeSelect.addEventListener('change', () => planSetMode('select'));
  if (el.planPlaceAll) el.planPlaceAll.addEventListener('click', planPlaceAllRooms);
  if (el.planPlaceClear) el.planPlaceClear.addEventListener('click', planClearPlaced);
  if (el.planTraceOutlines) el.planTraceOutlines.addEventListener('click', planTraceOutlines);
  if (el.planTraceClear) el.planTraceClear.addEventListener('click', planTraceClear);
}

/** Open a drawing in the plan panel. Safe to call for every upload: the panel is an enhancement. */
async function openPlan(bytes, opts) {
  if (!bytes || !el.planCard) return;
  const o = opts || {};
  // pdf.js DETACHES the ArrayBuffer it is handed — it transfers it to its worker — so a buffer shared
  // with the parser is already dead for whoever asks second ("ArrayBuffer at index 0 is already
  // detached"). The plan view therefore gets its own copy, taken synchronously here, before any await,
  // because the parse is running concurrently and may detach the original at any moment.
  const own = (bytes instanceof Uint8Array) ? bytes.slice().buffer : bytes.slice(0);
  // a second copy for the browser store: pdf.js will detach `own` during load, and the saved drawing
  // has to outlive that (this is what makes the drawing still be here after a refresh)
  const keep = o.skipStore ? null : own.slice(0);
  // The outline tracer needs the bytes too. Keep this copy in memory so tracing does not depend on the
  // IndexedDB write having finished (a user can click Trace the moment the rooms appear); putDrawing
  // stores it with `owned: true` and a plain structured clone, which copies rather than detaches, so
  // this same buffer stays alive. On a restore there is no `keep` and the tracer reads the stored copy.
  plan.traceBytes = keep;            // null on a restore: the store certainly has the drawing there
  const mods = await ensurePlanModules();
  if (!mods) return;
  plan.bytes = own;
  el.planCard.classList.remove('hidden');
  try {
    if (!plan.viewer) {
      plan.viewer = mods.createViewer(el.planView, {
        pdfjsUrl: new URL('../vendor/pdf.min.mjs', import.meta.url).href,
        workerUrl: pdfjs.GlobalWorkerOptions.workerSrc,
      });
      if (typeof plan.viewer.on === 'function') {
        plan.viewer.on('pagechange', (e) => { if (e && e.page) { plan.page = e.page; planSync(); } });
        plan.viewer.on('rendered', () => {
          plan.page = (typeof plan.viewer.getCurrentPage === 'function') ? plan.viewer.getCurrentPage() : plan.page;
          if (plan.overlay) { plan.overlay.resize(); plan.overlay.render(); }
          planSync();
        });
      }
      plan.overlay = mods.createOverlay(el.planView, {
        getViewport: () => plan.viewer.getViewport(),
        getRooms: () => state.rooms,
        getPage: () => plan.page,
        getSelectedId: () => state.ui.openId || null,
        getScaleDenom: planScaleDenom,
        getMode: () => (state.ui.planMode === 'select' ? 'select' : 'draw'),
        onDraw: planDrawRoom,
        onSelect: planSelectRoom,
        onRoomMoved: planRoomMoved,
        onRoomMoveEnd: planRoomMoveEnd,
        onDelete: planDeleteRoom,
      });
      if (plan.overlay.setMode) plan.overlay.setMode(state.ui.planMode === 'select' ? 'select' : 'draw');
      planWire();
    }
    const info = await plan.viewer.load(own);
    plan.pages = (info && info.pages) || 1;
    if (typeof plan.viewer.fitWidth === 'function') await plan.viewer.fitWidth();
    else await plan.viewer.showPage(1);
    // land on the page the user was last looking at (a reload should hand the sheet back as it was).
    // state.project.planPage WINS: it is updated on every page change, while the stored record's page
    // is only whatever it was when the drawing was saved — preferring that sent the reader back to
    // page 1 after a reload.
    const want = Number(state.project.planPage || o.page) || 1;
    if (want > 1 && want <= plan.pages && typeof plan.viewer.showPage === 'function') {
      await plan.viewer.showPage(want);
    }
    plan.page = (typeof plan.viewer.getCurrentPage === 'function') ? plan.viewer.getCurrentPage() : 1;
    if (plan.overlay) { plan.overlay.resize(); plan.overlay.render(); }
    planSync();
    if (keep) storeDrawing(keep, o.name);
    // bring the drawing into view the first time one loads: the panel is below the upload box, and
    // 'nearest' only scrolls when it is actually off-screen, so it never yanks a visible page around.
    // Never on a restore: reloading a page should leave the reader where they are.
    if (!plan.revealed && !o.restoring) {
      plan.revealed = true;
      try { el.planCard.scrollIntoView({ block: 'nearest' }); } catch (err) { /* older browsers */ }
    }
  } catch (err) {
    // Say it out loud as well as on screen: a silent catch here once hid a broken plan view, and
    // the message was then overwritten by the next status update from the parse.
    console.warn('[plan] could not open the drawing:', (err && err.message) || err);
    setStatus('warn', `The drawing could not be shown in the plan view (${(err && err.message) || err}). ` +
      `The rooms, the table and the load are unaffected.`);
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
  return String(state.project.name || 'loadlens').replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '') || 'loadlens';
}

function exportCsv() {
  if (!state.rooms.length) { setStatus('warn', 'There are no rooms to export yet.'); return; }
  download(safeName() + '-cooling-load.csv', toCsv(state.project, currentCalc()), 'text/csv;charset=utf-8');
  setStatus('ok', 'CSV downloaded.');
}

/** Open the loading report in the page, and print it from there.
 *  It used to be written into a window from window.open(), which a pop-up blocker refuses — and which
 *  an embedded preview pane blocks outright, where "allow pop-ups for this page" cannot help because
 *  there is no browser chrome to allow it in. The report is self-contained (inline styles, no external
 *  files), so an inline frame renders it identically: same document, own styles, its own printing, and
 *  nothing to allow. */
function printReport() {
  if (!state.rooms.length) { setStatus('warn', 'There are no rooms to report yet.'); return; }
  const html = buildReportHtml(state.project, currentCalc());
  const view = el.reportView;
  const frame = el.reportFrame;
  if (!view || !frame) {
    // last resort: the old behaviour, for a page that has no report view
    const w = window.open('', '_blank');
    if (!w) {
      setStatus('err', 'The report could not be shown. Please allow pop-ups for this page and try again.');
      return;
    }
    w.document.open(); w.document.write(html); w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch (e) { /* the user can press the button */ } }, 500);
    setStatus('ok', 'Report opened in a new window.');
    return;
  }
  frame.setAttribute('srcdoc', html);
  view.classList.remove('hidden');
  document.body.classList.add('reporting');
  el.reportClose.focus();
  setStatus(null);
}

function closeReport() {
  const view = el.reportView;
  if (!view || view.classList.contains('hidden')) return false;
  view.classList.add('hidden');
  document.body.classList.remove('reporting');
  // drop the document too: a stale report must not still be printable after new rooms are added
  if (el.reportFrame) el.reportFrame.removeAttribute('srcdoc');
  return true;
}

function printReportFrame() {
  const frame = el.reportFrame;
  if (!frame || !frame.contentWindow) { setStatus('warn', 'The report is not open yet.'); return; }
  try {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  } catch (err) {
    setStatus('warn', `Could not open the print dialog (${(err && err.message) || err}). ` +
      `Use the browser's own Print (Ctrl+P) — the report is on screen.`);
  }
}

function saveProjectFile() {
  download(safeName() + '.json',
    JSON.stringify({ app: 'LoadLens', v: 1, savedAt: new Date().toISOString(), project: state.project, rooms: state.rooms }, null, 2),
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
      setStatus('err', `Could not open this file as a LoadLens project (${(err && err.message) || err}).`);
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
  // The OCR box is off by default. Ticking it only changes the wording here:
  // the tesseract files are fetched the first time a PDF is read with OCR.
  if (el.ocrCheck) {
    el.ocrCheck.addEventListener('change', () => {
      updateParseWhere();
      setStatus(el.ocrCheck.checked ? 'warn' : 'ok', el.ocrCheck.checked
        ? 'OCR is on. PDF drawings will be read with OCR in this browser — slow, and the first run fetches the OCR files.'
        : 'OCR is off. PDF drawings are read normally.');
    });
  }
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
  if (el.reportPrint) el.reportPrint.addEventListener('click', printReportFrame);
  if (el.reportClose) el.reportClose.addEventListener('click', () => { closeReport(); });
  $('#btnSave').addEventListener('click', saveProjectFile);
  $('#btnOpen').addEventListener('click', () => el.jsonInput.click());
  el.jsonInput.addEventListener('change', () => {
    if (el.jsonInput.files && el.jsonInput.files[0]) openProjectFile(el.jsonInput.files[0]);
    el.jsonInput.value = '';
  });

  // Escape backs out one layer at a time: the report if it is open, otherwise the room breakdown
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (closeReport()) return;
    closeDetail();
  });
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
  updateParseWhere(); // the browser text until the one-time check answers
  probeServer();      // asks the server if it is there; never blocks the page
  restoreDrawing();   // put back the drawing this browser kept for us; never blocks either
  if (restored && state.rooms.length) {
    setStatus('ok', `Restored your last work from this browser: ${state.rooms.length} room(s).`);
  } else {
    setStatus(null);
  }
}

start();

/* keep a couple of internals reachable for quick console debugging */
window.webhvac = { state, currentCalc, renderAll, addRooms, buildReportHtml, toCsv, calcRoom, normalizeRoom, planPlaceAllRooms, planClearPlaced, planTraceOutlines, planTraceClear, plan };
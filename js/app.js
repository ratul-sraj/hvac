// LoadLens — app state, room table, events, rendering.
// No frameworks, no build step. Plain ES modules.

import {
  COUNTRIES, CLIMATES, ORIENTS, SPACE_TYPES, DEFAULT_PROJECT,
  normalizeRoom, calcRoom, calcProject, guessSpaceType, NON_AC_WORDS,
} from './calc.js';
import { buildReportHtml, toCsv, fmt, groupByLevel, breakdown, esc, typeLabel } from './report.js';
// The single source of truth for every conversion, unit and label (js/units.js). The load itself is
// always computed in SI; these helpers only convert an already-computed result for display, so the
// screen can never disagree with itself about what a number means. No literal factor is written here.
import {
  air, airUnit, power, powerUnit, area, areaUnit,
  areaPerTr, areaPerTrUnit, length, lengthUnit,
  fmtValue, fmtPower, fmtAir, fmtArea,
  header, systemLabel, normSystem,
} from './units.js';
// Which system the SHEET itself uses (js/unitdetect.js) - plain-English evidence for the user, never a
// silent switch on its own (the project setting decides; detection only informs or offers a one-click).
import { detectUnits } from './unitdetect.js';
import { parsePdf } from './pdfparse.js';
import * as pdfjs from '../vendor/pdf.min.mjs';
import {
  roomFromRect, areaFromRect, dimsFromRect, round2, isDrawnRoom,
  rectFromLabel, isPlacedRoom,
  normalizeRect, rectIsUsable, rectToViewBox, pdfPointToView, viewPointToPdf,
  DRAWING_SCALES, DEFAULT_SCALE_DENOM,
} from './planview.js';
// Pure ring maths for a hand-drawn polygon (js/polyshape.js): the shoelace area in m² (through the
// SAME scale conversion the placed rectangles use) and the simplicity test that lets the app refuse
// a self-crossing or zero-area shape. No DOM, so it is loaded with the app, not on demand.
import { polyAreaM2, ringIsUsable, ringBBox, roundRing } from './polyshape.js';
// The stairwell rule for the "Fill areas" control: js/autotrace.js owns it, and the control needs it
// synchronously to decide whether a blank named room is worth offering (a stairwell never is). The
// matcher itself is still loaded on demand, with the tracer.
import { isStairwellName } from './autotrace.js';
// The location -> design-conditions table and its resolver (js/climates.js): pure data + a pure
// lookup, loaded with the app. The auto-detect wiring below uses it; nothing here touches the DOM.
import { resolveClimate, countryFromTimezone, countryFromLocale, locationKey } from './climates.js';
// Anonymous usage counting (js/usage.js): a strict allowlist of real actions plus
// the utm_* campaign tags already in the URL. No cookies, no ids, no plan data —
// see the module header. Every call is a no-op if counting is unavailable.
import { track, bucketBytes, bucketPages, bucketRooms } from './usage.js';

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
const MISSING_AUTOTRACE = 'the area filler (js/autotrace.js) is not in this build';

// vendored tesseract files, served from the site (no CDN at runtime)
const OCR_VENDOR = new URL('../vendor/tesseract/', import.meta.url).href;

let scheduleMod = null, scheduleTried = false;
let ocrMod = null, ocrTried = false;
let traceMod = null, traceTried = false;
let autotraceMod = null, autotraceTried = false;

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

/** js/autotrace.js — pure geometry: traced regions + named rooms -> confident areas, or a reason why
 *  not. Loaded on demand like the tracer, so a build without it still runs the calculator. */
async function loadAutotraceModule() {
  if (!autotraceMod && !autotraceTried) {
    autotraceTried = true;
    try { autotraceMod = await import('./autotrace.js'); } catch (e) { autotraceMod = null; }
  }
  if (!autotraceMod || typeof autotraceMod.matchRoomsToRegions !== 'function') throw new Error(MISSING_AUTOTRACE);
  return autotraceMod;
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
    planMode: 'shape',
    // True while the automatic "place then trace" of a freshly opened plan runs, so a manual press of
    // a plan button during it is a no-op rather than a second run (see maybeAutoSetupPlan).
    autoSetupBusy: false,
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
  // Sticky totals bar (UX pass). Its text is written from renderSummary() so it always matches the
  // summary card exactly. The bar itself is hidden while nothing is included in the load.
  totalsBar: $('#totalsBar'),
  tbTr: $('#tbTr'),
  tbAir: $('#tbAir'),
  tbRooms: $('#tbRooms'),
  quickStart: $('#quickStart'),
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
  planModeShape: $('#planModeShape'),
  planModeSelect: $('#planModeSelect'),
  planPlaceAll: $('#planPlaceAll'),
  planPlaceClear: $('#planPlaceClear'),
  planTraceOutlines: $('#planTraceOutlines'),
  planTraceClear: $('#planTraceClear'),
  planFillAreas: $('#planFillAreas'),
  planFillUndo: $('#planFillUndo'),
  planShapeAssign: $('#planShapeAssign'),
  planShapeAssignRoom: $('#planShapeAssignRoom'),
  planShapeAssignGo: $('#planShapeAssignGo'),
  planShapeAssignClose: $('#planShapeAssignClose'),
  planHint: $('#planHint'),
  planShapeLink: $('#planShapeLink'), planShapeLinkName: $('#planShapeLinkName'),
  planLinkTarget: $('#planLinkTarget'), planLinkMove: $('#planLinkMove'), planLinkDetach: $('#planLinkDetach'),
  planStatus: $('#planStatus'),
  planScaleFix: $('#planScaleFix'),
  planProgress: $('#planProgress'),
  planProgressText: $('#planProgressText'),
  planProgressFill: $('#planProgressFill'),
  projectPanel: $('#projectPanel'),
  unitsSi: $('#proj-units-si'),
  unitsIp: $('#proj-units-ip'),
  unitDetect: $('#unitDetect'),
  geoNote: $('#geoNote'),
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

/** The one place a status message's TEXT lives, exactly as before.
 *  `scope` may be 'plan': the SAME string is also mirrored into the plan panel's own message line
 *  (#planStatus, aria-live) so an answer to a plan-panel button is visible where the user is looking.
 *  #statusBox lives in the upload section, ~155 px above the plan panel's buttons — off-screen, so
 *  "Real outlines for 105 of 159 room(s)…" was never seen (UX review, item 1). The text is built once
 *  and passed to both, never duplicated. */
function setStatus(kind, msg, scope) {
  if (!msg) {
    el.statusBox.classList.add('hidden'); el.statusBox.textContent = '';
    if (scope === 'plan') hidePlanStatus();
    return;
  }
  el.statusBox.className = 'status ' + (kind || '');
  el.statusBox.textContent = msg;
  el.statusBox.classList.remove('hidden');
  if (scope === 'plan') showPlanStatus(kind, msg);
}

/** Mirror a status message into the plan panel's own line (see setStatus).
 *  Good news fades itself away after 10 s (the room count after outlining has
 *  been read by then); problems stay on screen until the next action. */
let planStatusTimer = 0;
function showPlanStatus(kind, msg) {
  if (!el.planStatus) return;
  el.planStatus.className = 'plan-status ' + (kind || '');
  el.planStatus.textContent = msg;
  el.planStatus.classList.remove('hidden');
  placePlanStatus();
  // Re-measure on the next frame: the toast's wrapped height can settle a frame after its text
  // changes, so a single pass can position it using a stale height and leave it over the drawing.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(placePlanStatus);
  clearTimeout(planStatusTimer);
  if (kind !== 'warn' && kind !== 'err') {
    planStatusTimer = setTimeout(hidePlanStatus, 10000);
  }
}

/** Keep the fixed plan toast clear of the drawing. It used to sit at the bottom-centre of the
 *  viewport, which is exactly where the plan view is while the user works on it — right after Place
 *  all / draw the toast covered the rooms being worked on for its 10 s. Prefer the strip under the
 *  sticky header; if that would sit over #planView, move it just below the drawing, or just above it
 *  when the drawing reaches the bottom of the screen. Re-run on scroll/resize so it stays clear. */
function placePlanStatus() {
  const t = el.planStatus;
  if (!t || t.classList.contains('hidden')) return;
  const vh = window.innerHeight || 0;
  const gap = 10;
  const h = t.offsetHeight || 0;
  const nav = document.querySelector('.app-nav');
  const navBottom = nav ? Math.max(0, nav.getBoundingClientRect().bottom) : 0;
  let top = navBottom + gap;
  const view = el.planView;
  if (view) {
    const r = view.getBoundingClientRect();
    const overlaps = (y) => y < r.bottom + gap && y + h > r.top - gap;
    if (overlaps(top)) {
      const below = r.bottom + gap;
      const above = r.top - h - gap;
      // Prefer a position that fully clears the drawing. The old test required a whole `gap` of room at
      // the bottom, and fractional rects made it fail by a fraction of a pixel - the toast then fell
      // through to a fallback that sat over the drawing. Fit within the viewport instead, and only fall
      // back to the least-bad clamped spot when neither side has room.
      if (below + h <= vh) top = below;
      else if (above >= navBottom) top = above;
      else top = Math.max(navBottom + gap, Math.min(above, vh - h));
    }
  }
  t.style.top = Math.round(top) + 'px';
}

function hidePlanStatus() {
  clearTimeout(planStatusTimer);
  if (!el.planStatus) return;
  el.planStatus.classList.add('hidden');
  el.planStatus.textContent = '';
}

function setProgress(text, pct) {
  if (text === null) {
    el.progressBox.classList.add('hidden');
    el.progressBox.classList.remove('indeterminate');
    el.progressBox.setAttribute('aria-hidden', 'true');
    return;
  }
  el.progressBox.classList.remove('hidden');
  el.progressBox.removeAttribute('aria-hidden');
  el.progressText.textContent = text;
  if (pct == null) {
    // The total is genuinely unknown: an INDETERMINATE bar. No aria-valuenow, no made-up percentage.
    el.progressBox.classList.add('indeterminate');
    el.progressBox.removeAttribute('aria-valuenow');
    el.progressFill.style.width = '';
    return;
  }
  el.progressBox.classList.remove('indeterminate');
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  el.progressBox.setAttribute('aria-valuenow', String(Math.round(p)));
  el.progressFill.style.width = p + '%';
}

function currentCalc() {
  return calcProject(state.rooms, state.project);
}

/** The system every DISPLAYED figure follows. Never the calculation - js/calc.js is always SI. */
const unitsSys = () => normSystem(state.project.units);

/** SI area served per ton (m²/TR), from the SI area and the SI tonnage. Never a stored imperial
 *  figure: the ft²/TR the user sees in imperial is derived from THIS through units.js, so the two
 *  systems can never drift apart. */
const m2PerTr = (areaM2, tr) => (tr > 0 ? Math.max(0, Number(areaM2) || 0) / tr : 0);

// Anonymous, once-per-page-load signal that a calculation produced zero included
// rooms — the honest "it did not work for me" case (a load that added nothing, or
// every room excluded). Sent at most once, and only after a real attempt, so an
// untouched empty page never counts. See js/usage.js.
let calcEmptySent = false;
function noteCalcEmpty(source) {
  if (calcEmptySent) return;
  if (currentCalc().totals.rooms > 0) return;
  calcEmptySent = true;
  track('calc_empty', { source });
}

// Anonymous, once-per-upload signal that a drawing / scan / schedule upload FAILED or produced no
// rooms. The reason is one coarse allowlisted word (js/usage.js) — never the error message, the file
// name or anything from the plan. The first reason seen in an upload attempt wins.
let parseFailedSent = false;
let uploadFailReason = '';
function noteParseFailed(reason) {
  if (parseFailedSent) return;
  parseFailedSent = true;
  track('parse_failed', { reason });
}

// The one drop-off signal: how far a visit got, sent on the way out (pagehide, or a hidden tab as a
// fallback) through the existing beacon path. `exportedThisLoad` is set by the CSV download and by
// opening the report; the rest is read live from state, so a restored project counts too.
let leftSent = false;
let exportedThisLoad = false;
function leftPageStage() {
  try {
    if (exportedThisLoad) return 'exported';
    if (currentCalc().totals.tr > 0) return 'has_load';
    if (state.rooms && state.rooms.length) return 'has_rooms';
    return 'loaded';
  } catch (e) {
    return 'nothing';
  }
}
function sendLeftPage() {
  if (leftSent) return;
  leftSent = true;
  try { track('left_page', { stage: leftPageStage() }); } catch (e) { /* never break the unload */ }
}
function initDropoffTracking() {
  try {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('pagehide', sendLeftPage);
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') sendLeftPage();
      });
    }
  } catch (e) { /* counting must never break the app */ }
}

// Which FILE GROUP an uncaught error came from, most specific first. Only the group is ever sent
// (js/usage.js) — never the message, the stack, a URL or a line number. track() caps js_error at 3
// per page load, so a broken loop cannot flood the counter.
const JS_ERROR_AREAS = [
  [/pdfparse|ocr|schedule/i, 'parse'],
  [/trace|autotrace|overlay|planview/i, 'trace'],
  [/calc/i, 'calc'],
  [/app|viewer|report/i, 'ui'],
];
function jsErrorArea(source) {
  const s = String(source == null ? '' : source);
  for (const [re, area] of JS_ERROR_AREAS) if (re.test(s)) return area;
  return 'other';
}
function noteJsError(source) {
  try { track('js_error', { area: jsErrorArea(source) }); } catch (e) { /* swallowed */ }
}
function initErrorTracking() {
  try {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('error', (ev) => {
      try {
        const src = (ev && (ev.filename || (ev.error && ev.error.stack))) || '';
        noteJsError(src);
      } catch (e) { /* the handler itself must never throw */ }
    });
    window.addEventListener('unhandledrejection', (ev) => {
      try {
        const r = ev && ev.reason;
        // classify by the stack only (a file name); a bare reason has no source file -> 'other'
        noteJsError((r && typeof r === 'object' && r.stack) || '');
      } catch (e) { /* the handler itself must never throw */ }
    });
  } catch (e) { /* counting must never break the app */ }
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: 1, project: state.project, rooms: state.rooms,
      // The plan mode is remembered too, so a reload hands the panel back as the user left it.
      // An older saved project may carry the retired 'draw' mode; loadStored migrates it.
      ui: { planMode: state.ui.planMode },
    }));
  } catch (e) {
    /* storage full or blocked: not fatal */
  }
}

/** The two plan modes the UI offers. Anything else — including the retired 'draw' — becomes
 *  'shape', so an old saved mode can never leave the panel without a drawing tool. */
function normalizePlanMode(m) {
  return m === 'select' ? 'select' : 'shape';
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
      // SILENT migration: a project saved by an older version may hold the retired 'draw' mode
      // (the panel used to offer Draw room / Draw shape / Select). It becomes 'shape' here, with
      // nothing said on screen — the two-gesture shape tool covers what Draw room used to do.
      if (data.ui && data.ui.planMode != null) state.ui.planMode = normalizePlanMode(data.ui.planMode);
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
  syncUnitsControl();
  // A project can carry a scale the preset list does not contain (a custom 1:N). Rebuild the drawing-
  // scale list so the select SHOWS that value again instead of snapping to the nearest preset — which
  // would silently change EVERY area on the next edit.
  planRenderScaleOptions();
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
/* results system: metric (SI) or imperial (IP)                        */
/* ------------------------------------------------------------------ */
// STATE: proj.units = 'si' | 'ip' (default 'si' in DEFAULT_PROJECT, js/calc.js). 'unitsExplicit' is
// only set when the USER picks a system here. That distinction is the whole point: an explicit choice
// always wins, while a system the detector merely suggested may be replaced when a later sheet says
// something different. A saved project without either field reads as metric/SI and not-explicit.

/** Point the radio control at state.project.units and label both choices from js/units.js. */
function syncUnitsControl() {
  const sys = unitsSys();
  if (el.unitsSi) {
    el.unitsSi.checked = sys === 'si';
    el.unitsSi.parentNode.querySelector('span').textContent = systemLabel('si');
  }
  if (el.unitsIp) {
    el.unitsIp.checked = sys === 'ip';
    el.unitsIp.parentNode.querySelector('span').textContent = systemLabel('ip');
  }
}

/** Choose the results system.
 *  explicit: the user clicked it, so the choice is remembered and detection can no longer switch it. */
function setUnits(sys, opts) {
  const next = normSystem(sys);
  state.project.units = next;
  if (opts && opts.explicit) state.project.unitsExplicit = true;
  detectSwitched = false;         // a by-hand choice is not an automatic follow any more
  syncUnitsControl();
  renderAll();
  saveSoon();
  updateUnitDetectLine();
}

/* ------------------------------------------------------------------ */
/* what the SHEET says it is (js/unitdetect.js)                        */
/* ------------------------------------------------------------------ */

// The last detection, kept so the line can be redrawn when the setting changes without re-parsing.
let lastDetection = null;
// True while the current line reflects an automatic follow of the detection (cleared if the user
// then chooses a system by hand, so the line stops claiming the app switched for them).
let detectSwitched = false;

/** Ask js/unitdetect.js what system the drawing uses and show one plain line beside the plan panel.
 *  Behaviour follows the contract: the project setting decides. Detection only auto-follows when it
 *  says imperial AND the user has not chosen a system explicitly; otherwise it just informs, with a
 *  one-click switch when the two disagree. A sheet with no evidence says so plainly - never "error",
 *  never a guess. */
function noteDetectedUnits(parseResult) {
  let det = null;
  try { det = detectUnits(parseResult); } catch (e) { det = null; }
  if (!det || typeof det !== 'object') {
    det = {
      system: 'unknown', confidence: 'none',
      reason: 'This sheet does not state whether its measurements are metric or imperial, so the results stay in the system you have chosen.',
    };
  }
  lastDetection = det;

  // Follow the detection ONLY when it says imperial and the user has not chosen explicitly.
  let switched = false;
  if (det.system === 'ip' && !state.project.unitsExplicit && unitsSys() !== 'ip') {
    state.project.units = 'ip';
    switched = true;
    syncUnitsControl();
    saveSoon();
  }
  updateUnitDetectLine(switched);
  renderAll();
}

/** Draw the detection line (#unitDetect). `switched` says whether we just followed the detection;
 *  when omitted the last known state is reused, so a plain re-render never drops that clause. */
function updateUnitDetectLine(switched) {
  if (switched === undefined) switched = detectSwitched; else detectSwitched = switched;
  const node = el.unitDetect || document.getElementById('unitDetect');
  if (!node) return;
  if (!lastDetection) { node.classList.add('hidden'); node.textContent = ''; return; }
  const d = lastDetection;
  const sys = unitsSys();
  const reason = String(d.reason || '').trim()
    || 'This sheet does not state whether its measurements are metric or imperial.';
  let text = reason;
  if (switched) text += ` This sheet looks imperial, so the results are now shown in ${systemLabel('ip')}.`;
  else if ((d.system === 'si' || d.system === 'ip') && d.system !== sys) {
    text += ` The results are being shown in ${systemLabel(sys)}.`;
  }
  node.innerHTML = '';
  node.classList.remove('hidden');
  const span = document.createElement('span');
  span.textContent = text;
  node.appendChild(span);
  // One-click switch when the sheet and the chosen system disagree.
  if (!switched && (d.system === 'si' || d.system === 'ip') && d.system !== sys) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'unitDetectSwitch';
    btn.className = 'btn btn-small btn-ghost';
    btn.textContent = `Show results in ${systemLabel(d.system)}`;
    btn.addEventListener('click', () => setUnits(d.system, { explicit: true }));
    node.appendChild(document.createTextNode(' '));
    node.appendChild(btn);
  }
}

/* ------------------------------------------------------------------ */
/* location-aware design conditions (auto-detect, once per visitor)    */
/* ------------------------------------------------------------------ */
// On a first visit the outdoor design conditions are pre-filled from a free IP-geolocation lookup,
// mapped through the EDITABLE table in js/climates.js. The rules, in order of importance:
//   * saved values are never overwritten — the chip offers a [Use detected values] button instead;
//   * manual edits always win;
//   * the chip is dismissible, and stays dismissed for that location;
//   * offline / blocked / unknown location falls back to the timezone or locale (country level),
//     and if even that names nothing the fields are left exactly as they were.
// The lookup result is cached for 30 days. The page works fully with the network off.

const GEO_CACHE_KEY = 'webhvac.geo.v1';       // the 30-day IP-lookup cache
const GEO_DISMISS_KEY = 'webhvac.geo.dismissed.v1'; // the locations the visitor said "no thanks" to
const GEO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GEO_TIMEOUT_MS = 7000;

let geoRan = false;            // the whole dance runs at most once per page load
let hadStoredProject = false;  // was there a saved project when the page started?

function readGeoCache() {
  try {
    const raw = localStorage.getItem(GEO_CACHE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return null;
    if (!Number.isFinite(d.ts) || (Date.now() - d.ts) > GEO_TTL_MS) return null;
    if (!d.country && !d.region && !d.city) return null;
    return { country: String(d.country || ''), region: String(d.region || ''), city: String(d.city || ''), source: String(d.source || 'ip') };
  } catch (e) { return null; }   // storage blocked: behave as if there were no cache
}

function writeGeoCache(loc) {
  try {
    localStorage.setItem(GEO_CACHE_KEY, JSON.stringify({
      ts: Date.now(), country: loc.country, region: loc.region, city: loc.city, source: loc.source,
    }));
  } catch (e) { /* storage full or blocked: not fatal */ }
}

function geoDismissed() {
  try {
    const arr = JSON.parse(localStorage.getItem(GEO_DISMISS_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function isDismissedFor(loc) {
  return geoDismissed().includes(locationKey(loc.country, loc.region, loc.city));
}

function rememberDismissed(loc) {
  const key = locationKey(loc.country, loc.region, loc.city);
  const arr = geoDismissed();
  if (!arr.includes(key)) arr.push(key);
  try { localStorage.setItem(GEO_DISMISS_KEY, JSON.stringify(arr.slice(-25))); } catch (e) { /* not fatal */ }
}

function geoAbortSignal() {
  try {
    return (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
      ? AbortSignal.timeout(GEO_TIMEOUT_MS) : undefined;
  } catch (e) { return undefined; }
}

async function geoFetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' }, signal: geoAbortSignal(), credentials: 'omit', cache: 'no-store',
  });
  if (!res || !res.ok) throw new Error('geo HTTP ' + (res && res.status));
  return res.json();
}

// Two free, keyless, HTTPS + CORS endpoints. ipwho.is first; ipapi.co if it is unreachable.
// Verified response shapes (see docs/USER-GUIDE.md): ipwho.is -> { country, region, city, success };
// ipapi.co -> { country_name, region, city, error }.
async function detectFromIp() {
  try {
    const d = await geoFetchJson('https://ipwho.is/');
    if (d && d.success !== false && (d.country || d.region || d.city)) {
      return { country: d.country || '', region: d.region || '', city: d.city || '', source: 'ipwho.is' };
    }
  } catch (e) { /* offline, blocked or rate-limited: fall through */ }
  try {
    const d = await geoFetchJson('https://ipapi.co/json/');
    if (d && !d.error && (d.country_name || d.region || d.city)) {
      return { country: d.country_name || '', region: d.region || '', city: d.city || '', source: 'ipapi.co' };
    }
  } catch (e) { /* nothing either: the caller falls back to the locale */ }
  return null;
}

// The offline fallback: name a country from the browser's own clock/locale. It only ever yields a
// COUNTRY, so the suggestion can only ever be a country-level one — no city is ever assumed.
function detectFromLocale() {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { tz = ''; }
  const byTz = countryFromTimezone(tz);
  if (byTz) return { country: byTz, region: '', city: '', source: 'timezone' };
  let lang = '';
  try { lang = (typeof navigator !== 'undefined' && navigator.language) || ''; } catch (e) { lang = ''; }
  const byLocale = countryFromLocale(lang);
  if (byLocale) return { country: byLocale, region: '', city: '', source: 'locale' };
  return null;
}

function outdoorFieldsEmpty() {
  const empty = (i) => !i || String(i.value).trim() === '';
  return empty(projInput('outDb')) && empty(projInput('outWb'));
}

// The city shown when the location match is COUNTRY-level: the country is known but no single city was
// assumed, so the country dropdown must not fall back to "Custom" (which would deny the match the chip
// already announced). A sentinel that no climate row carries keeps applyClimate() from overwriting the
// paired country-level DB/WB with some arbitrary city's values.
const COUNTRY_LEVEL_CITY = '(country-level)';

// Put the suggestion into the fields. A detected city the app's own country list knows is selected
// properly so the two dropdowns stay consistent; anything else (e.g. London, which has no row in
// the older js/calc.js list) is marked 'Custom', so the pair is honoured exactly as suggested
// rather than silently relabelled as some other city's climate. A COUNTRY-level match keeps the
// country's own name in the dropdown (the country IS known) and marks the city as country-level.
function applyDetectedClimate(match, loc) {
  const known = loc.city ? CLIMATES[loc.city] : null;
  if (known) {
    state.project.country = known.country;
    state.project.city = loc.city;
  } else if (match && match.matched === 'country' && loc.country && COUNTRIES[loc.country]) {
    state.project.country = loc.country;
    state.project.city = COUNTRY_LEVEL_CITY;
  } else {
    state.project.country = 'Custom';
    state.project.city = 'Custom';
  }
  state.project.outDb = match.db;
  state.project.outWb = match.wb;
  syncProjectInputs();
  renderAll();
  if (state.ui.openId) renderDetail(currentCalc());
  saveNow();
}

function detectedLabel(loc, match) {
  const bits = [];
  if (match.matched === 'city' && loc.city) bits.push(loc.city);
  if (match.matched !== 'country' && loc.region) bits.push(loc.region);
  if (loc.country) bits.push(loc.country);
  return bits.filter(Boolean).join(', ');
}

const GEO_LEVEL_NOTE = { region: ' (region-level match)', country: ' (country-level match)' };

function hideGeoNote() {
  if (!el.geoNote) return;
  el.geoNote.classList.add('hidden');
  el.geoNote.innerHTML = '';
}

// mode === 'filled': the fields were empty, so the suggestion is already IN them.
// mode === 'offer':  saved values were left alone; the visitor can apply the suggestion on request.
function showGeoNote(loc, match, mode) {
  if (!el.geoNote) return;
  const place = detectedLabel(loc, match) || loc.country || 'your location';
  const level = GEO_LEVEL_NOTE[match.matched] || '';
  const head = mode === 'filled'
    ? `Detected <strong>${esc(place)}${esc(level)}</strong> — design conditions filled from an editable table.`
    : `Detected <strong>${esc(place)}${esc(level)}</strong>. Your saved design conditions were left alone.`;
  const verify = ' Verify against ISHRAE / ASHRAE before engineering use.';
  const action = mode === 'filled'
    ? '<button type="button" class="btn btn-small btn-ghost" data-act="change">Change</button>'
    : '<button type="button" class="btn btn-small" data-act="apply">Use detected values</button>';
  el.geoNote.innerHTML =
    `<span class="geo-text">${head}${verify}</span>` +
    `<span class="geo-actions">${action}` +
    `<button type="button" class="btn btn-small btn-ghost" data-act="dismiss">Dismiss</button></span>`;
  el.geoNote.classList.remove('hidden');

  const change = el.geoNote.querySelector('[data-act="change"]');
  if (change) change.addEventListener('click', () => {
    const i = projInput('outDb');
    if (i) { i.focus(); if (i.select) i.select(); }
  });
  const applyBtn = el.geoNote.querySelector('[data-act="apply"]');
  if (applyBtn) applyBtn.addEventListener('click', () => {
    applyDetectedClimate(match, loc);
    rememberDismissed(loc);   // done for this location: do not nag again
    hideGeoNote();
    setStatus('ok', `Design conditions set to ${place} — ${match.db} °C DB / ${match.wb} °C WB.`);
  });
  const dismiss = el.geoNote.querySelector('[data-act="dismiss"]');
  if (dismiss) dismiss.addEventListener('click', () => { rememberDismissed(loc); hideGeoNote(); });
}

async function autoDetectClimate() {
  if (geoRan) return;
  geoRan = true;
  try {
    let loc = readGeoCache();
    let match = loc ? resolveClimate(loc.country, loc.region, loc.city) : null;
    if (!match || !match.matched) {
      const ip = await detectFromIp();
      if (ip) { writeGeoCache(ip); loc = ip; match = resolveClimate(ip.country, ip.region, ip.city); }
    }
    if (!match || !match.matched) {
      const fb = detectFromLocale();
      if (fb) { loc = fb; match = resolveClimate(fb.country, fb.region, fb.city); }
    }
    if (!loc || !match || !match.matched || !Number.isFinite(match.db) || !Number.isFinite(match.wb)) return;
    if (isDismissedFor(loc)) return;
    if (!hadStoredProject || outdoorFieldsEmpty()) {
      applyDetectedClimate(match, loc);
      showGeoNote(loc, match, 'filled');
    } else {
      showGeoNote(loc, match, 'offer');
    }
  } catch (e) {
    /* Detection is a convenience, never a requirement: any failure leaves the page untouched. */
  }
}

/* ------------------------------------------------------------------ */
/* rooms: add / delete / bulk                                         */
/* ------------------------------------------------------------------ */

function sameRoom(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm(a.name) !== norm(b.name)) return false;
  if (String(a.level || '') !== String(b.level || '')) return false;
  const aa = parseFloat(a.area) || 0, ba = parseFloat(b.area) || 0;
  if (Math.abs(aa - ba) >= 0.05) return false;
  // Two rooms with NO area cannot be told apart by name + level alone. A plan that prints room NAMES
  // but no AREAS (the LEVEL 11 sample: six rooms called MEETING ROOM, seven called MONITOR) would have
  // all but one of each name dropped here as a "duplicate" — silently losing real rooms and making the
  // parser's own "56 room names detected" note contradict the table. When neither room carries an area,
  // fall back to the point that names it on the sheet (room.at), so distinct rooms stay distinct while
  // re-loading the SAME drawing still de-duplicates (the label sits at the same point). Rooms with an
  // area, or with no position, keep the original name + level + area behaviour.
  if (aa === 0 && ba === 0 && a.at && b.at
    && Number.isFinite(a.at.x) && Number.isFinite(a.at.y)
    && Number.isFinite(b.at.x) && Number.isFinite(b.at.y)) {
    return Math.abs(a.at.x - b.at.x) < 0.5 && Math.abs(a.at.y - b.at.y) < 0.5;
  }
  return true;
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

/* ---- one-step undo for a deleted room -----------------------------------------------------------
 * Deleting a room is otherwise permanent (state.rooms is auto-saved to this browser), so a mis-click
 * costs the row. Keep the room OBJECT and its index from the most recent delete only; the small
 * button beside Add/Clear restores it, fields (area, poly, areaFromDrawing, page, ...) intact. */
let deleteUndo = null;        // { room, index } of the MOST RECENT delete, or null
let btnUndoDelete = null;     // the button, created lazily (app.html is not edited for this)

/** Create the Undo-delete button beside #btnClear once, and wire it. Returns the button (or null if
 *  the toolbar is not in the DOM, e.g. an unusual embed). */
function ensureUndoDeleteButton() {
  if (btnUndoDelete) return btnUndoDelete;
  const clearBtn = $('#btnClear');
  if (!clearBtn || !clearBtn.parentNode) return null;
  const b = document.createElement('button');
  b.type = 'button';
  b.id = 'btnUndoDelete';
  b.className = 'btn btn-danger-ghost btn-undo-delete';
  b.hidden = true;
  b.disabled = true;
  b.textContent = 'Undo delete';
  b.addEventListener('click', undoDeleteRoom);
  clearBtn.parentNode.insertBefore(b, clearBtn.nextSibling);
  btnUndoDelete = b;
  return b;
}

/** Reflect the single undoable delete on the button: labelled with the room, enabled only while a
 *  delete can still be undone, hidden otherwise. */
function updateUndoDeleteButton() {
  const b = ensureUndoDeleteButton();
  if (!b) return;
  if (deleteUndo && deleteUndo.room) {
    b.hidden = false;
    b.disabled = false;
    b.textContent = `Undo delete (${deleteUndo.room.name || 'room'})`;
    b.setAttribute('aria-label', b.textContent);
  } else {
    b.hidden = true;
    b.disabled = true;
    b.textContent = 'Undo delete';
    b.setAttribute('aria-label', 'Undo delete');
  }
}

/** Forget the undoable delete (used when the whole room list is replaced or cleared). */
function clearDeleteUndo() {
  deleteUndo = null;
  updateUndoDeleteButton();
}

/** Put the most recently deleted room back at its old index, with every field as it was. */
function undoDeleteRoom() {
  if (!deleteUndo || !deleteUndo.room) return;
  const { room, index } = deleteUndo;
  deleteUndo = null;                       // the undo is single-use
  const at = Math.max(0, Math.min(Number(index) || 0, state.rooms.length));
  state.rooms.splice(at, 0, room);
  updateUndoDeleteButton();
  renderAll();
  saveSoon();
  setStatus('ok', `Put ${room.name || 'the room'} back at its old place in the table.`);
  try {
    const tr = el.roomsBody && el.roomsBody.querySelector(`tr[data-id="${room.id}"]`);
    if (tr) { scrollRowIntoView(tr); flashTableRow(tr); }
  } catch (err) { /* ignore */ }
}

function deleteRoom(idx) {
  const room = state.rooms[idx];
  if (!room) return;
  if (state.ui.openId === room.id) closeDetail();
  state.rooms.splice(idx, 1);
  deleteUndo = { room, index: idx };       // only the MOST RECENT delete is undoable
  renderAll();
  saveSoon();
  updateUndoDeleteButton();
  setStatus('ok', `Removed ${room.name || 'the room'} — press Undo delete (${room.name || 'room'}) to put it back.`);
}

function visibleIndices() {
  const q = state.ui.q.trim().toLowerCase();
  const lvl = state.ui.level;
  const idc = [];
  state.rooms.forEach((r, i) => {
    const rn = normalizeRoom(r, state.project);
    if (lvl !== 'all' && ((rn.level || '').trim() || 'Unspecified') !== lvl) return;
    // Search the labels the user can SEE, not only the name: the space type is shown in its own
    // column, so typing "conference" must find the rooms whose name is "CONF. RM." and whose type
    // reads "Conference/Meeting".
    if (q && !String(rn.name || '').toLowerCase().includes(q)
      && !typeLabel(rn.type).toLowerCase().includes(q)) return;
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
  drawn: 'drawn',       // a shape the user drew on the plan by hand (not traced, not placed)
};

function sourceLabel(src) {
  return SOURCE_LABEL[String(src || '').toLowerCase()] || '';
}

/** The badge that says this room's AREA was filled from the drawing's own outlines (the "Fill areas
 *  from the drawing" control), not typed by the user or printed on the sheet. It disappears the
 *  moment the user edits the area by hand. */
function areaBadge(raw) {
  if (!raw || !raw.areaFromDrawing) return '';
  const a = Number(raw.area);
  const title = Number.isFinite(a) && a > 0
    ? `area filled from the drawing's own outline: ${fmtArea(a, unitsSys())} ${areaUnit(unitsSys())} — check it against the plan`
    : "area filled from the drawing's own outline";
  return ` <span class="row-badge is-autofill" title="${esc(title)}">area from drawing</span>`;
}

/** The little badge that says what shape this room has on the plan: a real outline traced from the
 *  drawing's own linework, or a box (placed locator or hand-drawn). Nothing when it has neither.
 *  The title spells out traced-vs-stated, because that difference is the whole point of the trace. */
function shapeBadge(raw) {
  const hasPoly = !!(raw && Array.isArray(raw.poly) && raw.poly.length > 2);
  const hasRect = !!(raw && raw.rect);
  if (hasPoly) {
    if (raw.source === 'drawn') {
      const a = Number(raw.area);
      const title = Number.isFinite(a) && a > 0
        ? `shape drawn on the plan by hand; its area, ${fmtArea(a, unitsSys())} ${areaUnit(unitsSys())}, is the drawn shape's own area`
        : 'shape drawn on the plan by hand';
      return ` <span class="row-badge is-outline" title="${esc(title)}">drawn</span>`;
    }
    const traced = Number(raw.polyArea), stated = Number(raw.area);
    const title = Number.isFinite(traced) && traced > 0 && Number.isFinite(stated) && stated > 0
      ? `outline traced from the drawing: ${fmtArea(traced, unitsSys())} ${areaUnit(unitsSys())} traced against ${fmtArea(stated, unitsSys())} ${areaUnit(unitsSys())} stated`
      : 'outline traced from the drawing';
    return ` <span class="row-badge is-outline" title="${esc(title)}">outline</span>`;
  }
  // A placed/drawn BOX gets no badge: it is a locator square sized back from the stated area, so it
  // tells the user nothing about the area or the load, and owners read the pill as clutter.
  return '';
}

/** One plain line for the detail panel saying where this room's shape comes from — the drawn shape's
 *  own area, or the plan's stated area for a traced outline. Empty when the room has no polygon. */
function shapeNote(raw) {
  if (!raw || !Array.isArray(raw.poly) || raw.poly.length <= 2) return '';
  return raw.source === 'drawn'
    ? '&middot; shape drawn on the plan (the area is the drawn shape)'
    : "&middot; outline traced from the drawing (the area is the plan's stated area)";
}

/**
 * The shape's LINK, shown in a room's load breakdown when that room carries geometry from the plan.
 * The link is otherwise invisible: a drawn room simply IS a table row, so if the wrong row was picked
 * when the shape was closed, nothing on screen says so and there is no way back. This names the row the
 * shape belongs to and offers the two corrections people actually need - move the shape to another row,
 * or take the shape off this row and keep the room as a typed one.
 */
/** Rooms in the order EVERY picker must list them: alphabetically by room name, then room number, then
 *  level — case-insensitive and numeric-aware, so "Office 2" comes before "Office 10". One shared sort
 *  so the chooser after a shape is drawn and the two shape-link lists cannot drift apart. `exclude`
 *  drops a single row (the shape's current owner) where a list must not offer it. */
function pickerRooms(exclude) {
  const keyed = state.rooms
    .filter((r) => !exclude || r.id !== exclude.id)
    .map((r) => {
      const n = normalizeRoom(r, state.project);
      return {
        r,
        name: String(n.name || ''),
        number: String(n.number == null ? '' : n.number),
        level: String(n.level || ''),
      };
    });
  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  keyed.sort((a, b) => cmp(a.name, b.name) || cmp(a.number, b.number) || cmp(a.level, b.level));
  return keyed.map((k) => k.r);
}

/** The rows a shape could be linked to, as <option> markup. Shared by the bar under the drawing and the
 *  block in the load breakdown so the two lists cannot drift apart, and listed ALPHABETICALLY (see
 *  pickerRooms) so a long table is not a hunt through sheet order. */
function shapeTargetOptions(raw) {
  return pickerRooms(raw)
    .map((x) => `<option value="${esc(x.id)}">${esc(roomOptionLabel(x))}</option>`).join('');
}

/**
 * ONE label for a room row, shared by every picker that asks the user to name a row (the chooser that
 * opens after a shape is drawn, the shape-link bar under the drawing and the link block in the load
 * breakdown). Built in one place so the three lists cannot drift apart.
 *
 * The room NUMBER comes first when the sheet prints one: a plan often carries several rows with the
 * same name (the office sample has four MEETING ROOMs), and when the user has to pick "which room is
 * this shape", the number and the level are the only things that tell those rows apart. { areaFallback:
 * false } drops the "no area" tail for the one-line sentence that names the row a shape belongs to.
 */
function roomOptionLabel(raw, opts) {
  const showNoArea = !(opts && opts.areaFallback === false);
  const n = normalizeRoom(raw, state.project);
  const lv = (n.level || '').trim();
  const no = String(n.number == null ? '' : n.number).trim();
  const a = Number(n.area);
  const areaOk = Number.isFinite(a) && a > 0;
  return `${no ? `${no} \u00b7 ` : ''}${n.name || 'Room'}${lv ? ` (${lv})` : ''}`
    + (areaOk ? ` \u00b7 ${fmt(a, 1)} m\u00b2` : (showNoArea ? ' \u00b7 no area' : ''));
}

/** The one short sentence naming the row a shape belongs to. */
function shapeOwnerLabel(raw) {
  return roomOptionLabel(raw, { areaFallback: false });
}

/**
 * The shape's link, mirrored UNDER THE DRAWING for the selected room. The same control exists in the
 * room's load breakdown, but that sits far below the plan, and the moment the link matters is the moment
 * the user is looking at the shape - they should not have to scroll away from it and back.
 */
function renderPlanShapeLink() {
  if (!el.planShapeLink) return;
  const raw = state.rooms.find((r) => r.id === state.ui.openId) || null;
  const hasShape = !!(raw && Array.isArray(raw.poly) && raw.poly.length > 2);
  if (!hasShape) { el.planShapeLink.classList.add('hidden'); return; }
  const others = state.rooms.filter((x) => x.id !== raw.id);
  el.planShapeLinkName.textContent = shapeOwnerLabel(raw);
  el.planLinkTarget.innerHTML = others.length ? shapeTargetOptions(raw) : '<option value="">(no other room)</option>';
  el.planLinkTarget.disabled = !others.length;
  if (el.planLinkMove) el.planLinkMove.disabled = !others.length;
  el.planShapeLink.classList.remove('hidden');
}

function shapeLinkBlock(raw) {
  if (!raw || !Array.isArray(raw.poly) || raw.poly.length <= 2) return '';
  const others = state.rooms.filter((x) => x.id !== raw.id);
  const where = `this row ("${esc(shapeOwnerLabel(raw))}")`;
  if (!others.length) {
    return `<div class="bd-link"><h3>Shape on the drawing</h3>` +
      `<p>This shape is linked to ${where}. There is no other room to link it to yet.</p></div>`;
  }
  return `<div class="bd-link">
      <h3>Shape on the drawing</h3>
      <p>This shape belongs to ${where}. If that is the wrong room, move it &mdash; the shape and its
        area go to the row you choose.</p>
      <div class="bd-link-controls">
        <label class="muted small" for="bdShapeTarget">Link the shape to</label>
        <select id="bdShapeTarget">${shapeTargetOptions(raw)}</select>
        <button type="button" class="btn btn-small" id="bdShapeMove">Move the shape</button>
        <button type="button" class="btn btn-small btn-ghost" id="bdShapeDetach">Remove the shape from this row</button>
      </div>
      <p class="muted small">Moving the shape gives the other row this shape and its area, and the load
        changes with it. Removing it leaves this row with the area you can type yourself.</p>
    </div>`;
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
  const sys = unitsSys();         // the chosen results system for this row's computed cells
  return `<tr data-idx="${idx}" data-id="${esc(raw.id)}" class="clickable${inc ? '' : ' excluded'}">
    <td class="c-include col-in"><input type="checkbox" data-field="include" ${inc ? 'checked' : ''}
          aria-label="Include ${esc(nm)} in the load"></td>
    <td class="l c-lv"><input type="text" data-field="level" value="${esc(raw.level || '')}"
      placeholder="-" aria-label="Level of ${esc(nm)}"></td>
    <td class="c-num"><input type="text" data-field="number" value="${esc(raw.number || '')}"
      placeholder="-" aria-label="Room number of ${esc(nm)}"></td>
    <td class="l c-name col-name"><input type="text" data-field="name" value="${esc(raw.name || '')}"
          placeholder="Room name" aria-label="Room name">${areaBadge(raw)}${shapeBadge(raw)}</td>
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
    <td class="res v-sensible">${fmtPower(r.rsh, sys)}</td>
    <td class="res v-latent">${fmtPower(r.rlh, sys)}</td>
    <td class="res hi v-total">${fmtPower(r.totalW, sys)}</td>
    <td class="res hi v-tr col-tr">${fmt(r.tr, 2)}</td>
    <td class="res v-ls">${r.supplyOk === false ? '-' : fmtAir(r.supplyLs, sys)}</td>
    <td class="res v-sqftPerTr">${fmtValue(areaPerTr(m2PerTr(room.area, r.tr), sys), 0)}</td>
    <td class="c-src" title="Where this room came from">${esc(sourceLabel(raw.source))}</td>
    <td class="c-del"><button type="button" class="btn-del" data-act="del"
      title="Delete ${esc(nm)}" aria-label="Delete ${esc(nm)}">&times;</button></td>
  </tr>`;
}

function renderTable() {
  const calc = currentCalc();
  state.ui.order = sortedIndices(calc);
  // Quick start strip: the first-run entry point, shown only while the table is empty.
  if (el.quickStart) el.quickStart.hidden = state.rooms.length > 0;
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
  const sys = unitsSys();
  el.roomsBody.querySelectorAll('tr').forEach((tr) => {
    const idx = parseInt(tr.dataset.idx, 10);
    const r = calc.results[idx];
    if (!r) return;
    const raw = state.rooms[idx];
    tr.querySelector('.v-sensible').textContent = fmtPower(r.rsh, sys);
    tr.querySelector('.v-latent').textContent = fmtPower(r.rlh, sys);
    tr.querySelector('.v-total').textContent = fmtPower(r.totalW, sys);
    tr.querySelector('.v-tr').textContent = fmt(r.tr, 2);
    tr.querySelector('.v-ls').textContent = r.supplyOk === false ? '-' : fmtAir(r.supplyLs, sys);
    tr.querySelector('.v-sqftPerTr').textContent = fmtValue(areaPerTr(m2PerTr(r.room.area, r.tr), sys), 0);
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
  // The engine's own warnings (a negative area counted as 0, a zero supply ΔT, ...) are recomputed on
  // every render; an in-table edit must surface them immediately, not only after an unrelated
  // re-render (the old path never called this, so typing -5 into Area moved the load silently).
  renderWarnings(calc);
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
  const sys = unitsSys();
  el.summaryCards.innerHTML = [
    card('Total cooling load', fmt(t.tr, 2), 'TR', true),
    card('Total heat', fmtPower(t.totalW, sys), powerUnit(sys), true),
    card('Supply air', t.supplyOk === false ? '-' : fmtAir(t.ls, sys), airUnit(sys)),
    card('Fresh / outdoor air', fmtAir(t.oaLs, sys), airUnit(sys)),
    // ONE area card in the chosen system. It used to be shown twice - m² and ft² side by side -
    // which is exactly the metric/imperial pair the contract says must not appear twice.
    card('Conditioned area', fmtArea(t.area, sys), areaUnit(sys)),
    card('Area per tonne', fmtValue(areaPerTr(m2PerTr(t.area, t.tr), sys), 0), areaPerTrUnit(sys)),
    card('Rooms included', String(t.rooms), ''),
    card('Room sensible heat', fmtPower(t.rsh, sys), powerUnit(sys)),
    card('Room latent heat', fmtPower(t.rlh, sys), powerUnit(sys)),
    // the safety factor has always been applied to the room heat; this shows what it is worth, so it
    // is visible at a glance instead of only living in the project settings
    card(`Safety allowance (+${fmt(t.safetyPct, 0)}%)`, fmtPower(t.safetyW, sys), powerUnit(sys)),
  ].join('');

  // The level table's two AREA columns stay the deliberate m²/ft² pair (each column is one unit, and
  // the existing suite reads the fresh-air column by position); the single-unit RESULT columns follow
  // the setting - supply air, fresh air and area per ton are converted through js/units.js.
  const levels = groupByLevel(calc.results);
  el.levelBody.innerHTML = levels.length
    ? levels.map((g) => `<tr>
        <td class="l">${esc(g.level)}</td>
        <td>${g.rooms}</td>
        <td>${fmt(g.area, 1)}</td>
        <td>${fmt(g.areaSqft, 0)}</td>
        <td>${fmt(g.tr, 2)}</td>
        <td>${g.supplyOk === false ? '-' : fmtAir(g.ls, sys)}</td>
        <td>${fmtAir(g.oaLs, sys)}</td>
        <td>${fmtValue(areaPerTr(m2PerTr(g.area, g.tr), sys), 0)}</td>
      </tr>`).join('') +
      `<tr class="total-row">
        <td class="l">Total</td><td>${t.rooms}</td><td>${fmt(t.area, 1)}</td><td>${fmt(t.areaSqft, 0)}</td>
        <td>${fmt(t.tr, 2)}</td><td>${t.supplyOk === false ? '-' : fmtAir(t.ls, sys)}</td><td>${fmtAir(t.oaLs, sys)}</td>
        <td>${fmtValue(areaPerTr(m2PerTr(t.area, t.tr), sys), 0)}</td>
      </tr>`
    : '<tr><td class="l" colspan="8">No rooms included yet.</td></tr>';

      // Sticky totals bar (UX pass): it repeats the headline numbers so they stay on screen while the
      // user is editing further down the page. It is hidden entirely when there is nothing included in
      // the load or the total is 0, so a first-time visitor never sees a hollow "0.00 TR" banner. The TR
      // text is built from the SAME fmt()/fmtAir()/airUnit() calls as the summary card above, so the two
      // can never disagree. Marker used to verify the deploy: UXPASS-TOTALSBAR
      const hasLoad = t.rooms > 0 && t.tr > 0;
      if (el.totalsBar) {
        el.totalsBar.hidden = !hasLoad;
        if (hasLoad) {
          if (el.tbTr) el.tbTr.textContent = `${fmt(t.tr, 2)} TR`;
          if (el.tbAir) el.tbAir.textContent = `${t.supplyOk === false ? '-' : fmtAir(t.ls, sys)} ${airUnit(sys)}`;
          if (el.tbRooms) el.tbRooms.textContent = `${t.rooms} rooms included`;
        }
      }
      // Nothing to print or export while no room is included in the load.
      setExportEnabled(t.rooms > 0);
    }

    /** Enable or disable the print / CSV controls. With no room included in the load there is nothing to
     *  export, so the buttons are disabled and say why, rather than producing an empty file. Driven from
     *  renderSummary(), i.e. the same render path as everything else. */
    function setExportEnabled(enabled) {
      ['#btnPrint', '#btnCsv', '#btnPrint2', '#btnCsv2'].forEach((sel) => {
        const b = document.querySelector(sel);
        if (!b) return;
        b.disabled = !enabled;
        b.title = enabled ? '' : 'Add rooms first';
      });
    }

/** Set the unit in every table header that follows the setting (rooms table + level subtotals).
 *  Every label comes from js/units.js (header()/…Unit()), never a literal in this file. */
function applyUnitLabels(sys) {
  const th = (id, text) => { const n = document.getElementById(id); if (n) n.textContent = text; };
  // rooms table result columns
  th('thSensible', header('Sensible', powerUnit(sys)));
  th('thLatent', header('Latent', powerUnit(sys)));
  th('thTotal', header('Total', powerUnit(sys)));
  th('thLs', header('Supply air', airUnit(sys)));
  th('thApt', header('Area/tonne', areaPerTrUnit(sys)));
  // level-wise subtotal columns
  th('levelThSupply', header('Supply air', airUnit(sys)));
  th('levelThFresh', header('Fresh air', airUnit(sys)));
  th('levelThApt', header('Area/tonne', areaPerTrUnit(sys)));
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
  const sys = unitsSys();
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
        <div class="w">${fmtPower(x.w, sys)} ${powerUnit(sys)}</div>
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
        ${fmtArea(area, sys)} ${areaUnit(sys)} &middot;
        height ${fmtValue(length(room.height, sys), 2)} ${lengthUnit(sys)} &middot;
        ${fmt(room.people, 0)} people &middot; ${esc(room.orient)} facing &middot;
        glass ${fmtArea(room.glass, sys)} ${areaUnit(sys)} ${room.roof ? '&middot; roof exposed' : ''}
        ${shapeNote(state.rooms[idx])}
        ${room.include === false ? '&middot; <strong>excluded from totals</strong>' : ''}
      </div>
    </div>
    <div class="bd-total">
      <div><div class="k">Cooling load</div><div class="v">${fmt(r.tr, 2)} TR</div></div>
      <div><div class="k">Total heat</div><div class="v">${fmtPower(r.totalW, sys)} ${powerUnit(sys)}</div></div>
      <div><div class="k">Supply air</div><div class="v">${r.supplyOk === false ? '-' : fmtAir(r.supplyLs, sys)} ${airUnit(sys)}</div></div>
      <div><div class="k">Fresh air</div><div class="v">${fmtAir(r.oaLs, sys)} ${airUnit(sys)}</div></div>
      <div><div class="k">SHF</div><div class="v">${fmt(r.shf, 2)}</div></div>
      <div><div class="k">Area / tonne</div><div class="v">${fmtValue(areaPerTr(m2PerTr(room.area, r.tr), sys), 0)} ${areaPerTrUnit(sys)}</div></div>
    </div>
    ${shapeLinkBlock(state.rooms[idx])}
    ${body}
    <div class="bd-row bd-total-row">
      <div class="lbl">Total cooling load</div>
      <div class="w">${fmtPower(r.totalW, sys)} ${powerUnit(sys)}</div>
      <div></div>
      <div class="pct">100%</div>
    </div>
    <p class="bd-note">
      Bar length is scaled to the biggest component; the percentage is the share of the total load.
      "Safety factor" is the extra allowance on the room sensible and latent heat
      (${fmt(state.project.safety, 0)}% in the project settings).
    </p>`;

  const moveBtn = el.detailBody.querySelector('#bdShapeMove');
  if (moveBtn) {
    moveBtn.dataset.wired = '1';
    moveBtn.addEventListener('click', () => {
      const sel = el.detailBody.querySelector('#bdShapeTarget');
      if (sel && sel.value) planMoveShapeTo(state.ui.openId, sel.value);
    });
  }
  const detachBtn = el.detailBody.querySelector('#bdShapeDetach');
  if (detachBtn) detachBtn.addEventListener('click', () => planDetachShape(state.ui.openId));

  // The bar under the drawing mirrors this room's link, so it is updated in the same place the breakdown
  // is - there is no second source of truth for which room is "open".
  renderPlanShapeLink();
}

/** Open a room's load breakdown.
 *  keepView: leave the page where it is. Set by the plan panel — the user is looking at the DRAWING,
 *  and scrolling down to the breakdown there would yank the sheet out of view after every room they
 *  draw (it looked like the drawing only worked near the top of the page). Clicking a table row still
 *  scrolls to the breakdown, because there the breakdown IS what was asked for. */
async function openDetail(id, opts) {
  state.ui.openId = id;
  el.detailPanel.classList.remove('hidden');
  el.roomsBody.querySelectorAll('tr').forEach((tr) =>
    tr.classList.toggle('selected', tr.dataset.id === id));
  renderDetail(currentCalc());
  // The overlay draws the selection straight from getSelectedId() (= state.ui.openId), so it has to be
  // re-rendered here: this is what shows the room's outline, or — for a room that has none on the
  // sheet — the focus mark at the point that names it.
  if (plan.overlay) plan.overlay.render();
  if (!(opts && opts.keepView)) el.detailPanel.scrollIntoView({ block: 'nearest' });
  // A table row click ASKS to see the room, so switch to its page and bring it into view. Never for a
  // selection made ON the drawing (keepView) — it is already on screen and must not jump. A
  // schedule-only project (no drawing) is a safe no-op.
  if (!(opts && opts.keepView)) await planRevealRoom(id);
}

function closeDetail() {
  state.ui.openId = null;
  if (typeof renderPlanShapeLink === 'function') renderPlanShapeLink();   // hide the bar under the plan
  el.detailPanel.classList.add('hidden');
  el.roomsBody.querySelectorAll('tr').forEach((tr) => tr.classList.remove('selected'));
  // Re-render so the overlay drops the selected outline / focus mark with the selection itself —
  // closing must leave nothing behind on the plan.
  if (plan.overlay) plan.overlay.render();
}

/** Bring a room on the plan into view after its table row is clicked (the row asks to SEE it). The
 *  overlay can only outline a room that has geometry; a room read from a PDF label carries just `at`
 *  (where the sheet names it, PDF space) and gets a focus pointer there. This switches to the room's
 *  page when it lives on another one, then centres the plan's own scroll box on that point and, only
 *  when the plan panel is not already on screen, scrolls the window to it. Safe no-op for a
 *  schedule-only project, and it never throws. */
async function planRevealRoom(id) {
  try {
    if (!plan.viewer || plan.unavailable) return;
    const room = state.rooms.find((r) => String(r.id) === String(id));
    if (!room) return;
    const src = room.at || room.rect || null;
    const roomPage = Number(room.page != null ? room.page : (src && src.page != null ? src.page : 1));
    const target = Number.isFinite(roomPage) ? roomPage : 1;
    if (target !== plan.page) await planGoTo(target);
    const at = room.at;
    if (!at || !Number.isFinite(Number(at.x)) || !Number.isFinite(Number(at.y))) return;
    const vp = plan.viewer.getViewport ? plan.viewer.getViewport() : null;
    if (!vp || typeof vp.convertToViewportPoint !== 'function') return;
    // pdfPointToView maps the PDF point into the CANVAS' CSS box — the very space the overlay draws in
    // (js/overlay.js resize() reads canvas.clientWidth). If a stale viewport ever disagreed with the
    // canvas' own size, scale the point back to it rather than scrolling to a wrong place.
    const pt = pdfPointToView(vp, at);
    const canvas = el.planView.querySelector('canvas');
    let vx = pt.x, vy = pt.y;
    if (canvas && vp.width) {
      const sx = canvas.clientWidth / vp.width;
      if (Number.isFinite(sx) && sx > 0) vx *= sx;
    }
    if (canvas && vp.height) {
      const sy = canvas.clientHeight / vp.height;
      if (Number.isFinite(sy) && sy > 0) vy *= sy;
    }
    const box = planScrollBox();
    if (box) {
      box.scrollLeft = Math.max(0, vx - box.clientWidth / 2);
      box.scrollTop = Math.max(0, vy - box.clientHeight / 2);
    }
    // Bring the plan PANEL into the window only when it is not visible right now; clicking a row must
    // not yank a page the user is already looking at.
    const r = el.planView.getBoundingClientRect();
    const onScreen = el.planView.offsetHeight > 0 && r.bottom > 0 && r.top < window.innerHeight
      && r.right > 0 && r.left < window.innerWidth;
    if (!onScreen) el.planView.scrollIntoView({ block: 'center' });
  } catch (err) {
    // enhancement only: a plan that cannot be scrolled must never stop a room's breakdown opening
  }
}

/** The element a reveal (or a pan) must scroll: the nearest scrollable box at or above #planView —
 *  the choice js/overlay.js scrollBox() makes, so the two agree (rootEl when there is none). */
function planScrollBox() {
  let node = el.planView;
  for (let i = 0; node && i < 6; i += 1) {
    const cs = getComputedStyle(node);
    const scrolls = /(auto|scroll|overlay)/.test(`${cs.overflow}${cs.overflowX}${cs.overflowY}`);
    const overflow = node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1;
    if (scrolls && overflow) return node;
    node = node.parentElement;
  }
  return el.planView;
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
    if (field === 'area') {
      // The user has typed the area themselves, so it is no longer "from the drawing" — drop the mark
      // (and the badge) rather than keep claiming a provenance that is no longer true.
      delete room.areaFromDrawing;
      delete room.areaSource;
      // ...and MARK it as the owner's own figure (areaTyped). Every geometry path checks this marker
      // before it recomputes an area: a shape edit may only replace an area a SHAPE provided, never one
      // the user typed. This is the opposite direction from a row that GIVES its shape away — that one
      // blanks the area the shape was providing (planDetachShape). An EMPTY cell leaves the area
      // unknown, so the marker goes and a shape may drive the area once more.
      if (v === '') delete room.areaTyped; else room.areaTyped = true;
    }
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
  applyUnitLabels(unitsSys());
  renderTable();
  renderSortHeaders();
  renderSummary(currentCalc());
  renderWarnings();
  if (state.ui.openId) renderDetail(currentCalc());
  if (plan.overlay) plan.overlay.render();
  planSyncFillButton();
  updateUnitDetectLine();
}

// Everything that must be refreshed after a project setting changed.
function afterProjectChange() {
  applyUnitLabels(unitsSys());
  if (state.rooms.length) {
    renderTable();
    renderSortHeaders();
  }
  renderSummary(currentCalc());
  renderWarnings();
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
  // Total pages known -> a real percentage; unknown -> leave `pct` null so setProgress shows an
  // INDETERMINATE bar. A made-up percentage is worse than no number.
  const pct = pages ? (100 * page) / pages : null;
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
  renderWarnings();
}

// The warnings box shows two kinds of note together:
// - file/parse notes, which are permanent until cleared (state.warnings);
// - live engine warnings from js/calc.js (impossible conditions, clamped
//   geometry), which are recomputed on every render, so they never pile up.
function renderWarnings(calc) {
  const live = ((calc || currentCalc()) && (calc || currentCalc()).warnings) || [];
  const list = state.warnings.concat(live);
  if (!list.length) {
    el.warnBox.classList.add('hidden');
    el.warnCount.textContent = '0';
    el.warnList.innerHTML = '';
    return;
  }
  el.warnBox.classList.remove('hidden');
  el.warnCount.textContent = String(list.length);
  el.warnList.innerHTML = list.map((w) => `<li>${esc(w)}</li>`).join('');
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
  // Only a percentage when the share is really known (a page count, or a real inner fraction);
  // otherwise an INDETERMINATE bar — never a made-up number.
  const known = pages > 0 || typeof i.progress === 'number';
  setProgress(
    `File ${fileIdx + 1} of ${fileCount}: ${fileName} — ${phase}${page ? ` page ${page}${pages ? ` of ${pages}` : ''}` : ''}`.replace(/\s+/g, ' '),
    known ? part * 100 : null,
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
// How long to wait for one POST /api/parse batch before giving up and reading in the browser.
const SERVER_PARSE_TIMEOUT_MS = 60000;

// POST the files as multipart/form-data, one field named "files" per file, and
// merge the answer of every batch into one { rooms, warnings, files }.
// Errors (400 bad PDF, 413 too big, network, bad answer) throw with a short message.
async function parseFilesOnServer(files) {
  const rooms = [], warnings = [], fileInfos = [];
  // What the sheets said about their own units, so the detection line works on this path too
  // (js/unitdetect.js reads it via noteDetectedUnits). First file that reports evidence wins.
  let evidence = null;
  for (let i = 0; i < files.length; i += SERVER_FILES_PER_REQUEST) {
    const batch = files.slice(i, i + SERVER_FILES_PER_REQUEST);
    const body = new FormData();
    for (const f of batch) body.append('files', f, f.name);
    // A generous ceiling so a hung server cannot leave the upload spinning forever; the abort is the
    // only way the 'timeout' reason can be reached. The reason code rides on the Error and is mapped
    // to one coarse allowlisted word by the caller — the message itself is never counted.
    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), SERVER_PARSE_TIMEOUT_MS) : null;
    let res;
    try {
      res = await fetch('api/parse', { method: 'POST', body, signal: ctrl ? ctrl.signal : undefined });
    } catch (e) {
      const err = new Error(e && e.name === 'AbortError'
        ? 'the server took too long to read the file'
        : 'the server could not be reached');
      err.reason = (e && e.name === 'AbortError') ? 'timeout' : 'server_error';
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      // 400 and 413 come back as { error: "..." } — show the server's own words
      const err = new Error((data && data.error) ? data.error : `the server answered HTTP ${res.status}`);
      err.reason = res.status === 413 ? 'too_big' : (res.status === 400 ? 'bad_file' : 'server_error');
      throw err;
    }
    if (!data || typeof data !== 'object') {
      const err = new Error('the server sent an unexpected answer');
      err.reason = 'server_error';
      throw err;
    }
    if (Array.isArray(data.rooms)) rooms.push(...data.rooms);
    if (Array.isArray(data.warnings)) warnings.push(...data.warnings);
    if (Array.isArray(data.files)) {
      for (const info of data.files) {
        if (!evidence && info && info.evidence) evidence = info.evidence;
        fileInfos.push(info);
      }
    }
    if (!evidence && data.evidence) evidence = data.evidence;
  }
  return { rooms, warnings, files: fileInfos, evidence };
}

// Same ending for all readers, so the status wording stays the same.
// `readers` = who read the files (server / browser / OCR / room schedule),
// `scanned` = a PDF came back with 0 rooms and no text layer while OCR was off,
// `ocrEmpty` = OCR ran, the page(s) were read, and 0 rooms came out of them.
/* ONE line per upload, saying only how big the drawing was and how much came out of it:
 *   * sizeBucket -- which size band the file fell in. Never the exact byte count: a precise size
 *     plus a timestamp is close to a fingerprint, and the band answers the only question we have.
 *   * pages / rooms -- which band the page and room counts fell in.
 *   * reader -- which reader actually produced the rooms.
 * The file itself, its name, its contents and anything derived from them are NEVER sent: whatever
 * may travel is limited to the coarse vocabularies in js/usage.js, and anything else is dropped
 * before it leaves the browser. Called by BOTH exits of handleFiles() — the server path returns
 * early, so this cannot live at the end of the function alone. */
function trackPlanUpload(pdfs, pagesRead, added, readers) {
  try {
    track('plan_upload', {
      source: 'upload',
      reader: readers.has('server') ? 'server' : (readers.has('ocr') ? 'ocr' : 'browser'),
      sizeBucket: bucketBytes(pdfs.reduce((s, f) => s + ((f && f.size) || 0), 0)),
      pages: bucketPages(pagesRead),
      rooms: bucketRooms(added),
    });
  } catch {
    /* counting must never break an upload */
  }
}

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
  if (!added) {
    // No usable room came out of this upload: record ONE coarse reason, then the calc-empty signal.
    noteParseFailed(uploadFailReason || (ocrEmpty ? 'no_rooms' : scanned ? 'no_text' : 'no_rooms'));
    noteCalcEmpty('upload');   // nothing usable came out of this upload
  }
  // The drawing is up and its rooms now exist: place them, then trace the outlines, by itself. A call
  // that arrives before the viewer has finished loading is harmless — openPlan's own end calls again.
  maybeAutoSetupPlan();
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
  // A fresh upload attempt: forget the last attempt's reason so this attempt's first reason wins.
  parseFailedSent = false;
  uploadFailReason = '';

  // --- 1. room schedules: always read here in the browser ------------------
  for (let i = 0; i < schedules.length; i++) {
    const f = schedules[i];
    setProgress(`File ${i + 1} of ${schedules.length}: ${f.name} — reading the room schedule`);
    try {
      const out = await parseScheduleFile(f);
      const res = addRooms(withSource(out.rooms, 'schedule'));
      added += res.added;
      skipped += res.skipped;
      if (out.warnings && out.warnings.length) {
        pushWarnings(out.warnings.map((w) => `${f.name}: ${w}`));
      }
      readers.add('schedule');
      track('schedule_imported', { reader: 'schedule' });
      if (!res.added) uploadFailReason = uploadFailReason || 'no_rooms';   // read, but no rooms
      const bits = [`${res.added} room(s) from the schedule`];
      if (out.rowCount) bits.push(`${out.rowCount} row(s) read`);
      if (out.sheetName) bits.push(`sheet "${out.sheetName}"`);
      notes.push(`${f.name}: ${bits.join(', ')}`);
    } catch (err) {
      failed += 1;
      uploadFailReason = uploadFailReason || 'bad_file';   // the schedule could not be read
      const msg = (err && err.message) ? err.message : String(err);
      pushWarnings([`${f.name}: could not be read — ${msg}`]);
      notes.push(`${f.name}: FAILED — ${shortReason(msg)}`);
    }
  }

  // --- 2. PDF drawings -----------------------------------------------------
  // Pages read across the whole upload, used for one coarse plan_upload line at the end.
  let pagesRead = 0;
  // Server path: text-layer PDFs only, and never when the user asked for OCR.
  if (pdfs.length && !useOcr && state.server.available) {
    setProgress(pdfs.length === 1
      ? `Uploading file 1 of 1: ${pdfs[0].name} …`
      : `Uploading ${pdfs.length} files to the server …`);
    // the server reads the whole file at once and answers in one piece,
    // so after the upload we only have one line left to show — indeterminate, since the work left
    // is genuinely unknown here.
    const readingTimer = setTimeout(() => setProgress('Reading PDF on the server …', null), 500);
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
      noteDetectedUnits(out);   // one plain line: what system the SHEET uses
      if (out.warnings && out.warnings.length) pushWarnings(out.warnings);
      readers.add('server');
      track('plan_parsed', { reader: 'server' });
      pagesRead += (out.files || []).reduce((s, info) => s + (info.pages || 0), 0);
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
      if (!res.added) uploadFailReason = uploadFailReason || (scanned ? 'no_text' : 'no_rooms');
      trackPlanUpload(pdfs, pagesRead, added, readers);
      finishUpload(added, skipped, failed, notes, '', readers, scanned);
      return;
    } catch (err) {
      clearTimeout(readingTimer);
      serverError = (err && err.message) ? err.message : String(err);
      uploadFailReason = (err && err.reason) || 'server_error';   // coarse code set by parseFilesOnServer
      setStatus('warn', `Server: ${serverError}. Reading the file(s) in your browser instead.`);
      // fall through to the local path below, the user still gets a result
    }
  }

  // --- local path: pdf.js, or tesseract OCR when the box is ticked ---------
  for (let i = 0; i < pdfs.length; i++) {
    const f = pdfs[i];
    setProgress(`File ${i + 1} of ${pdfs.length}: ${f.name} — ${useOcr ? 'preparing OCR' : 'opening'}`);
    try {
      const buf = await f.arrayBuffer();
      if (i === 0) openPlan(buf, { name: f.name });   // show the drawing while it is being read
      const out = useOcr
        ? await parseOneWithOcr(buf, f.name, i, pdfs.length)
        : await parseOne(buf, f.name, i, pdfs.length);
      const res = addRooms(withSource(out.rooms, useOcr ? 'ocr' : 'pdf'));
      added += res.added;
      skipped += res.skipped;
      noteDetectedUnits(out);   // one plain line: what system the SHEET uses
      readers.add(useOcr ? 'ocr' : 'browser');
      track('plan_parsed', { reader: useOcr ? 'ocr' : 'browser' });
      pagesRead += out.pages || 0;
      if (out.warnings && out.warnings.length) {
        pushWarnings(out.warnings.map((w) => `${f.name}: ${w}`));
      }
      const ocrPages = (useOcr && Array.isArray(out.usedOcr) && out.usedOcr.length)
        ? `, OCR on page(s) ${out.usedOcr.join(', ')}` : '';
      notes.push(`${f.name}: ${res.added} room(s)${out.pages ? ` from ${out.pages} page(s)` : ''}${ocrPages}`);
      // no rooms and no text layer: one clear line about the OCR box
      if (!useOcr && (!out.rooms || !out.rooms.length) && await pdfLooksScanned(out)) scanned = true;
      // zero rooms out of this file: a scan has no text layer, anything else simply has no rooms
      if (!res.added) uploadFailReason = uploadFailReason || (scanned ? 'no_text' : 'no_rooms');
      // OCR ran and read the page(s) but found no rooms: say why, and what works better.
      if (useOcr && !res.added && out.pages) {
        ocrEmpty = true;
        pushWarnings([`${f.name}: ${OCR_NO_ROOMS_MSG}`]);
      }
    } catch (err) {
      failed += 1;
      uploadFailReason = uploadFailReason || 'bad_file';   // pdf.js / OCR could not read the file
      const msg = (err && err.message) ? err.message : String(err);
      pushWarnings([`${f.name}: could not be read — ${msg}`]);
      notes.push(`${f.name}: FAILED — ${shortReason(msg)}`);
    }
  }

  trackPlanUpload(pdfs, pagesRead, added, readers);   // local path: the server path returned above

  finishUpload(added, skipped, failed, notes, serverError, readers, scanned, ocrEmpty);
}

/* Which drawing 'Try sample drawing' loads.
 *
 * The DEFAULT is a real, credited CAD sheet — LEVEL 11 FLOOR PLAN, from Wikimedia Commons under
 * CC BY-SA 4.0 (the credit sits under the button; the full entry is in docs/SAMPLE-CREDITS.md and on
 * about.html). It is genuine vector linework, which is what a first-time visitor should see.
 *
 * `?sample=synthetic` loads the synthetic tests/samples/sample-plan.pdf fixture instead. That hook is
 * deliberately unadvertised: the browser suite uses it so its 159-room / 363.86 TR baselines stay
 * exact now that the button no longer loads the synthetic plan. */
const SAMPLE_REAL = ['samples/level-11-floor-plan.pdf'];
const SAMPLE_HOUSE = ['samples/waller-estate-floor-plan.pdf'];
const SAMPLE_SYNTHETIC = ['samples/sample-plan.pdf', 'tests/samples/sample-plan.pdf'];

/* Each sample is somebody else's drawing used under its licence, so whichever one is loaded is named
 * in the credit line under the plan panel. The synthetic plan is ours (a built-in test drawing). */
const SAMPLE_CREDITS = {
  office: 'The sample drawing is a real plan: <strong>LEVEL 11 FLOOR PLAN</strong> by Vivianwwj on ' +
    '<a href="https://commons.wikimedia.org/wiki/File:LEVEL_11_FLOOR_PLAN.pdf">Wikimedia Commons</a>, ' +
    'used under the <a href="https://creativecommons.org/licenses/by-sa/4.0/">Creative Commons ' +
    'Attribution-ShareAlike 4.0</a> licence',
  house: 'The sample drawing is a real plan: <strong>BALLARAT Waller Estate</strong> by MichaelScott99 ' +
    'on <a href="https://commons.wikimedia.org/wiki/File:BALLARAT_Waller_Estate_Floor_plan.pdf">Wikimedia Commons</a>, ' +
    'used under the <a href="https://creativecommons.org/licenses/by-sa/3.0/">Creative Commons ' +
    'Attribution-ShareAlike 3.0</a> licence',
  synthetic: 'The drawing shown is a synthetic test plan built for LoadLens (not a real building)',
};

function sampleChoice(which) {
  let key = which;
  if (!key) {
    try { key = new URLSearchParams(location.search).get('sample'); } catch (err) { key = null; }
  }
  key = String(key || '').toLowerCase();
  if (key === 'synthetic') return 'synthetic';
  if (key === 'house' || key === 'waller') return 'house';
  return 'office';
}
function samplePaths(which) {
  const choice = sampleChoice(which);
  if (choice === 'synthetic') return SAMPLE_SYNTHETIC;
  if (choice === 'house') return SAMPLE_HOUSE;
  return SAMPLE_REAL;
}
function setSampleCredit(which) {
  const el = document.getElementById('sampleCredit');
  if (!el) return;
  const credit = SAMPLE_CREDITS[sampleChoice(which)];
  if (credit) el.innerHTML = credit + ' &middot; <a href="about.html#sample-credit">full credit</a>.';
}

async function loadSample(which) {
  if (state.ui.busy) return;
  state.ui.busy = true;
  setStatus(null);
  setProgress('Downloading the sample drawing ...');
  const paths = samplePaths(which);
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
    await openPlan(buf, { name: used });   // show the sample drawing before its rooms are read
    setSampleCredit(which);          // and name whichever drawing this is, under its licence
    setProgress(`Reading ${used} ...`);
    const out = await parseOne(buf, used, 0, 1);
    const r = addRooms(out.rooms);
    if (out.warnings && out.warnings.length) pushWarnings(out.warnings);
    noteDetectedUnits(out);   // one plain line: what system the SAMPLE SHEET uses
    track('sample_loaded', { source: 'sample' });
    if (!r.added) noteCalcEmpty('sample');
    setProgress(null);
    renderAll();
    saveSoon();
    // A drawing that prints room NAMES but no AREAS comes in with every area unknown and every room
    // out of the load (the parser also pushes its own note into the warning box). Say the headline and
    // the exact next step rather than a hollow "please check the areas".
    const unknown = out.rooms.filter((x) => x && x.areaUnknown).length;
    if (out.rooms.length && unknown >= out.rooms.length) {
      // This sheet prints room NAMES but no AREAS, so the page would open on a load of zero.
      // A first-time visitor must not have to discover the "Fill areas" button to see a number:
      // the drawing's own outlines can supply those areas, so try that once, here, first.
      await planFillAreas();
      if (!currentCalc().totals.rooms) {
        noteCalcEmpty('sample');   // still honestly nothing to compute, recorded only now
        setStatus('warn',
          `Sample drawing loaded: ${r.added} room(s). This drawing prints no room areas, so every room ` +
          `came in with its area unknown and is left out of the load. Give each room an area — type it ` +
          `in the Area column, or drag a rectangle over the room on the plan and set it to that room's ` +
          `row — then tick its Include box. Click a row to open its Load breakdown.`);
      } else {
        const measured = state.rooms.filter((x) => x && !x.areaUnknown && roomHasArea(x)).length;
        const total = state.rooms.length;
        setStatus('ok',
          `Sample drawing loaded: ${r.added} room(s). The drawing prints no areas, so ${measured} of the ` +
          `${total} areas were measured from the outline the drawing itself draws — the load below is real. ` +
          `The rest stay blank on purpose. Click any row to open its breakdown.`);
      }
    } else {
      setStatus('ok', r.added
        ? `Sample drawing loaded: ${r.added} room(s) added${r.skipped ? `, ${r.skipped} duplicate(s) skipped` : ''}. Please check the areas.`
        : 'The sample drawing was read but no rooms were found. Please add rooms manually.');
    }
    // The rooms exist and the drawing is up: place them, then trace the outlines, by itself.
    await maybeAutoSetupPlan();
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
  // True once the drawing has finished loading into the viewer — the plan auto-setup (place then
  // trace) waits for this AND for the rooms to exist (see maybeAutoSetupPlan).
  loaded: false,
  // Identity of the drawing now loaded (see drawingIdentity). Every shape is tagged with the identity
  // of the drawing it was measured on, and the overlay paints only shapes that match this one.
  drawingId: null,
  // The area a ring-edit gesture started from, so Escape (which restores the original ring with no
  // `kind`) can put the figure back exactly — a traced room's own figure is the plan's, not its ring's.
  polyDrag: null,
};

/* ---- the one-click "trace again at the implied scale" -------------------------------------------
 * The trace can measure what scale a drawing's own outlines imply. When that disagrees with the
 * panel's scale, the fix is offered ONCE per drawing beside the plan buttons (planShowScaleFix). After
 * it has been used, a second trace that still disagrees only REPORTS the scale — it never offers the
 * button again, so the fix can never become a loop. Reset when a different drawing is opened. */
let scaleFixUsedDrawing;   // undefined = never used; otherwise the drawingId it was used for

/** Do two drawing identities name the same drawing? Both null (no identity in play) count as the same. */
function sameDrawingKey(a, b) {
  if (a == null && b == null) return true;
  return String(a) === String(b);
}

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

/** The text of a room's AREA CHIP on the plan: the area in the CURRENT unit system, or exactly
 *  "no area" when the room has none. Never 0, never NaN, never a blank chip. Formatted with the same
 *  helpers the table uses, so the plan and the table can never disagree — the overlay only places it. */
function planRoomAreaText(room) {
  const n = Number(room && room.area);
  if (!room || room.areaUnknown || room.area == null || room.area === ''
      || !Number.isFinite(n) || n <= 0) {
    return 'no area';
  }
  const sys = unitsSys();
  return `${fmtArea(n, sys)} ${areaUnit(sys)}`;
}

function planHintText() {
  // An IN-PROGRESS shape comes first: the user is mid-gesture, and until now the hint kept describing
  // the tool in general. Clicking a corner changed nothing on screen, so the polygon tool looked
  // broken and only the drag (rectangle) felt like it worked.
  if (pendingShape) {
    return 'Shape drawn and still outlined on the drawing — choose which room it is above, then press ' +
      '"Set the shape". Leaving it on "(new room)" adds it as a new room; picking an existing row gives ' +
      'that room this shape and area, and its load changes with it.';
  }
  if (state.ui.planMode !== 'select' && plan.overlay && typeof plan.overlay.hasDraft === 'function'
      && plan.overlay.hasDraft()) {
    const n = (typeof plan.overlay.draftCount === 'function') ? plan.overlay.draftCount() : 0;
    const what = n <= 1 ? 'First corner placed' : `${n} corners placed`;
    const more = n < 3
      ? `Click at least ${3 - n} more corner(s) to make a room.`
      : 'Click the first corner again, double-click, or press Enter to finish the shape.';
    return `${what} — ${more} Backspace takes back the last corner, Escape throws the shape away. ` +
      `Areas are measured at 1:${planScaleDenom()}.`;
  }
  // A PLACED room (a locator box sized back from its own area, see planPlaceAllRooms) carries a rect
  // too, so isDrawnRoom() alone cannot tell it from a hand-drawn one — planview.isPlacedRoom() can.
  // A converted polygon carries NO rect, so the count uses the shared "has a shape" test.
  const drawn = state.rooms.filter((r) => roomHasShape(r) && !isPlacedRoom(r)).length;
  const placed = state.rooms.filter(isPlacedRoom).length;
  if (state.ui.planMode === 'select') {
    return `Click a room box to open its load breakdown. Drag a room to move it, drag a corner to ` +
      `resize, drag a shape's vertex to reshape it (drag an edge middle to add a point; hold Alt and ` +
      `drop a point on another edge to remove it), Delete to remove, middle-drag or hold Space to pan. ` +
      `${drawn} hand-drawn and ${placed} placed room box(es) on the plan.`;
  }
  return `Drag over a room to add it as a rectangle, or click to add a corner of a room with any ` +
    `number of sides. Close a shape by clicking its first corner again (or double-click, or press ` +
    `Enter); Backspace takes back the last corner, Escape throws the shape away. When a shape closes ` +
    `you choose which room it is. Areas are measured at 1:${planScaleDenom()} — change the drawing ` +
    `scale above if the sheet differs. ${drawn} room(s) drawn so far, ${placed} placed. Switch to ` +
    `Select / edit to move, resize or delete a box.`;
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
  updateStaleShapesButton();   // keep the "old drawing's shapes" control in step with state.rooms
}

/** Any change to a room's poly/rect made from the APP side must repaint the overlay. The overlay draws
 *  straight from state.rooms, so a room whose outline was removed would otherwise keep its shape on
 *  the sheet until some unrelated redraw. renderAll() already calls overlay.render() — this is called
 *  by the geometry paths as well so a future change to renderAll can never leave a stale outline on
 *  the drawing (and the hint follows). Idempotent and safe when no drawing is loaded. */
function planRenderGeometry() {
  if (plan.overlay) plan.overlay.render();
  planSync();
}

/* ---- stale shapes from a PREVIOUS drawing --------------------------------------------------------
 * A room's outline or box belongs to the drawing it was measured on: room.polyDrawing for a traced
 * outline, room.rectDrawing for a placed or hand-drawn box (both are room-level fields, so a move that
 * rewrites room.rect never loses the tag). When a DIFFERENT drawing is loaded, the shape is simply not
 * painted (overlay.shapesOnPage) — but it is NEVER destroyed, because the room's AREA is the user's own
 * number, not a measurement. The stale shapes are counted, said out loud with their count, and offered
 * for removal with one control beside the plan's buttons; removing them deletes only the geometry
 * (poly/polyPage/polyDrawing, rect/rectDrawing) and leaves every area exactly as it was. */

/** A short, stable identity for a loaded drawing. A hash of the bytes (rather than a counter or a
 *  timestamp) is what makes it survive a page reload: the drawing this browser keeps is byte-identical,
 *  so a restored room's outline still matches. Only the head and tail are sampled, so it stays fast on
 *  a 40 MB CAD sheet. */
const DRAWING_ID_SAMPLE = 64 * 1024;
function drawingIdentity(bytes) {
  if (!bytes) return null;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = u8.length;
  if (!n) return null;
  let h = 0x811c9dc5;                                  // FNV-1a, 32-bit
  const step = (b) => { h ^= b; h = Math.imul(h, 0x01000193); };
  const head = Math.min(n, DRAWING_ID_SAMPLE);
  for (let i = 0; i < head; i++) step(u8[i]);
  for (let i = Math.max(head, n - DRAWING_ID_SAMPLE); i < n; i++) step(u8[i]);
  step(n & 0xff); step((n >>> 8) & 0xff); step((n >>> 16) & 0xff); step((n >>> 24) & 0xff);
  return 'd' + (h >>> 0).toString(36) + '-' + n.toString(36);
}

/** Is this room's poly a stale outline — one measured on a drawing other than the one now loaded? */
function polyIsStale(room) {
  return !!(room && Array.isArray(room.poly) && plan.drawingId != null
    && room.polyDrawing != null && String(room.polyDrawing) !== String(plan.drawingId));
}

/** Is this room's rect a stale box — one measured on a drawing other than the one now loaded? */
function rectIsStale(room) {
  return !!(room && room.rect && plan.drawingId != null
    && room.rectDrawing != null && String(room.rectDrawing) !== String(plan.drawingId));
}

/** Rooms still carrying geometry whose recorded drawing is not the one now loaded. A room with no
 *  recorded drawing is not counted: nothing proves its shape is stale (a project saved before drawing
 *  identity existed keeps working exactly as before). */
function staleShapeRooms() {
  return state.rooms.filter((r) => r && (polyIsStale(r) || rectIsStale(r)));
}

let btnStaleShapes = null;   // created lazily; app.html is not edited for this

/** Create the "remove the old drawing's shapes" button beside the plan's own buttons once, and wire it
 *  — the same pattern ensureUndoDeleteButton uses for the room table. */
function ensureStaleShapesButton() {
  if (btnStaleShapes) return btnStaleShapes;
  const anchor = el.planTraceClear || el.planPlaceAll;
  if (!anchor || !anchor.parentNode) return null;
  const b = document.createElement('button');
  b.type = 'button';
  b.id = 'planRemoveStaleShapes';
  b.className = 'btn btn-small btn-danger-ghost';
  b.hidden = true;
  b.disabled = true;
  b.textContent = 'Remove old shapes';
  b.addEventListener('click', removeStaleShapes);
  anchor.parentNode.insertBefore(b, anchor.nextSibling);
  btnStaleShapes = b;
  return b;
}

/** Reflect how many rooms still carry a shape from a previous drawing on the button: labelled with the
 *  count, hidden when there are none. */
function updateStaleShapesButton() {
  const b = ensureStaleShapesButton();
  if (!b) return;
  const rooms = staleShapeRooms();
  const n = rooms.length;
  if (!n) {
    b.hidden = true;
    b.disabled = true;
    b.textContent = 'Remove old shapes';
    b.removeAttribute('aria-label');
    b.title = '';
    return;
  }
  const outlines = rooms.filter(polyIsStale).length;
  const what = outlines === n ? `outline${n === 1 ? '' : 's'}` : `shape${n === 1 ? '' : 's'}`;
  b.hidden = false;
  b.disabled = false;
  b.textContent = `Remove ${n} ${what} from the old drawing`;
  b.setAttribute('aria-label', b.textContent);
  b.title = 'Delete the outline/box measured on the previous drawing. Every room KEEPS its area.';
}

/** Say out loud (once per load) that rooms still carry shapes from a previous drawing; the control
 *  beside the plan's buttons is the way to clear them. */
function planAnnounceStaleShapes() {
  updateStaleShapesButton();
  const rooms = staleShapeRooms();
  const n = rooms.length;
  if (!n) return;
  const outlines = rooms.filter(polyIsStale).length;
  const what = outlines === n ? `outline${n === 1 ? '' : 's'}` : `shape${n === 1 ? '' : 's'}`;
  const lead = n === 1
    ? `1 room still carries ${outlines === n ? 'an outline' : 'a shape'} measured on the previous drawing, so it is not shown on this sheet`
    : `${n} rooms still carry ${outlines === n ? 'outlines' : 'shapes'} measured on the previous drawing, so they are not shown on this sheet`;
  const areasWord = n === 1 ? 'Its area is untouched' : 'Their areas are untouched';
  setStatus('warn', `${lead}. ${areasWord} — press "Remove ${n} ${what} from the old drawing" ` +
    `beside the plan buttons if you want the old shape gone.`, 'plan');
}

/** Delete ONLY the geometry measured on a previous drawing (never the area, never a shape belonging to
 *  the drawing now loaded). Every room keeps the area the user can still see and use. */
function removeStaleShapes() {
  const rooms = staleShapeRooms();
  if (!rooms.length) {
    updateStaleShapesButton();
    setStatus('warn', 'There are no shapes left from an earlier drawing.', 'plan');
    return;
  }
  let n = 0;
  for (const room of rooms) {
    if (polyIsStale(room)) {
      delete room.poly;
      delete room.polyPage;
      delete room.polyArea;
      delete room.polyRatio;
      delete room.polyDrawing;
    }
    if (rectIsStale(room)) { delete room.rect; delete room.rectDrawing; }
    n += 1;
  }
  updateStaleShapesButton();
  renderAll();
  saveNow();
  setStatus('ok', `Removed the outline/box measured on an earlier drawing from ${n} room${n === 1 ? '' : 's'}. ` +
    `Every room kept its area — nothing about the load has changed.`, 'plan');
}

function planSelectRoom(room) {
  if (room) openDetail(room.id, { keepView: true }); else closeDetail();
  if (plan.overlay) plan.overlay.render();
  if (!room) return;
  // Drawing -> row: the selection was made ON the sheet, so give the matching table row the other
  // half of the link — bring it into view and flash it — otherwise on a 56-row table the user sees
  // nothing happen. If the current search / level filter hides that row, say so instead of silently
  // doing nothing. A schedule-only project, or any odd DOM, must never break selection.
  try {
    const tr = el.roomsBody ? el.roomsBody.querySelector(`tr[data-id="${room.id}"]`) : null;
    if (tr) {
      scrollRowIntoView(tr);
      flashTableRow(tr);
    } else {
      setStatus('', `Selected ${room.name || 'the room'} in the load, but the current filter hides its row.`, 'plan');
    }
  } catch (err) { /* never throw when no drawing is loaded */ }
}

/** Bring a table row into view WITHOUT moving the window. scrollIntoView scrolls every scrollable
 *  ancestor — including the page — which yanks the drawing out of view while the user is working on
 *  it (a fixed-coordinate click/drag on the plan then lands somewhere else). Scroll the table's own
 *  scroll container instead; the drawing stays exactly where it is. */
function scrollRowIntoView(tr) {
  if (!tr) return;
  const container = tr.closest ? tr.closest('.table-scroll') : null;
  if (!container) { try { tr.scrollIntoView({ block: 'nearest' }); } catch (err) { /* ignore */ } return; }
  const cr = container.getBoundingClientRect();
  const rr = tr.getBoundingClientRect();
  if (rr.top < cr.top) container.scrollTop += rr.top - cr.top;
  else if (rr.bottom > cr.bottom) container.scrollTop += rr.bottom - cr.bottom;
}

let rowFlashTimer = 0;
/** Briefly flash a table row so a selection made on the drawing is noticed in a long table. The CSS
 *  class is removed after ~1.2 s; @media (prefers-reduced-motion: reduce) shows a static ring. */
function flashTableRow(tr) {
  if (!tr || !tr.classList) return;
  tr.classList.remove('row-flash');
  void tr.offsetWidth;                 // reflow so re-picking the SAME row retriggers the animation
  tr.classList.add('row-flash');
  clearTimeout(rowFlashTimer);
  rowFlashTimer = setTimeout(() => { if (tr.classList) tr.classList.remove('row-flash'); }, 1200);
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
function planRoomMoved(id, payload) {
  const room = roomById(id);
  if (!room || !payload) return;
  // An abandoned conversion: the app wrote a ring live but the box must stand — drop the ring and stop.
  if (payload.kind === 'convert-cancel') {
    delete room.poly;
    delete room.polyPage;
    delete room.polyDrawing;
    if (plan.overlay) plan.overlay.render();
    return;
  }
  // A polygon room (a traced outline, or a hand-drawn shape) reports { id, poly, page, kind }: write
  // the ring. For a HAND-DRAWN shape the row's area cell is refreshed live too (a vertex edit changes
  // the area, and the user should see it), but the TOTALS are deliberately left alone until the
  // release — exactly as for a rectangle move — so the load can never move mid-gesture.
  if (Array.isArray(payload.poly)) {
    // A BOX becoming a POLYGON (Select/edit: drag the middle of a rect edge). While the drag is live
    // the ring is written but the box is KEPT, so an abandoned drag (Escape) simply drops the ring and
    // the room is exactly as it was. The box leaves only on release (planRoomMoveEnd).
    if (payload.kind === 'convert') {
      planConvertRectToPoly(room, payload.poly, payload.page, false);
      // LIVE area preview while the conversion drag runs: on release the ring re-measures the area for a
      // room whose area came from a shape, so show that figure on the chip NOW, not only on release. A
      // TYPED area is never touched.
      if (!areaIsTyped(room) && (room.areaFromDrawing || room.source === 'drawn')) {
        room.area = round2(polyAreaM2(room.poly, roomDenom(room)));
      }
      return;
    }
    setRoomRing(room, payload.poly, payload.page);
    // Escape / pointercancel: the overlay puts the ORIGINAL ring back and reports it with NO `kind`.
    // Restore the figure the gesture started from, so an abandoned reshape can never leave a
    // re-measured area behind (a traced room's own figure is the plan's, not its ring's).
    if (payload.kind == null) {
      const snap = plan.polyDrag && plan.polyDrag.id === room.id ? plan.polyDrag : null;
      if (snap) {
        room.area = snap.area;
        if (snap.areaFromDrawing) room.areaFromDrawing = true; else delete room.areaFromDrawing;
        if (snap.areaUnknown) room.areaUnknown = true; else delete room.areaUnknown;
        const inp = el.roomsBody.querySelector(`tr[data-id="${room.id}"] input[data-field="area"]`);
        if (inp) inp.value = String(room.area);
      }
      plan.polyDrag = null;
      if (plan.overlay) plan.overlay.render();
      return;
    }
    // Remember the pre-drag figure ONCE per gesture, so Escape can put it back exactly.
    if (!plan.polyDrag || plan.polyDrag.id !== room.id) {
      plan.polyDrag = {
        id: room.id, area: room.area,
        areaFromDrawing: !!room.areaFromDrawing, areaUnknown: !!room.areaUnknown,
      };
    }
    // AREA follows the ring the user is drawing — for a HAND-DRAWN shape on any edit, and now for a
    // TRACED outline when its VERTICES are dragged (its printed/filled figure described the plan's
    // shape, not the one the user is now reshaping). A whole-ring MOVE (kind 'move') keeps the
    // figure: a translation leaves the shoelace unchanged, so re-measuring there would only swap the
    // plan's figure for a ring-derived one for no reason. A TYPED area is the owner's own measurement
    // and no geometry edit may replace it. The TOTALS still wait for the release.
    if (!areaIsTyped(room) && (room.source === 'drawn' || payload.kind === 'vertex')) {
      const next = ringAreaIfUsable(room);
      if (next != null) {
        room.area = next;
        room.areaFromDrawing = true;
        delete room.areaUnknown;
        const inp = el.roomsBody.querySelector(`tr[data-id="${room.id}"] input[data-field="area"]`);
        if (inp) inp.value = String(room.area);
      }
    }
    if (plan.overlay) plan.overlay.render();
    return;
  }
  room.rect = {
    page: payload.page != null ? payload.page : (room.rect && room.rect.page) || plan.page || 1,
    x: payload.x, y: payload.y, w: payload.w, h: payload.h,
  };
  // LIVE area preview for a resize/move, so the on-plan chip shows the figure on the way (the release
  // re-derives the same area from the box). A move keeps w/h, so the area is unchanged; a TYPED area is
  // never touched, so its chip keeps the owner's figure. The TOTALS are still untouched until release.
  if (!areaIsTyped(room)) room.area = round2(areaFromRect(room.rect, roomDenom(room)));
  if (plan.overlay) plan.overlay.render();
}

/** On release: the real update. Write the new rectangle into the room, re-derive its area and
 *  length/width from THAT rectangle at its own scale, refresh its row (the area cell the table still
 *  shows), recalculate, refresh the summary and the open description, redraw the map and persist.
 *  updateLive() is the same no-table-rebuild refresh the in-table edits use, so the table keeps the
 *  room's row and the user's focus instead of being thrown away and rebuilt. */
function planRoomMoveEnd(id, payload) {
  const room = roomById(id);
  if (!room || !payload) return;
  // A BOX became a POLYGON (the edge-middle drag converted it). Store the ring, DROP the box, tag it
  // like every other outline — then say so and hand the room back selected, ready to reshape. The AREA
  // rule is the one planDetachShape/commit use: it is re-measured from the new shape ONLY when the
  // room's area already came from a shape; a typed (or placed) area is never silently overwritten.
  if (payload.kind === 'convert' && Array.isArray(payload.poly)) {
    const typed = areaIsTyped(room);
    const wasFromDrawing = !areaIsTyped(room) && !!(room.areaFromDrawing || room.source === 'drawn');
    planConvertRectToPoly(room, payload.poly, payload.page, true);
    const inp = el.roomsBody.querySelector(`tr[data-id="${room.id}"] input[data-field="area"]`);
    if (inp) inp.value = String(room.area);
    updateLive();
    saveSoon();
    if (plan.overlay) plan.overlay.render();
    // The message must quote the area that ACTUALLY resulted. A typed area was left alone, so say so
    // rather than reading back a number the room still carries from somewhere else.
    setStatus('ok', `${room.name || 'The room'} is now a shape you can pull — drag its corners ` +
      `to match the drawing. ` +
      (typed
        ? `Your typed area ${fmt(room.area, 1)} m² is unchanged — a shape edit never replaces a figure you typed.`
        : wasFromDrawing
          ? `Its area is now ${fmt(room.area, 1)} m² and the load uses it.`
          : `It keeps the area you had (${fmt(room.area, 1)} m²), so the load is unchanged.`), 'plan');
    return;
  }
  // A polygon room: store the new ring. A hand-drawn shape OWNS its area through the ring, so it is
  // re-derived here (a translation leaves a shoelace area untouched, so a move reports the same area
  // and the load does not move; a VERTEX edit really does change it, so the load follows). A traced
  // outline keeps the stated area it already had — the load must never read `poly*` (AGENTS.md). A
  // TYPED area is the owner's own measurement, so it is left exactly as typed and the status says so.
  if (Array.isArray(payload.poly)) {
    const denom = roomDenom(room);
    const typed = areaIsTyped(room);
    const snap = plan.polyDrag && plan.polyDrag.id === room.id ? plan.polyDrag : null;
    setRoomRing(room, payload.poly, payload.page);
    if (!room.scaleDenom) room.scaleDenom = denom;
    plan.polyDrag = null;     // the gesture is over: no Escape restore can apply now
    // AREA follows the ring on a VERTEX drag — a hand-drawn shape and a traced outline alike; a MOVE
    // keeps the figure (a translation does not change the shoelace). A TYPED area is left alone.
    const followsRing = !typed && (room.source === 'drawn' || payload.kind === 'vertex');
    const measured = followsRing ? ringAreaIfUsable(room) : null;
    if (followsRing && measured != null) {
      room.area = measured;
      room.areaFromDrawing = true;
      delete room.areaUnknown;
      room.areaSource = 'drawing';
      // The tracer's verification numbers described the outline as it was traced; after the user
      // reshapes it they no longer describe anything, so drop them (the badge then just says the
      // shape is an outline traced from the drawing, which is still true).
      if (room.source !== 'drawn') { delete room.polyArea; delete room.polyRatio; }
      const inp = el.roomsBody.querySelector(`tr[data-id="${room.id}"] input[data-field="area"]`);
      if (inp) inp.value = String(room.area);
    } else if (followsRing && snap) {
      // The ring came back degenerate (empty, a speck, or self-crossing): it cannot describe a room,
      // so nothing may be measured from it — put back the figure the gesture started from (never 0 or
      // NaN from a broken ring) and say the shape is unusable.
      room.area = snap.area;
      if (snap.areaFromDrawing) room.areaFromDrawing = true; else delete room.areaFromDrawing;
      if (snap.areaUnknown) room.areaUnknown = true; else delete room.areaUnknown;
      const inp = el.roomsBody.querySelector(`tr[data-id="${room.id}"] input[data-field="area"]`);
      if (inp) inp.value = String(room.area);
    }
    updateLive();   // recalculates, refreshes computed cells, summary, description and the shapes
    saveSoon();
    // Only an edit that can CHANGE the area speaks about it: a vertex drag reshapes the room, a move
    // slides it (shoelace unchanged). The status must never quote a stale figure.
    if (payload.kind === 'vertex') {
      if (typed) {
        setStatus('ok', `${room.name || 'The room'} was reshaped, but your typed area ` +
          `${fmt(room.area, 1)} m² is unchanged — a geometry edit never replaces a figure you typed.`, 'plan');
      } else if (followsRing && measured != null) {
        setStatus('ok', `${room.name || 'The room'} was reshaped — its area now follows the outline ` +
          `you drew: ${fmt(room.area, 1)} m², and the load uses it.`, 'plan');
      } else if (followsRing) {
        setStatus('warn', `${room.name || 'The room'} was reshaped, but that outline is too small or ` +
          `crosses itself, so it cannot describe a room. Its area is left as it was ` +
          `(${fmt(room.area, 1)} m²) — drag the corners back into a real shape.`, 'plan');
      }
    }
    return;
  }
  const denom = roomDenom(room);
  // store the rectangle the same rounded way roomFromRect() does, so a move matches a fresh draw
  const next = {
    page: payload.page != null ? payload.page : (room.rect && room.rect.page) || plan.page || 1,
    x: round2(payload.x), y: round2(payload.y), w: round2(payload.w), h: round2(payload.h),
  };
  room.rect = next;
  room.scaleDenom = denom;
  if (!room.source) room.source = 'manual';
  const dims = dimsFromRect(next, denom);
  room.length = round2(dims.length);
  room.width = round2(dims.width);
  // AREA rule (the same one every geometry edit uses): a resize recomputes the area from the box ONLY
  // when the room did not carry a TYPED one. The owner's typed figure is his own measurement and must
  // never be replaced silently by a corner drag.
  const typed = areaIsTyped(room);
  if (!typed) room.area = round2(areaFromRect(next, denom));

  // the area cell shows room.area, so it has to be re-typed into the input as well (updateLive()
  // refreshes the computed cells and placeholders, but never overwrites a field's value) — unless the
  // area is the user's own typed value, which stays exactly as it is.
  const inp = el.roomsBody.querySelector(`tr[data-id="${room.id}"] input[data-field="area"]`);
  if (inp && !typed) inp.value = String(room.area);

  updateLive();   // recalculates, refreshes computed cells, summary, description and the boxes
  saveSoon();
  if (typed) {
    setStatus('ok', `${room.name || 'The room'} was resized, but your typed area ` +
      `${fmt(room.area, 1)} m² is unchanged — a geometry edit never replaces a figure you typed.`, 'plan');
  }
}

/** Delete/Backspace on a selection: drop the room from state and from the table, recalculate,
 *  refresh the summary and the description, redraw the boxes and persist. */
function planDeleteRoom(id) {
  const room = roomById(id);
  if (!room) return;
  const idx = state.rooms.indexOf(room);
  if (idx < 0) return;
  deleteRoom(idx);   // splices state, closes the description if it showed this room, renderAll + save
  planRenderGeometry();   // a deleted room's outline must leave the sheet too
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
async function planPlaceAllRooms(opts) {
  // A manual press while the automatic setup is running must be a no-op, not a second run.
  if (state.ui.autoSetupBusy && !(opts && opts.__auto)) return;
  if (!state.rooms.length) {
    setStatus('warn', 'There are no rooms in the table to place yet. Load a drawing or add rooms first.', 'plan');
    return;
  }

  // The button that started this is disabled and says it is working until it ends, and the bar beside
  // the buttons counts the rooms as they are placed (the owner: "people shouldnt have ambiguity").
  const restorePlaceBtn = planButtonWorking(el.planPlaceAll, 'Placing…');
  planProgressShow('Placing rooms on the plan');
  planProgressIndeterminate('Placing rooms on the plan - preparing…');
  try {

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
  const progressTotal = state.rooms.length;
  let placed = 0, noAt = 0, noArea = 0, already = 0, handDrawn = 0, seen = 0;
  for (const room of state.rooms) {
    seen += 1;
    if (seen % 10 === 0 || seen === progressTotal) {
      planProgressCount(seen, progressTotal, `Placing rooms on the plan - ${seen} of ${progressTotal} rooms`);
      await yieldToBrowser();
    }
    if (isPlacedRoom(room)) { already += 1; continue; }        // already has a locator box
    if (roomHasShape(room)) { handDrawn += 1; continue; }       // a hand-drawn box/outline already sits where it was traced
    if (!room.at) { noAt += 1; continue; }                      // the plan does not name this room
    const area = Number(room.area);
    if (!Number.isFinite(area) || area <= 0) { noArea += 1; continue; }
    const rect = rectFromLabel(room.at, area, denom, { length: room.length, width: room.width });
    if (!rect) { noArea += 1; continue; }
    // each room's box goes on ITS OWN page, not the page the user happens to be looking at
    room.rect = { ...rect, page: room.page || 1 };
    room.rectDrawing = plan.drawingId;   // the drawing this box was measured on
    placed += 1;
  }

  const notes = [];
  if (noAt) notes.push(`${noAt} ${noAt === 1 ? 'is' : 'are'} not named on the sheet, so ${noAt === 1 ? 'it stays' : 'they stay'} in the table only`);
  if (noArea) notes.push(`${noArea} ${noArea === 1 ? 'has' : 'have'} no usable area to size a box from, so ${noArea === 1 ? 'it stays' : 'they stay'} in the table only`);
  if (handDrawn) notes.push(`${handDrawn} hand-drawn box(es) were left where you traced them`);
  if (already) notes.push(`${already} ${already === 1 ? 'is' : 'are'} already on the plan`);

  if (!placed) {
    if (!notes.length) {
      setStatus('warn', 'No room to place — none of the rooms carries a usable area to size a box from.', 'plan');
      return;
    }
    // nothing new, but say WHY rather than a flat "done": rooms already placed, and rooms that have
    // nowhere to sit (the sheet does not name them) or nothing to size a box from.
    if (already && notes.length === 1) {
      setStatus('ok', rehydrateNote + `All ${already} room(s) the drawing names are already on the plan.`, 'plan');
      return;
    }
    setStatus('warn', rehydrateNote + `No room to place: ${notes.join('; ')}.`, 'plan');
    return;
  }

  planSync();     // refresh the hint (draw counts changed)
  renderAll();    // rebuild the table + summary and redraw the boxes (the table rows do not change)
  saveSoon();

  let msg = rehydrateNote + `Placed ${placed} room(s) on the plan. `;
  msg += notes.length ? `${notes.join('; ')}.` : 'Each box is a locator centred on the point that names the room, sized back from its own area — the load has not changed.';
  track('rooms_placed');
  setStatus('ok', msg, 'plan');
  } finally {
    planProgressHide();
    restorePlaceBtn();
  }
}

/** Remove ONLY the locator boxes made by "Place all rooms on the plan". Hand-drawn rooms and rooms
 *  that were never placed are untouched: their rectangle, area, name and include flag all stay. */
function planClearPlaced() {
  let removed = 0;
  for (const room of state.rooms) {
    if (!isPlacedRoom(room)) continue;
    delete room.rect;       // area, name, include and source are deliberately left alone
    delete room.rectDrawing;
    removed += 1;
  }
  if (!removed) {
    setStatus('warn', 'There are no placed rooms on the plan to remove.', 'plan');
    return;
  }
  planSync();
  renderAll();
  saveSoon();
  setStatus('ok', `Removed ${removed} placed room(s) from the plan. Hand-drawn boxes were left alone; ` +
    `the rooms and the load are unchanged.`, 'plan');
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

/** A plain-language bucket for a REFUSAL CODE from js/trace.js, so the status line can count
 *  categories, not rooms. The code is a stable machine value the tracer returns alongside its human
 *  sentence ('shared' | 'too-big' | 'no-region' | 'area-mismatch' | 'no-area'), so the app
 *  categorises by code and never regex-parses the English `reason` any more. */
function traceReasonBucket(code) {
  switch (code) {
    case 'too-big': return 'had no enclosed space around the name (open plan or a gap in the walls)';
    case 'no-region': return 'had their name on a wall line';
    case 'shared': return 'share their area with another room';
    case 'area-mismatch': return 'did not match their stated area';
    case 'no-area': return 'have no stated area to check the outline against';
    default: return 'the tracer could not verify them';
  }
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
  for (const b of [el.planPlaceAll, el.planPlaceClear, el.planTraceOutlines, el.planTraceClear,
    el.planFillAreas, el.planFillUndo]) {
    if (b) b.disabled = !!on;
  }
  // A finished fill/undo restores the Undo button's own enabled state (disabled == "nothing to undo").
  if (!on) planSyncFillButton();
}

/** Keep the fixed plan-progress bar beside the buttons: pin it just under the plan toolbar, clamped
 *  into the viewport, re-measured on scroll/resize. It is OUT OF FLOW, so it can never move #planView
 *  — an in-flow strip did move it, and the plan-gesture checks then failed because their targets had
 *  shifted off-screen. */
function placePlanProgress() {
  const t = el.planProgress;
  if (!t || t.dataset.active !== '1') return;
  const vh = window.innerHeight || 0;
  const h = t.offsetHeight || 0;
  const tb = document.querySelector('.plan-toolbar');
  let top = 64;
  if (tb) top = tb.getBoundingClientRect().bottom + 6;
  if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
  t.style.top = Math.round(top) + 'px';
}

/* ---- The plan panel's own progress bar ---------------------------------------------------------
 * A long plan operation must say what it is doing and how far it has got, and never invent a number
 * (the owner, twice: "people shouldnt have ambiguity"). The bar lives beside the buttons; while the
 * total is KNOWN it is a real ARIA progressbar counting ROOMS (aria-valuenow/valuemin/valuemax); when
 * the total is genuinely unknown it is INDETERMINATE — no aria-valuenow, no fake percentage, just
 * "Working...". */
function planProgressShow(label) {
  const b = el.planProgress;
  if (!b) return;
  b.dataset.active = '1';
  b.removeAttribute('aria-hidden');
  b.classList.remove('indeterminate');
  b.removeAttribute('aria-valuenow');
  b.setAttribute('aria-valuemin', '0');
  b.setAttribute('aria-valuemax', '100');
  if (el.planProgressText) el.planProgressText.textContent = label || 'Working...';
  if (el.planProgressFill) el.planProgressFill.style.width = '0%';
  placePlanProgress();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(placePlanProgress);
}

/** Show progress against a KNOWN total: the aria-* values carry the real counts and the fill width is
 *  the same fraction. `label` is the plain sentence naming the operation and the count. */
function planProgressCount(done, total, label) {
  const b = el.planProgress;
  if (!b || b.dataset.active !== '1') return;
  const t = Math.max(1, Number(total) || 0);
  const n = Math.max(0, Math.min(t, Number(done) || 0));
  b.classList.remove('indeterminate');
  b.setAttribute('aria-valuemin', '0');
  b.setAttribute('aria-valuemax', String(t));
  b.setAttribute('aria-valuenow', String(n));
  if (el.planProgressFill) el.planProgressFill.style.width = (100 * n / t).toFixed(2) + '%';
  if (el.planProgressText && label != null) el.planProgressText.textContent = label;
}

/** The total is genuinely unknown: an INDETERMINATE bar. No aria-valuenow, no made-up percentage. */
function planProgressIndeterminate(label) {
  const b = el.planProgress;
  if (!b || b.dataset.active !== '1') return;
  b.classList.add('indeterminate');
  b.removeAttribute('aria-valuenow');
  b.setAttribute('aria-valuemin', '0');
  b.setAttribute('aria-valuemax', '100');
  if (el.planProgressFill) el.planProgressFill.style.width = '';
  if (el.planProgressText && label != null) el.planProgressText.textContent = label || 'Working...';
}

function planProgressHide() {
  const b = el.planProgress;
  if (!b) return;
  b.dataset.active = '0';
  b.setAttribute('aria-hidden', 'true');
  b.classList.remove('indeterminate');
  b.removeAttribute('aria-valuenow');
  if (el.planProgressFill) el.planProgressFill.style.width = '0%';
  // Reset the wording too. A hidden bar that still reads "Tracing outlines - 149 of 149 rooms" is
  // invisible to a user but reads as a live (or just-finished) job to anything inspecting the DOM.
  if (el.planProgressText) el.planProgressText.textContent = 'Working...';
}

/** Mark the button that started a long job as working — disabled, its label saying so — and return a
 *  function that restores its idle label and enabled state. */
function planButtonWorking(btn, busyLabel) {
  if (!btn) return () => {};
  if (btn.dataset.idleLabel == null) btn.dataset.idleLabel = btn.textContent;
  btn.textContent = busyLabel;
  btn.disabled = true;
  return () => {
    if (btn.dataset.idleLabel != null) { btn.textContent = btn.dataset.idleLabel; delete btn.dataset.idleLabel; }
    btn.disabled = false;
  };
}

/** Let the browser paint: one macrotask hop, awaited between work units so the bar actually repaints
 *  while a synchronous-but-chunked job runs. A MessageChannel task is used rather than setTimeout(0)
 *  because DOM timers are clamped to ~1 s on a hidden/inactive tab (and in headless), which would turn
 *  a 20 s trace into minutes; a MessageChannel macrotask is never clamped and still lets the browser
 *  run its rendering steps between units. */
const yieldChannel = (typeof MessageChannel === 'function') ? new MessageChannel() : null;
let yieldResolvers = [];
if (yieldChannel) yieldChannel.port1.onmessage = () => { const r = yieldResolvers.shift(); if (r) r(); };
function yieldToBrowser() {
  if (!yieldChannel) return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => { yieldResolvers.push(resolve); yieldChannel.port2.postMessage(0); });
}

/** Read the plan's own linework and give every room it can verify a real outline. */
async function planTraceOutlines(opts) {
  // A manual press while the automatic setup is running must be a no-op, not a second run.
  if (state.ui.autoSetupBusy && !(opts && opts.__auto)) return;
  if (state.ui.traceBusy) return;
  if (!state.rooms.length) {
    setStatus('warn', 'There are no rooms to trace yet. Load a drawing or add rooms first.', 'plan');
    return;
  }
  if (!plan.viewer || plan.unavailable) {
    setStatus('warn', 'Open a drawing in the plan view first, then trace its outlines.', 'plan');
    return;
  }

  // Hold the busy flag for the WHOLE job, including the awaits that recover positions and load the
  // tracer: it used to be set only after those (≈1 s in on a live sheet), so a second click in that
  // window re-entered the trace — double work, a doubled status. Cleared in the finally on every path.
  planTraceBusy(true);
  const restoreTraceBtn = planButtonWorking(el.planTraceOutlines, 'Tracing…');
  try {

  // A project saved before the parser recorded WHERE the sheet names each room has no `at`; recover
  // the positions exactly like Place all rooms does, so tracing works on such a project too.
  // A room the user drew BY HAND is left out on purpose: its shape is their own work, not a stale
  // outline from an earlier trace, and tracing must not overwrite or drop it.
  const traceable = () => positionedRooms().filter((r) => r.source !== 'drawn');
  let withPos = traceable();
  if (!withPos.length) {
    const n = await rehydratePositions();
    if (n) saveSoon();
    withPos = traceable();
  }
  if (!withPos.length) {
    setStatus('warn', 'No room carries both a position on the sheet and an area, so there is nothing to trace. ' +
      'Upload the drawing again if the rooms have no position.', 'plan');
    return;
  }
  const noAt = state.rooms.filter((r) => !r.at || !Number.isFinite(r.at.x) || !Number.isFinite(r.at.y)).length;

  const denom = planScaleDenom();
  let trace;
  try { trace = await loadTraceModule(); } catch (err) { setStatus('err', (err && err.message) || String(err), 'plan'); return; }

  planHideScaleFix();   // a stale one-click fix must not survive the trace that replaces it
  setStatus(null, "Tracing the plan's linework… this can take a second or two on a big sheet.", 'plan');
  // A real progress bar beside the buttons: it starts INDETERMINATE (the room total is known, but no
  // room has been processed yet) and switches to a count as the tracer reports work done.
  planProgressShow('Tracing outlines');
  planProgressIndeterminate('Tracing outlines - preparing…');
  await nextFrame();

  try {
    const rec = await drawingBytesForTrace();
    if (!rec) {
      setStatus('warn', 'The drawing is not kept in this browser any more, so its linework cannot be read. ' +
        'Upload it again and try.', 'plan');
      return;
    }

    const doc = await pdfjs.getDocument({ data: rec.bytes.slice(0), verbosity: 0 }).promise;
    try {
      // Every room we are about to re-check loses any outline from an EARLIER trace: a shape that this
      // run refuses must not survive as a stale outline from the last one. Boxes are never touched.
      for (const r of withPos) { delete r.poly; delete r.polyPage; delete r.polyDrawing; delete r.polyArea; delete r.polyRatio; }

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

      // Progress, in ROOMS across every page: the honest denominator is the number of rooms being
      // traced. `progressDone` counts rooms a page's trace has fully finished (or skipped outright).
      const progressTotal = withPos.length;
      let progressDone = 0;
      let uiTick = 0;    // DOM text is refreshed every unit, but the paint hop is throttled (see below)
      const tickProgress = (label) => planProgressCount(progressDone, progressTotal, label);

      for (const p of [...byPage.keys()].sort((a, b) => a - b)) {
        const list = byPage.get(p);
        if (p < 1 || p > doc.numPages) {
          refused += list.length;
          refusedWithRect += list.filter((r) => r.rect).length;
          list.forEach(() => bump(reasonCount, 'are on a page the drawing does not have'));
          progressDone += list.length; tickProgress(`Tracing outlines - ${Math.min(progressDone, progressTotal)} of ${progressTotal} rooms`);
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
          progressDone += list.length; tickProgress(`Tracing outlines - ${Math.min(progressDone, progressTotal)} of ${progressTotal} rooms`);
          continue;
        }
        if (!segmentsInBox(segs, box, 2)) {
          badPages += 1;
          refused += list.length;
          refusedWithRect += list.filter((r) => r.rect).length;
          list.forEach(() => bump(reasonCount, 'could not be placed in the sheet’s own space'));
          console.warn(`[trace] skipped page ${p}: the linework falls outside the page MediaBox — ` +
            `the app and the tracer disagree on the page space, so no shape is stored for it.`);
          progressDone += list.length; tickProgress(`Tracing outlines - ${Math.min(progressDone, progressTotal)} of ${progressTotal} rooms`);
          continue;
        }

        const roomsIn = list.map((r) => ({ id: r.id, at: { x: r.at.x, y: r.at.y }, area: Number(r.area) }));
        // Which lines are the plan's WALLS is decided by result, not by how common a class is: on a real
        // MEP sheet the symbol hatch outnumbered the walls, so "most common class" traced symbols and
        // merged rooms. pickWallLines tries the few most common classes plus every line and keeps
        // whichever verifies the most rooms; the winner's class is named in the status line.
        // The ASYNC tracer does the same maths but yields to the browser between rooms, so this bar
        // actually repaints while a big sheet is being traced.
        const out = await trace.pickWallLinesAsync(segs, {
          box, rooms: roomsIn, denom, pxPerPt: TRACE_PX_PER_PT, thickness: TRACE_THICKNESS, topN: 3,
        }, async (prog) => {
          const frac = prog.total ? Math.min(1, prog.units / prog.total) : 1;
          const shown = Math.min(progressTotal, progressDone + Math.round(frac * (prog.rooms || list.length)));
          planProgressCount(shown, progressTotal, `Tracing outlines - ${shown} of ${progressTotal} rooms`);
          // The text/aria update above is cheap; a full macrotask hop per update is not (hundreds of
          // them add seconds), so the browser is only handed the loop every few updates — still visibly
          // live, and the trace stays close to its un-chunked wall-clock time.
          uiTick += 1;
          if (uiTick % 6 === 0) await yieldToBrowser();
        });
        progressDone += list.length; tickProgress(`Tracing outlines - ${Math.min(progressDone, progressTotal)} of ${progressTotal} rooms`);
        winKeys.add(out.key);

        for (const res of out.results) {
          const room = roomById(res.id);
          if (!room) continue;
          allResults.push(res);
          if (res.ok && Array.isArray(res.rings) && res.rings.length) {
            const ring = ringFor(res.rings, room.at, trace);
            room.poly = ring.map((pt) => ({ x: round2(pt.x), y: round2(pt.y) }));
            room.polyPage = p;
            room.polyDrawing = plan.drawingId;   // the drawing this outline was traced from
            // the module's own verdict numbers: the traced area the accept rule was judged on
            room.polyArea = round2(Number(res.tracedM2) || 0);
            room.polyRatio = Number((Number(res.ratio) || 0).toFixed(3));
            ratios.push(room.polyRatio);
            accepted += 1;
          } else {
            refused += 1;
            if (room.rect) refusedWithRect += 1;
            bump(reasonCount, traceReasonBucket(res.code));
          }
        }
      }

      planTraceBusy(false);
      renderAll();
      saveSoon();
      if (accepted) track('trace_run');   // an outline was actually stored

      // The implied scale only means something for a region that held exactly ONE label: a region that
      // merged several rooms, or one far larger than any single room, says nothing about the scale.
      // Filtering those out first is what makes the hint point at the real scale instead of at the junk.
      // Categorised by the tracer's stable CODE, never by regex-matching its English sentence.
      const scaleSet = allResults.filter((r) => r
        && !['shared', 'no-region', 'too-big'].includes(r.code));
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
      // Once the button has been used for THIS drawing, never offer it again — a second trace that
      // still disagrees only reports the scale (planShowScaleFix), so the fix cannot loop.
      const fixUsedHere = scaleFixUsedDrawing !== undefined
        && sameDrawingKey(scaleFixUsedDrawing, plan.drawingId);
      const offered = (scaleOff && !fixUsedHere) ? planOfferScale(implied.denom) : false;
      // ...and put the fix ON the plan panel, next to the button that produced it: the scale list entry
      // alone was easy to miss, and the explanation sat in the upload section (UX review, item 2).
      if (offered) planShowScaleFix({ implied: implied.denom, denom, accepted, attempted: withPos.length });
      else planHideScaleFix();

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
          (offered
            ? `(1:${implied.denom} is now in the drawing-scale list.) `
            : `(The one-click fix was already used for this drawing, so it is not offered again.) `);
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
        // Read forwards, always: "Of the 54 room(s) that got no outline, 0 kept their box (33 share
        // their area with another room, 10 had their name on a wall line)." The old "0 of the 54 kept
        // their box" read backwards and contradicted itself (UX review, item 4).
        const kept = refusedWithRect === refused
          ? `all ${refused} kept their box`
          : `${refusedWithRect} of ${refused} kept their box`;
        msg += `Of the ${refused} room(s) that got no outline, ${kept}` +
          `${parts.length ? ` (${parts.join(', ')})` : ''}. `;
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
      setStatus(accepted ? 'ok' : 'warn', msg.replace(/\s+$/, ''), 'plan');
    } finally {
      try { await doc.destroy(); } catch (e) { /* ignore */ }
    }
  } catch (err) {
    console.warn('[trace] tracing failed:', (err && err.message) || err);
    setStatus('err', `Tracing the plan's linework failed (${(err && err.message) || err}). ` +
      `The rooms and the load are unchanged.`, 'plan');
  }
  } finally {
    planProgressHide();
    planTraceBusy(false);
    restoreTraceBtn();
  }
}

/* ---- automatic setup of a freshly opened plan ---------------------------------------------------
 * A first-time visitor should not have to discover "Place all rooms" and "Trace real outlines": once
 * a drawing is loaded AND its rooms exist, the app runs those two steps itself — place first, then
 * trace, then stop. It never runs the area fill (that stays a manual button), never runs before the
 * rooms exist, and never runs when there is no drawing. A drawing whose rooms already carry geometry
 * (a re-load, a restored project, or the user's own work) is left exactly as it is, and a drawing is
 * set up at most once per session. Each step reuses the buttons' own progress bar, busy labels and
 * yielding; on any failure the run simply stops, the manual buttons stay usable and the bar is hidden
 * (every step hides it in its own finally). */

const planAutoSetupDone = new Set();   // drawingId -> automatic setup ran (or was skipped) for it
let planAutoSetupRunning = false;

/** Has any room already been given geometry — a traced ring (poly/polyPage) or a placed / hand-drawn
 *  box (rect)? If so the plan is already set up (this drawing, a restored project, or the user's own
 *  work) and the automatic run must not touch it. It also must not run when an OLDER drawing's rooms
 *  are still on the table: re-placing them on a new sheet would trample the "old drawing's shapes"
 *  behaviour (they are reported stale and offered for removal, never silently re-measured). */
function roomsHavePlanGeometry() {
  return state.rooms.some((r) => r && (
    (Array.isArray(r.poly) && r.poly.length > 2) || r.polyPage != null
    || (r.rect && typeof r.rect.x === 'number')));
}

/** Run the automatic setup once the drawing is loaded and the rooms exist. Called at the end of the
 *  drawing load AND after the rooms arrive (a load path reaches one before the other), so whichever
 *  call first finds BOTH ready does the work; every other call does nothing. */
function maybeAutoSetupPlan() {
  if (planAutoSetupRunning) return null;
  if (!plan.loaded || plan.drawingId == null || plan.unavailable || !plan.viewer) return null;
  if (!state.rooms.length) return null;
  if (planAutoSetupDone.has(plan.drawingId)) return null;
  if (roomsHavePlanGeometry()) { planAutoSetupDone.add(plan.drawingId); return null; }
  return planAutoSetup();
}

/** Place every room, then trace the real outlines, once — quietly, and never leaving a bad state. */
async function planAutoSetup() {
  if (planAutoSetupRunning) return;
  planAutoSetupRunning = true;
  state.ui.autoSetupBusy = true;           // manual presses during the run are no-ops (the guards)
  planAutoSetupDone.add(plan.drawingId);   // never twice for the same drawing this session
  // The drawing's own message (a sample fill's line, say) is overwritten by each step's status below,
  // so keep it here and put the automatic line AFTER it — the fill's counts stay on screen.
  const prior = (el.planStatus && !el.planStatus.classList.contains('hidden'))
    ? el.planStatus.textContent.replace(/\s+/g, ' ').trim() : '';
  try {
    await planPlaceAllRooms({ __auto: true });
    const placed = state.rooms.filter(isPlacedRoom).length;
    await planTraceOutlines({ __auto: true });
    const traced = state.rooms.filter((r) => Array.isArray(r.poly) && r.poly.length > 2).length;
    planAutoSetupStatus(placed, traced, prior);
  } catch (err) {
    // Never leave a bad state: each step hid its own bar and restored its own button in a finally, and
    // the manual buttons stay usable. Say nothing extra — the drawing just did not need the help.
    console.warn('[plan] automatic setup failed:', (err && err.message) || err);
  } finally {
    state.ui.autoSetupBusy = false;
    planAutoSetupRunning = false;
  }
}

/** One honest line when the automatic setup finishes: the REAL counts, and that it was automatic. It
 *  is appended to whatever the drawing's own message already said (`prior`, still one line), and never
 *  claims work that did not happen. */
function planAutoSetupStatus(placed, traced, prior) {
  const bits = [];
  if (placed) bits.push(`Placed ${placed} room locator${placed === 1 ? '' : 's'}`);
  if (traced) bits.push(`traced ${traced} outline${traced === 1 ? '' : 's'}`);
  let line;
  if (bits.length === 2) line = `${bits[0]} and ${bits[1]} straight from the drawing — automatically.`;
  else if (bits.length === 1) line = `${bits[0]} straight from the drawing — automatically.`;
  else line = 'Opened the drawing automatically, but no room could be placed or traced from it.';
  line += ' Use "Fill areas from the drawing" to measure the rest.';
  const existing = String(prior == null ? '' : prior).replace(/\s+/g, ' ').trim();
  if (existing && existing.indexOf('straight from the drawing — automatically') < 0) {
    line = `${existing} ${line}`;
  }
  setStatus('ok', line, 'plan');
}

/** The one-click scale fix, shown ON the plan panel (in #planScaleFix, above the drawing) when a
 *  trace reports the drawing scale is wrong. The offered list entry alone was easy to miss and the
 *  explanation sat far up the page (UX review, item 2). The button sets #planScale and re-runs the
 *  trace — for ANY offered scale, not only the sample's 1:101. */
function planShowScaleFix(info) {
  const box = el.planScaleFix;
  if (!box || !info || !(Number(info.implied) > 0)) return;
  const right = String(Math.round(info.implied));
  const what = info.accepted === 0
    ? 'finds no rooms'
    : `finds only ${info.accepted} of ${info.attempted} room(s)`;
  box.replaceChildren();
  const text = document.createElement('span');
  text.className = 'plan-scalefix-text';
  text.textContent = `This scale ${what}: the outlines point to about 1:${right}, not 1:${info.denom}.`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-small';
  btn.id = 'planScaleFixBtn';
  btn.textContent = `Use 1:${right} and trace again`;
  btn.addEventListener('click', () => {
    planOfferScale(info.implied);                       // make sure the option exists before selecting it
    scaleFixUsedDrawing = plan.drawingId;               // the fix is single-use per drawing — never re-offered
    planHideScaleFix();                                 // hide it at once, before the trace it starts
    if (el.planScale) el.planScale.value = right;
    planApplyScale(right);
    planTraceOutlines();
  });
  box.append(text, btn);
  box.classList.remove('hidden');
}

/** Hide the one-click scale fix (a new trace, or a manual scale change, supersedes it). */
function planHideScaleFix() {
  if (!el.planScaleFix) return;
  el.planScaleFix.classList.add('hidden');
  el.planScaleFix.replaceChildren();
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

/* ---- the drawing-scale list, including a user-typed CUSTOM scale --------------------------------
 * `#planScale` is filled from DRAWING_SCALES by planRenderScaleOptions(). On top of the presets it can
 * hold: a `1:N (from the drawing)` entry a trace offered (planOfferScale, marked data-from-drawing), a
 * `1:N (custom)` entry for a denominator the user typed (marked data-custom), and always a final
 * `Custom…` sentinel. The list is rebuilt from state.project.planScale every time it is shown, so a
 * project RESTORED from this browser shows its custom scale again instead of snapping to the nearest
 * preset — which would silently change EVERY area. The only place a scale is ever applied is
 * planApplyScale(); a custom value goes through it exactly like a preset. */
const CUSTOM_SCALE_VALUE = '__custom__';   // the sentinel option value; never a real scale
const CUSTOM_SCALE_MAX = 5000;             // above this a "scale" is almost certainly a typo

/** Is this denominator one of the presets (so it needs no `(custom)` entry of its own)? */
function isPresetScale(n) {
  return DRAWING_SCALES.some((s) => Number(s.denom) === Number(n));
}

/** (Re)build the drawing-scale <option> list from the current project scale. Preserves any
 *  `(from the drawing)` entry across rebuilds, adds a `(custom)` entry when the current scale is not a
 *  preset, and always ends with `Custom…`. */
function planRenderScaleOptions() {
  const sel = el.planScale;
  if (!sel) return;
  const cur = planScaleDenom();
  const draw = [...sel.options]
    .filter((o) => o.dataset && o.dataset.fromDrawing)
    .map((o) => ({ value: String(o.value), label: o.textContent }));
  const drawByVal = new Map(draw.map((d) => [d.value, d.label]));
  const html = DRAWING_SCALES.map((s) => {
    const v = String(s.denom);
    const over = drawByVal.get(v);
    return over
      ? `<option value="${v}" data-from-drawing="1">${esc(over)}</option>`
      : `<option value="${v}">${esc(s.label)}</option>`;
  });
  for (const d of draw) {
    if (isPresetScale(d.value)) continue;          // a preset already covers 1:N
    html.push(`<option value="${esc(d.value)}" data-from-drawing="1">${esc(d.label)}</option>`);
  }
  if (!isPresetScale(cur)) {
    html.push(`<option value="${cur}" data-custom="1">1:${cur} (custom)</option>`);
  }
  html.push(`<option value="${CUSTOM_SCALE_VALUE}">Custom…</option>`);
  sel.innerHTML = html.join('');
  sel.value = String(cur);
}

/** Select a custom denominator and apply it through the ONE scale path (planApplyScale). */
function planApplyCustomScale(n) {
  const sel = el.planScale;
  if (!sel) return;
  const v = String(n);
  [...sel.options].forEach((o) => { if (o.dataset.custom && o.value !== v) o.remove(); });
  let opt = [...sel.options].find((o) => o.value === v && o.dataset.custom);
  if (!opt) {
    opt = [...sel.options].find((o) => o.value === v);   // a preset with the same value: relabel it
    if (opt) opt.dataset.custom = '1';
  }
  if (!opt) {
    opt = document.createElement('option');
    opt.value = v;
    opt.dataset.custom = '1';
    sel.appendChild(opt);
  }
  opt.textContent = `1:${v} (custom)`;
  sel.value = v;
  planApplyScale(v);
}

/** Ask for the denominator behind `Custom…`. A cancel, or anything that is not a positive number in
 *  1..CUSTOM_SCALE_MAX, leaves the select exactly where it was and SAYS so — a silent no-op reads as
 *  broken, and a wrong scale silently changes every area, so a value is never guessed. */
function planAskCustomScale() {
  const sel = el.planScale;
  if (!sel) return;
  const prev = String(planScaleDenom());
  sel.value = prev;                      // the sentinel is never a real selection
  const raw = window.prompt('Drawing scale — type the N in 1:N (for example 175 for 1:175):', prev);
  if (raw == null) {
    sel.value = prev;
    setStatus('warn', `No scale was entered, so the drawing scale is unchanged (1:${prev}).`, 'plan');
    return;
  }
  const txt = String(raw).trim();
  const n = Number(txt);
  if (!Number.isFinite(n) || n <= 0) {
    sel.value = prev;
    setStatus('warn', `“${txt || '(blank)'}” is not a positive number, so the drawing scale is ` +
      `unchanged (1:${prev}). Type the N in 1:N, for example 175.`, 'plan');
    return;
  }
  if (n > CUSTOM_SCALE_MAX) {
    sel.value = prev;
    setStatus('warn', `1:${n} is beyond the range this tool accepts (1 to ${CUSTOM_SCALE_MAX}), so the ` +
      `drawing scale is unchanged (1:${prev}).`, 'plan');
    return;
  }
  planApplyCustomScale(n);
}

/** Which line class(es) the trace used, in words (one class, or a different winner per page). */
function passLabel(keys) {
  const list = [...(keys || [])];
  const name = (k) => (k === 'all lines' ? 'all the linework' : `the wall-line class "${k}"`);
  if (!list.length) return 'all the linework';
  if (list.length === 1) return name(list[0]);
  return list.map(name).join(' and ');
}

/** Remove ONLY the traced outlines. The rooms, their boxes, areas and the load are all untouched.
 *  A shape the user DREW by hand (source 'drawn') is not a trace and is left alone. */
function planTraceClear() {
  let removed = 0;
  for (const room of state.rooms) {
    if (!room.poly) continue;
    if (room.source === 'drawn') continue;
    delete room.poly;
    delete room.polyPage;
    delete room.polyDrawing;
    delete room.polyArea;
    delete room.polyRatio;
    removed += 1;
  }
  if (!removed) {
    setStatus('warn', 'There are no traced outlines to remove.', 'plan');
    return;
  }
  planHideScaleFix();
  renderAll();
  saveSoon();
  setStatus('ok', `Removed ${removed} traced outline(s). Their boxes, if any, and the load are unchanged.`, 'plan');
}

/* ---- "Fill areas from the drawing" -------------------------------------------------------------
 * A sheet that prints room NAMES but no AREAS (the real LEVEL 11 sample) parses into rooms with
 * `area: null`. The plan's own linework still encloses those rooms, so js/trace.js turns the walls
 * into regions and js/autotrace.js matches them to the names — filling an area ONLY where a single
 * name sits inside a single closed, sane-sized outline. The app never guesses which of several names
 * owns an outline, never overwrites an area a room already had, and never touches a stairwell: a
 * skipped room stays blank. One Undo step restores exactly the areas it replaced. */

/** True when a room carries a usable area (the same test the filler uses). */
function roomHasArea(r) {
  return Number.isFinite(Number(r && r.area)) && Number(r.area) > 0;
}

/** Named rooms that have no area yet and are not stairwells: the rooms this feature can fill.
 *  Stairwells are never conditioned (the owner's rule), so they are never even offered. */
function fillableRooms() {
  return state.rooms.filter((r) => r && r.name && !roomHasArea(r) && !isStairwellName(r.name));
}

/** The words a building-services engineer reads for one autotrace skip code (js/autotrace.js CODES).
 *  Never a count — the count comes from the run itself, never from this table. */
const FILL_REASON_WORDS = {
  shared: 'one outline holds several room names',
  'bad-area': 'the traced shape did not look like a room',
  'no-outline': 'no traced outline contains the name',
  'no-position': 'the plan gives no position for the name',
  open: 'the outline is not closed',
  overlap: 'the outline overlaps another traced outline',
  'on-edge': 'the room name sits on the outline',
  already: 'the room already had an area',
  stairwell: 'a stairwell, which is never cooled',
  unused: 'no room name sits inside the outline',
  'open-plan': 'the room is open to the next space, so its edge is not on the drawing',
  'unnamed-space': 'the room joins a space with no name through a doorway',
};
function fillReasonWords(code) {
  return FILL_REASON_WORDS[code] || 'the outline could not be verified';
}

/** "33 because one outline holds several room names, 2 because the traced shape did not look like a
 *  room." — built from the run's OWN reason counts (never hardcoded), most common first, at most
 *  three named reasons. */
function fillReasonSummary(reasonCount) {
  const entries = [...reasonCount.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  const parts = entries.slice(0, 3).map(([code, n]) => `${n} because ${fillReasonWords(code)}`);
  const rest = entries.slice(3).reduce((a, [, n]) => a + n, 0);
  let s = parts.join(', ');
  if (rest) s += `, ${rest} for other reasons`;
  return s + '.';
}

// The last fill run, for Undo: [{ id, area, include, areaUnknown }]. A single step is enough.
let lastFill = null;

/** Keep the fill buttons honest: offer the control when there are blank named rooms, and enable
 *  Undo only when a fill actually changed something. */
function planSyncFillButton() {
  const btn = el.planFillAreas;
  if (btn) {
    const n = fillableRooms().length;
    btn.dataset.nothingToFill = n ? '0' : '1';
    btn.setAttribute('aria-disabled', n ? 'false' : 'true');
    btn.title = n
      ? `Give ${n} named room${n === 1 ? '' : 's'} an area measured from the plan's own outlines`
      : 'Every room already has an area, so there is nothing to fill from the drawing.';
  }
  if (el.planFillUndo) el.planFillUndo.disabled = !(lastFill && lastFill.length);
}

/** Undo the last "Fill areas from the drawing": put back exactly the areas (and Include flags) the
 *  fill replaced, and drop the "from the drawing" mark. */
function planUndoFill() {
  if (!lastFill || !lastFill.length) {
    setStatus('warn', 'There is nothing to undo: no areas have been filled from the drawing.', 'plan');
    return;
  }
  const n = lastFill.length;
  for (const s of lastFill) {
    const room = roomById(s.id);
    if (!room) continue;
    if (s.area === null || s.area === undefined) delete room.area; else room.area = s.area;
    if (s.include === undefined) delete room.include; else room.include = s.include;
    if (s.areaUnknown) room.areaUnknown = true; else delete room.areaUnknown;
    delete room.areaFromDrawing;
    delete room.areaSource;
  }
  lastFill = null;
  renderAll();
  saveNow();
  planSyncFillButton();
  planRenderGeometry();
  setStatus('ok', `Undone: ${n} area${n === 1 ? '' : 's'} put back exactly as they were, ` +
    `and the load is back to what it was.`, 'plan');
}

/** Apply the confident assignments to the rooms, remember the previous values for Undo, and report
 *  honestly what was filled and what was left alone. */
function planApplyFill(assignments, reasonCount, info) {
  const toFill = info.fillable;
  const filled = [];
  for (const [id, a] of assignments) {
    const room = roomById(id);
    if (!room) continue;
    if (roomHasArea(room)) continue;      // paranoid re-check: never overwrite a real area
    filled.push({
      id,
      area: room.area === undefined ? null : room.area,
      include: room.include,
      areaUnknown: room.areaUnknown === true,
    });
    room.area = a.areaM2;
    delete room.areaUnknown;
    delete room.areaTyped;      // the area comes from the drawing now, so edits may follow the shape
    // Mark it so the table can say where the area came from, and so a later run/undo behave.
    room.areaFromDrawing = true;
    room.areaSource = 'drawing';
    // A room with no area was left out of the load. Now it has one, switch it on by the SAME rule the
    // parser uses for a room that HAS an area (so a toilet/stairwell stays out) — otherwise filling
    // areas would change no total at all, which is the whole point of the feature.
    room.include = !NON_AC_WORDS.test(room.name || '');
  }
  // Only a run that CHANGED something becomes the Undo step. A run that filled nothing must leave the
  // previous Undo intact — otherwise pressing Fill areas a second time (which changes nothing, and says
  // so) silently destroys the user's one chance to put the earlier fill back.
  if (filled.length) lastFill = filled;
  // Remember the state this run finished in, so a repeat press with nothing changed answers at once.
  state.ui.fillSig = planFillSignature();
  renderAll();
  saveNow();
  planSyncFillButton();
  planRenderGeometry();

  if (!filled.length) {
    const why = fillReasonSummary(reasonCount) || 'no blank room matched one closed outline of the plan.';
    track('fill_none');   // the fill ran but filled nothing — a coarse failure signal (js/usage.js)
    setStatus('warn', `No area could be filled from the drawing: ${why} Nothing was changed.`, 'plan');
    return;
  }
  const left = Math.max(0, toFill - filled.length);
  const tail = left > 0 ? ` ${left} left alone — ${fillReasonSummary(reasonCount)}` : '';
  const pages = info.pagesSkipped
    ? ` ${info.pagesSkipped} page(s) had no readable linework.` : '';
  setStatus('ok', `Filled ${filled.length} area${filled.length === 1 ? '' : 's'} from the drawing ` +
    `(using ${info.passKey === 'mixed' ? 'the plan’s own wall lines' : passLabel([info.passKey])}).${tail}${pages} ` +
    `They now count in the load, unless the name means a space that is not cooled. Undo puts them back.`, 'plan');
}

/** Everything a fill result depends on: the drawing, the scale, and the rooms (name, whether they
 *  already have an area, and the outline/box they use). Two fills with the same signature MUST agree,
 *  so a repeat run with nothing changed cannot find a single new area. */
function planFillSignature() {
  const rooms = (state.rooms || []).map((r) => [
    r.id, r.name || '', Number(r.area) > 0 ? 'A' : '-',
    r.poly ? r.poly.length : 0, r.rect ? 1 : 0, r.include === false ? 0 : 1,
  ].join('|')).join('~');
  return `${plan.drawingId || ''}@${planScaleDenom()}#${rooms}`;
}

/** Read the plan's own linework and give the blank named rooms an area — but only where the match is
 *  unambiguous. Never overwrites an area, never touches a stairwell, never invents a number. */
async function planFillAreas(opts) {
  // A manual press while the automatic setup is running must be a no-op, not a second run.
  if (state.ui.autoSetupBusy && !(opts && opts.__auto)) return;
  if (state.ui.traceBusy) return;
  if (!state.rooms.length) {
    setStatus('warn', 'There are no rooms to fill yet. Load a drawing or add rooms first.', 'plan');
    return;
  }
  const fillable = fillableRooms();
  if (!fillable.length) {
    setStatus('warn', 'Every room already has an area, so there is nothing to fill from the drawing. ' +
      'An area is filled only when a single room name sits inside one closed outline the plan itself draws.', 'plan');
    return;
  }
  if (!plan.viewer || plan.unavailable) {
    setStatus('warn', 'Open a drawing in the plan view first, then fill the blank areas from its outlines.', 'plan');
    return;
  }
  // A fill is DETERMINISTIC for a given drawing, scale and set of rooms: re-running it with nothing
  // changed in between cannot find one new area. Saying so at once beats spending the same minutes to
  // learn the same thing — "a second press must say there is nothing left rather than pretend to work".
  if (state.ui.fillSig && state.ui.fillSig === planFillSignature()) {
    setStatus('warn', 'Nothing was changed since the last fill, so no new area could be measured from ' +
      'the drawing. Move a room, redraw its shape or change the scale first, then fill again.', 'plan');
    return;
  }

  planTraceBusy(true);
  const restoreFillBtn = planButtonWorking(el.planFillAreas, 'Filling…');
  try {
    // A project saved before the parser recorded WHERE the sheet names each room has no `at`; recover
    // the positions exactly like Place all rooms / Trace real outlines do.
    if (!state.rooms.some((r) => r.at && Number.isFinite(r.at.x) && Number.isFinite(r.at.y))) {
      const n = await rehydratePositions();
      if (n) saveSoon();
    }

    const denom = planScaleDenom();
    let trace, auto;
    try { trace = await loadTraceModule(); } catch (err) { setStatus('err', (err && err.message) || String(err), 'plan'); return; }
    try { auto = await loadAutotraceModule(); } catch (err) { setStatus('err', (err && err.message) || String(err), 'plan'); return; }

    planHideScaleFix();
    setStatus(null, "Reading the plan's linework to fill the blank areas… this can take a few seconds on a big sheet.", 'plan');
    planProgressShow('Filling areas from the drawing');
    planProgressIndeterminate('Filling areas from the drawing - preparing…');
    await nextFrame();

    try {
      const rec = await drawingBytesForTrace();
      if (!rec) {
        setStatus('warn', 'The drawing is not kept in this browser any more, so its linework cannot be read. ' +
          'Upload it again and try.', 'plan');
        return;
      }
      const doc = await pdfjs.getDocument({ data: rec.bytes.slice(0), verbosity: 0 }).promise;
      try {
        const fillIds = new Set(fillable.map((r) => r.id));
        const pages = [...new Set(fillable.map((r) => Number(r.page) || 1))].sort((a, b) => a - b);
        const assignments = new Map();     // roomId -> { areaM2, regionId }
        const reasonCount = new Map();
        let pagesRead = 0, pagesSkipped = 0, regionsTotal = 0, passKey = null;

        // Progress in ROOMS to fill, across pages; a skipped page still advances the count.
        const progTotal = fillable.length;
        let progDone = 0;
        let fillTick = 0;
        const fillOnPage = (pno) => state.rooms.filter((r) => (Number(r.page) || 1) === pno && fillIds.has(r.id)).length;
        const tickFill = () => planProgressCount(progDone, progTotal,
          `Filling areas from the drawing - ${Math.min(progDone, progTotal)} of ${progTotal} rooms`);

        for (const p of pages) {
          if (p < 1 || p > doc.numPages) { pagesSkipped += 1; progDone += fillOnPage(p); tickFill(); continue; }
          const pg = await doc.getPage(p);
          const v = pg.view;
          const box = { x0: v[0], y0: v[1], x1: v[2], y1: v[3] };
          const opList = await pg.getOperatorList();
          const segs = lineSegmentsForPage(opList.fnArray, opList.argsArray, pdfjs.OPS, trace);
          if (!segs.length || !segmentsInBox(segs, box, 2)) { pagesSkipped += 1; progDone += fillOnPage(p); tickFill(); continue; }

          // EVERY room on the page goes in, not only the blank ones: "exactly one name inside the
          // outline" must be judged against every name, so a region holding a blank room AND a named
          // room is refused (shared) rather than wrongly handed to the blank one.
          const pageRooms = state.rooms.filter((r) => (Number(r.page) || 1) === p);
          const pageFillCount = pageRooms.filter((r) => fillIds.has(r.id)).length;
          const roomInput = pageRooms.map((r) => ({
            id: r.id, name: r.name, at: r.at,
            area: roomHasArea(r) ? Number(r.area) : null,
            include: r.include,
          }));

          // Try the few most common line classes plus every line and keep whichever fills the most
          // blank rooms — the same by-result choice the outline tracer makes (on a real MEP sheet the
          // symbol hatch can outnumber the walls).
          const cands = trace.styleCounts(segs).slice(0, 3)
            .map(([key]) => ({ key, segs: trace.filterByStyle(segs, key) }));
          cands.push({ key: 'all lines', segs });
          let best = null;
          for (let ci = 0; ci < cands.length; ci += 1) {
            const c = cands[ci];
            const regions = (await trace.traceRegionsAsync({
              segments: c.segs, box, rooms: roomInput, denom,
              pxPerPt: TRACE_PX_PER_PT, thickness: TRACE_THICKNESS,
              closeGaps: trace.RECOMMENDED_CLOSE_GAPS,
              splitShared: true,   // SPLITSHARED-ON: split a region holding several names at its door-width necks; unnamed halls go to nobody (js/splitregion.js)
            }, async (prog) => {
              const pageFrac = (ci + (prog.total ? prog.done / prog.total : 1)) / cands.length;
              const shown = Math.min(progTotal, progDone + Math.round(pageFrac * pageFillCount));
              planProgressCount(shown, progTotal, `Filling areas from the drawing - ${shown} of ${progTotal} rooms`);
              fillTick += 1;
              if (fillTick % 6 === 0) await yieldToBrowser();
            })).regions;
            const out = auto.matchRoomsToRegions({ rooms: roomInput, regions });
            const n = out.assignments.filter((a) => fillIds.has(a.roomId)).length;
            if (!best || n > best.n) best = { key: c.key, regions, out, n };
          }
          progDone += pageFillCount; tickFill();
          pagesRead += 1;
          regionsTotal += best.regions.length;
          if (!passKey) passKey = best.key;
          else if (passKey !== best.key) passKey = 'mixed';

          const assignBy = new Map(best.out.assignments.map((a) => [a.roomId, a]));
          const skipBy = new Map(best.out.skipped.filter((s) => s.kind === 'room').map((s) => [s.id, s.code]));
          for (const r of pageRooms) {
            if (!fillIds.has(r.id)) continue;
            const a = assignBy.get(r.id);
            if (a) { assignments.set(r.id, { areaM2: a.areaM2, regionId: a.regionId }); continue; }
            const code = skipBy.get(r.id) || 'no-outline';
            reasonCount.set(code, (reasonCount.get(code) || 0) + 1);
          }
        }

        planApplyFill(assignments, reasonCount, {
          fillable: fillable.length, pagesRead, pagesSkipped, regionsTotal, passKey, denom,
        });
      } finally {
        try { await doc.destroy(); } catch (e) { /* ignore */ }
      }
    } catch (err) {
      console.warn('[fill] filling areas failed:', (err && err.message) || err);
      setStatus('err', `Filling the areas from the drawing failed (${(err && err.message) || err}). ` +
        `The rooms and the load are unchanged.`, 'plan');
    }
  } finally {
    planProgressHide();
    planTraceBusy(false);
    restoreFillBtn();
  }
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

/* ---- "Draw shape": a hand-drawn polygon with any number of edges ---------------------------------
 * The overlay (js/overlay.js, mode 'shape') reports a CLOSED ring in PDF space — the same space
 * room.poly uses for a traced outline — so a hand-drawn shape is stored, drawn, hit-tested, moved and
 * exported exactly like a traced one. Two extra things happen here:
 *   • a ring that crosses itself, or encloses almost no area, is refused with one plain line and never
 *     becomes a room (polyshape.polygonIsSimple / the MIN area rule);
 *   • a usable ring is offered to the user: it can become its OWN new room, or REPLACE the shape and
 *     AREA of an existing table row. Assigning a shape changes that room's area, and therefore its
 *     load — that is the whole point of tracing a real boundary by hand — and the chooser says so.
 * The area is the ring's shoelace converted to m² through the SAME points→metres conversion the
 * placed rectangles use (planview.areaFromRect, wrapped by polyshape.polyAreaM2): there is no second
 * formula. */

/** True when the user TYPED this room's area himself (areaTyped, set in onTableInput). That figure is
 *  the owner's own measurement: no geometry edit may replace it silently. A path that recomputes an
 *  area checks this FIRST and leaves the room exactly as typed instead. */
function areaIsTyped(room) {
  return !!(room && room.areaTyped);
}

/** A room the user drew by hand: source 'drawn' plus a poly ring. */
function isDrawnPolyRoom(room) {
  return !!(room && room.source === 'drawn' && Array.isArray(room.poly) && room.poly.length > 2);
}

/** Does this room carry geometry on the plan — a ring (traced, drawn, or a converted polygon) or a
 *  box (placed or hand-drawn)? A converted polygon owns its shape through the RING and carries no
 *  `rect`, so planview.isDrawnRoom() alone would miss it; this is the single "has a shape on the plan"
 *  test the box-based paths use. */
function roomHasShape(room) {
  if (!room) return false;
  if (Array.isArray(room.poly) && room.poly.length > 2) return true;
  return !!(room.rect && typeof room.rect.x === 'number');
}

/** Write a ring onto a room: the ring, its page, and a bounding-box rect — so every existing "this
 *  room has geometry on the plan" path (hints, place-all, the table badge) keeps working. The ring is
 *  what the overlay draws and hit-tests; the rect is only its box. NEVER touches `source`: a traced
 *  outline stays traced. */
function setRoomRing(room, ring, page) {
  const hadRing = Array.isArray(room.poly) && room.poly.length > 2;
  const pts = roundRing(ring);
  room.poly = pts;
  room.polyPage = page != null ? page : (room.polyPage || plan.page || 1);
  room.polyDrawing = plan.drawingId;   // this ring is measured on the drawing now loaded
  // A room whose shape is a RING owns it through the ring: it must not ALSO grow a `rect`. A bounding
  // box on a polygon is a lie about the shape, and rewriting it on every vertex drag would resurrect a
  // rectangle behind the polygon that a later corner gesture could act on. So the box is written only
  // when this call GIVES the room its first ring (a trace, a hand-drawn shape, a shape moved onto it) —
  // the box-based paths (isDrawnRoom, place-all) still recognise that room. A room that already had a
  // ring (a converted polygon's vertex/edge edit) keeps whatever box state it has: none, for a
  // conversion, which drops the box on release (planConvertRectToPoly).
  if (hadRing) return;
  const bbox = ringBBox(pts);
  if (bbox) {
    room.rect = {
      page: room.polyPage, x: round2(bbox.x), y: round2(bbox.y),
      w: round2(bbox.w), h: round2(bbox.h),
    };
    room.rectDrawing = plan.drawingId;
  }
}

/** The area (m²) a hand-drawn room's own ring represents at its own drawing scale. */
function drawnPolyArea(room) {
  return round2(polyAreaM2(room.poly, roomDenom(room)));
}

/** The area (m²) a room's ring represents, but ONLY when that ring is a usable room shape — 3+ points,
 *  simple (non-self-intersecting) and more than a speck of paper, the same rule the shape tool refuses
 *  a nonsense draw with (polyshape.ringIsUsable). A degenerate ring returns null so that NO path can
 *  write an area of 0 or NaN from it: the caller keeps the room's previous area and says the shape is
 *  unusable. Traced outlines and hand-drawn shapes go through the ONE shoelace (polyshape.polyAreaM2). */
function ringAreaIfUsable(room) {
  const ring = room && room.poly;
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const denom = roomDenom(room);
  if (!ringIsUsable(ring, denom)) return null;
  const area = polyAreaM2(ring, denom);
  return Number.isFinite(area) && area > 0 ? round2(area) : null;
}

/** A BOX becoming a POLYGON. The overlay reports the ring (the four corners plus the vertex inserted
 *  when an edge middle was dragged) in PDF space; this writes it the way every other outline is
 *  stored: `poly` + `polyPage` + `polyDrawing`, so the overlay draws/hit-tests/moves it as a polygon
 *  and the drawing tag keeps it on the sheet it was measured on. `final` is false while the drag is
 *  live — then the box is KEPT, so Escape leaves the room untouched; on release the box is dropped.
 *  AREA (the rule planDetachShape/planCommitShape use): the new shape's area replaces the room's ONLY
 *  when that area already came FROM a shape (areaFromDrawing, or a room the user drew); a typed or
 *  placed area is never overwritten. */
function planConvertRectToPoly(room, ring, page, final) {
  const denom = roomDenom(room);
  room.poly = roundRing(ring);
  room.polyPage = page != null
    ? page
    : (room.polyPage || (room.rect && room.rect.page) || plan.page || 1);
  room.polyDrawing = plan.drawingId;
  if (!final) return;                 // live drag: the box stays, so an abandoned drag changes nothing
  delete room.rect;
  delete room.rectDrawing;
  // AREA rule: the new shape's area replaces the room's ONLY when that area came FROM a shape
  // (areaFromDrawing, or a room the user drew) AND the user did not type it. A typed area is the
  // owner's own measurement and is NEVER silently replaced by a geometry edit — the opposite direction
  // from a row that GIVES its shape away, which blanks the area that shape was providing.
  if (!areaIsTyped(room) && (room.areaFromDrawing || room.source === 'drawn')) {
    room.source = 'drawn';            // it now owns its area through the ring (vertex edits follow)
    room.scaleDenom = denom;
    room.area = round2(polyAreaM2(room.poly, denom));
    room.areaFromDrawing = true;
    delete room.areaUnknown;
  }
}

/** The ring is stored, pending the user's choice in the chooser. */
let pendingShape = null;   // { ring:[{x,y}], page }

/** A shape closed in the overlay: refuse a nonsense one, otherwise ask what room it belongs to. */
function planDrawShape(ring, info) {
  const page = (info && info.page) || plan.page || 1;
  const denom = planScaleDenom();
  if (!ringIsUsable(ring, denom)) {
    setStatus('warn', 'That shape cannot be used: its lines cross each other, or it encloses almost ' +
      'no area. Please draw it again.', 'plan');
    return;
  }
  // A previous shape still waiting for a choice is kept as a new room (the tool's normal behaviour)
  // before the new one takes the chooser.
  if (pendingShape) planCommitShape(null);
  pendingShape = { ring: roundRing(ring), page };
  // The overlay threw its draft away when the shape closed, so hand it back as a PENDING ring: the user
  // has to pick which room this shape belongs to, and choosing blind is how the wrong room gets sized.
  if (plan.overlay && typeof plan.overlay.setPendingRing === 'function') {
    plan.overlay.setPendingRing(pendingShape.ring, pendingShape.page);
  }
  planShowShapeChooser();
  planSync();   // the hint must describe the CHOICE now, not the drawing tool
}

/** Fill and show the "This shape is room:" chooser near the plan. */
function planShowShapeChooser() {
  if (!el.planShapeAssign || !pendingShape) return;
  el.planShapeAssignRoom.innerHTML = '<option value="">(new room)</option>' +
    pickerRooms(null)
      .map((r) => `<option value="${esc(r.id)}">${esc(roomOptionLabel(r, { areaFallback: false }))}</option>`)
      .join('');
  el.planShapeAssignRoom.value = '';
  el.planShapeAssign.classList.remove('hidden');
  if (plan.overlay) plan.overlay.render();
  try { el.planShapeAssign.scrollIntoView({ block: 'nearest' }); } catch (err) { /* older browsers */ }
}

function planHideShapeChooser() {
  if (el.planShapeAssign) el.planShapeAssign.classList.add('hidden');
}

/**
 * Apply the pending shape. `roomId` = an existing row to give the shape to; empty/null = make a NEW
 * room (also what a dismiss does, exactly like the plain tool). Assigning sets the room's area to the
 * ring's shoelace area, so the table, the totals, the CSV and the report all move with it.
 */
function planCommitShape(roomId) {
  if (!pendingShape) return;
  const shape = pendingShape;
  pendingShape = null;
  planHideShapeChooser();
  // The choice is made: the ring is now the room's own geometry (drawn as a normal room) or it is gone,
  // so the pending preview must not linger.
  if (plan.overlay && typeof plan.overlay.clearPendingRing === 'function') plan.overlay.clearPendingRing();
  planSync();
  const room = roomId ? roomById(roomId) : null;
  if (room) {
    const before = Number(normalizeRoom(room, state.project).area) || 0;
    room.source = 'drawn';
    room.scaleDenom = planScaleDenom();
    setRoomRing(room, shape.ring, shape.page);
    room.area = drawnPolyArea(room);
    delete room.areaTyped;      // the drawn shape now provides the area: edits follow the shape again
    delete room.areaUnknown;
    renderAll();
    saveNow();
    planRenderGeometry();
    const delta = round2(room.area - before);
    setStatus('ok', `${room.name || 'Room'} was given the drawn shape: its area is now ` +
      `${fmt(room.area, 1)} m² (${delta >= 0 ? '+' : ''}${fmt(delta, 1)} m²), and the load has ` +
      `changed with it. Its shape now comes from the drawing.`, 'plan');
    planSetMode('select');       // hand the user the new geometry, ready to reshape
    planSelectRoom(room);
    return;
  }
  planCreateShapeRoom(shape);
}

/**
 * Take the shape off a row, leaving the room as a plain typed one. The area cannot stay as if the shape
 * were still there: an area that came from the drawing goes back to "unknown" so the load stops counting
 * a figure nothing supports.
 */
function planDetachShape(roomId) {
  const room = roomById(roomId);
  if (!room || !Array.isArray(room.poly)) return;
  const wasFromDrawing = !!(room.areaFromDrawing || room.source === 'drawn');
  const oldArea = Number(room.area);
  delete room.poly;
  delete room.polyPage;
  delete room.polyDrawing;
  delete room.rect;
  delete room.rectDrawing;
  delete room.areaFromDrawing;
  delete room.areaSource;
  room.source = 'manual';
  if (wasFromDrawing) { room.area = null; room.areaUnknown = true; }
  renderAll();
  saveNow();
  planRenderGeometry();     // the outline must leave the sheet the moment the row stops claiming it
  // The shape that was being edited is gone, so drop the selection too: the row keeps its data in the
  // table, but nothing of it is left on the drawing (no outline, and no lingering focus pointer).
  closeDetail();
  setStatus('ok', `The shape was removed from ${room.name || 'the room'}. ` +
    (wasFromDrawing
      ? `Its area was the drawn shape, so it now counts as unknown and is left out of the load until you type one.`
      : `It keeps the area you typed (${fmt(oldArea, 1)} m²).`) +
    ` Choose Draw shape to draw it again if that was a mistake.`, 'plan');
}

/**
 * Move a row's shape onto another row - the correction for picking the wrong room when the shape closed.
 * The receiving row gets the shape, its area and its load; the giving row keeps its own data but stops
 * claiming an area the shape was providing.
 */
function planMoveShapeTo(fromId, toId) {
  const from = roomById(fromId);
  const to = toId ? roomById(toId) : null;
  if (!from || !to) return;
  if (from.id === to.id) return;
  if (!Array.isArray(from.poly) || from.poly.length <= 2) return;
  const ring = from.poly.map((p) => ({ x: p.x, y: p.y }));
  const page = from.polyPage;
  const denom = roomDenom(from);
  const wasFromDrawing = !!(from.areaFromDrawing || from.source === 'drawn');
  const toHadShape = !!((to.poly && to.poly.length > 2) || to.rect);
  const toOldArea = Number(normalizeRoom(to, state.project).area);

  planDetachShape(fromId);          // the giving row stops claiming the shape (and says nothing yet)
  to.source = 'drawn';
  to.scaleDenom = denom;
  setRoomRing(to, ring, page);
  to.area = drawnPolyArea(to);
  to.areaFromDrawing = true;
  delete to.areaTyped;        // the shape now provides the area: edits on it follow the shape again
  delete to.areaUnknown;
  renderAll();
  saveNow();
  planRenderGeometry();     // the outline moved from one box to another on the sheet
  setStatus('ok', `The drawn shape now belongs to ${to.name || 'the room'}` +
    `${to.level ? ` (${to.level})` : ''}: its area is ${fmt(to.area, 1)} m² and the load uses it. ` +
    (toHadShape ? `Its previous shape was replaced. ` : '') +
    `${from.name || 'The other room'} ` +
    (wasFromDrawing ? 'had its area from this shape, so its area is now unknown and it is out of the load.'
                    : `keeps the area you typed (${fmt(toOldArea, 1)} m²).`), 'plan');
  planSelectRoom(to);
  openDetail(to.id, { keepView: true });
}

/** Create a new room from a ring — the tool's normal behaviour. */
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
  planRenderGeometry();
  if (res.added) {
    setStatus('ok', `${room.name} added — ${room.length} × ${room.width} m, ${room.area} m² at 1:${denom}. ` +
      `Set its name, orientation and glazing below; the load already uses it.`, 'plan');
    planSelectRoom(room);
  } else if (res.skipped) {
    // addRooms de-duplicates on name + level + area, so a draw that lands on an existing room used to
    // vanish with no message. Say it plainly, and point at the shape tool (which can REPLACE a room's
    // area) instead of drawing the same rectangle twice.
    setStatus('warn', `That rectangle was not added: a room with the same name, level and area ` +
      `(${room.area} m²) is already in the table. Draw a different size, or give the shape to that ` +
      `room with "Set the shape" to replace its area.`, 'plan');
  } else {
    setStatus('warn', 'That rectangle was not added. Draw it again, or add the room by hand.', 'plan');
  }
}

function planCreateShapeRoom(shape) {
  const page = shape.page;
  const denom = planScaleDenom();
  const n = state.rooms.filter((r) => isDrawnRoom(r) && !isPlacedRoom(r)).length + 1;
  const room = {
    id: newId(),
    name: `Drawn room ${n}`,
    level: planLevelForPage(page),
    scaleDenom: denom,
    source: 'drawn',
    include: true,
  };
  setRoomRing(room, shape.ring, page);
  room.area = drawnPolyArea(room);
  const res = addRooms([room]);
  renderAll();
  saveNow();
  planRenderGeometry();
  if (res.added) {
    setStatus('ok', `${room.name} added — ${fmt(room.area, 1)} m² drawn on the plan at 1:${denom}. ` +
      `Set its name, orientation and glazing below; the load already uses it. ` +
      `The tool is now on Select / edit so you can reshape it — pick Draw shape to draw the next room.`, 'plan');
    planSetMode('select');       // hand the user the new geometry, ready to reshape
    planSelectRoom(room);
  } else if (res.skipped) {
    setStatus('warn', `That drawn shape was not added as a new room: a room with the same name, level ` +
      `and area (${fmt(room.area, 1)} m²) is already in the table. Pick that room in the chooser and ` +
      `press "Set the shape" to replace its area instead.`, 'plan');
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
  let changed = 0, keptTrace = 0;
  for (const r of state.rooms) {
    // A TYPED area is the user's own figure, independent of the drawing scale: changing the scale must
    // not silently replace it (the same rule every geometry edit follows).
    if (areaIsTyped(r)) continue;
    if (!roomHasShape(r) || isPlacedRoom(r)) continue;
    if (isDrawnPolyRoom(r)) {
      // a HAND-DRAWN SHAPE owns its area through the RING, not through the bounding box, so it is
      // re-measured from the ring at the new scale (a traced outline keeps the old rect behaviour)
      r.scaleDenom = n;
      r.area = round2(polyAreaM2(r.poly, n));
      changed += 1;
      continue;
    }
    // A TRACED OUTLINE also has a `poly`. Moving one in Select mode writes `room.rect` = the ring's
    // bounding box while leaving `source !== 'drawn'` (see setRoomRing), so this else-branch used to
    // treat that bbox as the room's own rectangle and OVERWRITE `room.area` with areaFromRect(bbox) —
    // silently changing an L-shaped traced room's area (and load) when the user only changed scale.
    // A traced room's area is the plan's own figure, so it is never re-measured from a box here.
    if (Array.isArray(r.poly) && r.poly.length > 2) { keptTrace += 1; continue; }
    const dims = dimsFromRect(r.rect, n);
    r.scaleDenom = n;
    r.area = round2(areaFromRect(r.rect, n));
    r.length = round2(dims.length);
    r.width = round2(dims.width);
    changed += 1;
  }
  renderAll();
  saveSoon();
  const keptNote = keptTrace
    ? ` ${keptTrace} traced outline(s) kept their own area.`
    : '';
  setStatus('ok', changed
    ? `Drawing scale 1:${n} — ${changed} drawn room(s) re-measured from their own shapes ` +
      `(a rectangle from its box, a drawn shape from its ring).${keptNote}`
    : `Drawing scale set to 1:${n}. Rooms you draw are measured at this scale.${keptNote}`, 'plan');
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

/** Put the plan panel back to its empty (no drawing) state and forget the stored drawing, so a reload
 *  cannot bring back a sheet the table no longer describes. Called by Clear all rooms. Idempotent and
 *  safe when no drawing is open. */
async function unloadPlan() {
  planClearPreview();
  if (plan.overlay) { try { plan.overlay.destroy(); } catch (err) { /* ignore */ } }
  if (plan.viewer) { try { plan.viewer.destroy(); } catch (err) { /* ignore */ } }
  plan.overlay = null;
  plan.viewer = null;
  plan.bytes = null;
  plan.traceBytes = null;
  plan.stored = false;
  plan.loaded = false;
  plan.page = 1;
  plan.pages = 1;
  plan.revealed = false;
  pendingShape = null;
  lastFill = null;                 // the fill's Undo belonged to the drawing that is going away
  if (el.planPage) el.planPage.textContent = '1';
  if (el.planPages) el.planPages.textContent = '1';
  if (el.planCard) el.planCard.classList.add('hidden');   // the panel's empty/upload state
  if (typeof planTraceBusy === 'function') planTraceBusy(false);   // fill/undo/trace back to their empty state
  // With no drawing there is nothing to fill or trace: leave those buttons off rather than enabled-but-inert.
  if (el.planFillAreas) el.planFillAreas.disabled = true;
  if (el.planFillUndo) el.planFillUndo.disabled = true;
  // Drop the copy this browser kept, so a reload cannot restore a drawing that no longer matches the
  // (now empty) table. Never fatal: a browser without IndexedDB costs nothing here.
  try {
    const mod = await import('./drawstore.js');
    await mod.clearDrawing();
  } catch (err) { /* nothing stored, or no store */ }
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
    setStatus('warn', `Could not show page ${target} (${(err && err.message) || err}).`, 'plan');
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
    setStatus('warn', `Could not zoom (${(err && err.message) || err}).`, 'plan');
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
    setStatus('warn', `Could not fit the drawing (${(err && err.message) || err}).`, 'plan');
  }
}

function planSetMode(mode) {
  // Two modes only: 'shape' (the drawing tool, default) and 'select' (Select / edit). The retired
  // 'draw' mode — and anything else a saved project might carry — migrates silently to 'shape'.
  state.ui.planMode = normalizePlanMode(mode);
  // keep the radio buttons in step with the state: the mode can also be changed from code (a closed
  // shape hands over to Select / edit), and a stale radio would then swallow the next click on it.
  if (el.planModeShape) el.planModeShape.checked = state.ui.planMode === 'shape';
  if (el.planModeSelect) el.planModeSelect.checked = state.ui.planMode === 'select';
  if (plan.overlay) { plan.overlay.setMode(state.ui.planMode); plan.overlay.render(); }
  planSync();
  saveSoon();
}

/* ---- one drawing tool, two gestures (the merged 'Draw shape') ------------------------------------
 * The retired 'Draw room' mode (a bare press-move-release = a rectangle) is folded into 'Draw shape'.
 * The overlay still owns the polygon gestures (a click adds a corner; close on the first corner /
 * double-click / Enter; Backspace; Escape). The app adds the DRAG gesture on top.
 *
 * The overlay's <svg> is a descendant of #planView, so a capture-phase listener on #planView sees
 * every pointer event BEFORE the overlay's own listeners. That is what lets a drag be recognised and
 * taken over before it can leave a stray corner behind:
 *
 *   • a press-and-release that never leaves PLAN_DRAG_PX is left entirely to the overlay — a click,
 *     which adds one polygon corner exactly as before;
 *   • once the pointer travels further than that, the gesture is a RECTANGLE. The overlay's
 *     in-progress shape draft is dropped (setMode('shape') cancels it), the overlay is stopped from
 *     seeing this and every later move, and the app rubber-bands the box itself;
 *   • on release the finished rectangle goes to planDrawRoom() — the very path the old Draw room mode
 *     used, so the room, its area, its table row and the load are all unchanged.
 */
const PLAN_DRAG_PX = 6;      // a press that travels beyond this (view px) is a drag, not a click
// At 1:20/1:50 a 3×3 pt rectangle rounds to 0.00 m². Such a rectangle is not a room: it would add a
// junk zero row (and a bogus outline), so it is refused with a status message instead.
const MIN_ROOM_AREA_M2 = 0.01;
let planGesture = null;      // { startView, startPdf, page, drag, pointerId, droppedDraft }
let planSpaceHeld = false;   // Space is the pan modifier, exactly as it is in the overlay

function planGestureSpaceKey(e) {
  return e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
}

// The same text-entry rule js/overlay.js uses (isTextEntry): Space must never start a pan, and must
// never let the overlay start a polygon, while the user is typing — including while typing in the
// room-name box. Holding Space there used to set the pan flag and made the app skip the gesture while
// the overlay still started a polygon, so the two disagreed about the same keystroke.
const PLAN_TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number',
  'date', 'datetime-local', 'month', 'week', 'time',
]);
function planIsTextEntry(node) {
  if (!node || node === document) return false;
  const tag = String(node.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (node.isContentEditable === true) return true;
  if (tag !== 'INPUT') return false;
  return PLAN_TEXT_INPUT_TYPES.has(String(node.getAttribute('type') || 'text').toLowerCase());
}

function planGestureViewport() {
  const vp = plan.viewer && typeof plan.viewer.getViewport === 'function' ? plan.viewer.getViewport() : null;
  return vp && typeof vp.convertToPdfPoint === 'function' ? vp : null;
}

function planGesturePoint(e) {
  const svg = plan.overlay && plan.overlay.el;
  if (!svg) return null;
  const r = svg.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** The rubber band + the live size/area readout, drawn straight onto the overlay <svg> (the overlay's
 *  own render() only replaces its <g> children, so these survive it). Mirrors what Draw room showed. */
function planShowPreview(rect) {
  planClearPreview();
  const vp = planGestureViewport();
  const svg = plan.overlay && plan.overlay.el;
  if (!vp || !svg) return;
  const box = rectToViewBox(vp, rect);
  const band = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  band.setAttribute('class', 'plan-draft-box');
  band.setAttribute('x', box.x);
  band.setAttribute('y', box.y);
  band.setAttribute('width', box.w);
  band.setAttribute('height', box.h);
  band.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(band);

  const denom = planScaleDenom();
  const mPerPt = Math.sqrt(areaFromRect({ x: 0, y: 0, w: 1, h: 1 }, denom));
  const area = areaFromRect(rect, denom);
  const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t.setAttribute('class', 'plan-overlay-readout');
  t.setAttribute('text-anchor', 'start');
  t.setAttribute('data-area-m2', String(Math.round(area * 100) / 100));
  t.textContent = `${(rect.w * mPerPt).toFixed(2)} × ${(rect.h * mPerPt).toFixed(2)} m · ${area.toFixed(2)} m²`;
  const w = Number(svg.getAttribute('width')) || 0;
  const h = Number(svg.getAttribute('height')) || 0;
  t.setAttribute('x', String(Math.max(2, Math.min(box.x + box.w + 12, w - 4))));
  t.setAttribute('y', String(Math.max(14, Math.min(box.y + box.h + 20, h - 4))));
  svg.appendChild(t);
  plan.preview = [band, t];
}

function planClearPreview() {
  if (!plan.preview) return;
  for (const node of plan.preview) if (node.parentNode) node.parentNode.removeChild(node);
  plan.preview = null;
}

function planGestureDown(e) {
  if (plan.unavailable || !plan.overlay) return;
  if (state.ui.planMode !== 'shape') return;
  if (planGesture) return;    // a press is already in flight: a second finger must not restart it
  if (e.pointerType === 'mouse' && e.button !== 0) return;   // middle-drag pans, owned by the overlay
  if (planSpaceHeld) return;                                 // Space + drag pans, owned by the overlay
  const vp = planGestureViewport();
  const p = planGesturePoint(e);
  if (!vp || !p) return;
  // Deliberately NOT stopped: the overlay still needs the press for the click (polygon) gesture.
  // Pointer capture is NOT taken here: capturing on the press would retarget the pointerup to
  // #planView and the overlay (a CHILD of it) would never see the click, so every polygon vertex
  // would be lost. Capture is taken the moment the press becomes a DRAG instead (see planGestureMove).
  // `draftBefore`: whether a polygon was ALREADY in progress when this press landed. This handler is
  // a CAPTURE-phase listener on an ancestor of the overlay, so it runs BEFORE the overlay's own
  // pointerdown — which starts a 1-vertex draft on EVERY press in Draw shape mode. Reading hasDraft()
  // here, and not later in the move, is what tells a real multi-corner shape from the throwaway
  // 1-vertex draft this very press just created.
  planGesture = {
    startView: p, startPdf: viewPointToPdf(vp, p), page: plan.page || 1,
    drag: false, pointerId: e.pointerId,
    draftBefore: !!(plan.overlay && typeof plan.overlay.hasDraft === 'function' && plan.overlay.hasDraft()),
  };
}

/** Release the pointer captured when the press became a drag (idempotent; safe with no capture). */
function planReleaseCapture(id) {
  try { el.planView.releasePointerCapture(id); } catch (err) { /* never captured, or already gone */ }
}

function planGestureMove(e) {
  const g = planGesture;
  if (!g) return;
  // A SECOND finger (or pen) must not corrupt the rectangle: only the pointer that started the
  // gesture may move it.
  if (e.pointerId !== g.pointerId) return;
  // No button (or contact) is down any more: this is a stale gesture whose pointerup was missed,
  // not a drag. Ignoring it stops a phantom rubber band following later hovers.
  if (e.buttons === 0) return;
  const p = planGesturePoint(e);
  if (!p) return;
  if (!g.drag) {
    const far = Math.max(Math.abs(p.x - g.startView.x), Math.abs(p.y - g.startView.y));
    if (far <= PLAN_DRAG_PX) return;   // still a click: leave it to the overlay
    // A drag: it is a RECTANGLE. Drop the corner the overlay just placed at the press, take the
    // gesture over (so the overlay sees no more of it), and rubber-band the box ourselves.
    g.drag = true;
    // Switching the overlay's mode discards EVERY vertex of a polygon the user was drawing, so note
    // whether a real polygon was already in progress before the mode change wipes it, and warn when
    // the drag finishes. `draftBefore` (read at the press, before the overlay's own startShape) tells
    // a real shape from the throwaway 1-vertex draft every press in Draw shape mode creates.
    g.droppedDraft = !!g.draftBefore;
    if (typeof plan.overlay.setMode === 'function') plan.overlay.setMode('shape');
    // NOW capture the pointer. A drag that leaves the plan area would otherwise never deliver its
    // pointerup here: the rubber band would freeze, the gesture would never clear, and every later
    // hover would draw a phantom band. Capture is taken only once the press is a DRAG, so a plain
    // click still reaches the overlay and polygon drawing is unaffected. Best effort: a browser
    // without pointer capture keeps the old behaviour.
    try { el.planView.setPointerCapture(g.pointerId); } catch (err) { /* no capture available */ }
    e.stopPropagation();
  } else {
    e.stopPropagation();
  }
  const vp = planGestureViewport();
  if (!vp) return;
  planShowPreview(normalizeRect(g.startPdf, viewPointToPdf(vp, p)));
}

function planGestureUp(e) {
  const g = planGesture;
  if (!g) return;
  if (e.pointerId !== g.pointerId) return;   // another pointer lifting must not end this gesture
  planGesture = null;
  planReleaseCapture(e.pointerId);
  if (!g.drag) return;   // a click: the overlay has already turned it into a polygon corner
  e.stopPropagation();
  planClearPreview();
  const vp = planGestureViewport();
  const p = planGesturePoint(e);
  if (!vp || !p) return;
  const denom = planScaleDenom();
  const rect = normalizeRect(g.startPdf, viewPointToPdf(vp, p));
  const replaced = g.droppedDraft
    ? 'That drag replaced the shape you were drawing — its corners were dropped. '
    : '';
  if (rectIsUsable(rect) && areaFromRect(rect, denom) >= MIN_ROOM_AREA_M2) {
    planDrawRoom({ ...rect, page: g.page }, { page: g.page });
    if (replaced) setStatus('warn', replaced + 'A small rectangle was added in its place.', 'plan');
    return;
  }
  // Too small to be a room at this scale: say so rather than discarding silently (it would have
  // added a junk 0.00 m² row), and always say so when the drag also threw away a drawn shape.
  setStatus('warn', replaced +
    `That drag was too small to make a room (under ${MIN_ROOM_AREA_M2} m² at 1:${denom}). Nothing was added.`, 'plan');
}

function planGestureCancel(e) {
  if (planGesture && e && typeof e.pointerId === 'number' && e.pointerId !== planGesture.pointerId) return;
  if (planGesture) planReleaseCapture(planGesture.pointerId);
  planGesture = null;
  planClearPreview();
}

/** The merged drawing gestures. Wired once, with the rest of the plan panel. */
function planWireGestures() {
  if (!el.planView) return;
  // capture:true — #planView is an ANCESTOR of the overlay <svg>, so these run before the overlay's
  // own handlers and can decide whether the press is a click (polygon) or a drag (rectangle).
  el.planView.addEventListener('pointerdown', planGestureDown, true);
  el.planView.addEventListener('pointermove', planGestureMove, true);
  el.planView.addEventListener('pointerup', planGestureUp, true);
  el.planView.addEventListener('pointercancel', planGestureCancel, true);
  // The overlay adds a corner on its own pointerdown and takes one back on Backspace, and in shape mode
  // it reports NOTHING to the app — so without these two listeners the corner count on screen would
  // stay stale and the shape would look like it was never started. Bubble phase: the overlay's own
  // handlers have already run by the time these fire.
  el.planView.addEventListener('click', () => { if (plan.overlay && plan.overlay.hasDraft && plan.overlay.hasDraft()) planSync(); });
  window.addEventListener('keyup', (e) => {
    if ((e.key === 'Backspace' || e.key === 'Escape')
        && plan.overlay && plan.overlay.hasDraft && plan.overlay.hasDraft()) planSync();
  });
  window.addEventListener('keydown', (e) => {
    // Space is the pan modifier — but never while the user is typing (the room-name box, a table
    // cell). Without this guard, holding Space to type a space set the pan flag, so the app skipped
    // the press while the overlay still started a polygon: the two disagreed about one keystroke.
    if (planGestureSpaceKey(e) && !planIsTextEntry(document.activeElement) && !planIsTextEntry(e.target)) {
      planSpaceHeld = true;
    }
    if (e.key === 'Escape' && planGesture) planGestureCancel();
  });
  window.addEventListener('keyup', (e) => { if (planGestureSpaceKey(e)) planSpaceHeld = false; });
  window.addEventListener('blur', () => { planSpaceHeld = false; });
}

function planWire() {
  if (plan.wired) return;
  plan.wired = true;
  if (el.planScale) {
    planRenderScaleOptions();
    el.planScale.addEventListener('change', () => {
      const opt = el.planScale.options[el.planScale.selectedIndex];
      // The `Custom…` sentinel asks for a denominator; it is never applied as a scale itself.
      if (opt && opt.value === CUSTOM_SCALE_VALUE) { planAskCustomScale(); return; }
      const fromDrawing = !!(opt && opt.dataset && opt.dataset.fromDrawing);
      planApplyScale(el.planScale.value);
      // Choosing the scale the outlines imply re-runs the trace straight away — that is the whole point
      // of offering it. Any other scale change keeps its old behaviour exactly. Either way the old
      // one-click fix is stale now, so it goes.
      if (fromDrawing) planTraceOutlines(); else planHideScaleFix();
    });
  }
  if (el.planPrev) el.planPrev.addEventListener('click', () => planGoTo(plan.page - 1));
  if (el.planNext) el.planNext.addEventListener('click', () => planGoTo(plan.page + 1));
  if (el.planZoomIn) el.planZoomIn.addEventListener('click', () => planZoomBy(1.25));
  if (el.planZoomOut) el.planZoomOut.addEventListener('click', () => planZoomBy(1 / 1.25));
  if (el.planFit) el.planFit.addEventListener('click', planFitWidth);
  if (el.planModeShape) el.planModeShape.addEventListener('change', () => planSetMode('shape'));
  if (el.planModeSelect) el.planModeSelect.addEventListener('change', () => planSetMode('select'));
  if (el.planShapeAssignGo) el.planShapeAssignGo.addEventListener('click', () => {
    planCommitShape(el.planShapeAssignRoom ? el.planShapeAssignRoom.value : '');
  });
  if (el.planShapeAssignClose) el.planShapeAssignClose.addEventListener('click', () => planCommitShape(null));
  if (el.planPlaceAll) el.planPlaceAll.addEventListener('click', planPlaceAllRooms);
  if (el.planPlaceClear) el.planPlaceClear.addEventListener('click', planClearPlaced);
  if (el.planTraceOutlines) el.planTraceOutlines.addEventListener('click', planTraceOutlines);
  if (el.planTraceClear) el.planTraceClear.addEventListener('click', planTraceClear);
  if (el.planFillAreas) el.planFillAreas.addEventListener('click', planFillAreas);
  if (el.planFillUndo) el.planFillUndo.addEventListener('click', planUndoFill);
  planWireGestures();
}

/** Open a drawing in the plan panel. Safe to call for every upload: the panel is an enhancement. */
async function openPlan(bytes, opts) {
  if (!bytes || !el.planCard) return;
  const o = opts || {};
  // Give this drawing an identity BEFORE anything can detach or copy the bytes: every shape measured
  // from it is tagged with it, and the overlay paints only shapes that match the drawing now loaded.
  plan.drawingId = drawingIdentity(bytes);
  plan.loaded = false;               // until the viewer has really shown it (set at the end of the try)
  scaleFixUsedDrawing = undefined;   // a different drawing has its own one-click scale fix
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
        getDrawingId: () => plan.drawingId,
        getMode: () => state.ui.planMode,
        getAreaText: planRoomAreaText,   // the on-drawing area chip (formatted here, not in the overlay)
        onDraw: planDrawRoom,
        onDrawShape: planDrawShape,
        onSelect: planSelectRoom,
        onRoomMoved: planRoomMoved,
        onRoomMoveEnd: planRoomMoveEnd,
        onDelete: planDeleteRoom,
      });
      if (plan.overlay.setMode) planSetMode(state.ui.planMode);   // also syncs the mode radios
  if (el.planLinkMove) {
    el.planLinkMove.addEventListener('click', () => {
      if (el.planLinkTarget && el.planLinkTarget.value) planMoveShapeTo(state.ui.openId, el.planLinkTarget.value);
    });
  }
  if (el.planLinkDetach) {
    el.planLinkDetach.addEventListener('click', () => planDetachShape(state.ui.openId));
  }
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
    plan.loaded = true;   // on screen now — the auto-setup waits for this AND for the rooms to exist
    if (keep) storeDrawing(keep, o.name);
    // A drawing just loaded: if rooms still carry shapes measured on an EARLIER drawing, say so (with
    // the count) and keep the one-click removal control in step. A restore of the SAME drawing finds
    // no stale shapes, so nothing is said and nothing changes.
    planAnnounceStaleShapes();
    // bring the drawing into view the first time one loads: the panel is below the upload box, and
    // 'nearest' only scrolls when it is actually off-screen, so it never yanks a visible page around.
    // Never on a restore: reloading a page should leave the reader where they are.
    if (!plan.revealed && !o.restoring) {
      plan.revealed = true;
      try { el.planCard.scrollIntoView({ block: 'nearest' }); } catch (err) { /* older browsers */ }
    }
    // The drawing is up: place its rooms and trace their outlines by itself, if the rooms are here and
    // the drawing does not already carry geometry (a re-load or a restored project is left alone).
    maybeAutoSetupPlan();
  } catch (err) {
    // Say it out loud as well as on screen: a silent catch here once hid a broken plan view, and
    // the message was then overwritten by the next status update from the parse.
    console.warn('[plan] could not open the drawing:', (err && err.message) || err);
    setStatus('warn', `The drawing could not be shown in the plan view (${(err && err.message) || err}). ` +
      `The rooms, the table and the load are unaffected.`, 'plan');
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
  track('export_csv');
  exportedThisLoad = true;   // the furthest stage for the left_page signal
  setStatus('ok', 'CSV downloaded.');
}

/** The tool's own address, shown once in the report foot and in the CSV, and copied by the share
 *  button so a user can hand the calculator to a colleague in one click. */
const LOADLENS_URL = 'https://loadlens.net/';

/** Copy LOADLENS_URL to the clipboard. Plain words, no pop-ups: the confirmation and the failure
 *  both go through the normal status line, so the app's behaviour is unchanged where they are not
 *  wanted. If clipboard access is unavailable or refused (older browser, denied permission) it
 *  degrades quietly to a warning that names the address instead of throwing. */
function copyLoadLensLink() {
  const done = () => { track('share_link_copied'); setStatus('ok', 'LoadLens link copied. Paste it to a colleague who needs a quick load check.'); };
  const fail = () => setStatus('warn', `Could not copy automatically. The address is ${LOADLENS_URL} — type it in the address bar or copy it from there.`);
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(LOADLENS_URL).then(done).catch(fail);
    } else {
      fail();
    }
  } catch (e) {
    fail();
  }
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
    track('report_opened');
    exportedThisLoad = true;   // the furthest stage for the left_page signal
    setTimeout(() => { try { w.focus(); w.print(); } catch (e) { /* the user can press the button */ } }, 500);
    setStatus('ok', 'Report opened in a new window.');
    return;
  }
  frame.setAttribute('srcdoc', html);
  view.classList.remove('hidden');
  document.body.classList.add('reporting');
  el.reportClose.focus();
  track('report_opened');
  exportedThisLoad = true;   // the furthest stage for the left_page signal
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
      clearDeleteUndo();
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
    // A blank numeric field silently uses the default (readProjectInput writes DEFAULT_PROJECT[key]),
    // so show that default as the placeholder: the user can see the value the engine is using instead
    // of an empty box that hides it.
    if (kind === 'num' && Number.isFinite(DEFAULT_PROJECT[key])) input.placeholder = String(DEFAULT_PROJECT[key]);
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

  // The results system: two plain choices in a radio group (keyboard reachable with the arrow keys).
  // Clicking either is an EXPLICIT choice, which from then on wins over what a sheet is detected to be.
  const onUnitsChoice = () => setUnits(el.unitsIp && el.unitsIp.checked ? 'ip' : 'si', { explicit: true });
  if (el.unitsSi) el.unitsSi.addEventListener('change', onUnitsChoice);
  if (el.unitsIp) el.unitsIp.addEventListener('change', onUnitsChoice);

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

  $('#btnSample').addEventListener('click', () => loadSample());
    if ($('#btnSampleHouse')) $('#btnSampleHouse').addEventListener('click', () => loadSample('house'));

    // Quick start strip: upload opens the EXISTING #fileInput (never a second one), and the two sample
    // buttons just press the existing #btnSample / #btnSampleHouse, so the ?sample= hooks and the
    // auto-fill are completely unchanged. The strip itself is hidden/shown by renderTable().
    {
      const qsUpload = $('#qsUpload');
      if (qsUpload) qsUpload.addEventListener('click', () => el.fileInput.click());
      const qsSample = $('#qsSample');
      if (qsSample) qsSample.addEventListener('click', () => $('#btnSample').click());
      const qsHouse = $('#qsHouse');
      if (qsHouse) qsHouse.addEventListener('click', () => { const b = $('#btnSampleHouse'); if (b) b.click(); });
    }

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
    if (!window.confirm(`Delete all ${state.rooms.length} room(s) and unload the drawing? This cannot be undone.`)) return;
    state.rooms = [];
        state.warnings = [];
    clearDeleteUndo();
        renderWarnings();
    closeDetail();
    renderAll();
    unloadPlan();          // also drop the drawing, hide the plan panel, and forget the stored copy
    saveNow();
    setStatus('ok', 'All rooms cleared. The drawing was unloaded and will not come back on a reload.');
  });

  // table
  el.roomsBody.addEventListener('input', onTableInput);
  el.roomsBody.addEventListener('change', onTableInput);
  el.roomsBody.addEventListener('click', onTableClick);
  el.roomsTable.querySelector('thead').addEventListener('click', onHeaderClick);

  // one-step undo for a deleted room: create/reflect the button beside Add/Clear (app.html untouched)
  updateUndoDeleteButton();

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

  // The plan toast is fixed; keep it clear of the drawing as the page scrolls or the window resizes.
  window.addEventListener('scroll', () => { placePlanStatus(); placePlanProgress(); }, { passive: true });
  window.addEventListener('resize', () => { placePlanStatus(); placePlanProgress(); });

  // export / import
  $('#btnCsv').addEventListener('click', exportCsv);
  $('#btnCsv2').addEventListener('click', exportCsv);
  $('#btnPrint').addEventListener('click', printReport);
  $('#btnPrint2').addEventListener('click', printReport);
  if (el.reportPrint) el.reportPrint.addEventListener('click', printReportFrame);
  if (el.reportClose) el.reportClose.addEventListener('click', () => { closeReport(); });
  $('#btnSave').addEventListener('click', saveProjectFile);
  $('#btnOpen').addEventListener('click', () => el.jsonInput.click());

  // One quiet way to hand the tool to a colleague. Built here rather than in the HTML so the share
  // control sits with the export buttons without a page change; the same address is printed in every
  // report foot and CSV, so a forwarded file carries it too.
  {
    const anchor = $('#btnPrint2');
    if (anchor && anchor.parentNode) {
      const shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.id = 'btnShare';
      shareBtn.className = 'btn btn-ghost';
      shareBtn.textContent = 'Copy link to LoadLens';
      shareBtn.title = `Copies ${LOADLENS_URL} to the clipboard so you can paste it to a colleague`;
      shareBtn.addEventListener('click', copyLoadLensLink);
      anchor.parentNode.insertBefore(shareBtn, anchor.nextSibling);
    }
  }

  el.jsonInput.addEventListener('change', () => {
    if (el.jsonInput.files && el.jsonInput.files[0]) openProjectFile(el.jsonInput.files[0]);
    el.jsonInput.value = '';
  });

  // Escape backs out one layer at a time: an in-progress drawn shape (left to the overlay, which owns
  // it — do NOT also close the breakdown under it), a shape waiting for the chooser (kept as a new
  // room, the tool's normal behaviour), the report if it is open, otherwise the room breakdown.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (plan.overlay && typeof plan.overlay.hasDraft === 'function' && plan.overlay.hasDraft()) return;
    if (pendingShape) { planCommitShape(null); return; }
    if (closeReport()) return;
    closeDetail();
  });
}

/* ------------------------------------------------------------------ */
/* start                                                              */
/* ------------------------------------------------------------------ */

/* A landing-page link can name the sample it wants (?sample=house). The whole point is that the
 * visitor's first sight is a REAL number, not an empty calculator they must find a button in - the
 * measured bounce here was 13 arrivals on the landing page and 1 reaching the calculator.
 * Guarded three ways so it can never eat a returning visitor's own work: only when the URL names a
 * sample, only when nothing was restored, and only when this browser kept no drawing of its own. */
/* What the plan panel should show on arrival - ONE decision, made once.
 *
 * A landing-page link can ask to be landed on a worked example (`?go=1`), because the measured bounce
 * here was 13 arrivals on the landing page to 1 reaching the calculator: an empty calculator that
 * asks the visitor to find a button is where they left.
 *
 * This is deliberately a SINGLE async decision rather than two independent ones. Restoring a stored
 * drawing and loading a sample are both "open a plan" paths; when they ran separately at boot they
 * raced, and the panel ended up showing a restored drawing while the sample's credit line was on
 * screen (measured in the suite: 159 rooms of the fixture, 363.86 TR, named as LEVEL 11).
 *
 * Precedence, and the reasons:
 *   1. work saved in this browser WINS - a returning visitor must never have it replaced by a sample;
 *   2. otherwise an explicit ?go=1 loads that sample (or the default real sheet);
 *   3. otherwise nothing here - a plain visit stays an empty calculator.
 * A bare ?sample= never triggers this: those are the suites' hooks and load only when asked. */
async function bootPlan() {
  if (!el.planCard) return;
  let params = null;
  try { params = new URLSearchParams(location.search); } catch (err) { params = null; }
  const wantsExample = !!params && params.get('go') === '1';

  let stored = null;
  try {
    const mod = await import('./drawstore.js');
    stored = await mod.getDrawing();
  } catch (err) { stored = null; }   // no drawstore: treat as nothing saved

  if (stored) { await restoreDrawing(); return; }          // (1) the visitor's own drawing
  if (wantsExample && !state.rooms.length) {               // (2) the landing page's worked example
    loadSample(params.get('sample') || undefined);
    return;
  }
  // (3) a plain first visit: leave the empty calculator alone
}

function start() {
  initErrorTracking();     // catch anything the startup below throws (coarse area only)
  initDropoffTracking();   // the one left_page signal, on the way out
  track('app_open');   // once per page load — the calculator was opened
  fillCountrySelect();
  const restored = loadStored();
  hadStoredProject = restored;
  syncProjectInputs();
  wire();
  renderAll();
  updateParseWhere(); // the browser text until the one-time check answers
  probeServer();      // asks the server if it is there; never blocks the page
  bootPlan();         // either the drawing this browser kept for us, or the landing page's worked example
  autoDetectClimate(); // one free IP lookup -> the editable table -> pre-fill, if it is a first visit

  if (restored && state.rooms.length) {
    setStatus('ok', `Restored your last work from this browser: ${state.rooms.length} room(s).`);
  } else {
    setStatus(null);
  }
}

start();

/* keep a couple of internals reachable for quick console debugging */
window.webhvac = { state, currentCalc, renderAll, addRooms, buildReportHtml, toCsv, calcRoom, normalizeRoom, planMoveShapeTo, planDetachShape, planPlaceAllRooms, planClearPlaced, planTraceOutlines, planTraceClear, planFillAreas, planUndoFill, plan, planDrawShape, planCommitShape, planShowShapeChooser, setUnits, detectUnits: (...a) => detectUnits(...a), planAutoSetup, maybeAutoSetupPlan, roomsHavePlanGeometry, planAutoSetupDone };

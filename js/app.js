// LoadLens — app state, room table, events, rendering.
// No frameworks, no build step. Plain ES modules.

import {
  COUNTRIES, CLIMATES, ORIENTS, SPACE_TYPES, DEFAULT_PROJECT,
  normalizeRoom, calcRoom, calcProject, guessSpaceType, NON_AC_WORDS,
} from './calc.js';
import { buildReportHtml, toCsv, fmt, groupByLevel, breakdown, esc, typeLabel, refusalHtml } from './report.js';
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
// The design basis: every figure the load depends on with its source, and the gate that refuses to
// total a load built on figures nobody has stood behind (js/basis.js).
import { BASIS_FIELDS, basisFromProject, basisGaps, basisStats, basisLine, confirmField, savedBasis,
  basisStatements, openStatements } from './basis.js';
import { monteCarlo } from './uncertainty.js';
import { crossCheck, peakLoadHour } from './crosscheck.js';
import { DESIGN_DAY_EPW } from './weather.js';
// The shared state + element refs now live in their own module (js/appstate.js). It calls BACK into
// the app for the few renderers it needs, so the app hands it those at boot — see wireAppstateHost.
import { wireHost as wireAppstateHost, pendingUndo, setPendingUndo, planStatusTimer, setPlanStatusTimer } from './appstate.js';
// The plan pane's module (js/plan.js) calls back for these; the app hands them over in start().
import { wireHost as wirePlanHost } from './plan.js';
// Anonymous usage counting (js/usage.js): a strict allowlist of real actions plus
// the utm_* campaign tags already in the URL. No cookies, no ids, no plan data —
// see the module header. Every call is a no-op if counting is unavailable.
import { track, bucketBytes, bucketPages, bucketRooms } from './usage.js';
import { $, MISSING_AUTOTRACE, MISSING_OCR, MISSING_SCALECAL, MISSING_SCHEDULE, MISSING_TRACE, NUM_FIELDS, OCR_VENDOR, PROJ_FIELDS, STORAGE_KEY, areaIsTyped, citiesOf, defaultText, download, el, idSeq, inferCountry, isPdfUpload, isPresetScale, joinWords, m2PerTr, mergeProject, normalizePlanMode, normalizeRoomName, plan, projInput, roomById, roomHasArea, roomHasShape, sameDrawingKey, saveNow, saveSoon, scrollRowIntoView, setStatus, shapeRing, shortReason, state, withSource } from './appstate.js';
import { largestRing, openPlan, pendingShape, planAutoSetup, planAutoSetupDone, planAutoSetupRunning, planClearPlaced, planCommitShape, planDetachShape, planDrawShape, planFillAreas, planFitShapeToWalls, planGesture, planMoveShapeTo, planPlaceAllRooms, planRenderGeometry, planRenderScaleOptions, planRevealRoom, planRoomMoveEnd, planScaleDenom, planSetupGen, planShowShapeChooser, planSyncFillButton, planTraceClear, planTraceOutlines, planUndoFill, unloadPlan } from './plan.js';

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

let scheduleMod = null, scheduleTried = false;
let ocrMod = null, ocrTried = false;
let traceMod = null, traceTried = false;
let autotraceMod = null, autotraceTried = false;
let scaleCalMod = null, scaleCalTried = false;

/** js/scalecal.js — pure maths: the drawing scale read OFF the sheet (scale note, printed areas,
 *  door-leaf arcs) instead of trusted from the panel. Loaded on demand; when it is missing the app
 *  simply keeps the manual dropdown's value. */
async function loadScaleCalModule() {
  if (!scaleCalMod && !scaleCalTried) {
    scaleCalTried = true;
    try { scaleCalMod = await import('./scalecal.js'); } catch (e) { scaleCalMod = null; }
  }
  if (!scaleCalMod || typeof scaleCalMod.calibrateScale !== 'function') throw new Error(MISSING_SCALECAL);
  return scaleCalMod;
}

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

let labelMod = null, labelTried = false;
/** js/labelclass.js — tells a ROOM NAME from an ANNOTATION LABEL inside a room (MONITOR, SEATING,
 *  IN/OUT, COMMISSIONERS' BENCH, WITNESS ...). Loaded on demand; a missing module returns null and the
 *  app behaves exactly as it did before. */
async function loadLabelModule() {
  if (!labelMod && !labelTried) {
    labelTried = true;
    try { labelMod = await import('./labelclass.js'); } catch (e) { labelMod = null; }
  }
  return labelMod;
}

/** Keep ANNOTATION LABELS out of the load.
 *
 *  26 of the sample's 56 detected names are labels, not rooms (MONITOR x7, SEATING x3, IN/OUT,
 *  ESCAPE ONLY, WITNESS, COUNSEL, COMMISSIONERS' BENCH, WHEELCHAIR BAY, PRESS/PUBLIC SEATING). On the
 *  owner's own run three of them were carrying real areas - "IN" 11.06 m2 and two "COMMISSIONERS'
 *  BENCH" 28.57 / 29.76 m2 - about 3.4 TR of a 20 TR load attributed to fittings instead of rooms.
 *
 *  js/labelclass.js decides with the region geometry the tracer already produced (never the name
 *  alone, so a real "WITNESS ROOM" of its own stays a room). This:
 *    - marks the row `subZone` so the table can say what it is;
 *    - takes back an area that CAME FROM THE DRAWING (a typed area is the user's and is left alone);
 *    - excludes it from the totals, so the load is over rooms only.
 *  Returns how many rows it changed, for the status line. Never throws. */
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
function showPlanStatus(kind, msg, hideAfterMs) {
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
    const hold = Number.isFinite(hideAfterMs) && hideAfterMs > 0 ? hideAfterMs : 10000;
    setPlanStatusTimer(setTimeout(hidePlanStatus, hold));
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
  if (!raw || !roomHasShape(raw)) return '';
  // A PLACED box is neither a drawn shape nor a traced outline: it is a locator the placement centred on
  // the point that names the room and sized back from the area the sheet printed, so say exactly that.
  if (!(Array.isArray(raw.poly) && raw.poly.length > 2)) {
    return "&middot; room box placed on the plan (sized back from the plan's stated area)";
  }
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
  // A leading "Choose a room…" row, deliberately with an empty value: the list used to start on the first
  // room ALPHABETICALLY, which reads as a suggestion ("Move it to ANNEXE · no area") and let a stray
  // press move a shape onto a room nobody picked. Empty value = neither Move handler will act.
  return `<option value="">Choose a room&hellip;</option>`
    + pickerRooms(raw)
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
  const hasShape = roomHasShape(raw);   // a traced outline OR a placed box - both are shapes on the sheet
  if (!hasShape) { el.planShapeLink.classList.add('hidden'); return; }
  const others = state.rooms.filter((x) => x.id !== raw.id);
  el.planShapeLinkName.textContent = shapeOwnerLabel(raw);
  el.planLinkTarget.innerHTML = others.length ? shapeTargetOptions(raw) : '<option value="">(no other room)</option>';
  el.planLinkTarget.disabled = !others.length;
  if (el.planLinkMove) el.planLinkMove.disabled = !others.length;
  el.planShapeLink.classList.remove('hidden');
}

function shapeLinkBlock(raw) {
  if (!raw || !roomHasShape(raw)) return '';
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
        <button type="button" class="btn btn-small" id="bdShapeFit">Bubble it out to the walls</button>
        <button type="button" class="btn btn-small btn-ghost" id="bdShapeDetach">Remove the shape from this row</button>
      </div>
      <p class="muted small">Moving the shape gives the other row this shape and its area, and the load
        changes with it. Removing it leaves this row with the area you can type yourself.
        <strong>Bubble it out</strong> floods the drawing from inside this outline until the walls stop
        it, and keeps the result as this room's shape and area — so you only have to draw the space
        roughly, and the drawing decides where its edges are.</p>
    </div>`;
}

/**
 * An OPEN AREA: the drawing does not draw this row's edge, so its whole measured area was given to ONE
 * name and the load counts it once (js/trace.js source 'open-area'). The names inside it are the rows it
 * could sensibly belong to, and moving it reuses the shape machinery (outline and area travel together,
 * so the total cannot change - only which row owns it).
 */
function openAreaBlock(raw) {
  if (!raw || !raw.openArea) return '';
  const inside = (raw.openArea.inside || []).filter((x) => x.id && x.id !== raw.id);
  const area = Number(raw.area) > 0 ? raw.area : Number(raw.openArea.areaM2) || 0;
  const head = `<div class="bd-link">
      <h3>Open area</h3>
      <p>This row holds a whole <strong>open area of ${fmt(area, 2)} m&sup2;</strong>. The plan does not
        draw its edge, so it could not be cut into rooms and the whole area went to this one name. It is
        counted <strong>once</strong> in the load.</p>`;
  if (!inside.length) {
    return head + `<p class="muted small">No other room name sits inside it, so there is nowhere to
      move it to.</p></div>`;
  }
  return head + `
      <div class="bd-link-controls">
        <label class="muted small" for="bdOpenAreaTarget">Give this area to</label>
        <select id="bdOpenAreaTarget">
          ${inside.map((x) => `<option value="${esc(x.id)}">${esc(x.name || 'room')} &mdash; inside this area${Number(x.areaM2) > 0 ? ` (${fmt(x.areaM2, 1)} m&sup2; of it)` : ''}</option>`).join('')}
          ${shapeTargetOptions(raw)}
        </select>
        <button type="button" class="btn btn-small" id="bdOpenAreaMove">Move the area</button>
      </div>
      <p class="muted small">The outline and the area move together, so the total load is unchanged &mdash;
        only which row owns it. Ctrl+Z puts it back.</p>
    </div>`;
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
  // `fitting` is set HERE, where the row is built: the toggle in updateLive() reads a field the
  // normalised room does not carry, and the row is usually built after the classifier has marked it, so
  // a fitting (MONITOR, SEATING, COMMISSIONERS' BENCH) came out looking like an ordinary room that
  // simply failed - the row never said what it really was.
  return `<tr data-idx="${idx}" data-id="${esc(raw.id)}" class="clickable${inc ? '' : ' excluded'}${raw.subZone ? ' fitting' : ''}">
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
  if (!state.ui.order.length) {
    // Rooms exist but the search box or the level filter hides every one of them: an empty table with no
    // words reads as a broken app (the only clue was the small "0 shown of 3 room(s)" line). Say what
    // happened and how to get back. Reported from real use.
    const n = state.rooms.length;
    el.roomsBody.innerHTML = '<tr class="rooms-none"><td class="l" colspan="99">' +
      `No rooms match the search or the level you set. Clear the search box, or set Level back to ` +
      `“All levels”, to see all ${n} room${n === 1 ? '' : 's'}.</td></tr>`;
  } else {
    el.roomsBody.innerHTML = state.ui.order.map((i) => rowHtml(i, calc)).join('');
  }

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
    // `subZone` lives on the RAW room: the normalised room the engine builds has no such field, so this
    // toggle never fired and a fitting came out looking like an ordinary room that simply failed
    // ("excluded"), which is exactly how MONITOR/BENCH/SEATING read as "no longer detected".
    tr.classList.toggle('fitting', !!(raw.subZone || r.room.subZone));   // styled and findable as a fitting, not a room
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


/* ------------------------------------------------------------------ */
/* THE DESIGN BASIS (js/basis.js) — what the load actually stands on   */
/* ------------------------------------------------------------------ */
// The engine multiplies areas by about twenty constants. Until now none of them said where it came
// from and the app totalled the load regardless. Now every one of them is an entry with a source, and
// the summary REFUSES TO TOTAL while a figure the result depends on is unconfirmed — because a number
// built on unconfirmed practice looks precise and means nothing. One click resolves the whole set, and
// the report then states exactly which figures are cited and which a human confirmed.

// The internal-gain and outdoor-air figures live per room TYPE in the engine (js/calc.js SPACE_TYPES),
// so they have no single project value to show: the row shows the office row as the reference and says
// the rest are per row in the table and the report.
const BASIS_PER_TYPE = new Set(['oap', 'oaa', 'light', 'equip', 'm2pp', 'ps', 'pl']);

/** The climate row the app used, with its provenance — a station row is sourced, an estimate is not. */
function basisClimate() {
  const row = state.project && state.project.city ? CLIMATES[state.project.city] : null;
  if (!row) return null;
  return {
    db: row.db, wb: row.wb, station: row.station || '', src: row.src || '',
    indicative: !!row.indicative, why: row.why || '',
  };
}

/** The basis as it stands now: values from the engine's own settings, statuses from what the user saved. */
function currentBasis() {
  if (!state.project.basis || typeof state.project.basis !== 'object') state.project.basis = {};
  // js/basis.js owns this merge: the panel, the totals and the printed report must never disagree.
  return savedBasis(state.project, basisClimate(), { perType: BASIS_PER_TYPE });
}

function basisGate() {
  const b = currentBasis();
  return { ok: basisStats(b).complete, gaps: basisGaps(b), stats: basisStats(b), basis: b };
}

const BASIS_STATE_LABEL = {
  cited: 'from a published source', confirmed: 'confirmed', typed: 'hand-entered',
  unconfirmed: 'unconfirmed', missing: 'no value',
};

function basisRowHtml(f, e, gap, stats) {
  const perType = BASIS_PER_TYPE.has(f.id);
  let valueText;
  if (perType) {
    const ref = SPACE_TYPES.office || {};
    valueText = `office: ${fmtValue(ref[f.id] != null ? ref[f.id] : 0, 2)} ${esc(f.unit)} <span class="basis-sub">per room type</span>`;
  } else if (e.value == null) {
    valueText = '<span class="basis-sub">not set</span>';
  } else {
    valueText = `${fmtValue(e.value, 2)} ${esc(f.unit)}`;
  }
  // A value above the code's own limit is the one thing this panel must shout about.
  const over = !perType && f.limit && e.value != null && Number(e.value) > Number(f.limit.value)
    ? `<span class="pill pill-warn" title="${esc(f.limit.cite)}">above ${f.limit.value} ${esc(f.unit)}</span>` : '';
  const state = gap ? (e.status === 'missing' ? 'missing' : 'unconfirmed') : e.status;
  const pill = `<span class="pill pill-${state}" title="${esc(e.note || '')}">${esc(BASIS_STATE_LABEL[state] || state)}</span>`;
  const btn = (e.status === 'confirmed') ? ''
    : `<button type="button" class="btn btn-small btn-ghost" data-basis-confirm="${esc(f.id)}">Confirm</button>`;
  return `<div class="basis-row${gap ? ' is-gap' : ''}" data-basis="${esc(f.id)}">
      <div class="basis-main"><span class="basis-label">${esc(f.label)}</span><span class="basis-value">${valueText}${over}</span></div>
      <div class="basis-src">${e.cite ? esc(e.cite) : (f.cite ? esc(f.cite) : '')}</div>
      <div class="basis-actions">${pill}${btn}</div>
    </div>`;
}

/** What the user is asked to stand behind: a sentence per subject, not a number per constant. */
function statementHtml(st) {
  const ref = SPACE_TYPES.office || {};
  const vals = st.fields.map((f) => {
    const e = f.entry;
    const unit = f.def ? esc(f.def.unit || '') : '';
    // A figure that lives per room type has no single value; show the office row, which is what the
    // reader will recognise, and say it is the reference.
    const v = BASIS_PER_TYPE.has(f.id)
      ? `${fmtValue(ref[f.id] != null ? ref[f.id] : 0, 2)} ${unit} <span class="basis-sub">office; varies by use</span>`
      : (e.value == null ? '<em>not set</em>' : `${fmtValue(e.value, 2)} ${unit}`);
    return `<span class="basis-kv"><b>${esc(f.def ? f.def.label : f.id)}</b> ${v}</span>`;
  }).join('');
  const pill = st.settled
    ? '<span class="pill pill-confirmed">settled</span>'
    : `<span class="pill pill-unconfirmed">needs your OK${st.needs.length > 1 ? ` (${st.needs.length} figures)` : ''}</span>`;
  const btn = st.settled ? ''
    : `<button type="button" class="btn btn-small" data-basis-accept="${esc(st.id)}">These are right</button>`;
  return `<div class="basis-statement${st.settled ? ' is-ok' : ''}" data-statement="${esc(st.id)}">
      <div class="basis-statement-head"><h4>${esc(st.label)}</h4>${pill}</div>
      <p>${esc(st.plain)}</p>
      <div class="basis-values">${vals}</div>
      <div class="basis-statement-actions">${btn}</div>
    </div>`;
}

function wireBasisAcceptButtons(root) {
  root.querySelectorAll('button[data-basis-accept]').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => confirmStatement(btn.getAttribute('data-basis-accept')));
  });
}

/** One statement accepted = the figures behind it confirmed, in one write and one record. */
function confirmStatement(id) {
  const b = currentBasis();
  const st = basisStatements(b).find((x) => x.id === id);
  if (!st || !st.needs.length) return;
  for (const fid of st.needs) {
    const e = b.entries[fid];
    if (!e) continue;
    state.project.basis[fid] = {
      status: 'confirmed', confirmedAt: basisWhen(), value: e.value,
      note: `Confirmed as-is by ${basisWho()} on ${basisWhen()}.`,
    };
  }
  saveSoon();
  afterProjectChange();
  setStatus('ok', `Accepted: ${st.label.toLowerCase()}.`);
}

function renderBasisPanel() {
  const wrap = document.getElementById('basisRows');
  if (!wrap) return;
  const b = currentBasis();
  const s = basisStats(b);
  const gaps = basisGaps(b);
  const sts = basisStatements(b);
  const open = sts.filter((x) => !x.settled);
  const grade = document.getElementById('basisGrade');
  if (grade) {
    grade.textContent = s.complete
      ? `complete — ${s.cited} from a standard, ${s.confirmed} confirmed by you, ${s.typed} hand-entered`
      : `needs your OK — ${open.length} of ${sts.length}`;
    grade.className = `basis-grade ${s.complete ? 'is-ok' : 'is-bad'}`;
  }
  const sumLine = document.getElementById('basisSummaryLine');
  if (sumLine) {
    sumLine.textContent = s.complete ? '(all settled — the load is totalled)' : '(what this load stands on)';
  }
  const hint = document.getElementById('basisHint');
  if (hint) {
    hint.textContent = s.complete
      ? basisLine(b) + ' The load is shown and can be printed.'
      : 'Six sentences, not twenty-one constants. Accept the ones you can answer and the load is totalled. ' +
        'Every figure behind them is listed underneath with where it came from, and the printable report ' +
        'prints all of it.';
  }
  const groups = document.getElementById('basisGroups');
  if (groups) {
    groups.innerHTML = sts.map(statementHtml).join('');
    wireBasisAcceptButtons(groups);
  }
  let html = '', group = '';
  for (const f of BASIS_FIELDS) {
    if (f.group !== group) { group = f.group; html += `<h4 class="basis-group">${esc(group)}</h4>`; }
    html += basisRowHtml(f, b.entries[f.id], gaps.find((g) => g.id === f.id), s);
  }
  wrap.innerHTML = html;
  wireBasisConfirmButton(wrap);
  const all = document.getElementById('btnBasisConfirmAll');
  if (all && !all.dataset.wired) {
    all.dataset.wired = '1';
    all.addEventListener('click', confirmAllPractice);
  }
}

function wireBasisConfirmButton(root) {
  root.querySelectorAll('button[data-basis-confirm]').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => confirmOnePractice(btn.getAttribute('data-basis-confirm')));
  });
}

/** The programmatic form of the "Confirm all practice values" button — same code path, same record.
 *  Tests use it so they exercise the real gate instead of a bypass; a visitor uses the button. */
function confirmBasisAll() { confirmAllPractice(); return basisStats(currentBasis()); }

function basisWhen() { return new Date().toISOString().slice(0, 10); }
function basisWho() { return (state.project.name || '').trim() || 'the user'; }

function confirmOnePractice(id) {
  const b = currentBasis();
  const e = b.entries[id];
  if (!e) return;
  state.project.basis[id] = {
    status: 'confirmed', confirmedAt: basisWhen(), value: e.value,
    note: `Confirmed as-is by ${basisWho()} on ${basisWhen()}.`,
  };
  saveSoon();
  afterProjectChange();
}

function confirmAllPractice() {
  const b = currentBasis();
  const gaps = basisGaps(b);
  for (const g of gaps) {
    const e = b.entries[g.id];
    state.project.basis[g.id] = {
      status: 'confirmed', confirmedAt: basisWhen(), value: e.value,
      note: `Confirmed as-is by ${basisWho()} on ${basisWhen()}.`,
    };
  }
  saveSoon();
  afterProjectChange();
  const hint = document.getElementById('basisHint');
  if (hint) hint.textContent = `Confirmed ${gaps.length} figure${gaps.length === 1 ? '' : 's'}. ` + basisLine(currentBasis());
}

/** The refusal. Not a warning on top of a number — there is no number. */
function renderBasisRefusal(gate) {
  // The user is asked about SUBJECTS, not constants: "how much fresh air each space gets", not
  // "outdoor air per person 2.5 L/s". A refusal nobody understands is not a gate, it is a wall.
  const openSts = openStatements(gate.basis);
  const n = openSts.length;
  const names = openSts.map((s) => esc(s.label)).join(' · ');
  el.summaryCards.innerHTML = `<div class="basis-refusal">
      <h3>Not totalled — ${n} thing${n === 1 ? '' : 's'} still need your OK</h3>
      <p class="basis-refusal-body">This load is multiplied by figures that come from engineering practice,
      not from a standard, and nobody has stood behind ${n === 1 ? 'this one' : 'these ' + n} yet. A tonnage
      built on numbers nobody chose would look precise and mean nothing, so it is not shown.</p>
      <p class="basis-refusal-list">${names}</p>
      <p class="basis-refusal-actions">
        <button type="button" class="btn btn-primary" id="btnBasisConfirmAll2">Yes, these are right</button>
        <button type="button" class="btn btn-ghost" id="btnBasisOpen">Show me them one by one</button>
      </p>
      <p class="hint">Accepting them records the date against each figure; the printable report then states
      plainly which figures came from a standard, which you accepted, and which you typed by hand. Change a
      value in section 1 and this comes back.</p>
    </div>`;
  const c2 = document.getElementById('btnBasisConfirmAll2');
  if (c2) c2.addEventListener('click', confirmAllPractice);
  const open = document.getElementById('btnBasisOpen');
  if (open) open.addEventListener('click', () => {
    const block = document.getElementById('basisBlock');
    if (block) block.scrollIntoView({ block: 'center' });
    const btn = document.getElementById('btnBasisConfirmAll');
    if (btn) btn.focus();
  });
  if (el.levelBody) el.levelBody.innerHTML = '<tr><td class="l" colspan="8">Not totalled: the design basis is incomplete.</td></tr>';
  if (el.totalsBar) el.totalsBar.hidden = true;
  setExportEnabled(false, 'Confirm the design basis first');
}

function renderSummary(calc) {
  const t = calc.totals;
  const sys = unitsSys();
  renderBasisPanel();                       // the panel always shows the engine's own figures
  const gate = basisGate();
  // The refusal is about a LOAD: with no tonnage on screen there is nothing to refuse yet, so an empty
  // project still reads as an empty project (and its buttons still say "Add rooms first").
  if (t.tr > 0 && !gate.ok) { renderBasisRefusal(gate); return; }   // no basis, no tonnage
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
        reserveTotalsBar();          // its height depends on how it wrapped, so measure it here
      }
      // Nothing to print or export while no room is included in the load.
      setExportEnabled(t.rooms > 0);
    }

    /** Enable or disable the print / CSV controls. With no room included in the load there is nothing to
     *  export, so the buttons are disabled and say why, rather than producing an empty file. Driven from
     *  renderSummary(), i.e. the same render path as everything else. */
    function setExportEnabled(enabled, reason) {
      ['#btnPrint', '#btnCsv', '#btnPrint2', '#btnCsv2'].forEach((sel) => {
        const b = document.querySelector(sel);
        if (!b) return;
        b.disabled = !enabled;
        b.title = enabled ? '' : (reason || 'Add rooms first');
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
        ${room.subZone ? '&middot; <strong>a fitting inside a room, not a room</strong> &mdash; no area, not in the load'
          : room.include === false ? '&middot; <strong>excluded from totals</strong>' : ''}
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
    ${openAreaBlock(state.rooms[idx])}
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
      if (sel && sel.value) {
        planMoveShapeTo(state.ui.openId, sel.value);
      } else {
        setStatus('warn', 'Choose the room to move this shape to first — the list starts on "Choose a room…".', 'plan');
      }
    });
  }
  const fitBtn = el.detailBody.querySelector('#bdShapeFit');
  if (fitBtn) fitBtn.addEventListener('click', () => planFitShapeToWalls(state.ui.openId));
  const detachBtn = el.detailBody.querySelector('#bdShapeDetach');
  if (detachBtn) detachBtn.addEventListener('click', () => planDetachShape(state.ui.openId));
  const oaBtn = el.detailBody.querySelector('#bdOpenAreaMove');
  if (oaBtn) {
    oaBtn.addEventListener('click', () => {
      const sel = el.detailBody.querySelector('#bdOpenAreaTarget');
      if (sel && sel.value) planMoveShapeTo(state.ui.openId, sel.value);
      else setStatus('warn', 'Choose the row that should own this open area first.', 'plan');
    });
  }

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
  // An UPLOAD forgets what earlier drawings were set up for: the user has just handed us a drawing and
  // expects it set up, and the same file hashes to the same id, so a remembered "done" would silently
  // refuse to run again — measured after Clear all rooms + re-uploading the same PDF, where nothing
  // was placed or traced a second time. Rooms that keep their geometry are still left alone below.
  planAutoSetupDone.clear();
  planSetupGen++;                  // an upload replaces the drawing: abandon a run still on the old one
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
const undoStack = [];
const UNDO_DEPTH = 25;      // deep enough for a run of corrections, bounded so memory cannot creep

const cloneRooms = () => JSON.parse(JSON.stringify(state.rooms));

function undoBegin(label) {
  if (!pendingUndo) setPendingUndo({ label: label, rooms: cloneRooms() });
}

/** The gesture is over: keep its "before" state only if it really changed something. */
function undoCommit() {
  const snap = pendingUndo;
  setPendingUndo(null);
  if (!snap) return;
  if (JSON.stringify(snap.rooms) === JSON.stringify(state.rooms)) return;   // nothing moved: not an edit
  undoStack.push(snap);
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
}

/** An edit with no gesture behind it (a chooser, a button): the state now is the "before" state. */
function undoPush(label) {
  undoStack.push({ label: label, rooms: cloneRooms() });
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
}

function undoPlanEdit() {
  if (planGesture) return false;        // never step on a gesture that is still running
  const entry = undoStack.pop();
  if (!entry) {
    setStatus('warn', 'Nothing to undo on the drawing yet.', 'plan');
    return false;
  }
  setPendingUndo(null);
  state.rooms = entry.rooms;
  // The table's row order is derived in renderAll(), so it is rebuilt with the restored rooms; the open
  // row is dropped only if the restored state no longer has it.
  if (state.ui.openId && !state.rooms.some((r) => r.id === state.ui.openId)) closeDetail();
  renderAll();
  saveNow();
  planRenderGeometry();                 // the sheet itself shows the restored shape
  // One second, not ten: the reader asked for the confirmation to get out of the way
  // ("the notification stays too long").
  setStatus('ok', `Undone: ${entry.label}. The drawing is back as it was.`, 'plan', { hideAfterMs: 1000 });
  return true;
}

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
const yieldChannel = (typeof MessageChannel === 'function') ? new MessageChannel() : null;
let yieldResolvers = [];
if (yieldChannel) yieldChannel.port1.onmessage = () => { const r = yieldResolvers.shift(); if (r) r(); };
function yieldToBrowser() {
  if (!yieldChannel) return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => { yieldResolvers.push(resolve); yieldChannel.port2.postMessage(0); });
}

/** Read the plan's own linework and give every room it can verify a real outline. */
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
function passLabel(keys) {
  const list = [...(keys || [])];
  const name = (k) => (k === 'all lines' ? 'all the linework' : `the wall-line class "${k}"`);
  if (!list.length) return 'all the linework';
  if (list.length === 1) return name(list[0]);
  return list.map(name).join(' and ');
}

/** Remove ONLY the traced outlines. The rooms, their boxes, areas and the load are all untouched.
 *  A shape the user DREW by hand (source 'drawn') is not a trace and is left alone. */
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
  fitting: 'the name is a fitting inside a room, not a room',
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
function reserveTotalsBar() {
  if (!el.totalsBar) return;
  const h = el.totalsBar.hidden ? 0 : Math.ceil(el.totalsBar.getBoundingClientRect().height);
  document.body.style.paddingBottom = `${Math.max(h, 8)}px`;
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
  const calc = currentCalc();
  // ---- the evidence the report carries -----------------------------------------------------------
  // The basis as it stands, the band, and the second method. Computed here, once, on the user's click
  // (about a second for 10,000 draws), and never invented: anything that cannot be computed is left
  // out of the report and named as missing there.
  const climate = basisClimate();
  const basis = savedBasis(state.project, climate, { perType: BASIS_PER_TYPE });
  const gaps = basisGaps(basis);
  let html;
  if (gaps.length) {
    // buildReportHtml returns the refusal document: no tonnage is printed when the basis is incomplete.
    html = buildReportHtml(state.project, calc, { climate, basis });
    setStatus('warn', `The report is NOT issued: ${gaps.length} figure(s) in the design basis are ` +
      'unconfirmed. The report lists them and prints no load.');
  } else {
    const rooms = state.rooms.filter((r) => r && r.include !== false && Number(r.area) > 0);
    let uncertainty = null;
    let crosscheck = null;
    try { uncertainty = monteCarlo(rooms, state.project, { n: 10000 }); } catch (e) { uncertainty = null; }
    try {
      const day = peakLoadHour(DESIGN_DAY_EPW, rooms, state.project);
      if (day) crosscheck = crossCheck(rooms, state.project, day);
    } catch (e) { crosscheck = null; }
    html = buildReportHtml(state.project, calc, { climate, basis, uncertainty, crosscheck });
  }
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
  // Give the extracted state module (js/appstate.js) the app-side functions its bodies call.
  // Everything here is a hoisted function declaration, so it exists before start() runs.
  wireAppstateHost({
    card, hidePlanStatus, loadStored, maybeAutoSetupPlan, planFillAreas, planRoomMoveEnd,
    planTraceClear, planTraceOutlines, probeServer, renderSummary, showPlanStatus,
  });
  // ...and the plan pane's module (js/plan.js) with everything it calls back into.
  wirePlanHost({
    addRooms,
    closeDetail,
    deleteRoom,
    drawingBytesForTrace,
    drawingIdentity,
    ensurePlanModules,
    fillReasonSummary,
    fillableRooms,
    flashTableRow,
    loadAutotraceModule,
    loadLabelModule,
    loadScaleCalModule,
    loadTraceModule,
    maybeAutoSetupPlan,
    newId,
    nextFrame,
    onTableInput,
    openDetail,
    parseOne,
    passLabel,
    pickerRooms,
    placePlanProgress,
    polyIsStale,
    positionedRooms,
    renderAll,
    reserveTotalsBar,
    ringFor,
    roomDenom,
    roomOptionLabel,
    staleShapeRooms,
    start,
    traceReasonBucket,
    undoBegin,
    undoCommit,
    undoPlanEdit,
    undoPush,
    unitsSys,
    updateLive,
    updateStaleShapesButton,
    yieldToBrowser,
  });
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
// A read-only peek at the automatic setup's own bookkeeping, for the checks and for diagnosing a
// drawing that did not set itself up. Nothing writes through it.
window.__planSetupDebug = () => ({ gen: planSetupGen, running: planAutoSetupRunning,
  busy: state.ui.autoSetupBusy, marks: planAutoSetupDone.size, drawingId: plan.drawingId,
  rooms: state.rooms.length, withAt: state.rooms.filter((r) => r.at).length,
  placed: state.rooms.filter((r) => r.rect && r.rect.placed === true).length,
  traced: state.rooms.filter((r) => Array.isArray(r.poly) && r.poly.length > 2).length });
window.webhvac = {
  confirmBasisAll, state, currentCalc, renderAll, addRooms,
  // The report, as the app itself builds it: with the resolved climate and the saved confirmations, so a
  // caller (a test, a console, another page) gets exactly what the Print button gives — refusal included.
  buildReportHtml: (project, calc, opts) => buildReportHtml(project || state.project, calc || currentCalc(),
    Object.assign({ climate: basisClimate(), basis: currentBasis() }, opts || {})),
  toCsv, calcRoom, normalizeRoom, planMoveShapeTo, planDetachShape, planPlaceAllRooms, planClearPlaced, planTraceOutlines, planTraceClear, planFillAreas, planUndoFill, plan, planDrawShape, planCommitShape, planShowShapeChooser, setUnits, detectUnits: (...a) => detectUnits(...a), planAutoSetup, maybeAutoSetupPlan, roomsHavePlanGeometry, planAutoSetupDone };

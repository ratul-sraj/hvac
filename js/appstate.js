// js/appstate.js — extracted verbatim from js/app.js (see tests/qa/split-app.py).
// Behaviour is unchanged: same code, same order, just a smaller app.js to read.

import { CLIMATES, COUNTRIES, DEFAULT_PROJECT } from './calc.js';
import { DRAWING_SCALES } from './planview.js';
import { fmt } from './report.js';
import { area, length } from './units.js';

// Host seam: the app supplies these at boot (wireHost). Bodies below call them by name.
let HOST = {};
export function wireHost(h) { HOST = { ...HOST, ...h }; }
const card = (...a) => HOST.card(...a);
const hidePlanStatus = (...a) => HOST.hidePlanStatus(...a);
const loadStored = (...a) => HOST.loadStored(...a);
const maybeAutoSetupPlan = (...a) => HOST.maybeAutoSetupPlan(...a);
const planFillAreas = (...a) => HOST.planFillAreas(...a);
const planRoomMoveEnd = (...a) => HOST.planRoomMoveEnd(...a);
const planTraceClear = (...a) => HOST.planTraceClear(...a);
const planTraceOutlines = (...a) => HOST.planTraceOutlines(...a);
const probeServer = (...a) => HOST.probeServer(...a);
const renderSummary = (...a) => HOST.renderSummary(...a);
const showPlanStatus = (...a) => HOST.showPlanStatus(...a);

export const MISSING_SCHEDULE = 'the room-schedule reader (js/schedule.js) is not in this build';
export const MISSING_OCR = 'the OCR reader (js/ocr.js) is not in this build';
export const MISSING_TRACE = 'the outline tracer (js/trace.js) is not in this build';
export const MISSING_AUTOTRACE = 'the area filler (js/autotrace.js) is not in this build';
export const MISSING_SCALECAL = 'the scale reader (js/scalecal.js) is not in this build';

// vendored tesseract files, served from the site (no CDN at runtime)
export const OCR_VENDOR = new URL('../vendor/tesseract/', import.meta.url).href;
export const STORAGE_KEY = 'webhvac.state.v1';
export const NUM_FIELDS = ['area', 'height', 'people', 'light', 'equip', 'extWall', 'glass', 'partition'];
export const state = {
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
export const $ = (sel) => document.querySelector(sel);
export const el = {
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
export const PROJ_FIELDS = [
  ['name', 'text'],
  ['outDb', 'num'], ['outWb', 'num'], ['inDb', 'num'], ['inRh', 'num'],
  ['uWall', 'num'], ['uGlass', 'num'], ['sc', 'num'], ['uRoof', 'num'], ['roofEtd', 'num'],
  ['uPart', 'num'], ['infilAch', 'num'], ['safety', 'num'], ['supplyDt', 'num'], ['wwr', 'num'],
];
export const projInput = (key) => document.getElementById('proj-' + key);

/* ------------------------------------------------------------------ */
/* small helpers                                                      */
/* ------------------------------------------------------------------ */
export let idSeq = 0;
export function setStatus(kind, msg, scope, opts) {
  if (!msg) {
    el.statusBox.classList.add('hidden'); el.statusBox.textContent = '';
    if (scope === 'plan') hidePlanStatus();
    return;
  }
  el.statusBox.className = 'status ' + (kind || '');
  el.statusBox.textContent = msg;
  el.statusBox.classList.remove('hidden');
  if (scope === 'plan') showPlanStatus(kind, msg, opts && opts.hideAfterMs);
}

/** Mirror a status message into the plan panel's own line (see setStatus).
 *  Good news fades itself away after 10 s (the room count after outlining has
 *  been read by then); problems stay on screen until the next action. A caller can
 *  shorten that with opts.hideAfterMs - a confirmation that only says an edit was
 *  taken back is a flash, not a paragraph. */
export const m2PerTr = (areaM2, tr) => (tr > 0 ? Math.max(0, Number(areaM2) || 0) / tr : 0);

// Anonymous, once-per-page-load signal that a calculation produced zero included
// rooms — the honest "it did not work for me" case (a load that added nothing, or
// every room excluded). Sent at most once, and only after a real attempt, so an
// untouched empty page never counts. See js/usage.js.
export let saveTimer = null;
export function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
export function saveNow() {
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
export function normalizePlanMode(m) {
  return m === 'select' ? 'select' : 'shape';
}
export function citiesOf(country) {
  return Object.keys(COUNTRIES[country] || {}).sort((a, b) => a.localeCompare(b));
}

// Fill the city list for the selected country and keep the stored city if possible.
export function inferCountry(proj) {
  const list = proj.country ? COUNTRIES[proj.country] : null;
  if (list && list[proj.city]) return proj.country;
  const cl = CLIMATES[proj.city];
  if (cl && COUNTRIES[cl.country]) return cl.country;
  if (list) return proj.country;
  return DEFAULT_PROJECT.country || 'India';
}

// Merge a project loaded from localStorage / a .json file with the defaults.
// A missing country is left undefined so inferCountry() can derive it from the city.
export function mergeProject(saved) {
  const p = { ...DEFAULT_PROJECT, ...(saved || {}) };
  if (!saved || !saved.country) delete p.country;
  return p;
}
export function defaultText(key, rn) {
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
export const isPdfUpload = (f) => /\.pdf$/i.test(f.name || '') || f.type === 'application/pdf';

// Keep the source a reader already set ("label", "table", "schedule", "ocr", …)
// and only fill it in when it is missing, so the table can show where a row came from.
export function withSource(rooms, source) {
  return (rooms || [])
    .filter((r) => r && typeof r === 'object')
    .map((r) => (r.source ? r : { ...r, source }));
}
export function joinWords(list) {
  if (list.length < 2) return list[0] || '';
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

// Short reason for the status line (the full text stays in the warnings box).
export function shortReason(msg) {
  const s = String(msg == null ? '' : msg).replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 137) + '...' : s;
}

/* --- one .csv / .tsv / .xlsx room schedule, always here in the browser ---- */

// The worker accepts a string or an ArrayBuffer. Try the natural one for the
// file type first (.xlsx is binary, .csv / .tsv is text) and the other one if
// that throws, so either shape of parseSchedule() works.
export const plan = {
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
export function sameDrawingKey(a, b) {
  if (a == null && b == null) return true;
  return String(a) === String(b);
}
export function scrollRowIntoView(tr) {
  if (!tr) return;
  const container = tr.closest ? tr.closest('.table-scroll') : null;
  if (!container) { try { tr.scrollIntoView({ block: 'nearest' }); } catch (err) { /* ignore */ } return; }
  const cr = container.getBoundingClientRect();
  const rr = tr.getBoundingClientRect();
  if (rr.top < cr.top) container.scrollTop += rr.top - cr.top;
  else if (rr.bottom > cr.bottom) container.scrollTop += rr.bottom - cr.bottom;
}
export function roomById(id) {
  const want = id && typeof id === 'object' ? id.id : id;
  return state.rooms.find((r) => r.id === want) || null;
}

/** Live, on every pointermove of a move/resize drag: write the reported rectangle into the room and
 *  redraw the boxes only. Deliberately NO recalculation and NO table rebuild here — this runs dozens
 *  of times a second, and the full project calc over a large table (159 sample rooms) is far too
 *  heavy to repeat per move. The row's area cell, the totals and the summary are refreshed once, in
 *  planRoomMoveEnd(). Keeping the live path this small is what makes the box follow the pointer. */
/* ---------------- Ctrl+Z: take back the last edit made ON the drawing ---------------- */
// The single correction the readers have actually asked for: "I dragged the wrong shape, or caught the
// wrong vertex." A drag writes itself LIVE, so the snapshot has to be taken before the gesture's first
// write and held aside until the release - what gets pushed is the state as it STOOD, not as it ended.
// A gesture that changed nothing (a click, a drag that ended where it began, an abandoned reshape)
// pushes nothing at all, so Ctrl+Z can never appear to do nothing.
//
// Scope, deliberately: this is for edits made on the sheet. "Fill areas" and "Undo delete" keep the
// single-step buttons they already have, and the automatic setup is not an edit the reader made.
export function isPresetScale(n) {
  return DRAWING_SCALES.some((s) => Number(s.denom) === Number(n));
}

/** (Re)build the drawing-scale <option> list from the current project scale. Preserves any
 *  `(from the drawing)` entry across rebuilds, adds a `(custom)` entry when the current scale is not a
 *  preset, and always ends with `Custom…`. */
export function roomHasArea(r) {
  return Number.isFinite(Number(r && r.area)) && Number(r.area) > 0;
}

/** Named rooms that have no area yet and are not stairwells: the rooms this feature can fill.
 *  Stairwells are never conditioned (the owner's rule), so they are never even offered. */
export function areaIsTyped(room) {
  return !!(room && room.areaTyped);
}

/** A room the user drew by hand: source 'drawn' plus a poly ring. */
export function roomHasShape(room) {
  if (!room) return false;
  if (Array.isArray(room.poly) && room.poly.length > 2) return true;
  return !!(room.rect && typeof room.rect.x === 'number');
}

/** A room's shape as a closed ring, whichever kind it carries: a traced/drawn OUTLINE (room.poly) or a
 *  PLACED BOX (room.rect - the locator "Place all rooms" centres on the point that names the room and
 *  sizes back from its own area). The shape link tested room.poly only, so a room carrying a box showed
 *  no link at all, and both of the link's actions returned early on `!room.poly` - reporting "no row"
 *  for a room that has a row AND a shape on the sheet. */
export function shapeRing(room) {
  if (room && Array.isArray(room.poly) && room.poly.length > 2) {
    const ring = room.poly.filter((q) => q && Number.isFinite(Number(q.x)) && Number.isFinite(Number(q.y)));
    return ring.length > 2 ? ring.map((q) => ({ x: Number(q.x), y: Number(q.y) })) : null;
  }
  const rc = room && room.rect;
  if (rc && Number.isFinite(Number(rc.x)) && Number.isFinite(Number(rc.y))
      && Number.isFinite(Number(rc.w)) && Number.isFinite(Number(rc.h))) {
    const x = Number(rc.x), y = Number(rc.y), w = Number(rc.w), h = Number(rc.h);
    return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  }
  return null;
}

/** The page a room's shape sits on, for either kind of shape. */
export function normalizeRoomName(name) {
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
export function download(name, text, mime) {
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

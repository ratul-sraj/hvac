// js/plan.js — extracted verbatim from js/app.js (see tests/qa/split-app.py).
// Behaviour is unchanged: same code, same order, just a smaller app.js to read.

import * as pdfjs from '../vendor/pdf.min.mjs';
import { $, areaIsTyped, el, isPresetScale, normalizePlanMode, normalizeRoomName, plan, roomById, roomHasArea, roomHasShape, sameDrawingKey, saveNow, saveSoon, scrollRowIntoView, setPendingUndo, setStatus, shapeRing, state } from './appstate.js';
import { NON_AC_WORDS, normalizeRoom } from './calc.js';
import { DEFAULT_SCALE_DENOM, DRAWING_SCALES, areaFromRect, dimsFromRect, isDrawnRoom, isPlacedRoom, normalizeRect, pdfPointToView, rectFromLabel, rectIsUsable, rectToViewBox, roomFromRect, round2, viewPointToPdf } from './planview.js';
import { polyAreaM2, ringBBox, ringIsUsable, roundRing } from './polyshape.js';
import { breakdown, esc, fmt } from './report.js';
import { area, areaUnit, fmtArea, length } from './units.js';
import { track } from './usage.js';

// Host seam: the app supplies these at boot (wireHost). Bodies below call them by name.
let HOST = {};
export function wireHost(h) { HOST = { ...HOST, ...h }; }
const addRooms = (...a) => HOST.addRooms(...a);
const closeDetail = (...a) => HOST.closeDetail(...a);
const deleteRoom = (...a) => HOST.deleteRoom(...a);
const drawingBytesForTrace = (...a) => HOST.drawingBytesForTrace(...a);
const drawingIdentity = (...a) => HOST.drawingIdentity(...a);
const ensurePlanModules = (...a) => HOST.ensurePlanModules(...a);
const fillReasonSummary = (...a) => HOST.fillReasonSummary(...a);
const fillableRooms = (...a) => HOST.fillableRooms(...a);
const flashTableRow = (...a) => HOST.flashTableRow(...a);
const loadAutotraceModule = (...a) => HOST.loadAutotraceModule(...a);
const loadLabelModule = (...a) => HOST.loadLabelModule(...a);
const loadScaleCalModule = (...a) => HOST.loadScaleCalModule(...a);
const loadTraceModule = (...a) => HOST.loadTraceModule(...a);
const maybeAutoSetupPlan = (...a) => HOST.maybeAutoSetupPlan(...a);
const newId = (...a) => HOST.newId(...a);
const nextFrame = (...a) => HOST.nextFrame(...a);
const onTableInput = (...a) => HOST.onTableInput(...a);
const openDetail = (...a) => HOST.openDetail(...a);
const parseOne = (...a) => HOST.parseOne(...a);
const passLabel = (...a) => HOST.passLabel(...a);
const pickerRooms = (...a) => HOST.pickerRooms(...a);
const placePlanProgress = (...a) => HOST.placePlanProgress(...a);
const polyIsStale = (...a) => HOST.polyIsStale(...a);
const positionedRooms = (...a) => HOST.positionedRooms(...a);
const renderAll = (...a) => HOST.renderAll(...a);
const reserveTotalsBar = (...a) => HOST.reserveTotalsBar(...a);
const ringFor = (...a) => HOST.ringFor(...a);
const roomDenom = (...a) => HOST.roomDenom(...a);
const roomOptionLabel = (...a) => HOST.roomOptionLabel(...a);
const staleShapeRooms = (...a) => HOST.staleShapeRooms(...a);
const start = (...a) => HOST.start(...a);
const traceReasonBucket = (...a) => HOST.traceReasonBucket(...a);
const undoBegin = (...a) => HOST.undoBegin(...a);
const undoCommit = (...a) => HOST.undoCommit(...a);
const undoPlanEdit = (...a) => HOST.undoPlanEdit(...a);
const undoPush = (...a) => HOST.undoPush(...a);
const unitsSys = (...a) => HOST.unitsSys(...a);
const updateLive = (...a) => HOST.updateLive(...a);
const updateStaleShapesButton = (...a) => HOST.updateStaleShapesButton(...a);
const yieldToBrowser = (...a) => HOST.yieldToBrowser(...a);

export async function planMarkFittings(regions, pageRooms, where) {
  const ids = new Set();
  try {
    const mod = await loadLabelModule();
    if (!mod || typeof mod.classifyLabels !== 'function') return ids;
    const rooms = (pageRooms || []).filter((r) => r && r.at && Number.isFinite(r.at.x) && Number.isFinite(r.at.y));
    if (!rooms.length || !(regions || []).length) return ids;
    const cls = mod.classifyLabels(rooms.map((r) => ({ id: r.id, name: r.name, at: r.at })), regions);
    // Visible to tests/qa: what the classifier saw on this pass (rooms in, regions in, verdict).
    try {
      if (window.webhvac && window.webhvac.plan) {
        const rec = { where: where || '?', rooms: rooms.length,
          regions: (regions || []).length, sub: cls.subZones, real: cls.realRooms,
          ids: [...cls.subZoneIds], byRegion: cls.byRegion.map((g) => ({
            real: g.real.map((x) => x.name), sub: g.sub.map((x) => x.name), r: (g.rings || []).length })) };
        window.webhvac.plan.lastFit = rec;
        window.webhvac.plan.fitLog = (window.webhvac.plan.fitLog || []).concat([rec]).slice(-8);
      }
    } catch (e) { /* diagnostics only */ }
    for (const id of cls.subZoneIds) {
      const room = rooms.find((r) => r.id === id);
      if (!room) continue;
      const wasTyped = typeof areaIsTyped === 'function' && areaIsTyped(room);
      ids.add(id);
      room.subZone = true;
      room.include = false;
      if (!wasTyped && (room.areaFromDrawing || room.source === 'drawn' || room.poly || room.rect)) {
        delete room.area; delete room.areaFromDrawing; delete room.areaUnknown; delete room.areaSource;
        delete room.poly; delete room.polyPage; delete room.polyDrawing; delete room.polyArea; delete room.polyRatio;
        delete room.rect; delete room.rectDrawing;
      }
    }
  } catch (e) { /* an annotation lost is a wrong area; a crash here must not cost the user the rest */ }
  return ids;
}

/* js/labelclass.js EXISTS and is measured (tests/qa/zone-accuracy.mjs uses it): it tells a ROOM NAME
 * from an ANNOTATION LABEL inside a room - MONITOR, SEATING, IN/OUT, WHEELCHAIR BAY, COMMISSIONERS'
 * BENCH, COUNSEL, WITNESS, ESCAPE ONLY - and on the real sample 26 of the 56 detected names are such
 * labels, not rooms.
 *
 * It is deliberately NOT wired into the app yet. Two attempts were measured and REVERTED:
 *   1. handing its sub-zone ids to the filler (matchRoomsToRegions, options.subZoneIds) changed the
 *      sample's own fill result - 22 areas became 24 - and the two extras were annotation labels,
 *      while five trace-progress checks in tests/browser-check.mjs went red;
 *   2. refusing fitting-named results inside the outline pass missed them anyway: `IN` gets its area
 *      from the FILL path (room.areaFromDrawing === true, areaSource 'drawing'), not from the trace.
 * The way in is the spec's step 0 - mark the annotation labels ONCE, together with the parent room
 * they sit in, and let every path (place, trace, fill, load) skip them. A hook per path is not it.
 * Evidence and the measuring probe: docs/ZONE-DETECTION-RESEARCH.md section 2 step 0 and
 * tests/qa/app-annot-areas.mjs, which reproduces the defect today (`IN 11.06 m2`, BENCH x2). */

/* ------------------------------------------------------------------ */
/* state                                                              */
/* ------------------------------------------------------------------ */

// KEEP the old brand in this key: renaming it would throw away every user's saved project.
export async function planRevealRoom(id) {
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
export function planScrollBox() {
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
export let scaleFixUsedDrawing;   // undefined = never used; otherwise the drawingId it was used for

/** Do two drawing identities name the same drawing? Both null (no identity in play) count as the same. */
export function planScaleDenom() {
  const n = Number(state.project.planScale);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SCALE_DENOM;
}

/** The text of a room's AREA CHIP on the plan: the area in the CURRENT unit system, or exactly
 *  "no area" when the room has none. Never 0, never NaN, never a blank chip. Formatted with the same
 *  helpers the table uses, so the plan and the table can never disagree — the overlay only places it. */
export function planRoomAreaText(room) {
  const n = Number(room && room.area);
  if (!room || room.areaUnknown || room.area == null || room.area === ''
      || !Number.isFinite(n) || n <= 0) {
    return 'no area';
  }
  const sys = unitsSys();
  return `${fmtArea(n, sys)} ${areaUnit(sys)}`;
}
export function planHintText() {
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
      `drop a point on another edge to remove it), Delete to remove, Ctrl+Z takes back the last change ` +
      `you made here, middle-drag or hold Space to pan. ` +
      `Dragged the wrong shape or the wrong vertex? Ctrl+Z puts the last edit back. ` +
      `${drawn} hand-drawn and ${placed} placed room box(es) on the plan.`;
  }
  return `Drag over a room to add it as a rectangle, or click to add a corner of a room with any ` +
    `number of sides. Close a shape by clicking its first corner again (or double-click, or press ` +
    `Enter); Backspace takes back the last corner, Escape throws the shape away. When a shape closes ` +
    `you choose which room it is. Areas are measured at 1:${planScaleDenom()} — change the drawing ` +
    `scale above if the sheet differs. ${drawn} room(s) drawn so far, ${placed} placed. Switch to ` +
    `Select / edit to move, resize or delete a box.`;
}
export function planSync() {
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
export function planRenderGeometry() {
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
export function planAnnounceStaleShapes() {
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
export function planSelectRoom(room) {
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
export function planRoomMoved(id, payload) {
  const room = roomById(id);
  if (!room || !payload) return;
  // The first write of a gesture takes the snapshot; later moves in the same drag reuse it.
  undoBegin(payload.kind === 'convert' ? 'turning that room box into a shape'
    : (Array.isArray(payload.poly) ? 'reshaping a room outline' : 'moving a room'));
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
export function planRoomMoveEnd(id, payload) {
  undoCommit();          // the gesture is over: keep its "before" state if it changed anything
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
export function planDeleteRoom(id) {
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
export async function planPlaceAllRooms(opts) {
  // A manual press while the automatic setup is running must be a no-op, not a second run.
  if (state.ui.autoSetupBusy && !(opts && opts.__auto)) return;
  const gen = opts && opts.__gen != null ? opts.__gen : null;
  if (gen != null && gen !== planSetupGen) return;   // this drawing was cleared or replaced
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
    if (gen != null && gen !== planSetupGen) return;   // went away while the positions were recovered
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
    if (gen != null && gen !== planSetupGen) return;   // the drawing went away: place nothing more
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
export function planClearPlaced() {
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
export const TRACE_PX_PER_PT = 2;      // raster resolution the module was measured at (see trace.js)
export const TRACE_THICKNESS = 2;      // wall stroke, in raster pixels

/** Every line segment of one page, in PDF user space, tagged with its line width and stroke colour.
 *  trace.js tracks the page's own save/restore/transform (and form XObjects) from a base matrix, so
 *  the base is the identity: the page content stream starts in the page's user space, which is the
 *  space room.at lives in. */
export function lineSegmentsForPage(fnArray, argsArray, OPS, trace) {
  const out = trace.segmentsFromOperatorList(fnArray, argsArray, OPS, [1, 0, 0, 1, 0, 0]);
  return out.segments;
}

/** Do ALL of these segment endpoints lie inside the page box (with a small tolerance)? If not, the
 *  transform we used is not the one that lands points in the MediaBox and the page must be skipped. */
export function segmentsInBox(segments, box, tol) {
  const t = Number.isFinite(tol) ? tol : 2;
  for (const s of segments) {
    if (!(s.x1 >= box.x0 - t && s.x1 <= box.x1 + t && s.y1 >= box.y0 - t && s.y1 <= box.y1 + t)) return false;
    if (!(s.x2 >= box.x0 - t && s.x2 <= box.x1 + t && s.y2 >= box.y0 - t && s.y2 <= box.y1 + t)) return false;
  }
  return true;
}

/** The ring the room's own name sits inside (falling back to the biggest ring). A region can return
 *  more than one ring — the outer boundary plus any holes — and the label is inside the outer one. */
export function largestRing(rings, trace) {
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
export function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

/** Rooms that can be traced at all: a position on the sheet and an area to check the outline against. */
export function planTraceBusy(on) {
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
export function planProgressShow(label) {
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
export function planProgressCount(done, total, label) {
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
export function planProgressIndeterminate(label) {
  const b = el.planProgress;
  if (!b || b.dataset.active !== '1') return;
  b.classList.add('indeterminate');
  b.removeAttribute('aria-valuenow');
  b.setAttribute('aria-valuemin', '0');
  b.setAttribute('aria-valuemax', '100');
  if (el.planProgressFill) el.planProgressFill.style.width = '';
  if (el.planProgressText && label != null) el.planProgressText.textContent = label || 'Working...';
}
export function planProgressHide() {
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
export function planButtonWorking(btn, busyLabel) {
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
export async function planTraceOutlines(opts) {
  // A manual press while the automatic setup is running must be a no-op, not a second run.
  if (state.ui.autoSetupBusy && !(opts && opts.__auto)) return;
  if (state.ui.traceBusy) return;
  const gen = opts && opts.__gen != null ? opts.__gen : null;
  if (gen != null && gen !== planSetupGen) return;   // this drawing was cleared or replaced
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
  // The list above is read from state.rooms: if the drawing was replaced while the tracer loaded, it
  // now holds the NEXT plan's rooms and tracing them would wreck that plan's fresh state.
  if (gen != null && gen !== planSetupGen) return;
  if (!withPos.length) {
    setStatus('warn', 'No room carries both a position on the sheet and an area, so there is nothing to trace. ' +
      'Upload the drawing again if the rooms have no position.', 'plan');
    return;
  }
  const noAt = state.rooms.filter((r) => !r.at || !Number.isFinite(r.at.x) || !Number.isFinite(r.at.y)).length;

  let denom = planScaleDenom();
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
    // ---- scale calibration pre-pass: ask the SHEET for its scale before trusting the dropdown ----
    // Did the calibration put something on screen? If it did, the older implied-scale block further
    // down must NOT hide it: after a correction there is no mismatch left, so that block's own test is
    // false and its `else planHideScaleFix()` wiped the very message the user needed - a corrected
    // scale the app never mentioned.
    let calReported = false;
    try {
      const cal = await planCalibrateScale(pdfjs, doc, trace);
      if (cal && cal.denom != null && cal.confidence !== 'none') {
        const applied = Number(cal.denom) !== denom;
        if (applied) {
          planOfferScale(cal.denom);                        // make the option exist, then select it
          if (el.planScale) el.planScale.value = String(Math.round(cal.denom));
          planApplyScale(cal.denom);                        // the same path a preset or custom scale takes
          denom = planScaleDenom();
        }
        planShowScaleConfidence(cal, applied);
        calReported = true;
      } else if (cal) {
        planShowScaleConfidence(cal, false);                // conflict / too little evidence: amber line
        calReported = true;
      }
    } catch (err) {
      console.warn('[scale] calibration skipped:', (err && err.message) || err);
    }
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
      let fittings = 0;   // annotation labels the tracer reached: never sized, never in the load

      // Progress, in ROOMS across every page: the honest denominator is the number of rooms being
      // traced. `progressDone` counts rooms a page's trace has fully finished (or skipped outright).
      const progressTotal = withPos.length;
      let progressDone = 0;
      let uiTick = 0;    // DOM text is refreshed every unit, but the paint hop is throttled (see below)
      const tickProgress = (label) => planProgressCount(progressDone, progressTotal, label);

      for (const p of [...byPage.keys()].sort((a, b) => a - b)) {
        if (gen != null && gen !== planSetupGen) return;   // the drawing went away: stop between pages
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

        // Before a single outline is written: which of this page's names are ANNOTATION LABELS, not
        // rooms? (js/labelclass.js, decided on this page's own traced regions.) A fitting is never
        // sized and never enters the load, and a fitting that already held an area from an earlier run
        // has it taken back. See planMarkFittings.
        const pageRegions = out.results
          .filter((r) => r && r.ok && Array.isArray(r.rings) && r.rings.length)
          .map((r) => ({ id: r.id, rings: r.rings, closed: true }));
        // EVERY label on this page, not just the rooms being traced: the classifier needs a room's own
        // name to see that a fitting sits inside it, and those rooms are already traced or skipped.
        const allPageRooms = state.rooms.filter((r) => (Number(r.page) || 1) === p
          && r.at && Number.isFinite(r.at.x) && Number.isFinite(r.at.y));
        const fittingIds = await planMarkFittings(pageRegions, allPageRooms, 'trace');

        for (const res of out.results) {
          // The generation is checked at the WRITE, not only at the step's start: byPage's rooms are
          // looked up by id, and the same file hashes to the same ids, so an abandoned run would
          // otherwise write this page's outlines straight onto the drawing that replaced it.
          if (gen != null && gen !== planSetupGen) return;
          const room = roomById(res.id);
          if (!room) continue;
          allResults.push(res);
          if (fittingIds.has(res.id)) { fittings += 1; continue; }   // a label inside a room is not a room
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
      else if (!calReported) planHideScaleFix();            // never wipe what the calibration just said

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
      if (fittings) {
        // Say it out loud: these got NO area because they are fittings inside a room (MONITOR, SEATING,
        // IN/OUT, COMMISSIONERS' BENCH, WITNESS ...), which is a different thing from a room the tracer
        // could not measure - and an area on one of them would be a wrong area in the load.
        msg += `${fittings} name${fittings === 1 ? '' : 's'} that ${fittings === 1 ? 'is a fitting' : 'are fittings'} ` +
          `inside a room (not a room) ${fittings === 1 ? 'was' : 'were'} left out of the load. `;
      }
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
export const planAutoSetupDone = new Set();   // drawingId -> automatic setup ran (or was skipped) for it
// Bumped whenever the drawing goes away: unloaded, cleared, or replaced by a new upload. A run captures
// it and stops the moment it changes, because an abandoned run must never touch the drawing that replaced
// it. Measured live: Clear all rooms while the setup is still tracing, re-upload the SAME file, and the
// old run's trace step picked up the NEW plan's 159 rooms (69 rings, no boxes) - and because that left
// geometry behind, the new plan was then refused a setup of its own. That is the whole of the owner's
// "the automation only runs once".
export let planSetupGen = 0;
export let planAutoSetupRunning = false;

/** Has any room already been given geometry — a traced ring (poly/polyPage) or a placed / hand-drawn
 *  box (rect)? If so the plan is already set up (this drawing, a restored project, or the user's own
 *  work) and the automatic run must not touch it. It also must not run when an OLDER drawing's rooms
 *  are still on the table: re-placing them on a new sheet would trample the "old drawing's shapes"
 *  behaviour (they are reported stale and offered for removal, never silently re-measured). */
export async function planAutoSetup() {
  if (planAutoSetupRunning) return;
  planAutoSetupRunning = true;
  state.ui.autoSetupBusy = true;           // manual presses during the run are no-ops (the guards)
  const gen = planSetupGen;                // the drawing THIS run belongs to
  planAutoSetupDone.add(plan.drawingId);   // never twice for the same drawing this session
  // The drawing's own message (a sample fill's line, say) is overwritten by each step's status below,
  // so keep it here and put the automatic line AFTER it — the fill's counts stay on screen.
  const prior = (el.planStatus && !el.planStatus.classList.contains('hidden'))
    ? el.planStatus.textContent.replace(/\s+/g, ' ').trim() : '';
  try {
    await planPlaceAllRooms({ __auto: true, __gen: gen });
    if (gen !== planSetupGen) return;      // superseded between the steps: touch nothing more
    const placed = state.rooms.filter(isPlacedRoom).length;
    await planTraceOutlines({ __auto: true, __gen: gen });
    if (gen !== planSetupGen) return;
    const traced = state.rooms.filter((r) => Array.isArray(r.poly) && r.poly.length > 2).length;
    planAutoSetupStatus(placed, traced, prior);
  } catch (err) {
    // Never leave a bad state: each step hid its own bar and restored its own button in a finally, and
    // the manual buttons stay usable. Say nothing extra — the drawing just did not need the help.
    console.warn('[plan] automatic setup failed:', (err && err.message) || err);
  } finally {
    state.ui.autoSetupBusy = false;
    planAutoSetupRunning = false;
    // A drawing that arrived WHILE this run was in flight had its own setup refused entry by the guard
    // above, and nothing else would ever ask again. Ask now that the way is clear: this is the other
    // half of "the automation only runs once".
    if (gen !== planSetupGen) setTimeout(() => { try { maybeAutoSetupPlan(); } catch (err) { /* noop */ } }, 0);
  }
}

/** One honest line when the automatic setup finishes: the REAL counts, and that it was automatic. It
 *  is appended to whatever the drawing's own message already said (`prior`, still one line), and never
 *  claims work that did not happen. */
export function planAutoSetupStatus(placed, traced, prior) {
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
export function planShowScaleFix(info) {
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
export function planHideScaleFix() {
  if (!el.planScaleFix) return;
  el.planScaleFix.classList.add('hidden');
  el.planScaleFix.classList.remove('plan-scalefix-amber');
  el.planScaleFix.replaceChildren();
}

/* ---- the scale READ OFF THE SHEET (spec steps 1-2) ---------------------------------------------
 * The scale is the one input every area depends on, and a wrong one passes silently: every area is
 * then wrong by (N_wrong/N_true)^2. So before tracing, the sheet is asked for its own scale from
 * three independent pieces of evidence and the answer is applied automatically:
 *   E1  a "1:N" scale note in the PDF text layer            (js/scalecal.js scaleTextEstimate);
 *   E2  the sheet's own printed room areas vs the traced pt^2 (areaScaleEstimate) — this is the one
 *       that can veto a wrong note, and it is only needed when E1 and E3 disagree;
 *   E3  drawn door-leaf / swing arcs, which are a known real-world size (objectScaleEstimate).
 * A high- or medium-confidence answer is written into the SAME #planScale control the user has, so
 * the existing manual dropdown and its Custom… path keep working as an override. A conflict (E1 and
 * E3 far apart and E2 too thin to call) is never guessed at: it is shown as an amber line and the
 * user's current scale is left in place. Nothing here throws into the trace: it is best-effort. */
export async function planCalibrateScale(pdfjs, doc, trace) {
  const cal = await loadScaleCalModule();
  let E1 = null, E3 = null, box = null, page = 1, segments = null;
  for (let p = 1; p <= Math.min(doc.numPages, 4); p += 1) {
    const pg = await doc.getPage(p);
    const v = pg.view;
    const opList = await pg.getOperatorList();
    const got = trace.segmentsFromOperatorList(opList.fnArray, opList.argsArray, pdfjs.OPS, [1, 0, 0, 1, 0, 0]);
    const tc = await pg.getTextContent();
    const e1 = cal.scaleTextEstimate(tc.items);
    const e3 = cal.objectScaleEstimate(got.curves);
    if (e1.values.length || e3.denom) {
      E1 = e1; E3 = e3; page = p; segments = got.segments;
      box = { x0: v[0], y0: v[1], x1: v[2], y1: v[3] };
      break;
    }
  }
  if (!E1 && !E3) return null;

  // Only when the note and the arcs disagree is the expensive raster pass worth it — and it is the
  // sheet's own printed areas that then decide. Printed areas are read here, before any filling.
  const noted = E1 && E1.values.length ? E1.values[0] : null;
  const disagree = noted && E3 && E3.denom && !cal.agrees(noted, E3.denom);
  let E2 = null;
  if (disagree && segments) {
    const roomsIn = state.rooms
      .filter((r) => (Number(r.page) || 1) === page && r.at && Number(r.area) > 0)
      .map((r) => ({ id: r.id, name: r.name, at: { x: r.at.x, y: r.at.y }, area: Number(r.area), include: r.include }));
    if (roomsIn.length) {
      const at = await loadAutotraceModule();
      const found = trace.traceRegions({
        segments, box, rooms: roomsIn, denom: planScaleDenom(),
        pxPerPt: TRACE_PX_PER_PT, thickness: TRACE_THICKNESS, closeGaps: 6, splitShared: true,
      }).regions;
      const withRooms = found.map((g) => {
        const rings = at.regionRings(g);
        return { ...g, rooms: roomsIn.filter((r) => at.pointInRegion(r.at.x, r.at.y, rings) !== 'out') };
      });
      E2 = cal.areaScaleEstimate(withRooms);
    }
  }
  return cal.calibrateScale({ E1, E2, E3, box });
}

/** Show what the sheet said about its own scale, on the plan panel. Amber when the evidence
 *  CONFLICTS and the app deliberately did not pick a scale (the user's current one is kept).
 *
 *  The calibration applies a confident scale by itself, but the ONE-CLICK FIX BUTTON is kept as the
 *  override: whenever the drawing's own evidence disagrees with the scale the panel is showing, the
 *  banner also carries `#planScaleFixBtn` ("Use 1:N and trace again") so a user who knows better can
 *  re-assert it in one click. It is single-use per drawing (scaleFixUsedDrawing), so a re-trace after
 *  the button has been used does not re-offer it. */
export function planShowScaleConfidence(cal, applied) {
  const box = el.planScaleFix;
  if (!box || !cal) return;
  // The override has already been used on this drawing: say nothing more about the scale until the
  // drawing changes, so the panel is left clean (the suite asserts the banner hides after the fix).
  if (scaleFixUsedDrawing === plan.drawingId) { planHideScaleFix(); return; }
  const conflicting = !!(cal.conflict || cal.denom == null);
  const offer = !conflicting && applied && (Number(cal.denom) > 0);
  box.replaceChildren();
  const text = document.createElement('span');
  text.className = 'plan-scalefix-text';
  if (conflicting) {
    text.textContent = `Scale not applied - the sheet disagrees with itself${cal.conflict ? ': ' + cal.conflict.note : ''}. ` +
      `Keeping 1:${planScaleDenom()}; set the drawing scale yourself if that is wrong.`;
  } else {
    const how = cal.source === 'E2' ? "the sheet's printed room areas"
      : cal.source === 'E1' ? 'the scale note on the sheet'
        : cal.source === 'E3' ? 'the drawn door swings' : 'the sheet';
    text.textContent = `${applied ? 'Scale read from the sheet' : 'Scale confirmed'}: 1:${cal.denom} ` +
      `(from ${how}, ${cal.confidence} confidence). Change it in the Drawing scale box if that is wrong.`;
  }
  box.append(text);
  if (offer) {
    const right = String(Math.round(cal.denom));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small';
    btn.id = 'planScaleFixBtn';
    btn.textContent = `Use 1:${right} and trace again`;
    btn.addEventListener('click', () => {
      planOfferScale(cal.denom);
      scaleFixUsedDrawing = plan.drawingId;    // single-use per drawing — never re-offered
      planHideScaleFix();
      if (el.planScale) el.planScale.value = right;
      planApplyScale(right);
      planTraceOutlines();
    });
    box.append(btn);
  }
  box.classList.toggle('plan-scalefix-amber', conflicting);
  box.classList.toggle('plan-scalefix-info', !conflicting);
  box.classList.remove('hidden');
}

/** Offer the scale the outlines imply, as "1:225 (from the drawing)", at the end of the drawing-scale
 *  list — so the fix is one click. It is only OFFERED: nothing is stored until the user picks it, and
 *  picking it re-runs the trace (see planWire). Returns true when the option is in the list. */
export function planOfferScale(implied) {
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
export const CUSTOM_SCALE_VALUE = '__custom__';   // the sentinel option value; never a real scale
export const CUSTOM_SCALE_MAX = 5000;             // above this a "scale" is almost certainly a typo

/** Is this denominator one of the presets (so it needs no `(custom)` entry of its own)? */
export function planRenderScaleOptions() {
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
export function planApplyCustomScale(n) {
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
export function planAskCustomScale() {
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
export function planTraceClear() {
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
export let lastFill = null;

/** Keep the fill buttons honest: offer the control when there are blank named rooms, and enable
 *  Undo only when a fill actually changed something. */
export function planSyncFillButton() {
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
export function planUndoFill() {
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
export function planApplyFill(assignments, reasonCount, info) {
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
    // An OPEN AREA: the whole region went to this one name because the drawing does not draw its edge.
    // Recorded on the room so the table can mark it and offer to move the area to another name inside.
    if (a.openArea) room.openArea = a.openArea; else delete room.openArea;
    // An OPEN AREA carries its outline: the boundary the tracer measured (the plan's own walls where
    // they exist, closed across the opening). Stored exactly like a traced outline, so the overlay
    // draws it and the row's shape behaves like any other.
    if (a.openArea && Array.isArray(a.rings) && a.rings.length) {
      const ring = Array.isArray(a.rings[0]) ? a.rings[0] : a.rings;
      if (ring.length > 2) {
        room.poly = ring.map((pt) => ({ x: round2(pt.x), y: round2(pt.y) }));
        room.polyPage = a.page != null ? a.page : (plan.page || 1);
        room.polyDrawing = plan.drawingId;
        room.polyArea = round2(Number(a.areaM2) || 0);
        room.source = room.source || 'label';
      }
    }
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
  const openNote = info.openAreas
    ? ` ${info.openAreas} of them had no edge drawn on the plan, so the whole area was given to ONE ` +
      `room - open that room's row to move the area to another name inside it.`
    : '';
  setStatus('ok', `Filled ${filled.length} area${filled.length === 1 ? '' : 's'} from the drawing ` +
    `(using ${info.passKey === 'mixed' ? 'the plan’s own wall lines' : passLabel([info.passKey])}).${tail}${pages} ` +
    `They now count in the load, unless the name means a space that is not cooled.${openNote} Undo puts them back.`, 'plan');
}

/** Everything a fill result depends on: the drawing, the scale, and the rooms (name, whether they
 *  already have an area, and the outline/box they use). Two fills with the same signature MUST agree,
 *  so a repeat run with nothing changed cannot find a single new area. */
export function planFillSignature() {
  const rooms = (state.rooms || []).map((r) => [
    r.id, r.name || '', Number(r.area) > 0 ? 'A' : '-',
    r.poly ? r.poly.length : 0, r.rect ? 1 : 0, r.include === false ? 0 : 1,
  ].join('|')).join('~');
  return `${plan.drawingId || ''}@${planScaleDenom()}#${rooms}`;
}

/** Read the plan's own linework and give the blank named rooms an area — but only where the match is
 *  unambiguous. Never overwrites an area, never touches a stairwell, never invents a number. */
export async function planFillAreas(opts) {
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

    // NOT planHideScaleFix() here: the banner is what the calibration READ OFF THE SHEET, and filling
    // areas has nothing to do with the scale. Hiding it erased the very message the user needs (a fill
    // runs right after the automatic trace, so the scale line vanished as soon as the app corrected a
    // wrong scale - a silent correction). It is cleared where it belongs: clearing the trace, and a
    // different drawing.
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
        let fittingIds = null;             // annotation labels this pass classified (own reason)
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
            // An ANNOTATION LABEL inside a room must not take the room's area: classify this pass's own
            // regions first (js/labelclass.js). subZoneIds belongs INSIDE `options` - a top-level key is
            // silently ignored by js/autotrace.js, which reads p.options.subZoneIds. Without this a
            // region holding a real room plus its fittings (MONITOR, SEATING, ESCAPE ONLY ...) is refused
            // as `shared` and the whole room is lost - the biggest single reason a real sheet comes back
            // with almost no areas.
            // An OPEN AREA (js/trace.js, source 'open-area') is a region whose edge the drawing does not
            // draw: ONE name holds the whole area, and the user can move it to another of the names
            // inside. It must NOT go through the matcher - the matcher decides by "exactly one name
            // inside", and such a region holds several by construction, so it would refuse the area AND
            // veto neighbours that really did trace (measured: 21 -> 18 areas, every loss refused as
            // `overlap`). It is applied directly below instead: counted once, under one name.
            const openAreaRegions = regions.filter((r) => r.source === 'open-area' && r.roomId != null);
            const matchRegions = openAreaRegions.length ? regions.filter((r) => r.source !== 'open-area') : regions;
            const subZoneIds = await planMarkFittings(matchRegions, pageRooms, 'fill');
            fittingIds = subZoneIds;
            const out = auto.matchRoomsToRegions({ rooms: roomInput, regions: matchRegions, options: { subZoneIds } });
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
            // An ANNOTATION LABEL is not a room that could not be measured - it is a fitting inside a
            // room (MONITOR, SEATING, IN/OUT, COMMISSIONERS' BENCH ...). Counting those as "could not
            // be verified" told the user nothing; they get their own words.
            if (fittingIds && fittingIds.has(r.id)) {
              reasonCount.set('fitting', (reasonCount.get('fitting') || 0) + 1);
              continue;
            }
            const code = skipBy.get(r.id) || 'no-outline';
            reasonCount.set(code, (reasonCount.get(code) || 0) + 1);
          }

          // ---- open areas: the whole area, counted ONCE, under one name the user can change --------
          // `best` is this PAGE's pass, so this must stay inside the page loop. A real measurement always
          // wins over the fallback (the `assignments.has` guard), and the names inside the area ride along
          // on the room so the table can offer to move the area to another of them.
          // The head must be a ROOM, never an annotation label: MONITOR/SEATING/BENCH are fittings, not
          // spaces that get cooled (they were the whole of fix #1). A fitting was chosen as the head of
          // one open area and got an area of its own that way - prefer the largest name inside the area
          // that is not a fitting, and ignore a region with no usable figure at all.
          const isFit = (id) => {
            const rr = roomById(id);
            return !!(rr && rr.subZone) || !!(fittingIds && fittingIds.has(id));
          };
          for (const r of (best.regions || [])) {
            if (r.source !== 'open-area' || !(Number(r.areaM2) > 0)) continue;
            const insideList = (r.openArea && r.openArea.inside) || [];
            const pick = insideList.filter((x) => x.id != null && !isFit(x.id))
              .sort((a, b) => (b.areaM2 || 0) - (a.areaM2 || 0))[0];
            const targetId = (r.roomId != null && !isFit(r.roomId)) ? r.roomId : (pick && pick.id);
            if (targetId == null || !fillIds.has(targetId) || assignments.has(targetId)) continue;
            assignments.set(targetId, {
              areaM2: round2(r.areaM2), regionId: r.id,
              // The OUTLINE travels with the area. Without it the row had a figure but nothing on the
              // drawing: the trace path is what stores outlines, and it drops these regions (their own
              // verdict is a refusal), so an open area was "detected" with no boundary drawn - reported
              // from real use ("the lobby is now detected but it's not tracing the actual boundaries").
              rings: r.rings, page: p,
              openArea: { ...(r.openArea || {}), areaM2: round2(r.areaM2), roomId: targetId },
            });
          }
        }

        const openAreas = [...assignments.values()].filter((a) => a.openArea).length;

        planApplyFill(assignments, reasonCount, {
          fillable: fillable.length, pagesRead, pagesSkipped, regionsTotal, passKey, denom, openAreas,
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
export function planLevelForPage(page) {
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
export function isDrawnPolyRoom(room) {
  return !!(room && room.source === 'drawn' && Array.isArray(room.poly) && room.poly.length > 2);
}

/** Does this room carry geometry on the plan — a ring (traced, drawn, or a converted polygon) or a
 *  box (placed or hand-drawn)? A converted polygon owns its shape through the RING and carries no
 *  `rect`, so planview.isDrawnRoom() alone would miss it; this is the single "has a shape on the plan"
 *  test the box-based paths use. */
export function shapePage(room) {
  if (!room) return plan.page || 1;
  if (Array.isArray(room.poly) && room.poly.length > 2) {
    return room.polyPage != null ? room.polyPage : (plan.page || 1);
  }
  if (room.rect && room.rect.page != null) return room.rect.page;
  return plan.page || 1;
}

/** Write a ring onto a room: the ring, its page, and a bounding-box rect — so every existing "this
 *  room has geometry on the plan" path (hints, place-all, the table badge) keeps working. The ring is
 *  what the overlay draws and hit-tests; the rect is only its box. NEVER touches `source`: a traced
 *  outline stays traced. */
export function setRoomRing(room, ring, page) {
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
export function drawnPolyArea(room) {
  return round2(polyAreaM2(room.poly, roomDenom(room)));
}

/** The area (m²) a room's ring represents, but ONLY when that ring is a usable room shape — 3+ points,
 *  simple (non-self-intersecting) and more than a speck of paper, the same rule the shape tool refuses
 *  a nonsense draw with (polyshape.ringIsUsable). A degenerate ring returns null so that NO path can
 *  write an area of 0 or NaN from it: the caller keeps the room's previous area and says the shape is
 *  unusable. Traced outlines and hand-drawn shapes go through the ONE shoelace (polyshape.polyAreaM2). */
export function ringAreaIfUsable(room) {
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
export function planConvertRectToPoly(room, ring, page, final) {
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
export let pendingShape = null;   // { ring:[{x,y}], page }

/** A shape closed in the overlay: refuse a nonsense one, otherwise ask what room it belongs to. */
/**
 * BUBBLE IT OUT TO THE WALLS. The user draws a rough outline of a space; this floods the free space from
 * inside that outline until the drawing's own walls stop it (js/trace.js growToWalls) and keeps the
 * result as the room's outline and area. The user says WHICH space, the drawing says where its edges are.
 *
 * The same line classes the tracer tries are tried here, so a fit agrees with the rest of the app: a
 * class that reached a wall beats one that only ran out of bubble distance, and then area wins. A space
 * the drawing leaves OPEN cannot reach a wall in every direction: the flood stops at FIT_BUBBLE_M from
 * the user's own outline, and the message says so plainly rather than pretending it found the edge.
 */
export const FIT_BUBBLE_M = 2.5;     // how far beyond the user's rough outline the flood may run
export const FIT_PRUNE_M = 0.5;      // a lobe thinner than this (a tongue through a doorway) is dropped
export async function planFitShapeToWalls(roomId) {
  const room = roomById(roomId);
  if (!room) return;
  if (!Array.isArray(room.poly) || room.poly.length < 3) {
    setStatus('warn', 'This row has no outline to start from. Draw one roughly over the space first — ' +
      'then bubble it out to the walls.', 'plan');
    return;
  }
  const rec = await drawingBytesForTrace();
  if (!rec) {
    setStatus('warn', 'The drawing is not kept in this browser any more, so its linework cannot be read. ' +
      'Upload it again and try.', 'plan');
    return;
  }
  // js/trace.js is loaded on demand (a build without it still runs the calculator), so take it here
  // rather than assuming a module-level name: without this the handler threw "trace is not defined".
  const trace = await loadTraceModule();
  const denom = roomDenom(room);
  const page = Number(room.polyPage) || 1;
  const jx = room.poly.reduce((s, q) => s + q.x, 0) / room.poly.length;
  const jy = room.poly.reduce((s, q) => s + q.y, 0) / room.poly.length;
  const before = Number(normalizeRoom(room, state.project).area) || 0;
  setStatus('info', `Bubbling ${room.name || 'the shape'} out to the walls…`, 'plan');
  const doc = await pdfjs.getDocument({ data: rec.bytes.slice(0), verbosity: 0 }).promise;
  let best = null;
  try {
    if (page < 1 || page > doc.numPages) {
      setStatus('warn', `That outline is on page ${page}, which this drawing does not have.`, 'plan');
      return;
    }
    const pg = await doc.getPage(page);
    const v = pg.view;
    const box = { x0: v[0], y0: v[1], x1: v[2], y1: v[3] };
    const opList = await pg.getOperatorList();
    const segs = lineSegmentsForPage(opList.fnArray, opList.argsArray, pdfjs.OPS, trace);
    if (!segs.length) {
      setStatus('warn', 'This page has no wall lines, so there is nothing to bubble out to.', 'plan');
      return;
    }
    const keys = trace.styleCounts(segs).slice(0, 3).map(([key]) => key);
    keys.push('all lines');
    for (const key of keys) {
      const list = key === 'all lines' ? segs : trace.filterByStyle(segs, key);
      if (!list.length) continue;
      const out = trace.growToWalls({
        segments: list, box, pxPerPt: TRACE_PX_PER_PT, thickness: TRACE_THICKNESS, denom,
        closeGaps: 6, poly: room.poly.map((q) => ({ x: q.x, y: q.y })),
        bubbleM: FIT_BUBBLE_M, pruneM: FIT_PRUNE_M,
      });
      if (!out || !Array.isArray(out.rings) || !out.rings.length) continue;
      const score = (out.grewTo === 'walls' ? 1e9 : 0) + out.areaM2;
      if (!best || score > best.score) best = { key, out, score };
    }
  } finally {
    if (doc && typeof doc.destroy === 'function') doc.destroy();
  }
  if (!best) {
    setStatus('warn', 'There is no free space inside that outline to bubble out into — it is sitting on ' +
      'the drawing\'s walls. Draw it a little inside the room and try again.', 'plan');
    return;
  }
  const raw = best.out.rings;
  const ring = ringFor(raw, { x: jx, y: jy }, trace);
  if (!Array.isArray(ring) || ring.length < 3) {
    setStatus('warn', 'The flood found only walls around that outline, so there is no shape to keep.', 'plan');
    return;
  }
  const areaM2 = round2(trace.pt2ToM2(trace.outlineAreaPt2(raw), denom));
  const islands = Math.max(0, raw.length - 1);
  undoPush('Bubbled the shape out to the walls');
  planSync();
  room.source = 'traced';
  setRoomRing(room, ring, page);
  room.area = areaM2;
  room.scaleDenom = planScaleDenom();
  delete room.areaTyped;          // the traced shape provides the area from now on
  delete room.areaUnknown;
  delete room.openArea;           // it has an edge of its own now, so it is no longer an open area
  delete room.polyRatio;
  renderAll();
  saveNow();
  planRenderGeometry();
  const delta = round2(areaM2 - before);
  // Say what actually happened. `grewTo: 'walls'` means the flood was stopped by a wall on every side.
  // Otherwise some of it ran out - through a door the gap-closer did not seal, or through an opening the
  // drawing really leaves open - and the prune cut that escaped part back (leakedM2 says how much).
  const leaked = Number(best.out.leakedM2) || 0;
  const hit = best.out.grewTo === 'walls'
    ? 'it reached the walls on every side'
    : `it reached its walls, and the part that ran out through an opening was trimmed ` +
      `(${fmt(leaked, 2)} m² trimmed, at most ${fmt(FIT_BUBBLE_M, 1)} m past your outline)`;
  setStatus(before > 0 ? 'ok' : 'info',
    `${room.name || 'Room'}: bubbled out to the walls — ${fmt(areaM2, 2)} m² ` +
    `(${delta >= 0 ? '+' : ''}${fmt(delta, 2)} m² vs before), ${hit}. ` +
    `Traced from ${passLabel([best.key])}` +
    (islands ? `, and ${islands} island${islands === 1 ? '' : 's'} inside it (shafts, courtyards) ` +
      'are kept out of the area' : '') +
    '. Undo puts the outline you drew back.', 'plan');
}
export function planDrawShape(ring, info) {
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
export function planShowShapeChooser() {
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
export function planHideShapeChooser() {
  if (el.planShapeAssign) el.planShapeAssign.classList.add('hidden');
}

/**
 * Apply the pending shape. `roomId` = an existing row to give the shape to; empty/null = make a NEW
 * room (also what a dismiss does, exactly like the plain tool). Assigning sets the room's area to the
 * ring's shoelace area, so the table, the totals, the CSV and the report all move with it.
 */
export function planCommitShape(roomId) {
  if (!pendingShape) return;
  undoPush(roomId ? 'drawing that shape onto a row' : 'drawing a new room');
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
export function planDetachShape(roomId) {
  const room = roomById(roomId);
  if (!room || !roomHasShape(room)) return;        // a placed box is a shape too, not only an outline
  undoPush('removing a shape from its row');
  // Was the AREA measured FROM this shape? A ring is the area's own source, so losing it makes the area
  // unknown. A PLACED box is the reverse - the placement sized the box BACK from the area the sheet
  // printed - so removing the box must leave that measured area alone, which is what planClearPlaced()
  // does too when it drops locator boxes. Only the ring case rewrites the area and its provenance.
  const hadRing = Array.isArray(room.poly) && room.poly.length > 2;
  const wasFromDrawing = hadRing && !!(room.areaFromDrawing || room.source === 'drawn');
  const oldArea = Number(room.area);
  delete room.poly;
  delete room.polyPage;
  delete room.polyDrawing;
  delete room.rect;
  delete room.rectDrawing;
  if (hadRing) {
    delete room.areaFromDrawing;
    delete room.areaSource;
    room.source = 'manual';
  }
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
export function planMoveShapeTo(fromId, toId) {
  const from = roomById(fromId);
  const to = toId ? roomById(toId) : null;
  if (!from || !to) return;
  if (from.id === to.id) return;
  undoPush('moving a shape to another row');
  const ring = shapeRing(from);      // a traced outline OR the placed box, as a ring
  if (!ring) return;
  const page = shapePage(from);
  const denom = roomDenom(from);
  const wasFromDrawing = !!(from.areaFromDrawing || from.source === 'drawn');
  const toHadShape = !!((to.poly && to.poly.length > 2) || to.rect);
  const toOldArea = Number(normalizeRoom(to, state.project).area);

  planDetachShape(fromId);          // the giving row stops claiming the shape (and says nothing yet)
  // A giving row whose area CAME FROM THE DRAWING must not keep it while the shape's area travels to the
  // other row: that would count the same measured area on two rows. planDetachShape deliberately keeps
  // the area for a PLACED BOX (the box was sized back FROM that area, so the room still owns it) - which
  // is right for "Remove the shape from this row", and wrong here, where the shape is really leaving.
  if (wasFromDrawing && from.area != null) {
    from.area = null;
    from.areaUnknown = true;
    delete from.areaFromDrawing;
    delete from.areaSource;
  }
  to.source = 'drawn';
  to.scaleDenom = denom;
  setRoomRing(to, ring, page);
  to.area = drawnPolyArea(to);
  to.areaFromDrawing = true;
  delete to.areaTyped;        // the shape now provides the area: edits on it follow the shape again
  delete to.areaUnknown;
  // An OPEN AREA travels with its shape: the list of names inside is what makes it reassignable, and the
  // area must stay in the load, so the new row inherits both (and the rule that a name meaning an uncooled
  // space stays out). The giving row forgets it - one owner at a time, so the total cannot double-count.
  if (from.openArea) {
    to.openArea = { ...from.openArea, roomId: to.id };
    to.include = !NON_AC_WORDS.test(to.name || '');
    delete from.openArea;
    from.include = false;
  }
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
export function planDrawRoom(rect, info) {
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
export function planCreateShapeRoom(shape) {
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
export function planApplyScale(denom) {
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
export async function storeDrawing(bytes, name) {
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
export async function unloadPlan() {
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
  planAutoSetupDone.clear();       // nothing is set up on a drawing that is no longer loaded
  planSetupGen++;                  // and a run still working on it stops where it stands
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
export async function rehydratePositions() {
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
export async function planGoTo(n) {
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
export let zoomBusy = false;
export let zoomFactor = 1;

/** Zoom by a factor, coalescing clicks that land faster than a repaint — without losing any of them.
 *  Each setScale cancels the render in flight and paints the page again (half a second on a real CAD
 *  sheet), so one repaint per click queues work that is immediately thrown away and leaves the drawing
 *  showing an intermediate state. Here the counts are accumulated instead: every click multiplies
 *  zoomFactor, and the accumulated factor is applied once to the scale actually in effect. Reading the
 *  factor rather than a target scale is deliberate — several clicks can arrive in the same tick, when
 *  they would all read the same committed scale and the extra steps would be silently lost. */
export async function planZoomBy(factor) {
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
export async function planFitWidth() {
  if (!plan.viewer || plan.unavailable) return;
  try {
    await plan.viewer.fitWidth();
    if (plan.overlay) { plan.overlay.resize(); plan.overlay.render(); }
    planSync();
  } catch (err) {
    setStatus('warn', `Could not fit the drawing (${(err && err.message) || err}).`, 'plan');
  }
}
export function planSetMode(mode) {
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
export const PLAN_DRAG_PX = 6;      // a press that travels beyond this (view px) is a drag, not a click
// At 1:20/1:50 a 3×3 pt rectangle rounds to 0.00 m². Such a rectangle is not a room: it would add a
// junk zero row (and a bogus outline), so it is refused with a status message instead.
export const MIN_ROOM_AREA_M2 = 0.01;
export let planGesture = null;      // { startView, startPdf, page, drag, pointerId, droppedDraft }
export let planSpaceHeld = false;   // Space is the pan modifier, exactly as it is in the overlay
export function planGestureSpaceKey(e) {
  return e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
}

// The same text-entry rule js/overlay.js uses (isTextEntry): Space must never start a pan, and must
// never let the overlay start a polygon, while the user is typing — including while typing in the
// room-name box. Holding Space there used to set the pan flag and made the app skip the gesture while
// the overlay still started a polygon, so the two disagreed about the same keystroke.
export const PLAN_TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number',
  'date', 'datetime-local', 'month', 'week', 'time',
]);
export function planIsTextEntry(node) {
  if (!node || node === document) return false;
  const tag = String(node.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (node.isContentEditable === true) return true;
  if (tag !== 'INPUT') return false;
  return PLAN_TEXT_INPUT_TYPES.has(String(node.getAttribute('type') || 'text').toLowerCase());
}
export function planGestureViewport() {
  const vp = plan.viewer && typeof plan.viewer.getViewport === 'function' ? plan.viewer.getViewport() : null;
  return vp && typeof vp.convertToPdfPoint === 'function' ? vp : null;
}
export function planGesturePoint(e) {
  const svg = plan.overlay && plan.overlay.el;
  if (!svg) return null;
  const r = svg.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** The rubber band + the live size/area readout, drawn straight onto the overlay <svg> (the overlay's
 *  own render() only replaces its <g> children, so these survive it). Mirrors what Draw room showed. */
export function planShowPreview(rect) {
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
export function planClearPreview() {
  if (!plan.preview) return;
  for (const node of plan.preview) if (node.parentNode) node.parentNode.removeChild(node);
  plan.preview = null;
}
export function planGestureDown(e) {
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
export function planReleaseCapture(id) {
  try { el.planView.releasePointerCapture(id); } catch (err) { /* never captured, or already gone */ }
}
export function planGestureMove(e) {
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
export function planGestureUp(e) {
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
export function planGestureCancel(e) {
  if (planGesture && e && typeof e.pointerId === 'number' && e.pointerId !== planGesture.pointerId) return;
  if (planGesture) planReleaseCapture(planGesture.pointerId);
  planGesture = null;
  // An abandoned gesture is not an edit: drop the snapshot it had begun, or a later Ctrl+Z could reach
  // back past it and undo something else the reader changed in the meantime.
  setPendingUndo(null);
  planClearPreview();
}

/** The merged drawing gestures. Wired once, with the rest of the plan panel. */
export function planWireGestures() {
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
    // Refresh on the KEYSTROKE itself, not only while a draft still exists. Escape THROWS THE DRAFT
    // AWAY, so by the time this fires hasDraft() is false, the refresh was skipped, and the line under
    // the drawing went on telling the user to "press Enter to finish the shape" for a shape that no
    // longer existed. Reported from real use.
    if (e.key === 'Backspace' || e.key === 'Escape') planSync();
  });
  // The totals bar is FIXED to the bottom and body reserves its height (reserveTotalsBar below).
  // Wrapping on a narrow screen changes that height, so measure it again when the window changes shape.
  window.addEventListener('resize', reserveTotalsBar);
  window.addEventListener('keydown', (e) => {
    // Space is the pan modifier — but never while the user is typing (the room-name box, a table
    // cell). Without this guard, holding Space to type a space set the pan flag, so the app skipped
    // the press while the overlay still started a polygon: the two disagreed about one keystroke.
    if (planGestureSpaceKey(e) && !planIsTextEntry(document.activeElement) && !planIsTextEntry(e.target)) {
      planSpaceHeld = true;
    }
    if (e.key === 'Escape' && planGesture) planGestureCancel();
  });
  window.addEventListener('keydown', (e) => {
    // Ctrl+Z (Cmd+Z on a Mac) takes back the last edit made on the DRAWING: the shape the reader dragged
    // by mistake, the vertex they caught instead of the one they meant. Never while typing - inside a
    // text box Ctrl+Z belongs to the text.
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (String(e.key || '').toLowerCase() !== 'z') return;
    if (planIsTextEntry(document.activeElement) || planIsTextEntry(e.target)) return;
    if (undoPlanEdit()) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { if (planGestureSpaceKey(e)) planSpaceHeld = false; });
  window.addEventListener('blur', () => { planSpaceHeld = false; });
}

/** Body reserves exactly the totals bar's own height, MEASURED — the fixed 50 px in the stylesheet was
 *  not enough once the bar wraps. On a phone (390 px) the bar is two lines tall, so the last controls on
 *  the page — the plan toolbar buttons "Remove placed rooms", "Trace real outlines", "Remove outlines" —
 *  ended up behind it and could not be tapped. Reported from real use. */
export function planWire() {
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
export async function openPlan(bytes, opts) {
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
      if (el.planLinkTarget && el.planLinkTarget.value) {
        planMoveShapeTo(state.ui.openId, el.planLinkTarget.value);
      } else {
        setStatus('warn', 'Choose the room to move this shape to first — the list starts on "Choose a room…", '
          + 'so pressing Move without picking one cannot move a shape onto a room you never chose.', 'plan');
      }
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

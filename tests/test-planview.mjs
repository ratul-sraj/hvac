// Tests for js/planview.js — the geometry behind drawing rooms on the plan.
// Pure Node: no DOM, no pdf.js. The viewport used here is a fake that follows pdf.js's own
// convention (view pixels from the canvas top-left, y down), so the adapters are exercised for
// real without pulling in the library.
import {
  PT_PER_INCH, M_PER_INCH, SQIN_PER_SQM, DRAWING_SCALES, DEFAULT_SCALE_DENOM, MIN_RECT_PT,
  normalizeRect, rectIsUsable, areaFromRect, dimsFromRect, clampRectToPage, rectCenter,
  rectContainsPoint, moveRect, resizeRect, handlePoints, roomAtPoint, roomsOnPage, roomFromRect,
  round2, isDrawnRoom, pdfPointToView, viewPointToPdf, rectToViewBox,
  handleAtPoint,
} from '../js/planview.js';
import { normalizeRoom, calcRoom, calcProject, DEFAULT_PROJECT } from '../js/calc.js';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? '  — ' + detail : ''}`); }
};
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ---------- constants ----------
ok('PDF points are 1/72 inch', PT_PER_INCH === 72);
ok('metres per inch is exact', M_PER_INCH === 0.0254);
ok('a scale list is offered and includes the default',
  DRAWING_SCALES.length >= 4 && DRAWING_SCALES.some((s) => s.denom === DEFAULT_SCALE_DENOM),
  DRAWING_SCALES.map((s) => s.label).join(' '));

// ---------- area from the drawing scale ----------
// 100 pt on paper = 100/72 in = 1.3889 in; at 1:100 that is 138.889 in = 3.52778 m of building.
const r100 = { x: 0, y: 0, w: 100, h: 100 };
const a100 = areaFromRect(r100, 100);
ok('100x100 pt at 1:100 is 12.445 m2', near(a100, 12.4452, 0.001), `${a100.toFixed(4)} m2`);
ok('doubling the scale quadruples the area', near(areaFromRect(r100, 200), a100 * 4, 0.01),
  `${areaFromRect(r100, 200).toFixed(2)} m2 at 1:200`);
ok('halving the scale quarters the area', near(areaFromRect(r100, 50), a100 / 4, 0.01));
ok('a rectangle twice as wide has twice the area',
  near(areaFromRect({ x: 0, y: 0, w: 200, h: 100 }, 100), a100 * 2, 0.01));
ok('zero-size rect has zero area', areaFromRect({ x: 0, y: 0, w: 0, h: 0 }, 100) === 0);

// cross-check against a hand figure: 1:100, a 141.7x141.7 pt box is a 5 m x 5 m room (25 m2)
const fiveM = 5 / M_PER_INCH / 100 * PT_PER_INCH; // 5 m of building -> points on a 1:100 sheet
ok('computed side length matches a 5 m room at 1:100', near(fiveM, 141.732, 0.01), `${fiveM.toFixed(3)} pt`);
ok('that box is 25 m2', near(areaFromRect({ x: 0, y: 0, w: fiveM, h: fiveM }, 100), 25, 0.01));

// ---------- dimensions ----------
const dims = dimsFromRect({ x: 0, y: 0, w: 200, h: 100 }, 100);
ok('dimsFromRect reports long side first', dims.length > dims.width && near(dims.length, dims.width * 2, 0.01),
  `${dims.length.toFixed(2)} x ${dims.width.toFixed(2)} m`);

// ---------- drag normalisation ----------
const down = normalizeRect({ x: 30, y: 40 }, { x: 10, y: 10 });
ok('dragging up-left still yields positive w/h', down.w === 20 && down.h === 30, JSON.stringify(down));
const up = normalizeRect({ x: 10, y: 10 }, { x: 30, y: 40 });
ok('drag direction does not change the rectangle', JSON.stringify(up) === JSON.stringify(down));
ok('a stray click is rejected', rectIsUsable({ x: 5, y: 5, w: 1, h: 1 }) === false);
ok('a small-but-deliberate box is accepted', rectIsUsable({ x: 5, y: 5, w: MIN_RECT_PT, h: MIN_RECT_PT }));

// ---------- page clamping ----------
const clamp = clampRectToPage({ x: -5, y: -5, w: 50, h: 50 }, { width: 100, height: 100 });
ok('a rectangle dragged off the page is clamped inside it', clamp.x === 0 && clamp.y === 0);
const clamp2 = clampRectToPage({ x: 90, y: 90, w: 50, h: 50 }, { width: 100, height: 100 });
ok('clamping respects the far edge', clamp2.x === 50 && clamp2.y === 50, JSON.stringify(clamp2));

// ---------- hit testing ----------
const rect = { x: 10, y: 10, w: 20, h: 20 };
ok('centre is inside', rectContainsPoint(rect, rectCenter(rect)));
ok('corner counts as inside', rectContainsPoint(rect, { x: 10, y: 30 }));
ok('just outside is outside', rectContainsPoint(rect, { x: 9.9, y: 20 }) === false);

const big = { id: 'big', rect: { page: 1, x: 0, y: 0, w: 400, h: 400 } };
const small = { id: 'small', rect: { page: 1, x: 100, y: 100, w: 50, h: 50 } };
const other = { id: 'other', rect: { page: 2, x: 100, y: 100, w: 50, h: 50 } };
const noGeom = { id: 'nogeom', name: 'parsed room', area: 20 };
ok('the smallest room under the cursor wins (nested boxes stay clickable)',
  roomAtPoint([big, small, other, noGeom], 1, { x: 110, y: 110 }).id === 'small');
ok('a room on another page is never picked', roomAtPoint([other], 1, { x: 110, y: 110 }) === null);
ok('rooms without geometry (parsed or scheduled) are skipped',
  roomAtPoint([noGeom], 1, { x: 110, y: 110 }) === null);
ok('clicking empty space picks nothing', roomAtPoint([big], 1, { x: 999, y: 999 }) === null);

const onPage = roomsOnPage([big, small, other, noGeom], 1);
ok('roomsOnPage keeps only that page and only rooms with geometry',
  onPage.length === 2 && onPage.every((r) => r.rect.page === 1));
ok('roomsOnPage draws the biggest first', onPage[0].id === 'big');

// ---------- move / resize ----------
const moved = moveRect(rect, 5, -3);
ok('moveRect shifts without mutating the original',
  moved.x === 15 && moved.y === 7 && rect.x === 10 && rect.y === 10);
const h = handlePoints(rect);
ok('handles sit on the four corners',
  h.nw.x === 10 && h.nw.y === 30 && h.se.x === 30 && h.se.y === 10, JSON.stringify(h.nw));

// dragging the NE corner out grows the rect; the SW corner must stay put
const grew = resizeRect(rect, 'ne', { x: 40, y: 40 });
ok('resizing from NE keeps SW pinned', grew.x === 10 && grew.y === 10 && grew.w === 30 && grew.h === 30,
  JSON.stringify(grew));
const shrankPast = resizeRect(rect, 'nw', { x: 60, y: 60 });
ok('dragging a corner past its opposite never inverts the rectangle',
  shrankPast.w >= MIN_RECT_PT && shrankPast.h >= MIN_RECT_PT, JSON.stringify(shrankPast));
const swDrag = resizeRect(rect, 'sw', { x: 5, y: 5 });
ok('resizing from SW keeps NE pinned', near(swDrag.x + swDrag.w, 30, 0.001) && near(swDrag.y + swDrag.h, 30, 0.001));

// ---------- building a room ----------
const room = roomFromRect({ x: 100, y: 200, w: 141.732, h: 141.732 }, {
  id: 'r9', name: 'Drawn Room', level: 'Ground Floor', page: 2, denom: 100, orient: 'W',
});
ok('a drawn room carries the shared Room contract fields',
  room.id === 'r9' && room.name === 'Drawn Room' && room.level === 'Ground Floor' && room.source === 'manual',
  JSON.stringify({ id: room.id, source: room.source }));
ok('its area matches the rectangle and the scale', near(room.area, 25, 0.05), `${room.area} m2`);
ok('its geometry is recorded in PDF points, on the right page',
  room.rect.page === 2 && room.rect.w === 141.73 && isDrawnRoom(room) === true);
ok('the scale it was measured at is remembered', room.scaleDenom === 100);
ok('it is included in the load by default', room.include === true);
ok('numbers are rounded, not float-dusted', room.rect.w === round2(141.732));
ok('orient is only set when asked for', roomFromRect(rect, { id: 'x', page: 1 }).orient === undefined);

// ---------- the room must survive the real engine ----------
const norm = normalizeRoom(room, DEFAULT_PROJECT);
ok('normalizeRoom accepts a drawn room without complaint', norm && near(norm.area, 25, 0.05) && norm.include === true);
const res = calcRoom(room, DEFAULT_PROJECT);
ok('calcRoom produces a load for a drawn room', res && res.totalW > 0 && res.tr > 0,
  `${res.totalW.toFixed(0)} W = ${res.tr.toFixed(2)} TR`);
const proj = calcProject([room], DEFAULT_PROJECT);
ok('a drawn room flows into project totals', proj.totals.rooms === 1 && proj.totals.tr > 0,
  `${proj.totals.tr.toFixed(2)} TR over ${proj.totals.area.toFixed(1)} m2`);

// ---------- viewport adapters (fake viewport, pdf.js convention) ----------
const PAGE_H = 100;
const fake = (scale, rotation = 0) => ({
  scale, rotation, width: 100 * scale, height: PAGE_H * scale,
  convertToViewportPoint(x, y) {
    if (rotation === 90) return [y * scale, x * scale];
    return [x * scale, (PAGE_H - y) * scale];
  },
  convertToPdfPoint(x, y) {
    if (rotation === 90) return [y / scale, x / scale];
    return [x / scale, PAGE_H - y / scale];
  },
});
const vp2 = fake(2);
const v = pdfPointToView(vp2, { x: 10, y: 20 });
ok('a PDF point becomes a view pixel with y flipped', v.x === 20 && v.y === 160, JSON.stringify(v));
const back = viewPointToPdf(vp2, v);
ok('view -> PDF is the exact inverse', near(back.x, 10, 1e-9) && near(back.y, 20, 1e-9), JSON.stringify(back));
const box = rectToViewBox(vp2, { x: 0, y: 0, w: 10, h: 10 });
ok('a PDF rect becomes an SVG box at the right place and size',
  box.x === 0 && box.y === 180 && box.w === 20 && box.h === 20, JSON.stringify(box));
const box45 = rectToViewBox(fake(2, 90), { x: 0, y: 0, w: 10, h: 10 });
ok('a rotated page still yields a positive view box',
  box45.w > 0 && box45.h > 0 && near(box45.w, 20, 0.001), JSON.stringify(box45));
ok('a missing viewport degrades to zero instead of throwing',
  pdfPointToView(null, { x: 1, y: 1 }).x === 0 && rectToViewBox(null, rect).w === 0);

// ---- grabbing a corner to resize ---------------------------------------------------------------
const gRect = { x: 100, y: 200, w: 400, h: 300 };   // sw(100,200) se(500,200) ne(500,500) nw(100,500)
const grab = (x, y) => handleAtPoint(gRect, { x, y }, 12);
ok('the sw corner is grabbed just above it', grab(104, 204) === 'sw', String(grab(104, 204)));
ok('the se corner is grabbed just below it', grab(497, 197) === 'se', String(grab(497, 197)));
ok('the ne corner is grabbed just past it', grab(503, 503) === 'ne', String(grab(503, 503)));
ok('the nw corner is grabbed just inside it', grab(96, 496) === 'nw', String(grab(96, 496)));
// this is what stops an ordinary drag from resizing the room by accident
ok('the middle of the box is a MOVE, not a handle', grab(300, 350) === null, String(grab(300, 350)));
ok('an edge midpoint is a MOVE too', grab(100, 350) === null && grab(500, 350) === null,
  `${grab(100, 350)} / ${grab(500, 350)}`);
ok('a point outside the grab radius is a MOVE', grab(80, 190) === null, String(grab(80, 190)));
ok('zero tolerance still matches a corner exactly',
  handleAtPoint(gRect, { x: 100, y: 200 }, 0) === 'sw' && handleAtPoint(gRect, { x: 101, y: 200 }, 0) === null);
// overlapping grab areas resolve to the corner actually aimed at, not to the list order
const tightRect = { x: 100, y: 200, w: 10, h: 10 };
ok('overlapping grab areas pick the nearest corner',
  handleAtPoint(tightRect, { x: 101, y: 201 }, 8) === 'sw' && handleAtPoint(tightRect, { x: 108, y: 208 }, 8) === 'ne',
  `${handleAtPoint(tightRect, { x: 101, y: 201 }, 8)} / ${handleAtPoint(tightRect, { x: 108, y: 208 }, 8)}`);
ok('a missing rect or point cannot throw',
  handleAtPoint(null, { x: 0, y: 0 }, 10) === null && handleAtPoint(gRect, null, 10) === null);

// ---- dragging keeps the geometry sane ----------------------------------------------------------
// moving then resizing must behave like the pointer's own path: a move cannot change the area, and a
// resize that drags one corner across the box must not produce a negative rectangle
const movedRoom = moveRect(gRect, 50, -30);
ok('moving a room cannot change its area',
  Math.abs(areaFromRect(movedRoom, 100) - areaFromRect(gRect, 100)) < 1e-9,
  `${areaFromRect(gRect, 100).toFixed(2)} m2 -> ${areaFromRect(movedRoom, 100).toFixed(2)} m2`);
ok('moving a room keeps its size', movedRoom.w === gRect.w && movedRoom.h === gRect.h);
const grownRect = resizeRect(gRect, 'se', { x: 700, y: 100 });      // drag the se corner down-right
ok('dragging a corner outwards grows the room',
  grownRect.w === 600 && grownRect.h === 400 && grownRect.x === 100 && grownRect.y === 100,
  JSON.stringify(grownRect));
const flippedRect = resizeRect(gRect, 'se', { x: 50, y: 450 });     // drag it right across the box
ok('dragging a corner across the box still gives a positive rectangle',
  flippedRect.w > 0 && flippedRect.h > 0 && flippedRect.x + flippedRect.w <= 101,
  JSON.stringify(flippedRect));
ok('the opposite corner stays pinned while resizing',
  resizeRect(gRect, 'nw', { x: 120, y: 220 }).x + resizeRect(gRect, 'nw', { x: 120, y: 220 }).w === 500);

console.log(`\n${pass}/${pass + fail} plan view checks passed`);
if (fail) { console.log(`${fail} FAILED`); process.exit(1); }
console.log('ALL PLAN VIEW CHECKS PASSED');

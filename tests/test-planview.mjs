// Tests for js/planview.js — the geometry behind drawing rooms on the plan.
// Pure Node: no DOM, no pdf.js. The viewport used here is a fake that follows pdf.js's own
// convention (view pixels from the canvas top-left, y down), so the adapters are exercised for
// real without pulling in the library.
import {
  PT_PER_INCH, M_PER_INCH, SQIN_PER_SQM, DRAWING_SCALES, DEFAULT_SCALE_DENOM, MIN_RECT_PT,
  normalizeRect, rectIsUsable, areaFromRect, dimsFromRect, clampRectToPage, rectCenter,
  rectContainsPoint, moveRect, resizeRect, handlePoints, roomAtPoint, roomsOnPage, roomFromRect,
  round2, isDrawnRoom, pdfPointToView, viewPointToPdf, rectToViewBox,
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

console.log(`\n${pass}/${pass + fail} plan view checks passed`);
if (fail) { console.log(`${fail} FAILED`); process.exit(1); }
console.log('ALL PLAN VIEW CHECKS PASSED');

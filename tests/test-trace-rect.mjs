// js/trace.js against the REAL vendored pdf.js: does a `re` (rectangle) wall actually survive?
// Run: node tests/test-trace-rect.mjs
//
// The vendored pdf.js 4.10.38 names the rectangle op OPS.rectangle (=19); OPS.rect is undefined there.
// trace.js used to match OPS.rect, so EVERY `re` wall was dropped silently — a rect-only drawing
// produced 0 segments, 0 outlines and no error. This builds a real one-page PDF whose walls are only
// `re` rectangles, runs the operator list the app's own tracer produces, and pins the fixed behaviour:
// segments are produced, none carries a NaN (the naive rename read 8 numbers where pdf.js emits 4), and
// the room still traces to a sane, accepted outline.
//
// Pure Node (pdf.js runs in Node with a warning about the legacy build); no browser, no server.
import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { segmentsFromOperatorList, traceRooms, pt2ToM2 } from '../js/trace.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? '  — ' + detail : ''}`); process.exitCode = 1; }
};

// Minimal one-page PDF: two rooms, each a single `re` rectangle (no text, no line paths at all).
const content = '2 w 0 0 0 RG\n100 100 200 150 re S\n100 400 200 150 re S\n';
const objs = [];
objs.push('<< /Type /Catalog /Pages 2 0 R >>');
objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << >> >>');
objs.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
let pdf = '%PDF-1.4\n';
const offsets = [];
objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
offsets.forEach((o) => { pdf += String(o).padStart(10, '0') + ' 00000 n \n'; });
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

const data = new Uint8Array(Buffer.from(pdf, 'latin1'));
const doc = await pdfjsLib.getDocument({ data, verbosity: 0, isEvalSupported: false }).promise;
const page = await doc.getPage(1);
const opList = await page.getOperatorList();
const OPS = pdfjsLib.OPS;

ok('the vendored pdf.js exposes OPS.rectangle and no OPS.rect',
  OPS.rectangle === 19 && OPS.rect === undefined,
  `rectangle=${OPS.rectangle}, rect=${OPS.rect}`);

// What the op list really carries for a `re`: constructPath with path op = rectangle and 4 coords.
let rectArgs = null;
for (let i = 0; i < opList.fnArray.length; i += 1) {
  if (opList.fnArray[i] === OPS.constructPath && opList.argsArray[i] && opList.argsArray[i][0]
    && Array.from(opList.argsArray[i][0]).includes(OPS.rectangle)) rectArgs = opList.argsArray[i];
}
ok('the page carries a rectangle path op with exactly 4 numbers',
  !!rectArgs && rectArgs[1].length === 4, rectArgs ? JSON.stringify(rectArgs) : 'no rect op found');

const out = segmentsFromOperatorList(opList.fnArray, opList.argsArray, OPS, [1, 0, 0, 1, 0, 0]);
ok('a rect-only drawing now yields segments (was 0 before the fix)', out.segments.length === 8,
  `${out.segments.length} segments from 2 rectangles`);
ok('no segment carries a NaN (a naive rename would have pushed NaN)',
  out.segments.every((s) => [s.x1, s.y1, s.x2, s.y2].every(Number.isFinite)),
  out.segments.map((s) => `${s.x1},${s.y1}->${s.x2},${s.y2}`).slice(0, 2).join(' '));

const box = { x0: 0, y0: 0, x1: page.view[2], y1: page.view[3] };
// The stated area each plan would print: the rectangle's own size at 1:100.
const stated = pt2ToM2(200 * 150, 100);
const traced = traceRooms({
  segments: out.segments, box, denom: 100, pxPerPt: 2, thickness: 2,
  rooms: [
    { id: 'a', name: 'OFFICE', area: stated, at: { x: 200, y: 175 } },
    { id: 'b', name: 'STORE', area: stated, at: { x: 200, y: 475 } },
  ],
});
ok('both rect-only rooms trace to sane, accepted outlines',
  traced.stats.accepted === 2 && traced.results.every((r) => r.ok && Number.isFinite(r.tracedM2) && r.tracedM2 > 0),
  `accepted ${traced.stats.accepted}/2, areas ${traced.results.map((r) => r.tracedM2.toFixed(2)).join(', ')} m²`);

await doc.destroy();

console.log(`\n${pass}/${pass + fail} rect-linework checks passed`);
if (!process.exitCode) console.log('ALL RECT LINEWORK CHECKS PASSED');

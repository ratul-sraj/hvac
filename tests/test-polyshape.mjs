// js/polyshape.js — the pure geometry behind the 'Draw shape' tool: a ring's area (the shoelace,
// converted to m² through the SAME scale conversion a placed rectangle uses), the self-crossing test
// that lets the app refuse a nonsense shape, and the vertex / edge-midpoint edits.
// Run: node tests/test-polyshape.mjs        (pure Node: no browser, no server)
import {
  MIN_POLY_AREA_PT2, polyAreaM2, polyAreaPt2, polygonIsSimple, ringIsUsable,
  ringMidpoint, ringVertexAt, ringMidpointAt, ringEdgeNotTouching,
  ringMoveVertex, ringInsertVertex, ringRemoveVertex, ringBBox, roundRing,
} from '../js/polyshape.js';
// The reference conversion, straight from the planner-owned module: a ring's m² must be exactly the
// rectangle formula on the equivalent area, never a second definition.
import { areaFromRect } from '../js/planview.js';

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? '  — ' + detail : ''}`); process.exitCode = 1; }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const DENOM = 100;

// ---------------------------------------------------------------- area uses the planview conversion
{
  // A 100×100 pt square ring is 10000 pt²; its m² is exactly areaFromRect of a 100×100 pt rectangle.
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const expected = areaFromRect({ x: 0, y: 0, w: 100, h: 100 }, DENOM);
  ok('a square ring measures exactly like the equivalent rectangle',
    near(polyAreaM2(square, DENOM), expected, 1e-9),
    `${polyAreaM2(square, DENOM).toFixed(4)} m² vs ${expected.toFixed(4)} m²`);
  ok('ring order (clockwise / anti-clockwise) does not change the area',
    near(polyAreaM2([...square].reverse(), DENOM), expected, 1e-9));

  // scale is linear in area: 1:200 is 4× the area of 1:100
  ok('the drawing scale scales the area by its square',
    near(polyAreaM2(square, 200), expected * 4, 1e-9),
    `${polyAreaM2(square, 200).toFixed(2)} vs ${(expected * 4).toFixed(2)}`);

  // a triangle of half the square
  const tri = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
  ok('a right triangle is half the rectangle it sits in',
    near(polyAreaM2(tri, DENOM), expected / 2, 1e-9));
  ok('polyAreaPt2 is the raw shoelace in square points',
    near(polyAreaPt2(tri), 5000, 1e-6), String(polyAreaPt2(tri)));
}

// ---------------------------------------------------------------- a CONCAVE ring (the drawn case)
{
  // A 6-vertex L-ish concave ring — the shape the browser check draws.
  const ring = [
    { x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 40 },
    { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 },
  ];
  ok('a concave (6-vertex) ring is simple', polygonIsSimple(ring));
  ok('a concave ring is usable', ringIsUsable(ring, DENOM));
  // its area = 120×40 + 40×60 = 4800 + 2400 = 7200 pt²
  ok('the concave ring area is the shoelace sum of its parts',
    near(polyAreaPt2(ring), 7200, 1e-6), String(polyAreaPt2(ring)));
}

// ---------------------------------------------------------------- refusal rules
{
  // a self-crossing "bow-tie"
  const bow = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
  ok('a self-crossing ring is NOT simple', polygonIsSimple(bow) === false);
  ok('a self-crossing ring is refused', ringIsUsable(bow, DENOM) === false);

  // a degenerate (zero-area) ring: three collinear points
  const flat = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }];
  ok('a zero-area (collinear) ring is refused', ringIsUsable(flat, DENOM) === false);
  ok('a zero-area ring has no area', near(polyAreaPt2(flat), 0, 1e-9));

  // a speck, below the minimum area
  const speck = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  ok('a ~1 pt² speck is below the minimum area and refused',
    polyAreaPt2(speck) < MIN_POLY_AREA_PT2 && ringIsUsable(speck, DENOM) === false,
    `${polyAreaPt2(speck)} pt² < ${MIN_POLY_AREA_PT2}`);

  // fewer than 3 points is not a shape
  ok('two points are not a shape', polygonIsSimple([{ x: 0, y: 0 }, { x: 1, y: 1 }]) === false);
  ok('a non-finite point is refused',
    polygonIsSimple([{ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 2, y: 2 }]) === false);
}

// ---------------------------------------------------------------- vertex / edge grabs (PDF points)
{
  const ring = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  ok('a vertex is grabbed within tolerance', ringVertexAt(ring, { x: 2, y: 1 }, 5) === 0);
  ok('a vertex outside tolerance is not grabbed', ringVertexAt(ring, { x: 20, y: 20 }, 5) === -1);
  ok('the nearest vertex wins',
    ringVertexAt(ring, { x: 98, y: 99 }, 15) === 2, String(ringVertexAt(ring, { x: 98, y: 99 }, 15)));
  ok('an edge MIDPOINT is grabbed', ringMidpointAt(ring, { x: 50, y: 1 }, 5) === 0);
  ok('a vertex is not mistaken for a midpoint',
    ringMidpointAt(ring, { x: 1, y: 1 }, 5) === -1);
  ok('ringMidpoint is the average of the edge ends',
    near(ringMidpoint(ring, 1).x, 100, 1e-9) && near(ringMidpoint(ring, 1).y, 50, 1e-9));

  // a vertex dropped on a NON-adjacent edge is an "remove" gesture; its own edges never count
  ok('its own edge does not count as "another edge"',
    ringEdgeNotTouching(ring, 0, { x: 50, y: 1 }, 5) === -1);
  ok('the opposite edge DOES count',
    ringEdgeNotTouching(ring, 0, { x: 50, y: 99 }, 5) === 2,
    String(ringEdgeNotTouching(ring, 0, { x: 50, y: 99 }, 5)));
}

// ---------------------------------------------------------------- edits keep the ring valid
{
  const ring = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const moved = ringMoveVertex(ring, 1, { x: 150, y: 0 });
  ok('moving a vertex moves exactly that point', moved[1].x === 150 && moved[1].y === 0);
  ok('moving a vertex leaves the source ring untouched', ring[1].x === 100);
  ok('moving a vertex grows the area',
    polyAreaPt2(moved) > polyAreaPt2(ring), `${polyAreaPt2(ring)} -> ${polyAreaPt2(moved)}`);

  const inserted = ringInsertVertex(ring, 0, { x: 50, y: -30 });
  ok('inserting after edge 0 puts the point in the right slot',
    inserted.length === 5 && inserted[1].x === 50 && inserted[1].y === -30);
  const removed = ringRemoveVertex(ring, 2);
  ok('removing a vertex drops exactly that point', removed.length === 3 && removed[2].x === 0);
  ok('a ring never loses its last three points by removal arithmetic',
    ringRemoveVertex(removed, 0).length === 2);

  const bbox = ringBBox(ring);
  ok('the bounding box is right',
    bbox.x === 0 && bbox.y === 0 && bbox.w === 100 && bbox.h === 100, JSON.stringify(bbox));
  const rounded = roundRing([{ x: 1.2345, y: -0.005 }]);
  ok('roundRing tidies the stored points', rounded[0].x === 1.23, JSON.stringify(rounded));
}

// ---------------------------------------------------------------- a scale sanity: metresPerPt agrees
{
  // polyAreaM2 on a unit square divided by the m²-per-pt² from planview must be 1 — one conversion only.
  const unit = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const mPerPt = Math.sqrt(areaFromRect({ x: 0, y: 0, w: 1, h: 1 }, DENOM));
  ok('a 1 pt square is (metresPerPt)² m², through polyAreaM2',
    near(polyAreaM2(unit, DENOM), mPerPt * mPerPt, 1e-12),
    `${polyAreaM2(unit, DENOM)} vs ${mPerPt * mPerPt}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('ALL POLYSHAPE CHECKS PASSED');

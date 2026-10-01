# LoadLens (repo name: webhvac) — cooling load calculator from PDF floor plans, scans and room schedules

Static web app (no server). Deployed with GitHub Pages from repo `ratul-sraj/hvac`.
All processing happens in the browser. Plain HTML + CSS + ES modules. NO build step, NO frameworks,
NO CDN links (everything must be local so it works offline and on Pages).

## File layout (each file has ONE owner — do not edit files you don't own)
```
index.html            PLANNER — the LANDING page (home page of the site)
app.html              PLANNER — the CALCULATOR page (its own source of truth). Its top nav is
                      injected by `node tools/update-app-nav.mjs`
about.html            LANDING worker — about the project
method.html           LANDING worker — load method and assumptions in plain language
help.html             LANDING worker — FAQ / how-to
js/nav.js             PLANNER — shared top nav + hamburger menu (all pages)
tools/check-nav.mjs   PLANNER — browser check for the nav on every page
tools/keepalive.sh    PLANNER — git backup + server keepalive (run by a Hermes cron job)
css/style.css         calculator page styles            css/landing.css   landing pages
js/calc.js            PLANNER — load engine (read-only for workers)
js/planview.js        PLANNER — plan geometry (pure: rects, drawing scale, area, hit-testing)
                      CONTRACT: a drawn room adds `rect:{page,x,y,w,h}` (PDF points, y-up),
                      `scaleDenom` and `source:'manual'`. Screen coords are NEVER stored; the
                      overlay converts per render through the pdf.js viewport (see planview.js).
                      A PLACED region (rectFromLabel) adds `rect.placed = true` instead: the room was
                      not drawn, it was put where the plan names it, sized BACK from the area the
                      table already carries — so placing can never change a load. isPlacedRoom()
                      tells the two apart; once the user moves or resizes a placed box it is handled
                      as a hand-drawn one and its area is re-read from the rectangle.
js/viewer.js          VIEWER agent — renders a PDF page to a canvas, page nav, zoom/fit
js/overlay.js         OVERLAY agent — SVG layer over the canvas: draws rooms, drag to create
                      Room-box class names are part of its contract (see the comment at the top of
                      the file); it ships no stylesheet, so css/style.css must define them.
                      Size the layer from the CANVAS box, never from the container: the panel is a
                      scroll box, and a window-sized layer cannot reach the rest of the sheet.
                      It FOLLOWS the canvas with its own ResizeObserver — do not rely on callers to
                      resize it after a zoom. Zooming re-sizes the canvas asynchronously (it paints
                      first, ~0.5 s on a real CAD sheet), so a caller measuring straight after asking
                      for a zoom sees the PREVIOUS size and leaves the layer stale: rooms bunch toward
                      the top-left corner and the scroll extents are wrong.
                      STAGE 2 (move / resize / delete / pan) — FROZEN interface, agreed 2026-10-01:
                        modes: 'draw' | 'select'
                        opts callbacks (the overlay NEVER writes room state; it only reports):
                          onSelect(room | null)
                          onRoomMoved(id, rectPt)     // live, every pointermove of a drag
                          onRoomMoveEnd(id, rectPt)   // on release: the app persists here
                          onDelete(id)                // Delete/Backspace with a selection
                          (already there and unchanged: getViewport/getRooms/getPage/getSelectedId/
                          getScaleDenom/getMode, onDraw, onSelect, setMode, render, resize, destroy)
                          NEW, named exactly like this: onRoomMoved, onRoomMoveEnd, onDelete
                          NEW class names to emit: is-dragging, plan-room-handle, is-pan
                        select mode:
                          - pointerdown within HANDLE_PX (9 px) of a corner of the SELECTED room →
                            resize; the pixel radius is converted to PDF points through
                            getViewport() and matched with planview.handleAtPoint(), so handles stay
                            the same size under the finger at every zoom. Use ONLY handleAtPoint —
                            never re-derive the grab logic in the overlay.
                          - pointerdown inside a room box → move (live onRoomMoved, on release
                            onRoomMoveEnd). Dragging the body must NEVER resize, and vice versa.
                          - the new rect is computed with planview.moveRect()/resizeRect() (keep the
                            page, keep w/h positive), then clamped to the page with clampRectToPage().
                          - Delete/Backspace deletes the selection — but ONLY when the focus is not in
                            a text field (never steal a keystroke from a table cell).
                        pan (both modes): middle-button drag, or Space held + primary drag.
                          While panning emit no room changes and do not start a draft.
                        class names part of the contract: plan-overlay, plan-room-box, is-included,
                          is-excluded, is-selected, is-dragging, plan-room-handle (+ is-nw/is-ne/
                          is-se/ is-sw), is-draw, is-pan. css/style.css defines all of them.
js/drawstore.js       PLANNER — the uploaded drawing, kept in this browser's IndexedDB so a refresh
                      does not lose it. putDrawing/getDrawing/clearDrawing never throw: a browser
                      without IndexedDB, or a full quota, must cost the user only the drawing.
                      The buffer handed to pdf.js is DETACHED by it — pass putDrawing a private
                      copy (owned: true), never the buffer the viewer is loading.
js/pdfparse.js        PDF agent — PDF -> rooms[] (also runs server-side in Node)
                      A room read from a name+area label also carries `at:{x,y}`: where the plan names
                      it, in PDF user space (y up — the same space `rect` uses). pdf.js's own
                      convertToPdfPoint does the conversion, so a /Rotate page needs no special case.
                      Rooms the sheet does not name have no `at` and cannot be placed on the plan.
                      The DISPLAY coordinates (x right, y down) that the layout logic depends on are
                      unchanged — never "fix" y in place.
js/app.js             UI agent  — calculator behaviour; uses the Express API when present
js/report.js          UI agent  — printable report + CSV builders
vendor/pdf.*.mjs      pdf.js 4.10.38 — read-only
server.js lib/**      SERVER worker — Express server, /api/parse, /api/calc, /api/health
Dockerfile, render.yaml, fly.toml, docker-compose.yml, .github/workflows/**  deploy configs
docs/**               USER-GUIDE.md, DEMO-SCRIPT.md, INTERVIEW-NOTES.md, DEPLOY.md
tests/*.mjs           node test suites (run.mjs = unit/PDF, api-test.mjs = API,
                      browser-check.mjs = the calculator in a real browser,
                      landing-check.mjs = the marketing pages, screenshots.mjs = docs images)
```
The calculator page must keep the ids `#roomsTable`, `#btnSample`, `#summaryCards`,
`#roomsBody`, `#filterName`, `#proj-country`, `#proj-city`, `#proj-outDb`, `#proj-outWb`
— the browser checks drive them by id.

## Room object (shared contract)
```js
{
  id: "r1",            // string unique
  name: "Conference Room",
  level: "Ground Floor", // optional
  length: 6.0, width: 4.5,   // metres, optional
  area: 27.0,          // m² (required after parse; compute from L×W if missing)
  height: 3.0,         // m, optional (default 3.0)
  type: "conference",  // key of SPACE_TYPES in calc.js, optional (guessed from name)
  people, light, equip,        // optional overrides (people count, W/m², W/m²)
  orient: "W",          // N NE E SE S SW W NW
  extWall: 18,          // m² exposed wall (gross), optional
  glass: 5.4,           // m² glazing, optional
  roof: false,          // top floor / exposed roof
  partition: 0,         // m² wall to non-AC space
  include: true,        // false for toilets, stairs, etc.
  source: "table" | "label" | "manual"
}
```
`calc.js` exports: CLIMATES, SOLAR, WALL_ETD, ORIENTS, SPACE_TYPES, NON_AC_WORDS, guessSpaceType,
DEFAULT_PROJECT, normalizeRoom(room, proj), calcRoom(room, proj), calcProject(rooms, proj) -> {results, totals}.
Each result: {room, sensible:{glassSolar,glassCond,wall,roof,partition,people,lighting,equipment,infiltration},
latent:{people,infiltration}, rsh, rlh, oaSens, oaLat, oaLs, totalW, tr, shf, supplyLs, cfm, oaCfm, sqftPerTr}.
Totals: {rooms, area, areaSqft, totalW, tr, cfm, oaCfm, rsh, rlh, sqftPerTr, wOut, wIn, outRh}.

## pdfparse.js contract
```js
export async function parsePdf(arrayBuffer, { pdfjs, onProgress } = {}) -> {
  rooms: Room[], pages: number, text: string /* all text, for debugging */, warnings: string[]
}
export function parseText(items /* [{str,x,y,page}] */) -> { rooms, warnings }  // pure, testable
```
`pdfjs` is the imported pdf.js module (browser: `import * as pdfjs from "../vendor/pdf.min.mjs"`;
node tests: `pdfjs-dist/legacy/build/pdf.mjs`). parsePdf must NOT import pdf.js itself.

## Style
- Units: SI in the engine (m, m², W). UI shows TR, W, L/s, m² and ft².
- Simple English in UI text (user is non-native English speaker).
- Keep code readable; no minification.

## trace.js contract — real room outlines from the plan's linework (PLANNER owns this module)

A placed region was a RECTANGLE sized back from the room's stated area, because only the PDF's TEXT
layer was read. The walls are the PDF's VECTOR PATHS. `js/trace.js` is pure (no DOM, no canvas, no
pdf.js) and works entirely in **PDF user space (y up, points)** — the same space `room.at` and
`room.rect` use, so the overlay needs no extra conversion.

```js
segmentsFromOperatorList(fnArray, argsArray, OPS, ctm) -> { segments, styled }
   // segments: {x1,y1,x2,y2,width,color} — width/color are the graphics state at constructPath time,
   // which is how the plan's own line class is told from hatching, symbols and the title block.
dominantStyle(segments) -> "width|r,g,b"      // the most common line class in a sheet
filterByStyle(segments, key) -> segments
rasterizeWalls(segments, box, pxPerPt, thickness) -> { w, h, grid }   // grid 1 = wall
pointToCell(x, y, box, pxPerPt) -> { cx, cy }        // box = {x0,y0,x1,y1} = the page MediaBox
regionAt(grid, w, h, cx, cy) -> { cells, areaPx, bbox, key }         // null if on a wall / outside
outlineFromRegion(region, w, box, pxPerPt) -> [ring]                 // rings of {x,y} in PDF space
polygonAreaPt2 / outlineAreaPt2 / pt2ToM2(areaPt2, denom) / metresPerPt(denom)
judgeTrace(tracedM2, statedArea, labelsInRegion, band) -> { ok, ratio, reason }
traceRooms({segments, box, rooms:{id,at,area}, denom, pxPerPt, thickness, band}) -> { results, stats }
```

**A traced outline is ACCEPTED only when both hold** (this is the whole point of the module):
1. the enclosed region contains exactly ONE room label — the region's `key` is canonical (its smallest
   cell index), never `cells[0]`, which is only the seed and differs per label; and
2. its area at the drawing scale is within `TRACE_BAND` (`lo 0.8`, `hi 1.35`) of the area the plan
   states. The band is asymmetric because a region bounded by wall CENTRELINES is systematically
   larger (measured ≈ +9% with 220 mm walls).
Everything refused keeps its rectangle. A refusal must carry a plain-language `reason` and no outline.

**Room fields added by tracing** (display + verification ONLY):
`room.poly` = closed ring in PDF space, `room.polyPage` = the page it belongs to,
`room.polyArea` = traced m², `room.polyRatio` = traced ÷ stated.
**The load must never read `poly*`** — `room.area`/`length`/`width` stay exactly as the plan or the
user gave them, so tracing cannot move a load figure. Assert that.

**Rendering rules** (`js/overlay.js`): a room with `poly` draws as a polygon path instead of a rect,
keeping the same classes, `data-room-id`, include/exclude toggle, selection, move and delete.
Dragging translates every point. **Resize handles exist only for rect rooms** — an outline has no box
to drag, and silently turning it into a rectangle would be a lie. Pan/zoom are unaffected.

**Extraction rules** (`js/app.js`): read each page's operator list, transform every point with the
matrix that lands it in the MediaBox, and ASSERT it does (warn otherwise) — the app and the trace must
agree on the space. Try the plan's `dominantStyle` class first, falling back to all segments when that
accepts too few rooms; report which was used in the status line. The drawing scale comes from the
user's own scale setting: if almost nothing is accepted, say the scale may be wrong rather than
quietly retrying with another one.

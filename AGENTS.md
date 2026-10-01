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

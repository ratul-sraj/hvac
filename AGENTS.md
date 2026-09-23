# WebHVAC — cooling load calculator from PDF floor plans / room schedules

Static web app (no server). Deployed with GitHub Pages from repo `ratul-sraj/hvac`.
All processing happens in the browser. Plain HTML + CSS + ES modules. NO build step, NO frameworks,
NO CDN links (everything must be local so it works offline and on Pages).

## File layout (each file has ONE owner — do not edit files you don't own)
```
index.html            UI agent
css/style.css         UI agent
js/app.js             UI agent   (state, room table, events, rendering)
js/report.js          UI agent   (printable report HTML + CSV export)
js/calc.js            PLANNER — DONE, read-only. Load engine.
js/pdfparse.js        PDF agent  (PDF -> rooms[])
vendor/pdf.min.mjs, vendor/pdf.worker.min.mjs   pdf.js 4.10.38 — read-only
tests/*.mjs           PDF agent  (node tests, run with `node tests/run.mjs`)
tests/samples/*.pdf   PDF agent  (generated sample PDFs)
.github/workflows/pages.yml   PLANNER
```

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
- Units: SI in the engine (m, m², W). UI shows TR, W, CFM, m² and ft².
- Simple English in UI text (user is non-native English speaker).
- Keep code readable; no minification.

# LoadLens — OCR (scanned drawings) + Excel/CSV room-schedule import

Two new input ways, on top of the existing PDF text-layer path:

1. **OCR** — for scanned / image-only PDFs where pdf.js finds no text.
2. **Room schedule import** — `.csv`, `.tsv`, `.xlsx` exported from Revit/Excel (far more accurate than OCR).

Both must work in the browser (static site, GitHub Pages) **and** keep working when the Express
server is present. No CDN at runtime: everything is vendored under `vendor/` and served from the site.

## File ownership — do not edit files you do not own; never run git

```
js/ocr.js  vendor/tesseract/**  tests/test-ocr.mjs  tests/make-scanned-fixture.mjs   -> OCR worker
js/schedule.js  vendor/xlsx/**  tests/test-schedule.mjs  tests/samples/*.csv|.xlsx   -> SCHEDULE worker
js/app.js  app.html  css/style.css                                                  -> UI worker
js/calc.js js/pdfparse.js js/report.js js/nav.js  index.html about/method/help.html -> PLANNER (read-only)
server.js lib/** tests/api-test.mjs tools/** docs/** README.md package.json          -> PLANNER (read-only)
```

## Contract 1 — `js/ocr.js` (OCR worker implements exactly this)

```js
// True when a page's text layer is empty/nearly empty (i.e. probably a scan).
export function isProbablyScanned(textItems /* [{str,x,y,h}] */, { minItems = 12 } = {}) -> boolean

// OCR one already-loaded pdf.js page. Renders the page to a canvas, runs tesseract.js,
// returns the SAME item shape js/pdfparse.js already consumes (display coords, y DOWN, points):
//   [{ str, x, y, h, page, confidence }]   str = a single word (no spaces), h = text height
export async function ocrPdfPage({ pdfjs, page, pageNo = 1, scale = 4, langs = "eng", onProgress } = {})
  -> { items, words, ms, rotation }

// Whole document: OCR only the pages that look scanned; pages with a text layer use pdf.js text.
// Rooms come from js/pdfparse.js parseText() so the room rules stay in ONE place.
export async function ocrPdf(arrayBuffer, { pdfjs, onProgress, langs = "eng", force = false } = {})
  -> { rooms, pages, text, warnings, items, usedOcr: [pageNo...], ms }

// Load/patch the tesseract worker paths (call before first use in the browser).
export function configureOcr({ workerPath, corePath, langPath, logger } = {}) -> void
```

Requirements and hints:
- Vendor **tesseract.js** (`npm i tesseract.js`) into `vendor/tesseract/`: worker script, the wasm
  core, and `eng.traineddata.gz`. Point `configureOcr()`/`createWorker()` at those local paths with
  `langPath` + `gzip: true` so nothing is fetched from a CDN at runtime. Record the exact file list
  and total MB in your final answer, and add a `vendor/tesseract/README.md` saying where each file
  came from and its licence.
- In Node (tests) tesseract.js can use its own bundled paths — the test may OCR a real fixture.
- Rendering: `page.getViewport({ scale })` then `page.render({ canvasContext, viewport })`. Use an
  OffscreenCanvas when available, else a detached `<canvas>`. scale 4 ≈ 300 dpi for A1 sheets.
- **Rotation matters** — the sample drawing is a 90°-rotated sheet. Detect it: OCR once, then (if the
  result is thin) rotate the raster by 90/180/270 and keep the orientation that yields the most words.
  Put the chosen rotation in `rotation` and report it in `warnings`.
- Map tesseract word boxes to the item shape: `x = bbox.x0`, `y = bbox.y0`, `h = bbox.y1 - bbox.y0`
  (tesseract boxes are already top-left origin, y down — same as our display coords). Drop words with
  confidence < 40 and anything matching the existing junk filter in `js/pdfparse.js`.
- Keep progress reporting: `onProgress({ phase: 'render'|'ocr'|'rotate', page, pages, progress })`.
- OCR is slow and memory heavy: cap `scale` so the raster stays under ~4000 px on the long edge.

Tests (`tests/test-ocr.mjs`, plain node, no framework, PASS/FAIL + exit 1): unit-test
`isProbablyScanned()`; build a **real scanned fixture** with
`tests/make-scanned-fixture.mjs` — use the installed Edge via puppeteer-core (see
`tests/browser-check.mjs` for the launch options): open a page that draws
`tests/samples/headquarters.pdf` page 1 into a canvas at scale 3, turn that canvas into a JPEG, then
use `page.pdf()` to save an image-only PDF as `tests/samples/headquarters-scanned.pdf`. Assert the
fixture has NO text layer (pdf.js returns < 12 items) and then that `ocrPdf()` on it finds a
reasonable number of rooms (report the real number; do not invent a threshold you cannot meet — if
OCR finds only a few rooms, say so plainly and assert what it really does).

## Contract 2 — `js/schedule.js` (SCHEDULE worker implements exactly this)

```js
export const SCHEDULE_EXTENSIONS = [".csv", ".tsv", ".xlsx"];
export function isScheduleFile(name) -> boolean
export function parseSchedule(fileData /* ArrayBuffer | string */, { filename = "", sheet = 0 } = {})
  -> { rooms, warnings, columns, headerRow, rowCount, sheetName }
```
- `.csv`/`.tsv`: write your own small parser (quoted fields, `;` or `,` or tab, CRLF, BOM).
- `.xlsx`: vendor SheetJS community build (`npm i xlsx`, copy `dist/xlsx.full.min.js` into
  `vendor/xlsx/`) — or read the zip yourself with node/DecompressionStream if that proves simpler.
  Only `.xlsx` (not legacy `.xls`). Add `vendor/xlsx/README.md` with version + licence.
- Column detection by header synonyms (case/punctuation insensitive), first row that matches at
  least 2 known headers wins; also accept a headerless 2-column file as `name, area`:
  `name`: room / space / space name / area name / description / room name / room no + name
  `number`: room no / number / no / tag / ref
  `level`: level / floor / storey / story / zone / block
  `area`: area / area m² / net area / room area / (ft²/sq ft → ×0.092903)
  `length`/`width`: length, width, depth, l, w (mm > 100 → m; feet-inches like `12'-6"` → m)
  `height`: height / ceiling / soffit / ceiling height (mm → m)
  `type`: type / space type / usage / function / activity
  `people`: people / occupancy / persons / pax / no of persons
  `orient`: orient / orientation / facing / exposure
  `glass`: glass / window / glazing (area)
  `roof`: roof / top floor / exposed roof (yes/no/true/false/1/0/x)
  `light`, `equip`: lighting / light w/m², equipment / plug / power density
- Produce Room objects per the AGENTS.md contract (`id`, `name`, `number`, `level`, `area`, `length`,
  `width`, `height`, `type` from `guessSpaceType`, `people`, `orient`, `glass`, `roof`, `light`,
  `equip`, `include` from `NON_AC_WORDS`, `source: "schedule"`). Skip empty rows and any row whose
  name column is blank or a repeated header. Warn for rows missing an area, unknown units, an
  unknown level, and for duplicate rows that were dropped.
- Numbers written like `45.5 m²`, `490 ft²`, `1,249.3`, `6.0 x 4.5`, `4500x3600` must all work.

Tests (`tests/test-schedule.mjs`): create `tests/samples/schedule.csv` (12 rows: mixed units, a
ft² row, a feet-inch dimension row, a blank row, a duplicate row, a toilet row, a repeated header)
and `tests/samples/schedule.xlsx` (generate it in the test with the vendored SheetJS, or keep a real
file), then assert the parsed rooms: counts, names, areas in m², levels, `include` flags, and that
`guessSpaceType("Open Plan Office") === "office"` style typing works. Print PASS/FAIL, exit 1 on
failure. Also assert a junk file (`.txt` content) produces a warning, not a crash.

## Contract 3 — `js/app.js` + `app.html` (UI worker owns these)

- The drop zone accepts `.pdf`, `.csv`, `.tsv`, `.xlsx`. Say so in the panel text and the file input
  `accept` attribute. Route by extension: schedule files → `js/schedule.js`; PDFs → the existing
  server-or-browser path.
- A checkbox in the upload panel: **"Read scanned drawings with OCR (slow)"**, default **off**, with
  one line explaining it is for scanned/image PDFs. When on, use `js/ocr.js` (`configureOcr()` with
  the vendored paths, then `ocrPdf()`), showing the OCR progress phases. When off, keep today's
  behaviour, BUT if a PDF yields 0 rooms and `isProbablyScanned()` is true, show one clear line:
  "This PDF looks scanned (no text layer). Tick 'Read scanned drawings with OCR' and try again."
- OCR and schedule import always run in the browser even when the Express server is present (the
  server parses text-layer PDFs only). Say which one is being used in the existing status line.
- Reuse the existing `addRooms()`, `pushWarnings()`, progress and status helpers, and keep the
  `source` on each room (`schedule` / `ocr` / `label` / `table`) so the table can show it.
- Do not change the load engine, the table columns' meaning, the exports or the report.

Import the new modules with **static** `import` at the top of `js/app.js` (they are in the repo);
guard the tesseract paths with `configureOcr()` called lazily, so a browser that never ticks the box
never loads the wasm.

## Finish line
- `cd D:/webhvac && node tests/run.mjs` (existing 23) still passes, plus the two new suites.
- `node tests/browser-check.mjs http://127.0.0.1:3000/app.html` still passes 26/26.
- Real end-to-end evidence in your final answer: the CSV/XLSX import through the page, and one OCR
  run on the scanned fixture, with the numbers you actually got.

# LoadLens — Express + Node server (second way to run the same app)

The app already works as a pure static site (GitHub Pages). This adds a Node/Express
server that serves the same UI AND does the PDF reading on the server.
Both modes must stay working: if the page is opened with no server (GitHub Pages), the
browser still parses PDFs locally. If the server is there, the browser uses it.

## Shared rules
- Node 22 (installed), Windows + git-bash. Package manager: npm.
- Run from `D:/webhvac`. Start the server with `npm start` (default port 3000,
  override with `PORT`).
- ES modules only (`"type": "module"` is already in package.json). No TypeScript, no build step.
- **Do not edit files you do not own** (see ownership below). Do not run git commands.

## File ownership
```
server.js  lib/  Dockerfile  .dockerignore  README.md  tests/api-test.mjs  package.json   -> SERVER worker
js/app.js  index.html                                                                       -> CLIENT worker
js/calc.js js/pdfparse.js js/report.js css/ vendor/ tests/*.mjs (except api-test.mjs)        -> PLANNER, read-only
.github/workflows/pages.yml                                                                  -> PLANNER, read-only
```

## Existing modules you must reuse (read-only)
- `js/calc.js` — load engine. Exports `calcProject(rooms, project)`, `DEFAULT_PROJECT`,
  `normalizeRoom`, `COUNTRIES`, `CLIMATES`, `SPACE_TYPES`, `ORIENTS`.
- `js/pdfparse.js` — `parsePdf(arrayBuffer, { pdfjs, onProgress }) -> { rooms, pages, text, warnings }`.
  It does NOT import pdf.js itself; the caller passes it. In Node import the legacy build:
  `import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"`.
- `js/report.js` — pure builders: `buildReportHtml(project, calcResult)`, `toCsv(project, calcResult)`.
- Room object shape: `{ id, name, number?, level, area, length?, width?, height?, type, people?,
  light?, equip?, orient, extWall?, glass?, roof?, partition?, include, source, page? }`

## HTTP API (server worker implements exactly this)
All JSON. Errors: `{ error: "message" }` with a proper status.

1. `GET /api/health` -> `{ ok: true, app: "WebHVAC", version, node, uptimeSec, maxUploadMb, serverSideParse: true }`
2. `POST /api/parse` — `multipart/form-data`, one or more fields named `files` (also accept a single field
   named `file`). Only `.pdf` / `application/pdf`, magic bytes must start with `%PDF`, max 25 MB per file
   (override `MAX_UPLOAD_MB`), max 10 files per request.
   -> `200 { files: [ { name, pages, rooms, warnings, levelCount, roomCount, ms } ], rooms: [...all rooms with
   sourceFile name set...], warnings: [...], ms }`
   -> `400 { error }` when no file / not a PDF / a PDF that cannot be read (say which file)
   -> `413 { error }` when a file is over the limit
3. `POST /api/calc` — JSON `{ rooms: [...], project: {...} }` -> the same object `calcProject()` returns
   (`{ results, totals }`), so a caller can compute loads without loading the engine itself.
   -> `400 { error }` when `rooms` is missing or not an array.
4. `GET /api/climates` -> `{ countries: COUNTRIES, cities: CLIMATES }` (from calc.js).
5. Any other `/api/*` -> `404 { error: "unknown endpoint" }`.

Also serve the app itself statically so `npm start` gives the full UI at `http://localhost:3000/`:
`index.html`, `selftest.html`, `favicon.svg`, `css/`, `js/`, `vendor/`, and `samples/` if it exists
(the repo path is `tests/samples/`; mount that as `/samples` too so the sample button works on the server).
Never serve `tests/`, `node_modules/`, `.git/`, or dotfiles.

## Client changes (client worker)
- On first load, call `GET /api/health` once (short timeout, ~1.5 s) and remember the answer in
  `state.server = { available: true|false, version }`. Show a small line in the upload panel:
  "Reading PDFs on the server (faster)" or "Reading PDFs in your browser" — and say which, honestly.
- In `handleFiles()`: when `state.server.available`, send the files to `POST /api/parse` instead of calling
  `parsePdf()` locally. Show progress text like `Uploading file 1 of 2 …` then
  `Reading page x of y …` (the server returns everything at once, so after upload show
  `Reading PDF on the server …` until the response arrives). Merge the returned `rooms` + `warnings` into
  the table exactly like the local path (same dedupe-by-upload guard, same error/status messages).
- When the server is not available, keep the current local `parsePdf()` path unchanged — GitHub Pages must
  keep working. If a server call fails (network error, 413, 400), fall back to local parsing automatically
  and tell the user in one short line.
- Do not change any calculation, table, export or report behaviour.

## Server worker deliverables
- `server.js` (+ small modules under `lib/` if you want), `package.json` (move `pdfjs-dist` to
  `dependencies`, add `express` and `multer`; keep `puppeteer-core` as a devDependency; scripts:
  `start`, `dev`, `test`, `test:api`, `test:browser`).
- `Dockerfile` (node:22-alpine or slim, non-root user, `EXPOSE 3000`, `CMD ["node","server.js"]`,
  copies only what the server needs), `.dockerignore`, and a `README.md` with: what it is, how to run
  (npm install / npm start), the API endpoints with curl examples, how to run the tests, how to deploy
  (Docker; Render/Railway/Fly free tier; and note that GitHub Pages keeps serving the static version),
  and the limits (text-layer PDFs only, handbook-level load method — must be checked by an engineer).
- `tests/api-test.mjs` — plain node (no test framework), starts the server on a random free port with
  `PORT=0`-style handling (or spawn `node server.js` with a free port), uses `fetch` + `FormData`/`Blob`
  (Node 22 has both), and asserts: health ok; `/api/parse` on `tests/samples/sample-plan.pdf` returns
  159 rooms and 3 pages; a `.txt` file and a fake `%PDF`-less file are rejected with 400; an oversize file
  is rejected (set `MAX_UPLOAD_MB=1` for the test run and post >1 MB); `/api/calc` with 2 rooms returns
  totals with `tr > 0`; unknown `/api/x` is 404 JSON; `GET /` returns the HTML with `WebHVAC` in it and
  `GET /tests/run.mjs` is NOT served (403/404). Print PASS/FAIL per check and exit 1 on failure.
  Kill the server process cleanly at the end (also on failure).

## Finish line
`cd D:/webhvac && npm test && node tests/api-test.mjs` both pass, and `npm start` serves the UI at
http://localhost:3000/ with `/api/health` answering. Report what you did, exact commands you ran,
their real output, and anything you could not do.

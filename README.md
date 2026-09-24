# LoadLens server — optional Express server

LoadLens is a small cooling-load calculator: you give it a PDF floor plan, a scanned sheet (browser
OCR) or an Excel / CSV room schedule (or type the rooms yourself), it reads the rooms and estimates
the cooling load (TR, W, L/s).

The app works **two ways**, and both keep working:

| Mode | Who reads the PDF | Where it runs |
|---|---|---|
| Static site (GitHub Pages) | your browser (pdf.js from `vendor/`) | any static host |
| **This server** | the server (Node + pdf.js) | `npm start`, Docker, or a Node host |

When the page is opened through this server it asks `GET /api/health` once and, if the server
answers, uploads the PDFs to the server instead of parsing them locally. If the server is missing
(GitHub Pages) or a call fails, the browser falls back to local parsing automatically.

### Inputs

The drop zone accepts **`.pdf`, `.csv`, `.tsv` and `.xlsx`**. Room schedules and the optional
**"Read scanned drawings with OCR (slow)"** checkbox always run **in the browser**, even when this
server is present (the server parses text-layer PDFs only). The room table's **Source** column shows
where each row came from: `CSV/Excel`, `OCR`, `PDF` or `manual`.

## Run it

```bash
cd D:/webhvac
npm install
npm start                 # http://localhost:3000/
```

Useful environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port (`PORT=0` lets the OS pick a free one) |
| `MAX_UPLOAD_MB` | `25` | maximum size of **one** PDF (max 10 files per request) |
| `LOG_REQUESTS` | on | set `LOG_REQUESTS=0` to silence the one-line-per-request log |

```bash
PORT=8080 MAX_UPLOAD_MB=50 npm start
```

## API

All endpoints return JSON. Errors are `{ "error": "message" }` with a proper status code.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/health` | `{ ok, app, version, node, uptimeSec, maxUploadMb, serverSideParse }` |
| POST | `/api/parse` | `multipart/form-data`, one or more PDFs → rooms |
| POST | `/api/calc` | `{ rooms, project }` → `{ results, totals }` |
| GET | `/api/climates` | `{ countries, cities }` from `js/calc.js` |
| any other `/api/*` | — | `404 { "error": "unknown endpoint" }` |

### `GET /api/health`

```bash
curl -s http://localhost:3000/api/health
# {"ok":true,"app":"LoadLens","version":"1.0.0-server","node":"v22.23.2",
#  "uptimeSec":3,"maxUploadMb":25,"serverSideParse":true}
```

### `POST /api/parse`

Send the PDFs under the field name `files` (one file works too, and a single field named `file`
is also accepted). `application/pdf` / `.pdf` only, magic bytes must start with `%PDF`.

```bash
curl -s -X POST \
  -F "files=@tests/samples/headquarters.pdf;type=application/pdf" \
  http://localhost:3000/api/parse
```

200 response (shortened):

```json
{
  "files": [
    { "name": "headquarters.pdf", "pages": 3, "roomCount": 149, "levelCount": 3,
      "rooms": [ /* … */ ], "warnings": [], "ms": 246 }
  ],
  "rooms": [ { "id": "r1", "name": "TEL.C.", "level": "Ground Floor", "area": 1.5,
               "type": "general", "include": false, "source": "label", "page": 1,
               "sourceFile": "headquarters.pdf" } ],
  "warnings": [ "…" ],
  "ms": 246
}
```

`rooms` is every room from every file, each with `sourceFile` set to the file it came from.
Status codes: `400` no file / not a PDF / a PDF that cannot be read (the message names the file),
`413` a file over `MAX_UPLOAD_MB`. One unreadable file fails the request with `400` and says which
one.

### `POST /api/calc`

Computes the load without loading the engine yourself:

```bash
curl -s -X POST -H "content-type: application/json" \
  -d '{"rooms":[{"id":"r1","name":"Office","area":25,"height":3,"type":"office","orient":"W","include":true}]}' \
  http://localhost:3000/api/calc
# {"results":[ … ],"totals":{"rooms":1,"area":25,"tr":1.27,"totalW":4470.7, … }}
```

`project` is optional; missing fields fall back to `DEFAULT_PROJECT` from `js/calc.js`.
`400` when `rooms` is missing or not an array.

### `GET /api/climates`

```bash
curl -s http://localhost:3000/api/climates
# {"countries":{"India":{ … }},"cities":{"Mumbai":{ … }}}
```

## Static files

The server also serves the app: `/`, `/index.html`, `/selftest.html`, `/favicon.svg`, `/css/*`,
`/js/*`, `/vendor/*`, and the sample drawing at `/samples/headquarters.pdf` (so the "load sample"
button works on the server too).

**Never served:** `tests/` (except its read-only `samples/` subfolder), `node_modules/`, `.git/`,
dotfiles, and `package.json` / `package-lock.json` — all answer `404`.

## Tests

```bash
npm test            # the existing engine/parser/node tests (23 tests)
npm run test:api    # this server's HTTP API (25 checks, plain node, no framework)
npm run test:browser # optional: drives a real Chrome via puppeteer-core
```

`npm run test:api` starts its own server on a free port with `MAX_UPLOAD_MB=1` and
`LOG_REQUESTS=0`, checks health, a real 3-page / 149-room PDF, multi-file uploads, the `.txt`,
fake-PDF, empty and oversize rejections, `/api/calc`, `/api/climates`, the JSON 404, the served UI
and that `tests/`/`node_modules/` stay private — then shuts the server down (also when a check
fails). It exits `1` if anything fails.

## Deploy

### Docker

```bash
docker build -t loadlens .
docker run --rm -p 3000:3000 -e MAX_UPLOAD_MB=25 loadlens
# http://localhost:3000/
```

The image is `node:22-alpine`, installs production dependencies only (`npm ci --omit=dev`) and
runs as the unprivileged `node` user. `.dockerignore` keeps the host `node_modules/`, the test
sources and `.git/` out of the image.

### Free/cheap Node hosts

Render, Railway and Fly.io all work with no changes: build `npm ci`, start `npm start` (Render and
Railway set `PORT` for you automatically). Give the container at least a few hundred MB of RAM —
pdf.js reads the whole PDF in memory.

### GitHub Pages

Unchanged: Pages keeps serving the static version from `index.html`, `css/`, `js/`, `vendor/`.
That version parses PDFs in the browser, so nothing breaks if you never run this server.

## Contributors

Built by **ratul-sraj** (project owner) together with **Hermes Agent** (Nous Research) —
see [CONTRIBUTORS.md](CONTRIBUTORS.md) for who did what. Commits written by the agent carry a
`Co-authored-by: Hermes Agent <hermes-agent@nousresearch.com>` trailer.

## Limits — please read

- **Text-layer PDFs and room schedules.** The best input is a text-layer PDF (exported from CAD) or
  an Excel / CSV room schedule (`.csv`, `.tsv`, `.xlsx`). The server parses text-layer PDFs only. A
  scanned or image-only drawing can be read **in the browser** with the optional *"Read scanned
  drawings with OCR (slow)"* box, but OCR is slow (~4 s per page, and it downloads ~11 MB of wasm
  from this site on first use) and the small area labels on a scanned drawing usually cannot be read
  back — for a scanned sheet, import the Excel / CSV room schedule instead. Everything runs locally;
  nothing is uploaded to a third party.
- **The load method is handbook level.** The numbers come from a simplified handbook method
  (solar, wall ETD, people, lighting, equipment, infiltration). They are an estimate for early
  sizing, **not** a substitute for a proper load calculation — an engineer must check the input
  data and the result before it is used on a real project.
- Room areas/dimensions are read from the drawing text (room tags, schedules) and can be wrong
  for unusual layouts. Check them in the table before trusting the total.
- Uploads are held in memory (max 10 files, `MAX_UPLOAD_MB` each), so keep both limits sensible
  on a small host.

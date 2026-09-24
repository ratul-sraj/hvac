# vendor/tesseract — OCR engine for scanned drawings (`js/ocr.js`)

Everything OCR needs is in this folder. **Nothing is fetched from a CDN at runtime** — the site
works offline / on GitHub Pages. `js/ocr.js` points tesseract.js at these files with
`configureOcr()` (`workerPath`, `corePath`, `langPath` + `gzip: true`).

| file | size | where it comes from | licence |
|---|---|---|---|
| `tesseract.esm.min.js` | 62 KB | `tesseract.js@7.0.0/dist/tesseract.esm.min.js` (npm) — ES module bundle, loaded with a lazy `import()` | Apache-2.0 |
| `worker.min.js` | 109 KB | `tesseract.js@7.0.0/dist/worker.min.js` (npm) — the Web Worker script (`workerPath`) | Apache-2.0 |
| `tesseract-core-lstm.wasm.js` | 3.72 MB | `tesseract.js-core@7.0.0/` (npm) — wasm core with the binary embedded as base64, no separate `.wasm` fetch | Apache-2.0 |
| `tesseract-core-simd-lstm.wasm.js` | 3.72 MB | idem — SIMD build | Apache-2.0 |
| `tesseract-core-relaxedsimd-lstm.wasm.js` | 3.72 MB | idem — relaxed-SIMD build (used by current Chromium/Edge) | Apache-2.0 |
| `eng.traineddata.gz` | 2.82 MB | `@tesseract.js-data/eng@4.0.0_best_int/eng.traineddata.gz` (downloaded once, from jsDelivr; the unpacked file is `eng.traineddata`, 5.2 MB) | Apache-2.0 (tessdata_best) |
| `LICENSE-tesseract.js.md` | 11 KB | `tesseract.js@7.0.0/LICENSE.md` | Apache-2.0 text |
| `LICENSE-tesseract.js-core.txt` | 11 KB | `tesseract.js-core@7.0.0/LICENSE` | Apache-2.0 text |
| `tesseract.esm.min.js.LICENSE.txt` | 149 B | banner shipped with the bundle (bundled `regenerator-runtime`, MIT) | MIT |

**Total: 14,851,987 bytes ≈ 14.2 MB** (dominated by the three wasm builds + the language data).

Notes

- Only the **LSTM** cores are vendored. tesseract.js v7 defaults to `OEM.LSTM_ONLY`, which picks
  `tesseract-core-relaxedsimd-lstm.wasm.js` / `-simd-lstm` / `-lstm` depending on the browser's
  WebAssembly features — all three are here so every browser stays local. The legacy (non-LSTM)
  cores are 12 MB more and the plugin never asks for them; if `configureOcr({ oem: 0 })` is ever
  used, those files have to be added too.
- `eng.traineddata.gz` is the gzipped `best_int` English model (`gzip: true` in `configureOcr`), so
  the worker gunzips it in memory instead of a 5 MB download.
- `configureOcr({ langPath: "…/vendor/tesseract/" })` expects the **directory**; tesseract.js
  appends `eng.traineddata.gz`. `corePath` may be the directory (it then picks the right wasm
  variant) or one exact `.wasm.js` file.
- In Node (tests) the same `eng.traineddata.gz` is read from disk; tesseract.js uses its own bundled
  Node worker + core from `node_modules`, so no network access is needed there either.
- Upgrade steps: `npm i tesseract.js@latest` (which pulls the matching `tesseract.js-core`), copy
  the five files above, then
  `curl -L -o eng.traineddata.gz https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz`
  and re-run `node tests/test-ocr.mjs`.
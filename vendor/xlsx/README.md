# vendor/xlsx — nothing is vendored here (read this before adding SheetJS)

`js/schedule.js` reads `.xlsx` **by itself**, with no third-party code:

- `readZip()` — ZIP central-directory reader (method 0 "stored" and method 8 "deflate");
- `inflateRaw()` — a small RFC 1951 DEFLATE decoder (fixed + dynamic Huffman, 32 kB window);
- a SpreadsheetML reader for `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`,
  `xl/sharedStrings.xml` and `xl/worksheets/sheetN.xml` (shared strings, inline strings,
  cached formula values, sparse cells, blank/merged rows, sheet by index or by name).

**Why not the SheetJS bundle** (as suggested in `AGENTS-OCR-SCHEDULE.md` "Contract 2"):

1. The contract's signature is **synchronous**, `parseSchedule(...) -> {rooms, warnings, ...}`.
   The only browser decompressor, `DecompressionStream`, is async, so a zip-SheetJS-free reader
   needed a synchronous inflate — that is what `inflateRaw()` is (also why no `Promise` leaks
   into the UI code, which imports this module statically).
2. `xlsx.full.min.js` is a **UMD** bundle (~900 kB) that is not importable as an ES module and
   would need a `<script>` tag in `app.html`, plus a global `XLSX` on `window`. The project rule is
   "no build step, everything local, plain ES modules" (`AGENTS.md`), so a plain module that
   imports nothing but `js/calc.js` is the cleaner fit.
3. Only **`.xlsx`** is supported (as the spec says — never legacy `.xls`). A sheet-schedule import
   needs cells, shared strings and sheet names; it does not need styles, dates, charts or
   pivot tables, which is most of what the full library adds.
4. No runtime or licence obligation is added to the static site: everything in `vendor/` here is
   zero bytes of third-party code.

## If you (or a reviewer) prefer SheetJS anyway

SheetJS Community Edition, npm package `xlsx`, **version 0.18.5** (the last version published to
the npm registry; newer builds live on cdn.sheetjs.com), licence **Apache-2.0** — vendors cleanly
into a repo like this one (include `LICENSE` / a `NOTICE` if you ship it). Drop
`dist/xlsx.full.min.js` here and load it with a `<script>` tag, then replace the `readWorkbook()`
call in `js/schedule.js` with `XLSX.read(bytes, { type: "array" })`. The rest of the module
(column detection, units, Room building) is independent of how the cells arrive.

## What is verified instead

`tests/test-schedule.mjs` proves the reader two ways:

- the committed fixture `tests/samples/schedule.xlsx` is written by the test with **real DEFLATE
  streams from node's `zlib`**, and the test also round-trips random/repetitive buffers through
  `inflateRaw()` at zlib levels 0–9 and compares against `zlib.inflateRawSync`;
- the same tests were run against an `.xlsx` produced by an unrelated writer (Python `openpyxl`
  3.1.5, which emits inline strings and no `sharedStrings.xml`) and against a real Excel-produced
  workbook with 4 sheets; both parse correctly (the latter is correctly refused as "not a
  schedule" rather than turned into invented rooms).

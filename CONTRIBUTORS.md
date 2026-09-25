# Contributors

LoadLens is a small, focused tool: read a floor plan PDF (or a scanned sheet, or an
Excel/CSV room schedule), get the room-wise HVAC cooling load. It was built as a
collaboration between its owner and an AI agent working in this repository.

## Project owner

**ratul-sraj** — [github.com/ratul-sraj](https://github.com/ratul-sraj)

- Set the goal and the scope: a cooling-load tool that reads the room tags already drawn in
  a floor plan PDF, in SI units (TR, L/s, m²), for Kerala and Gulf design conditions.
- Supplied real room schedules for verification. The project was developed and verified against
  the synthetic fixture that ships in the repo, `tests/samples/sample-plan.pdf` (3 pages,
  159 room tags, built by `tools/make-sample-plan.mjs`) — the owner's real drawings are
  deliberately **not** in the repository and never published.
- Chose the product name, the deployment target (one repository, no other repos touched), and
  reviewed what shipped.

## Implementation

**Hermes Agent** — [Nous Research](https://nousresearch.com) — `hermes-agent@nousresearch.com`

- Wrote and maintained the code, tests and documentation in this repository: the load engine
  (`js/calc.js`), the PDF reader (`js/pdfparse.js`), the OCR path (`js/ocr.js`), the
  Excel/CSV/TSV schedule reader (`js/schedule.js`), the calculator UI (`js/app.js`,
  `js/report.js`, `app.html`), the pages, the Express server (`server.js`, `lib/`), the deploy
  configs, the tools and the test suites.
- Ran the verification: 7 test suites (182 checks) plus real-browser end-to-end runs driven
  with puppeteer-core against the installed Edge.
- Commits authored or co-authored by the agent carry the trailer:
  `Co-authored-by: Hermes Agent <hermes-agent@nousresearch.com>`

Parts of the implementation were written by parallel subagents running on
`deepseek/deepseek-v4.1-flash` (PDF parsing, the Express server, the UI, the landing pages,
deploy configs, documentation, OCR, schedule import, and an independent check of the load
engine against ASHRAE psychrometric values). Every change was reviewed, tested and merged by
Hermes Agent before it was committed.

## Third-party components

`pdf.js` (Apache-2.0, vendored in `vendor/`), `tesseract.js` and the `eng` traineddata
(Apache-2.0, vendored in `vendor/tesseract/`), Express and multer (MIT, from npm).
See `vendor/tesseract/README.md` for the exact file list and licences.

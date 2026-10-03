# Units: detect what the sheet uses, and show results in metric or imperial

## Why

Real drawings come from both worlds. A Kerala consultancy sheet is metric (areas in m², dimensions
in mm, `SCALE 1:100`); a US client sheet is imperial (areas in ft², dimensions as `12'-0"`,
`SCALE 1/4" = 1'-0"`). Today LoadLens reads either one, computes in SI, and shows some figures in
both systems without ever asking the user which one they think in.

## The two hard rules

1. **The load is always computed in SI.** `js/calc.js` keeps working in W, L/s, m², °C. Everything
   in this feature is a *display conversion of an already-computed result*. No second calculation,
   no different assumptions.
2. **Never let a converted number look original.** Every figure carries its unit (a column header, a
   cell suffix, or the card's own unit label), and the report/CSV state the basis in words. Nothing
   mixes systems inside one table.

## What already exists (do not rebuild)

- `js/pdfparse.js` already reads the unit on an area figure (`m²`, `sqm`, `ft²`, `sft`, `sq. ft` …)
  and converts feet-based areas to m², and already reads dimensions as mm or as feet+inches.
- `js/calc.js` already emits `cfm`, `oaCfm`, `areaSqft`, `sqftPerTr` beside the SI fields.
- `js/units.js` (new, written by the planner) is the single source of truth for factors, units,
  labels and formatting. Read it before writing anything: `air()`, `airUnit()`, `power()`,
  `powerUnit()`, `area()`, `areaUnit()`, `density()`, `densityUnit()`, `areaPerTr()`,
  `areaPerTrUnit()`, `temp()`, `uValue()`, `fmtValue()`, `fmtAir()`, `fmtPower()`, `fmtArea()`,
  `fmtDensity()`, `header()`, `conversionNote()`, `systemLabel()`, `normSystem()`, `K`.

## Detection (what the sheet says it is)

New `js/unitdetect.js`:

```js
export function detectUnits(parseResult) // -> {
//   system: 'si' | 'ip' | 'unknown',
//   confidence: 'high' | 'low' | 'none',
//   evidence: {
//     areaUnits: { m2: n, ft2: n },        // counted from the area figures the parser accepted
//     dims:      { metric: n, feet: n },   // mm/4-digit runs vs feet-inches strings
//     scaleText: { metric: n, imperial: n },// '1:100' vs 1/4" = 1'-0"
//     samples:   [ '3,385 ft²', "12'-0\" x 10'-6\"", 'SCALE 1:100' ]  // max 5, for the UI to quote
//   },
//   reason: 'plain English sentence for the user'
// }
```

Rules:

- `ft²`/`sft`/`sq. ft`/`sf` area figures and feet-inches dimensions are imperial evidence; `m²`/`sqm`
  area figures and mm-style dimensions are metric evidence; `1:100`-style scale text is metric,
  `1/4" = 1'-0"`-style is imperial.
- **High confidence needs agreement**: at least 2 pieces of evidence *and* no contradicting evidence.
  One figure alone is `low`. Nothing at all is `unknown`.
- Contradictory evidence (a sheet with both, e.g. a title block in feet and areas in m²) must be
  reported honestly as low confidence with the counts, **not** resolved by guessing.
- Never throw, never return a system without a reason sentence, never invent evidence.

## The project setting

`proj.units` = `'si' | 'ip'`, default `'si'` in `DEFAULT_PROJECT` (js/calc.js), persisted with the
rest of the state. Existing saved projects without it keep working and read as `'si'`.

Behaviour on loading a drawing: if the user has not chosen a system explicitly in this project,
follow the detection when it says `ip` (and only then), and say so in plain words. If the user has
chosen, the choice wins and detection only *informs* ("this sheet prints areas in ft²").

## What must follow the setting

Rooms table columns, level-wise subtotals, summary cards, the room load breakdown, the printed
report, the printable credit, and the CSV export. Thresholds that are *judgements* (e.g. "dense
load") must compare in SI internally and only be displayed in the chosen system.

## Tests each worker must leave green

- `tests/test-units.mjs` (new): factors and round-trips, formatter honesty (`NaN`→`-`), both systems.
- `tests/test-unit-detect.mjs` (new): metric sheet, imperial sheet, mixed sheet (low confidence),
  sheet with no evidence (`unknown`), and that `reason` is always non-empty.
- `tests/qa/units-ui-probe.mjs` (new, real browser): toggle the setting, assert every visible table
  header/summary card changes unit, assert no `NaN`, and that switching back restores the SI figures
  to the last digit.
- `tests/browser-check.mjs`: add checks for the toggle and the detection line.

## Verification (the planner runs this)

`node tests/test-units.mjs && node tests/test-unit-detect.mjs && node tests/run.mjs &&
node tests/browser-check.mjs` plus the rest of the suite, then commit, deploy, and verify the live
site shows the chosen system.

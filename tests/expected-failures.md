# Expected failures — tests/browser-check.mjs

`tests/browser-check.mjs` is a ~347-assertion real-browser suite. It has long carried a set of
red assertions that were tolerated from memory, which is the worst of both worlds: a suite that always
has reds cannot tell **"still broken"** from **"newly broken"**. This file system fixes that.

The known reds now live in **`tests/expected-failures.json`** (machine-read) and the run is judged by
what *changed*:

* a **failing** check that is **not** listed → the run **fails**, printed as **NEW**
* a **listed** check that now **passes** → the run **fails**, printed as **FIXED REMOVE IT**
* a check listed under `flaky` that fails → counted as **flaky** (tolerated), never as new

Summary line format:

```
329 pass, 18 known, 0 new, 0 fixed
```

Wire-in lives at the foot of `tests/browser-check.mjs`; no dependency beyond `node:fs`, matching the
plain-node style of `tests/run.mjs`. Remove an entry the moment its check passes — the harness will
refuse the run until you do.

---

## Current state (measured on the tree at 2026-11-01, after the js/autotrace.js + js/trace.js fix)

Two consecutive runs, both `329 pass, 18 known, 0 new, 0 fixed`, identical failure sets (exit 0).
Raw logs: `tests/qa/bcheck-run1.log`, `tests/qa/bcheck-run-final.log`.

The 18 reds are **four real causes**, not eighteen bugs.

### Group A — 7 checks — the drawn-rectangle overlay box reads 0×0 in the long geometry block
`a rectangle drawn by dragging is editable by its handles afterwards` ·
`the room just drawn can be found on the drawing by its id` ·
`dragging a room's body moves it on the drawing` ·
`dragging a corner resizes the room` ·
`resizing recomputes the room's area in the table` ·
`middle-drag pans the drawing` ·
`Delete reaches the drawing while the mode radio holds the focus`

In the sequential plan-geometry block (`browser-check.mjs` ~1239–1267 and ~1840–2025) a freshly drawn
rectangle's `.plan-room-box` attributes read `x=0 y=0 w=0 h=0`, so every later gesture is aimed at
`(0,0)` and moves nothing. **The feature works in isolation**: a clean probe measured the drawn box at
`x=139 y=119 280×240`. Verdict: **known, project-documented red group** (docs/ZONE-DETECTION-RESEARCH.md
section 6) — state/timing coupling in that one block, **not** a confirmed product defect. It is not
flaky (identical every run), so it stays in `fails`, not `flaky`.

### Group B — 4 checks — area-fill count moved 21 → 25 (stale expectation)
`the auto-trace status line reports the REAL filled count and reasons` ·
`the filled rooms are marked in the table as coming from the drawing` ·
`Undo says what it put back` ·
`the sample's own fill result is unchanged — 22 of 56 areas measured from the drawing`

The checks hard-code **21** filled areas / 21 badges / `Undone: 21 areas`. The app now fills **25**
(probe: 25 rooms carry an area; status `Filled 25 areas …`), and the reason breakdown changed
(`26 because the name is a fitting inside a room, not a room, 8 because no traced outline contains the
name, 1 because the traced shape did not look like a room` — the old `open to the next space` phrase is
gone). Verdict: **STALE TEST EXPECTATION**, by design. One number, four assertions — update them together.
*(Do not weaken the assertion; change the expected number.)*

### Group D — 2 checks — box→polygon edge drag missed (same family as A)
`JOB2 (iv) an edge-middle drag converts the box into a polygon …` ·
`JOB2 (iv) the status line says the room is now a shape the user can pull`

The drag landed on nothing (`corners 0, shape rect`), so no conversion happened and the follow-up status
line never appeared. The adjacent check on a differently-placed box converts correctly, so the
conversion itself works — same coordinate/state dependence as Group A. Verdict: **state/coordinate
dependent, not systemic**.

### Group E — 4 checks — "Place all rooms" leaves no placed boxes on the real sample
`...and its button is disabled and says it is working, and the bar goes when it ends` (Place all) ·
`25 (a) a room box can actually be dragged in Select/edit mode (the premise of this check)` ·
`25 (b) Ctrl+Z puts the dragged room back EXACTLY where it was …` ·
`25 (c) Ctrl+Z inside a table cell is left to the text box …`

On the real LEVEL 11 sample, "Place all rooms" shows its progress bar and reports success, but **zero**
rooms end up with a `rect`. Probe: `56 rooms, 56 with 'at', 0 with 'rect', 0 with rect.placed === true`.
Because placement sizes a box *back from a room's own area* and the real sample prints **no** areas,
this may be intended — but the checks `315` and `25 (a)`–`(c)` were written for a sample that carried
areas. Verdict: **owner decision — stale expectation vs a real user-visible gap** (the demo drawing ends
up with no draggable room geometry). 25 (b)/(c) are pure cascades of 25 (a)'s failed premise.

---

## Separate stale expectation (not in the JSON)

The demo drawing's load total moved **42.66 TR → 44 TR** (6 rooms that previously had no area now have
one, from the `js/autotrace.js` + `js/trace.js` change). `browser-check.mjs` no longer hard-codes
42.66 TR, so no browser check breaks — but **42.66 appears in prose/docs and must be updated there**.
Left to the owner; not weakened here.

## Ranking the real product bugs (most user-visible first)

1. **Group E** — the demo drawing ends up with no placed room boxes, so nothing on the plan can be
   dragged and Ctrl+Z-on-the-drawing cannot be exercised. User-visible; may be by design.
2. **Group A / D** — after drawing a rectangle, editing it (body drag, corner resize, pan) does nothing
   *inside that long interaction sequence*. Reproducible only in-suite; not confirmed standalone.
3. **Group B** — display/accounting only; the load itself is correct. A stale expectation, not a bug.

Scripts/tools used: `tests/qa/probe-ef.mjs` (raw-state probe). Logs kept under `tests/qa/`.

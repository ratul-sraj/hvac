# Zone detection and scale calibration: research spec

Status: research only. No code has changed. Targets: give at least 75% of the real rooms a zone with a correct area, on BOTH `samples/level-11-floor-plan.pdf` (L11) and the owner's HQ sheet (read only from its local absolute path, never copied into the repo). Constraints: client-side only, deterministic, a few seconds, and the fixture stays at 159 rooms / 363.86 TR.

## 1. Root cause of the "4x"

**The 4x does not come from the PDF. It comes from the scale being a free panel setting that nothing checks against the drawing.** Measured with PyMuPDF (the scratch probes `geom_probe.py` and `hq_scale.py`):

| Check (L11) | Result |
|---|---|
| Page / MediaBox | 1683.8 x 1190.6 pt = **A2** (594x420 mm), no rotation, one page. Made in Illustrator CS6. |
| Text layer | 730 characters: room names, `SCALE 1:100`, `LEVEL 11 FLOOR PLAN`. The only numbers are 1, 100, 11. **No area figure, no dimension.** |
| Area labels drawn as outlines? | No. 128 filled paths, all bars, columns and hatch (for example 44x3 pt x27). There are no glyph-sized clusters, no XObjects and one OCG. |
| Door swings | 16 quarter arcs with radius 23.3-25.0 pt. At 1:100 that is **0.82-0.88 m** (a real door leaf). At 1:200 it would be 1.65-1.76 m (impossible). |
| Chairs | 106 rectangles of 12.2x14.2 / 14.4x16.2 / 14.4x17.2 pt. At 1:100 that is **0.43x0.50 to 0.51x0.61 m**. At 1:200 a chair would be 1 m deep. |
| Footprint | Linework spans 41.1 x 41.3 m at 1:100, which is plausible for one tower floor. |

So on L11 the drawing's geometry, its page size and its own `SCALE 1:100` all agree. The automated 1:100 areas (11.89 m² for TRANSCRIPT ROOM) are the physically consistent ones. The "printed" values in the brief (47.6, 49.4, 24.0, 22.4) are exactly the traced areas × (200/100)² = ×4.00. They are not on the sheet anywhere. They are the app's own measurements taken with the panel at **1:200**. The interactive run (1,269 m² over 19 rooms against 325.6 m² over 18) is the same ×3.9 shift. The "A1 printed to A3" theory is refuted: an A2 sheet whose doors measure 0.85 m at the stated scale has not been reduced.

The real defects, in code:

1. `pdfparse.detectScaleText` only *classifies* `1:100` as metric evidence (`unitdetect.js`). The denominator is never parsed, so the panel scale is a default or a user choice, unconnected to the sheet.
2. Nothing checks the scale geometrically when the sheet has no area labels. `trace.impliedDenom` needs stated areas, and L11 has none. A wrong 1:200 therefore passes silently, giving areas that are present but 4x wrong.
3. On HQ the default is truly wrong. HQ has 3 A1 pages (1684x2384 pt, rotated 90), **no scale text**, 54 printed `x.x m²` figures and 38,969 line paths in two width classes (0.24 / 0.6 pt). Flood-filling from each printed area figure and solving `denom = (72/0.0254)·sqrt(A_printed / A_pt²)` over 108 labels gives a bimodal spread. The densest ±8% window holds 37 labels, centred on **1:249**. Of the rest, 65 are regions cut short by furniture lines (the implied scale is too high) and 6 are leaks. The app's own tracer reports a median of **1:229** over the rooms it reached. At 1:100, every HQ area is 5.2-6.2x too small. That is why 2 of 149 outlines traced, and 78 of 149 once the scale was fixed.

## 2. The method

The pipeline is a ladder. Each rung only handles rooms the rung above refused, and every result carries a `zoneSource` and a confidence.

```
calibrate(page)                                  // js/scalecal.js (new), section 3; runs BEFORE any fill
labels  = classifyLabels(rooms, regions)         // js/labelclass.js (new)
regions = traceRegions(segments, closeGaps=6)    // js/trace.js (unchanged)
for each blank real room R:
  rung1  single-name closed region               -> autotrace.matchRoomsToRegions   (exists)
  rung2  shared region, neck <= 1.0 m            -> splitregion.splitRegion          (exists)
  rung3  portal-closed region                    -> js/portals.js (new) + re-trace of that region
  rung4  area-conserving open-plan partition     -> splitregion (new mode)
  rung5  no trustworthy outline:
           printed area exists -> placed box sized from the printed area (exists; area correct)
           else                -> blank + "draw its shape" (never invent)
```

**(0) Label classification (new `js/labelclass.js`, about 90 LOC). This is the cheapest fix for "several names in one outline".** On L11, 26 of the 56 "rooms" are not rooms at all. They are fittings or zones inside a room: MONITOR ×7, SEATING ×3, ESCAPE ONLY ×3, PRESS/PUBLIC SEATING ×4, WHEELCHAIR BAY ×2, COMMISSIONERS' BENCH ×2, COUNSEL ×2, WITNESS, IN, OUT. A label becomes a **sub-zone** (`parentId`, never assigned an area, never counted in the load) when:

```
isSubZone(L) = lexicon(L.name)                        // fittings, seating, bay, bench, in/out, escape only, monitor...
               && region(L) also holds a label that is NOT lexicon (the parent room)
            || (font(L) < median room font && region(L) holds a larger-font label)
```

When a sub-zone is removed from a shared region and only one real name is left, rung 1 accepts the region whole. A hearing room that holds 12 annotations then gets one area instead of none. Coverage must be reported over real rooms (about 30 on L11). It must also be checked that none of today's 22 fills went to a sub-zone label: an area on "MONITOR" is a wrong area.

**(a) A room open to the next space (rung 3, new `js/portals.js`, about 180 LOC; rung 4 about 60 LOC in splitregion).** The architect's boundary across an opening is the straight line between the two wall ends. The method rebuilds that line instead of guessing one:

```
ends   = free endpoints of wall-class segments (degree 1 after snapping at 0.5 pt), plus column corners
pairs  = (e1, e2) with |e1e2| in [0.6 m, 3.5 m] at the calibrated scale,
         the segment axis-aligned to within 10 deg or collinear with a wall at e1 or e2,
         crossing no wall line and no label box, mutual nearest partner (deterministic: sort by length, then id)
raster those pairs as virtual walls (portal flag) -> re-run regionAt for the still-unresolved names only
accept room iff one real name inside, area in band, and drawnPerimeter / perimeter >= 0.70
  zoneSource = 'portal', boundary words: "closed across a 2.4 m opening"
```

Rung 4 handles a region that still holds several real names after rung 3 (a true open-plan floor). It runs the existing watershed with the neck limit raised to 4 m, and accepts the split only if:

- the outer boundary of the region is at least 85% drawn wall;
- the parts tile the region exactly, so the sum of the parts equals the region area to within 0.5%.

The floor total is then exact by construction, and each part is marked `areaEstimated` ("split along an opening, check"). It counts in the load. If either condition fails, the rooms stay at rung 5.

**(b) One outline holding several names.** In order:

1. Drop sub-zones (step 0).
2. Run the existing seeded watershed with the 1.0 m neck test (rung 2).
3. Close portals and re-split (rung 3).
4. Run the area-conserving partition (rung 4).

Corridors left with no name are still trimmed away as `unnamed-space`.

**(c) When tracing fails entirely** (a scan, or no closed regions):

1. If printed areas exist, keep them (the area is correct) and place a locator box sized from the area. That path exists today.
2. Otherwise, if the scale is known, the user draws the shape (the area follows the ring).
3. Otherwise the area stays blank with `areaUnknown`, plus a two-point calibration prompt.

No rung may write an area at a scale whose confidence is "none".

## 3. Scale calibration that cannot silently be 2x wrong

New `js/scalecal.js` (about 140 LOC, pure). The key fact: region areas in **pt²** do not depend on the scale, so calibration runs on one region pass *before* any accept band or neck test in metres is applied. This removes today's "trace at 1:100, refuse almost everything, then offer 1:229" round trip.

| Estimator | How | Strength |
|---|---|---|
| E1 scale text | Parse N from `1:N` / `SCALE 1:N` (and imperial `1/4"=1'-0"` → 48). Prefer the note nearest the plan's title block. Several different notes mean viewports. | Says what was *intended*, not what was exported. |
| E2 area labels | For each single-name closed region with a printed m²: `N_i = (72/0.0254)·sqrt(A_i/pt²_i)`. Use the **densest ±8% window** (not the median: HQ's median 306 is pulled up by cut-short regions, while the window gives 249). Strong when it holds ≥5 inliers and ≥25% of labels. | Measures exactly the m² we need. |
| E3 object priors | Door arcs (leaf 0.75-1.05 m, mode 0.9), chairs (0.40-0.65 m), WC pans, stair treads (0.25-0.30 m). Each gives a scale band; intersect the bands. | Works on L11 (16 doors → 1:93-1:106), which has no areas. |
| E4 paper sanity | Detect A/ANSI paper size; footprint = page extent × N must be 5-300 m. | Rejection only. |

The decision rule, with agreement meaning within ±7% linear (±15% area):

```
if E2 strong:  N = E2; high if E1 or E3 agrees; else "conflict" (E2 still wins; it is the sheet's own m²)
elif E1 && E3: agree -> N = E1, high;  disagree -> conflict, N = E3 if E3 has >= 8 doors else ask
elif E1 or E3: N = that one, medium ("from the scale note" / "from door sizes")
else:          confidence none -> no automatic areas; ask for two points + a known length
flag ratio(E_a, E_b) within 3% of sqrt2, 2, 2.5 or 4 as "the sheet looks re-plotted at a different size"
```

What the user sees, with every estimate and its evidence on one line:

- High confidence: a quiet line, for example "Scale 1:100 (from the scale note, confirmed by 16 door widths)."
- Conflict: an amber banner, for example "Areas use 1:249, taken from 37 printed room areas. Door sizes say 1:240. The sheet's note says 1:100, which would make every area 6.2x smaller." The banner offers [Use 1:100 instead] and [Measure two points].
- A user-chosen scale that disagrees with E2/E3 by more than 15% keeps the same banner. That is the exact case that produced the 4x areas.

Every measured area stores `scaleDenom` + `scaleSource`, and the report prints both.

## 4. Verification

A new probe, `tests/qa/zone-accuracy.mjs <pdf> [--truth file.json] [--blank-printed]`, runs the same functions in Node, the way `autofill-probe.mjs` does. It prints one row per drawing:

`rooms  realRooms  subZones  filled  correct(<=10%)  WRONG(>15%)  coverage%  medianErr%  scale(N, source, confidence)  ms`

- **coverage %** = correct ÷ realRooms (also printed ÷ all labels, so the sub-zone step cannot inflate it unseen).
- **Ground truth, by drawing:**
  - HQ: the printed m² figures. `--blank-printed` hides them from the fill and compares afterwards. The probe reads the PDF from `C:/Users/Aorus/Downloads/HEADQUARTERS FLOOR DUCTING.pdf` and writes only counts. The 149 rooms are its denominator.
  - Fixture: blank all 159 areas and compare against the printed ones (the existing `split-accuracy.mjs` gate is WRONG = 0).
  - L11: has no printed areas. Its truth is `tests/truth/level11.json`: hand-drawn rings for its ~30 real rooms, stored in **pt²** so the truth does not depend on the scale. Separately, the probe asserts that the scale chosen is 1:100 ± 7% from E1 + E3.
- **Gates:**

  | Drawing | Coverage | WRONG | Scale |
  |---|---|---|---|
  | L11 | ≥ 23 of ~30 real rooms | 0 | 1:100 ± 7% |
  | HQ | ≥ 112 of 149 | ≤ 2% | within 7% of the E2 window |
  | Fixture | ≥ baseline | 0 | 1:100, and the unchanged parse still gives 159 rooms / 363.86 TR |

  Every run must finish in under 5 s per drawing.
- **Commands:** `node tests/qa/zone-accuracy.mjs samples/level-11-floor-plan.pdf --truth tests/truth/level11.json`, then the HQ path with `--blank-printed`, then `tests/samples/sample-plan.pdf --blank-printed`.

## 5. Implementation steps (cheapest first)

1. **The `zone-accuracy.mjs` probe and the L11 truth file** (about 150 LOC + 30 rings). Without it, no later step can be judged.
2. **Calibration pre-pass**:
   - the `1:N` parse in `pdfparse.js` (about 20 LOC);
   - E1/E2/E3 plus the decision rule in `js/scalecal.js` (about 140 LOC);
   - the banner and auto-applying the scale in `app.js` (about 50 LOC).

   **This is the biggest single correctness and coverage win on HQ**: 2 → about 78 of 149 with no click, and the 4x / 6x silent errors become impossible. It replaces the one-click offer as the default path (keep the button as an override).
3. **Label classification** (`js/labelclass.js`, about 90 LOC, plus a 10 LOC hook in `autotrace`). **This is the biggest single coverage step on L11**: it removes 26 annotation labels from the 33 `shared` refusals and lets whole rooms that hold annotations pass rung 1. Expected L11 result: about 20-24 of ~30 real rooms. This is an estimate until step 1's probe measures it.
4. **Portal closing** (`js/portals.js`, about 180 LOC, plus 30 LOC in `trace.js` to raster flagged segments). This targets the `open-plan` refusals on L11 and the 71 unmatched rooms on HQ.
5. **Area-conserving open-plan partition** (about 60 LOC in `splitregion.js`, with the `areaEstimated` words in app.js `FILL_REASON_WORDS`).
6. **Two-point calibration UI** for sheets with confidence "none" (about 80 LOC, in app.js / overlay).

Re-run all three probe rows after every step. A step that raises coverage while WRONG > 0 is reverted, not tuned.

## 6. Status after the first implementation pass (measured, 14 Oct 2026)

Landed and measured - **scale calibration** (spec step 2) and the **label classifier module**
(step 3's module, `js/labelclass.js`):

| Drawing | real rooms | traced-correct | WRONG | scale chosen | runtime |
|---|---|---|---|---|---|
| `samples/level-11-floor-plan.pdf` | 30 | 21 (70%) | 0 | **1:100 (E1+E3, high)** | ~1.1 s |
| `tests/samples/sample-plan.pdf` (fixture) | 159 | 105 | 0 | 1:101 (E2, high) | ~5.5 s |
| the owner's HQ sheet | 145 | 50 + the rest from the sheet's printed figures | 0 | 1:228 (E2, conflict) | ~6 min (probe) |

The 4x silent error is gone: the scale is read off the sheet, and a disagreement between the three
estimators can no longer pass without a banner. The fixture's 159 rooms / 363.86 TR are unchanged.

**Step 0/3 is NOT wired into the app.** `js/labelclass.js` is used by the probe only. Two app-side
attempts were measured and reverted, and the reasons are the useful part:

1. Passing its sub-zone ids to the filler (`matchRoomsToRegions`, `options.subZoneIds`) moved the
   sample's own fill result from 22 areas to 24 - and the two extras were annotation labels - while
   five trace-progress checks in `tests/browser-check.mjs` went red. Reverted.
2. Refusing fitting-named results inside the outline pass missed the target: `IN` receives its area
   from the FILL path (`room.areaFromDrawing === true`, `areaSource: 'drawing'`), not from the tracer.

**Open defect, with a probe that reproduces it:** in the app, three annotation labels still carry an
area on the sample - `IN` 11.06 m2 (no outline at all, a box sized from its own area) and
`COMMISSIONERS' BENCH` x2 (28.57 / 29.76 m2) - `node tests/qa/app-annot-areas.mjs`. Note the last two
are the regions of real rooms, so the risk there is a room counted under a fitting's name, not double
counting. The fix is step 0 done properly: mark the labels once with their parent room and have every
path (place, trace, fill, load) skip them, rather than a hook per path.

**The last 5% of coverage on the sample** (21 of 30 vs the 75% goal) is the `open-plan` rung: 8 of the
9 rooms with no area are refused for exactly that reason. Relaxing the split's neck limit or widening
`closeGaps` makes it WORSE (21 -> 18 fills, and 6-8 WRONG areas), so the real portal-closing method is
required - it is not a tuning problem.

**The verification probe lives at `tests/qa/zone-accuracy.mjs`** (gitignored: local tooling, by the
repo's convention) with its ground truth in `tests/truth/level11.json` (committed). Run it with
`node tests/qa/zone-accuracy.mjs samples/level-11-floor-plan.pdf --truth tests/truth/level11.json --split`.

### 6.1 The browser suite after this pass

The suite had been aborting part-way (`Cannot read properties of null (reading 'textContent')` in its
own `pickRow`), which silently hid every check after it. Fixed, and that is why the later sections
now run at all. Also fixed in the suite, each for a measured reason:

- **A coordinate click on a plan-panel button landed on the sticky NAV.** The plan panel is taller than
  the window once the scale line is shown, so centring it left the toolbar above the top edge
  (`#planTraceOutlines` at `y = -21`, `elementFromPoint` answering `wrap nav-inner`); the click
  navigated the page away and five checks then read an empty state. All 61 plan-button clicks now go
  through `clickPlanButton`, which scrolls the button into view, clicks it with the mouse when it is
  genuinely clickable (so focus still moves - one check depends on that) and clicks it in-page
  otherwise. Relatedly, every `#planView` centring call became `bringPlanOnScreen` (top-align, clear
  the sticky header).
- **The pager span can be detached mid-render**, so the current page is now read from
  `state.project.planPage`, the app's own source of truth.
- **`js/app.js`: the area filler no longer hides the scale line.** It ran right after the automatic
  trace, so the message the calibration had just put on screen (a corrected scale, say) vanished
  immediately - a correction the user was never told about. The line is cleared where it belongs:
  clearing the trace, and a different drawing.
- **JOB1's scale-fix checks** were modernised: they cleared nothing, and the tracer now SKIPS a room
  that already has an outline, so a re-trace after changing the scale examined nothing and could not
  notice the mismatch. They clear the outlines first now.

**Still red, and named (10 checks; the suite reports 326/336 and now runs to the end).** Seven are in
the "move, resize, delete and pan a room on the drawing" section, which aims its drags from a stored
`#planView` rect plus fixed pixel offsets: they report `box {"x":0,"y":0,"w":0,"h":0}` /
`area 94.24 -> 94.24`, i.e. the gestures do not land on the room the section thinks it drew. Clearing
the rooms' geometry first (the device the earlier drawing checks use) made it WORSE - `box null`, then
a throw that aborted the run - so that section needs its drag points derived from the plan's own
fractions the way the other section does, not from `p0` plus pixels. Two more are JOB2 (iv)'s
edge-middle drag, the same problem in miniature. The last is JOB1 (iii): after the one-click fix has
been used the control correctly does not return, but the status line does not mention the scale the
outlines point to, so the check's second half fails - a one-line status gap in `js/app.js`, not a
behavior regression. **No area or scale assertion is among the ten: the node suite is 30/30, the probe
numbers above are unchanged, and JOB1 (i) and (ii) pass again now that the app tells the user it
corrected the scale.**

### 6.2 Fittings out of the load — DONE (14 Oct, evening)

`js/labelclass.js` is now wired into the app on BOTH paths (the outline pass and the area fill), and
its two-pass rule was completed: pass 1 (a fitting sharing a region with a room label) plus pass 2 (a
fitting alone in its own region whose region sits INSIDE a room's region — the case the tracer's own
splitting creates, and the one that let "IN" and two "COMMISSIONERS' BENCH" rows carry real areas).

The wiring had to give the classifier the page's WHOLE region set. Handing it only the regions the
tracer had matched to a room found nothing at all — measured in-app: `rooms 24, regions 23, sub 0` —
because a fitting sitting in a region of its own is never in that list. The winning line class is now
re-traced once for its regions, and only when the page actually carries a fitting-like word, so a
normal plan pays nothing.

Verified in the app (`node tests/qa/app-annot-areas.mjs`, which loads the real sample through the
app's own automatic setup):

| measure | before | after |
|---|---|---|
| rooms with an area on the sample | 24 | **21** |
| annotation labels given an area | 4 (`IN`, 2 × BENCH, + a probe false positive) | **0** |
| classifier verdict in-app | 24 rooms / 23 regions / 0 sub-zones | **56 rooms / 21 regions / 26 sub-zones, 30 real** |

So the ~3.4 TR that was sitting on fittings is now out of the load, and the status line says so
("N names that are fittings inside a room (not a room) were left out of the load"). Node suite 30/30.

### 6.3 The last 9 rooms (the 75% goal) — OPEN, and NOT a tuning problem

On the sample, 21 of 30 real rooms have an area (70%). The 9 missing: 8 are refused `open-plan`
(PUBLIC FOYER, BLACK SATURDAY GALLERY, SECURITY, LOBBY, PUBLIC LIFT LOBBY, ANNEXE, HEARING ROOM, one
COURT OPERATOR) and 1 is `bad-area` (the other COURT OPERATOR).

What has been MEASURED on this, and each one reverted:

| attempt | result |
|---|---|
| relax the split neck limit (`NECK`) | 21 -> 18 fills, and wrong areas appear |
| global gap-closing (`CGAP`) | 21 -> 18, small rooms lose area to big neighbours |
| open-plan rung 4 (`OPM`) opt-in | worse, 3 small rooms leaked into neighbours |
| watershed "sibling carve" attribution (a delegated worker, 27 min) | 21 -> **8** fills |
| portal-closing gate: a part whose outline is mostly the drawing's OWN WALL may accept a cut face wider than a door (`wallFrac >= 0.5`) | 21 -> **18**, 0 wrong |
| ...plus a membership fix (a room belongs only to its own part) | 21 -> **10**, 0 wrong |
| the portal gate AND the sibling membership rule together (the order this document recommended) | 21 -> **10**, 0 wrong |

**The recommended order was tried, and it does not work either.** The sibling rule alone is a measured
no-op (21 -> 21, which is why it looked safe), but with the gate switched on the pair lands on the SAME
10 the blunt owner rule produced - the membership fix costs far more than the gate gains, and the two
interact. Reverted: baseline is 21 of 30 real rooms (70%) with 0 wrong, node suite 30/30.

**What that rules out, for whoever tries next:** every saving so far has come from a change that only
removes area from the load (fix #1: fittings), and every attempt to ADD area has lost some instead.
Do not tune the neck, the gap, the wall-fraction or the membership rules again - each has now been
measured at least twice. A part can only be added safely when its outline is verified against the wall
NETWORK (a part whose outline is one closed opening away from being a wall-bounded room), not against
the matcher's bookkeeping.


Every one of them trades real coverage or accuracy away, which is the spec's own stop rule. The
existing machinery (`js/splitregion.js` cuts a shared region at a "neck" of at most `NECK_MAX_M` = 2 m)
is the same knob the first two attempts turned. The remaining 8 rooms are genuinely open — lobbies and
a gallery that run into each other — and closing their portals means finding the free wall ends and
joining the right pair, then proving the result does not steal a neighbour's area. That is its own
piece of work with its own measurement harness, not a parameter.

**The one lead worth keeping from the carve attempt** (its last thought before it was stopped, kept in
`C:/Users/Aorus/AppData/Local/hermes/cache/delegation/live/deleg_8127f090/task-0.log`): the watershed
hands the OWNER region each SIBLING's own anchor, so every sibling's part comes back as a boundary
sliver rather than a room. Its conclusion was that the owner region must geometrically exclude a small
disk at every sibling anchor before attributing. That is a concrete next step for `attributeOpenPlan`,
and it is untested - the run was stopped before it could measure it. Its work-in-progress is saved in
`git stash` (`worker WIP: portal-closing`), not on the branch.

**Why the portal gate cost rooms, which is the real finding.** `js/autotrace.js` decides per REGION by
counting how many room NAMES fall inside that region's outline; more than one and it is refused as
`shared`. Closing a portal changes that arithmetic: the closed part's outline can enclose a SIBLING's
name, so the region reads as two names and BOTH rooms are refused — measured as exactly three correct
rooms (EMERGENCY EXIT, SECURE STORE, SOUND LOBBY) losing their areas while nothing gained. The gate
itself is sound (it measures how much of a part's boundary is drawing vs cut face, which is the honest
test for "this opening was closed"), but it cannot be switched on before the membership rule is made
robust on its own, measured on its own, with no gate involved. That is the right order for the next
attempt: (1) make `shared` counting immune to a room that already owns a part, verify 21 -> 21 with
zero change, then (2) switch the portal gate on and verify 21 -> 23+ with zero wrong. Both steps are
reverted; the baseline is 21 of 30 (70%) with 0 wrong.


## §6.3 Portal-closing — built, measured, OFF  (16 Oct)

`js/portalclose.js` (+ `closePortals` / `portalMaxM` / `portalMinM` on `traceRegions`/`traceRegionsAsync`)
implements the retry this file's earlier ledger called for: find the wall ENDS that frame an opening and
join them, so a space open to its neighbour can still be traced along its own walls. Re-extraction then
yields spaces closed by the drawing's walls plus the join.

MEASURED on the built-in sample (L11, truth 30 real rooms):

| rule | joins found | coverage | WRONG |
|---|---|---|---|
| free wall ends only (a wall that simply stops), up to 6 m | 29, all 0.48-1.29 m (median 0.53 m) - i.e. door-width gaps the existing gap-closer already handles; count does NOT grow as the cap widens | 18/30 | 0 |
| + corner-framed openings (two parallel walls facing each other across the join) | 265-405 depending on the cap | **17/30** at 2 m, **16/30** at 3 m, 16/30 at 4 m | 0 |
| portals off (shipped default) | - | **18/30** | 0 |

So it closes openings honestly - it never produced a wrong area - but on this sheet it costs real rooms
and gains none, which is exactly the trade §6's rule forbids. **It stays off by default**; the default
path is unchanged (node suite 30/30, app 25 rooms with areas / 42.66 TR).

WHY the wide openings around the centre lobby are not found by the strict rule: measured near the lobby
label (page pt 799,596), every wall point within 6 m has **2-4 lines meeting** it - these are corners of
the lift shafts, not free wall ends. In this drawing walls are two parallel lines that turn corners, so
an opening between two spaces is framed by two CORNERS. The corner rule finds them, and that is what
costs the rooms: the same rule also closes openings that a room needs to stay one room.

TWO THINGS WORTH KEEPING FROM THIS:
1. An open area now carries its OUTLINE, not just its area: open areas are applied by the fill path and
   the trace path (the only writer of outlines) drops them, so a "detected" open space used to have a
   figure and no boundary on the drawing (measured: LOBBY polyPoints 0 -> 65). Commit 56aaf03.
2. `splitRegion`'s flood now starts from each space's OPENED CORE instead of the single cell under each
   name, so two pieces meet at the narrowest passage rather than at the equidistant midline. Measured
   NEUTRAL on this sample (all five names in the centre open zone share one core), so it changes nothing
   today - it is groundwork, and it was verified not to change the shipped default.

A room the drawing leaves genuinely open cannot be given a "true" boundary by any of this: the honest
route there is the user's own outline (draw the shape; the area follows it) or the open-area piece as
shipped (counted once, reassignable).

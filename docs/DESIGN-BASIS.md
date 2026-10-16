# The design basis — what this load stands on

A cooling load is a number multiplied out of about twenty assumptions. Until this change the app held
those assumptions as constants in the source, printed a tonnage, and never said where any of them came
from. That is a guess with decimals, not a design document. This document, and `js/basis.js`, make each
figure explicit — and make the app **refuse to total a load built on figures nobody has confirmed**.

## The rule

Every figure is one of three kinds, and it is never nothing:

| kind | meaning |
|---|---|
| `code` | a published requirement — cited with document, table and page |
| `climate` | an outdoor design condition, carrying the station provenance from `js/climates.js` |
| `practice` | engineering practice with **no standard behind it** — allowed, but a human must confirm it, and the report says so in those words |

The summary refuses to total while a figure the result depends on is unconfirmed. One action
("Confirm all practice values") resolves the set, recording the date against each figure. The printable
report then states exactly which figures are cited, which were confirmed as they stand, and which were
entered by hand.

## Verified citations (read from the published documents, not recalled)

Envelope and lighting, **ECBC 2017** (Energy Conservation Building Code, Bureau of Energy Efficiency,
India). Zone = *warm and humid* (Kerala). Page numbers are the printed page and the PDF page of the
official code text.

| figure | value | source |
|---|---|---|
| Roof assembly U | ≤ 0.33 W/m²K | ECBC 2017 Table 4-4, printed p.25 (PDF p.57) |
| Opaque wall U | ≤ 0.40 W/m²K | ECBC 2017 Table 4-7, printed p.26 (PDF p.58) |
| Fenestration U | ≤ 3.00 W/m²K | ECBC 2017 Table 4-10, printed p.27 (PDF p.59) |
| SHGC, non-North | ≤ 0.27 | ECBC 2017 Table 4-10 (warm and humid) |
| SHGC, North (lat ≥ 15°N) | ≤ 0.50 | ECBC 2017 Table 4-10 (warm and humid) |
| WWR (prescriptive) | ≤ 40% | ECBC 2017 §4.3.3 (PDF p.58) |
| VLT minimum | ≥ 0.27 | ECBC 2017 §4.3.3 (PDF p.58) |
| Office lighting power density | 9.5 W/m² | ECBC 2017 Table 6-1, Building Area Method, printed p.64 (PDF p.96) |
| Ventilation | **no rate in the code** | ECBC 2017 §5.2.1 (PDF p.75) requires outdoor air "as per NBC" — the Code states no figure itself |
| Plug loads | **out of scope** | ECBC 2017 (PDF p.36): "the provisions of this code do not apply to plug loads" |
| Summer comfort | 23–26 °C, 30–60% RH | ASHRAE Standard 55 summer office range; ASHRAE Handbook (HVAC Applications) gives offices 24.1–26.9 °C at 50% RH |

Because ECBC delegates ventilation and excludes plug loads, those two figures **cannot** be cited from
the code. The app marks them `practice` and requires confirmation. That is the honest position, not a gap
in this table.

## What the app's own defaults turn out to be

The defaults describe an **existing, conventional** building. They are not wrong for a retrofit — but
they are nowhere near an ECBC-compliant envelope, and the app never asked which one you are loading.

| figure | app default | ECBC 2017 limit (warm-humid) | ratio |
|---|---|---|---|
| Wall U | 2.0 W/m²K | 0.40 | **5×** |
| Roof U | 2.0 W/m²K | 0.33 | **6×** |
| Glass U | 5.8 W/m²K | 3.00 | ~2× |
| Shading | SC 0.6 (≈ SHGC 0.52) | SHGC ≤ 0.27 ⇒ SC ≤ 0.31 | ~1.7× |
| Office LPD | 10 W/m² | 9.5 | ~1.05× |

The panel flags any figure above the code limit on screen, so the choice cannot be made by accident.

## Where the figures actually live

- Project and envelope figures: `DEFAULT_PROJECT` and the settings panel in `js/app.js`.
- Per-room-type figures (occupancy density, LPD, plug load, person sensible/latent, outdoor air per
  person and per m²): `SPACE_TYPES` in `js/calc.js`. Its comment claims "(ASHRAE 62.1)" but no row
  carries a citation, and the rows disagree with each other: office outdoor air is 2.5 L/s·person while
  classroom is 5.0 L/s·person for a similar occupancy. Both are flagged `practice` until verified
  against NBC 2016 Part 9 or ASHRAE 62.1 for the project.
- Outdoor design conditions: `js/climates.js`, per-row `src` + `station`. Rows flagged `indicative`
  (Kerala is one: *"state/province estimate; not a station value"*) are treated as unconfirmed — an
  estimate wearing a place name is the most dangerous kind of default.

## The outdoor design conditions, checked against a station record (added after reading the weather files)

`js/climates.js` carries per-row provenance, and its station row for the state capital is real:
**Thiruvananthapuram 34.2 °C / 26.2 °C, `src: "ASHRAE 2021"`, station "WMO 433710"**. Read against a second
published dataset for the same station:

| source | 0.4% cooling DB | MCWB | note |
|---|---|---|---|
| app row (ASHRAE 2021), Thiruvananthapuram WMO 433710 | 34.2 °C | 26.2 °C | station record, cited in the app already |
| ISHRAE 2014 Data Set, same station | **33.8 °C** | **25.8 °C** | agrees within **0.4 K** — an independent corroboration across two datasets |
| app row for **Kerala** (what a Kochi project resolves to) | 35.0 °C | 28.0 °C | `indicative: true` — *"state/province estimate; not a station value"* |

So the climate leg is not the weak one: where the app has a station row it matches a second published
dataset to within 0.4 K. The gap is a **Kochi** project falling back to the state estimate, 1.2 K hotter and
2.2 K wetter than the nearest station record — and the wet bulb is what drives the outdoor-air load, the
largest single term in this climate. That is exactly what the confirmation gate is for: the estimate is
allowed, but it has to be a decision somebody made, not a silent default.

Downloaded from climate.onebuilding.org (`IND_KL_Thiruvananthapuram.433710_ISHRAE2014.epw`, header row:
*"ISHRAE Data Set; Period of Record 1990-2006; (c) 2014 Indian Society of Heating, Refrigerating and
Air-Conditioning Engineers (ISHRAE), New Delhi"*). The ISHRAE row is a **hotter, drier** design day than
the app assumes by 1.2 K dry bulb and 2.2 K wet bulb — and the wet bulb is what drives the outdoor-air
load, the largest single term in this climate. So the app's default is conservative, but it is not the
figure a Kerala design should be built on.

The same weather files are the basis for the independent cross-check (a sol-air / SHGC calculation driven
by the file's own hourly solar and temperature, compared against the app's engine). The Cochin
Nedumbassery TMYx file (12 years, 2009–2021) reports a maximum dry bulb of **35.6 °C**, which brackets the
app's 35 °C for Kochi — the estimate is not wild, it is simply not a station value.

## The evidence layer — built, and what it measured

**Uncertainty (`js/uncertainty.js`).** Seeded Monte Carlo over fifteen drivers, run on the app's own
engine (0.12 ms per draw, so 10,000 draws is a second or two). On 40 representative rooms — a mix of
office, meeting, cabin, reception and general space, four orientations, a quarter of them under the roof:

```
68.07 TR   (5th-95th percentile 53.70 - 86.04 TR, i.e. +/-24% around the middle)
1. Occupancy density               20.91 TR   23%
2. Outdoor air per person          14.47 TR   16%
3. Infiltration                     9.67 TR   11%
4. Outdoor air per floor area       9.50 TR   10%
5. Glazing fraction                 6.45 TR    7%
...
12. Lighting power density           2.05 TR    2%
13. Opaque wall U                    1.13 TR    1%
14. Fenestration U                   0.86 TR    1%
15. Outdoor design dry bulb          0.47 TR    1%
```

That ranking is the most useful thing this exercise has produced. **The three figures that move the answer
most are the three with no published source in the code** — occupancy density, outdoor air per person, and
infiltration — while the envelope U values that engineers argue about are worth about 1% each in a
warm-humid climate. A project can spend a week justifying a wall U and be wrong by a quarter on how many
people are in the building.

**Area reconciliation (`js/reconcile.js`).** Every room is checked against whatever independent figures
exist, with a 5% tolerance. The measured fact that shapes it: **the LEVEL 11 sample prints no room areas at
all**, so on that sheet *nothing* can be independently checked and the module says so in those words. On
the builder's own 149-room headquarters sheet, which does print 154 areas, the traced figures were
previously measured against those printed figures at a **1.8% median error, 0 disagreements over tolerance**
— that is the strongest verification available on these drawings, because it compares this app's geometry
against the architect's own numbers. A placed box is explicitly **not** treated as agreement: the app sizes
a box *back from* the printed area, so comparing the two compares a number with itself.

**Cross-check (`js/crosscheck.js`).** The same zones and the same basis, worked by a different method:
sol-air temperature and computed solar geometry from a weather file, instead of the engine's tabulated
per-orientation ETD and solar constants, and psychrometric enthalpy instead of fixed latent factors.
Measured on the same 40 rooms:

The design hour is found by running the second method for **every daylight hour of the file and keeping
the hour this building actually peaks** — 14:30 in the Cochin record, dry bulb 33.3 °C, GHI 946 W/m².
(Picking the hour with the highest outdoor *enthalpy* instead lands on a humid 20:30 with zero sun, and
picking the sunniest hour lands on a dry February afternoon: the building decides the design hour, not
any single weather variable. Both traps were walked into while building this, and both are now tests.)

| term | app engine | second method | delta |
|---|---|---|---|
| outdoor air | 56.2 kW | 57.2 kW | **+2%** — two different formulations, one physics |
| infiltration | 34.0 kW | 31.5 kW | −7% |
| glazing solar | 27.3 kW | 32.0 kW | +17% (per-orientation constants vs the sun's real position) |
| glazing conduction | 10.1 kW | 10.1 kW | **0** |
| people / lighting / equipment | 67.5 kW | 67.5 kW | **0** (shared inputs) |
| **roof** | 15.6 kW | 32.9 kW | **+17.3 kW (2.1×)** |
| **wall** | 6.9 kW | 13.6 kW | **+6.7 kW (2.0×)** |
| **total** | **65.49 TR** | **74.03 TR** | **+13.0%** |

The two methods agree on everything except opaque conduction, and that gap is explainable rather than
mysterious: the engine pairs a **high** U value (2.0 W/m²K — an uninsulated 230 mm slab) with a **mild**
effective temperature difference (a fixed 22 K roof ETD). Those two are inconsistent for a dark,
uninsulated roof in full sun: the ECBC-compliant roof (U 0.33) would give ~16 W/m², and an uninsulated
dark roof needs an ETD nearer 40–50 K, not 22. So the engine's opaque load is roughly **half** what a
sol-air calculation gives — which is precisely the kind of figure the design basis exists to force into the
open (`roofEtd` is a `practice` entry, and it is unconfirmed until somebody stands behind it).

**Calibration against meter data (Guideline 14) is NOT possible for these projects** — no energy bills, no
meter logs, nothing measured. The report states that as a gap rather than quoting a validation it does not
have. The metrics it *would* use (NMBE within ±5%, CV(RMSE) under 15% hourly) are named so the gap is
obvious rather than hidden.

## The stamped sheet (js/report.js)

One document now carries the whole argument, in ten sections: the project and design conditions (1-2),
the room-wise load (3), the summary (4), the level subtotals (5), **the design basis with a source and a
status against every figure (6)**, **the per-room area reconciliation with the percentage disagreement
(7)**, **the tonnage as a band with the drivers that widen it (8)**, **the cross-check with its term-by-term
delta and the written explanation of it (9)**, the method notes and a signature block (10).

**And it refuses to issue.** With the basis unconfirmed the export produces a one-page document that says
`This report is NOT ISSUED`, prints no tonnage anywhere, and lists every outstanding figure with what is
missing and how to fix it. Verified in a real browser (11 checks, including that no number of the form
`N TR` appears in the withheld document) and in the node suite (16 checks).

### What it measured on the level-11 sample

| | |
|---|---|
| total cooling load, this tool | **42.66 TR** |
| the same building, second method | **51.21 TR** (+20.0%) |
| design hour used | 16:30, dry bulb 32.4 °C, GHI 662 W/m² |
| band (5th-95th percentile, 10,000 draws) | **35.65 - 55.46 TR** |
| area reconciliation | **nothing checkable** — this sheet prints no room areas |

The cross-check's 20% sits almost entirely in two terms: **solar through glazing** (30.1 kW against 48.8 kW,
+62%) and **opaque walls** (7.5 kW against 17.0 kW, +128%). Everything shared agrees exactly (people,
lighting, equipment, glazing conduction), and the outdoor-air term — worked as sensible+latent factors on
one side and as an enthalpy difference on the other — agrees within 2%. The glazing gap is the tabulated
per-orientation solar constant (one peak value per compass point, whatever the hour) against the sun's real
position at the design hour; the wall gap is the fixed ETD against a sol-air temperature. Both are named in
the report's own words, because a 20% gap that is explained is a design decision and a 20% gap that is not
is a liability.

## What is still not here

- The geometry itself is not reconciled by an independent engine: a second implementation of the *tracing*
  (not the load) is the remaining piece of WS2.
- No meter data exists for any of these buildings, so the Guideline 14 metrics remain uncomputed — stated
  as a gap in every report rather than assumed away.

# Independent verification of the HVAC cooling-load engine (`js/calc.js`)

Checker: independent subagent. **No project file was edited.** Scratch evidence lives only in
`tests/verify/`. Reproduce everything with:

```
cd D:/webhvac && node tests/verify/check-calc.mjs     # 52 checks, exit 1 if any BUG
```

Reference data used for the psychrometrics: an independent implementation of ASHRAE
*Fundamentals* (2017) eq. 6 saturation pressure over water (Hyland–Wexler, ±0.1 %) plus the
ASHRAE adiabatic-saturation humidity-ratio equation; cross-checked against published chart
values (35 °C DB / 28 °C WB → W = 0.0211; 24 °C / 50 % → W = 0.0093; 30/60 % → 0.01604;
40/50 % → 0.02352; saturation Ws(20 °C) = 0.01476, Ws(35 °C) = 0.03662).
Web access was unavailable (search backend returned 403), so solar/ETD tables could not be
checked against a fetched ASHRAE table — that is stated explicitly where it matters.

Note: `js/app.js` contains **no second load formula** — every screen, CSV and report value
comes from `js/calc.js`, so there is a single source of truth.

## 1. Psychrometrics

| item | engine value | hand-checked value | verdict | suggested fix |
|---|---|---|---|---|
| `pws` (Magnus, calc.js:95) 0–40 °C vs ASHRAE Hyland–Wexler | 4.2367 kPa @30 °C (worst −0.26 %) | 4.2469 kPa | OK | none (Magnus bias is <0.3 %, immaterial) |
| `wFromDbWb(35, 28)` | 0.021055 | 0.021112 (HW) / 0.0211 (chart) | OK | none (−0.27 %) |
| `wFromDbWb` at 33/27, 46/29, 43/24, 30/25, 24/17.1, 20/15 | 0.02007/0.01829/0.01086/0.01791/0.00931/0.00855 | HW: 0.02013/0.01835/0.01090/0.01795/0.00934/0.00857 | OK | worst deviation −0.42 %, well inside the ±1 % budget |
| `wFromDbRh(24, 50 %)` | 0.009276 | 0.009299 (HW) / 0.0093 (chart) | OK | none |
| `wFromDbRh` at 30/60 %, 40/50 %, 26/55 % | 0.016005/0.023488/0.011537 | HW: 0.016041/0.023517/0.011565 | OK | none (−0.12 … −0.25 %) |
| `rhFromDbW(24, w(24,50))` round trip | 50.000 % | 50 % | OK | exact |
| `rhFromDbW(35, w(35,28))` | 59.06 % | 59.1 % (chart RH for 35/28 WB) | OK | none |
| saturation round trip `rhFromDbW(30, w(30,30))` | 100.00 % | 100 % | OK | none |
| pressure used internally | hardcoded `P = 101.325` kPa (calc.js:94) | see altitude item (§5) | SIMPLIFICATION | fine for Kochi (sea level); for the listed high-altitude cities either compute P from elevation or say "sea level" in the UI |

The ASHRAE adiabatic-saturation formula (`calc.js:99`) uses the correct constant set
(2501, 2.326, 1.006, 1.86, 4.186) and `wSat`/`wFromDbRh` use the correct 0.621945 ratio.

## 2. Heat-transfer factors

| item | engine value | hand-checked value | verdict | suggested fix |
|---|---|---|---|---|
| sensible `1.23 × L/s × ΔT` (calc.js:169,178) | 1.23 | 1.006 × ρ(24 °C) = 1.195 (−2.9 %); 0.33 W/m³h × 3.6 = 1.188 | OK | 1.23 is the standard Indian/Carrier value and is mildly conservative; keep |
| latent `3010 × L/s × ΔW` (calc.js:174,179) | 3010 | 2501 × 1.2 = 3001 (+0.3 %) | OK | none |
| TR divisor (calc.js:190,193,209) | 3517 W | 3516.85 W | OK | none |
| CFM = L/s × 2.11888 (calc.js:192) | 2.11888 | 1/0.000471947 = 2.118882 | OK | exact |
| ft² = m² × 10.7639 (calc.js:193,206; report.js:42) | 10.7639 | 10.76391 | OK | exact |

## 3. Method items (units, missing/duplicated terms)

| item | engine value | hand-checked value | verdict | suggested fix |
|---|---|---|---|---|
| Glass solar `A × SOLAR[o] × SC` (calc.js:159) | 9 × 470 × 0.6 = 2538 W | 2538 W | OK (arithmetic) | see caveat below |
| Glass conduction `A × U × ΔT` (calc.js:160) | 9 × 5.8 × 11 = 574.2 W | 574.2 W | OK | none |
| Wall `A_net × U × ETD[o]` (calc.js:161) | 21 × 2.0 × 15 = 630 W | 630 W | OK | ETD must **not** have ΔT added — the table is sol-air-type (W 15 K > ΔT 11 K); keep as is and state in the note that ETD already includes the base ΔT |
| Roof `A × U × roofEtd` (calc.js:162) | 100 × 2.0 × 22 = 4400 W (44 W/m²) | 4400 W | OK | none |
| Partition `A × U_part × (ΔT−3)` (calc.js:163) | 0 W by default (area defaults to 0) | 0 W | SIMPLIFICATION | internal/partition area is not defaulted, so partition gain is silently absent unless the user types the area; either default it to the remaining wall area or show it as "not included" |
| People sensible/latent (calc.js:165,173) | 10 × 75 = 750 / 10 × 55 = 550 W | same | OK | none (ASHRAE office values) |
| Lighting `A × W/m²` (calc.js:166) | 100 × 10 = 1000 W | 1000 W | OK | units match the UI header ("Light W/m²"); 10 W/m² is conservative for LED |
| Equipment `A × W/m²` (calc.js:167) | 100 × 15 = 1500 W | 1500 W | OK | 15 W/m² is at the top of normal office plug loads; not 2× off |
| Infiltration flow `ACH × V × 1000/3600` (calc.js:168) | 0.5 × 300 → 41.67 L/s | 150 m³/h ÷ 3.6 = 41.67 L/s | OK | units correct (m³/h → L/s) |
| Infiltration sensible `1.23 × L/s × ΔT_full` (calc.js:169) | 563.7 W | 0.33 × 150 × 11 = 544.5 W (+3.5 %) | OK | equivalent method; full ΔT is correct for infiltration |
| Infiltration latent (calc.js:174) | 1477.2 W | 0.05 kg/s × 2501 × 0.011779 = 1473 W (+0.3 %) | OK | none |
| Floor gain | 0 W | 0 W (correct for a mid-floor slab on conditioned space) | SIMPLIFICATION | no on-grade/ground-floor slab term exists; acceptable for offices, flag if ground-floor rooms are calculated |
| Fan heat / duct gain / diversity | not included | — | SIMPLIFICATION | explicitly disclosed in the report notes (report.js:364-365) — acceptable |
| Supply air `rsh/(1.23 × ΔT)` (calc.js:184) | 972 L/s = 2060 CFM | 972 L/s (standard room-sensible method; correct — the OA load is picked up at the coil, not in the room) | OK | none; the fan/duct term is disclosed as excluded |

**Glass-solar caveat (unverified against a fetched table):** `SOLAR` (calc.js:48) is labelled
"already includes storage effect ~CLF", but the magnitudes (W 470, H 650, N 110 W/m²) are
maximum *instantaneous* SHGF values for ~10° N, not CLF-discounted cooling loads. If so, glass
solar is conservative by roughly the CLF (0.6–0.9) → for the test room ~500–1000 W, i.e. 3–5 %
of the total. Direction of error is safe. Also, the table has S (130) > N (110) although at
~10° N the summer sun passes north of the zenith (north walls take direct noon sun in the
design month) — the two entries look inverted, but the absolute difference is small.

## 4. Sanity room — 100 m², 10 × 10 × 3 m, top floor, west, defaults

Every component reproduced by hand from the code's own inputs; the engine matches to the watt.

| component | engine (W) | hand-checked (W) | verdict |
|---|---|---|---|
| Glass — solar (9 m² × 470 × 0.6) | 2538.0 | 2538.0 | OK |
| Glass — conduction (9 × 5.8 × 11) | 574.2 | 574.2 | OK |
| External wall (21 × 2.0 × 15) | 630.0 | 630.0 | OK |
| Roof (100 × 2.0 × 22) | 4400.0 | 4400.0 | OK |
| Partition | 0.0 | 0.0 | OK (default 0 — see §3) |
| People sensible (10 × 75) | 750.0 | 750.0 | OK |
| Lighting (100 × 10) | 1000.0 | 1000.0 | OK |
| Equipment (100 × 15) | 1500.0 | 1500.0 | OK |
| Infiltration sensible (1.23 × 41.667 × 11) | 563.7 | 563.7 | OK |
| Room sensible subtotal | 11955.9 | 11955.9 | OK |
| People latent (10 × 55) | 550.0 | 550.0 | OK |
| Infiltration latent (3010 × 41.667 × 0.011779) | 1477.2 | 1477.2 | OK |
| Room latent subtotal | 2027.2 | 2027.2 | OK |
| Safety +10 % → rsh / rlh | 13151.5 / 2230.0 | 13151.5 / 2230.0 | OK |
| OA flow 10 × 2.5 + 100 × 0.3 | 55.0 L/s | 55.0 L/s | OK |
| OA sensible (1.23 × 55 × 11) | 744.2 | 744.2 | OK |
| OA latent (3010 × 55 × 0.011779) | 1949.9 | 1949.9 | OK |
| **Total** | **18075.6 W = 18.08 kW = 5.139 TR** | 18075.6 W = 5.139 TR | OK |
| Supply air | 972.0 L/s → **2060 CFM** | 972.0 L/s → 2060 CFM | OK |
| Area/tonne | **209.4 ft²/TR** | 1076.4 ft² / 5.139 TR = 209.4 | OK |
| Room SHF = rsh/(rsh+rlh) | 0.855 | 0.855 (grand SHF incl. OA = 0.728) | OK |

**No component is 2× or 0.5× off.** Load split: roof 24 %, glass solar 14 %, equipment 8 %,
people 7 %, lighting 6 %, infiltration 12 %, safety 9 %, fresh air 15 %.
209 ft²/TR sits at the heavy end of the 200–400 ft²/TR band, which is exactly what a west-facing
top-floor office with 30 % glazing and 5.5 L/s per person of fresh air should give — plausible.

## 5. Order of operations, double counting, aggregation

| item | engine value | hand-checked value | verdict | suggested fix |
|---|---|---|---|---|
| `shf = rsh/(rsh+rlh)` (calc.js:191) | 0.855 | 0.855 = room SHF (0.728 if OA is included) | OK | definition is the standard *room* SHF; label it "Room SHF" (UI/CSV/report currently say "SHF") so nobody compares it with a coil SHF |
| Safety 10 % on room sensible+latent, OA added afterwards (calc.js:181-183) | sf = 1.1 on room loads only | same | OK | defensible order; no double counting, and the supply CFM therefore carries the safety factor |
| Infiltration **and** ASHRAE-62.1 fresh air both counted | 12.4 % of the total | ASHRAE practice is to use the larger of the two, not the sum | SIMPLIFICATION | conservative by ~2.2 kW (12 %) on this room; document it (the notes mention infiltration generically) |
| Double counting people latent / infiltration latent / OA latent | none — three independent sources | none | OK | none |
| Totals: `area`, `tr`, `cfm`, `sqftPerTr`, `areaSqft` (calc.js:200-211) | 230 m² / 10.109 TR / 244.9 ft²/TR | 230 m², Σ room TR = 10.109, 230 × 10.7639 / 10.109 = 244.9 | OK | only included rooms counted, non-AC rooms still shown per-room but excluded from totals |
| Per-level subtotals (report.js:30-47, app.js:456-473) | same include rule; ft²/TR = Σarea_ft² / Σtr | matches project totals | OK | none |
| Report layer arithmetic (report.js:305, 317, 321, 327) | fresh air W = totalW − rsh − rlh = oaSens + oaLat; CFM → m³/s × 0.000471947 | exact | OK | none |

## 6. Real defect found — room classification regex

`calc.js:71` (`NON_AC_WORDS`), applied at `calc.js:143` (`room.include = !NON_AC_WORDS.test(...)`).

| case | engine result | expected | verdict |
|---|---|---|---|
| room named **"Open Plan Office"** | `type = office`, **`include = false`** → dropped from every total | office space must be air conditioned | **BUG** |
| room named **"Open Office"** | `type = office`, **`include = false`** | same | **BUG** |
| "Court Room" / "Court Hall" | `include = false` | courtrooms are normally air conditioned (courtyard is the intent) | likely bug, same line |
| "Office", "Server Room", "Reception", "WORKSTATIONS" | `include = true` | — | OK |
| "Toilet", "Store Room", "Terrace", "Court Yard", "Lift Lobby" | `include = false` | — | OK |

Impact: the room is silently deleted from the room list totals, level subtotals, TR, CFM and the
report — the largest single-answer change of anything found in this review (one 100 m² room =
5.14 TR). `guessSpaceType` (calc.js:87) explicitly maps `/open plan|workstation/` → `office`, so
the two functions contradict each other for the most common Indian office-schedule label.
Note the supplied sample schedule uses "WORKSTATIONS",
"CHIEF OFFICE", "S. MAN. OFFICE", so the existing test suite does not catch this.

Tested fix (drop-in, verified against all cases in the table above):

```js
export const NON_AC_WORDS = /\b(toilet|wc|w\.c|bath|washroom|lavatory|store|storage|shaft|duct|stair|staircase|lift|elevator|corridor|passage|utility|balcony|sit[- ]?out|verandah|veranda|porch|parking|garage|electrical|elec\.|janitor|jan\.|pantry|kitchen|wash|dress|dressing|court\s*yard|terrace|open(?!\s+(plan|office))|void|ramp|drive)\b/i;
```

i.e. replace `open` with `open(?!\s+(plan|office))` and `court` with `court\s*yard`
(keep `terrace`, `void`, `sit-out`, `balcony` for "open terrace"/"open to sky" so those rooms are
still excluded).

## 7. Altitude sensitivity (documented simplification, small net effect)

`P = 101.325` kPa is hardcoded and the 1.23 factor assumes sea-level density, while `COUNTRIES`
offers Bengaluru (920 m), Hyderabad (542 m), Riyadh (612 m), Madinah (639 m), Makkah (277 m).
At Bengaluru (920 m, P = 90.8 kPa) the engine reports W = 0.01160 where the correct value is
0.01362 (−15 %) and uses a sensible factor of 1.23 where 1.07 is correct (+15 %); the two errors
largely cancel in the total (engine 4.289 TR vs altitude-corrected 4.282 TR, +0.17 %; Hyderabad
+0.54 %, Riyadh +0.40 %). So: wrong per component, negligible in the total for these dry
high-altitude cities, and the module is explicitly labelled "sea level". Keep as a documented
limitation (or compute P from elevation if a city elevation field is ever added).

## Verdict

- Psychrometrics, all heat-transfer factors, every component of the reference room, the TR/CFM/ft²
  conversions, the safety-factor order, the SHF definition and all aggregation arithmetic are
  **correct** — 50 of 52 checks match hand calculation to the watt, and the psychrometrics are
  within 0.42 % of ASHRAE Hyland–Wexler.
- The reduced-fidelity items (single peak solar per orientation, ETD instead of hourly RTS, no
  fan/duct heat, no floor gain, infiltration + OA both counted, sea-level constants, no
  partition area by default) are simplifications; most are disclosed in the report notes.
- Exactly **one real defect**: the `NON_AC_WORDS` regex silently excludes rooms whose names
  contain "open" (and, less likely, "court").
# Property-testing findings — LoadLens

**STATUS (after the fixes)**

| # | finding | severity | status |
| --- | --- | --- | --- |
| 1 | a plain three-decimal number is multiplied by 1000 (`num()`) | HIGH | **FIXED** in `js/calc.js` (comma now required for the European form) |
| 1b | the CSV area cell was parsed with `parseFloat`, not the engine's parser | MEDIUM | **FIXED** in `js/report.js` |
| 2 | the rate-limit store can hold `maxKeys + 1` entries | LOW | **FIXED** in `lib/ratelimit.js` |
| 3 | `reconcileAreas()` counts rooms the load excluded | LOW (latent) | **OPEN** — needs a decision, see below |

Verification after the fixes: `node tests/proptest/regressions.mjs` → 8 of 9 assertions pass (the open
one is #3); `node tests/proptest/run.mjs --cases 200` → 42 of 43 properties pass (#3 again);
`node tests/run.mjs` → 47/47.

---

Discovery run following Inanna Malick's *Property Testing with Agent Swarms*
(https://recursion.wtf/posts/agents-and-property-tests/) and the `proptest-praxis` skill: build an
independent reference model + generators, run the software against many generated histories, shrink
failures to a readable repro, then decide contract violation vs. ambiguity.

Everything below was executed. `tests/proptest/regressions.mjs` pins each finding as a deterministic
test (it is deliberately **not** wired into `tests/run.mjs`, which must stay green).

```
node tests/proptest/run.mjs --cases 200      # 43 properties, 39 pass, 4 fail
node tests/proptest/regressions.mjs          # 8 failing assertions = the findings below
```

## Targets and why they were chosen

Complex behaviour with a simple independent oracle, per the skill's priority:

| target | oracle used |
| --- | --- |
| `js/polyshape.js` — ring area, simplicity, vertex edits | shoelace recomputed in the test; convex hull as a guaranteed-simple generator; segment-cross product written separately |
| `js/calc.js` — engine, psychrometrics, `num()` | documented formulas; monotonicity; additivity; hostile-input finiteness |
| `js/reconcile.js` — the 5% area check | the documented `diff <= tol` rule, applied by hand |
| `lib/ratelimit.js` — token bucket | semantic contracts (capacity, truthfulness of `retryAfterMs`, key isolation) — **not** a copy of its formula |
| `js/report.js` — CSV and printable report | a strict RFC-4180 reader written in `lib.mjs`; the basis gate |
| `js/schedule.js`, `js/scalecal.js`, `js/basis.js`, `js/uncertainty.js` | unit conversion, "never invent a denominator", gap/statement consistency, percentile ordering |

Property count: 43 across 8 targets, 200 generated cases each (8,600 executions), plus shrinking.

---

## Finding 1 — HIGH — a plain three-decimal number is multiplied by 1000

**Where:** `js/calc.js`, `num()` — the `else if` dot-thousands branch.

**Contract, from the function's own doc block:**
> `"1.249,3" -> 1249.3   dot is a thousands separator, comma is the decimal point (European)`
> A comma AND a dot where the comma follows the dot means thousands; a lone comma with 1-2 digits
> after it means a decimal comma.

The branch is written `/^-?\d{1,3}(\.\d{3})+(,\d+)?$/` — the comma part is **optional**, so the
European rule fires on values that carry no comma at all.

**Repro (deterministic):**
```
num("0.125")   -> 125
num("2.750")   -> 2750
num("12.345")  -> 12345
num("100.125") -> 100125
```

**Reachable straight from the UI.** `js/app.js:2162` stores a typed cell as the **raw string**
(`room[field] = v`), so typing `12.345` into the area column of the rooms table is enough — no
import needed. The table keeps showing `12.345` (`inp.value = String(room.area)`), the load is
computed for 12,345 m², and `geometryWarnings` sees 12345 as a perfectly sane area, so **nothing
warns**. Height is the only field protected: `normalizeRoom` clamps to 0.5–10 m and says so.

**Impact, measured end to end.** One office, 12.345 m², 4 people, 12 m ext wall, 4 m² glass:

| area as typed | area the engine used | load |
| --- | --- | --- |
| `"12.345"` (string, from a typed cell or an import) | 12,345 m² | **189.11 TR** |
| `12.345` (number) | 12.345 m² | **1.00 TR** |

**190× too high for that room** (not 1000× because the per-person terms do not scale with area).

**And the export contradicted itself:** the CSV row read `area 12.35 m²` (the exporter used
`parseFloat`, which reads the dot as a decimal point) beside `TR 189.11` (the engine used `num()`).
Two columns of the same row disagreed by 190×.

**Fix applied (1b):** `js/report.js` now writes the area cell with `num()`, the same parser the load
used — a `1,249.3` area used to export as `1.00`. Verified: the same row now reads `12.35 m²` and
`1.00 TR`.

**Fix applied** — the European branch now requires the comma it documents:
```js
- else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
+ else if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
```
Trade-off to accept knowingly: `"1.234"` alone then reads as 1.234, not 1234. The doc already
treats a bare dot as the decimal point; Indian schedules print `1,249.3` (comma thousands), so the
bare-dot EU form is the unlikely one. `num("1.249,3")`, `num("1,249")`, `num("12,5")` are unaffected
and still pass.

---

## Finding 2 — LOW — the rate-limit store can hold `maxKeys + 1` entries

**Where:** `lib/ratelimit.js`, `prune()`.

`prune()` computes `excess = buckets.size - maxKeys` and returns when `excess <= 0`. It is called
when `buckets.size >= maxKeys`, i.e. exactly when `excess` is 0 — so it returns, and the insert that
follows overshoots by one. The next key triggers the prune, so the map never grows unbounded; the
bound is just `maxKeys + 1`, not `maxKeys`.

```
createBucket({max:5, windowMs:60000, maxKeys:3}); take("a"); take("b"); take("c"); take("d")
size() -> 4
```

**Fix applied:** `const excess = buckets.size - maxKeys + 1;` (prune for the entry about to be added).

Impact today is one extra ~40-byte entry on a 20,000-entry cap — but the invariant is what a future
caller reasons about, and it costs one character to make true.

---

## Finding 3 — LOW (latent) — `reconcileAreas()` counts rooms the load excluded

**Where:** `js/reconcile.js:101` — `(rooms || []).filter((r) => r && r.include !== false)`.

`include` is **not** a field of a raw room: `calc.js normalizeRoom()` derives it from the room name
(toilets, stairs, shafts, stores, pantries are not cooled). `reconcileAreas` reads the raw field, so
on un-normalised rooms it counts every room.

```
rooms = [{ name: "Stair 2", area: 28.96, areaStated: 29 }]
reconcileAreas(rooms).rows.length   -> 1
calcProject(rooms).totals.rooms     -> 0
```

**Not visible in the app today**, because `js/report.js:418` filters `r.room.include` before calling
it. That is a coupling, not a fix: `reconcileLine()` prints "<n> rooms in the load", so any second
caller — a new endpoint, an MCP tool, a test — silently prints a wrong room count. The module reads
as if it can be called with ordinary rooms, and it cannot.

**Fix options:** filter with the same rule (`!NON_AC_WORDS.test(r.name || "")` when `include` is
undefined), or make the report's pre-filter the documented precondition and assert it.

---

## Investigated and dismissed (not bugs)

- **`reconcileRoom` gap is not symmetric.** 236.58 vs 418.77 reads 77% one way and 43.5% the other.
  Correct by design: the denominator is the sheet's printed figure, and the wording says "measured X
  against the sheet's Y".
- **A non-numeric safety factor falls back to the default (10%), it is not forced to 0.** Documented
  as "a parseable number, clamped to a sane band"; only out-of-range parseable values clamp.
- **`parseAreaValue` rounds to 2 dp**, so `1 ft²` reads 0.09 m² (3% at that size). A display rounding
  choice, not a misparse; a 1 ft² room does not exist.
- **The report refuses to total without a confirmed design basis.** Verified both directions: an
  unconfirmed basis returns the NOT-ISSUED document and prints no tonnage anywhere; with every basis
  figure confirmed it issues and prints exactly the engine's total. This held across 200 generated
  projects — the project's central contract is intact.

## What the suite covers that now passes (39 properties)

Ring area under rotation / reversal / translation / uniform scale; insert-then-remove round trip;
`roundRing` idempotence; convex rings accepted and bowties refused; bbox containment; engine
additivity, order independence, area monotonicity, zero and negative area, safety clamping,
`TR = W/3517`; humid-ratio round trip and wet-bulb saturation; no hostile cell (NaN, ±Infinity,
negative, strings, arrays) can produce a NaN/negative/infinite load or an SHF outside 0–1;
reconcile verdict boundaries and bucket partition; rate-limit capacity, `retryAfterMs` truthfulness
and key isolation; CSV column integrity, name round-trip through a strict reader, no formula-leading
cells, TR column fidelity; unit-labelled area and feet-inches parsing; scale-calibration never
invents a denominator; basis statement/gap consistency; report markup injection and the basis gate;
Monte Carlo percentile ordering and seed reproducibility.

## Notes on the harness itself

Two generator defects were found and fixed while building it — worth recording, because both would
have produced false findings:

1. A ring generated by sorting vertices by angle around a point is simple **unless** two vertices are
   nearly collinear with that point, where 2-dp rounding can flip a razor-thin wedge into a real
   crossing. Replaced with a convex hull, which cannot self-intersect.
2. The first `num()` generator drew areas in `[0.001, 5000]`, which almost never produces a
   three-decimal value below 1 — so the ×1000 bug survived 60 cases and only surfaced when the
   generator was aimed at it. A quiet target is a coverage problem, not a clean bill of health.

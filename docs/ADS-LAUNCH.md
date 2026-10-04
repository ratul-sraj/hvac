# LoadLens — ad launch sheet (Google Search, no video)

**Answer to "do we need video?"** No. The Google Search half is text-only by design, and it is the half
that answers the only question worth paying for: *is this useful to a stranger?* Meta is the half where
video helps — and a screen recording of a utility is not a hook, so that route uses the **static card**
instead: `img/ad-static.png` (1080×1080), built from live app screenshots by `tools/ad-creative.mjs`.

Budget is unchanged from `ADS-PLAN.md`: **Rs 1,100** total, and it is a validation spend, not growth.

## WHY TODAY'S NUMBERS ARE DIFFERENT (the pre-flight fix)

Before any spend, the funnel was read (`node tools/funnel.mjs`):

```
arrived 23 · engaged 8 · worked 3 · converted 0
calc_empty 6   <- 27% of arrivals got a load of zero and left
```

Cause: the default sample (LEVEL 11) prints room NAMES but no AREAS, so the page opened on 0.00 TR and
the visitor was expected to discover a button. Fixed: the app now measures what it can from the sheet's
own outlines **by itself** when a sample arrives with no printed areas — 21 of 56 areas, **20.70 TR**,
with the status line saying where those areas came from. `tests/qa/first-visit-probe.mjs` locks that in
(7/7): a fresh browser, one click, a real number, and **no `calc_empty`**.

Do not spend on traffic until that probe passes — it is the difference between a visitor and a bounce.

## Google Search — exact settings

| Setting | Value |
|---|---|
| Campaign type | Search |
| Networks | **Search only** (Search Partners OFF, Display expansion OFF) |
| Locations | India |
| Languages | English |
| Daily budget | Rs 60 |
| Bidding | Manual CPC, max CPC Rs 20 |
| Match types | Phrase and Exact only — never Broad |
| Campaign name | **`g-oct4`** (fresh: older `g-oct2`/`g-oct3` rows are smoke tests) |

**Negative keywords** (all groups): `job, jobs, salary, course, courses, training, interview, interview
questions, question, questions, mcq, notes, college, teaching, book, pdf download, free download,
download, crack, torrent, excel sheet download, calculator online free download, ppt, assignment, thesis`

**Ads to create** — three hooks from `ADS-PLAN.md`, each pointing at its own tracked URL:

### Hook 1 — straight pitch
- URL: `https://loadlens.net/app.html?utm_source=google&utm_medium=cpc&utm_campaign=g-oct4&utm_content=hook1`
- Keywords: `cooling load calculation`, `heat load calculation`, `hvac load calculation`,
  `cooling load calculator`, `heat load calculation software`, `room wise cooling load`,
  `cooling load calculation from floor plan`
- Headlines: `Cooling Load From a Plan` · `Free HVAC Load Calculator` · `Floor Plan PDF to TR` ·
  `Room-wise TR, W and L/s` · `No Signup, No Third Parties`
- Descriptions: `Read a floor plan PDF or a room schedule. Get room-wise TR, L/s and watts. Free.` ·
  `Cooling load from a PDF plan: room-wise TR, L/s and ft2 per TR. No sign-up.`

### Hook 2 — privacy
- URL: `https://loadlens.net/app.html?utm_source=google&utm_medium=cpc&utm_campaign=g-oct4&utm_content=hook2`
- Keywords: `hvac load calculation software`, `cooling load calculation software`, `hvac design software`,
  `heat load software for engineers`
- Headlines: `Your Drawing Never Leaves` · `Client Plans Stay Private` · `Load Calc in Your Browser` ·
  `Nothing Sent to Third Parties` · `For Consultants and MEP Teams`
- Descriptions: `Everything runs in your browser. Your drawing is never sent to a third party. Free to
  use.` · `Load calculation that keeps client drawings on your own computer. TR, L/s and watts.`

### Hook 3 — design conditions
- URL: `https://loadlens.net/app.html?utm_source=google&utm_medium=cpc&utm_campaign=g-oct4&utm_content=hook3`
- Keywords: `ashrae design conditions`, `ishrae design conditions`, `outdoor design conditions`,
  `design dry bulb temperature`
- Headlines: `ASHRAE 2021 Design Data` · `Design Conditions, Cited` · `132 Cities, With Sources` ·
  `Outdoor DB and WB Values` · `Sourced, Not Guessed`
- Descriptions: `ASHRAE 2021 outdoor design conditions for 132 cities, each with its station.` ·
  `Design dry bulb and wet bulb values, source station named. Free reference.`

## Meta — only if the Google half shows a pulse

Objective Traffic · Rs 100/day × 5 days · Facebook + Instagram feeds only (Audience Network OFF) ·
India · 21-45 · interests: Autodesk Revit, AutoCAD, HVAC, Building information modeling, Mechanical
engineering, Construction engineering, Energy engineering, Facility management.
**Creative: `img/ad-static.png`** (not video). URL:
`https://loadlens.net/app.html?utm_source=facebook&utm_medium=cpc&utm_campaign=m-oct4&utm_content=hook1`

## What only the user can do

1. Open / create the Google Ads account. **Billing needs a card or UPI** — that step is theirs, and the
   account reviews for 1-2 days before ads run.
2. Check the account for a promotional credit before paying anything (Microsoft Ads also does
   matched-spend credits).
3. Say when the account is live, and the campaign can be built inside it.

## Success bar (fixed before spending, so the result cannot be argued afterwards)

- 40+ real ad clicks reaching the site
- at least 20% of them doing something real (loads the sample, parses a plan)
- **3+ sessions reaching an export** (report or CSV) — that is the "useful to strangers" signal
- Miss it with 100 clicks → the page fails in its first 30 seconds; fix that before spending again

Read the result with `node tools/funnel.mjs` (one row per `utm_campaign`, so `g-oct4` reads separately
from any Meta spend).

## Honest expectations

- Rs 600 of Google Search at Rs 15-30/click is roughly 20-40 clicks: a signal, not proof.
- This can never be profitable — the tool is free and there is nothing to sell. It is Rs 1,100 to learn
  whether strangers find it useful.
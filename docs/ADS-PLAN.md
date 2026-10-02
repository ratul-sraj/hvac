# LoadLens — minimal-budget ad validation kit

Budget: Rs 1,100 total. Google Search Rs 600 (Rs 60/day x 10 days), Meta Rs 500 (Rs 100/day x 5 days).

This is a VALIDATION spend, not growth: we are buying an answer to 'is this useful to strangers?'

Read the success bar at the bottom BEFORE spending.


## Before you pay

- Google Ads: check the account for a promotional credit offer. Microsoft Ads has matched-spend credits (spend X, get X, 90-day clock).

- Billing needs a card or UPI. Account review can take 1-2 days before ads start.

- Do NOT start ads until the funnel beacon is deployed (it is queued behind the current build). Without it you learn nothing.

- **Use FRESH campaign names.** Every campaign row already in the log (`ll_validate`, and the
  `g-oct2` / `m-oct2` names below if you have already clicked a link) is a SMOKE TEST from
  building and checking the beacon. If you reuse an existing name your real ad rows are added to
  those test rows and the campaign reads as a mixture. The URLs below already use fresh names —
  `g-oct2` for Google, `m-oct2` for Meta. If either name is already in the log, bump it (e.g.
  `g-oct3`).


## Google Search campaign settings (exact)

| Setting | Value |
|---|---|
| Campaign type | Search |
| Networks | **Search only** — turn OFF Search Partners and Display expansion |
| Locations | India |
| Languages | English |
| Daily budget | Rs 60 |
| Bidding | Manual CPC, max CPC Rs 20 |
| Match types | Phrase and Exact only — never Broad |
| Ad rotation | Optimise, then read after 10 days |


## Negative keywords (paste into the campaign, all groups)

`job, jobs, salary, course, courses, training, interview, interview questions, question, questions, mcq, notes, college, teaching, book, pdf download, free download, download, crack, torrent, excel sheet download, calculator online free download, ppt, assignment, thesis`


## Meta campaign settings (exact)

| Setting | Value |
|---|---|
| Objective | Traffic |
| Budget | Rs 100/day x 5 days |
| Placements | Facebook + Instagram feeds only — **exclude Audience Network** |
| Location | India |
| Age | 21-45 |
| Interests | Autodesk Revit, AutoCAD, HVAC, Building information modeling, Mechanical engineering, Construction engineering, Energy engineering, Facility management |
| Creative | 20-30 s screen recording: sample PDF -> 159 rooms -> 363.86 TR |


## How the tracking link works

Every ad link points straight at **`app.html`**, because `app.html` is the only page that loads the
tracker (`js/usage.js`). A link that lands on the home page instead still works — the home page now
copies the four `utm_*` tags onto its own "Open the calculator" link, so a click-through is
attributed — but landing on `app.html` is the shortest path, and it is what the URLs below do.

For the **Meta** ads, use the same URL with `utm_source=facebook` and `utm_campaign=m-oct2`:

`https://loadlens.net/app.html?utm_source=facebook&utm_medium=cpc&utm_campaign=m-oct2&utm_content=hook1`

(swap `hook1` for `hook2` / `hook3`.) `node tools/funnel.mjs` then shows one row per
`utm_campaign`, so Google (`g-oct2`) and Meta (`m-oct2`) are read separately.


## Hook 1 — straight pitch

**Landing page (with tracking):** `https://loadlens.net/app.html?utm_source=google&utm_medium=cpc&utm_campaign=g-oct2&utm_content=hook1`

**Keywords (phrase/exact):** `cooling load calculation`, `heat load calculation`, `hvac load calculation`, `cooling load calculator`, `heat load calculation software`, `room wise cooling load`, `cooling load calculation from floor plan`


**Headlines** (limit 30)

- Cooling Load From a Plan  (24)
- Free HVAC Load Calculator  (25)
- Floor Plan PDF to TR  (20)
- Room-wise TR, W and L/s  (23)
- No Signup, No Third Parties  (27)

**Descriptions** (limit 90)

- Read a floor plan PDF or a room schedule. Get room-wise TR, L/s and watts. Free.  (80)
- Cooling load from a PDF plan: room-wise TR, L/s and ft2 per TR. No sign-up.  (75)

## Hook 2 — privacy

**Landing page (with tracking):** `https://loadlens.net/app.html?utm_source=google&utm_medium=cpc&utm_campaign=g-oct2&utm_content=hook2`

**Keywords (phrase/exact):** `hvac load calculation software`, `cooling load calculation software`, `hvac design software`, `heat load software for engineers`


**Headlines** (limit 30)

- Your Drawing Never Leaves  (25)
- Client Plans Stay Private  (25)
- Load Calc in Your Browser  (25)
- Nothing Sent to Third Parties  (29)
- For Consultants and MEP Teams  (29)

**Descriptions** (limit 90)

- Everything runs in your browser. Your drawing is never sent to a third party. Free to use.  (88)
- Load calculation that keeps client drawings on your own computer. TR, L/s and watts.  (84)

## Hook 3 — design conditions

**Landing page (with tracking):** `https://loadlens.net/app.html?utm_source=google&utm_medium=cpc&utm_campaign=g-oct2&utm_content=hook3`

**Keywords (phrase/exact):** `ashrae design conditions`, `ishrae design conditions`, `outdoor design conditions`, `design dry bulb temperature`


**Headlines** (limit 30)

- ASHRAE 2021 Design Data  (23)
- Design Conditions, Cited  (24)
- 132 Cities, With Sources  (24)
- Outdoor DB and WB Values  (24)
- Sourced, Not Guessed  (20)

**Descriptions** (limit 90)

- ASHRAE 2021 outdoor design conditions for 132 cities, each with its station.  (76)
- Design dry bulb and wet bulb values, source station named. Free reference.  (74)

## Success bar (decide now, so we cannot fool ourselves)

- 40+ real ad clicks reaching the site
- at least 20% of those doing something real (load the sample or parse a plan)
- **3+ sessions reaching an export** (report or CSV) -> useful to strangers, worth more effort

- Miss it with 100 clicks -> the landing page fails in its first 30 seconds. Fix that before spending again.


## Honest expectations

- Rs 600 of Google Search at ~Rs 15-30/click is roughly 20-40 clicks. That is a small sample; treat it as a signal, not proof.

- Meta will give more clicks (cheaper) but lower intent - it tests your message, not your SEO.

- Ads will never be profitable here: the tool is free and there is nothing to sell. This is Rs 1,100 for a read.


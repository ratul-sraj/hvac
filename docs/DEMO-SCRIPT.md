# LoadLens — 5-minute live demo script

For presenting the project live: to an interview panel, a mentor at the academy, or a colleague.
Everything below is real output from the app running on this PC. Keep the browser at full screen,
zoom 100 %, and have the sample PDF ready (you do not need to hunt for a file — the app downloads
it for you).

**Before you start (30 seconds of setup)**

**The recorded ad** (for ads and for the landing page) is scripted, not hand-recorded:
`bash tools/reel/shoot.sh` records the live site and encodes `infra/.tmp/reel/loadlens-ad.mp4`
(1080×1080, house plan first, then the office sheet). Re-run it after any UI change; it also drops
`still-*.jpg` frames to use as ad images.

```bash
cd D:/webhvac
npm start
```
Open **https://loadlens.net/** — the live copy (or **http://localhost:3000/** if you are running it on
this PC) — and leave the page at the top. If you want to also show the
landing / method pages from a static copy, that is a second terminal with
`python -m http.server 8230 --bind 127.0.0.1` — but the demo below only needs the one page.

Numbers to remember before you speak. **There are two samples** — pick the beat you are doing:

- **Try sample drawing (the default)** loads a **real** CAD sheet, **LEVEL 11 FLOOR PLAN**
  (Wikimedia Commons, **CC BY-SA 4.0**, credit: Vivianwwj — see `docs/SAMPLE-CREDITS.md`). It prints
  **56 room names and no areas**, so it lands as **56 rows, every area unknown, nothing counted, 0.00 TR**
  — and you then give rooms their areas. This is the honest "real drawing" demo; the workflow is
  *area first, then trace*. The exact lines to expect are below.
- **Try a house plan** loads a second **real** sheet, **BALLARAT Waller Estate Floor plan**
  (Wikimedia Commons, **CC BY-SA 3.0**, credit: MichaelScott99). Its rooms are more enclosed, so
  **Fill areas from the drawing** fills **6 of 10** here — the demo beat to use when you want to show
  automatic area-filling actually working. Say plainly that the office floor fills fewer (21 of 56)
  because open-plan spaces merge, and that a blank is deliberate.
- **`app.html?sample=synthetic`** (unadvertised) loads the synthetic 3-page fixture. Its numbers are
  the full-building ones in the table below — use them when you want a finished 159-room load sheet
  rather than a live workflow.

The full-building figures (the synthetic fixture `tests/samples/sample-plan.pdf`):

| | |
|---|---|
| Pages / floors | 3 — Ground Floor, L1 Floor, L2 Floor |
| Rooms read from the PDF | **159** |
| Rooms air-conditioned (included in the load) | **120** |
| Conditioned area | **7,006.8 m²** (75,420 ft²) |
| Total cooling load | **363.86 TR** (1,279,702 W) |
| Supply air | **52,157 L/s**; fresh air **6,995 L/s** |
| Area per tonne | **207 ft²/TR** |
| Load by floor | Ground **154.76 TR**, L1 **106.44 TR**, L2 **102.66 TR** (each includes that floor's fresh-air load) |
| Biggest room | ATRIUM, Ground Floor, 1,249 m² → 34.6 TR, SHF 0.68 |
| Safety factor / assumptions | 10 %; Kochi 35 °C DB / 28 °C WB; 24 °C / 50 % RH inside |

The real-sample figures (**Try sample drawing**, the default):

| | |
|---|---|
| Drawing | LEVEL 11 FLOOR PLAN, SCALE 1:100 — real vector CAD, CC BY-SA 4.0 |
| Rooms read from the PDF | **56** (room names only — the sheet prints **no areas**) |
| Areas known | **0** — every row's Area is blank |
| Rooms included | **0** → total **0.00 TR** (nothing is invented) |
| Parser note | *"Page 1: no printed areas found — 56 room names detected … set each area … then tick its Include box."* |
| Credit line | in the plan panel (section 3): LEVEL 11 FLOOR PLAN by Vivianwwj, Wikimedia Commons, CC BY-SA 4.0 |

---

## The 5-minute script

### 0:00 – 0:30 — the hook (do not touch the mouse)

> "This is LoadLens. It takes a floor plan PDF — the kind of drawing we get from the architect —
> reads the rooms out of it, applies cooling-load theory to each room, and gives you the cooling
> load in tonnes of refrigeration, the supply air in L/s and a room-wise sheet you can hand over.
> Let me show you with a real three-floor building."

### 0:30 – 1:00 — the settings (top of the page, scroll the panel)

**What to do:** point at sections **1. Project and design conditions** and **2. Upload a drawing or
a room schedule**. Click nothing yet.

> "First the design conditions — country, city, outdoor dry bulb and wet bulb. This is Kochi:
> 35 degrees dry bulb, 28 wet bulb. That wet bulb is the important one in Kerala — the gap between
> 35 and 28 is all latent load. Indoor is 24 and 50 % RH. Below that, the construction assumptions:
> wall U 2.0, glass U 5.8 with a shading coefficient of 0.6, roof U 2.0 with an equivalent
> temperature difference of 22 K, infiltration at half an air change, and a 10 % safety factor."

### 1:00 – 2:15 — load the drawing (this is the moment)

**What to do:** click **Try sample drawing**. Wait a few seconds. It loads a **real** drawing —
LEVEL 11 FLOOR PLAN — and the credit line at the foot of the plan panel says exactly whose drawing it
is. The room table fills, but the summary stays at **0.00 TR**, and the notes box says why.

> "One click. This is a real floor plan, from Wikimedia Commons, and it is credited right here at the
> foot of the plan panel under its licence — because it is somebody else's drawing, not ours. The
> reader found **56 rooms**:
> MEETING ROOM, CONFERENCE ROOM, HEARING ROOM, TRANSCRIPT ROOM, a Black Saturday Gallery. But look at
> the total: **zero tonnes**. This sheet prints the room **names** and no **areas** — which is very
> common on a real sheet — so the app will not invent one. Every room is in the table with its area
> blank and left out of the load, and the note says so in plain words: *no printed areas found — 56
> room names detected … set each area … then tick its Include box*."

Then show the honest next step, live:

**What to do:** scroll to section **3. Draw rooms on the plan** (scale **1:100** is already right,
from the sheet's own "SCALE 1:100"). Stay in **Draw shape** and **drag a rectangle** over one room —
say a 5 m by 4 m meeting room. In the chooser, set the shape to that room's existing row. Then tick
**In** on the row.

> "So I give a room its area the way an engineer would — I draw it. Five metres by four, and the app
> measures **20 square metres** straight off the rectangle at one to a hundred and writes it into that
> row. Tick Include and it counts — the total moves off zero. Every other room is the same one
> gesture, or I can type the areas straight from the room schedule."

> "And this is the honest order of operations: get the areas in first — drawn, or typed — and only
> **then** press **Trace real outlines**. Tracing reads the plan's own wall lines and gives a room a
> real outline only when the traced area agrees with the area you stated. It never guesses an area.
> Press it with the areas still blank and it says, correctly, *nothing to trace*."

> **Presenter note — set expectations on tracing.** Auto-trace fills rooms well on enclosed, cellular
> plans (a real house plan gave **6 of 10 rooms, 60%**, with the gap-closing setting the app now uses;
> a small villa plan gave **2 of 10**), but poorly on open-plan floors — **this LEVEL 11 sample fills
> only 21 of 56 rooms (38%)** because its big galleries and lobbies have no walls between them and
> merge into one outline. That is not a setting you are missing. **A blank is deliberate, not a bug:** a
> wrong area would corrupt the load, so the room is left for you to type or draw. Mention this rather
> than hide it — it is the honest answer and it is why the manual ways exist.

**If you want the finished, full-building numbers instead** (159 rooms, 363.86 TR): the synthetic
fixture is still one URL away — open **`app.html?sample=synthetic`**. Those are the 3-page figures in
the table at the top; use them only if you want a ready-made load sheet rather than the live workflow.

**If you have 20 seconds more:** scroll back up, type `35` → `38` in the outdoor dry bulb (Kochi →
Chennai-like) and let them watch the total change. Say:

> "All of this recalculates while I type — the design conditions are live."

Put it back to 35 (or click **Reset to defaults**).

> "Drag for a rectangle, click for an odd shape — same tool."

**If you have 60 seconds more — a room that is not a box (optional).** Keep the mode on **Draw
shape** (it is the same tool you just dragged with) and click the corners of an **L-shaped** room on
the sheet (five or six clicks), then click the
**first corner** again to close it. The chooser appears: leave it on **`(new room)`** for a new room, or
pick an existing row from the list to **give that room the shape**.

> "Real rooms are not rectangles. This room is an L, so I click its corners — one, two, three, four,
> five — and close it on the first corner. See the area: it is the **shape's own** area, not the box
> around it, which would be about a third bigger. And I can hand it to a room the reader already found:
> pick it in this list, and that row takes the shape and the area — the table cell, the totals, the CSV
> and the report all follow it, because that room really is that big now."

### 2:15 – 3:15 — where the number comes from

**What to do:** sort by clicking the **TR** column heading (highest first), then click the **ATRIUM**
row to open **Load breakdown**.

> "This is what I want you to notice. The ATRIUM is 1,249 square metres and 34.6 tonnes — the
> biggest single item in the building. The breakdown shows every component: solar through the
> glass, glass conduction, external wall, roof, partition, people, lighting, equipment,
> infiltration, then the latent part from people and infiltration, then the safety factor, and
> separately the fresh-air sensible and latent load. SHF here is 0.68 — that low value is the
> Kerala humidity: a third of the load is latent, not temperature."

### 3:15 – 4:15 — the deliverables

**What to do:** click **Download CSV**; say what lands in the folder. Then click **Print / Save
PDF report** and let the report window appear (do not print).

> "For the office work there is a CSV — one row per room, plus the project settings in the header —
> that goes straight into Excel. And there is a printable report: design conditions, all the
> assumptions written down, the room-wise table, the load summary, the floor-wise subtotals, and an
> 'Important notes' section that says in plain words this is a handbook-level estimate that an
> engineer must check. The project can also be saved as a JSON file and re-opened on another
> machine."

And at the very foot of that report — and on the last line of the CSV — point at the credit and say:

> "Every report you send carries the tool's address — here is where it shows."

### 4:15 – 5:00 — the honest close

> "Two things I want to be clear about. This is a **handbook-level estimate**, not a design
> calculation — peak solar, sol-air ETD, no hourly simulation, no duct sizing, no psychrometric
chart, no coil selection. For a signed job you still use HAP or Carrier or TRACE. And it reads
> the **text layer** of the PDF — a scanned drawing has no text, so for a scan you either import the
> room schedule as Excel/CSV (much better) or tick the OCR box. Within those limits, in a few seconds it turns a drawing I would normally read
> by hand into a 120-room load sheet with the whole calculation shown line by line."

---

## The 60-second version

> This short version uses the **synthetic full-building fixture** (`app.html?sample=synthetic`) so the
> numbers land instantly. If you only have the default real sample, say the same pitch from the
> **0.00 TR → give it areas** angle in the main script instead.

**Do:** open **`app.html?sample=synthetic`** → click **Try sample drawing** → wait → click the **TR**
header to sort → click the **ATRIUM** row → say the numbers → stop.

> "This app reads a floor plan PDF and calculates the cooling load. It found **159 rooms in three
> floors** and decided **120 of them are air-conditioned** — **7,006.8 square metres** — for a total of
> **363.9 tonnes of refrigeration**, about **207 square feet per tonne**, with **52,157 L/s** of
> supply air and **6,995 L/s** of fresh air at the Kochi design condition of 35 dry bulb and 28 wet
> bulb. This panel is one room's breakdown — solar, wall, roof, people, lighting, equipment,
> infiltration, fresh air, sensible and latent, with percentages. Everything is editable, and the
CSV or a printed report comes straight out. It is a handbook-level estimate for early sizing, not
> a replacement for HAP — and for a scanned sheet it needs the room schedule as Excel/CSV, or the
> optional OCR."

---

## Likely questions, with short answers

**Is the load method correct?**
It is a **simplified handbook method** — peak solar gain through glass with a storage factor, wall
sol-air ETD (CLTD-style), people/lighting/equipment densities, an ACH infiltration estimate and
ASHRAE 62.1 fresh-air rates. The physics and the formula structure are standard; the values are
typical practice values, and the whole thing must be checked by an engineer before use. It is not a
radiant time series calculation run hour by hour, so expect it to be slightly conservative at the
peak and useless for a load profile.

**Who owns the sample drawing?**
Not us. The default sample is **LEVEL 11 FLOOR PLAN**, uploaded to Wikimedia Commons by **Vivianwwj**
and used under **CC BY-SA 4.0**. We ship the file unmodified and credit the author and the licence
(with a link to both) under the **Try sample drawing** button, on the About page and in
`docs/SAMPLE-CREDITS.md`. Share-alike applies to the file itself; LoadLens' own code is unaffected.
The synthetic 3-page fixture (`?sample=synthetic`) is generated by this project and is separate.

**Where do the numbers come from?**
Everything is visible: the solar gain and wall ETD tables for about 10° north latitude, the
space-type table (m² per person, W/m² lighting and equipment, W per person sensible and latent,
fresh-air L/s per person and per m²) and the climate table are all in `js/calc.js`, and the app
shows them on the Method page and in the printed report's "Assumptions used" section. The room
areas, names and levels come from the text in the PDF you upload.

**Does it handle scanned drawings?**
Partly, and honestly. It reads the PDF's text layer first; a scanned or photographed drawing has no
text, so the normal reader finds nothing. Two better options exist. **Best:** export the room
schedule from Revit/Excel and drop the `.xlsx` / `.csv` on the page — it needs no OCR and is the most
accurate input. **Alternative:** tick the *"Read scanned drawings with OCR (slow)"* box, which reads
the page in the browser with Tesseract (off by default, ~4 s per page, ~11 MB downloaded from this
site on first use). A legible scanned **schedule** OCRs into real rooms (Office 27 m², Conference
48 m², Store ~2.9 m²), but a scanned **drawing** currently comes back with 0 rooms, because the small
area labels cannot be recovered — the page says so and points you at the schedule import. Keep the
mouse test: open the PDF, try to select a room name. If you cannot select it, it is an image.

**Can it read Revit schedules?**
Not the `.rvt` file and not the schedule object — it has no Revit API. But you **can** export the
room schedule as Excel/CSV (`.xlsx`, `.csv`, `.tsv`) and drop that on the page; it is the cleanest
input of all. Exporting the schedule as PDF also works — the same reader reads the text layer.

**Is the data uploaded anywhere?**
Your file is never sent to a third party. Running it locally with `npm start`, the PDF goes to your
own machine's Node server on localhost and nothing leaves the PC. Opened as the static GitHub Pages
copy, the PDF never leaves the browser tab at all — the PDF engine is bundled inside the page. On the
hosted site (**loadlens.net**) the PDF is posted to **this site's own server** so it can be read
faster; it is parsed in memory, is **not stored**, and nothing from it is logged. There is no database,
no account, and the server keeps nothing after the response. What it does send is an anonymous count of
which buttons get used and of coarse reader/source properties, plus the four `utm_` campaign tags from
the page URL if present — no cookie, no user id, no IP address, no file name, no room name, and never
the drawing or anything from it. Plus no third-party analytics and no ads in the page.

**Can it be wrong about a room?**
Yes, and it says so. It found 159 rooms here and flagged one parser note (a label with no area).
A room called `TEL.C.` is a drafting abbreviation, not a real name; the area
can be missing. That is exactly why the table is editable and why the report says the areas must be
confirmed against the drawing and the room schedule.

**What is 207 ft²/TR telling me?**
It is a sanity check on the whole building: how much floor area one tonne of refrigeration serves.
Typical Indian office practice is roughly 200–300 ft²/TR; a well-insulated office with efficient
glazing can be better, a glass-box restaurant or a lab can be far worse. If a number in that range
appears and the big rooms look right, the estimate is behaving.

**Why is the load so high compared with a rule of thumb?**
Because there is no diversity, no part-load and a single peak hour with every room at its design
condition — plus a 10 % safety factor on top. Also the assumptions are conservative: 30 % glazing
on every exposed wall, one exposed side per room, roof exposed on the top floor, 0.5 ACH
infiltration. Correct the glazing area and orientation for the real façade and the total drops.

**Does it size ducts or equipment?**
No. It gives the **supply air quantity** in L/s (from the sensible heat and the supply ΔT) and the
fresh-air quantity, and that is all. No duct sizing, no duct heat gain or leakage, no fan heat, no
chilled-water or refrigerant piping, no AHU/FCU selection, no psychrometric chart.

**Can I show how the total is built up?**
Yes — that is the breakdown panel. It lists every sensible component (glass solar, glass
conduction, wall, roof, partition, people, lighting, equipment, infiltration), the latent
components, the safety factor and the fresh-air sensible/latent, each with watts and its
percentage of the room total. It is the screen to open when someone asks "where is this tonne
coming from?".

**What would you add next?**
Worth saying honestly, because it is a real roadmap: reading a Revit/IFC room schedule directly,
per-hour RTS solar and wall storage, a psychrometric process line and coil selection, duct and pipe
sizing, and a project library of glass and wall build-ups so the U values and shading coefficients
are not typed in by hand. (OCR and Excel/CSV schedule import have since shipped — see the notes
above.)

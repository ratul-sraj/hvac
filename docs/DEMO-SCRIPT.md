# LoadLens — 5-minute live demo script

For presenting the project live: to an interview panel, a mentor at the academy, or a colleague.
Everything below is real output from the app running on this PC. Keep the browser at full screen,
zoom 100 %, and have the sample PDF ready (you do not need to hunt for a file — the app downloads
it for you).

**Before you start (30 seconds of setup)**

```bash
cd D:/webhvac
npm start
```
Open **http://localhost:3000/** and leave the page at the top. If you want to also show the
landing / method pages from a static copy, that is a second terminal with
`python -m http.server 8230 --bind 127.0.0.1` — but the demo below only needs the one page.

Numbers to remember before you speak (real and measured, from the synthetic sample
`tests/samples/sample-plan.pdf` that ships with the app):

| | |
|---|---|
| Pages / floors | 3 — Ground Floor, L1 Floor, L2 Floor |
| Rooms read from the PDF | **159** |
| Rooms air-conditioned (included in the load) | **120** |
| Conditioned area | **7,006.8 m²** (75,413 ft²) |
| Total cooling load | **363.86 TR** (1,279,702 W) |
| Supply air | **52,157 L/s**; fresh air **6,995 L/s** |
| Area per tonne | **207 ft²/TR** |
| Load by floor | Ground 88.1 TR, L1 70.2 TR, L2 75.5 TR |
| Biggest room | ATRIUM, Ground Floor, 1,249 m² → 34.6 TR, SHF 0.68 |
| Safety factor / assumptions | 10 %; Kochi 35 °C DB / 28 °C WB; 24 °C / 50 % RH inside |

---

## The 5-minute script

### 0:00 – 0:30 — the hook (do not touch the mouse)

> "This is LoadLens. It takes a floor plan PDF — the kind of drawing we get from the architect —
> reads the rooms out of it, applies cooling-load theory to each room, and gives you the cooling
> load in tonnes of refrigeration, the supply air in L/s and a room-wise sheet you can hand over.
> Let me show you with a real three-floor building."

### 0:30 – 1:00 — the settings (top of the page, scroll the panel)

**What to do:** point at sections **1. Project and design conditions** and **2. Upload floor plan
PDF**. Click nothing yet.

> "First the design conditions — country, city, outdoor dry bulb and wet bulb. This is Kochi:
> 35 degrees dry bulb, 28 wet bulb. That wet bulb is the important one in Kerala — the gap between
> 35 and 28 is all latent load. Indoor is 24 and 50 % RH. Below that, the construction assumptions:
> wall U 2.0, glass U 5.8 with a shading coefficient of 0.6, roof U 2.0 with an equivalent
> temperature difference of 22 K, infiltration at half an air change, and a 10 % safety factor."

### 1:00 – 2:15 — load the drawing (this is the moment)

**What to do:** click **Try sample drawing**. Wait — about 10 seconds. Say nothing for a second
while it fills, then point at the summary cards.

> "One click. It reads all three pages and here is the load summary: **363.9 tonnes of
> refrigeration**, **52,157 L/s supply air**, **6,995 L/s fresh air**, **7,006.8 square metres
> conditioned**, and **258 square feet per tonne**."

Then scroll a little, to the level-wise table, then into the room table:

> "Under the cards is the floor-wise subtotal: Ground Floor 88 tonnes, Level One 70, Level Two 75.
> And here is the room list — **159 rooms found, 120 air-conditioned**. The app decided by itself
> that the toilets, shafts, stores and stairs are not conditioned — they stay in the list but they
> are out of the totals. Every row is editable: area, height, people, lighting, equipment,
> orientation, wall and glass area, roof, partitions."

**If you have 20 seconds more:** scroll back up, type `35` → `38` in the outdoor dry bulb (Kochi →
Chennai-like) and let them watch the total change. Say:

> "All of this recalculates while I type — the design conditions are live."

Put it back to 35 (or click **Reset to defaults**).

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

### 4:15 – 5:00 — the honest close

> "Two things I want to be clear about. This is a **handbook-level estimate**, not a design
> calculation — peak solar, sol-air ETD, no hourly simulation, no duct sizing, no psychrometric
chart, no coil selection. For a signed job you still use HAP or Carrier or TRACE. And it reads
> the **text layer** of the PDF — a scanned drawing has no text, so for a scan you either import the
> room schedule as Excel/CSV (much better) or tick the OCR box. Within those limits, in a few seconds it turns a drawing I would normally read
> by hand into a 120-room load sheet with the whole calculation shown line by line."

---

## The 60-second version

**Do:** open the page → click **Try sample drawing** → wait → click the **TR** header to sort →
click the **ATRIUM** row → say the numbers → stop.

> "This app reads a floor plan PDF and calculates the cooling load. It found **159 rooms in three
> floors** and decided **120 of them are air-conditioned** — **7,006.8 square metres** — for a total of
> **363.9 tonnes of refrigeration**, about **207 square feet per tonne**, with **52,200 L/s** of
> supply air and **3,970 L/s** of fresh air at the Kochi design condition of 35 dry bulb and 28 wet
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
No. Running it locally with `npm start`, the PDF goes to your own machine's Node server on
localhost and nothing leaves the PC. Opened as the static GitHub Pages copy, the PDF never leaves
the browser tab at all — the PDF engine is bundled inside the page. There is no database, no
account, no analytics, and the server keeps nothing after the response.

**Can it be wrong about a room?**
Yes, and it says so. It found 159 rooms here and flagged one parser note (a label with no area, a
label with no area). A room called `TEL.C.` is a drafting abbreviation, not a real name; the area
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

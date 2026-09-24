# LoadLens — interview notes

How to present this project in a BIM MEP Modeller / Coordinator interview. Simple English, factual
tone, no overselling. Read the hook and the limitations out loud a few times — those two are what
interviews are actually made of.

---

## 1. The one-line hook

> "I built a small web tool that reads a floor plan PDF, pulls out every room, and gives you the
> cooling load room by room — tonnes of refrigeration, supply air in L/s and a printable load sheet."

If they want the longer version:

> "MEP modellers spend a lot of time reading room names, areas and levels off architectural PDFs by
> hand, and the first cooling-load check is usually a rule of thumb. I automated the reading part
> and put the standard handbook cooling-load method behind it, so in a few seconds you get a
> room-wise sheet you can check line by line and export to Excel."

---

## 2. The problem it solves for a modeller

- **Room data entry is slow and boring.** A three-floor building has 100–200 rooms. Reading names,
  numbers, areas and levels off a drawing and typing them into Excel takes hours and always has
  typos.
- **The first load check happens too late.** Usually someone asks "roughly how many tonnes?" before
  any software run exists, and the answer is a rule of thumb from memory.
- **Room-wise numbers are hard to explain.** A single total from a black-box program does not show
  where the load is coming from. This tool shows every component of every room.
- **Schedules and drawings disagree.** A room-wise sheet you can sort by load makes it obvious which
  rooms to check against the drawing.

---

## 3. What was built (the stack)

| Layer | What was used | Why it matters in the room |
|---|---|---|
| UI | Plain HTML + CSS + ES modules. No framework, no build step | Anyone can read it; it also runs offline and from a static host |
| PDF reading | pdf.js 4.10.38, vendored locally | The PDF text layer is read in the browser — no upload, no API key |
| Calculation engine | `js/calc.js` — pure module, SI units inside | The engineering lives in one file with the factor tables visible, not hidden in the UI |
| Reporting | `js/report.js` — pure string builders | CSV for Excel and a printable A4 report with the assumptions and the caveats on it |
| Server (optional) | Node 22 + Express, `POST /api/parse`, `/api/calc`, `/api/health` | Same app works two ways: PDF read in the browser, or read on the server. Docker-ready |
| Tests | Node test scripts, an HTTP API test, and a real-browser test with puppeteer-core | The sample building (3 pages, 149 rooms) is a regression test, not a demo |
| Docs | A user guide, a demo script, these notes, and a screenshot script | Documentation is part of the deliverable |

Two words for the architecture: **same engine, two runtimes.** The engine has no DOM and no Node
dependency, so the browser and the server run identical code — the totals cannot drift apart.

---

## 4. The engineering concepts the project demonstrates

Talk about these with the drawing in mind, not as definitions. Each line is one sentence for the
interview.

- **Design conditions.** Outdoor summer **dry bulb + coincident wet bulb** and indoor **dry bulb +
  relative humidity** drive everything. Kochi is 35 °C DB / 28 °C WB; that 7 K depression is what
  makes the humid-climate load so latent-heavy.
- **Humidity ratio.** From DB/WB with the psychrometric relations (sea level, 101.325 kPa). The
  difference between outdoor and indoor humidity ratio (kg/kg) multiplied by the air quantity and
  the latent heat of vapour gives the **latent** load — this is the part a temperature-only rule of
  thumb misses.
- **U values (thermal transmittance, W/m²K).** Wall 2.0 for 230 mm plastered brick, glass 5.8 for
  single clear, roof 2.0 for an RCC slab with weathering course. Conduction = U × area × ΔT.
- **ETD / CLTD and sol-air temperature.** A wall does not see air temperature, it sees sun plus air
  plus long-wave sky, so the effective ΔT is bigger: 7 K for a north wall up to 15 K for a west
  wall, and 22 K for a roof. This is the CLTD/ETD family of methods. Orientation therefore changes
  the wall load with no change in U value.
- **Solar gain through glass** as peak W/m² per orientation (110 for north to 470 for west, 650 for
  a horizontal skylight) multiplied by the **shading coefficient** — 0.6 for clear glass with
  internal blinds. Glass has a small conduction load and a large radiation load; that is why the
  west façade and the glazing ratio decide the peak.
- **Sensible vs latent heat.** Sensible = temperature change; latent = moisture change. They are
  calculated separately, added separately, and they behave differently: latent load barely cares
  about the room ΔT but scales directly with the outdoor-indoor humidity difference.
- **SHF (sensible heat factor).** SHF = sensible ÷ total for the room. Kerala gives low SHF
  (0.68–0.76 in this sample) because a large share of the load is moisture removal. A low SHF is
  what forces a deeper coil and a colder supply air; it is the number to quote when someone says
  "it is only 35 degrees outside".
- **Fresh air per ASHRAE 62.1.** Ventilation air per person plus per m² of floor, by type of use
  (2.5 L/s per person in an office, 5 in a classroom, 12 in a patient room). Fresh air is not free
  cooling: at Kochi design conditions every 1,000 L/s of outdoor air adds about 3–4 TR.
- **TR (tonne of refrigeration).** 1 TR = 3,517 W = 12,000 BTU/h. Converting the SI result into TR
  is what the client and the equipment schedule speak.
- **Airflow (L/s) and supply ΔT.** Supply air quantity = sensible heat ÷ (1.23 × supply ΔT). With an 11 K
  supply-to-room ΔT, 35,978 L/s here. The air quantity is the bridge from the load to the duct and
  AHU design, even though this tool does not size them.
- **ft²/TR as a sanity check.** 5,609 m² / 233.8 TR = **258 ft²/TR**. The rule of thumb for Indian
  office work is roughly 200–300 ft²/TR. A number inside that band, with the biggest rooms verified,
  is a sign the estimate is behaving — and outside it is a sign something is wrong.
- **Why Kerala's humid climate pushes ft²/TR down (more TR for the same area).** Fresh air at
  28 °C wet bulb carries a lot of moisture. Removing that moisture costs latent heat; the fresh-air
  load is a large fraction of the total here (3,974 L/s of outdoor air), and roof and west-wall
  gains are high all year. So for the same floor area, a Kochi building needs more tonnes than a
  dry-climate building — which is why 258 ft²/TR appears instead of the 350–400 ft²/TR someone may
  quote from a dry city.
- **Safety factor and diversity.** A flat 10 % on room sensible and latent, shown separately in the
  breakdown. No diversity on people or equipment — conservative by design, and stated in the report.
- **Infiltration.** A simple ACH estimate (0.5), converted to L/s and split into sensible (1.23 ×
  L/s × ΔT) and latent (3010 × L/s × ΔW) parts.

---

## 5. The honest limitations, and how to say them

Say them before you are asked. It reads as competence, not as an excuse.

| Limitation | How to say it |
|---|---|
| Handbook-level estimate, not a design calculation | "It is a peak handbook estimate — sensible and latent split properly, but it must be checked by an engineer. For a signed calculation I would use HAP or Carrier E-20, or a full manual RTS." |
| No hourly simulation / no load profile | "It gives one peak hour, not the building's load profile, so it cannot size a chiller plant on part-load hours." |
| No radiant time series | "Heat storage is a single factor, not hour-by-hour, so it is approximate at the peak and wrong if you want the time of the peak." |
| No duct, pipe, coil or equipment selection | "It stops at the load and the air quantity. Duct sizing, pipe sizing, coil selection and equipment selection are the next step, and I did not build that." |
| No OCR | "It reads the PDF text layer. A scanned drawing has no text, so there it finds nothing — you would type the rooms in or use the schedule sheet." |
| No Revit / IFC connection | "It reads a PDF, not a model. Exporting a Revit room schedule to PDF works well; reading the model directly would need the Revit API or IFC." |
| Areas and names can be wrong | "It read 149 rooms here and flagged six parser notes. Every row is editable and the report tells you to confirm the areas against the drawing — that is the workflow, not a bug." |
| Simplified solar and shading | "One peak value per orientation and a single shading coefficient. Overhangs, fins, adjacent buildings, glass framing and interior shades are not modelled one by one." |
| Fresh-air rates from the app's table | "The rates are ASHRAE 62.1 type-of-use values; for a real project you take the project specification and the local code (NBC, ECBC) and type them in." |
| I am not a licensed HVAC designer | "I am training as a modeller and coordinator. This shows I understand how the load is built up and where it can go wrong; the sign-off belongs to the engineer." |

**The one-sentence summary of the limits, if you only get one sentence:**

> "It is a fast, transparent, room-by-room handbook estimate that is right for early sizing and for
> showing my working — and it says so on every printed page."

---

## 6. Questions an interviewer may ask, with model answers

**1. "Walk me through what happens when I upload a PDF."**
"pdf.js reads the text layer of every page and gives me text items with their position. The parser
groups them into rooms — either room tags on the plan with their area, or a room schedule table —
and produces a room list with name, level, number and area. Then the load engine fills the missing
fields from the space type: people from m² per person, lighting and equipment W/m², wall and glass
area derived from the room area and 30 % glazing, orientation defaulting to west. Finally it
calculates each room and sums the included rooms for the totals."

**2. "Where does the load method come from?"**
"It is a simplified ASHRAE / Carrier E-20 style method: peak solar gain through glass with a
storage factor, sol-air ETD values for walls and the roof, people sensible and latent per person by
use type, lighting and equipment power densities, infiltration from air changes per hour, and fresh
air on ASHRAE 62.1 rates. The factor tables are in one file, `js/calc.js`, and the Method page and
the printed report show them, so nothing is hidden."

**3. "How do you handle the humidity here in Kerala?"**
"I calculate the humidity ratio outdoors from dry bulb and wet bulb, and indoors from dry bulb and
RH, then the latent load is 3010 × air flow × the humidity-ratio difference — plus people latent
heat. At Kochi's 28 °C wet bulb the fresh-air latent load is large, and you can see it in the SHF:
0.68 to 0.76 in the sample instead of the 0.85+ you would see in a dry climate."

**4. "What is SHF and why does it matter?"**
"Sensible heat factor — sensible divided by total. It tells the coil how much of the load is
moisture. A low SHF means you need a lower apparatus dew point and a colder supply air, so it
affects the coil selection and the supply air temperature, not just the tonnage."

**5. "Why is your number higher than my rule of thumb?"**
"Three reasons. It is one peak hour with no diversity, every room at design condition. The
assumptions are conservative — 30 % glazing on each exposed wall, one exposed side per room, roof
exposed on the top floor, 0.5 ACH infiltration. And there is a flat 10 % safety factor on room
sensible and latent. Correct the glazing area and the orientation from the actual façade and the
number comes down."

**6. "How do you know the answer is not nonsense?"**
"Three checks. First, ft²/TR: 5,609 m² over 233.8 TR is 258 ft²/TR, inside the 200–300 band for
Indian office work. Second, the breakdown of the biggest rooms — the ATRIUM at 1,249 m² gives
34.6 TR, and its components are solar, ventilation and people, which is what I would expect for an
atrium. Third, the level-wise totals: 88, 70 and 75 TR across three floors, with the ground floor
higher because it has the atrium and the coffee shop. If any of those three looked wrong I would go
back to the room table before trusting the total."

**7. "What did you find hard?"**
"Two things. Parsing real drawings is messier than it looks — the same room can appear twice, some
labels have no area, so I had to add duplicate detection and report parser notes instead of
silently guessing. And keeping the browser and the server paths exactly the same: I solved that by
making the engine a pure module with no DOM and no Node dependency, so both runtimes run identical
code."

**8. "How is the app tested?"**
"Node tests for the engine and the parser, an HTTP API test that uploads the real 3-page sample PDF
and expects 149 rooms, and a real-browser test driven with puppeteer-core that loads the sample,
edits an area, exports the CSV, checks the printed report and reloads the page to see the state
restored. The total of 233.78 TR from the sample is a regression value — if a factor changes by
mistake, the test catches it."

**9. "Could it read my Revit model?"**
"Not directly — it reads PDFs. The practical path today is to export the room schedule from Revit to
PDF and upload that page; it is usually cleaner than the plan. To read the model itself I would need
the Revit API or IFC, and then I would be building a different tool."

**10. "Where would this fit in a real project, and what would you do next?"**
"Early stage — design development, before the load software run: a quick room-wise sanity check, a
sheet to compare against the architect's areas, and a defensible first number for the MEP meeting.
Next I would add OCR for scans, per-hour RTS solar and wall storage, a psychrometric process line
with coil selection, duct and pipe sizing, and a library of glass and wall build-ups so nobody types
U values by hand."

**11. "Is this your own work?"**
Be straight about it: say which parts you wrote, which parts you specified and reviewed, and how you
tested it. Over-claiming is the fastest way to lose the room; showing that you can review someone
else's engineering numbers against your own understanding is exactly what a coordinator does.

---

## 7. Demo in the interview (if they ask you to show it)

Use `docs/DEMO-SCRIPT.md`. The short version: open `http://localhost:3000/` → **Try sample
drawing** → sort by **TR** → open the **ATRIUM** breakdown → **Download CSV** → **Print / Save PDF
report**. Say the numbers as facts: 149 rooms, 93 conditioned, 5,609 m², 233.8 TR, 258 ft²/TR,
three floors. Then say the limits before they ask.
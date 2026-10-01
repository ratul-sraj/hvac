# LoadLens climate sources — where the design conditions come from

Every row of `CLIMATE_TABLE` in [`js/climates.js`](../js/climates.js) is either **sourced** (it carries a
non-null `src` and the `station` it came from) or **indicative** (it carries `indicative: true` and a
short `why`). Nothing is left silently unsourced. `tests/test-climates.mjs` enforces both halves of
that rule mechanically.

## What the numbers are

For every **sourced** city the DB/WB pair is the **ASHRAE 2021 Handbook—Fundamentals, Chapter 14
(Climatic Design Information), 0.4% annual cooling design condition**: the dry-bulb temperature
corresponding to the 0.4% annual cumulative frequency of occurrence and the **mean coincident wet-bulb**
(MCWB) temperature at that dry bulb. The figures were read from the public per-station tables at
[ashrae-meteo.info](https://ashrae-meteo.info/v3.0/) (edition **2021**, SI), and the station name and WMO
number are recorded on each row so any figure can be re-checked. The URL column below opens the exact
station table that was read.

### Why ASHRAE 2021 and not ISHRAE for the Indian cities

The brief prefers ISHRAE design conditions for Indian cities, then IMD/NASA summaries, then ASHRAE 2021
Ch.14. In practice an ISHRAE table could **not be verified from an open, machine-readable source**: the
ISHRAE *Weather Data & Design Conditions for India* book is not freely published, and the freely
available BIS standard **IS 7896:2001** — "Data for Outside Design Conditions for Air Conditioning for
Indian Cities" — and its newer revision **IS 7896:2023** ("Air Conditioning Outdoor Design Conditions
Data For Indian Cities") both survive online only as scanned PDFs whose tables cannot be parsed
reliably without risking transcription errors. Rather than guess, **ASHRAE 2021 Ch.14 was used as the verifiable primary
source for every sourced city, Indian and international alike**, so the whole table rests on one
consistent, checkable standard. ISHRAE values are of the same order and remain the right thing to check
against for a real job.

### The convention used

* **DB** = 0.4% annual cooling dry bulb; **WB** = its mean coincident wet bulb (MCWB).
  This is the pair an HVAC cooling-coil selection uses.
* ASHRAE also publishes a separate **0.4% evaporation wet bulb / mean coincident dry bulb** (the monsoon
  dehumidification condition). It is typically a few degrees wetter than the MCWB above and is the one to
  check if a project is driven by latent load; it is not carried in the table, which keeps the single
  summer DB/coincident-WB meaning the app already had.
* A city is marked **sourced** only when an ASHRAE station lies within ~75 km. Where the nearest station is
  farther than that, the current value is kept and the row is flagged `indicative` — attributing a distant
  station's climate to a city would be misleading.

## Sourced rows (132)

| City | DB °C | WB °C | Source | Edition/year | Station (WMO) | URL |
|---|---:|---:|---|---|---|---|
| **Australia** | | | | | | |
| Adelaide | 36.8 | 18.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | ADELAIDE AP (WMO 946720) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-34.95&lng=138.53&place=%27%27&wmo=946720&ashrae_version=2021) |
| Brisbane | 30.8 | 23.1 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | BRISBANE AP (WMO 945780) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-27.38&lng=153.13&place=%27%27&wmo=945780&ashrae_version=2021) |
| Darwin | 34.2 | 23.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | DARWIN (WMO 941200) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-12.42&lng=130.88&place=%27%27&wmo=941200&ashrae_version=2021) |
| Melbourne | 35.4 | 18.1 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MELBOURNE AP (WMO 948660) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-37.67&lng=144.85&place=%27%27&wmo=948660&ashrae_version=2021) |
| Perth | 37.5 | 19.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | PERTH AP (WMO 946100) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-31.93&lng=115.97&place=%27%27&wmo=946100&ashrae_version=2021) |
| Sydney | 33.3 | 19.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SYDNEY AP (WMO 947670) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-33.93&lng=151.18&place=%27%27&wmo=947670&ashrae_version=2021) |
| **Bahrain** | | | | | | |
| Manama | 41.2 | 23.7 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | BAHRAIN INTL (WMO 411500) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=26.27&lng=50.65&place=%27%27&wmo=411500&ashrae_version=2021) |
| **Brazil** | | | | | | |
| Rio de Janeiro | 34.8 | 25.7 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | RIO DE JANEIRO SANTOS DUMONT (WMO 837550) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-22.9&lng=-43.17&place=%27%27&wmo=837550&ashrae_version=2021) |
| São Paulo | 32.2 | 20.1 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SAO PAULO CONGONHAS (WMO 837800) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-23.62&lng=-46.65&place=%27%27&wmo=837800&ashrae_version=2021) |
| **Canada** | | | | | | |
| Calgary | 28.8 | 16 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | CALGARY INTL (WMO 718770) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=51.11&lng=-114.02&place=%27%27&wmo=718770&ashrae_version=2021) |
| Montreal | 30.3 | 22.1 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MONTREAL TRUDEAU (WMO 716270) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=45.47&lng=-73.75&place=%27%27&wmo=716270&ashrae_version=2021) |
| Ottawa | 30.9 | 22 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | OTTAWA INTL (WMO 716280) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=45.32&lng=-75.67&place=%27%27&wmo=716280&ashrae_version=2021) |
| Toronto | 31.5 | 22.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | TORONTO PEARSON (WMO 716240) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=43.68&lng=-79.63&place=%27%27&wmo=716240&ashrae_version=2021) |
| Vancouver | 25.1 | 18.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | VANCOUVER INTL (WMO 718920) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=49.2&lng=-123.18&place=%27%27&wmo=718920&ashrae_version=2021) |
| **China** | | | | | | |
| Beijing | 35.2 | 22 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | BEIJING (WMO 545110) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=39.93&lng=116.28&place=%27%27&wmo=545110&ashrae_version=2021) |
| Guangzhou | 36 | 26.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | GUANGZHOU (WMO 592870) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=23.17&lng=113.33&place=%27%27&wmo=592870&ashrae_version=2021) |
| Shanghai | 35.5 | 26.7 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SHANGHAI BAOSHAN (WMO 583620) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=31.4&lng=121.47&place=%27%27&wmo=583620&ashrae_version=2021) |
| Shenzhen | 34 | 26.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SHENZHEN (WMO 594930) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=22.55&lng=114.1&place=%27%27&wmo=594930&ashrae_version=2021) |
| **Egypt** | | | | | | |
| Cairo | 38.8 | 21 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | CAIRO INTL (WMO 623660) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=30.13&lng=31.4&place=%27%27&wmo=623660&ashrae_version=2021) |
| **France** | | | | | | |
| Lyon | 33.8 | 20.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | LYON-BRON AP (WMO 074800) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=45.72&lng=4.93&place=%27%27&wmo=074800&ashrae_version=2021) |
| Marseille | 33.1 | 21 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MARSEILLE PROVENCE AP (WMO 076500) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=43.45&lng=5.23&place=%27%27&wmo=076500&ashrae_version=2021) |
| Paris | 31.6 | 20.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | PARIS MONTSOURIS (WMO 071560) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=48.82&lng=2.33&place=%27%27&wmo=071560&ashrae_version=2021) |
| **Germany** | | | | | | |
| Berlin | 29.3 | 19 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | BERLIN DAHLEM (WMO 103810) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=52.47&lng=13.3&place=%27%27&wmo=103810&ashrae_version=2021) |
| Frankfurt | 32.1 | 20 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | FRANKFURT AM MAIN (WMO 106370) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=50.05&lng=8.6&place=%27%27&wmo=106370&ashrae_version=2021) |
| Hamburg | 29.1 | 19.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | HAMBURG FUHLSBUTTEL (WMO 101470) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=53.63&lng=10.0&place=%27%27&wmo=101470&ashrae_version=2021) |
| Munich | 29.5 | 19 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MUNICH STADT (WMO 108650) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=48.13&lng=11.55&place=%27%27&wmo=108650&ashrae_version=2021) |
| **Hong Kong** | | | | | | |
| Hong Kong | 32.2 | 26.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | HONG KONG OBSERVATORY (WMO 450050) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=22.3&lng=114.17&place=%27%27&wmo=450050&ashrae_version=2021) |
| **India** | | | | | | |
| Ahmedabad | 43.1 | 23 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | AHMEDABAD (WMO 426470) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=23.07&lng=72.63&place=%27%27&wmo=426470&ashrae_version=2021) |
| Amritsar | 43.2 | 23.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | LAHORE ALLAMA IQBAL INTL (WMO 416410)<br>*nearest station in the edition (~46 km, in Pakistan) — an Indian city served cross-border, as Johor Bahru is served by Singapore* | [table](https://ashrae-meteo.info/v3.0/index.php?lat=31.52&lng=74.4&place=%27%27&wmo=416410&ashrae_version=2021) |
| Bengaluru | 34.3 | 20 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | BENGALURU (WMO 432950) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=12.97&lng=77.58&place=%27%27&wmo=432950&ashrae_version=2021) |
| Bhopal | 42 | 21.9 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | BHOPAL (WMO 426670) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=23.28&lng=77.35&place=%27%27&wmo=426670&ashrae_version=2021) |
| Chennai | 39 | 26 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | CHENNAI INTL (WMO 432790) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=13.0&lng=80.18&place=%27%27&wmo=432790&ashrae_version=2021) |
| Coimbatore | 36.7 | 22.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | COIMBATORE INTL (WMO 433210) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=11.03&lng=77.05&place=%27%27&wmo=433210&ashrae_version=2021) |
| Delhi | 42.3 | 23.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | NEW DELHI SAFDARJUNG (WMO 421820) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=28.58&lng=77.2&place=%27%27&wmo=421820&ashrae_version=2021) |
| Faridabad | 42.3 | 23.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | NEW DELHI SAFDARJUNG (WMO 421820) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=28.58&lng=77.2&place=%27%27&wmo=421820&ashrae_version=2021) |
| Gurugram | 43.8 | 22.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | NEW DELHI INDIRA GANDHI INTL (WMO 421810) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=28.57&lng=77.12&place=%27%27&wmo=421810&ashrae_version=2021) |
| Guwahati | 35.2 | 27.8 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | GUWAHATI INTL (WMO 424100) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=26.1&lng=91.58&place=%27%27&wmo=424100&ashrae_version=2021) |
| Hyderabad | 41 | 22 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | HYDERABAD BEGUMPET (WMO 431280) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=17.45&lng=78.47&place=%27%27&wmo=431280&ashrae_version=2021) |
| Indore | 40.8 | 20.9 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | INDORE INTL (WMO 427540) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=22.72&lng=75.8&place=%27%27&wmo=427540&ashrae_version=2021) |
| Jaipur | 42.7 | 20.9 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | JAIPUR (WMO 423480) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=26.82&lng=75.8&place=%27%27&wmo=423480&ashrae_version=2021) |
| Kanpur | 42.8 | 23.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | LUCKNOW (WMO 423690) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=26.75&lng=80.88&place=%27%27&wmo=423690&ashrae_version=2021) |
| Kolkata | 37.9 | 27.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | KOLKATA BOSE INTL (WMO 428090) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=22.65&lng=88.45&place=%27%27&wmo=428090&ashrae_version=2021) |
| Kollam | 34.2 | 26.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | THIRUVANANTHAPURAM (WMO 433710) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=8.48&lng=76.95&place=%27%27&wmo=433710&ashrae_version=2021) |
| Kozhikode | 35.2 | 28.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | KOZHIKODE (WMO 433140) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=11.25&lng=75.78&place=%27%27&wmo=433140&ashrae_version=2021) |
| Lucknow | 42.8 | 23.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | LUCKNOW (WMO 423690) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=26.75&lng=80.88&place=%27%27&wmo=423690&ashrae_version=2021) |
| Mangaluru | 34.4 | 24.9 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MANGALORE INTL (WMO 432840) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=12.92&lng=74.88&place=%27%27&wmo=432840&ashrae_version=2021) |
| Mumbai | 36 | 22.7 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MUMBAI SHIVAJI INTL (WMO 430030) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=19.12&lng=72.85&place=%27%27&wmo=430030&ashrae_version=2021) |
| Nagpur | 44.2 | 22.6 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | NAGPUR AMBEDKAR INTL (WMO 428670) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=21.1&lng=79.05&place=%27%27&wmo=428670&ashrae_version=2021) |
| New Delhi | 42.3 | 23.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | NEW DELHI SAFDARJUNG (WMO 421820) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=28.58&lng=77.2&place=%27%27&wmo=421820&ashrae_version=2021) |
| Palakkad | 36.7 | 22.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | COIMBATORE INTL (WMO 433210) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=11.03&lng=77.05&place=%27%27&wmo=433210&ashrae_version=2021) |
| Panaji | 34.2 | 25.9 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | GOA PANAJI (WMO 431920) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=15.48&lng=73.82&place=%27%27&wmo=431920&ashrae_version=2021) |
| Patna | 41.3 | 23.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | PATNA (WMO 424920) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=25.6&lng=85.1&place=%27%27&wmo=424920&ashrae_version=2021) |
| Pune | 38.5 | 19.9 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | PUNE (WMO 430630) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=18.53&lng=73.85&place=%27%27&wmo=430630&ashrae_version=2021) |
| Surat | 38.2 | 22.6 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SURAT (WMO 428400) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=21.2&lng=72.83&place=%27%27&wmo=428400&ashrae_version=2021) |
| Thiruvananthapuram | 34.2 | 26.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | THIRUVANANTHAPURAM (WMO 433710) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=8.48&lng=76.95&place=%27%27&wmo=433710&ashrae_version=2021) |
| Visakhapatnam | 34 | 27.1 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | VISHAKHAPATNAM CWC (WMO 431500) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=17.7&lng=83.3&place=%27%27&wmo=431500&ashrae_version=2021) |
| **Indonesia** | | | | | | |
| Denpasar | 32.5 | 26.6 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | DENPASAR NGURAH RAI (WMO 972300) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-8.75&lng=115.17&place=%27%27&wmo=972300&ashrae_version=2021) |
| Jakarta | 34 | 25.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | JAKARTA SOEKARNO-HATTA (WMO 967490) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-6.12&lng=106.65&place=%27%27&wmo=967490&ashrae_version=2021) |
| Surabaya | 34.1 | 24.7 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | JUANDA SURABAYA (WMO 969350) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-7.37&lng=112.77&place=%27%27&wmo=969350&ashrae_version=2021) |
| **Israel** | | | | | | |
| Tel Aviv | 35.2 | 20.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | TEL AVIV BEN GURION (WMO 401800) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=32.0&lng=34.9&place=%27%27&wmo=401800&ashrae_version=2021) |
| **Japan** | | | | | | |
| Osaka | 34.5 | 25 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | OSAKA (WMO 477720) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=34.68&lng=135.52&place=%27%27&wmo=477720&ashrae_version=2021) |
| Tokyo | 33.7 | 25.6 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | TOKYO (WMO 476620) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=35.68&lng=139.77&place=%27%27&wmo=476620&ashrae_version=2021) |
| **Kenya** | | | | | | |
| Mombasa | 33.2 | 25.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MOMBASA INTL (WMO 638200) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-4.03&lng=39.62&place=%27%27&wmo=638200&ashrae_version=2021) |
| Nairobi | 29.2 | 16 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | NAIROBI JOMO KENYATTA INTL (WMO 637400) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-1.32&lng=36.92&place=%27%27&wmo=637400&ashrae_version=2021) |
| **Kuwait** | | | | | | |
| Kuwait City | 48.1 | 21.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | KUWAIT INTL (WMO 405820) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=29.22&lng=47.97&place=%27%27&wmo=405820&ashrae_version=2021) |
| **Malaysia** | | | | | | |
| George Town | 33.2 | 26.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | PENANG INTL (WMO 486010) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=5.3&lng=100.27&place=%27%27&wmo=486010&ashrae_version=2021) |
| Johor Bahru | 33.2 | 26.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SINGAPORE/CHANGI INTL (WMO 486980)<br>*~30 km away, across the border in Singapore; the same station as the Singapore row* | [table](https://ashrae-meteo.info/v3.0/index.php?lat=1.37&lng=103.98&place=%27%27&wmo=486980&ashrae_version=2021) |
| Kuala Lumpur | 35 | 26.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | KUALA LUMPUR SUBANG (WMO 486470) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=3.12&lng=101.55&place=%27%27&wmo=486470&ashrae_version=2021) |
| Penang | 33.2 | 26.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | PENANG INTL (WMO 486010) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=5.3&lng=100.27&place=%27%27&wmo=486010&ashrae_version=2021) |
| **Maldives** | | | | | | |
| Malé | 32.2 | 27.1 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MALE (WMO 435550) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=4.2&lng=73.53&place=%27%27&wmo=435550&ashrae_version=2021) |
| **Mexico** | | | | | | |
| Guadalajara | 33.1 | 15.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | GUADALAJARA INTL (WMO 766133) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=20.52&lng=-103.3&place=%27%27&wmo=766133&ashrae_version=2021) |
| Mexico City | 29.1 | 12.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MEXICO CITY INTL (WMO 766793) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=19.43&lng=-99.07&place=%27%27&wmo=766793&ashrae_version=2021) |
| **Netherlands** | | | | | | |
| Amsterdam | 28.1 | 20 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | AMSTERDAM AP SCHIPHOL (WMO 062400) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=52.3&lng=4.77&place=%27%27&wmo=062400&ashrae_version=2021) |
| **New Zealand** | | | | | | |
| Auckland | 25.8 | 20.1 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | AUCKLAND (WMO 931100) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-37.0&lng=174.8&place=%27%27&wmo=931100&ashrae_version=2021) |
| **Oman** | | | | | | |
| Muscat | 42.6 | 22.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MUSCAT INTL (WMO 412560) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=23.58&lng=58.28&place=%27%27&wmo=412560&ashrae_version=2021) |
| Salalah | 33.8 | 21.6 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SALALAH (WMO 413160) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=17.03&lng=54.08&place=%27%27&wmo=413160&ashrae_version=2021) |
| Sohar | 40.4 | 23.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SOHAR MAJIS (WMO 412460) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=24.47&lng=56.63&place=%27%27&wmo=412460&ashrae_version=2021) |
| **Pakistan** | | | | | | |
| Islamabad | 41.1 | 22.8 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | ISLAMABAD INTL (WMO 415710) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=33.62&lng=73.1&place=%27%27&wmo=415710&ashrae_version=2021) |
| Karachi | 39 | 22.7 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | JINNAH INTL (WMO 417800) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=24.9&lng=67.13&place=%27%27&wmo=417800&ashrae_version=2021) |
| Lahore | 43.2 | 23.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | LAHORE ALLAMA IQBAL INTL (WMO 416410) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=31.52&lng=74.4&place=%27%27&wmo=416410&ashrae_version=2021) |
| **Philippines** | | | | | | |
| Manila | 34.5 | 26.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MANILA (WMO 984250) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=14.58&lng=120.98&place=%27%27&wmo=984250&ashrae_version=2021) |
| **Qatar** | | | | | | |
| Doha | 44.3 | 22.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | DOHA INTL (WMO 411700) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=25.25&lng=51.57&place=%27%27&wmo=411700&ashrae_version=2021) |
| **Russia** | | | | | | |
| Moscow | 29.9 | 21.1 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MOSKVA VDNH (WMO 276120) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=55.83&lng=37.62&place=%27%27&wmo=276120&ashrae_version=2021) |
| Saint Petersburg | 28.4 | 19.6 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | ST PETERSBURG PULKOVO (WMO 260630) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=59.97&lng=30.3&place=%27%27&wmo=260630&ashrae_version=2021) |
| **Saudi Arabia** | | | | | | |
| Dammam | 45.9 | 22.9 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | DHAHARAN KING ABDULAZIZ AB (WMO 404160) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=26.27&lng=50.17&place=%27%27&wmo=404160&ashrae_version=2021) |
| Jeddah | 41 | 23.7 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | JEDDAH KING ABDULAZIZ INTL (WMO 410240) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=21.7&lng=39.18&place=%27%27&wmo=410240&ashrae_version=2021) |
| Madinah | 45.2 | 18.8 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MEDINA PRINCE ABDULAZIZ INTL (WMO 404300) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=24.55&lng=39.7&place=%27%27&wmo=404300&ashrae_version=2021) |
| Makkah | 45.2 | 24.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MAKKAH (WMO 410300) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=21.43&lng=39.77&place=%27%27&wmo=410300&ashrae_version=2021) |
| Riyadh | 44.9 | 19.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | RIYADH KING SALMAN AB (WMO 404380) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=24.7&lng=46.73&place=%27%27&wmo=404380&ashrae_version=2021) |
| **Singapore** | | | | | | |
| Singapore | 33.2 | 26.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SINGAPORE CHANGI INTL (WMO 486980) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=1.37&lng=103.98&place=%27%27&wmo=486980&ashrae_version=2021) |
| **South Africa** | | | | | | |
| Cape Town | 31.9 | 19.8 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | CAPE TOWN INTL (WMO 688160) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-33.97&lng=18.6&place=%27%27&wmo=688160&ashrae_version=2021) |
| Durban | 30.2 | 23.9 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | DURBAN (WMO 685880) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-29.97&lng=30.95&place=%27%27&wmo=685880&ashrae_version=2021) |
| Johannesburg | 29.1 | 14.8 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | JOHANNESBURG INTL (WMO 683680) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=-26.15&lng=28.23&place=%27%27&wmo=683680&ashrae_version=2021) |
| **Spain** | | | | | | |
| Barcelona | 30.9 | 23.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | BARCELONA AP (WMO 081810) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=41.28&lng=2.07&place=%27%27&wmo=081810&ashrae_version=2021) |
| Madrid | 36.8 | 18.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MADRID-BARAJAS AP (WMO 082210) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=40.45&lng=-3.55&place=%27%27&wmo=082210&ashrae_version=2021) |
| Seville | 39.2 | 21.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SEVILLA AP (WMO 083910) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=37.42&lng=-5.9&place=%27%27&wmo=083910&ashrae_version=2021) |
| **Sri Lanka** | | | | | | |
| Colombo | 33.1 | 24.7 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | KATUNAYAKE (WMO 434500) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=7.17&lng=79.88&place=%27%27&wmo=434500&ashrae_version=2021) |
| **Thailand** | | | | | | |
| Bangkok | 36.2 | 26.9 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | BANGKOK METROPOLIS (WMO 484550) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=13.73&lng=100.57&place=%27%27&wmo=484550&ashrae_version=2021) |
| Chiang Mai | 38.1 | 22.8 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | CHIANG MAI INTL (WMO 483270) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=18.78&lng=98.98&place=%27%27&wmo=483270&ashrae_version=2021) |
| Phuket | 34.9 | 26.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | PHUKET (WMO 485640) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=7.88&lng=98.4&place=%27%27&wmo=485640&ashrae_version=2021) |
| **Turkey** | | | | | | |
| Ankara | 33.9 | 17 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | ANKARA ESENBOGA (WMO 171280) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=40.12&lng=33.0&place=%27%27&wmo=171280&ashrae_version=2021) |
| Istanbul | 32.1 | 21.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | ISTANBUL ATATURK (WMO 170600) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=40.97&lng=28.82&place=%27%27&wmo=170600&ashrae_version=2021) |
| **United Arab Emirates** | | | | | | |
| Abu Dhabi | 45.1 | 23 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | ABU DHABI INTL (WMO 412170) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=24.43&lng=54.65&place=%27%27&wmo=412170&ashrae_version=2021) |
| Ajman | 44.3 | 23.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SHARJAH INTL (WMO 411960) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=25.33&lng=55.52&place=%27%27&wmo=411960&ashrae_version=2021) |
| Al Ain | 46 | 22.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | AL AIN INTL (WMO 412180) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=24.27&lng=55.6&place=%27%27&wmo=412180&ashrae_version=2021) |
| Dubai | 43.3 | 23.6 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | DUBAI INTL (WMO 411940) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=25.25&lng=55.33&place=%27%27&wmo=411940&ashrae_version=2021) |
| Fujairah | 42.9 | 21.9 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | FUJAIRAH INTL (WMO 411980) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=25.1&lng=56.33&place=%27%27&wmo=411980&ashrae_version=2021) |
| Ras Al Khaimah | 44.7 | 24.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | RAS AL KHAIMAH INTL (WMO 411840) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=25.62&lng=55.93&place=%27%27&wmo=411840&ashrae_version=2021) |
| Sharjah | 44.3 | 23.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SHARJAH INTL (WMO 411960) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=25.33&lng=55.52&place=%27%27&wmo=411960&ashrae_version=2021) |
| **United Kingdom** | | | | | | |
| Birmingham | 26.8 | 18.1 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | BIRMINGHAM (WMO 035340) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=52.45&lng=-1.73&place=%27%27&wmo=035340&ashrae_version=2021) |
| Bristol | 26.7 | 18.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | BRISTOL WEATHER CENTRE (WMO 037260) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=51.47&lng=-2.6&place=%27%27&wmo=037260&ashrae_version=2021) |
| Edinburgh | 22.2 | 16.8 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | EDINBURGH AP (WMO 031600) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=55.95&lng=-3.35&place=%27%27&wmo=031600&ashrae_version=2021) |
| Glasgow | 23.2 | 17.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | GLASGOW AP (WMO 031400) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=55.87&lng=-4.43&place=%27%27&wmo=031400&ashrae_version=2021) |
| London | 28.4 | 18.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | LONDON WC CLERKENWELL (WMO 037790) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=51.52&lng=-0.1&place=%27%27&wmo=037790&ashrae_version=2021) |
| Manchester | 25.8 | 18.1 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MANCHESTER AP (WMO 033340) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=53.35&lng=-2.28&place=%27%27&wmo=033340&ashrae_version=2021) |
| **United States** | | | | | | |
| Atlanta | 34.3 | 23.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | ATLANTA HARTSFIELD-JACKSON (WMO 722190) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=33.64&lng=-84.43&place=%27%27&wmo=722190&ashrae_version=2021) |
| Boston | 32.7 | 22.8 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | BOSTON LOGAN (WMO 725090) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=42.36&lng=-71.01&place=%27%27&wmo=725090&ashrae_version=2021) |
| Chicago | 32.9 | 23.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | CHICAGO O'HARE (WMO 725300) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=41.99&lng=-87.91&place=%27%27&wmo=725300&ashrae_version=2021) |
| Dallas | 38.6 | 23.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | DALLAS FORT WORTH (WMO 722590) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=32.9&lng=-97.04&place=%27%27&wmo=722590&ashrae_version=2021) |
| Denver | 34.9 | 15.5 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | DENVER INTL (WMO 725650) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=39.83&lng=-104.66&place=%27%27&wmo=725650&ashrae_version=2021) |
| Houston | 36.4 | 24.8 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | HOUSTON BUSH (WMO 722430) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=29.99&lng=-95.36&place=%27%27&wmo=722430&ashrae_version=2021) |
| Las Vegas | 42.8 | 19.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | LAS VEGAS MCCARRAN (WMO 723860) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=36.08&lng=-115.16&place=%27%27&wmo=723860&ashrae_version=2021) |
| Los Angeles | 29.3 | 17.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | LOS ANGELES INTL (WMO 722950) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=33.94&lng=-118.41&place=%27%27&wmo=722950&ashrae_version=2021) |
| Miami | 33.3 | 25.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | MIAMI NHC (WMO 722020) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=25.82&lng=-80.3&place=%27%27&wmo=722020&ashrae_version=2021) |
| New York | 33.7 | 23.3 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | NEW YORK LA GUARDIA (WMO 725030) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=40.78&lng=-73.88&place=%27%27&wmo=725030&ashrae_version=2021) |
| Orlando | 34.3 | 24.8 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | ORLANDO INTL (WMO 722050) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=28.43&lng=-81.33&place=%27%27&wmo=722050&ashrae_version=2021) |
| Phoenix | 43.6 | 20.7 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | PHOENIX SKY HARBOR (WMO 722780) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=33.44&lng=-111.99&place=%27%27&wmo=722780&ashrae_version=2021) |
| San Francisco | 28.3 | 17.1 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SAN FRANCISCO INTL (WMO 724940) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=37.62&lng=-122.4&place=%27%27&wmo=724940&ashrae_version=2021) |
| Seattle | 30 | 18.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | SEATTLE TACOMA (WMO 727930) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=47.46&lng=-122.31&place=%27%27&wmo=727930&ashrae_version=2021) |
| Washington | 34.7 | 24.2 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | WASHINGTON RONALD REAGAN (WMO 724050) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=38.87&lng=-77.03&place=%27%27&wmo=724050&ashrae_version=2021) |
| **Vietnam** | | | | | | |
| Hanoi | 36.2 | 27.4 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | HA NOI (WMO 488200) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=21.03&lng=105.8&place=%27%27&wmo=488200&ashrae_version=2021) |
| Ho Chi Minh City | 35.8 | 25.7 | ASHRAE 2021 | Handbook—Fundamentals Ch.14, 2021 | HO CHI MINH TAN SON NHAT INTL (WMO 489000) | [table](https://ashrae-meteo.info/v3.0/index.php?lat=10.82&lng=106.67&place=%27%27&wmo=489000&ashrae_version=2021) |

## Station record periods (vintage disclosure)

Most ASHRAE 2021 stations derive their design conditions from the standard record period **1994–2019**
(108 of the 123 cited stations). **15 of the 132 sourced rows rest on a station whose record is shorter
or older than that.** The numbers are still *this edition's* design conditions — they were read from the
2021 station table unchanged — but the underlying record is not the standard one, so a reviewer should
know which cities those are:

| City | Station (WMO) | Record period |
|---|---|---|
| Hong Kong | HONG KONG OBSERVATORY (450050) | 1982–1992 |
| Berlin | BERLIN DAHLEM (103810) | 1982–2003 |
| Munich | MUNICH STADT (108650) | 1982–2003 |
| Bristol | BRISTOL WEATHER CENTRE (037260) | 1990–2001 |
| London | LONDON WC CLERKENWELL (037790) | 1994–2010 |
| Riyadh | RIYADH KING SALMAN AB (404380) | 1994–2014 |
| Visakhapatnam | VISHAKHAPATNAM CWC (431500) | 1994–2015 |
| Makkah | MAKKAH (410300) | 1994–2018 |
| Kozhikode | KOZHIKODE (433140) | shorter than 1994–2019 |
| Gurugram | NEW DELHI INDIRA GANDHI INTL (421810, Palam) | shorter than 1994–2019 |
| Fujairah | FUJAIRAH INTL (411980) | shorter than 1994–2019 |
| Phuket | PHUKET (485640) | shorter than 1994–2019 |
| Paris | PARIS MONTSOURIS (071560) | shorter than 1994–2019 |
| Lyon | LYON-BRON AP (074800) | shorter than 1994–2019 |
| Hamburg | HAMBURG FUHLSBUTTEL (101470) | shorter than 1994–2019 |

**Caveat:** a small minority of rows rest on shorter or older station records — most notably Hong Kong
Observatory (1982–1992, a 30-year-old record), Berlin and Munich (1982–2003), and the seven rows above
whose records are simply shorter than the standard 1994–2019 period. For any city where the vintage
matters to the job, open the station's URL and check the period ASHRAE prints beside the value.


## Rows still indicative (89)

These keep the value that was in the table before this change; each is flagged `indicative: true` and
carries the reason below. Check any of them against ISHRAE / ASHRAE / the local code before use.

| Country | Row | DB °C | WB °C | Why it is indicative |
|---|---|---:|---:|---|
| Australia (country fallback) | — | 38 | 24 | country-level fallback; no single station defines a whole country |
| Australia (region) | New South Wales | 34 | 23 | state/province estimate; not a station value |
| Australia (region) | Northern Territory | 35 | 27 | state/province estimate; not a station value |
| Australia (region) | Queensland | 33 | 25 | state/province estimate; not a station value |
| Australia (region) | South Australia | 38 | 22 | state/province estimate; not a station value |
| Australia (region) | Victoria | 36 | 21 | state/province estimate; not a station value |
| Australia (region) | Western Australia | 38 | 23 | state/province estimate; not a station value |
| Bahrain (country fallback) | — | 43 | 29 | country-level fallback; no single station defines a whole country |
| Bangladesh | Chittagong | 33 | 27 | no ASHRAE station within 75 km; indicative value kept |
| Bangladesh | Dhaka | 34 | 27 | no ASHRAE station within 75 km; indicative value kept |
| Bangladesh (country fallback) | — | 34 | 27 | country-level fallback; no single station defines a whole country |
| Brazil (country fallback) | — | 33 | 24 | country-level fallback; no single station defines a whole country |
| Canada (country fallback) | — | 30 | 22 | country-level fallback; no single station defines a whole country |
| Canada (region) | Alberta | 28 | 18 | state/province estimate; not a station value |
| Canada (region) | British Columbia | 26 | 19 | state/province estimate; not a station value |
| Canada (region) | Ontario | 30 | 22 | state/province estimate; not a station value |
| Canada (region) | Quebec | 30 | 22 | state/province estimate; not a station value |
| China (country fallback) | — | 35 | 27 | country-level fallback; no single station defines a whole country |
| Egypt (country fallback) | — | 38 | 24 | country-level fallback; no single station defines a whole country |
| France (country fallback) | — | 32 | 21 | country-level fallback; no single station defines a whole country |
| Germany (country fallback) | — | 30 | 20 | country-level fallback; no single station defines a whole country |
| Hong Kong (country fallback) | — | 33 | 27 | country-level fallback; no single station defines a whole country |
| India | Kannur | 35 | 28 | no ASHRAE station within 75 km; indicative value kept |
| India | Kochi | 35 | 28 | no ASHRAE station within 75 km; indicative value kept |
| India | Kottayam | 35 | 27.5 | no ASHRAE station within 75 km; indicative value kept |
| India | Ludhiana | 42 | 26 | no ASHRAE station within 75 km; indicative value kept |
| India | Madurai | 39 | 26 | no ASHRAE station within 75 km; indicative value kept |
| India | Mysuru | 33 | 22 | no ASHRAE station within 75 km; indicative value kept |
| India | Thrissur | 36 | 27.5 | no ASHRAE station within 75 km; indicative value kept |
| India (country fallback) | — | 40 | 26 | country-level fallback; no single station defines a whole country |
| India (region) | Andhra Pradesh | 36 | 27 | state/province estimate; not a station value |
| India (region) | Assam | 36 | 27 | state/province estimate; not a station value |
| India (region) | Bihar | 42 | 26 | state/province estimate; not a station value |
| India (region) | Delhi | 43 | 24 | state/province estimate; not a station value |
| India (region) | Goa | 33 | 27 | state/province estimate; not a station value |
| India (region) | Gujarat | 42 | 25 | state/province estimate; not a station value |
| India (region) | Haryana | 43 | 24 | state/province estimate; not a station value |
| India (region) | Karnataka | 34 | 23 | state/province estimate; not a station value |
| India (region) | Kerala | 35 | 28 | state/province estimate; not a station value |
| India (region) | Madhya Pradesh | 41 | 24 | state/province estimate; not a station value |
| India (region) | Maharashtra | 36 | 26 | state/province estimate; not a station value |
| India (region) | Punjab | 42 | 25 | state/province estimate; not a station value |
| India (region) | Rajasthan | 44 | 24 | state/province estimate; not a station value |
| India (region) | Tamil Nadu | 38 | 27 | state/province estimate; not a station value |
| India (region) | Telangana | 41 | 24 | state/province estimate; not a station value |
| India (region) | Uttar Pradesh | 43 | 25 | state/province estimate; not a station value |
| India (region) | West Bengal | 38 | 28 | state/province estimate; not a station value |
| Indonesia (country fallback) | — | 33 | 26 | country-level fallback; no single station defines a whole country |
| Israel (country fallback) | — | 33 | 25 | country-level fallback; no single station defines a whole country |
| Japan (country fallback) | — | 34 | 26 | country-level fallback; no single station defines a whole country |
| Kenya (country fallback) | — | 27 | 19 | country-level fallback; no single station defines a whole country |
| Kuwait (country fallback) | — | 48 | 24 | country-level fallback; no single station defines a whole country |
| Malaysia (country fallback) | — | 34 | 27 | country-level fallback; no single station defines a whole country |
| Maldives (country fallback) | — | 32 | 27 | country-level fallback; no single station defines a whole country |
| Mexico | Cancun | 33 | 26 | nearest ASHRAE station (Cancún Intl, WMO 765906) has no 2021 design-condition data |
| Mexico (country fallback) | — | 34 | 22 | country-level fallback; no single station defines a whole country |
| Nepal | Kathmandu | 30 | 22 | no ASHRAE station within 75 km; indicative value kept |
| Nepal (country fallback) | — | 30 | 22 | country-level fallback; no single station defines a whole country |
| Netherlands (country fallback) | — | 28 | 19 | country-level fallback; no single station defines a whole country |
| New Zealand (country fallback) | — | 26 | 18 | country-level fallback; no single station defines a whole country |
| Nigeria | Abuja | 36 | 23 | no ASHRAE station within 75 km; indicative value kept |
| Nigeria | Lagos | 33 | 25 | no ASHRAE station within 75 km; indicative value kept |
| Nigeria (country fallback) | — | 33 | 25 | country-level fallback; no single station defines a whole country |
| Oman (country fallback) | — | 46 | 29 | country-level fallback; no single station defines a whole country |
| Pakistan (country fallback) | — | 40 | 26 | country-level fallback; no single station defines a whole country |
| Philippines (country fallback) | — | 34 | 27 | country-level fallback; no single station defines a whole country |
| Qatar (country fallback) | — | 46 | 28 | country-level fallback; no single station defines a whole country |
| Russia (country fallback) | — | 28 | 19 | country-level fallback; no single station defines a whole country |
| Saudi Arabia (country fallback) | — | 45 | 24 | country-level fallback; no single station defines a whole country |
| Singapore (country fallback) | — | 33 | 26.5 | country-level fallback; no single station defines a whole country |
| South Africa (country fallback) | — | 32 | 20 | country-level fallback; no single station defines a whole country |
| Spain (country fallback) | — | 35 | 23 | country-level fallback; no single station defines a whole country |
| Sri Lanka (country fallback) | — | 33 | 27 | country-level fallback; no single station defines a whole country |
| Thailand (country fallback) | — | 36 | 27 | country-level fallback; no single station defines a whole country |
| Turkey (country fallback) | — | 34 | 23 | country-level fallback; no single station defines a whole country |
| United Arab Emirates (country fallback) | — | 46 | 29 | country-level fallback; no single station defines a whole country |
| United Kingdom (country fallback) | — | 28 | 20 | country-level fallback; no single station defines a whole country |
| United Kingdom (region) | England | 28 | 20 | state/province estimate; not a station value |
| United Kingdom (region) | Northern Ireland | 24 | 18 | state/province estimate; not a station value |
| United Kingdom (region) | Scotland | 24 | 18 | state/province estimate; not a station value |
| United Kingdom (region) | Wales | 26 | 19 | state/province estimate; not a station value |
| United States (country fallback) | — | 35 | 24 | country-level fallback; no single station defines a whole country |
| United States (region) | Arizona | 43 | 22 | state/province estimate; not a station value |
| United States (region) | California | 32 | 21 | state/province estimate; not a station value |
| United States (region) | Florida | 34 | 26 | state/province estimate; not a station value |
| United States (region) | Illinois | 32 | 24 | state/province estimate; not a station value |
| United States (region) | New York | 33 | 24 | state/province estimate; not a station value |
| United States (region) | Texas | 38 | 24 | state/province estimate; not a station value |
| Vietnam (country fallback) | — | 36 | 27 | country-level fallback; no single station defines a whole country |

### Indicative cities in detail

These are the city rows (not regions/fallbacks) that are **not** sourced; the distance is to the
nearest ASHRAE station in the 2021 edition, so each keeps its pre-existing estimate:

* **Chittagong** (Bangladesh) — kept 33/27: nearest ASHRAE station ~177 km away.
* **Dhaka** (Bangladesh) — kept 34/27: nearest is Agartala, India ~86 km away, just beyond the ~75 km rule.
* **Kannur** (India) — kept 35/28: nearest ASHRAE station ~82 km away.
* **Kochi** (India) — kept 35/28: nearest is Coimbatore ~149 km away (the "KOCHI" station in the ASHRAE
  list is Kochi, **Japan**, WMO 478930 — not this city).
* **Kottayam** (India) — kept 35/27.5: nearest ASHRAE station ~132 km away.
* **Ludhiana** (India) — kept 42/26: nearest is Patiala ~86 km away.
* **Madurai** (India) — kept 39/26: nearest ASHRAE station ~114 km away.
* **Mysuru** (India) — kept 33/22: nearest ASHRAE station ~126 km away.
* **Thrissur** (India) — kept 36/27.5: nearest ASHRAE station ~93 km away.
* **Cancun** (Mexico) — kept 33/26: Cancún Intl (WMO 765906) is ~15 km away but that station carries
  **no design-condition data in the 2021 edition**, so no 2021 value can be attributed to the city.
* **Kathmandu** (Nepal) — kept 30/22: nearest is Tingri, China ~201 km away.
* **Abuja** (Nigeria) — kept 36/23: nearest ASHRAE station ~463 km away.
* **Lagos** (Nigeria) — kept 33/25: nearest ASHRAE station ~112 km away.

(Johor Bahru, previously listed here, is now **sourced** — it is served by Singapore/Changi ~30 km away;
see the sourced table above.)

## Reproducing this table

For any sourced row, open its URL above (or go to <https://ashrae-meteo.info/v3.0/>), pick the **2021**
edition and the WMO/SI view, and read the **Annual Cooling, Dehumidification, and Enthalpy Design
Conditions** block: the `0.4%` `DB` and `MCWB` columns are the two numbers in this table.


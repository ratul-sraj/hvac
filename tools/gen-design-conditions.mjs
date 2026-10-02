// tools/gen-design-conditions.mjs — regenerate design-conditions.html FROM THE DATA.
//
// The public reference page design-conditions.html is GENERATED, never hand-edited.
// It reads:
//   * js/climates.js        — the CLIMATE_TABLE (the numbers + per-row src/station/why)
//   * docs/CLIMATE-SOURCES.md — the station record-period disclosure (vintage table)
// and writes design-conditions.html (site root).
//
// Run it after any change to the climate table:
//   cd D:/webhvac && node tools/gen-design-conditions.mjs
//
// tests/tools/check-seo.mjs then re-checks that every sourced city and every number on
// the page still matches js/climates.js, so a stale page fails the gate loudly.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIMATE_TABLE } from "../js/climates.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MD_PATH = path.join(ROOT, "docs", "CLIMATE-SOURCES.md");
const OUT_PATH = path.join(ROOT, "design-conditions.html");
const GH_SOURCES = "https://github.com/ratul-sraj/hvac/blob/main/docs/CLIMATE-SOURCES.md";
const STANDARD_RECORD = "1994\u20132019"; // standard ASHRAE 2021 station record period

// ---- html helpers ---------------------------------------------------------
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const attr = (s) => esc(s);
const num = (n) => (Number.isInteger(n) ? String(n) : String(n));

// ---- read the record-period disclosure out of docs/CLIMATE-SOURCES.md ------
// The `## Station record periods` section holds a `| City | Station | Record period |`
// table. Parse it so a sourced row can show its station's real vintage, defaulting to
// the standard 1994-2019 period for every station not listed there.
function parseRecordPeriods(md) {
  const out = new Map();
  const lines = md.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (/^##\s+Station record periods/i.test(line)) { inSection = true; continue; }
      if (inSection) break; // next top-level section ends it
    }
    if (!inSection) continue;
    const m = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/);
    if (!m) continue;
    const city = m[1].trim();
    const period = m[3].trim();
    if (/^city$/i.test(city) || /^-+$/.test(city) || !period) continue; // header / separator
    out.set(city, period);
  }
  return out;
}

// list a country's rows in a stable order: cities, then regions, then fallback
function rowsOf(entry) {
  const rows = [];
  for (const [city, r] of Object.entries(entry.cities || {})) {
    rows.push({ kind: "city", name: city, row: r });
  }
  for (const [region, r] of Object.entries(entry.regions || {})) {
    rows.push({ kind: "region", name: region, row: r });
  }
  if (entry.fallback) rows.push({ kind: "fallback", name: "", row: entry.fallback });
  return rows;
}

const isSourced = (r) => !!(r && r.src);

// ---- build a table row ----------------------------------------------------
function tr(country, { kind, name, row }) {
  const sourced = isSourced(row);
  const cityLabel = kind === "city" ? name : kind === "region" ? `${name} (region)` : "(country fallback)";
  const dataAttrs = [
    `data-country="${attr(country)}"`,
    `data-kind="${kind}"`,
    `data-city="${attr(name)}"`,
    `data-db="${attr(num(row.db))}"`,
    `data-wb="${attr(num(row.wb))}"`,
    `data-sourced="${sourced ? "true" : "false"}"`,
  ].join(" ");

  const stationCell = sourced
    ? esc(row.station || "")
    : `<span class="dc-badge dc-ind">indicative</span>`;
  const noteCell = sourced
    ? esc(recordFor(name, row))
    : esc(row.why || "estimate; no station value");

  return (
    `        <tr class="${sourced ? "dc-sourced" : "dc-indicative"}" ${dataAttrs}>\n` +
    `          <td class="l">${esc(cityLabel)}</td>\n` +
    `          <td>${esc(num(row.db))}</td>\n` +
    `          <td>${esc(num(row.wb))}</td>\n` +
    `          <td class="l">${stationCell}</td>\n` +
    `          <td class="l">${noteCell}</td>\n` +
    `        </tr>\n`
  );
}

let RECORD_PERIODS = new Map();
function recordFor(city, row) {
  if (row && typeof row.note === "string" && row.note.trim()) {
    const period = RECORD_PERIODS.get(city) || STANDARD_RECORD;
    return `${period} \u2014 ${row.note.trim()}`;
  }
  return RECORD_PERIODS.get(city) || `${STANDARD_RECORD} (standard)`;
}

function table(head, bodyRows, caption) {
  return (
    `      <div class="table-scroll">\n` +
    `      <table class="num-table dc-table">\n` +
    `        <caption class="dc-caption">${esc(caption)}</caption>\n` +
    `        <thead>\n` +
    `          <tr><th class="l">City</th><th>Summer DB \u00b0C</th><th>WB \u00b0C</th>` +
    `<th class="l">Source station</th><th class="l">Record period / note</th></tr>\n` +
    `        </thead>\n` +
    `        <tbody>\n` +
    bodyRows.join("") +
    `        </tbody>\n` +
    `      </table>\n` +
    `      </div>\n`
  );
}

// ---- assemble the page ----------------------------------------------------
function build() {
  const countries = Object.keys(CLIMATE_TABLE);
  const indiaName = countries.find((c) => /^india$/i.test(c));
  const otherCountries = countries.filter((c) => c !== indiaName);

  let sourcedCitiesTotal = 0;
  for (const entry of Object.values(CLIMATE_TABLE)) {
    for (const r of Object.values(entry.cities || {})) if (isSourced(r)) sourcedCitiesTotal += 1;
  }

  // ---- India: sourced cities
  const india = CLIMATE_TABLE[indiaName] || { cities: {}, regions: {}, fallback: null };
  const indiaSourced = Object.entries(india.cities || {})
    .filter(([, r]) => isSourced(r))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([city, row]) => tr(indiaName, { kind: "city", name: city, row }));

  // ---- India: everything that is not a station value (cities, regions, fallback)
  const indiaIndicative = Object.entries(india.cities || {})
    .filter(([, r]) => !isSourced(r))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([city, row]) => tr(indiaName, { kind: "city", name: city, row }))
    .concat(
      Object.entries(india.regions || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([region, row]) => tr(indiaName, { kind: "region", name: region, row }))
    )
    .concat(india.fallback ? [tr(indiaName, { kind: "fallback", name: "", row: india.fallback })] : []);

  // ---- other countries: sourced cities only, one collapsible block each
  const otherBlocks = [];
  for (const country of otherCountries.sort((a, b) => a.localeCompare(b))) {
    const entry = CLIMATE_TABLE[country];
    const rows = Object.entries(entry.cities || {})
      .filter(([, r]) => isSourced(r))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([city, row]) => tr(country, { kind: "city", name: city, row }));
    if (!rows.length) continue;
    otherBlocks.push(
      `      <details class="dc-country">\n` +
      `        <summary>${esc(country)} <span class="muted">(${rows.length} sourced ${rows.length === 1 ? "city" : "cities"})</span></summary>\n` +
      table(null, rows, `${country} \u2014 sourced ASHRAE 2021 outdoor design conditions`) +
      `      </details>\n`
    );
  }

  const generated = new Date().toISOString().slice(0, 10);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ASHRAE 2021 Design Conditions \u2014 Indian Cities</title>
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<meta name="description" content="Sourced ASHRAE 2021 outdoor design conditions for Indian cities: summer dry bulb, mean coincident wet bulb, source station and record period. Verify before use.">
<link rel="canonical" href="https://loadlens.net/design-conditions.html">
<meta property="og:url" content="https://loadlens.net/design-conditions.html">
<meta property="og:image" content="https://loadlens.net/favicon.svg">
<meta name="twitter:image" content="https://loadlens.net/favicon.svg">
<link rel="stylesheet" href="css/style.css">
<link rel="stylesheet" href="css/landing.css">
</head>
<body>

<header class="site-nav">
  <div class="wrap nav-inner">
    <a class="brand" href="index.html" aria-label="LoadLens \u2014 home">
      <svg class="brand-mark" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false">
        <rect x="1.5" y="7" width="29" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="2"/>
        <path d="M7 12.5h11M7 16h8M7 19.5h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M22.5 16l4.2-2.7v5.4z" fill="currentColor"/>
      </svg>
      <span class="brand-text">LoadLens<span class="brand-sub">COOLING LOAD FROM PDF</span></span>
    </a>
    <nav class="nav-links" aria-label="Main">
      <a href="index.html">Home</a>
      <a href="app.html">Calculator</a>
      <a href="about.html">About</a>
      <a href="method.html">Method</a>
      <a href="help.html">Help</a>
    </nav>
  </div>
</header>

<main>

  <!-- ======================= intro / provenance ======================= -->
  <section class="section">
    <div class="wrap prose">
      <h1>ASHRAE 2021 outdoor design conditions for Indian cities</h1>
      <p class="lead">
        Summer outdoor design conditions for Indian cities, city by city: the <strong>0.4% annual cooling
        dry bulb</strong> (DB) and its <strong>mean coincident wet bulb</strong> (WB), the ASHRAE station the
        number was read from, and the station's record period. These are the same values LoadLens fills in
        when it recognises your city.
      </p>

      <div class="callout">
        <h2>Where these numbers come from</h2>
        <p>
          Every sourced row is the pair an HVAC cooling-coil selection uses, read from the public per-station
          tables of the <strong>ASHRAE 2021 Handbook\u2014Fundamentals, Chapter 14 (Climatic Design
          Information)</strong> at <a href="https://ashrae-meteo.info/v3.0/">ashrae-meteo.info</a> (edition 2021,
          SI). The station name and WMO number are shown on each row so any figure can be re-checked.
        </p>
        <p>
          A city is marked <strong>sourced</strong> only when an ASHRAE station lies within about 75 km.
          Where the nearest station is farther, the value is kept as an estimate and the row is flagged
          <span class="dc-badge dc-ind">indicative</span> with the reason \u2014 attributing a distant
          station's climate to a city would be misleading. ISHRAE design conditions are the right thing to
          check against for a real project; they could not be verified from an open, machine-readable source,
          so ASHRAE 2021 is used as the single checkable primary source throughout.
        </p>
        <p>
          Full provenance, the reasons for the indicative rows and the per-station record periods are in
          <a href="${GH_SOURCES}">docs/CLIMATE-SOURCES.md</a> on GitHub.
        </p>
      </div>

      <div class="callout warn">
        <h2>Verify before engineering use</h2>
        <p>
          These are outdoor <em>design conditions</em>, not a load calculation, and this page is a reference,
          not a design. A small number of stations rest on a record period older or shorter than the standard
          ${STANDARD_RECORD} \u2014 those periods are printed on each row. Before any engineering use, open the
          station's table, confirm the period, and check the value against ISHRAE / ASHRAE or the local code.
          A qualified HVAC engineer must verify every number.
        </p>
      </div>
    </div>
  </section>

  <!-- ======================= India ======================= -->
  <section class="section" id="india">
    <div class="wrap">
      <div class="section-head prose">
        <h2>India \u2014 cities with a sourced ASHRAE 2021 station</h2>
        <p class="muted">
          ${indiaSourced.length} cities with a station within about 75 km. DB is the 0.4% annual cooling
          dry bulb; WB is its mean coincident wet bulb. Both in \u00b0C.
        </p>
      </div>
${table(null, indiaSourced, "India \u2014 sourced ASHRAE 2021 outdoor design conditions")}
    </div>
  </section>

  <section class="section" id="india-indicative">
    <div class="wrap">
      <div class="section-head prose">
        <h2>India \u2014 indicative rows (not station values)</h2>
        <p class="muted">
          Cities with no ASHRAE station within the radius, plus the state/province estimates and the
          country-wide fallback. Each is an estimate; the reason is shown.
        </p>
      </div>
${table(null, indiaIndicative, "India \u2014 indicative estimates (no station within about 75 km)")}
    </div>
  </section>

  <!-- ======================= other countries ======================= -->
  <section class="section" id="international">
    <div class="wrap">
      <div class="section-head prose">
        <h2>Other countries \u2014 sourced stations</h2>
        <p class="muted">
          The same ASHRAE 2021 sourced pairs for the other countries LoadLens knows. The countries with no
          station of their own (and the state/province estimates) stay flagged indicative in the app.
        </p>
      </div>
${otherBlocks.join("")}    </div>
  </section>

  <!-- ======================= call to action ======================= -->
  <section class="section">
    <div class="wrap prose">
      <h2>Calculate a cooling load for your own floor plan</h2>
      <p>
        LoadLens reads a floor plan PDF or an Excel / CSV room schedule, applies these design conditions,
        and returns the room-wise cooling load in TR, L/s and watts \u2014 in your browser, nothing uploaded.
      </p>
      <a class="btn btn-lg" href="app.html">Calculate a cooling load for your own floor plan</a>
    </div>
  </section>

</main>

<footer class="site-footer">
  <div class="wrap footer-grid">
    <div>
      <h3>LoadLens</h3>
      <p>Room-wise cooling load from a floor plan PDF \u2014 TR, L/s and watts, in your browser.</p>
      <p class="small"><a href="https://loadlens.net/">LoadLens \u2014 loadlens.net</a></p>
      <p class="small"><a href="index.html">Home</a></p>
    </div>
    <div>
      <h3>Pages</h3>
      <ul>
        <li><a href="app.html">Calculator</a></li>
        <li><a href="about.html">About</a></li>
        <li><a href="method.html">Method and assumptions</a></li>
        <li><a href="design-conditions.html">Design conditions (India)</a></li>
        <li><a href="help.html">Help / FAQ</a></li>
      </ul>
    </div>
    <div>
      <h3>Project</h3>
      <ul>
        <li><a href="https://github.com/ratul-sraj/hvac">Source on GitHub</a></li>
        <li><a href="${GH_SOURCES}">Climate sources</a></li>
      </ul>
    </div>
  </div>
  <div class="wrap footer-bottom">
    Generated from <code>js/climates.js</code> and <code>docs/CLIMATE-SOURCES.md</code> by
    <code>tools/gen-design-conditions.mjs</code> on ${generated} \u2014 do not edit by hand.
    ASHRAE 2021 Handbook\u2014Fundamentals, Ch.14, 0.4% annual cooling dry bulb / mean coincident wet bulb.
    <strong>Reference only \u2014 a qualified HVAC engineer must verify every number.</strong>
  </div>
</footer>

<script src="js/nav.js" defer></script>
</body>
</html>
`;
}

// ---- main -----------------------------------------------------------------
const md = fs.readFileSync(MD_PATH, "utf8");
RECORD_PERIODS = parseRecordPeriods(md);

const html = build();
fs.writeFileSync(OUT_PATH, html);
console.log(`wrote ${path.relative(ROOT, OUT_PATH).replace(/\\/g, "/")} (${html.length} bytes)`);

// sanity: count what we emitted
let emitted = 0;
for (const entry of Object.values(CLIMATE_TABLE)) {
  for (const r of Object.values(entry.cities || {})) if (isSourced(r)) emitted += 1;
}
console.log(`sourced cities emitted: ${emitted}`);

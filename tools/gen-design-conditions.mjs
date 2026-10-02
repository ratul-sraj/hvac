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
// The page is WORLDWIDE: it groups the sourced cities by region with stable anchors
// (#india, #south-asia, #middle-east, …), carries a search box over every sourced city, and
// keeps India as its own first section. Running it twice in a row produces byte-identical
// output (no timestamps beyond the day, no randomness).
//
// tools/check-seo.mjs then re-checks that every sourced city and every number on the page still
// matches js/climates.js, that the search box and the region anchors are present, and that the
// city count the page prints is the real sourced-city count — so a stale page fails the gate.
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

// ---- which countries sit in which region (id = anchor, name = heading) ----
// Every country in CLIMATE_TABLE must appear exactly once; build() asserts that below, so adding
// a country to the table without a region fails the generator loudly instead of silently
// dropping it from the page.
const REGIONS = [
  { id: "india", name: "India", countries: ["India"] },
  { id: "south-asia", name: "South Asia", countries: ["Bangladesh", "Maldives", "Nepal", "Pakistan", "Sri Lanka"] },
  { id: "southeast-asia", name: "Southeast Asia", countries: ["Indonesia", "Malaysia", "Philippines", "Singapore", "Thailand", "Vietnam"] },
  { id: "east-asia", name: "East Asia", countries: ["China", "Hong Kong", "Japan"] },
  { id: "middle-east", name: "Middle East", countries: ["Bahrain", "Israel", "Kuwait", "Oman", "Qatar", "Saudi Arabia", "United Arab Emirates"] },
  { id: "europe", name: "Europe", countries: ["France", "Germany", "Netherlands", "Russia", "Spain", "Turkey", "United Kingdom"] },
  { id: "africa", name: "Africa", countries: ["Egypt", "Kenya", "Nigeria", "South Africa"] },
  { id: "americas", name: "Americas", countries: ["Brazil", "Canada", "Mexico", "United States"] },
  { id: "oceania", name: "Oceania", countries: ["Australia", "New Zealand"] },
];

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

const isSourced = (r) => !!(r && r.src);

// ---- build a table row ----------------------------------------------------
// Attribute ORDER matters: tools/check-seo.mjs parses rows with a regex expecting
// data-country, data-kind, data-city, data-db, data-wb, data-sourced in that order.
// data-search (for the in-page filter) goes last.
function tr(country, { kind, name, row }) {
  const sourced = isSourced(row);
  const cityLabel = kind === "city" ? name : kind === "region" ? `${name} (region)` : "(country fallback)";
  const searchText = [name, country, row && row.station ? row.station : ""].join(" ").toLowerCase();
  const cls = ["dc-row", sourced ? "dc-sourced" : "dc-indicative"];
  if (kind === "city" && sourced) cls.push("dc-src");
  const dataAttrs = [
    `data-country="${attr(country)}"`,
    `data-kind="${kind}"`,
    `data-city="${attr(name)}"`,
    `data-db="${attr(num(row.db))}"`,
    `data-wb="${attr(num(row.wb))}"`,
    `data-sourced="${sourced ? "true" : "false"}"`,
    `data-search="${attr(searchText)}"`,
  ].join(" ");

  const stationCell = sourced
    ? esc(row.station || "")
    : `<span class="dc-badge dc-ind">indicative</span>`;
  const noteCell = sourced
    ? esc(recordFor(name, row))
    : esc(row.why || "estimate; no station value");

  return (
    `        <tr class="${cls.join(" ")}" ${dataAttrs}>\n` +
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

function table(bodyRows, caption) {
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

// a per-country sub-block inside a region: heading + sourced table (or an honest note)
function countryBlock(country, rows, caption) {
  if (!rows.length) {
    return (
      `      <div class="dc-country-block dc-note" data-dc-country="${attr(country)}">\n` +
      `        <h3 class="dc-country-h">${esc(country)}</h3>\n` +
      `        <p class="muted">No ASHRAE 2021 station within about 75 km of any city here, so no row on\n` +
      `          this page is a station value. LoadLens keeps an <span class="dc-badge dc-ind">indicative</span>\n` +
      `          value for these places in the calculator, flagged exactly as that.</p>\n` +
      `      </div>\n`
    );
  }
  return (
    `      <div class="dc-country-block" data-dc-country="${attr(country)}">\n` +
    `        <h3 class="dc-country-h">${esc(country)} <span class="muted">(${rows.length} sourced ${rows.length === 1 ? "city" : "cities"})</span></h3>\n` +
    table(rows, caption) +
    `      </div>\n`
  );
}

// ---- assemble the page ----------------------------------------------------
function build() {
  const allCountries = Object.keys(CLIMATE_TABLE);

  // assertion: every country is assigned to exactly one region (no silent drops)
  const mapped = new Map();
  for (const region of REGIONS) {
    for (const c of region.countries) {
      if (mapped.has(c)) throw new Error(`country "${c}" is listed in more than one region`);
      mapped.set(c, region.id);
    }
  }
  const unmapped = allCountries.filter((c) => !mapped.has(c));
  if (unmapped.length) throw new Error(`country/countries not assigned to any region: ${unmapped.join(", ")}`);
  for (const c of mapped.keys()) {
    if (!allCountries.includes(c)) throw new Error(`region lists "${c}", which is not in CLIMATE_TABLE`);
  }

  // ---- sourced cities, total and per country ----
  let sourcedCitiesTotal = 0;
  const sourcedByCountry = {};
  for (const [country, entry] of Object.entries(CLIMATE_TABLE)) {
    const n = Object.values(entry.cities || {}).filter(isSourced).length;
    sourcedByCountry[country] = n;
    sourcedCitiesTotal += n;
  }

  // ---- the same sourced rows, rendered once, remembered by country ----
  const emittedSourced = new Set();
  const renderedByCountry = {};
  for (const [country, entry] of Object.entries(CLIMATE_TABLE)) {
    const rows = Object.entries(entry.cities || {})
      .filter(([, r]) => isSourced(r))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([city, row]) => {
        emittedSourced.add(`${country}\u0000${city}`);
        return tr(country, { kind: "city", name: city, row });
      });
    renderedByCountry[country] = rows;
  }

  // ---- region sections (India first, kept prominent) ----
  const regionCounts = {};
  for (const region of REGIONS) {
    regionCounts[region.id] = region.countries.reduce((n, c) => n + (sourcedByCountry[c] || 0), 0);
  }

  const regionSections = [];
  for (const region of REGIONS) {
    const count = regionCounts[region.id];
    const blocks = region.countries
      .map((country) => countryBlock(country, renderedByCountry[country] || [], `${country} \u2014 sourced ASHRAE 2021 outdoor design conditions`))
      .join("");
    regionSections.push(
      `  <section class="section dc-region" id="${region.id}" data-dc-region="${region.id}">\n` +
      `    <div class="wrap">\n` +
      `      <div class="section-head prose">\n` +
      `        <h2>${esc(region.name)} <span class="muted">(${count} sourced ${count === 1 ? "city" : "cities"})</span></h2>\n` +
      `        <p class="muted">\n` +
      `          ${count} ${count === 1 ? "city" : "cities"} with an ASHRAE 2021 station within about 75 km. DB is the\n` +
      `          0.4% annual cooling dry bulb; WB is its mean coincident wet bulb. Both in \u00b0C.\n` +
      `        </p>\n` +
      `      </div>\n` +
      blocks +
      `    </div>\n` +
      `  </section>\n`
    );
  }

  // India's indicative rows (cities with no station, the state/province estimates, the fallback).
  const india = CLIMATE_TABLE["India"] || { cities: {}, regions: {}, fallback: null };
  const indiaIndicative = Object.entries(india.cities || {})
    .filter(([, r]) => !isSourced(r))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([city, row]) => tr("India", { kind: "city", name: city, row }))
    .concat(
      Object.entries(india.regions || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([region, row]) => tr("India", { kind: "region", name: region, row }))
    )
    .concat(india.fallback ? [tr("India", { kind: "fallback", name: "", row: india.fallback })] : []);

  // Every indicative row on the page comes from the India indicative set above (all other country
  // blocks render sourced rows only). The honest counter and the generator's own assertion both use
  // this number; the assertion below re-counts data-sourced="false" so the two can never drift.
  const indicativeTotal = indiaIndicative.length;

  // ---- in-page index of region anchors ----
  const indexLinks = REGIONS.map(
    (region) =>
      `        <a href="#${region.id}">${esc(region.name)} <span class="dc-n">${regionCounts[region.id]}</span></a>`
  ).join("\n");

  const generated = new Date().toISOString().slice(0, 10);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ASHRAE 2021 Design Conditions for ${sourcedCitiesTotal} Cities | LoadLens</title>
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<meta name="description" content="Sourced ASHRAE 2021 outdoor summer design conditions for cities worldwide: dry bulb, wet bulb, source station and record period. Verify before use.">
<link rel="canonical" href="https://loadlens.net/design-conditions.html">
<meta property="og:url" content="https://loadlens.net/design-conditions.html">
<meta property="og:image" content="https://loadlens.net/favicon.svg">
<meta name="twitter:image" content="https://loadlens.net/favicon.svg">
<link rel="stylesheet" href="css/style.css">
<link rel="stylesheet" href="css/landing.css">
<style>
  /* design-conditions.html only — the search box, region index and region blocks. */
  .dc-search { margin: 0 0 16px; max-width: 620px; }
  .dc-search label { display: block; font-weight: 600; margin: 0 0 6px; }
  .dc-search-input {
    width: 100%; box-sizing: border-box; font: inherit; padding: 10px 12px;
    border: 1px solid var(--line, #ccc); border-radius: 8px; background: #fff; color: inherit;
  }
  .dc-search-input:focus { outline: 2px solid var(--accent, #2563eb); outline-offset: 1px; }
  .dc-count { margin: 8px 0 0; color: var(--ink-soft, #555); font-size: 14px; font-variant-numeric: tabular-nums; }
  .dc-index { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 0; }
  .dc-index a {
    display: inline-block; padding: 4px 10px; border: 1px solid var(--line, #ccc);
    border-radius: 999px; text-decoration: none; font-size: 14px; color: inherit;
  }
  .dc-index a:hover { background: var(--accent-soft, #eef3fb); }
  .dc-n { color: var(--ink-soft, #666); }
  .dc-country-block { margin: 0 0 14px; }
  .dc-country-h { margin: 18px 0 8px; font-size: 16px; }
  .dc-region[hidden], .dc-country-block[hidden] { display: none; }
  .dc-table tr[hidden] { display: none; }
</style>
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
      <h1>ASHRAE 2021 outdoor design conditions for cities worldwide</h1>
      <p class="lead">
        Summer outdoor design conditions for cities worldwide, city by city: the <strong>0.4% annual
        cooling dry bulb</strong> (DB) and its <strong>mean coincident wet bulb</strong> (WB), the ASHRAE
        station the number was read from, and how long that station's record runs. These are the same
        values LoadLens fills in when it recognises your city.
      </p>

      <div class="callout">
        <h2>Where these numbers come from</h2>
        <p>
          Every sourced row is the pair an HVAC cooling-coil selection uses, read from the public
          per-station tables of the <strong>ASHRAE 2021 Handbook\u2014Fundamentals, Chapter 14 (Climatic
          Design Information)</strong> at <a href="https://ashrae-meteo.info/v3.0/">ashrae-meteo.info</a>
          (edition 2021, SI). The station name and WMO number are shown on each row so any figure can be
          re-checked.
        </p>
        <p>
          A city is marked <strong>sourced</strong> only when an ASHRAE station lies within about 75 km.
          Where the nearest station is farther, the value is kept as an estimate and the row is flagged
          <span class="dc-badge dc-ind">indicative</span> with the reason \u2014 attributing a distant
          station's climate to a city would be misleading. ISHRAE design conditions are the right thing
          to check against for a real project; they could not be verified from an open, machine-readable
          source, so ASHRAE 2021 is used as the single checkable primary source throughout.
        </p>
        <p>
          Full provenance, the reasons for the indicative rows and the per-station record periods are in
          <a href="${GH_SOURCES}">docs/CLIMATE-SOURCES.md</a> on GitHub.
        </p>
      </div>

      <div class="callout warn">
        <h2>Verify before engineering use</h2>
        <p>
          These are outdoor <em>design conditions</em>, not a load calculation, and this page is a
          reference, not a design. A small number of stations rest on a record period older or shorter
          than the standard ${STANDARD_RECORD} \u2014 those periods are printed on each row. Before any
          engineering use, open the station's table, confirm the period, and check the value against
          ISHRAE / ASHRAE or the local code. A qualified HVAC engineer must verify every number.
        </p>
      </div>
    </div>
  </section>

  <!-- ======================= search + region index ======================= -->
  <section class="section" id="find">
    <div class="wrap">
      <div class="section-head prose">
        <h2>Find your city</h2>
        <p class="muted">
          Type any part of a <strong>city</strong>, <strong>country</strong> or <strong>station</strong>
          name. The list filters as you type \u2014 <strong>sourced and indicative rows alike</strong>
          \u2014 no network call, and with JavaScript off the full list stays on the page below.
        </p>
      </div>
      <div class="dc-search">
        <label for="dc-search">Search cities</label>
        <input id="dc-search" class="dc-search-input" type="search" autocomplete="off" spellcheck="false"
          placeholder="Search by city, country or station">
        <p class="dc-count" id="dc-count" role="status" aria-live="polite">Showing ${sourcedCitiesTotal} of ${sourcedCitiesTotal} sourced cities and ${indicativeTotal} of ${indicativeTotal} indicative rows</p>
      </div>
      <nav class="dc-index" aria-label="Regions">
        <span class="muted">Jump to:</span>
${indexLinks}
      </nav>
    </div>
  </section>

  <!-- ======================= regions (India first) ======================= -->
${regionSections.join("")}
  <!-- ======================= India indicative rows ======================= -->
  <section class="section dc-region" id="india-indicative" data-dc-region="india-indicative">
    <div class="wrap">
      <div class="section-head prose">
        <h2>India \u2014 indicative rows (not station values)</h2>
        <p class="muted">
          Cities with no ASHRAE station within the radius, plus the state/province estimates and the
          country-wide fallback. Each is an estimate; the reason is shown.
        </p>
      </div>
${table(indiaIndicative, "India \u2014 indicative estimates (no station within about 75 km)")}    </div>
  </section>

  <!-- ======================= call to action ======================= -->
  <section class="section">
    <div class="wrap prose">
      <h2>Calculate a cooling load for your own floor plan</h2>
      <p>
        LoadLens reads a floor plan PDF or an Excel / CSV room schedule, applies these design conditions,
        and returns the room-wise cooling load in TR, L/s and watts \u2014 in your browser; your drawing is never sent to a third party.
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
        <li><a href="design-conditions.html">Design conditions (worldwide)</a></li>
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

<script>
// In-page filter over EVERY row — sourced cities and the indicative estimates alike. No network,
// no framework. If this script never runs, every row is already in the HTML and the list stays
// complete. The counter is honest: it reports sourced and indicative matches separately, and no row
// that matches is hidden (the old filter only knew about sourced rows, so typing an indicative city
// like Kochi hid it and the counter said "0 of N sourced cities").
(function () {
  var box = document.getElementById('dc-search');
  if (!box) return;
  var count = document.getElementById('dc-count');
  var rows = [].slice.call(document.querySelectorAll('tr.dc-row'));
  var countries = [].slice.call(document.querySelectorAll('[data-dc-country]'));
  var regions = [].slice.call(document.querySelectorAll('[data-dc-region]'));
  var sourced = [];
  var totalSourced = 0, totalIndicative = 0;
  for (var s = 0; s < rows.length; s++) {
    var isSrc = rows[s].getAttribute('data-sourced') === 'true';
    sourced.push(isSrc);
    if (isSrc) totalSourced++; else totalIndicative++;
  }

  function norm(s) {
    return (s || '').toLowerCase().normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '');
  }
  var hay = rows.map(function (tr) { return norm(tr.getAttribute('data-search')); });

  function apply() {
    var q = norm(box.value.replace(/^\\s+|\\s+$/g, ''));
    var shownSourced = 0, shownIndicative = 0;
    for (var i = 0; i < rows.length; i++) {
      var hit = !q || hay[i].indexOf(q) !== -1;
      if (hit) rows[i].removeAttribute('hidden'); else rows[i].setAttribute('hidden', '');
      if (hit) { if (sourced[i]) shownSourced++; else shownIndicative++; }
    }
    for (var j = 0; j < countries.length; j++) {
      var c = countries[j];
      if (q && !c.querySelector('tr.dc-row:not([hidden])')) c.setAttribute('hidden', '');
      else c.removeAttribute('hidden');
    }
    for (var k = 0; k < regions.length; k++) {
      var s = regions[k];
      if (q && !s.querySelector('tr.dc-row:not([hidden])')) s.setAttribute('hidden', '');
      else s.removeAttribute('hidden');
    }
    if (count) count.textContent = 'Showing ' + shownSourced + ' of ' + totalSourced +
      ' sourced cities and ' + shownIndicative + ' of ' + totalIndicative + ' indicative rows';
  }

  box.addEventListener('input', apply);
})();
</script>

<script src="js/nav.js" defer></script>
</body>
</html>
`;

  // ---- assertions: the page must carry every sourced city, exactly as counted ----
  if (emittedSourced.size !== sourcedCitiesTotal) {
    throw new Error(
      `sourced city drift: table has ${sourcedCitiesTotal} sourced cities, generator rendered ${emittedSourced.size}`
    );
  }
  const renderedTrue = (html.match(/data-sourced="true"/g) || []).length;
  if (renderedTrue !== sourcedCitiesTotal) {
    throw new Error(
      `sourced row drift: table has ${sourcedCitiesTotal} sourced cities, page has ${renderedTrue} sourced rows`
    );
  }
  const renderedFalse = (html.match(/data-sourced="false"/g) || []).length;
  if (renderedFalse !== indicativeTotal) {
    throw new Error(
      `indicative row drift: generator says ${indicativeTotal} indicative rows, page has ${renderedFalse}`
    );
  }
  const printed = html.match(/Showing (\d+) of (\d+) sourced cities/);
  if (!printed || printed[1] !== String(sourcedCitiesTotal) || printed[2] !== String(sourcedCitiesTotal)) {
    throw new Error(`printed city count does not match js/climates.js (${sourcedCitiesTotal})`);
  }

  return { html, sourcedCitiesTotal };
}

// ---- main -----------------------------------------------------------------
const md = fs.readFileSync(MD_PATH, "utf8");
RECORD_PERIODS = parseRecordPeriods(md);

const { html, sourcedCitiesTotal } = build();
fs.writeFileSync(OUT_PATH, html);
console.log(`wrote ${path.relative(ROOT, OUT_PATH).replace(/\\/g, "/")} (${html.length} bytes)`);
console.log(`sourced cities emitted: ${sourcedCitiesTotal}`);

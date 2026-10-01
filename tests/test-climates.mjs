// js/climates.js — the location -> design-conditions table and its resolver.
// Run: node tests/test-climates.mjs        (pure Node: no browser, no server, no network)
//
// The point of these checks is the CONTRACT the app relies on:
//   * a city match is exact and case/punctuation-insensitive,
//   * a miss at city level falls back to the region, then to the whole country,
//   * an unknown place returns nulls — the resolver NEVER invents a dry bulb or wet bulb,
//   * every value in the table is physically plausible (db > wb, sane range),
//   * every row carries provenance: a non-null `src` (sourced) OR `indicative: true` (an estimate) —
//     nothing is left silently unsourced (see docs/CLIMATE-SOURCES.md).
import assert from 'node:assert/strict';
import {
  CLIMATE_TABLE, COUNTRY_ALIASES, resolveClimate, canonicalCountry, isKnownCity,
  countryFromTimezone, countryFromLocale, locationKey,
} from '../js/climates.js';

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? '  — ' + detail : ''}`); process.exitCode = 1; }
};

// ---------------------------------------------------------------- the table itself is data
{
  const india = CLIMATE_TABLE.India;
  const cities = Object.keys(india.cities);
  ok('the table has at least 15 Indian cities', cities.length >= 15, `${cities.length} cities`);
  ok('Kochi is 35 / 28 (the app default)',
    india.cities.Kochi.db === 35 && india.cities.Kochi.wb === 28);
  ok('Delhi is hotter than Chennai on dry bulb',
    india.cities.Delhi.db > india.cities.Chennai.db,
    `${india.cities.Delhi.db} vs ${india.cities.Chennai.db}`);
  ok('Chennai is more humid (higher WB) than Delhi',
    india.cities.Chennai.wb > india.cities.Delhi.wb,
    `${india.cities.Chennai.wb} vs ${india.cities.Delhi.wb}`);
  ok('every Indian city has a region row pointing at a plausible value',
    Object.keys(india.regions).length >= 10 && Object.values(india.regions).every((r) => r.db > r.wb));

  for (const [country, entry] of Object.entries(CLIMATE_TABLE)) {
    const rows = [entry.fallback, ...Object.values(entry.cities), ...Object.values(entry.regions)];
    const bad = rows.filter((r) => !Number.isFinite(r.db) || !Number.isFinite(r.wb) || r.db <= r.wb || r.db < 15 || r.db > 55 || r.wb < 5 || r.wb > 35);
    ok(`every row for ${country} is physical (db > wb, 15–55 / 5–35 °C)`, bad.length === 0,
      bad.length ? JSON.stringify(bad[0]) : `${rows.length} rows`);
  }

  // the named international examples (values are ASHRAE 2021 0.4% DB/MCWB — see docs/CLIMATE-SOURCES.md)
  ok('Dubai is present and hot', CLIMATE_TABLE['United Arab Emirates'].cities.Dubai.db >= 42,
    `Dubai ${CLIMATE_TABLE['United Arab Emirates'].cities.Dubai.db}/${CLIMATE_TABLE['United Arab Emirates'].cities.Dubai.wb}`);
  ok('Singapore is present and humid', CLIMATE_TABLE.Singapore.cities.Singapore.wb >= 25);
  ok('London is present', CLIMATE_TABLE['United Kingdom'].cities.London.db > 24);
}

// ---------------------------------------------------------------- provenance (sourced vs indicative)
{
  const badProvenance = [], badWhy = [], missingStation = [];
  let sourced = 0, indicative = 0;
  for (const [country, entry] of Object.entries(CLIMATE_TABLE)) {
    const rows = [
      ['fallback', entry.fallback],
      ...Object.entries(entry.cities || {}).map(([k, v]) => [`city ${k}`, v]),
      ...Object.entries(entry.regions || {}).map(([k, v]) => [`region ${k}`, v]),
    ];
    for (const [where, row] of rows) {
      const hasSrc = typeof row.src === 'string' && row.src.trim().length > 0;
      const isInd = row.indicative === true;
      if (hasSrc && !isInd) {
        sourced += 1;
        if (typeof row.station !== 'string' || !row.station.trim()) missingStation.push(`${country}/${where}`);
      } else if (isInd && !hasSrc) {
        indicative += 1;
        if (typeof row.why !== 'string' || !row.why.trim()) badWhy.push(`${country}/${where}`);
      } else {
        badProvenance.push(`${country}/${where}`);
      }
    }
  }
  ok('every row is EITHER sourced (a non-null src) OR explicitly flagged indicative',
    badProvenance.length === 0,
    badProvenance.length ? badProvenance.slice(0, 3).join(', ') : `${sourced} sourced, ${indicative} indicative`);
  ok('no row is both sourced and indicative, and none is silently unsourced', badProvenance.length === 0);
  ok('every sourced row names the station it came from', missingStation.length === 0,
    missingStation.slice(0, 3).join(', ') || 'all sourced rows carry a station');
  ok('every indicative row says why it is an estimate', badWhy.length === 0,
    badWhy.slice(0, 3).join(', ') || 'all indicative rows carry a why');
  ok('the table holds both genuinely sourced rows and flagged estimates',
    sourced > 0 && indicative > 0, `${sourced} sourced, ${indicative} indicative`);
}

// ---------------------------------------------------------------- city match
{
  const r = resolveClimate('India', 'Kerala', 'Kochi');
  ok('an exact city match resolves at city level',
    r.matched === 'city' && r.db === 35 && r.wb === 28, JSON.stringify(r));

  const loose = resolveClimate('  india ', 'kerala', 'KOCHI');
  ok('country / region / city matching ignores case and padding',
    loose.matched === 'city' && loose.db === 35 && loose.wb === 28, JSON.stringify(loose));

  const alias = resolveClimate('IN', 'Karnataka', 'Bangalore');
  ok('a city alias (Bangalore) resolves to Bengaluru',
    alias.matched === 'city' && alias.db === 34.3 && alias.wb === 20, JSON.stringify(alias));

  const accented = resolveClimate('Maldives', '', 'Male');
  ok('an accented city name (Malé) matches a plain-typed one',
    accented.matched === 'city' && accented.db === 32.2, JSON.stringify(accented));

  // the resolver hands back a fresh object, so a caller cannot corrupt the table
  const first = resolveClimate('India', 'Kerala', 'Kochi');
  first.db = 999;
  const second = resolveClimate('India', 'Kerala', 'Kochi');
  ok('mutating a result never changes the table', second.db === 35, String(second.db));
}

// ---------------------------------------------------------------- region fallback
{
  const r = resolveClimate('India', 'Kerala', 'Somewhere Not In The Table');
  ok('an unknown city falls back to the region row',
    r.matched === 'region' && r.db === 35 && r.wb === 28, JSON.stringify(r));

  const noRegion = resolveClimate('India', 'Rajasthan', 'Jodhpur');
  ok('a region-only match uses the region value',
    noRegion.matched === 'region' && noRegion.db === 44 && noRegion.wb === 24, JSON.stringify(noRegion));

  const suffix = resolveClimate('India', 'Kerala State', 'Nowhere');
  ok('a "State"-suffixed region still matches', suffix.matched === 'region' && suffix.db === 35);
}

// ---------------------------------------------------------------- country fallback
{
  const r = resolveClimate('India', 'Nowhere Province', 'Nowhere City');
  ok('an unknown city AND region falls back to the country value',
    r.matched === 'country' && r.db === 40 && r.wb === 26, JSON.stringify(r));

  const aliasCountry = resolveClimate('UAE', '', '');
  ok('a country code (UAE) resolves at country level',
    aliasCountry.matched === 'country' && aliasCountry.db === 46, JSON.stringify(aliasCountry));

  const longForm = resolveClimate('United States of America', 'Texas', 'Dallas');
  ok('a long country name resolves', longForm.matched === 'city' && longForm.db === 38.6,
    JSON.stringify(longForm));
}

// ---------------------------------------------------------------- no match: NEVER invents
{
  const none = resolveClimate('Atlantis', 'Atlantis', 'Atlantis City');
  ok('an unknown country matches nothing', none.matched === null, JSON.stringify(none));
  ok('a no-match carries strict nulls, not numbers or zeros',
    none.db === null && none.wb === null, JSON.stringify(none));
  ok('a no-match value is not a number', typeof none.db !== 'number' && typeof none.wb !== 'number');

  const empty = resolveClimate('', '', '');
  ok('empty input matches nothing and invents nothing',
    empty.matched === null && empty.db === null && empty.wb === null, JSON.stringify(empty));

  const nulls = resolveClimate(null, null, null);
  ok('null input is handled without throwing', nulls.matched === null && nulls.db === null);

  // never invents even when only a region is given for an unknown country
  const regionOnly = resolveClimate('Nowhereland', 'Kerala', 'Kochi');
  ok('an unknown country cannot borrow another country\'s numbers',
    regionOnly.db === null && regionOnly.matched === null, JSON.stringify(regionOnly));

  ok('canonicalCountry refuses to guess', canonicalCountry('Freedonia') === null
    && canonicalCountry('India') === 'India' && canonicalCountry('in') === 'India');

  ok('isKnownCity agrees with the resolver',
    isKnownCity('India', 'Kochi') === true && isKnownCity('India', 'Narnia') === false);
}

// ---------------------------------------------------------------- offline fallback helpers
{
  ok('the timezone Asia/Kolkata names India', countryFromTimezone('Asia/Kolkata') === 'India');
  ok('a US timezone names the United States', countryFromTimezone('America/Chicago') === 'United States');
  ok('an unknown timezone names nothing', countryFromTimezone('Mars/Olympus_Mons') === null
    && countryFromTimezone('') === null && countryFromTimezone(null) === null);

  ok('the locale en-IN names India', countryFromLocale('en-IN') === 'India');
  ok('a bare language with no region names nothing', countryFromLocale('en') === null);
  ok('an unmapped locale region names nothing', countryFromLocale('xx-ZZ') === null);

  ok('the dismissal key is stable and case-insensitive',
    locationKey('India', 'Kerala', 'Kochi') === locationKey('india', 'kerala', 'kochi'),
    locationKey('India', 'Kerala', 'Kochi'));
  ok('the dismissal key separates different cities',
    locationKey('India', 'Kerala', 'Kochi') !== locationKey('India', 'Kerala', 'Delhi'));
}

// ---------------------------------------------------------------- table / alias consistency
{
  const missingFallback = Object.entries(CLIMATE_TABLE).filter(([, e]) => !e.fallback).map(([c]) => c);
  ok('every country has a fallback row', missingFallback.length === 0, missingFallback.join(', '));

  const danglingAlias = Object.entries(COUNTRY_ALIASES)
    .filter(([, target]) => !CLIMATE_TABLE[target]).map(([k]) => k);
  ok('no country alias points at a country with no table row', danglingAlias.length === 0,
    danglingAlias.join(', '));
}

// ---------------------------------------------------------------- provenance hardening
// `src` used to accept any non-empty string; a typo or a joke label would have passed. Pin it to a
// known source vocabulary, require a station (or an explicit note), and pin the two cross-border /
// false-flag rows that the citation audit corrected.
{
  const SRC_VOCAB = [/^ASHRAE 2021/, /^IS 7896/];
  let sourced = 0;
  const badSrc = [], noStationOrNote = [];
  for (const [country, entry] of Object.entries(CLIMATE_TABLE)) {
    const rows = [entry.fallback, ...Object.values(entry.cities || {}), ...Object.values(entry.regions || {})];
    for (const row of rows) {
      const hasSrc = typeof row.src === 'string' && row.src.trim().length > 0;
      if (!hasSrc) continue;
      sourced += 1;
      if (!SRC_VOCAB.some((re) => re.test(row.src))) badSrc.push(`${country}: ${JSON.stringify(row.src)}`);
      const hasStation = typeof row.station === 'string' && row.station.trim().length > 0;
      const hasNote = typeof row.note === 'string' && row.note.trim().length > 0;
      if (!hasStation && !hasNote) noStationOrNote.push(`${country}`);
    }
  }
  ok("every sourced row's src is a known source label (ASHRAE 2021 / IS 7896)",
    badSrc.length === 0, badSrc.slice(0, 3).join(', ') || `${sourced} sourced rows in vocabulary`);
  ok('every sourced row carries a station or an explicit note',
    noStationOrNote.length === 0, noStationOrNote.slice(0, 3).join(', ') || `${sourced} sourced rows accounted for`);

  // Johor Bahru: was flagged indicative with a false "no station within 75 km" reason; it is 33.2/26.3
  // from SINGAPORE/CHANGI INTL (WMO 486980) ~30 km away, and is now sourced.
  const jb = CLIMATE_TABLE.Malaysia.cities['Johor Bahru'];
  ok('Johor Bahru is now sourced (not indicative) from Singapore/Changi at 33.2 / 26.3',
    jb.indicative !== true && jb.src === 'ASHRAE 2021' && /486980/.test(jb.station)
      && jb.db === 33.2 && jb.wb === 26.3, JSON.stringify(jb));
  ok('Johor Bahru explains that its station is across the border in Singapore',
    typeof jb.note === 'string' && /singapore/i.test(jb.note), jb.note);

  // Amritsar: Indian city served cross-border by LAHORE ALLAMA IQBAL INTL (WMO 416410); the borrowing
  // is now annotated rather than silent.
  const amritsar = CLIMATE_TABLE.India.cities.Amritsar;
  ok('Amritsar is sourced to Lahore and carries a cross-border note',
    amritsar.src === 'ASHRAE 2021' && /416410/.test(amritsar.station)
      && typeof amritsar.note === 'string' && /pakistan/i.test(amritsar.note), JSON.stringify(amritsar));

  // Cancun: a station exists ~15 km away but has no 2021 data — it stays indicative, with the true reason.
  const cancun = CLIMATE_TABLE.Mexico.cities.Cancun;
  ok('Cancun stays indicative with the true reason (station 765906 lacks 2021 data)',
    cancun.indicative === true && /765906/.test(cancun.why) && /2021/.test(cancun.why), cancun.why);

  ok("Chicago station name uses the official O'Hare spelling",
    CLIMATE_TABLE['United States'].cities.Chicago.station === "CHICAGO O'HARE (WMO 725300)",
    CLIMATE_TABLE['United States'].cities.Chicago.station);
}

assert.equal(typeof resolveClimate, 'function'); // keep the import honest

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('ALL CLIMATE CHECKS PASSED');

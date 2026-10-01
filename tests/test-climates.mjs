// js/climates.js — the location -> design-conditions table and its resolver.
// Run: node tests/test-climates.mjs        (pure Node: no browser, no server, no network)
//
// The point of these checks is the CONTRACT the app relies on:
//   * a city match is exact and case/punctuation-insensitive,
//   * a miss at city level falls back to the region, then to the whole country,
//   * an unknown place returns nulls — the resolver NEVER invents a dry bulb or wet bulb,
//   * every value in the table is physically plausible (db > wb, sane range).
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

  // the named international examples
  ok('Dubai is present and hot', CLIMATE_TABLE['United Arab Emirates'].cities.Dubai.db >= 44);
  ok('Singapore is present and humid', CLIMATE_TABLE.Singapore.cities.Singapore.wb >= 25);
  ok('London is present', CLIMATE_TABLE['United Kingdom'].cities.London.db > 24);
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
    alias.matched === 'city' && alias.db === 34 && alias.wb === 22, JSON.stringify(alias));

  const accented = resolveClimate('Maldives', '', 'Male');
  ok('an accented city name (Malé) matches a plain-typed one',
    accented.matched === 'city' && accented.db === 32, JSON.stringify(accented));

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
  ok('a long country name resolves', longForm.matched === 'city' && longForm.db === 38,
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

assert.equal(typeof resolveClimate, 'function'); // keep the import honest

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('ALL CLIMATE CHECKS PASSED');

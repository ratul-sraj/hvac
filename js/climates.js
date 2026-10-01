/**
 * climates.js — where LoadLens's location-aware design conditions come from.
 *
 * PURE and DOM-FREE: no fetch, no state, no DOM, no localStorage. Importable in plain Node
 * (see tests/test-climates.mjs), so the mapping rules can be pinned without a browser.
 *
 * It is TWO things:
 *   1. a LOOKUP TABLE of summer outdoor design conditions (dry bulb / coincident wet bulb, °C)
 *      keyed by country -> city, country -> region, and country -> generic fallback; plus a few
 *      helpers that turn a timezone or a browser locale into a country NAME;
 *   2. a RESOLVER, resolveClimate(country, region, city), that answers with the most specific row
 *      it can find and NEVER invents a number: an unknown location comes back with nulls.
 *
 * ⚠⚠  EDITABLE DATA — VERIFY BEFORE ENGINEERING USE  ⚠⚠
 * The numbers below are a STARTING POINT, gathered from values commonly used in design practice
 * (ISHRAE / ASHRAE-style summer design conditions). They are DATA, not logic: edit them freely to
 * suit your project, your code and your edition of the standards. They are INDICATIVE ONLY and
 * must be checked against ISHRAE / ASHRAE / the local authority before any engineering use. The
 * app says the same thing to the user, next to the fields it fills in.
 *
 * To add a place: put a { db, wb } row under the country's `cities` (city-level), `regions`
 * (state/province-level), or `fallback` (whole-country default). Nothing else to change.
 */

// ---------------------------------------------------------------------------------------------
// THE TABLE — edit these numbers, not the code around them.
// ---------------------------------------------------------------------------------------------
export const CLIMATE_TABLE = {
  India: {
    fallback: { db: 40, wb: 26 },
    regions: {
      Kerala: { db: 35, wb: 28 }, Karnataka: { db: 34, wb: 23 },
      'Tamil Nadu': { db: 38, wb: 27 }, Telangana: { db: 41, wb: 24 },
      'Andhra Pradesh': { db: 36, wb: 27 }, Delhi: { db: 43, wb: 24 },
      Maharashtra: { db: 36, wb: 26 }, Gujarat: { db: 42, wb: 25 },
      Rajasthan: { db: 44, wb: 24 }, 'West Bengal': { db: 38, wb: 28 },
      'Uttar Pradesh': { db: 43, wb: 25 }, 'Madhya Pradesh': { db: 41, wb: 24 },
      Punjab: { db: 42, wb: 25 }, Haryana: { db: 43, wb: 24 },
      Assam: { db: 36, wb: 27 }, Bihar: { db: 42, wb: 26 }, Goa: { db: 33, wb: 27 },
    },
    cities: {
      Kochi: { db: 35, wb: 28 }, Thiruvananthapuram: { db: 34, wb: 27.5 },
      Kozhikode: { db: 35, wb: 28 }, Thrissur: { db: 36, wb: 27.5 },
      Kannur: { db: 35, wb: 28 }, Kollam: { db: 34, wb: 27.5 },
      Kottayam: { db: 35, wb: 27.5 }, Palakkad: { db: 38, wb: 26 },
      Mangaluru: { db: 35, wb: 27.5 }, Bengaluru: { db: 34, wb: 22 },
      Mysuru: { db: 33, wb: 22 }, Chennai: { db: 38, wb: 28 },
      Coimbatore: { db: 36, wb: 24 }, Madurai: { db: 39, wb: 26 },
      Hyderabad: { db: 41, wb: 24 }, Visakhapatnam: { db: 36, wb: 28 },
      Delhi: { db: 43, wb: 24 }, 'New Delhi': { db: 43, wb: 24 },
      Gurugram: { db: 43, wb: 24 }, Faridabad: { db: 43, wb: 24 },
      Mumbai: { db: 35, wb: 27.5 }, Pune: { db: 38, wb: 23 }, Nagpur: { db: 44, wb: 24 },
      Ahmedabad: { db: 43, wb: 25 }, Surat: { db: 38, wb: 27 },
      Jaipur: { db: 44, wb: 24 }, Kolkata: { db: 38, wb: 28 },
      Lucknow: { db: 43, wb: 25 }, Kanpur: { db: 43, wb: 26 },
      Bhopal: { db: 42, wb: 24 }, Indore: { db: 40, wb: 23 },
      Amritsar: { db: 42, wb: 26 }, Ludhiana: { db: 42, wb: 26 },
      Guwahati: { db: 36, wb: 27 }, Patna: { db: 42, wb: 27 }, Panaji: { db: 33, wb: 27 },
    },
  },

  'United Arab Emirates': {
    fallback: { db: 46, wb: 29 },
    regions: {},
    cities: {
      Dubai: { db: 46, wb: 29 }, 'Abu Dhabi': { db: 46, wb: 29 },
      Sharjah: { db: 46, wb: 29 }, Ajman: { db: 46, wb: 29 },
      Fujairah: { db: 44, wb: 30 }, 'Ras Al Khaimah': { db: 46, wb: 29 },
      'Al Ain': { db: 48, wb: 26 },
    },
  },
  'Saudi Arabia': {
    fallback: { db: 45, wb: 24 },
    regions: {},
    cities: {
      Riyadh: { db: 46, wb: 22 }, Jeddah: { db: 43, wb: 29 },
      Dammam: { db: 46, wb: 28 }, Makkah: { db: 46, wb: 26 },
      Madinah: { db: 46, wb: 22 },
    },
  },
  Qatar: { fallback: { db: 46, wb: 28 }, regions: {}, cities: { Doha: { db: 46, wb: 28 } } },
  Oman: {
    fallback: { db: 46, wb: 29 }, regions: {},
    cities: { Muscat: { db: 46, wb: 29 }, Sohar: { db: 45, wb: 29 }, Salalah: { db: 36, wb: 28 } },
  },
  Kuwait: { fallback: { db: 48, wb: 24 }, regions: {}, cities: { 'Kuwait City': { db: 48, wb: 24 } } },
  Bahrain: { fallback: { db: 43, wb: 29 }, regions: {}, cities: { Manama: { db: 43, wb: 29 } } },
  Singapore: { fallback: { db: 33, wb: 26.5 }, regions: {}, cities: { Singapore: { db: 33, wb: 26.5 } } },
  Malaysia: {
    fallback: { db: 34, wb: 27 }, regions: {},
    cities: {
      'Kuala Lumpur': { db: 34, wb: 27 }, Penang: { db: 33, wb: 27 },
      'Johor Bahru': { db: 33, wb: 27 }, 'George Town': { db: 33, wb: 27 },
    },
  },
  'Sri Lanka': { fallback: { db: 33, wb: 27 }, regions: {}, cities: { Colombo: { db: 33, wb: 27 } } },
  Maldives: { fallback: { db: 32, wb: 27 }, regions: {}, cities: { 'Malé': { db: 32, wb: 27 } } },
  Pakistan: {
    fallback: { db: 40, wb: 26 }, regions: {},
    cities: { Karachi: { db: 36, wb: 28 }, Lahore: { db: 41, wb: 26 }, Islamabad: { db: 40, wb: 26 } },
  },
  Bangladesh: {
    fallback: { db: 34, wb: 27 }, regions: {},
    cities: { Dhaka: { db: 34, wb: 27 }, Chittagong: { db: 33, wb: 27 } },
  },
  Nepal: { fallback: { db: 30, wb: 22 }, regions: {}, cities: { Kathmandu: { db: 30, wb: 22 } } },

  'United Kingdom': {
    fallback: { db: 28, wb: 20 },
    regions: { England: { db: 28, wb: 20 }, Scotland: { db: 24, wb: 18 }, Wales: { db: 26, wb: 19 }, 'Northern Ireland': { db: 24, wb: 18 } },
    cities: {
      London: { db: 28, wb: 20 }, Birmingham: { db: 27, wb: 19 },
      Manchester: { db: 26, wb: 19 }, Edinburgh: { db: 24, wb: 18 },
      Glasgow: { db: 24, wb: 18 }, Bristol: { db: 27, wb: 19 },
    },
  },
  'United States': {
    fallback: { db: 35, wb: 24 },
    regions: {
      Texas: { db: 38, wb: 24 }, California: { db: 32, wb: 21 }, Florida: { db: 34, wb: 26 },
      'New York': { db: 33, wb: 24 }, Arizona: { db: 43, wb: 22 }, Illinois: { db: 32, wb: 24 },
    },
    cities: {
      'New York': { db: 33, wb: 24 }, 'Los Angeles': { db: 32, wb: 21 },
      Chicago: { db: 32, wb: 24 }, Houston: { db: 36, wb: 26 },
      Phoenix: { db: 43, wb: 22 }, Miami: { db: 33, wb: 26 },
      Atlanta: { db: 34, wb: 24 }, Dallas: { db: 38, wb: 24 },
      'San Francisco': { db: 26, wb: 18 }, Seattle: { db: 28, wb: 19 },
      Boston: { db: 31, wb: 23 }, Washington: { db: 34, wb: 25 },
      Denver: { db: 33, wb: 18 }, 'Las Vegas': { db: 42, wb: 20 },
      Orlando: { db: 34, wb: 26 },
    },
  },
  Canada: {
    fallback: { db: 30, wb: 22 },
    regions: { Ontario: { db: 30, wb: 22 }, Quebec: { db: 30, wb: 22 }, 'British Columbia': { db: 26, wb: 19 }, Alberta: { db: 28, wb: 18 } },
    cities: {
      Toronto: { db: 31, wb: 23 }, Vancouver: { db: 26, wb: 19 },
      Montreal: { db: 30, wb: 22 }, Calgary: { db: 29, wb: 18 }, Ottawa: { db: 30, wb: 22 },
    },
  },
  Australia: {
    fallback: { db: 38, wb: 24 },
    regions: {
      'New South Wales': { db: 34, wb: 23 }, Victoria: { db: 36, wb: 21 },
      Queensland: { db: 33, wb: 25 }, 'Western Australia': { db: 38, wb: 23 },
      'South Australia': { db: 38, wb: 22 }, 'Northern Territory': { db: 35, wb: 27 },
    },
    cities: {
      Sydney: { db: 34, wb: 23 }, Melbourne: { db: 36, wb: 21 },
      Brisbane: { db: 33, wb: 25 }, Perth: { db: 38, wb: 23 },
      Adelaide: { db: 38, wb: 22 }, Darwin: { db: 35, wb: 27 },
    },
  },
  'New Zealand': { fallback: { db: 26, wb: 18 }, regions: {}, cities: { Auckland: { db: 26, wb: 18 } } },

  Germany: {
    fallback: { db: 30, wb: 20 }, regions: {},
    cities: { Berlin: { db: 31, wb: 20 }, Munich: { db: 30, wb: 19 }, Frankfurt: { db: 32, wb: 20 }, Hamburg: { db: 28, wb: 19 } },
  },
  France: {
    fallback: { db: 32, wb: 21 }, regions: {},
    cities: { Paris: { db: 32, wb: 21 }, Marseille: { db: 34, wb: 23 }, Lyon: { db: 33, wb: 21 } },
  },
  Spain: {
    fallback: { db: 35, wb: 23 }, regions: {},
    cities: { Madrid: { db: 36, wb: 22 }, Barcelona: { db: 32, wb: 24 }, Seville: { db: 39, wb: 23 } },
  },
  Netherlands: { fallback: { db: 28, wb: 19 }, regions: {}, cities: { Amsterdam: { db: 28, wb: 19 } } },

  Turkey: {
    fallback: { db: 34, wb: 23 }, regions: {},
    cities: { Istanbul: { db: 32, wb: 23 }, Ankara: { db: 34, wb: 21 } },
  },
  Egypt: { fallback: { db: 38, wb: 24 }, regions: {}, cities: { Cairo: { db: 38, wb: 24 } } },
  Israel: { fallback: { db: 33, wb: 25 }, regions: {}, cities: { 'Tel Aviv': { db: 33, wb: 25 } } },

  Japan: {
    fallback: { db: 34, wb: 26 }, regions: {},
    cities: { Tokyo: { db: 34, wb: 26 }, Osaka: { db: 34, wb: 26 } },
  },
  China: {
    fallback: { db: 35, wb: 27 }, regions: {},
    cities: {
      Beijing: { db: 34, wb: 26 }, Shanghai: { db: 34, wb: 27 },
      Guangzhou: { db: 35, wb: 27 }, Shenzhen: { db: 34, wb: 27 },
    },
  },
  'Hong Kong': { fallback: { db: 33, wb: 27 }, regions: {}, cities: { 'Hong Kong': { db: 33, wb: 27 } } },
  Thailand: {
    fallback: { db: 36, wb: 27 }, regions: {},
    cities: { Bangkok: { db: 36, wb: 27 }, Phuket: { db: 33, wb: 27 }, 'Chiang Mai': { db: 36, wb: 25 } },
  },
  Indonesia: {
    fallback: { db: 33, wb: 26 }, regions: {},
    cities: { Jakarta: { db: 33, wb: 26 }, Denpasar: { db: 32, wb: 26 }, Surabaya: { db: 34, wb: 26 } },
  },
  Philippines: { fallback: { db: 34, wb: 27 }, regions: {}, cities: { Manila: { db: 34, wb: 27 } } },
  Vietnam: {
    fallback: { db: 36, wb: 27 }, regions: {},
    cities: { Hanoi: { db: 36, wb: 27 }, 'Ho Chi Minh City': { db: 35, wb: 27 } },
  },

  'South Africa': {
    fallback: { db: 32, wb: 20 }, regions: {},
    cities: { Johannesburg: { db: 28, wb: 17 }, 'Cape Town': { db: 28, wb: 18 }, Durban: { db: 31, wb: 23 } },
  },
  Nigeria: {
    fallback: { db: 33, wb: 25 }, regions: {},
    cities: { Lagos: { db: 33, wb: 25 }, Abuja: { db: 36, wb: 23 } },
  },
  Kenya: {
    fallback: { db: 27, wb: 19 }, regions: {},
    cities: { Nairobi: { db: 27, wb: 19 }, Mombasa: { db: 32, wb: 25 } },
  },
  Brazil: {
    fallback: { db: 33, wb: 24 }, regions: {},
    cities: { 'São Paulo': { db: 30, wb: 21 }, 'Rio de Janeiro': { db: 34, wb: 25 } },
  },
  Russia: {
    fallback: { db: 28, wb: 19 }, regions: {},
    cities: { Moscow: { db: 28, wb: 19 }, 'Saint Petersburg': { db: 25, wb: 18 } },
  },
  Mexico: {
    fallback: { db: 34, wb: 22 }, regions: {},
    cities: { 'Mexico City': { db: 26, wb: 17 }, Cancun: { db: 33, wb: 26 }, Guadalajara: { db: 32, wb: 20 } },
  },
};

// ---------------------------------------------------------------------------------------------
// COUNTRY ALIASES — country names / codes that mean the same country as a CLIMATE_TABLE key.
// Keyed by the lower-case, punctuation-free form (see norm()).
// ---------------------------------------------------------------------------------------------
export const COUNTRY_ALIASES = {
  'india': 'India', in: 'India', ind: 'India',
  'united arab emirates': 'United Arab Emirates', uae: 'United Arab Emirates', ae: 'United Arab Emirates', emirates: 'United Arab Emirates',
  'saudi arabia': 'Saudi Arabia', ksa: 'Saudi Arabia', sa: 'Saudi Arabia',
  qatar: 'Qatar', qa: 'Qatar',
  oman: 'Oman', om: 'Oman',
  kuwait: 'Kuwait', kw: 'Kuwait',
  bahrain: 'Bahrain', bh: 'Bahrain',
  singapore: 'Singapore', sg: 'Singapore',
  malaysia: 'Malaysia', my: 'Malaysia',
  'sri lanka': 'Sri Lanka', lk: 'Sri Lanka', ceylon: 'Sri Lanka',
  maldives: 'Maldives', mv: 'Maldives',
  pakistan: 'Pakistan', pk: 'Pakistan',
  bangladesh: 'Bangladesh', bd: 'Bangladesh',
  nepal: 'Nepal', np: 'Nepal',
  'united kingdom': 'United Kingdom', uk: 'United Kingdom', gb: 'United Kingdom',
  'great britain': 'United Kingdom', britain: 'United Kingdom', 'england and wales': 'United Kingdom',
  'united states': 'United States', 'united states of america': 'United States', usa: 'United States', us: 'United States',
  canada: 'Canada', ca: 'Canada',
  australia: 'Australia', au: 'Australia',
  'new zealand': 'New Zealand', nz: 'New Zealand',
  germany: 'Germany', de: 'Germany',
  france: 'France', fr: 'France',
  spain: 'Spain', es: 'Spain',
  netherlands: 'Netherlands', holland: 'Netherlands', nl: 'Netherlands',
  turkey: 'Turkey', 'türkiye': 'Turkey', tr: 'Turkey',
  egypt: 'Egypt', eg: 'Egypt',
  israel: 'Israel', il: 'Israel',
  japan: 'Japan', jp: 'Japan',
  china: 'China', cn: 'China',
  'hong kong': 'Hong Kong', hk: 'Hong Kong', 'hong kong sar': 'Hong Kong',
  thailand: 'Thailand', th: 'Thailand',
  indonesia: 'Indonesia', id: 'Indonesia',
  philippines: 'Philippines', ph: 'Philippines',
  vietnam: 'Vietnam', 'viet nam': 'Vietnam', vn: 'Vietnam',
  'south africa': 'South Africa', za: 'South Africa',
  nigeria: 'Nigeria', ng: 'Nigeria',
  kenya: 'Kenya', ke: 'Kenya',
  brazil: 'Brazil', br: 'Brazil',
  russia: 'Russia', ru: 'Russia',
  mexico: 'Mexico', mx: 'Mexico',
};

// Spelled-out variants that do not need a table row of their own but DO need the same city:
// e.g. the built-in city dropdown says "Bengaluru" while a visitor's IP says "Bangalore".
const CITY_ALIASES = {
  bangalore: 'Bengaluru', bombay: 'Mumbai', madras: 'Chennai', calcutta: 'Kolkata',
  cochin: 'Kochi', calicut: 'Kozhikode', trivandrum: 'Thiruvananthapuram',
  mysore: 'Mysuru', gurgaon: 'Gurugram', 'new delhi': 'New Delhi',
  mecca: 'Makkah', medina: 'Madinah', 'kuala lumpur': 'Kuala Lumpur',
  'ho chi minh': 'Ho Chi Minh City', saigon: 'Ho Chi Minh City', bangkok: 'Bangkok',
};

// ---------------------------------------------------------------------------------------------
// TIMEZONE / LOCALE -> COUNTRY (the offline fallback when the IP lookup cannot be reached).
// The country NAME is then run through the resolver at country level — no weather value is ever
// guessed here. Only exact IANA names are honoured; anything unknown returns null.
// ---------------------------------------------------------------------------------------------
export const COUNTRY_FROM_TIMEZONE = {
  'Asia/Kolkata': 'India', 'Asia/Calcutta': 'India',
  'Asia/Dubai': 'United Arab Emirates', 'Asia/Qatar': 'Qatar', 'Asia/Riyadh': 'Saudi Arabia',
  'Asia/Kuwait': 'Kuwait', 'Asia/Bahrain': 'Bahrain', 'Asia/Muscat': 'Oman',
  'Asia/Singapore': 'Singapore', 'Asia/Kuala_Lumpur': 'Malaysia', 'Asia/Colombo': 'Sri Lanka',
  'Asia/Male': 'Maldives', 'Asia/Karachi': 'Pakistan', 'Asia/Dhaka': 'Bangladesh',
  'Asia/Kathmandu': 'Nepal', 'Asia/Hong_Kong': 'Hong Kong', 'Asia/Shanghai': 'China',
  'Asia/Tokyo': 'Japan', 'Asia/Bangkok': 'Thailand', 'Asia/Jakarta': 'Indonesia',
  'Asia/Manila': 'Philippines', 'Asia/Ho_Chi_Minh': 'Vietnam', 'Asia/Saigon': 'Vietnam',
  'Asia/Jerusalem': 'Israel', 'Asia/Istanbul': 'Turkey',
  'Europe/London': 'United Kingdom', 'Europe/Berlin': 'Germany', 'Europe/Paris': 'France',
  'Europe/Madrid': 'Spain', 'Europe/Amsterdam': 'Netherlands', 'Europe/Moscow': 'Russia',
  'Africa/Cairo': 'Egypt', 'Africa/Johannesburg': 'South Africa', 'Africa/Lagos': 'Nigeria',
  'Africa/Nairobi': 'Kenya',
  'America/New_York': 'United States', 'America/Chicago': 'United States',
  'America/Denver': 'United States', 'America/Los_Angeles': 'United States',
  'America/Phoenix': 'United States', 'America/Toronto': 'Canada', 'America/Vancouver': 'Canada',
  'America/Sao_Paulo': 'Brazil', 'America/Mexico_City': 'Mexico',
  'Australia/Sydney': 'Australia', 'Australia/Melbourne': 'Australia',
  'Australia/Brisbane': 'Australia', 'Australia/Perth': 'Australia',
  'Pacific/Auckland': 'New Zealand',
};

// ISO 3166-1 alpha-2 region subtags that mean a country in the table (from navigator.language).
const LOCALE_REGION = {
  IN: 'India', AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar', OM: 'Oman',
  KW: 'Kuwait', BH: 'Bahrain', SG: 'Singapore', MY: 'Malaysia', LK: 'Sri Lanka',
  MV: 'Maldives', PK: 'Pakistan', BD: 'Bangladesh', NP: 'Nepal', GB: 'United Kingdom',
  US: 'United States', CA: 'Canada', AU: 'Australia', NZ: 'New Zealand', DE: 'Germany',
  FR: 'France', ES: 'Spain', NL: 'Netherlands', TR: 'Turkey', EG: 'Egypt', IL: 'Israel',
  JP: 'Japan', CN: 'China', HK: 'Hong Kong', TH: 'Thailand', ID: 'Indonesia',
  PH: 'Philippines', VN: 'Vietnam', ZA: 'South Africa', NG: 'Nigeria', KE: 'Kenya', BR: 'Brazil',
};

/** Lower-case, accent- and punctuation-free form used for every comparison in this file. */
function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The CLIMATE_TABLE key (or alias target) a country name / code means, else null. Never guesses. */
export function canonicalCountry(country) {
  const n = norm(country);
  if (!n) return null;
  for (const name of Object.keys(CLIMATE_TABLE)) if (norm(name) === n) return name;
  return COUNTRY_ALIASES[n] || null;
}

/** The city key of `bag` whose normalised name equals `needle`, or null. */
function findCity(bag, needle) {
  if (!needle) return null;
  for (const key of Object.keys(bag)) if (norm(key) === needle) return key;
  const alias = CITY_ALIASES[needle];
  if (alias && bag[alias]) return alias;
  return null;
}

/** The region key of `bag` whose normalised name equals `needle`, or null. */
function findRegion(bag, needle) {
  if (!needle) return null;
  for (const key of Object.keys(bag)) if (norm(key) === needle) return key;
  // "Kerala" typed as "kerala state" / "Kerala State" should still land on Kerala.
  const trimmed = needle.replace(/\s*(state|province|region|governorate|emirate|prefecture)\s*$/, '').trim();
  if (trimmed && trimmed !== needle) {
    for (const key of Object.keys(bag)) if (norm(key) === trimmed) return key;
  }
  return null;
}

/**
 * The best-known summer design conditions for a location.
 *
 *   resolveClimate('India', 'Kerala', 'Kochi')  -> { db: 35, wb: 28, matched: 'city' }
 *   resolveClimate('India', 'Kerala', 'Nowhere')-> { db: 35, wb: 28, matched: 'region' }
 *   resolveClimate('India', 'Unknown', 'X')     -> { db: 40, wb: 26, matched: 'country' }
 *   resolveClimate('Atlantis', '', 'X')         -> { db: null, wb: null, matched: null }
 *
 * It NEVER invents values: when nothing matches, the object carries nulls, so the caller knows to
 * leave the fields exactly as they were.
 */
export function resolveClimate(country, region, city) {
  // also accept resolveClimate({ country, region, city })
  if (country && typeof country === 'object') {
    ({ country, region, city } = country);
  }
  const c = canonicalCountry(country);
  if (!c) return { db: null, wb: null, matched: null };
  const entry = CLIMATE_TABLE[c];
  const cities = entry.cities || {};
  const regions = entry.regions || {};

  const cityKey = findCity(cities, norm(city));
  if (cityKey) return { db: cities[cityKey].db, wb: cities[cityKey].wb, matched: 'city' };

  const regionKey = findRegion(regions, norm(region));
  if (regionKey) return { db: regions[regionKey].db, wb: regions[regionKey].wb, matched: 'region' };

  if (entry.fallback) return { db: entry.fallback.db, wb: entry.fallback.wb, matched: 'country' };
  return { db: null, wb: null, matched: null };
}

/** Is `city` a city this table knows, in `country`? (used by the UI to decide how to word the chip) */
export function isKnownCity(country, city) {
  const c = canonicalCountry(country);
  if (!c) return false;
  return !!findCity(CLIMATE_TABLE[c].cities || {}, norm(city));
}

/** Country name for an IANA timezone, or null when it is not one we can name. Never guesses. */
export function countryFromTimezone(tz) {
  const key = String(tz == null ? '' : tz).trim();
  if (!key) return null;
  return COUNTRY_FROM_TIMEZONE[key] || null;
}

/** Country name for a BCP-47 language tag like 'en-IN', via its region subtag, or null. */
export function countryFromLocale(language) {
  const m = String(language == null ? '' : language).match(/[-_]([A-Za-z]{2})(?![A-Za-z])/);
  if (!m) return null;
  return LOCALE_REGION[m[1].toUpperCase()] || null;
}

/** A stable, case-insensitive key for "this detected location" — used to remember dismissals. */
export function locationKey(country, region, city) {
  return [norm(country), norm(region), norm(city)].join('|');
}

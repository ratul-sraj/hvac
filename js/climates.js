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
 * ⚠⚠  DESIGN CONDITIONS — SOURCED WHERE POSSIBLE, VERIFY BEFORE ENGINEERING USE  ⚠⚠
 * City rows carry the outdoor summer design conditions from the sources catalogued in
 * docs/CLIMATE-SOURCES.md and a per-row `src` + `station` provenance
 * (ASHRAE 2021 Handbook—Fundamentals, Ch.14, 0.4% annual cooling DB / mean coincident WB).
 * Rows flagged `indicative: true` are ESTIMATES — either a state/country-level approximation or a
 * place with no station value within a sensible radius — and each carries a short `why`.
 * Every row must be one or the other: a non-null `src`, or `indicative: true`; nothing is silently
 * unsourced (tests/test-climates.mjs enforces this). Check any value against ISHRAE / ASHRAE / the
 * local authority before any engineering use; the app says the same thing to the user.
 *
 * To add a place: put a { db, wb, src, station } row under the country's `cities` (city-level),
 * `regions` (state/province-level), or `fallback` (whole-country default); use
 * { db, wb, indicative: true, why } when no source exists. Nothing else to change.
 */

// ---------------------------------------------------------------------------------------------
// THE TABLE — edit these numbers, not the code around them. Provenance:
// docs/CLIMATE-SOURCES.md (city | DB | WB | source | edition | url).
// ---------------------------------------------------------------------------------------------
export const CLIMATE_TABLE = {
  India: {
    fallback: { db: 40, wb: 26, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {
      Kerala: { db: 35, wb: 28, indicative: true, why: 'state/province estimate; not a station value' },
      Karnataka: { db: 34, wb: 23, indicative: true, why: 'state/province estimate; not a station value' },
      'Tamil Nadu': { db: 38, wb: 27, indicative: true, why: 'state/province estimate; not a station value' },
      Telangana: { db: 41, wb: 24, indicative: true, why: 'state/province estimate; not a station value' },
      'Andhra Pradesh': { db: 36, wb: 27, indicative: true, why: 'state/province estimate; not a station value' },
      Delhi: { db: 43, wb: 24, indicative: true, why: 'state/province estimate; not a station value' },
      Maharashtra: { db: 36, wb: 26, indicative: true, why: 'state/province estimate; not a station value' },
      Gujarat: { db: 42, wb: 25, indicative: true, why: 'state/province estimate; not a station value' },
      Rajasthan: { db: 44, wb: 24, indicative: true, why: 'state/province estimate; not a station value' },
      'West Bengal': { db: 38, wb: 28, indicative: true, why: 'state/province estimate; not a station value' },
      'Uttar Pradesh': { db: 43, wb: 25, indicative: true, why: 'state/province estimate; not a station value' },
      'Madhya Pradesh': { db: 41, wb: 24, indicative: true, why: 'state/province estimate; not a station value' },
      Punjab: { db: 42, wb: 25, indicative: true, why: 'state/province estimate; not a station value' },
      Haryana: { db: 43, wb: 24, indicative: true, why: 'state/province estimate; not a station value' },
      Assam: { db: 36, wb: 27, indicative: true, why: 'state/province estimate; not a station value' },
      Bihar: { db: 42, wb: 26, indicative: true, why: 'state/province estimate; not a station value' },
      Goa: { db: 33, wb: 27, indicative: true, why: 'state/province estimate; not a station value' },
    },
    cities: {
      Kochi: { db: 35, wb: 28, indicative: true, why: 'no ASHRAE station within 75 km; indicative value kept' },
      Thiruvananthapuram: { db: 34.2, wb: 26.2, src: 'ASHRAE 2021', station: 'THIRUVANANTHAPURAM (WMO 433710)' },
      Kozhikode: { db: 35.2, wb: 28.2, src: 'ASHRAE 2021', station: 'KOZHIKODE (WMO 433140)' },
      Thrissur: { db: 36, wb: 27.5, indicative: true, why: 'no ASHRAE station within 75 km; indicative value kept' },
      Kannur: { db: 35, wb: 28, indicative: true, why: 'no ASHRAE station within 75 km; indicative value kept' },
      Kollam: { db: 34.2, wb: 26.2, src: 'ASHRAE 2021', station: 'THIRUVANANTHAPURAM (WMO 433710)' },
      Kottayam: { db: 35, wb: 27.5, indicative: true, why: 'no ASHRAE station within 75 km; indicative value kept' },
      Palakkad: { db: 36.7, wb: 22.2, src: 'ASHRAE 2021', station: 'COIMBATORE INTL (WMO 433210)' },
      Mangaluru: { db: 34.4, wb: 24.9, src: 'ASHRAE 2021', station: 'MANGALORE INTL (WMO 432840)' },
      Bengaluru: { db: 34.3, wb: 20, src: 'ASHRAE 2021', station: 'BENGALURU (WMO 432950)' },
      Mysuru: { db: 33, wb: 22, indicative: true, why: 'no ASHRAE station within 75 km; indicative value kept' },
      Chennai: { db: 39, wb: 26, src: 'ASHRAE 2021', station: 'CHENNAI INTL (WMO 432790)' },
      Coimbatore: { db: 36.7, wb: 22.2, src: 'ASHRAE 2021', station: 'COIMBATORE INTL (WMO 433210)' },
      Madurai: { db: 39, wb: 26, indicative: true, why: 'no ASHRAE station within 75 km; indicative value kept' },
      Hyderabad: { db: 41, wb: 22, src: 'ASHRAE 2021', station: 'HYDERABAD BEGUMPET (WMO 431280)' },
      Visakhapatnam: { db: 34, wb: 27.1, src: 'ASHRAE 2021', station: 'VISHAKHAPATNAM CWC (WMO 431500)' },
      Delhi: { db: 42.3, wb: 23.2, src: 'ASHRAE 2021', station: 'NEW DELHI SAFDARJUNG (WMO 421820)' },
      'New Delhi': { db: 42.3, wb: 23.2, src: 'ASHRAE 2021', station: 'NEW DELHI SAFDARJUNG (WMO 421820)' },
      Gurugram: { db: 43.8, wb: 22.2, src: 'ASHRAE 2021', station: 'NEW DELHI INDIRA GANDHI INTL (WMO 421810)' },
      Faridabad: { db: 42.3, wb: 23.2, src: 'ASHRAE 2021', station: 'NEW DELHI SAFDARJUNG (WMO 421820)' },
      Mumbai: { db: 36, wb: 22.7, src: 'ASHRAE 2021', station: 'MUMBAI SHIVAJI INTL (WMO 430030)' },
      Pune: { db: 38.5, wb: 19.9, src: 'ASHRAE 2021', station: 'PUNE (WMO 430630)' },
      Nagpur: { db: 44.2, wb: 22.6, src: 'ASHRAE 2021', station: 'NAGPUR AMBEDKAR INTL (WMO 428670)' },
      Ahmedabad: { db: 43.1, wb: 23, src: 'ASHRAE 2021', station: 'AHMEDABAD (WMO 426470)' },
      Surat: { db: 38.2, wb: 22.6, src: 'ASHRAE 2021', station: 'SURAT (WMO 428400)' },
      Jaipur: { db: 42.7, wb: 20.9, src: 'ASHRAE 2021', station: 'JAIPUR (WMO 423480)' },
      Kolkata: { db: 37.9, wb: 27.3, src: 'ASHRAE 2021', station: 'KOLKATA BOSE INTL (WMO 428090)' },
      Lucknow: { db: 42.8, wb: 23.4, src: 'ASHRAE 2021', station: 'LUCKNOW (WMO 423690)' },
      Kanpur: { db: 42.8, wb: 23.4, src: 'ASHRAE 2021', station: 'LUCKNOW (WMO 423690)' },
      Bhopal: { db: 42, wb: 21.9, src: 'ASHRAE 2021', station: 'BHOPAL (WMO 426670)' },
      Indore: { db: 40.8, wb: 20.9, src: 'ASHRAE 2021', station: 'INDORE INTL (WMO 427540)' },
      Amritsar: { db: 43.2, wb: 23.3, src: 'ASHRAE 2021', station: 'LAHORE ALLAMA IQBAL INTL (WMO 416410)', note: 'nearest station in the edition (~46 km, in Pakistan, cross-border)' },
      Ludhiana: { db: 42, wb: 26, indicative: true, why: 'no ASHRAE station within 75 km; indicative value kept' },
      Guwahati: { db: 35.2, wb: 27.8, src: 'ASHRAE 2021', station: 'GUWAHATI INTL (WMO 424100)' },
      Patna: { db: 41.3, wb: 23.2, src: 'ASHRAE 2021', station: 'PATNA (WMO 424920)' },
      Panaji: { db: 34.2, wb: 25.9, src: 'ASHRAE 2021', station: 'GOA PANAJI (WMO 431920)' }
    },
  },
  'United Arab Emirates': {
    fallback: { db: 46, wb: 29, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Dubai: { db: 43.3, wb: 23.6, src: 'ASHRAE 2021', station: 'DUBAI INTL (WMO 411940)' },
      'Abu Dhabi': { db: 45.1, wb: 23, src: 'ASHRAE 2021', station: 'ABU DHABI INTL (WMO 412170)' },
      Sharjah: { db: 44.3, wb: 23.5, src: 'ASHRAE 2021', station: 'SHARJAH INTL (WMO 411960)' },
      Ajman: { db: 44.3, wb: 23.5, src: 'ASHRAE 2021', station: 'SHARJAH INTL (WMO 411960)' },
      Fujairah: { db: 42.9, wb: 21.9, src: 'ASHRAE 2021', station: 'FUJAIRAH INTL (WMO 411980)' },
      'Ras Al Khaimah': { db: 44.7, wb: 24.4, src: 'ASHRAE 2021', station: 'RAS AL KHAIMAH INTL (WMO 411840)' },
      'Al Ain': { db: 46, wb: 22.5, src: 'ASHRAE 2021', station: 'AL AIN INTL (WMO 412180)' }
    },
  },
  'Saudi Arabia': {
    fallback: { db: 45, wb: 24, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Riyadh: { db: 44.9, wb: 19.5, src: 'ASHRAE 2021', station: 'RIYADH KING SALMAN AB (WMO 404380)' },
      Jeddah: { db: 41, wb: 23.7, src: 'ASHRAE 2021', station: 'JEDDAH KING ABDULAZIZ INTL (WMO 410240)' },
      Dammam: { db: 45.9, wb: 22.9, src: 'ASHRAE 2021', station: 'DHAHARAN KING ABDULAZIZ AB (WMO 404160)' },
      Makkah: { db: 45.2, wb: 24.5, src: 'ASHRAE 2021', station: 'MAKKAH (WMO 410300)' },
      Madinah: { db: 45.2, wb: 18.8, src: 'ASHRAE 2021', station: 'MEDINA PRINCE ABDULAZIZ INTL (WMO 404300)' }
    },
  },
  Qatar: {
    fallback: { db: 46, wb: 28, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Doha: { db: 44.3, wb: 22.3, src: 'ASHRAE 2021', station: 'DOHA INTL (WMO 411700)' }
    },
  },
  Oman: {
    fallback: { db: 46, wb: 29, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Muscat: { db: 42.6, wb: 22.3, src: 'ASHRAE 2021', station: 'MUSCAT INTL (WMO 412560)' },
      Sohar: { db: 40.4, wb: 23.5, src: 'ASHRAE 2021', station: 'SOHAR MAJIS (WMO 412460)' },
      Salalah: { db: 33.8, wb: 21.6, src: 'ASHRAE 2021', station: 'SALALAH (WMO 413160)' }
    },
  },
  Kuwait: {
    fallback: { db: 48, wb: 24, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      'Kuwait City': { db: 48.1, wb: 21.2, src: 'ASHRAE 2021', station: 'KUWAIT INTL (WMO 405820)' }
    },
  },
  Bahrain: {
    fallback: { db: 43, wb: 29, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Manama: { db: 41.2, wb: 23.7, src: 'ASHRAE 2021', station: 'BAHRAIN INTL (WMO 411500)' }
    },
  },
  Singapore: {
    fallback: { db: 33, wb: 26.5, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Singapore: { db: 33.2, wb: 26.3, src: 'ASHRAE 2021', station: 'SINGAPORE CHANGI INTL (WMO 486980)' }
    },
  },
  Malaysia: {
    fallback: { db: 34, wb: 27, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      'Kuala Lumpur': { db: 35, wb: 26.3, src: 'ASHRAE 2021', station: 'KUALA LUMPUR SUBANG (WMO 486470)' },
      Penang: { db: 33.2, wb: 26.3, src: 'ASHRAE 2021', station: 'PENANG INTL (WMO 486010)' },
      // Served by the Singapore/Changi station ~30 km away, across the border (same station as the
      // Singapore row) — the nearest station in the edition, exactly as Amritsar is served by Lahore.
      'Johor Bahru': { db: 33.2, wb: 26.3, src: 'ASHRAE 2021', station: 'SINGAPORE/CHANGI INTL (WMO 486980)', note: 'nearest ASHRAE station is ~30 km away, in Singapore (cross-border, as Amritsar is served by Lahore)' },
      'George Town': { db: 33.2, wb: 26.3, src: 'ASHRAE 2021', station: 'PENANG INTL (WMO 486010)' }
    },
  },
  'Sri Lanka': {
    fallback: { db: 33, wb: 27, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Colombo: { db: 33.1, wb: 24.7, src: 'ASHRAE 2021', station: 'KATUNAYAKE (WMO 434500)' }
    },
  },
  Maldives: {
    fallback: { db: 32, wb: 27, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Malé: { db: 32.2, wb: 27.1, src: 'ASHRAE 2021', station: 'MALE (WMO 435550)' }
    },
  },
  Pakistan: {
    fallback: { db: 40, wb: 26, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Karachi: { db: 39, wb: 22.7, src: 'ASHRAE 2021', station: 'JINNAH INTL (WMO 417800)' },
      Lahore: { db: 43.2, wb: 23.3, src: 'ASHRAE 2021', station: 'LAHORE ALLAMA IQBAL INTL (WMO 416410)' },
      Islamabad: { db: 41.1, wb: 22.8, src: 'ASHRAE 2021', station: 'ISLAMABAD INTL (WMO 415710)' }
    },
  },
  Bangladesh: {
    fallback: { db: 34, wb: 27, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Dhaka: { db: 34, wb: 27, indicative: true, why: 'no ASHRAE station within 75 km; indicative value kept' },
      Chittagong: { db: 33, wb: 27, indicative: true, why: 'no ASHRAE station within 75 km; indicative value kept' }
    },
  },
  Nepal: {
    fallback: { db: 30, wb: 22, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Kathmandu: { db: 30, wb: 22, indicative: true, why: 'no ASHRAE station within 75 km; indicative value kept' }
    },
  },
  'United Kingdom': {
    fallback: { db: 28, wb: 20, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {
      England: { db: 28, wb: 20, indicative: true, why: 'state/province estimate; not a station value' },
      Scotland: { db: 24, wb: 18, indicative: true, why: 'state/province estimate; not a station value' },
      Wales: { db: 26, wb: 19, indicative: true, why: 'state/province estimate; not a station value' },
      'Northern Ireland': { db: 24, wb: 18, indicative: true, why: 'state/province estimate; not a station value' },
    },
    cities: {
      London: { db: 28.4, wb: 18.5, src: 'ASHRAE 2021', station: 'LONDON WC CLERKENWELL (WMO 037790)' },
      Birmingham: { db: 26.8, wb: 18.1, src: 'ASHRAE 2021', station: 'BIRMINGHAM (WMO 035340)' },
      Manchester: { db: 25.8, wb: 18.1, src: 'ASHRAE 2021', station: 'MANCHESTER AP (WMO 033340)' },
      Edinburgh: { db: 22.2, wb: 16.8, src: 'ASHRAE 2021', station: 'EDINBURGH AP (WMO 031600)' },
      Glasgow: { db: 23.2, wb: 17.2, src: 'ASHRAE 2021', station: 'GLASGOW AP (WMO 031400)' },
      Bristol: { db: 26.7, wb: 18.3, src: 'ASHRAE 2021', station: 'BRISTOL WEATHER CENTRE (WMO 037260)' }
    },
  },
  'United States': {
    fallback: { db: 35, wb: 24, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {
      Texas: { db: 38, wb: 24, indicative: true, why: 'state/province estimate; not a station value' },
      California: { db: 32, wb: 21, indicative: true, why: 'state/province estimate; not a station value' },
      Florida: { db: 34, wb: 26, indicative: true, why: 'state/province estimate; not a station value' },
      'New York': { db: 33, wb: 24, indicative: true, why: 'state/province estimate; not a station value' },
      Arizona: { db: 43, wb: 22, indicative: true, why: 'state/province estimate; not a station value' },
      Illinois: { db: 32, wb: 24, indicative: true, why: 'state/province estimate; not a station value' },
    },
    cities: {
      'New York': { db: 33.7, wb: 23.3, src: 'ASHRAE 2021', station: 'NEW YORK LA GUARDIA (WMO 725030)' },
      'Los Angeles': { db: 29.3, wb: 17.4, src: 'ASHRAE 2021', station: 'LOS ANGELES INTL (WMO 722950)' },
      Chicago: { db: 32.9, wb: 23.4, src: 'ASHRAE 2021', station: "CHICAGO O'HARE (WMO 725300)" },
      Houston: { db: 36.4, wb: 24.8, src: 'ASHRAE 2021', station: 'HOUSTON BUSH (WMO 722430)' },
      Phoenix: { db: 43.6, wb: 20.7, src: 'ASHRAE 2021', station: 'PHOENIX SKY HARBOR (WMO 722780)' },
      Miami: { db: 33.3, wb: 25.4, src: 'ASHRAE 2021', station: 'MIAMI NHC (WMO 722020)' },
      Atlanta: { db: 34.3, wb: 23.2, src: 'ASHRAE 2021', station: 'ATLANTA HARTSFIELD-JACKSON (WMO 722190)' },
      Dallas: { db: 38.6, wb: 23.4, src: 'ASHRAE 2021', station: 'DALLAS FORT WORTH (WMO 722590)' },
      'San Francisco': { db: 28.3, wb: 17.1, src: 'ASHRAE 2021', station: 'SAN FRANCISCO INTL (WMO 724940)' },
      Seattle: { db: 30, wb: 18.4, src: 'ASHRAE 2021', station: 'SEATTLE TACOMA (WMO 727930)' },
      Boston: { db: 32.7, wb: 22.8, src: 'ASHRAE 2021', station: 'BOSTON LOGAN (WMO 725090)' },
      Washington: { db: 34.7, wb: 24.2, src: 'ASHRAE 2021', station: 'WASHINGTON RONALD REAGAN (WMO 724050)' },
      Denver: { db: 34.9, wb: 15.5, src: 'ASHRAE 2021', station: 'DENVER INTL (WMO 725650)' },
      'Las Vegas': { db: 42.8, wb: 19.4, src: 'ASHRAE 2021', station: 'LAS VEGAS MCCARRAN (WMO 723860)' },
      Orlando: { db: 34.3, wb: 24.8, src: 'ASHRAE 2021', station: 'ORLANDO INTL (WMO 722050)' }
    },
  },
  Canada: {
    fallback: { db: 30, wb: 22, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {
      Ontario: { db: 30, wb: 22, indicative: true, why: 'state/province estimate; not a station value' },
      Quebec: { db: 30, wb: 22, indicative: true, why: 'state/province estimate; not a station value' },
      'British Columbia': { db: 26, wb: 19, indicative: true, why: 'state/province estimate; not a station value' },
      Alberta: { db: 28, wb: 18, indicative: true, why: 'state/province estimate; not a station value' },
    },
    cities: {
      Toronto: { db: 31.5, wb: 22.4, src: 'ASHRAE 2021', station: 'TORONTO PEARSON (WMO 716240)' },
      Vancouver: { db: 25.1, wb: 18.5, src: 'ASHRAE 2021', station: 'VANCOUVER INTL (WMO 718920)' },
      Montreal: { db: 30.3, wb: 22.1, src: 'ASHRAE 2021', station: 'MONTREAL TRUDEAU (WMO 716270)' },
      Calgary: { db: 28.8, wb: 16, src: 'ASHRAE 2021', station: 'CALGARY INTL (WMO 718770)' },
      Ottawa: { db: 30.9, wb: 22, src: 'ASHRAE 2021', station: 'OTTAWA INTL (WMO 716280)' }
    },
  },
  Australia: {
    fallback: { db: 38, wb: 24, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {
      'New South Wales': { db: 34, wb: 23, indicative: true, why: 'state/province estimate; not a station value' },
      Victoria: { db: 36, wb: 21, indicative: true, why: 'state/province estimate; not a station value' },
      Queensland: { db: 33, wb: 25, indicative: true, why: 'state/province estimate; not a station value' },
      'Western Australia': { db: 38, wb: 23, indicative: true, why: 'state/province estimate; not a station value' },
      'South Australia': { db: 38, wb: 22, indicative: true, why: 'state/province estimate; not a station value' },
      'Northern Territory': { db: 35, wb: 27, indicative: true, why: 'state/province estimate; not a station value' },
    },
    cities: {
      Sydney: { db: 33.3, wb: 19.5, src: 'ASHRAE 2021', station: 'SYDNEY AP (WMO 947670)' },
      Melbourne: { db: 35.4, wb: 18.1, src: 'ASHRAE 2021', station: 'MELBOURNE AP (WMO 948660)' },
      Brisbane: { db: 30.8, wb: 23.1, src: 'ASHRAE 2021', station: 'BRISBANE AP (WMO 945780)' },
      Perth: { db: 37.5, wb: 19.4, src: 'ASHRAE 2021', station: 'PERTH AP (WMO 946100)' },
      Adelaide: { db: 36.8, wb: 18.5, src: 'ASHRAE 2021', station: 'ADELAIDE AP (WMO 946720)' },
      Darwin: { db: 34.2, wb: 23.5, src: 'ASHRAE 2021', station: 'DARWIN (WMO 941200)' }
    },
  },
  'New Zealand': {
    fallback: { db: 26, wb: 18, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Auckland: { db: 25.8, wb: 20.1, src: 'ASHRAE 2021', station: 'AUCKLAND (WMO 931100)' }
    },
  },
  Germany: {
    fallback: { db: 30, wb: 20, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Berlin: { db: 29.3, wb: 19, src: 'ASHRAE 2021', station: 'BERLIN DAHLEM (WMO 103810)' },
      Munich: { db: 29.5, wb: 19, src: 'ASHRAE 2021', station: 'MUNICH STADT (WMO 108650)' },
      Frankfurt: { db: 32.1, wb: 20, src: 'ASHRAE 2021', station: 'FRANKFURT AM MAIN (WMO 106370)' },
      Hamburg: { db: 29.1, wb: 19.2, src: 'ASHRAE 2021', station: 'HAMBURG FUHLSBUTTEL (WMO 101470)' }
    },
  },
  France: {
    fallback: { db: 32, wb: 21, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Paris: { db: 31.6, wb: 20.4, src: 'ASHRAE 2021', station: 'PARIS MONTSOURIS (WMO 071560)' },
      Marseille: { db: 33.1, wb: 21, src: 'ASHRAE 2021', station: 'MARSEILLE PROVENCE AP (WMO 076500)' },
      Lyon: { db: 33.8, wb: 20.2, src: 'ASHRAE 2021', station: 'LYON-BRON AP (WMO 074800)' }
    },
  },
  Spain: {
    fallback: { db: 35, wb: 23, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Madrid: { db: 36.8, wb: 18.4, src: 'ASHRAE 2021', station: 'MADRID-BARAJAS AP (WMO 082210)' },
      Barcelona: { db: 30.9, wb: 23.5, src: 'ASHRAE 2021', station: 'BARCELONA AP (WMO 081810)' },
      Seville: { db: 39.2, wb: 21.4, src: 'ASHRAE 2021', station: 'SEVILLA AP (WMO 083910)' }
    },
  },
  Netherlands: {
    fallback: { db: 28, wb: 19, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Amsterdam: { db: 28.1, wb: 20, src: 'ASHRAE 2021', station: 'AMSTERDAM AP SCHIPHOL (WMO 062400)' }
    },
  },
  Turkey: {
    fallback: { db: 34, wb: 23, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Istanbul: { db: 32.1, wb: 21.5, src: 'ASHRAE 2021', station: 'ISTANBUL ATATURK (WMO 170600)' },
      Ankara: { db: 33.9, wb: 17, src: 'ASHRAE 2021', station: 'ANKARA ESENBOGA (WMO 171280)' }
    },
  },
  Egypt: {
    fallback: { db: 38, wb: 24, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Cairo: { db: 38.8, wb: 21, src: 'ASHRAE 2021', station: 'CAIRO INTL (WMO 623660)' }
    },
  },
  Israel: {
    fallback: { db: 33, wb: 25, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      'Tel Aviv': { db: 35.2, wb: 20.5, src: 'ASHRAE 2021', station: 'TEL AVIV BEN GURION (WMO 401800)' }
    },
  },
  Japan: {
    fallback: { db: 34, wb: 26, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Tokyo: { db: 33.7, wb: 25.6, src: 'ASHRAE 2021', station: 'TOKYO (WMO 476620)' },
      Osaka: { db: 34.5, wb: 25, src: 'ASHRAE 2021', station: 'OSAKA (WMO 477720)' }
    },
  },
  China: {
    fallback: { db: 35, wb: 27, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Beijing: { db: 35.2, wb: 22, src: 'ASHRAE 2021', station: 'BEIJING (WMO 545110)' },
      Shanghai: { db: 35.5, wb: 26.7, src: 'ASHRAE 2021', station: 'SHANGHAI BAOSHAN (WMO 583620)' },
      Guangzhou: { db: 36, wb: 26.2, src: 'ASHRAE 2021', station: 'GUANGZHOU (WMO 592870)' },
      Shenzhen: { db: 34, wb: 26.4, src: 'ASHRAE 2021', station: 'SHENZHEN (WMO 594930)' }
    },
  },
  'Hong Kong': {
    fallback: { db: 33, wb: 27, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      'Hong Kong': { db: 32.2, wb: 26.5, src: 'ASHRAE 2021', station: 'HONG KONG OBSERVATORY (WMO 450050)' }
    },
  },
  Thailand: {
    fallback: { db: 36, wb: 27, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Bangkok: { db: 36.2, wb: 26.9, src: 'ASHRAE 2021', station: 'BANGKOK METROPOLIS (WMO 484550)' },
      Phuket: { db: 34.9, wb: 26.2, src: 'ASHRAE 2021', station: 'PHUKET (WMO 485640)' },
      'Chiang Mai': { db: 38.1, wb: 22.8, src: 'ASHRAE 2021', station: 'CHIANG MAI INTL (WMO 483270)' }
    },
  },
  Indonesia: {
    fallback: { db: 33, wb: 26, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Jakarta: { db: 34, wb: 25.4, src: 'ASHRAE 2021', station: 'JAKARTA SOEKARNO-HATTA (WMO 967490)' },
      Denpasar: { db: 32.5, wb: 26.6, src: 'ASHRAE 2021', station: 'DENPASAR NGURAH RAI (WMO 972300)' },
      Surabaya: { db: 34.1, wb: 24.7, src: 'ASHRAE 2021', station: 'JUANDA SURABAYA (WMO 969350)' }
    },
  },
  Philippines: {
    fallback: { db: 34, wb: 27, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Manila: { db: 34.5, wb: 26.4, src: 'ASHRAE 2021', station: 'MANILA (WMO 984250)' }
    },
  },
  Vietnam: {
    fallback: { db: 36, wb: 27, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Hanoi: { db: 36.2, wb: 27.4, src: 'ASHRAE 2021', station: 'HA NOI (WMO 488200)' },
      'Ho Chi Minh City': { db: 35.8, wb: 25.7, src: 'ASHRAE 2021', station: 'HO CHI MINH TAN SON NHAT INTL (WMO 489000)' }
    },
  },
  'South Africa': {
    fallback: { db: 32, wb: 20, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Johannesburg: { db: 29.1, wb: 14.8, src: 'ASHRAE 2021', station: 'JOHANNESBURG INTL (WMO 683680)' },
      'Cape Town': { db: 31.9, wb: 19.8, src: 'ASHRAE 2021', station: 'CAPE TOWN INTL (WMO 688160)' },
      Durban: { db: 30.2, wb: 23.9, src: 'ASHRAE 2021', station: 'DURBAN (WMO 685880)' }
    },
  },
  Nigeria: {
    fallback: { db: 33, wb: 25, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Lagos: { db: 33, wb: 25, indicative: true, why: 'no ASHRAE station within 75 km; indicative value kept' },
      Abuja: { db: 36, wb: 23, indicative: true, why: 'no ASHRAE station within 75 km; indicative value kept' }
    },
  },
  Kenya: {
    fallback: { db: 27, wb: 19, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Nairobi: { db: 29.2, wb: 16, src: 'ASHRAE 2021', station: 'NAIROBI JOMO KENYATTA INTL (WMO 637400)' },
      Mombasa: { db: 33.2, wb: 25.3, src: 'ASHRAE 2021', station: 'MOMBASA INTL (WMO 638200)' }
    },
  },
  Brazil: {
    fallback: { db: 33, wb: 24, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      'São Paulo': { db: 32.2, wb: 20.1, src: 'ASHRAE 2021', station: 'SAO PAULO CONGONHAS (WMO 837800)' },
      'Rio de Janeiro': { db: 34.8, wb: 25.7, src: 'ASHRAE 2021', station: 'RIO DE JANEIRO SANTOS DUMONT (WMO 837550)' }
    },
  },
  Russia: {
    fallback: { db: 28, wb: 19, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      Moscow: { db: 29.9, wb: 21.1, src: 'ASHRAE 2021', station: 'MOSKVA VDNH (WMO 276120)' },
      'Saint Petersburg': { db: 28.4, wb: 19.6, src: 'ASHRAE 2021', station: 'ST PETERSBURG PULKOVO (WMO 260630)' }
    },
  },
  Mexico: {
    fallback: { db: 34, wb: 22, indicative: true, why: 'country-level fallback; no single station defines a whole country' },
    regions: {},
    cities: {
      'Mexico City': { db: 29.1, wb: 12.3, src: 'ASHRAE 2021', station: 'MEXICO CITY INTL (WMO 766793)' },
      Cancun: { db: 33, wb: 26, indicative: true, why: 'nearest ASHRAE station (Cancún Intl, WMO 765906) has no 2021 design-condition data' },
      Guadalajara: { db: 33.1, wb: 15.2, src: 'ASHRAE 2021', station: 'GUADALAJARA INTL (WMO 766133)' }
    },
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

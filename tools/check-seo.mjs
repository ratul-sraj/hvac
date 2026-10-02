// tools/check-seo.mjs — the LoadLens search-metadata gate (a real check suite, not a smoke test).
//
//   cd D:/webhvac && node tools/check-seo.mjs [base-url]
//
// It talks to the running Express server (default http://127.0.0.1:3000), reads js/climates.js
// directly, and FAILS LOUDLY (exit 1) on:
//   * a page with a missing or duplicate <title> / meta description (and title > 60 chars,
//     description outside 120-160 chars);
//   * a page with no rel=canonical, or a canonical that is not the page's own absolute URL;
//   * sitemap.xml missing a page that exists in the repo root, or listing a page that does not;
//   * robots.txt not referencing the sitemap (or blocking the whole site);
//   * invalid JSON-LD, or the wrong/missing structured data (SoftwareApplication on index,
//     FAQPage on help, built from the questions actually on help.html);
//   * design-conditions.html missing any sourced city from js/climates.js, or carrying a DB/WB
//     that disagrees with the table (so a stale generated page cannot ship).
//
// Prints "N/M checks passed" and exits non-zero on any failure.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIMATE_TABLE } from "../js/climates.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BASE = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/+$/, "");
const SITE = "https://loadlens.net";
const TITLE_MAX = 60;
const DESC_MIN = 120;
const DESC_MAX = 160;

// ---- tiny check harness ---------------------------------------------------
const results = [];
const ok = (label, pass, detail = "") => {
  results.push({ label, pass, detail: String(detail) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? "  \u2014 " + detail : ""}`);
};
const get = async (url) => {
  const r = await fetch(url, { redirect: "follow" });
  return { status: r.status, body: await r.text(), headers: r.headers };
};
const stripTags = (s) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---- what pages exist? ----------------------------------------------------
const PUBLIC_HTML = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith(".html") && !f.startsWith("."))
  .sort();
const expectedCanonical = (file) => (file === "index.html" ? `${SITE}/` : `${SITE}/${file}`);
const expectedLoc = (file) => expectedCanonical(file);
const locToFile = (loc) => {
  const p = loc.replace(SITE, "").replace(/^\/+/, "");
  return p === "" ? "index.html" : p;
};

// ---- HTML attribute parsing (no DOM in Node) ------------------------------
function tagAttrs(html, tagName) {
  const out = [];
  const re = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    const are = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = are.exec(m[0]))) attrs[a[1].toLowerCase()] = a[3] !== undefined ? a[3] : a[4];
    out.push(attrs);
  }
  return out;
}
const getTitle = (html) => (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
function metaContent(html, name) {
  const m = tagAttrs(html, "meta").find((a) => (a.name || "").toLowerCase() === name);
  return m ? m.content : undefined;
}
function canonicalOf(html) {
  const l = tagAttrs(html, "link").find((a) => (a.rel || "").toLowerCase() === "canonical");
  return l ? l.href : undefined;
}
function jsonLdBlocks(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

// ==========================================================================
console.log(`base url : ${BASE}`);
console.log(`repo root: ${ROOT}`);
console.log(`pages    : ${PUBLIC_HTML.length} html files in the root\n`);

// ---- 1. fetch every page --------------------------------------------------
const pages = {};
for (const file of PUBLIC_HTML) {
  const url = file === "index.html" ? `${BASE}/` : `${BASE}/${file}`;
  try {
    const r = await get(url);
    pages[file] = { url, status: r.status, html: r.body };
  } catch (e) {
    pages[file] = { url, status: 0, html: "", error: e.message };
  }
}

// ---- 2. titles ------------------------------------------------------------
const titles = new Map();
for (const file of PUBLIC_HTML) {
  const p = pages[file];
  const t = p.status === 200 ? (getTitle(p.html) || "").trim() : "";
  ok(`${file}: reachable (HTTP 200)`, p.status === 200, p.status ? `HTTP ${p.status}` : p.error || "no response");
  ok(`${file}: has a <title>`, t.length > 0, t ? `${t.length} chars` : "missing");
  ok(`${file}: title is \u2264 ${TITLE_MAX} chars`, t.length > 0 && t.length <= TITLE_MAX, `${t.length} chars: "${t}"`);
  if (t) (titles.get(t) || titles.set(t, []).get(t) || []).push(file);
}
const dupTitles = [...titles.entries()].filter(([, files]) => files.length > 1);
ok("titles are unique across pages", dupTitles.length === 0,
  dupTitles.map(([t, f]) => `"${t}" in ${f.join(", ")}`).join(" | ") || `${titles.size} unique titles`);

// ---- 3. meta descriptions -------------------------------------------------
const descs = new Map();
for (const file of PUBLIC_HTML) {
  const p = pages[file];
  const d = (metaContent(p.html, "description") || "").trim();
  ok(`${file}: has a meta description`, d.length > 0, d ? `${d.length} chars` : "missing");
  ok(`${file}: description is ${DESC_MIN}\u2013${DESC_MAX} chars`,
    d.length >= DESC_MIN && d.length <= DESC_MAX, `${d.length} chars`);
  if (d) (descs.get(d) || descs.set(d, []).get(d) || []).push(file);
}
const dupDescs = [...descs.entries()].filter(([, files]) => files.length > 1);
ok("meta descriptions are unique across pages", dupDescs.length === 0,
  dupDescs.map(([, f]) => f.join(", ")).join(" | ") || `${descs.size} unique descriptions`);

// ---- 4. canonical ---------------------------------------------------------
for (const file of PUBLIC_HTML) {
  const c = canonicalOf(pages[file].html);
  const want = expectedCanonical(file);
  ok(`${file}: canonical is ${want}`, c === want, c ? `found ${c}` : "no rel=canonical");
}

// ---- 5. robots.txt --------------------------------------------------------
try {
  const r = await get(`${BASE}/robots.txt`);
  ok("robots.txt is served (HTTP 200)", r.status === 200, `HTTP ${r.status}`);
  const sitemapLine = (r.body.match(/^\s*Sitemap:\s*(\S+)\s*$/im) || [])[1];
  ok("robots.txt references the sitemap", sitemapLine === `${SITE}/sitemap.xml`,
    sitemapLine ? `Sitemap: ${sitemapLine}` : "no Sitemap: line");
  const blocksAll = /^\s*Disallow:\s*\/\s*$/im.test(r.body);
  ok("robots.txt does not block the whole site", !blocksAll, blocksAll ? "found 'Disallow: /'" : "crawl allowed");
} catch (e) {
  ok("robots.txt is served (HTTP 200)", false, e.message);
}

// ---- 6. sitemap.xml -------------------------------------------------------
let locs = [];
try {
  const r = await get(`${BASE}/sitemap.xml`);
  ok("sitemap.xml is served (HTTP 200)", r.status === 200, `HTTP ${r.status}`);
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(r.body))) locs.push(m[1]);
  ok("sitemap.xml is well-formed <urlset> with at least one <loc>",
    /<urlset\b/i.test(r.body) && locs.length > 0, `${locs.length} <loc> entries`);
} catch (e) {
  ok("sitemap.xml is served (HTTP 200)", false, e.message);
}
const locSet = new Set(locs);
for (const file of PUBLIC_HTML) {
  ok(`sitemap.xml lists ${file}`, locSet.has(expectedLoc(file)),
    locSet.has(expectedLoc(file)) ? expectedLoc(file) : "MISSING from sitemap");
}
for (const loc of locs) {
  const file = locToFile(loc);
  const exists = PUBLIC_HTML.includes(file);
  ok(`sitemap entry resolves to a real page: ${loc}`, exists && !!pages[file] && pages[file].status === 200,
    exists ? `-> ${file} (HTTP ${pages[file].status})` : "no such file in the repo root");
}
const sitemapDup = locs.length !== locSet.size;
ok("sitemap.xml has no duplicate <loc> entries", !sitemapDup, sitemapDup ? "duplicates found" : `${locs.length} unique URLs`);

// ---- 7. JSON-LD -----------------------------------------------------------
const ldByPage = {};
for (const file of PUBLIC_HTML) {
  const blocks = jsonLdBlocks(pages[file].html);
  const parsed = [];
  blocks.forEach((b, i) => {
    try {
      parsed.push(JSON.parse(b));
    } catch (e) {
      ok(`${file}: JSON-LD block ${i + 1} is valid JSON`, false, e.message);
    }
  });
  ldByPage[file] = parsed;
  if (blocks.length) ok(`${file}: JSON-LD parses (${blocks.length} block${blocks.length > 1 ? "s" : ""})`, true, `${parsed.length} valid`);
}

// index: SoftwareApplication
const ldIndex = (ldByPage["index.html"] || []).find((b) => {
  const t = Array.isArray(b["@type"]) ? b["@type"] : [b["@type"]];
  return t.includes("SoftwareApplication");
});
if (ldIndex) {
  ok("index.html: SoftwareApplication name = LoadLens", ldIndex.name === "LoadLens", String(ldIndex.name));
  ok("index.html: SoftwareApplication url is the site root", ldIndex.url === `${SITE}/`, String(ldIndex.url));
  ok("index.html: SoftwareApplication applicationCategory is set", !!ldIndex.applicationCategory, String(ldIndex.applicationCategory));
  ok("index.html: SoftwareApplication operatingSystem = 'Any (browser)'", ldIndex.operatingSystem === "Any (browser)", String(ldIndex.operatingSystem));
  ok("index.html: SoftwareApplication offers price is 0", !!ldIndex.offers && String(ldIndex.offers.price) === "0", JSON.stringify(ldIndex.offers));
  ok("index.html: SoftwareApplication has a description", typeof ldIndex.description === "string" && ldIndex.description.length > 40, `${(ldIndex.description || "").length} chars`);
  ok("index.html: SoftwareApplication has a screenshot or logo",
    !!(ldIndex.screenshot || ldIndex.logo || ldIndex.image), ldIndex.screenshot || ldIndex.logo || ldIndex.image || "none");
} else {
  ok("index.html: has a valid SoftwareApplication JSON-LD block", false, "not found");
}

// help: FAQPage built from the questions on the page
const ldHelp = (ldByPage["help.html"] || []).find((b) => {
  const t = Array.isArray(b["@type"]) ? b["@type"] : [b["@type"]];
  return t.includes("FAQPage");
});
if (ldHelp) {
  const qs = Array.isArray(ldHelp.mainEntity) ? ldHelp.mainEntity : [];
  ok("help.html: FAQPage has questions", qs.length >= 8, `${qs.length} questions`);
  const malformed = qs.filter((q) => !q.name || !q.acceptedAnswer || !q.acceptedAnswer.text);
  ok("help.html: every FAQ question has a name and an acceptedAnswer.text", malformed.length === 0,
    malformed.length ? `${malformed.length} malformed` : "all well-formed");
  const summaries = [...pages["help.html"].html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/gi)].map((m) => norm(stripTags(m[1]))).filter(Boolean);
  const qNames = new Set(qs.map((q) => norm(q.name)));
  const missing = summaries.filter((s) => !qNames.has(s));
  ok("help.html: every question on the page is in the FAQPage structured data", missing.length === 0,
    missing.length ? `missing: ${missing.slice(0, 2).join(" / ")}` : `${summaries.length} on-page questions covered`);
} else {
  ok("help.html: has a valid FAQPage JSON-LD block", false, "not found");
}

// ---- 8. design-conditions.html is a faithful rendering of js/climates.js ---
const dc = pages["design-conditions.html"];
if (dc && dc.status === 200) {
  const rowRe = /<tr\b[^>]*data-country="([^"]*)"[^>]*data-kind="([^"]*)"[^>]*data-city="([^"]*)"[^>]*data-db="([^"]*)"[^>]*data-wb="([^"]*)"[^>]*data-sourced="(true|false)"[^>]*>/gi;
  const rows = [];
  let m;
  while ((m = rowRe.exec(dc.html))) {
    rows.push({ country: m[1], kind: m[2], city: m[3], db: m[4], wb: m[5], sourced: m[6] === "true" });
  }
  ok("design-conditions.html: table rows carry city + DB + WB data", rows.length > 100, `${rows.length} rows parsed`);

  const key = (c, city) => `${c}\u0000${city}`;
  const byKey = new Map(rows.filter((r) => r.kind === "city").map((r) => [key(r.country, r.city), r]));

  const sourcedCities = [];
  const indiaIndicative = [];
  for (const [country, entry] of Object.entries(CLIMATE_TABLE)) {
    for (const [city, row] of Object.entries(entry.cities || {})) {
      if (row.src) sourcedCities.push({ country, city, row });
      else if (/^india$/i.test(country)) indiaIndicative.push({ country, city, row });
    }
  }
  const missingSourced = sourcedCities.filter((s) => !byKey.has(key(s.country, s.city)));
  ok(`design-conditions.html: lists every sourced city from js/climates.js (${sourcedCities.length})`,
    missingSourced.length === 0,
    missingSourced.length ? `missing ${missingSourced.length}: ${missingSourced.slice(0, 3).map((s) => s.city).join(", ")}` : "all sourced cities present");

  const wrong = sourcedCities.filter((s) => {
    const r = byKey.get(key(s.country, s.city));
    return r && (r.db !== String(s.row.db) || r.wb !== String(s.row.wb));
  });
  ok("design-conditions.html: every sourced DB/WB matches js/climates.js exactly", wrong.length === 0,
    wrong.length ? `mismatch: ${wrong.slice(0, 3).map((s) => s.city).join(", ")}` : `${sourcedCities.length} values match`);

  const missingInd = indiaIndicative.filter((s) => !byKey.has(key(s.country, s.city)));
  ok(`design-conditions.html: lists India's indicative cities too (${indiaIndicative.length})`,
    missingInd.length === 0,
    missingInd.length ? `missing ${missingInd.length}` : "all present, flagged indicative");
  const indFlagged = indiaIndicative.every((s) => byKey.get(key(s.country, s.city)) && byKey.get(key(s.country, s.city)).sourced === false);
  ok("design-conditions.html: India's indicative rows are flagged indicative", indFlagged, indFlagged ? "none claimed as sourced" : "an indicative row claims a source");

  ok("design-conditions.html: links to docs/CLIMATE-SOURCES.md on GitHub",
    /github\.com\/ratul-sraj\/hvac\/blob\/main\/docs\/CLIMATE-SOURCES\.md/.test(dc.html), "provenance link present");
  ok("design-conditions.html: ends with a link to the calculator (app.html)",
    /href="app\.html"[^>]*>\s*Calculate a cooling load for your own floor plan/i.test(dc.html), "CTA present");
} else {
  ok("design-conditions.html: is served (HTTP 200)", false, dc ? `HTTP ${dc.status}` : "no response");
}

// ---- summary --------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("failed:");
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? " :: " + f.detail : ""}`);
  process.exit(1);
}
console.log("ALL SEO CHECKS PASSED");

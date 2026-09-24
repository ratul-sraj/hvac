// Real-browser check of the WebHVAC public pages (landing, about, method, help).
//   cd D:/webhvac && node tests/landing-check.mjs [base-url-or-page-url]
//
// Default base: http://127.0.0.1:3000/  (the running Express server, where the planner
// serves the landing page as index.html). While you are testing pages before that
// the page itself — the directory is worked out from the URL either way:
//   node tests/landing-check.mjs http://127.0.0.1:8220/index.html
//   node tests/landing-check.mjs http://127.0.0.1:3000/
//
// Uses puppeteer-core with the Edge already installed on this PC (no browser download).
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const ARG = process.argv[2] || "http://127.0.0.1:3000/";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = "tests/qa";
fs.mkdirSync(OUT, { recursive: true });

// ---- work out the directory and which file is the landing page -------------------
function splitArg(a) {
  const u = new URL(a);
  const path = u.pathname;
  const m = path.match(/^(.*\/)([^/]*\.html)$/i);
  if (m) return { origin: u.origin, dir: m[1], landing: m[2] };
  return { origin: u.origin, dir: path.endsWith("/") ? path : path + "/", landing: null };
}
let loc;
try {
  loc = splitArg(ARG);
} catch (e) {
  console.log(`FAIL  base url is not a valid URL: ${ARG}`);
  process.exit(1);
}
const DIR = loc.origin + loc.dir;
const url = (f) => DIR + f;

const results = [];
const ok = (label, pass, detail = "") => {
  results.push({ label, pass, detail: String(detail) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

// Which file is the landing page? The given one, else the first of
// index.html that is 200 AND carries the landing hero, so the landing page is
// always found at its real URL.
async function pickLanding() {
  if (loc.landing) {
    try {
      const r = await fetch(url(loc.landing), { redirect: "follow" });
      return { file: r.status === 200 ? loc.landing : null, tried: `${loc.landing} -> ${r.status}` };
    } catch (e) {
      return { file: null, tried: `${loc.landing} -> ${e.message}` };
    }
  }
  const tried = [];
  let firstOk = null;
  for (const c of ["index.html"]) {
    try {
      const r = await fetch(url(c), { redirect: "follow" });
      const body = r.status === 200 ? await r.text() : "";
      tried.push(`${c} -> ${r.status}${body ? (body.includes('id="hero-cta"') ? " (landing)" : " (no hero)") : ""}`);
      if (r.status === 200) {
        if (firstOk === null) firstOk = c;
        if (body.includes('id="hero-cta"')) return { file: c, tried: tried.join(", ") };
      }
    } catch (e) {
      tried.push(`${c} -> ${e.message}`);
    }
  }
  return { file: firstOk, tried: tried.join(", ") };
}
const picked = await pickLanding();
ok("landing page found", !!picked.file, picked.tried);
const LANDING = picked.file || "index.html";

// ---- calculator target must exist (this is a real failure, not something to skip) --
try {
  const r = await fetch(url("app.html"), { redirect: "follow" });
  const body = await r.text();
  ok("calculator target exists (GET app.html)", r.status === 200 && /WebHVAC/i.test(body),
    `HTTP ${r.status}, ${body.length} bytes`);
} catch (e) {
  ok("calculator target exists (GET app.html)", false, "request failed: " + e.message);
}

const PAGES = [
  { key: "landing", label: "landing page", file: LANDING, name: LANDING },
  { key: "about", label: "about.html", file: "about.html", name: "about.html" },
  { key: "method", label: "method.html", file: "method.html", name: "method.html" },
  { key: "help", label: "help.html", file: "help.html", name: "help.html" },
];

const NAV_HREFS = ["app.html", "about.html", "method.html", "help.html"];
const PLACEHOLDER = /lorem ipsum|\bTODO\b|\bXXX\b/i;

console.log(`\nbase directory : ${DIR}`);
console.log(`landing page   : ${LANDING}\n`);

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--window-size=1400,1000"],
  protocolTimeout: 120000,
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });

let consoleErrors = [];
let failedRequests = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
page.on("requestfailed", (r) => failedRequests.push(`${r.url()} ${(r.failure() && r.failure().errorText) || ""}`));

const shots = [];
const contents = {};

try {
  for (const p of PAGES) {
    consoleErrors = [];
    failedRequests = [];
    const pageUrl = url(p.file);
    let resp = null;

    try {
      resp = await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 60000 });
    } catch (e) {
      ok(`${p.label} loads`, false, "navigation failed: " + e.message);
      continue;
    }
    const status = resp ? resp.status() : 0;
    ok(`${p.label} loads with HTTP 200`, status === 200, `HTTP ${status} ${pageUrl}`);

    // console / network health for THIS page
    ok(`${p.label} — no console errors`, consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(" | ") || "none");
    ok(`${p.label} — no failed requests`, failedRequests.length === 0,
      failedRequests.slice(0, 3).join(" | ") || "none");

    // nav with exactly the four links, hrefs exactly as shipped
    const navHrefs = await page.$$eval("nav a", (as) => as.map((a) => a.getAttribute("href")))
      .catch(() => []);
    const navOk = navHrefs.length === NAV_HREFS.length && NAV_HREFS.every((h) => navHrefs.includes(h));
    ok(`${p.label} — nav has the 4 links (app/about/method/help)`, navOk, JSON.stringify(navHrefs));

    // no leftover placeholder text
    const html = await page.content();
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    contents[p.key] = { html, text };
    const ph = (html.match(PLACEHOLDER) || [])[0] || "";
    ok(`${p.label} — no placeholder text (lorem/TODO/XXX)`, !ph, ph ? `found "${ph}"` : "clean");

    // desktop screenshot
    const shot = `${OUT}/landing-${p.key}.png`;
    await page.screenshot({ path: shot, fullPage: true });
    shots.push(shot);

    // narrow screen: no sideways overflow at 390 px
    await page.setViewport({ width: 390, height: 844 });
    await new Promise((r) => setTimeout(r, 350));
    const of = await page.evaluate(() => {
      const de = document.documentElement;
      const sw = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
      return { sw, iw: window.innerWidth };
    });
    ok(`${p.label} — fits 390 px without sideways overflow`, of.sw <= of.iw + 2,
      `scrollWidth ${of.sw} vs viewport ${of.iw}`);
    await page.setViewport({ width: 1400, height: 1000 });
  }

  // ---- landing page specifics -------------------------------------------------
  const homeText = (contents.landing && contents.landing.text) || "";
  const homeHtml = (contents.landing && contents.landing.html) || "";

  const cta = await page.goto(url(LANDING), { waitUntil: "networkidle2", timeout: 60000 })
    .then(() => page.$eval("#hero-cta", (e) => ({ href: e.getAttribute("href"), text: e.innerText.trim() })))
    .catch(() => null);
  ok("landing hero CTA points at app.html",
    !!cta && cta.href === "app.html",
    cta ? `href="${cta.href}" text="${cta.text}"` : "no #hero-cta element found");
  ok("landing hero CTA mentions the calculator",
    !!cta && /calculat/i.test(cta.text), cta ? cta.text : "-");

  ok("landing content: has 'TR' and a link to app.html",
    /\bTR\b/.test(homeText) && /href="app\.html"/.test(homeHtml),
    `TR=${/\bTR\b/.test(homeText)} app.html=${/href="app\.html"/.test(homeHtml)}`);

  // ---- about ------------------------------------------------------------------
  const aboutText = (contents.about && contents.about.text) || "";
  const aboutHtml = (contents.about && contents.about.html) || "";
  ok("about content: public repo URL present",
    /https:\/\/github\.com\/ratul-sraj\/hvac/.test(aboutHtml),
    aboutHtml.includes("ratul-sraj/hvac") ? "github.com/ratul-sraj/hvac linked" : "missing");

  // ---- method -----------------------------------------------------------------
  const methodText = (contents.method && contents.method.text) || "";
  ok("method content: the 3517 / 1 TR factor is stated",
    /3517/.test(methodText) && /1\s*TR/.test(methodText),
    (/3517/.test(methodText) ? "3517 W = 1 TR shown" : "3517 missing"));
  ok("method content: a note that a qualified engineer must verify",
    /engineer/i.test(methodText) && /(verif|check)/i.test(methodText),
    methodText.includes("engineer") ? "engineer verification note present" : "missing");

  // ---- help -------------------------------------------------------------------
  const helpText = (contents.help && contents.help.text) || "";
  ok("help content: FAQ entry about scanned / OCR PDFs",
    /(scanned|scan\b)/i.test(helpText) && /OCR/i.test(helpText),
    /OCR/i.test(helpText) ? "scan + OCR entry present" : "missing");
  ok("help content: FAQ entry about where files go",
    /where do my files go|files go|nothing is uploaded|not uploaded/i.test(helpText),
    /files go/i.test(helpText) ? "where-files-go entry present" : "missing");

  // ---- screenshots ------------------------------------------------------------
  const badShots = shots.filter((s) => !fs.existsSync(s) || fs.statSync(s).size < 2000);
  ok("a screenshot of each page written to tests/qa/", badShots.length === 0,
    shots.map((s) => `${s.split("/").pop()} ${fs.existsSync(s) ? fs.statSync(s).size : 0}B`).join(", "));
} catch (err) {
  ok("browser run completed without throwing", false, String((err && err.message) || err));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} landing checks passed`);
fs.writeFileSync(`${OUT}/landing-report.json`, JSON.stringify({
  base: DIR,
  landingPage: LANDING,
  when: new Date().toISOString(),
  passed: results.length - failed.length,
  total: results.length,
  results,
}, null, 1));

if (failed.length) {
  console.log("failed:\n" + failed.map((f) => `  - ${f.label} :: ${f.detail}`).join("\n"));
  process.exit(1);
}
console.log("ALL LANDING CHECKS PASSED");

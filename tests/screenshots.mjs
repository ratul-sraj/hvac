// LoadLens — take the documentation screenshots (docs/img/*.png) from a running copy of the app.
//
//   cd D:/webhvac
//   node tests/screenshots.mjs [appBaseUrl] [docsBaseUrl]
//
//   appBaseUrl   where the calculator page is served   (default http://127.0.0.1:3000/)
//   docsBaseUrl  where home/method/help pages live     (default = appBaseUrl)
//
// The Express server (npm start) serves the calculator and the landing pages, so one base URL is
// normally enough. Pass a second URL only if the documentation pages live somewhere else (a plain
// static copy, for example):
//   python -m http.server 8230 --bind 127.0.0.1      (run inside D:/webhvac)
//   node tests/screenshots.mjs http://127.0.0.1:3000/ http://127.0.0.1:8230/
//
// A page that answers anything but HTTP 200 is SKIPPED with a clear line — no file is written
// and nothing is faked. Uses the Edge already on this PC through puppeteer-core (no download).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const APP_BASE = process.argv[2] || "http://127.0.0.1:3000/";
const DOCS_BASE = process.argv[3] || APP_BASE;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // .../tests
const ROOT = path.resolve(HERE, "..");                       // .../webhvac
const IMG = path.join(ROOT, "docs", "img");
fs.mkdirSync(IMG, { recursive: true });

const VIEW = { width: 1400, height: 1000 };
const abs = (p) => path.resolve(p).replace(/\\/g, "/");
const written = [];
const skipped = [];

const log = (s) => console.log(s);

/* ---- helpers ---------------------------------------------------------- */

// HEAD/GET a page: 200 -> ok, anything else (or a network error) -> null (caller prints SKIP)
async function pageStatus(page, url) {
  try {
    const res = await page.goto(url, { waitUntil: "load", timeout: 30000 });
    return res ? res.status() : null;
  } catch (e) {
    return null;
  }
}

async function shot(page, name, { fullPage = false } = {}) {
  const file = path.join(IMG, name);
  await page.screenshot({ path: file, fullPage });
  const size = fs.statSync(file).size;
  written.push({ name, file, size });
  log(`WROTE  ${abs(file)}  (${size} bytes)`);
  return file;
}

// Make the element sit near the top of the viewport, then wait a moment for the scroll to settle.
async function bringToTop(page, selector, offset = 70) {
  await page.evaluate((sel, off) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.scrollY - off;
    window.scrollTo(0, Math.max(0, y));
  }, selector, offset);
  await new Promise((r) => setTimeout(r, 400));
}

/* ---- run -------------------------------------------------------------- */

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", `--window-size=${VIEW.width},${VIEW.height}`],
  protocolTimeout: 120000,
});
const page = await browser.newPage();
await page.setViewport(VIEW);
page.on("pageerror", (e) => log(`  (page error: ${e.message})`));

try {
  /* ---------- 1. the calculator, before any upload ---------- */
  // app.html is the calculator; index.html is the same page on the static/GitHub Pages build.
  let appUrl = APP_BASE.replace(/\/?$/, "/") + "app.html";
  if ((await pageStatus(page, appUrl)) !== 200) {
    const fallback = APP_BASE.replace(/\/?$/, "/") + "index.html";
    log(`SKIP   ${appUrl} did not answer HTTP 200 — trying ${fallback}`);
    appUrl = (await pageStatus(page, fallback)) === 200 ? fallback : null;
  }

  if (!appUrl) {
    skipped.push("app.html / index.html (no calculator page on " + APP_BASE + ")");
    log(`SKIP   the calculator page is not served by ${APP_BASE} — no app-*.png written`);
  } else {
    log(`PAGE   calculator: ${appUrl}`);
    // start from a clean slate: an earlier run may have left rooms in localStorage
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.goto(appUrl, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector("#roomsEmpty:not(.hidden)", { timeout: 20000 }).catch(() => {});
    await bringToTop(page, "#projectHead", 24);
    await shot(page, "app-empty.png", { fullPage: false });

    /* ---------- 2. after loading the sample drawing (the money shot) ---------- */
    await page.click("#btnSample");
    await page.waitForFunction(() => {
      const b = document.querySelector("#roomsBody");
      return b && b.querySelectorAll("tr").length > 100;
    }, { timeout: 120000 });
    await new Promise((r) => setTimeout(r, 800));           // let the summary cards settle
    const rows = await page.$$eval("#roomsBody tr", (r) => r.length);
    const trText = await page.$eval("#summaryCards", (e) => {
      const m = e.innerText.replace(/\s+/g, " ").match(/Total cooling load ([\d.,]+) TR/);
      return m ? m[1] : "(no total yet)";
    });
    log(`        sample loaded: ${rows} room rows, total cooling load ${trText} TR`);
    await bringToTop(page, "#sumHead", 24);
    await shot(page, "app-loaded.png", { fullPage: false });

    /* ---------- 3. one room opened — the load breakdown panel ---------- */
    // Open the biggest room (the most interesting breakdown, not a 1.5 m² toilet).
    const bigIdx = await page.$$eval("#roomsBody tr[data-idx]", (rows) => {
      let best = null, bestTr = -1;
      for (const tr of rows) {
        const cell = tr.querySelector(".v-tr");
        const v = cell ? parseFloat(cell.textContent.replace(/,/g, "")) : NaN;
        if (Number.isFinite(v) && v > bestTr) { bestTr = v; best = tr.dataset.idx; }
      }
      return best;
    });
    await page.click(`#roomsBody tr[data-idx="${bigIdx}"] td.res.v-total`);
    await page.waitForSelector("#detailPanel:not(.hidden)", { timeout: 20000 });
    await page.waitForFunction(() => {
      const b = document.querySelector("#detailBody");
      return b && b.innerText.trim().length > 80;
    }, { timeout: 20000 });
    const detailTitle = await page.$eval("#detailBody .bd-title", (e) => e.innerText.trim()).catch(() => "?");
    log(`        breakdown panel open for: ${detailTitle}`);
    await bringToTop(page, "#detailPanel", 16);
    await shot(page, "app-detail.png", { fullPage: false });
  }

  /* ---------- 4. the documentation pages ---------- */
  const pages = [
    ["method.png", "method.html", "this copy does not serve method.html"],
    ["help.png", "help.html", "this copy does not serve help.html"],
    ["landing.png", "index.html", "this copy does not serve index.html"],
  ];
  for (const [file, pageName, note] of pages) {
    const url = DOCS_BASE.replace(/\/?$/, "/") + pageName;
    const status = await pageStatus(page, url);
    if (status !== 200) {
      skipped.push(`${pageName} (HTTP ${status === null ? "no answer" : status})`);
      log(`SKIP   ${url} -> HTTP ${status === null ? "no answer" : status}; ${file} NOT written (${note})`);
      continue;
    }
    const title = await page.title().catch(() => "");
    log(`PAGE   ${url}  "${title}"`);
    await new Promise((r) => setTimeout(r, 600));
    await shot(page, file, { fullPage: true });
  }
} catch (err) {
  log(`ERROR  ${err && err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}

log("");
log(`app base  : ${APP_BASE}`);
log(`docs base : ${DOCS_BASE}`);
log(`output    : ${abs(IMG)}`);
for (const w of written) log(`  ${w.name.padEnd(16)} ${String(w.size).padStart(9)} bytes  ${abs(w.file)}`);
if (skipped.length) log(`skipped   : ${skipped.join("; ")}`);
log(`\n${written.length} file(s) written, ${skipped.length} page(s) skipped.`);

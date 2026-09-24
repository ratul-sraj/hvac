// Real-browser check of a WebHVAC deployment using the Edge already on this PC.
//   cd D:/webhvac && node tests/browser-check.mjs [url-of-the-calculator-page]
// Default = the local Express server's calculator page. Uses puppeteer-core (no download).
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const URL_ = process.argv[2] || "http://127.0.0.1:3000/app.html";
const BASE = new URL(".", URL_).href;   // directory the pages live in
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = "tests/qa";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const ok = (label, pass, detail = "") => {
  results.push({ label, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--window-size=1400,1000"],
  protocolTimeout: 120000,
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });

const consoleErrors = [];
// A static host (GitHub Pages) has no /api/health, so the app's own availability probe
// legitimately 404s there; browsers log that as a console error. It is not a page fault.
const BENIGN = [/\bapi\/health\b/, /favicon\.ico/];
const isBenign = (t) => BENIGN.some((re) => re.test(t));
page.on("console", (m) => { if (m.type() === "error" && !isBenign(m.text())) consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
const failedRequests = [];
page.on("requestfailed", (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));

try {
  // 1. load
  const resp = await page.goto(URL_, { waitUntil: "networkidle2", timeout: 60000 });
  ok("site loads", resp && resp.status() === 200, `HTTP ${resp && resp.status()} in ${URL_}`);
  ok("title", (await page.title()).includes("WebHVAC"), await page.title());

  // 2. no console errors on load
  ok("no console errors on load", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  // 3. sample drawing -> rooms
  const t0 = Date.now();
  await page.click("#btnSample");
  await page.waitForFunction(() => {
    const b = document.querySelector("#roomsBody");
    return b && b.querySelectorAll("tr").length > 100;
  }, { timeout: 120000 });
  const roomRows = await page.$$eval("#roomsBody tr", (r) => r.length);
  ok("sample drawing parsed in a real browser", roomRows > 100, `${roomRows} room rows in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const summary = await page.$$eval("#summaryCards .card, #summaryCards > *", (cards) =>
    cards.map((c) => c.innerText.replace(/\s+/g, " ").trim()).filter(Boolean));
  const tr = await page.$eval("#summaryCards", (e) => {
    const m = e.innerText.replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/);
    return m ? parseFloat(m[1]) : NaN;
  });
  ok("total cooling load shown", tr > 20 && tr < 2000, `${tr} TR`);
  const levels = await page.$$eval("#levelBody tr", (rows) =>
    rows.map((r) => r.innerText.replace(/\s+/g, " ")).slice(0, 5));
  ok("level-wise subtotals", levels.length >= 3, levels.join(" || ").slice(0, 200));

  await page.screenshot({ path: `${OUT}/live-rooms.png`, fullPage: false });

  // 4. country / city dropdowns
  const countries = await page.$$eval("#proj-country option", (o) => o.map((x) => x.value));
  ok("country list present", countries.length >= 12, countries.length + " countries");
  const indiaCities = await page.$$eval("#proj-city option", (o) => o.map((x) => x.value));
  ok("India city list sorted A-Z", JSON.stringify(indiaCities) === JSON.stringify([...indiaCities].sort()),
    indiaCities.slice(0, 6).join(", ") + " ...");
  await page.select("#proj-country", "United Arab Emirates");
  const uaeCities = await page.$$eval("#proj-city option", (o) => o.map((x) => x.value));
  ok("UAE cities only after switching country", uaeCities.every((c) => ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Ras Al Khaimah", "Fujairah", "Al Ain"].includes(c)),
    uaeCities.join(", "));
  await page.select("#proj-city", "Dubai");
  const db = await page.$eval("#proj-outDb", (e) => e.value);
  const wb = await page.$eval("#proj-outWb", (e) => e.value);
  ok("Dubai fills 46 / 29", Number(db) === 46 && Number(wb) === 29, `DB=${db} WB=${wb}`);
  const trAfterCity = await page.$eval("#summaryCards", (e) => {
    const m = e.innerText.replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/);
    return m ? parseFloat(m[1]) : NaN;
  });
  ok("changing the city recalculates", trAfterCity > tr * 1.05, `${tr} TR -> ${trAfterCity} TR (hotter)`);

  // back to Kochi
  await page.select("#proj-country", "India");
  await page.select("#proj-city", "Kochi");

  // 5. edit a room area -> totals update
  const before = tr;
  const areaSel = "#roomsBody tr:not(.excluded) input[data-field='area']";
  await page.$eval(areaSel, (inp) => {
    inp.focus();
    inp.value = "200";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 400));
  const afterEdit = await page.$eval("#summaryCards", (e) => {
    const m = e.innerText.replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/);
    return m ? parseFloat(m[1]) : NaN;
  });
  ok("editing a room area updates the total", Number.isFinite(afterEdit) && afterEdit !== before, `${before} -> ${afterEdit} TR`);
  ok("focus kept while typing", await page.evaluate(() => document.activeElement && document.activeElement.tagName === "INPUT"),
    await page.evaluate(() => document.activeElement && document.activeElement.tagName));

  // 6. filter + sort + include toggle
  await page.type("#filterName", "MEETING");
  await new Promise((r) => setTimeout(r, 300));
  const filtered = await page.$$eval("#roomsBody tr", (r) => r.length);
  ok("name filter narrows the table", filtered > 0 && filtered < roomRows, `${roomRows} -> ${filtered} rows`);
  await page.$eval("#filterName", (e) => { e.value = ""; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 200));
  await page.click("#filterLevel");
  await new Promise((r) => setTimeout(r, 200));

  // 7. CSV export (capture the generated Blob instead of a real file download)
  await page.evaluate(() => {
    window.__csv = null;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { try { blob.text().then((t) => { window.__csv = t; }); } catch (e) {} return orig(blob); };
  });
  await page.click("#btnCsv");
  await page.waitForFunction(() => window.__csv !== null, { timeout: 20000 }).catch(() => {});
  const csv = await page.evaluate(() => window.__csv);
  const csvLines = csv ? csv.split(/\r?\n/) : [];
  ok("CSV export produces a file", !!csv && csv.length > 1000, `${csv ? csv.length : 0} characters, ${csvLines.length} lines`);
  ok("CSV has a row per room and the totals", csvLines.length > 100 && /TR/i.test(csv || ""),
    (csvLines[0] || "").slice(0, 140));

  // 8. print report: capture the generated HTML instead of leaving a real popup open
  try {
    await page.evaluate(() => {
      window.__html = null;
      window.__printed = false;
      window.open = () => ({
        document: { write: (h) => { window.__html = h; }, close: () => {}, open: () => {}, },
        focus: () => {}, print: () => { window.__printed = true; }, close: () => {},
      });
    });
    await page.click("#btnPrint");
    await page.waitForFunction(() => window.__html !== null, { timeout: 20000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200)); // app calls print() 500 ms after opening
    const html = await page.evaluate(() => window.__html);
    const printed = await page.evaluate(() => window.__printed);
    ok("print report is generated", !!html && html.length > 5000, `${html ? html.length : 0} characters of report HTML`);
    ok("print is called on the report", printed === true, String(printed));
    const text = (html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    ok("report has design conditions, country and room totals",
      /Design conditions/i.test(text) && /Total cooling load/i.test(text) && /India/i.test(text) && /TR/.test(text),
      text.slice(0, 160));
    fs.writeFileSync(`${OUT}/report.html`, html || "");
  } catch (e) {
    ok("print report is generated", false, "driver error: " + (e && e.message));
  }

  // 9. reload restores state
  await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));
  const rowsAfterReload = await page.$$eval("#roomsBody tr", (r) => r.length);
  ok("rooms restored after reload (localStorage)", rowsAfterReload > 100, `${rowsAfterReload} rows`);

  // 10. mobile layout
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((r) => setTimeout(r, 600));
  const overflow = await page.evaluate(() => {
    const t = document.querySelector("#roomsTable");
    const w = document.querySelector(".table-wrap") || t.parentElement;
    return { scrollable: w.scrollWidth > w.clientWidth, bodyOverflow: document.body.scrollWidth > window.innerWidth + 2 };
  });
  ok("table scrolls on a narrow screen", overflow.scrollable, JSON.stringify(overflow));
  ok("page does not overflow sideways on mobile", !overflow.bodyOverflow, JSON.stringify(overflow));
  await page.screenshot({ path: `${OUT}/live-mobile.png` });
  await page.setViewport({ width: 1400, height: 1000 });

  // 11. no NaN / undefined shown anywhere
  const junk = await page.evaluate(() => {
    const t = document.body.innerText;
    return ["NaN", "undefined", "Infinity", "null"].filter((w) => new RegExp("\\b" + w + "\\b").test(t));
  });
  ok("no NaN / undefined / Infinity on screen", junk.length === 0, junk.join(", ") || "none");

  ok("no failed network requests", failedRequests.length === 0, failedRequests.slice(0, 3).join(" | ") || "none");
  ok("no console errors during the whole flow", consoleErrors.length === 0, consoleErrors.slice(0, 4).join(" | ") || "none");

  // 12. selftest page (real pdf.js worker + engine in the browser)
  await page.goto(BASE + "selftest.html", { waitUntil: "load", timeout: 90000 });
  let selfOut = "";
  for (let i = 0; i < 60; i++) {
    selfOut = await page.$eval("#out", (e) => e.innerText).catch(() => "");
    if (/ALL SELF TESTS PASSED|CHECK\(S\) FAILED|threw an error/.test(selfOut)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  ok("in-browser self test (PDF reader + engine)", /ALL SELF TESTS PASSED/.test(selfOut),
      selfOut.split("\n").slice(-3).join(" | "));
  fs.writeFileSync(`${OUT}/selftest.txt`, selfOut);
} catch (err) {
  ok("browser run completed without throwing", false, String(err && err.message));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
fs.writeFileSync(`${OUT}/browser-report.json`, JSON.stringify(results, null, 1));
if (failed.length) { console.log("failed:\n" + failed.map((f) => "  - " + f.label + " :: " + f.detail).join("\n")); process.exit(1); }
console.log("ALL BROWSER CHECKS PASSED");
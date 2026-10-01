// Real-browser check of a LoadLens deployment using the Edge already on this PC.
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

// Deny real file downloads. Capturing the CSV needs URL.createObjectURL, but that call cannot stop
// the following anchor click from saving a file — without this, EVERY test run dropped another
// "HVAC-Load-Calculation-cooling-load (n).csv" into the user's Downloads folder (26 of them piled up
// before this was noticed). CDP's deny is the only reliable way to stop it inside the page.
try {
  const cdp = await page.target().createCDPSession();
  await cdp.send("Page.setDownloadBehavior", { behavior: "deny" });
} catch (e) {
  console.warn("warning: could not disable downloads:", e.message);
}
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
  ok("title", (await page.title()).includes("LoadLens"), await page.title());

  // 2. no console errors on load
  ok("no console errors on load", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  // 3. sample drawing -> rooms. tests/samples/sample-plan.pdf is synthetic (tools/make-sample-plan.mjs),
  // so publishing it is safe — but a deployment may still not ship it (infra/50-deploy-site.sh only
  // uploads /samples with --with-samples). In that case the app says so clearly, and the
  // sample-dependent checks below are skipped rather than failed — what matters on such a deployment
  // is that the page, the API and the in-browser parser all work.
  const t0 = Date.now();
  await page.click("#btnSample");
  let sampleMissing = false;
  let roomRows = 0; // used again by the filter check below
  try {
    await page.waitForFunction(() => {
      const b = document.querySelector("#roomsBody");
      return b && b.querySelectorAll("tr").length > 100;
    }, { timeout: 120000 });
  } catch (e) {
    const statusText = await page.evaluate(() => {
      const el = document.querySelector("#status") || document.querySelector(".status");
      return el ? el.innerText.replace(/\s+/g, " ") : "";
    });
    sampleMissing = /not part of this deployment/.test(statusText);
  }
  if (sampleMissing) {
    ok("sample drawing absent -> app says so clearly", true, "the app reports the sample is not published here");
    const health = await page.evaluate(async () => {
      try { const r = await fetch("/api/health"); return `${r.status} ${(await r.text()).slice(0, 90)}`; }
      catch (e) { return "threw: " + e.message; }
    });
    ok("server-side API reachable from this deployment", /^200 /.test(health), health);
  } else {
    roomRows = await page.$$eval("#roomsBody tr", (r) => r.length);
    ok("sample drawing parsed in a real browser", roomRows > 100, `${roomRows} room rows in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

if (!sampleMissing) {

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


  // 13. the plan view: draw a room straight onto the drawing
  //     NOTE the panel sits BELOW the upload box, so it must be scrolled into view first: mouse
  //     coordinates are viewport-relative and a drag at an off-screen y delivers no pointer event at
  //     all (that mistake looks exactly like a broken feature).
  // The suite may have reloaded the page since the sample was first opened, and a reload has no
  // drawing in memory — so make this block stand on its own: be on the calculator, load the sample.
  if (!/app\.html/.test(page.url())) {
    await page.goto(BASE + "app.html", { waitUntil: "load", timeout: 90000 });
  }
  if (!(await page.$("#planCanvas"))) {
    await page.click("#btnSample").catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  }
  // the panel sits BELOW the upload box, so it must be scrolled into view: mouse coordinates are
  // viewport-relative and a drag at an off-screen y delivers no pointer event at all (that mistake
  // looks exactly like a broken feature).
  await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
  await new Promise((r) => setTimeout(r, 400));

  const planPainted = await page.waitForFunction(() => {
    const c = document.getElementById("planCanvas");
    return c && c.width > 400;
  }, { timeout: 60000, polling: 400 }).then(() => true).catch(() => false);
  const planGeom = await page.evaluate(() => {
    const c = document.getElementById("planCanvas");
    const pages = document.getElementById("planPages");
    return c ? { w: c.width, h: c.height, pages: pages ? pages.textContent : "?" } : null;
  });
  ok("the drawing is rendered on the page", planPainted && !!planGeom, JSON.stringify(planGeom));
  ok("the plan knows how many pages the PDF has", !!planGeom && planGeom.pages === "3",
      "pages=" + (planGeom && planGeom.pages));

  const planZoom = Number(await page.$eval("#planZoomPct", (e) => e.textContent)) / 100;
  ok("the drawing is fitted to the panel width", planZoom > 0.1 && planZoom < 3, `scale ${planZoom}`);

  const readTotalTr = () => page.$eval("#summaryCards", (e) => {
    const m = e.innerText.replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/);
    return m ? parseFloat(m[1]) : NaN;
  });
  const trBeforeDraw = await readTotalTr();
  const rowsBeforePlan = await page.$$eval("#roomsBody tr", (r) => r.length);
  const planBox = await page.$eval("#planView", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const dx = 300, dy = 210;
  const px1 = planBox.x + 120, py1 = planBox.y + 120;
  await page.mouse.move(px1, py1);
  await page.mouse.down();
  await page.mouse.move(px1 + dx / 2, py1 + dy / 2, { steps: 5 });
  await page.mouse.move(px1 + dx, py1 + dy, { steps: 8 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 900));

  const rowsAfterPlan = await page.$$eval("#roomsBody tr", (r) => r.length);
  ok("dragging on the drawing adds exactly one room", rowsAfterPlan === rowsBeforePlan + 1,
      `${rowsBeforePlan} -> ${rowsAfterPlan}`);
  const planShapes = await page.$$eval(".plan-room", (n) => n.length);
  ok("the overlay draws a box for the new room", planShapes === 1, `${planShapes} box(es)`);
  const planLabel = await page.$eval(".plan-room-label", (e) => e.textContent).catch(() => "");
  ok("the box is labelled", /Drawn room/.test(planLabel), JSON.stringify(planLabel));

  // the name and the numbers are <input>s, so read .value — row.textContent never contains them
  const readDrawn = () => page.evaluate(() => {
    const tr = [...document.querySelectorAll("#roomsBody tr")]
      .find((t) => { const i = t.querySelector('input[data-field="name"]'); return i && /Drawn room/.test(i.value); });
    if (!tr) return null;
    const i = tr.querySelector('input[data-field="area"]');
    return { name: tr.querySelector('input[data-field="name"]').value, area: i ? Number(i.value) : null };
  });
  const drawn = await readDrawn();
  const PT_PER_IN = 72, M_PER_IN = 0.0254;
  const areaOf = (wPt, hPt, denom) => ((wPt / PT_PER_IN * denom) * (hPt / PT_PER_IN * denom)) / ((1 / M_PER_IN) ** 2);
  const expectedArea = areaOf(dx / planZoom, dy / planZoom, 100);
  ok("the drawn room reaches the room table with an area", !!drawn && drawn.area > 0,
      drawn ? JSON.stringify(drawn) : "not found");
  ok("its area matches the rectangle at 1:100",
      !!drawn && Math.abs(drawn.area - expectedArea) <= Math.max(1, expectedArea * 0.04),
      `table ${drawn && drawn.area} m² vs geometry ${expectedArea.toFixed(2)} m²`);

  // the drawing scale is a real input: 1:200 must re-measure the room to 4x the area
  await page.select("#planScale", "200");
  await new Promise((r) => setTimeout(r, 800));
  const drawn200 = await readDrawn();
  ok("changing the drawing scale re-measures the drawn room",
      !!drawn200 && Math.abs(drawn200.area - expectedArea * 4) <= Math.max(2, expectedArea * 4 * 0.04),
      `1:200 gives ${drawn200 && drawn200.area} m² (expected ~${(expectedArea * 4).toFixed(1)})`);
  await page.select("#planScale", "100");
  await new Promise((r) => setTimeout(r, 500));

  // select mode: click the box, expect the load breakdown for that room
  await page.click("#planModeSelect");
  await page.mouse.click(px1 + 60, py1 + 40);
  await new Promise((r) => setTimeout(r, 700));
  const selectedBoxes = await page.$$eval(".plan-room.is-selected", (n) => n.length);
  const detailShown = await page.evaluate(() => !document.getElementById("detailPanel").classList.contains("hidden"));
  ok("clicking a box in select mode opens that room's breakdown", selectedBoxes === 1 && detailShown,
      `${selectedBoxes} selected, breakdown open: ${detailShown}`);
  await page.click("#planModeDraw");

  // the drawn room is part of the load, not just the table
  const trWithPlan = await readTotalTr();
  ok("the drawn room is included in the total cooling load", trWithPlan > trBeforeDraw,
      `${trBeforeDraw} TR just before the drag -> ${trWithPlan} TR after it`);
  await page.screenshot({ path: `${OUT}/live-plan.png` });

  // 14. drawing must keep working when the sheet is zoomed past fit-width and has to be scrolled.
  //     The overlay is a layer over the drawing: if it is sized to the visible window instead of to
  //     the drawing, everything further down the sheet takes no pointer events and cannot be drawn on.
  const fitScale = await page.evaluate(() => {
    const c = document.getElementById("planCanvas");
    const v = document.getElementById("planView");
    return { canvas: c.clientWidth, panel: v.clientWidth };
  });
  for (let i = 0; i < 3; i += 1) {
    await page.click("#planZoomIn");
    await new Promise((r) => setTimeout(r, 700));
  }
  const zoomed = await page.evaluate(() => {
    const c = document.getElementById("planCanvas");
    const v = document.getElementById("planView");
    const svg = document.querySelector(".plan-overlay");
    const sr = svg.getBoundingClientRect(), cr = c.getBoundingClientRect();
    return {
      scale: Number(document.getElementById("planZoomPct").textContent) / 100,
      canvasCss: c.clientWidth, panelW: v.clientWidth,
      scrollableX: v.scrollWidth > v.clientWidth + 1, scrollableY: v.scrollHeight > v.clientHeight + 1,
      svgW: Math.round(sr.width), svgH: Math.round(sr.height),
      coversCanvas: Math.abs(sr.left - cr.left) < 2 && Math.abs(sr.top - cr.top) < 2 &&
                    sr.width >= c.clientWidth - 2 && sr.height >= c.clientHeight - 2,
    };
  });
  ok("zooming past fit-width makes the sheet scrollable",
      zoomed.scrollableX || zoomed.scrollableY, JSON.stringify(zoomed));
  ok("the overlay covers the whole drawing, not just the visible window",
      zoomed.coversCanvas, `svg ${zoomed.svgW}x${zoomed.svgH} vs canvas ${zoomed.canvasCss} css px`);

  // scroll to the far corner of the sheet: this is the part that used to be undrawable
  await page.evaluate(() => {
    const v = document.getElementById("planView");
    v.scrollLeft = v.scrollWidth;
    v.scrollTop = v.scrollHeight;
  });
  await new Promise((r) => setTimeout(r, 500));

  const rowsBeforeZoomDraw = await page.$$eval("#roomsBody tr", (r) => r.length);
  const zoomBox = await page.$eval("#planView", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const zx = 260, zy = 190;
  const qx = zoomBox.x + 40, qy = zoomBox.y + 40;
  await page.mouse.move(qx, qy);
  await page.mouse.down();
  await page.mouse.move(qx + zx / 2, qy + zy / 2, { steps: 5 });
  await page.mouse.move(qx + zx, qy + zy, { steps: 8 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 900));

  const rowsAfterZoomDraw = await page.$$eval("#roomsBody tr", (r) => r.length);
  ok("a room can still be drawn on a zoomed-in, scrolled sheet",
      rowsAfterZoomDraw === rowsBeforeZoomDraw + 1,
      `${rowsBeforeZoomDraw} -> ${rowsAfterZoomDraw} at ${zoomed.scale}x`);

  const zoomDrawn = await page.evaluate(() => {
    const out = [];
    for (const tr of document.querySelectorAll("#roomsBody tr")) {
      const n = tr.querySelector('input[data-field="name"]');
      const a = tr.querySelector('input[data-field="area"]');
      if (n && /Drawn room/.test(n.value)) out.push({ name: n.value, area: a ? Number(a.value) : null });
    }
    return out;
  });
  const newest = zoomDrawn[zoomDrawn.length - 1];
  const zoomExpected = areaOf(zx / zoomed.scale, zy / zoomed.scale, 100);
  ok("the room drawn on the scrolled sheet has the right area",
      !!newest && Math.abs(newest.area - zoomExpected) <= Math.max(1, zoomExpected * 0.05),
      newest ? `table ${newest.area} m² vs geometry ${zoomExpected.toFixed(2)} m²` : "not found");


  // A drawn box must land UNDER THE CURSOR. Area and size checks pass even when the box is placed
  // somewhere else entirely, which is exactly what a coordinate/scroll bug looks like.
  const landed = await page.evaluate(([sx, sy]) => {
    const svg = document.querySelector(".plan-overlay");
    const sr = svg.getBoundingClientRect();
    const boxes = [...document.querySelectorAll(".plan-room-box")];
    const last = boxes[boxes.length - 1];
    if (!last) return null;
    return { x: sr.x + (+last.getAttribute("x")), y: sr.y + (+last.getAttribute("y")) };
  }, [qx, qy]);
  const miss = landed ? { x: Math.round(landed.x - qx), y: Math.round(landed.y - qy) } : null;
  ok("the room lands under the cursor, not somewhere else on the sheet",
      !!miss && Math.abs(miss.x) <= 12 && Math.abs(miss.y) <= 12,
      miss ? `off by ${miss.x},${miss.y} px from the drag start` : "no box found");

  // Drawing on the plan must not throw the user off the drawing: the breakdown appearing below is
  // fine, but the page must not scroll the sheet out of view (it did, after every single room).
  const panelNow = await page.evaluate(() => {
    const r = document.getElementById("planView").getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
  });
  ok("the drawing is still on screen after a room is drawn there",
      panelNow.bottom > 0 && panelNow.top < panelNow.vh,
      `panel top ${panelNow.top}, bottom ${panelNow.bottom}, viewport ${panelNow.vh}`);


  // the summary must agree with the rows it is derived from: conditioned area == the areas of the
  // rooms that are ticked as included. A silent disagreement here is how a load sheet stops being
  // trustworthy without anyone noticing.
  const agree = await page.evaluate(() => {
    let sum = 0;
    for (const tr of document.querySelectorAll("#roomsBody tr")) {
      const cb = tr.querySelector('input[type="checkbox"]');
      const a = tr.querySelector('input[data-field="area"]');
      if (cb && cb.checked && a) sum += parseFloat(a.value) || 0;
    }
    const m = document.getElementById("summaryCards").innerText.replace(/\s+/g, " ")
      .match(/Conditioned area ([0-9,\.]+) m/);
    const shown = m ? parseFloat(m[1].replace(/,/g, "")) : NaN;
    return { sum: +sum.toFixed(1), shown };
  });
  ok("the conditioned area on the summary equals the sum of the included rooms",
      Math.abs(agree.sum - agree.shown) <= 0.2, `${agree.sum} m² vs ${agree.shown} m²`);

  // put the view back so the screenshot shows the whole sheet
  await page.click("#planFit");
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: `${OUT}/live-plan-zoomed.png` });


  // 15. a refresh must not lose the drawing. The rooms were always saved; the PDF was not, so the
  //     user was left with a table and no sheet. The sheet is now kept in this browser's IndexedDB.
  const preReload = await page.evaluate(() => ({
    rows: document.querySelectorAll("#roomsBody tr").length,
    drawn: [...document.querySelectorAll('#roomsBody tr input[data-field="name"]')]
      .filter((i) => /Drawn room/.test(i.value)).length,
  }));
  await page.click("#planNext");                       // give the reload a page to remember
  await new Promise((r) => setTimeout(r, 1000));
  const pageBefore = await page.$eval("#planPage", (e) => e.textContent);
  await page.reload({ waitUntil: "load", timeout: 90000 });
  const backAgain = await page.waitForFunction(() => {
    const c = document.getElementById("planCanvas");
    return c && c.width > 400;
  }, { timeout: 60000, polling: 400 }).then(() => true).catch(() => false);
  await new Promise((r) => setTimeout(r, 800));
  const postReload = await page.evaluate(() => ({
    rows: document.querySelectorAll("#roomsBody tr").length,
    drawn: [...document.querySelectorAll('#roomsBody tr input[data-field="name"]')]
      .filter((i) => /Drawn room/.test(i.value)).length,
    page: document.getElementById("planPage").textContent,
    canvas: !!document.getElementById("planCanvas"),
  }));
  ok("the drawing is still shown after a refresh", backAgain && postReload.canvas, JSON.stringify(postReload));
  ok("the room table survives the refresh unchanged",
      postReload.rows === preReload.rows && postReload.drawn === preReload.drawn,
      `${preReload.rows}/${preReload.drawn} before -> ${postReload.rows}/${postReload.drawn} after`);
  ok("the sheet comes back on the page the user was on", postReload.page === pageBefore,
      `page ${pageBefore} before -> ${postReload.page} after`);
  await page.click("#planPrev");
  await new Promise((r) => setTimeout(r, 900));
  const boxesBack = await page.$$eval(".plan-room", (n) => n.length);
  ok("the drawn rooms are still drawn on their page after a refresh", boxesBack >= 1, `${boxesBack} box(es)`);

  // 16. renaming a room must follow through to every place the room is shown: the table row, its box
  //     label on the drawing, and its description under the table. The drawing was the one that stayed
  //     stale: the in-table edit path deliberately does not rebuild the table (that would take the
  //     caret out of the cell being typed in) and forgot to redraw the plan overlay.
  const drawnInput = await page.evaluateHandle(() =>
    [...document.querySelectorAll('#roomsBody tr input[data-field="name"]')].find((i) => /Drawn room/.test(i.value)) || null);
  const drawnEl = drawnInput.asElement();
  const renamedTo = "Conference A";
  const renameResult = { before: null, labelsBefore: 0, after: null };
  if (drawnEl) {
    // open that room's breakdown FIRST: clicking a computed cell, not an input (row clicks on inputs
    // are ignored on purpose, so the caret can be placed while editing)
    await page.evaluate(() => {
      const input = [...document.querySelectorAll('#roomsBody tr input[data-field="name"]')]
        .find((i) => /Drawn room/.test(i.value));
      const cell = input && input.closest('tr').querySelector('.v-total');
      if (cell) cell.click();
    });
    await new Promise((r) => setTimeout(r, 600));
    renameResult.detailOpen = await page.evaluate(() =>
      !document.getElementById("detailPanel").classList.contains("hidden"));
    renameResult.before = await page.evaluate((e) => e.value, drawnEl);
    renameResult.labelsBefore = await page.$$eval(".plan-room-label", (n) => n.length);
    await drawnEl.focus();
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.type(renamedTo);
    await new Promise((r) => setTimeout(r, 700));
    renameResult.after = await page.evaluate(() => ({
      labels: [...document.querySelectorAll(".plan-room-label")].map((e) => e.textContent),
      drawnLabels: [...document.querySelectorAll(".plan-room-label")].filter((e) => /Drawn room/.test(e.textContent)).length,
      detail: document.getElementById("detailPanel").classList.contains("hidden") ? null
        : document.getElementById("detailPanel").innerText.replace(/\s+/g, " ").slice(0, 120),
    }));
    // put the original name back: later steps and the screenshots expect it
    await drawnEl.focus();
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.type(renameResult.before || "Drawn room 1");
    await new Promise((r) => setTimeout(r, 500));
  }
  ok("renaming a room in the table updates its box label on the drawing",
      !!renameResult.after && renameResult.after.labels.includes(renamedTo) &&
        renameResult.after.drawnLabels === renameResult.labelsBefore - 1,
      `labels now ${JSON.stringify(renameResult.after && renameResult.after.labels)} (was ${renameResult.labelsBefore} boxes)`);
  ok("the description under the table follows the rename as it is typed",
      !!renameResult.detailOpen && !!renameResult.after && !!renameResult.after.detail &&
        renameResult.after.detail.includes(renamedTo),
      JSON.stringify(renameResult.after && renameResult.after.detail));

} // end of the checks that need the sample drawing

  // 12. selftest page (real pdf.js worker + engine in the browser) — independent of the sample
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
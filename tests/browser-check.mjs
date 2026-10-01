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

  // 8. print report. It must NOT depend on window.open(): a pop-up blocker refuses it, and an embedded
  //    preview pane blocks it outright, where "allow pop-ups for this page" cannot help. The report is
  //    opened in an inline frame inside the page instead, and printed from there.
  try {
    let popupAttempts = 0;
    await page.evaluate(() => {
      window.__popups = 0;
      window.open = () => { window.__popups += 1; return null; };   // behave like a blocker
    });
    await page.click("#btnPrint");
    await new Promise((r) => setTimeout(r, 1200));
    popupAttempts = await page.evaluate(() => window.__popups);

    const report = await page.evaluate(() => {
      const view = document.getElementById("reportView");
      const frame = document.getElementById("reportFrame");
      const doc = frame && frame.contentDocument ? frame.contentDocument : null;
      const html = doc ? doc.documentElement.outerHTML : "";
      return {
        visible: !!view && !view.classList.contains("hidden"),
        reporting: document.body.classList.contains("reporting"),
        blockedMessageShown: /pop-ups/i.test((document.getElementById("statusBox") || {}).textContent || ""),
        len: html.length,
        text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "),
      };
    });
    ok("the loading report opens without a pop-up window", report.visible, JSON.stringify({ visible: report.visible, popups: popupAttempts }));
    ok("it shows a real report, not an empty frame",
        report.len > 5000, `${report.len} characters in the frame`);
    ok("it says nothing about pop-ups being blocked", !report.blockedMessageShown, String(report.blockedMessageShown));
    ok("report has design conditions, country and room totals",
      /Design conditions/i.test(report.text) && /Total cooling load/i.test(report.text) &&
        /India/i.test(report.text) && /TR/.test(report.text), report.text.slice(0, 160));
    fs.writeFileSync(`${OUT}/report.html`, report.text.slice(0, 40000));

    // printing happens from the frame itself (same origin), so stub its print and press the button
    await page.evaluate(() => {
      const frame = document.getElementById("reportFrame");
      frame.contentWindow.__printed = 0;
      frame.contentWindow.print = () => { frame.contentWindow.__printed += 1; };
    });
    await page.click("#reportPrint");
    await new Promise((r) => setTimeout(r, 400));
    const framePrinted = await page.evaluate(() => document.getElementById("reportFrame").contentWindow.__printed);
    ok("Print / Save as PDF prints the report itself", framePrinted === 1, `print called ${framePrinted} time(s)`);

    // and it closes again
    await page.click("#reportClose");
    await new Promise((r) => setTimeout(r, 300));
    const closed = await page.evaluate(() => {
      const view = document.getElementById("reportView");
      return {
        hidden: view.classList.contains("hidden"),
        reporting: document.body.classList.contains("reporting"),
        srcdocCleared: !document.getElementById("reportFrame").hasAttribute("srcdoc"),
      };
    });
    ok("the report view closes and leaves nothing behind",
        closed.hidden && !closed.reporting && closed.srcdocCleared, JSON.stringify(closed));
  } catch (e) {
    ok("the loading report opens without a pop-up window", false, "driver error: " + (e && e.message));
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


  // 17. the safety allowance on the load summary. The 10% factor has always been applied to the room
  //     heat; this guards the card that now shows what it is worth, against the engine it comes from.
  const readSafety = () => page.evaluate(() => {
    const cards = [...document.querySelectorAll("#summaryCards .scard")];
    const card = cards.find((c) => /Safety allowance/.test(c.textContent));
    const calc = window.webhvac && window.webhvac.currentCalc ? window.webhvac.currentCalc() : null;
    const t = calc ? calc.totals : null;
    return {
      label: card ? card.textContent.replace(/\s+/g, " ").trim() : null,
      shownW: card ? Number((card.textContent.replace(/,/g, "").match(/([0-9.]+)\s*W/) || [])[1]) : null,
      engineW: t ? Math.round(t.safetyW) : null,
      pct: t ? t.safetyPct : null,
      roomHeat: t ? t.rsh + t.rlh : null,
      tr: t ? t.tr : null,
    };
  });

  const safety10 = await readSafety();
  ok("the load summary shows the safety allowance", !!safety10.label, String(safety10.label));
  ok("the card names the percentage in the project settings",
      !!safety10.label && safety10.label.includes("10%"), String(safety10.label));
  ok("the allowance shown is the engine's own number",
      safety10.shownW === safety10.engineW && safety10.engineW > 0,
      `card ${safety10.shownW} W vs engine ${safety10.engineW} W`);
  // identity: the allowance is the room heat's share for a pct% uplift, i.e. roomHeat * pct/(100+pct)
  ok("the allowance is the room heat's own percentage share",
      Math.abs(safety10.engineW - safety10.roomHeat * (safety10.pct / (100 + safety10.pct))) <= 1,
      `${safety10.engineW} W vs ${(safety10.roomHeat * (safety10.pct / (100 + safety10.pct))).toFixed(1)} W of ${Math.round(safety10.roomHeat)} W`);

  // changing the setting must move BOTH the card and the cooling load, and doubling it must double the
  // allowance; then put it back so later steps see the project as the user left it
  await page.$eval("#proj-safety", (el) => { el.value = "20"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 800));
  const safety20 = await readSafety();
  ok("raising the safety factor to 20% moves the cooling load",
      safety20.tr > safety10.tr, `${safety10.tr.toFixed(2)} TR -> ${safety20.tr.toFixed(2)} TR`);
  ok("the allowance doubles with the percentage",
      Math.abs(safety20.engineW - safety10.engineW * 2) <= 2,
      `${safety10.engineW} W at 10% -> ${safety20.engineW} W at 20%`);
  ok("the card follows the new percentage",
      !!safety20.label && safety20.label.includes("20%") && safety20.shownW === safety20.engineW,
      String(safety20.label));
  await page.$eval("#proj-safety", (el) => { el.value = "10"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 800));
  const safetyBack = await readSafety();
  ok("setting it back to 10% restores the original load",
      Math.abs(safetyBack.tr - safety10.tr) <= 0.02, `${safety10.tr.toFixed(2)} -> ${safetyBack.tr.toFixed(2)} TR`);

  // 18. clicking zoom faster than the drawing repaints must not leave the layer behind.
  //     Each zoom re-sizes the canvas asynchronously (it has to paint first — half a second on a real
  //     CAD sheet), and the room layer has to follow it. It did not: the layer stayed at the old size
  //     while the drawing had already grown, so the rooms bunched toward the top-left corner and the
  //     scroll extents were wrong, until a later paint happened to fix it. Reported from use as
  //     "click the zoom button quickly ... the drawn area gets reset to the corners ... if I give a
  //     moment it behaves normally afterwards".
  //     CPU throttling widens that window on this small synthetic sheet (a real CAD sheet is slow
  //     enough on its own), so the guard is deterministic instead of a race that usually passes.
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 24 });
  try {
    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await new Promise((r) => setTimeout(r, 500));
    const shape = () => page.evaluate(() => {
      const svg = document.querySelector(".plan-overlay");
      const canvas = document.getElementById("planCanvas");
      const sr = svg.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
      const vb = (svg.getAttribute("viewBox") || "").split(/[ ,]+/).map(Number);
      const box = document.querySelector(".plan-room-box");
      return {
        canvas: [canvas.clientWidth, canvas.clientHeight],
        layer: [Math.round(sr.width), Math.round(sr.height)],
        sized: Math.abs(sr.width - canvas.clientWidth) < 2 && Math.abs(sr.height - canvas.clientHeight) < 2,
        placed: Math.abs(sr.left - cr.left) < 2 && Math.abs(sr.top - cr.top) < 2,
        viewBox: vb,
        boxFrac: box && vb[2] ? +((+box.getAttribute("x")) / vb[2]).toFixed(3) : null,
      };
    });
    const before = await shape();
    // four clicks inside one tick, as fast as a hand can land them
    await page.evaluate(() => {
      const btn = document.getElementById("planZoomIn");
      for (let i = 0; i < 4; i += 1) btn.click();
    });
    const immediately = await shape();
    await new Promise((r) => setTimeout(r, 400));
    const shortly = await shape();
    await new Promise((r) => setTimeout(r, 4000));
    const settled = await shape();

    ok("the room layer never lags behind the drawing when zooming fast",
        immediately.sized && shortly.sized, JSON.stringify({ immediately, shortly }));
    ok("the layer stays on the drawing while zooming fast",
        immediately.placed && shortly.placed, JSON.stringify({ placedNow: [immediately.placed, shortly.placed] }));
    ok("the layer ends up the size of the drawing once the clicks stop",
        settled.sized && settled.placed, JSON.stringify(settled));
    ok("the rooms keep their place on the sheet through the zoom",
        before.boxFrac != null && settled.boxFrac != null && Math.abs(settled.boxFrac - before.boxFrac) <= 0.01,
        `room was ${before.boxFrac} across the sheet, now ${settled.boxFrac}`);
    ok("four fast clicks still zoom four steps' worth",
        settled.viewBox[2] > before.viewBox[2] * 1.8,
        `layer width ${before.viewBox[2]} -> ${settled.viewBox[2]}`);
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach().catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 300));

  // ---- Stage 2: move, resize, delete and pan a room on the drawing ---------------------------------
  // These run last in this block and put the row count back where they found it (one drawn, one
  // deleted), so nothing after them depends on their state.
  // Every check targets the room it drew BY ID: the overlay draws rooms biggest-first, so the order of
  // boxes in the DOM is not the order they were drawn in, and "the last box" is the smallest room.
  {
    const p0 = await page.$eval("#planView", (e) => { const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y }; });
    const rows2 = () => page.$$eval("#roomsBody tr", (t) => t.length);
    const roomIdOfLastRow = () => page.$eval("#roomsBody tr:last-child", (tr) => tr.getAttribute("data-id"));
    const areaOfRoom = (id) => page.$eval(`#roomsBody tr[data-id="${id}"] input[data-field="area"]`, (i) => i.value).catch(() => null);
    const boxOfRoom = (id) => page.evaluate((rid) => {
      const g = document.querySelector(`.plan-room[data-room-id="${rid}"]`);
      if (!g) return null;
      const r = g.querySelector(".plan-room-box");
      return { x: +r.getAttribute("x"), y: +r.getAttribute("y"),
               w: +r.getAttribute("width"), h: +r.getAttribute("height") };
    }, id);
    const layerState = () => page.evaluate(() => {
      const svg = document.querySelector(".plan-overlay");
      const canvas = document.getElementById("planCanvas");
      const view = document.getElementById("planView");
      const sr = svg.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
      return { handles: document.querySelectorAll(".plan-room-handle").length,
               selected: document.querySelectorAll(".plan-room.is-selected").length,
               aligned: Math.abs(sr.left - cr.left) < 2 && Math.abs(sr.width - canvas.clientWidth) < 2,
               scroll: [view.scrollLeft, view.scrollTop] };
    });

    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await new Promise((r) => setTimeout(r, 400));
    const rowsStart = await rows2();

    // draw one room to work on
    await page.click("#planModeDraw");
    await new Promise((r) => setTimeout(r, 200));
    await page.mouse.move(p0.x + 140, p0.y + 120);
    await page.mouse.down();
    await page.mouse.move(p0.x + 300, p0.y + 280, { steps: 6 });
    await page.mouse.move(p0.x + 420, p0.y + 360, { steps: 6 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 800));
    const id2 = await roomIdOfLastRow();
    const areaDrawn2 = await areaOfRoom(id2);
    const r0 = await boxOfRoom(id2);
    ok("the room just drawn can be found on the drawing by its id",
      !!r0 && (await rows2()) === rowsStart + 1, `id ${id2}, box ${JSON.stringify(r0)}`);

    // select it, then drag the body
    await page.click("#planModeSelect");
    await new Promise((r) => setTimeout(r, 250));
    let layer = await layerState();
    const cx2 = p0.x + (r0.x + r0.w / 2 - layer.scroll[0]);
    const cy2 = p0.y + (r0.y + r0.h / 2 - layer.scroll[1]);
    await page.mouse.click(cx2, cy2);
    await new Promise((r) => setTimeout(r, 400));
    layer = await layerState();
    ok("selecting a drawn room shows its four corner handles",
      layer.handles === 4 && layer.selected === 1, `handles ${layer.handles}, selected ${layer.selected}`);

    await page.mouse.move(cx2, cy2);
    await page.mouse.down();
    await page.mouse.move(cx2 + 90, cy2 + 70, { steps: 8 });
    await page.mouse.move(cx2 + 150, cy2 + 120, { steps: 8 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 700));
    const moved2 = await boxOfRoom(id2);
    ok("dragging a room's body moves it on the drawing",
      Math.abs(moved2.x - r0.x) > 20 && Math.abs(moved2.y - r0.y) > 15,
      `(${r0.x.toFixed(0)},${r0.y.toFixed(0)}) -> (${moved2.x.toFixed(0)},${moved2.y.toFixed(0)})`);
    ok("moving a room does not change its size or its area",
      Math.abs(moved2.w - r0.w) < 2 && Math.abs(moved2.h - r0.h) < 2 && (await areaOfRoom(id2)) === areaDrawn2,
      `${r0.w.toFixed(0)}x${r0.h.toFixed(0)} -> ${moved2.w.toFixed(0)}x${moved2.h.toFixed(0)}, area ${areaDrawn2} -> ${await areaOfRoom(id2)}`);

    // drag its se corner: bigger area, opposite corner pinned
    const seX2 = p0.x + (moved2.x + moved2.w - layer.scroll[0]);
    const seY2 = p0.y + (moved2.y + moved2.h - layer.scroll[1]);
    await page.mouse.move(seX2, seY2);
    await page.mouse.down();
    await page.mouse.move(seX2 + 120, seY2 + 90, { steps: 8 });
    await page.mouse.move(seX2 + 200, seY2 + 150, { steps: 8 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 800));
    const big2 = await boxOfRoom(id2);
    const areaResized2 = await areaOfRoom(id2);
    ok("dragging a corner resizes the room",
      big2.w > moved2.w + 20 && big2.h > moved2.h + 15,
      `${moved2.w.toFixed(0)}x${moved2.h.toFixed(0)} -> ${big2.w.toFixed(0)}x${big2.h.toFixed(0)}`);
    ok("the opposite corner stays pinned while resizing",
      Math.abs(big2.x - moved2.x) < 3 && Math.abs(big2.y - moved2.y) < 3,
      `${moved2.x.toFixed(0)},${moved2.y.toFixed(0)} -> ${big2.x.toFixed(0)},${big2.y.toFixed(0)}`);
    ok("resizing recomputes the room's area in the table",
      Number(areaResized2) > Number(areaDrawn2), `${areaDrawn2} m2 -> ${areaResized2} m2`);

    // panning moves the sheet without moving the room
    await page.click("#planZoomIn");
    await new Promise((r) => setTimeout(r, 900));
    const panBefore2 = await layerState();
    // the zoom above moved and grew the box in view space, so the reference for "panning did not move
    // the room" has to be taken AFTER it, not before
    const panRefBox = await boxOfRoom(id2);
    await page.mouse.move(p0.x + 600, p0.y + 300);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(p0.x + 300, p0.y + 150, { steps: 10 });
    await page.mouse.move(p0.x + 200, p0.y + 100, { steps: 10 });
    await page.mouse.up({ button: "middle" });
    await new Promise((r) => setTimeout(r, 400));
    const panAfter2 = await layerState();
    const panRoom = await boxOfRoom(id2);
    ok("middle-drag pans the drawing",
      panAfter2.scroll[0] !== panBefore2.scroll[0] || panAfter2.scroll[1] !== panBefore2.scroll[1],
      `scroll ${panBefore2.scroll.join(",")} -> ${panAfter2.scroll.join(",")}`);
    ok("panning moves the view and not the room",
      Math.abs(panRoom.w - panRefBox.w) < 2 && Math.abs(panRoom.x - panRefBox.x) < 2 &&
      Math.abs(panRoom.y - panRefBox.y) < 2 && panAfter2.aligned,
      `box ${panRefBox.x.toFixed(0)},${panRefBox.y.toFixed(0)} ${panRefBox.w.toFixed(0)}x${panRefBox.h.toFixed(0)} -> ${panRoom.x.toFixed(0)},${panRoom.y.toFixed(0)} ${panRoom.w.toFixed(0)}x${panRoom.h.toFixed(0)}, layer on drawing: ${panAfter2.aligned}`);
    await page.click("#planFit");
    await new Promise((r) => setTimeout(r, 900));

    // a keystroke inside a table cell must not delete a room
    await page.focus("#roomsBody tr:last-child input[data-field=\"name\"]");
    const rowsBeforeKey = await rows2();
    await page.keyboard.press("Delete");
    await new Promise((r) => setTimeout(r, 300));
    ok("Delete while typing in a table cell does not delete a room",
      (await rows2()) === rowsBeforeKey, `${rowsBeforeKey} -> ${await rows2()}`);

    // ...but Delete must reach the drawing while a non-text control holds the focus. Clicking a room
    // does not blur the mode radio (the drag cancels the default that would move focus), so treating
    // every <input> as a text field made Delete silently do nothing right after switching mode.
    await page.click("#planModeSelect");
    await new Promise((r) => setTimeout(r, 300));
    // click the box where it actually IS on screen: scroll it into view first, then use its client
    // rectangle, so no scroll arithmetic can send the click somewhere else (it hit the page-nav
    // button once, which selected nothing and made this check look like a product failure)
    await page.evaluate((rid) => {
      const g = document.querySelector(`.plan-room[data-room-id="${rid}"]`);
      if (g && g.scrollIntoView) g.scrollIntoView({ block: "center" });
    }, id2);
    await new Promise((r) => setTimeout(r, 400));
    const boxClient = await page.evaluate((rid) => {
      const g = document.querySelector(`.plan-room[data-room-id="${rid}"]`);
      if (!g) return null;
      const r = g.querySelector(".plan-room-box").getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, id2);
    if (boxClient) await page.mouse.click(boxClient.x + boxClient.w / 2, boxClient.y + boxClient.h / 2);
    await new Promise((r) => setTimeout(r, 400));
    const radioState = await page.evaluate(() => ({
      active: document.activeElement ? document.activeElement.id : "none",
      selected: document.querySelectorAll(".plan-room.is-selected").length }));
    await page.keyboard.press("Delete");
    await new Promise((r) => setTimeout(r, 700));
    ok("Delete reaches the drawing while the mode radio holds the focus",
      radioState.active === "planModeSelect" && radioState.selected === 1 && (await rows2()) === rowsStart,
      `focused ${radioState.active}, selected ${radioState.selected}, rows ${rowsStart} at the start -> ${await rows2()} after deleting the drawn room`);
  }


  // ---- Placing every room of the table on the drawing ------------------------------------------------
  // The rooms the reader finds from name+area labels carry `at` (where the plan names them, PDF space).
  // Placing puts a region there, sized BACK from the room's own area — so it can never change a load,
  // which is the one thing that must be true for an HVAC figure to stay trustworthy.
  {
    const rows3 = () => page.$$eval("#roomsBody tr", (t) => t.length);
    const totalOf = () => page.evaluate(() => {
      const c = [...document.querySelectorAll("#summaryCards .scard")].find((x) => /Total cooling load/i.test(x.textContent));
      return c ? c.textContent.replace(/\s+/g, " ").trim() : "";
    });
    const roomsNow = () => page.evaluate(() => {
      const rooms = window.webhvac.state.rooms;
      const pageNow = +(document.getElementById("planPage").textContent.trim());
      return {
        total: rooms.length,
        withAt: rooms.filter((r) => r.at && Number.isFinite(r.at.x)).length,
        placed: rooms.filter((r) => r.rect && r.rect.placed === true).length,
        drawn: rooms.filter((r) => r.rect && r.rect.placed !== true).length,
        boxesOnPage: document.querySelectorAll(".plan-room").length,
        pageNow,
        onThisPage: rooms.filter((r) => r.at && (r.page || 1) === pageNow).length,
        areas: rooms.map((r) => `${r.id}:${r.area}:${r.length}:${r.width}`).join("|"),
      };
    });

    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await page.click("#planModeDraw");
    await new Promise((r) => setTimeout(r, 250));
    const before = await roomsNow();
    const totalBefore = await totalOf();
    const rowsBefore = await rows3();

    ok("no region is on the drawing before placing", before.placed === 0, `${before.placed} placed, ${before.drawn} drawn`);

    await page.click("#planPlaceAll");
    await new Promise((r) => setTimeout(r, 1500));
    const after = await roomsNow();
    const totalAfter = await totalOf();

    ok("placing puts every room the plan names on the drawing",
      after.placed === after.withAt && after.placed > 0,
      `${after.placed} placed of ${after.withAt} named on the sheet`);
    ok("placing shows them on the page you are looking at",
      after.boxesOnPage >= after.onThisPage, `${after.boxesOnPage} boxes on page ${after.pageNow}, ${after.onThisPage} rooms named on it`);
    ok("placing does not add or drop table rows", (await rows3()) === rowsBefore, `${rowsBefore} -> ${await rows3()}`);
    ok("PLACING DOES NOT CHANGE THE LOAD", totalAfter === totalBefore, `"${totalBefore}" -> "${totalAfter}"`);
    ok("placing leaves every room's area and dimensions exactly as they were",
      after.areas === before.areas, `${before.total} rooms compared field by field`);

    const geom = await page.evaluate(() => {
      const rooms = window.webhvac.state.rooms.filter((r) => r.rect && r.rect.placed === true);
      const denom = +(document.getElementById("planScale").value || 100) || 100;
      const mPerPt = (denom * 0.0254) / 72;
      let worst = 0, worstName = "-", areaOff = 0;
      for (const r of rooms) {
        const cx = r.rect.x + r.rect.w / 2, cy = r.rect.y + r.rect.h / 2;
        const off = Math.abs(cx - r.at.x) + Math.abs(cy - r.at.y);
        if (off > worst) { worst = off; worstName = r.name; }
        const boxArea = (r.rect.w * mPerPt) * (r.rect.h * mPerPt);
        if (r.area > 0 && Math.abs(boxArea - r.area) / r.area > 0.02) areaOff += 1;
      }
      return { count: rooms.length, worst: +worst.toFixed(2), worstName, areaOff, denom };
    });
    ok("every placed region is centred on the point that names the room",
      geom.count > 0 && geom.worst < 0.5, `worst off-centre ${geom.worst} pt (${geom.worstName})`);
    ok("every placed region measures that room's own area",
      geom.areaOff === 0, `${geom.areaOff} of ${geom.count} disagree at 1:${geom.denom}`);

    // clicking one opens ITS breakdown: the smallest region under the pointer wins, so a big region
    // cannot steal a click from a room inside it
    const pick = await page.evaluate(() => {
      const pageNow = +(document.getElementById("planPage").textContent.trim());
      const rooms = window.webhvac.state.rooms
        .filter((r) => r.rect && r.rect.placed === true && (r.page || 1) === pageNow)
        .sort((a, b) => a.area - b.area);
      return rooms[0] ? { id: rooms[0].id, name: rooms[0].name } : null;
    });
    await page.click("#planModeSelect");
    await new Promise((r) => setTimeout(r, 300));
    const boxClient = await page.evaluate((rid) => {
      const g = document.querySelector(`.plan-room[data-room-id="${rid}"]`);
      if (!g) return null;
      if (g.scrollIntoView) g.scrollIntoView({ block: "center" });
      const r = g.querySelector(".plan-room-box").getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, pick.id);
    await new Promise((r) => setTimeout(r, 400));
    if (boxClient) await page.mouse.click(boxClient.x + boxClient.w / 2, boxClient.y + boxClient.h / 2);
    await new Promise((r) => setTimeout(r, 500));
    const shown = await page.$eval("#detailPanel", (e) => e.textContent.replace(/\s+/g, " ").trim().slice(0, 80));
    ok("clicking a placed room opens its own breakdown", !!pick && shown.includes(pick.name),
      `${pick && pick.name} -> "${shown.slice(0, 60)}"`);

    // clearing takes away only what was placed
    const totalBeforeClear = await totalOf();
    await page.click("#planPlaceClear");
    await new Promise((r) => setTimeout(r, 1200));
    const cleared = await roomsNow();
    ok("removing placed rooms removes exactly those",
      cleared.placed === 0 && cleared.drawn === before.drawn,
      `${after.placed} placed -> ${cleared.placed}, hand-drawn ${before.drawn} -> ${cleared.drawn}`);
    ok("removing placed rooms does not change the load either",
      (await totalOf()) === totalBeforeClear, `"${totalBeforeClear}" -> "${await totalOf()}"`);

    // and they come back after a refresh: the regions are part of the saved project
    await page.click("#planPlaceAll");
    await new Promise((r) => setTimeout(r, 1200));
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 50,
      { timeout: 120000, polling: 400 });
    await new Promise((r) => setTimeout(r, 1500));
    const persisted = await roomsNow();
    ok("the placed regions are still there after a refresh",
      persisted.placed === before.withAt, `${persisted.placed} of ${before.withAt} after the reload`);
    await page.click("#planPlaceClear");
    await new Promise((r) => setTimeout(r, 1200));
    ok("and the drawing is left as it was found",
      (await roomsNow()).placed === 0, "placed regions cleared again");
  }

  // ---- A project saved before the parser kept positions ---------------------------
  // (the user's own report: 'No room to place: N are not named on the sheet')
  {
    const storedLacksPositions = await page.evaluate(() => {
      const h = window.webhvac;
      // make the table look like one saved by the older parser, then write it exactly as the app's
      // own saveNow() does (saveSoon is not exposed to scripts, so a probe cannot call it)
      for (const r of h.state.rooms) delete r.at;
      localStorage.setItem('webhvac.state.v1',
        JSON.stringify({ v: 1, project: h.state.project, rooms: h.state.rooms }));
      const raw = localStorage.getItem('webhvac.state.v1') || '';
      return !/"at"\s*:/.test(raw);
    });
    ok('an old saved project can be simulated (storage holds no positions)', storedLacksPositions,
      'so a reload restores a table with no positions at all');

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#roomsBody tr').length > 20,
      { timeout: 120000, polling: 500 });
    await new Promise((r) => setTimeout(r, 2000));

    const afterReload = await page.evaluate(() => ({
      rooms: window.webhvac.state.rooms.length,
      withAt: window.webhvac.state.rooms.filter((r) => r.at && Number.isFinite(r.at.x)).length,
    }));
    ok('the reload brings the old project back without positions', afterReload.withAt === 0,
      `${afterReload.rooms} rooms, ${afterReload.withAt} with a position`);

    const readLoad = () => page.evaluate(() => {
      const el = [...document.querySelectorAll('#summaryCards .scard')]
        .find((c) => /total cooling load/i.test(c.textContent));
      return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    });
    const loadBefore = await readLoad();
    await page.evaluate(() => document.getElementById('planCard').scrollIntoView({ block: 'center' }));
    await new Promise((r) => setTimeout(r, 400));
    await page.click('#planPlaceAll');
    await new Promise((r) => setTimeout(r, 4000));

    const healed = await page.evaluate(() => ({
      withAt: window.webhvac.state.rooms.filter((r) => r.at && Number.isFinite(r.at.x)).length,
      placed: window.webhvac.state.rooms.filter((r) => r.rect && r.rect.placed === true).length,
      boxes: document.querySelectorAll('.plan-room').length,
      msg: document.getElementById('statusBox').textContent.replace(/\s+/g, ' ').trim(),
      load: (() => {
        const el = [...document.querySelectorAll('#summaryCards .scard')]
          .find((c) => /total cooling load/i.test(c.textContent));
        return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
      })(),
    }));
    ok('the old project recovers its positions and places its rooms',
      healed.withAt > 0 && healed.placed === healed.withAt,
      `${healed.withAt} rooms recovered, ${healed.placed} placed, ${healed.boxes} boxes on this page`);
    ok('the app says it re-read the drawing', /re-?read|older version/i.test(healed.msg),
      healed.msg.slice(0, 96));
    ok('recovering positions does not change the load', healed.load === loadBefore,
      `${loadBefore || '(none)'} -> ${healed.load || '(none)'}`);

    // leave the project as it was found, so the checks after this one start clean
    await page.click('#planPlaceClear');
    await new Promise((r) => setTimeout(r, 1200));
  }

  // ---- A long space-type label must stay inside its own cell ----------------------
  {
    const vw = page.viewport() || { width: 1500, height: 1100 };
    await page.setViewport({ ...vw, width: 900 });
    await new Promise((r) => setTimeout(r, 600));
    const overhang = await page.evaluate(() => {
      let worst = -Infinity, widest = 0, label = '';
      for (const tr of document.querySelectorAll('#roomsBody tr')) {
        const td = tr.querySelector('td.c-type');
        if (!td) continue;
        const sel = td.querySelector('select');
        const t = td.getBoundingClientRect(), s = sel.getBoundingClientRect();
        worst = Math.max(worst, s.right - t.right);
        if (s.width > widest) { widest = s.width; label = sel.options[sel.selectedIndex].text; }
      }
      const cs = getComputedStyle(document.querySelector('td.c-type select'));
      return { worst: Math.round(worst), widest: Math.round(widest), label,
        appearance: cs.appearance, ellipsis: cs.textOverflow };
    });
    ok('a long space type stays inside its own cell in a narrow window', overhang.worst <= 0,
      `widest control ${overhang.widest}px, longest label "${overhang.label}", overhang ${overhang.worst}px`);
    ok('the space type is drawn by us so it can ellipsize instead of spilling',
      overhang.appearance === 'none' && overhang.ellipsis === 'ellipsis',
      `${overhang.appearance} / ${overhang.ellipsis}`);
    await page.setViewport(vw);
    await new Promise((r) => setTimeout(r, 400));
  }
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
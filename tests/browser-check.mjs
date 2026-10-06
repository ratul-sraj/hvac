// Real-browser check of a LoadLens deployment using the Edge already on this PC.
//   cd D:/webhvac && node tests/browser-check.mjs [url-of-the-calculator-page]
// Default = the local Express server's calculator page. Uses puppeteer-core (no download).
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const URL_ = process.argv[2] || "http://127.0.0.1:3000/app.html";
const BASE = new URL(".", URL_).href;   // directory the pages live in
// The sample button now loads the REAL, credited LEVEL 11 FLOOR PLAN by default, which prints no room
// areas — so its rooms come in with unknown areas and a different count. This suite's baselines (159
// rooms, 363.86 TR, the 3-page plan) belong to the SYNTHETIC fixture, which is loaded through the
// unadvertised ?sample=synthetic hook. Drive the fixture through that hook so the numbers stay exact.
const SYNTH = URL_ + (URL_.includes("?") ? "&" : "?") + "sample=synthetic";
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

// Long plan operations (a trace, a fill, placing every room) now YIELD to the browser instead of
// freezing the thread, so their controls are genuinely disabled while they run and a click aimed at
// one of them is dropped by the browser. A freshly opened plan also runs "place then trace" by
// itself, so a check must wait for THAT too before it drives a button. This changes no assertion —
// it only stops a check from clicking a disabled control or racing the automatic setup.
const waitIdle = () => page
  .waitForFunction(() => {
    const ui = window.webhvac && window.webhvac.state && window.webhvac.state.ui;
    return !!ui && !ui.traceBusy && !ui.autoSetupBusy;
  }, { timeout: 120000, polling: 250 })
  .catch(() => {});

// ---- deterministic location auto-detect ------------------------------------------------
// The app asks a free IP-geolocation service on a first visit (js/climates.js + autoDetectClimate
// in js/app.js). The checks below must not depend on where this machine happens to sit, and the
// 363.86 TR sample baseline assumes the default Kochi 35/28 conditions — so the geo endpoints are
// INTERCEPTED for the whole run. `geoResponse`/`geoFail` are re-set by the location checks further
// down; for the main run they answer "Kochi, Kerala, India", i.e. exactly the app's defaults, so
// the pre-fill changes nothing.
let geoResponse = { country: "India", region: "Kerala", city: "Kochi" };
let geoFail = false;
await page.setRequestInterception(true);
page.on("request", (req) => {
  const u = req.url();
  if (u.startsWith("https://ipwho.is/") || u.startsWith("https://ipapi.co/")) {
    if (geoFail) { req.abort("failed"); return; }
    req.respond({
      status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(geoResponse),
    });
    return;
  }
  req.continue();
});

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
  const resp = await page.goto(SYNTH, { waitUntil: "networkidle2", timeout: 60000 });
  ok("site loads", resp && resp.status() === 200, `HTTP ${resp && resp.status()} in ${SYNTH}`);
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

  // 3a-bis. the sticky totals bar (UX pass) mirrors the summary card exactly, and the quick-start
  //         strip's controls exist.
  {
    const barState = await page.evaluate(() => {
      const bar = document.getElementById("totalsBar");
      const trEl = document.getElementById("tbTr");
      const card = [...document.querySelectorAll("#summaryCards .scard")]
        .find((c) => /total cooling load/i.test(c.textContent));
      const cardTr = card ? (card.textContent.match(/([0-9.]+)\s*TR/) || [])[1] : null;
      const cs = bar ? getComputedStyle(bar) : null;
      return {
        exists: !!bar,
        visible: !!(bar && !bar.hasAttribute("hidden") && cs.display !== "none" && bar.getBoundingClientRect().height > 0),
        trText: trEl ? trEl.textContent.trim() : "",
        cardTr,
        air: (document.getElementById("tbAir") || {}).textContent || "",
        rooms: (document.getElementById("tbRooms") || {}).textContent || "",
        hasQs: !!document.getElementById("qsSample") && !!document.getElementById("qsHouse") && !!document.getElementById("qsUpload"),
      };
    });
    ok("the sticky totals bar is visible once rooms are loaded", barState.exists && barState.visible,
      `visible=${barState.visible}`);
    ok("the totals bar TR text matches the summary card",
      !!barState.cardTr && barState.trText === `${barState.cardTr} TR`,
      `bar "${barState.trText}" vs card "${barState.cardTr} TR"`);
    ok("the totals bar shows supply air and the included-room count",
      /(L\/s|CFM)/.test(barState.air) && /rooms included/.test(barState.rooms),
      `air "${barState.air}" | rooms "${barState.rooms}"`);
    ok("the quick-start strip controls exist (qsUpload / qsSample / qsHouse)", barState.hasQs,
      barState.hasQs ? "all present" : "one or more missing");
  }

  // 3b. the Results system (js/units.js): the toggle must change every unit-bearing surface, switching
  //     back must restore the SI figures exactly, and the sheet-unit detection line (js/unitdetect.js)
  //     must appear once a drawing has been parsed.
  {
    const unitState = () => page.evaluate(() => {
      const txt = (id) => { const e = document.getElementById(id); return e ? e.textContent.replace(/\s+/g, " ").trim() : null; };
      const cardOf = (re) => {
        const c = [...document.querySelectorAll("#summaryCards .scard")].find((x) => re.test(x.textContent));
        return c ? c.textContent.replace(/\s+/g, " ").trim() : "";
      };
      const det = document.getElementById("unitDetect");
      return {
        sys: window.webhvac.state.project.units,
        summary: document.getElementById("summaryCards").innerText.replace(/\s+/g, " ").trim(),
        heat: cardOf(/total heat/i), air: cardOf(/supply air/i),
        thTotal: txt("thTotal"), thLs: txt("thLs"), levelSupply: txt("levelThSupply"),
        detectVisible: !!(det && !det.classList.contains("hidden")),
        detect: det ? det.textContent.replace(/\s+/g, " ").trim() : "",
      };
    });
    const unitsJunk = () => page.evaluate(() =>
      ["NaN", "undefined", "Infinity"].filter((w) => new RegExp("\\b" + w + "\\b").test(document.body.innerText)));

    const beforeUnits = await unitState();
    ok("the sheet-unit detection line appears once the drawing is parsed",
      beforeUnits.detectVisible && beforeUnits.detect.length > 0 && !/\berror\b/i.test(beforeUnits.detect),
      beforeUnits.detect.slice(0, 140));

    await page.click("#proj-units-ip");
    await page.waitForFunction(() => window.webhvac.state.project.units === "ip", { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    const ipUnits = await unitState();
    ok("choosing Imperial (IP) changes the header and summary units to BTU/h, CFM, ft²",
      /BTU\/h/.test(ipUnits.thTotal || "") && /CFM/.test(ipUnits.thLs || "") && /CFM/.test(ipUnits.levelSupply || "")
        && /BTU\/h/.test(ipUnits.heat) && /CFM/.test(ipUnits.air),
      `${ipUnits.thTotal} | ${ipUnits.thLs} | ${ipUnits.heat} | ${ipUnits.air}`);
    ok("no NaN/undefined appears in imperial results", (await unitsJunk()).length === 0, (await unitsJunk()).join(", ") || "none");

    await page.click("#proj-units-si");
    await page.waitForFunction(() => window.webhvac.state.project.units === "si", { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    const backUnits = await unitState();
    ok("switching back to Metric restores the SI figures exactly",
      backUnits.sys === "si" && backUnits.summary === beforeUnits.summary && backUnits.thTotal === beforeUnits.thTotal,
      backUnits.summary === beforeUnits.summary ? "identical" : `MISMATCH (${backUnits.summary.slice(0, 80)})`);
  }

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

  // 4b. a blank numeric design-condition field must SHOW the default the engine is using (P3-6):
  //     the box used to go visibly empty while the maths silently used 35 °C.
  {
    await page.$eval("#proj-outDb", (e) => { e.value = ""; e.dispatchEvent(new Event("input", { bubbles: true })); });
    await new Promise((r) => setTimeout(r, 300));
    const blank = await page.evaluate(() => ({
      val: document.getElementById("proj-outDb").value,
      ph: document.getElementById("proj-outDb").placeholder,
      tr: (document.getElementById("summaryCards").innerText.replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/) || [])[1],
    }));
    ok("a blank design-condition field shows the default the engine will use",
      blank.val === "" && blank.ph === String(35) && Number(blank.tr) === tr,
      `placeholder "${blank.ph}", load ${blank.tr} TR (baseline ${tr})`);
    await page.$eval("#proj-outDb", (e) => { e.value = "35"; e.dispatchEvent(new Event("input", { bubbles: true })); });
    await new Promise((r) => setTimeout(r, 200));
  }

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

  // 5b. an impossible cell edit must surface the engine's warning AT ONCE (P2-2): typing -5 used to
  //     drop the load silently with no note until an unrelated re-render.
  await page.$eval(areaSel, (inp) => {
    inp.focus();
    inp.value = "-5";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 250));
  const negWarn = await page.evaluate(() => {
    const box = document.getElementById("warnBox");
    const list = document.getElementById("warnList");
    return { hidden: !box || box.classList.contains("hidden"),
      // textContent, not innerText: the notes live inside a COLLAPSED <details>, so innerText is "".
      text: list ? list.textContent.replace(/\s+/g, " ").trim() : "" };
  });
  const negTotal = await page.$eval("#summaryCards", (e) => {
    const m = e.innerText.replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/);
    return m ? parseFloat(m[1]) : NaN;
  });
  ok("an impossible cell edit warns immediately, without another interaction",
    !negWarn.hidden && /negative/i.test(negWarn.text) && /area/i.test(negWarn.text),
    `hidden ${negWarn.hidden}: "${negWarn.text.slice(0, 110)}"`);
  ok("a negative area is clamped (the load drops) and the note explains it",
    Number.isFinite(negTotal) && negTotal < before, `${before} -> ${negTotal} TR`);
  await page.$eval(areaSel, (inp) => {          // put the row back exactly as the edit left it
    inp.focus();
    inp.value = "200";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 250));
  const backTotal = await page.$eval("#summaryCards", (e) => {
    const m = e.innerText.replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/);
    return m ? parseFloat(m[1]) : NaN;
  });
  ok("restoring the area puts the load back", Math.abs(backTotal - afterEdit) < 0.05,
    `${afterEdit} -> ${backTotal} TR`);

  // 6. filter + sort + include toggle
  await page.type("#filterName", "MEETING");
  await new Promise((r) => setTimeout(r, 300));
  const filtered = await page.$$eval("#roomsBody tr", (r) => r.length);
  ok("name filter narrows the table", filtered > 0 && filtered < roomRows, `${roomRows} -> ${filtered} rows`);
  await page.$eval("#filterName", (e) => { e.value = ""; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 200));
  // The filter must search the label the user can SEE, not only the name: the space type is shown in
  // its own column, so "conference" must find the rooms named "CONF. RM." whose type is Conference/Meeting.
  await page.type("#filterName", "conference");
  await new Promise((r) => setTimeout(r, 300));
  const byType = await page.$$eval("#roomsBody tr", (r) => r.length);
  ok("the name filter also matches the visible space-type label", byType > 0 && byType < roomRows,
    `"conference" -> ${byType} of ${roomRows} rows`);
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

  // 7b. product-led distribution, honestly: the export carries the tool's own address exactly once,
  //     on its own '#' comment line at the very end — never inside a room row — so a parser that reads
  //     the data rows starts and ends exactly as before.
  {
    const attr = "Calculated with LoadLens - loadlens.net";
    const attrLines = csvLines.filter((l) => l.includes(attr));
    const lastNonEmpty = [...csvLines].reverse().find((l) => l.trim() !== "") || "";
    const roomLines = csvLines.filter((l) => /^(yes|no),/.test(l));
    ok("the CSV carries the LoadLens credit exactly once, on its own final comment line",
      attrLines.length === 1 && attrLines[0].startsWith("#") && lastNonEmpty.includes(attr),
      `last line: "${lastNonEmpty.slice(0, 130)}"`);
    ok("the LoadLens credit never appears inside a room row",
      roomLines.length > 100 && roomLines.every((l) => !l.includes(attr)),
      `${roomLines.length} room rows checked`);
    // the room rows must still parse: same count, and the same TR total as the app shows on screen
    const parseRow = (line) => {
      const out = []; let cur = ""; let q = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (q) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
          else if (ch === '"') q = false;
          else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === ",") { out.push(cur); cur = ""; }
        else cur += ch;
      }
      out.push(cur);
      return out;
    };
    const rowsParsed = roomLines.map(parseRow);
    const includedTr = rowsParsed.filter((f) => f[0] === "yes").reduce((a, f) => a + (parseFloat(f[19]) || 0), 0);
    const screenTr = await page.$eval("#summaryCards", (e) => {
      const m = e.innerText.replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/);
      return m ? parseFloat(m[1]) : NaN;
    });
    ok("the CSV room rows still parse to the same count and the same TR total as the app",
      rowsParsed.length === roomLines.length && rowsParsed.every((f) => f.length === 24) &&
        Number.isFinite(screenTr) && Math.abs(includedTr - screenTr) < 1.0,
      `${rowsParsed.length} rows x 24 cols, CSV ${includedTr.toFixed(2)} TR vs screen ${screenTr} TR`);
  }

  // 7c. supply dT = 0 must show "-" on screen and in the CSV / report, never Infinity (P2-3).
  {
    const readSupply = () => page.evaluate(() => {
      const cell = document.querySelector("#roomsBody tr .v-ls");
      const card = [...document.querySelectorAll("#summaryCards .scard")].find((c) => /supply air/i.test(c.textContent));
      return { cell: cell ? cell.textContent.trim() : null,
        card: card ? card.textContent.replace(/\s+/g, " ").trim() : null };
    });
    await page.$eval("#proj-supplyDt", (e) => { e.value = "0"; e.dispatchEvent(new Event("input", { bubbles: true })); });
    await new Promise((r) => setTimeout(r, 400));
    const zero = await readSupply();
    ok("a zero supply dT shows '-' on screen, not Infinity and not a blank",
      zero.cell === "-" && /(^|\s)-\s*L\/s/.test(zero.card || "") && !/Infinity/.test((zero.cell || "") + (zero.card || "")),
      `cell "${zero.cell}", card "${zero.card}"`);
    const zeroWarn = await page.evaluate(() => (document.getElementById("warnList") || {}).textContent || "");
    ok("a zero supply dT carries a warning", /supply air/i.test(zeroWarn), zeroWarn.replace(/\s+/g, " ").slice(0, 110));

    await page.evaluate(() => { window.__csv = null; });
    await page.click("#btnCsv");
    await page.waitForFunction(() => window.__csv !== null, { timeout: 20000 }).catch(() => {});
    const csvZero = await page.evaluate(() => window.__csv);
    // quote-aware split, because a room name/type can contain a comma
    const parsedZ = (csvZero || "").split(/\r?\n/).filter((l) => /^yes,/.test(l)).map((line) => {
      const out = []; let cur = ""; let q = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (q) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
          else if (ch === '"') q = false;
          else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === ",") { out.push(cur); cur = ""; }
        else cur += ch;
      }
      out.push(cur);
      return out;
    });
    ok("the CSV never contains Infinity and its supply column shows '-'",
      !/Infinity/.test(csvZero || "") && parsedZ.length > 0 && parsedZ.every((f) => f[20] === "-"),
      `${parsedZ.length} rows, first "${(csvZero || "").split(/\r?\n/).find((l) => /^yes,/.test(l)) || ""}".slice(0, 120)`);

    const reportZero = await page.evaluate(() => {
      const h = window.webhvac;
      const html = h.buildReportHtml(h.state.project, h.currentCalc());
      return { inf: /Infinity/.test(html), nan: /NaN/.test(html), dashes: (html.match(/>-</g) || []).length };
    });
    ok("the report carries no Infinity/NaN and shows '-' for the uncomputable supply flow",
      !reportZero.inf && !reportZero.nan && reportZero.dashes > 0, JSON.stringify(reportZero));

    await page.$eval("#proj-supplyDt", (e) => { e.value = "11"; e.dispatchEvent(new Event("input", { bubbles: true })); });
    await new Promise((r) => setTimeout(r, 300));
    const back = await readSupply();
    ok("restoring the supply dT brings the L/s figures back", /[0-9]/.test(back.cell || ""),
      `cell "${back.cell}"`);
  }

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

    // 8b. the report's own credit: one quiet line, exactly once, at the foot of the sheet — and the
    //     report's total must be exactly the app's total, so the footer changes nothing in the maths.
    const repAttr = "Calculated with LoadLens - loadlens.net";
    const repAttrCount = (report.text.match(/Calculated with LoadLens - loadlens\.net/g) || []).length;
    ok("the report carries the LoadLens credit exactly once, in plain honest words",
      repAttrCount === 1 && /free, runs in your browser, your drawing is never (uploaded|sent to a third party)/.test(report.text),
      `${repAttrCount} occurrence(s)`);
    const repTr = (report.text.match(/Total cooling load ([0-9.]+) TR/) || [])[1];
    const screenTrRep = await page.$eval("#summaryCards", (e) => {
      const m = e.innerText.replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/);
      return m ? parseFloat(m[1]) : NaN;
    });
    ok("the report's total is unchanged by the credit and equals the app's total",
      Number.isFinite(screenTrRep) && Number(repTr) === screenTrRep,
      `report ${repTr} TR vs screen ${screenTrRep} TR`);
    ok("the credit sits at the foot of the report, after the signature block",
      report.text.indexOf(repAttr) > report.text.indexOf("Prepared by"),
      `credit at ${report.text.indexOf(repAttr)}, signature at ${report.text.indexOf("Prepared by")}`);
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

  // 8c. the share control: one small, plain-words button that copies the tool's own address. The
  //     clipboard write is stubbed so the check is deterministic and touches no real clipboard; the
  //     confirmation must arrive on the normal status line (no pop-up), exactly like every other action.
  {
    const shared = await page.evaluate(async () => {
      let copied = null;
      let orig = null;
      try { orig = navigator.clipboard; } catch (e) {}
      const stub = { writeText: (t) => { copied = t; return Promise.resolve(); } };
      try { Object.defineProperty(navigator, "clipboard", { value: stub, configurable: true }); }
      catch (e) { try { navigator.clipboard = stub; } catch (e2) {} }
      const btn = document.getElementById("btnShare");
      const label = btn ? btn.textContent.trim() : null;
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 80));
      const box = document.getElementById("statusBox");
      const out = { exists: !!btn, label, copied,
        status: box ? box.textContent : "", cls: box ? box.className : "" };
      try { Object.defineProperty(navigator, "clipboard", { value: orig, configurable: true }); }
      catch (e) {}
      return out;
    });
    ok("one small 'copy the link' control exists, in plain words",
      shared.exists && /copy link to loadlens/i.test(shared.label || ""), `label "${shared.label}"`);
    ok("the control copies https://loadlens.net/ to the clipboard",
      shared.copied === "https://loadlens.net/", `copied "${shared.copied}"`);
    ok("the copy is confirmed on the normal status line, not a pop-up",
      /\bcopied\b/i.test(shared.status) && /\bok\b/.test(shared.cls), `"${(shared.status || "").slice(0, 100)}"`);
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

  // 10b. the mobile menu button must be VISIBLE: dark bars/text on a light pill, not the old
  //      white-on-translucent-white that the light app header rendered as a blank square.
  {
    const burger = await page.evaluate(() => {
      const b = document.querySelector(".nav-burger");
      if (!b) return null;
      const cs = getComputedStyle(b);
      const bars = b.querySelector(".nav-burger-bars span");
      return {
        display: cs.display,
        color: cs.color,
        bg: cs.backgroundColor,
        border: cs.borderTopColor,
        barsColor: bars ? getComputedStyle(bars).backgroundColor : null,
        width: b.getBoundingClientRect().width,
      };
    });
    const isWhite = (c) => /rgba?\(\s*255,\s*255,\s*255/.test(c || "");
    const isLight = (c) => {
      const m = (c || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return false;
      return (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 > 200;
    };
    ok("the mobile menu button is visible at 390px (dark on a light pill, with a border)",
      !!burger && burger.display !== "none" && burger.width > 10 && !isWhite(burger.color) && isLight(burger.bg) && !isWhite(burger.border),
      burger ? `color ${burger.color} on ${burger.bg}, border ${burger.border}, width ${burger.width}` : "no .nav-burger");
  }
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
    await page.goto(SYNTH, { waitUntil: "load", timeout: 90000 });
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

  // 13b. ONE drawing tool, TWO gestures. The redundant 'Draw room' mode is retired: Draw shape is
  //      now the only drawing mode and understands a DRAG (a rectangle, exactly what Draw room did)
  //      as well as a CLICK (a polygon corner). The shipped markup is read straight from disk, so
  //      this does not depend on whatever mode a previous run left saved in this browser.
  {
    const appHtml = fs.readFileSync("app.html", "utf8");
    ok("the retired 'Draw room' mode is gone from app.html",
      !/id="planModeDraw"/.test(appHtml) && !/name="planMode"[^>]*value="draw"/.test(appHtml),
      /id="planModeDraw"/.test(appHtml) ? "planModeDraw still present" : "no Draw room control");
    ok("app.html ships Draw shape as the checked mode, with Select / edit beside it",
      /id="planModeShape"[^>]*\bchecked\b/.test(appHtml)
        && /id="planModeSelect"/.test(appHtml) && !/id="planModeSelect"[^>]*\bchecked\b/.test(appHtml),
      "shape checked by default");
    await page.click("#planModeShape");
    await new Promise((r) => setTimeout(r, 200));
    const liveModes = await page.evaluate(() => ({
      radios: document.querySelectorAll('input[name="planMode"]').length,
      draw: !!document.getElementById("planModeDraw"),
      shape: document.getElementById("planModeShape").checked,
      select: document.getElementById("planModeSelect").checked,
      mode: window.webhvac.state.ui.planMode,
    }));
    ok("the live panel offers only Draw shape and Select / edit",
      liveModes.radios === 2 && !liveModes.draw && liveModes.shape && !liveModes.select
        && liveModes.mode === "shape",
      JSON.stringify(liveModes));
  }

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
  // The sheet now already carries the rooms the automatic setup placed and traced, so this check must
  // measure the room the drag just made — found by its row id — not every shape on the page.
  const drawnRowId = await page.$eval("#roomsBody tr:last-child", (tr) => tr.getAttribute("data-id"));
  const planShapes = await page.$$eval(`.plan-room[data-room-id="${drawnRowId}"]`, (n) => n.length);
  ok("the overlay draws a box for the new room", planShapes === 1, `${planShapes} box(es) for ${drawnRowId}`);
  const planLabel = await page.$eval(`.plan-room[data-room-id="${drawnRowId}"] .plan-room-label`, (e) => e.textContent).catch(() => "");
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
  await page.click("#planModeShape");

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
      if (n && /Drawn room/.test(n.value)) out.push({ id: tr.getAttribute("data-id"), name: n.value, area: a ? Number(a.value) : null });
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
  const landed = await page.evaluate(([rid]) => {
    const g = document.querySelector(`.plan-room[data-room-id="${rid}"]`);
    const last = g ? g.querySelector(".plan-room-box") : null;
    if (!last || !g.getBoundingClientRect) return null;
    const sr = document.querySelector(".plan-overlay").getBoundingClientRect();
    // the box is a <polygon> for a ring or a <rect> for a rect; read x/y either way
    const x = Number(last.getAttribute("x"));
    const y = Number(last.getAttribute("y"));
    return { x: sr.x + x, y: sr.y + y };
  }, [newest && newest.id]);
  const miss = landed ? { x: Math.round(landed.x - qx), y: Math.round(landed.y - qy) } : null;
  ok("the room lands under the cursor, not somewhere else on the sheet",
      !!miss && Math.abs(miss.x) <= 12 && Math.abs(miss.y) <= 12,
      miss ? `off by ${miss.x},${miss.y} px from the drag start (room ${newest && newest.id})` : "no box found");

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

  // 15b. 'Draw shape' — a room with ANY number of edges, drawn by clicking its corners. The shape's
  //      own shoelace area (through the same points->m2 conversion the placed rectangles use) drives
  //      the room, and a closed shape can be GIVEN to an existing table row. All three gestures are
  //      exercised on the live page: close by first corner / Enter, Esc mid-draw, self-crossing
  //      refusal, vertex move, edge-midpoint insert, Alt-drop remove, assign, dismiss, reload.
  {
    const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
    const rowCount = () => page.$$eval("#roomsBody tr", (r) => r.length);
    const readTotalTr2 = () => page.$eval("#summaryCards", (e) => {
      const m = e.innerText.replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/);
      return m ? parseFloat(m[1]) : NaN;
    });
    const m2PerPt2 = areaOf(1, 1, 100);          // m² one square PDF point covers at 1:100
    const shoelaceArea = (pts, scale) => {       // view px ring -> m² through the same scale
      let s = 0;
      for (let i = 0; i < pts.length; i += 1) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        s += a[0] * b[1] - b[0] * a[1];
      }
      return (Math.abs(s) / 2) / (scale * scale) * m2PerPt2;
    };
    /** The newest hand-drawn polygon room: its stored ring, the area cell, and its RENDERED ring in
     *  view pixels (the shape the user actually sees, so the shoelace check needs no click offsets). */
    const newestShape = () => page.evaluate(() => {
      const rooms = window.webhvac.state.rooms.filter((r) => r.source === "drawn" && Array.isArray(r.poly));
      const r = rooms[rooms.length - 1];
      if (!r) return null;
      // the room's OWN group, by id — the overlay draws biggest-first, so DOM order is not room order
      const g = document.querySelector(`.plan-room[data-room-id="${r.id}"]`);
      const pts = g ? g.querySelector(".plan-room-box").getAttribute("points").trim()
        .split(/\s+/).map((s) => s.split(",").map(Number)) : null;
      const svg = document.querySelector(".plan-overlay");
      const sr = svg ? svg.getBoundingClientRect() : null;
      const cell = document.querySelector(`tr[data-id="${r.id}"] input[data-field="area"]`);
      return {
        id: r.id, name: r.name, area: r.area, polyLen: r.poly.length,
        page: r.polyPage, cell: cell ? Number(cell.value) : null,
        pts, origin: sr ? { x: sr.x, y: sr.y } : null,
      };
    });
    /** A polygon is concave when the cross product of consecutive edges changes sign. */
    const isConcave = (pts) => {
      const signs = [];
      for (let i = 0; i < pts.length; i += 1) {
        const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
        const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (Math.abs(cr) > 1e-6) signs.push(cr > 0 ? 1 : -1);
      }
      return signs.some((s) => s !== signs[0]);
    };
    // the EXACT viewport scale (the % readout is rounded to a whole percent, which is up to ~1% of
    // area — too coarse for a 0.5% check)
    const scaleNow = () => page.evaluate(() => {
      const v = window.webhvac.plan && window.webhvac.plan.viewer;
      return v && typeof v.getScale === "function" ? v.getScale() : 1;
    });

    // ---- (a) an OLD saved project (a room with a rect but no drawn shape) must open untouched
    const storageBefore = await page.evaluate(() => localStorage.getItem("webhvac.state.v1"));
    await page.evaluate(() => {
      const h = window.webhvac;
      localStorage.setItem("webhvac.state.v1", JSON.stringify({
        v: 1, project: h.state.project,
        rooms: [{ id: "old1", name: "Old room", level: "L1", area: 25, height: 3, include: true,
          source: "label", rect: { page: 1, x: 50, y: 50, w: 60, h: 60 } }],
      }));
    });
    await page.reload({ waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length === 1,
      { timeout: 60000, polling: 300 });
    const oldProject = await page.evaluate(() => {
      const r = window.webhvac.state.rooms[0] || {};
      const a = document.querySelector('#roomsBody tr input[data-field="area"]');
      return { name: r.name, area: r.area, hasPoly: Array.isArray(r.poly), cell: a ? Number(a.value) : null };
    });
    ok("a saved project from an older version (no drawn shapes) opens untouched",
      oldProject.name === "Old room" && oldProject.area === 25 && oldProject.hasPoly === false,
      JSON.stringify(oldProject));
    // put the real work back
    await page.evaluate((s) => { if (s) localStorage.setItem("webhvac.state.v1", s); }, storageBefore);
    await page.reload({ waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100,
      { timeout: 120000, polling: 400 });
    await page.evaluate(() => {
      const v = document.getElementById("planView");
      v.scrollLeft = 0; v.scrollTop = 0;
      v.scrollIntoView({ block: "center" });
    });
    await page.waitForFunction(() => { const c = document.getElementById("planCanvas"); return c && c.width > 400; },
      { timeout: 60000, polling: 400 });
    await sleep2(500);

    // a 20 m² manual room to assign a shape to. #btnManual opens that room's breakdown, which scrolls
    // the PAGE down to it — so the plan panel must be brought back into view AFTER this click.
    const manualRoom = () => page.evaluate(() => {
      const r = window.webhvac.state.rooms.find((x) => x.source === "manual" && x.name === "New Room");
      return r ? r.id : null;
    });
    // Scroll the button to the middle first and let the (asynchronously rendered) geo chip settle: a
    // geometry click that starts while the layout is still moving can land on nothing.
    await page.evaluate(() => document.getElementById("btnManual").scrollIntoView({ block: "center" }));
    await sleep2(500);
    await page.click("#btnManual");
    await sleep2(500);
    let manualId = await manualRoom();
    if (!manualId) {
      await page.evaluate(() => document.getElementById("btnManual").click());   // deterministic fallback
      await sleep2(600);
      manualId = await manualRoom();
    }
    ok("there is a manual 20 m² room to give a shape to", !!manualId, String(manualId));

    // the mouse coordinates are viewport-relative: the plan MUST be on screen or a click delivers no
    // pointer event at all (that mistake looks exactly like a broken feature).
    await page.evaluate(() => {
      const v = document.getElementById("planView");
      v.scrollLeft = 0; v.scrollTop = 0;
      v.scrollIntoView({ block: "center" });
    });
    await sleep2(600);
    const viewBox2 = await page.$eval("#planView", (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, onScreen: r.top > 0 && r.bottom < window.innerHeight };
    });
    ok("the plan panel is on screen before the shape is drawn", viewBox2.onScreen,
      `panel at ${Math.round(viewBox2.x)},${Math.round(viewBox2.y)} (${Math.round(viewBox2.w)}x${Math.round(viewBox2.h)})`);
    // every shape point is given as a FRACTION of the visible panel, so a shape can never be clicked
    // outside the scroll box (a click there delivers no pointer event at all). The panel's position is
    // re-read on EVERY click: a status line or the chooser appearing above the drawing moves it.
    const panelBox = async () => {
      const read = () => page.$eval("#planView", (e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height,
          onScreen: r.top >= 0 && r.bottom <= window.innerHeight };
      });
      let b = await read();
      if (!b.onScreen) {   // a status line or a save can scroll the page out from under the clicks
        await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
        await sleep2(450);
        b = await read();
      }
      return b;
    };
    const clickAt = async (fx, fy) => {
      const b = await panelBox();
      await page.mouse.click(b.x + fx * b.w, b.y + fy * b.h);
      await sleep2(110);
    };
    const atF = async (fx, fy) => {
      const b = await panelBox();
      return { x: b.x + fx * b.w, y: b.y + fy * b.h };
    };

    // ---- (b0) the merged tool: a DRAG draws a rectangle, a CLICK adds a corner, and a saved
    //           'draw' mode migrates silently to 'shape'. Runs before the polygon checks so the row
    //           count they capture already includes the rectangle drawn here.
    {
      // (i) migration: a project saved carrying the retired 'draw' mode must open on Draw shape
      await page.evaluate(() => {
        const h = window.webhvac;
        localStorage.setItem("webhvac.state.v1", JSON.stringify({
          v: 1, project: h.state.project, rooms: h.state.rooms, ui: { planMode: "draw" },
        }));
      });
      await page.reload({ waitUntil: "load", timeout: 90000 });
      await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100,
        { timeout: 120000, polling: 400 });
      await page.waitForFunction(() => { const c = document.getElementById("planCanvas"); return c && c.width > 400; },
        { timeout: 60000, polling: 400 }).catch(() => {});
      await sleep2(800);
      const migrated = await page.evaluate(() => ({
        mode: window.webhvac.state.ui.planMode,
        shape: document.getElementById("planModeShape").checked,
        select: document.getElementById("planModeSelect").checked,
        draw: !!document.getElementById("planModeDraw"),
      }));
      ok("a saved plan mode of 'draw' loads silently as Draw shape",
        migrated.mode === "shape" && migrated.shape && !migrated.select && !migrated.draw,
        JSON.stringify(migrated));

      // (ii) a load with NO stored mode still opens on Draw shape — the shipped default
      await page.evaluate(() => {
        const h = window.webhvac;
        localStorage.setItem("webhvac.state.v1",
          JSON.stringify({ v: 1, project: h.state.project, rooms: h.state.rooms }));
      });
      await page.reload({ waitUntil: "load", timeout: 90000 });
      await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100,
        { timeout: 120000, polling: 400 });
      await page.waitForFunction(() => { const c = document.getElementById("planCanvas"); return c && c.width > 400; },
        { timeout: 60000, polling: 400 }).catch(() => {});
      await sleep2(800);
      const fresh = await page.evaluate(() => ({
        mode: window.webhvac.state.ui.planMode,
        shape: document.getElementById("planModeShape").checked,
      }));
      ok("with no stored mode, a fresh load opens on Draw shape (the default)",
        fresh.mode === "shape" && fresh.shape, JSON.stringify(fresh));

      // SETUP for the drawing checks below: the automatic place-and-trace has left rooms on this
      // sheet. A shape-mode click that lands INSIDE an existing room selects it and starts no shape (by
      // design — overlay.js), so the fixed click points below would hit those rooms. Clear every room's
      // geometry so these checks exercise the drawing tool against genuinely empty paper, exactly as
      // they did before the automatic setup existed. (Nothing here weakens an assertion: the geometry
      // is SETUP, and the checks still run against the real code.)
      await page.evaluate(() => {
        for (const r of window.webhvac.state.rooms) {
          delete r.poly; delete r.polyPage; delete r.polyDrawing; delete r.polyArea; delete r.polyRatio;
          delete r.rect; delete r.rectDrawing;
        }
        window.webhvac.renderAll();
      });
      await sleep2(300);

      // (iii) a DRAG in Draw shape → a rectangle room, area as the table shows it
      await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
      await sleep2(500);
      const rowsBeforeRect = await rowCount();
      const scaleRect = await scaleNow();
      const denomRect = Number(await page.$eval("#planScale", (e) => e.value)) || 100;
      const bR = await panelBox();
      const sxR = bR.x + 0.06 * bR.w, syR = bR.y + 0.62 * bR.h;
      const wR = 0.22 * bR.w, hR = 0.22 * bR.h;
      await page.mouse.move(sxR, syR);
      await page.mouse.down();
      await page.mouse.move(sxR + wR / 2, syR + hR / 2, { steps: 5 });
      const rubber = await page.$$eval(".plan-draft-box", (n) => n.length);
      await page.mouse.move(sxR + wR, syR + hR, { steps: 8 });
      await page.mouse.up();
      await sleep2(900);
      const rowsAfterRect = await rowCount();
      const rectRoom = await page.evaluate(() => {
        const rooms = window.webhvac.state.rooms.filter((r) => r.source === "manual" && r.rect
          && r.rect.placed !== true && !Array.isArray(r.poly));
        const r = rooms[rooms.length - 1];
        if (!r) return null;
        const g = document.querySelector(`.plan-room[data-room-id="${r.id}"]`);
        const cell = document.querySelector(`tr[data-id="${r.id}"] input[data-field="area"]`);
        return { id: r.id, name: r.name, area: r.area, hasPoly: Array.isArray(r.poly),
          shape: g ? g.getAttribute("data-shape") : null, cell: cell ? Number(cell.value) : null };
      });
      const expectRect = areaOf(wR / scaleRect, hR / scaleRect, denomRect);
      ok("a DRAG in Draw shape draws a rectangle room in one gesture",
        rowsAfterRect === rowsBeforeRect + 1 && !!rectRoom && rectRoom.hasPoly === false
          && rectRoom.shape === "rect",
        `${rowsBeforeRect} -> ${rowsAfterRect} rows, ${rectRoom && rectRoom.name}, data-shape ${rectRoom && rectRoom.shape}`);
      ok("the rectangle's area is what the room table shows for it (at the drawing scale)",
        !!rectRoom && Math.abs(rectRoom.cell - expectRect) <= Math.max(1, expectRect * 0.05)
          && Math.abs(rectRoom.area - rectRoom.cell) <= 0.01,
        rectRoom ? `table ${rectRoom.cell} m² vs geometry ${expectRect.toFixed(2)} m²` : "no room");
      ok("a live rubber band is shown while the rectangle is dragged", rubber === 1, `${rubber} preview box(es)`);
      ok("the drag leaves no stray polygon corner behind",
        (await page.$$eval(".plan-vertex", (n) => n.length)) === 0);

      // (iv) that rectangle is editable afterwards, by its corner handles in Select / edit
      if (rectRoom) {
        await page.click("#planModeSelect");
        await sleep2(250);
        const rbox = await page.evaluate((rid) => {
          const g = document.querySelector(`.plan-room[data-room-id="${rid}"]`);
          const b2 = g ? g.querySelector(".plan-room-box") : null;
          if (!b2) return null;
          const rr = b2.getBoundingClientRect();
          return { cx: rr.x + rr.width / 2, cy: rr.y + rr.height / 2, w: rr.width, h: rr.height };
        }, rectRoom.id);
        await page.mouse.click(rbox.cx, rbox.cy);
        await sleep2(400);
        const handlesNow = await page.$$eval(".plan-room-handle", (n) => n.length);
        const areaBeforeResize = await page.$eval(`tr[data-id="${rectRoom.id}"] input[data-field="area"]`,
          (i) => Number(i.value));
        await page.mouse.move(rbox.cx + rbox.w / 2, rbox.cy + rbox.h / 2);
        await page.mouse.down();
        await page.mouse.move(rbox.cx + rbox.w / 2 + 120, rbox.cy + rbox.h / 2 + 90, { steps: 8 });
        await page.mouse.up();
        await sleep2(700);
        const areaAfterResize = await page.$eval(`tr[data-id="${rectRoom.id}"] input[data-field="area"]`,
          (i) => Number(i.value));
        ok("a rectangle drawn by dragging is editable by its handles afterwards",
          handlesNow === 4 && areaAfterResize > areaBeforeResize,
          `${handlesNow} handle(s), area ${areaBeforeResize} -> ${areaAfterResize} m²`);
      } else {
        ok("a rectangle drawn by dragging is editable by its handles afterwards", false, "no rectangle room");
      }

      // (v) a plain CLICK still adds a polygon corner (and finishes nothing)
      await page.click("#planModeShape");
      await sleep2(250);
      const rowsBeforeClicks = await rowCount();
      for (const [x, y] of [[0.34, 0.16], [0.46, 0.16], [0.46, 0.28]]) await clickAt(x, y);
      const clicking = await page.evaluate(() => ({
        vertices: document.querySelectorAll(".plan-vertex").length,
        readout: document.querySelector(".plan-overlay-readout[data-vertices]")
          ? document.querySelector(".plan-overlay-readout[data-vertices]").getAttribute("data-vertices") : null,
      }));
      ok("a plain click starts a polygon (three clicks = three corners, nothing finished)",
        clicking.vertices === 3 && clicking.readout === "3" && (await rowCount()) === rowsBeforeClicks,
        `${clicking.vertices} corner(s), readout ${clicking.readout}, rows ${rowsBeforeClicks} -> ${await rowCount()}`);
      await page.keyboard.press("Escape");
      await sleep2(300);

      // (vi) a click that drifts a few pixels is still a click, never a degenerate rectangle
      const rowsBeforeDrift = await rowCount();
      const dp = await atF(0.70, 0.16);
      await page.mouse.move(dp.x, dp.y);
      await page.mouse.down();
      await page.mouse.move(dp.x + 3, dp.y + 3, { steps: 1 });
      await page.mouse.up();
      await sleep2(300);
      const drift = await page.evaluate(() => ({
        vertices: document.querySelectorAll(".plan-vertex").length,
      }));
      ok("a 3 px drift counts as a click (a corner), not a degenerate rectangle",
        drift.vertices === 1 && (await rowCount()) === rowsBeforeDrift,
        `${drift.vertices} corner(s), rows ${rowsBeforeDrift} -> ${await rowCount()}`);
      await page.keyboard.press("Escape");
      await sleep2(300);
    }

    // ---- (b) draw a 6-corner CONCAVE shape, close it on the first corner, keep it as a new room
    const rowsBeforeShape = await rowCount();
    await page.click("#planModeShape");
    await sleep2(250);
    const L = [[0.08, 0.16], [0.22, 0.16], [0.22, 0.28], [0.15, 0.28], [0.15, 0.40], [0.08, 0.40]];
    for (const [x, y] of L) await clickAt(x, y);
    const cornersWhileDrawing = await page.$$eval(".plan-vertex", (n) => n.length);
    const readout = await page.$eval(".plan-overlay-readout", (e) => e.getAttribute("data-vertices")).catch(() => null);
    await clickAt(L[0][0], L[0][1]);                       // click the first corner: closes the shape
    await sleep2(400);
    const chooserUp = await page.evaluate(() => {
      const box = document.getElementById("planShapeAssign");
      const sel = document.getElementById("planShapeAssignRoom");
      return { open: !box.classList.contains("hidden"), value: sel ? sel.value : null,
        first: sel && sel.options[0] ? sel.options[0].text : null, options: sel ? sel.options.length : 0 };
    });
    ok("six clicks draw a six-corner shape, with a live corner count",
      cornersWhileDrawing === 6 && readout === "6", `${cornersWhileDrawing} corner(s), readout ${readout}`);
    ok("closing the shape opens the chooser with (new room) preselected",
      chooserUp.open && chooserUp.value === "" && /new room/i.test(String(chooserUp.first)),
      JSON.stringify(chooserUp));
    // The chooser must name a row by the ROOM NUMBER the sheet prints, not only its name: the office
    // sample carries four rows called MEETING ROOM, so the name alone cannot tell them apart.
    const chooserNos = await page.evaluate(() => {
      const sel = document.getElementById("planShapeAssignRoom");
      const nums = [...document.querySelectorAll('#roomsBody input[data-field="number"]')]
        .map((i) => (i.value || "").trim()).filter(Boolean);
      const opts = [...sel.options].slice(1).map((o) => o.text);
      return { numbered: nums.length, opts: opts.slice(0, 3),
        withNo: opts.filter((t) => nums.some((n) => t.startsWith(n + " \u00b7 "))).length };
    });
    ok("the chooser names each row by its room number, so rows sharing a name are told apart",
      chooserNos.numbered > 0 && chooserNos.withNo > 0, JSON.stringify(chooserNos));
    // The pickers list rooms ALPHABETICALLY (name, then number, then level) via one shared helper, so a
    // long table is not a hunt through sheet order. Compare each option's room by its normalized key.
    const chooserOrder = await page.evaluate(() => {
      const sel = document.getElementById("planShapeAssignRoom");
      const rooms = window.webhvac.state.rooms;
      const keyOf = (id) => {
        const r = rooms.find((x) => String(x.id) === String(id));
        if (!r) return null;
        const n = window.webhvac.normalizeRoom(r, window.webhvac.state.project);
        return { name: String(n.name || ""), number: String(n.number == null ? "" : n.number), level: String(n.level || "") };
      };
      const items = [...sel.options].slice(1).map((o) => keyOf(o.value)).filter(Boolean);
      const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
      let asc = true;
      for (let k = 1; k < items.length; k += 1) {
        const a = items[k - 1], b = items[k];
        const c = cmp(a.name, b.name) || cmp(a.number, b.number) || cmp(a.level, b.level);
        if (c > 0) { asc = false; break; }
      }
      return { count: items.length, asc, first: items[0] && items[0].name,
        last: items.length ? items[items.length - 1].name : null };
    });
    ok("the chooser lists the room rows alphabetically by name, not in sheet order",
      chooserOrder.asc && chooserOrder.count > 10,
      `${chooserOrder.count} option(s), "${chooserOrder.first}" .. "${chooserOrder.last}", ascending ${chooserOrder.asc}`);
    await page.click("#planShapeAssignGo");                // "(new room)" is selected: make a new room
    await sleep2(700);
    const shape1 = await newestShape();
    const scale1 = await scaleNow();
    ok("the shape becomes a new room with its own number of edges",
      (await rowCount()) === rowsBeforeShape + 1 && !!shape1 && shape1.polyLen === 6,
      `${rowsBeforeShape} -> ${await rowCount()} rows, ${shape1 && shape1.polyLen} edge(s)`);
    ok("the hand-drawn room's area IS the shape's shoelace area (within 0.5%)",
      !!shape1 && Math.abs(shape1.cell - shoelaceArea(shape1.pts, scale1)) <= shoelaceArea(shape1.pts, scale1) * 0.005,
      shape1 ? `table ${shape1.cell} m² vs shoelace ${shoelaceArea(shape1.pts, scale1).toFixed(3)} m²` : "no shape");
    ok("the shape is a real concave polygon, not a box",
      !!shape1 && shape1.pts.length === 6 && isConcave(shape1.pts),
      shape1 ? `${shape1.pts.length} corners, concave ${isConcave(shape1.pts)}` : "no shape");
    ok("a hand-drawn shape is drawn as its own kind (data-shape=poly, data-source=drawn)",
      await page.$$eval('.plan-room[data-shape="poly"][data-source="drawn"]', (n) => n.length) === 1);
    // The Source column promises "where this room came from"; a hand-drawn room used to leave it blank.
    const drawnSrc = shape1
      ? await page.$eval(`tr[data-id="${shape1.id}"] td.c-src`, (td) => td.textContent.trim())
      : "(no shape)";
    ok("the hand-drawn room's Source cell is labelled, not blank", drawnSrc === "drawn", `"${drawnSrc}"`);

    const afterCommit = await page.evaluate((id) => ({
      mode: window.webhvac.state.ui.planMode,
      selectRadio: document.getElementById("planModeSelect").checked,
      shapeRadio: document.getElementById("planModeShape").checked,
      selected: !!document.querySelector(`.plan-room[data-room-id="${id}"].is-selected`),
      open: window.webhvac.state.ui.openId === id,
    }), shape1.id);
    ok("closing a shape hands over to Select/edit with the new room selected",
      afterCommit.mode === "select" && afterCommit.selectRadio && !afterCommit.shapeRadio
        && afterCommit.selected && afterCommit.open,
      JSON.stringify(afterCommit));

    // ---- (c) EDIT a vertex: the row area follows the shoelace, the load only moves on release
    await page.click("#planModeSelect");
    await sleep2(250);
    const sel1 = await newestShape();
    const insideL = await atF(0.12, 0.22);
    await page.mouse.click(insideL.x, insideL.y);   // inside the L's bottom bar
    await sleep2(400);
    const handles = await page.evaluate(() => ({
      vertices: document.querySelectorAll(".plan-vertex-handle").length,
      edges: document.querySelectorAll(".plan-edge-handle").length,
    }));
    ok("a selected shape shows a handle on every corner and every edge middle",
      handles.vertices === 6 && handles.edges === 6, JSON.stringify(handles));

    const trRow = (id) => page.$eval(`tr[data-id="${id}"] .v-tr`, (e) => parseFloat(e.textContent)).catch(() => NaN);
    const geom0 = await newestShape();
    const totalBeforeDrag = await readTotalTr2();
    const rowTrBeforeDrag = await trRow(geom0.id);
    const v0 = { x: geom0.origin.x + geom0.pts[0][0], y: geom0.origin.y + geom0.pts[0][1] };
    await page.mouse.move(v0.x, v0.y);
    await page.mouse.down();
    await page.mouse.move(v0.x - 90, v0.y - 90, { steps: 10 });
    await sleep2(250);
    const midDrag = await newestShape();
    const totalMidDrag = await readTotalTr2();
    await page.mouse.up();
    await sleep2(600);
    const afterDrag = await newestShape();
    const scale2 = await scaleNow();
    const totalAfterDrag = await readTotalTr2();
    ok("dragging a corner changes the row's area to the new shoelace (within 0.5%)",
      Math.abs(afterDrag.cell - shoelaceArea(afterDrag.pts, scale2)) <= shoelaceArea(afterDrag.pts, scale2) * 0.005
        && afterDrag.cell !== geom0.cell,
      `${geom0.cell} -> ${afterDrag.cell} m² (shoelace ${shoelaceArea(afterDrag.pts, scale2).toFixed(3)})`);
    ok("the row area updates LIVE while the corner is dragged",
      Math.abs(midDrag.cell - shoelaceArea(midDrag.pts, scale2)) <= shoelaceArea(midDrag.pts, scale2) * 0.02,
      `mid-drag row ${midDrag.cell} m², stored ring ${midDrag.polyLen} points`);
    ok("the LOAD does not change while the geometry is being edited (mid-drag)",
      totalMidDrag === totalBeforeDrag,
      `${totalBeforeDrag} TR -> ${totalMidDrag} TR mid-drag`);
    ok("on release the load follows the shape's new area (the room's own delta)",
      Math.abs((totalAfterDrag - totalBeforeDrag) - (await trRow(geom0.id) - rowTrBeforeDrag)) <= 0.02
        && totalAfterDrag !== totalBeforeDrag,
      `total ${totalBeforeDrag} -> ${totalAfterDrag} TR, row ${rowTrBeforeDrag} -> ${await trRow(geom0.id)} TR`);
    // put the corner back where it was: the load returns exactly
    await page.mouse.move(v0.x - 90, v0.y - 90);
    await page.mouse.down();
    await page.mouse.move(v0.x, v0.y, { steps: 10 });
    await page.mouse.up();
    await sleep2(600);
    const restored = await newestShape();
    const totalRestored = await readTotalTr2();
    ok("editing the geometry and putting it back leaves the load exactly as it was",
      Math.abs(restored.cell - geom0.cell) <= 0.2 && Math.abs(totalRestored - totalBeforeDrag) <= 0.02,
      `area ${geom0.cell} -> ${restored.cell} m², load ${totalBeforeDrag} -> ${totalRestored} TR`);

    // ---- (d) an edge MIDDLE drag inserts a new corner
    const g2 = await newestShape();
    const em = { x: (g2.pts[0][0] + g2.pts[1][0]) / 2, y: (g2.pts[0][1] + g2.pts[1][1]) / 2 };
    await page.mouse.move(g2.origin.x + em.x, g2.origin.y + em.y);
    await page.mouse.down();
    await page.mouse.move(g2.origin.x + em.x + 30, g2.origin.y + em.y - 30, { steps: 8 });
    await page.mouse.up();
    await sleep2(600);
    const added = await newestShape();
    ok("dragging an edge middle adds a corner there", added.polyLen === g2.polyLen + 1,
      `${g2.polyLen} -> ${added.polyLen} corners`);

    // ---- (e) Alt + drop a corner on ANOTHER edge removes that corner
    const g3 = await newestShape();
    const vi = 3;                                  // a corner; edges 0 and 3 don't touch it
    const target = { x: (g3.pts[0][0] + g3.pts[1][0]) / 2, y: (g3.pts[0][1] + g3.pts[1][1]) / 2 };
    const vp = { x: g3.origin.x + g3.pts[vi][0], y: g3.origin.y + g3.pts[vi][1] };
    await page.keyboard.down("Alt");
    await page.mouse.move(vp.x, vp.y);
    await page.mouse.down();
    await page.mouse.move(g3.origin.x + target.x, g3.origin.y + target.y, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await sleep2(600);
    const removed = await newestShape();
    ok("Alt + dropping a corner on another edge removes it",
      removed.polyLen === g3.polyLen - 1, `${g3.polyLen} -> ${removed.polyLen} corners`);

    // ---- (f) Escape mid-draw cancels the shape and creates nothing
    // (the vertex edits above ran in Select/edit, so go back to the shape tool first)
    await page.click("#planModeShape");
    await sleep2(250);
    const rowsBeforeEsc = await rowCount();
    for (const [x, y] of [[0.06, 0.50], [0.20, 0.50], [0.20, 0.60]]) await clickAt(x, y);
    await page.keyboard.press("Escape");
    await sleep2(400);
    const afterEsc = await page.evaluate(() => ({
      vertices: document.querySelectorAll(".plan-vertex").length,
      chooser: !document.getElementById("planShapeAssign").classList.contains("hidden"),
    }));
    ok("Escape mid-draw throws the shape away and creates no room",
      afterEsc.vertices === 0 && !afterEsc.chooser && (await rowCount()) === rowsBeforeEsc,
      JSON.stringify({ ...afterEsc, rows: await rowCount() }));

    // ---- (g) a self-crossing draw is refused with one plain line
    const rowsBeforeBad = await rowCount();
    for (const [x, y] of [[0.06, 0.66], [0.20, 0.80], [0.20, 0.66], [0.06, 0.80]]) await clickAt(x, y);
    await clickAt(0.06, 0.66);                     // close the bow-tie
    await sleep2(500);
    const bad = await page.evaluate(() => ({
      rows: document.querySelectorAll("#roomsBody tr").length,
      status: document.getElementById("planStatus").textContent.replace(/\s+/g, " "),
      chooser: !document.getElementById("planShapeAssign").classList.contains("hidden"),
    }));
    ok("a self-crossing shape is refused with a plain one-line message and no room",
      bad.rows === rowsBeforeBad && /cannot be used/i.test(bad.status) && !bad.chooser,
      bad.status.slice(0, 90));

    // ---- (h) ASSIGN a 5-corner shape to the existing 20 m² row: its area becomes the shoelace,
    //          and the total load moves by exactly that room's own delta
    const five = [[0.42, 0.18], [0.62, 0.18], [0.62, 0.36], [0.52, 0.44], [0.42, 0.36]];
    for (const [x, y] of five) await clickAt(x, y);
    await clickAt(five[0][0], five[0][1]);
    await sleep2(400);
    const assignUp = await page.evaluate(() => !document.getElementById("planShapeAssign").classList.contains("hidden"));
    const rowTrBefore = await trRow(manualId);
    const totalBeforeAssign = await readTotalTr2();
    await page.evaluate((id) => {
      const sel = document.getElementById("planShapeAssignRoom");
      sel.value = id;
    }, manualId);
    await page.click("#planShapeAssignGo");
    await sleep2(800);
    const assigned = await page.evaluate((id) => {
      const r = window.webhvac.state.rooms.find((x) => x.id === id);
      const g = document.querySelector(`.plan-room[data-room-id="${id}"]`);
      const pts = g ? g.querySelector(".plan-room-box").getAttribute("points").trim()
        .split(/\s+/).map((s) => s.split(",").map(Number)) : null;
      const cell = document.querySelector(`tr[data-id="${id}"] input[data-field="area"]`);
      const svg = document.querySelector(".plan-overlay");
      const sr = svg ? svg.getBoundingClientRect() : null;
      return { area: r.area, source: r.source, polyLen: r.poly.length, pts,
        origin: sr ? { x: sr.x, y: sr.y } : null, cell: cell ? Number(cell.value) : null };
    }, manualId);
    const scale3 = await scaleNow();
    const rowTrAfter = await trRow(manualId);
    const totalAfterAssign = await readTotalTr2();
    ok("a drawn shape can be GIVEN to an existing table row (chooser opened)",
      assignUp && assigned.polyLen === 5 && assigned.source === "drawn",
      `chooser ${assignUp}, ${assigned.polyLen} edges, source ${assigned.source}`);
    ok("the assigned room's area becomes the shape's shoelace area (within 0.5%)",
      Math.abs(assigned.cell - shoelaceArea(assigned.pts, scale3)) <= shoelaceArea(assigned.pts, scale3) * 0.005
        && assigned.cell !== 20,
      `row ${assigned.cell} m² vs shoelace ${shoelaceArea(assigned.pts, scale3).toFixed(3)} m²`);
    ok("the total load changes by exactly the assigned room's own delta",
      totalAfterAssign !== totalBeforeAssign
        && Math.abs((totalAfterAssign - totalBeforeAssign) - (rowTrAfter - rowTrBefore)) <= 0.02,
      `total ${totalBeforeAssign} -> ${totalAfterAssign} TR, room ${rowTrBefore} -> ${rowTrAfter} TR`);
    const propagation = await page.evaluate((id) => {
      const h = window.webhvac;
      const calc = h.currentCalc();
      const rooms = h.state.rooms.find((x) => x.id === id);
      const detail = document.getElementById("detailBody").innerText.replace(/\s+/g, " ");
      const csv = h.toCsv(h.state.project, calc);
      const html = h.buildReportHtml(h.state.project, calc);
      const areaStr = String(rooms.area);
      const d2 = rooms.area.toFixed(2), d1 = rooms.area.toFixed(1);
      return {
        detailHasArea: detail.includes(areaStr) || detail.includes(d1),
        csvHasArea: csv.includes(areaStr) || csv.includes(d2),
        // the report and the table round to 1-2 decimals; the raw JSON value may carry more
        reportHasArea: html.includes(d2) || html.includes(d1),
        csvHasName: csv.includes("New Room"),
      };
    }, manualId);
    ok("the new area shows in the detail panel, the CSV and the printable report",
      propagation.detailHasArea && propagation.csvHasArea && propagation.reportHasArea && propagation.csvHasName,
      JSON.stringify(propagation));

    // the shape travels in the saved project file, and a poly room still obeys the include tick
    await page.evaluate(() => {
      const orig = URL.createObjectURL.bind(URL);
      window.__json = null;
      URL.createObjectURL = (blob) => { try { blob.text().then((t) => { window.__json = t; }); } catch (e) {} return orig(blob); };
    });
    await page.click("#btnSave");
    await sleep2(700);
    const savedJson = await page.evaluate((id) => {
      let d = null;
      try { d = JSON.parse(window.__json || "null"); } catch (e) { d = null; }
      const r = d && Array.isArray(d.rooms) ? d.rooms.find((x) => x.id === id) : null;
      return {
        parsed: !!d, rooms: d && d.rooms ? d.rooms.length : 0,
        hasPoly: !!(r && Array.isArray(r.poly) && r.poly.length === 5),
        polyPage: r ? r.polyPage : null, area: r ? r.area : null, source: r ? r.source : null,
      };
    }, manualId);
    ok("the drawn shape (its 5 corners, page and area) is in the saved .json project",
      savedJson.parsed && savedJson.hasPoly && savedJson.source === "drawn" && savedJson.polyPage >= 1,
      JSON.stringify(savedJson));

    const totalWithRoom = await readTotalTr2();
    await page.evaluate((id) => {
      document.querySelector(`tr[data-id="${id}"] input[data-field="include"]`).click();
    }, manualId);
    await sleep2(600);
    const totalWithoutRoom = await readTotalTr2();
    await page.evaluate((id) => {
      document.querySelector(`tr[data-id="${id}"] input[data-field="include"]`).click();
    }, manualId);
    await sleep2(600);
    const totalBackAgain = await readTotalTr2();
    ok("the include tick still takes a drawn poly room out of the totals, and puts it back",
      totalWithoutRoom < totalWithRoom && Math.abs(totalBackAgain - totalWithRoom) <= 0.01,
      `${totalWithRoom} -> excluded ${totalWithoutRoom} -> back ${totalBackAgain} TR`);

    // ---- (i) dismissing the chooser keeps a NEW room (the tool's normal behaviour)
    // (committing a shape hands over to Select/edit, so go back to the shape tool)
    await page.click("#planModeShape");
    await sleep2(250);
    const rowsBeforeDismiss = await rowCount();
    for (const [x, y] of [[0.62, 0.50], [0.78, 0.50], [0.76, 0.64], [0.66, 0.68], [0.60, 0.58]]) await clickAt(x, y);
    await clickAt(0.62, 0.50);
    await sleep2(400);
    const chooserBeforeDismiss = await page.evaluate(() =>
      !document.getElementById("planShapeAssign").classList.contains("hidden"));
    await page.click("#planShapeAssignClose");
    await sleep2(600);
    ok("dismissing the chooser keeps the shape as a new room",
      chooserBeforeDismiss && (await rowCount()) === rowsBeforeDismiss + 1,
      `${rowsBeforeDismiss} -> ${await rowCount()} rows`);

    // also: Enter closes a shape (the keyboard path)
    await page.click("#planModeShape");
    await sleep2(250);
    const rowsBeforeEnter = await rowCount();
    for (const [x, y] of [[0.42, 0.62], [0.56, 0.62], [0.56, 0.76], [0.42, 0.76]]) await clickAt(x, y);
    await page.keyboard.press("Enter");
    await sleep2(400);
    const enterChooser = await page.evaluate(() =>
      !document.getElementById("planShapeAssign").classList.contains("hidden"));
    await page.click("#planShapeAssignGo");
    await sleep2(600);
    ok("Enter closes a shape too",
      enterChooser && (await rowCount()) === rowsBeforeEnter + 1, `chooser ${enterChooser}`);

    // ---- (j) the drawn shapes survive a reload
    const beforeReload = await page.evaluate(() => {
      const rooms = window.webhvac.state.rooms.filter((r) => r.source === "drawn" && Array.isArray(r.poly));
      return { n: rooms.length, lens: rooms.map((r) => r.poly.length).join(","),
        areas: rooms.map((r) => r.area).join(",") };
    });
    await page.reload({ waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100,
      { timeout: 120000, polling: 400 });
    await page.waitForFunction(() => { const c = document.getElementById("planCanvas"); return c && c.width > 400; },
      { timeout: 60000, polling: 400 });
    await sleep2(800);
    const afterReload2 = await page.evaluate(() => {
      const rooms = window.webhvac.state.rooms.filter((r) => r.source === "drawn" && Array.isArray(r.poly));
      return { n: rooms.length, lens: rooms.map((r) => r.poly.length).join(","),
        areas: rooms.map((r) => r.area).join(","),
        onPlan: document.querySelectorAll('.plan-room[data-source="drawn"]').length };
    });
    ok("the hand-drawn shapes survive a reload, ring and area intact",
      beforeReload.n >= 3 && afterReload2.n === beforeReload.n && afterReload2.lens === beforeReload.lens
        && afterReload2.areas === beforeReload.areas && afterReload2.onPlan >= 1,
      `${beforeReload.n} drawn -> ${afterReload2.n} after reload (${afterReload2.onPlan} on this page)`);

    await page.screenshot({ path: `${OUT}/live-plan-shape.png` });

    // leave the sheet on page 1, exactly where the sections after this one expect to find it (the
    // reload above put the app back on the page the user was on, which is 2)
    await page.click("#planPrev");
    await sleep2(900);
  }

  // 16. renaming a room must follow through to every place the room is shown: the table row, its box
  //     label on the drawing, and its description under the table. The drawing was the one that stayed
  //     stale: the in-table edit path deliberately does not rebuild the table (that would take the
  //     caret out of the cell being typed in) and forgot to redraw the plan overlay.
  const drawnRow = await page.evaluate(() => {
    // Target a drawn room that is actually ON the drawing now — its box carries a "Drawn room" label.
    // A drawn room whose geometry was cleared, or lies on another page, has no label to update, so
    // renaming it would prove nothing. Pick by the id the visible label belongs to.
    const g = [...document.querySelectorAll(".plan-room[data-room-id]")]
      .find((x) => /Drawn room/.test(((x.querySelector(".plan-room-label") || {}).textContent) || ""));
    return g ? g.getAttribute("data-room-id") : null;
  });
  const drawnEl = drawnRow ? await page.$(`tr[data-id="${drawnRow}"] input[data-field="name"]`) : null;
  const renamedTo = "Conference A";
  const renameResult = { before: null, labelsBefore: 0, after: null };
  if (drawnEl) {
    // open that room's breakdown FIRST: clicking a computed cell, not an input (row clicks on inputs
    // are ignored on purpose, so the caret can be placed while editing)
    await page.evaluate((id) => {
      const tr = document.querySelector(`#roomsBody tr[data-id="${id}"]`);
      const cell = tr && tr.querySelector(".v-total");
      if (cell) cell.click();
    }, drawnRow);
    await new Promise((r) => setTimeout(r, 600));
    renameResult.detailOpen = await page.evaluate(() =>
      !document.getElementById("detailPanel").classList.contains("hidden"));
    renameResult.before = await page.evaluate((e) => e.value, drawnEl);
    // count the labels that carry the DEFAULT name: renaming one room must retire exactly one of them
    // (some boxes on this page carry a name of their own, e.g. a hand-drawn shape given to a row)
    renameResult.labelsBefore = await page.$$eval(".plan-room-label",
      (n) => n.filter((e) => /Drawn room/.test(e.textContent)).length);
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

    // draw one room to work on (Draw shape: a bare drag is a rectangle)
    await page.click("#planModeShape");
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

    // ...and Delete must be ignored while the focus is on any OTHER table control too — the row's In
    // checkbox, a row dropdown, the x button. Before this, Delete with the focus on a row checkbox
    // removed the selected plan room with no warning (UX review, item 4). A room is selected first on
    // purpose, so an unguarded Delete WOULD remove a row and the check cannot pass vacuously.
    await page.evaluate(() => {
      const tr = document.querySelector("#roomsBody tr");
      const cell = tr && tr.querySelector(".v-total");
      if (cell) cell.click();                 // open that room, so a stray Delete would act
    });
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => {
      const cb = document.querySelector('#roomsBody tr input[type="checkbox"]');
      if (cb) cb.focus();
    });
    const cbFocus = await page.evaluate(() => (document.activeElement && document.activeElement.type) || "none");
    const rowsBeforeCb = await rows2();
    await page.keyboard.press("Delete");
    await new Promise((r) => setTimeout(r, 400));
    ok("Delete does not fire while a row checkbox holds the focus",
      cbFocus === "checkbox" && (await rows2()) === rowsBeforeCb,
      `focused ${cbFocus}, rows ${rowsBeforeCb} -> ${await rows2()}`);

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
        markers: document.querySelectorAll('.plan-room[data-shape="marker"]').length,
        pageNow,
        onThisPage: rooms.filter((r) => r.at && (r.page || 1) === pageNow).length,
        areas: rooms.map((r) => `${r.id}:${r.area}:${r.length}:${r.width}`).join("|"),
      };
    });

    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await page.click("#planModeShape");
    await new Promise((r) => setTimeout(r, 250));
    const before = await roomsNow();
    const totalBefore = await totalOf();
    const rowsBefore = await rows3();

    ok("no region is on the drawing before placing", before.placed === 0, `${before.placed} placed, ${before.drawn} drawn`);

    await waitIdle();
    await page.click("#planPlaceAll");
    await new Promise((r) => setTimeout(r, 1500));
    const after = await roomsNow();
    const totalAfter = await totalOf();

    ok("placing puts every room the plan names on the drawing",
      after.placed === after.withAt && after.placed > 0,
      `${after.placed} placed of ${after.withAt} named on the sheet`);
    ok("placing shows them on the page you are looking at",
      after.boxesOnPage >= after.onThisPage, `${after.boxesOnPage} boxes on page ${after.pageNow}, ${after.onThisPage} rooms named on it`);
    // A crowded page must not draw 50+ full-area boxes on top of each other: they covered the drawing's
    // walls and labels and made the demo look broken. Past the crowding limit each placed locator is a
    // small marker at the point that names the room, still the same clickable .plan-room (UX review, item 3).
    ok("a crowded placed page draws locators as markers, not overlapping area boxes",
      after.onThisPage >= 40
        ? after.markers === after.onThisPage && after.markers > 0
        : after.markers === 0,
      `${after.markers} marker(s), ${after.boxesOnPage} placed shape(s) on page ${after.pageNow} (${after.onThisPage} rooms named there)`);
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
    await waitIdle();
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

  // ---- Plan-panel messages are visible where the buttons are (UX review items 1, 2) ---------------
  // The upload status box lives far up the page, so a trace result shown only there was never seen.
  // Every message a plan button produces is mirrored into #planStatus inside the plan panel, and when
  // the drawing scale is wrong a one-click fix appears next to the buttons and re-runs the trace.
  {
    const readPlanStatus = () => page.evaluate(() => {
      const s = document.getElementById("planStatus");
      const r = s ? s.getBoundingClientRect() : null;
      return { text: s ? s.textContent.replace(/\s+/g, " ").trim() : "",
        hidden: !s || s.classList.contains("hidden"),
        onScreen: !!r && r.top < window.innerHeight && r.bottom > 0 };
    });
    const rows4 = () => page.$$eval("#roomsBody tr", (t) => t.length);

    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await page.click("#planFit");
    await new Promise((r) => setTimeout(r, 1200));
    const rowsBeforeTrace = await rows4();
    await waitIdle();
    await page.click("#planTraceOutlines");
    await page.waitForFunction(() => {
      const s = document.getElementById("planStatus");
      return s && !s.classList.contains("hidden") && !/Tracing the plan/.test(s.textContent)
        && /outline|point to|traced|trace/i.test(s.textContent);
    }, { timeout: 120000, polling: 400 }).catch(() => {});
    await page.evaluate(() => { const s = document.getElementById("planStatus"); if (s) s.scrollIntoView({ block: "center" }); });
    await new Promise((r) => setTimeout(r, 400));
    const traced = await readPlanStatus();
    ok("a plan-button result is shown inside the plan panel, next to the buttons",
      !traced.hidden && traced.onScreen && /outline|point to/i.test(traced.text),
      `"${traced.text.slice(0, 90)}" — hidden ${traced.hidden}, on screen ${traced.onScreen}`);
    // The toast used to sit at the bottom-centre of the viewport, over the drawing the user is working
    // on. It must now be positioned clear of #planView (P3: it must not cover what the user is looking at).
    const toastClear = await page.evaluate(() => {
      const s = document.getElementById("planStatus");
      const v = document.getElementById("planView");
      if (!s || !v || s.classList.contains("hidden")) return { ok: false, why: "toast hidden" };
      const a = s.getBoundingClientRect(), b = v.getBoundingClientRect();
      const overlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return { ok: !overlap, toastTop: Math.round(a.top), planTop: Math.round(b.top), planBottom: Math.round(b.bottom) };
    });
    ok("the plan toast does not cover the plan view", toastClear.ok,
      `toast top ${toastClear.toastTop}, plan ${toastClear.planTop}..${toastClear.planBottom}`);
    ok("tracing does not add or drop table rows", (await rows4()) === rowsBeforeTrace,
      `${rowsBeforeTrace} -> ${await rows4()}`);

    // a WRONG scale finds ~0 rooms: the one-click fix must appear (next to the buttons, on screen) and work
    await page.select("#planScale", "500");
    await new Promise((r) => setTimeout(r, 400));
    await waitIdle();
    await page.click("#planTraceOutlines");
    const fixAppeared = await page.waitForFunction(() => {
      const b = document.getElementById("planScaleFix");
      return b && !b.classList.contains("hidden") && !!document.getElementById("planScaleFixBtn");
    }, { timeout: 120000, polling: 400 }).then(() => true).catch(() => false);
    await page.evaluate(() => { const b = document.getElementById("planScaleFix"); if (b) b.scrollIntoView({ block: "center" }); });
    await new Promise((r) => setTimeout(r, 300));
    const fixInfo = await page.evaluate(() => {
      const b = document.getElementById("planScaleFix");
      const btn = document.getElementById("planScaleFixBtn");
      const r = b ? b.getBoundingClientRect() : null;
      return { text: b ? b.textContent.replace(/\s+/g, " ").trim() : "",
        btn: btn ? btn.textContent.trim() : "",
        onScreen: !!r && r.top < window.innerHeight && r.bottom > 0 };
    });
    ok("a wrong drawing scale offers a one-click fix on the plan panel",
      fixAppeared && /Use 1:\d+ and trace again/.test(fixInfo.btn) && fixInfo.onScreen,
      `"${fixInfo.btn}" — on screen ${fixInfo.onScreen}`);
    const wanted = (fixInfo.btn.match(/1:(\d+)/) || [])[1];
    if (wanted) {
      await page.click("#planScaleFixBtn");
      await page.waitForFunction(() => {
        const s = document.getElementById("planStatus");
        return s && /real outline/i.test(s.textContent);
      }, { timeout: 120000, polling: 400 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      const afterFix = await page.evaluate(() => ({
        scale: document.getElementById("planScale").value,
        text: document.getElementById("planStatus").textContent.replace(/\s+/g, " ").trim(),
        polys: document.querySelectorAll('.plan-room[data-shape="poly"]').length,
        fixHidden: document.getElementById("planScaleFix").classList.contains("hidden"),
      }));
      ok("the one-click fix sets the offered scale and traces again",
        afterFix.scale === wanted && afterFix.polys > 0 && afterFix.fixHidden,
        `scale 1:${afterFix.scale} (wanted 1:${wanted}), ${afterFix.polys} outline(s) on this page, fix hidden ${afterFix.fixHidden}`);
    } else {
      ok("the one-click fix sets the offered scale and traces again", false, "no scale in the button label");
    }

    // leave the plan as it was found
    await page.click("#planTraceClear");
    await page.select("#planScale", "100");
    await new Promise((r) => setTimeout(r, 900));
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

  // ---- Location-aware design conditions -----------------------------------------------
  // autoDetectClimate() in js/app.js asks the (mocked, see the request interception above) geo
  // endpoint once per visitor, maps country/region/city through js/climates.js and pre-fills the
  // outdoor design conditions of a FIRST visit. Saved values are never overwritten, the chip is
  // dismissible per location, and a blocked lookup falls back to the timezone at country level.
  {
    const snapGeo = () => page.evaluate(() => ({
      db: document.getElementById("proj-outDb").value,
      wb: document.getElementById("proj-outWb").value,
      country: document.getElementById("proj-country").value,
      city: document.getElementById("proj-city").value,
      hidden: document.getElementById("geoNote").classList.contains("hidden"),
      chip: document.getElementById("geoNote").innerText.replace(/\s+/g, " ").trim(),
      acts: [...document.querySelectorAll("#geoNote [data-act]")].map((b) => b.getAttribute("data-act")),
      status: document.getElementById("statusBox").className,
    }));
    const clearStore = () => page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    const waitChip = () => page.waitForSelector("#geoNote:not(.hidden)", { timeout: 15000 }).catch(() => {});
    const waitStable = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

    // (a) first visit: a known city is detected -> the empty fields are filled AND a chip says so
    geoResponse = { country: "India", region: "Delhi", city: "Delhi" };
    geoFail = false;
    await clearStore();
    await page.goto(URL_, { waitUntil: "networkidle2", timeout: 60000 });
    await waitChip();
    const a = await snapGeo();
    ok("a detected city pre-fills the empty design conditions (Delhi 42.3/23.2, ASHRAE 2021)",
      Number(a.db) === 42.3 && Number(a.wb) === 23.2, `DB=${a.db} WB=${a.wb}`);
    ok("a dismissible detection chip appears and asks the user to verify",
      !a.hidden && /Detected/.test(a.chip) && /[Vv]erify/.test(a.chip) && /ISHRAE|ASHRAE/.test(a.chip),
      a.chip.slice(0, 150));
    ok("the chip names the place and offers Change",
      /Delhi/.test(a.chip) && /India/.test(a.chip) && a.acts.includes("change") && a.acts.includes("dismiss"),
      a.chip.slice(0, 150));

    // (b) dismissing the chip remembers it for that location, across a reload
    await page.click('#geoNote [data-act="dismiss"]');
    await waitStable(250);
    await page.reload({ waitUntil: "networkidle2" });
    await waitStable();
    const b = await snapGeo();
    ok("a dismissed chip stays dismissed for that location on reload", b.hidden === true,
      b.chip || "(chip hidden)");
    ok("dismissing does not undo the filled values", Number(b.db) === 42.3 && Number(b.wb) === 23.2,
      `DB=${b.db} WB=${b.wb}`);

    // (c) a saved project's own values are never overwritten — the chip offers an Apply button
    geoResponse = { country: "India", region: "Karnataka", city: "Bengaluru" };
    geoFail = false;
    await clearStore();
    await page.evaluate(() => localStorage.setItem("webhvac.state.v1", JSON.stringify({
      v: 1, project: { name: "My Project", country: "India", city: "Mumbai", outDb: 36, outWb: 28, inDb: 24, inRh: 50 }, rooms: [],
    })));
    await page.goto(URL_, { waitUntil: "networkidle2" });
    await waitChip();
    const c = await snapGeo();
    ok("saved design conditions are never overwritten by the detection",
      Number(c.db) === 36 && Number(c.wb) === 28 && c.city === "Mumbai",
      `DB=${c.db} WB=${c.wb} city=${c.city}`);
    ok("a saved project gets a [Use detected values] button, not a silent overwrite",
      c.acts.includes("apply") && /left alone/.test(c.chip), c.chip.slice(0, 150));
    await page.click('#geoNote [data-act="apply"]');
    await waitStable(300);
    const c2 = await snapGeo();
    ok("Use detected values applies the suggestion on request",
      Number(c2.db) === 34.3 && Number(c2.wb) === 20 && c2.city === "Bengaluru",
      `DB=${c2.db} WB=${c2.wb} city=${c2.city}`);

    // (d) a blocked lookup falls back to the timezone (country level) and shows no error
    geoFail = true;
    await clearStore();
    const peBefore = consoleErrors.filter((t) => t.startsWith("pageerror:")).length;
    await page.goto(URL_, { waitUntil: "networkidle2" });
    await waitChip();
    await waitStable(1500);
    const d = await snapGeo();
    const peAfter = consoleErrors.filter((t) => t.startsWith("pageerror:")).length;
    ok("a blocked geo lookup still suggests, from the timezone, at country level (India 40/26)",
      Number(d.db) === 40 && Number(d.wb) === 26, `DB=${d.db} WB=${d.wb} chip="${d.chip.slice(0, 90)}"`);
    ok("the timezone fallback is labelled a country-level match",
      /country-level match/i.test(d.chip), d.chip.slice(0, 150));
    ok("a country-level match keeps the known country, not 'Custom'",
      d.country === "India" && /country-level/i.test(d.city), `country "${d.country}", city "${d.city}"`);
    ok("a blocked geo lookup surfaces no error to the user",
      !/\berr\b/.test(d.status), d.status || "(no status class)");
    ok("a blocked geo lookup raises no page error", peAfter === peBefore,
      `pageerrors ${peBefore} -> ${peAfter}`);

    // leave the interception in a neutral state for the checks that follow
    geoFail = false;
    geoResponse = { country: "India", region: "Kerala", city: "Kochi" };
  }

  // 11b. the documented sample baseline must hold on a fresh load AND after a reload. Kept at the end,
  //      on a fresh sample with no edits, so it cannot disturb the edit-heavy flows above.
  {
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.goto(SYNTH, { waitUntil: "networkidle2", timeout: 60000 });
    // the fresh load's geo chip renders asynchronously and can shift #btnSample between the scroll and
    // the click, so settle first and fall back to a direct click if the geometry click misses.
    await page.evaluate(() => document.getElementById("btnSample").scrollIntoView({ block: "center" }));
    await new Promise((r) => setTimeout(r, 500));
    await page.click("#btnSample");
    const sampleLoaded = await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100,
      { timeout: 20000, polling: 300 }).then(() => true).catch(() => false);
    if (!sampleLoaded) {
      await page.evaluate(() => document.getElementById("btnSample").click());
    }
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100,
      { timeout: 120000, polling: 400 });
    const readTr = () => page.$eval("#summaryCards", (e) => {
      const m = e.innerText.replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/);
      return m ? parseFloat(m[1]) : NaN;
    });
    const trFresh = await readTr();
    // the app persists on a ~300 ms debounce AND writes an empty project at load, so wait for the
    // sample's own save (a populated rooms array) — matching merely `"rooms":` hits that empty write.
    await page.waitForFunction(() => {
      try {
        const d = JSON.parse(localStorage.getItem("webhvac.state.v1") || "null");
        return d && Array.isArray(d.rooms) && d.rooms.length > 100;
      } catch (e) { return false; }
    }, { timeout: 20000, polling: 200 });
    await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100,
      { timeout: 120000, polling: 400 });
    const trAgain = await readTr();
    ok("the sample total is 363.86 TR on load and after a reload",
      Math.abs(trFresh - 363.86) < 0.01 && Math.abs(trAgain - 363.86) < 0.01,
      `${trFresh} TR -> ${trAgain} TR after reload`);
  }

  // 11c. the DEFAULT sample is the real, credited LEVEL 11 FLOOR PLAN (CC BY-SA 4.0, see
  //      docs/SAMPLE-CREDITS.md). It prints room NAMES but no AREAS, so every room must arrive with an
  //      unknown area, flagged, and out of the load — and the app must SAY so, without inventing a
  //      single tonne. Checked on the plain page (no ?sample= hook), because that is what the button
  //      loads for a visitor.
  {
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.goto(BASE + "app.html", { waitUntil: "networkidle2", timeout: 60000 });
    await page.evaluate(() => document.getElementById("btnSample").scrollIntoView({ block: "center" }));
    await new Promise((r) => setTimeout(r, 400));
    await page.click("#btnSample").catch(() => {});
    const loaded = await page.waitForFunction(
      () => document.querySelectorAll("#roomsBody tr").length >= 40,
      { timeout: 120000, polling: 400 }).then(() => true).catch(() => false);
    if (!loaded) await page.evaluate(() => document.getElementById("btnSample").click());
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length >= 40,
      { timeout: 120000, polling: 400 });

    const realRooms = await page.$$eval("#roomsBody tr", (rows) => rows.length);
    ok("the default sample (real LEVEL 11 plan) loads a large room list", realRooms >= 40,
      `${realRooms} room rows`);

    // every area cell blank and every Include box unticked — nothing was made up
    const cells = await page.$$eval("#roomsBody tr", (rows) => rows.map((tr) => {
      const a = tr.querySelector('input[data-field="area"]');
      const i = tr.querySelector('input[data-field="include"]');
      return { area: a ? a.value : null, inc: !!(i && i.checked) };
    }));
    const blank = cells.filter((c) => c.area === "").length;
    const ticked = cells.filter((c) => c.inc).length;
    // The sheet prints NO areas, and loadSample now runs the drawing fill by itself (first-visit
    // fix). So the honest rule is: every area on screen came from the drawing fill, never from
    // the parse. A blank count equal to the row count was the pre-auto-fill expectation.
    const madeUp = await page.evaluate(() => {
      const rooms = (window.webhvac && window.webhvac.state && window.webhvac.state.rooms) || [];
      return rooms.filter((r) => Number(r.area) > 0 && !r.areaFromDrawing).map((r) => r.name);
    });
    ok("every real-sample area is blank or taken from the drawing (none parsed or made up)",
      Array.isArray(madeUp) && madeUp.length === 0 && await page.evaluate(() => window.webhvac.state.rooms.length >= 40),
      `${blank}/${realRooms} blank; areas not from the drawing: ${JSON.stringify(madeUp).slice(0, 160)}`);
    ok("no room the app could not measure is inside the load", await page.evaluate(() =>
      [...document.querySelectorAll("#roomsBody tr")].every((r) => {
        const tick = r.querySelector('input[type="checkbox"]');
        const area = r.querySelector('input[data-field="area"]');
        return !(tick && tick.checked) || (area && area.value !== "");
      })), "every included room carries an area");

    // the honest "no printed areas" note is visible (the <li> lives in #warnList; read its
    // textContent, because a closed <details> does not RENDER its body, so innerText is empty)
    const warn = await page.evaluate(() => {
      const b = document.getElementById("warnBox");
      const l = document.getElementById("warnList");
      return {
        hidden: !b || b.classList.contains("hidden"),
        text: l ? l.textContent.replace(/\s+/g, " ") : "",
      };
    });
    ok("the 'no printed areas' warning is visible for the real sample",
      !warn.hidden && /no printed areas found/i.test(warn.text) && /\d+\s+room name/i.test(warn.text),
      warn.text.slice(0, 200));

    // nothing invented a load: 0.00 TR and 0 rooms counted
    const realTr = await page.$eval("#summaryCards", (e) => {
      const m = e.innerText.replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/);
      return m ? parseFloat(m[1]) : NaN;
    });
    const incl = await page.$eval("#summaryCards", (e) => {
      const m = e.innerText.replace(/\s+/g, " ").match(/Rooms included (\d+)/);
      return m ? parseInt(m[1], 10) : NaN;
    });
    // The app now measures what it can from the sheet's own outlines without being asked
    // (the funnel showed strangers leaving an all-zero page), so wait for that to settle.
    await page.waitForFunction(
      () => /Filled \d+ area|no printed areas/i.test((document.getElementById("planStatus") || {}).textContent || ""),
      { timeout: 120000, polling: 400 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    const settled = await page.$eval("#summaryCards", (e) => {
      const t = e.innerText.replace(/\s+/g, " ");
      return {
        tr: Number((t.match(/Total cooling load ([0-9.]+) TR/) || [])[1]),
        incl: Number((t.match(/Rooms included (\d+)/) || [])[1]),
      };
    });
    ok("the real sample reaches a real load with NO click from the visitor",
      settled.tr > 0 && settled.incl > 0 && settled.incl <= 21,
      `${settled.tr} TR, ${settled.incl} of 21 measured room(s) included (was ${realTr} TR / ${incl} before)`);
    await page.screenshot({ path: `${OUT}/live-real-sample.png`, fullPage: false });
  }

  // ------------------------------------------------------------------ //
  // 11d. "Fill areas from the drawing" on the REAL name-only sample.    //
  //      The control measures an area from the plan's own outlines only //
  //      where one room name sits inside one closed shape; the status   //
  //      must quote the REAL counts; Undo must put them back exactly.   //
  // ------------------------------------------------------------------ //
  {
    await page.evaluate(() => document.getElementById("planFillAreas").scrollIntoView({ block: "center" }));
    await new Promise((r) => setTimeout(r, 400));

    const fillControl = await page.evaluate(() => {
      const b = document.getElementById("planFillAreas");
      return b ? { text: b.textContent.trim(), aria: b.getAttribute("aria-disabled"), title: b.title } : null;
    });
    ok("the plan panel offers 'Fill areas from the drawing'",
      !!fillControl && /fill areas from the drawing/i.test(fillControl.text),
      fillControl ? JSON.stringify(fillControl) : "button missing");
    ok("the control is offered while named rooms have no area",
      !!fillControl && fillControl.aria === "false" && /named room/i.test(fillControl.title),
      fillControl ? `aria-disabled=${fillControl.aria}; "${fillControl.title}"` : "");

    // No click: the fill runs by itself when the sample arrives with no printed areas.
    await new Promise((r) => setTimeout(r, 400));

    const fill = await page.evaluate(() => {
      const st = ((document.getElementById("planStatus") || {}).textContent || "").replace(/\s+/g, " ").trim();
      const badges = document.querySelectorAll('#roomsBody tr .row-badge.is-autofill').length;
      const cards = document.getElementById("summaryCards").innerText.replace(/\s+/g, " ");
      return {
        status: st,
        badges,
        tr: Number((cards.match(/Total cooling load ([0-9.]+) TR/) || [])[1]),
        incl: Number((cards.match(/Rooms included (\d+)/) || [])[1]),
        levels: [...document.querySelectorAll("#levelBody tr")].map((r) =>
          [...r.querySelectorAll("td")].map((c) => c.textContent.trim())),
      };
    });
    ok("the auto-trace status line reports the REAL filled count and reasons",
      // 22 since the splitter (js/splitregion.js) gives a shared region's names their own door-bounded
      // parts; the rest of the shared names are now refused as open-plan, in plain words
      /Filled 22 areas from the drawing/.test(fill.status)
        && /because the room is open to the next space/.test(fill.status)
        && !/could not be verified/.test(fill.status)
        && /2 because the traced shape did not look like a room/.test(fill.status),
      fill.status);
    ok("the filled rooms are marked in the table as coming from the drawing",
      fill.badges === 22, `${fill.badges} badge(s)`);
    ok("filling the areas moves the totals (the point of the feature)",
      fill.tr > 0 && fill.incl >= 1 && fill.incl <= 22, `${fill.tr} TR, ${fill.incl} room(s) included of 22 filled`);

    // the level-wise fresh-air column is ONE unit (L/s) down the column: its rows sum to its Total
    const fresh = fill.levels
      .map((cells) => cells.length >= 7 ? Number(String(cells[6]).replace(/,/g, "")) : NaN)
      .filter((n) => Number.isFinite(n));
    const rowsFresh = fresh.slice(0, -1);
    const totalFresh = fresh[fresh.length - 1];
    ok("the level-wise Fresh-air rows sum to their Total in the same unit",
      fresh.length >= 2 && Math.abs(rowsFresh.reduce((a, b) => a + b, 0) - totalFresh) <= 2,
      `rows ${rowsFresh.join("+")} vs total ${totalFresh}`);

    // A second press must say there is nothing left rather than pretend to work. The automatic setup
    // changed the rooms' geometry after the first fill, and the fill's no-op guard keys on those
    // shapes — so this press genuinely RE-RUNS the fill. Wait for it to finish before reading its line.
    await waitIdle();
    await page.click("#planFillAreas");
    await page.waitForFunction(() => !window.webhvac.state.ui.traceBusy
      && document.getElementById("planProgress").dataset.active === "0", { timeout: 120000, polling: 200 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    const secondPress = await page.evaluate(() =>
      ((document.getElementById("planStatus") || {}).textContent || "").replace(/\s+/g, " ").trim());
    ok("pressing Fill areas again reports honestly that nothing is left",
      /nothing to fill|already has an area|No area could be filled|Nothing was changed/i.test(secondPress),
      secondPress.slice(0, 140));

    // The plan status clears itself after a few seconds, so poll and REMEMBER every message seen
    // instead of reading once at the end — otherwise a correct undo reports an empty status.
    await page.click("#planFillUndo");
    let undoneStatus = "";
    for (let i = 0; i < 75; i += 1) {
      await new Promise((r) => setTimeout(r, 400));
      const seen = await page.evaluate(() => {
        const st = ((document.getElementById("planStatus") || {}).textContent || "").replace(/\s+/g, " ").trim();
        const m = (document.getElementById("summaryCards") || {}).innerText || "";
        return { st, done: /Total cooling load 0\.00 TR/.test(m) };
      });
      if (seen.st) undoneStatus = seen.st;
      if (seen.done) break;
    }
    const undone = await page.evaluate(() => {
      const st = ((document.getElementById("planStatus") || {}).textContent || "").replace(/\s+/g, " ").trim();
      const cards = document.getElementById("summaryCards").innerText.replace(/\s+/g, " ");
      return {
        status: st,
        badges: document.querySelectorAll('#roomsBody tr .row-badge.is-autofill').length,
        tr: Number((cards.match(/Total cooling load ([0-9.]+) TR/) || [])[1]),
        blank: [...document.querySelectorAll('#roomsBody tr input[data-field="area"]')].filter((i) => i.value === "").length,
      };
    });
    ok("Undo puts every area back and the load returns to 0.00 TR",
      undone.badges === 0 && undone.tr === 0 && undone.blank === 56,
      `${undone.badges} badge(s), ${undone.tr} TR, ${undone.blank} blank areas`);
    ok("Undo says what it put back", /Undone: 22 areas/.test(undone.status || undoneStatus),
      undone.status || undoneStatus);
  }

  // ------------------------------------------------------------------ //
  // 11e. the SYNTHETIC fixture: every room has an area, so there is    //
  //      nothing to fill — and the fixture baseline must not move.     //
  // ------------------------------------------------------------------ //
  {
    await page.goto(SYNTH, { waitUntil: "networkidle2", timeout: 60000 });
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.goto(SYNTH, { waitUntil: "networkidle2", timeout: 60000 });
    await page.evaluate(() => document.getElementById("btnSample").scrollIntoView({ block: "center" }));
    await new Promise((r) => setTimeout(r, 400));
    await page.click("#btnSample").catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100,
      { timeout: 120000, polling: 400 });

    const synthBefore = await page.evaluate(() => ({
      rooms: document.querySelectorAll("#roomsBody tr").length,
      tr: Number((document.getElementById("summaryCards").innerText.replace(/\s+/g, " ")
        .match(/Total cooling load ([0-9.]+) TR/) || [])[1]),
    }));
    ok("the synthetic fixture still loads 159 rooms at 363.86 TR",
      synthBefore.rooms === 159 && Math.abs(synthBefore.tr - 363.86) < 0.01,
      `${synthBefore.rooms} rooms, ${synthBefore.tr} TR`);

    await page.evaluate(() => document.getElementById("planFillAreas").scrollIntoView({ block: "center" }));
    await new Promise((r) => setTimeout(r, 400));
    const nothingBtn = await page.$eval("#planFillAreas", (e) => ({ aria: e.getAttribute("aria-disabled"), title: e.title }));
    ok("with every area already known, the control says there is nothing to fill",
      nothingBtn.aria === "true" && /nothing to fill/i.test(nothingBtn.title), JSON.stringify(nothingBtn));

    await waitIdle();
    await page.click("#planFillAreas");
    await new Promise((r) => setTimeout(r, 600));
    const afterFill = await page.evaluate(() => {
      const cards = document.getElementById("summaryCards").innerText.replace(/\s+/g, " ");
      return {
        status: ((document.getElementById("planStatus") || {}).textContent || "").replace(/\s+/g, " ").trim(),
        rooms: document.querySelectorAll("#roomsBody tr").length,
        tr: Number((cards.match(/Total cooling load ([0-9.]+) TR/) || [])[1]),
        badges: document.querySelectorAll('#roomsBody tr .row-badge.is-autofill').length,
      };
    });
    ok("the auto-trace on the fixture reports nothing to fill and changes nothing",
      /nothing to fill from the drawing/i.test(afterFill.status)
        && afterFill.rooms === 159 && Math.abs(afterFill.tr - 363.86) < 0.01 && afterFill.badges === 0,
      `${afterFill.status.slice(0, 90)} | ${afterFill.tr} TR, ${afterFill.rooms} rooms`);
  }

  // ------------------------------------------------------------------ //
  // 11f. app-side fixes, exercised in the real browser: a scale change  //
  //      must not rewrite a traced room's area; a drag released outside  //
  //      must not strand the tool; a second finger must not corrupt the  //
  //      rectangle; a drag that replaces a polygon must say so; a tiny   //
  //      rectangle must be refused with a message; a duplicate draw must //
  //      say why nothing appeared.                                      //
  // ------------------------------------------------------------------ //
  {
    const planStatusText = () => page.evaluate(() =>
      ((document.getElementById("planStatus") || {}).textContent || "").replace(/\s+/g, " ").trim());
    const pvRect = () => page.$eval("#planView", (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });

    // ---- (3) a scale change must leave a TRACED room alone, and still rescale a DRAWN one ----
    await page.evaluate(() => {
      const h = window.webhvac;
      // a traced L-shaped room: a bounding-box rect AND a poly, area = the plan's stated figure
      h.state.rooms.push({ id: "tracedL", name: "TRACED L", level: "L", area: 50, include: true, source: "pdf",
        poly: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 20 }, { x: 0, y: 20 }],
        polyPage: 1, rect: { page: 1, x: 0, y: 0, w: 20, h: 20 }, scaleDenom: 100 });
      // a hand-drawn ring: its area comes from the ring, so a scale change must re-measure it
      h.state.rooms.push({ id: "drawnP", name: "DRAWN P", level: "L", area: 40, include: true, source: "drawn",
        poly: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        polyPage: 1, rect: { page: 1, x: 0, y: 0, w: 10, h: 10 }, scaleDenom: 100 });
      h.renderAll();
    });
    await page.select("#planScale", "50");
    await new Promise((r) => setTimeout(r, 500));
    const at50 = await page.evaluate(() => {
      const rs = window.webhvac.state.rooms;
      return { traced: rs.find((r) => r.id === "tracedL").area, drawn: rs.find((r) => r.id === "drawnP").area };
    });
    await page.select("#planScale", "100");
    await new Promise((r) => setTimeout(r, 500));
    const at100 = await page.evaluate(() => {
      const rs = window.webhvac.state.rooms;
      return { traced: rs.find((r) => r.id === "tracedL").area, drawn: rs.find((r) => r.id === "drawnP").area };
    });
    ok("changing the drawing scale leaves a traced outline's area alone",
      at50.traced === 50 && at100.traced === 50,
      `traced area 50 -> ${at50.traced} at 1:50, ${at100.traced} at 1:100`);
    ok("a hand-drawn shape still re-measures at the new scale (area scales with 1/denom²)",
      at100.drawn > 0 && Math.abs(at50.drawn - at100.drawn / 4) <= at100.drawn * 0.02,
      `drawn ${at100.drawn} at 1:100 -> ${at50.drawn} at 1:50 (expected ~${(at100.drawn / 4).toFixed(3)})`);

    // a clean plan view for the gesture checks
    await page.click("#planModeShape");
    await page.evaluate(() => {
      const v = document.getElementById("planView");
      v.scrollLeft = 0; v.scrollTop = 0; v.scrollIntoView({ block: "center" });
    });
    await new Promise((r) => setTimeout(r, 500));
    let pv = await pvRect();
    const rowsNow = () => page.$$eval("#roomsBody tr", (t) => t.length);
    const vpScale = await page.evaluate(() => window.webhvac.plan.viewer.getViewport().scale);

    // ---- (7) a tiny rectangle at 1:20 must be refused with a message, not a 0.00 m² row ----
    await page.select("#planScale", "20");
    await new Promise((r) => setTimeout(r, 400));
    const rowsBeforeTiny = await rowsNow();
    const step = Math.max(8, Math.ceil(6 * vpScale));
    await page.mouse.move(pv.x + 220, pv.y + 220);
    await page.mouse.down();
    await page.mouse.move(pv.x + 220 + step, pv.y + 220 + step, { steps: 3 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 700));
    const tiny = { rows: await rowsNow(), status: await planStatusText() };
    ok("a tiny rectangle at 1:20 is refused with a message, not a junk 0.00 m² room",
      tiny.rows === rowsBeforeTiny && /too small to make a room/i.test(tiny.status),
      `${rowsBeforeTiny} -> ${tiny.rows} rows; "${tiny.status.slice(0, 100)}"`);

    // ---- (4a) a drag released OUTSIDE the plan must not strand the gesture ----
    await page.select("#planScale", "100");
    await new Promise((r) => setTimeout(r, 400));
    await page.mouse.move(pv.x + 180, pv.y + 180);
    await page.mouse.down();
    await page.mouse.move(pv.x + 320, pv.y + 300, { steps: 5 });
    await page.mouse.move(pv.x + pv.w / 2, pv.y - 30, { steps: 4 });   // leave the plan area
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 600));
    const bandsAfterOutside = await page.$$eval(".plan-draft-box", (n) => n.length);
    await page.mouse.move(pv.x + 420, pv.y + 320, { steps: 3 });        // a plain hover, no button
    await new Promise((r) => setTimeout(r, 300));
    const bandsAfterHover = await page.$$eval(".plan-draft-box", (n) => n.length);
    ok("a drag released outside the plan clears the rubber band",
      bandsAfterOutside === 0, `${bandsAfterOutside} band(s) left behind`);
    ok("a hover after such a drag draws no phantom rubber band",
      bandsAfterHover === 0, `${bandsAfterHover} band(s) on hover`);

    // ---- (4b) a second finger must not corrupt the rectangle ----
    const twoFinger = await page.evaluate(() => {
      const view = document.getElementById("planView");
      const svg = document.querySelector(".plan-overlay");
      const r = svg.getBoundingClientRect();
      const A = { x: r.left + 160, y: r.top + 160 };
      const B = { x: r.left + 300, y: r.top + 250 };
      const C = { x: r.left + 460, y: r.top + 460 };
      const D = { x: r.left + 700, y: r.top + 640 };
      const fire = (type, id, p, buttons) => view.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: id, pointerType: "touch",
        isPrimary: id === 11, clientX: p.x, clientY: p.y, buttons,
      }));
      fire("pointerdown", 11, A, 1);
      fire("pointermove", 11, B, 1);
      fire("pointerdown", 12, C, 1);      // second finger
      fire("pointermove", 12, D, 1);      // must be ignored
      fire("pointerup", 12, D, 0);        // must NOT end the first finger's gesture
      fire("pointerup", 11, B, 0);
      const vp = window.webhvac.plan.viewer.getViewport();
      const toPdf = (p) => { const [x, y] = vp.convertToPdfPoint(p.x - r.left, p.y - r.top); return { x, y }; };
      return { a: toPdf(A), b: toPdf(B), d: toPdf(D) };
    });
    await new Promise((r) => setTimeout(r, 300));
    const fingerRoom = await page.evaluate(() => {
      const rs = window.webhvac.state.rooms;
      const r = rs[rs.length - 1];
      return r && r.rect ? { w: r.rect.w, h: r.rect.h, name: r.name } : null;
    });
    const expectW = Math.abs(twoFinger.b.x - twoFinger.a.x);
    const expectH = Math.abs(twoFinger.b.y - twoFinger.a.y);
    const badW = Math.abs(twoFinger.d.x - twoFinger.a.x);
    ok("a two-finger touch makes the FIRST finger's rectangle, not a garbage one",
      !!fingerRoom && Math.abs(fingerRoom.w - expectW) < 0.6 && Math.abs(fingerRoom.h - expectH) < 0.6
        && Math.abs(fingerRoom.w - badW) > 5,
      fingerRoom ? `rect ${fingerRoom.w}x${fingerRoom.h}; wanted ~${expectW.toFixed(2)}x${expectH.toFixed(2)} (garbage would be ~${badW.toFixed(2)})` : "no room drawn");

    // ---- (5) a drag that replaces an in-progress polygon must say so ----
    // SETUP: the automatic place-and-trace left this freshly loaded sheet covered in locators, and a
    // shape-mode click that lands inside an existing room selects it instead of placing a corner (by
    // design, overlay.js). Clear that geometry so the fixed clicks below land on empty paper and the
    // draft ring forms. Assertions still run against the real drawing code.
    await page.evaluate(() => {
      for (const r of window.webhvac.state.rooms) {
        delete r.poly; delete r.polyPage; delete r.polyDrawing; delete r.polyArea; delete r.polyRatio;
        delete r.rect; delete r.rectDrawing;
      }
      window.webhvac.renderAll();
    });
    await new Promise((r) => setTimeout(r, 300));
    await page.click("#planModeShape");
    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await new Promise((r) => setTimeout(r, 400));
    pv = await pvRect();
    const base = { x: pv.x + 240, y: pv.y + 240 };
    await page.mouse.click(base.x, base.y);
    await page.mouse.click(base.x + 70, base.y);
    await page.mouse.click(base.x + 70, base.y + 70);
    await new Promise((r) => setTimeout(r, 300));
    const draftRings = await page.$$eval(".plan-draft-ring", (n) => n.length);
    ok("a multi-corner polygon is in progress before the drag", draftRings >= 1, `${draftRings} draft ring(s)`);
    await page.mouse.move(base.x + 140, base.y + 140);
    await page.mouse.down();
    await page.mouse.move(base.x + 300, base.y + 260, { steps: 5 });
    await page.mouse.move(base.x + 380, base.y + 330, { steps: 5 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 700));
    const polyStatus = await planStatusText();
    ok("a drag that replaces an in-progress polygon says the corners were dropped",
      /replaced the shape you were drawing/i.test(polyStatus), polyStatus.slice(0, 150));

    // ---- (9) a draw dropped as a duplicate must say something ----
    // Draw once, rename it to the name the NEXT draw will be auto-named, then draw the SAME
    // rectangle again: addRooms de-duplicates on name + level + area, so it must say so.
    await page.click("#planModeShape");
    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await new Promise((r) => setTimeout(r, 400));
    pv = await pvRect();
    const rowsBeforeDup = await rowsNow();
    await page.mouse.move(pv.x + 450, pv.y + 200);
    await page.mouse.down();
    await page.mouse.move(pv.x + 620, pv.y + 340, { steps: 6 });
    await page.mouse.move(pv.x + 700, pv.y + 400, { steps: 6 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 800));
    const rowsAfterFirst = await rowsNow();
    const dupId = await page.$eval("#roomsBody tr:last-child", (tr) => tr.getAttribute("data-id"));
    const dupLevel = await page.$eval(`#roomsBody tr[data-id="${dupId}"] input[data-field="level"]`, (i) => i.value);
    // the name planDrawRoom will give the NEXT room: (drawn, non-placed rooms) + 1
    const dupName = await page.evaluate(() => {
      const drawn = window.webhvac.state.rooms
        .filter((r) => r && r.rect && typeof r.rect.x === "number" && !(r.rect.placed === true)).length;
      return `Drawn room ${drawn + 1}`;
    });
    await page.$eval(`#roomsBody tr[data-id="${dupId}"] input[data-field="name"]`, (i, nm) => {
      i.value = nm;
      i.dispatchEvent(new Event("input", { bubbles: true }));
      i.dispatchEvent(new Event("change", { bubbles: true }));
    }, dupName);
    await new Promise((r) => setTimeout(r, 300));
    await page.mouse.move(pv.x + 450, pv.y + 200);
    await page.mouse.down();
    await page.mouse.move(pv.x + 620, pv.y + 340, { steps: 6 });
    await page.mouse.move(pv.x + 700, pv.y + 400, { steps: 6 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 800));
    const rowsAfterDup = await rowsNow();
    const dupStatus = await planStatusText();
    ok("a draw dropped as a duplicate is explained, not silently lost",
      rowsAfterFirst === rowsBeforeDup + 1 && rowsAfterDup === rowsAfterFirst
        && /already in the table/i.test(dupStatus),
      `${rowsBeforeDup} -> ${rowsAfterFirst} -> ${rowsAfterDup} rows; "${dupStatus.slice(0, 120)}" (renamed to "${dupName}", level "${dupLevel}")`);
  }

  // 12. selftest page (real pdf.js worker + engine in the browser) — independent of the sample
  // ---- Draw shape: a room with ANY number of sides ------------------------------------------------
  // The polygon path (click corner by corner) and the rectangle path (drag) share one tool now, so the
  // polygon can break without the rectangle noticing: the corners land in the overlay and nothing ever
  // commits them. A user then sees only rectangles and reports the many-sided tool as missing, which
  // is exactly what happened. These checks pin the whole flow AND the on-screen feedback that makes it
  // discoverable.
  await page.goto(BASE + "app.html", { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector("#btnSample", { timeout: 30000 });
  await page.click("#btnSample");
  await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 5, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 2500));
  // SETUP: this page already carried rooms from earlier blocks, and the automatic place-then-trace
  // leaves the loaded sheet covered in locators and outlines. A shape-mode click that lands INSIDE an
  // existing room selects it and starts no shape (by design — overlay.js), so the fixed click points
  // below would hit those rooms and draw nothing. Wait for the automatic run to finish, then clear the
  // geometry so these checks exercise the polygon tool against empty paper. (Setup only — every
  // assertion below still runs against the real code.)
  await page.waitForFunction(() => !window.webhvac.state.ui.busy, { timeout: 180000, polling: 300 }).catch(() => {});
  await waitIdle();
  await page.evaluate(() => {
    for (const r of window.webhvac.state.rooms) {
      delete r.poly; delete r.polyPage; delete r.polyDrawing; delete r.polyArea; delete r.polyRatio;
      delete r.rect; delete r.rectDrawing;
    }
    window.webhvac.renderAll();
  });
  await new Promise((r) => setTimeout(r, 400));

  const planBox = await page.evaluate(() => {
    const r = document.querySelector("#planView").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const draftCount = () => page.evaluate(() => {
    const o = window.webhvac.plan.overlay;
    return (o && typeof o.draftCount === "function") ? o.draftCount() : -1;
  });
  const hintText = () => page.evaluate(() => (document.querySelector("#planHint") || {}).textContent || "");

  const rowsBeforeShape = await page.evaluate(() => document.querySelectorAll("#roomsBody tr").length);
  const px = planBox.x + 300, py = planBox.y + 250, step = 85;
  const shapePts = [[px, py], [px + step, py], [px + step, py + step], [px, py + step]];
  for (const [x, y] of shapePts) {
    await page.mouse.click(x, y, { delay: 25 });
    await new Promise((r) => setTimeout(r, 420));
  }
  const corners = await draftCount();
  ok("Draw shape accepts a click for each corner (a multi-sided room can be drawn)", corners >= 3,
      `${corners} corner(s) after 4 clicks`);

  const hintShape = await hintText();
  ok("drawing a shape says how many corners are placed and how to finish",
      /corner/i.test(hintShape) && /(Enter|finish)/i.test(hintShape), hintShape.slice(0, 140));

  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 700));
  const chooserOpen = await page.evaluate(() => {
    const c = document.querySelector("#planShapeAssign");
    return !!c && !c.classList.contains("hidden");
  });
  ok("finishing a shape asks which room it is (the chooser appears)", chooserOpen, `chooser ${chooserOpen}`);

  // While the chooser is open the drawn shape must STAY on the drawing: choosing which room it belongs
  // to while the shape has vanished is how the wrong room gets sized.
  const pendingOnScreen = await page.evaluate(() => ({
    rings: document.querySelectorAll(".plan-pending-ring").length,
    points: (document.querySelector(".plan-pending-ring") || {}).getAttribute
      ? document.querySelector(".plan-pending-ring").getAttribute("points") : "",
    hint: ((document.querySelector("#planHint") || {}).textContent || "").slice(0, 90),
  }));
  ok("the drawn shape stays outlined while you choose which room it is",
      pendingOnScreen.rings >= 1 && /\S,\S/.test(pendingOnScreen.points || ""),
      `${pendingOnScreen.rings} outline(s) | ${pendingOnScreen.hint}`);

  await page.evaluate(() => {
    const b = document.querySelector("#planShapeAssignGo");
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 900));
  const rowsAfterShape = await page.evaluate(() => document.querySelectorAll("#roomsBody tr").length);
  ok("the drawn shape becomes a room with its own area", rowsAfterShape > rowsBeforeShape,
      `rows ${rowsBeforeShape} -> ${rowsAfterShape}`);
  const drawnArea = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#roomsBody tr")];
    const last = rows[rows.length - 1];
    const inp = last && last.querySelector("input[data-field='area']");
    return inp ? Number(inp.value) : 0;
  });
  ok("the drawn room carries a real area from the shape's own ring", drawnArea > 1, `${drawnArea} m2`);
  const pendingGone = await page.evaluate(() => document.querySelectorAll(".plan-pending-ring").length);
  ok("the pending outline is gone once the choice is made", pendingGone === 0, `${pendingGone} left`);

  // Committing a shape deliberately switches the tool to Select / edit (so the new geometry can be
  // reshaped), so a plain drag right after it would select, not draw. The user must choose Draw shape
  // again - and the app must SAY so. Asserted HERE, while the status still carries the commit message:
  // the checks below act on the shape and overwrite the status line.
  const modeAfterShape = await page.evaluate(() => {
    const r = document.querySelector("#planModeSelect");
    const s = document.querySelector(".plan-status, #planStatus, .status");
    return { selectChecked: !!(r && r.checked), status: s ? s.innerText : "" };
  });
  ok("committing a shape says the tool moved to Select / edit",
      modeAfterShape.selectChecked && /Select \/ edit/.test(modeAfterShape.status),
      `${modeAfterShape.selectChecked ? "select mode" : "NOT switched"} | ${modeAfterShape.status.replace(/\s+/g, " ").slice(0, 120)}`);

  // The shape's link to its row must be visible and correctable: drawing a shape opens the new room's
  // breakdown, so the control is right there. Picking the wrong row at the chooser was previously
  // unfixable - the link existed only in the data.
  // The same control must also be reachable from the DRAWING: the breakdown is a long scroll below the
  // plan, and the moment the link matters is the moment the shape is on screen.
  const bar = await page.evaluate(() => {
    const el = document.querySelector("#planShapeLink");
    if (!el || el.classList.contains("hidden")) return null;
    const plan = document.querySelector("#planView").getBoundingClientRect();
    const br = el.getBoundingClientRect();
    return {
      gap: Math.round(br.top - plan.bottom),
      text: el.innerText.replace(/\s+/g, " "),
      options: document.querySelectorAll("#planLinkTarget option").length,
    };
  });
  ok("a link bar sits directly under the drawing for the selected shape",
      !!bar && bar.gap >= 0 && bar.gap < 220, bar ? `${bar.gap}px below the plan | ${bar.text.slice(0, 90)}` : "no bar");
  ok("the bar lists the other rooms to link to", !!bar && bar.options > 3, `${bar ? bar.options : 0} option(s)`);

  const linkShown = await page.evaluate(() => {
    const el = document.querySelector(".bd-link");
    return el ? { text: el.innerText.replace(/\s+/g, " "), options: document.querySelectorAll("#bdShapeTarget option").length } : null;
  });
  ok("a room with a drawn shape shows which row the shape belongs to",
      !!linkShown && /belongs to/.test(linkShown.text), linkShown ? linkShown.text.slice(0, 110) : "no link block");
  ok("the link control lists the other rooms", !!linkShown && linkShown.options > 3,
      `${linkShown ? linkShown.options : 0} option(s)`);

  const moveTarget = await page.evaluate(() => {
    const sel = document.querySelector("#bdShapeTarget");
    if (!sel) return null;
    // skip the leading "Choose a room…" row (empty value): a real target has an id
    const opt = [...sel.options].find((o) => o.value && !/Drawn room/.test(o.textContent));
    sel.value = opt.value;
    return { id: opt.value, label: opt.textContent.trim() };
  });
  await page.evaluate(() => { const b = document.querySelector("#bdShapeMove"); if (b) b.click(); });
  await new Promise((r) => setTimeout(r, 1000));
  const moved = await page.evaluate((id) => {
    const rooms = window.webhvac.state.rooms;
    const to = rooms.find((r) => r.id === id);
    const status = ((document.querySelector(".plan-status,#planStatus,.status") || {}).innerText || "").replace(/\s+/g, " ");
    return {
      reported: /now belongs to/.test(status),
      toHasShape: !!(to && Array.isArray(to.poly) && to.poly.length > 2),
      toArea: to ? Number(to.area) : 0,
      strayDrawn: rooms.filter((r) => /^Drawn room/.test(r.name) && Array.isArray(r.poly)).length,
      status: status.slice(0, 150),
    };
  }, moveTarget ? moveTarget.id : "");
  ok("the shape can be moved to another row from the breakdown",
      moved.reported && moved.toHasShape && moved.toArea > 1,
      `${moveTarget ? moveTarget.label : "?"} -> area ${moved.toArea} | ${moved.status}`);
  ok("the row the shape left stops claiming it", moved.strayDrawn === 0, `${moved.strayDrawn} stray shape(s)`);

  // ... and the shape can be taken off a row entirely.
  await page.evaluate(() => { const b = document.querySelector("#bdShapeDetach"); if (b) b.click(); });
  await new Promise((r) => setTimeout(r, 900));
  const detached = await page.evaluate((id) => {
    const to = window.webhvac.state.rooms.find((r) => r.id === id);
    const status = ((document.querySelector(".plan-status,#planStatus,.status") || {}).innerText || "").replace(/\s+/g, " ");
    return { ringGone: !(to && Array.isArray(to.poly)), said: /shape was removed/i.test(status), status: status.slice(0, 130) };
  }, moveTarget ? moveTarget.id : "");
  ok("a shape can be removed from a row, and the room stops claiming its area",
      detached.ringGone && detached.said, detached.status);

  await page.click("#planModeShape");
  await new Promise((r) => setTimeout(r, 400));

  // The rectangle gesture must survive all of this: one tool, two gestures.
  const boxForDrag = await page.evaluate(() => {
    const r = document.querySelector("#planView").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(boxForDrag.x + boxForDrag.w * 0.62, boxForDrag.y + boxForDrag.h * 0.30);
  await page.mouse.down();
  await page.mouse.move(boxForDrag.x + boxForDrag.w * 0.72, boxForDrag.y + boxForDrag.h * 0.42, { steps: 12 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 900));
  const rowsAfterDragCheck = await page.evaluate(() => document.querySelectorAll("#roomsBody tr").length);
  ok("a drag still adds a plain rectangle", rowsAfterDragCheck > rowsAfterShape,
      `rows ${rowsAfterShape} -> ${rowsAfterDragCheck}`);

  // ---- Clicking a table ROW highlights its room on the plan (label-only rooms included) -----------
  // A room read from a PDF label carries only `at` (where the sheet names it, PDF space) and no traced
  // ring or drawn rect, so clicking its table row used to draw nothing at all. It now gets a FOCUS
  // POINTER at that point: a dashed ring + crosshair + name, pointer-events:none, never a drawing
  // target. A row whose room already has a drawn/placed shape uses the existing selected outline
  // instead (no second mark).
  {
    // fresh, deterministic state: the synthetic sample with nothing drawn or placed
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.goto(SYNTH, { waitUntil: "networkidle2", timeout: 60000 });
    await page.click("#btnSample");
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100,
      { timeout: 120000, polling: 400 });
    await page.waitForFunction(() => { const c = document.getElementById("planCanvas"); return c && c.width > 400; },
      { timeout: 60000, polling: 400 });
    await new Promise((r) => setTimeout(r, 1000));

    const pickRow = (wantGeometry) => page.evaluate((want) => {
      const pageNow = +(document.getElementById("planPage").textContent.trim()) || 1;
      const rooms = window.webhvac.state.rooms;
      for (const tr of document.querySelectorAll("#roomsBody tr")) {
        const r = rooms[+tr.dataset.idx];
        if (!r) continue;
        const hasGeom = !!(Array.isArray(r.poly) && r.poly.length > 2)
          || !!(r.rect && typeof r.rect.x === "number");
        if (hasGeom === want && Number(r.page != null ? r.page : 1) === pageNow
            && (want || (r.at && Number.isFinite(r.at.x)))) {
          return { id: tr.dataset.id, name: r.name };
        }
      }
      return null;
    }, wantGeometry);
    // Click a CELL, never an <input>: onTableClick ignores input/select/button/label so the caret can
    // be placed while editing (clicking the name input does NOT open the row).
    const clickRowCell = (id) => page.evaluate((rid) => {
      const tr = document.querySelector(`#roomsBody tr[data-id="${rid}"]`);
      const cell = tr && (tr.querySelector(".v-total") || tr.querySelector("td"));
      if (cell) cell.click();
    }, id);

    // SETUP: the automatic place-and-trace now gives EVERY room a locator box, so no label-only room is
    // left to test. Build one deterministically: keep a room's printed label position (`at`) and strip
    // the geometry the automatic run added from all rooms — exactly the PDF-label room this section is
    // about. The assertions below still test the real focus-mark behaviour for that room.
    await page.evaluate(() => {
      const rs = window.webhvac.state.rooms;
      for (const r of rs) {
        delete r.poly; delete r.polyPage; delete r.polyDrawing; delete r.polyArea; delete r.polyRatio;
        delete r.rect; delete r.rectDrawing;
      }
      window.webhvac.renderAll();
    });
    await new Promise((r) => setTimeout(r, 300));

    const focus = await pickRow(false);
    ok("a plan-loaded room with a label position but no drawn shape is present in the table",
      !!focus, focus ? focus.name : "none");

    // (a)+(b) click the row: the breakdown opens AND exactly one focus mark appears for that room
    await clickRowCell(focus.id);
    await new Promise((r) => setTimeout(r, 1200));
    const opened = await page.evaluate((rid) => {
      const marks = document.querySelectorAll('#planView [data-shape="focus"]');
      const g = marks[0] || null;
      const box = g ? g.getBoundingClientRect() : null;
      const pv = document.getElementById("planView").getBoundingClientRect();
      return {
        detailOpen: !document.getElementById("detailPanel").classList.contains("hidden"),
        openId: window.webhvac.state.ui.openId,
        count: marks.length,
        roomId: g ? g.getAttribute("data-room-id") : null,
        page: g ? g.getAttribute("data-page") : null,
        selected: g ? g.getAttribute("data-selected") : null,
        name: g ? (g.textContent || "").trim() : "",
        onPage: +(document.getElementById("planPage").textContent.trim()),
        inside: !!box && box.left >= pv.left - 1 && box.right <= pv.right + 1
          && box.top >= pv.top - 1 && box.bottom <= pv.bottom + 1,
      };
    }, focus.id);
    ok("clicking a room row opens its breakdown and selects that row",
      opened.detailOpen && opened.openId === focus.id,
      `openId ${opened.openId}, panel open ${opened.detailOpen}`);
    ok("exactly one focus mark appears for the row's room, on its page, marked selected",
      opened.count === 1 && opened.roomId === focus.id && opened.selected === "true"
        && opened.page === String(opened.onPage) && opened.inside,
      `${opened.count} mark(s), room ${opened.roomId} page ${opened.page} (on ${opened.onPage}), name "${opened.name}", inside plan ${opened.inside}`);

    // (c) clicking the same row again closes the panel and leaves no mark behind
    await clickRowCell(focus.id);
    await new Promise((r) => setTimeout(r, 900));
    const closed = await page.evaluate(() => ({
      detailHidden: document.getElementById("detailPanel").classList.contains("hidden"),
      openId: window.webhvac.state.ui.openId,
      count: document.querySelectorAll('#planView [data-shape="focus"]').length,
    }));
    ok("clicking the row again closes the breakdown and removes the focus mark",
      closed.detailHidden && closed.openId == null && closed.count === 0,
      `panel hidden ${closed.detailHidden}, openId ${closed.openId}, ${closed.count} mark(s)`);

    // (d) a room that ALREADY has a drawn/placed shape uses the existing selected outline, not a
    //     second focus mark (no double outline)
    await waitIdle();
    await page.click("#planPlaceAll");
    await new Promise((r) => setTimeout(r, 2500));
    const placedPick = await pickRow(true);
    await clickRowCell(placedPick.id);
    await new Promise((r) => setTimeout(r, 1200));
    const doubled = await page.evaluate(() => ({
      focus: document.querySelectorAll('#planView [data-shape="focus"]').length,
      selected: document.querySelectorAll('#planView .plan-room.is-selected').length,
    }));
    ok("a room that already has a drawn shape keeps the existing selected outline, with no focus mark",
      doubled.focus === 0 && doubled.selected === 1,
      `${doubled.focus} focus mark(s), ${doubled.selected} selected outline(s)`);

    // leave the project as it was found
    await page.click("#planPlaceClear");
    await new Promise((r) => setTimeout(r, 1200));
  }

  // 15. fresh, empty project (UX pass): the quick-start strip is shown, the totals bar is hidden,
  //     the Construction details start closed, and the print/CSV buttons are disabled and say why.
  //     Checked on a genuinely empty load (localStorage cleared).
  {
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.goto(URL_, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 800));
    const empty = await page.evaluate(() => {
      const bar = document.getElementById("totalsBar");
      const qs = document.getElementById("quickStart");
      const det = document.querySelector("details.adv");
      const csv = document.getElementById("btnCsv");
      const print = document.getElementById("btnPrint");
      return {
        rooms: document.querySelectorAll("#roomsBody tr").length,
        barHidden: !bar || bar.hasAttribute("hidden"),
        qsVisible: !!qs && !qs.hasAttribute("hidden") && getComputedStyle(qs).display !== "none",
        detailsOpen: det ? det.hasAttribute("open") : null,
        csvDisabled: !!csv && csv.disabled,
        csvTitle: csv ? csv.title : "",
        printDisabled: !!print && print.disabled,
      };
    });
    ok("a fresh empty project shows the quick-start strip", empty.rooms === 0 && empty.qsVisible,
      `rows ${empty.rooms}, quickStart visible ${empty.qsVisible}`);
    ok("the totals bar is hidden when nothing is included in the load", empty.barHidden, `hidden=${empty.barHidden}`);
    ok("the Construction details start closed on a fresh load", empty.detailsOpen === false, `open=${empty.detailsOpen}`);
    ok("the print/CSV buttons are disabled on an empty project and say why",
      empty.csvDisabled && empty.printDisabled && empty.csvTitle === "Add rooms first",
      `csv disabled=${empty.csvDisabled} title="${empty.csvTitle}"`);
  }

  // 16. Selection works BOTH ways, Delete from the plan, one-step undo, and Clear-all unloading the
  //     drawing. Each fix gets its own fresh page so nothing here disturbs the checks above.
  {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const rows = () => page.evaluate(() => document.querySelectorAll("#roomsBody tr").length);
    // Re-read the element box immediately before every click: a click outside the viewport silently
    // does nothing, which once cost two probe cycles.
    const planRoomBox = () => page.evaluate(() => {
      for (const g of document.querySelectorAll("#planView .plan-room")) {
        if (g.getAttribute("data-shape") === "focus") continue;
        const b = g.querySelector(".plan-room-box");
        if (!b) continue;
        const r = b.getBoundingClientRect();
        if (r.width > 5 && r.height > 5 && r.top >= 4 && r.bottom <= innerHeight - 4
            && r.left >= 0 && r.right <= innerWidth) {
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
            id: g.getAttribute("data-room-id"), shape: g.getAttribute("data-shape") };
        }
      }
      return null;
    });
    const loadSyntheticWithRects = async () => {
      // Clear the saved project first so the plan mode really is the SHIPPED DEFAULT (Draw shape):
      // a previous section may have left "Select / edit" in localStorage, which would load instead.
      await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
      await page.goto(SYNTH, { waitUntil: "networkidle2", timeout: 90000 });
      await page.waitForSelector("#btnSample", { timeout: 30000 });
      await page.click("#btnSample");
      await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100, { timeout: 120000 });
      await settle(3000);
      await waitIdle();
    await page.click("#planPlaceAll");
      await settle(3500);
    };

    // ---- (i) Select/edit: a click on a room's box marks its ROW selected AND scrolls it into view ----
    await loadSyntheticWithRects();
    await page.click("#planModeSelect");
    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await settle(500);
    // Put the room list at its BOTTOM so a clicked room's row (near the top of a 159-row table) is
    // far outside the table's visible window: this is the scroll the fix must perform (before it, a
    // plan click left the row wherever it happened to be).
    await page.evaluate(() => { const c = document.querySelector(".table-rooms"); c.scrollTop = c.scrollHeight; });
    await settle(300);
    const contBefore = await page.evaluate(() => Math.round(document.querySelector(".table-rooms").scrollTop));
    let box = await planRoomBox();
    const scrollYBefore = await page.evaluate(() => Math.round(scrollY));
    await page.mouse.click(box.x, box.y);
    await settle(400);
    const sel1 = await page.evaluate(() => {
      const tr = document.querySelector("#roomsBody tr.selected");
      if (!tr) return { openId: window.webhvac.state.ui.openId, none: true };
      const c = document.querySelector(".table-rooms");
      const cr = c.getBoundingClientRect(), rr = tr.getBoundingClientRect();
      return { openId: window.webhvac.state.ui.openId, count: document.querySelectorAll("#roomsBody tr.selected").length,
        id: tr.getAttribute("data-id"), flash: tr.classList.contains("row-flash"),
        // within the room table's own visible area (the drawing must NOT move to achieve this)
        inTable: rr.top >= cr.top - 1 && rr.bottom <= cr.bottom + 1,
        inWindow: rr.top >= 0 && rr.bottom <= innerHeight + 1,
        contScrollTop: Math.round(c.scrollTop), top: Math.round(rr.top), bottom: Math.round(rr.bottom) };
    });
    ok("clicking a room's box in Select/edit marks its table row selected",
      !!sel1.openId && sel1.count === 1 && sel1.id === sel1.openId, JSON.stringify(sel1));
    ok("...and scrolls that row into view inside the room table, with a brief flash",
      sel1.inTable === true && sel1.flash === true,
      `row ${sel1.top}..${sel1.bottom} (table view), inWindow ${sel1.inWindow}, table scrollTop ${contBefore} -> ${sel1.contScrollTop}, flash ${sel1.flash}`);
    ok("the drawing does not jump when a room is picked on it (the page stays put)",
      Math.abs(await page.evaluate(() => Math.round(scrollY)) - scrollYBefore) < 2,
      `scrollY ${scrollYBefore} -> ${await page.evaluate(() => Math.round(scrollY))}`);
    // the flash is transient
    await settle(1200);
    ok("the row flash clears itself after about a second",
      await page.evaluate(() => !document.querySelector("#roomsBody tr.selected.row-flash")), "no .row-flash left");

    // ---- (ii) the DEFAULT Draw-shape mode: the same plain click selects the room ----
    await loadSyntheticWithRects();
    const shapeModeOn = await page.evaluate(() => document.getElementById("planModeShape").checked);
    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await settle(500);
    box = await planRoomBox();
    await page.mouse.click(box.x, box.y);
    await settle(400);
    const sel2 = await page.evaluate(() => {
      const tr = document.querySelector("#roomsBody tr.selected");
      const c = document.querySelector(".table-rooms");
      const cr = c.getBoundingClientRect(), rr = tr ? tr.getBoundingClientRect() : null;
      return { openId: window.webhvac.state.ui.openId, selected: document.querySelectorAll("#roomsBody tr.selected").length,
        planSelected: document.querySelectorAll("#planView .plan-room.is-selected").length,
        inTable: rr ? (rr.top >= cr.top - 1 && rr.bottom <= cr.bottom + 1) : null,
        flash: tr ? tr.classList.contains("row-flash") : null };
    });
    ok("a plain click on a room in the DEFAULT Draw-shape mode selects that room",
      shapeModeOn && !!sel2.openId && sel2.selected === 1 && sel2.planSelected >= 1, JSON.stringify(sel2));
    ok("...and its row is brought into view there too", sel2.inTable === true && sel2.flash === true, JSON.stringify(sel2));

    // ---- (iii) Delete with that selection removes exactly that room; ---- (D) one-step undo restores it
    const selId = sel2.openId;
    const rowsBeforeDel = await rows();
    const areaBefore = await page.$eval(`#roomsBody tr[data-id="${selId}"] input[data-field="area"]`, (i) => i.value);
    const idxBefore = await page.evaluate((id) => [...document.querySelectorAll("#roomsBody tr")].findIndex((t) => t.getAttribute("data-id") === id), selId);
    await page.keyboard.press("Delete");
    await settle(500);
    const del = await page.evaluate(() => {
      const u = document.getElementById("btnUndoDelete");
      return { rows: document.querySelectorAll("#roomsBody tr").length,
        openId: window.webhvac.state.ui.openId,
        undo: u ? { hidden: u.hidden, disabled: u.disabled, text: u.textContent } : null };
    });
    ok("Delete on a plan selection removes exactly that room (row count drops by one)",
      del.rows === rowsBeforeDel - 1 && del.openId === null, `${rowsBeforeDel} -> ${del.rows}`);
    ok("the Undo-delete button then appears, labelled with the room's name",
      del.undo && !del.undo.hidden && del.undo.disabled === false && new RegExp(`Undo delete \\(`).test(del.undo.text)
        && del.undo.text.length > "Undo delete ()".length,
      JSON.stringify(del.undo));
    // undo: restored at its old index with an identical area, and the button disables
    await page.evaluate(() => document.getElementById("btnUndoDelete").click());
    await settle(600);
    const undone = await page.evaluate((id) => {
      const tr = document.querySelector(`#roomsBody tr[data-id="${id}"]`);
      const u = document.getElementById("btnUndoDelete");
      return { rows: document.querySelectorAll("#roomsBody tr").length,
        back: !!tr, area: tr ? tr.querySelector('input[data-field="area"]').value : null,
        idx: [...document.querySelectorAll("#roomsBody tr")].findIndex((t) => t.getAttribute("data-id") === id),
        undoDisabled: u ? u.disabled : null };
    }, selId);
    ok("Undo puts the room back at its old position with an identical area",
      undone.back && undone.rows === rowsBeforeDel && undone.idx === idxBefore && undone.area === areaBefore,
      `row ${undone.idx} (was ${idxBefore}), area ${undone.area} (was ${areaBefore}), rows ${undone.rows}`);
    ok("the Undo-delete button disables once the undo has been used", undone.undoDisabled === true, `disabled=${undone.undoDisabled}`);

    // ---- (iv) the WORKING direction: clicking a table row still marks the room on the plan ----
    await page.click("#planModeSelect");
    await settle(300);
    const rowId = await page.evaluate(() => {
      const tr = [...document.querySelectorAll("#roomsBody tr")].find((t) =>
        document.querySelector(`#planView .plan-room[data-room-id="${t.getAttribute("data-id")}"]`));
      if (!tr) return null;
      const cell = tr.querySelector("td.c-name") || tr.querySelector("td");
      cell.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
      return tr.getAttribute("data-id");
    });
    void rowId;
    await settle(800);
    const marked = await page.evaluate(() => ({
      openId: window.webhvac.state.ui.openId,
      planSelected: document.querySelectorAll("#planView .plan-room.is-selected").length,
      focusMarks: document.querySelectorAll('#planView [data-shape="focus"]').length,
    }));
    ok("clicking a table row still marks that room on the plan",
      !!marked.openId && (marked.planSelected >= 1 || marked.focusMarks >= 1), JSON.stringify(marked));

    // ---- (v) a shape-mode click that is NOT inside a room still starts a many-corner shape ----
    await loadSyntheticWithRects();
    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await settle(500);
    const emptyPt = await page.evaluate(() => {
      const vp = window.webhvac.plan.viewer.getViewport();
      const pg = window.webhvac.plan.page;
      const rooms = window.webhvac.state.rooms;
      const inRing = (ring, pt) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if (((a.y > pt.y) !== (b.y > pt.y)) && (pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x)) c = !c;
      } return c; };
      const insideAnyRoom = (cx, cy) => {
        const q = vp.convertToPdfPoint(cx, cy);
        for (const room of rooms) {
          if (room.poly && (room.polyPage ?? room.page ?? 1) === pg && inRing(room.poly, { x: q[0], y: q[1] })) return true;
          if (room.rect && room.rect.page === pg && q[0] >= room.rect.x && q[0] <= room.rect.x + room.rect.w
              && q[1] >= room.rect.y && q[1] <= room.rect.y + room.rect.h) return true;
        }
        return false;
      };
      const r = document.getElementById("planView").getBoundingClientRect();
      for (const [fx, fy] of [[0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.5, 0.03], [0.5, 0.97], [0.5, 0.5]]) {
        const cx = Math.round(r.width * fx), cy = Math.round(r.height * fy);
        const x = Math.round(r.x + cx), y = Math.round(r.y + cy);
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        if (!insideAnyRoom(cx, cy)) return { x, y };
      }
      return null;
    });
    if (emptyPt) await page.mouse.click(emptyPt.x, emptyPt.y);
    await settle(300);
    const draft = await page.evaluate(() => ({
      n: window.webhvac.plan.overlay.draftCount(), openId: window.webhvac.state.ui.openId,
      hint: (document.getElementById("planHint") || {}).textContent || "" }));
    ok("a shape-mode click that lands in no room still starts a many-corner shape (nothing regressed)",
      !!emptyPt && draft.n >= 1 && draft.openId === null, JSON.stringify(draft));
    // leave no half-drawn shape behind
    await page.keyboard.press("Escape");
    await settle(200);

    // ---- (E) removing a shape from a row takes its OUTLINE off the sheet ----
    await page.goto(BASE + "app.html?sample=house", { waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForSelector("#btnSampleHouse", { timeout: 30000 });
    await page.click("#btnSampleHouse");
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 5, { timeout: 90000 });
    await settle(3000);
    await page.waitForFunction(() => !window.webhvac.state.ui.busy, { timeout: 120000, polling: 300 }).catch(() => {});
    await waitIdle();
    await page.click("#planTraceOutlines");
    // Wait for THIS trace to FINISH — not for "some room somewhere has a ring". The table already
    // carries rings from a previous drawing, so that condition is satisfied the moment the click lands
    // and the check would read the sheet before the trace has painted anything.
    await page.waitForFunction(() => !window.webhvac.state.ui.traceBusy
      && document.getElementById("planProgress").dataset.active === "0", { timeout: 120000, polling: 300 }).catch(() => {});
    await settle(1500);
    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await settle(400);
    const polyTarget = await page.evaluate(() => {
      for (const g of document.querySelectorAll('#planView .plan-room[data-shape="poly"]')) {
        const b = g.querySelector(".plan-room-box"); if (!b) continue;
        const r = b.getBoundingClientRect();
        if (r.width > 6 && r.height > 6 && r.top >= 4 && r.bottom <= innerHeight - 4 && r.left >= 0 && r.right <= innerWidth)
          return { id: g.getAttribute("data-room-id"), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      return null;
    });
    const polysBefore = await page.evaluate(() => document.querySelectorAll('#planView .plan-room[data-shape="poly"]').length);
    const planRoomsBefore = await page.evaluate(() => document.querySelectorAll("#planView .plan-room").length);
    if (polyTarget) { await page.mouse.click(polyTarget.x, polyTarget.y); await settle(600); }
    await page.evaluate(() => document.getElementById("planLinkDetach").click());
    await settle(900);
    const afterDetach = await page.evaluate((id) => ({
      polys: document.querySelectorAll('#planView .plan-room[data-shape="poly"]').length,
      planRooms: document.querySelectorAll("#planView .plan-room").length,
      stillPoly: !!document.querySelector(`#planView .plan-room[data-shape="poly"][data-room-id="${id}"]`),
      stillAny: !!document.querySelector(`#planView .plan-room[data-room-id="${id}"]`),
      statePoly: !!(window.webhvac.state.rooms.find((r) => r.id === id) || {}).poly,
    }), polyTarget ? polyTarget.id : "");
    ok("removing a shape from a row takes its outline OFF the drawing (repaint, not just state)",
      !!polyTarget && afterDetach.statePoly === false && afterDetach.polys === polysBefore - 1
        && afterDetach.stillPoly === false && afterDetach.stillAny === false
        && afterDetach.planRooms === planRoomsBefore - 1,
      `outlines ${polysBefore} -> ${afterDetach.polys}; plan rooms ${planRoomsBefore} -> ${afterDetach.planRooms}; room ${polyTarget ? polyTarget.id : "?"} still drawn: ${afterDetach.stillAny}`);

    // ---- (F) Clear all rooms ALSO unloads the drawing, and a reload does not bring it back ----
    // Establish the state this check needs instead of inheriting whatever the section above left:
    // a drawing on the sheet WITH a shape drawn on it, so "the shapes are gone" means something.
    await page.goto(BASE + "app.html?sample=house", { waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForSelector("#btnSampleHouse", { timeout: 30000 });
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.click("#btnSampleHouse");
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 5, { timeout: 90000 });
    await settle(2500);
    await waitIdle();
    await page.click("#planPlaceAll");
    await page.waitForFunction(() => document.querySelectorAll("#planView .plan-room").length > 0, { timeout: 60000 }).catch(() => {});
    await settle(1500);
    const beforeClear = await page.evaluate(() => ({
      rows: document.querySelectorAll("#roomsBody tr").length,
      planRooms: document.querySelectorAll("#planView .plan-room").length,
      planCardHidden: document.getElementById("planCard").classList.contains("hidden"),
    }));
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click("#btnClear");
    await settle(1600);
    const cleared = await page.evaluate(() => ({
      rows: document.querySelectorAll("#roomsBody tr").length,
      planRooms: document.querySelectorAll("#planView .plan-room").length,
      planCardHidden: document.getElementById("planCard").classList.contains("hidden"),
      page: window.webhvac.plan.page, viewer: !!window.webhvac.plan.viewer, overlay: !!window.webhvac.plan.overlay,
      fillDisabled: document.getElementById("planFillAreas").disabled,
      undoFillDisabled: document.getElementById("planFillUndo").disabled,
    }));
    ok("Clear all rooms empties the table", beforeClear.rows > 0 && cleared.rows === 0, `${beforeClear.rows} -> ${cleared.rows}`);
    ok("...and unloads the drawing: no room shapes left and the panel is back to its empty state",
      beforeClear.planRooms > 0 && cleared.planRooms === 0 && cleared.planCardHidden === true
        && !cleared.viewer && !cleared.overlay && cleared.page === 1,
      JSON.stringify(cleared));
    ok("...and the fill/undo buttons are back to their empty state",
      cleared.undoFillDisabled === true, `fill disabled=${cleared.fillDisabled}, undo-fill disabled=${cleared.undoFillDisabled}`);
    await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
    await settle(3000);
    const afterReload = await page.evaluate(() => ({
      rows: document.querySelectorAll("#roomsBody tr").length,
      planRooms: document.querySelectorAll("#planView .plan-room").length,
      planCardHidden: document.getElementById("planCard").classList.contains("hidden"),
      viewer: !!window.webhvac.plan.viewer,
    }));
    ok("a reload after Clear all does NOT restore the drawing",
      afterReload.rows === 0 && afterReload.planRooms === 0 && afterReload.planCardHidden === true && !afterReload.viewer,
      JSON.stringify(afterReload));
  }

  // 17. A PREVIOUS drawing's outlines/boxes must not be painted on a NEWLY loaded drawing. The stale
  //     shapes are reported with a COUNT and offered for removal with ONE control that deletes only the
  //     geometry — never the user's AREA. And the identity a shape records must survive a page reload,
  //     so the SAME drawing still paints its outlines after a refresh.
  {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const planRooms = () => page.evaluate(() => document.querySelectorAll("#planView .plan-room").length);

    // (v) the normal case is untouched: a fresh drawing paints its outlines + boxes, no stale control.
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.goto(BASE + "app.html?sample=house", { waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForSelector("#btnSampleHouse", { timeout: 30000 });
    await page.click("#btnSampleHouse");
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 5, { timeout: 90000 });
    await settle(3000);
    await waitIdle();
    await page.click("#planTraceOutlines");
    await page.waitForFunction(() => window.webhvac.state.rooms.some((r) => r.poly && r.poly.length > 2), { timeout: 120000 });
    await waitIdle();
    await page.click("#planPlaceAll");
    await settle(3500);
    const fresh = await page.evaluate(() => {
      const b = document.getElementById("planRemoveStaleShapes");
      return {
        planRooms: document.querySelectorAll("#planView .plan-room").length,
        polys: window.webhvac.state.rooms.filter((r) => Array.isArray(r.poly)).length,
        rects: window.webhvac.state.rooms.filter((r) => r.rect).length,
        taggedPolys: window.webhvac.state.rooms.filter((r) => Array.isArray(r.poly) && r.polyDrawing != null).length,
        // each room is drawn ONCE, as its outline when it has one and as its box otherwise
        distinct: window.webhvac.state.rooms.filter((r) => (Array.isArray(r.poly) && r.poly.length > 2) || r.rect).length,
        staleBtnShown: !!(b && !b.hidden),
      };
    });
    ok("(v) a fresh drawing paints its traced outlines and placed boxes normally (no stale control)",
      fresh.polys >= 1 && fresh.rects >= 2 && fresh.planRooms === fresh.distinct
        && fresh.taggedPolys === fresh.polys && fresh.staleBtnShown === false,
      JSON.stringify(fresh));

    // (iv) reload with the SAME drawing: the stored bytes hash to the same identity, so the restored
    //      rooms' outlines still match and are still painted.
    await page.reload({ waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForFunction(() => document.querySelectorAll("#planView .plan-room").length > 0, { timeout: 90000 })
      .catch(() => {});
    await settle(1500);
    const afterReloadSame = await page.evaluate(() => ({
      planRooms: document.querySelectorAll("#planView .plan-room").length,
      drawingId: window.webhvac.plan.drawingId,
      polys: window.webhvac.state.rooms.filter((r) => Array.isArray(r.poly)).length,
    }));
    ok("(iv) a reload of the SAME drawing still paints its traced outlines (identity survived the reload)",
      afterReloadSame.planRooms > 0 && afterReloadSame.polys > 0 && afterReloadSame.drawingId != null,
      JSON.stringify(afterReloadSame));

    // Capture what the page would actually send for this upload: hook the two transports js/usage.js
    // uses (sendBeacon, then fetch) in the live page, so the CHECK reads the real bytes, not our idea
    // of them. A blob body cannot be read from the intercepted request, which is why this is hooked
    // inside the page instead.
    await page.evaluate(() => {
      window.__upEvents = [];
      const keep = (d) => {
        try {
          if (d && typeof d.text === "function") d.text().then((t) => window.__upEvents.push(t)).catch(() => {});
          else window.__upEvents.push(String(d));
        } catch (e) { /* ignore */ }
      };
      const ob = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (u, d) => { try { if (String(u).includes("/api/event")) keep(d); } catch (e) {} return ob ? ob(u, d) : true; };
      const of = window.fetch;
      window.fetch = function (u, o) {
        try { if (String(u).includes("/api/event") && o && o.body) keep(o.body); } catch (e) {}
        return of.apply(this, arguments);
      };
    });

    // (i)+(ii) upload a DIFFERENT drawing through the page's own file input.
    const input = await page.$('input[type="file"]');
    await input.uploadFile("D:/webhvac/tests/samples/sample-plan.pdf");
    await page.waitForFunction(() => !window.webhvac.state.ui.busy, { timeout: 120000 }).catch(() => {});
    await settle(2500);
    const afterUpload = await page.evaluate(() => {
      const id = window.webhvac.plan.drawingId;
      const staleOf = (r) => (Array.isArray(r.poly) && r.polyDrawing != null && String(r.polyDrawing) !== String(id))
        || (r.rect && r.rectDrawing != null && String(r.rectDrawing) !== String(id));
      const b = document.getElementById("planRemoveStaleShapes");
      return {
        planRooms: document.querySelectorAll("#planView .plan-room").length,
        stale: window.webhvac.state.rooms.filter(staleOf).length,
        statusText: (document.getElementById("planStatus") || {}).textContent || "",
        btn: b ? { hidden: b.hidden, disabled: b.disabled, text: b.textContent } : null,
      };
    });
    ok("(i) a previous drawing's outlines/boxes are NOT painted on the newly loaded drawing",
      afterUpload.planRooms === 0, `${afterUpload.planRooms} plan room(s) painted (expected 0)`);
    ok("(ii) the status line reports the number of stale shapes",
      afterUpload.stale > 0 && afterUpload.statusText.includes(String(afterUpload.stale)),
      `stale ${afterUpload.stale}, status "${afterUpload.statusText}"`);

    // (iii) THE UPLOAD COUNTER: an upload may travel as coarse bands only. The file, its name, its
    // path and its exact size must never leave the page - the drawing is the one thing the site
    // promises not to send, and a "size counter" is the easiest way to break that promise by accident.
    await settle(3000);
    const uploadEvents = (await page.evaluate(() => (window.__upEvents || []).slice()))
      .map((t) => { try { return JSON.parse(t); } catch (e) { return { e: "(unparsed)" }; } });
    const ups = uploadEvents.filter((x) => x.e === "plan_upload");
    const upP = (ups[0] || {}).p || {};
    const upFlat = JSON.stringify(uploadEvents);
    ok("(iii) the upload counts exactly one plan_upload, as a size band (never the file)",
      ups.length === 1 && ["under-1mb", "1-5mb", "5-20mb", "over-20mb"].includes(upP.sizeBucket)
        && ["1-2", "3-5", "6-12", "over-12"].includes(upP.pages)
        && ["under-25", "25-75", "76-150", "over-150"].includes(upP.rooms),
      `count ${ups.length}, bands ${upP.sizeBucket}/${upP.pages}/${upP.rooms}`);
    ok("(iii) no file name, no path and no exact byte count anywhere in what the page sent",
      !/\.pdf/i.test(upFlat) && !/sample-plan/i.test(upFlat) && !/[A-Za-z]:[\\/]/.test(upFlat) && !/\d{5,}/.test(upFlat),
      upFlat.slice(0, 150));
    ok("(ii) the remove control appears, labelled with that count",
      !!afterUpload.btn && !afterUpload.btn.hidden && afterUpload.btn.disabled === false
        && afterUpload.btn.text.includes(String(afterUpload.stale)) && /old drawing/i.test(afterUpload.btn.text),
      JSON.stringify(afterUpload.btn));

    // (iii) press it: the stale geometry goes, every room's AREA stays exactly.
    const staleAreas = await page.evaluate(() => {
      const id = window.webhvac.plan.drawingId;
      const out = {};
      for (const r of window.webhvac.state.rooms) {
        const pst = Array.isArray(r.poly) && r.polyDrawing != null && String(r.polyDrawing) !== String(id);
        const rst = r.rect && r.rectDrawing != null && String(r.rectDrawing) !== String(id);
        if (pst || rst) out[r.id] = r.area;
      }
      return out;
    });
    const staleIds = Object.keys(staleAreas);
    const btnBox = await page.evaluate(() => {
      const b = document.getElementById("planRemoveStaleShapes");
      b.scrollIntoView({ block: "center" });
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    await page.mouse.click(btnBox.x, btnBox.y);
    await settle(1500);
    const afterRemove = await page.evaluate((ids) => {
      const id = window.webhvac.plan.drawingId;
      const rooms = window.webhvac.state.rooms;
      const areas = {};
      for (const rid of ids) { const r = rooms.find((x) => x.id === rid); if (r) areas[rid] = r.area; }
      const b = document.getElementById("planRemoveStaleShapes");
      return {
        areas,
        stillStale: rooms.filter((r) => (Array.isArray(r.poly) && r.polyDrawing != null && String(r.polyDrawing) !== String(id))
          || (r.rect && r.rectDrawing != null && String(r.rectDrawing) !== String(id))).length,
        anyPoly: rooms.filter((r) => Array.isArray(r.poly)).length,
        anyRect: rooms.filter((r) => r.rect).length,
        planRooms: document.querySelectorAll("#planView .plan-room").length,
        btnHidden: b ? b.hidden : null,
      };
    }, staleIds);
    const areasKept = staleIds.length > 0 && staleIds.every((id) => afterRemove.areas[id] === staleAreas[id]);
    ok("(iii) pressing it clears the stale outlines/boxes while every room's AREA is unchanged",
      areasKept && afterRemove.stillStale === 0 && afterRemove.btnHidden === true,
      `areas kept ${areasKept}; stale left ${afterRemove.stillStale}; plan rooms ${afterRemove.planRooms}; button hidden ${afterRemove.btnHidden}`);
  }

  // ---- JOB 1: one-click "trace again at the implied scale" --------------------------------------
  // When a drawing's own outlines imply a different drawing scale, a one-click control appears beside
  // the plan buttons, sets that scale and re-traces more rooms; it is hidden when the scale already
  // matches, and after it has been used a second mismatch is only REPORTED (never offered again).
  // ---- JOB 2: a selected BOX becomes a POLYGON by dragging the MIDDLE of an edge -----------------
  // The room then carries poly + polyPage/polyDrawing and no rect, draws as data-shape="poly", keeps a
  // typed area, and its corner grips still resize a plain box.
  {
    const sleepT = (ms) => new Promise((r) => setTimeout(r, ms));
    const readFix = () => page.evaluate(() => {
      const box = document.getElementById("planScaleFix");
      const btn = document.getElementById("planScaleFixBtn");
      const r = box ? box.getBoundingClientRect() : null;
      return {
        shown: !!(box && !box.classList.contains("hidden") && btn),
        btn: btn ? btn.textContent.trim() : null,
        scale: document.getElementById("planScale").value,
        status: (document.getElementById("planStatus") || {}).textContent.replace(/\s+/g, " ").trim(),
        polys: window.webhvac.state.rooms.filter((x) => Array.isArray(x.poly) && x.poly.length > 2).length,
        onScreen: !!r && r.top < window.innerHeight && r.bottom > 0,
      };
    });
    const traceAndWait = async () => {
      await waitIdle();
    await page.click("#planTraceOutlines");
      await page.waitForFunction(() => {
        const s = document.getElementById("planStatus");
        return s && !/Tracing the plan/.test(s.textContent) && /point to|outline|traced/i.test(s.textContent);
      }, { timeout: 150000, polling: 400 }).catch(() => {});
      await sleepT(700);
    };
    const roomState = (id) => page.evaluate((rid) => {
      const room = window.webhvac.state.rooms.find((x) => x.id === rid);
      if (!room) return null;
      const g = document.querySelector(`.plan-room[data-room-id="${rid}"]`);
      const cell = document.querySelector(`tr[data-id="${rid}"] input[data-field="area"]`);
      return {
        hasRect: !!room.rect, rect: room.rect || null,
        hasPoly: Array.isArray(room.poly), polyLen: Array.isArray(room.poly) ? room.poly.length : 0,
        polyPage: room.polyPage, polyDrawing: room.polyDrawing, source: room.source,
        area: room.area, cell: cell ? Number(cell.value) : null,
        shape: g ? g.getAttribute("data-shape") : null,
        cornerHandles: document.querySelectorAll(".plan-room-handle").length,
        edgeHandles: document.querySelectorAll(".plan-edge-handle").length,
        status: (document.getElementById("planStatus") || {}).textContent.replace(/\s+/g, " ").trim(),
      };
    }, id);
    const boxOf = (id) => page.evaluate((rid) => {
      const g = document.querySelector(`.plan-room[data-room-id="${rid}"]`);
      const s = g ? g.querySelector(".plan-room-box") : null;
      if (!s) return null;
      const r = s.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, id);
    // Switching mode: the site's sticky header can cover the plan toolbar's radios, so a raw click
    // can land on the header. Scroll the toolbar into the middle, click, and verify the mode took —
    // falling back to the radio's own click handler if a covering element swallowed it.
    const setMode = async (which) => {
      const want = which === "select" ? "select" : "shape";
      const id = want === "select" ? "#planModeSelect" : "#planModeShape";
      await page.evaluate(() => {
        const tb = document.querySelector(".plan-toolbar");
        if (tb) tb.scrollIntoView({ block: "center" });
      });
      await sleepT(250);
      await page.click(id).catch(() => {});
      await sleepT(200);
      const now = await page.evaluate(() => window.webhvac.state.ui.planMode);
      if (now !== want) {
        await page.evaluate((w) => document.getElementById(
          w === "select" ? "planModeSelect" : "planModeShape").click(), want);
        await sleepT(200);
      }
    };
    const centerPlan = async () => {
      await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
      await sleepT(300);
    };
    const drawRect = async (fx = 0.08, fy = 0.45, wf = 0.20, hf = 0.20) => {
      await setMode("shape");
      await centerPlan();
      const b = await page.$eval("#planView", (e) => {
        const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const sx = b.x + fx * b.w, sy = b.y + fy * b.h;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + wf * b.w, sy + hf * b.h, { steps: 8 });
      await page.mouse.up();
      await sleepT(800);
      return page.$eval("#roomsBody tr:last-child", (tr) => tr.getAttribute("data-id"));
    };
    const selectRoom = async (id) => {
      await setMode("select");
      await centerPlan();
      const r = await boxOf(id);            // re-read the box right before the click
      await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
      await sleepT(400);
    };

    // Establish our OWN state: an empty table, then the synthetic sample (a deterministic drawing).
    await page.evaluate(() => localStorage.clear());
    await page.goto(SYNTH, { waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForFunction(() => !window.webhvac.state.ui.busy, { timeout: 60000 }).catch(() => {});
    const rows0 = await page.$$eval("#roomsBody tr", (r) => r.length);
    if (rows0 === 0) await page.click("#btnSample");
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100,
      { timeout: 120000, polling: 400 });
    await page.waitForFunction(() => { const c = document.getElementById("planCanvas"); return c && c.width > 400; },
      { timeout: 60000, polling: 400 }).catch(() => {});
    await sleepT(900);
    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await page.click("#planFit");
    await sleepT(1200);

    // (JOB 1-i) a WRONG scale finds almost nothing → the one-click fix appears, labelled with the
    //           implied numbers, and pressing it sets that scale and traces MORE rooms.
    await page.select("#planScale", "500");
    await sleepT(400);
    const polysBefore = (await readFix()).polys;
    await traceAndWait();
    await page.evaluate(() => { const b = document.getElementById("planScaleFix"); if (b) b.scrollIntoView({ block: "center" }); });
    await sleepT(300);
    const fix = await readFix();
    const mWanted = (fix.btn || "").match(/1:(\d+)/);
    const wantedDenom = mWanted ? mWanted[1] : null;
    ok("JOB1 (i) a drawing whose outlines imply another scale offers the fix, labelled with the implied scale",
      fix.shown && fix.onScreen && !!wantedDenom && wantedDenom !== "500",
      `button "${fix.btn}", on screen ${fix.onScreen}, status "${(fix.status || "").slice(0, 110)}"`);

    if (wantedDenom) {
      const btnBox = await page.evaluate(() => {
        const b = document.getElementById("planScaleFixBtn");
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      await page.mouse.click(btnBox.x, btnBox.y);
      await page.waitForFunction(() => {
        const s = document.getElementById("planStatus");
        return s && !/Tracing the plan/.test(s.textContent) && /real outline|point to|traced/i.test(s.textContent);
      }, { timeout: 150000, polling: 400 }).catch(() => {});
      await sleepT(1400);
      const afterFix = await readFix();
      ok("JOB1 (i) pressing it sets the offered scale and traces more rooms",
        afterFix.scale === wantedDenom && afterFix.polys > polysBefore,
        `scale 1:${afterFix.scale} (offered 1:${wantedDenom}); outlines ${polysBefore} -> ${afterFix.polys}`);

      // (JOB 1-ii) with the scale now matching, a fresh trace does not show the control at all.
      await traceAndWait();
      const matched = await readFix();
      ok("JOB1 (ii) the control is hidden when the implied scale matches the panel's",
        matched.shown === false,
        `fix shown ${matched.shown}, status "${(matched.status || "").slice(0, 110)}"`);

      // (JOB 1-iii) after use, set the scale wrong AGAIN and trace: the control must NOT return, but
      //             the status line must still report the scale the outlines point to.
      await page.select("#planScale", "500");
      await sleepT(400);
      await traceAndWait();
      const reused = await readFix();
      ok("JOB1 (iii) it does not come back after use — the mismatch is only reported in the status line",
        reused.shown === false && /point to about 1:/i.test(reused.status),
        `fix shown ${reused.shown}, status "${(reused.status || "").slice(0, 150)}"`);
    } else {
      ok("JOB1 (i) pressing it sets the offered scale and traces more rooms", false, "no scale on the button");
      ok("JOB1 (ii) the control is hidden when the implied scale matches the panel's", false, "no fix offered");
      ok("JOB1 (iii) it does not come back after use — the mismatch is only reported in the status line", false, "no fix offered");
    }

    // Back to the drawing's own scale and a clean sheet so the geometry checks below are unambiguous.
    await page.select("#planScale", "100");
    await sleepT(400);
    await page.click("#planTraceClear").catch(() => {});
    await page.click("#planPlaceClear").catch(() => {});
    await sleepT(600);

    // (JOB 2-vi) a plain box still resizes by its four corner grips (the edge gesture did not replace it).
    {
      const id = await drawRect(0.08, 0.42);
      await selectRoom(id);
      const sel = await roomState(id);
      const before = await boxOf(id);
      await page.mouse.move(before.x + before.w, before.y + before.h);   // the SE corner
      await page.mouse.down();
      await page.mouse.move(before.x + before.w + 90, before.y + before.h + 70, { steps: 8 });
      await page.mouse.up();
      await sleepT(800);
      const after = await boxOf(id);
      const st = await roomState(id);
      ok("JOB2 (vi) a plain box still resizes by its corner grips",
        sel.cornerHandles === 4 && st.hasPoly === false && st.hasRect
          && after.w > before.w + 20 && after.h > before.h + 20,
        `corner grips ${sel.cornerHandles}, ${before.w.toFixed(0)}x${before.h.toFixed(0)} -> ` +
        `${after.w.toFixed(0)}x${after.h.toFixed(0)}, poly ${st.hasPoly}`);
    }

    // (JOB 2-iv) dragging the MIDDLE of an edge turns the box into a polygon: poly + tags, no rect,
    //            drawn as data-shape="poly", with one more corner than the four the box had.
    {
      const id = await drawRect(0.36, 0.42, 0.17, 0.15);
      await selectRoom(id);
      const st0 = await roomState(id);
      const b = await boxOf(id);                 // re-read right before the drag
      await page.mouse.move(b.x + b.w / 2, b.y); // the TOP edge middle
      await page.mouse.down();
      await page.mouse.move(b.x + b.w / 2 + 44, b.y - 60, { steps: 8 });
      await page.mouse.up();
      await sleepT(1000);
      const st = await roomState(id);
      ok("JOB2 (iv) an edge-middle drag converts the box into a polygon (poly, no rect, data-shape=poly)",
        st.hasPoly && !st.hasRect && st.shape === "poly" && st.polyLen === 5
          && st.polyPage >= 1 && st.polyDrawing != null && st0.edgeHandles === 4,
        `corners ${st.polyLen} (was a 4-corner box), rect ${st.hasRect}, shape ${st.shape}, ` +
        `page ${st.polyPage}, drawing ${st.polyDrawing ? "tagged" : "null"}, edge grips shown ${st0.edgeHandles}`);
      ok("JOB2 (iv) the status line says the room is now a shape the user can pull",
        /now a shape you can pull/i.test(st.status),
        `status "${(st.status || "").slice(0, 140)}"`);
    }

    // (JOB 2-v) a TYPED area is never overwritten by the conversion.
    {
      const id = await drawRect(0.64, 0.42, 0.15, 0.24);
      await page.$eval(`tr[data-id="${id}"] input[data-field="area"]`, (inp) => {
        inp.value = "42.5";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await sleepT(500);
      await selectRoom(id);
      const typed = await roomState(id);
      const b = await boxOf(id);
      await page.mouse.move(b.x + b.w, b.y + b.h / 2);   // the RIGHT edge middle
      await page.mouse.down();
      await page.mouse.move(b.x + b.w + 70, b.y + b.h / 2 + 30, { steps: 8 });
      await page.mouse.up();
      await sleepT(1000);
      const st = await roomState(id);
      ok("JOB2 (v) a typed area is NOT overwritten when the box becomes a polygon",
        st.hasPoly && !st.hasRect && typed.area != null
          && Math.abs(Number(st.area) - Number(typed.area)) < 0.01
          && Math.abs(Number(st.cell) - Number(typed.area)) < 0.01,
        `typed ${typed.area} m²; after conversion ${st.area} m² (cell ${st.cell})`);
    }

    // ---- JOB 4: an AREA CHIP under each room's own name, kept live and inert --------------------
    // Every room with geometry on the page gets one small text just under its name; a room with no
    // area reads exactly "no area"; a chip never becomes a hit-target; a stale shape gets none; and
    // the plan does not move when chips appear. Text is handed in by the app (unit-aware formatter).
    {
      const chipTextOf = (id) => page.evaluate((rid) => {
        const t = document.querySelector(`.plan-area-chip[data-room-id="${rid}"]`);
        return t ? t.textContent : null;
      }, id);
      const drawPoly = async () => {
        await setMode("shape");
        await centerPlan();
        const b = await page.$eval("#planView", (e) => {
          const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        const P = [[0.05, 0.10], [0.20, 0.10], [0.20, 0.24], [0.05, 0.24]]
          .map(([fx, fy]) => ({ x: b.x + fx * b.w, y: b.y + fy * b.h }));
        for (const pt of P) { await page.mouse.click(pt.x, pt.y); await sleepT(220); }
        await page.mouse.click(P[0].x, P[0].y); await sleepT(700);          // close on the first corner
        const shown = await page.evaluate(() => {
          const c = document.getElementById("planShapeAssign");
          return !!(c && !c.classList.contains("hidden"));
        });
        if (shown) { await page.click("#planShapeAssignGo"); await sleepT(800); }
        return page.$eval("#roomsBody tr:last-child", (tr) => tr.getAttribute("data-id"));
      };

      // (i) one chip per room with geometry, and a room with no area reads exactly "no area".
      const idPoly = await drawPoly();
      const polyChip = await chipTextOf(idPoly);
      const stats = await page.evaluate(() => {
        const chips = [...document.querySelectorAll(".plan-area-chip")];
        return {
          chips: chips.length,
          rooms: document.querySelectorAll(
            '#planView .plan-room[data-shape="rect"],#planView .plan-room[data-shape="poly"],' +
            '#planView .plan-room[data-shape="marker"]').length,
          blank: chips.filter((t) => !t.textContent.trim()).length,
          zeroOrNan: chips.filter((t) => /NaN/.test(t.textContent) || /^0(\.0+)? ?/.test(t.textContent)).length,
          pe: getComputedStyle(document.querySelector(".plan-area-chips")).pointerEvents,
        };
      });
      ok("JOB4 (i) one area chip per room with geometry (never blank/0/NaN); the chip layer is inert",
        stats.chips === stats.rooms && stats.rooms > 1 && stats.blank === 0 && stats.zeroOrNan === 0
          && stats.pe === "none",
        `chips ${stats.chips} vs rooms ${stats.rooms}; blank ${stats.blank}; 0/NaN ${stats.zeroOrNan}; layer pointer-events ${stats.pe}; drawn-poly chip "${polyChip}"`);

      // a room WITH geometry and NO area → exactly "no area"
      await page.$eval(`tr[data-id="${idPoly}"] input[data-field="area"]`, (inp) => {
        inp.value = "";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await sleepT(500);
      const cleared = await chipTextOf(idPoly);
      ok("JOB4 (i) a room with geometry but no area shows exactly \"no area\"",
        cleared === "no area", `chip "${cleared}"`);
      // restore a numeric area WITHOUT the typed marker, so the outline still drives it (a typed area
      // is deliberately kept, so it must not be used for this live-follow check)
      await page.evaluate((rid) => {
        const room = window.webhvac.state.rooms.find((r) => r.id === rid);
        room.area = 30;
        delete room.areaTyped;
        window.webhvac.plan.overlay.render();
      }, idPoly);
      await sleepT(400);

      // (ii) the chip CHANGES when the room's own outline is dragged (a hand-drawn polygon's vertex).
      await selectRoom(idPoly);
      const beforeDrag = await chipTextOf(idPoly);
      let pb = await boxOf(idPoly);   // re-read the box right before the gesture
      await page.mouse.move(pb.x, pb.y);
      await page.mouse.down();
      await page.mouse.move(pb.x - 55, pb.y - 45, { steps: 8 });
      await sleepT(200);
      const duringDrag = await chipTextOf(idPoly);
      await page.mouse.up();
      await sleepT(700);
      const afterDrag = await chipTextOf(idPoly);
      // A hand-drawn polygon's vertex drag recomputes the area on every move, so the chip moved DURING
      // the drag as well as after release.
      ok("JOB4 (ii) the area chip changes when the room's outline is dragged (live, during the drag)",
        !!afterDrag && afterDrag !== beforeDrag && /m²|ft²/.test(afterDrag) && duringDrag === afterDrag,
        `before "${beforeDrag}" → during "${duringDrag}" → after "${afterDrag}"`);

      // (ii-b) a plain BOX's corner resize is live too — the chip already shows the new figure BEFORE
      //        the pointer is lifted.
      {
        const idRect = await drawRect(0.55, 0.08, 0.14, 0.14);
        await selectRoom(idRect);
        const before = await chipTextOf(idRect);
        const rb = await boxOf(idRect);
        await page.mouse.move(rb.x + rb.w, rb.y + rb.h);
        await page.mouse.down();
        await page.mouse.move(rb.x + rb.w + 80, rb.y + rb.h + 60, { steps: 8 });
        await sleepT(200);
        const mid = await chipTextOf(idRect);          // read BEFORE pointer up
        await page.mouse.up();
        await sleepT(500);
        const after = await chipTextOf(idRect);
        ok("JOB4 (ii) a box corner-resize updates the chip MID-DRAG (before pointer up)",
          !!mid && mid !== before && mid === after && /m²|ft²/.test(mid),
          `before "${before}" → mid-drag "${mid}" → after "${after}"`);
      }

      // (vi) the chip belongs to the room's NAME: directly below it, on the same axis, and it travels
      //      with the name when the outline is moved. Reported from real use: dragging an outline moved
      //      the name (drawn at the shape's centre) while the area stayed at the sheet's printed name
      //      position, so the two visibly parted company.
      {
        const idShape = await drawRect(0.60, 0.52, 0.16, 0.16);
        await setMode("select");
        await centerPlan();
        const labelChip = (rid) => page.evaluate((r) => {
          const chip = document.querySelector(`.plan-area-chip[data-room-id="${r}"]`);
          const g = document.querySelector(`.plan-room[data-room-id="${r}"]`);
          const label = g ? g.querySelector(".plan-room-label") : null;
          const mid = (el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
          return { chip: chip ? mid(chip) : null, label: label ? mid(label) : null };
        }, rid);
        const a0 = await labelChip(idShape);
        ok("JOB4 (vi) the area chip sits directly below the room's name, on its axis",
          !!a0.chip && !!a0.label && a0.chip.y > a0.label.y && Math.abs(a0.chip.x - a0.label.x) <= 6,
          `name ${JSON.stringify(a0.label)} chip ${JSON.stringify(a0.chip)}`);
        const bb = await boxOf(idShape);
        await page.mouse.move(bb.x + bb.w / 2, bb.y + bb.h / 2);
        await page.mouse.down();
        await page.mouse.move(bb.x + bb.w / 2 + 60, bb.y + bb.h / 2 + 40, { steps: 8 });
        await page.mouse.up();
        await sleepT(700);
        const a1 = await labelChip(idShape);
        const dN = a0.label && a1.label ? { x: a1.label.x - a0.label.x, y: a1.label.y - a0.label.y } : null;
        const dC = a0.chip && a1.chip ? { x: a1.chip.x - a0.chip.x, y: a1.chip.y - a0.chip.y } : null;
        ok("JOB4 (vii) the chip travels with the name when the outline is moved",
          !!dN && !!dC && Math.abs(dN.x - dC.x) <= 2 && Math.abs(dN.y - dC.y) <= 2 && Math.abs(dN.x) + Math.abs(dN.y) > 15,
          `name moved ${JSON.stringify(dN)} chip moved ${JSON.stringify(dC)}`);
        ok("JOB4 (vii) the chip is still below the name after the move",
          !!a1.chip && !!a1.label && a1.chip.y > a1.label.y, `${JSON.stringify(a1.label)} ${JSON.stringify(a1.chip)}`);
      }

      // (viii) A CONCAVE outline (a foyer wrapped round a core) whose bounding-box centre falls
      //        OUTSIDE the shape must still put its tag inside the drawn area. Native SVG
      //        isPointInFill decides, so this cannot pass by agreeing with the app's own maths.
      {
        await setMode("select");
        await centerPlan();
        await page.evaluate(() => {
          const S = window.webhvac.state;
          const pg = window.webhvac.plan.page || 1;
          const drw = window.webhvac.plan.drawingId;
          const o = { x: 180, y: 260 };
          const ring = [{ x: o.x, y: o.y }, { x: o.x + 300, y: o.y }, { x: o.x + 300, y: o.y + 300 },
            { x: o.x + 200, y: o.y + 300 }, { x: o.x + 200, y: o.y + 100 }, { x: o.x + 100, y: o.y + 100 },
            { x: o.x + 100, y: o.y + 300 }, { x: o.x, y: o.y + 300 }];
          let r = S.rooms.find((x) => x.id === "probeConcave");
          if (!r) { r = { id: "probeConcave", name: "CONCAVE FOYER", level: "P", area: 1059.6, include: true, source: "drawn" }; S.rooms.push(r); }
          r.poly = ring; r.polyPage = pg; r.polyDrawing = drw; r.polyArea = 1059.6;
          r.areaFromDrawing = true; r.scaleDenom = 100;
          r.at = { x: o.x - 300, y: o.y + 400, page: pg };
          // a NARROW room with a long name: no label that spills outside the outline
          let n = S.rooms.find((x) => x.id === "probeNarrow");
          if (!n) { n = { id: "probeNarrow", name: "CONFERENCE ROOM", level: "P", area: 39.01, include: true, source: "drawn" }; S.rooms.push(n); }
          n.poly = [{ x: o.x + 700, y: o.y }, { x: o.x + 760, y: o.y }, { x: o.x + 760, y: o.y + 300 }, { x: o.x + 700, y: o.y + 300 }];
          n.polyPage = pg; n.polyDrawing = drw; n.polyArea = 39.01; n.areaFromDrawing = true; n.scaleDenom = 100;
          n.at = { x: o.x + 730, y: o.y + 150, page: pg };
          window.webhvac.renderAll();
        });
        await sleepT(700);
        const concave = await page.evaluate(() => {
          const svg = document.querySelector("#planView svg");
          if (!svg) return null;
          const M = svg.getScreenCTM().inverse();
          const user = (cx, cy) => new DOMPoint(cx, cy).matrixTransform(M);
          const g = document.querySelector('.plan-room[data-room-id="probeConcave"]');
          if (!g) return null;
          const geos = [...g.querySelectorAll("path,polygon,rect")].filter((e) => typeof e.isPointInFill === "function");
          const geo = geos[geos.length - 1];
          if (!geo) return null;
          const bb = geo.getBBox();
          const boxCentreInside = geo.isPointInFill(new DOMPoint(bb.x + bb.width / 2, bb.y + bb.height / 2));
          const corners = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height],
              [r.x + r.width / 2, r.y + r.height / 2]].map(([cx, cy]) => geo.isPointInFill(user(cx, cy)));
          };
          const label = corners(g.querySelector(".plan-room-label"));
          const chip = corners(document.querySelector('.plan-area-chip[data-room-id="probeConcave"]'));
          // the narrow room against ITS own outline
          const gn = document.querySelector('.plan-room[data-room-id="probeNarrow"]');
          const geosN = gn ? [...gn.querySelectorAll("path,polygon,rect")].filter((e) => typeof e.isPointInFill === "function") : [];
          const geoN = geosN[geosN.length - 1];
          const cornersN = (el) => {
            if (!el || !geoN) return null;
            const r = el.getBoundingClientRect();
            return [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height],
              [r.x + r.width / 2, r.y + r.height / 2]].map(([cx, cy]) => geoN.isPointInFill(user(cx, cy)));
          };
          const narrowLabel = gn ? cornersN(gn.querySelector(".plan-room-label")) : null;
          const narrowChip = cornersN(document.querySelector('.plan-area-chip[data-room-id="probeNarrow"]'));
          return { boxCentreInside, label, chip, narrowLabel, narrowChip,
            name: (g.querySelector(".plan-room-label") || {}).textContent };
        });
        const allIn = (a) => Array.isArray(a) && a.length === 5 && a.every(Boolean);
        ok("JOB4 (viii) that concave room really does have its box centre outside the shape (the check is meaningful)",
          !!concave && concave.boxCentreInside === false, JSON.stringify(concave && concave.boxCentreInside));
        ok("JOB4 (viii) its NAME sits wholly inside the drawn outline",
          !!concave && allIn(concave.label), JSON.stringify(concave && concave.label));
        ok("JOB4 (viii) its AREA sits wholly inside the drawn outline",
          !!concave && allIn(concave.chip), JSON.stringify(concave && concave.chip));
        // A name too wide for a narrow room is simply not drawn (the existing legibility floor): the rule
        // is no label OR a label wholly inside - never one that spills over the outline.
        ok("JOB4 (viii) a narrow room's long name is either omitted or wholly inside its own outline",
          !!concave && (concave.narrowLabel === null || allIn(concave.narrowLabel)), JSON.stringify(concave && concave.narrowLabel));
        ok("JOB4 (viii) the narrow room still prints its area, inside its own outline",
          !!concave && allIn(concave.narrowChip), JSON.stringify(concave && concave.narrowChip));
        // leave no probe room behind: later checks count rooms and outlines
        await page.evaluate(() => {
          const S = window.webhvac.state;
          S.rooms = S.rooms.filter((r) => r.id !== "probeConcave" && r.id !== "probeNarrow");
          window.webhvac.renderAll();
        });
        await sleepT(400);
      }

      // (iii) inert: the chip is never the hit-target, and a click at its centre still selects the room.
      //        Re-measure AFTER centering the plan (scrolling moves the chip).
      await setMode("select");
      await centerPlan();
      const inert = await page.evaluate((rid) => {
        const t = document.querySelector(`.plan-area-chip[data-room-id="${rid}"]`);
        const r = t.getBoundingClientRect();
        const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        return { x, y, pe: getComputedStyle(t).pointerEvents, hitIsChip: hit === t,
          hitClass: hit ? (hit.getAttribute("class") || hit.tagName) : null };
      }, idPoly);
      await page.mouse.click(inert.x, inert.y);
      await sleepT(500);
      const selectedByChip = await page.evaluate(() => window.webhvac.state.ui.openId);
      ok("JOB4 (iii) a chip is inert — a click at its centre is not the chip and still selects the room",
        inert.pe === "none" && inert.hitIsChip === false && selectedByChip === idPoly,
        `chip pointer-events ${inert.pe}; element from chip centre hit ${inert.hitIsChip} (${inert.hitClass}); openId ${selectedByChip}`);

      // (v) the plan does not move when chips appear (identical box with the layer hidden vs shown).
      const rectOfPlan = () => page.evaluate(() => {
        const r = document.getElementById("planView").getBoundingClientRect();
        return { y: Math.round(r.y), h: Math.round(r.height) };
      });
      const withChips = await rectOfPlan();
      await page.evaluate(() => { const g = document.querySelector(".plan-area-chips"); if (g) g.style.display = "none"; });
      await sleepT(200);
      const withoutChips = await rectOfPlan();
      await page.evaluate(() => { const g = document.querySelector(".plan-area-chips"); if (g) g.style.display = ""; });
      ok("JOB4 (v) the plan does not move when chips appear",
        withChips.y === withoutChips.y && withChips.h === withoutChips.h,
        `#planView y/h ${withChips.y}/${withChips.h} (chips) vs ${withoutChips.y}/${withoutChips.h} (hidden)`);

      // (iv) a stale shape (geometry from another drawing) gets no chip, and gets one again when the
      //      drawing tag matches.
      const beforeStale = await chipTextOf(idPoly);
      await page.evaluate((rid) => {
        const room = window.webhvac.state.rooms.find((r) => r.id === rid);
        room.polyDrawing = "OTHER-DRAWING";
        window.webhvac.plan.overlay.render();
      }, idPoly);
      await sleepT(300);
      const staleChip = await chipTextOf(idPoly);
      await page.evaluate((rid) => {
        const room = window.webhvac.state.rooms.find((r) => r.id === rid);
        delete room.polyDrawing;
        window.webhvac.plan.overlay.render();
      }, idPoly);
      await sleepT(300);
      const restoredChip = await chipTextOf(idPoly);
      ok("JOB4 (iv) a shape from a previous drawing gets no chip (the stale gate applies)",
        staleChip === null && restoredChip === beforeStale,
        `chip before "${beforeStale}", stale "${staleChip}", restored "${restoredChip}"`);
    }

    // ---- JOB 5: a user-typed CUSTOM drawing scale -----------------------------------------------
    // `Custom…` at the end of the list asks for the denominator and applies it through the SAME
    // planApplyScale path; rubbish leaves the select and every area untouched and says why; the custom
    // value survives a reload as `1:N (custom)`.
    {
      const scaleState = () => page.evaluate(() => {
        const sel = document.getElementById("planScale");
        const opt = sel.options[sel.selectedIndex];
        return {
          value: sel.value, label: opt ? opt.textContent : null,
          n: window.webhvac.state.project.planScale,
          status: (document.getElementById("planStatus") || {}).textContent.replace(/\s+/g, " ").trim(),
          hasCustomOption: [...sel.options].some((o) => o.value === "__custom__"),
        };
      });
      const areaOf = (id) => page.evaluate((rid) =>
        Number((window.webhvac.state.rooms.find((r) => r.id === rid) || {}).area), id);
      const promptReply = (reply) => page.evaluate((r) => { window.prompt = () => r; }, reply);

      const id = await drawRect(0.44, 0.12, 0.16, 0.16);
      await sleepT(400);
      const a0 = await areaOf(id);
      ok("JOB5 the scale list ends in a Custom… option", (await scaleState()).hasCustomOption,
        `options: ${JSON.stringify(await page.$$eval("#planScale option", (o) => o.map((x) => x.textContent)))}`);

      // (i) Custom… 175: the scale is set and the drawn room re-measured by (175/100)^2 = 3.0625.
      await promptReply("175");
      await page.select("#planScale", "__custom__");
      await sleepT(700);
      const s1 = await scaleState();
      const a1 = await areaOf(id);
      const factor = a1 / a0, want = (175 / 100) ** 2;
      ok("JOB5 (i) Custom… 175 sets the scale and re-measures a drawn room by (175/100)^2",
        s1.value === "175" && s1.n === 175 && /\(custom\)/.test(s1.label || "") && Math.abs(factor - want) < 0.02,
        `scale 1:${s1.value} "${s1.label}" (project ${s1.n}); area ${a0} → ${a1} (factor ${factor.toFixed(3)}, want ${want.toFixed(3)})`);

      // (ii) rubbish / out-of-range: the select and the areas are untouched and the status explains.
      await promptReply("abc");
      await page.select("#planScale", "__custom__");
      await sleepT(600);
      const b1 = await scaleState();
      const aBad = await areaOf(id);
      ok("JOB5 (ii) a non-number leaves the scale and every area untouched, and the status line explains",
        b1.value === "175" && aBad === a1 && /not a positive number/i.test(b1.status),
        `value 1:${b1.value}; area ${aBad}; status "${(b1.status || "").slice(0, 110)}"`);
      await promptReply("99999");
      await page.select("#planScale", "__custom__");
      await sleepT(600);
      const b2 = await scaleState();
      ok("JOB5 (ii) an absurd scale is refused with a plain sentence",
        b2.value === "175" && b2.n === 175 && /beyond the range/i.test(b2.status),
        `value 1:${b2.value}; status "${(b2.status || "").slice(0, 110)}"`);
      await promptReply(null);
      await page.select("#planScale", "__custom__");
      await sleepT(600);
      const b3 = await scaleState();
      ok("JOB5 (ii) a cancelled prompt also leaves the select exactly where it was",
        b3.value === "175" && /No scale was entered/i.test(b3.status),
        `value 1:${b3.value}; status "${(b3.status || "").slice(0, 110)}"`);

      // (iii) the custom scale survives a save + reload and still reads "(custom)".
      await sleepT(700);   // let the debounced save flush (saveSoon waits 300 ms)
      await page.reload({ waitUntil: "networkidle2", timeout: 90000 });
      await page.waitForFunction(() => window.webhvac && window.webhvac.state, { timeout: 60000 }).catch(() => {});
      await sleepT(1200);
      const s2 = await scaleState();
      ok("JOB5 (iii) a custom scale survives a reload and still reads 1:N (custom)",
        s2.value === "175" && s2.n === 175 && /\(custom\)/.test(s2.label || ""),
        `after reload: 1:${s2.value} "${s2.label}" (project ${s2.n})`);
      // (iv) the presets are still offered, and the one-click / from-drawing path is unchanged (the
      //      JOB1 checks above exercise the fix itself).
      const presetOk = await page.$$eval("#planScale option", (o) => o.map((x) => x.value)).then(
        (vals) => vals.includes("100") && vals.includes("200") && vals.includes("500"));
      ok("JOB5 (iv) the preset scales remain in the list beside the custom entry", presetOk,
        `options ${JSON.stringify(await page.$$eval("#planScale option", (o) => o.map((x) => x.textContent)))}`);
    }
  }

  // ------------------------------------------------------------------ //
  // 20. A TRACED room's area must follow the outline the user draws.    //
  //     planRoomMoved/planRoomMoveEnd used to refresh the area of a     //
  //     HAND-DRAWN room only, so a traced outline kept the plan's own   //
  //     figure while its ring visibly moved — the number did not        //
  //     describe the shape on the screen. These checks drag a vertex of //
  //     a traced room and assert the area follows. The hand-drawn rule  //
  //     ("dragging a corner changes the row's area to the new shoelace",//
  //     15b) and the scale-change rule ("changing the drawing scale     //
  //     leaves a traced outline's area alone", 11f(3)) must stay green  //
  //     — both are cited, and 15b already re-asserts the first here.    //
  // ------------------------------------------------------------------ //
  {
    const sleepT = (ms) => new Promise((r) => setTimeout(r, ms));
    const PT_PER_IN = 72, M_PER_IN = 0.0254;
    // shoelace over the stored PDF-space ring, converted to m² at its own drawing scale — computed
    // INDEPENDENTLY of the app, so the assertion is not the app grading its own arithmetic.
    const ringAreaM2 = (poly, denom) => {
      let s = 0;
      for (let i = 0; i < poly.length; i += 1) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        s += a.x * b.y - b.x * a.y;
      }
      return (Math.abs(s) / 2) * ((denom / PT_PER_IN * M_PER_IN) ** 2);
    };
    const readRoom = (id) => page.evaluate((rid) => {
      const r = (window.webhvac.state.rooms || []).find((x) => x.id === rid) || {};
      const tr = [...document.querySelectorAll("#roomsBody tr")].find((t) => t.dataset.id === rid);
      const cell = tr ? (tr.querySelector('input[data-field="area"]') || {}).value : null;
      const chip = document.querySelector(`.plan-area-chip[data-room-id="${rid}"]`);
      const m = ((document.getElementById("summaryCards") || {}).innerText || "")
        .replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/);
      return {
        area: Number(r.area),
        denom: Number(r.scaleDenom) || Number((window.webhvac.state.project || {}).planScale) || 100,
        areaFromDrawing: !!r.areaFromDrawing, areaUnknown: !!r.areaUnknown, areaTyped: !!r.areaTyped,
        src: r.source, polyLen: (r.poly || []).length,
        poly: (r.poly || []).map((p) => ({ x: Number(p.x), y: Number(p.y) })),
        cell: cell == null || cell === "" ? null : Number(cell),
        chip: chip ? chip.textContent.trim() : null,
        total: m ? parseFloat(m[1]) : null,
      };
    }, id);
    const chipNum = (s) => { const m = /(-?[0-9.]+)/.exec(s || ""); return m ? parseFloat(m[1]) : NaN; };
    const statusText = () => page.evaluate(() => ((document.getElementById("planStatus") || {}).textContent || "")
      .replace(/\s+/g, " ").trim());
    // robust switch to Select/edit: a plain click on the radio is swallowed by the sticky nav
    const toSelectMode = async () => {
      await page.evaluate(() => document.getElementById("planModeSelect").scrollIntoView({ block: "center" }));
      await sleepT(250);
      await page.click("#planModeSelect").catch(() => {});
      await sleepT(250);
      if (!(await page.evaluate(() => document.getElementById("planModeSelect").checked))) {
        await page.evaluate(() => document.getElementById("planModeSelect").click());
        await sleepT(350);
      }
      return page.evaluate(() => document.getElementById("planModeSelect").checked);
    };
    // centre the room's shape in the plan panel, then return an in-viewport vertex grip and an
    // OUTWARD drag target (pulling a corner away from the shape keeps the result a simple polygon).
    const gripAndTarget = async (id, outPx) => {
      const centered = await page.evaluate((rid) => {
        const v = document.getElementById("planView");
        const box = document.querySelector(`.plan-room[data-room-id="${rid}"] .plan-room-box`);
        if (!box) return false;
        const vr = v.getBoundingClientRect(), br = box.getBoundingClientRect();
        v.scrollLeft += (br.x + br.width / 2) - (vr.x + vr.width / 2);
        v.scrollTop += (br.y + br.height / 2) - (vr.y + vr.height / 2);
        v.scrollIntoView({ block: "center" });
        return true;
      }, id);
      if (!centered) return null;
      await sleepT(500);
      return page.evaluate((rid, R) => {
        const r = (window.webhvac.state.rooms || []).find((x) => x.id === rid);
        if (!r || !Array.isArray(r.poly)) return null;
        const vp = window.webhvac.plan.viewer.getViewport();
        const c = document.getElementById("planCanvas").getBoundingClientRect();
        const pv = document.getElementById("planView").getBoundingClientRect();
        const tv = (q) => { const p = vp.convertToViewportPoint(q.x, q.y); return { x: c.x + p[0], y: c.y + p[1] }; };
        const inside = (q, m) => q.x > pv.left + m && q.x < pv.right - m && q.y > pv.top + m && q.y < pv.bottom - m;
        const cand = r.poly.map((q, i) => ({ i, ...tv(q) })).filter((p) => inside(p, 30));
        if (!cand.length) return null;
        const cen = r.poly.reduce((s, q) => { const p = tv(q); return { x: s.x + p.x / r.poly.length, y: s.y + p.y / r.poly.length }; }, { x: 0, y: 0 });
        // pick a vertex whose OUTWARD drag target also stays on the panel (a drag released outside the
        // scroll box is still delivered via pointer capture, but keeping it on-panel is steadier).
        const withTarget = cand.map((g) => {
          let ux = g.x - cen.x, uy = g.y - cen.y; const m = Math.hypot(ux, uy) || 1; ux /= m; uy /= m;
          return { ...g, tx: g.x + ux * R, ty: g.y + uy * R };
        });
        const best = withTarget.find((g) => inside(g, -8)) || withTarget[0];
        // clamp the target into the panel so the drag always ends on a point that exists
        const tx = Math.max(pv.left + 8, Math.min(pv.right - 8, best.tx));
        const ty = Math.max(pv.top + 8, Math.min(pv.bottom - 8, best.ty));
        return { gx: Math.round(best.x), gy: Math.round(best.y), tx: Math.round(tx), ty: Math.round(ty), vertex: best.i };
      }, id, outPx);
    };

    // fresh sample, then "Trace real outlines" (the fill only assigns areas — it leaves no ring)
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.goto(BASE + "app.html", { waitUntil: "networkidle2", timeout: 90000 });
    await page.evaluate(() => document.getElementById("btnSample").scrollIntoView({ block: "center" }));
    await sleepT(500);
    await page.click("#btnSample").catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length >= 40,
      { timeout: 120000, polling: 400 }).catch(() => {});
    await sleepT(5000);
    await page.evaluate(() => document.getElementById("planTraceOutlines").scrollIntoView({ block: "center" }));
    await sleepT(400);
    await page.click("#planTraceOutlines").catch(() => {});
    await page.waitForFunction(() => (window.webhvac.state.rooms || [])
      .some((r) => Array.isArray(r.poly) && r.poly.length > 2), { timeout: 90000, polling: 500 }).catch(() => {});
    await sleepT(2500);

    const picked = await page.evaluate(() => {
      const rs = (window.webhvac.state.rooms || [])
        .filter((r) => r.source !== "drawn" && Array.isArray(r.poly) && r.poly.length > 2 && Number(r.area) > 0);
      rs.sort((a, b) => Number(b.area) - Number(a.area));
      return rs[0] ? { id: rs[0].id, name: rs[0].name } : null;
    });
    ok("20 the sample has a TRACED room (an outline with an area) to drag", !!picked, JSON.stringify(picked));

    if (picked) {
      const id = picked.id;
      ok("20 the traced room is selected in Select/edit before the vertex is dragged",
        await toSelectMode(), "planModeSelect checked");
      await page.evaluate((rid) => {
        const tr = [...document.querySelectorAll("#roomsBody tr")].find((t) => t.dataset.id === rid);
        (tr.querySelector("td.c-name") || tr.querySelector("td") || tr).click();
      }, id);
      await sleepT(700);
      const gt = await gripAndTarget(id, 45);
      ok("20 the traced room shows a vertex grip with an outward drag that stays on the panel",
        !!gt, JSON.stringify(gt));

      if (gt) {
        const before = await readRoom(id);
        await page.mouse.move(gt.gx, gt.gy); await sleepT(120);
        await page.mouse.down(); await sleepT(120);
        await page.mouse.move((gt.gx + gt.tx) / 2, (gt.gy + gt.ty) / 2, { steps: 6 }); await sleepT(80);
        await page.mouse.move(gt.tx, gt.ty, { steps: 6 }); await sleepT(300);
        const mid = await readRoom(id);
        const totalMid = mid.total;
        await page.mouse.up(); await sleepT(900);
        const after = await readRoom(id);
        const expAfter = ringAreaM2(after.poly, after.denom);
        const afterStatus = await statusText();

        // (i) the area changed and now IS the ring's shoelace (computed here independently), and the
        //     provenance is honest: it now comes from the outline.
        ok("20 (i) dragging a vertex of a TRACED room changes its area to the ring's own shoelace",
          Math.abs(after.area - before.area) > 0.5
            && Math.abs(after.area - expAfter) <= Math.max(0.15, expAfter * 0.005)
            && after.areaFromDrawing === true && after.areaUnknown === false,
          `${before.area} -> ${after.area} m² (independent shoelace ${expAfter.toFixed(3)} m², ` +
          `${after.polyLen} ring points, areaFromDrawing ${after.areaFromDrawing}, areaUnknown ${after.areaUnknown})`);
        ok("20 (i) the plan status says the traced room's area now follows the outline drawn",
          /follows the outline you drew/i.test(afterStatus), `"${afterStatus.slice(0, 140)}"`);

        // (ii) the TABLE CELL and the on-plan CHIP both carry the new figure.
        ok("20 (ii) the table cell and the on-plan chip both show the traced room's new area",
          mid.cell != null && mid.chip != null && after.cell != null && after.chip != null
            && Math.abs(mid.cell - mid.area) < 0.01 && Math.abs(after.cell - after.area) < 0.01
            && Math.abs(chipNum(mid.chip) - mid.area) <= 0.05 && Math.abs(chipNum(after.chip) - after.area) <= 0.05
            && after.cell !== before.cell,
          `cell ${before.cell} -> ${after.cell} m²; chip "${before.chip}" -> "${after.chip}"`);

        // (iii) the load total follows the new area ON RELEASE. (It may also tick during the drag:
        // the live chip/table update was extended to the totals for a vertex drag, so asserting
        // "unchanged mid-drag" would be asserting something the app no longer promises - measured
        // on the live site: 21.6 TR before a vertex drag, 20.74 TR mid-drag, 20.74 TR on release.)
        ok("20 (iii) the load total follows the room's new area on release",
          after.total !== before.total,
          `total ${before.total} TR -> ${totalMid} TR mid-drag -> ${after.total} TR on release`);

        // (iv) a TYPED area on a traced room is never replaced by a vertex drag, and the status says so.
        await page.$eval(`tr[data-id="${id}"] input[data-field="area"]`, (inp) => {
          inp.value = "55.5";
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await sleepT(700);
        const typed0 = await readRoom(id);
        const gt2 = await gripAndTarget(id, 45);
        ok("20 (iv) the traced room still shows vertex grips after a typed area", !!gt2, JSON.stringify(gt2));
        if (gt2) {
          await page.mouse.move(gt2.gx, gt2.gy); await sleepT(120);
          await page.mouse.down(); await sleepT(120);
          await page.mouse.move((gt2.gx + gt2.tx) / 2, (gt2.gy + gt2.ty) / 2, { steps: 6 }); await sleepT(80);
          await page.mouse.move(gt2.tx, gt2.ty, { steps: 6 }); await sleepT(300);
          await page.mouse.up(); await sleepT(900);
          const typed1 = await readRoom(id);
          const typedMsg = await statusText();
          ok("20 (iv) a TYPED area on a traced room survives a vertex drag, and the status says so",
            typed0.areaTyped === true && Math.abs(typed1.area - typed0.area) < 0.01
              && typed1.cell != null && Math.abs(typed1.cell - 55.5) < 0.01
              && /never replaces a figure you typed/i.test(typedMsg),
            `typed ${typed0.area} -> ${typed1.area} m² (cell ${typed1.cell}); status "${typedMsg.slice(0, 120)}"`);
        }
      }
    }
  }

  // ---- Long operations say what they are doing, and the bar can actually paint ------------------
  //      The tracer is synchronous main-thread code, so it now yields between work units and the plan
  //      panel gained a real ARIA progressbar. These checks prove: the bar appears with a count that
  //      increases, the button that started the work is disabled and says so, the bar goes when the
  //      work ends, and the RESULT is unchanged (the fixture's own 105 of 159). The owner's words:
  //      "people shouldnt have ambiguity".
  {
    const settleP = (ms) => new Promise((r) => setTimeout(r, ms));
    // A tiny in-page recorder: it watches #planProgress and the button while an operation runs.
    const installRecorder = (buttonId, watchWord) => page.evaluate((bid, word) => {
      const el = document.getElementById("planProgress");
      const txt = document.getElementById("planProgressText");
      const btn = document.getElementById(bid);
      const watch = new RegExp(word);
      window.__prog = { vals: [], texts: [], sawIndet: false, indetNoNow: false, sawDisabled: false, sawLabel: false,
        role: el.getAttribute("role"), min: null, max: null };
      const rec = () => {
        if (el.dataset.active !== "1") return;
        const n = el.getAttribute("aria-valuenow");
        if (n != null && window.__prog.vals[window.__prog.vals.length - 1] !== Number(n)) window.__prog.vals.push(Number(n));
        const tx = txt.textContent;
        if (tx && window.__prog.texts[window.__prog.texts.length - 1] !== tx) window.__prog.texts.push(tx);
        if (el.classList.contains("indeterminate")) {
          window.__prog.sawIndet = true;
          // NEVER invent a number: while the total is unknown there must be no aria-valuenow at all.
          if (el.getAttribute("aria-valuenow") == null) window.__prog.indetNoNow = true;
        }
        if (btn.disabled) window.__prog.sawDisabled = true;
        if (watch.test(btn.textContent)) window.__prog.sawLabel = true;
        window.__prog.min = el.getAttribute("aria-valuemin");
        window.__prog.max = el.getAttribute("aria-valuemax");
      };
      new MutationObserver(rec).observe(el, { attributes: true });
      new MutationObserver(rec).observe(txt, { characterData: true, childList: true });
      rec();
    }, buttonId, watchWord);

    // (1) TRACE on the synthetic fixture: still exactly 105 of 159 rooms.
    await page.evaluate(() => localStorage.clear());
    await page.goto(SYNTH, { waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForFunction(() => !window.webhvac.state.ui.busy, { timeout: 60000 }).catch(() => {});
    if ((await page.$$eval("#roomsBody tr", (t) => t.length)) === 0) await page.click("#btnSample");
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100, { timeout: 120000, polling: 400 });
    await settleP(1500);
    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await page.click("#planFit");
    await settleP(1000);
    // Let the AUTOMATIC run finish before attaching the recorder. Otherwise the bar is sampled from
    // the tail of the automatic trace and then RESTARTS for the manual trace, so the combined series
    // dips (159 -> 1) and reads as non-monotonic. This check is about ONE run of the button.
    await waitIdle();
    await settleP(400);
    await installRecorder("planTraceOutlines", "Tracing");
    const tTrace = Date.now();
    await page.click("#planTraceOutlines");
    // The bar must APPEAR first — an "it has finished" wait would otherwise be satisfied by the idle
    // state before the click takes effect — and only then must it go when the work ends.
    await page.waitForFunction(() => document.getElementById("planProgress").dataset.active === "1",
      { timeout: 60000, polling: 100 }).catch(() => {});
    await page.waitForFunction(() => {
      const el = document.getElementById("planProgress");
      const s = document.getElementById("planStatus");
      return el && el.dataset.active === "0" && s && !/Tracing the plan/.test(s.textContent);
    }, { timeout: 120000, polling: 300 }).catch(() => {});
    const traceMs = Date.now() - tTrace;
    await settleP(800);
    const tp = await page.evaluate(() => {
      const el = document.getElementById("planProgress");
      const btn = document.getElementById("planTraceOutlines");
      const p = window.__prog || {};
      return { vals: p.vals || [], vCount: (p.vals || []).length,
        monotonic: (p.vals || []).every((v, i, a) => i === 0 || v >= a[i - 1]),
        texts: (p.texts || []).join(" | "), sawIndet: !!p.sawIndet, indetNoNow: !!p.indetNoNow, sawDisabled: !!p.sawDisabled, sawLabel: !!p.sawLabel,
        role: p.role, min: p.min, max: p.max,
        active: el.dataset.active, ariaHidden: el.getAttribute("aria-hidden"), vis: getComputedStyle(el).visibility,
        btnText: btn.textContent, btnDisabled: btn.disabled,
        status: (document.getElementById("planStatus") || {}).textContent.replace(/\s+/g, " ").trim(),
        accepted: window.webhvac.plan.lastTrace ? window.webhvac.plan.lastTrace.accepted : null,
        attempted: window.webhvac.plan.lastTrace ? window.webhvac.plan.lastTrace.attempted : null };
    });
    ok("the trace shows a progress bar whose count increases while it runs",
      tp.vCount >= 2 && tp.monotonic && tp.vals[tp.vCount - 1] > tp.vals[0],
      `aria-valuenow ${tp.vCount} samples: ${tp.vals.slice(0, 12).join(",")}… (last ${tp.vals[tp.vCount - 1]}) in ${traceMs} ms`);
    ok("the trace bar is a real progressbar and names the operation with a room count",
      tp.role === "progressbar" && tp.min === "0" && tp.max === "159" && /Tracing outlines - \d+ of 159 rooms/.test(tp.texts),
      `role=${tp.role} min=${tp.min} max=${tp.max} texts "${String(tp.texts).slice(0, 90)}"`);
    ok("the trace button is disabled and says it is working while the trace runs",
      tp.sawDisabled && tp.sawLabel && tp.btnDisabled === false && /^Trace real outlines$/.test(tp.btnText),
      `disabled-during=${tp.sawDisabled}, working-label=${tp.sawLabel}, after "${tp.btnText}" disabled=${tp.btnDisabled}`);
    ok("the progress bar disappears when the trace ends",
      tp.active === "0" && tp.ariaHidden === "true" && tp.vis === "hidden",
      `active=${tp.active} aria-hidden=${tp.ariaHidden} visibility=${tp.vis}`);
    ok("the trace result is unchanged on the fixture — 105 of 159 rooms",
      tp.accepted === 105 && tp.attempted === 159 && /Real outlines for 105 of 159 room\(s\)/.test(tp.status),
      `accepted ${tp.accepted}/${tp.attempted}; status "${tp.status.slice(0, 80)}"`);
    // While the total is genuinely unknown (the tracer is still preparing), the bar is INDETERMINATE:
    // no aria-valuenow, no made-up percentage, just "Working..."-style text.
    ok("while the total is unknown the bar is indeterminate — no aria-valuenow, no invented number",
      tp.sawIndet && tp.indetNoNow,
      `indeterminate-seen=${tp.sawIndet}, without-aria-valuenow=${tp.indetNoNow}`);

    // (2) FILL on the default sample (LEVEL 11: 56 rooms, none with a printed area, so this button is
    //     the only way its areas appear at all) — its own bar, its own count, yielding so it paints.
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE + "app.html", { waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForSelector("#btnSample", { timeout: 30000 });
    await settleP(1200);
    await installRecorder("planFillAreas", "Filling");
    const tFill = Date.now();
    await page.click("#btnSample");   // the sample auto-runs the fill for a sheet that prints no areas
    await page.waitForFunction(() => {
      const el = document.getElementById("planProgress");
      return el && el.dataset.active === "0" && window.webhvac && window.webhvac.state.rooms.length > 50
        && !window.webhvac.state.ui.busy;
    }, { timeout: 180000, polling: 300 }).catch(() => {});
    const fillMs = Date.now() - tFill;
    await settleP(1200);
    const fp = await page.evaluate(() => {
      const el = document.getElementById("planProgress");
      const p = window.__prog || {};
      return { vals: p.vals || [], vCount: (p.vals || []).length,
        monotonic: (p.vals || []).every((v, i, a) => i === 0 || v >= a[i - 1]),
        texts: (p.texts || []).join(" | "), textList: p.texts || [],
        sawIndet: !!p.sawIndet, sawDisabled: !!p.sawDisabled, sawLabel: !!p.sawLabel,
        role: p.role, min: p.min, max: p.max,
        active: el.dataset.active, ariaHidden: el.getAttribute("aria-hidden"), vis: getComputedStyle(el).visibility,
        btnText: document.getElementById("planFillAreas").textContent,
        fillBtnDisabled: document.getElementById("planFillAreas").disabled,
        rooms: window.webhvac.state.rooms.length,
        withArea: window.webhvac.state.rooms.filter((r) => Number(r.area) > 0).length,
        status: (document.getElementById("planStatus") || {}).textContent.replace(/\s+/g, " ").trim() };
    });
    // The bar now runs THREE times on this load: the sample's own fill, then the automatic place, then
    // the automatic trace (the automatic setup when the sample has no printed areas). So the claim must
    // be about the FILL's own count rising — not a single monotonic run across all three.
    const fillCounts = (fp.textList || [])
      .filter((t) => /^Filling areas from the drawing - /.test(t))
      .map((t) => Number((t.match(/- (\d+) of 56 rooms/) || [])[1]))
      .filter((n) => Number.isFinite(n));
    ok("the fill shows a progress bar naming it and counting rooms (the sample prints no areas)",
      fp.role === "progressbar" && fillCounts.length >= 2
        && fillCounts.every((v, i, a) => i === 0 || v >= a[i - 1]) && fillCounts[fillCounts.length - 1] > fillCounts[0]
        && /Filling areas from the drawing - \d+ of 56 rooms/.test(fp.texts),
      `fill count rose ${fillCounts.slice(0, 6).join(",")}… (${fillCounts.length} of ${fp.vCount} bar sample(s)) in ${fillMs} ms`);
    ok("the fill button is disabled and says it is working, and the bar goes when it ends",
      fp.sawDisabled && fp.sawLabel && fp.active === "0" && fp.vis === "hidden" && /^Fill areas from the drawing$/.test(fp.btnText),
      `disabled-during=${fp.sawDisabled} working=${fp.sawLabel} active=${fp.active} vis=${fp.vis} after "${fp.btnText}"`);
    ok("the sample's own fill result is unchanged — 22 of 56 areas measured from the drawing",
      fp.withArea === 22 && /Filled 22 areas from the drawing/.test(fp.status),
      `rooms ${fp.rooms}, with area ${fp.withArea}; status "${fp.status.slice(0, 80)}"`);

    // (3) PLACE ALL on the same sample: its own bar, its own room count, the button disabled while it
    //     runs and the bar gone when it ends.
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE + "app.html", { waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForSelector("#btnSample", { timeout: 30000 });
    await settleP(1200);
    await page.click("#btnSample");
    await page.waitForFunction(() => window.webhvac && window.webhvac.state.rooms.length > 50
      && !window.webhvac.state.ui.busy, { timeout: 180000, polling: 300 }).catch(() => {});
    await settleP(1000);
    await installRecorder("planPlaceAll", "Placing");
    await waitIdle();
    await page.click("#planPlaceAll");
    await page.waitForFunction(() => document.getElementById("planProgress").dataset.active === "1",
      { timeout: 60000, polling: 100 }).catch(() => {});
    await page.waitForFunction(() => {
      const el = document.getElementById("planProgress");
      return el && el.dataset.active === "0" && !window.webhvac.state.ui.busy;
    }, { timeout: 120000, polling: 300 }).catch(() => {});
    await settleP(1000);
    const pp = await page.evaluate(() => {
      const el = document.getElementById("planProgress");
      const p = window.__prog || {};
      return { vCount: (p.vals || []).length, texts: (p.texts || []).join(" | "),
        sawDisabled: !!p.sawDisabled, sawLabel: !!p.sawLabel,
        active: el.dataset.active, vis: getComputedStyle(el).visibility,
        btnText: document.getElementById("planPlaceAll").textContent,
        placed: window.webhvac.state.rooms.filter((r) => r.rect).length };
    });
    ok("Place all rooms shows the same bar, counting rooms as it places them",
      pp.vCount >= 1 && /Placing rooms on the plan - \d+ of \d+ rooms/.test(pp.texts),
      `${pp.vCount} sample(s) "${String(pp.texts).slice(0, 80)}"`);
    ok("...and its button is disabled and says it is working, and the bar goes when it ends",
      pp.sawDisabled && pp.sawLabel && pp.active === "0" && pp.vis === "hidden"
        && /^Place all rooms on the plan$/.test(pp.btnText) && pp.placed > 0,
      `disabled-during=${pp.sawDisabled} working=${pp.sawLabel} active=${pp.active} placed=${pp.placed} after "${pp.btnText}"`);
  }

  // ------------------------------------------------------------------ //
  // 21. THE AUTOMATIC SETUP OF A FRESHLY OPENED PLAN.                    //
  //     Once a drawing is loaded AND its rooms exist, the app places     //
  //     every room and traces the real outlines by itself — place first, //
  //     then trace, then stop. It runs once per drawing, never runs the  //
  //     area fill, and leaves one honest line saying it was automatic.   //
  // ------------------------------------------------------------------ //
  {
    const sleep21 = (ms) => new Promise((r) => setTimeout(r, ms));
    const geomSig = () => page.evaluate(() => window.webhvac.state.rooms
      .map((r) => `${r.id}:${Array.isArray(r.poly) ? r.poly.length : 0}:${r.rect ? 1 : 0}`).join("|"));
    // A recorder that counts how many times #planProgress goes ACTIVE and keeps its labels. It is
    // installed as an init script so it also sees a run that starts during a page load (a reload).
    const installBarRecorder = () => page.evaluateOnNewDocument(() => {
      window.__bar = { runs: 0, labels: [] };
      const attach = () => {
        const el = document.getElementById("planProgress");
        if (!el) { setTimeout(attach, 100); return; }
        const txt = document.getElementById("planProgressText");
        const note = (t) => {
          if (!t) return;
          const last = window.__bar.labels[window.__bar.labels.length - 1];
          if (last !== t) window.__bar.labels.push(t);
        };
        let last = el.dataset.active;
        if (last === "1") window.__bar.runs += 1;
        new MutationObserver(() => {
          const a = el.dataset.active;
          if (a === "1" && last !== "1") window.__bar.runs += 1;
          last = a;
          if (a === "1" && txt) note(txt.textContent);
        }).observe(el, { attributes: true, attributeFilter: ["data-active"] });
        if (txt) new MutationObserver(() => {
          if (el.dataset.active === "1") note(txt.textContent);
        }).observe(txt, { childList: true, characterData: true });
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach);
      else attach();
    });

    // (a) a fresh sample load ends with outlines traced automatically; (b) the bar was seen active.
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await installBarRecorder();
    await page.goto(SYNTH, { waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForSelector("#btnSample", { timeout: 30000 });
    await page.click("#btnSample");
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100,
      { timeout: 120000, polling: 400 });
    await waitIdle();
    await sleep21(1500);   // let the auto line be written and the bar settle

    const auto = await page.evaluate(() => {
      const rs = window.webhvac.state.rooms;
      return {
        rooms: rs.length,
        traced: rs.filter((r) => Array.isArray(r.poly) && r.poly.length > 2).length,
        placed: rs.filter((r) => r.rect && r.rect.placed === true).length,
        bar: window.__bar || { runs: 0, labels: [] },
        status: ((document.getElementById("planStatus") || {}).textContent || "").replace(/\s+/g, " ").trim(),
      };
    });
    ok("21 (a) a fresh sample load ends with outlines traced automatically",
      auto.traced > 0, `${auto.traced} of ${auto.rooms} room(s) traced; ${auto.placed} placed`);
    ok("21 (b) the progress bar was seen active during the automatic run",
      auto.bar.runs >= 1 && auto.bar.labels.some((t) => /Placing rooms on the plan|Tracing outlines/.test(t)),
      `${auto.bar.runs} bar run(s); labels ${JSON.stringify(auto.bar.labels.slice(0, 4))}`);
    ok("21 the automatic run says so and quotes the real counts",
      /straight from the drawing — automatically/.test(auto.status)
        && (/Placed \d+ room locator/.test(auto.status) || /traced \d+ outline/.test(auto.status)),
      auto.status.slice(0, 170));

    // (c) it happens ONCE: reloading the same drawing traces nothing again and duplicates nothing.
    const sigBefore = await geomSig();
    await page.reload({ waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 100,
      { timeout: 120000, polling: 400 });
    await waitIdle();
    await sleep21(2500);   // a second automatic run would have started and shown its bar by now
    const afterReload = await page.evaluate(() => {
      const rs = window.webhvac.state.rooms;
      return {
        rooms: rs.length,
        traced: rs.filter((r) => Array.isArray(r.poly) && r.poly.length > 2).length,
        sig: rs.map((r) => `${r.id}:${Array.isArray(r.poly) ? r.poly.length : 0}:${r.rect ? 1 : 0}`).join("|"),
        bar: window.__bar || { runs: 0 },
        status: ((document.getElementById("planStatus") || {}).textContent || "").replace(/\s+/g, " ").trim(),
      };
    });
    ok("21 (c) reloading the same drawing does not trace again or duplicate geometry",
      afterReload.rooms === auto.rooms && afterReload.traced === auto.traced && afterReload.sig === sigBefore,
      `rooms ${auto.rooms} -> ${afterReload.rooms}, traced ${auto.traced} -> ${afterReload.traced}, geometry ${afterReload.sig === sigBefore ? "unchanged" : "CHANGED"}`);
    ok("21 (c) no second automatic run starts on the reload",
      afterReload.bar.runs === 0 && !/straight from the drawing — automatically/.test(afterReload.status),
      `${afterReload.bar.runs} bar run(s) after the reload; status "${afterReload.status.slice(0, 90)}"`);

    // (e) both manual buttons still do their job after the automatic run.
    await page.evaluate(() => document.getElementById("planView").scrollIntoView({ block: "center" }));
    await sleep21(300);
    const placeBefore = await page.evaluate(() =>
      window.webhvac.state.rooms.filter((r) => r.rect && r.rect.placed === true).length);
    await waitIdle();
    await page.click("#planPlaceAll");
    await page.waitForFunction(() => !window.webhvac.state.ui.autoSetupBusy && !window.webhvac.state.ui.traceBusy
      && document.getElementById("planProgress").dataset.active === "0", { timeout: 60000, polling: 200 }).catch(() => {});
    await sleep21(500);
    const placeRes = await page.evaluate(() => ({
      status: ((document.getElementById("planStatus") || {}).textContent || "").replace(/\s+/g, " ").trim(),
      placed: window.webhvac.state.rooms.filter((r) => r.rect && r.rect.placed === true).length,
      btnDisabled: document.getElementById("planPlaceAll").disabled,
    }));
    ok("21 (e) 'Place all rooms' still works after the automatic run",
      placeRes.placed >= placeBefore && placeRes.placed > 0 && placeRes.btnDisabled === false
        && /already on the plan|Placed \d+ room/i.test(placeRes.status),
      `${placeRes.placed} placed (was ${placeBefore}); "${placeRes.status.slice(0, 100)}"`);

    await page.evaluate(() => { window.webhvac.plan.lastTrace = null; });
    await waitIdle();
    await page.click("#planTraceOutlines");
    await page.waitForFunction(() => !!window.webhvac.plan.lastTrace
      && !window.webhvac.state.ui.traceBusy && document.getElementById("planProgress").dataset.active === "0",
      { timeout: 120000, polling: 300 }).catch(() => {});
    await sleep21(800);
    const traceRes = await page.evaluate(() => ({
      status: ((document.getElementById("planStatus") || {}).textContent || "").replace(/\s+/g, " ").trim(),
      accepted: window.webhvac.plan.lastTrace ? window.webhvac.plan.lastTrace.accepted : null,
      btnDisabled: document.getElementById("planTraceOutlines").disabled,
    }));
    ok("21 (e) 'Trace real outlines' still works after the automatic run",
      traceRes.accepted != null && traceRes.accepted > 0 && traceRes.btnDisabled === false
        && /Real outlines for \d+ of/.test(traceRes.status),
      `accepted ${traceRes.accepted}; "${traceRes.status.slice(0, 100)}"`);

    // (d) a room whose geometry the USER already set is not re-placed or re-traced: with ANY room
    //     carrying geometry on this drawing, the automatic run is skipped for that drawing.
    const injected = [{ x: 111, y: 222 }, { x: 211, y: 222 }, { x: 211, y: 322 }, { x: 111, y: 322 }];
    const guard = await page.evaluate((ring) => {
      const h = window.webhvac;
      for (const r of h.state.rooms) {
        delete r.poly; delete r.polyPage; delete r.polyDrawing; delete r.polyArea; delete r.polyRatio;
        delete r.rect; delete r.rectDrawing;
      }
      const keep = h.state.rooms[0];
      keep.poly = ring.map((p) => ({ ...p }));
      keep.polyPage = 1;
      keep.polyDrawing = h.plan.drawingId;   // the user's own ring, measured on the drawing now loaded
      h.renderAll();
      // Forget the once-per-session note, so it is the EXISTING GEOMETRY alone that must skip the run.
      h.planAutoSetupDone.delete(h.plan.drawingId);
      const started = h.maybeAutoSetupPlan();
      const others = h.state.rooms.filter((r) => r !== keep)
        .filter((r) => r.rect || (Array.isArray(r.poly) && r.poly.length > 2)).length;
      return { started: !!started, ringAfter: keep.poly, others, keepId: keep.id };
    }, injected);
    ok("21 (d) a room whose geometry the user already set is not re-placed or re-traced",
      guard.started === false && guard.others === 0
        && JSON.stringify(guard.ringAfter) === JSON.stringify(injected.map((p) => ({ ...p }))),
      `started=${guard.started}, other rooms given geometry=${guard.others}, ring untouched=${JSON.stringify(guard.ringAfter).slice(0, 60)}`);
  }

  /* ---------- 22. a landing-page deep link must land on a FINISHED calculation ---------- */
  // The measured bounce: 13 arrivals on the landing page and 1 reached the calculator, because the hero
  // CTA opened an EMPTY calculator that asked the visitor to find a button. The CTA now asks to be landed
  // on a worked example (?go=1), so a visitor's first sight is a real number with no clicks at all.
  //
  // Both legs run in their OWN fresh browser context. That IS the bounce case - a first-time visitor with
  // nothing saved - so no clearing is needed, and it can neither disturb nor be disturbed by the heavy
  // automatic work the checks above leave running. Three earlier versions of this block died with
  // "Runtime.callFunctionOn timed out" precisely because they drove that busy main page.
  {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const freshPage = async () => {
      const ctx = await browser.createBrowserContext();
      return { ctx, p: await ctx.newPage() };
    };

    // (a)+(b) a first-time visitor following the landing button
    const A = await freshPage();
    await A.p.goto(BASE + "app.html?go=1&utm_source=site&utm_medium=hero&utm_campaign=landing-sample",
      { waitUntil: "domcontentloaded", timeout: 90000 });
    await A.p.waitForFunction(() => window.webhvac && window.webhvac.state.rooms.length > 0,
      { timeout: 120000, polling: 400 }).catch(() => {});
    // the sample MEASURES its areas from its own outlines before it has a load to show, so wait for the
    // NUMBER - the whole point of the deep link - not merely for the rooms to appear
    await A.p.waitForFunction(() => {
      const c = document.getElementById("summaryCards");
      const t = c ? c.innerText.replace(/\s+/g, " ") : "";
      return /Total cooling load [0-9.]+ TR/.test(t) && !/Total cooling load 0\.00 TR/.test(t);
    }, { timeout: 180000, polling: 500 }).catch(() => {});
    const deep = await A.p.evaluate(() => {
      const S = window.webhvac && window.webhvac.state;
      const cards = document.getElementById("summaryCards");
      const m = cards ? cards.innerText.replace(/\s+/g, " ").match(/Total cooling load ([0-9.]+) TR/) : null;
      const cr = document.getElementById("sampleCredit");
      return { rooms: S ? S.rooms.length : 0, total: m ? parseFloat(m[1]) : 0,
        credit: cr ? (cr.textContent || "").trim().slice(0, 50) : "" };
    }).catch(() => null);
    ok("22 (a) a deep link lands on the sample's own 56 rooms and a REAL load, with no click at all",
      !!deep && deep.rooms === 56 && deep.total > 0,
      deep ? `rooms=${deep.rooms} (expected 56), total=${deep.total} TR` : "could not read the page");
    ok("22 (b) and it names THAT drawing (LEVEL 11) rather than reading like the visitor's own",
      !!deep && /LEVEL 11/i.test(deep.credit), deep ? JSON.stringify(deep.credit) : "-");
    await A.ctx.close().catch(() => {});

    // (c) a plain visit must stay an EMPTY calculator: the deep link loads a sample, not every visit
    const B = await freshPage();
    await B.p.goto(BASE + "app.html", { waitUntil: "domcontentloaded", timeout: 90000 });
    await wait(6000);
    const plain = await B.p.evaluate(() => (window.webhvac && window.webhvac.state.rooms.length) || 0).catch(() => -1);
    ok("22 (c) a plain visit to the calculator stays empty (the deep link loads a sample, not every visit)",
      plain === 0, "rooms=" + plain);
    await B.ctx.close().catch(() => {});
  }

  await page.goto(BASE + "selftest.html", { waitUntil: "load", timeout: 90000 });
  let selfOut = "";
  for (let i = 0; i < 60; i++) {
    selfOut = await page.$eval("#out", (e) => e.innerText).catch(() => "");
    if (/ALL SELF TESTS PASSED|CHECK\(S\) FAILED|threw an error/.test(selfOut)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  /* ---------- 23. the shape link must see a PLACED BOX, not only a traced outline ---------- */
  // "Place all rooms on the plan" puts a box (room.rect) on every room it can, and the tracer supplies a
  // ring (room.poly) only where it succeeds - 21 of 56 rooms on the sample, and 2 of 149 on the owner's
  // own plan. The link tested room.poly alone, so on a box-shaped room it showed nothing at all ("no row"
  // for a room that has a row AND a shape), and BOTH of its actions returned early on `!room.poly`, so
  // neither Move nor Remove could do anything. Reported from real use on the sample, where IN is a box.
  // Its own fresh context, as block 22: the checks above leave the main page busy.
  {
    const ctx = await browser.createBrowserContext();
    const pg = await ctx.newPage();
    await pg.goto(BASE + "app.html?go=1", { waitUntil: "domcontentloaded", timeout: 90000 });
    await pg.waitForFunction(() => {
      const S = window.webhvac && window.webhvac.state;
      const bar = document.getElementById("planProgress");
      return !!S && !S.ui.busy && !(bar && bar.getAttribute("data-active") === "1");
    }, { timeout: 300000, polling: 1000 }).catch(() => {});

    const box = await pg.evaluate(() => {
      const r = window.webhvac.state.rooms.find((x) => x.rect && !(Array.isArray(x.poly) && x.poly.length > 2));
      if (!r) return null;
      document.querySelector(`#roomsBody tr[data-id="${r.id}"]`).click();
      const el = document.getElementById("planShapeLink");
      const det = document.getElementById("planLinkDetach");
      const sel = document.getElementById("planLinkTarget");
      const detail = document.getElementById("detail") || document.body;
      return { name: String(r.name || ""), hidden: el ? el.classList.contains("hidden") : null,
        detach: det ? !det.disabled : null, options: sel ? sel.options.length : 0,
        placeholder: sel && sel.options.length ? (sel.options[0].value === "" ? 1 : 0) : 0,
        saysPlacedBox: /placed on the plan/.test(detail.innerText || "") ? 1 : 0 };
    });
    ok("23 (a) a room whose shape is a PLACED BOX shows the shape link, named as its own row",
      !!box && box.hidden === false && !!box.name && box.detach === true,
      box ? `${box.name}: hidden=${box.hidden} remove-enabled=${box.detach}` : "no box-only room on the sample");
    ok("23 (b) that link starts its target list on \u2018Choose a room\u2026\u2019 and calls the box a box",
      !!box && box.options > 1 && box.placeholder === 1 && box.saysPlacedBox === 1,
      box ? `${box.options} option(s), placeholder=${box.placeholder}, says-placed-box=${box.saysPlacedBox}` : "-");
    const rm = await pg.evaluate(() => {
      const r = window.webhvac.state.rooms.find((x) => x.rect && !(Array.isArray(x.poly) && x.poly.length > 2));
      const before = r.area;
      window.webhvac.planDetachShape(r.id);
      const a = window.webhvac.state.rooms.find((x) => x.id === r.id);
      return { boxGone: !a.rect, hasShape: !!(a.rect || (a.poly && a.poly.length > 2)), before, after: a.area };
    });
    ok("23 (c) removing a placed box takes the box off the sheet and LEAVES the area the sheet printed",
      rm.boxGone === true && rm.hasShape === false && rm.after === rm.before,
      `box gone=${rm.boxGone}, area ${rm.before} -> ${rm.after}`);
    await ctx.close().catch(() => {});

    // (d) MOVING that box is the other case, and the area must not end up on two rows at once: the box
    // was sized back from the giver's measured area, so giving the shape away releases the area with it.
    // Its own fresh page: (c) has just taken the box off the only box-shaped room on the sample.
    const ctx2 = await browser.createBrowserContext();
    const pg2 = await ctx2.newPage();
    await pg2.goto(BASE + "app.html?go=1", { waitUntil: "domcontentloaded", timeout: 90000 });
    await pg2.waitForFunction(() => {
      const S = window.webhvac && window.webhvac.state;
      const bar = document.getElementById("planProgress");
      return !!S && !S.ui.busy && !(bar && bar.getAttribute("data-active") === "1");
    }, { timeout: 300000, polling: 1000 }).catch(() => {});
    const moved = await pg2.evaluate(() => {
      const rooms = window.webhvac.state.rooms;
      const from = rooms.find((r) => r.rect && !(Array.isArray(r.poly) && r.poly.length > 2) && Number(r.area) > 0);
      const to = from ? rooms.find((r) => r.id !== from.id && Number(r.area) > 0) : null;
      if (!from || !to) return null;
      const beforeArea = from.area;
      window.webhvac.planMoveShapeTo(from.id, to.id);
      const F = rooms.find((r) => r.id === from.id), T = rooms.find((r) => r.id === to.id);
      return { beforeArea, fromArea: F.area, fromUnknown: F.areaUnknown === true,
        fromShape: !!(F.rect || (F.poly && F.poly.length > 2)),
        toShape: !!(T.rect || (T.poly && T.poly.length > 2)), toPoints: T.poly ? T.poly.length : 0, toArea: T.area };
    });
    ok("23 (d) moving a placed box releases the giver's area and hands the shape to the target",
      !!moved && moved.fromUnknown === true && moved.fromShape === false && moved.toShape === true && Number(moved.toArea) > 0,
      moved ? `giver area ${moved.beforeArea} -> ${moved.fromArea} (unknown=${moved.fromUnknown}), target shape=${moved.toShape} area=${moved.toArea} (${moved.toPoints} pt)` : "no box+area pair to move");
    await ctx2.close().catch(() => {});
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
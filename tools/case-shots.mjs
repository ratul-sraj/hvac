// tools/case-shots.mjs — re-measure the numbers on the LIVE app and re-shoot the two case-study
// images, so case-study.html never carries a figure the tool no longer produces.
//
//   cd D:/webhvac && node tools/case-shots.mjs            # https://loadlens.net/app.html
//   node tools/case-shots.mjs http://127.0.0.1:3000/app.html   # a local copy instead
//
// What it does, in a FRESH incognito context (no cookie, no saved state from this machine):
//   1. opens the calculator page, presses #btnSample (the public "LEVEL 11 FLOOR PLAN" sheet),
//   2. waits until the load is non-zero AND unchanged for 5 consecutive 1 s polls — the areas are
//      filled from the drawing asynchronously, so a number read too early is half-applied,
//   3. prints every figure the page states (TR, W, supply L/s, conditioned m², m²/TR, rooms in the
//      load, areas filled, and the exact fill-status line the tool shows),
//   4. re-shoots img/case-summary.png (element shot of #summaryCards) and img/case-plan-areas.png
//      (the plan view) at deviceScaleFactor 2, matching the widths the page already references.
// It also measures the house sample once, so the "6 -> 10 of 10" claim on the page can be checked.
//
// Uses the Edge already on this PC via puppeteer-core (no download). No commit, no deploy.
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const APP = process.argv[2] || "https://loadlens.net/app.html";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = "img";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

/* ---- one fresh, cookie-less context per sample ---------------------------------------------- */
async function freshPage() {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1500, height: 1050, deviceScaleFactor: 2 });
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  return page;
}

/* ---- load a sample and wait for the load to settle ------------------------------------------- */
// Returns { tr, status, totalRooms, filled } once totals.tr has been non-zero and stable for 5 polls.
async function loadSample(page, buttonSel) {
  await page.goto(APP, { waitUntil: "networkidle2", timeout: 90000 });
  await page.waitForSelector(buttonSel, { timeout: 60000 });
  await page.evaluate((sel) => document.querySelector(sel).click(), buttonSel);

  let prev = null;
  let stable = 0;
  let fillStatus = "";
  let tr = 0;
  for (let i = 0; i < 180; i += 1) {
    await sleep(1000);
    const st = await page.evaluate(() => {
      const t = (window.webhvac && window.webhvac.currentCalc().totals) || {};
      const statusEl = document.querySelector("#planStatus");
      return { tr: t.tr || 0, status: (statusEl && statusEl.textContent) || "" };
    });
    // Capture the fill line while it is on screen; the plan toast fades and clears itself after 10 s.
    if (/Filled\s+\d+\s+areas?\b/.test(st.status)) fillStatus = st.status.replace(/\s+/g, " ").trim();
    const now = +Number(st.tr).toFixed(2);
    if (now > 0 && prev !== null && now === prev) stable += 1;
    else stable = 0;
    prev = now;
    tr = st.tr;
    if (now > 0 && stable >= 5) break;
  }
  const extra = await page.evaluate(() => ({
    totalRooms: window.webhvac.state.rooms.length,
    filled: window.webhvac.state.rooms.filter((r) => r && r.areaFromDrawing).length,
  }));
  return { tr, status: fillStatus, ...extra };
}

/* ---- every figure the page states ------------------------------------------------------------ */
async function readNumbers(page, which) {
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll("#summaryCards .scard")].map((c) => ({
      k: (c.querySelector(".k") || {}).textContent || "",
      v: (c.querySelector(".v") || {}).textContent || "",
    }))
  );
  const t = await page.evaluate(() => {
    const x = window.webhvac.currentCalc().totals;
    return {
      tr: +x.tr.toFixed(2),
      totalW: Math.round(x.totalW),
      supplyLs: +x.ls.toFixed(1),
      oaLs: +x.oaLs.toFixed(1),
      areaM2: +x.area.toFixed(1),
      m2PerTr: +x.m2PerTr.toFixed(1),
      rooms: x.rooms,
    };
  });
  const get = (label) => {
    const c = cards.find((c) => c.k.toLowerCase().includes(label));
    return c ? c.v.replace(/\s+/g, " ").trim() : "?";
  };
  return {
    which,
    cards,
    tr: t.tr,
    totalW: t.totalW,
    supplyLs: t.supplyLs,
    oaLs: t.oaLs,
    areaM2: t.areaM2,
    m2PerTr: t.m2PerTr,
    roomsInLoad: t.rooms,
    display: {
      totalCoolingLoad: get("total cooling"),
      totalHeat: get("total heat"),
      supplyAir: get("supply air"),
      freshAir: get("fresh"),
      conditionedArea: get("conditioned area"),
      areaPerTonne: get("area per tonne"),
      roomsIncluded: get("rooms included"),
    },
  };
}

const printReport = (n, m) => {
  console.log(`\n===== ${n.which} =====`);
  console.log(`rooms on the sheet (rows)   : ${m.totalRooms}`);
  console.log(`areas filled from drawing   : ${m.filled}`);
  console.log(`rooms in the load           : ${n.roomsInLoad}`);
  console.log(`total cooling load          : ${n.tr} TR   (page: ${n.display.totalCoolingLoad})`);
  console.log(`total heat                  : ${n.totalW} W   (page: ${n.display.totalHeat})`);
  console.log(`supply air                  : ${n.supplyLs} L/s   (page: ${n.display.supplyAir})`);
  console.log(`fresh / outdoor air         : ${n.oaLs} L/s   (page: ${n.display.freshAir})`);
  console.log(`conditioned area            : ${n.areaM2} m2   (page: ${n.display.conditionedArea})`);
  console.log(`area per tonne              : ${n.m2PerTr} m2/TR   (page: ${n.display.areaPerTonne})`);
  console.log(`rooms included              : ${n.roomsInLoad}   (page: ${n.display.roomsIncluded})`);
  console.log(`fill status line            : ${m.status}`);
};

/* ---- run ----------------------------------------------------------------------------------- */
// 1. LEVEL 11 sample — the one the case study is built on.
const level = await freshPage();
const levelRun = await loadSample(level, "#btnSample");
const levelNums = await readNumbers(level, "LEVEL 11 sample (#btnSample)");
printReport(levelNums, levelRun);

// 2. Re-shoot the two images from the same settled page.
for (const sel of ["#summaryCards", "#planView"]) {
  const el = await level.$(sel);
  if (!el) {
    console.error(`ABORT: ${sel} not found — refusing to shoot a missing element`);
    process.exit(1);
  }
}
await level.evaluate(() => {
  document.querySelector("#planCard").scrollIntoView({ block: "start" });
  // The sticky totals bar sits over the drawing while a tall element is captured, and the plan toast
  // is fixed too — neither is part of the plan, and the case-study image has always been the drawing
  // alone, so hide both for the shot (a display tweak only; nothing on the page is changed).
  for (const sel of ["#totalsBar", "#planStatus"]) {
    const n = document.querySelector(sel);
    if (n) n.style.display = "none";
  }
});

// 2b. Trace the plan's own outlines first: the area chips are drawn only for rooms that HAVE geometry
//     (a traced outline or a placed box), and the sampling run above fills AREAS without keeping the
//     shapes. Without this the plan shot is a bare drawing with no chips and nothing selected - which
//     is exactly what this figure used to show, while its caption claimed the areas were on the plan.
try {
  await level.click("#planTraceOutlines");
  await level.waitForFunction(
    () => window.webhvac.state.rooms.some((r) => Array.isArray(r.poly) && r.poly.length > 2),
    { timeout: 120000, polling: 500 }
  );
} catch (e) {
  console.warn("WARN: the outline trace produced nothing on this sheet — the plan shot will have no chips");
}
await sleep(3000);

// 2c. Select a room so the shot shows what the page claims: a room picked out on the sheet with its
//     area chip under its name. The room is selected through the TABLE ROW (the same gesture a visitor
//     uses - the app marks that room on the plan, scrolls its row into view and flashes it). Never
//     pre-set state.ui.openId: a row click TOGGLES, so a pre-set id closes the panel instead of
//     opening it. Pick a room that has a real outline on the page being shown, so the mark and the
//     new ring are both visible in the picture.
const picked = await level.evaluate(() => {
  const page = (window.webhvac.plan && window.webhvac.plan.page) || 1;
  const rooms = window.webhvac.state.rooms.filter(
    (r) => Array.isArray(r.poly) && r.poly.length > 2 && (r.polyPage || r.page || 1) === page && r.name
  );
  if (!rooms.length) return null;
  // the room with the largest ring area reads best at this size
  const best = rooms.sort((a, b) => (Number(b.area) || 0) - (Number(a.area) || 0))[0];
  const tr = [...document.querySelectorAll("#roomsBody tr")].find((t) => t.dataset.id === best.id);
  if (!tr) return null;
  const cell = tr.querySelector("td.c-name") || tr.querySelector("td");
  if (cell) cell.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
  return { id: best.id, name: best.name, area: best.area };
});
await sleep(1200);
if (!picked) console.warn("WARN: no room with an outline to select — the plan shot will show no selection");
else console.log(`selected for the shot      : ${picked.name} (${picked.area} m2, id ${picked.id})`);
// the row click scrolls the table into view; the drawing has to be back under the camera for the shot
await level.evaluate(() => {
  document.querySelector("#planCard").scrollIntoView({ block: "start" });
  for (const sel of ["#totalsBar", "#planStatus"]) {
    const n = document.querySelector(sel);
    if (n) n.style.display = "none";
  }
});
await sleep(900);
await sleep(800);
await (await level.$("#planView")).screenshot({ path: `${OUT}/case-plan-areas.png` });
await (await level.$("#summaryCards")).screenshot({ path: `${OUT}/case-summary.png` });
const sizes = {};
for (const f of ["case-summary.png", "case-plan-areas.png"]) {
  const b = fs.readFileSync(`${OUT}/${f}`);
  sizes[f] = `${b.readUInt32BE(16)}x${b.readUInt32BE(20)} (${b.length} bytes)`;
  console.log(`wrote ${OUT}/${f}  ${sizes[f]}`);
}
await level.close();

// 3. House sample — the second claim on the page ("6 -> 10 of 10"), measured on its own fresh page.
const house = await freshPage();
const houseRun = await loadSample(house, "#btnSampleHouse");
const houseNums = await readNumbers(house, "house sample (#btnSampleHouse)");
printReport(houseNums, houseRun);
await house.close();

console.log("\nimage sizes:", JSON.stringify(sizes));
await browser.close();

// Standalone browser test: a project saved by an OLDER parser (rooms with no `at`) is recovered by
// re-reading the drawing the browser already keeps, when "Place all rooms on the plan" is clicked —
// without changing the load and without touching any other room field.
//
//   cd D:/webhvac && node tests/test-rehydrate.mjs [url]
// Needs the app served (default http://127.0.0.1:3000/app.html) and the Edge install, like
// tests/browser-check.mjs. It never starts a server.
import puppeteer from "puppeteer-core";

const URL_ = process.argv[2] || "http://127.0.0.1:3000/app.html";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const SAMPLE = "D:/webhvac/tests/samples/sample-plan.pdf";
const EXPECTED_ROOMS = 159;
const KEY = "webhvac.state.v1";
const KEEP = ["id", "name", "area", "length", "width", "type", "include", "page", "level"];

let pass = 0, fail = 0;
const ok = (label, good, detail = "") => {
  if (good) { pass += 1; console.log(`  PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--window-size=1400,1000"],
  protocolTimeout: 180000,
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });

const waitRows = (n) => page.waitForFunction(
  (m) => document.querySelectorAll("#roomsBody tr").length >= m, { timeout: 120000 }, n);
const readState = () => page.evaluate(() => {
  const rooms = window.webhvac.state.rooms;
  return {
    total: rooms.length,
    withAt: rooms.filter((r) => r && r.at).length,
    withRect: rooms.filter((r) => r && r.rect).length,
  };
});
const readLoad = () => page.evaluate(() => {
  const v = document.querySelector("#summaryCards .scard.hero .v");
  const m = v ? v.textContent.replace(/\s+/g, " ").match(/([\d.]+)/) : null;
  return m ? Number(m[1]) : NaN;
});
const readStatus = () => page.evaluate(() => {
  const el = document.querySelector("#statusBox");
  return el && !el.classList.contains("hidden") ? el.textContent.replace(/\s+/g, " ").trim() : "";
});
const clearStorage = () => page.evaluate(() => new Promise((resolve) => {
  try { localStorage.clear(); } catch (e) { /* ignore */ }
  const req = indexedDB.deleteDatabase("loadlens");
  req.onsuccess = req.onerror = req.onblocked = () => resolve();
  setTimeout(resolve, 1500);
}));
const upload = async () => {
  const input = await page.$("#fileInput");
  await input.uploadFile(SAMPLE);
  await waitRows(20);
  await new Promise((r) => setTimeout(r, 900));
};

try {
  await page.goto(URL_, { waitUntil: "networkidle2", timeout: 60000 });
  await clearStorage();
  await page.reload({ waitUntil: "networkidle2" });
  await upload();

  const fresh = await readState();
  ok("fresh upload gives 159 rooms, each with a position",
    fresh.total === EXPECTED_ROOMS && fresh.withAt === EXPECTED_ROOMS, `${fresh.withAt}/${fresh.total}`);

  // remember every non-position field so we can prove the recovery left them alone
  const before = await page.evaluate((fields) => window.webhvac.state.rooms.map((r) => {
    const o = {};
    for (const f of fields) o[f] = r[f];
    return o;
  }), KEEP);

  // simulate the OLD saved project: write the app's exact saved shape with no `at` anywhere
  await page.evaluate((k) => {
    const h = window.webhvac;
    h.state.rooms.forEach((r) => { delete r.at; });
    localStorage.setItem(k, JSON.stringify({ v: 1, project: h.state.project, rooms: h.state.rooms }));
  }, KEY);
  await page.waitForFunction((k) => !/"at"/.test(localStorage.getItem(k) || ""), { timeout: 5000 }, KEY);

  await page.reload({ waitUntil: "networkidle2" });
  await waitRows(20);
  const restored = await readState();
  ok("reload restores the rooms with NO positions",
    restored.total === EXPECTED_ROOMS && restored.withAt === 0, `withAt=${restored.withAt}`);

  const loadBefore = await readLoad();
  await page.click("#planPlaceAll");
  await page.waitForFunction((n) => window.webhvac.state.rooms.filter((r) => r.rect).length >= n,
    { timeout: 120000 }, EXPECTED_ROOMS).catch(() => {});
  const after = await readState();
  const status = await readStatus();
  const loadAfter = await readLoad();

  ok("the button recovered a position for every room", after.withAt === EXPECTED_ROOMS,
    `${after.withAt}/${after.total}`);
  ok("every room was placed on the plan", after.withRect === EXPECTED_ROOMS, `${after.withRect}`);
  ok("the status line says the drawing was re-read",
    /Re-read the drawing to find where the rooms are named/.test(status), status);
  ok("the load is unchanged before vs after placing",
    Number.isFinite(loadBefore) && loadBefore === loadAfter, `${loadBefore} -> ${loadAfter} TR`);

  // every non-position field is exactly what it was before the recovery ran
  const after2 = await page.evaluate((fields) => window.webhvac.state.rooms.map((r) => {
    const o = {};
    for (const f of fields) o[f] = r[f];
    return o;
  }), KEEP);
  ok("no other room field was touched (name/area/size/type/include/… )",
    JSON.stringify(before) === JSON.stringify(after2), `${before.length} rooms compared`);

  await clearStorage();
} catch (err) {
  ok("test completed without throwing", false, (err && err.message) || String(err));
} finally {
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} rehydrate checks passed`);
if (fail) process.exit(1);
console.log("ALL REHYDRATE CHECKS PASSED");

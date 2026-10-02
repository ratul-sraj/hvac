// Record a short demo reel of the LIVE LoadLens app for the Meta ad.
//
// Story (owner's choice): the house plan first, where "Fill areas from the drawing" visibly fills
// 6 of the 10 rooms, then the office sheet at real scale. Scripted on purpose: when a label changes
// a re-shoot is `node infra/.tmp/demo-reel.mjs` and ~40 seconds, no manual screen recording.
//
// Output: infra/.tmp/reel/frames/*.jpg (CDP screencast) -> infra/.tmp/reel/loadlens-demo.mp4
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const EXE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = "D:/webhvac/infra/.tmp/reel";
const BASE = process.env.BASE || "https://loadlens.net/";
// Fresh campaign token per docs/ADS-PLAN.md: every older ll_/e2e- row in the log is smoke-test noise.
const UTM = "?utm_source=facebook&utm_medium=cpc&utm_campaign=m-oct2&utm_content=reel";
const W = 1080, H = 1080; // square: safe in Meta feeds

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });
// Clear the previous shoot's frames only. Do NOT remove OUT itself: on Windows a shell that is cd'd
// into the folder makes its deletion fail with EBUSY, and the ad lives there.
for (const f of fs.readdirSync(path.join(OUT, "frames"))) {
  try { fs.rmSync(path.join(OUT, "frames", f), { force: true }); } catch {}
}

const browser = await puppeteer.launch({
  executablePath: EXE,
  headless: "new",
  args: [`--window-size=${W},${H}`, "--force-device-scale-factor=1"],
  protocolTimeout: 600000,
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const client = await page.createCDPSession();
let frames = 0;
client.on("Page.screencastFrame", async (f) => {
  frames++;
  fs.writeFileSync(path.join(OUT, "frames", `f${String(frames).padStart(5, "0")}.jpg`), Buffer.from(f.data, "base64"));
  try { await client.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch {}
});

await page.goto(BASE + "app.html" + UTM, { waitUntil: "load", timeout: 90000 });
await page.waitForSelector("#btnSample", { timeout: 30000 });
await sleep(3500); // let the page settle and the geo chip appear

await client.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1, maxWidth: W, maxHeight: H });
await sleep(1200);

log("frames dir:", path.join(OUT, "frames"));
log("url:", BASE + "app.html" + UTM);

// ---- 1. the house plan: the small, enclosed sheet where auto-fill visibly works ------------------
await page.click("#btnSampleHouse");
await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length >= 8, { timeout: 90000 });
await sleep(2200);
log("house plan loaded:", await page.evaluate(() => document.querySelectorAll("#roomsBody tr").length), "rooms");

await page.click("#planFillAreas");
await page.waitForFunction(
  () => /Filled \d+ areas from the drawing/.test(document.body.innerText),
  { timeout: 90000 },
);
await sleep(4500); // hold on the filled badges, the status line and the new total
log("house auto-fill status:", (await page.evaluate(() => {
  const m = document.body.innerText.match(/Filled \d+ areas from the drawing[^\n]*/);
  return m ? m[0] : "(none)";
})).slice(0, 220));

// ---- 2. the office sheet at real scale -----------------------------------------------------------
// Reload first: the house rooms are still in the table (the app restores the saved session), which
// would change the office count - and the video must show the same figure the docs and tests use.
await client.send("Page.stopScreencast");
await page.evaluate(async () => {
  try { localStorage.clear(); sessionStorage.clear(); } catch {}
  try {
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map((d) => new Promise((res) => {
      const r = indexedDB.deleteDatabase(d.name);
      r.onsuccess = r.onerror = r.onblocked = res;
    })));
  } catch {}
});
await page.goto(BASE + "app.html" + UTM, { waitUntil: "load", timeout: 90000 });
await page.waitForSelector("#btnSample", { timeout: 30000 });
await sleep(2500);
await client.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1, maxWidth: W, maxHeight: H });
await sleep(800);

await page.click("#btnSample");
await page.waitForFunction(() => document.querySelectorAll("#roomsBody tr").length > 50, { timeout: 90000 });
await sleep(2000);

await page.click("#planFillAreas");
await page.waitForFunction(
  () => /Filled \d+ areas from the drawing/.test(document.body.innerText),
  { timeout: 90000 },
);
await sleep(2500);
log("office auto-fill status:", (await page.evaluate(() => {
  const m = document.body.innerText.match(/Filled \d+ areas from the drawing[^\n]*/);
  return m ? m[0] : "(none)";
})).slice(0, 220));

// ---- 3. the numbers -----------------------------------------------------------------------------
await page.evaluate(() => {
  const s = document.querySelector("#summaryCards");
  if (s) s.scrollIntoView({ block: "center", behavior: "smooth" });
});
await sleep(3200);

await client.send("Page.stopScreencast");
await browser.close();

log(`frames: ${frames}`);

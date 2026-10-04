// Build the static ad creative (no video) from the LIVE app: load the sample, let the app measure the
// areas itself, and shoot (a) the load schedule with real numbers, (b) a 1080x1350 ad card that puts
// the plan beside the result. Screen recording was rejected as unattractive; a before/after still is
// what a utilitarian tool can honestly sell.
//
//   cd D:/webhvac && node tools/ad-creative.mjs
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const BASE = process.env.LL_URL || "http://127.0.0.1:3000/app.html";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = "img";

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-device-scale-factor=2"],
});

// ---- 1. the load schedule, with the sample's own measured areas
const app = await browser.newPage();
await app.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 2 });
await app.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
await app.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await app.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
await app.evaluate(() => document.getElementById("btnSample").click());
for (let i = 0; i < 120; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  const tr = await app.evaluate(() => (window.webhvac && window.webhvac.currentCalc().totals.tr) || 0);
  if (tr > 0) break;
}
const totals = await app.evaluate(() => {
  const t = window.webhvac.currentCalc().totals;
  return { rooms: t.rooms, tr: +t.tr.toFixed(2), w: Math.round(t.totalW), ls: Math.round(t.ls), area: +t.area.toFixed(1), m2PerTr: +t.m2PerTr.toFixed(1) };
});
console.log("live numbers for the creative:", JSON.stringify(totals));

const box = await app.evaluate(() => {
  const t = document.getElementById("roomsTable");
  if (!t) throw new Error("no #roomsTable in the page — the clip would grab the wrong element");
  const r = t.getBoundingClientRect();
  return { x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 6), width: Math.min(r.width + 12, 1480), height: Math.min(r.height + 12, 900) };
});
await app.screenshot({ path: `${OUT}/ad-schedule.png`, clip: box });
console.log(`wrote ${OUT}/ad-schedule.png`);
await app.close();

// ---- 2. the ad card: plan on the left, the numbers it produced on the right
const card = await browser.newPage();
await card.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 });
const planB64 = fs.readFileSync(`${OUT}/case-plan-areas.png`).toString("base64");
const schedB64 = fs.readFileSync(`${OUT}/ad-schedule.png`).toString("base64");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:1080px; height:1080px; background:#0f1720; color:#eef2f6;
         font-family:"Segoe UI",system-ui,sans-serif; }
  .head { padding:26px 46px 16px; }
  .brand { font-size:30px; font-weight:800; letter-spacing:.5px; color:#7cc4ff; }
  .h1 { font-size:52px; font-weight:800; line-height:1.05; margin-top:8px; }
  .h1 span { color:#7cc4ff; }
  .sub { font-size:29px; color:#a9b6c4; margin-top:14px; line-height:1.35; }
  .pair { display:flex; gap:18px; padding:0 46px; align-items:flex-start; }
  .pane { background:#16202b; border:1px solid #26333f; border-radius:14px; padding:12px; }
  .pane { display:flex; flex-direction:column; }
  .shot { flex:1; overflow:hidden; border-radius:8px; background:#0f1720; }
  .pane img { width:100%; display:block; object-fit:cover; object-position:top center; }
  .left .shot { height:430px; } .right .shot { height:430px; }
  .left img { transform: scale(1.42); transform-origin: 50% 46%; }
  .cap { font-size:23px; color:#8fa0b2; padding:10px 4px 2px; }
  .stats { display:flex; flex-wrap:wrap; gap:12px; padding:22px 46px 0; }
  .stat { background:#16202b; border:1px solid #26333f; border-radius:12px; padding:14px 20px; }
  .n { font-size:38px; font-weight:800; color:#7cc4ff; }
  .l { font-size:21px; color:#9fb0c0; margin-top:2px; }
  .foot { position:absolute; bottom:0; left:0; right:0; padding:26px 46px 30px; border-top:1px solid #26333f;
          display:flex; justify-content:space-between; align-items:center; }
  .url { font-size:36px; font-weight:800; }
  .free { font-size:26px; color:#6fe3a2; font-weight:700; }
  .tiny { font-size:20px; color:#7d8b99; padding:18px 46px 0; line-height:1.4; }
</style></head><body>
  <div class="head">
    <div class="brand">LOADLENS</div>
    <div class="h1">Cooling load from the <span>floor plan PDF</span>.</div>
    <div class="sub">Room-wise TR, L/s and m&sup2;/TR in the browser. It measures the areas from the
      drawing&rsquo;s own outlines &mdash; and leaves a room blank rather than guess it.</div>
  </div>
  <div class="pair">
    <div class="pane left"><div class="shot"><img src="data:image/png;base64,${planB64}"></div><div class="cap">1. Open the plan</div></div>
    <div class="pane right"><div class="shot"><img src="data:image/png;base64,${schedB64}"></div><div class="cap">2. Read the schedule</div></div>
  </div>
  <div class="stats">
    <div class="stat"><div class="n">${totals.tr} TR</div><div class="l">total cooling load</div></div>
    <div class="stat"><div class="n">${totals.rooms}</div><div class="l">rooms in the load</div></div>
    <div class="stat"><div class="n">${totals.m2PerTr} m&sup2;/TR</div><div class="l">area served per ton</div></div>
    <div class="stat"><div class="n">${totals.ls} L/s</div><div class="l">supply air</div></div>
  </div>
  <div class="tiny">Numbers above are this sample sheet, measured live in the browser. Free, no sign-up.
    A wrong number is worse than a blank one, so anything it cannot measure stays blank and says why.</div>
  <div class="foot"><div class="url">loadlens.net</div><div class="free">Free &middot; no sign-up</div></div>
</body></html>`;
await card.setContent(html, { waitUntil: "load" });
await new Promise((r) => setTimeout(r, 800));
await card.screenshot({ path: `${OUT}/ad-static.png` });
console.log(`wrote ${OUT}/ad-static.png`);
await browser.close();
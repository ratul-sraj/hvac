// Quick check: the calculator page has the shared nav and every link works.
import puppeteer from "puppeteer-core";
const BASE = process.argv[2] || "http://127.0.0.1:3000/";
const b = await puppeteer.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: "new", args: ["--no-sandbox", "--disable-gpu"], protocolTimeout: 120000,
});
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 1000 });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await p.goto(BASE + "app.html", { waitUntil: "networkidle2", timeout: 60000 });
const links = await p.$$eval("nav.app-nav a", (as) => as.map((a) => [a.textContent.trim(), a.getAttribute("href")]));
console.log("nav links:", JSON.stringify(links));
let bad = [];
for (const [text, href] of links) {
  const r = await p.goto(new URL(href, BASE + "app.html").href, { waitUntil: "domcontentloaded", timeout: 30000 });
  if (!r || (r.status() !== 200 && r.status() !== 304)) bad.push(`${href} -> ${r && r.status()}`);
  console.log(`  ${text.padEnd(12)} ${href.padEnd(14)} ${r && r.status()}`);
}
await p.goto(BASE + "app.html", { waitUntil: "networkidle2" });
await p.screenshot({ path: "tests/qa/app-nav.png" });
console.log(bad.length ? "FAILED links: " + bad.join(", ") : "all nav links OK");
console.log("console errors:", errs.length ? errs.slice(0, 3).join(" | ") : "none");
await b.close();
process.exit(bad.length || errs.length ? 1 : 0);
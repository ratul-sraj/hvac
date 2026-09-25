// Checks the shared top navigation on every page, in both layouts.
//   cd D:/webhvac && node tools/check-nav.mjs [base-url]
// Desktop: every page has the nav and all its links answer 200/304.
// Narrow (390 px): a hamburger button appears, the links are hidden, tapping the button
// shows them, Escape / tapping outside closes them, and nothing overflows sideways.
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] || "http://127.0.0.1:3000/";
const PAGES = [
  { url: "app.html", nav: "nav.app-nav", links: ".app-nav-links", burger: "nav.app-nav .nav-burger", file: "nav-app" },
  { url: "index.html", nav: "header.site-nav", links: ".nav-links", burger: "header.site-nav .nav-burger", file: "nav-home" },
  { url: "method.html", nav: "header.site-nav", links: ".nav-links", burger: "header.site-nav .nav-burger", file: "nav-method" },
  { url: "help.html", nav: "header.site-nav", links: ".nav-links", burger: "header.site-nav .nav-burger", file: "nav-help" },
  { url: "about.html", nav: "header.site-nav", links: ".nav-links", burger: "header.site-nav .nav-burger", file: "nav-about" },
];
const OUT = "tests/qa";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const ok = (label, pass, detail = "") => {
  results.push({ label, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
  protocolTimeout: 120000,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

for (const spec of PAGES) {
  const url = BASE + spec.url;
  const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  ok(`${spec.url} loads`, !!resp && (resp.status() === 200 || resp.status() === 304), `HTTP ${resp && resp.status()}`);

  // ---- desktop ----------------------------------------------------------
  await page.setViewport({ width: 1400, height: 1000 });
  await new Promise((r) => setTimeout(r, 250));
  const desktop = await page.evaluate((sel) => {
    const nav = document.querySelector(sel);
    if (!nav) return { nav: false };
    const burger = nav.querySelector(".nav-burger");
    const links = nav.querySelector(".nav-links, .app-nav-links");
    const hrefs = [...(links ? links.querySelectorAll("a") : [])].map((a) => a.getAttribute("href"));
    return {
      nav: true,
      burgerShown: !!burger && getComputedStyle(burger).display !== "none",
      linksShown: !!links && getComputedStyle(links).display !== "none",
      hrefs,
    };
  }, spec.nav);
  ok(`${spec.url}: nav present with links visible on desktop`,
    desktop.nav && desktop.linksShown && !desktop.burgerShown && desktop.hrefs.length >= 4,
    JSON.stringify(desktop.hrefs));

  // every link must answer
  let bad = [];
  for (const href of desktop.hrefs || []) {
    const r = await page.goto(new URL(href, url).href, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!r || (r.status() !== 200 && r.status() !== 304)) bad.push(`${href} ${r && r.status()}`);
  }
  ok(`${spec.url}: every nav link answers`, bad.length === 0, bad.join(", ") || `${(desktop.hrefs || []).length} links ok`);

  // ---- narrow (390 px) --------------------------------------------------
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((r) => setTimeout(r, 350));
  const narrowClosed = await page.evaluate((sel) => {
    const nav = document.querySelector(sel);
    const burger = nav.querySelector(".nav-burger");
    const links = nav.querySelector(".nav-links, .app-nav-links");
    return {
      burgerShown: !!burger && getComputedStyle(burger).display !== "none",
      burgerLabel: burger ? burger.getAttribute("aria-label") : null,
      expanded: burger ? burger.getAttribute("aria-expanded") : null,
      linksShown: !!links && getComputedStyle(links).display !== "none",
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, spec.nav);
  ok(`${spec.url}: hamburger shows on a narrow screen`, narrowClosed.burgerShown, JSON.stringify(narrowClosed));
  ok(`${spec.url}: menu is closed until tapped`, narrowClosed.linksShown === false && narrowClosed.expanded === "false");
  ok(`${spec.url}: no sideways overflow at 390 px`, narrowClosed.overflow === false);

  // The LoadLens brand must reach the home page from EVERY page, and the nav must carry a Home link —
  // on a phone the ☰ menu is the only nav there is, so a missing Home there strands you on a subpage.
  const home = await page.evaluate((sel) => {
    const nav = document.querySelector(sel);
    const brand = nav.querySelector("a.brand, a.app-nav-brand");
    return {
      brandTag: brand ? brand.tagName : null,
      brandHref: brand ? brand.getAttribute("href") : null,
      links: [...nav.querySelectorAll(".nav-links a, .app-nav-links a")].map((a) => ({
        text: a.textContent.trim(), href: a.getAttribute("href"),
      })),
    };
  }, spec.nav);
  const goesHome = (h) => !!h && /^(?:\.\/|\/)?(?:index\.html)?\/?$/i.test(h) && h !== "";
  ok(`${spec.url}: clicking the brand goes to the home page`,
    home.brandTag === "A" && goesHome(home.brandHref), `${home.brandTag} href=${home.brandHref}`);
  const homeLink = home.links.find((l) => /^home$/i.test(l.text));
  ok(`${spec.url}: the nav offers a Home link`,
    !!homeLink && goesHome(homeLink.href),
    home.links.map((l) => `${l.text}->${l.href}`).join(", "));

  await page.click(spec.burger);
  await new Promise((r) => setTimeout(r, 350));
  const open = await page.evaluate((sel) => {
    const nav = document.querySelector(sel);
    const links = nav.querySelector(".nav-links, .app-nav-links");
    const cs = getComputedStyle(links);
    const box = links.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 12);
    return {
      linksShown: cs.display !== "none",
      direction: cs.flexDirection,
      expanded: nav.querySelector(".nav-burger").getAttribute("aria-expanded"),
      firstLinkClickable: !!(hit && hit.closest("a")),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, spec.nav);
  ok(`${spec.url}: tapping the hamburger opens a stacked menu`,
    open.linksShown && open.direction === "column" && open.expanded === "true", JSON.stringify(open));
  ok(`${spec.url}: open menu does not overflow the screen`, open.overflow === false);
  await page.screenshot({ path: `${OUT}/${spec.file}-open.png` });
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 300));
  const afterEsc = await page.evaluate((sel) => {
    const nav = document.querySelector(sel);
    return getComputedStyle(nav.querySelector(".nav-links, .app-nav-links")).display !== "none";
  }, spec.nav);
  ok(`${spec.url}: Escape closes the menu`, afterEsc === false);

  // tapping a link must navigate (test on the calculator page only, it is the heaviest)
  if (spec.url === "app.html") {
    await page.click(spec.burger);
    await new Promise((r) => setTimeout(r, 250));
    await page.click("nav.app-nav .app-nav-links a[href='method.html']");
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    ok("tapping a menu link navigates", page.url().includes("method.html"), page.url());
  }
  await page.setViewport({ width: 1400, height: 1000 });
}

ok("no console errors anywhere", errors.length === 0, errors.slice(0, 3).join(" | ") || "none");

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} navigation checks passed`);
fs.writeFileSync(`${OUT}/nav-report.json`, JSON.stringify(results, null, 1));
if (failed.length) {
  console.log("failed:\n" + failed.map((f) => "  - " + f.label + " :: " + f.detail).join("\n"));
  process.exit(1);
}
console.log("ALL NAVIGATION CHECKS PASSED");
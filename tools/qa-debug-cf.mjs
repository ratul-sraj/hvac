// Throwaway diagnostic: why does the "Load sample drawing" button stall on the AWS build
// (CloudFront) when it works against localhost? Drives real Edge with puppeteer-core, clicks
// #btnSample and prints every console message, request failure and API response.
import puppeteer from "puppeteer-core";

const URL_ = process.argv[2] || "https://d3cf28rp8goz0w.cloudfront.net/app.html";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--no-first-run", "--disable-features=msEdgeSidebarV2"],
});
const page = await browser.newPage();
try {
  const cdp = await page.target().createCDPSession();
  await cdp.send("Page.setDownloadBehavior", { behavior: "deny" });
} catch {}

const logs = [];
page.on("console", (m) => logs.push(`console.${m.type()}: ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message.slice(0, 300)}`));
page.on("requestfailed", (r) => logs.push(`FAILED ${r.method()} ${r.url().slice(0, 120)} :: ${r.failure()?.errorText}`));
page.on("response", async (r) => {
  const u = r.url();
  if (u.includes("/api/") || u.endsWith(".pdf") || u.includes("vendor/")) {
    logs.push(`<- ${r.status()} ${r.request().method()} ${u.replace(/^https?:\/\/[^/]+/, "").slice(0, 110)}`);
  }
});

console.log("URL:", URL_);
await page.goto(URL_, { waitUntil: "networkidle2", timeout: 60000 });

// what does the app think about the server?
console.log("probe:", await page.evaluate(async () => {
  try {
    const r = await fetch("/api/health");
    return `${r.status} ${(await r.text()).slice(0, 120)}`;
  } catch (e) { return "threw: " + e.message; }
}));

console.log("\n--- clicking #btnSample ---");
const t0 = Date.now();
await page.click("#btnSample").catch((e) => console.log("click failed:", e.message));
try {
  await page.waitForFunction(() => {
    const b = document.querySelector("#roomsBody");
    return b && b.querySelectorAll("tr").length > 100;
  }, { timeout: 90000 });
  const rows = await page.$$eval("#roomsBody tr", (r) => r.length);
  console.log(`OK: ${rows} room rows in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (e) {
  console.log(`STALLED after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log("status text:", (await page.evaluate(() => {
    const s = document.querySelector("#status") || document.querySelector(".status") || document.querySelector("#warnings");
    return s ? s.innerText.replace(/\s+/g, " ").slice(0, 400) : "(no status element)";
  })));
  console.log("room rows now:", await page.$$eval("#roomsBody tr", (r) => r.length).catch(() => "n/a"));
}

console.log("\n--- browser activity ---");
console.log(logs.slice(-40).join("\n") || "(none)");
await browser.close();

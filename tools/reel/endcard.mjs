// Screenshot the end card to a 1080x1080 PNG for the ad. HTML rather than ffmpeg drawtext: the
// drawtext filter segfaults in this MSYS ffmpeg build, and HTML gives the real brand typography.
import puppeteer from "puppeteer-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = "D:/webhvac/infra/.tmp/reel/endcard.png";
const EXE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 });
await page.goto("file:///" + path.join(HERE, "endcard.html").replace(/\\/g, "/"), { waitUntil: "load" });
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: OUT });
await browser.close();
console.log("endcard.png written:", OUT);

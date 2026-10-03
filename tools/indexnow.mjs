// Tell Bing (and the other IndexNow engines: Yandex, Seznam, Naver) that these URLs exist, without
// waiting for a crawl. Reads the URLs from sitemap.xml so it can never submit a page we do not publish.
//
//   node tools/indexnow.mjs                 # dry run: prints what would be sent
//   node tools/indexnow.mjs --live          # actually submits
//
// IndexNow needs no account and no verification: it fetches https://loadlens.net/<key>.txt and checks
// the key matches. That file is <key>.txt in the repo root, shipped by the deploy.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "loadlens.net";
const ENDPOINT = "https://api.indexnow.org/indexnow";
const live = process.argv.includes("--live");

const xml = fs.readFileSync(path.join(ROOT, "sitemap.xml"), "utf8");
const urlList = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
if (!urlList.length) { console.error("no <loc> entries in sitemap.xml"); process.exit(1); }

// The key is whichever <32 hex>.txt sits in the repo root; if several exist, they must agree.
const keyFiles = fs.readdirSync(ROOT).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (keyFiles.length !== 1) {
  console.error(`expected exactly one <32 hex>.txt key file in the repo root, found ${keyFiles.length}`);
  process.exit(1);
}
const key = fs.readFileSync(path.join(ROOT, keyFiles[0]), "utf8").trim();
const keyLocation = `https://${HOST}/${keyFiles[0]}`;
const body = { host: HOST, key, keyLocation, urlList };

console.log(`host: ${HOST}`);
console.log(`key file: ${keyFiles[0]} (${key.length} chars)`);
console.log(`keyLocation: ${keyLocation}`);
console.log(`urls (${urlList.length}):`);
for (const u of urlList) console.log(`  ${u}`);

if (!live) { console.log("\ndry run - pass --live to submit"); process.exit(0); }

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});
const text = await res.text().catch(() => "");
console.log(`\nsubmitted -> HTTP ${res.status} ${res.statusText}`);
if (text.trim()) console.log(text.trim().slice(0, 400));
// 200 = accepted, 202 = accepted but key still being validated. Anything else is a real failure.
process.exit(res.status === 200 || res.status === 202 ? 0 : 1);

// tests/test-visitors.mjs — guards on tools/visitors.mjs (the CloudFront access-log reader).
//
//   cd D:/webhvac && node tests/test-visitors.mjs
//
// No network: the fixtures are small in-memory CloudFront log texts. The things pinned here are
// the ones that would silently ruin the number:
//   * fields come from the '#Fields:' header, so a row missing trailing fields still parses;
//   * a bot hit and an own-address hit are excluded and COUNTED as excluded;
//   * the same address+browser on the same UTC day is ONE visitor, on two days are TWO;
//   * an asset or /api/parse request is not a visit;
//   * a raw address NEVER reaches the output — the printed JSON carries neither the address
//     string nor the address column name;
//   * a malformed line is skipped and reported, never fatal.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseLog, analyze, makeVisitorId, isBot, loadOwnIps, ipMatchesAny, PAGE_PATHS, UA_DENY, decodeLog,
} from "../tools/visitors.mjs";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TOOL = path.join(ROOT, "tools", "visitors.mjs");

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};

/* ----------------------------- fixture ---------------------------------- */
const IP_VISITOR = "203.0.113.99";   // a real-looking visitor address
const IP_ASSET = "198.51.100.7";     // only ever fetched an asset / the API
const IP_OWN = "192.0.2.50";         // the owner's own address
const UA_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const UA_BOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

// Fields are space-separated in the header, rows are tab-separated (CloudFront standard format).
const FIELDS = [
  "date", "time", "x-edge-location", "sc-bytes", "c-ip", "cs-method", "cs(Host)",
  "cs-uri-stem", "sc-status", "cs(Referer)", "cs(User-Agent)", "cs-uri-query",
  "x-edge-result-type", "x-edge-request-id", "x-host-header", "cs-protocol",
];
const HEADER = "#Version: 1.0\n#Fields: " + FIELDS.join(" ") + "\n";

// Build one tab-separated row. Missing trailing fields are allowed by design.
const row = (o) => FIELDS.map((f) => (o[f] == null ? "" : o[f])).join("\t");

const DAY1 = "2026-10-04";
const DAY2 = "2026-10-03";

const ROWS = [
  // two hits from the SAME address+browser on the SAME day -> ONE visitor
  row({ date: DAY1, time: "08:00:00", "c-ip": IP_VISITOR, "cs-uri-stem": "/", "cs(User-Agent)": UA_CHROME, "sc-status": "200", "cs-uri-query": "-" }),
  row({ date: DAY1, time: "09:30:00", "c-ip": IP_VISITOR, "cs-uri-stem": "/index.html", "cs(User-Agent)": UA_CHROME, "sc-status": "200" }),
  // same pair on a DIFFERENT day -> a SECOND visitor
  row({ date: DAY2, time: "14:00:00", "c-ip": IP_VISITOR, "cs-uri-stem": "/app.html", "cs(User-Agent)": UA_CHROME, "sc-status": "200" }),
  // a bot on a page -> excluded and counted as a bot
  row({ date: DAY1, time: "10:00:00", "c-ip": "66.249.66.1", "cs-uri-stem": "/about.html", "cs(User-Agent)": UA_BOT, "sc-status": "200" }),
  // the owner's own address on a page -> excluded and counted as own
  row({ date: DAY1, time: "10:05:00", "c-ip": IP_OWN, "cs-uri-stem": "/help.html", "cs(User-Agent)": UA_CHROME, "sc-status": "200" }),
  // a script asset and the API -> real requests, but NOT visits
  row({ date: DAY1, time: "11:00:00", "c-ip": IP_ASSET, "cs-uri-stem": "/js/app.js", "cs(User-Agent)": UA_CHROME, "sc-status": "200" }),
  row({ date: DAY1, time: "11:01:00", "c-ip": IP_ASSET, "cs-uri-stem": "/api/parse", "cs(User-Agent)": UA_CHROME, "sc-status": "200" }),
  row({ date: DAY1, time: "11:02:00", "c-ip": IP_ASSET, "cs-uri-stem": "/api/parse", "cs(User-Agent)": UA_CHROME, "sc-status": "500" }),
  // a row with only the first six fields (missing trailing fields) -> parses, no crash
  row({ date: DAY1, time: "12:00:00", "c-ip": IP_VISITOR, "cs-uri-stem": "/method.html", "cs(User-Agent)": UA_CHROME }),
  "this is not a log line at all",
];

const TEXT = HEADER + ROWS.join("\n") + "\n";

/* ------------------------------ parse ----------------------------------- */
const parsed = parseLog(TEXT);
ok("parse-by-header: #Fields names are read", parsed.fields.includes("cs-uri-stem") && parsed.fields.includes("cs(User-Agent)"), parsed.fields.length + " fields");
ok("a short row (missing trailing fields) still parses", parsed.rows.length === 9, "rows=" + parsed.rows.length);
ok("malformed line is counted, not fatal", parsed.malformed === 1, "malformed=" + parsed.malformed);

/* ------------------------------ helpers --------------------------------- */
ok("isBot flags the Googlebot UA", isBot(UA_BOT) === true);
ok("isBot does not flag the Chrome UA", isBot(UA_CHROME) === false);
ok("UA_DENY is the documented deny-list", UA_DENY instanceof RegExp && UA_DENY.test("curl/8.0"));
ok("PAGE_PATHS has the home page paths", PAGE_PATHS.has("/") && PAGE_PATHS.has("/index.html") && PAGE_PATHS.has("/app.html"));
ok("id is 12 hex chars", /^[0-9a-f]{12}$/.test(makeVisitorId(IP_VISITOR, UA_CHROME, DAY1)));
ok("same inputs -> same id", makeVisitorId(IP_VISITOR, UA_CHROME, DAY1) === makeVisitorId(IP_VISITOR, UA_CHROME, DAY1));
ok("a different day -> a different id", makeVisitorId(IP_VISITOR, UA_CHROME, DAY1) !== makeVisitorId(IP_VISITOR, UA_CHROME, DAY2));
ok("ipMatchesAny: exact", ipMatchesAny("1.2.3.4", ["1.2.3.4"]) === true);
ok("ipMatchesAny: trailing-dot prefix", ipMatchesAny("157.51.219.205", ["157.51."]) === true);
ok("ipMatchesAny: CIDR", ipMatchesAny("1.2.3.99", ["1.2.3.0/24"]) === true && ipMatchesAny("1.2.4.1", ["1.2.3.0/24"]) === false);

/* ------------------------------ analyze --------------------------------- */
const stats = analyze(parsed, { ownIps: [IP_OWN] });

ok("bot hit excluded and counted", stats.excluded.bots === 1, "bots=" + stats.excluded.bots);
ok("own-address hit excluded and counted", stats.excluded.ownIp === 1, "own=" + stats.excluded.ownIp);
ok("total excluded hits reported", stats.excluded.total === 2, "total=" + stats.excluded.total);

// Visitor (IP_VISITOR+Chrome): day1 one id (/, /index.html, /method.html all same day), day2 one id.
ok("same pair, same UTC day -> ONE visitor", stats.unique.byDay[DAY1] === 1, "day1=" + stats.unique.byDay[DAY1]);
ok("same pair, different day -> TWO visitors", stats.unique.window === 2, "window=" + stats.unique.window);
ok("byDay has one entry per day", Object.keys(stats.unique.byDay).length === 2);
ok("'/' + '/index.html' count as the one home page", stats.unique.perPage["/"] === 1 && stats.unique.perPage["/app.html"] === 1, JSON.stringify(stats.unique.perPage));

ok("a /js/*.js hit is not a visit", !Object.keys(stats.unique.perPage).includes("/js/app.js"));
ok("a /api/parse hit is not a visit", !Object.keys(stats.unique.perPage).includes("/api/parse"));
ok("/api/parse is reported separately with a status split", stats.api.count === 2 && stats.api.byStatus["200"] === 1 && stats.api.byStatus["500"] === 1, JSON.stringify(stats.api));
ok("total requests counts everything parsed", stats.totalRequests === 9, "total=" + stats.totalRequests);
ok("skipped malformed lines surfaced", stats.skipped === 1);
ok("top stems are present", stats.byStem.some(([s]) => s === "/api/parse"));
ok("unfiltered count ignores exclusions", stats.uniqueUnfiltered.window >= stats.unique.window, `unfiltered=${stats.uniqueUnfiltered.window} clean=${stats.unique.window}`);

/* --------------------- raw address never in the output ------------------ */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadlens-visitors-"));
const logFile = path.join(dir, "fixture.gz.log");
const ipsFile = path.join(dir, "own-ips.txt");
fs.writeFileSync(logFile, TEXT, "utf8");
fs.writeFileSync(ipsFile, "# comment\n" + IP_OWN + "\n\n", "utf8");

const run = spawnSync(process.execPath, [TOOL, "--file", logFile, "--own-ips", ipsFile, "--json"], { encoding: "utf8" });
const out = (run.stdout || "") + (run.stderr || "");
ok("CLI exits 0 on a fixture", run.status === 0, "status=" + run.status);
ok("output never contains a raw visitor address", !out.includes(IP_VISITOR), IP_VISITOR);
ok("output never contains the owner's address", !out.includes(IP_OWN));
ok("output never contains the asset address", !out.includes(IP_ASSET));
ok("output never contains the address column name", !out.includes("c-ip"));
// the JSON block must contain the aggregate result
ok("CLI JSON reports the two unique visitors", /"uniqueVisitors"[\s\S]*?"window": 2/.test(out));
ok("CLI JSON has no address-named key", !/"c-ip"/.test(out));

/* ------------------------- own-IP file handling ------------------------- */
const missing = loadOwnIps(path.join(dir, "does-not-exist.txt"));
ok("a missing own-IP file is not an error", missing.exists === false && missing.entries.length === 0 && missing.error === "ENOENT");
const loaded = loadOwnIps(ipsFile);
ok("own-IP file comments and blanks are ignored", loaded.exists === true && loaded.entries.length === 1 && loaded.entries[0] === IP_OWN);

/* ------------------------- gzip / plain handling ----------------------- */
const gzDec = decodeLog(zlib.gzipSync(Buffer.from(TEXT, "utf8")));
ok("a gzipped log file is gunzipped", gzDec.gz === true && gzDec.text.includes("#Fields:") && gzDec.text.includes(IP_VISITOR));
const plainDec = decodeLog(Buffer.from(TEXT, "utf8"));
ok("a non-gzipped log file is read as plain text", plainDec.gz === false && plainDec.text.includes("#Fields:"));

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) { console.log("FAILED"); process.exit(1); }
console.log("VISITORS OK");

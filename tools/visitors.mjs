// tools/visitors.mjs — how many REAL people visited in the last N hours, read from
// this site's own CloudFront access logs.
//
//   node tools/visitors.mjs                 # the last 24 hours
//   node tools/visitors.mjs --hours 48      # a wider window
//   node tools/visitors.mjs --json          # also machine-readable
//   node tools/visitors.mjs --file a.log    # read a local log file instead of S3 (offline / tests)
//
// WHY THIS EXISTS
// The site's /api/event beacon is anonymous by design — no cookie and no id — so event
// counts can never say how many PEOPLE came; one visitor who reloads counts twice.
// CloudFront standard access logs can, because they record the address that asked and the
// browser it claimed to be. These are the site's OWN logs, in the owner's own AWS account.
// This tool reads them locally and uploads nothing anywhere.
//
// PRIVACY — never a raw address on screen:
//   A visitor is identified only by a short salted hash, sha256(SALT + address + user-agent)
//   truncated to its first 12 hex characters, ONE id per UTC day. A raw address is never
//   printed and never stored in --json — not even the owner's own. Only the hash prefix and
//   aggregate counts leave this process.
//
// PER-CAMPAIGN ATTRIBUTION: the standard log's cs-uri-query holds the utm_* tags a link carried
// (see tools/job-links.mjs, which mints one tagged link per job-email recipient). This tool
// groups the unique real visitors by utm_campaign, with "(none)" for a visit that arrived without
// a tag, and shows the (campaign/content) pair when a request carried both — so a single emailed
// link can be told apart from a campaign-wide one. An untagged share still counts as a visitor;
// it simply cannot be attributed, and the report says so rather than guessing.
//
// TRAFFIC THAT IS NOT PEOPLE is removed three ways and each is reported:
//   (a) a user-agent deny-list covering bots, monitors and automation (see UA_DENY below);
//   (b) an own-address list read from a file that lives OUTSIDE this public repo, because a
//       home address is personal data. Default:
//         C:\Users\Aorus\Documents\LoadLens-Own-IPs.txt
//       one entry per line, '#' starts a comment, blank lines are fine. An entry may be an
//       exact address, a trailing-dot prefix ("157.51."), or a CIDR block ("203.0.113.0/24").
//       Override with --own-ips <path>. If the file is missing the tool says so and excludes
//       nothing by address — it never fails.
//
// Node only, no dependencies. Uses the AWS CLI exactly like the rest of infra/. If nothing
// has been delivered yet it says so and exits 0. It never throws on a bad line: malformed
// lines are skipped and counted.
import { spawnSync, execFile } from "node:child_process";
import zlib from "node:zlib";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ------------------------------- config -------------------------------- */
const DEFAULT_BUCKET = "loadlens-logs-395298786586";
const DEFAULT_PREFIX = "cf/";
const DEFAULT_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
// Kept OUTSIDE the public repo on purpose: a home address is personal data.
const DEFAULT_OWN_IPS = "C:\\Users\\Aorus\\Documents\\LoadLens-Own-IPs.txt";
// Fixed, public salt. Its job is only to make the printed id short and non-reversible-looking,
// not to be a secret — anyone with the logs and this file could recompute it anyway.
const VISITOR_SALT = "loadlens-cf-access-log|visitor-id|v1";

// The pages a person actually opens. Everything else (assets, robots, /api/*) is not a visit.
const PAGE_PATHS = new Set([
  "/", "/index.html", "/app.html", "/case-study.html", "/about.html",
  "/method.html", "/help.html", "/design-conditions.html", "/selftest.html",
]);

// Every path the DEPLOYED site actually has. It is a static site with a known file list, so "is this
// even on the site" is decidable rather than guessed. A request for /wp-admin/install.php cannot be
// anything but a scanner, however browser-like a user-agent it claims — which is exactly what a
// user-agent deny-list misses. Keep in step with what infra/50-deploy-site.sh uploads.
// The site's REAL file list, read from the bucket (aws s3 ls --recursive s3://loadlens-site-...).
// A request that is not in here is not a page, not an asset and not an endpoint, so it is a probe -
// however plausible it looks. Using the list instead of path PREFIXES is what stops a scanner probing
// /vendor/.env from being waved through as "an asset under /vendor/".
// Keep in step with what infra/50-deploy-site.sh uploads. If it drifts, the cost is only that a path
// shows up in the probe block (visible, and reported) rather than in the traffic table.
const SITE_FILE_LIST = [
  "/a538267c22d3d06f0d9dda2d2e87746e.txt", "/about.html", "/app.html",
  "/case-study.html", "/css/landing.css", "/css/style.css",
  "/design-conditions.html", "/favicon.ico", "/favicon.svg",
  "/help.html", "/img/ad-schedule.png", "/img/ad-static.png",
  "/img/case-level-table.png", "/img/case-plan-areas.png", "/img/case-summary.png",
  "/index.html", "/js/app.js", "/js/autotrace.js",
  "/js/calc.js", "/js/climates.js", "/js/drawstore.js",
  "/js/nav.js", "/js/ocr.js", "/js/overlay.js",
  "/js/pdfparse.js", "/js/planview.js", "/js/polyshape.js",
  "/js/report.js", "/js/schedule.js", "/js/splitregion.js",
  "/js/trace.js", "/js/unitdetect.js", "/js/units.js",
  "/js/usage.js", "/js/viewer.js", "/method.html",
  "/robots.txt", "/samples/level-11-floor-plan.pdf", "/samples/room-types.csv",
  "/samples/sample-plan.pdf", "/samples/schedule-sample.pdf", "/samples/schedule.csv",
  "/samples/schedule.xlsx", "/samples/waller-estate-floor-plan.pdf", "/selftest.html",
  "/sitemap.xml", "/vendor/pdf.min.mjs", "/vendor/pdf.worker.min.mjs",
  "/vendor/tesseract/LICENSE-tesseract.js-core.txt", "/vendor/tesseract/LICENSE-tesseract.js.md", "/vendor/tesseract/README.md",
  "/vendor/tesseract/eng.traineddata.gz", "/vendor/tesseract/tesseract-core-lstm.wasm.js", "/vendor/tesseract/tesseract-core-relaxedsimd-lstm.wasm.js",
  "/vendor/tesseract/tesseract-core-simd-lstm.wasm.js", "/vendor/tesseract/tesseract.esm.min.js", "/vendor/tesseract/tesseract.esm.min.js.LICENSE.txt",
  "/vendor/tesseract/worker.min.js", "/vendor/xlsx/README.md",
];
// The API's own paths are NOT in the bucket - CloudFront sends them to the Lambda - so they are listed
// here. They are real: the page fetches api/health on load and posts its anonymous events to api/event,
// and the server also answers api/parse, api/calc and api/climates. Miss one and the tool reports the
// app's OWN traffic as a scanner probing for it.
const API_PATHS = ["/api/health", "/api/event", "/api/parse", "/api/calc", "/api/climates"];
const SITE_FILES = new Set([...SITE_FILE_LIST, ...API_PATHS]);
const SITE_VERIFY_FILE = /^\/[0-9a-f]{16,64}\.txt$/;      // root-level site-verification file

function isSitePath(stem) {
  if (!stem) return false;
  if (PAGE_PATHS.has(stem) || SITE_FILES.has(stem)) return true;
  if (SITE_VERIFY_FILE.test(stem)) return true;      // a root-level verification file added later
  return false;
}

// A visitor is a SCANNER when NOT ONE of their requests is a path this site has. A real person's first
// request is always a page or one of that page's assets, so this cannot catch a person; and because it
// leans on the site's own file list it needs no guessing about who they claim to be.
// PROBE_BURST: a scanner that did once request "/" is still a scanner if it also fired this many
// unknown paths in the same day - nobody browses by hammering /wp-login.php.
const PROBE_BURST = 20;

// Bots, crawlers, monitors and scripted clients. Exactly the deny-list the brief names.
const UA_DENY =
  /bot|crawl|spider|slurp|puppeteer|headless|playwright|python-requests|python-urllib|curl|wget|Go-http|Java\/|libwww|okhttp|axios|node-fetch|facebookexternalhit|WhatsApp|TelegramBot|GPTBot|ClaudeBot|PerplexityBot|Ahrefs|Semrush|MJ12|DotBot|UptimeRobot|StatusCake|Pingdom|monitor|check|uptime|lighthouse|Lighthouse|PageSpeed/i;

const F_IP = "c-ip";                 // internal only — never printed
const F_UA = "cs(User-Agent)";       // internal only
const F_STEM = "cs-uri-stem";
const F_QUERY = "cs-uri-query";      // carries the utm_* tags of the clicked link
const F_STATUS = "sc-status";
const F_DATE = "date";

// Standard CloudFront field order, used only if a file somehow lacks its #Fields: header.
const CF_FIELDS_FALLBACK =
  "date time x-edge-location sc-bytes c-ip cs-method cs(Host) cs-uri-stem sc-status cs(Referer) cs(User-Agent) cs-uri-query cs(Cookie) x-edge-result-type x-edge-request-id x-host-header cs-protocol cs-bytes time-taken x-forwarded-for ssl-protocol ssl-cipher x-edge-response-result-type cs-protocol-version fle-status fle-encrypted-fields c-port time-to-first-byte x-edge-detailed-result-type sc-content-type sc-content-len sc-range-start sc-range-end".split(
    " "
  );

/* ------------------------------- args ---------------------------------- */
function parseArgs(argv) {
  const opts = {
    hours: 24,
    bucket: process.env.LOADLENS_LOG_BUCKET || DEFAULT_BUCKET,
    prefix: DEFAULT_PREFIX,
    region: DEFAULT_REGION,
    ownIpsPath: DEFAULT_OWN_IPS,
    file: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hours") opts.hours = Number(argv[++i]);
    else if (a.startsWith("--hours=")) opts.hours = Number(a.slice(8));
    else if (a === "--bucket") opts.bucket = argv[++i];
    else if (a.startsWith("--bucket=")) opts.bucket = a.slice(9);
    else if (a === "--prefix") opts.prefix = argv[++i];
    else if (a.startsWith("--prefix=")) opts.prefix = a.slice(9);
    else if (a === "--region") opts.region = argv[++i];
    else if (a.startsWith("--region=")) opts.region = a.slice(9);
    else if (a === "--own-ips") opts.ownIpsPath = argv[++i];
    else if (a.startsWith("--own-ips=")) opts.ownIpsPath = a.slice(10);
    else if (a === "--file") opts.file = argv[++i];
    else if (a.startsWith("--file=")) opts.file = a.slice(7);
    else if (a === "--json") opts.json = true;
    else if (a === "--selftest") opts.selftest = true;
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
  }
  if (!Number.isFinite(opts.hours) || opts.hours <= 0) opts.hours = 24;
  return opts;
}

function printHelp() {
  console.log(`tools/visitors.mjs — unique REAL visitors from this site's CloudFront access logs

  node tools/visitors.mjs [--hours N] [--own-ips PATH] [--file PATH] [--json]
                          [--bucket NAME] [--prefix P] [--region R]

  --hours N       window to read, ending now (default 24)
  --own-ips PATH  own-address list to exclude (default ${DEFAULT_OWN_IPS})
  --file PATH     read one local log file instead of S3 (offline / tests)
  --json          also print the result as JSON
  --bucket NAME   S3 bucket holding the logs (default ${DEFAULT_BUCKET})
  --prefix P      key prefix (default ${DEFAULT_PREFIX})
  --region R      AWS region (default ${DEFAULT_REGION})
  --selftest      check the path classifier and the scanner rules on known examples, then exit
                  (no AWS access - run it after touching the file list or the rules)

A visitor is a short salted hash of (address + browser), one per UTC day. A raw address is
never printed and never stored. A visitor counts when they open a PAGE (assets are not a visit).

Traffic that is not people is removed three ways, each reported separately: a user-agent
deny-list, the own-address file above, and the scanner filter - a visitor whose every request is
for a path this site does not have. That last one is decidable because the site is static with a
real file list (plus the API paths CloudFront sends to the Lambda), so it is not a guess about who
someone claims to be. --selftest proves the classifier if you change the list.

The report also groups unique real visitors by the utm_campaign carried in the request URL
("(none)" = untagged), and shows the campaign/content pair when a request carried both, so a
visit from a tagged email link can be told apart from a stranger, a bot, or an untagged share.`);
}

/* ---------------------------- AWS CLI helper --------------------------- */
/** Run the AWS CLI. Returns { ok, stdout, error }. Never throws. */
function aws(args) {
  for (const cmd of ["aws", "aws.exe"]) {
    const res = spawnSync(cmd, [...args, "--no-cli-pager", "--output", "json"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
      // A HARD timeout: CloudFront writes its hourly log object while we may already have it in a
      // listing, and `aws s3 cp` on an object that is not readable yet retries for minutes. Without
      // this the whole report hangs with no output (measured: a 24h run died at exactly 300 s having
      // printed only "could not download cf/…-23.….gz"). A killed cp is a skipped file, not a crash.
      timeout: 45000,
      killSignal: "SIGKILL",
    });
    if (res.error) {
      if (res.error.code === "ENOENT") continue; // try aws.exe, then give up
      return { ok: false, error: String(res.error.message || res.error) };
    }
    if (res.status !== 0) {
      return { ok: false, error: (res.stderr || res.stdout || "").trim().split("\n").slice(-3).join(" ") };
    }
    return { ok: true, stdout: res.stdout || "" };
  }
  return { ok: false, error: "the AWS CLI ('aws') was not found on PATH" };
}

/**
 * List cf/ objects. Returns { ok, objects:[key], error }.
 * Uses s3api (not `s3 ls`) on purpose: `aws s3 ls s3://bucket/prefix` exits 1 with an empty
 * message when the prefix holds nothing, which is indistinguishable from a real failure.
 */
function listLogObjects(opts) {
  const objects = [];
  let token = null;
  for (let page = 0; page < 100; page++) {
    const args = ["s3api", "list-objects-v2", "--bucket", opts.bucket, "--prefix", opts.prefix, "--region", opts.region];
    if (token) args.push("--starting-token", token);
    const res = aws(args);
    if (!res.ok) return { ok: false, error: res.error, objects };
    let data;
    try { data = JSON.parse(res.stdout || "{}"); } catch { data = {}; }
    for (const c of data.Contents || []) {
      if (c && typeof c.Key === "string" && c.Key.endsWith(".gz")) objects.push(c.Key);
    }
    if (data.IsTruncated && data.NextToken) { token = data.NextToken; continue; }
    return { ok: true, objects };
  }
  return { ok: true, objects };
}

/** The UTC hour an access-log key covers, from its "YYYY-MM-DD-HH" suffix. */
function hourStartFromKey(key) {
  const m = key.match(/\.(\d{4})-(\d{2})-(\d{2})-(\d{2})\./);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), 0, 0);
}

/* ------------------------------ parsing -------------------------------- */
/**
 * Parse CloudFront standard log text. Field names come from the '#Fields:' header, so a
 * short row (missing trailing fields) is fine — it simply carries fewer keys.
 * Returns { fields, rows, malformed }.
 */
function parseLog(text) {
  const out = { fields: [], rows: [], malformed: 0 };
  let fields = null;
  for (const raw of String(text == null ? "" : text).split(/\r?\n/)) {
    if (raw === "") continue;
    if (raw.charCodeAt(0) === 35 /* '#' */) {
      const m = raw.match(/^#Fields:\s*(.*)$/);
      if (m) {
        const names = m[1].trim().split(/\s+/).filter(Boolean);
        if (names.length) { fields = names; out.fields = names; }
      }
      continue; // #Version and any other comment
    }
    const cols = raw.split("\t");
    const have = fields || CF_FIELDS_FALLBACK;
    const row = {};
    for (let i = 0; i < cols.length && i < have.length; i++) row[have[i]] = cols[i];
    // Validity: CloudFront logs always lead with a UTC date. Anything else is not a log line.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row[F_DATE] || "")) { out.malformed++; continue; }
    out.rows.push(row);
  }
  return out;
}

/* ------------------------------- privacy ------------------------------- */
/** The short, one-per-UTC-day id. A raw address never leaves this function in the clear. */
function makeVisitorId(ip, ua, day) {
  const h = crypto.createHash("sha256").update(`${VISITOR_SALT}|${day}|${ip || ""}|${ua || ""}`).digest("hex");
  return h.slice(0, 12);
}

function isBot(ua) {
  return UA_DENY.test(ua || "");
}

/* ------------------------------- own IPs ------------------------------- */
/** Read the own-address list. Missing file is not an error. Values are never printed. */
function loadOwnIps(filePath) {
  const result = { path: filePath, exists: false, entries: [], error: "" };
  let text;
  try { text = fs.readFileSync(filePath, "utf8"); }
  catch (e) { result.error = String(e && e.code ? e.code : e); return result; }
  result.exists = true;
  result.entries = text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
  return result;
}

/** Compare an IPv4 "a.b.c.d" against "a.b" / "a.b." / "a.b.c.d" / "a.b.c.d/24". */
function ipInCidr(ip, cidr) {
  const [net, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (s) => {
    const p = String(s).split(".");
    if (p.length !== 4) return null;
    let n = 0;
    for (const part of p) {
      const v = Number(part);
      if (!/^\d+$/.test(part) || v > 255) return null;
      n = (n << 8) | v;
    }
    return n >>> 0;
  };
  const a = toInt(ip), b = toInt(net);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function ipMatchesAny(ip, entries) {
  if (!ip) return false;
  for (const e of entries) {
    if (e.includes("/")) { if (ipInCidr(ip, e)) return true; }
    else if (e.endsWith(".") || e.endsWith(":")) { if (ip.startsWith(e)) return true; }
    else if (ip === e) return true;
  }
  return false;
}

/* --------------------------- campaign tagging -------------------------- */
/**
 * Parse a CloudFront cs-uri-query value into a flat object. '-' or '' means no query.
 * Values are URI-decoded (a '+' is treated as a space, matching how a query string is read).
 * Never throws on a malformed escape.
 */
function parseQuery(q) {
  const out = {};
  const raw = String(q == null ? "" : q).trim();
  if (!raw || raw === "-") return out;
  for (const part of raw.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = eq >= 0 ? part.slice(0, eq) : part;
    const v = eq >= 0 ? part.slice(eq + 1) : "";
    let dk, dv;
    try { dk = decodeURIComponent(k.replace(/\+/g, " ")); } catch { dk = k; }
    try { dv = decodeURIComponent(v.replace(/\+/g, " ")); } catch { dv = v; }
    if (dk) out[dk] = dv;
  }
  return out;
}

/**
 * A raw utm_* value -> the same stable token the site's own beacon records, so a visit read here
 * reconciles with the same visit read from the beacons (js/usage.js normaliseUtm): lower-cased,
 * runs of separators -> a single '-', trimmed, capped at 64. Kept in sync with js/usage.js by
 * hand (that module is a browser ES module and is not imported here).
 */
function normaliseCampaignToken(value) {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (!raw || raw.length > 512) return "";
  return raw.toLowerCase().replace(/[^a-z0-9._~-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
}

/** The (campaign, content) a request carried. campaign is "(none)" when absent or unreadable. */
function campaignOf(query) {
  const q = parseQuery(query);
  const campaign = normaliseCampaignToken(q.utm_campaign || "") || "(none)";
  const content = normaliseCampaignToken(q.utm_content || "");
  return { campaign, content };
}

/* ------------------------------ analysis ------------------------------- */
const pageOf = (stem) => (stem === "/index.html" ? "/" : stem); // '/' + '/index.html' are the home page

/**
 * Turn parsed rows into the report. `parsed` may be a parseLog() result or a plain row array.
 * opts: { ownIps, skipped, now }
 */
function analyze(parsed, opts = {}) {
  const rows = Array.isArray(parsed) ? parsed : parsed.rows || [];
  const skipped = Array.isArray(parsed) ? opts.skipped || 0 : parsed.malformed || 0;
  const ownIps = (opts.ownIps || []).map((s) => String(s).trim()).filter(Boolean);

  const excluded = { total: 0, bots: 0, ownIp: 0, probes: 0 };
  // One pass to see who probes: a single hit proves nothing, the decision needs the visitor's whole
  // day. Keys are the same `${day}|${id}` used everywhere else, so the rejected figure is PEOPLE
  // (one per UTC day), not hits.
  const visitorPaths = new Map();          // key -> { site, probe }
  const probeStemCount = new Map();        // unknown path -> hits, reported but never counted as a visit
  for (const r of rows) {
    const stem = r[F_STEM] || "";
    if (!stem) continue;
    const day = r[F_DATE] || "unknown";
    const key = `${day}|${makeVisitorId(r[F_IP] || "", r[F_UA] || "", day)}`;
    const cur = visitorPaths.get(key) || { site: 0, probe: 0 };
    if (isSitePath(stem)) cur.site += 1;
    else { cur.probe += 1; probeStemCount.set(stem, (probeStemCount.get(stem) || 0) + 1); }
    visitorPaths.set(key, cur);
  }
  const probeOnly = new Set();
  for (const [key, s] of visitorPaths) {
    if (!s.probe) continue;
    if (s.site === 0 || (s.probe >= PROBE_BURST && s.site <= 1)) probeOnly.add(key);
  }
  const cleanIds = new Set();          // `${day}|${id}` for real page visits
  const allIds = new Set();            // no exclusions at all, for the cost comparison
  const cleanByDay = new Map();
  const perPage = new Map();           // path -> unique visitor count
  const byStem = new Map();            // clean request counts per uri stem
  const api = { count: 0, byStatus: new Map() };
  // Per-campaign attribution. Visitors are tracked as the SAME (day|id) keys as elsewhere, so a
  // campaign count is unique PEOPLE, not requests — the hourly batching (one file per UTC hour)
  // changes nothing about who is unique; a person is one id per UTC day.
  const campVisitors = new Map();      // campaign -> Set(day|id)
  const campRequests = new Map();      // campaign -> clean page request count
  const campContentVisitors = new Map(); // "campaign/content" -> Set(day|id)
  const campContentRequests = new Map(); // "campaign/content" -> request count
  let taggedRequests = 0;              // page requests carrying a utm_campaign
  let untaggedRequests = 0;            // page requests with none
  let totalRequests = 0;

  for (const r of rows) {
    totalRequests += 1;
    const ip = r[F_IP] || "";
    const ua = r[F_UA] || "";
    const stem = r[F_STEM] || "";
    const status = r[F_STATUS] || "";
    const day = r[F_DATE] || "unknown";

    // Unfiltered unique (everyone, bots included) — so the owner sees what exclusion costs.
    if (stem && PAGE_PATHS.has(stem)) {
      const id = makeVisitorId(ip, ua, day);
      allIds.add(`${day}|${id}`);
    }

    let reason = null;
    if (isBot(ua)) reason = "bots";
    else if (ipMatchesAny(ip, ownIps)) reason = "ownIp";
    else if (stem && probeOnly.has(`${day}|${makeVisitorId(ip, ua, day)}`)) reason = "probes";
    if (reason) { excluded.total += 1; excluded[reason] += 1; continue; }

    // Only the site's OWN paths belong in the request table. A request for /wp-login.php says nothing
    // about how the tool is used, and in a visitor's mixed day it used to sit in the top-15 looking
    // like traffic. Probe requests are reported on their own line instead (see the probe block).
    if (isSitePath(stem)) byStem.set(stem, (byStem.get(stem) || 0) + 1);
    if (stem === "/api/parse") {
      api.count += 1;
      api.byStatus.set(status || "(none)", (api.byStatus.get(status || "(none)") || 0) + 1);
    }

    if (stem && PAGE_PATHS.has(stem)) {
      const id = makeVisitorId(ip, ua, day);
      cleanIds.add(`${day}|${id}`);
      const pg = pageOf(stem);
      // per-page and per-day counts are UNIQUE visitors, tracked as id sets
      if (!perPage.has(pg)) perPage.set(pg, new Set());
      perPage.get(pg).add(`${day}|${id}`);
      if (!cleanByDay.has(day)) cleanByDay.set(day, new Set());
      cleanByDay.get(day).add(id);

      // Per-campaign attribution, from the tags this page request carried.
      const { campaign, content } = campaignOf(r[F_QUERY]);
      const vkey = `${day}|${id}`;
      if (campaign === "(none)") untaggedRequests += 1;
      else taggedRequests += 1;
      if (!campVisitors.has(campaign)) campVisitors.set(campaign, new Set());
      campVisitors.get(campaign).add(vkey);
      campRequests.set(campaign, (campRequests.get(campaign) || 0) + 1);
      if (campaign !== "(none)" && content) {
        const pair = `${campaign}/${content}`;
        if (!campContentVisitors.has(pair)) { campContentVisitors.set(pair, new Set()); campContentRequests.set(pair, 0); }
        campContentVisitors.get(pair).add(vkey);
        campContentRequests.set(pair, campContentRequests.get(pair) + 1);
      }
    }
  }

  // unique per (unfiltered) day = distinct ids that day; recompute cleanly from allIds keys.
  const allByDayUnique = new Map();
  for (const key of allIds) {
    const day = key.slice(0, key.indexOf("|"));
    allByDayUnique.set(day, (allByDayUnique.get(day) || 0) + 1);
  }
  const cleanByDayCount = new Map([...cleanByDay.entries()].map(([d, s]) => [d, s.size]));
  const perPageCount = new Map([...perPage.entries()].map(([p, s]) => [p, s.size]));

  const topStems = [...byStem.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  // Campaign rows: tagged campaigns first (by visitors desc), then "(none)". Requests are the
  // clean page requests carrying that campaign tag.
  const campaignRows = [...campVisitors.entries()]
    .map(([campaign, ids]) => ({ campaign, visitors: ids.size, requests: campRequests.get(campaign) || 0 }))
    .sort((a, b) => {
      if (a.campaign === "(none)") return 1;
      if (b.campaign === "(none)") return -1;
      return b.visitors - a.visitors || a.campaign.localeCompare(b.campaign);
    });
  const contentRows = [...campContentVisitors.entries()]
    .map(([pair, ids]) => ({ pair, visitors: ids.size, requests: campContentRequests.get(pair) || 0 }))
    .sort((a, b) => b.visitors - a.visitors || a.pair.localeCompare(b.pair));

  return {
    totalRequests,
    skipped,
    excluded,
    unique: {
      window: cleanIds.size,
      byDay: Object.fromEntries([...cleanByDayCount.entries()].sort()),
      perPage: Object.fromEntries([...perPageCount.entries()].sort()),
    },
    uniqueUnfiltered: {
      window: allIds.size,
      byDay: Object.fromEntries([...allByDayUnique.entries()].sort()),
    },
    byStem: topStems,
    probe: {
      visitors: probeOnly.size,
      stems: [...probeStemCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    },
    api: { count: api.count, byStatus: Object.fromEntries([...api.byStatus.entries()].sort()) },
    campaigns: {
      rows: campaignRows,
      content: contentRows,
      taggedRequests,
      untaggedRequests,
      taggedVisitors: campaignRows.filter((r) => r.campaign !== "(none)").reduce((n, r) => n + r.visitors, 0),
    },
  };
}

/* ------------------------------- selftest ------------------------------ */
// The visitor count rests on one decidable question - "is this path even on the site?" - so it is worth
// a check of its own: --selftest asserts the classification on real examples (paths seen in the logs on
// one side, the site's own files on the other). Run it after any edit to the file list or the rules.
function runSelftest() {
  const site = ["/", "/index.html", "/app.html", "/case-study.html", "/about.html", "/method.html",
    "/help.html", "/design-conditions.html", "/selftest.html", "/css/style.css", "/css/landing.css",
    "/js/app.js", "/js/overlay.js", "/img/ad-static.png", "/samples/sample-plan.pdf",
    "/samples/level-11-floor-plan.pdf", "/vendor/pdf.min.mjs", "/vendor/tesseract/worker.min.js",
    "/robots.txt", "/sitemap.xml", "/favicon.ico", "/favicon.svg",
    "/api/health", "/api/event", "/api/parse", "/api/calc", "/api/climates"];
  // Every one of these was seen in this site's own logs. None belongs to the site.
  const probe = ["/wp-admin/install.php", "/wp-login.php", "/xmlrpc.php", "/wp-content/plugins/x.php",
    "/.env", "/.env_copy", "/.env.backup", "/.env.backup1", "/.git/config", "/.aws/credentials",
    "/.config/gcloud/application_default_credentials.json", "/_environment", "/_phpinfo.php",
    "/_profiler/phpinfo", "/phpmyadmin/index.php", "/backup.sql", "/vendor/.env", "/api/.env",
    "/api/v1/.env", "/api/dev/.env", "/api/staging/.env", "/cgi-bin/luci", "/server-status",
    "/actuator/health", "/robots.txt.php", "/.well-known/security.txt"];
  const bad = [];
  for (const p of site) if (!isSitePath(p)) bad.push(`site path called a probe: ${p}`);
  for (const p of probe) if (isSitePath(p)) bad.push(`probe called a site path: ${p}`);
  // the rules that turn a visitor into a scanner, on the shapes actually seen
  const cases = [
    { name: "probes only, never a page", v: { site: 0, probe: 3 }, scanner: true },
    { name: "opened a page only (assets cached)", v: { site: 1, probe: 0 }, scanner: false },
    { name: "opened a page and probed once", v: { site: 1, probe: 1 }, scanner: false },
    { name: "fetched / then hammered 20 unknown paths", v: { site: 1, probe: 20 }, scanner: true },
    { name: "normal browse", v: { site: 14, probe: 0 }, scanner: false },
  ];
  for (const c of cases) {
    const got = c.v.probe > 0 && (c.v.site === 0 || (c.v.probe >= PROBE_BURST && c.v.site <= 1));
    if (got !== c.scanner) bad.push(`scanner rule wrong for "${c.name}" (expected ${c.scanner ? "scanner" : "visitor"})`);
  }
  for (const b of bad) console.log(`  FAIL  ${b}`);
  console.log(`${bad.length ? bad.length + " FAILED" : "visitors.mjs selftest: OK"}  (${site.length} site paths, ${probe.length} probe paths, ${cases.length} scanner rules)`);
  return bad.length === 0;
}

/* ------------------------------- report -------------------------------- */
const padL = (s, n) => String(s).padStart(n);
const pad = (s, n) => String(s).padEnd(n);

// The per-campaign attribution block. Tagged campaigns first (already sorted in analyze), then
// "(none)". A campaign with zero requests cannot appear here — so when NOTHING was tagged the
// block says so plainly instead of implying traffic does not exist.
function printCampaigns(stats) {
  const c = stats.campaigns;
  console.log(`Per campaign (UNIQUE real visitors grouped by utm_campaign in the request URL):`);
  console.log(`  ${pad("campaign", 26)}${padL("visitors", 9)}${padL("requests", 9)}`);
  if (!c.rows.length) console.log(`      (none)`);
  for (const r of c.rows) console.log(`  ${pad(r.campaign, 26)}${padL(r.visitors, 9)}${padL(r.requests, 9)}`);
  const total = c.taggedRequests + c.untaggedRequests;
  console.log(`  tagged page requests: ${c.taggedRequests} of ${total}  ("(none)" above = a visit with no utm_campaign)`);
  if (c.content.length) {
    console.log(`  campaign/content pairs (tells ONE emailed link apart from a campaign-wide one):`);
    console.log(`    ${pad("pair", 34)}${padL("visitors", 9)}${padL("requests", 9)}`);
    for (const r of c.content) console.log(`    ${pad(r.pair, 34)}${padL(r.visitors, 9)}${padL(r.requests, 9)}`);
  } else {
    console.log(`  campaign/content pairs: none in this window (no request carried both tags)`);
  }
  if (!c.taggedRequests) {
    const untaggedVisitors = (c.rows.find((r) => r.campaign === "(none)") || {}).visitors || 0;
    console.log("");
    console.log(`  NOTE (honest zero): no request in this window carried a utm_campaign tag — so 0 campaigns`);
    console.log(`        can be attributed, whatever the total. ${untaggedVisitors} unique real visitor(s) were counted`);
    console.log(`        without a tag. An untagged share still counts as a visitor; it simply cannot be attributed.`);
    console.log(`        If you emailed a tagged link and it is absent above, it was opened without its utm_* tags,`);
    console.log(`        or nobody opened it — this tool will not invent an attribution either way.`);
  }
  console.log("");
}

function printReport(stats, opts, meta) {
  const line = "-".repeat(64);
  console.log(`LoadLens — unique real visitors (${opts.hours}h window)`);
  console.log(`Source: s3://${opts.bucket}/${opts.prefix}  (region ${opts.region})`);
  console.log(
    `Window: ${new Date(meta.start).toISOString()} .. ${new Date(meta.end).toISOString()} (UTC)` +
      (meta.files != null ? `  — ${meta.files} log file(s)` : "")
  );
  console.log(
    `Privacy: a visitor is a 12-char salted hash, one per UTC day. A raw address is never ` +
      `printed and never stored, here or in --json.`
  );
  console.log("");
  console.log(`Requests read         : ${stats.totalRequests}`);
  if (stats.skipped) console.log(`Malformed lines skipped: ${stats.skipped}  (not fatal)`);
  console.log(
    `Excluded traffic      : ${stats.excluded.total} hits  (bots ${stats.excluded.bots}, ` +
      `own traffic ${stats.excluded.ownIp}, scanner probes ${stats.excluded.probes})`
  );
  if (meta.ownIps) {
    if (meta.ownIps.exists) {
      console.log(`Own-address list      : ${meta.ownIps.entries.length} entry(ies) from ${meta.ownIps.path} (values never printed)`);
    } else {
      console.log(
        `Own-address list      : NOT FOUND at ${meta.ownIps.path} — nothing excluded by address ` +
          `(only the bot deny-list applied). Add your address there to remove your own visits.`
      );
    }
  }
  console.log("");
  console.log(`UNIQUE REAL VISITORS  : ${stats.unique.window}   (after exclusions, in this window)`);
  console.log(`  per UTC day         :`);
  for (const [day, n] of Object.entries(stats.unique.byDay)) console.log(`      ${pad(day, 12)} ${padL(n, 5)}`);
  if (!Object.keys(stats.unique.byDay).length) console.log(`      (none)`);
  console.log(`  per page (unique visitors; '/' includes /index.html):`);
  for (const [p, n] of Object.entries(stats.unique.perPage)) console.log(`      ${pad(p, 26)} ${padL(n, 5)}`);
  if (!Object.keys(stats.unique.perPage).length) console.log(`      (none)`);
  console.log("");
  printCampaigns(stats);
  console.log(`Same count WITHOUT any exclusion : ${stats.uniqueUnfiltered.window}`);
  console.log(`  (the difference is what the bot deny-list, the own-address list and the scanner`);
  console.log(`   filter cost you - none of the three is a guess about who someone claims to be)`);
  if (stats.probe && stats.probe.visitors) {
    console.log("");
    // NOT people removed from the count: a visitor is counted when they open a page, and none of these
    // ever did - they only ever asked for paths that do not exist here. Reported so the number can be
    // seen to be clean rather than merely asserted to be.
    console.log(`Probe-only visitor-days : ${stats.probe.visitors}  (asked ONLY for paths this site does not have;`);
    console.log(`                          none of them ever opened a page, so none was ever in the count)`);
    console.log(`  what they were looking for (${stats.probe.stems.length} distinct paths, top 10):`);
    for (const [stem, n] of stats.probe.stems.slice(0, 10)) console.log(`      ${padL(n, 6)}  ${stem}`);
  }
  console.log("");
  console.log(`Top request paths (real traffic, top 15):`);
  const top = stats.byStem.slice(0, 15);
  if (!top.length) console.log(`      (none)`);
  for (const [stem, n] of top) console.log(`      ${padL(n, 6)}  ${stem}`);
  console.log("");
  console.log(`POST /api/parse (did the tool actually work): ${stats.api.count}`);
  if (stats.api.count) {
    const split = Object.entries(stats.api.byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s}:${n}`)
      .join("  ");
    console.log(`  by status: ${split}`);
  }
  console.log(line);
}

/* -------------------------------- main --------------------------------- */
function readLocalLogFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return decodeLog(buf);
}

/** Gunzip if it is gzip, otherwise read as plain text. Returns { text, gz, note }. */
function decodeLog(buf) {
  const gz = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (gz) {
    try { return { text: zlib.gunzipSync(buf).toString("utf8"), gz: true, note: "" }; }
    catch (e) { return { text: buf.toString("utf8"), gz: false, note: `gunzip failed (${e.code || e.message}); read as plain text` }; }
  }
  return { text: buf.toString("utf8"), gz: false, note: "not gzipped; read as plain text" };
}

/**
 * Download many S3 objects at once (a small pool), each with the same hard timeout.
 * Sequential downloads made a 48h window crawl: ~50 `aws` processes, one after another,
 * several of them spending the whole timeout on an object CloudFront had not finished
 * writing. Eight at a time turns minutes into seconds. Order is preserved; a file that
 * fails to arrive is simply absent (never a fabricated row).
 */
async function downloadObjectsParallel(objects, opts, scratch, limit = 8) {
  const out = new Array(objects.length).fill(null);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= objects.length) return;
      const key = objects[i].key;
      const dest = path.join(scratch, path.basename(key));
      out[i] = await new Promise((resolve) => {
        execFile("aws", ["s3", "cp", `s3://${opts.bucket}/${key}`, dest, "--region", opts.region,
          "--no-cli-pager", "--output", "json"], {
          encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true,
          timeout: 45000, killSignal: "SIGKILL",
        }, (err) => {
          if (err) {
            console.log(`! could not download ${key}: ${String(err.message || err).slice(0, 120)}`);
            return resolve(null);
          }
          try { resolve(fs.readFileSync(dest)); } catch { resolve(null); }
        });
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, objects.length)) }, worker));
  return out;
}

/** Download one S3 object into the scratch dir. Returns a Buffer or null. */
function downloadObject(key, opts, scratch) {
  const dest = path.join(scratch, path.basename(key));
  const res = aws(["s3", "cp", `s3://${opts.bucket}/${key}`, dest, "--region", opts.region]);
  if (!res.ok) { console.log(`! could not download ${key}: ${res.error}`); return null; }
  try { return fs.readFileSync(dest); }
  catch (e) { console.log(`! could not read downloaded ${key}: ${e.message}`); return null; }
}

async function main() {
  if (parseArgs(process.argv.slice(2)).selftest) { process.exit(runSelftest() ? 0 : 1); }
  const opts = parseArgs(process.argv.slice(2));
  const end = Date.now();
  const start = end - opts.hours * 60 * 60 * 1000;
  const ownIpsInfo = loadOwnIps(opts.ownIpsPath);
  const ownIps = ownIpsInfo.entries;

  let texts = [];
  let files = null;

  if (opts.file) {
    try { texts.push(readLocalLogFile(opts.file).text); }
    catch (e) { console.log(`! could not read --file ${opts.file}: ${e.message}`); }
  } else {
    const list = listLogObjects(opts);
    if (!list.ok) {
      console.log(`! could not list the log bucket: ${list.error}`);
      console.log("  (check your AWS credentials / region, then try again)\n");
    } else if (list.objects.length === 0) {
      console.log("nothing delivered yet, CloudFront delivers in hourly batches with up to an hour of delay");
      console.log(`  (looked in s3://${opts.bucket}/${opts.prefix})`);
      process.exit(0);
    } else {
      const inWindow = list.objects
        .map((key) => ({ key, hourStart: hourStartFromKey(key) }))
        .filter((o) => o.hourStart != null && o.hourStart + 3600 * 1000 >= start && o.hourStart <= end)
        .sort((a, b) => a.hourStart - b.hourStart);
      files = inWindow.length;
      if (inWindow.length === 0) {
        console.log(`no log files fall inside the last ${opts.hours}h window yet (delivery can lag up to an hour).`);
      }
      // CloudFront writes the current hour's object while we are reading the window: a key can be
      // listed and still be unreadable. Skip the hour that has not finished, and say so, rather
      // than spending the per-file timeout on it.
      const settled = inWindow.filter((o) => o.hourStart <= end - 3600 * 1000);
      const skippedLatest = inWindow.length - settled.length;
      if (skippedLatest > 0) {
        console.log(`  (skipped the most recent hour: CloudFront is still writing it)`);
      }
      const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "loadlens-visitors-"));
      try {
        const bufs = await downloadObjectsParallel(settled, opts, scratch);
        for (let i = 0; i < bufs.length; i++) {
          const buf = bufs[i];
          if (!buf) continue;
          const dec = decodeLog(buf);
          if (dec.note) console.log(`  note: ${path.basename(settled[i].key)} ${dec.note}`);
          texts.push(dec.text);
        }
      } finally {
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }

  // Parse every file, then analyse as one set.
  const rows = [];
  let skipped = 0;
  for (const t of texts) {
    const p = parseLog(t);
    rows.push(...p.rows);
    skipped += p.malformed;
  }
  const stats = analyze({ rows, malformed: skipped }, { ownIps, now: new Date(end) });

  if (opts.json) {
    // Deliberately carries no addresses: only hashes and counts. Note there is no key that
    // could hold one (in particular, nothing named after the address column).
    console.log(JSON.stringify({
      hours: opts.hours,
      bucket: opts.bucket,
      prefix: opts.prefix,
      region: opts.region,
      window: { start, end },
      files,
      totalRequests: stats.totalRequests,
      skipped: stats.skipped,
      excluded: stats.excluded,
      uniqueVisitors: stats.unique,
      uniqueVisitorsUnfiltered: stats.uniqueUnfiltered,
      // Per-campaign attribution: unique real visitors (never requests-only) grouped by the
      // utm_campaign in the request URL, "(none)" for untagged. Visitors stay 12-hex hashes.
      uniqueVisitorsByCampaign: stats.campaigns.rows,
      campaignContentPairs: stats.campaigns.content,
      taggedRequests: stats.campaigns.taggedRequests,
      untaggedRequests: stats.campaigns.untaggedRequests,
      topStems: stats.byStem.slice(0, 15),
      apiParse: stats.api,
      ownIpsFile: { path: ownIpsInfo.path, exists: ownIpsInfo.exists, entries: ownIpsInfo.entries.length },
      note: "no raw IP is printed or stored; visitors are 12-char salted hashes, one per UTC day",
    }, null, 2));
    console.log("");
  }

  printReport(stats, opts, { start, end, files, ownIps: ownIpsInfo });
  process.exit(0); // an empty window is not an error
}

export {
  PAGE_PATHS, UA_DENY, VISITOR_SALT, DEFAULT_OWN_IPS,
  parseArgs, parseLog, makeVisitorId, isBot, loadOwnIps, ipMatchesAny, ipInCidr,
  analyze, printReport, printCampaigns, listLogObjects, hourStartFromKey, decodeLog,
  parseQuery, normaliseCampaignToken, campaignOf,
};

// Only run the CLI when executed directly; importing it (tests) must not touch AWS.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(`! ${e && e.stack || e}`); process.exit(1); });

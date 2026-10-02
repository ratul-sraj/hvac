// tools/funnel.mjs — read the anonymous usage events out of CloudWatch Logs and
// print the ad funnel, per campaign, so a small ad spend can actually be read.
//
//   node tools/funnel.mjs                 # the last 24 hours
//   node tools/funnel.mjs --days 7        # the last 7 days
//   node tools/funnel.mjs --days 1 --log-group /aws/lambda/loadlens-api
//
// What it reads: the one JSON line the Lambda writes for each POST /api/event
// (see lambda/index.mjs). Each line looks like
//   {"evt":"usage","e":"app_open","utm_source":"google","utm_campaign":"kerala-hvac"}
// and carries NO IP, no user agent, no referrer and no plan data.
//
// These are EVENT COUNTS, not unique people: there is no cookie and no id, so a
// visitor who loads the page twice counts twice. That is the price of counting
// without tracking anyone, and it is the honest way to read these numbers.
//
// Node only, no dependencies. Uses the AWS CLI exactly like the rest of infra/.
// If there is no data yet — or the CLI cannot reach CloudWatch — it prints zeros
// and exits 0. It never throws.
import { spawnSync } from "node:child_process";

const DEFAULT_LOG_GROUP = "/aws/lambda/loadlens-api";
const PAGE_LIMIT = 10000; // filter-log-events caps a page at 10,000 events

/* ------------------------------- args ---------------------------------- */
function parseArgs(argv) {
  const opts = {
    days: 1,
    logGroup: process.env.LAMBDA_LOG_GROUP || DEFAULT_LOG_GROUP,
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-south-1",
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") opts.days = Number(argv[++i]);
    else if (a.startsWith("--days=")) opts.days = Number(a.slice(7));
    else if (a === "--log-group") opts.logGroup = argv[++i];
    else if (a.startsWith("--log-group=")) opts.logGroup = a.slice(12);
    else if (a === "--region") opts.region = argv[++i];
    else if (a.startsWith("--region=")) opts.region = a.slice(9);
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0) opts.days = 1;
  return opts;
}

function printHelp() {
  console.log(`tools/funnel.mjs — the anonymous LoadLens ad funnel from CloudWatch Logs

  node tools/funnel.mjs [--days N] [--log-group NAME] [--region R] [--json]

  --days N        window to read, ending now (default 1)
  --log-group     CloudWatch log group (default ${DEFAULT_LOG_GROUP})
  --region        AWS region (default AWS_REGION or ap-south-1)
  --json          also print the raw counts as JSON
`);
}

/* ---------------------------- AWS CLI read ------------------------------ */
/** Run the AWS CLI. Returns { ok, stdout, error }. Never throws. */
function aws(args) {
  for (const cmd of ["aws", "aws.exe"]) {
    const res = spawnSync(cmd, [...args, "--no-cli-pager", "--output", "json"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
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

/** Read every usage line in the window, paging through filter-log-events. */
function readUsageLines(opts, startMs, endMs) {
  const events = [];
  let nextToken;
  for (let page = 0; page < 100; page++) {
    const args = [
      "logs", "filter-log-events",
      "--log-group-name", opts.logGroup,
      "--start-time", String(startMs),
      "--end-time", String(endMs),
      "--filter-pattern", '{ $.evt = "usage" }',
      "--limit", String(PAGE_LIMIT),
      "--region", opts.region,
    ];
    if (nextToken) args.push("--next-token", nextToken);
    const res = aws(args);
    if (!res.ok) return { ok: false, error: res.error, events };
    let data;
    try { data = JSON.parse(res.stdout || "{}"); } catch { data = {}; }
    if (Array.isArray(data.events)) events.push(...data.events);
    nextToken = data.nextToken;
    if (!nextToken) return { ok: true, events };
  }
  return { ok: true, events };
}

/* ------------------------------ counting -------------------------------- */
const FUNNEL = [
  { step: "arrived",   events: ["app_open"] },
  { step: "engaged",   events: ["sample_loaded", "plan_parsed", "schedule_imported"] },
  { step: "worked",    events: ["trace_run", "rooms_placed"] },
  { step: "converted", events: ["export_csv", "report_opened"] },
];
const ALL_EVENTS = [
  "app_open", "sample_loaded", "plan_parsed", "schedule_imported", "trace_run",
  "rooms_placed", "export_csv", "report_opened", "share_link_copied", "calc_empty",
];
const EXTRA_EVENTS = ["share_link_copied", "calc_empty"];

const utm = (obj, key) => (obj && typeof obj[key] === "string" && obj[key]) || "(none)";

function tally(lines) {
  const perEvent = Object.fromEntries(ALL_EVENTS.map((e) => [e, 0]));
  const stepCount = Object.fromEntries(FUNNEL.map((f) => [f.step, 0]));
  const campaigns = new Map(); // campaign -> { step -> count }
  const contents = new Map();
  let malformed = 0, total = 0;

  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { malformed++; continue; }
    if (!ev || ev.evt !== "usage" || typeof ev.e !== "string") { malformed++; continue; }
    if (!ALL_EVENTS.includes(ev.e)) { malformed++; continue; }
    total++;
    perEvent[ev.e] += 1;
    const step = FUNNEL.find((f) => f.events.includes(ev.e)).step;
    stepCount[step] += 1;

    for (const [map, key] of [[campaigns, "utm_campaign"], [contents, "utm_content"]]) {
      const k = utm(ev, key);
      if (!map.has(k)) map.set(k, Object.fromEntries(FUNNEL.map((f) => [f.step, 0])));
      map.get(k)[step] += 1;
    }
  }
  return { perEvent, stepCount, campaigns, contents, malformed, total };
}

/* ------------------------------- report --------------------------------- */
const pct = (part, whole) => (whole ? ` (${((100 * part) / whole).toFixed(1)}% of ${whole})` : "");
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function printReport(t, opts, window) {
  const { perEvent, stepCount, campaigns, contents, malformed, total } = t;

  console.log(`LoadLens usage funnel — last ${opts.days} day(s)`);
  console.log(`  log group : ${opts.logGroup}   region: ${opts.region}`);
  console.log(`  window    : ${new Date(window.start).toISOString()} .. ${new Date(window.end).toISOString()}`);
  console.log(`  note      : event counts, not unique people (no cookies, no ids)`);
  console.log("");

  console.log("Funnel");
  let prev = null;
  for (const f of FUNNEL) {
    const n = stepCount[f.step];
    const arrow = prev === null ? "" : pct(n, prev);
    console.log(`  ${pad(f.step, 10)} ${padL(n, 7)}${arrow}`);
    prev = n;
  }
  console.log("");

  console.log("Events");
  for (const e of ALL_EVENTS) console.log(`  ${pad(e, 18)} ${padL(perEvent[e], 7)}`);
  if (malformed) console.log(`  ${pad("(unparsable)", 18)} ${padL(malformed, 7)}`);
  console.log(`  ${pad("(total lines)", 18)} ${padL(total, 7)}`);
  console.log("");

  const breakdown = (title, map) => {
    console.log(`${title}`);
    const keys = [...map.keys()].sort((a, b) => {
      if (a === "(none)") return 1;
      if (b === "(none)") return -1;
      const av = FUNNEL.reduce((s, f) => s + map.get(a)[f.step], 0);
      const bv = FUNNEL.reduce((s, f) => s + map.get(b)[f.step], 0);
      return bv - av;
    });
    console.log(`  ${pad("value", 24)}${FUNNEL.map((f) => padL(f.step, 11)).join("")}`);
    for (const k of keys) {
      const row = map.get(k);
      console.log(`  ${pad(k.slice(0, 23), 24)}${FUNNEL.map((f) => padL(row[f.step], 11)).join("")}`);
    }
    console.log("");
  };
  breakdown("By utm_campaign", campaigns);
  breakdown("By utm_content", contents);

  if (total === 0) {
    console.log("No usage events in this window yet. Nothing is broken — that just means");
    console.log("nobody has used the tool in the window you asked about (or the ads have not run).");
  }
}

/* -------------------------------- main ---------------------------------- */
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const end = Date.now();
  const start = end - opts.days * 24 * 60 * 60 * 1000;

  const read = readUsageLines(opts, start, end);
  const lines = [];
  for (const ev of read.events) {
    if (!ev || typeof ev.message !== "string") continue;
    // CloudWatch prefixes the line with "<timestamp>\t<requestId>\tINFO\t";
    // keep only the JSON object itself.
    const raw = ev.message.trim();
    const brace = raw.indexOf("{");
    lines.push(brace >= 0 ? raw.slice(brace) : raw);
  }
  const t = tally(lines);

  if (!read.ok) {
    console.log(`! could not read CloudWatch Logs: ${read.error}`);
    console.log("  (showing zeros — check your AWS credentials / region, then try again)\n");
  }

  if (opts.json) {
    console.log(JSON.stringify({
      days: opts.days, logGroup: opts.logGroup, region: opts.region,
      window: { start, end },
      steps: t.stepCount, events: t.perEvent,
      campaigns: Object.fromEntries(t.campaigns), contents: Object.fromEntries(t.contents),
      malformed: t.malformed, total: t.total,
    }, null, 2));
    console.log("");
  }

  printReport(t, opts, { start, end });
  process.exit(0); // always success: an empty window is not an error
}

main();

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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_LOG_GROUP = "/aws/lambda/loadlens-api";
const PAGE_LIMIT = 10000; // filter-log-events caps a page at 10,000 events

/* ------------------------------- args ---------------------------------- */
function parseArgs(argv) {
  const opts = {
    days: 1,
    logGroup: process.env.LAMBDA_LOG_GROUP || DEFAULT_LOG_GROUP,
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-south-1",
    json: false,
    file: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") opts.days = Number(argv[++i]);
    else if (a.startsWith("--days=")) opts.days = Number(a.slice(7));
    else if (a === "--log-group") opts.logGroup = argv[++i];
    else if (a.startsWith("--log-group=")) opts.logGroup = a.slice(12);
    else if (a === "--region") opts.region = argv[++i];
    else if (a.startsWith("--region=")) opts.region = a.slice(9);
    else if (a === "--file") opts.file = argv[++i];
    else if (a.startsWith("--file=")) opts.file = a.slice(7);
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0) opts.days = 1;
  return opts;
}

function printHelp() {
  console.log(`tools/funnel.mjs — the anonymous LoadLens ad funnel from CloudWatch Logs

  node tools/funnel.mjs [--days N] [--log-group NAME] [--region R] [--file PATH] [--json]

  --days N        window to read, ending now (default 1)
  --log-group     CloudWatch log group (default ${DEFAULT_LOG_GROUP})
  --region        AWS region (default AWS_REGION or ap-south-1)
  --file PATH     read the log lines from a local file instead of CloudWatch (offline / tests)
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
// Every event this tool knows. share_link_copied sits with the other outcome events (it is a real
// sign the tool was useful). calc_empty is NOT a success step — it is a failure signal (a
// calculation that produced no included rooms, including a failed upload) and is reported on its
// own so it can never be read as part of the funnel.
const FUNNEL = [
  { step: "arrived",   events: ["app_open"] },
  { step: "engaged",   events: ["sample_loaded", "plan_parsed", "schedule_imported"] },
  { step: "worked",    events: ["trace_run", "rooms_placed"] },
  { step: "converted", events: ["export_csv", "report_opened", "share_link_copied"] },
];
const FAILURE_EVENTS = ["calc_empty"];

// ONE source of truth. The known-event list and the event -> step map are both derived from FUNNEL
// and FAILURE_EVENTS, so an event can no longer be listed as known while belonging to no step. The
// old code did FUNNEL.find(...).step and threw a TypeError on exactly that mismatch — which is what
// share_link_copied and calc_empty did — printing nothing at all.
const STEP_OF = new Map(FUNNEL.flatMap((f) => f.events.map((e) => [e, f.step])));
const ALL_EVENTS = [...new Set([...FUNNEL.flatMap((f) => f.events), ...FAILURE_EVENTS])];
const COLUMNS = [...FUNNEL.map((f) => f.step), "failed"];

const utm = (obj, key) => (obj && typeof obj[key] === "string" && obj[key]) || "(none)";
const emptyRow = () => Object.fromEntries(COLUMNS.map((c) => [c, 0]));

function tally(lines) {
  const perEvent = Object.fromEntries(ALL_EVENTS.map((e) => [e, 0]));
  const stepCount = Object.fromEntries(FUNNEL.map((f) => [f.step, 0]));
  const failures = Object.fromEntries(FAILURE_EVENTS.map((e) => [e, 0]));
  const campaigns = new Map(); // campaign -> { <step> | failed -> count }
  const contents = new Map();
  const unknownNames = new Set();
  let malformed = 0, unknown = 0, total = 0;

  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { malformed++; continue; }
    if (!ev || ev.evt !== "usage" || typeof ev.e !== "string") { malformed++; continue; }
    if (!ALL_EVENTS.includes(ev.e)) {
      // A usage line naming an event this tool does not know. Counted and named, never a crash.
      unknown++; unknownNames.add(String(ev.e).slice(0, 40));
      continue;
    }
    total++;
    perEvent[ev.e] += 1;
    const step = STEP_OF.get(ev.e);
    if (step) stepCount[step] += 1;
    else failures[ev.e] += 1;
    const column = step || "failed";

    for (const [map, key] of [[campaigns, "utm_campaign"], [contents, "utm_content"]]) {
      const k = utm(ev, key);
      if (!map.has(k)) map.set(k, emptyRow());
      map.get(k)[column] += 1;
    }
  }
  return { perEvent, stepCount, failures, campaigns, contents, unknownNames, malformed, unknown, total };
}

/* ------------------------------- report --------------------------------- */
const pct = (part, whole) => (whole ? ` (${((100 * part) / whole).toFixed(1)}% of ${whole})` : "");
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function printReport(t, opts, window) {
  const { perEvent, stepCount, failures, campaigns, contents, unknownNames, malformed, unknown, total } = t;

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
  if (unknown) console.log(`  ${pad("(unknown event)", 18)} ${padL(unknown, 7)}`);
  console.log(`  ${pad("(total lines)", 18)} ${padL(total, 7)}`);
  console.log("");

  // calc_empty is a failure signal, not a funnel step: printed on its own so a rising count can
  // never be mistaken for a success. It means arrivals that reached a calculation and found nothing.
  console.log("Failure signals (NOT part of the funnel)");
  for (const e of FAILURE_EVENTS) console.log(`  ${pad(e, 18)} ${padL(failures[e], 7)}`);
  const failureTotal = FAILURE_EVENTS.reduce((s, e) => s + failures[e], 0);
  if (failureTotal && stepCount.arrived) {
    console.log(`  ${pad("", 18)} ${padL("", 7)}${pct(failureTotal, stepCount.arrived)} of arrivals`);
  }
  console.log("");

  const breakdown = (title, map) => {
    console.log(`${title}`);
    const keys = [...map.keys()].sort((a, b) => {
      if (a === "(none)") return 1;
      if (b === "(none)") return -1;
      const av = COLUMNS.reduce((s, c) => s + map.get(a)[c], 0);
      const bv = COLUMNS.reduce((s, c) => s + map.get(b)[c], 0);
      return bv - av;
    });
    console.log(`  ${pad("value", 24)}${COLUMNS.map((c) => padL(c, 11)).join("")}`);
    for (const k of keys) {
      const row = map.get(k);
      console.log(`  ${pad(k.slice(0, 23), 24)}${COLUMNS.map((c) => padL(row[c], 11)).join("")}`);
    }
    console.log("");
  };
  breakdown("By utm_campaign", campaigns);
  breakdown("By utm_content", contents);

  if (unknown) {
    console.log(`! ${unknown} log line(s) named an event this tool does not know: ${[...unknownNames].join(", ")}`);
    console.log("  (they are counted as unknown above, not silently dropped — add them to FUNNEL if they are real)\n");
  }

  if (total === 0) {
    console.log("No usage events in this window yet. Nothing is broken — that just means");
    console.log("nobody has used the tool in the window you asked about (or the ads have not run).");
  }
}

/* -------------------------------- main ---------------------------------- */
// CloudWatch prefixes each line with "<timestamp>\t<requestId>\tINFO\t"; keep the JSON object only.
const stripPrefix = (message) => {
  const raw = String(message == null ? "" : message).trim();
  const brace = raw.indexOf("{");
  return brace >= 0 ? raw.slice(brace) : raw;
};

function readLocalLines(file) {
  try {
    return { ok: true, lines: fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), lines: [] };
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const end = Date.now();
  const start = end - opts.days * 24 * 60 * 60 * 1000;

  let lines;
  let readOk = true;
  let readError = "";
  if (opts.file) {
    // --file: read the lines from a local file instead of CloudWatch (offline reading and tests).
    const local = readLocalLines(opts.file);
    lines = local.lines.map(stripPrefix);
    readOk = local.ok;
    readError = local.error;
  } else {
    const read = readUsageLines(opts, start, end);
    readOk = read.ok;
    readError = read.error;
    lines = read.events.filter((ev) => ev && typeof ev.message === "string").map((ev) => stripPrefix(ev.message));
  }
  const t = tally(lines);

  if (!readOk) {
    console.log(`! could not read the log source: ${readError}`);
    console.log("  (showing zeros — check the --file path, or your AWS credentials / region, then try again)\n");
  }

  if (opts.json) {
    console.log(JSON.stringify({
      days: opts.days, logGroup: opts.logGroup, region: opts.region,
      window: { start, end },
      steps: t.stepCount, events: t.perEvent, failures: t.failures,
      campaigns: Object.fromEntries(t.campaigns), contents: Object.fromEntries(t.contents),
      malformed: t.malformed, unknown: t.unknown, unknownEvents: [...t.unknownNames],
      total: t.total,
    }, null, 2));
    console.log("");
  }

  printReport(t, opts, { start, end });
  process.exit(0); // always success: an empty window is not an error
}

export { FUNNEL, FAILURE_EVENTS, ALL_EVENTS, STEP_OF, COLUMNS, tally, printReport, parseArgs, readUsageLines, stripPrefix };

// Only run the CLI when this file is executed directly; importing it (tests) must not touch AWS.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

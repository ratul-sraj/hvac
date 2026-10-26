#!/usr/bin/env node
/* LoadLens — NEW vs RETURNING visitors.
 *
 * tools/visitors.mjs identifies a visitor as sha256(salt | DAY | address | browser), one id per UTC
 * day. That makes cross-day tracking impossible even for the owner — a deliberate privacy choice —
 * but it also means the dashboard's "unique visitors" is really VISITOR-DAYS: the same person on
 * three days counts three times, and nobody can be called new or returning.
 *
 * This tool answers only that: how many PEOPLE, and of those, how many came more than once.
 *
 * PRIVACY — what is different here, and why it is still safe:
 *   - The identity is sha256("loadlens|people|v1" | address | browser) — the day is NOT in it, so a
 *     person is the same id on every day they visit.
 *   - That id lives in this process's memory for the length of the run and is then gone. It is never
 *     printed, never stored, never sent anywhere, and no file on disk holds it. Only counts leave.
 *   - Raw addresses are never printed or stored, exactly as in visitors.mjs.
 *   - What changes: while this runs, the owner COULD in principle tell whether the same browser came
 *     back. visitors.mjs alone could not. That is the whole trade, so it is stated here, in the
 *     output, and in the report it writes.
 *
 * Everything else — which user-agents are bots, the owner's own addresses, which paths are the site's
 * real pages, and the scanner rule — is IMPORTED from visitors.mjs, so there is one classifier in
 * this repository, not two that can drift apart.
 *
 *   node tools/visitor-people.mjs                     # last 14 days, writes the HTML report
 *   node tools/visitor-people.mjs --hours 48 --json
 *   node tools/visitor-people.mjs --out C:/tmp/new.html
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs, parseLog, decodeLog, isBot, loadOwnIps, ipMatchesAny,
  listLogObjects, hourStartFromKey, isSitePath, PAGE_PATHS, PROBE_BURST,
} from "./visitors.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, "..", ".cache", "cf");   // the SAME cache visitors.mjs fills
const PEOPLE_SALT = "loadlens|people|v1";

/* One id per PERSON: the day is deliberately absent. In memory only. */
function personId(ip, ua) {
  return crypto.createHash("sha256").update(`${PEOPLE_SALT}|${ip || ""}|${ua || ""}`).digest("hex").slice(0, 12);
}

function log(msg) { process.stderr.write(msg + "\n"); }

function readCached(key) {
  const cached = path.join(CACHE_DIR, path.basename(key));
  try { if (fs.existsSync(cached)) { const b = fs.readFileSync(cached); if (b.length) return b; } } catch { /* ignore */ }
  return null;
}
/* Fetch ONE object, asynchronously, so a batch can run in parallel — the same eight-at-a-time the
 * standard tool uses. Serial fetching made a cold 14-day window take quarter of an hour. */
function fetchOne(key, opts, scratch) {
  return new Promise((resolve) => {
    const dest = path.join(scratch, path.basename(key));
    const child = spawn("aws", ["s3", "cp", `s3://${opts.bucket}/${key}`, dest, "--region", opts.region, "--only-show-errors"], { stdio: "ignore" });
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      try {
        const buf = fs.readFileSync(dest);
        try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, path.basename(key)), buf); } catch { /* best effort */ }
        resolve(buf);
      } catch { resolve(null); }
    });
    child.on("error", () => resolve(null));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const hours = Number(opts.hours || 336);
  const outPath = process.env.npm_config_out || process.argv.find((a) => a.startsWith("--out="))?.slice(6)
    || (process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null)
    || "C:/Users/Aorus/Documents/LoadLens-New-Visitors.html";
  const end = Date.now();
  const start = end - hours * 60 * 60 * 1000;

  const ownInfo = loadOwnIps(opts.ownIpsPath);
  const ownIps = ownInfo.entries || [];

  const list = listLogObjects(opts);
  if (!list.ok) { console.error(`! could not list the log bucket: ${list.error}`); process.exit(1); }
  const inWindow = list.objects
    .map((key) => ({ key, hourStart: hourStartFromKey(key) }))
    .filter((o) => o.hourStart != null && o.hourStart + 3600e3 >= start && o.hourStart <= end)
    .filter((o) => o.hourStart <= end - 3600e3)          // CloudFront is still writing the last hour
    .sort((a, b) => a.hourStart - b.hourStart);
  if (!inWindow.length) { console.log(`no log files inside the last ${hours}h window yet.`); process.exit(0); }

  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "loadlens-people-"));
  const rows = [];
  let malformed = 0, read = 0, fromCache = 0;
  try {
    const BATCH = 8;
    for (let i = 0; i < inWindow.length; i += BATCH) {
      const batch = inWindow.slice(i, i + BATCH);
      const bufs = await Promise.all(batch.map((o) => {
        const c = readCached(o.key);
        return c ? Promise.resolve(c) : fetchOne(o.key, opts, scratch);
      }));
      for (let j = 0; j < batch.length; j++) {
        const buf = bufs[j];
        if (!buf) { log(`  ! could not read ${path.basename(batch[j].key)}`); continue; }
        if (readCached(batch[j].key)) fromCache++;
        read++;
        const dec = decodeLog(buf);
        const p = parseLog(dec.text);
        rows.push(...p.rows); malformed += p.malformed;
      }
      process.stderr.write(`  ${Math.min(i + BATCH, inWindow.length)}/${inWindow.length} log file(s) read\r`);
    }
    process.stderr.write("\n");
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // ---- classify exactly as visitors.mjs does, but keyed by PERSON and then person-day -------------
  // person -> day -> {site, probe, page}
  const perPerson = new Map();
  let excluded = { bots: 0, own: 0 };
  for (const r of rows) {
    const ip = r["c-ip"] || "", ua = r["cs(User-Agent)"] || "";
    const stem = r["cs-uri-stem"] || "", day = r["date"] || "";
    if (!stem || !day) continue;
    if (isBot(ua)) { excluded.bots++; continue; }
    if (ipMatchesAny(ip, ownIps)) { excluded.own++; continue; }
    const pid = personId(ip, ua);
    let days = perPerson.get(pid);
    if (!days) { days = new Map(); perPerson.set(pid, days); }
    const cur = days.get(day) || { site: 0, probe: 0, page: 0 };
    if (isSitePath(stem)) { cur.site++; if (PAGE_PATHS.has(stem)) cur.page++; }
    else cur.probe++;
    days.set(day, cur);
  }

  // ---- collapse to people -------------------------------------------------------------------------
  const people = [];                                     // { days:Set, first, last, visits }
  let visitorDays = 0, allowed = 0;
  for (const [, days] of perPerson) {
    const real = [];
    for (const [day, s] of days) {
      const probeOnly = s.probe > 0 && (s.site === 0 || (s.probe >= PROBE_BURST && s.site <= 1));
      if (probeOnly) { allowed++; continue; }
      if (s.page === 0) continue;                        // a visitor counts when they OPEN A PAGE
      real.push(day);
    }
    if (!real.length) continue;
    const set = new Set(real);
    visitorDays += set.size;
    people.push({ days: set, n: set.size });
  }

  const total = people.length;
  const returning = people.filter((p) => p.n > 1).length;
  const oneDay = total - returning;
  const hist = { "1": 0, "2": 0, "3-4": 0, "5+": 0 };
  for (const p of people) {
    if (p.n === 1) hist["1"]++; else if (p.n === 2) hist["2"]++;
    else if (p.n <= 4) hist["3-4"]++; else hist["5+"]++;
  }

  // per-day: people active, of which NEW (first real day is today) and REPEAT
  const days = [...new Set(people.flatMap((p) => [...p.days]))].sort();
  const perDay = days.map((d) => {
    let active = 0, isNew = 0;
    for (const p of people) {
      if (!p.days.has(d)) continue;
      active++;
      if ([...p.days].sort()[0] === d) isNew++;
    }
    return { day: d, active, new: isNew, repeat: active - isNew };
  });

  const last24 = (() => {
    const cut = new Date(end - 86400e3).toISOString().slice(0, 10);
    let ppl = 0, vd = 0;
    for (const p of people) {
      let hit = false;
      for (const d of p.days) { if (d >= cut) { vd++; hit = true; } }
      if (hit) ppl++;
    }
    return { people: ppl, visitorDays: vd };
  })();

  const result = {
    hours, window: { start, end }, files: { listed: inWindow.length, read, fromCache }, malformed,
    excludedHits: excluded,
    people: total, visitorDays, inflation: visitorDays ? Number((visitorDays / total).toFixed(2)) : 0,
    returning, oneDay, howManyDays: hist,
    perDay, last24Hours: last24,
    note: "people-level: identity is sha256(salt|address|browser) WITHOUT the day, in memory only; no id is printed or stored",
  };

  if (opts.json) { console.log(JSON.stringify(result, null, 2)); }
  else {
    console.log(`LoadLens — new vs returning visitors (last ${hours}h)`);
    console.log(`Window: ${new Date(start).toISOString()} .. ${new Date(end).toISOString()}  — ${read} log file(s) (${fromCache} from cache)\n`);
    console.log(`  PEOPLE (true unique)      : ${total}`);
    console.log(`  visitor-days (what the dashboard counts, and why it is higher): ${visitorDays}`);
    console.log(`  return rate               : ${total ? Math.round((returning / total) * 100) : 0}%  (${returning} came back, ${oneDay} only ever appeared once)\n`);
    console.log(`  how many distinct days each person appeared:`);
    for (const k of ["1", "2", "3-4", "5+"]) console.log(`      ${k.padEnd(4)} day(s) : ${hist[k]}`);
    console.log(`\n  per UTC day: people active, of which new / repeat`);
    for (const d of perDay) console.log(`      ${d.day}   active ${String(d.active).padStart(4)}   new ${String(d.new).padStart(4)}   repeat ${String(d.repeat).padStart(4)}`);
    console.log(`\n  last 24h: ${last24.people} people (${last24.visitorDays} visitor-days)`);
    console.log(`\nPrivacy: addresses are never printed or stored. The person id is derived WITHOUT the day and`);
    console.log(`exists in memory only for this run — it is not written to any file. What that buys: this is the`);
    console.log(`only report in the project that can tell you whether anyone came back.`);
  }

  // ---- the report file --------------------------------------------------------------------------
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const peakDay = Math.max(1, ...perDay.map((d) => d.active));
  const dayRows = perDay.map((d) => `<tr><td class="d">${esc(d.day)}</td><td class="b"><i style="width:${Math.round((d.active / peakDay) * 100)}%"></i><b>${d.active}</b></td><td class="n">${d.new}</td><td class="n">${d.repeat}</td></tr>`).join("");
  const css = ':root{color-scheme:dark}body{margin:0;padding:28px;font:15px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;background:#0e1116;color:#e6e9ef}'
    + 'h1{font-size:20px;margin:0 0 4px}.sub{color:#8b93a7;margin:0 0 22px}.tiles{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 22px}'
    + '.t{background:#161b22;border:1px solid #232a36;border-radius:10px;padding:12px 16px;min-width:150px}.t b{display:block;font-size:26px}'
    + '.t span{color:#8b93a7;font-size:12px;text-transform:uppercase}h2{font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:#8b93a7;margin:26px 0 10px}'
    + 'table{border-collapse:collapse;width:100%;max-width:720px}td,th{padding:4px 10px 4px 0;border-bottom:1px solid #1b212b;font-variant-numeric:tabular-nums;text-align:left}'
    + 'td.d{color:#aab3c5;white-space:nowrap;width:130px}td.b{position:relative;height:22px;width:60%}'
    + 'td.b i{position:absolute;left:0;top:3px;bottom:3px;background:linear-gradient(90deg,#2f6df6,#4d8dff);border-radius:3px}td.b b{position:relative;padding-left:6px}'
    + 'td.n{color:#aab3c5;width:80px}th{color:#8b93a7;font-size:12px;text-transform:uppercase}'
    + '.note{color:#79839a;font-size:12.5px;max-width:840px;margin-top:26px;border-top:1px solid #1b212b;padding-top:12px}';
  const tile = (l, v) => `<div class="t"><span>${l}</span><b>${v}</b></div>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>LoadLens - new vs returning</title><style>${css}</style></head><body>
<h1>LoadLens — new vs returning</h1>
<p class="sub">Last ${hours} hours · generated ${new Date(end).toISOString().replace("T", " ").slice(0, 16)} UTC · a local file, never deployed</p>
<div class="tiles">
${tile("people (true unique)", total)}
${tile("came back", returning)}
${tile("seen only once", oneDay)}
${tile("return rate", (total ? Math.round((returning / total) * 100) : 0) + "%")}
</div>
<p class="sub">The dashboard counts <b>${visitorDays} visitor-days</b> where there are <b>${total} people</b> — a ${visitorDays && total ? (visitorDays / total).toFixed(2) : "1.00"}× overcount, because its id includes the day by design.</p>
<h2>People active per day</h2>
<table><tr><th>day (UTC)</th><th>active</th><th>new</th><th>repeat</th></tr>${dayRows}</table>
<h2>How many days each person appeared</h2>
<table>${["1", "2", "3-4", "5+"].map((k) => `<tr><td class="d">${k} day(s)</td><td class="b"><i style="width:${Math.round((hist[k] / Math.max(1, total)) * 100)}%"></i><b>${hist[k]}</b></td></tr>`).join("")}</table>
<p class="note">A person is <code>sha256(salt | address | browser)</code> — <b>without</b> the day — so the same browser keeps one id across days. That id is built in memory and never written to this file, to any log, or to any server; only counts appear above. Addresses are never printed or stored.<br><br>
This is the one report that can say whether anyone came back. It exists because the standard visitor id deliberately includes the day, which makes cross-day linking impossible — the trade is that its "unique visitors" figure is visitor-days, not people.<br><br>
Regenerate: <code>node tools/visitor-people.mjs</code> from D:/webhvac.<br>Files read: ${read} of ${inWindow.length} in the window (${fromCache} from the cache).</p>
</body></html>`;
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), html);
  log(`wrote ${outPath} (${html.length} bytes)`);
}

main().catch((e) => { console.error(`! ${e && e.stack || e}`); process.exit(1); });

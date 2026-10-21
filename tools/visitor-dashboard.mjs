#!/usr/bin/env node
/* LoadLens - private visitor dashboard. Writes ONE self-contained HTML file into the user's
 * Documents folder, OUTSIDE the repo, so it is never deployed. All collection and every privacy
 * decision stays in tools/visitors.mjs; this file adds no data path and never sees an address. */
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith("--" + name + "="));
  return eq ? eq.split("=").slice(1).join("=") : dflt;
};
const hours = Number(arg("hours", 96));
const out = resolve(arg("out", "C:/Users/Aorus/Documents/LoadLens-Dashboard.html"));
const jsonFile = arg("json-file", null);

function firstJson(text) {
  const at = text.indexOf("{"); if (at < 0) throw new Error("no JSON in the output");
  let depth = 0, inStr = false, esc = false;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return JSON.parse(text.slice(at, i + 1)); }
  }
  throw new Error("unterminated JSON");
}
function loadData() {
  if (jsonFile) return firstJson(readFileSync(jsonFile, "utf8"));
  const r = spawnSync(process.execPath, [resolve("tools/visitors.mjs"), "--json", "--hours", String(hours)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const raw = String(r.stdout || "").trim(); const at = raw.indexOf("{");
  if (r.status !== 0 || at < 0) throw new Error("visitors.mjs failed: " + String(r.stderr || raw).slice(0, 800));
  return firstJson(raw);
}
function scalars(o, re, acc = []) {
  if (!o || typeof o !== "object") return acc;
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object") { if (typeof v.total === "number" && re.test(k)) acc.push({ key: k, n: v.total }); else scalars(v, re, acc); }
    else if (typeof v === "number" && re.test(k)) acc.push({ key: k, n: v });
  }
  return acc;
}
function objectNamed(o, re) {
  if (!o || typeof o !== "object") return null;
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object" && !Array.isArray(v)) { if (re.test(k)) return v; const d = objectNamed(v, re); if (d) return d; }
  }
  return null;
}
const first = (re) => { const l = scalars(data, re); return l.length ? l[0] : null; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n0 = (v) => (typeof v === "number" ? v : 0);

const data = loadData();
console.log("top-level keys:", Object.keys(data).join(", "));
const uv = (data.uniqueVisitors && typeof data.uniqueVisitors === "object") ? data.uniqueVisitors : { total: data.uniqueVisitors };
const numOf = (v) => (typeof v === "number" ? v : (v && typeof v === "object" ? (Object.values(v).find((x) => typeof x === "number") ?? null) : null));
// A "rows" source may be a {label: n} map or a list of {stem|path|url, count|visitors|requests}.
const asRows = (src, limit) => {
  const out = [];
  if (Array.isArray(src)) {
    for (const it of src) {
      if (!it || typeof it !== "object") continue;
      const label = it.stem ?? it.path ?? it.url ?? it.page ?? it.name ?? it.key ?? Object.values(it).find((x) => typeof x === "string") ?? "?";
      const n = numOf(it) ?? 0;
      out.push([String(label), Number(n) || 0]);
    }
  } else if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src)) out.push([k, n0(typeof v === "number" ? v : numOf(v))]);
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, limit);
};
const uvAny = uv.byDay || uv;
const byDay = (uv.byDay && typeof uv.byDay === "object") ? uv.byDay : {};
const days = Object.entries(byDay).map(([d, n]) => [d, n0(typeof n === "number" ? n : numOf(n))]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
const pages = asRows(uv.byPage || data.topStems || data.topPaths, 15);
const uni = { n: numOf(data.uniqueVisitors), key: "uniqueVisitors" };
const read = { n: numOf(data.totalRequests), key: "totalRequests" };
const excl = { n: numOf(data.excluded), key: "excluded" };
const parseHit = { n: numOf(data.apiParse) ?? 0, key: "apiParse" };
const peak = Math.max(1, ...days.map((x) => x[1]));
const topPage = pages.length ? Math.max(1, pages[0][1]) : 1;
const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
const bar = (label, n, pct) => '<tr><td class="d">' + esc(label) + '</td><td class="b"><i style="width:' + Math.max(2, Math.round(pct)) + '%"></i><b>' + n + '</b></td></tr>';
const dayRows = days.map((x) => bar(x[0], x[1], (x[1] / peak) * 100)).join("");
const pageRows = pages.map((x) => bar(x[0], x[1], (x[1] / topPage) * 100)).join("");
const detected = [["visitors", uni], ["requests", read], ["excluded", excl], ["parse", parseHit]].filter((x) => x[1]).map((x) => x[0] + "=" + x[1].key).join(", ");
const css = ':root{color-scheme:dark}body{margin:0;padding:28px;font:15px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;background:#0e1116;color:#e6e9ef}'
 + 'h1{font-size:20px;margin:0 0 4px}.sub{color:#8b93a7;margin:0 0 22px}.tiles{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 26px}'
 + '.t{background:#161b22;border:1px solid #232a36;border-radius:10px;padding:12px 16px;min-width:132px}.t b{display:block;font-size:26px}'
 + '.t span{color:#8b93a7;font-size:12px;text-transform:uppercase}h2{font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:#8b93a7;margin:26px 0 10px}'
 + 'table{border-collapse:collapse;width:100%;max-width:780px}td{padding:4px 10px 4px 0;border-bottom:1px solid #1b212b;font-variant-numeric:tabular-nums}'
 + 'td.d{color:#aab3c5;white-space:nowrap;width:150px;overflow:hidden;text-overflow:ellipsis}td.b{position:relative;height:22px}'
 + 'td.b i{position:absolute;left:0;top:3px;bottom:3px;background:linear-gradient(90deg,#2f6df6,#4d8dff);border-radius:3px}'
 + 'td.b b{position:relative;padding-left:6px;font-weight:600}.note{color:#79839a;font-size:12.5px;max-width:840px;margin-top:26px;border-top:1px solid #1b212b;padding-top:12px}.zero{color:#ffb4b4}';
const tile = (label, val, cls) => '<div class="t"><span>' + label + '</span><b class="' + (cls || "") + '">' + val + '</b></div>';
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>LoadLens - visitors (private)</title><style>' + css + '</style></head><body>'
 + '<h1>LoadLens - visitors</h1><p class="sub">Last ' + hours + ' hours - generated ' + stamp + ' - a local file, never deployed</p><div class="tiles">'
 + tile("unique real visitors", uni ? uni.n : "-") + tile("requests read", read ? read.n : "-") + tile("excluded", excl ? excl.n : "-")
 + tile("POST /api/parse", parseHit ? parseHit.n : 0, parseHit && parseHit.n > 0 ? "" : "zero") + '</div>'
 + '<h2>Unique visitors per day (UTC)</h2><table>' + (dayRows || '<tr><td class="d">no data</td><td></td></tr>') + '</table>'
 + '<h2>Pages (unique visitors)</h2><table>' + (pageRows || '<tr><td class="d">no data</td><td></td></tr>') + '</table>'
 + '<p class="note">A visitor is a 12-character salted hash, one per UTC day, computed by tools/visitors.mjs - the same code the terminal report uses. Raw addresses are never printed, never stored and never reach this file.</p></body></html>';

// A dashboard that silently reports zero is worse than no dashboard: it looks like data. Refuse to
// write when the logs were never read, and leave the previous file exactly as it was.
const readCount = numOf(data.totalRequests);
if (data.listError || !readCount) {
  console.error("refusing to write the dashboard: " + (data.listError ? "the log bucket could not be listed (" + data.listError + ")" : "zero requests were read") +
    "\n  the existing dashboard was left untouched. Check that the aws CLI is on PATH and credentials work.");
  process.exit(2);
}
if (!days.length) {
  console.error("refusing to write the dashboard: " + readCount + " requests read but no per-day data — schema mismatch in visitors.mjs --json?");
  process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });
const tmp = out + ".tmp";
writeFileSync(tmp, html);   // atomic: a crash mid-write must not leave a half dashboard
renameSync(tmp, out);
console.log("wrote " + out + " - " + html.length + " bytes, " + days.length + " day(s), " + pages.length + " page row(s)");

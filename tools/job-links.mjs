// tools/job-links.mjs — mint ONE tagged link per job-email recipient, so every email
// you send becomes attributable.
//
// WHY THIS EXISTS
// You send applications to companies. When someone opens the link you emailed, you want to tell
// that visit apart from a stranger's search hit and from a bot. The way to do that without any
// third-party analytics is a link tagged with utm_* parameters: the site's OWN anonymous beacon
// (/api/event, read back with tools/funnel.mjs) records which utm_campaign + utm_content the
// visit arrived with, and the site's OWN CloudFront access logs (read with tools/visitors.mjs)
// let the SAME tag be counted as unique PEOPLE per campaign. So: paste the right link into each
// email, and this tool has made that email's visit both attributable and countable.
//
// WHAT IT READS (never edits)
//   The applications list, which lives OUTSIDE this public repo:
//     C:\Users\Aorus\Documents\LoadLens-Applications.md
//   a markdown document containing one or more tables whose first column is the Company. Pass
//   --file <path> to point somewhere else. The company cell (and, when the table has one, the
//   second "ask/role" column) is copied out verbatim — nothing is invented.
//
// WHAT IT WRITES (stdout only)
//   One entry per recipient: the company/role exactly as written, plus
//     https://loadlens.net/?utm_source=email&utm_medium=outreach&utm_campaign=<campaign>&utm_content=<slug>
//   The slug is the company lowercased, every run of non-alphanumerics collapsed to a single '-',
//   trimmed of leading/trailing '-', capped at 40 characters, and made UNIQUE across the whole
//   list (the 2nd, 3rd… duplicate get '-2', '-3', … appended).
//
//   --campaign NAME  the utm_campaign value (default job-<year>-<month>, e.g. job-2026-10)
//   --csv            machine-readable rows: company,role,utm_content,url
//   --check          validate only: fail loudly (exit 1) if any two recipients share a
//                    utm_content, or if a slug is empty. Prints nothing else.
//   --base URL       the landing page (default https://loadlens.net/)
//
// Node only, no dependencies (stdlib only). Exits 0 on success, 1 on a problem.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Kept OUTSIDE the public repo on purpose: the applications pack is personal.
const DEFAULT_FILE = "C:\\Users\\Aorus\\Documents\\LoadLens-Applications.md";
const DEFAULT_BASE = "https://loadlens.net/";
const SLUG_MAX = 40;

/* ------------------------------- args ---------------------------------- */
function parseArgs(argv) {
  const opts = { file: DEFAULT_FILE, campaign: null, csv: false, check: false, base: DEFAULT_BASE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") opts.file = argv[++i];
    else if (a.startsWith("--file=")) opts.file = a.slice(7);
    else if (a === "--campaign") opts.campaign = argv[++i];
    else if (a.startsWith("--campaign=")) opts.campaign = a.slice(11);
    else if (a === "--base") opts.base = argv[++i];
    else if (a.startsWith("--base=")) opts.base = a.slice(7);
    else if (a === "--csv") opts.csv = true;
    else if (a === "--check") opts.check = true;
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
    else { console.error(`! unknown argument: ${a}`); printHelp(); process.exit(2); }
  }
  if (!opts.campaign) opts.campaign = defaultCampaign(new Date());
  return opts;
}

/** job-<year>-<month>, e.g. job-2026-10. Local date, matching how the owner dates things. */
function defaultCampaign(now) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `job-${y}-${m}`;
}

function printHelp() {
  console.log(`tools/job-links.mjs — one tagged link per job-email recipient

  node tools/job-links.mjs [--file PATH] [--campaign NAME] [--base URL] [--csv] [--check]

  --file PATH     applications markdown (default ${DEFAULT_FILE})
  --campaign NAME utm_campaign value (default job-<year>-<month>, e.g. ${defaultCampaign(new Date())})
  --base URL      landing page (default ${DEFAULT_BASE})
  --csv           print company,role,utm_content,url rows instead of the readable list
  --check         validate only: exit 1 if two recipients share a utm_content, or a slug is empty

Reads the applications list (outside this public repo; use --file to point elsewhere),
mints a unique utm_content slug per company, and prints the matching link to paste into
each email — so the site's own beacon and access logs can tell an emailed visit apart
from a stranger or a bot. It never edits the list.`);
}

/* ----------------------------- slug + uniq ----------------------------- */
/**
 * Company -> a URL-safe token: lowercase, runs of non-alphanumerics -> single '-', trimmed,
 * capped at SLUG_MAX with a trailing '-' removed. May be '' (a company cell with no letters or
 * digits at all) — callers treat that as an error, never paste it.
 */
function slugify(name) {
  return String(name == null ? "" : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

/**
 * Give every recipient a unique slug. recipients: [{ company, role }].
 * Returns [{ company, role, slug }] in input order; the 2nd/3rd… duplicate of a base slug get
 * '-2', '-3', … and the suffix is advanced until the slug is genuinely free.
 */
function assignSlugs(recipients) {
  const used = new Set();
  const out = [];
  for (const r of recipients) {
    const base = slugify(r.company);
    let slug = base;
    let n = 2;
    while (slug && used.has(slug)) { slug = `${base}-${n}`; n++; }
    if (slug) used.add(slug);
    out.push({ company: r.company, role: r.role || "", slug });
  }
  return out;
}

/* --------------------------- markdown tables --------------------------- */
const COMPANY_HEAD_RE = /^company\b/i;
const cellIsSeparator = (c) => /^:?-{2,}:?$/.test(String(c).trim());

/** Split a '| a | b | c |' row into trimmed cells, dropping the empty edges. */
function splitRow(line) {
  let s = String(line).trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/**
 * Parse every markdown table whose first column header is "Company". Returns
 * { tables: [{ header, rows: [{cells}] }], recipients: [{ company, role }] }.
 * A table is a header row, then a '---' separator row, then data rows up to the first
 * non-table line. The 2nd column, when the table has one, is kept as "role" (the tables in
 * the applications pack head it "Ask for" / "Why").
 */
function parseApplications(text) {
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  const tables = [];
  const recipients = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("|")) continue;
    const cells = splitRow(line);
    if (cells.length < 2) continue;
    if (!COMPANY_HEAD_RE.test(cells[0])) continue;
    // need a separator row next
    if (i + 1 >= lines.length || !line.includes("|")) continue;
    const sep = splitRow(lines[i + 1]);
    if (!sep.length || !sep.every(cellIsSeparator)) continue;

    const table = { header: cells, rows: [] };
    let j = i + 2;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (!l.includes("|") || !l.trim().startsWith("|")) break;
      const rc = splitRow(l);
      if (!rc.length || !rc[0]) continue;
      if (rc.every(cellIsSeparator)) continue;
      // stop if a repeated header row sneaks in
      if (COMPANY_HEAD_RE.test(rc[0])) continue;
      table.rows.push({ cells: rc, company: rc[0], role: rc[1] || "" });
      recipients.push({ company: rc[0], role: rc[1] || "" });
    }
    tables.push(table);
    i = j - 1; // continue after the table
  }
  return { tables, recipients };
}

/* ------------------------------- links --------------------------------- */
function buildUrl(base, campaign, slug) {
  const b = String(base).replace(/\?+$/, "");
  return `${b}?utm_source=email&utm_medium=outreach&utm_campaign=${encodeURIComponent(campaign)}&utm_content=${encodeURIComponent(slug)}`;
}

/** Validate the minted links. Returns an array of problem strings (empty = good). */
function checkLinks(links) {
  const problems = [];
  const seen = new Map();
  for (const l of links) {
    if (!l.slug) problems.push(`empty utm_content for recipient "${l.company}"`);
    if (seen.has(l.slug)) problems.push(`duplicate utm_content "${l.slug}" (${seen.get(l.slug)} and ${l.company})`);
    else seen.set(l.slug, l.company);
  }
  return problems;
}

/* ------------------------------- output -------------------------------- */
function csvField(v) {
  const s = String(v == null ? "" : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function printList(links, campaign, file, tableCount) {
  console.log(`LoadLens — per-recipient tagged links for job emails`);
  console.log(`  campaign : ${campaign}`);
  console.log(`  source   : ${file}  (${links.length} recipient(s), ${tableCount} table(s))`);
  console.log("");
  console.log(`Paste the matching link into that recipient's email. The site's own anonymous beacon`);
  console.log(`then reports which link was clicked and what the visitor did — so a visit from an`);
  console.log(`emailed link can be told apart from a stranger and from a bot.`);
  console.log("");
  const w = Math.max(...links.map((l) => l.company.length), 7);
  links.forEach((l, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${l.company}${l.role ? " — " + l.role : ""}`);
    console.log(`    ${buildUrl(DEFAULT_BASE, campaign, l.slug)}`);
  });
  console.log("");
  console.log(`${links.length} link(s) minted.  utm_source=email  utm_medium=outreach  utm_campaign=${campaign}`);
}

function printCsv(links, campaign) {
  console.log("company,role,utm_content,url");
  for (const l of links) {
    console.log([l.company, l.role, l.slug, buildUrl(DEFAULT_BASE, campaign, l.slug)].map(csvField).join(","));
  }
}

/* -------------------------------- main --------------------------------- */
function main() {
  const opts = parseArgs(process.argv.slice(2));
  let text;
  try { text = fs.readFileSync(opts.file, "utf8"); }
  catch (e) {
    console.error(`! could not read the applications list at ${opts.file}: ${e.code || e.message}`);
    console.error(`  (pass --file <path> to point at it)`);
    process.exit(1);
  }
  const { tables, recipients } = parseApplications(text);
  if (!recipients.length) {
    console.error(`! no "| Company | … |" table with rows was found in ${opts.file}`);
    process.exit(1);
  }
  const links = assignSlugs(recipients);
  const problems = checkLinks(links);

  if (opts.check) {
    if (problems.length) {
      console.error(`FAILED — ${problems.length} problem(s):`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`OK — ${links.length} recipient(s), every utm_content unique and non-empty (campaign ${opts.campaign}).`);
    process.exit(0);
  }

  if (opts.csv) printCsv(links, opts.campaign);
  else printList(links, opts.campaign, opts.file, tables.length);

  if (problems.length) {
    console.error(`\n! ${problems.length} problem(s) — run with --check for detail:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  process.exit(0);
}

export {
  DEFAULT_FILE, DEFAULT_BASE, SLUG_MAX,
  parseArgs, defaultCampaign, slugify, assignSlugs, splitRow, parseApplications,
  buildUrl, checkLinks, csvField,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

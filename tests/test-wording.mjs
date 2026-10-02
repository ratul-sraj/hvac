// tests/test-wording.mjs — a pure-node guard on the site's privacy wording and the sample staging.
//
//   node tests/test-wording.mjs
//
// It exists because the site once claimed more than it does: it said an uploaded PDF was "never
// uploaded anywhere" and that "there is no cloud service", while the hosted copy (loadlens.net)
// actually posts the PDF to the operator's OWN server to be read faster (parsed in memory, not
// stored, nothing logged). The narrow TRUE claim is:
//   never sent to a third party; on loadlens.net the file is posted to this site's own server to be
//   read faster — it is not stored and nothing from it is logged.
// This test pins that claim and forbids the old absolute wording returning to the pages we own.
//
// It is standalone (prints its own PASS/FAIL, exits non-zero on failure) and is NOT wired into
// tests/run.mjs — run it directly, or add it to the runner when the sample wiring lands.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0;
const failures = [];
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}`); }
}

// --- 1. no absolute privacy claim may remain in the pages/docs we own --------------------------
// (The question headings "...uploaded anywhere?" are a QUESTION, not a claim, so "uploaded anywhere"
//  on its own is deliberately not forbidden — only the absolute statements are.)
const FORBIDDEN = [
  /never uploaded/i,
  /nothing is uploaded/i,
  /no cloud service/i,
  /uploaded anywhere on its own/i,
  /never uploaded to any server/i,
];
const CLAIM_PAGES = ["help.html", "about.html", "docs/USER-GUIDE.md", "docs/DEMO-SCRIPT.md"];
for (const rel of CLAIM_PAGES) {
  let text;
  try { text = read(rel); } catch { check(`${rel} is readable`, false); continue; }
  for (const re of FORBIDDEN) {
    check(`${rel} does not say ${re}`, !re.test(text));
  }
}

// --- 2. the narrow true claim must be present in each page that talks about it -----------------
const REQUIRED = [
  ["help.html", /never sent to a third party/i],
  ["help.html", /this site's own server/i],
  ["about.html", /never sent to a third party/i],
  ["about.html", /this site's own server/i],
  ["docs/USER-GUIDE.md", /never sent to a third party/i],
  ["docs/DEMO-SCRIPT.md", /never sent to a third party/i],
  ["docs/DEMO-SCRIPT.md", /loadlens\.net/i],
];
for (const [rel, re] of REQUIRED) {
  check(`${rel} states ${re}`, re.test(read(rel)));
}

// --- 3. the UI strings quoted in the docs must match what the app shows ------------------------
// js/app.js is owned by another change; we only READ it to check the quoted strings are current.
const appJs = read("js/app.js");
check("app shows the browser-mode string", appJs.includes("PDF drawings and CSV / TSV / Excel room schedules: in your browser."));
check("app shows the server-mode string", appJs.includes("PDF drawings: on the server (faster)."));
const help = read("help.html");
const guide = read("docs/USER-GUIDE.md");
check("help.html quotes the browser-mode string", help.includes("PDF drawings and CSV / TSV / Excel room schedules: in your browser."));
check("help.html quotes the server-mode string", help.includes("PDF drawings: on the server (faster)."));
check("USER-GUIDE quotes the server-mode string", guide.includes("PDF drawings: on the server (faster)."));
check("stale UI string 'Reading PDFs on the server' is gone from help.html", !/Reading PDFs on the server/.test(help));
check("stale UI string 'Reading PDFs on the server' is gone from USER-GUIDE", !/Reading PDFs on the server/.test(guide));

// --- 4. both licensed sample plans are at the expected byte sizes ------------------------------
const EXPECTED_SAMPLES = {
  "samples/level-11-floor-plan.pdf": 393532,
  "samples/waller-estate-floor-plan.pdf": 848237,
};
for (const [rel, bytes] of Object.entries(EXPECTED_SAMPLES)) {
  let ok = false;
  try { ok = fs.statSync(path.join(ROOT, rel)).size === bytes; } catch { ok = false; }
  check(`${rel} exists at ${bytes} bytes`, ok);
}

// --- 5. .gitignore tracks ONLY the two licensed plans under samples/ ---------------------------
const gi = read(".gitignore");
check(".gitignore whitelists level-11-floor-plan.pdf", gi.includes("!/samples/level-11-floor-plan.pdf"));
check(".gitignore whitelists waller-estate-floor-plan.pdf", gi.includes("!/samples/waller-estate-floor-plan.pdf"));
check(".gitignore still ignores the rest of samples/", /^\/samples\/\*$/m.test(gi));

// --- 6. both deploy allow-lists name both plans (a wildcard would sweep in a private drawing) --
const deploy = read("infra/50-deploy-site.sh");
const pages = read(".github/workflows/pages.yml");
for (const name of ["level-11-floor-plan.pdf", "waller-estate-floor-plan.pdf"]) {
  check(`infra/50-deploy-site.sh names ${name}`, deploy.includes(`samples/${name}`));
  check(`.github/workflows/pages.yml names ${name}`, pages.includes(`samples/${name}`));
}
check("deploy allow-list is a named copy, not a samples/*.pdf wildcard", !/cp .*samples\/\*\.pdf/.test(deploy));

// --- 7. the new plan is exactly the file we licence-checked -----------------------------------
const WALLER_SHA = "4b68eea0ae673c0b796e714f93ab0164093c4b3b9cefa6c62d98d5a096c7fb65";
try {
  const h = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "samples/waller-estate-floor-plan.pdf"))).digest("hex");
  check("waller-estate-floor-plan.pdf sha256 matches the checked file", h === WALLER_SHA);
} catch { check("waller-estate-floor-plan.pdf sha256 matches the checked file", false); }

// --- 8. its credit block records the real author and licence (CC BY-SA 3.0) --------------------
const credits = read("docs/SAMPLE-CREDITS.md");
check("credit names the author MichaelScott99", credits.includes("MichaelScott99"));
check("credit states CC BY-SA 3.0", /CC BY-SA 3\.0/.test(credits));
check("credit links the Commons file page", credits.includes("File:BALLARAT_Waller_Estate_Floor_plan.pdf"));

console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length) {
  console.log("failed:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("WORDING + SAMPLE STAGING OK");

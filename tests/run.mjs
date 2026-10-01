// Test runner: plain node, no framework.
//   cd D:/webhvac && node tests/run.mjs
// Prints PASS/FAIL per test and exits 1 on the first failing run.
//
// Two tiers, so that `npm test` can actually pass on a GitHub ubuntu runner without shrinking
// local (Windows) coverage:
//   1. PURE-NODE suites — need nothing but node + the installed deps. They always run; this is the
//      set the CI gate covers.
//   2. BROWSER/SERVER suites — need the Windows Edge install AND the app already served on
//      http://127.0.0.1:3000 (they never start a server). They run when both are present and
//      SKIP LOUDLY, by name, when they are not — never silently pass. On ubuntu none of this
//      exists, so they skip there; on the dev machine they still run, so coverage does not shrink.
//      (`npm run test:browser` runs tests/browser-check.mjs, the big manual browser suite.)
import { writeSample } from "./make-sample.mjs";
import { writeSamplePlan } from "../tools/make-sample-plan.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import * as calc from "./test-calc.mjs";
import * as samplePlan from "./test-sample-plan.mjs";
import * as parseText from "./test-parseText.mjs";
import * as samplePdf from "./test-sample-pdf.mjs";

const suites = [
  ["engine/calc", calc],
  ["text/parseText", parseText],
  ["pdf/sample", samplePdf],
  ["pdf/sample-plan", samplePlan],
];

const only = process.argv[2];

// the synthetic fixtures are (re)generated on every run: schedule-sample.pdf (hand-built
// schedule table) and sample-plan.pdf (the 3-page sample drawing the sample button loads)
writeSample();
writeSamplePlan();

let pass = 0;
const failures = [];
const skipped = [];
for (const [label, mod] of suites) {
  if (only && !label.includes(only)) continue;
  console.log(`\n${label}`);
  for (const name of Object.keys(mod)) {
    if (!/^test/.test(name) || typeof mod[name] !== "function") continue;
    const title = `${label} :: ${name}`;
    try {
      await mod[name]();
      console.log(`  PASS  ${name}`);
      pass++;
    } catch (err) {
      failures.push(title);
      console.log(`  FAIL  ${name}`);
      console.log(
        "        " + String((err && err.message) || err).split("\n").join("\n        ")
      );
    }
  }
}

// Run one standalone suite: a self-contained script that prints its own PASS/FAIL and exits
// non-zero on failure (rather than a module exporting test* functions).
function runStandalone(label, file) {
  const run = spawnSync(process.execPath, [file], { encoding: "utf8" });
  const lines = String(run.stdout || "").split("\n").filter((l) => l.trim());
  if (run.status === 0) {
    pass += 1;
    console.log(`  PASS  ${file}  — ${lines[lines.length - 1] || ""}`);
    return;
  }
  failures.push(`${label} :: ${file}`);
  console.log(`  FAIL  ${file}`);
  for (const l of lines.slice(-14)) console.log("        " + l);
  if (run.stderr) console.log("        " + String(run.stderr).split("\n").join("\n        "));
}

// Standalone PURE-NODE suites (no browser, no server): they always gate CI. js/planview.js is the
// geometry behind drawing rooms on the plan (69 checks), js/trace.js owns the outline geometry
// (41 checks), and tests/test-input-guards.mjs pins the negative / impossible-input rules of
// js/calc.js (41 checks).
const STANDALONE_NODE = [
  ["plan/geometry", "tests/test-planview.mjs"],
  ["room outlines", "tests/test-trace.mjs"],
  ["input guards", "tests/test-input-guards.mjs"],
];

for (const [label, file] of STANDALONE_NODE) {
  if (only && !label.includes(only)) continue;
  console.log(`\n${label}`);
  runStandalone(label, file);
}

// ---------------------------------------------------------------- browser/server tier
// tests/test-rehydrate.mjs drives the installed Edge against the app served on :3000. Both needs
// are probed first; a missing one SKIPs loudly with the reason, so this file can never turn a
// missing browser into a silent pass (and CI, which has neither, can still go green on tier 1).
const EDGE = process.env.LOADLENS_EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const APP_URL = process.env.LOADLENS_APP_URL || "http://127.0.0.1:3000/app.html";
const BROWSER_SUITES = [["saved projects", "tests/test-rehydrate.mjs"]];

async function serverUp(url, ms = 2500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: "manual" });
    return res.status > 0;
  } catch {
    return false;
  }
}

const edgeHere = fs.existsSync(EDGE);
const appHere = edgeHere ? await serverUp(APP_URL) : false;

for (const [label, file] of BROWSER_SUITES) {
  if (only && !label.includes(only)) continue;
  console.log(`\n${label}`);
  const missing = [];
  if (!edgeHere) missing.push(`Windows Edge is not installed at ${EDGE}`);
  if (!appHere) missing.push(`the app is not being served on ${APP_URL}`);
  if (missing.length) {
    skipped.push(`${label} :: ${file}`);
    console.log(
      `  SKIP  ${file}  — ${missing.join("; ")}.\n` +
        `        This browser suite only runs on the dev machine (start it with: node server.js).\n` +
        `        A GitHub ubuntu runner has neither, so it is skipped there by design — not a failure.`
    );
    continue;
  }
  runStandalone(label, file);
}

const total = pass + failures.length;
console.log(
  `\n${pass}/${total} tests passed` +
    (skipped.length
      ? `, ${skipped.length} skipped (browser/server suite; needs Windows Edge + the app on :3000)`
      : "")
);
if (failures.length) {
  console.log("failed:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log(skipped.length ? "ALL RUNNABLE TESTS PASSED" : "ALL TESTS PASSED");

// Test runner: plain node, no framework.
//   cd D:/webhvac && node tests/run.mjs
// Prints PASS/FAIL per test and exits 1 on the first failing run.
import { writeSample } from "./make-sample.mjs";
import { writeSamplePlan } from "../tools/make-sample-plan.mjs";
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

const total = pass + failures.length;
console.log(`\n${pass}/${total} tests passed`);
if (failures.length) {
  console.log("failed:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("ALL TESTS PASSED");
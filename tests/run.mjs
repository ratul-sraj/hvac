// Test runner: plain node, no framework.
//   cd D:/webhvac && node tests/run.mjs
// Prints PASS/FAIL per test and exits 1 on the first failing run.
import { writeSample } from "./make-sample.mjs";
import * as headquarters from "./test-headquarters.mjs";
import * as parseText from "./test-parseText.mjs";
import * as samplePdf from "./test-sample-pdf.mjs";

const suites = [
  ["text/parseText", parseText],
  ["pdf/sample", samplePdf],
  ["pdf/headquarters", headquarters],
];

const only = process.argv[2];

// the synthetic sample PDF is (re)generated on every run
writeSample();

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
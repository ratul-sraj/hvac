// tests/proptest/run.mjs — run the property catalogue.
//
//   node tests/proptest/run.mjs                 # 100 cases per property
//   node tests/proptest/run.mjs --cases 500
//   node tests/proptest/run.mjs --target calc   # one target only
//   node tests/proptest/run.mjs --seed 7
//
// Exit code 1 if any property fails. Failures print the shrunk counterexample.
import { props } from "./props.mjs";
import { Rng, fmt, shrink } from "./lib.mjs";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith("--" + name + "="));
  return eq ? eq.split("=").slice(1).join("=") : dflt;
};

const CASES = Number(arg("cases", 100));
const SEED = Number(arg("seed", 20261108));
const ONLY = arg("target", null);

let failures = 0, passed = 0;
const lines = [];

for (const p of props) {
  if (ONLY && p.target !== ONLY) continue;
  let failed = null;
  for (let i = 0; i < CASES; i += 1) {
    const rng = new Rng(SEED + i * 7919 + p.name.length);
    let c;
    try { c = p.gen(rng); } catch (e) { failed = { arg: null, res: { ok: false, why: `generator threw: ${e.message}` } }; break; }
    let res;
    try { res = p.check(c); } catch (e) { res = { ok: false, why: `threw: ${e.message}` }; }
    if (!res || res.ok !== true) { failed = { arg: c, res }; break; }
  }
  if (!failed) { passed += 1; lines.push(`PASS  ${p.target.padEnd(14)} ${p.name}`); continue; }

  failures += 1;
  const check = (c) => { try { return p.check(c); } catch (e) { return { ok: false, why: `threw: ${e.message}` }; } };
  let minimal = failed;
  if (p.simplify && failed.arg != null) {
    minimal = shrink({ arg: failed.arg, check, res: failed.res }, p.simplify);
  }
  lines.push(`FAIL  ${p.target.padEnd(14)} ${p.name}`);
  lines.push(`      why:  ${minimal.res.why}`);
  lines.push(`      case: ${fmt(minimal.arg)}`);
}

console.log(lines.join("\n"));
console.log(`\n${passed} propert${passed === 1 ? "y" : "ies"} passed, ${failures} failed  (${CASES} cases each, seed ${SEED})`);
process.exit(failures ? 1 : 0);

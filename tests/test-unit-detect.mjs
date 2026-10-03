// Unit-system detection (js/unitdetect.js): does a sheet talk in metric or imperial?
//
// The detector reads the RAW evidence js/pdfparse.js recorded (parsed.evidence) — the unit each
// accepted area figure was written in, the format of each dimension run, and any scale note. This
// suite proves the rules in docs/UNITS-PLAN.md: agreement -> high confidence, one figure -> low,
// nothing -> unknown, and a genuinely mixed sheet -> low confidence with the conflict stated, never
// guessed away. `reason` must always be a non-empty sentence with no "undefined"/"NaN" in it.
//
// Synthetic parse-result objects cover the odd shapes; two REAL plans cover the ordinary cases:
//   * tests/samples/sample-plan.pdf     — the committed synthetic sample drawing (m² areas + SCALE 1:100)
//   * samples/level-11-floor-plan.pdf   — the public CC BY-SA office plan
// The level-11 sheet prints no areas and no dimensions (only a "SCALE 1:100" note), so its honest
// verdict is asserted as measured below, not forced.
//
//   cd D:/webhvac && node tests/test-unit-detect.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { parsePdf } from "../js/pdfparse.js";
import { detectUnits } from "../js/unitdetect.js";
import { writeSamplePlan, OUT_PATH as SAMPLE_PLAN } from "../tools/make-sample-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEVEL_11 = path.join(HERE, "..", "samples", "level-11-floor-plan.pdf");

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, null]); }
  catch (err) { checks.push([name, err]); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); checks.push([name, null]); }
  catch (err) { checks.push([name, err]); }
};

// ---- synthetic evidence records ----------------------------------------------------------------
const EV = (area = {}, dims = {}, scale = {}, samples = []) => ({
  areaUnits: { m2: 0, ft2: 0, ...area },
  dims: { metric: 0, feet: 0, ...dims },
  scaleText: { metric: 0, imperial: 0, ...scale },
  samples,
});
const clean = (s) => typeof s === "string" && s.length > 0 && !/undefined|NaN/.test(s);

// ---- the five verdicts on synthetic sheets -----------------------------------------------------
check("metric sheet: m² areas + mm dimensions + 1:100 scale -> si / high", () => {
  const d = detectUnits({ evidence: EV({ m2: 5 }, { metric: 3 }, { metric: 1 }, ["33.5 m²", "4500x3600", "SCALE 1:100"]) });
  assert.equal(d.system, "si");
  assert.equal(d.confidence, "high");
  assert.match(d.reason, /metric/i);
  assert.ok(clean(d.reason), `reason: ${d.reason}`);
  assert.equal(d.evidence.areaUnits.m2, 5);
});

check("imperial sheet: ft² areas + feet-inch dimensions + 1/4\"=1'-0\" -> ip / high", () => {
  const d = detectUnits({ evidence: EV({ ft2: 4 }, { feet: 2 }, { imperial: 1 }, ["3,385 ft²", `12'-0" x 10'-6"`, `1/4" = 1'-0"`]) });
  assert.equal(d.system, "ip");
  assert.equal(d.confidence, "high");
  assert.match(d.reason, /imperial/i);
  assert.ok(clean(d.reason), `reason: ${d.reason}`);
});

check("two agreeing pieces (one area + one dimension) is enough for high confidence", () => {
  assert.equal(detectUnits({ evidence: EV({ ft2: 2 }) }).confidence, "high");
  assert.equal(detectUnits({ evidence: EV({}, { metric: 2 }) }).confidence, "high");
});

check("a single piece of evidence is low confidence, metric or imperial", () => {
  const m = detectUnits({ evidence: EV({ m2: 1 }) });
  assert.equal(m.system, "si");
  assert.equal(m.confidence, "low");
  assert.match(m.reason, /one|single/i);
  const i = detectUnits({ evidence: EV({}, { feet: 1 }) });
  assert.equal(i.system, "ip");
  assert.equal(i.confidence, "low");
  assert.ok(clean(i.reason));
});

check("mixed sheet: feet-inches dimensions beside m² areas -> low, reason states the conflict", () => {
  const d = detectUnits({ evidence: EV({ m2: 3 }, { feet: 2 }, {}, [`12'-0" x 10'-6"`, "33.5 m²"]) });
  assert.equal(d.confidence, "low", "a contradiction can never be high confidence");
  assert.ok(d.system === "si" || d.system === "ip" || d.system === "unknown");
  assert.match(d.reason, /conflict/i);
  assert.match(d.reason, /imperial/i);
  assert.match(d.reason, /metric/i);
  assert.match(d.reason, /3/);   // honest counts, not a silent resolution
  assert.match(d.reason, /2/);
  assert.ok(clean(d.reason), `reason: ${d.reason}`);
});

check("no evidence at all -> unknown / none with a plain reason", () => {
  const d = detectUnits({ evidence: EV() });
  assert.equal(d.system, "unknown");
  assert.equal(d.confidence, "none");
  assert.match(d.reason, /no unit evidence/i);
  assert.ok(clean(d.reason));
});

// ---- robustness ---------------------------------------------------------------------------------
check("never throws and always returns a non-empty reason on odd inputs", () => {
  const odd = [
    null, undefined, 0, 1, "not a parse result", [], {},
    { evidence: null }, { evidence: {} }, { evidence: "nope" },
    { rooms: [], warnings: [] },
    { evidence: EV({ m2: "x", ft2: -3 }, null, undefined, "oops") },
    { evidence: { areaUnits: { m2: NaN, ft2: Infinity }, dims: { metric: "2" } } },
  ];
  for (const input of odd) {
    let d;
    assert.doesNotThrow(() => { d = detectUnits(input); }, `threw on ${JSON.stringify(input)}`);
    assert.ok(d && typeof d === "object", "returned an object");
    assert.ok(["si", "ip", "unknown"].includes(d.system), `bad system ${d.system}`);
    assert.ok(["high", "low", "none"].includes(d.confidence), `bad confidence ${d.confidence}`);
    assert.ok(clean(d.reason), `reason not clean: ${JSON.stringify(d.reason)}`);
    assert.ok(clean(JSON.stringify(d.evidence)), `evidence not clean: ${JSON.stringify(d.evidence)}`);
  }
});

check("accepts a bare evidence record as well as a full parse result", () => {
  const bare = detectUnits(EV({ ft2: 10 }, { feet: 1 }));
  assert.equal(bare.system, "ip");
  assert.equal(bare.confidence, "high");
});

check("samples are capped at 5 and never carry junk entries", () => {
  const d = detectUnits({ evidence: EV({ m2: 9 }, {}, {}, ["a", "", null, "b", "c", "d", "e", "f"]) });
  assert.equal(d.evidence.samples.length, 5);
  assert.ok(d.evidence.samples.every((s) => typeof s === "string" && s.length));
});

check("evidence counts on the output are non-negative integers", () => {
  const d = detectUnits({ evidence: EV({ m2: 2.9 }, { metric: 1 }) });
  const e = d.evidence;
  for (const n of [e.areaUnits.m2, e.areaUnits.ft2, e.dims.metric, e.dims.feet, e.scaleText.metric, e.scaleText.imperial]) {
    assert.ok(Number.isInteger(n) && n >= 0, `bad count ${n}`);
  }
});

// ---- real plans ---------------------------------------------------------------------------------
let realFails = 0;

if (!fs.existsSync(SAMPLE_PLAN)) {
  try { writeSamplePlan(); } catch { /* fall through to the explicit failure below */ }
}
if (!fs.existsSync(SAMPLE_PLAN)) {
  console.log(`  FAIL  the real sample plan is missing and could not be built: ${SAMPLE_PLAN}`);
  realFails++;
} else {
  const buf = fs.readFileSync(SAMPLE_PLAN);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const res = await parsePdf(ab, { pdfjs });
  const d = detectUnits(res);
  console.log(`  info  tests/samples/sample-plan.pdf -> ${d.system}/${d.confidence} ` +
    `(areas ${d.evidence.areaUnits.m2}m²/${d.evidence.areaUnits.ft2}ft², dims ${d.evidence.dims.metric}/${d.evidence.dims.feet}, ` +
    `scale ${d.evidence.scaleText.metric}/${d.evidence.scaleText.imperial})`);

  await checkAsync("real metric sample drawing is detected as si / high", () => {
    assert.ok(res.evidence, "parse result carries the evidence the detector needs");
    assert.equal(res.evidence.areaUnits.m2, res.rooms.length, "one m² area figure per parsed room");
    assert.equal(d.system, "si");
    assert.equal(d.confidence, "high");
    assert.ok(d.evidence.areaUnits.m2 > 120, `m² area figures measured ${d.evidence.areaUnits.m2}`);
    assert.ok(d.evidence.scaleText.metric >= 1, "the sheet prints SCALE 1:100");
    assert.ok(clean(d.reason) && /metric/i.test(d.reason), `reason: ${d.reason}`);
  });
  await checkAsync("real metric sample exposes a quotable m² sample for the UI", () => {
    assert.ok(d.evidence.samples.some((s) => /m²/.test(s)), `samples: ${JSON.stringify(d.evidence.samples)}`);
  });
}

if (!fs.existsSync(LEVEL_11)) {
  console.log(`  SKIP  ${path.basename(LEVEL_11)} is not on disk — the real CC BY-SA plan was not checked.`);
} else {
  const buf = fs.readFileSync(LEVEL_11);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const res = await parsePdf(ab, { pdfjs });
  const d = detectUnits(res);
  // MEASURED on this sheet: it prints no areas and no dimensions at all, but it DOES print a
  // "SCALE 1:100" note — one piece of metric evidence, so the honest verdict is si / low, not
  // "unknown". Asserted exactly as measured rather than forced to a guess.
  console.log(`  info  samples/level-11-floor-plan.pdf -> ${d.system}/${d.confidence} ` +
    `(areas ${d.evidence.areaUnits.m2}m²/${d.evidence.areaUnits.ft2}ft², dims ${d.evidence.dims.metric}/${d.evidence.dims.feet}, ` +
    `scale ${d.evidence.scaleText.metric}/${d.evidence.scaleText.imperial})`);

  await checkAsync("real office plan prints no areas and no dimensions (so nothing forces a system)", () => {
    assert.equal(d.evidence.areaUnits.m2, 0);
    assert.equal(d.evidence.areaUnits.ft2, 0);
    assert.equal(d.evidence.dims.metric, 0);
    assert.equal(d.evidence.dims.feet, 0);
    assert.equal(d.evidence.scaleText.imperial, 0);
  });
  await checkAsync("real office plan's lone SCALE 1:100 -> si / low, reason non-empty", () => {
    assert.equal(d.evidence.scaleText.metric, 1, "the sheet prints exactly one SCALE 1:100 note");
    assert.equal(d.system, "si");
    assert.equal(d.confidence, "low", "one piece of evidence is never high confidence");
    assert.ok(clean(d.reason), `reason: ${d.reason}`);
  });
}

// ---------------------------------------------------------------- report
let pass = 0;
const failures = [];
for (const [name, err] of checks) {
  if (err) { failures.push(name); console.log(`  FAIL  ${name}`); console.log("        " + (err.message || err)); }
  else { pass++; console.log(`  PASS  ${name}`); }
}
console.log(`\nunit detection: ${pass}/${checks.length} checks passed${realFails ? `, ${realFails} real-fixture error(s)` : ""}`);
if (failures.length || realFails) process.exit(1);
console.log("ALL UNIT-DETECT CHECKS PASSED");

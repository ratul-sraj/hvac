// Tests for tools/funnel.mjs — the anonymous usage readout.
//
//   cd D:/webhvac && node tests/test-funnel.mjs
//
// The bug these guard against: share_link_copied and calc_empty were listed as known events but
// belonged to no FUNNEL step, so `FUNNEL.find((f) => f.events.includes(ev.e)).step` threw a
// TypeError the first time either appeared in the log and the tool printed NOTHING. Both have live
// call sites, so it would break on real traffic. These tests feed fixture rows (including both) and
// prove the tool completes and reports them, and that an unknown event is reported, not crashed on.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tally, FUNNEL, FAILURE_EVENTS, ALL_EVENTS, STEP_OF, stripPrefix } from "../tools/funnel.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TOOL = path.join(ROOT, "tools", "funnel.mjs");

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};

// A CloudWatch-shaped log: prefixed lines, one malformed line, one event the tool does not know.
const FIXTURE = [
  '2026-10-01T10:00:00.000Z\treq-1\tINFO\t{"evt":"usage","e":"app_open","utm_source":"google","utm_medium":"cpc","utm_campaign":"g-oct2","utm_content":"hook1"}',
  '2026-10-01T10:01:00.000Z\treq-2\tINFO\t{"evt":"usage","e":"sample_loaded","p":{"source":"sample"},"utm_campaign":"g-oct2"}',
  '2026-10-01T10:02:00.000Z\treq-3\tINFO\t{"evt":"usage","e":"share_link_copied","utm_campaign":"g-oct2"}',
  '2026-10-01T10:03:00.000Z\treq-4\tINFO\t{"evt":"usage","e":"calc_empty","utm_campaign":"g-oct2"}',
  '2026-10-01T10:04:00.000Z\treq-5\tINFO\t{"evt":"usage","e":"export_csv","utm_campaign":"m-oct2"}',
  "{not json",
  '2026-10-01T10:05:00.000Z\treq-6\tINFO\t{"evt":"usage","e":"something_new"}',
].join("\n") + "\n";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadlens-funnel-"));
const file = path.join(dir, "fixture.log");
fs.writeFileSync(file, FIXTURE, "utf8");

// first JSON object in a mixed stdout stream
function firstJson(s) {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

/* ---------- the crash fix: every known event maps to a step or a failure bucket ------ */
ok("FUNNEL has four success steps", FUNNEL.length === 4, FUNNEL.map((f) => f.step).join(","));
for (const e of ALL_EVENTS) {
  const mapped = STEP_OF.has(e) || FAILURE_EVENTS.includes(e);
  ok(`event "${e}" maps to a step or the failure bucket (never neither)`, mapped);
}
ok("share_link_copied belongs to the converted step (no more TypeError)",
  STEP_OF.get("share_link_copied") === "converted");
ok("calc_empty is a failure signal, never a success step",
  !STEP_OF.has("calc_empty") && FAILURE_EVENTS.includes("calc_empty"));

/* ---------- tally() completes on the fixture ---------------------------------------- */
const lines = FIXTURE.split(/\r?\n/).filter((l) => l.trim()).map(stripPrefix);
let t = null;
let threw = false;
try { t = tally(lines); } catch (e) { threw = true; console.log("      tally threw: " + e.message); }
ok("tally() completes on a log containing share_link_copied and calc_empty", !threw);
ok("tally counts share_link_copied in the converted step", !!t && t.stepCount.converted === 2,
  t ? JSON.stringify(t.stepCount) : "no result");
ok("tally counts calc_empty as a failure signal, not a step", !!t && t.failures.calc_empty === 1,
  t ? JSON.stringify(t.failures) : "no result");
ok("tally counts an unknown event instead of throwing", !!t && t.unknown === 1 &&
  t.unknownNames instanceof Set && [...t.unknownNames].includes("something_new"));
ok("tally counts the malformed line", !!t && t.malformed === 1);
ok("tally attributes the campaign through share_link_copied and calc_empty",
  !!t && t.campaigns.has("g-oct2") && t.campaigns.get("g-oct2").converted === 1 &&
  t.campaigns.get("g-oct2").failed === 1);

/* ---------- the CLI itself completes end-to-end ------------------------------------- */
const run = spawnSync(process.execPath, [TOOL, "--file", file, "--json"], { encoding: "utf8", cwd: ROOT });
ok("CLI exits 0 on a log with share_link_copied and calc_empty", run.status === 0,
  `status ${run.status}${run.stderr ? " :: " + run.stderr.trim() : ""}`);
ok("CLI never prints a TypeError", !/TypeError/.test(run.stdout + run.stderr));
ok("CLI output names share_link_copied", /share_link_copied/.test(run.stdout));
ok("CLI output reports calc_empty under failure signals",
  /Failure signals/.test(run.stdout) && /calc_empty/.test(run.stdout));
ok("CLI names the unknown event", /something_new/.test(run.stdout));

const parsed = firstJson(run.stdout);
ok("CLI emits parsable JSON with the step counts", !!parsed &&
  parsed.steps && parsed.steps.converted === 2, parsed ? JSON.stringify(parsed.steps) : "no JSON");
ok("CLI JSON reports calc_empty as a failure, not a step", !!parsed &&
  parsed.failures && parsed.failures.calc_empty === 1 && parsed.steps.worked === 0);
ok("CLI JSON reports the unknown event", !!parsed && parsed.unknown === 1);

/* ---------- an empty window still exits 0 ------------------------------------------- */
const emptyFile = path.join(dir, "empty.log");
fs.writeFileSync(emptyFile, "", "utf8");
const emptyRun = spawnSync(process.execPath, [TOOL, "--file", emptyFile], { encoding: "utf8", cwd: ROOT });
ok("CLI exits 0 with no events at all", emptyRun.status === 0, `status ${emptyRun.status}`);

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);

// Tests for the anonymous usage counter: js/usage.js (browser send surface) and
// the POST /api/event handler in lambda/index.mjs. Pure Node, no DOM, no browser.
//
//   cd D:/webhvac && node tests/test-usage.mjs
//
// The point of these tests is the CONTRACT: only allowlisted events may be sent,
// only allowlisted coarse property values may travel, no free text or plan data
// can ride along, the UTMs come from the page URL, and the Lambda rejects
// anything oversized or unknown with a bare 204.
import {
  EVENTS, PROP_VALUES, TRACKABLE, parseUtms, buildPayload, track,
  rateLimitExceeded, resetRateLimits,
} from "../js/usage.js";
import {
  EVENT_NAMES, EVENT_MAX_BYTES, eventLogLine, handleEventRequest,
} from "../lambda/index.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};

const ALL_EVENTS = [
  "app_open", "sample_loaded", "plan_parsed", "schedule_imported", "trace_run",
  "rooms_placed", "export_csv", "report_opened", "share_link_copied", "calc_empty",
  "parse_failed", "fill_none", "js_error", "left_page",
];

// a request shaped like a Lambda Function URL (payload format 2.0) event
const postEvent = (rawBody, { base64 = false, path = "/api/event", method = "POST" } = {}) => {
  const body = base64 ? Buffer.from(rawBody, "utf8").toString("base64") : rawBody;
  return {
    version: "2.0",
    rawPath: path,
    requestContext: { http: { method, path, sourceIp: "203.0.113.9" } },
    headers: { "user-agent": "test-agent", referer: "https://example.test/" },
    body,
    isBase64Encoded: base64,
  };
};

/* ---------- the allowlist is the surface -------------------------------- */
ok("js/usage.js exposes the surface for tests (TRACKABLE boolean)", TRACKABLE === true);
ok("js/usage.js exports exactly the fourteen events",
  Array.isArray(EVENTS) && EVENTS.length === 14 && ALL_EVENTS.every((e) => EVENTS.includes(e)),
  EVENTS.join(","));
ok("the Lambda accepts exactly the same fourteen events (single source of truth)",
  EVENT_NAMES instanceof Set && EVENT_NAMES.size === 14 && ALL_EVENTS.every((e) => EVENT_NAMES.has(e)));
ok("lambda rejects an event that js/usage.js does not list",
  !EVENT_NAMES.has("page_scroll") && !EVENTS.includes("page_scroll"));
ok("coarse property vocabulary has no free-text key",
  Object.keys(PROP_VALUES).sort().join(",") === "area,reader,reason,source,stage",
  Object.keys(PROP_VALUES).join(","));

/* ---------- UTM parsing (from a URL string) ----------------------------- */
const utms = parseUtms("https://loadlens.net/app.html?utm_source=google&utm_medium=cpc&utm_campaign=kerala-hvac&utm_content=ad-3#x");
ok("parseUtms reads all four utm_ values from a URL", utms.utm_source === "google" &&
  utms.utm_medium === "cpc" && utms.utm_campaign === "kerala-hvac" && utms.utm_content === "ad-3",
  JSON.stringify(utms));
ok("parseUtms accepts a bare query string too",
  parseUtms("?utm_campaign=test").utm_campaign === "test");
ok("parseUtms drops a free-text / oversized value (would identify a person)",
  Object.keys(parseUtms("?utm_campaign=" + encodeURIComponent("my name is Asha <asha@x.io>"))).length === 0);
ok("parseUtms keeps only the four allowlisted keys",
  Object.keys(parseUtms("?utm_source=g&gclid=abc&fbclid=xyz&foo=bar")).join(",") === "utm_source");
ok("parseUtms returns {} for empty / absent input",
  Object.keys(parseUtms("")).length === 0 && Object.keys(parseUtms(null)).length === 0);

/* ---------- buildPayload: what can actually travel ----------------------- */
const pSample = buildPayload("sample_loaded", { source: "sample" }, utms);
ok("a valid event carries its name, allowlisted prop and the UTMs",
  pSample.e === "sample_loaded" && pSample.p.source === "sample" &&
  pSample.utm_campaign === "kerala-hvac", JSON.stringify(pSample));
ok("an unknown event name builds nothing", buildPayload("scroll", {}, utms) === null);
ok("an unknown property KEY is dropped",
  !("foo" in ((buildPayload("app_open", { foo: "bar" }, utms) || {}).p || {})));
ok("an unknown property VALUE is dropped",
  buildPayload("sample_loaded", { source: "the CEOs villa" }, utms).p === undefined);
ok("a non-string property value is dropped",
  buildPayload("sample_loaded", { source: 7 }, utms).p === undefined);

// plan data / free text must not survive
const leaky = buildPayload("plan_parsed", {
  name: "Confidential Tower", area: 1234.5, rooms: 159, reader: "server",
  address: "MG Road, Kochi", fileName: "hq_plan.pdf",
}, utms);
const leakyJson = JSON.stringify(leaky);
ok("only the allowlisted reader survives a payload full of plan data",
  leaky.p && leaky.p.reader === "server" && Object.keys(leaky.p).length === 1, leakyJson);
ok("no plan field can leak into the sent JSON",
  !/Confidential|MG Road|hq_plan|1234|159/.test(leakyJson), leakyJson);
ok("the sent object has at most name + p + the four UTMs",
  Object.keys(leaky).every((k) => k === "e" || k === "p" || k.startsWith("utm_")),
  Object.keys(leaky).join(","));
ok("building an event needs no DOM (utms injected)", typeof buildPayload("app_open", null, {}) === "object");

/* ---------- track() never throws and sends nothing for junk ------------- */
let threw = false;
try {
  track("scroll");                                  // not an event
  track("export_csv", { name: "secret project" });  // prop not allowed
  track("app_open", "not-an-object");
  track(undefined);
} catch { threw = true; }
ok("track() swallows junk and never throws", !threw);

/* ---------- the new failure / drop-off events --------------------------- */
const NEW_EVENTS = ["parse_failed", "fill_none", "js_error", "left_page"];
ok("js/usage.js exports the new failure / drop-off events",
  NEW_EVENTS.every((e) => EVENTS.includes(e)), EVENTS.join(","));
ok("the Lambda accepts the new events too (client and server cannot drift)",
  NEW_EVENTS.every((e) => EVENT_NAMES.has(e)));

ok("parse_failed carries an allowlisted reason",
  (buildPayload("parse_failed", { reason: "no_text" }, utms).p || {}).reason === "no_text");
ok("parse_failed drops an UNLISTED reason",
  buildPayload("parse_failed", { reason: "the server said: boom" }, utms).p === undefined);
ok("fill_none is accepted with no property",
  buildPayload("fill_none", {}, utms).e === "fill_none");
ok("js_error carries an allowlisted area",
  (buildPayload("js_error", { area: "calc" }, utms).p || {}).area === "calc");
ok("js_error drops an UNLISTED area",
  buildPayload("js_error", { area: "javascript/index.js" }, utms).p === undefined);
ok("left_page carries an allowlisted stage",
  (buildPayload("left_page", { stage: "has_load" }, utms).p || {}).stage === "has_load");
ok("left_page drops an UNLISTED stage",
  buildPayload("left_page", { stage: "50% scrolled" }, utms).p === undefined);

// an error message / stack / URL / line number must be impossible to send
const errPayload = buildPayload("js_error", {
  area: "ui",
  message: "Cannot read properties of undefined (reading 'x')",
  stack: "TypeError: boom\n    at calcRoom (https://loadlens.net/js/calc.js:412:9)",
  filename: "https://loadlens.net/js/calc.js",
  lineno: 412, url: "https://loadlens.net/js/calc.js",
}, utms);
const errJson = JSON.stringify(errPayload);
ok("only the coarse area survives a js_error payload full of error detail",
  errPayload.p && errPayload.p.area === "ui" && Object.keys(errPayload.p).length === 1, errJson);
ok("no message / stack / URL / line number can ride along",
  !/Cannot read|TypeError|calc\.js|412|loadlens\.net|boom/.test(errJson), errJson);

// js_error is capped at 3 per page load (the cap lives in js/usage.js)
resetRateLimits();
ok("js_error is allowed three times", rateLimitExceeded("js_error") === false &&
  rateLimitExceeded("js_error") === false && rateLimitExceeded("js_error") === false);
ok("the fourth js_error is over the cap", rateLimitExceeded("js_error") === true);
ok("the cap applies only to js_error", rateLimitExceeded("parse_failed") === false);
resetRateLimits();
ok("resetRateLimits() clears the cap", rateLimitExceeded("js_error") === false);

/* ---------- the Lambda handler ------------------------------------------ */
const valid = JSON.stringify({ e: "sample_loaded", p: { source: "sample" },
  utm_source: "google", utm_medium: "cpc", utm_campaign: "kerala-hvac", utm_content: "ad-3" });
const line = eventLogLine(JSON.parse(valid));
ok("eventLogLine accepts a valid event and returns one JSON line",
  typeof line === "string" && JSON.parse(line).e === "sample_loaded", line);
ok("the logged line names the source and the campaign",
  JSON.parse(line).evt === "usage" && JSON.parse(line).p.source === "sample" &&
  JSON.parse(line).utm_campaign === "kerala-hvac", line);
ok("eventLogLine rejects an unknown event", eventLogLine({ e: "page_scroll" }) === null);
ok("eventLogLine rejects a missing / non-string event", eventLogLine({}) === null && eventLogLine({ e: 4 }) === null);
ok("eventLogLine rejects non-objects", eventLogLine(null) === null && eventLogLine("x") === null && eventLogLine([]) === null);
ok("eventLogLine drops an unknown property key and a bad value",
  eventLogLine({ e: "app_open", p: { ip: "1.2.3.4", source: "the villas" } }) === null ||
  !/ip|1\.2\.3\.4|villas/.test(eventLogLine({ e: "app_open", p: { ip: "1.2.3.4", source: "the villas" } })));
const scrub = eventLogLine({ e: "plan_parsed", ip: "203.0.113.9", ua: "Mozilla",
  referer: "https://x/", name: "Secret Tower", p: { reader: "server" } });
ok("an IP / user-agent / referer in the body never reaches the log line",
  !/203\.0\.113|Mozilla|referer|Secret/.test(scrub) && JSON.parse(scrub).p.reader === "server", scrub);
ok("a malformed utm token is not forwarded",
  !("utm_campaign" in JSON.parse(eventLogLine({ e: "app_open", utm_campaign: "a b c" }))));
ok("eventLogLine accepts parse_failed with its coarse reason",
  JSON.parse(eventLogLine({ e: "parse_failed", p: { reason: "too_big" } })).p.reason === "too_big");
ok("eventLogLine drops an unlisted reason",
  JSON.parse(eventLogLine({ e: "parse_failed", p: { reason: "disk full" } })).p === undefined);

// handler: status + routing
const rGood = handleEventRequest(postEvent(valid));
ok("a valid POST /api/event answers 204 with an empty body",
  rGood && rGood.statusCode === 204 && rGood.body === "", JSON.stringify(rGood));
const rB64 = handleEventRequest(postEvent(valid, { base64: true }));
ok("a base64-encoded body (Function URL) is decoded and accepted", rB64.statusCode === 204);
ok("an unknown event is rejected with 204 (no detail leaked)",
  handleEventRequest(postEvent(JSON.stringify({ e: "page_scroll" }))).statusCode === 204);
ok("oversized bodies are rejected with 204",
  handleEventRequest(postEvent(JSON.stringify({ e: "app_open", pad: "x".repeat(EVENT_MAX_BYTES + 50) }))).statusCode === 204);
ok("malformed JSON is rejected with 204",
  handleEventRequest(postEvent("{not json")).statusCode === 204);
ok("an empty body is rejected with 204", handleEventRequest(postEvent("")).statusCode === 204);
ok("204 carries no body and no leaky header",
  !("content-type" in rGood.headers) && rGood.body === "");
ok("EVENT_MAX_BYTES is a ~1 KB cap", EVENT_MAX_BYTES === 1024);

// the handler must NOT touch the other endpoints or methods
ok("GET /api/event falls through to the app (null)",
  handleEventRequest(postEvent("", { method: "GET" })) === null);
ok("POST /api/parse falls through to the app (null)",
  handleEventRequest(postEvent("x", { path: "/api/parse" })) === null);
ok("an empty / unknown event object falls through (null)",
  handleEventRequest(null) === null && handleEventRequest({}) === null);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);

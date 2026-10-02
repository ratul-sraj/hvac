// Tests for UTM campaign normalisation — js/usage.js.
//
//   cd D:/webhvac && node tests/test-usage-utm.mjs
//
// The bug these guard against: UTM_RE accepted only [A-Za-z0-9._~-]{1,64}, so a campaign named with
// a space or a '+', or longer than 64 characters, was DROPPED entirely and the event was logged with
// no utm — a real Meta/Google campaign would look like it produced nothing. The fix normalises the
// value into a stable token instead; genuinely unsafe input (an email, markup, a sentence) is still
// refused. These tests pin that contract, including that 'Kerala' and 'kerala' collapse to ONE
// bucket and an over-long name is truncated rather than discarded.
import { UTM_RE, normaliseUtm, parseUtms, buildPayload } from "../js/usage.js";
import { eventLogLine } from "../lambda/index.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};

/* ---------- normalise a real campaign name ----------------------------------------- */
ok("'Kerala HVAC' normalises to a stable token", normaliseUtm("Kerala HVAC") === "kerala-hvac",
  normaliseUtm("Kerala HVAC"));
ok("normalising is stable (same input, same token twice)",
  normaliseUtm("Kerala HVAC") === normaliseUtm("Kerala HVAC"));
ok("a '+' campaign becomes a single '-' separator",
  normaliseUtm("Summer+2024") === "summer-2024", normaliseUtm("Summer+2024"));
ok("runs of separators collapse and are trimmed",
  normaliseUtm("  Kerala   --  HVAC  ") === "kerala-hvac", normaliseUtm("  Kerala   --  HVAC  "));

/* ---------- case folds into ONE bucket --------------------------------------------- */
ok("'Kerala' and 'kerala' map to the same campaign",
  normaliseUtm("Kerala") === "kerala" && normaliseUtm("KERALA") === "kerala" &&
  normaliseUtm(" Kerala ") === "kerala");
ok("case-differing values parse to one campaign in the URL reader",
  parseUtms("?utm_campaign=Kerala").utm_campaign === parseUtms("?utm_campaign=kerala").utm_campaign);

/* ---------- over-long is truncated, not dropped ------------------------------------ */
const long = normaliseUtm("campaign-" + "x".repeat(300));
ok("an over-long name is truncated to 64 chars, not dropped",
  long.length === 64 && UTM_RE.test(long), `${long.length} chars`);
ok("an over-long name in the URL is kept as a truncated token",
  (parseUtms("?utm_campaign=" + "a".repeat(200)).utm_campaign || "").length === 64);

/* ---------- genuinely unsafe input is still refused -------------------------------- */
ok("a pasted email is refused", normaliseUtm("asha@example.com") === "");
ok("a sentence with markup is refused", normaliseUtm("my name is Asha <asha@x.io>") === "");
ok("parseUtms drops a free-text / unsafe campaign entirely",
  Object.keys(parseUtms("?utm_campaign=" + encodeURIComponent("my name is Asha <asha@x.io>"))).length === 0);
ok("a value with a URL fragment char is refused", normaliseUtm("a/b?c#d") === "");
ok("a non-string is refused", normaliseUtm(null) === "" && normaliseUtm(42) === "");
ok("an empty / whitespace-only value is refused", normaliseUtm("   ") === "");

/* ---------- end to end: URL -> payload -> server accepts --------------------------- */
const utms = parseUtms("?utm_source=google&utm_medium=cpc&utm_campaign=Kerala%20HVAC&utm_content=ad%2B3");
ok("parseUtms normalises the campaign from the query string",
  utms.utm_campaign === "kerala-hvac", JSON.stringify(utms));
ok("parseUtms normalises utm_content too ('ad+3' -> 'ad-3')", utms.utm_content === "ad-3",
  String(utms.utm_content));

const payload = buildPayload("app_open", null, utms);
ok("the payload carries the normalised campaign", payload.utm_campaign === "kerala-hvac",
  JSON.stringify(payload));
ok("the normalised token passes the STRICT server allowlist",
  eventLogLine({ e: "app_open", utm_campaign: payload.utm_campaign }) !== null &&
  /"utm_campaign":"kerala-hvac"/.test(eventLogLine({ e: "app_open", utm_campaign: payload.utm_campaign })));

// the server keeps refusing a raw non-token value (defence in depth)
ok("the server still refuses a raw campaign with spaces",
  !("utm_campaign" in JSON.parse(eventLogLine({ e: "app_open", utm_campaign: "a b c" }))));

// the '+' written literally (unencoded) decodes to a space, and '%%2B' decodes to a '+'; both fold
// into the same bucket so a platform that encodes it either way still attributes to one campaign.
ok("a '+' encoded either way folds to one campaign",
  parseUtms("?utm_campaign=Summer+2024").utm_campaign ===
  parseUtms("?utm_campaign=Summer%2B2024").utm_campaign);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);

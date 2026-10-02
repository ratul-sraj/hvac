// The single implementation of POST /api/event — the anonymous usage counter.
//
// It is used by BOTH the local Express server (lib/app.js) and the Lambda
// (lambda/index.mjs). Before this existed the Lambda handled the endpoint on its
// own and the dev server did not know it at all, so every beacon 404'd locally
// and the browser suite failed on console errors that never happen in
// production. One implementation means one behaviour in both places.
//
// The allowlist itself lives in js/usage.js, which the BROWSER also imports, so
// the client and the server can never drift apart on what may be sent.
//
// What this deliberately does NOT do: log an IP address, a user agent, a
// referrer, or anything a caller could use to identify a person or a drawing.
import { EVENTS, PROP_VALUES, UTM_KEYS, UTM_RE } from "../js/usage.js";

export const EVENT_NAMES = new Set(EVENTS);
export const EVENT_MAX_BYTES = 1024; // hard cap on the request body (~1 KB)

/**
 * Turn one submitted usage object into the single JSON line to log, or null when
 * it is not an event we accept. Only an allowlisted event name, allowlisted
 * coarse property values and well-formed utm_* tokens survive — so a caller
 * cannot smuggle free text, plan data or an identifier into the log.
 */
export function eventLogLine(data) {
  if (!data || typeof data !== "object") return null;
  const name = data.e;
  if (typeof name !== "string" || !EVENT_NAMES.has(name)) return null;

  const out = { evt: "usage", e: name };

  const props = data.p;
  if (props && typeof props === "object") {
    const clean = {};
    for (const key of Object.keys(PROP_VALUES)) {
      const value = props[key];
      if (typeof value === "string" && PROP_VALUES[key].includes(value)) clean[key] = value;
    }
    if (Object.keys(clean).length) out.p = clean;
  }

  for (const key of UTM_KEYS) {
    const value = data[key];
    if (typeof value === "string" && UTM_RE.test(value)) out[key] = value;
  }

  return JSON.stringify(out);
}

/**
 * True when a parsed body is small enough to accept. The Lambda caps the raw
 * string; the Express route has already parsed the JSON, so it measures the
 * re-serialised form. Both reject the same oversized payloads.
 */
export function eventBodyTooBig(data) {
  try {
    return JSON.stringify(data || {}).length > EVENT_MAX_BYTES;
  } catch {
    return true;
  }
}

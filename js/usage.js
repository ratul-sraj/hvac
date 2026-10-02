// LoadLens usage counting — anonymous, cookieless, no identifiers.
//
// LoadLens tells every visitor that their drawing is never uploaded. This module
// must not quietly contradict that, so it deliberately sends almost nothing:
//
//   * the name of one of a fixed set of real actions (EVENTS below),
//   * at most a few COARSE properties, each restricted to a fixed vocabulary
//     (PROP_VALUES below) — never free text, never a room name, area, count,
//     project name or anything else derived from the user's plan,
//   * the four utm_* values already present in the page URL (ad campaign tags).
//
// It uses NO cookie, NO localStorage/sessionStorage id, NO fingerprint and no
// cross-site anything. A page that never triggers a tracked action sends
// nothing at all. Every error is swallowed: counting can never break the app.
//
// The same allowlists are imported by the Lambda handler (lambda/index.mjs) so
// the browser and the server agree on exactly what may travel.
//
// ES module, no dependencies, safe to import in Node (browser globals are only
// touched inside functions, and inside try/catch).

/** Tests assert this surface. Kept true when counting is wired up. */
export const TRACKABLE = true;

/** Every event this tool may ever send. Anything else is dropped, not sent. */
export const EVENTS = [
  'app_open',          // the calculator page was loaded
  'sample_loaded',     // the built-in sample drawing was loaded
  'plan_parsed',       // a PDF floor plan parsed successfully
  'schedule_imported', // an Excel/CSV room schedule was imported
  'trace_run',         // "trace real outlines" finished a pass
  'rooms_placed',      // "place all rooms on the plan" placed at least one box
  'export_csv',        // the CSV was downloaded
  'report_opened',     // the printable report was opened
  'share_link_copied', // the link to LoadLens was copied to the clipboard
  'calc_empty',        // a calculation ran but produced zero included rooms
];

/** Coarse property names -> the ONLY values each may carry. Anything else is dropped. */
export const PROP_VALUES = {
  // how data reached the app (a fixed mode the user chose, not plan content)
  source: ['sample', 'upload', 'schedule', 'manual', 'stored'],
  // who read a file
  reader: ['server', 'browser', 'ocr', 'schedule'],
};

/** The only URL parameters this module reads or forwards. */
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];

// Short, plain campaign tokens only: letters, digits and . _ ~ - . This rejects a
// URL, a sentence, an email or anything else that could identify a person.
export const UTM_RE = /^[A-Za-z0-9._~-]{1,64}$/;

const ENDPOINT = '/api/event';
const MAX_BYTES = 900; // far below the Lambda's 1 KB cap

/**
 * Pull utm_source / utm_medium / utm_campaign / utm_content out of a URL or a
 * raw query string. Malformed or oversized values are dropped, never sent.
 * Pure and exported so Node tests can call it directly.
 */
export function parseUtms(input) {
  const out = {};
  if (!input) return out;
  let search = String(input);
  const q = search.indexOf('?');
  if (q >= 0) search = search.slice(q + 1);
  search = search.split('#')[0];
  let params;
  try {
    params = new URLSearchParams(search);
  } catch {
    return out;
  }
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value && UTM_RE.test(value)) out[key] = value;
  }
  return out;
}

/** The UTMs of the current page. Reads location once; never fails. */
export function currentUtms() {
  try {
    return parseUtms(globalThis.location && globalThis.location.href);
  } catch {
    return {};
  }
}

/**
 * Build the exact object that would be sent for one event, or null if the event
 * name is not on the allowlist. Exported so a test can prove what can and cannot
 * travel. `utms` is injectable so the test does not need a DOM.
 */
export function buildPayload(name, props, utms) {
  if (!EVENTS.includes(name)) return null;
  const payload = { e: name };

  const clean = {};
  if (props && typeof props === 'object') {
    for (const key of Object.keys(PROP_VALUES)) {
      const value = props[key];
      if (typeof value === 'string' && PROP_VALUES[key].includes(value)) clean[key] = value;
    }
  }
  if (Object.keys(clean).length) payload.p = clean;

  const u = utms === undefined ? currentUtms() : (utms || {});
  for (const key of UTM_KEYS) {
    const value = u && u[key];
    if (typeof value === 'string' && UTM_RE.test(value)) payload[key] = value;
  }
  return payload;
}

/** Send the payload if the browser can: sendBeacon, else fetch(keepalive). */
function send(data) {
  try {
    const body = JSON.stringify(data);
    if (body.length > MAX_BYTES) return;
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      } catch {
        /* fall through to fetch */
      }
    }
    if (typeof fetch === 'function') {
      fetch(ENDPOINT, {
        method: 'POST',
        body,
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        keepalive: true,
        mode: 'cors',
      }).catch(() => {});
    }
  } catch {
    /* counting must never break the app */
  }
}

/**
 * Count one real user action. The event name and every property value are
 * checked against the allowlists above; anything unknown is dropped. Never
 * throws, never blocks, sends nothing unless a tracked action actually happened.
 */
export function track(name, props) {
  try {
    if (!TRACKABLE) return;
    const payload = buildPayload(name, props);
    if (!payload) return;
    send(payload);
  } catch {
    /* swallowed on purpose */
  }
}

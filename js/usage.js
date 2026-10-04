// LoadLens usage counting — anonymous, cookieless, no identifiers.
//
// LoadLens tells every visitor that their drawing is never sent to a third party. This module
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
  'parse_failed',      // a PDF / scan / schedule upload failed or produced zero rooms
  'fill_none',         // "Fill areas from the drawing" ran and filled 0 areas
  'js_error',          // the page threw an uncaught error (coarse source area only)
  'left_page',         // the page was left — the furthest stage reached is reported
];

/** Coarse property names -> the ONLY values each may carry. Anything else is dropped. */
export const PROP_VALUES = {
  // how data reached the app (a fixed mode the user chose, not plan content)
  source: ['sample', 'upload', 'schedule', 'manual', 'stored'],
  // who read a file
  reader: ['server', 'browser', 'ocr', 'schedule'],
  // why an upload failed — one coarse word, never the error text or the file name
  reason: ['no_text', 'no_rooms', 'server_error', 'timeout', 'bad_file', 'too_big', 'other'],
  // which part of the app threw — a file group only, never a message, stack, URL or line number
  area: ['parse', 'trace', 'calc', 'ui', 'other'],
  // how far a visit got before the page was left (the furthest stage reached)
  stage: ['nothing', 'loaded', 'has_rooms', 'has_load', 'exported'],
};

/** The only URL parameters this module reads or forwards. */
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];

// The strict token shape the SERVER accepts (also used by lib/event.js via the Lambda). The
// browser normalises a campaign name into this shape before it is sent, so a real campaign name
// with spaces, a '+', mixed case or an over-long value still attributes instead of vanishing.
export const UTM_RE = /^[A-Za-z0-9._~-]{1,64}$/;

// Characters that never appear in a campaign token but do appear in pasted free text, an email
// address, markup or a URL fragment. A value carrying one is refused outright rather than
// normalised — that is the "genuinely unsafe input" the reader is promised.
const UTM_UNSAFE_RE = /[<>@"'`\\/{}[\]|^:;,?&#%=!*()$]/;
// Everything else that is not a plain token character is treated as a separator.
const UTM_SEP_RE = /[^A-Za-z0-9._~-]+/g;

/**
 * Turn a raw utm_* value into a stable campaign token, or '' when it should be dropped.
 * Lower-cases and trims so "Kerala" and "kerala" land in ONE bucket; turns runs of spaces, '+'
 * and other separators into a single '-'; truncates to the 64-character limit instead of discarding
 * an over-long campaign name. A value that looks like pasted text (an email, markup, a sentence)
 * is still rejected. Pure and exported so it can be unit-tested.
 */
export function normaliseUtm(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw || raw.length > 512) return '';
  if (UTM_UNSAFE_RE.test(raw)) return '';
  const token = raw.toLowerCase().replace(UTM_SEP_RE, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');
  return UTM_RE.test(token) ? token : '';
}

const ENDPOINT = '/api/event';
const MAX_BYTES = 900; // far below the Lambda's 1 KB cap

// Events that may be sent at most N times per page load. js_error is capped so one broken loop cannot
// flood the counter with the same failure; the cap lives HERE so it is unit-testable and the app only
// has to call track('js_error', …). Every other event is unlimited.
const RATE_LIMIT = { js_error: 3 };
const sentCounts = Object.create(null);

/**
 * True when this call is OVER the cap for a rate-limited event and must be dropped. It is the one
 * place the limit is enforced (track() calls it), so counting it here also makes it testable.
 */
export function rateLimitExceeded(name) {
  const cap = RATE_LIMIT[name];
  if (cap === undefined) return false;
  sentCounts[name] = (sentCounts[name] || 0) + 1;
  return sentCounts[name] > cap;
}

/** Forget the per-page counters (tests only). */
export function resetRateLimits() {
  for (const k of Object.keys(sentCounts)) delete sentCounts[k];
}

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
    const token = normaliseUtm(value);
    if (token) out[key] = token;
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
    const token = normaliseUtm(u && u[key]);
    if (token) payload[key] = token;
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
    if (rateLimitExceeded(name)) return;   // js_error and any future capped event
    const payload = buildPayload(name, props);
    if (!payload) return;
    send(payload);
  } catch {
    /* swallowed on purpose */
  }
}

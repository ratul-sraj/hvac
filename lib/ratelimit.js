// lib/ratelimit.js — a per-IP throttle for the expensive endpoints.
//
// WHY: the MCP endpoint has no auth by design (an agent must be able to call it without a key), and
// /api/parse does real work on an uploaded file. Without a limit, one loop — a misconfigured agent, a
// scraper, a bored stranger — can run the Lambda up and is billed by the millisecond. The Function URL
// is already closed to direct callers (the x-origin-auth gate), so everything that arrives here came
// through the distribution; what is left to bound is HOW OFTEN one caller may ask.
//
// WHAT THIS IS NOT: a global quota. Lambda containers do not share memory, so each warm container
// keeps its own bucket and the true ceiling is (limit x concurrent containers). That is honest and
// still useful — the first line of defence against a runaway loop is the same caller hitting the same
// warm container — and it is paired with a small reserved concurrency on the function, which caps the
// multiplier. An edge rule (AWS WAF rate-based rule) would be exact but costs $5/mo per web ACL plus
// $1/mo per rule, which this project's always-free budget does not carry.
//
// A bucket is a token bucket: `max` tokens, refilled evenly over `windowMs`. Sustained rate is
// max/windowMs; a burst of `max` is allowed, which is what a real user does (open, click, calculate).
import { intFromEnv } from "./config.js";

/** The address that asked, from the most trustworthy header present.
 *  CloudFront sets CloudFront-Viewer-Address (ip:port); X-Forwarded-For is the general fallback and
 *  may hold a chain. Never used for anything but counting — it is not logged and not stored. */
export function clientKey(req) {
  const h = (req && req.headers) || {};
  const viewer = h["cloudfront-viewer-address"];
  if (viewer) {
    const s = String(viewer);
    // "1.2.3.4:5678" or "[::1]:5678" -> the address
    return s.startsWith("[") ? s.slice(1, s.indexOf("]")) : s.replace(/:\d+$/, "");
  }
  const xff = h["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  const sock = req && req.socket && req.socket.remoteAddress;
  return sock || "unknown";
}

/** A token bucket per key. `now` is injectable so the tests can advance the clock instead of sleeping. */
export function createBucket({ max, windowMs, now = Date.now, maxKeys = 20000 }) {
  const refillPerMs = max / windowMs;
  const buckets = new Map();

  function prune() {
    // Bound memory: the map is keyed by address, so a wide scan would otherwise grow it forever.
    // Drop the least-recently-seen half rather than everything (a live caller keeps its history).
    const excess = buckets.size - maxKeys;
    if (excess <= 0) return;
    const sorted = [...buckets.entries()].sort((a, b) => a[1].seen - b[1].seen);
    for (let i = 0; i < excess + Math.floor(maxKeys / 2); i += 1) buckets.delete(sorted[i][0]);
  }

  /** Take one token. Returns { allowed, retryAfterMs, remaining }. */
  function take(key) {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxKeys) prune();
      b = { tokens: max, seen: t };
      buckets.set(key, b);
    }
    // refill, capped at max
    const elapsed = Math.max(0, t - b.seen);
    b.tokens = Math.min(max, b.tokens + elapsed * refillPerMs);
    b.seen = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(b.tokens) };
    }
    const retryAfterMs = Math.ceil((1 - b.tokens) / refillPerMs);
    return { allowed: false, retryAfterMs, remaining: 0 };
  }

  return { take, size: () => buckets.size, clear: () => buckets.clear() };
}

// ---- the limits --------------------------------------------------------------------------------
// Deliberately generous for a human (a person does not post 60 room lists a minute) and mean for the
// expensive upload. Overridable with env vars so a stuck limit never needs a code change.
const DEFAULTS = {
  mcp: { max: intFromEnv("RATE_LIMIT_MAX_MCP", 60), windowMs: 60_000 },
  calc: { max: intFromEnv("RATE_LIMIT_MAX_CALC", 120), windowMs: 60_000 },
  parse: { max: intFromEnv("RATE_LIMIT_MAX_PARSE", 10), windowMs: 60_000 },
};
const DISABLED = process.env.RATE_LIMIT_DISABLED === "1";

/** Express middleware for ONE bucket. `name` only labels the bucket in the 429 body. */
export function limiter(name, opts = {}) {
  const cfgIn = DEFAULTS[name] || { max: 60, windowMs: 60_000 };
  const b = createBucket({ max: opts.max || cfgIn.max, windowMs: opts.windowMs || cfgIn.windowMs, now: opts.now });
  const middleware = (req, res, next) => {
    if (DISABLED) return next();
    const r = b.take(clientKey(req));
    res.set("X-RateLimit-Limit", String(opts.max || cfgIn.max));
    res.set("X-RateLimit-Remaining", String(r.remaining));
    if (r.allowed) return next();
    const secs = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
    res.set("Retry-After", String(secs));
    return res.status(429).json({
      error: `too many requests on ${name}: limit ${opts.max || cfgIn.max} per ${Math.round((opts.windowMs || cfgIn.windowMs) / 1000)} s. Retry in ${secs} s.`,
      retryAfterSeconds: secs,
    });
  };
  middleware.bucket = b;
  middleware.limitName = name;   // NOT .name: a function's name is read-only
  return middleware;
}

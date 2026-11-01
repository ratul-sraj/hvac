// tests/test-ratelimit.mjs — the per-IP throttle on /mcp, /api/calc and /api/parse.
//
// Two halves:
//   1. the bucket itself, with an injected clock (no sleeping in tests)
//   2. the real Express app, listening on an ephemeral port, with the limits lowered by env so the
//      test can trip them in a handful of requests
//
// The point of the second half is the WIRING: a correct bucket mounted on the wrong routes protects
// nothing, and /api/health must never be throttled (the site polls it; a 429 there looks like an outage).
import http from "node:http";

// The limits are read ONCE, when lib/ratelimit.js is first imported, so they must be lowered before
// anything imports it — including the bucket tests below.
process.env.RATE_LIMIT_MAX_MCP = "6";
process.env.RATE_LIMIT_MAX_CALC = "4";
process.env.RATE_LIMIT_MAX_PARSE = "3";
process.env.LOG_REQUESTS = "0";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ---- 1. the bucket ------------------------------------------------------------------------------
const { createBucket, clientKey } = await import("../lib/ratelimit.js");

console.log("ratelimit: the token bucket");
{
  let t = 1_000_000;
  const b = createBucket({ max: 3, windowMs: 60_000, now: () => t });
  eq("burst of 3 is allowed", [b.take("ip"), b.take("ip"), b.take("ip")].filter((r) => r.allowed).length, 3);
  const denied = b.take("ip");
  eq("the 4th is refused", denied.allowed, false);
  ok("the refusal says when to come back", denied.retryAfterMs > 0 && denied.retryAfterMs <= 60_000,
    `${denied.retryAfterMs} ms`);
  // a full window of elapsed time refills every token
  t += 60_000;
  eq("after one window the caller is served again", b.take("ip").allowed, true);
  // drain the refilled burst, then check the sustained rate: 3 tokens per 60 s = one every 20 s
  b.take("ip"); b.take("ip");
  eq("the refilled burst is spent", b.take("ip").allowed, false);
  t += 20_000;
  eq("one token back after a third of the window", b.take("ip").allowed, true);
  eq("and only one", b.take("ip").allowed, false);
}

console.log("\nratelimit: one address cannot spend another's budget");
{
  const b = createBucket({ max: 1, windowMs: 60_000, now: () => 0 });
  eq("first address served", b.take("a").allowed, true);
  eq("its second is refused", b.take("a").allowed, false);
  eq("a different address is untouched", b.take("b").allowed, true);
}

console.log("\nratelimit: memory stays bounded under a wide scan");
{
  const b = createBucket({ max: 5, windowMs: 60_000, now: () => 0, maxKeys: 50 });
  for (let i = 0; i < 400; i += 1) b.take(`10.0.0.${i}`);
  ok("the map is pruned, not grown without limit", b.size() <= 60, `size ${b.size()} for 400 addresses`);
}

console.log("\nratelimit: which address is counted");
{
  eq("CloudFront-Viewer-Address wins, port stripped",
    clientKey({ headers: { "cloudfront-viewer-address": "203.0.113.9:51234" } }), "203.0.113.9");
  eq("an IPv6 viewer address keeps its address, not its port",
    clientKey({ headers: { "cloudfront-viewer-address": "[2001:db8::1]:443" } }), "2001:db8::1");
  eq("X-Forwarded-For chains resolve to the first hop",
    clientKey({ headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1" } }), "198.51.100.7");
  eq("the socket address is the last resort",
    clientKey({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
  eq("no address at all does not crash", clientKey({ headers: {} }), "unknown");
}

// ---- 2. the wiring, through the real app --------------------------------------------------------
const { buildApp } = await import("../lib/app.js");

const server = http.createServer(buildApp());
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = (path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

console.log("\nratelimit: /mcp is throttled");
{
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await post("/mcp", init)).status);
  ok("the first 6 are served", codes.slice(0, 6).every((c) => c === 200), codes.join(","));
  eq("the 7th is refused with 429", codes[6], 429);
  const res = await post("/mcp", init);
  eq("a refused call keeps being refused", res.status, 429);
  ok("it says how long to wait", Number(res.headers.get("retry-after")) > 0, `Retry-After: ${res.headers.get("retry-after")}`);
  const body = await res.json();
  ok("the body is JSON, not an HTML page", /too many requests/i.test(body.error || ""), JSON.stringify(body).slice(0, 90));
  ok("the limit is advertised", res.headers.get("x-ratelimit-limit") === "6", res.headers.get("x-ratelimit-limit"));
}

console.log("\nratelimit: /api/calc is throttled, and a different address is not");
{
  const body = { rooms: [{ name: "Office", area: 50, type: "office" }] };
  const mine = [];
  for (let i = 0; i < 5; i += 1) mine.push((await post("/api/calc", body)).status);
  ok("the first 4 calculate", mine.slice(0, 4).every((c) => c === 200), mine.join(","));
  eq("the 5th is refused", mine[4], 429);
  const other = await post("/api/calc", body, { "x-forwarded-for": "198.51.100.44" });
  eq("another address still calculates", other.status, 200);
}

console.log("\nratelimit: the upload is the meanest bucket");
{
  const codes = [];
  for (let i = 0; i < 4; i += 1) codes.push((await post("/api/parse", {})).status);
  ok("the first 3 get as far as the handler (400, no file)", codes.slice(0, 3).every((c) => c === 400), codes.join(","));
  eq("the 4th is refused", codes[3], 429);
}

console.log("\nratelimit: /api/health is never throttled");
{
  const codes = [];
  for (let i = 0; i < 30; i += 1) codes.push((await fetch(base + "/api/health")).status);
  ok("30 polls in a row, all 200", codes.every((c) => c === 200), `${codes.filter((c) => c === 200).length}/30`);
}

console.log("\nratelimit: the beacon is never throttled either");
{
  const codes = [];
  for (let i = 0; i < 30; i += 1) {
    codes.push((await fetch(base + "/api/event", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status);
  }
  ok("30 beacons in a row, none refused", codes.every((c) => c !== 429), `${codes.filter((c) => c === 429).length} refused`);
}

await new Promise((r) => server.close(r));

console.log(`\nratelimit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("ALL RATE-LIMIT CHECKS PASSED");

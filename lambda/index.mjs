// LoadLens on AWS Lambda (nodejs22.x runtime, ZIP deployment, invoked through a
// Lambda Function URL).
//
// This file does NOT reimplement anything: it mounts the exact same Express app
// the local server uses (lib/app.js, which serves /api/health, /api/parse,
// /api/calc, /api/climates and the static UI) behind `serverless-http`, which
// translates a Function URL (payload format 2.0) event into a Node
// request/response pair and the answer back into a Lambda proxy response.
//
// ONE endpoint is handled HERE instead of in the Express app: POST /api/event,
// the anonymous usage counter (see js/usage.js). It is a single allowlisted log
// line to CloudWatch — no request touches the routing, multer or pdf.js, and no
// log line contains an IP address, a user agent, a referrer or any plan data.
//
// Handler name for the deployment: `lambda/index.handler`.
//
// Sizing notes (see tools/build-lambda.mjs + tests/test-lambda.mjs):
//   * Memory: 512 MB is comfortable / 1024 MB is fast; a 3-page drawing needs
//     well under 300 MB of RSS. Below ~256 MB pdf.js on a big drawing may OOM.
//   * Timeout: give it at least 30 s. The 3-page synthetic tests/samples/sample-plan.pdf
//     parses in ~1-3 s cold (pdf.js + worker bootstrap on first call), then a
//     few hundred ms per warm call.
//   * Function URL payloads are synchronous and capped at 6 MB, while the app's
//     multer limit stays 25 MB per file (lib/config.js) — that is deliberate:
//     the static UI falls back to in-browser parsing for bigger drawings.
import serverless from "serverless-http";
import { buildApp } from "../lib/app.js";
// The usage counter lives in lib/event.js so the LOCAL dev server and this
// Lambda share one implementation (previously only this file had it, and every
// beacon 404'd against the dev server). The allowlist it uses comes from
// js/usage.js, which the browser imports too, so client and server cannot drift.
import { EVENT_NAMES, EVENT_MAX_BYTES, eventLogLine } from "../lib/event.js";

// Re-exported: tests import these from here, and the doc comment above explains
// why they exist (the allowlist is the privacy boundary).
export { EVENT_NAMES, EVENT_MAX_BYTES, eventLogLine };

// Built once per container so the Express router / multer instance survive warm
// invocations (repeat calls reuse the same app).
export const app = buildApp();

const expressHandler = serverless(app, {
  // `requestId` is only used for log correlation inside serverless-http.
  requestId: (event, context) => (context && context.awsRequestId) || "loadlens",
});

// ---------------------------------------------------------------------------
// POST /api/event — the anonymous usage counter
// ---------------------------------------------------------------------------
// EVENT_NAMES / EVENT_MAX_BYTES / eventLogLine are imported from lib/event.js
// and re-exported at the top of this file: one implementation, shared with the
// local dev server, so a beacon behaves identically in both places.

const EVENT_PATH = "/api/event";

/** The bare 204 answer used for every good, malformed or unknown submission:
 *  no body, no headers to distinguish them, nothing for a caller to learn from. */
const NO_CONTENT = { statusCode: 204, headers: {}, body: "" };

/**
 * Handle POST /api/event, or return null to let the Express app handle every
 * other request unchanged. Payload format 2.0 (`requestContext.http`) and 1.0
 * (`httpMethod`) are both understood so the same code works under tests.
 */
export function handleEventRequest(event) {
  if (!event || typeof event !== "object") return null;
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method)
    || event.httpMethod;
  const path = event.rawPath || event.path;
  if (method !== "POST" || path !== EVENT_PATH) return null;

  const res204 = { ...NO_CONTENT };
  let body = event.body;
  if (event.isBase64Encoded && typeof body === "string") {
    try {
      body = Buffer.from(body, "base64").toString("utf8");
    } catch {
      return res204;
    }
  }
  if (typeof body !== "string" || body.length === 0 || body.length > EVENT_MAX_BYTES) return res204;

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return res204;
  }

  const line = eventLogLine(data);
  if (line) {
    // One line, no IP, no user agent, no referrer. CloudWatch adds the timestamp.
    console.log(line);
  }
  return res204;
}

export const handler = async (event, context) => {
  const counted = handleEventRequest(event);
  if (counted) return counted;
  return expressHandler(event, context);
};

export default handler;

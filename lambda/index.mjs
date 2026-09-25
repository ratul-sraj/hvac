// LoadLens on AWS Lambda (nodejs22.x runtime, ZIP deployment, invoked through a
// Lambda Function URL).
//
// This file does NOT reimplement anything: it mounts the exact same Express app
// the local server uses (lib/app.js, which serves /api/health, /api/parse,
// /api/calc, /api/climates and the static UI) behind `serverless-http`, which
// translates a Function URL (payload format 2.0) event into a Node
// request/response pair and the answer back into a Lambda proxy response.
//
// Handler name for the deployment: `lambda/index.handler`.
//
// Sizing notes (see tools/build-lambda.mjs + tests/test-lambda.mjs):
//   * Memory: 512 MB is comfortable / 1024 MB is fast; a 3-page drawing needs
//     well under 300 MB of RSS. Below ~256 MB pdf.js on a big drawing may OOM.
//   * Timeout: give it at least 30 s. The 3-page tests/samples/headquarters.pdf
//     parses in ~1-3 s cold (pdf.js + worker bootstrap on first call), then a
//     few hundred ms per warm call.
//   * Function URL payloads are synchronous and capped at 6 MB, while the app's
//     multer limit stays 25 MB per file (lib/config.js) — that is deliberate:
//     the static UI falls back to in-browser parsing for bigger drawings.
import serverless from "serverless-http";
import { buildApp } from "../lib/app.js";

// Built once per container so the Express router / multer instance survive warm
// invocations (repeat calls reuse the same app).
export const app = buildApp();

export const handler = serverless(app, {
  // `requestId` is only used for log correlation inside serverless-http.
  requestId: (event, context) => (context && context.awsRequestId) || "loadlens",
});

export default handler;

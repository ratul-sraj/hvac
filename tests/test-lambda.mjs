// Lambda test suite for LoadLens: drives lambda/index.mjs's handler DIRECTLY,
// in-process, with synthetic AWS Lambda Function URL (payload format 2.0)
// events. No AWS account, no network, no deployment — this proves the packaged
// handler answers the same API the Express server does.
//   cd D:/webhvac && node tests/test-lambda.mjs     (or: npm run test:lambda)
// Prints PASS/FAIL per check and a final "n/3 lambda checks passed" line,
// matching the style of tests/api-test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SAMPLE = path.join(HERE, "samples", "headquarters.pdf");

let pass = 0;
const failures = [];
let handler = null;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log(`  PASS  ${name}`);
    })
    .catch((err) => {
      failures.push(name);
      console.log(`  FAIL  ${name}`);
      console.log("        " + String((err && err.message) || err).split("\n").join("\n        "));
    });
}

// ---- synthetic Lambda Function URL events --------------------------------
function fnUrlEvent({ method = "GET", urlPath = "/", query = "", headers = {}, body = null, base64 = false } = {}) {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: urlPath,
    rawQueryString: query,
    cookies: [],
    headers: {
      host: "abc123.lambda-url.ap-south-1.on.aws",
      "user-agent": "loadlens-lambda-test",
      ...headers,
    },
    requestContext: {
      accountId: "123456789012",
      apiId: "loadlens",
      authentication: null,
      domainName: "abc123.lambda-url.ap-south-1.on.aws",
      domainPrefix: "abc123",
      http: {
        method,
        path: urlPath,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "loadlens-lambda-test",
      },
      requestId: "00000000-0000-4000-8000-000000000000",
      routeKey: "$default",
      stage: "$default",
      time: "25/Sep/2026:00:00:00 +0000",
      timeEpoch: Date.now(),
    },
    body: body === null ? undefined : base64 ? body.toString("base64") : body.toString("utf8"),
    isBase64Encoded: base64,
  };
}

const fakeContext = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "loadlens",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:ap-south-1:123456789012:function:loadlens",
  memoryLimitInMB: "512",
  awsRequestId: "00000000-0000-4000-8000-000000000000",
  logGroupName: "/aws/lambda/loadlens",
  logStreamName: "2026/09/25/[$LATEST]test",
  getRemainingTimeInMillis: () => 30000,
};

function invoke(event) {
  return handler(event, fakeContext);
}

/** A multipart/form-data body built by hand (the real clients use FormData). */
function multipart(parts) {
  const boundary = "----LoadLensLambda" + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const p of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${p.field}"; filename="${p.filename}"\r\n` +
          `Content-Type: ${p.type}\r\n\r\n`,
        "utf8"
      )
    );
    chunks.push(p.data);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const bodyText = (res) =>
  res.body == null ? "" : res.isBase64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : String(res.body);

function jsonOf(res) {
  const text = bodyText(res);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`response body is not JSON (status ${res.statusCode}): ${text.slice(0, 200)}`);
  }
}

// ---- the suite -----------------------------------------------------------
async function main() {
  process.env.LOG_REQUESTS = "0"; // keep the test output readable (same as api-test.mjs)
  const mod = await import(new URL("../lambda/index.mjs", import.meta.url).href);
  handler = mod.handler;
  assert.equal(typeof handler, "function", "lambda/index.mjs must export a handler function");
  assert.ok(fs.existsSync(SAMPLE), `sample drawing missing: ${SAMPLE}`);
  console.log(`lambda handler loaded in-process (no AWS), sample = tests/samples/headquarters.pdf`);

  // 1. health -------------------------------------------------------------
  await check("Function URL GET /api/health -> 200 + ok:true + app LoadLens", async () => {
    const res = await invoke(fnUrlEvent({ method: "GET", urlPath: "/api/health" }));
    assert.equal(res.statusCode, 200, JSON.stringify(res).slice(0, 300));
    const j = jsonOf(res);
    assert.equal(j.ok, true);
    assert.equal(j.app, "LoadLens", "health reports the product name");
    assert.equal(j.serverSideParse, true);
    assert.ok(typeof j.version === "string" && j.version.length, "version");
    assert.equal(j.maxUploadMb, 25, "the app's 25 MB upload limit is unchanged on Lambda");
    const ctype = res.headers && (res.headers["content-type"] || res.headers["Content-Type"]);
    assert.ok(/application\/json/.test(String(ctype)), `content-type header: ${ctype}`);
  });

  // 2. real PDF through /api/parse ----------------------------------------
  await check("Function URL POST /api/parse headquarters.pdf -> 200, 3 pages, 149 rooms", async () => {
    const pdf = fs.readFileSync(SAMPLE);
    const { body, contentType } = multipart([
      { field: "files", filename: "headquarters.pdf", type: "application/pdf", data: pdf },
    ]);
    const res = await invoke(
      fnUrlEvent({
        method: "POST",
        urlPath: "/api/parse",
        headers: { "content-type": contentType, "content-length": String(body.length) },
        body,
        base64: true, // Function URL events carry binary payloads base64-encoded
      })
    );
    assert.equal(res.statusCode, 200, bodyText(res).slice(0, 300));
    const j = jsonOf(res);
    assert.equal(j.files.length, 1, "one parsed file");
    const f = j.files[0];
    assert.equal(f.name, "headquarters.pdf");
    assert.equal(f.pages, 3, `pages = ${f.pages}`);
    assert.equal(f.rooms.length, 149, `file rooms = ${f.rooms.length}`);
    assert.equal(f.roomCount, 149);
    assert.equal(j.rooms.length, 149, `rooms = ${j.rooms.length}`);
    assert.ok(j.rooms.every((r) => r.id && r.name && r.sourceFile === "headquarters.pdf"), "room shape + sourceFile");
    assert.ok(Number.isFinite(j.ms), "ms");
  });

  // 3. a bad request must be a real API error, not a 500 ------------------
  await check("Function URL POST /api/parse a .txt -> 400 JSON (not 500)", async () => {
    const { body, contentType } = multipart([
      { field: "files", filename: "notes.txt", type: "text/plain", data: Buffer.from("not a pdf at all") },
    ]);
    const res = await invoke(
      fnUrlEvent({
        method: "POST",
        urlPath: "/api/parse",
        headers: { "content-type": contentType, "content-length": String(body.length) },
        body,
        base64: true,
      })
    );
    assert.notEqual(res.statusCode, 500, "rejected uploads must not surface as a Lambda 500");
    assert.equal(res.statusCode, 400, `status ${res.statusCode}: ${bodyText(res).slice(0, 200)}`);
    const j = jsonOf(res);
    assert.ok(typeof j.error === "string" && j.error.length, "an error message");
    assert.ok(/notes\.txt|PDF/.test(j.error), `error explains the rejection: ${j.error}`);
  });

  const total = 3;
  console.log(`\n${pass}/${total} lambda checks passed`);
  if (failures.length) {
    console.log("failed:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  console.log("ALL LAMBDA CHECKS PASSED");
}

main().catch((err) => {
  console.error("lambda-test could not run:", err);
  process.exit(1);
});

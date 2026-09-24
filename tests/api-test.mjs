// API test suite for the LoadLens server (the product was renamed from WebHVAC;
// APP_NAME lives in lib/config.js). Plain node, no test framework.
//   cd D:/webhvac && node tests/api-test.mjs      (or: npm run test:api)
// Starts its own server on a free port with MAX_UPLOAD_MB=1, checks the HTTP
// contract from AGENTS-SERVER.md, prints PASS/FAIL per check and exits 1 on
// the first failing check (the server is always shut down).
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SAMPLE = path.join(HERE, "samples", "headquarters.pdf");
const MAX_UPLOAD_MB = 1; // tiny limit so the 413 check stays fast

let pass = 0;
const failures = [];
let child = null;
let base = "";

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

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(url + "/api/health");
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(150);
  }
  throw new Error(`server did not answer /api/health in time (${lastErr || "timeout"})`);
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const done = () => resolve();
    child.once("exit", done);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 4000).unref?.();
  });
}

const pdfEntry = (file, name = path.basename(file)) => [
  name,
  fs.readFileSync(file),
  "application/pdf",
];

async function postFiles(entries, fieldName = "files") {
  const fd = new FormData();
  for (const [filename, data, type] of entries) {
    fd.append(fieldName, new Blob([data], { type }), filename);
  }
  const res = await fetch(base + "/api/parse", { method: "POST", body: fd });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body is fine for the failure checks */
  }
  return { res, json };
}

async function main() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MAX_UPLOAD_MB: String(MAX_UPLOAD_MB),
      LOG_REQUESTS: "0", // keep the test output readable
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  child.stdout.on("data", (d) => serverLog.push(String(d)));
  child.stderr.on("data", (d) => serverLog.push(String(d)));

  try {
    await waitForServer(base);
    console.log(`server up on ${base} (MAX_UPLOAD_MB=${MAX_UPLOAD_MB})`);

    // 1. health ---------------------------------------------------------
    await check("GET /api/health -> ok, server-side parse advertised", async () => {
      const res = await fetch(base + "/api/health");
      assert.equal(res.status, 200);
      const j = await res.json();
      assert.equal(j.ok, true);
      assert.equal(j.app, "LoadLens", "the health endpoint reports the product name");
      assert.equal(j.serverSideParse, true);
      assert.equal(j.maxUploadMb, MAX_UPLOAD_MB);
      assert.ok(typeof j.version === "string" && j.version.length, "version");
      assert.ok(j.node.startsWith("v"), "node version");
      assert.ok(Number.isFinite(j.uptimeSec), "uptimeSec");
    });

    // 2. real PDF -------------------------------------------------------
    await check("POST /api/parse headquarters.pdf -> 3 pages, 149 rooms", async () => {
      const { res, json } = await postFiles([pdfEntry(SAMPLE)]);
      assert.equal(res.status, 200, JSON.stringify(json));
      assert.equal(json.files.length, 1);
      const f = json.files[0];
      assert.equal(f.name, "headquarters.pdf");
      assert.equal(f.pages, 3, `pages = ${f.pages}`);
      assert.equal(f.rooms.length, 149, `file rooms = ${f.rooms.length}`);
      assert.equal(f.roomCount, 149);
      assert.equal(f.levelCount, 3, `levelCount = ${f.levelCount}`);
      assert.equal(json.rooms.length, 149, `rooms = ${json.rooms.length}`);
      assert.ok(Array.isArray(json.warnings), "warnings array");
      assert.ok(Number.isFinite(json.ms), "ms");
      // every room carries the file it came from
      assert.ok(
        json.rooms.every((r) => r.sourceFile === "headquarters.pdf"),
        "every room has sourceFile"
      );
      assert.ok(json.rooms.every((r) => r.id && r.sourceFile && r.name), "room shape");
      const levels = new Set(json.rooms.map((r) => r.level));
      assert.equal(levels.size, 3, "3 levels in the merged list");
    });

    // 3. more than one file (same field name) ---------------------------
    await check("POST /api/parse two PDFs -> rooms merged from both", async () => {
      const { res, json } = await postFiles([
        pdfEntry(SAMPLE),
        pdfEntry(SAMPLE, "copy.pdf"),
      ]);
      assert.equal(res.status, 200, JSON.stringify(json));
      assert.equal(json.files.length, 2);
      assert.equal(json.rooms.length, 298, `rooms = ${json.rooms.length}`);
    });

    // 4. single field named "file" --------------------------------------
    await check('POST /api/parse single field named "file" -> accepted', async () => {
      const { res, json } = await postFiles([pdfEntry(SAMPLE)], "file");
      assert.equal(res.status, 200, JSON.stringify(json));
      assert.equal(json.files.length, 1);
      assert.equal(json.rooms.length, 149);
    });

    // 5. wrong type -----------------------------------------------------
    await check("POST /api/parse a .txt file -> 400 JSON", async () => {
      const { res, json } = await postFiles([
        ["notes.txt", Buffer.from("not a pdf at all"), "text/plain"],
      ]);
      assert.equal(res.status, 400, `status ${res.status}`);
      assert.ok(json && typeof json.error === "string" && json.error.length, "error message");
    });

    // 6. no magic bytes -------------------------------------------------
    await check("POST /api/parse a .pdf without %PDF magic -> 400 JSON", async () => {
      const { res, json } = await postFiles([
        ["fake.pdf", Buffer.from("this is named .pdf but has no magic bytes"), "application/pdf"],
      ]);
      assert.equal(res.status, 400, `status ${res.status}`);
      assert.ok(json && /fake\.pdf/.test(json.error), `error names the file: ${json && json.error}`);
    });

    // 7. empty request --------------------------------------------------
    await check("POST /api/parse with no file -> 400 JSON", async () => {
      const res = await fetch(base + "/api/parse", { method: "POST", body: new FormData() });
      assert.equal(res.status, 400);
      const j = await res.json();
      assert.ok(/no file/i.test(j.error), j.error);
    });

    // 8. oversize -------------------------------------------------------
    await check("POST /api/parse a file over MAX_UPLOAD_MB -> 413 JSON", async () => {
      const big = Buffer.alloc(Math.floor(MAX_UPLOAD_MB * 1024 * 1024) + 200 * 1024, 0x20);
      big.write("%PDF-1.7\n", 0, "latin1");
      let res;
      let json;
      try {
        ({ res, json } = await postFiles([["big.pdf", big, "application/pdf"]]));
      } catch (e) {
        // the server may reset the socket in mid-upload; that is also a rejection
        assert.ok(/fetch failed|ECONNRESET|socket/i.test(String(e.message)), String(e.message));
        return;
      }
      assert.equal(res.status, 413, `status ${res.status}`);
      assert.ok(json && /too large/i.test(json.error), JSON.stringify(json));
    });

    // 9. calc -----------------------------------------------------------
    await check("POST /api/calc with 2 rooms -> totals.tr > 0", async () => {
      const rooms = [
        { id: "r1", name: "Office A", level: "Ground", area: 25, height: 3, type: "office", orient: "W", include: true },
        { id: "r2", name: "Office B", level: "Ground", area: 25, height: 3, type: "office", orient: "S", include: true },
      ];
      const res = await fetch(base + "/api/calc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rooms }),
      });
      assert.equal(res.status, 200);
      const j = await res.json();
      assert.ok(Array.isArray(j.results) && j.results.length === 2, "results per room");
      assert.ok(j.totals && j.totals.tr > 0, `totals.tr = ${j.totals && j.totals.tr}`);
      assert.ok(j.totals.totalW > 0, "totals.totalW");
      assert.ok(j.totals.area > 0, "totals.area");
    });

    await check("POST /api/calc without rooms -> 400 JSON", async () => {
      const res = await fetch(base + "/api/calc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: {} }),
      });
      assert.equal(res.status, 400);
      const j = await res.json();
      assert.ok(/rooms/.test(j.error), j.error);
    });

    // 10. climates ------------------------------------------------------
    await check("GET /api/climates -> countries + cities from calc.js", async () => {
      const res = await fetch(base + "/api/climates");
      assert.equal(res.status, 200);
      const j = await res.json();
      assert.ok(j.countries && typeof j.countries === "object", "countries");
      assert.ok(j.cities && typeof j.cities === "object", "cities");
      assert.ok(Object.keys(j.cities).length > 5, "a few cities");
    });

    // 11. unknown api ---------------------------------------------------
    await check("GET /api/nope -> 404 JSON", async () => {
      const res = await fetch(base + "/api/nope");
      assert.equal(res.status, 404);
      const j = await res.json();
      assert.equal(j.error, "unknown endpoint");
    });

    // 12. UI is served --------------------------------------------------
    await check("GET / -> the LoadLens HTML", async () => {
      const res = await fetch(base + "/");
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(/LoadLens/.test(html), "page mentions LoadLens");
      assert.ok(/<html/i.test(html), "looks like HTML");
    });

    for (const asset of ["/js/calc.js", "/css/style.css", "/vendor/pdf.min.mjs", "/selftest.html", "/favicon.svg"]) {
      await check(`GET ${asset} -> 200`, async () => {
        const res = await fetch(base + asset);
        assert.equal(res.status, 200, `status ${res.status}`);
        const body = await res.arrayBuffer();
        assert.ok(body.byteLength > 0, "non-empty body");
      });
    }

    await check("GET /samples/headquarters.pdf -> the sample drawing (for the sample button)", async () => {
      const res = await fetch(base + "/samples/headquarters.pdf");
      assert.equal(res.status, 200);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.ok(buf.subarray(0, 5).toString("latin1").startsWith("%PDF"), "it is the PDF");
      assert.equal(buf.length, fs.statSync(SAMPLE).size, "same size as tests/samples file");
    });

    // 13. test sources stay private -------------------------------------
    for (const hidden of ["/tests/run.mjs", "/tests/test-headquarters.mjs", "/node_modules/express/package.json", "/.git/config", "/package-lock.json", "/AGENTS-SERVER.md"]) {
      await check(`GET ${hidden} -> 403/404 (never served)`, async () => {
        const res = await fetch(base + hidden);
        assert.ok(
          res.status === 403 || res.status === 404,
          `expected 403/404, got ${res.status}`
        );
      });
    }
  } finally {
    await stopServer();
  }

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} API checks passed`);
  if (failures.length) {
    console.log("failed:");
    for (const f of failures) console.log("  - " + f);
    if (serverLog.length) {
      console.log("\n--- server output ---");
      console.log(serverLog.join("").trim());
    }
    process.exit(1);
  }
  console.log("ALL API TESTS PASSED");
}

main().catch(async (err) => {
  console.error("api-test could not run:", err);
  await stopServer();
  process.exit(1);
});

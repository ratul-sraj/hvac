// MCP test suite for LoadLens: drives the real Express app (lib/app.js) mounted
// on an ephemeral port and exercises POST /mcp end to end over HTTP.
//   cd D:/webhvac && node tests/test-mcp.mjs     (also registered in tests/run.mjs)
// Plain node, no framework. Prints PASS/FAIL per check and exits non-zero on any
// failure, matching the style of tests/test-lambda.mjs.
//
// What it pins (the MCP contract the site now serves to agents):
//   * initialize shape: protocolVersion (echoed when supported), capabilities.tools,
//     serverInfo { name: "loadlens", version }
//   * notifications/initialized -> 202, empty body
//   * tools/list contains the three tools, each with a valid JSON Schema inputSchema
//   * tools/call happy path — and the total matches POST /api/calc exactly (one code path)
//   * unknown method -> -32601; invalid params -> -32602
//   * a 2001-room call -> isError:true inside the result (never a crash, never a protocol error)
//   * GET /mcp -> 405 with an Allow header
//   * /mcp never answers with text/event-stream
import assert from "node:assert/strict";
import net from "node:net";
import { buildApp } from "../lib/app.js";

let pass = 0;
const failures = [];

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

const TOOL_NAMES = ["calculate_cooling_load", "list_indian_cities", "explain_calculation"];

async function main() {
  process.env.LOG_REQUESTS = "0"; // keep the output readable
  const app = buildApp();
  const port = await freePort();
  const server = app.listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${port}`;

  // POST a JSON-RPC message to /mcp and capture status, content-type and body.
  async function rpc(body, headers = {}) {
    const res = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const ct = res.headers.get("content-type") || "";
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* leave json null; a caller asserting on it will fail with a clear message */
    }
    return { res, ct, text, json };
  }

  const call = (id, method, params) =>
    rpc({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });

  console.log(`MCP suite: app on ${base}/mcp`);

  // 1. initialize ---------------------------------------------------------
  await check("initialize -> protocolVersion + capabilities.tools + serverInfo loadlens", async () => {
    const { res, ct, json } = await call(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(res.status, 200, `status ${res.status}`);
    assert.ok(/application\/json/.test(ct), `content-type: ${ct}`);
    assert.ok(!/event-stream/.test(ct), `must not be an event stream: ${ct}`);
    assert.equal(json.jsonrpc, "2.0");
    assert.equal(json.id, 1, "the id is echoed");
    assert.equal(json.result.protocolVersion, "2025-06-18", "a supported version is echoed back");
    assert.deepEqual(json.result.capabilities.tools, {}, "capabilities.tools = {}");
    assert.equal(json.result.serverInfo.name, "loadlens");
    assert.ok(typeof json.result.serverInfo.version === "string" && json.result.serverInfo.version.length);
  });

  await check("initialize with an unsupported version -> falls back to 2025-06-18", async () => {
    const { json } = await call(2, "initialize", { protocolVersion: "1999-01-01" });
    assert.equal(json.result.protocolVersion, "2025-06-18");
  });

  // 2. notifications/initialized -----------------------------------------
  await check("notifications/initialized -> 202 with an empty body", async () => {
    const { res, text } = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res.status, 202, `status ${res.status}`);
    assert.equal(text, "", `body must be empty, got: ${JSON.stringify(text)}`);
  });

  // 3. tools/list ---------------------------------------------------------
  await check("tools/list -> the three tools, each with a valid JSON Schema inputSchema", async () => {
    const { res, ct, json } = await call(3, "tools/list", {});
    assert.equal(res.status, 200);
    assert.ok(!/event-stream/.test(ct), `must not be an event stream: ${ct}`);
    const tools = json.result.tools;
    assert.ok(Array.isArray(tools), "tools is an array");
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...TOOL_NAMES].sort(), `tool names: ${names.join(", ")}`);
    for (const t of tools) {
      assert.ok(typeof t.description === "string" && t.description.length > 20, `${t.name}: description`);
      assert.equal(t.inputSchema.type, "object", `${t.name}: inputSchema.type`);
      assert.ok(t.inputSchema.properties && typeof t.inputSchema.properties === "object", `${t.name}: properties`);
    }
    const calc = tools.find((t) => t.name === "calculate_cooling_load");
    assert.equal(calc.inputSchema.properties.rooms.type, "array", "calculate_cooling_load.rooms is an array");
    assert.equal(calc.inputSchema.properties.rooms.maxItems, 2000, "the 2000-room cap is declared");
    assert.deepEqual(calc.inputSchema.required, ["rooms"], "rooms is required");
  });

  // 4. tools/call happy path (+ same answer as /api/calc) ------------------
  const ROOMS = [
    { name: "Office", area: 50, type: "office" },
    { name: "Conference", area: 30, type: "conference" },
  ];
  let mcpTr = null;
  await check("tools/call calculate_cooling_load -> summary + JSON, isError false", async () => {
    const { res, ct, json } = await call(4, "tools/call", {
      name: "calculate_cooling_load",
      arguments: { rooms: ROOMS },
    });
    assert.equal(res.status, 200);
    assert.ok(!/event-stream/.test(ct), `must not be an event stream: ${ct}`);
    assert.equal(json.error, undefined, `no protocol error: ${JSON.stringify(json.error)}`);
    const r = json.result;
    assert.equal(r.isError, false);
    assert.ok(Array.isArray(r.content) && r.content.length >= 1, "content blocks");
    assert.equal(r.content[0].type, "text");
    const text = r.content[0].text;
    assert.ok(/^Total \d+\.\d{2} TR for 2 rooms \(cooling load\)/.test(text), `summary line: ${text.split("\n")[0]}`);
    const parsed = JSON.parse(text.slice(text.indexOf("\n\n") + 2));
    assert.equal(parsed.totals.rooms, 2);
    assert.ok(parsed.totals.tr > 0);
    mcpTr = parsed.totals.tr;
  });

  await check("the MCP total equals POST /api/calc for the same body (one code path)", async () => {
    const res = await fetch(base + "/api/calc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rooms: ROOMS }),
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.totals.tr, mcpTr, `MCP ${mcpTr} vs /api/calc ${j.totals.tr}`);
  });

  await check("tools/call list_indian_cities -> design conditions as text/JSON", async () => {
    const { json } = await call(5, "tools/call", { name: "list_indian_cities", arguments: {} });
    assert.equal(json.result.isError, false);
    const text = json.result.content[0].text;
    const parsed = JSON.parse(text.slice(text.indexOf("\n\n") + 2));
    assert.ok(parsed.countries && parsed.countries.India && parsed.countries.India.Kochi, "countries -> India -> Kochi");
    assert.equal(parsed.countries.India.Kochi.db, 35, "Kochi design DB");
  });

  await check("tools/call explain_calculation -> a factual method text block", async () => {
    const { json } = await call(6, "tools/call", { name: "explain_calculation", arguments: {} });
    assert.equal(json.result.isError, false);
    const text = json.result.content[0].text;
    assert.ok(/TR = 3517 W/.test(text), "states the TR conversion actually used");
    assert.ok(/ASHRAE/.test(text), "names the method's lineage");
    assert.ok(/method\.html/.test(text), "points at the documented method");
  });

  // 5. errors -------------------------------------------------------------
  await check("unknown method -> JSON-RPC error -32601", async () => {
    const { res, json } = await call(7, "does/not/exist", {});
    assert.equal(res.status, 200, "a JSON-RPC error still rides a 200");
    assert.ok(json.error, "an error object");
    assert.equal(json.error.code, -32601, `code ${json.error && json.error.code}`);
    assert.equal(json.id, 7, "the id is echoed");
  });

  await check("tools/call with invalid params -> -32602", async () => {
    const { json } = await call(8, "tools/call", { arguments: {} }); // no name
    assert.equal(json.error && json.error.code, -32602, `code ${json.error && json.error.code}`);
  });

  await check("tools/call an unknown tool -> -32602", async () => {
    const { json } = await call(9, "tools/call", { name: "nope", arguments: {} });
    assert.equal(json.error && json.error.code, -32602);
  });

  // 6. the room cap is a tool error, not a crash --------------------------
  await check("tools/call with 2001 rooms -> result.isError true (not a protocol error)", async () => {
    const rooms = Array.from({ length: 2001 }, (_, i) => ({ name: `R${i}`, area: 10, type: "office" }));
    const { res, json } = await call(10, "tools/call", { name: "calculate_cooling_load", arguments: { rooms } });
    assert.equal(res.status, 200, "the request itself succeeds");
    assert.equal(json.error, undefined, `must not be a protocol error: ${JSON.stringify(json.error)}`);
    assert.equal(json.result.isError, true, "isError flags the tool failure");
    assert.equal(json.result.content[0].type, "text");
    assert.ok(/too many rooms/i.test(json.result.content[0].text), `message: ${json.result.content[0].text}`);
  });

  // 7. ping ---------------------------------------------------------------
  await check("ping -> an empty result", async () => {
    const { json } = await call(11, "ping", {});
    assert.deepEqual(json.result, {});
  });

  // 8. GET /mcp -> 405 with Allow ----------------------------------------
  await check("GET /mcp -> 405 with an Allow header", async () => {
    const res = await fetch(base + "/mcp", { method: "GET" });
    assert.equal(res.status, 405, `status ${res.status}`);
    assert.equal(res.headers.get("allow"), "POST", `allow: ${res.headers.get("allow")}`);
    assert.ok(!/event-stream/.test(res.headers.get("content-type") || ""), "not an event stream");
  });

  // 9. CORS for the MCP POST ---------------------------------------------
  await check("POST /mcp carries CORS allowing POST + Content-Type from any origin", async () => {
    const res = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.ok(/POST/.test(res.headers.get("access-control-allow-methods") || ""), "methods include POST");
    assert.ok(/content-type/i.test(res.headers.get("access-control-allow-headers") || ""), "headers include Content-Type");
  });

  // 10. every /mcp response is JSON, never an event stream ----------------
  await check("/mcp never answers text/event-stream (initialize, tools/list, tools/call)", async () => {
    const bodies = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "explain_calculation", arguments: {} } },
    ];
    for (const b of bodies) {
      const res = await fetch(base + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(b),
      });
      const ct = res.headers.get("content-type") || "";
      assert.ok(/application\/json/.test(ct), `${b.method}: content-type ${ct}`);
      assert.ok(!/event-stream/.test(ct), `${b.method}: must not be an event stream`);
    }
  });

  server.close();
  const total = pass + failures.length;
  console.log(`\nmcp: ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("failed:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  console.log("ALL MCP CHECKS PASSED");
}

main().catch((err) => {
  console.error("mcp-test could not run:", err);
  process.exit(1);
});

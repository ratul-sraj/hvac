// The Express app: static UI + JSON API + server-side PDF parsing.
// Built here (not in server.js) so tests can mount it on an ephemeral port.
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config, APP_NAME, APP_VERSION } from "./config.js";
import { parseUpload, isPdfUpload } from "./parse.js";
import { eventLogLine, eventBodyTooBig, EVENT_MAX_BYTES } from "./event.js";
import { limiter } from "./ratelimit.js";
import { calcProject, DEFAULT_PROJECT, COUNTRIES, CLIMATES, SPACE_TYPES, guessSpaceType } from "../js/calc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Only these files/folders are reachable over HTTP. `tests/` (except its
// samples subfolder, mounted read-only at /samples) and `node_modules/` are
// deliberately NOT exposed.
const UI_ROOT_FILES = ["index.html", "selftest.html", "favicon.svg"];
// Any other public page/file dropped in the repo root is served too (so new pages do
// not need a code change), while dotfiles, tests/ and node_modules/ stay private.
const ROOT_FILE_EXTS = [".html", ".svg", ".ico", ".txt", ".xml", ".webmanifest"];
function uiRootFiles() {
  const fixed = UI_ROOT_FILES.filter((f) => fs.existsSync(path.join(ROOT, f)));
  let extra = [];
  try {
    extra = fs
      .readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith(".") && ROOT_FILE_EXTS.includes(path.extname(d.name).toLowerCase()))
      .map((d) => d.name);
  } catch { /* unreadable root is handled by the 404 fallback */ }
  return [...new Set([...fixed, ...extra])];
}
const UI_DIRS = ["css", "js", "vendor", "img"];
const SAMPLE_DIRS = ["samples", path.join("tests", "samples")];

// Upper bound on one /api/calc call (audit M4). A real building is a few hundred rooms; anything past
// this is a request built to consume the whole invocation budget, and it is refused with 413.
const MAX_ROOMS_PER_CALC = 2000;

const existing = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// The calculation itself, shared by POST /api/calc and the MCP tool
// `calculate_cooling_load`, so the two code paths can never drift: one helper,
// one answer. Returns { result } on success or { error: { status, message } }.
function computeCalc(body) {
  const rooms = body && body.rooms;
  if (!Array.isArray(rooms)) return { error: { status: 400, message: "rooms must be an array" } };
  if (rooms.length > MAX_ROOMS_PER_CALC) {
    return {
      error: {
        status: 413,
        message: `too many rooms: ${rooms.length} (limit ${MAX_ROOMS_PER_CALC}). Split the building across requests.`,
      },
    };
  }
  const project = { ...DEFAULT_PROJECT, ...((body && body.project) || {}) };
  return { result: calcProject(rooms, project) };
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) — LoadLens as a remote server at POST /mcp
// ---------------------------------------------------------------------------
// Streamable HTTP transport, JSON-RPC 2.0, a single JSON response per request
// (never text/event-stream). Agents (Claude, Cursor, ChatGPT connectors) point
// at POST /mcp and call the same calculator the site uses.
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_SUPPORTED_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];

// The documented method, in the tool's own words (from method.html / llms.txt).
// Kept as a constant so the tool never invents a standard: it describes the basis
// LoadLens actually uses.
const MCP_METHOD_TEXT = [
  "LoadLens method — a simplified ASHRAE / Carrier E-20 style block cooling-load estimate, in SI units.",
  "",
  "Basis: steady-state sol-air conduction through walls and roof (equivalent temperature difference, ETD),",
  "peak solar gain through glass at the design hour, people / lighting / equipment gains, infiltration, and",
  "outdoor-air load, then a safety factor, summed to tons of refrigeration (TR). It is a first-estimate /",
  "design-stage check — NOT a full radiant time series (RTS) model — and must be checked and approved by a",
  "qualified HVAC engineer before equipment selection.",
  "",
  "Design conditions (defaults; override via the `project` object): outdoor dry bulb 35 °C / wet bulb 28 °C",
  "(Kochi), indoor 24 °C / 50 % RH. Wall U 2.0 W/m²K, glass U 5.8 W/m²K, shading coefficient 0.6, roof U",
  "2.0 W/m²K, partition U 2.2 W/m²K, infiltration 0.5 ACH, safety 10 %, supply ΔT 11 K, glazing 30 % of the",
  "exposed wall.",
  "",
  "Constants actually used: 1 TR = 3517 W (metric tonne, 3.517 kW — not the 12,000 Btu/h ton); sensible",
  "1.23 × L/s × ΔT; latent 3010 × L/s × ΔW; 1 m² = 10.7639 ft². Peak solar gain (W/m²): N110 NE300 E440",
  "SE300 S130 SW350 W470 NW300. Wall ETD (K): N7 NE10 E12 SE11 S9 SW13 W15 NW12. Outdoor air per",
  "ASHRAE 62.1 (per person + per m²).",
  "",
  "The shipped defaults are general Indian practice, not a statement about any particular building: ECBC 2017",
  "(warm-humid zone) asks for wall U ≤ 0.40 and roof U ≤ 0.33 W/m²K, so override them when it matters.",
  "Not modelled: thermal mass / the real peak hour, duct and fan heat, diversity, detailed infiltration, altitude.",
  "Reference: https://loadlens.net/method.html  ·  machine-readable spec: https://loadlens.net/openapi.json",
].join("\n");

const MCP_TOOLS = [
  {
    name: "calculate_cooling_load",
    description:
      "Compute the design cooling load (in tons of refrigeration, TR) for one or more rooms, using " +
      "LoadLens' simplified ASHRAE / Carrier E-20 block method. Give room floor areas (m²) and space " +
      "types; get back a per-room and total load in W, TR and L/s. This is a first-estimate / design-stage " +
      "check, not a stamped HAP or Trace calculation.",
    inputSchema: {
      type: "object",
      properties: {
        rooms: {
          type: "array",
          minItems: 1,
          maxItems: 2000,
          description:
            "Rooms to calculate (1–2000). Each room: {name, area (m², the key input), type, height, people, " +
            "light, equip, orient, glass, extWall, roof, include}. Absent fields are filled from the space-type " +
            "defaults and echoed back in results[].room.",
          items: { type: "object" },
        },
        project: {
          type: "object",
          description:
            "Optional design basis overriding the defaults: {country, city, outDb, outWb, inDb, inRh, uWall, " +
            "uGlass, sc, uRoof, roofEtd, uPart, infilAch, safety, supplyDt, wwr, units}.",
        },
      },
      required: ["rooms"],
      additionalProperties: false,
    },
  },
  {
    name: "list_indian_cities",
    description:
      "List the outdoor design conditions (dry bulb / wet bulb, °C) LoadLens ships, as countries → cities " +
      "and a flat city lookup. Use it to pick honest outdoor design temperatures for `project.outDb` / " +
      "`project.outWb` instead of assuming them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "explain_calculation",
    description:
      "Explain the method and design basis LoadLens uses (sol-air conduction, solar gain, people/lighting/" +
      "equipment, infiltration, outdoor air, safety factor, TR conversion, and the defaults). Optionally pass " +
      "a room to also get the space-type defaults that would apply to it.",
    inputSchema: {
      type: "object",
      properties: {
        room: {
          type: "object",
          description: "Optional room ({name, type}) to report the space-type defaults for.",
        },
      },
      additionalProperties: false,
    },
  },
];

const mcpToolText = (text, isError = false) => ({
  content: [{ type: "text", text: String(text) }],
  isError: !!isError,
});
const mcpToolError = (text) => mcpToolText(text, true);

// Run one MCP tool. Returns a tool result object ({ content, isError }); a
// tool-level failure is isError:true inside the result, never a protocol error.
function runMcpTool(name, args) {
  if (name === "calculate_cooling_load") {
    const rooms = args && args.rooms;
    if (!Array.isArray(rooms)) {
      return mcpToolError('"rooms" is required and must be an array of room objects.');
    }
    if (rooms.length < 1) return mcpToolError("rooms is empty: give at least one room.");
    if (rooms.length > MAX_ROOMS_PER_CALC) {
      return mcpToolError(
        `too many rooms: ${rooms.length} (limit ${MAX_ROOMS_PER_CALC}). Split the building across requests.`
      );
    }
    const out = computeCalc({ rooms, project: args.project });
    if (out.error) return mcpToolError(out.error.message);
    const t = out.result.totals;
    const summary = `Total ${t.tr.toFixed(2)} TR for ${t.rooms} rooms (cooling load)`;
    return mcpToolText(`${summary}\n\n${JSON.stringify(out.result, null, 2)}`);
  }

  if (name === "list_indian_cities") {
    const header =
      `LoadLens design conditions: ${Object.keys(COUNTRIES).length} countries, ` +
      `${Object.keys(CLIMATES).length} cities (dry bulb / wet bulb, °C).`;
    return mcpToolText(`${header}\n\n${JSON.stringify({ countries: COUNTRIES, cities: CLIMATES }, null, 2)}`);
  }

  if (name === "explain_calculation") {
    let text = MCP_METHOD_TEXT;
    const room = args && args.room;
    if (room && typeof room === "object") {
      const type = room.type ? String(room.type) : guessSpaceType(room.name || "");
      const st = SPACE_TYPES[type] || SPACE_TYPES.general;
      text +=
        `\n\nFor this room (type "${type}"): ${st.label} — ${st.m2pp} m²/person, lighting ${st.light} W/m², ` +
        `equipment ${st.equip} W/m², people ${st.ps} W sensible / ${st.pl} W latent, outdoor air ${st.oap} L/s ` +
        `per person + ${st.oaa} L/s per m².`;
    }
    return mcpToolText(text);
  }

  return null; // unknown tool — handled as -32602 by the caller
}

const mcpRpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const mcpRpcError = (id, code, message) => ({
  jsonrpc: "2.0",
  id: id === undefined ? null : id,
  error: { code, message },
});

// Handle one JSON-RPC 2.0 message for POST /mcp. Writes exactly one JSON
// response (or an empty 202 for a notification) and never an event stream.
function handleMcp(req, res) {
  const msg = req.body;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return res.status(400).json(mcpRpcError(null, -32600, "invalid request: expected a JSON-RPC 2.0 object"));
  }
  const hasId = msg.id !== undefined && msg.id !== null;
  const method = typeof msg.method === "string" ? msg.method : "";

  // Notifications carry no id and get an empty 202 (the initialized handshake).
  if (method.startsWith("notifications/")) return res.status(202).end();
  if (!hasId) return res.status(202).end(); // any other notification: no reply

  const params = msg.params;

  if (method === "initialize") {
    const want = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    const protocolVersion = MCP_SUPPORTED_VERSIONS.includes(want) ? want : MCP_PROTOCOL_VERSION;
    return res.json(
      mcpRpcResult(msg.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "loadlens", version: APP_VERSION },
      })
    );
  }

  if (method === "ping") return res.json(mcpRpcResult(msg.id, {}));

  if (method === "tools/list") return res.json(mcpRpcResult(msg.id, { tools: MCP_TOOLS }));

  if (method === "tools/call") {
    if (!params || typeof params !== "object" || Array.isArray(params) || typeof params.name !== "string") {
      return res.json(mcpRpcError(msg.id, -32602, "invalid params: tools/call needs { name, arguments }"));
    }
    if (!MCP_TOOLS.some((t) => t.name === params.name)) {
      return res.json(mcpRpcError(msg.id, -32602, `unknown tool: ${params.name}`));
    }
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
    const result = runMcpTool(params.name, args);
    if (!result) return res.json(mcpRpcError(msg.id, -32602, `unknown tool: ${params.name}`));
    return res.json(mcpRpcResult(msg.id, result));
  }

  return res.json(mcpRpcError(msg.id, -32601, `method not found: ${method}`));
}

function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  // ---- request log: one line per request, opt-out with LOG_REQUESTS=0 ----
  app.use((req, res, next) => {
    if (!config.logRequests) return next();
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(
        `[webhvac] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`
      );
    });
    next();
  });

  // ---- CORS: one middleware for the whole app --------------------------
  // Remote MCP clients and browser agents call /mcp (and /api/*) from any origin,
  // and MCP Streamable HTTP requires POST + a Content-Type header. This is the ONE
  // place CORS is applied — there is no separate `cors` dependency to extend, so it
  // lives here and every route inherits it. Extend it here; never duplicate it.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  // ---- throttle (lib/ratelimit.js) -------------------------------------
  // Declared here, above every route that uses them. Mounted per bucket rather than globally:
  // /api/health and the /api/event beacon stay unlimited (a health poll must never be rate-limited),
  // the calc routes take a generous 120/min, and the upload — real work on a real file — takes 10/min.
  // lib/ratelimit.js explains why this is per-container and what bounds the multiplier.
  const limitMcp = limiter("mcp");
  const limitCalc = limiter("calc");
  const limitParse = limiter("parse");

  // ---------------- the anonymous usage counter --------------------------
  // POST /api/event, mounted BEFORE the JSON parser with a raw body reader for this route only.
  // Two reasons it is not left to express.json(): the beacon the browser sends is text/plain, and
  // express.json() leaves req.body undefined for that, so the dev server answered 204 but never
  // logged (production, which reads the raw body, did). It also makes a malformed body answer the
  // same bare 204 here as in the Lambda, instead of the 400 express.json() would raise. The log
  // line itself comes from the shared lib/event.js, so local and production cannot drift.
  app.post("/api/event", express.raw({ type: () => true, limit: "8mb" }), (req, res) => {
    let raw = req.body;
    if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
    if (typeof raw !== "string") raw = raw == null ? "" : String(raw);
    let data = null;
    if (raw.length > 0 && raw.length <= EVENT_MAX_BYTES) {
      try { data = JSON.parse(raw); } catch { data = null; } // malformed -> 204, exactly like the Lambda
    }
    if (data && !eventBodyTooBig(data)) {
      const line = eventLogLine(data);
      if (line) console.log(line); // one line, no IP, no user agent, no referrer
    }
    res.status(204).end();
  });

  app.use(express.json({ limit: "8mb" }));

  // ------------------------------- API -----------------------------------
  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      app: APP_NAME,
      version: APP_VERSION,
      node: config.nodeVersion,
      uptimeSec: Math.round(process.uptime()),
      maxUploadMb: config.maxUploadMb,
      serverSideParse: true,
    });
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxUploadMb * 1024 * 1024,
      files: config.maxFiles,
      fields: 20,
      parts: 30,
    },
    fileFilter(req, file, cb) {
      if (isPdfUpload(file)) return cb(null, true);
      const err = new Error(
        `${file.originalname || "file"}: only PDF files are accepted (.pdf)`
      );
      err.status = 400;
      cb(err);
    },
  }).any(); // `files` (many) and `file` (one) are both accepted; names checked below

  app.post("/api/parse", limitParse, (req, res, next) => {
    upload(req, res, (err) => {
      if (err) return next(err);
      const files = (req.files || []).filter(
        (f) => f.fieldname === "files" || f.fieldname === "file"
      );
      if (!files.length) {
        return res.status(400).json({
          error: 'no file in the request (send one or more files under the field name "files")',
        });
      }
      // one bad PDF must not kill the whole request -> parse each in try/catch
      Promise.all(
        files.map((f) =>
          parseUpload(f).then(
            (ok) => ({ ok }),
            (e) => ({ err: e })
          )
        )
      )
        .then((outcomes) => {
          const failed = outcomes.find((o) => o.err);
          if (failed) {
            return res.status(failed.err.status || 400).json({ error: failed.err.message });
          }
          const done = outcomes.map((o) => o.ok);
          const rooms = done.flatMap((d) => d.rooms);
          const warnings = done.flatMap((d) => d.warnings);
          res.json({
            files: done.map(({ name, pages, rooms: r, warnings: w, levelCount, roomCount, ms, evidence }) => ({
              name,
              pages,
              evidence,
              rooms: r,
              warnings: w,
              levelCount,
              roomCount,
              ms,
            })),
            rooms,
            warnings,
            ms: done.reduce((a, d) => Math.max(a, d.ms), 0),
          });
        })
        .catch(next);
    });
  });

  app.post("/api/calc", limitCalc, (req, res) => {
    // One code path with the MCP tool `calculate_cooling_load`: computeCalc().
    const out = computeCalc(req.body || {});
    if (out.error) return res.status(out.error.status).json({ error: out.error.message });
    res.json(out.result);
  });

  app.get("/api/climates", (req, res) => {
    res.json({ countries: COUNTRIES, cities: CLIMATES });
  });

  // ------------------------------- MCP -----------------------------------
  // LoadLens as a remote MCP server. POST /mcp speaks JSON-RPC 2.0 (Streamable
  // HTTP, single JSON response — never text/event-stream). GET /mcp is a 405 with
  // an Allow header, as Streamable HTTP expects POST.
  app.post("/mcp", limitMcp, handleMcp);
  app.get("/mcp", (req, res) => {
    res.set("Allow", "POST");
    res.status(405).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "MCP uses the Streamable HTTP transport: POST JSON-RPC 2.0 to /mcp" },
    });
  });

  // The anonymous usage counter is handled above, before the JSON parser.

  // any other /api/* -> JSON 404
  app.use("/api", (req, res) => res.status(404).json({ error: "unknown endpoint" }));

  // ------------------------------ static UI ------------------------------
  for (const f of uiRootFiles()) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) continue;
    app.get(`/${f}`, (req, res) => res.sendFile(abs));
  }
  app.get("/", (req, res) => res.sendFile(path.join(ROOT, "index.html")));

  for (const dir of UI_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!existing(abs)) continue;
    app.use(`/${dir}`, express.static(abs, { index: false, dotfiles: "deny" }));
  }

  // the sample drawing: repo `samples/` if present, plus tests/samples -> /samples
  for (const dir of SAMPLE_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!existing(abs)) continue;
    app.use("/samples", express.static(abs, { index: false, dotfiles: "deny" }));
  }

  // ------------------------------ fallbacks ------------------------------
  app.use((req, res) => res.status(404).json({ error: "not found" }));

  // final error handler: multer limits and body errors -> JSON with a status
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (!err) return res.status(500).json({ error: "internal error" });
    let status = err.status || err.statusCode;
    let message = err.message || "internal error";
    if (err.code === "LIMIT_FILE_SIZE") {
      status = 413;
      message = `file is too large (limit ${config.maxUploadMb} MB per file)`;
    } else if (err.code === "LIMIT_FILE_COUNT") {
      status = 400;
      message = `too many files (limit ${config.maxFiles} per request)`;
    } else if (err.code === "LIMIT_UNEXPECTED_FILE") {
      status = 400;
      message = `unexpected file field "${err.field}" (use "files")`;
    } else if (err.code === "LIMIT_PART_COUNT" || err.code === "LIMIT_FIELD_COUNT") {
      status = 400;
      message = "too many parts in the request";
    } else if (err.type === "entity.parse.failed" || err.name === "SyntaxError") {
      status = 400;
      message = "invalid JSON body";
    }
    if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;
    res.status(status).json({ error: message });
  });

  return app;
}

export { buildApp, ROOT, UI_ROOT_FILES, UI_DIRS, SAMPLE_DIRS };

// The Express app: static UI + JSON API + server-side PDF parsing.
// Built here (not in server.js) so tests can mount it on an ephemeral port.
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config, APP_NAME, APP_VERSION } from "./config.js";
import { parseUpload, isPdfUpload } from "./parse.js";
import { calcProject, DEFAULT_PROJECT, COUNTRIES, CLIMATES } from "../js/calc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Only these files/folders are reachable over HTTP. `tests/` (except its
// samples subfolder, mounted read-only at /samples) and `node_modules/` are
// deliberately NOT exposed.
const UI_ROOT_FILES = ["index.html", "selftest.html", "favicon.svg"];
const UI_DIRS = ["css", "js", "vendor"];
const SAMPLE_DIRS = ["samples", path.join("tests", "samples")];

const existing = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

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

  app.post("/api/parse", (req, res, next) => {
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
            files: done.map(({ name, pages, rooms: r, warnings: w, levelCount, roomCount, ms }) => ({
              name,
              pages,
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

  app.post("/api/calc", (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.rooms)) {
      return res.status(400).json({ error: "rooms must be an array" });
    }
    const project = { ...DEFAULT_PROJECT, ...(body.project || {}) };
    res.json(calcProject(body.rooms, project));
  });

  app.get("/api/climates", (req, res) => {
    res.json({ countries: COUNTRIES, cities: CLIMATES });
  });

  // any other /api/* -> JSON 404
  app.use("/api", (req, res) => res.status(404).json({ error: "unknown endpoint" }));

  // ------------------------------ static UI ------------------------------
  for (const f of UI_ROOT_FILES) {
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

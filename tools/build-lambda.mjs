// Build dist/loadlens-lambda.zip — the ZIP deployment artifact for the Lambda
// Function URL that hosts the LoadLens parsing API.
//
//   cd D:/webhvac && npm run build:lambda     (or: node tools/build-lambda.mjs)
//
// No Docker, and no system `zip` binary either: the archive is written by the
// tiny pure-Node (node:zlib) writer at the bottom of this file, so the build
// works on a bare Windows box. Runtime deps are installed production-only into
// a staging folder, the files the Lambda actually needs are copied in, a
// minimal "type":"module" package.json is written into the zip root, and the
// result is checked against the Lambda ZIP limits (50 MB zipped / 250 MB
// unzipped; we fail at 45 MB / 240 MB to leave headroom).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(ROOT, "dist");
const STAGING = path.join(DIST, "lambda-build");
const ZIP_PATH = path.join(DIST, "loadlens-lambda.zip");

const MAX_ZIP_MB = 45;
const MAX_UNZIPPED_MB = 240;
const HANDLER = "lambda/index.handler";

// -- what goes into the archive -------------------------------------------
// Directories copied whole.
const DIRS = ["lambda", "lib", "js", "css"];
// Files from the repo root that the static UI / the app's own file list wants.
const ROOT_FILE_EXTS = [".html", ".svg", ".ico", ".txt", ".webmanifest"];
// The vendored PDF engine: js/pdfparse.js is shared by the browser and the
// server, and the browser build of pdf.js is kept under vendor/ — the Lambda
// package must carry it (lib/parse.js uses pdfjs-dist, vendor/ keeps the
// img/worker entry points available to the served UI).
const VENDOR_FILES = ["pdf.min.mjs", "pdf.worker.min.mjs"];

// Never zipped: install noise, lockfiles, source maps, type stubs.
const SKIP_NAMES = new Set([
  "package-lock.json",
  ".package-lock.json",
  ".bin",
  ".cache",
  ".git",
  "node_modules/.bin",
  "__smoke.mjs",
]);
const SKIP_EXT = new Set([".map", ".ts", ".d.ts", ".d.mts", ".md"]);

// -- small helpers ---------------------------------------------------------
const mb = (bytes) => bytes / 1024 / 1024;
const human = (bytes) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${bytes} B`;

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function skipped(rel) {
  const parts = rel.split("/");
  for (const p of parts) if (SKIP_NAMES.has(p)) return true;
  if (SKIP_NAMES.has(rel)) return true;
  const ext = path.extname(rel).toLowerCase();
  if (SKIP_EXT.has(ext)) return true;
  if (rel.endsWith(".d.mts")) return true;
  return false;
}

/** Copy a tree into the staging dir, returning [{ rel, abs, size }]. */
function copyTree(srcDir, destDir, acc) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      const rel = path.relative(STAGING, dest).split(path.sep).join("/");
      if (skipped(rel)) continue;
      copyTree(src, dest, acc);
    } else if (entry.isFile()) {
      const rel = path.relative(STAGING, dest).split(path.sep).join("/");
      if (skipped(rel)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      acc.push({ rel, abs: dest, size: fs.statSync(dest).size });
    }
  }
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${res.status}`);
}

function npmInstall(cwd) {
  // `npm` is a .cmd shim on Windows; node's npm-cli.js path is the reliable one.
  // --omit=optional drops pdfjs-dist's optional @napi-rs/canvas: it is only used
  // to *render* PDFs to a bitmap, not to read their text, and its prebuilt
  // binary is per-platform (npm would install the Windows one here). Leaving it
  // out keeps the zip ~36 MB smaller and architecture-neutral (x86_64 + arm64).
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const args = ["install", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund"];
  if (fs.existsSync(cli)) return run(process.execPath, [cli, ...args], { cwd });
  return run("npm", args, { cwd, shell: process.platform === "win32" });
}

// -- zip writer (pure node:zlib, no system zip / no dependency) ------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Write a standard (no zip64 needed, sizes are far below 4 GB) ZIP archive. */
function writeZip(outPath, files) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.rel, "utf8");
    const data = fs.readFileSync(f.abs);
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const method = store ? 0 : 8; // 0 = stored, 8 = deflate
    const { time, date } = dosDateTime(fs.statSync(f.abs).mtime);

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28); // extra length
    local.push(head, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4); // made by: version 3.0, UNIX host
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0o644 << 16, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += head.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(outPath, Buffer.concat([...local, cdBuf, end]));
  return { entryCount: files.length, cdOffset: offset, cdSize: cdBuf.length };
}

/** Read the archive's own end-of-central-directory record back (sanity check). */
function verifyZip(outPath, written) {
  const buf = fs.readFileSync(outPath);
  const sig = buf.readUInt32LE(buf.length - 22);
  if (sig !== 0x06054b50) throw new Error("zip is malformed: no end-of-central-directory record");
  const count = buf.readUInt16LE(buf.length - 22 + 10);
  const cdSize = buf.readUInt32LE(buf.length - 22 + 12);
  const cdOffset = buf.readUInt32LE(buf.length - 22 + 16);
  if (count !== written.entryCount) throw new Error(`zip entry count ${count} != ${written.entryCount}`);
  if (cdSize !== written.cdSize || cdOffset !== written.cdOffset)
    throw new Error("zip central-directory offsets do not match what was written");
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50)
    throw new Error("zip central directory does not start where it claims");
  return count;
}

// -- smoke check: run the STAGED tree (its own node_modules) in-process -----
const SMOKE_FILE = "__smoke.mjs";
const SMOKE_SOURCE = `// generated by tools/build-lambda.mjs — parses the real sample from this staged
// tree so the build proves the packaged files + node_modules actually work.
import fs from "node:fs";
const { handler } = await import("./lambda/index.mjs");
const pdf = fs.readFileSync(process.env.SMOKE_SAMPLE);
const boundary = "----loadlenssmoke";
const head = Buffer.from(
  '--' + boundary + '\\r\\nContent-Disposition: form-data; name="files"; filename="headquarters.pdf"\\r\\nContent-Type: application/pdf\\r\\n\\r\\n',
  "utf8"
);
const tail = Buffer.from("\\r\\n--" + boundary + "--\\r\\n", "utf8");
const body = Buffer.concat([head, pdf, tail]);
const event = {
  version: "2.0",
  rawPath: "/api/parse",
  rawQueryString: "",
  cookies: [],
  headers: {
    host: "smoke.local",
    "content-type": "multipart/form-data; boundary=" + boundary,
    "content-length": String(body.length),
  },
  requestContext: {
    http: { method: "POST", path: "/api/parse", protocol: "HTTP/1.1", sourceIp: "127.0.0.1" },
    requestId: "smoke",
  },
  body: body.toString("base64"),
  isBase64Encoded: true,
};
const res = await handler(event, { awsRequestId: "smoke", callbackWaitsForEmptyEventLoop: false });
const text = res.isBase64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : String(res.body || "");
let j = null;
try { j = JSON.parse(text); } catch {}
const rooms = j && j.rooms ? j.rooms.length : null;
console.log("  staged smoke: status " + res.statusCode + ", pages " + (j && j.files && j.files[0] ? j.files[0].pages : "?") + ", rooms " + rooms + ", " + (j && j.ms) + " ms");
if (res.statusCode !== 200) { console.error("  staged tree did not answer 200: " + text.slice(0, 300)); process.exit(2); }
if (rooms !== 149) { console.error("  staged tree parsed " + rooms + " rooms, expected 149"); process.exit(3); }
`;

function smokeTestStaged(sample) {
  fs.writeFileSync(path.join(STAGING, SMOKE_FILE), SMOKE_SOURCE);
  const res = spawnSync(process.execPath, [SMOKE_FILE], {
    cwd: STAGING,
    stdio: "inherit",
    env: { ...process.env, LOG_REQUESTS: "0", SMOKE_SAMPLE: sample },
  });
  fs.rmSync(path.join(STAGING, SMOKE_FILE), { force: true });
  if (res.error) throw res.error;
  if (res.status !== 0)
    throw new Error(`staged smoke check failed (exit ${res.status}) — the packaged tree does not parse the sample`);
}

// -- main ------------------------------------------------------------------
function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const deps = pkg.dependencies || {};
  if (!deps.express || !deps.multer || !deps["pdfjs-dist"])
    throw new Error("package.json is missing express/multer/pdfjs-dist — refusing to build");
  if (!deps["serverless-http"])
    console.log("! serverless-http is not listed in dependencies — the handler will not load");

  console.log(`LoadLens Lambda build
  repo:    ${ROOT}
  staging: ${STAGING}
  zip:     ${ZIP_PATH}
  runtime deps: ${Object.entries(deps).map(([k, v]) => `${k}@${v}`).join(", ")}
`);

  rmrf(STAGING);
  rmrf(ZIP_PATH);
  fs.mkdirSync(STAGING, { recursive: true });

  // 1. minimal package.json so npm installs exactly the production deps.
  fs.writeFileSync(
    path.join(STAGING, "package.json"),
    JSON.stringify(
      {
        name: "loadlens-lambda",
        version: pkg.version,
        private: true,
        type: "module",
        description: "LoadLens server-side PDF parsing on AWS Lambda (do not edit by hand — built by tools/build-lambda.mjs)",
        dependencies: deps,
      },
      null,
      2
    ) + "\n"
  );

  // 2. production-only install (this is the step that needs the network).
  console.log("npm install --omit=dev ...");
  npmInstall(STAGING);
  rmrf(path.join(STAGING, "package-lock.json"));
  rmrf(path.join(STAGING, "node_modules", ".bin"));
  rmrf(path.join(STAGING, "node_modules", ".package-lock.json"));

  // 3. copy the app files the handler needs (node_modules is already there).
  const collected = [];
  for (const dir of DIRS) {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) copyTree(abs, path.join(STAGING, dir), collected);
  }
  for (const f of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!f.isFile() || f.name.startsWith(".")) continue;
    if (!ROOT_FILE_EXTS.includes(path.extname(f.name).toLowerCase())) continue;
    fs.copyFileSync(path.join(ROOT, f.name), path.join(STAGING, f.name));
  }
  for (const f of VENDOR_FILES) {
    const abs = path.join(ROOT, "vendor", f);
    if (!fs.existsSync(abs)) throw new Error(`vendor/${f} is missing — the PDF engine must be vendored`);
    fs.mkdirSync(path.join(STAGING, "vendor"), { recursive: true });
    fs.copyFileSync(abs, path.join(STAGING, "vendor", f));
  }
  for (const f of [...DIRS, "vendor"]) {
    if (!fs.existsSync(path.join(STAGING, f))) throw new Error(`no ${f}/ in the staging folder`);
  }
  for (const must of ["lambda/index.mjs", "lib/app.js", "lib/parse.js", "js/pdfparse.js", "js/calc.js", "vendor/pdf.worker.min.mjs"]) {
    if (!fs.existsSync(path.join(STAGING, must))) throw new Error(`required file missing from the build: ${must}`);
  }

  // 4. collect everything that will be zipped (node_modules included).
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(STAGING, abs).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (skipped(rel)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        if (skipped(rel)) continue;
        files.push({ rel, abs, size: fs.statSync(abs).size });
      }
    }
  };
  walk(STAGING);
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  // 5. zip + verify.
  const written = writeZip(ZIP_PATH, files);
  const entries = verifyZip(ZIP_PATH, written);
  console.log(`staged smoke check (parses tests/samples/headquarters.pdf through the staged tree)...`);
  smokeTestStaged(path.join(ROOT, "tests", "samples", "headquarters.pdf"));

  // 6. report.
  const zipSize = fs.statSync(ZIP_PATH).size;
  const unzipped = files.reduce((a, f) => a + f.size, 0);
  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 5);

  console.log(`
zip structure verified: ${entries} entries, handler ${HANDLER}
  zip file : ${human(zipSize)} (${zipSize} bytes)
  unzipped : ${human(unzipped)} (${unzipped} bytes)
  files    : ${files.length}
largest 5 files:`);
  for (const f of largest) console.log(`  ${human(f.size).padStart(9)}  ${f.rel}`);

  const problems = [];
  if (mb(unzipped) > MAX_UNZIPPED_MB) problems.push(`unzipped ${mb(unzipped).toFixed(1)} MB > ${MAX_UNZIPPED_MB} MB`);
  if (mb(zipSize) > MAX_ZIP_MB) problems.push(`zip ${mb(zipSize).toFixed(1)} MB > ${MAX_ZIP_MB} MB`);
  if (problems.length) {
    console.error(`\nBUILD FAILED: ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log(`\nBUILD OK -> ${ZIP_PATH}`);
  console.log(`deploy with handler ${HANDLER} (runtime nodejs22.x, architecture arm64 or x86_64)`);
}

main();

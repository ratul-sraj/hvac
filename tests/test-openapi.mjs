// tests/test-openapi.mjs — the OpenAPI spec must describe exactly the API the app serves.
//
// The failure mode this guards against: a spec that documents a route lib/app.js does not have, or
// that omits a real one — an agent then calls an endpoint that 404s (or never discovers one that
// works). So this file READS lib/app.js, extracts its /api/* routes, and compares them against the
// spec, resolving each documented path against the spec's server base (OpenAPI joins server.url +
// path). It also checks every operation has a summary and a response schema, that every example
// request validates against its own requestBody schema (a small dependency-free validator), and
// that the Room schema accepts the minimal documented room.
//
//   node tests/test-openapi.mjs
import fs from "node:fs";

const spec = JSON.parse(fs.readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
const appSrc = fs.readFileSync(new URL("../lib/app.js", import.meta.url), "utf8");

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// --------------------------------------------------------------------------
// a tiny JSON-schema validator (draft subset: $ref, type incl. arrays-of-types,
// required, properties, items, enum, minItems/maxItems). No dependencies.
// --------------------------------------------------------------------------
function resolveRef(schema, root) {
  let s = schema;
  while (s && s.$ref) {
    if (!s.$ref.startsWith("#/")) throw new Error(`unsupported $ref: ${s.$ref}`);
    s = s.$ref.slice(2).split("/").reduce((acc, k) => acc && acc[k.replace(/~1/g, "/").replace(/~0/g, "~")], root);
  }
  return s;
}
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v; // "number" | "string" | "boolean" | "object"
}
function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === "number") return actual === "number" || actual === "integer";
  if (t === "integer") return actual === "integer";
  return actual === t;
}
function validate(value, schema, root, path = "$", errors = []) {
  const s = resolveRef(schema, root);
  if (!s || typeof s !== "object") return errors;
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${path}: expected ${types.join("|")}, got ${typeOf(value)}`);
      return errors; // no point descending with the wrong type
    }
  }
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (Array.isArray(value)) {
    if (s.minItems != null && value.length < s.minItems) errors.push(`${path}: needs >= ${s.minItems} items`);
    if (s.maxItems != null && value.length > s.maxItems) errors.push(`${path}: needs <= ${s.maxItems} items`);
    if (s.items) value.forEach((v, i) => validate(v, s.items, root, `${path}[${i}]`, errors));
  } else if (value && typeof value === "object") {
    for (const req of s.required || []) {
      if (!(req in value)) errors.push(`${path}: missing required "${req}"`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (s.properties && s.properties[k]) validate(v, s.properties[k], root, `${path}.${k}`, errors);
    }
  }
  return errors;
}

const isPathKey = (k) => k.startsWith("/");
const METHODS = ["get", "post", "put", "delete", "patch"];

// --------------------------------------------------------------------------
console.log("openapi spec: shape");
{
  ok("openapi.json parses as JSON", !!spec && typeof spec === "object");
  ok("openapi version is 3.x", /^3\.\d+\.\d+$/.test(spec.openapi || ""), spec.openapi);
  ok("info.title names LoadLens", /LoadLens/.test((spec.info || {}).title || ""), (spec.info || {}).title);
  ok("info.description names LoadLens", /LoadLens/.test((spec.info || {}).description || ""));
  ok("info.description says no API key is needed", /no api key|needs no api key|without a key/i.test((spec.info || {}).description || ""));
  ok("info.description says it is free", /\bfree\b/i.test((spec.info || {}).description || ""));
  ok("info.description says it runs on AWS", /\bAWS\b/.test((spec.info || {}).description || ""));
  ok("info.description states the 2000-room limit", /2000 rooms/.test((spec.info || {}).description || ""));
  ok("info.description says the browser path never uploads the PDF", /never uploads the PDF/i.test((spec.info || {}).description || ""));
  ok("has at least one server", Array.isArray(spec.servers) && spec.servers.length > 0);
}

// --------------------------------------------------------------------------
// paths and methods must match lib/app.js EXACTLY (modulo the deliberately
// undocumented /api/event beacon).
console.log("\nopenapi spec: paths/methods match lib/app.js");
{
  // every app.get/post/...("/api/...") route the Express app registers
  const appRoutes = new Set();
  const routeRe = /app\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = routeRe.exec(appSrc))) {
    if (m[2].startsWith("/api/")) appRoutes.add(`${m[1]} ${m[2]}`);
  }
  ok("found the app's /api/* routes in lib/app.js", appRoutes.size >= 4, [...appRoutes].join(", "));

  // the internal anonymous-usage beacon is intentionally not part of the agent API:
  // it takes a text/plain body and answers 204, so it is not documented.
  const EXCLUDED = new Set(["/api/event"]);
  const expected = new Set([...appRoutes].filter((r) => !EXCLUDED.has(r.split(" ")[1])));
  ok("the only excluded app route is the /api/event beacon",
    [...appRoutes].filter((r) => EXCLUDED.has(r.split(" ")[1])).every((r) => r === "post /api/event"));

  // resolve each documented operation against the server base, the way OpenAPI does
  const serverBases = spec.servers.map((s) => s.url.replace(/\/+$/, ""));
  const documented = new Set();
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (!METHODS.includes(method)) continue;
      for (const base of serverBases) {
        const url = new URL(base + p);
        documented.add(`${method} ${url.pathname}`);
      }
    }
  }
  ok("every documented operation resolves to a real app route",
    [...documented].every((d) => appRoutes.has(d)),
    [...documented].filter((d) => !appRoutes.has(d)).join(", ") || "all resolve");
  eq("documented operations equal the app's routes (minus the beacon)",
    [...documented].sort(), [...expected].sort());

  // the four agent-facing endpoints must all be there
  for (const r of ["get /api/health", "post /api/calc", "post /api/parse", "get /api/climates"]) {
    ok(`documents ${r}`, documented.has(r));
  }
}

// --------------------------------------------------------------------------
console.log("\nopenapi spec: summaries, schemas, examples");
{
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (!METHODS.includes(method)) continue;
      const op = item[method];
      ok(`${method.toUpperCase()} ${p}: has a summary`, typeof op.summary === "string" && op.summary.length > 0, op.summary);

      const responses = op.responses || {};
      ok(`${method.toUpperCase()} ${p}: has responses`, Object.keys(responses).length > 0);
      let schemasOk = true;
      let detail = "";
      for (const [code, resp] of Object.entries(responses)) {
        const r = resolveRef(resp, spec);
        const content = r && r.content;
        const schema = content && content["application/json"] && content["application/json"].schema;
        if (!schema) { schemasOk = false; detail += `${code} has no json schema; `; }
      }
      ok(`${method.toUpperCase()} ${p}: every response carries a JSON schema`, schemasOk, detail || `${Object.keys(responses).length} responses`);

      // every example request must validate against its own requestBody schema
      const body = op.requestBody;
      if (body) {
        const media = Object.keys(body.content)[0];
        const schema = body.content[media].schema;
        const examples = body.content[media].examples || {};
        for (const [name, ex] of Object.entries(examples)) {
          const errors = validate(ex.value, schema, spec);
          ok(`${method.toUpperCase()} ${p}: example "${name}" validates against its schema`,
            errors.length === 0, errors.join("; "));
        }
      }
    }
  }
}

// --------------------------------------------------------------------------
console.log("\nopenapi spec: the Room schema accepts the minimal room");
{
  const room = spec.components.schemas.Room;
  const minimal = { name: "Office", area: 50, type: "office" };
  eq("minimal {name,area,type} validates", validate(minimal, room, spec), []);

  // prove the validator actually rejects things (so the pass above is meaningful)
  ok("a room with no area is rejected", validate({ name: "Office" }, room, spec).length > 0);
  ok("a room with a non-numeric area is rejected", validate({ area: "big" }, room, spec).length > 0);
  ok("a bad enum value is rejected", validate({ area: 10, type: "spaceship" }, room, spec).length > 0);
}

console.log(`\nopenapi: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("ALL OPENAPI CHECKS PASSED");

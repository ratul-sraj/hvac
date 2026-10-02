// Tests for the design-conditions.html search filter, executed in Node with a tiny DOM shim.
//
//   cd D:/webhvac && node tests/test-design-conditions-search.mjs
//
// The bug these guard against: the in-page filter only knew about SOURCED rows (tr.dc-src), so
// typing an indicative city such as "kochi" or "kannur" hid every block with no sourced match and
// the counter read "Showing 0 of 132 sourced cities" — the visitor concluded the city was missing.
// These tests run the real generated script and prove indicative rows match, are never hidden when
// they match, and the counter is honest.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, "..", "design-conditions.html");
const html = fs.readFileSync(FILE, "utf8");

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`); }
};

/* ------------------------------- tiny DOM shim ---------------------------- */
const attrsOf = (s) => {
  const a = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g;
  let m;
  while ((m = re.exec(s))) a[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : "");
  return a;
};

const makeRow = (attrs) => {
  let hidden = false;
  return {
    attrs,
    get hidden() { return hidden; },
    getAttribute(k) { return k === "hidden" ? (hidden ? "" : null) : (attrs[k.toLowerCase()] ?? null); },
    setAttribute(k) { if (k === "hidden") hidden = true; },
    removeAttribute(k) { if (k === "hidden") hidden = false; },
  };
};

const makeBlock = (tag, depth, attrs) => {
  let hidden = false;
  return {
    tag, depth, attrs, rows: [],
    get hidden() { return hidden; },
    getAttribute(k) { return k === "hidden" ? (hidden ? "" : null) : (attrs[k.toLowerCase()] ?? null); },
    setAttribute(k) { if (k === "hidden") hidden = true; },
    removeAttribute(k) { if (k === "hidden") hidden = false; },
    querySelector() { return this.rows.find((r) => !r.hidden) || null; },
  };
};

const rows = [], countries = [], regions = [], open = [];
let divDepth = 0, secDepth = 0;
const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
let m;
while ((m = tagRe.exec(html))) {
  const closing = m[1] === "/";
  const name = m[2].toLowerCase();
  const attrs = attrsOf(m[3]);
  const cls = attrs.class || "";
  if (!closing) {
    if (name === "div") {
      divDepth++;
      if (cls.split(/\s+/).includes("dc-country-block")) { const b = makeBlock("div", divDepth, attrs); countries.push(b); open.push(b); }
    } else if (name === "section") {
      secDepth++;
      if (cls.split(/\s+/).includes("dc-region")) { const b = makeBlock("section", secDepth, attrs); regions.push(b); open.push(b); }
    } else if (name === "tr" && cls.split(/\s+/).includes("dc-row")) {
      const row = makeRow(attrs);
      rows.push(row);
      for (const b of open) b.rows.push(row);
    }
  } else {
    if (name === "div") {
      for (let i = open.length - 1; i >= 0; i--) if (open[i].tag === "div" && open[i].depth === divDepth) open.splice(i, 1);
      divDepth--;
    } else if (name === "section") {
      for (let i = open.length - 1; i >= 0; i--) if (open[i].tag === "section" && open[i].depth === secDepth) open.splice(i, 1);
      secDepth--;
    }
  }
}

const box = { value: "", _listeners: [], addEventListener(_ev, fn) { this._listeners.push(fn); } };
const count = { textContent: "" };
const document = {
  getElementById: (id) => (id === "dc-search" ? box : id === "dc-count" ? count : null),
  querySelectorAll: (sel) => (sel === "tr.dc-row" ? rows : sel === "[data-dc-country]" ? countries : sel === "[data-dc-region]" ? regions : []),
};

/* ------------------------------- run the page's own script --------------- */
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]).find((s) => s.includes("querySelectorAll"));
ok("design-conditions.html carries an inline search script", !!inline);
let loaded = true;
try { new Function("document", inline)(document); } catch (e) { loaded = false; console.log("      script threw: " + e.message); }
ok("the search script loads against the row set", loaded);
ok("the script selects every row, sourced and indicative (tr.dc-row)",
  inline.includes("'tr.dc-row'") && !/querySelectorAll\('tr\.dc-src'\)/.test(inline));
ok("the script has no reference to the sourced-only class", !/dc-src\b/.test(inline));

const totalSourced = rows.filter((r) => r.getAttribute("data-sourced") === "true").length;
ok("the page carries 132 sourced rows", totalSourced === 132, `${totalSourced}`);
ok("the page carries the indicative rows too", rows.length > totalSourced, `${rows.length - totalSourced} indicative`);

const type = (q) => { box.value = q; box._listeners.forEach((fn) => fn()); };
const visible = (r) => !r.hidden;
const searchOf = (r) => (r.getAttribute("data-search") || "").trim();

/* ------------------------------- the bug cases --------------------------- */
for (const city of ["kochi", "kannur"]) {
  type(city);
  const matches = rows.filter((r) => searchOf(r).includes(city));
  ok(`typing "${city}" matches at least one row`, matches.length >= 1, `${matches.length}`);
  ok(`every row matching "${city}" is visible (none hidden)`, matches.every(visible),
    matches.filter((r) => !visible(r)).length + " hidden");
  ok(`the counter for "${city}" is honest about sourced AND indicative`,
    /^Showing \d+ of 132 sourced cities and \d+ of \d+ indicative rows$/.test(count.textContent),
    count.textContent);
  ok(`the counter for "${city}" reports an indicative match`, /and [1-9]\d* of \d+ indicative rows/.test(count.textContent), count.textContent);
  ok(`the block holding the "${city}" row is visible`, regions.some((b) => b.rows.includes(matches[0]) && !b.hidden));
}

/* a sourced city still works */
type("dubai");
ok("a sourced city still matches and shows a sourced count",
  /Showing [1-9]\d* of 132 sourced cities/.test(count.textContent), count.textContent);
ok("no matching row is hidden for a sourced city",
  rows.filter((r) => searchOf(r).includes("dubai")).every(visible));

/* empty query shows everything again */
type("");
ok("an empty query shows every row", rows.every(visible));
ok("an empty query reports the full counts",
  count.textContent === `Showing 132 of 132 sourced cities and ${rows.length - totalSourced} of ${rows.length - totalSourced} indicative rows`,
  count.textContent);

/* a query with no match hides rows and reports zero, honestly */
type("zzzznotacity");
ok("a no-match query hides every row", rows.every((r) => !visible(r)));
ok("a no-match query reports zero of each",
  count.textContent === "Showing 0 of 132 sourced cities and 0 of " + (rows.length - totalSourced) + " indicative rows",
  count.textContent);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);

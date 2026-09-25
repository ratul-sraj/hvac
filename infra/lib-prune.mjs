#!/usr/bin/env node
// infra/lib-prune.mjs — work out which S3 objects are no longer part of the site.
//
// The AWS CLI is used for everything else, but deciding "stale key = managed by
// us AND not in the local build" is real logic, and there is no jq on this
// machine. Node is already required by the project, so the logic lives here.
//
//   node infra/lib-prune.mjs --local keys.txt --remote objects.json \
//        [--dirs css/,js/,vendor/] [--root-glob .html] [--root-file favicon.svg]
//
// keys.txt     : one object key per line (the files we just uploaded)
// objects.json : the JSON that `aws s3api list-objects-v2` printed
// prints       : the keys that should be deleted, one per line
import { readFileSync } from "node:fs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const localKeysFile = arg("--local");
const remoteFile = arg("--remote");
const dirs = (arg("--dirs", "css/,js/,vendor/,samples/") || "").split(",").filter(Boolean);
const rootGlob = arg("--root-glob", ".html");
const rootFile = arg("--root-file", "favicon.svg");

if (!localKeysFile || !remoteFile) {
  console.error("usage: lib-prune.mjs --local keys.txt --remote objects.json [--dirs a/,b/]");
  process.exit(2);
}

const local = new Set(
  readFileSync(localKeysFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)
);

let remote = [];
try {
  const parsed = JSON.parse(readFileSync(remoteFile, "utf8"));
  remote = (parsed.Contents || []).map((o) => o.Key).filter(Boolean);
} catch {
  console.error("could not read the object listing (empty bucket?)");
  process.exit(0);
}

const managed = (key) => {
  if (dirs.some((d) => key.startsWith(d))) return true;
  if (key === rootFile) return true;
  if (!key.includes("/") && key.endsWith(rootGlob)) return true;
  return false;
};

const stale = remote.filter((k) => managed(k) && !local.has(k));
// print sorted for a readable log
process.stdout.write(stale.sort().join("\n") + (stale.length ? "\n" : ""));

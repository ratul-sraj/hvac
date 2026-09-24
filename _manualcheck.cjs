// scratch: manual check of the running server (delete after use)
const base = process.argv[2] || "http://localhost:3123";
const fs = require("node:fs");
(async () => {
  const buf = fs.readFileSync("tests/samples/headquarters.pdf");
  const fd = new FormData();
  fd.append("files", new Blob([buf], { type: "application/pdf" }), "headquarters.pdf");
  const res = await fetch(base + "/api/parse", { method: "POST", body: fd });
  const j = await res.json();
  console.log("POST /api/parse ->", res.status);
  console.log(JSON.stringify({
    files: j.files.map((f) => ({ name: f.name, pages: f.pages, roomCount: f.roomCount, levelCount: f.levelCount, ms: f.ms })),
    rooms: j.rooms.length,
    warnings: j.warnings.length,
    totalMs: j.ms,
    firstRoom: j.rooms[0],
    levels: [...new Set(j.rooms.map((r) => r.level))],
  }, null, 1));

  const s = await fetch(base + "/samples/headquarters.pdf");
  const sb = Buffer.from(await s.arrayBuffer());
  console.log("GET /samples/headquarters.pdf ->", s.status, sb.length, "bytes, starts", sb.subarray(0, 5).toString("latin1"));

  const h = await fetch(base + "/");
  console.log("GET / ->", h.status, (await h.text()).length, "bytes html");

  for (const p of ["/tests/run.mjs", "/node_modules/express/package.json"]) {
    const r = await fetch(base + p);
    console.log("GET", p, "->", r.status);
  }
})();

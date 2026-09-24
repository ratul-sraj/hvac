// Build the calculator page `app.html` from the calculator source `index.html`.
//
// Why: the site's home page (`/`) is the LANDING page (index.html after the swap made
// by hand), while the calculator lives at /app.html. This script keeps them in step:
// it copies the calculator source and injects the shared top navigation.
//
//   cd D:/webhvac && node tools/sync-app-page.mjs            # index.html -> app.html
//   node tools/sync-app-page.mjs calculator.src.html app.html  # explicit source/target
//
// Idempotent: running it again on an already-synced page changes nothing.
import fs from "node:fs";

const src = process.argv[2] || "index.html";
const dst = process.argv[3] || "app.html";

const NAV = `<!-- shared top navigation (injected by tools/sync-app-page.mjs) -->
<nav class="app-nav" aria-label="Main">
  <div class="wrap app-nav-inner">
    <a class="app-nav-brand" href="index.html">WebHVAC</a>
    <span class="app-nav-links">
      <a href="index.html">Home</a>
      <a href="app.html" class="here" aria-current="page">Calculator</a>
      <a href="method.html">Method</a>
      <a href="help.html">Help</a>
      <a href="about.html">About</a>
    </span>
  </div>
</nav>
`;

let html = fs.readFileSync(src, "utf8");

// guard: never turn the landing page into the calculator page
if (/class="site-nav"/.test(html)) {
  console.error(`refusing: ${src} looks like the landing page (has .site-nav), not the calculator`);
  process.exit(1);
}
if (!/id="roomsTable"/.test(html)) {
  console.error(`refusing: ${src} does not look like the calculator page (no #roomsTable)`);
  process.exit(1);
}

if (!/class="app-nav"/.test(html)) html = html.replace(/<body([^>]*)>\s*/, (m) => m + "\n" + NAV);
if (!html.includes("css/style.css")) {
  html = html.replace("</head>", `<link rel="stylesheet" href="css/style.css">\n</head>`);
}
if (!html.includes("js/nav.js")) {
  html = html.replace("</body>", `<script src="js/nav.js" defer></script>\n</body>`);
}

const before = fs.existsSync(dst) ? fs.readFileSync(dst, "utf8") : "";
fs.writeFileSync(dst, html);
console.log(
  before === html
    ? `${dst} already up to date (${html.length} bytes)`
    : `${dst} written from ${src} (${html.length} bytes)` + (before ? ` — ${before.length} bytes before` : ""),
);
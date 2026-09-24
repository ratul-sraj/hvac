// Refresh the top navigation injected into the calculator page `app.html`.
// (Product name: LoadLens. Keep this brand in step with the pages.)
//
// After the site was split, `index.html` is the LANDING page and `app.html` is the
// calculator. The calculator's own markup lives in app.html, but its top nav is injected
// from the NAV block below so the menu links stay identical across the site.
//
//   cd D:/webhvac && node tools/update-app-nav.mjs
//
// Idempotent: it replaces an existing injected block, or inserts one if missing.
import fs from "node:fs";

const page = process.argv[2] || "app.html";

const NAV = `<!-- shared top navigation (injected by tools/update-app-nav.mjs) -->
<nav class="app-nav" aria-label="Main">
  <div class="wrap app-nav-inner">
    <a class="app-nav-brand" href="index.html">LoadLens</a>
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

let html = fs.readFileSync(page, "utf8");

if (/class="site-nav"/.test(html)) {
  console.error(`refusing: ${page} is the landing page (has .site-nav), not the calculator`);
  process.exit(1);
}
if (!/id="roomsTable"/.test(html)) {
  console.error(`refusing: ${page} does not look like the calculator page (no #roomsTable)`);
  process.exit(1);
}

const before = html;
const block = /<!-- shared top navigation[\s\S]*?<\/nav>\n?/;
if (block.test(html)) html = html.replace(block, NAV);
else html = html.replace(/<body([^>]*)>\s*/, (m) => m + "\n" + NAV);

if (!html.includes("js/nav.js")) html = html.replace("</body>", `<script src="js/nav.js" defer></script>\n</body>`);
if (!html.includes("css/style.css")) html = html.replace("</head>", `<link rel="stylesheet" href="css/style.css">\n</head>`);

fs.writeFileSync(page, html);
console.log(before === html ? `${page} already up to date` : `${page} nav refreshed (${html.length} bytes)`);
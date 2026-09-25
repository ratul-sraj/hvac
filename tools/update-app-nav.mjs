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
<!-- same markup, classes and link order as the marketing pages, so the header looks identical -->
<nav class="app-nav" aria-label="Main">
  <div class="wrap app-nav-inner">
    <a class="app-nav-brand" href="index.html">
      <svg class="brand-mark" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false">
        <rect x="1.5" y="7" width="29" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="2"/>
        <path d="M7 12.5h11M7 16h8M7 19.5h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M22.5 16l4.2-2.7v5.4z" fill="currentColor"/>
      </svg>
      <span class="brand-text">LoadLens<span class="brand-sub">COOLING LOAD FROM PDF</span></span>
    </a>
    <span class="app-nav-links">
      <a href="index.html">Home</a>
      <a href="app.html" aria-current="page">Calculator</a>
      <a href="about.html">About</a>
      <a href="method.html">Method</a>
      <a href="help.html">Help</a>
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
// Shared top-navigation behaviour.
//
// On a narrow screen the nav links collapse behind a hamburger button. The button is
// created here (not in each page) so the marketing pages and the calculator page behave
// the same, and so a page with JavaScript disabled simply keeps showing the links.
//
// Loaded with: <script src="js/nav.js" defer></script>
(function () {
  "use strict";

  var NAVS = [
    { root: "header.site-nav", inner: ".nav-inner", links: ".nav-links" }, // landing / about / method / help
    { root: "nav.app-nav", inner: ".app-nav-inner", links: ".app-nav-links" }, // calculator page
  ];
  var NARROW = "(max-width: 700px)";

  function build(root, inner, linksSel) {
    if (root.dataset.navReady === "1") return;
    var innerEl = root.querySelector(inner);
    var links = root.querySelector(linksSel);
    if (!innerEl || !links) return;
    root.dataset.navReady = "1";
    root.classList.add("js-nav");

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-burger";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", links.id || "");
    btn.setAttribute("aria-label", "Show menu");
    btn.innerHTML =
      '<span class="nav-burger-bars" aria-hidden="true"><span></span><span></span><span></span></span>' +
      '<span class="nav-burger-text">Menu</span>';
    innerEl.appendChild(btn);

    function setOpen(open) {
      root.classList.toggle("nav-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", open ? "Hide menu" : "Show menu");
    }

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      setOpen(!root.classList.contains("nav-open"));
    });

    // tapping a link navigates, so close the menu then
    links.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });
    document.addEventListener("click", function (e) {
      if (!root.contains(e.target)) setOpen(false);
    });

    // leaving the narrow layout must not leave a hidden menu behind
    var mq = window.matchMedia(NARROW);
    var onChange = function () { if (!mq.matches) setOpen(false); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  function init() {
    NAVS.forEach(function (spec) {
      document.querySelectorAll(spec.root).forEach(function (root) {
        build(root, spec.inner, spec.links);
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
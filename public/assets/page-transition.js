/**
 * page-transition.js
 * Adds a quick scale+fade ("morph") between full page navigations, since
 * this site is plain multi-page HTML (not a SPA) — every link is a real
 * browser navigation. Entrance is handled purely by the static
 * `page-morph-in` class already sitting in each page's HTML (see
 * index.html's <main> / form.html's .form-card); this file only handles
 * the exit half: intercept a same-origin link click, play the "out"
 * animation on [data-transition-root], then navigate.
 *
 * To add this to another page: give its main content wrapper the
 * `data-transition-root` attribute + `page-morph-in` class, and include
 * this script. Nothing else needed — links pointing anywhere on this
 * site (any href starting with "/") get the effect automatically.
 */
(function () {
  const root = document.querySelector("[data-transition-root]");
  if (!root) return; // page hasn't opted in — do nothing, links behave normally

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;

    const href = a.getAttribute("href");
    // Only intercept plain same-origin internal links — everything else
    // (external URLs, mailto:, #anchors, modifier-clicks for new tab,
    // target="_blank") navigates exactly as it would have before.
    if (!href || !href.startsWith("/")) return;
    if (a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey) return;

    e.preventDefault();
    root.classList.remove("page-morph-in");
    root.classList.add("page-morph-out");
    setTimeout(() => {
      location.href = href;
    }, 200);
  });
})();

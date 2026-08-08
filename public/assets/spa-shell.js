/**
 * spa-shell.js  (index.html only)
 *
 * Turns index.html into the one persistent shell (topbar + brand row +
 * announcement banner + Issue Submission sidebar) and mounts the OTHER
 * four pages' content (form.html, threads.html, announcements.html,
 * promo.html) into #spaMount instead of doing a real page navigation.
 *
 * Deliberately does NOT touch those four files' own markup/JS at all —
 * this fetches their real HTML, pulls out just the one content node it
 * needs (skipping their own topbar/back-pill, which index.html already
 * has its own copy of), and runs their own inline <script> as-is. This
 * means those four pages keep working completely unmodified if someone
 * loads them directly by URL — spa-shell.js is a pure addition, not a
 * rewrite of the existing per-page logic.
 *
 * Each view's script is fetched as TEXT once (cached) and executed via
 * `new Function(text)()` rather than a real re-inserted <script> tag —
 * a real <script> tag re-run a second time would throw
 * "Identifier already declared" on that page's own top-level const/let
 * (e.g. app.js's `const params = ...`). Function-wrapping gives every
 * activation its own fresh scope, so switching Deposit Request → QA →
 * Deposit Request again never collides with the previous run.
 */
(function () {
  const ROUTES = {
    form: { url: "/form.html", select: ".form-page", extScripts: ["/assets/app.js"] },
    threads: { url: "/threads.html", select: ["#attachLightbox", ".threads-shell"], extScripts: ["https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/twemoji.min.js"] },
    announcements: { url: "/announcements.html", select: ".threads-shell" },
    promo: { url: "/promo.html", select: ".promo-shell", styleSelect: "style" },
  };

  const htmlCache = new Map(); // route name -> parsed Document
  const scriptTextCache = new Map(); // absolute url -> script text
  const loadedExtScripts = new Set(); // src already present on the page
  const viewIntervals = { form: [], threads: [], announcements: [], promo: [] };
  let currentView = "home";
  let capturingFor = null;

  const realSetInterval = window.setInterval.bind(window);
  window.setInterval = function (...args) {
    const id = realSetInterval(...args);
    if (capturingFor && viewIntervals[capturingFor]) viewIntervals[capturingFor].push(id);
    return id;
  };

  function clearViewIntervals(view) {
    if (!viewIntervals[view]) return;
    viewIntervals[view].forEach((id) => clearInterval(id));
    viewIntervals[view] = [];
  }

  async function getDoc(route) {
    if (htmlCache.has(route)) return htmlCache.get(route);
    const res = await fetch(ROUTES[route].url);
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, "text/html");
    htmlCache.set(route, doc);
    return doc;
  }

  async function getScriptText(url) {
    if (scriptTextCache.has(url)) return scriptTextCache.get(url);
    const res = await fetch(url);
    const text = await res.text();
    scriptTextCache.set(url, text);
    return text;
  }

  function loadExternalScriptOnce(src) {
    if (loadedExtScripts.has(src) || document.querySelector(`script[src="${src}"]`)) {
      loadedExtScripts.add(src);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => { loadedExtScripts.add(src); resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function setSidebarActive(moduleId) {
    document.querySelectorAll(".sidebar-item").forEach((el) => el.classList.remove("active"));
    if (moduleId) {
      const el = document.querySelector(`.sidebar-item[data-module="${moduleId}"]`);
      if (el) el.classList.add("active");
    } else {
      const home = document.querySelector('.sidebar-item[href="/"]');
      if (home) home.classList.add("active");
    }
  }

  async function mount(view, { moduleId, pushUrl } = {}) {
    clearViewIntervals(currentView);
    currentView = view;

    const homeEl = document.getElementById("viewHome");
    const mountEl = document.getElementById("spaMount");

    if (view === "home") {
      mountEl.style.display = "none";
      mountEl.innerHTML = "";
      homeEl.style.display = "";
      setSidebarActive(null);
      if (pushUrl !== false) history.pushState({ view: "home" }, "", "/");
      window.dispatchEvent(new CustomEvent("spa:home"));
      return;
    }

    homeEl.style.display = "none";
    mountEl.style.display = "flex";
    mountEl.innerHTML = '<div class="spa-loading">Loading…</div>';
    setSidebarActive(moduleId || null);

    const cfg = ROUTES[view];
    const docPromise = getDoc(view);

    // Fire-and-forget: twemoji (or any other extScript) is a nice-to-have
    // (nicer emoji rendering), not a hard requirement — the page's own
    // script already checks `if (window.twemoji)` before using it, so it
    // degrades gracefully to native emoji if this hasn't finished yet.
    // Blocking the whole mount on a third-party CDN response (previously
    // `await`ed here) is what caused the long "Loading…" hang when that
    // CDN is slow or blocked on someone's network.
    if (cfg.extScripts) {
      cfg.extScripts.forEach((src) => {
        if (src.endsWith("app.js")) return;
        loadExternalScriptOnce(src).catch((err) => console.warn("[spa-shell] optional script failed to load:", src, err));
      });
    }

    const doc = await docPromise;

    if (pushUrl !== false) {
      const url = view === "form" ? `/form.html?module=${encodeURIComponent(moduleId || "")}` : cfg.url;
      history.pushState({ view, moduleId }, "", url);
      // form.html's own script reads location.search for the module id —
      // pushState above already updated it before we execute that script.
    }

    const selectors = Array.isArray(cfg.select) ? cfg.select : [cfg.select];
    const frag = document.createDocumentFragment();
    if (cfg.styleSelect) {
      doc.querySelectorAll(cfg.styleSelect).forEach((styleEl) => {
        if (!document.querySelector(`style[data-spa-src="${view}"]`)) {
          const clone = styleEl.cloneNode(true);
          clone.setAttribute("data-spa-src", view);
          document.head.appendChild(clone);
        }
      });
    }
    selectors.forEach((sel) => {
      const node = doc.querySelector(sel);
      if (node) frag.appendChild(node.cloneNode(true));
    });
    // Strip anything that's the shell's job now, not the mounted page's —
    // "Back to Home" (Home already lives in the sidebar) is the one
    // that matters, and on threads.html/announcements.html it sits
    // NESTED inside .threads-shell (not a sibling like on promo.html),
    // so it rides along with the clone above unless removed here.
    frag.querySelectorAll(".threads-topline, .back-pill").forEach((el) => el.remove());
    mountEl.innerHTML = "";
    mountEl.appendChild(frag);

    // Run the page's own inline <script> blocks (skip any with a src=
    // that isn't app.js, since those are shared libs already loaded by
    // index.html itself — see loadExternalScriptOnce above).
    const inlineScripts = Array.from(doc.querySelectorAll("script:not([src])")).map((s) => s.textContent);
    capturingFor = view;
    try {
      if (view === "form") {
        const appJsText = await getScriptText("/assets/app.js");
        new Function(appJsText)();
      }
      for (const text of inlineScripts) {
        if (!text || !text.trim()) continue;
        new Function(text)();
      }
    } catch (err) {
      console.error(`[spa-shell] error running ${view} script:`, err);
    } finally {
      capturingFor = null;
    }
  }

  function routeForClick(target) {
    const moduleLink = target.closest(".sidebar-item[data-module]");
    if (moduleLink) return { view: "form", moduleId: moduleLink.dataset.module };
    const homeLink = target.closest('.sidebar-item[href="/"]');
    if (homeLink) return { view: "home" };
    if (target.closest("#threadsCard")) return { view: "threads" };
    if (target.closest("#promoCard")) return { view: "promo" };
    if (target.closest("#announcementCard")) return { view: "announcements" };
    return null;
  }

  // Capture phase, ON PURPOSE: page-transition.js also listens for clicks
  // on any a[href^="/"] (its own exit-animation logic) at the default
  // bubble phase, and calls preventDefault() + a real location.href
  // navigation of its own. If this listener also ran at the bubble
  // phase, whichever script's <script> tag comes first in index.html
  // would "win" the race — and since page-transition.js already calls
  // preventDefault(), this listener would see e.defaultPrevented and
  // bail out, thinking something else already handled it, while
  // page-transition.js's setTimeout still fires a real navigation right
  // after. Capture phase runs before ANY bubble-phase listener, so this
  // always gets first look regardless of script load order; calling
  // stopImmediatePropagation() below then stops page-transition.js's
  // handler from running at all for clicks this router actually owns.
  document.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const route = routeForClick(e.target);
    if (!route) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    mount(route.view, route).catch((err) => console.error("[spa-shell] mount failed:", err));
  }, { capture: true });

  window.addEventListener("popstate", (e) => {
    const state = e.state;
    if (!state || state.view === "home") {
      mount("home", { pushUrl: false });
    } else {
      mount(state.view, { moduleId: state.moduleId, pushUrl: false });
    }
  });

  // Deep-link support: landing on / with ?module=xxx (an old bookmark,
  // or a real reload while a form view was open) opens straight into
  // that module's form instead of the home hero.
  document.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(location.search);
    const moduleId = params.get("module");
    if (moduleId) mount("form", { moduleId, pushUrl: false });
  });
})();

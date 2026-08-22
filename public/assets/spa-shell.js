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
    activityLogs: { url: "/activity-logs.html", select: ".threads-shell" },
  };

  const htmlCache = new Map(); // route name -> parsed Document
  const scriptTextCache = new Map(); // absolute url -> script text
  const loadedExtScripts = new Set(); // src already present on the page
  const viewIntervals = { form: [], threads: [], announcements: [], promo: [], activityLogs: [] };
  let currentView = "home";
  let capturingFor = null;

  // ---- BUGFIX (2026-08-22) — concurrent mount() race ----
  //
  // mount() is async and awaits a network/cache fetch (getDoc) before it
  // ever touches the DOM or runs the target view's own <script>. If a
  // second navigation (another click, popstate, or the DOMContentLoaded
  // deep-link) happens WHILE an earlier mount() call is still sitting at
  // that await, both calls end up racing to overwrite #spaMount and to
  // eval the target view's inline script — whichever call's await
  // happens to resolve LAST wins the DOM, regardless of which one the
  // user actually clicked last. Each eval'd script (threads.html,
  // announcements.html, etc.) also calls setInterval() to poll — if an
  // earlier, "lost" mount() call reaches that point, its timers still
  // get registered and keep firing against the shared #threadList /
  // tab-pill elements, fighting with whichever mount() actually won,
  // producing exactly the symptom reported: the Active/Solved/Recall
  // tab state randomly flipping on its own, plus "Cannot read
  // properties of null" errors when one call's script reads an element
  // another call has since replaced or removed.
  //
  // Fix mirrors the SAME pattern threads.html's own openThread() already
  // uses for its own request race (see detailRequestSeq there): every
  // mount() call claims a fresh generation number up front, and after
  // every await point checks whether it's still the most recent call
  // before doing anything further. A superseded call quietly bails out
  // — no DOM writes, no script eval, no timers registered — instead of
  // finishing its work on top of (or underneath) a newer navigation.
  let mountGeneration = 0;

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
    // Claim this call's generation number — see the BUGFIX note above.
    // Any await below can check `myGeneration !== mountGeneration` to
    // find out a newer mount() has since started, and bail out cleanly.
    const myGeneration = ++mountGeneration;

    clearViewIntervals(currentView);
    currentView = view;

    // Close the mobile Issue Submission drawer on EVERY route change,
    // not just clicks inside the sidebar itself — this is the one place
    // every transition funnels through (a click on Home/a module link/a
    // tool card, AND the browser back/forward button via popstate below)
    // so it's the only reliable spot to put this. Needed because
    // index.html's own sidebar click listener that used to handle this
    // never actually fires for these links: this file's click router
    // (see the capture-phase listener further down) calls
    // stopImmediatePropagation() on exactly the clicks that reach here,
    // which stops the event before it can bubble up to that listener.
    // Left as a no-op-safe optional call (not a hard dependency) since
    // this file is also usable, in principle, without index.html's
    // particular sidebar markup.
    if (window.closeMobileSidebar) window.closeMobileSidebar();

    const homeEl = document.getElementById("viewHome");
    const mountEl = document.getElementById("spaMount");

    if (view === "home") {
      mountEl.style.display = "none";
      mountEl.innerHTML = "";
      mountEl.removeAttribute("data-view");
      homeEl.style.display = "";
      setSidebarActive(null);
      if (pushUrl !== false) history.pushState({ view: "home" }, "", "/");
      window.dispatchEvent(new CustomEvent("spa:home"));
      return;
    }

    homeEl.style.display = "none";
    mountEl.style.display = "flex";
    // Which exact view is mounted — needed so CSS can single out just
    // Threads (auto-collapsing the persistent ISSUE SUBMISSION sidebar
    // on narrower windows well before the general breakpoint kicks in,
    // see style.css's `body:has(#spaMount[data-view="threads"])` block)
    // without also catching other routes that don't bring their own
    // extra 340px ticket-list column and so don't have the same "not
    // enough width for a 3rd column" problem.
    mountEl.setAttribute("data-view", view);
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

    // A newer mount() call has started while this one was awaiting the
    // doc — someone navigated again before this fetch/cache-read
    // finished. Bail out now, before touching history, the DOM, or
    // running any script: whichever call is still current already has
    // (or will have) its own fresh doc and will render on top of
    // whatever's there. Applying this stale one now would either get
    // immediately overwritten (harmless but wasteful) or, worse, land
    // AFTER the newer call finishes and clobber it — see the BUGFIX
    // note above mountGeneration's declaration for the full writeup.
    if (myGeneration !== mountGeneration) return;

    if (pushUrl !== false) {
      // ALWAYS push a "/" URL (never the real /threads.html, /form.html
      // etc.) — Cloudflare Pages serves those paths as their own real,
      // separate static file, so a hard refresh while pushState pointed
      // at one would load that standalone page directly instead of this
      // shell (index.html never even runs). Keeping the address on "/"
      // with a query string means a refresh always re-requests index.html,
      // and the DOMContentLoaded bootstrap below reads that same query
      // string to remount the right view.
      const url = view === "form" ? `/?module=${encodeURIComponent(moduleId || "")}` : `/?view=${view}`;
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
        // Same check as above, needed again here specifically because
        // getScriptText() is its own await point — a newer mount() can
        // have started (and even finished) while this one was fetching
        // app.js. Skip running it (and the inline scripts below) if so;
        // running form.html's script now would register its own
        // setInterval-free logic against a #spaMount that's no longer
        // showing form.html at all.
        if (myGeneration !== mountGeneration) return;
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
    if (target.closest("#subActivityLogs")) return { view: "activityLogs" };
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

  // Deep-link support: landing on / with ?module=xxx (a form) or
  // ?view=xxx (threads/announcements/promo) opens straight into that
  // view instead of the home hero — this is what makes a hard refresh
  // land back where you were, now that mount() always pushes a "/" URL
  // (see the pushUrl block above) instead of the real per-page file path.
  document.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(location.search);
    const moduleId = params.get("module");
    const view = params.get("view");
    if (moduleId) mount("form", { moduleId, pushUrl: false });
    else if (view && ROUTES[view]) mount(view, { pushUrl: false });
  });
})();

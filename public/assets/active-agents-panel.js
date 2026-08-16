/**
 * active-agents-panel.js  (Active Agents online-status panel — UI)
 *
 * Renders into pre-existing DOM in index.html:
 *   Roster modal:        #aaModalBackdrop (header, 3 stat-card filters,
 *                         #aaSearchInput, #aaRosterWrap, footer)
 *   Record search modal: #aaRecordSearchBackdrop (#aaRecordSearchInput,
 *                         #aaRecordList)
 *   Record detail modal: #aaRecordDetailBackdrop (#aaRecordTableBody, ...)
 *
 * THREE-LAYER RENDERING MODEL (see architecture doc §5.5 — this is the
 * fix for "typing in the search box gets wiped out by the next poll"):
 *   1. ensureShell()   — runs ONCE per page load, on first open(). Binds
 *      every input/button listener. NEVER re-runs, so those DOM nodes
 *      are never destroyed/recreated by a poll.
 *   2. renderDynamic() — runs on every 10s poll AND every filter click/
 *      search keystroke. Rewrites ONLY #aaRosterWrap (+ the stat numbers)
 *      — never touches the search input or the stat-card buttons
 *      themselves.
 *   3. startTimeTicking() — a separate 2s timer that only updates
 *      `textContent` on elements tagged data-aa-heartbeat, so "3s ago"
 *      counts up smoothly between polls with no network request.
 */
(function () {
  const POLL_INTERVAL_MS = 10 * 1000;
  const TIME_TICK_INTERVAL_MS = 2 * 1000;
  const AVATAR_COLORS = ["#3b82f6", "#f87171", "#eab308", "#f97316", "#22c55e", "#a855f7", "#ec4899", "#14b8a6"];

  let shellReady = false;
  let pollTimer = null;
  let tickTimer = null;
  let lastAgents = [];
  let filterKind = "all"; // "all" | "online" | "offline"

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function colorFor(username) {
    let h = 0;
    for (const c of username) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function initials(fullName, username) {
    const name = (fullName || "").trim();
    if (name) {
      const parts = name.split(/\s+/);
      const two = (parts[0][0] || "") + (parts[1] ? parts[1][0] : "");
      if (two) return two.toUpperCase();
    }
    return (username || "?").slice(0, 2).toUpperCase();
  }

  function timeAgo(iso) {
    if (!iso) return "Never online";
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return "just now";
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " min ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function formatDuration(ms) {
    if (!ms) return "0s";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m " + s + "s";
    return s + "s";
  }

  function formatClock(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  // ---- shell (bound once) ----

  function ensureShell() {
    if (shellReady) return;
    shellReady = true;

    const closeBtn = document.getElementById("aaModalClose");
    const backdrop = document.getElementById("aaModalBackdrop");
    if (closeBtn) closeBtn.addEventListener("click", close);
    if (backdrop) backdrop.addEventListener("click", function (e) { if (e.target === backdrop) close(); });

    const search = document.getElementById("aaSearchInput");
    if (search) search.addEventListener("input", renderDynamic);

    const refreshBtn = document.getElementById("aaRefreshBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", async () => {
      // Same spin/disable/minimum-visible-duration pattern as TG Reply
      // Threads' and Activity Logs' refresh buttons — deliberately NOT
      // put inside poll() itself, since poll() also runs silently every
      // POLL_INTERVAL_MS from startPolling() and shouldn't spin the
      // button on every background tick, only on an actual manual click.
      if (refreshBtn.disabled) return;
      refreshBtn.classList.add("spinning");
      refreshBtn.disabled = true;
      const startedAt = Date.now();
      const MIN_VISIBLE_MS = 600;
      try {
        await poll();
      } finally {
        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_VISIBLE_MS) await new Promise((r) => setTimeout(r, MIN_VISIBLE_MS - elapsed));
        refreshBtn.classList.remove("spinning");
        refreshBtn.disabled = false;
      }
    });

    document.querySelectorAll(".aa-stat-card").forEach(function (card) {
      card.addEventListener("click", function () {
        filterKind = card.getAttribute("data-aa-filter");
        document.querySelectorAll(".aa-stat-card").forEach(function (c) { c.classList.toggle("is-active", c === card); });
        renderDynamic();
      });
    });

    // Record: header button -> search picker
    const openRecordBtn = document.getElementById("aaOpenRecordBtn");
    if (openRecordBtn) openRecordBtn.addEventListener("click", openRecordSearch);

    const recSearchClose = document.getElementById("aaRecordSearchClose");
    const recSearchBackdrop = document.getElementById("aaRecordSearchBackdrop");
    if (recSearchClose) recSearchClose.addEventListener("click", closeRecordSearch);
    if (recSearchBackdrop) recSearchBackdrop.addEventListener("click", function (e) { if (e.target === recSearchBackdrop) closeRecordSearch(); });

    const recSearchInput = document.getElementById("aaRecordSearchInput");
    if (recSearchInput) recSearchInput.addEventListener("input", renderRecordList);

    const recDetailClose = document.getElementById("aaRecordDetailClose");
    const recDetailBackdrop = document.getElementById("aaRecordDetailBackdrop");
    if (recDetailClose) recDetailClose.addEventListener("click", closeRecordDetail);
    if (recDetailBackdrop) recDetailBackdrop.addEventListener("click", function (e) { if (e.target === recDetailBackdrop) closeRecordDetail(); });

    const backBtn = document.getElementById("aaBackToSearchBtn");
    if (backBtn) backBtn.addEventListener("click", function () { closeRecordDetail(); openRecordSearch(); });
  }

  function currentSearch() {
    const search = document.getElementById("aaSearchInput");
    return search ? search.value.trim().toLowerCase() : "";
  }

  function applyFilters() {
    const search = currentSearch();
    return lastAgents.filter(function (a) {
      if (filterKind === "online" && a.status !== "online") return false;
      if (filterKind === "offline" && a.status !== "offline") return false;
      if (search) {
        const hay = (a.username + " " + (a.fullName || "")).toLowerCase();
        if (hay.indexOf(search) === -1) return false;
      }
      return true;
    });
  }

  // ---- roster: rewritten every poll/filter/search ----

  function renderDynamic() {
    const rosterWrap = document.getElementById("aaRosterWrap");
    if (!rosterWrap) return;

    const onlineCount = lastAgents.filter(function (a) { return a.status === "online"; }).length;
    const totalCount = lastAgents.length;

    const totalEl = document.getElementById("aaStatTotal");
    const onlineEl = document.getElementById("aaStatOnline");
    const offlineEl = document.getElementById("aaStatOffline");
    if (totalEl) totalEl.textContent = totalCount;
    if (onlineEl) onlineEl.textContent = onlineCount;
    if (offlineEl) offlineEl.textContent = totalCount - onlineCount;

    const pill = document.getElementById("aaOnlinePill");
    if (pill) {
      pill.textContent = onlineCount + " online";
      pill.classList.toggle("aa-breathing", onlineCount > 0);
    }
    const sub = document.getElementById("aaHeadSub");
    if (sub) sub.textContent = totalCount + " agents tracked · updates live";

    const filtered = applyFilters();
    if (!filtered.length) {
      rosterWrap.innerHTML = '<div class="aa-empty">' + (totalCount ? "No agents match." : "No agents to show.") + '</div>';
      return;
    }

    rosterWrap.innerHTML = filtered.map(function (a) {
      const isOn = a.status === "online";
      const badges = [
        a.role ? '<span class="aa-badge">🎫 ' + escapeHtml(a.role) + '</span>' : "",
        a.device ? '<span class="aa-badge">💻 ' + escapeHtml(a.device) + '</span>' : "",
        a.officeName ? '<span class="aa-badge">🏢 ' + escapeHtml(a.officeName) + '</span>' : "",
      ].join("");
      return (
        '<div class="aa-row">' +
        '<div class="aa-avatar" style="background:' + colorFor(a.username) + '">' + escapeHtml(initials(a.fullName, a.username)) +
        '<span class="aa-presence-dot ' + (isOn ? "aa-on" : "aa-off") + '"></span></div>' +
        '<div class="aa-row-main">' +
        '<div class="aa-row-name">' + escapeHtml(a.username) + '</div>' +
        (a.fullName ? '<div class="aa-row-full">' + escapeHtml(a.fullName) + '</div>' : "") +
        '<div class="aa-badges">' + badges + '</div>' +
        '</div>' +
        '<div class="aa-row-right">' +
        '<span class="aa-status-pill ' + (isOn ? "aa-on" : "aa-off") + '"><span class="aa-dot"></span>' + (isOn ? "Online" : "Offline") + '</span>' +
        '<div class="aa-row-time" data-aa-heartbeat="' + escapeHtml(a.lastActiveAt || "") + '">' + timeAgo(a.lastActiveAt) + '</div>' +
        '</div>' +
        '</div>'
      );
    }).join("");
  }

  function startTimeTicking() {
    stopTimeTicking();
    tickTimer = setInterval(function () {
      const rosterWrap = document.getElementById("aaRosterWrap");
      if (!rosterWrap) return;
      rosterWrap.querySelectorAll("[data-aa-heartbeat]").forEach(function (el) {
        el.textContent = timeAgo(el.getAttribute("data-aa-heartbeat") || null);
      });
    }, TIME_TICK_INTERVAL_MS);
  }
  function stopTimeTicking() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function poll() {
    if (!window.AgentAuth) return Promise.resolve();
    return window.AgentAuth.authFetch("/api/presence/list", { cache: "no-store" })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok) {
          const rosterWrap = document.getElementById("aaRosterWrap");
          if (rosterWrap) rosterWrap.innerHTML = '<div class="aa-empty aa-error">' + escapeHtml(data.error || "Failed to load.") + '</div>';
          return;
        }
        lastAgents = data.agents || [];
        renderDynamic();
      })
      .catch(function () {
        // Non-fatal — next poll cycle will try again.
      });
  }

  function startPolling() {
    stopPolling();
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function open() {
    ensureShell();
    const backdrop = document.getElementById("aaModalBackdrop");
    if (!backdrop) return;
    backdrop.classList.add("is-open");
    const search = document.getElementById("aaSearchInput");
    if (search) search.value = "";
    filterKind = "all";
    document.querySelectorAll(".aa-stat-card").forEach(function (c) { c.classList.toggle("is-active", c.getAttribute("data-aa-filter") === "all"); });
    startPolling();
    startTimeTicking();
  }

  function close() {
    const backdrop = document.getElementById("aaModalBackdrop");
    if (backdrop) backdrop.classList.remove("is-open");
    stopPolling();
    stopTimeTicking();
  }

  // ---- record: search picker ----

  function renderRecordList() {
    const list = document.getElementById("aaRecordList");
    if (!list) return;
    const search = document.getElementById("aaRecordSearchInput");
    const q = search ? search.value.trim().toLowerCase() : "";
    const filtered = lastAgents.filter(function (a) {
      return !q || (a.username + " " + (a.fullName || "")).toLowerCase().indexOf(q) !== -1;
    });

    if (!filtered.length) {
      list.innerHTML = '<div class="aa-empty">No agents match.</div>';
      return;
    }
    list.innerHTML = filtered.map(function (a) {
      return (
        '<div class="aa-rec-pick-row" data-username="' + escapeHtml(a.username) + '">' +
        '<div class="aa-avatar" style="width:30px;height:30px;font-size:11px;background:' + colorFor(a.username) + '">' + escapeHtml(initials(a.fullName, a.username)) + '</div>' +
        '<div class="aa-rec-pick-name">' + escapeHtml(a.username) + '</div>' +
        '<span class="aa-rec-pick-dot" style="background:' + (a.status === "online" ? "var(--aa-green)" : "var(--ink-soft)") + '"></span>' +
        '</div>'
      );
    }).join("");
    list.querySelectorAll(".aa-rec-pick-row").forEach(function (row) {
      row.addEventListener("click", function () { openRecordDetail(row.getAttribute("data-username")); });
    });
  }

  function openRecordSearch() {
    const backdrop = document.getElementById("aaRecordSearchBackdrop");
    if (!backdrop) return;
    const input = document.getElementById("aaRecordSearchInput");
    if (input) input.value = "";
    // If the roster hasn't been polled yet (Record opened before the
    // roster modal), fetch once so the picker isn't empty.
    if (!lastAgents.length) poll().then(renderRecordList);
    else renderRecordList();
    backdrop.classList.add("is-open");
  }
  function closeRecordSearch() {
    const backdrop = document.getElementById("aaRecordSearchBackdrop");
    if (backdrop) backdrop.classList.remove("is-open");
  }

  // ---- record: detail ----

  function openRecordDetail(username) {
    closeRecordSearch();
    const backdrop = document.getElementById("aaRecordDetailBackdrop");
    const body = document.getElementById("aaRecordTableBody");
    if (!backdrop || !body) return;

    document.getElementById("aaRecAvatar").style.background = colorFor(username);
    document.getElementById("aaRecAvatar").textContent = initials(null, username);
    document.getElementById("aaRecAgentName").textContent = username;
    document.getElementById("aaRecAgentSub").textContent = "Loading…";
    body.innerHTML = '<tr><td colspan="3" class="aa-empty">Loading…</td></tr>';
    backdrop.classList.add("is-open");

    if (!window.AgentAuth) return;
    window.AgentAuth.authFetch("/api/presence/record?username=" + encodeURIComponent(username) + "&days=7", { cache: "no-store" })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok) {
          document.getElementById("aaRecAgentSub").textContent = "";
          body.innerHTML = '<tr><td colspan="3" class="aa-empty aa-error">' + escapeHtml(data.error || "Failed to load.") + '</td></tr>';
          return;
        }

        if (data.fullName) document.getElementById("aaRecAvatar").textContent = initials(data.fullName, data.username);

        const isOn = data.status === "online";
        const pill = document.getElementById("aaRecStatusPill");
        pill.className = "aa-status-pill " + (isOn ? "aa-on" : "aa-off");
        pill.innerHTML = '<span class="aa-dot"></span>' + (isOn ? "Online" : "Offline");

        document.getElementById("aaRecAgentSub").textContent =
          timeAgo(data.lastActiveAt) + " · Today online: " + formatDuration(data.todayOnlineMs) + " · Last active: " + formatClock(data.lastActiveAt);

        body.innerHTML = data.days.map(function (d, i) {
          const isToday = i === 0;
          const label = isToday ? "Today" : new Date(d.date + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric" });
          return (
            '<tr class="' + (isToday ? "aa-today" : "") + '">' +
            '<td>' + escapeHtml(label) + '</td>' +
            '<td>' + formatDuration(d.totalOnlineMs) + '</td>' +
            '<td>' + (d.lastActiveAt ? formatClock(d.lastActiveAt) : "—") + '</td>' +
            '</tr>'
          );
        }).join("");
      })
      .catch(function () {
        document.getElementById("aaRecAgentSub").textContent = "";
        body.innerHTML = '<tr><td colspan="3" class="aa-empty aa-error">Failed to load.</td></tr>';
      });
  }

  function closeRecordDetail() {
    const backdrop = document.getElementById("aaRecordDetailBackdrop");
    if (backdrop) backdrop.classList.remove("is-open");
  }

  window.ActiveAgentsPanel = { open: open, close: close };
})();

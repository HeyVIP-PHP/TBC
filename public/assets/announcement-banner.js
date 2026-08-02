/**
 * announcement-banner.js
 *
 * Self-executing, include once per page, AFTER authguard.js has already
 * run (needs window.AgentAuth.authFetch):
 *   <div id="announcementBanner"></div>
 *   <script src="/assets/announcement-banner.js" defer></script>
 *
 * Behavior:
 *   - Fetches /api/announcements on load and every 60s.
 *   - 0 active -> renders nothing (#announcementBanner:empty is
 *     display:none via CSS).
 *   - 1 active -> static, no rotation.
 *   - 2+ active -> rotates using the server's rotateIntervalMs. Outgoing
 *     text fades out in place; incoming text slides in as a complete
 *     block from the right (~2.2s), not a typewriter effect and not an
 *     instant swap. The DOM skeleton is built ONCE per data-change
 *     (buildSkeleton()); each rotation tick (showItem()) only touches the
 *     two overlapping text nodes — a full innerHTML replace every tick
 *     would leave no "from" state for the CSS transition to animate out
 *     of.
 *   - Label (top-left) shows the announcement's topic in caps, falling
 *     back to "REMINDER" for older records with no topic.
 *   - Dismiss (X) is in-memory only — hides that one announcement for
 *     the rest of this page load; a refresh brings it back.
 *
 * Exposes window.refreshAnnouncementBanner() — call after any action
 * that just changed the data (Save/Delete on the management page, saving
 * the rotation-speed setting) so THIS device updates instantly instead of
 * waiting up to 60s for the next poll.
 */
(function () {
  const POLL_MS = 60000;
  const ROTATE_TRANSITION_MS = 2200;

  let container = null;
  let items = [];
  let rotateIntervalMs = 5000;
  let rotateTimer = null;
  let currentIndex = 0;
  let dismissed = new Set(); // in-memory only, per page load

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function visibleItems() {
    return items.filter((a) => !dismissed.has(a.id));
  }

  function buildSkeleton() {
    const visible = visibleItems();
    if (!visible.length) {
      container.innerHTML = "";
      return;
    }
    const dotsHtml = visible.length > 1
      ? `<div class="ann-dots">${visible.map((_, i) => `<span class="ann-dot${i === 0 ? " active" : ""}" data-i="${i}"></span>`).join("")}</div>`
      : "";
    container.innerHTML = `
      <div class="ann-banner">
        <div class="ann-icon breathing" aria-hidden="true">📢</div>
        <div class="ann-body">
          <div class="ann-label breathing" id="annLabel"></div>
          <div class="ann-text-stage">
            <div class="ann-text ann-text-current" id="annTextCurrent"></div>
            <div class="ann-text ann-text-incoming" id="annTextIncoming"></div>
          </div>
          ${dotsHtml}
        </div>
        <button type="button" class="ann-dismiss" id="annDismiss" title="Dismiss" aria-label="Dismiss">✕</button>
      </div>`;
    document.getElementById("annDismiss").addEventListener("click", () => {
      const v = visibleItems();
      const a = v[currentIndex];
      if (a) dismissed.add(a.id);
      currentIndex = 0;
      render();
    });
  }

  function showItem(index, animate) {
    const visible = visibleItems();
    if (!visible.length) return;
    const a = visible[index];
    const label = (a.topic || "REMINDER").toUpperCase();
    const labelEl = document.getElementById("annLabel");
    const currentEl = document.getElementById("annTextCurrent");
    const incomingEl = document.getElementById("annTextIncoming");
    if (!labelEl || !currentEl || !incomingEl) return;

    labelEl.textContent = label;

    if (!animate) {
      currentEl.textContent = a.text;
      currentEl.classList.remove("ann-fade-out");
      incomingEl.textContent = "";
      incomingEl.classList.remove("ann-slide-in");
    } else {
      // Outgoing: fade out in place. Incoming: slide in as a complete
      // block from the right. Both run concurrently via CSS transitions
      // on these two persistent nodes. `currentEl` stays in normal flow
      // throughout (so it keeps controlling the stage's real height as
      // the message wraps to however many lines it needs) — `incomingEl`
      // only ever overlays it as an absolutely-positioned element during
      // the transition, then gets emptied once the swap below lands.
      incomingEl.textContent = a.text;
      currentEl.classList.add("ann-fade-out");
      incomingEl.classList.add("ann-slide-in");
      setTimeout(() => {
        currentEl.textContent = a.text;
        currentEl.classList.remove("ann-fade-out");
        incomingEl.textContent = "";
        incomingEl.classList.remove("ann-slide-in");
      }, ROTATE_TRANSITION_MS);
    }

    container.querySelectorAll(".ann-dot").forEach((dot, i) => {
      dot.classList.toggle("active", i === index);
    });
  }

  function stopRotation() {
    if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  }

  function startRotation() {
    stopRotation();
    const visible = visibleItems();
    if (visible.length < 2) return;
    rotateTimer = setInterval(() => {
      const v = visibleItems();
      if (v.length < 2) { stopRotation(); return; }
      currentIndex = (currentIndex + 1) % v.length;
      showItem(currentIndex, true);
    }, Math.max(1000, rotateIntervalMs));
  }

  function render() {
    if (!container) return;
    const visible = visibleItems();
    stopRotation();
    if (!visible.length) {
      container.innerHTML = "";
      return;
    }
    if (currentIndex >= visible.length) currentIndex = 0;
    buildSkeleton();
    showItem(currentIndex, false);
    startRotation();
  }

  async function fetchAndRender() {
    if (!window.AgentAuth) return;
    try {
      const res = await window.AgentAuth.authFetch("/api/announcements", { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) return;
      items = data.announcements || [];
      rotateIntervalMs = data.rotateIntervalMs || rotateIntervalMs;
      // Drop dismiss entries for announcements that no longer exist/are
      // no longer active, so the Set doesn't grow unbounded across polls.
      const liveIds = new Set(items.map((a) => a.id));
      dismissed.forEach((id) => { if (!liveIds.has(id)) dismissed.delete(id); });
      render();
    } catch {
      // Non-fatal — banner just doesn't update this cycle.
    }
  }

  function init() {
    container = document.getElementById("announcementBanner");
    if (!container) return;
    fetchAndRender();
    setInterval(fetchAndRender, POLL_MS);
  }

  window.refreshAnnouncementBanner = fetchAndRender;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

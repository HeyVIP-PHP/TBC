/**
 * toast.js
 *
 * Centered popup notification — window.showToast(message, type). A
 * single reusable overlay (position:fixed; inset:0) + centered card,
 * pointer-events:none throughout (it's a notification, not a modal —
 * never blocks clicking things underneath), dims the backdrop briefly,
 * auto-fades after ~2s.
 *
 * type: "ok" | "err" | omitted (neutral). Used for every Save/Delete/
 * Create-type action across the admin modal (Settings rows, Create
 * Account, Whitelist IP, TG Group·Channel, Agent Profile, Reset
 * Password, Announcement rotation speed, the Announcement management
 * page) and the submission form, so the same "Saved."/"Submitted."/
 * "<reason> failed." feedback looks and behaves identically everywhere.
 *
 * Include once per page: <script src="/assets/toast.js"></script>
 */
(function () {
  const AUTO_FADE_MS = 2200;
  let overlay = null;
  let card = null;
  let hideTimer = null;

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "toast-overlay";
    card = document.createElement("div");
    card.className = "toast-card";
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  window.showToast = function (message, type) {
    if (!message) return;
    ensureDom();
    clearTimeout(hideTimer);
    card.textContent = message;
    card.className = "toast-card" + (type ? " toast-" + type : "");
    // Force a reflow so re-triggering the same message while still
    // visible restarts the fade-in transition instead of no-op'ing.
    overlay.classList.remove("toast-show");
    void overlay.offsetWidth;
    overlay.classList.add("toast-show");
    hideTimer = setTimeout(() => {
      overlay.classList.remove("toast-show");
    }, AUTO_FADE_MS);
  };
})();

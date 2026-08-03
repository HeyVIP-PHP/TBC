/**
 * toast.js
 *
 * Centered popup notification — window.showToast(message, type). A
 * single reusable overlay (position:fixed; inset:0) + centered card,
 * pointer-events:none throughout (it's a notification, not a modal —
 * never blocks clicking things underneath).
 *
 * Two very different lifetimes by design (2026-08, explicit business-
 * owner request):
 *   - type "ok": auto-fades after 3s. A save/reset/delete/forward/edit
 *     that WORKED doesn't need to stick around — nobody wants a stack of
 *     old success bubbles piling up.
 *   - type "err": does NOT auto-dismiss. It stays up until the person
 *     clicks ANYWHERE on the page — reading a specific error long enough
 *     to actually act on it matters more than a tidy timer, and a fixed
 *     couple of seconds isn't reliably enough time for that. Dismissing
 *     on the next click (rather than a click on the toast itself, which
 *     is pointer-events:none) means no extra step is needed — whatever
 *     the person does next just clears it.
 *   - omitted/neutral type: falls back to the "ok" 3s behavior.
 *
 * type: "ok" | "err" | omitted (neutral). Used for every Save/Delete/
 * Reset/Forward/Create-type action across the admin modal (Settings
 * rows, Create Account, Whitelist IP, TG Group·Channel, Agent Profile,
 * Reset Password, Announcement rotation speed, the Announcement
 * management page) and the submission form, so the same "X success."/
 * "X failed." feedback looks and behaves identically everywhere.
 *
 * Include once per page: <script src="/assets/toast.js"></script>
 */
(function () {
  const AUTO_FADE_MS = 3000;
  let overlay = null;
  let card = null;
  let hideTimer = null;
  let dismissOnClick = null;

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "toast-overlay";
    card = document.createElement("div");
    card.className = "toast-card";
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  function hide() {
    overlay.classList.remove("toast-show");
    clearDismissListener();
  }

  function clearDismissListener() {
    if (dismissOnClick) {
      document.removeEventListener("click", dismissOnClick, true);
      dismissOnClick = null;
    }
  }

  window.showToast = function (message, type) {
    if (!message) return;
    ensureDom();
    clearTimeout(hideTimer);
    clearDismissListener();
    card.className = "toast-card" + (type ? " toast-" + type : "");
    if (type === "err") {
      card.innerHTML = "";
      const line = document.createElement("div");
      line.textContent = message;
      const hint = document.createElement("div");
      hint.className = "toast-hint";
      hint.textContent = "Click anywhere to dismiss";
      card.appendChild(line);
      card.appendChild(hint);
    } else {
      card.textContent = message;
    }
    overlay.className = "toast-overlay" + (type === "err" ? " toast-overlay-err" : "");
    // Force a reflow so re-triggering the same message while still
    // visible restarts the fade-in transition instead of no-op'ing.
    overlay.classList.remove("toast-show");
    void overlay.offsetWidth;
    overlay.classList.add("toast-show");

    if (type === "err") {
      // Stays open until the NEXT click anywhere on the page. The click
      // that triggered this very error (e.g. clicking "Save") has
      // already fully finished dispatching by the time this runs — this
      // always fires after an async response — so it can't immediately
      // self-dismiss on its own trigger.
      dismissOnClick = hide;
      document.addEventListener("click", dismissOnClick, true);
    } else {
      hideTimer = setTimeout(hide, AUTO_FADE_MS);
    }
  };
})();

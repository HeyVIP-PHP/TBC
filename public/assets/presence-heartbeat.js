/**
 * presence-heartbeat.js  (Active Agents online-status panel — client)
 *
 * Include on every page that requires login, AFTER authguard.js (it
 * depends on window.AgentAuth being set up already).
 *
 * Sends a heartbeat every HEARTBEAT_INTERVAL_MS while the tab is open,
 * and one last "offline" beacon on pagehide. Throttling/write-amplification
 * protection all happens server-side (see functions/_shared/presence.js)
 * — this file does NOT try to be clever about when to send; that's the
 * whole point of the design (see the architecture doc, §四.2).
 *
 * Deliberately silent on failure — a missed heartbeat just means this
 * agent looks offline a bit sooner than they'd like; it must never
 * surface an error toast or otherwise interrupt someone's actual work.
 */
(function () {
  const HEARTBEAT_INTERVAL_MS = 15 * 1000;

  function getDevice() {
    try {
      const ua = navigator.userAgent || "";
      if (/Mobi|Android/i.test(ua)) return "mobile";
      return "desktop";
    } catch {
      return null;
    }
  }

  function sendHeartbeat(action) {
    if (!window.AgentAuth) return;
    const auth = window.AgentAuth.getAuth ? window.AgentAuth.getAuth() : null;
    if (!auth || !auth.token) return; // not logged in yet / already logged out

    const body = JSON.stringify({ action: action || "heartbeat", device: getDevice() });

    // Use a plain fetch (not authFetch) with keepalive so the request
    // can still complete during pagehide, when the tab is being torn
    // down — authFetch's 401 -> redirect-to-login behavior would also
    // be unwanted/unreliable at that exact moment.
    try {
      fetch("/api/presence/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-Token": auth.token },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Non-fatal — see file header.
    }
  }

  sendHeartbeat("heartbeat");
  setInterval(function () {
    sendHeartbeat("heartbeat");
  }, HEARTBEAT_INTERVAL_MS);

  window.addEventListener("pagehide", function () {
    sendHeartbeat("offline");
  });
})();

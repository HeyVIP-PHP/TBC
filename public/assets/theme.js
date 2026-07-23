(function () {
  // Applied as early as possible (this script is loaded in <head>) so the
  // page never flashes the wrong theme on load.
  const saved = localStorage.getItem("theme");
  const theme = saved || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);

  window.initThemeToggle = function () {
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    const setLabel = () => {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      btn.innerHTML = isDark ? "☀️ Light" : "🌙 Dark";
    };
    setLabel();
    btn.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);
      setLabel();
    });
  };

  window.initClock = function () {
    const el = document.getElementById("liveClock");
    if (!el) return;
    const tick = () => {
      const now = new Date();
      const day = now.toLocaleDateString(undefined, { weekday: "long" });
      const date = now.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" });
      const time = now.toLocaleTimeString(undefined, { hour12: false });
      // Colored segments (day/date/time) + a real vertical-bar divider
      // between each, instead of the previous single plain-text string.
      el.innerHTML =
        `<span class="clock-day">${day}</span>` +
        `<span class="clock-divider"></span>` +
        `<span class="clock-date">${date}</span>` +
        `<span class="clock-divider"></span>` +
        `<span class="clock-time">${time}</span>`;
    };
    tick();
    setInterval(tick, 1000);
  };
})();

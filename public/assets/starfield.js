/**
 * starfield.js
 *
 * The animated space-photo background (confirmed design: user-supplied
 * photo + slow "breathing" zoom + subtle mouse-parallax + a twinkling
 * star overlay + a meteor shower overlay), injected into every page that
 * includes this script rather than duplicated as markup in all 6 HTML
 * files. Active in BOTH themes — dark theme shows the photo as-is with a
 * dark shading gradient (see --sf-shade in style.css); light theme
 * brightens the same photo (a CSS filter) and shades it with a light
 * lavender-tinted overlay instead, so it fits the light theme's own
 * pastel palette rather than just dropping a dark photo onto a light
 * page. Both variants are theme CSS variables (--sf-shade, --sf-filter)
 * — this script itself doesn't care which theme is active, it just
 * mounts once and CSS handles the rest via [data-theme].
 *
 * Respects prefers-reduced-motion: shows the photo as a plain static
 * background with no zoom/parallax/stars/meteors for anyone with that
 * OS-level preference set, rather than ignoring it.
 */
(function () {
  const STAR_COUNT = 60;
  const METEOR_COUNT = 22;
  let mounted = false;
  let root = null;

  function reducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function buildStars() {
    let html = "";
    for (let i = 0; i < STAR_COUNT; i++) {
      const size = (Math.random() * 1.6 + 0.6).toFixed(2);
      const top = (Math.random() * 100).toFixed(2);
      const left = (Math.random() * 100).toFixed(2);
      const dur = (Math.random() * 3 + 2).toFixed(2);
      const delay = (Math.random() * 5).toFixed(2);
      const maxOp = (Math.random() * 0.5 + 0.5).toFixed(2);
      html += `<div class="sf-star" style="width:${size}px;height:${size}px;top:${top}%;left:${left}%;animation-duration:${dur}s;animation-delay:-${delay}s;--sf-max-op:${maxOp};"></div>`;
    }
    return html;
  }

  function buildMeteors() {
    let html = "";
    for (let i = 0; i < METEOR_COUNT; i++) {
      const top = (Math.random() * 60 - 15).toFixed(1);
      const left = (Math.random() * 90 - 10).toFixed(1);
      const dur = (Math.random() * 2.5 + 2.2).toFixed(2);
      const delay = (Math.random() * 8).toFixed(2);
      html += `<div class="sf-meteor" style="top:${top}%; left:${left}%; animation-duration:${dur}s; animation-delay:-${delay}s;"></div>`;
    }
    return html;
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    root = document.createElement("div");
    root.id = "starfieldRoot";
    root.innerHTML = `
      <div class="sf-bgwrap"><div class="sf-bgimg" id="sfBgImg"></div></div>
      <div class="sf-shade"></div>
      <div class="sf-stars">${reducedMotion() ? "" : buildStars()}</div>
      <div class="sf-meteors">${reducedMotion() ? "" : buildMeteors()}</div>
    `;
    if (reducedMotion()) root.classList.add("sf-static");
    document.body.insertBefore(root, document.body.firstChild);

    if (!reducedMotion()) {
      const bgimg = document.getElementById("sfBgImg");
      document.addEventListener("mousemove", (e) => {
        const x = (e.clientX / window.innerWidth - 0.5) * 2;
        const y = (e.clientY / window.innerHeight - 0.5) * 2;
        bgimg.style.setProperty("--sf-parallax", `translate(${(x * -14).toFixed(1)}px, ${(y * -10).toFixed(1)}px)`);
      });
    }
  }

  // Mounted once on load — active in both themes now, so there's no
  // theme-triggered mount/unmount to watch for anymore. Only the CSS
  // (keyed off [data-theme]) changes look between themes.
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();

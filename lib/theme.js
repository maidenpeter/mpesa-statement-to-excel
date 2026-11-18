/* The site's two themes: ink (the default) and paper. The choice is the one made on maidenpeter.github.io,
   which shares this origin and its "mp-theme" setting. Loaded in the head, so the page is drawn in the
   right theme from the start; the switch itself is in lib/nav.js, the site's navigation script.
   Only the theme is stored: nothing from a statement ever is. */
(function () {
  "use strict";
  try {
    var t = localStorage.getItem("mp-theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* storage blocked: stay on ink */ }
})();

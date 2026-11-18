/* The site's two themes: ink (the default) and paper. The choice is the one made on maidenpeter.github.io,
   which shares this origin and its "mp-theme" setting. Loaded in the head, so the page is drawn in the
   right theme from the start. Only the theme is stored: nothing from a statement ever is. */
(function () {
  "use strict";
  var d = document.documentElement;
  try {
    var t = localStorage.getItem("mp-theme");
    if (t === "light" || t === "dark") d.setAttribute("data-theme", t);
  } catch (e) { /* storage blocked: stay on ink */ }
  document.addEventListener("DOMContentLoaded", function () {
    var b = document.querySelector(".mp-theme");
    if (!b) return;
    var l = b.querySelector(".mp-l");
    var cur = function () { return d.getAttribute("data-theme") || "dark"; };
    var label = function () {
      var c = cur();
      l.textContent = c === "dark" ? "Paper theme" : "Ink theme";
      b.setAttribute("aria-label", "Switch to " + (c === "dark" ? "paper" : "ink") + " theme");
    };
    b.hidden = false;
    b.addEventListener("click", function () {
      var x = cur() === "dark" ? "light" : "dark";
      d.setAttribute("data-theme", x);
      try { localStorage.setItem("mp-theme", x); } catch (e) { /* not remembered */ }
      label();
    });
    label();
  });
})();

/* Shared helpers for the portal and console (no inline scripts: the CSP forbids them). */
window.AO = (function () {
  "use strict";
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || (opts.body !== undefined ? "POST" : "GET"), headers: { "content-type": "application/json" }, credentials: "same-origin" };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    return fetch(path, init).then(function (r) {
      var ct = r.headers.get("content-type") || "";
      return (ct.indexOf("json") >= 0 ? r.json() : r.text().then(function (t) { return { text: t }; })).then(function (j) {
        if (!r.ok) { var e = new Error((j && j.error) || ("HTTP " + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function flash(el, kind, msg) { el.className = "notice " + (kind || ""); el.textContent = msg; el.classList.remove("hidden"); }
  function fmt(n) { return Number(n || 0).toLocaleString("en-US"); }
  function copy(text, btn) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { if (btn) { var t = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = t; }, 1200); } }).catch(function () { window.prompt("Copy:", text); });
  }
  function hashParams() { var o = {}; location.hash.replace(/^#/, "").split("&").forEach(function (kv) { var p = kv.split("="); if (p[0]) o[decodeURIComponent(p[0])] = p.length > 1 ? decodeURIComponent(p.slice(1).join("=")) : ""; }); return o; }
  return { api: api, esc: esc, $: $, $$: $$, flash: flash, fmt: fmt, copy: copy, hashParams: hashParams };
})();

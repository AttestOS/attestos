(function () {
  "use strict";
  var out = document.getElementById("demo-out"), form = document.getElementById("demo-form"), el = document.getElementById("demo-widget");
  if (!form) return;
  var show = function (o) { out.textContent = JSON.stringify(o, null, 2); };
  var widget = null;
  fetch("/api/v1/demo/config").then(function (r) { return r.json(); }).then(function (c) {
    if (!c.sitekey) { show({ note: "The live demo isn't configured on this deployment yet." }); return; }
    widget = window.AttestOS.render(el, { sitekey: c.sitekey });
  }).catch(function () { show({ error: "could not load the demo" }); });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var token = widget && widget.getResponse();
    if (!token) { show({ note: "Still solving… try again in a moment." }); return; }
    show({ sending: "token → backend → /api/siteverify" });
    fetch("/api/v1/demo/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: token }) })
      .then(function (r) { return r.json(); })
      .then(function (v) { show(v); setTimeout(function () { widget.reset(); }, 300); })
      .catch(function () { show({ error: "network error" }); });
  });
})();

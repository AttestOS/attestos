(function () {
  "use strict";
  var $ = AO.$, esc = AO.esc, current = null;
  var ACCESS = { blocked: '<span class="pill r">blocked</span>', allowed: '<span class="pill g">allowed</span>' };
  var FR = { high: '<span class="pill r">visible puzzle</span>', medium: '<span class="pill a">sometimes visible</span>', low: '<span class="pill">invisible (score)</span>', none: '<span class="pill g">invisible</span>' };
  function render(r) {
    current = r;
    $("#report").classList.remove("hidden");
    $("#r-score").textContent = r.score + "/100";
    $("#r-score").style.color = r.score >= 80 ? "var(--green)" : r.score >= 55 ? "var(--amber)" : "var(--red)";
    $("#r-meta").innerHTML = esc(r.url) + "<br>HTTP " + esc(r.status) + " · " + esc(r.kind) + " page · " + esc(r.forms) + " form(s)<br>" + esc(new Date(r.scanned_at).toUTCString());
    $("#r-findings").innerHTML = r.findings.length ? r.findings.map(function (f) { return '<div style="margin:10px 0"><b class="sev-' + esc(f.severity) + '">' + esc(f.severity.toUpperCase()) + "</b> " + esc(f.title) + '<div class="small muted">' + esc(f.detail) + "</div></div>"; }).join("") : '<p class="muted">Nothing to flag. Nice.</p>';
    $("#r-vendors").innerHTML = r.vendors.length ? r.vendors.map(function (v) { return "<p>" + esc(v.name) + " " + (FR[v.friction] || "") + "</p>"; }).join("") : '<p class="muted">No CAPTCHA or bot-check script found on this page.</p>';
    $("#r-bots").innerHTML = r.robots === "missing" ? '<tr><td colspan="4" class="muted">No robots.txt found.</td></tr>' : r.bots.map(function (b) { return "<tr><td><code>" + esc(b.ua) + "</code></td><td>" + esc(b.owner) + "</td><td>" + esc(b.kind) + "</td><td>" + (ACCESS[b.access] || "") + (b.rule === "named" ? "" : ' <span class="small muted">(' + esc(b.rule === "wildcard" ? "via *" : "no rule") + ")</span>") + "</td></tr>"; }).join("");
    $("#r-headers").innerHTML = r.headers.map(function (h) { return "<div>" + (h.present ? '<span class="pill g">present</span>' : '<span class="pill a">missing</span>') + " <code>" + esc(h.name) + "</code> <span class='small muted'>" + esc(h.why) + "</span></div>"; }).join("") + "<p class='small muted' style='margin-top:8px'>security.txt: " + (r.security_txt ? "found" : "missing") + "</p>";
    $("#r-share").innerHTML = r.id ? 'Shareable report: <a href="/scanner/?id=' + esc(r.id) + '">' + esc(location.origin) + "/scanner/?id=" + esc(r.id) + "</a> (kept 90 days)" : "";
  }
  function scan(url) {
    var btn = $("#scan-btn"), msg = $("#scan-msg");
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Scanning…'; msg.classList.add("hidden");
    AO.api("/api/v1/scan", { body: { url: url } }).then(function (r) {
      render(r);
      if (r.id) history.replaceState(null, "", "/scanner/?id=" + r.id);
      $("#report").scrollIntoView({ behavior: "smooth" });
    }).catch(function (e) { AO.flash(msg, "err", e.message); }).then(function () { btn.disabled = false; btn.textContent = "Scan page"; });
  }
  $("#scan-form").addEventListener("submit", function (e) { e.preventDefault(); scan($("#scan-url").value.trim()); });
  $("#lead-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!current || !current.id) { AO.flash($("#lead-msg"), "err", "Run a scan first."); return; }
    AO.api("/api/v1/scan/" + current.id + "/lead", { body: { email: $("#lead-email").value.trim() } })
      .then(function () { AO.flash($("#lead-msg"), "ok", "Thanks. You'll get a personal reply, usually within a day."); })
      .catch(function (err) { AO.flash($("#lead-msg"), "err", err.message); });
  });
  var q = new URLSearchParams(location.search);
  if (q.get("id")) AO.api("/api/v1/scan/" + encodeURIComponent(q.get("id"))).then(function (r) { $("#scan-url").value = r.url; render(r); }).catch(function (e) { AO.flash($("#scan-msg"), "err", e.message); });
  else if (q.get("url")) { $("#scan-url").value = q.get("url"); scan(q.get("url")); }
})();

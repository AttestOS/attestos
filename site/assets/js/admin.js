/* AttestOS owner console. Password login → HMAC cookie on Path=/admin. */
(function () {
  "use strict";
  var $ = AO.$, $$ = AO.$$, esc = AO.esc, api = AO.api;
  function note(kind, msg) { AO.flash($("#notice"), kind, msg); }
  function yes(b) { return b ? '<span class="pill g">yes</span>' : '<span class="pill a">no</span>'; }
  function cell(v) { return "<td>" + esc(v == null ? "" : v) + "</td>"; }
  function onErr(err) { if (err.status === 401) showLogin(); else note("err", err.message); }
  function showLogin() { $("#console").classList.add("hidden"); $("#f-login").classList.remove("hidden"); }

  $("#f-login").addEventListener("submit", function (e) {
    e.preventDefault();
    api("/admin/api/login", { body: { password: $("#o-pw").value } }).then(function () { $("#o-pw").value = ""; $("#f-login").classList.add("hidden"); load(); openTabFromHash(); }).catch(function (err) { note("err", err.message); });
  });
  $("#logout").addEventListener("click", function () { api("/admin/api/logout", { body: {} }).then(showLogin); });
  $("#refresh").addEventListener("click", function () { load(); });
  $$("#tabs [data-t]").forEach(function (b) {
    b.addEventListener("click", function () {
      var t = b.getAttribute("data-t");
      $$("#tabs [data-t]").forEach(function (x) { x.classList.toggle("on", x === b); });
      $$("[data-p]").forEach(function (p) { p.classList.toggle("hidden", p.getAttribute("data-p") !== t); });
      var fn = ({ accounts: loadAccounts, outreach: loadProspects, leads: loadLeads, outbox: loadOutbox, mesh: loadMesh })[t];
      if (fn) fn();
      if (history.replaceState) history.replaceState(null, "", t === "health" ? location.pathname : "#" + t);
    });
  });
  function openTabFromHash() { var b = $('#tabs [data-t="' + location.hash.replace(/^#/, "") + '"]'); if (b) b.click(); }

  function load() {
    api("/admin/api/overview").then(function (o) {
      $("#console").classList.remove("hidden");
      var k = [["Accounts", o.accounts], ["Paying", o.paying], ["Sites", o.sites], ["Verified today", o.verifs_today], ["Verified this month", o.verifs_month], ["Scans (7 days)", o.scans_7d], ["Leads", o.leads], ["Prospects", Object.values(o.outreach.prospects).reduce(function (a, b) { return a + b; }, 0)]];
      $("#kpis").innerHTML = k.map(function (x) { return '<div class="card"><div class="kpi">' + AO.fmt(x[1]) + "</div><div>" + esc(x[0]) + "</div></div>"; }).join("");
      var c = o.config;
      $("#config").innerHTML = [["APP_SECRET (32+ chars)", c.app_secret], ["WHOP_WEBHOOK_SECRET", c.whop_webhook], ["WHOP_PLAN_MAP", c.whop_plans], ["POSTAL_ADDRESS", c.postal_address], ["AO_OPS_TOKEN (prospect intake)", c.ops_token], ["AO_PRESS_TOKEN (mesh)", c.press_token], ["NTFY_TOPIC (phone alerts)", c.ntfy]].map(function (r) { return "<div>" + yes(r[1]) + " " + esc(r[0]) + "</div>"; }).join("") +
        "<div style='margin-top:6px'>Checkout links: " + (c.checkout.length ? esc(c.checkout.join(", ")) : '<span class="pill a">none</span> (pricing buttons show "checkout opening soon")') + "</div>";
      var q = o.quota;
      $("#quota").innerHTML = "Writes " + AO.fmt(q.writes) + " / " + AO.fmt(q.budgets.writes) + '<div class="bar"><i style="width:' + Math.min(100, q.writes / q.budgets.writes * 100) + '%"></i></div>Reads ' + AO.fmt(q.reads) + " / " + AO.fmt(q.budgets.reads) + '<div class="bar"><i style="width:' + Math.min(100, q.reads / q.budgets.reads * 100) + '%"></i></div>' + (q.over ? '<p class="notice err">Over budget: background jobs paused until midnight UTC.</p>' : q.tight ? '<p class="notice warn">Above 80%: background jobs throttled.</p>' : "");
      $("#lanes").innerHTML = o.lanes.length ? o.lanes.map(function (l) {
        return "<div style='margin:6px 0'><b>" + esc(l.id) + "</b> " + esc(l.user) + " · " + (l.state.status === "ok" ? '<span class="pill g">ok</span>' : '<span class="pill r">' + esc(l.state.status) + "</span> " + esc(l.state.reason || "") + ' <button class="btn alt sm" data-resume="' + esc(l.id) + '">Resume</button>') +
          "<div class='small muted'>today: cold " + l.sent.cold + "/" + l.caps.cold + " · transactional " + l.sent.tx + "/" + l.caps.transactional + " · this hour " + l.sent.hour + "/" + l.caps.hourly + "</div></div>";
      }).join("") : '<p class="muted">No lanes configured (MAILBOXES + MAILBOX_*_USER/PASS secrets). Emails queue but are not sent.</p>';
      $$("[data-resume]").forEach(function (b) { b.addEventListener("click", function () { api("/admin/api/lanes/" + b.getAttribute("data-resume") + "/resume", { body: {} }).then(load).catch(onErr); }); });
      $("#errors").innerHTML = o.errors.length ? o.errors.map(function (e) { return "<tr>" + cell(e.at) + cell(e.scope) + cell(e.message) + "</tr>"; }).join("") : '<tr><td colspan="3" class="muted">None.</td></tr>';
      var s = o.outreach;
      $("#out-status").innerHTML = "<p>" + (s.enabled ? '<span class="pill g">switched on</span>' : '<span class="pill a">switched off</span>') + " " + (s.ready ? '<span class="pill g">sending</span>' : '<span class="pill r">not sending</span>') + "</p>" + (s.blockers.length ? "<ul>" + s.blockers.map(function (b) { return "<li>" + esc(b) + "</li>"; }).join("") + "</ul>" : "") +
        "<p class='small muted'>" + Object.keys(s.prospects).map(function (k) { return esc(k) + ": " + s.prospects[k]; }).join(" · ") + "</p>";
    }).catch(onErr);
  }
  function setOutreach(on) { api("/admin/api/settings", { body: { outreach_enabled: on } }).then(function () { note("ok", on ? "Outreach switched on." : "Outreach switched off."); load(); }).catch(onErr); }
  $("#out-on").addEventListener("click", function () { setOutreach(true); });
  $("#out-off").addEventListener("click", function () { setOutreach(false); });

  function loadAccounts() {
    api("/admin/api/accounts?q=" + encodeURIComponent($("#acc-q").value.trim())).then(function (r) {
      $("#accounts").innerHTML = r.accounts.map(function (a) {
        return "<tr>" + cell(a.email) + cell(a.plan) + '<td><select data-comp="' + esc(a.id) + '"><option value="">none</option>' + ["integrity", "hardware", "agent", "enterprise"].map(function (p) { return "<option" + (a.comp_plan === p ? " selected" : "") + ">" + p + "</option>"; }).join("") + "</select></td><td>" + (a.verified ? "yes" : '<button class="btn alt sm" data-verify="' + esc(a.id) + '">Confirm</button>') + "</td>" + cell(a.status) + cell(a.sites) + cell(String(a.created_at).slice(0, 10)) +
          '<td><button class="btn alt sm" data-status="' + esc(a.id) + '" data-to="' + (a.status === "active" ? "disabled" : "active") + '">' + (a.status === "active" ? "Disable" : "Enable") + "</button></td></tr>";
      }).join("") || '<tr><td colspan="8" class="muted">No accounts.</td></tr>';
      var upd = function (id, body) { return api("/admin/api/accounts/" + id, { body: body }).then(function () { note("ok", "Saved."); loadAccounts(); }).catch(onErr); };
      $$("[data-comp]").forEach(function (s) { s.addEventListener("change", function () { upd(s.getAttribute("data-comp"), { comp_plan: s.value }); }); });
      $$("[data-verify]").forEach(function (b) { b.addEventListener("click", function () { upd(b.getAttribute("data-verify"), { verified: true }); }); });
      $$("[data-status]").forEach(function (b) { b.addEventListener("click", function () { upd(b.getAttribute("data-status"), { status: b.getAttribute("data-to") }); }); });
    }).catch(onErr);
  }
  $("#acc-search").addEventListener("click", loadAccounts);

  function loadProspects() {
    api("/admin/api/prospects?status=" + encodeURIComponent($("#pr-filter").value)).then(function (r) {
      $("#prospects").innerHTML = r.prospects.map(function (p) {
        return '<tr><td><a href="' + esc(p.page_url || "https://" + p.domain) + '" target="_blank" rel="noopener noreferrer">' + esc(p.domain) + "</a></td>" + cell((p.vendor || "none") + " on " + (p.page_kind || "?")) + cell(p.contact_email ? p.contact_email + " (" + p.contact_source + ")" : "") + cell(p.status) + cell((p.first_sent_at || "").slice(0, 10) + (p.follow_sent_at ? " + follow-up" : "")) + cell(p.last_error) +
          '<td><select data-pst="' + esc(p.domain) + '"><option value="">set…</option><option>replied</option><option>skip</option><option>unsub</option><option>new</option></select></td></tr>';
      }).join("") || '<tr><td colspan="7" class="muted">No prospects yet. The daily GitHub Action feeds them in.</td></tr>';
      $$("[data-pst]").forEach(function (s) { s.addEventListener("change", function () { if (s.value) api("/admin/api/prospects/" + s.getAttribute("data-pst"), { body: { status: s.value } }).then(loadProspects).catch(onErr); }); });
    }).catch(onErr);
  }
  $("#pr-filter").addEventListener("change", loadProspects);
  function loadLeads() {
    api("/admin/api/leads").then(function (r) {
      $("#leads").innerHTML = r.leads.map(function (l) { return '<tr><td><a href="mailto:' + esc(l.email) + '">' + esc(l.email) + "</a></td>" + cell(l.domain) + '<td>' + (l.scan_id ? '<a href="/scanner/?id=' + esc(l.scan_id) + '" target="_blank">report</a>' : "") + "</td>" + cell(l.source) + cell(l.created_at) + "</tr>"; }).join("") || '<tr><td colspan="5" class="muted">None yet.</td></tr>';
    }).catch(onErr);
  }
  function loadOutbox() {
    api("/admin/api/outbox").then(function (r) {
      $("#outbox").innerHTML = r.outbox.map(function (m) { return "<tr>" + cell(m.id) + cell(m.to_email) + cell(m.subject) + cell(m.kind) + cell(m.status + (m.attempts > 1 ? " ×" + m.attempts : "")) + cell(m.lane) + cell(m.error) + cell(m.created_at) + "</tr>"; }).join("") || '<tr><td colspan="8" class="muted">Empty.</td></tr>';
    }).catch(onErr);
  }
  // ---- mesh (press) ----
  var RAIL_NAMES = { x: "X", linkedin: "LinkedIn", pinterest: "Pinterest", bsky: "Bluesky", nostrnote: "Nostr notes", nostr30023: "Nostr articles", devto: "dev.to", whop_public: "Whop forum (public)", whop_private: "Whop forum (members)", telegram: "Telegram", facebook: "Facebook", instagram: "Instagram", threads: "Threads", youtube: "YouTube", tiktok: "TikTok", gbp: "Google Business Profile", mastodon: "Mastodon", discord: "Discord" };
  function railName(r) { var m = r.match(/^(.*?)(_[a-z])?$/); return (RAIL_NAMES[m[1]] || m[1]) + (m[2] ? " (seller " + m[2].slice(1).toUpperCase() + ")" : ""); }
  function loadMesh() {
    api("/admin/api/press").then(function (p) {
      var last = p.lastRun && p.lastRun.at ? "Last run " + esc(String(p.lastRun.at).replace("T", " ").slice(0, 16)) + " UTC, " + esc(p.lastRun.value) + " author calls." : "No press run has reported yet.";
      $("#mesh-status").innerHTML = "<p>" + (p.configured ? '<span class="pill g">AO_PRESS_TOKEN set</span>' : '<span class="pill r">AO_PRESS_TOKEN missing on the Worker</span>') + " " + last + "</p>";
      // armed = rails whose credentials the last press run found; older runs did not report it
      var armed = p.lastRun && Array.isArray(p.lastRun.armed) ? p.lastRun.armed : null;
      function railState(o, rail) {
        if (o.parked) return '<span class="pill a">parked</span>';
        if (armed === null) return '<span class="pill a" title="The next press run reports which accounts exist">on (status after next run)</span>';
        return armed.indexOf(rail) >= 0 ? '<span class="pill g">active</span>' : '<span class="pill a" title="No credentials for this rail at the last run. Add its secret: docs/MESH-SETUP.md">on (waiting for account)</span>';
      }
      $("#mesh-rails").innerHTML = p.rails.map(function (r) {
        var o = p.overrides[r.rail] || {};
        return "<tr>" + cell(railName(r.rail)) + cell(r.per_day) + '<td><input type="number" min="0" max="10" style="max-width:90px" data-pd="' + esc(r.rail) + '" value="' + (o.per_day == null ? "" : esc(o.per_day)) + '"></td>' +
          "<td>" + railState(o, r.rail) + '</td><td><button class="btn alt sm" data-park="' + esc(r.rail) + '" data-to="' + (o.parked ? "0" : "1") + '">' + (o.parked ? "Resume" : "Park") + "</button></td></tr>";
      }).join("") || '<tr><td colspan="5" class="muted">No rails in cadence.json.</td></tr>';
      $$("[data-park]").forEach(function (b) { b.addEventListener("click", function () { api("/admin/api/press/rails/" + b.getAttribute("data-park"), { body: { parked: b.getAttribute("data-to") === "1" } }).then(loadMesh).catch(onErr); }); });
      $$("[data-pd]").forEach(function (i) { i.addEventListener("change", function () { var v = i.value.trim(); api("/admin/api/press/rails/" + i.getAttribute("data-pd"), { body: { per_day: v === "" ? null : Number(v) } }).then(function () { note("ok", "Saved."); loadMesh(); }).catch(onErr); }); });
      $("#mesh-controls").innerHTML = p.controls.specs.map(function (c) {
        var v = p.controls.values[c.key];
        return '<div style="margin:8px 0"><label class="small" for="mc-' + esc(c.key) + '">' + esc(c.label || c.key) + (c.min != null ? ' <span class="muted">(' + esc(c.min) + "–" + esc(c.max) + ")</span>" : "") + '</label><input id="mc-' + esc(c.key) + '" data-ctl="' + esc(c.key) + '" data-type="' + esc(c.type) + '" value="' + esc(v) + '"' + (c.type === "text" ? "" : ' type="number" step="any"') + "></div>";
      }).join("") || '<p class="muted">No controls.</p>';
      $$("[data-ctl]").forEach(function (i) { i.addEventListener("change", function () { var val = i.getAttribute("data-type") === "text" ? i.value : Number(i.value); api("/admin/api/press/controls", { body: { key: i.getAttribute("data-ctl"), value: val } }).then(function () { note("ok", "Saved."); }).catch(function (e) { onErr(e); loadMesh(); }); }); });
      $("#mesh-keys").innerHTML = p.keys.length ? p.keys.map(function (k) { return "<div>" + '<span class="pill g">stored</span> <code>' + esc(k.name) + '</code> <span class="small muted">' + esc(k.updated_at || "") + '</span> <button class="btn alt sm" data-delkey="' + esc(k.name) + '">Delete</button></div>'; }).join("") : '<p class="muted">None stored here.</p>';
      $$("[data-delkey]").forEach(function (b) { b.addEventListener("click", function () { api("/admin/api/press/keys", { body: { name: b.getAttribute("data-delkey"), value: "" } }).then(loadMesh).catch(onErr); }); });
      $("#mesh-clicks").innerHTML = p.clicks.length ? p.clicks.map(function (c) { var parts = String(c.key).split(":"); return "<tr>" + cell(parts[1]) + cell(parts[2]) + cell(c.n) + "</tr>"; }).join("") : '<tr><td colspan="3" class="muted">No tracked clicks yet.</td></tr>';
    }).catch(onErr);
  }
  $("#mesh-key-form").addEventListener("submit", function (e) {
    e.preventDefault();
    api("/admin/api/press/keys", { body: { name: $("#mk-name").value.trim(), value: $("#mk-value").value } }).then(function (r) { $("#mk-value").value = ""; note("ok", r.removed ? "Removed " + r.removed + "." : "Stored " + r.stored + "."); loadMesh(); }).catch(onErr);
  });

  load();
  openTabFromHash();
})();

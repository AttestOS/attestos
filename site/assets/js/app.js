/* AttestOS customer portal. Talks to /api/v1/account/* with a same-origin session cookie. */
(function () {
  "use strict";
  var $ = AO.$, $$ = AO.$$, esc = AO.esc, api = AO.api;
  var ORIGIN = location.origin;
  var me = null, cur = null, lang = "node", claimToken = null, resetToken = null;
  var ACTS = [["allow", "Allow"], ["charge", "Charge (HTTP 402)"], ["block", "Block"]];
  var NOTICES = { verified: ["ok", "Email confirmed. Any Whop purchase made with this email is now attached."], "link-expired": ["err", "That link expired. Log in and ask for a new one."] };

  function note(kind, msg) { AO.flash($("#notice"), kind, msg); window.scrollTo(0, 0); }
  function authMsg(kind, msg) { AO.flash($("#auth-msg"), kind, msg); }
  function has(f) { return me && me.entitlements.features.indexOf(f) >= 0; }

  // ---------- auth ----------
  function showAuth(which) {
    $("#dash").classList.add("hidden"); $("#auth").classList.remove("hidden");
    AO.signedIn(false);
    $$("[data-auth]").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-auth") === which); });
    $$("[data-form]").forEach(function (f) { f.classList.toggle("hidden", f.getAttribute("data-form") !== which); });
    $("#auth-msg").classList.add("hidden");
  }
  $$("[data-auth]").forEach(function (b) { b.addEventListener("click", function () { claimToken = null; showAuth(b.getAttribute("data-auth")); }); });
  $("#f-login").addEventListener("submit", function (e) {
    e.preventDefault();
    api("/api/v1/account/login", { body: { email: $("#l-email").value.trim(), password: $("#l-pw").value } }).then(load).catch(function (err) { authMsg("err", err.message); });
  });
  $("#f-signup").addEventListener("submit", function (e) {
    e.preventDefault();
    var body = { email: $("#s-email").value.trim(), password: $("#s-pw").value };
    if (claimToken) body.claim = claimToken;
    api("/api/v1/account/signup", { body: body }).then(function () { history.replaceState(null, "", "/app/"); return load(); }).catch(function (err) { authMsg("err", err.message); });
  });
  $("#f-forgot").addEventListener("submit", function (e) {
    e.preventDefault();
    api("/api/v1/account/reset/request", { body: { email: $("#fg-email").value.trim() } }).then(function () { authMsg("ok", "If that email has an account, a reset link is on its way. Check spam too."); }).catch(function (err) { authMsg("err", err.message); });
  });
  $("#f-reset").addEventListener("submit", function (e) {
    e.preventDefault();
    api("/api/v1/account/reset/confirm", { body: { token: resetToken, password: $("#r-pw").value } }).then(function () { history.replaceState(null, "", "/app/"); return load(); }).catch(function (err) { authMsg("err", err.message); });
  });
  $("#logout").addEventListener("click", function () { api("/api/v1/account/logout", { body: {} }).then(function () { me = null; showAuth("login"); }); });

  // ---------- dashboard ----------
  function load() {
    return api("/api/v1/account/me").then(function (m) { me = m; renderDash(); }).catch(function (err) {
      if (err.status === 401) { showAuth(location.hash.indexOf("signup") >= 0 ? "signup" : "login"); return; }
      note("err", err.message);
    });
  }
  function renderDash() {
    $("#auth").classList.add("hidden"); $("#dash").classList.remove("hidden");
    AO.signedIn(true);
    $("#d-email").textContent = me.email;
    $("#buy-email").textContent = me.email;
    $("#d-plans").innerHTML = me.plans.map(function (p) { var d = me.catalog.filter(function (c) { return c.id === p; })[0]; return '<span class="pill ' + (p === "free" ? "g" : "") + '">' + esc(d ? d.name : p) + "</span> "; }).join("") + (me.comp ? '<span class="pill v">complimentary</span> ' : "");
    var vb = $("#verify-box");
    if (!me.verified) {
      vb.innerHTML = "Confirm your email so Whop purchases attach to this account. " + (me.mail ? '<button class="btn alt sm" id="resend">Resend confirmation email</button>' : "<span class='small'>(Email sending isn't switched on yet; the owner can confirm you manually.)</span>");
      vb.classList.remove("hidden");
      var rb = $("#resend");
      if (rb) rb.addEventListener("click", function () { api("/api/v1/account/verify/resend", { body: {} }).then(function () { note("ok", "Sent. Check your inbox and spam folder."); }).catch(function (err) { note("err", err.message); }); });
    } else vb.classList.add("hidden");
    var lim = me.entitlements.verifications;
    $("#k-verifs").textContent = AO.fmt(me.usage.verifs) + " / " + AO.fmt(lim);
    $("#k-bar").style.width = Math.min(100, (me.usage.verifs / lim) * 100) + "%";
    $("#k-sites").textContent = me.sites.length + " / " + me.entitlements.sites;
    $("#k-agent").textContent = me.entitlements.agentChecks ? AO.fmt(me.usage.agent) + " / " + AO.fmt(me.entitlements.agentChecks) : "–";
    renderSites(); renderCatalog();
  }
  $$("#main-tabs [data-tab]").forEach(function (b) {
    b.addEventListener("click", function () {
      $$("#main-tabs [data-tab]").forEach(function (x) { x.classList.toggle("on", x === b); });
      $$("[data-pane]").forEach(function (p) { p.classList.toggle("hidden", p.getAttribute("data-pane") !== b.getAttribute("data-tab")); });
    });
  });

  function renderSites() {
    var list = $("#site-list");
    list.innerHTML = me.sites.map(function (s) { return '<button class="btn sm ' + (cur && cur.id === s.id ? "" : "alt") + '" data-site="' + esc(s.id) + '">' + esc(s.name || s.domains[0] || s.id) + "</button>"; }).join("") +
      (me.sites.length < me.entitlements.sites ? '<button class="btn alt sm" id="add-site">+ Add site</button>' : '<span class="small muted">Site limit reached for your plan.</span>');
    $$("[data-site]", list).forEach(function (b) { b.addEventListener("click", function () { selectSite(b.getAttribute("data-site")); }); });
    var add = $("#add-site");
    if (add) add.addEventListener("click", function () { $("#f-site").classList.toggle("hidden"); });
    $("#no-sites").classList.toggle("hidden", me.sites.length > 0);
    if (!me.sites.length) { $("#f-site").classList.remove("hidden"); $("#site").classList.add("hidden"); return; }
    selectSite(cur && me.sites.some(function (s) { return s.id === cur.id; }) ? cur.id : me.sites[0].id);
  }
  $("#f-site").addEventListener("submit", function (e) {
    e.preventDefault();
    api("/api/v1/account/sites", { body: { name: $("#ns-name").value.trim(), domains: $("#ns-domains").value } }).then(function (r) {
      $("#f-site").classList.add("hidden"); $("#f-site").reset();
      cur = r.site;
      return load().then(function () { showSecret(r.secret, r.note); });
    }).catch(function (err) { note("err", err.message); });
  });

  function showSecret(secret, msg) {
    var box = $("#secret-box");
    box.innerHTML = "<b>" + esc(msg) + '</b><div class="row" style="margin-top:6px"><code class="grow" id="new-secret">' + esc(secret) + '</code><button class="btn alt sm" id="copy-secret">Copy</button></div>';
    box.classList.remove("hidden");
    $("#copy-secret").addEventListener("click", function (e) { AO.copy(secret, e.target); });
    renderServerSnippet(secret);
  }

  function selectSite(id) {
    cur = me.sites.filter(function (s) { return s.id === id; })[0];
    $$("#site-list [data-site]").forEach(function (b) { b.classList.toggle("alt", b.getAttribute("data-site") !== id); });
    $("#site").classList.remove("hidden");
    $("#secret-box").classList.add("hidden");
    $("#s-key").textContent = cur.id;
    $("#s-secret").textContent = "ao_sec_…" + (cur.secret_hint || "").replace(/^…/, "");
    $("#s-domains").value = cur.domains.join(", ");
    $("#snip-html").textContent = '<script src="' + ORIGIN + '/v1/attestos.js" async defer></script>\n\n<form method="post" action="/signup">\n  <!-- your fields -->\n  <div class="attestos" data-sitekey="' + cur.id + '"></div>\n  <button type="submit">Sign up</button>\n</form>';
    renderServerSnippet(null);
    fillPolicy(); fillAgents();
    $("#del-confirm").value = "";
    var active = $("#site-tabs .on").getAttribute("data-stab");
    if (active === "stats") loadStats(); else if (active === "log") loadLog(); else if (active === "agents") loadKeys();
  }
  $$("#site-tabs [data-stab]").forEach(function (b) {
    b.addEventListener("click", function () {
      var t = b.getAttribute("data-stab");
      $$("#site-tabs [data-stab]").forEach(function (x) { x.classList.toggle("on", x === b); });
      $$("[data-spane]").forEach(function (p) { p.classList.toggle("hidden", p.getAttribute("data-spane") !== t); });
      if (t === "stats") loadStats(); else if (t === "log") loadLog(); else if (t === "agents") loadKeys();
    });
  });
  $$("[data-copy]").forEach(function (b) { b.addEventListener("click", function () { AO.copy($(b.getAttribute("data-copy")).textContent, b); }); });

  function renderServerSnippet(secret) {
    var S = secret ? secret : "process.env.ATTESTOS_SECRET";
    var V = ORIGIN + "/api/siteverify";
    var s = {
      node: "// Node 18+ / Express: req.body must be parsed (express.urlencoded or express.json)\nconst r = await fetch(\"" + V + "\", {\n  method: \"POST\",\n  headers: { \"content-type\": \"application/json\" },\n  body: JSON.stringify({ secret: " + (secret ? JSON.stringify(secret) : S) + ", response: req.body[\"attestos-response\"] }),\n}).then((x) => x.json()).catch(() => ({ success: false, \"error-codes\": [\"network-error\"] }));\nconst failOpen = (r[\"error-codes\"] || []).some((c) => c === \"quota-exceeded\" || c === \"network-error\");\nif (!r.success && !failOpen) return res.status(400).send(\"Bot check failed, please retry\");",
      php: "<?php\n$ch = curl_init(\"" + V + "\");\ncurl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5,\n  CURLOPT_HTTPHEADER => [\"content-type: application/json\"],\n  CURLOPT_POSTFIELDS => json_encode([\"secret\" => " + (secret ? JSON.stringify(secret) : "getenv(\"ATTESTOS_SECRET\")") + ", \"response\" => $_POST[\"attestos-response\"] ?? \"\"])]);\n$r = json_decode(curl_exec($ch) ?: '{\"success\":false,\"error-codes\":[\"network-error\"]}', true);\n$failOpen = array_intersect($r[\"error-codes\"] ?? [], [\"quota-exceeded\", \"network-error\"]);\nif (empty($r[\"success\"]) && !$failOpen) { http_response_code(400); exit(\"Bot check failed, please retry\"); }",
      python: "import os, requests\ntry:\n    r = requests.post(\"" + V + "\", json={\"secret\": " + (secret ? JSON.stringify(secret) : "os.environ[\"ATTESTOS_SECRET\"]") + ",\n        \"response\": request.form.get(\"attestos-response\", \"\")}, timeout=5).json()\nexcept requests.RequestException:\n    r = {\"success\": False, \"error-codes\": [\"network-error\"]}\nfail_open = {\"quota-exceeded\", \"network-error\"} & set(r.get(\"error-codes\", []))\nif not r.get(\"success\") and not fail_open:\n    abort(400, \"Bot check failed, please retry\")",
      curl: "curl -s " + V + " \\\n  -H 'content-type: application/json' \\\n  -d '{\"secret\":\"" + (secret || "ao_sec_…") + "\",\"response\":\"<value of attestos-response>\"}'",
    };
    $("#snip-server").textContent = s[lang];
    $("#snip-agent").textContent = "// Cloudflare Worker / any edge middleware in front of your site\nconst d = await fetch(\"" + ORIGIN + "/api/v1/agent/check\", {\n  method: \"POST\", headers: { \"content-type\": \"application/json\" },\n  body: JSON.stringify({ secret: env.ATTESTOS_SECRET, user_agent: request.headers.get(\"user-agent\"),\n    ip: request.headers.get(\"cf-connecting-ip\"), path: new URL(request.url).pathname,\n    agent_key: request.headers.get(\"x-agent-key\") }),\n}).then((r) => r.json()).catch(() => ({ action: \"allow\" }));\nif (d.action === \"block\") return new Response(\"Forbidden\", { status: 403 });\nif (d.action === \"charge\") return new Response(JSON.stringify({ price_usd: d.price_usd, pay: d.checkout_url }), { status: 402, headers: d.headers });\nreturn fetch(request);";
  }
  $$("#lang-tabs [data-lang]").forEach(function (b) {
    b.addEventListener("click", function () {
      lang = b.getAttribute("data-lang");
      $$("#lang-tabs [data-lang]").forEach(function (x) { x.classList.toggle("on", x === b); });
      var shown = $("#new-secret");
      renderServerSnippet(shown && !$("#secret-box").classList.contains("hidden") ? shown.textContent : null);
    });
  });

  $("#rotate").addEventListener("click", function () {
    if (!confirm("Rotate the secret key? The current one stops working immediately.")) return;
    api("/api/v1/account/sites/" + cur.id + "/rotate", { body: {} }).then(function (r) { cur.secret_hint = "…" + r.secret.slice(-4); $("#s-secret").textContent = "ao_sec_…" + r.secret.slice(-4); showSecret(r.secret, r.note); }).catch(function (err) { note("err", err.message); });
  });
  function saveSite(body, okMsg) {
    return api("/api/v1/account/sites/" + cur.id, { body: body }).then(function (r) {
      me.sites = me.sites.map(function (s) { return s.id === cur.id ? r.site : s; });
      cur = r.site; note("ok", okMsg);
    }).catch(function (err) { note("err", err.message); });
  }
  $("#save-domains").addEventListener("click", function () { saveSite({ domains: $("#s-domains").value }, "Domains saved.").then(function () { $("#s-domains").value = cur.domains.join(", "); }); });

  // ---------- policy ----------
  function fillPolicy() {
    var p = cur.policy;
    $("#p-diff").value = p.difficulty; $("#p-local").value = String(p.allowLocalhost); $("#p-signals").value = p.signals; $("#p-thr").value = p.riskThreshold;
    $("#p-adapt").value = String(p.adaptive); $("#p-surge").value = p.surgePerMinute; $("#p-hook").value = p.alertWebhook; $("#p-pat").value = String(p.pat); $("#p-rp").value = p.rpId;
    var missing = [];
    if (!has("signals")) missing.push("signals and adaptive difficulty need IntegrityRuntime Pro");
    if (!has("pat")) missing.push("Private Access Tokens need Hardware Gateway Pro");
    $("#p-plan-note").textContent = missing.length ? "On your plan, " + missing.join("; ") + ". You can save these settings now; they take effect when the plan is active." : "";
  }
  $("#f-policy").addEventListener("submit", function (e) {
    e.preventDefault();
    var p = { difficulty: Number($("#p-diff").value), allowLocalhost: $("#p-local").value === "true", signals: $("#p-signals").value, riskThreshold: Number($("#p-thr").value),
      adaptive: $("#p-adapt").value === "true", surgePerMinute: Number($("#p-surge").value), alertWebhook: $("#p-hook").value.trim(), pat: $("#p-pat").value === "true", rpId: $("#p-rp").value.trim(), agents: cur.policy.agents };
    saveSite({ policy: p }, "Policy saved. It applies to new challenges within a minute.").then(fillPolicy);
  });

  // ---------- agents ----------
  function fillAgents() {
    var a = cur.policy.agents;
    ["search", "training", "assist", "unknown"].forEach(function (k) {
      $("#a-" + k).innerHTML = ACTS.map(function (x) { return '<option value="' + x[0] + '">' + x[1] + "</option>"; }).join("");
    });
    $("#a-search").value = a.search; $("#a-training").value = a.training; $("#a-assist").value = a.assistants; $("#a-unknown").value = a.unknownBots;
    $("#a-price").value = a.priceUsd; $("#a-link").value = a.checkoutUrl; $("#a-verify").value = String(a.verifyCrawlers);
  }
  $("#f-agents").addEventListener("submit", function (e) {
    e.preventDefault();
    var p = JSON.parse(JSON.stringify(cur.policy));
    p.agents = { search: $("#a-search").value, training: $("#a-training").value, assistants: $("#a-assist").value, unknownBots: $("#a-unknown").value,
      priceUsd: Number($("#a-price").value), checkoutUrl: $("#a-link").value.trim(), verifyCrawlers: $("#a-verify").value === "true" };
    saveSite({ policy: p }, has("agentpass") ? "Crawler policy saved." : "Saved. AgentPass checks start working once you hold AgentPass Pro or Enterprise.").then(fillAgents);
  });
  function loadKeys() {
    if (!has("agentpass")) { $("#keys-body").innerHTML = '<tr><td colspan="5" class="muted">Agent keys are part of AgentPass Pro and Enterprise. <a href="/pricing/#agent">See plans</a>.</td></tr>'; return; }
    api("/api/v1/account/sites/" + cur.id + "/agent-keys").then(function (r) {
      $("#keys-body").innerHTML = r.keys.length ? r.keys.map(function (k) {
        return "<tr><td>" + esc(k.label) + "</td><td><code>ak_" + esc(k.hint) + "</code></td><td>" + AO.fmt(k.used) + " / " + (k.quota ? AO.fmt(k.quota) : "∞") + "</td><td>" + esc(k.status) + "</td><td>" + (k.status === "active" ? '<button class="btn alt sm" data-revoke="' + esc(k.id) + '">Revoke</button>' : "") + "</td></tr>";
      }).join("") : '<tr><td colspan="5" class="muted">No keys yet.</td></tr>';
      $$("[data-revoke]").forEach(function (b) { b.addEventListener("click", function () { api("/api/v1/account/sites/" + cur.id + "/agent-keys/" + b.getAttribute("data-revoke") + "/revoke", { body: {} }).then(loadKeys).catch(function (err) { note("err", err.message); }); }); });
    }).catch(function (err) { note("err", err.message); });
  }
  $("#f-key").addEventListener("submit", function (e) {
    e.preventDefault();
    api("/api/v1/account/sites/" + cur.id + "/agent-keys", { body: { label: $("#k-label").value.trim(), quota: Number($("#k-quota").value) || 0 } }).then(function (r) {
      AO.flash($("#key-box"), "ok", r.note + "  " + r.key); $("#f-key").reset(); loadKeys();
    }).catch(function (err) { note("err", err.message); });
  });

  // ---------- stats / log ----------
  function loadStats() {
    api("/api/v1/account/sites/" + cur.id + "/stats").then(function (r) {
      $("#stats-body").innerHTML = r.days.length ? r.days.slice().reverse().map(function (d) {
        return "<tr><td>" + esc(d.day) + "</td><td>" + AO.fmt(d.ok) + "</td><td>" + AO.fmt(d.fail) + "</td><td>" + AO.fmt(d.risky) + "</td><td>" + AO.fmt(d.pat) + "</td><td>" + AO.fmt(d.passkey) + "</td><td>" + AO.fmt(d.agent_allow) + " / " + AO.fmt(d.agent_charge) + " / " + AO.fmt(d.agent_block) + "</td></tr>";
      }).join("") : '<tr><td colspan="7" class="muted">No traffic yet. Add the widget and submit your form once.</td></tr>';
    }).catch(function (err) { note("err", err.message); });
  }
  function loadLog() {
    $("#export").href = "/api/v1/account/sites/" + cur.id + "/export.csv";
    $("#export").classList.toggle("hidden", !has("export"));
    api("/api/v1/account/sites/" + cur.id + "/log").then(function (r) {
      $("#log-body").innerHTML = r.entries.length ? r.entries.map(function (x) {
        return "<tr><td>" + esc(new Date(x.at * 1000).toISOString().replace("T", " ").slice(0, 19)) + "</td><td>" + esc(x.method) + "</td><td>" + esc(x.host || "") + "</td><td>" + (x.risk == null ? "–" : esc(Number(x.risk).toFixed(2))) + "</td><td><code>" + esc(x.salt) + "</code></td></tr>";
      }).join("") : '<tr><td colspan="5" class="muted">No verifications yet.</td></tr>';
    }).catch(function (err) { note("err", err.message); });
  }

  // ---------- danger ----------
  $("#del-site").addEventListener("click", function () {
    api("/api/v1/account/sites/" + cur.id + "/delete", { body: { confirm: $("#del-confirm").value.trim() } }).then(function () { cur = null; note("ok", "Site deleted."); return load(); }).catch(function (err) { note("err", err.message); });
  });

  // ---------- plans ----------
  function renderCatalog() {
    $("#catalog").innerHTML = me.catalog.map(function (p) {
      var owned = me.plans.indexOf(p.id) >= 0;
      var buy = p.id === "free" ? "" : owned ? '<span class="pill g">active</span> <a class="small" href="https://whop.com/@me/settings/memberships">Manage on Whop</a>' : '<a class="btn" href="' + esc(p.checkout || "/go/" + p.id) + '" target="_blank" rel="noopener">Buy on Whop</a>';
      return '<div class="card"><h3>' + esc(p.name) + '</h3><div class="price">$' + p.price + (p.price ? "<small>/mo</small>" : "") + '</div><p class="muted small">' + esc(p.blurb) + '</p><ul class="ticks small"><li>' + AO.fmt(p.verifications) + " verifications / month</li><li>" + p.sites + " site(s), " + p.domainsPerSite + " domains each</li>" + (p.agentChecks ? "<li>" + AO.fmt(p.agentChecks) + " agent checks / month</li>" : "") + "</ul>" + buy + "</div>";
    }).join("");
    // unconfirmed accounts: a Whop purchase only attaches to a CONFIRMED email, so say so
    // before they pay (this line used to insert an empty string)
    var warn = $("#catalog-warn");
    if (!warn) { warn = document.createElement("p"); warn.id = "catalog-warn"; warn.className = "notice warn"; $("#catalog").parentNode.insertBefore(warn, $("#catalog")); }
    warn.textContent = "Confirm your email first (banner at the top): a Whop purchase attaches to this account only once its email is confirmed.";
    warn.classList.toggle("hidden", !!me.verified);
  }
  $("#f-pw").addEventListener("submit", function (e) {
    e.preventDefault();
    api("/api/v1/account/password", { body: { current: $("#pw-cur").value, next: $("#pw-new").value } }).then(function () { $("#f-pw").reset(); note("ok", "Password changed. Other devices were logged out."); }).catch(function (err) { note("err", err.message); });
  });

  // ---------- boot ----------
  var q = new URLSearchParams(location.search);
  if (q.get("notice") && NOTICES[q.get("notice")]) { var n = NOTICES[q.get("notice")]; note(n[0], n[1]); history.replaceState(null, "", "/app/"); }
  var h = AO.hashParams();
  if (h.reset) { resetToken = h.reset; showAuth("reset"); $("#reset-title").textContent = "Choose a new password"; }
  else if (h.claim) { claimToken = h.claim; showAuth("signup"); if (h.email) $("#s-email").value = h.email; authMsg("ok", "Thanks for your purchase. Choose a password to create your account; your plan attaches automatically."); }
  else load();
})();

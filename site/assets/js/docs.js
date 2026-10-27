(function () {
  "use strict";
  var $ = AO.$, $$ = AO.$$, esc = AO.esc;
  $$("#doc-lang [data-l]").forEach(function (b) {
    b.addEventListener("click", function () {
      $$("#doc-lang [data-l]").forEach(function (x) { x.classList.toggle("on", x === b); });
      $$("[data-code]").forEach(function (p) { p.classList.toggle("hidden", p.getAttribute("data-code") !== b.getAttribute("data-l")); });
    });
  });
  AO.api("/api/v1/plans").then(function (r) {
    $("#plans-table").innerHTML = r.plans.map(function (p) {
      return "<tr><td>" + esc(p.name) + (p.price ? " ($" + p.price + "/mo)" : "") + "</td><td>" + AO.fmt(p.verifications) + "</td><td>" + p.sites + "</td><td>" + p.domainsPerSite + "</td><td>" + (p.passkeys >= 1000000 ? "unlimited" : AO.fmt(p.passkeys)) + "</td><td>" + (p.agentChecks ? AO.fmt(p.agentChecks) : "–") + "</td></tr>";
    }).join("");
  }).catch(function () { $("#plans-table").innerHTML = '<tr><td colspan="6">See <a href="/pricing/">pricing</a>.</td></tr>'; });

  // robots.txt generator: user agents as documented by each operator
  var GROUPS = [
    { id: "training", label: "Model-training crawlers", def: false, uas: ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended", "Applebot-Extended", "Bytespider", "Meta-ExternalAgent", "cohere-ai", "Diffbot"] },
    { id: "search", label: "AI search / answer crawlers", def: true, uas: ["OAI-SearchBot", "PerplexityBot", "Claude-SearchBot"] },
    { id: "assist", label: "User-triggered assistants", def: true, uas: ["ChatGPT-User", "Perplexity-User", "Claude-User", "MistralAI-User"] },
  ];
  var opts = $("#robots-opts");
  if (!opts) return;
  opts.innerHTML = GROUPS.map(function (g) {
    return '<div><label for="rg-' + g.id + '">' + esc(g.label) + '</label><select id="rg-' + g.id + '"><option value="allow"' + (g.def ? " selected" : "") + '>Allow</option><option value="block"' + (g.def ? "" : " selected") + ">Block</option></select><div class='small muted'>" + esc(g.uas.join(", ")) + "</div></div>";
  }).join("") + '<div><label for="rg-paths">Also keep every bot out of (one path per line)</label><textarea id="rg-paths" rows="3">/app/\n/checkout/</textarea></div>';
  function gen() {
    var out = ["# AI crawler rules generated with attestos-edge.attestos.workers.dev/docs/#robots", ""];
    GROUPS.forEach(function (g) {
      var block = $("#rg-" + g.id).value === "block";
      out.push("# " + g.label + ": " + (block ? "blocked" : "allowed"));
      g.uas.forEach(function (ua) { out.push("User-agent: " + ua); });
      out.push(block ? "Disallow: /" : "Allow: /", "");
    });
    var paths = $("#rg-paths").value.split(/\n/).map(function (s) { return s.trim(); }).filter(function (s) { return /^\//.test(s); });
    out.push("User-agent: *");
    if (paths.length) paths.forEach(function (p) { out.push("Disallow: " + p); }); else out.push("Allow: /");
    $("#robots-out").textContent = out.join("\n");
  }
  $$("select, textarea", opts).forEach(function (e) { e.addEventListener("input", gen); e.addEventListener("change", gen); });
  $("#robots-copy").addEventListener("click", function (e) { AO.copy($("#robots-out").textContent, e.target); });
  gen();
})();

/*! AttestOS widget v1 · https://attestos-edge.attestos.workers.dev/docs/ · Apache-2.0
 *
 *  <script src="https://attestos-edge.attestos.workers.dev/v1/attestos.js" async defer></script>
 *  <form ...> <div class="attestos" data-sitekey="ao_site_..."></div> ... </form>
 *
 *  The widget fetches a signed challenge, finds a nonce whose SHA-256 has the required leading zero bits (in a Web
 *  Worker when the page allows it), trades the solution for a pass token and puts it in a hidden field named
 *  "attestos-response". Your server sends that token + your secret key to /api/siteverify (once).
 *  On Apple devices with Private Access Tokens enabled (paid Hardware plan) the solve is skipped entirely.
 *
 *  JS API: AttestOS.execute(sitekey) → Promise<token>; AttestOS.render(element, {sitekey, callback});
 *          AttestOS.passkey.register(beginResponse) / AttestOS.passkey.login({sitekey, userId}) → Promise<…>
 */
(function () {
  "use strict";
  if (window.AttestOS && window.AttestOS.version) return;
  var script = document.currentScript;
  var API = (script && script.src ? new URL(script.src).origin : "https://attestos-edge.attestos.workers.dev");
  var REFRESH_MS = 4 * 60 * 1000; // pass tokens live 5 minutes; refresh before that

  // ---------- SHA-256 (sync, for short ASCII messages: "salt:nonce" always fits one 64-byte block) ----------
  // One factory runs both on the page (fallback) and, via toString(), inside a blob Web Worker: no eval needed.
  function factory(isWorker) {
    var K = new Int32Array([1116352408,1899447441,-1245643825,-373957723,961987163,1508970993,-1841331548,-1424204075,-670586216,310598401,607225278,1426881987,1925078388,-2132889090,-1680079193,-1046744716,-459576895,-272742522,264347078,604807628,770255983,1249150122,1555081692,1996064986,-1740746414,-1473132947,-1341970488,-1084653625,-958395405,-710438585,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,-2117940946,-1838011259,-1564481375,-1474664885,-1035236496,-949202525,-778901479,-694614492,-200395387,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,-2067236844,-1933114872,-1866530822,-1538233109,-1090935817,-965641998]);
    var W = new Int32Array(64);
    /** Leading zero bits of SHA-256(s), s ASCII and shorter than 56 bytes. */
    function zb(s) {
      var n = s.length, i;
      for (i = 0; i < 16; i++) W[i] = 0;
      for (i = 0; i < n; i++) W[i >> 2] |= (s.charCodeAt(i) & 255) << (24 - 8 * (i & 3));
      W[n >> 2] |= 128 << (24 - 8 * (n & 3));
      W[15] = n * 8;
      for (i = 16; i < 64; i++) {
        var a = W[i - 15], b = W[i - 2];
        W[i] = (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) + W[i - 16] + (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)) + W[i - 7] | 0;
      }
      var A = 1779033703, B = -1150833019, C = 1013904242, D = -1521486534, E = 1359893119, F = -1694144372, G = 528734635, H = 1541459225;
      for (i = 0; i < 64; i++) {
        var t1 = H + (((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7))) + ((E & F) ^ (~E & G)) + K[i] + W[i] | 0;
        var t2 = (((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10))) + ((A & B) ^ (A & C) ^ (B & C)) | 0;
        H = G; G = F; F = E; E = D + t1 | 0; D = C; C = B; B = A; A = t1 + t2 | 0;
      }
      var x = (1779033703 + A) | 0; if (x !== 0) return Math.clz32(x);
      var y = (-1150833019 + B) | 0; if (y !== 0) return 32 + Math.clz32(y);
      var z = (1013904242 + C) | 0; return z !== 0 ? 64 + Math.clz32(z) : 96;
    }
    function solve(salt, bits, from, to) { for (var n = from; n < to; n++) if (zb(salt + ":" + n) >= bits) return n; return -1; }
    if (isWorker) self.onmessage = function (e) { var d = e.data, t = Date.now(), n = solve(d.s, d.b, 0, 4294967295); self.postMessage({ n: n, ms: Date.now() - t }); };
    return solve;
  }
  var local = null;
  function localSolver() { if (!local) local = factory(false); return local; }

  function solveInWorker(salt, bits) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker(URL.createObjectURL(new Blob(["(" + factory.toString() + ")(true);"], { type: "text/javascript" }))); }
      catch (e) { return reject(e); }
      var timer = setTimeout(function () { w.terminate(); reject(new Error("solver timeout")); }, 60000);
      w.onmessage = function (e) { clearTimeout(timer); w.terminate(); resolve(e.data); };
      w.onerror = function (e) { clearTimeout(timer); w.terminate(); if (e.preventDefault) e.preventDefault(); reject(new Error("worker blocked")); };
      w.postMessage({ s: salt, b: bits });
    });
  }
  // Fallback when the page's CSP forbids blob: workers: solve on the main thread in small slices.
  function solveOnMainThread(salt, bits) {
    var solve = localSolver(), t = Date.now(), n = 0;
    return new Promise(function (resolve) {
      (function step() {
        var r = solve(salt, bits, n, n + 20000);
        if (r >= 0) return resolve({ n: r, ms: Date.now() - t });
        n += 20000; setTimeout(step, 0);
      })();
    });
  }

  function signals() {
    var s = { ua: navigator.userAgent, wd: navigator.webdriver === true, langs: (navigator.languages || []).length, plugins: navigator.plugins ? navigator.plugins.length : -1, hc: navigator.hardwareConcurrency || 0, ow: window.outerWidth, oh: window.outerHeight };
    try { var c = document.createElement("canvas").getContext("webgl"); var ext = c && c.getExtension("WEBGL_debug_renderer_info"); if (ext) s.gl = String(c.getParameter(ext.UNMASKED_RENDERER_WEBGL)).slice(0, 120); } catch (e) { /* ignore */ }
    try { var hit = false; var err = new Error(); Object.defineProperty(err, "stack", { get: function () { hit = true; return ""; } }); console.debug(err); s.cdp = hit; } catch (e) { /* ignore */ }
    return s;
  }

  function getJSON(url, opts) {
    return fetch(url, Object.assign({ credentials: "omit", mode: "cors" }, opts || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || ("HTTP " + r.status)); e.status = r.status; throw e; } return j; });
    });
  }

  function tryPat(url) {
    if (!url) return Promise.resolve(null);
    // Safari answers the 401 PrivateToken challenge by itself and retries; other browsers just get the 401.
    return fetch(url, { credentials: "omit", mode: "cors" }).then(function (r) { return r.ok ? r.json().then(function (j) { return j.token || null; }) : null; }).catch(function () { return null; });
  }

  function execute(sitekey) {
    if (!sitekey) return Promise.reject(new Error("AttestOS: data-sitekey is missing"));
    return getJSON(API + "/api/v1/challenge?sitekey=" + encodeURIComponent(sitekey)).then(function (c) {
      return tryPat(c.pat).then(function (patToken) {
        if (patToken) return patToken;
        return solveInWorker(c.salt, c.difficulty).catch(function () { return solveOnMainThread(c.salt, c.difficulty); }).then(function (res) {
          var sg = signals(); sg.ms = res.ms;
          return getJSON(API + "/api/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: c.challenge, nonce: res.n, signals: sg }) }).then(function (r) { return r.token; });
        });
      });
    });
  }

  var STYLE = ".attestos-badge{display:inline-flex;align-items:center;gap:6px;font:12px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;color:#475569;padding:4px 0}.attestos-badge i{width:10px;height:10px;border-radius:50%;background:#cbd5e1;display:inline-block}.attestos-badge.ok i{background:#10b981}.attestos-badge.err i{background:#ef4444}.attestos-badge a{color:inherit}";
  function ensureStyle() { if (document.getElementById("attestos-style")) return; var st = document.createElement("style"); st.id = "attestos-style"; st.textContent = STYLE; (document.head || document.documentElement).appendChild(st); }

  function render(el, opts) {
    opts = opts || {};
    var sitekey = opts.sitekey || el.getAttribute("data-sitekey");
    var cbName = opts.callback || el.getAttribute("data-callback");
    var form = el.closest ? el.closest("form") : null;
    var input = document.createElement("input");
    input.type = "hidden"; input.name = el.getAttribute("data-response-field") || "attestos-response";
    var badge = document.createElement("span");
    badge.className = "attestos-badge"; badge.setAttribute("role", "status"); badge.setAttribute("aria-live", "polite");
    badge.innerHTML = '<i aria-hidden="true"></i><span>Checking your browser privately…</span>';
    if (el.getAttribute("data-badge") === "hidden") badge.style.display = "none";
    ensureStyle();
    el.appendChild(input); el.appendChild(badge);
    var timer = null, busy = false;
    function setText(cls, text) { badge.className = "attestos-badge " + cls; badge.lastChild.textContent = text; }
    function run() {
      if (busy) return; busy = true;
      execute(sitekey).then(function (token) {
        input.value = token; setText("ok", "Verified privately · AttestOS");
        el.setAttribute("data-attestos-ready", "1");
        var cb = typeof cbName === "function" ? cbName : cbName && window[cbName];
        if (typeof cb === "function") cb(token);
        clearTimeout(timer); timer = setTimeout(function () { input.value = ""; run(); }, REFRESH_MS);
      }).catch(function (e) {
        setText("err", "Verification failed (" + (e && e.message ? e.message : "network") + "). Retrying…");
        clearTimeout(timer); timer = setTimeout(run, 8000);
      }).then(function () { busy = false; });
    }
    // A token is single-use: after the form is submitted, fetch a fresh one for a possible second submit.
    if (form) form.addEventListener("submit", function () { setTimeout(function () { input.value = ""; clearTimeout(timer); timer = setTimeout(run, 1500); }, 0); });
    run();
    return { reset: function () { input.value = ""; run(); }, getResponse: function () { return input.value; } };
  }

  // ---------- passkeys (AttestKit) ----------
  var b64u = {
    enc: function (buf) { var s = "", b = new Uint8Array(buf); for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
    dec: function (str) { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; var s = atob(str), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b.buffer; },
  };
  var passkey = {
    /** `begin` = the JSON your backend got from POST /api/v1/passkeys/register/begin (with your secret). */
    register: function (begin) {
      var pk = begin.publicKey;
      var opts = Object.assign({}, pk, { challenge: b64u.dec(pk.challenge), user: Object.assign({}, pk.user, { id: b64u.dec(pk.user.id) }), excludeCredentials: (pk.excludeCredentials || []).map(function (c) { return { type: c.type, id: b64u.dec(c.id) }; }) });
      return navigator.credentials.create({ publicKey: opts }).then(function (cred) {
        return getJSON(API + "/api/v1/passkeys/register/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: begin.token, credential: { id: cred.id, type: cred.type, response: { clientDataJSON: b64u.enc(cred.response.clientDataJSON), attestationObject: b64u.enc(cred.response.attestationObject) } } }) });
      });
    },
    /** Returns {token, user_id}: send token to your backend, which redeems it at /api/siteverify. */
    login: function (o) {
      return getJSON(API + "/api/v1/passkeys/login/begin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sitekey: o.sitekey, user_id: o.userId || "" }) }).then(function (b) {
        var pk = b.publicKey;
        var opts = Object.assign({}, pk, { challenge: b64u.dec(pk.challenge), allowCredentials: (pk.allowCredentials || []).map(function (c) { return { type: c.type, id: b64u.dec(c.id) }; }) });
        return navigator.credentials.get({ publicKey: opts, mediation: o.mediation || "optional" }).then(function (cred) {
          return getJSON(API + "/api/v1/passkeys/login/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: b.token, credential: { id: cred.id, type: cred.type, response: { clientDataJSON: b64u.enc(cred.response.clientDataJSON), authenticatorData: b64u.enc(cred.response.authenticatorData), signature: b64u.enc(cred.response.signature), userHandle: cred.response.userHandle ? b64u.enc(cred.response.userHandle) : null } } }) });
        });
      });
    },
  };

  window.AttestOS = { version: "1.0.0", execute: execute, render: render, passkey: passkey, _solve: function (s, b) { return localSolver()(s, b, 0, 4294967295); } };
  function boot() { var els = document.querySelectorAll(".attestos[data-sitekey]:not([data-attestos-init])"); for (var i = 0; i < els.length; i++) { els[i].setAttribute("data-attestos-init", "1"); render(els[i]); } }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();

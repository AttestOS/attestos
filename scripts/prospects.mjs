#!/usr/bin/env node
/**
 * Daily prospect finder (GitHub Action, Node 20, no dependencies).
 *
 * Honest by construction: a domain becomes a prospect only when
 *   1. one of its own public sign-up / login / contact pages really loads a VISIBLE challenge
 *      (reCAPTCHA v2 checkbox, hCaptcha, Arkose/FunCaptcha, GeeTest), and
 *   2. the same site publishes a role contact address on its own domain (hello@, info@, contact@, sales@ …),
 *      found on one of its own pages (we record which page as contact_source).
 * The Worker re-checks all of this server-side before inserting, and outreach only starts once the owner sets
 * POSTAL_ADDRESS and switches it on in the console.
 *
 * Input: Tranco top-1M list (research ranking, CC BY 4.0) in tranco.csv ("rank,domain"). A rotating window of
 * ranks 20,000–500,000 (mid-size businesses, not giants) is checked each day.
 *
 * Env: AO_URL (https://attestos-edge.attestos.workers.dev), AO_OPS_TOKEN, BATCH (default 300), DRY=1 (print only).
 */
import fs from "node:fs";

const AO_URL = (process.env.AO_URL || "https://attestos-edge.attestos.workers.dev").replace(/\/$/, "");
const TOKEN = process.env.AO_OPS_TOKEN || "";
const BATCH = Math.min(1000, Number(process.env.BATCH || 300));
const DRY = process.env.DRY === "1";
const CONCURRENCY = 12;
const DEADLINE = Date.now() + Number(process.env.MAX_MINUTES || 12) * 60_000;
const UA = `Mozilla/5.0 (compatible; AttestOS-scanner/1.0; +${AO_URL}/scanner/)`;

// Keep in sync with worker/src/scanner.ts VENDORS (worker/test/growth.test.ts checks it).
export const HIGH_FRICTION_VENDORS = [
  { id: "recaptcha_v2", test: /(google\.com|recaptcha\.net)\/recaptcha\/api\.js(?![^"']*render=(?!explicit)[\w-]{10,})|class=["'][^"']*g-recaptcha/i },
  { id: "hcaptcha", test: /hcaptcha\.com\/1\/api\.js|class=["'][^"']*h-captcha/i },
  { id: "arkose", test: /arkoselabs\.com|funcaptcha/i },
  { id: "geetest", test: /geetest\.com|initGeetest/i },
];
const SKIP_TLD = /\.(gov|mil|edu)(\.[a-z]{2})?$|\.gov\.[a-z]{2}$|\.ac\.[a-z]{2}$/;
const ROLE = /^(hello|hi|info|contact|contactus|sales|team|support|help|enquiries|inquiries|office|business|partners|partnerships|marketing|growth|founders?)$/i;
const NEVER = /^(no-?reply|do-?not-?reply|abuse|privacy|legal|dpo|gdpr|security|postmaster|hostmaster|webmaster|admin|root|careers|jobs|hr|press|media|billing|accounts?|invoices?)$/i;
const PAGE_HINT = /\/(sign-?up|register|registration|join|create-account|get-started|login|log-in|signin|sign-in|contact|contact-us|support|demo|request-demo)(\/|\?|$|\.)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, max = 600_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,*/*;q=0.5" }, redirect: "follow", signal: ctl.signal });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("html")) return null;
    const reader = r.body.getReader(); let got = 0; const parts = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; parts.push(value); if (got > max) { ctl.abort(); break; } }
    return { url: r.url, html: Buffer.concat(parts.map((p) => Buffer.from(p))).toString("utf8") };
  } catch { return null; } finally { clearTimeout(t); }
}
const base = (h) => h.replace(/^www\./, "");
const onSite = (u, domain) => { try { const h = new URL(u).hostname; return h === base(domain) || h.endsWith("." + base(domain)); } catch { return false; } };
function kindOf(u) { const p = new URL(u).pathname.toLowerCase(); return /sign-?up|register|join|create-account|get-started/.test(p) ? "signup" : /log-?in|sign-?in/.test(p) ? "login" : /contact|support|demo/.test(p) ? "contact" : p === "/" ? "home" : "other"; }
function links(html, from, domain) {
  const out = new Set();
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    try { const u = new URL(m[1], from); if (u.protocol === "https:" && onSite(u.href, domain) && PAGE_HINT.test(u.pathname)) out.add(u.origin + u.pathname); } catch { /* ignore */ }
  }
  return [...out].slice(0, 6);
}
function emails(html, domain) {
  const found = new Set();
  const text = html.replace(/&#64;|&#x40;|\s*\[at\]\s*|\s*\(at\)\s*/gi, "@");
  for (const m of text.matchAll(/(?:mailto:)?([a-z0-9._%+-]{1,40})@([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const local = m[1].toLowerCase(), host = m[2].toLowerCase();
    if (!(host === base(domain) || host.endsWith("." + base(domain)))) continue;
    if (NEVER.test(local) || !ROLE.test(local)) continue;
    found.add(`${local}@${host}`);
  }
  // Prefer sales/hello/contact over support.
  return [...found].sort((a, b) => (/^support|^help/.test(a) ? 1 : 0) - (/^support|^help/.test(b) ? 1 : 0));
}
export const stats = { loaded: 0, vendor: 0, email: 0 };
const vendorOf = (html) => HIGH_FRICTION_VENDORS.find((v) => v.test.test(html))?.id || null;

export async function examine(domain) {
  if (SKIP_TLD.test(domain)) return null;
  const home = await get(`https://${domain}/`);
  if (!home || !onSite(home.url, domain)) return null;
  const pages = [home];
  for (const u of links(home.html, home.url, domain)) { if (Date.now() > DEADLINE) break; const p = await get(u); if (p && onSite(p.url, domain)) pages.push(p); }
  let hit = null, contact = null;
  for (const p of pages) {
    const v = vendorOf(p.html);
    if (v && !hit) hit = { vendor: v, page_url: p.url, page_kind: kindOf(p.url) };
    const e = emails(p.html, domain);
    if (e.length && !contact) contact = { contact_email: e[0], contact_source: p.url };
  }
  stats.loaded++; if (hit) stats.vendor++; if (contact) stats.email++;
  if (!hit || !contact) return null;
  return { domain: base(new URL(home.url).hostname), ...hit, ...contact, source: "tranco" };
}

async function main() {
  const csv = fs.readFileSync(process.env.TRANCO || "tranco.csv", "utf8").split("\n");
  const window = csv.slice(20_000, 500_000).map((l) => l.split(",")[1]?.trim()).filter(Boolean);
  const day = Math.floor(Date.now() / 86_400_000);
  const start = (day * BATCH) % window.length;
  let known = new Set();
  if (TOKEN) {
    try { const r = await fetch(`${AO_URL}/api/ops/known`, { headers: { authorization: `Bearer ${TOKEN}` } }); if (r.ok) known = new Set((await r.json()).domains); } catch { /* ignore */ }
  }
  const todo = window.slice(start, start + BATCH).filter((d) => !known.has(base(d)));
  console.log(`window ${start}…${start + BATCH} of ${window.length}; ${todo.length} to check`);
  const found = [];
  let i = 0, checked = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < todo.length && Date.now() < DEADLINE) {
      const d = todo[i++];
      const p = await examine(d).catch(() => null);
      checked++;
      if (p) { found.push(p); console.log(`+ ${p.domain} ${p.vendor} on ${p.page_kind} → ${p.contact_email}`); }
      await sleep(50);
    }
  }));
  console.log(`checked ${checked}, homepages loaded ${stats.loaded}, visible challenge ${stats.vendor}, role email ${stats.email}, prospects ${found.length}`);
  if (DRY || !found.length) return;
  if (!TOKEN) { console.log("AO_OPS_TOKEN not set: not posting"); return; }
  for (let k = 0; k < found.length; k += 100) {
    const r = await fetch(`${AO_URL}/api/ops/prospects`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ prospects: found.slice(k, k + 100) }) });
    console.log("posted", r.status, await r.text());
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });

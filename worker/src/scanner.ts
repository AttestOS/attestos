import type { Env } from "./env";
import { first, run } from "./lib/db";
import { randomId } from "./lib/crypto";
import { HttpError, json, readObject, str } from "./lib/http";
import { limited } from "./lib/security";
import { budgetState } from "./lib/quota";
import { isEmail, normHost, safeJson } from "./lib/util";
import { notifyOwner } from "./lib/notify";

/** Free public scanner (the lead magnet). It really fetches the page, robots.txt and security.txt and reports what
 *  it finds: which CAPTCHA (if any) guards the page, what the forms are, how the site treats AI crawlers, and which
 *  security headers are missing. Nothing is invented: every finding quotes what was seen. */

export const VENDORS: { id: string; name: string; test: RegExp; friction: "high" | "medium" | "low" | "none" }[] = [
  { id: "recaptcha_enterprise", name: "reCAPTCHA Enterprise", test: /recaptcha\/enterprise\.js/i, friction: "medium" },
  { id: "recaptcha_v3", name: "reCAPTCHA v3", test: /recaptcha\/api\.js\?[^"']*render=(?!explicit)[\w-]{10,}/i, friction: "low" },
  { id: "recaptcha_v2", name: "reCAPTCHA v2", test: /(google\.com|recaptcha\.net)\/recaptcha\/api\.js(?![^"']*render=(?!explicit)[\w-]{10,})|class=["'][^"']*g-recaptcha/i, friction: "high" },
  { id: "hcaptcha", name: "hCaptcha", test: /hcaptcha\.com\/1\/api\.js|class=["'][^"']*h-captcha/i, friction: "high" },
  { id: "turnstile", name: "Cloudflare Turnstile", test: /challenges\.cloudflare\.com\/turnstile/i, friction: "none" },
  { id: "friendlycaptcha", name: "Friendly Captcha", test: /friendly-?challenge|friendlycaptcha/i, friction: "none" },
  { id: "arkose", name: "Arkose Labs / FunCaptcha", test: /arkoselabs\.com|funcaptcha/i, friction: "high" },
  { id: "geetest", name: "GeeTest", test: /geetest\.com|initGeetest/i, friction: "high" },
  { id: "attestos", name: "AttestOS", test: /\/v1\/attestos\.js/i, friction: "none" },
];

export const AI_BOTS: { ua: string; owner: string; kind: "training" | "search" | "assistant" }[] = [
  { ua: "GPTBot", owner: "OpenAI", kind: "training" },
  { ua: "OAI-SearchBot", owner: "OpenAI", kind: "search" },
  { ua: "ChatGPT-User", owner: "OpenAI", kind: "assistant" },
  { ua: "ClaudeBot", owner: "Anthropic", kind: "training" },
  { ua: "Claude-User", owner: "Anthropic", kind: "assistant" },
  { ua: "Google-Extended", owner: "Google", kind: "training" },
  { ua: "Applebot-Extended", owner: "Apple", kind: "training" },
  { ua: "PerplexityBot", owner: "Perplexity", kind: "search" },
  { ua: "Perplexity-User", owner: "Perplexity", kind: "assistant" },
  { ua: "CCBot", owner: "Common Crawl", kind: "training" },
  { ua: "Bytespider", owner: "ByteDance", kind: "training" },
  { ua: "Meta-ExternalAgent", owner: "Meta", kind: "training" },
  { ua: "Amazonbot", owner: "Amazon", kind: "search" },
];

const HEADERS = [
  { h: "content-security-policy", name: "Content-Security-Policy", why: "limits which scripts can run (XSS damage control)" },
  { h: "strict-transport-security", name: "Strict-Transport-Security", why: "forces HTTPS on return visits" },
  { h: "x-content-type-options", name: "X-Content-Type-Options", why: "stops MIME sniffing" },
  { h: "referrer-policy", name: "Referrer-Policy", why: "keeps full URLs out of third-party referrers" },
  { h: "permissions-policy", name: "Permissions-Policy", why: "switches off camera/mic/geolocation you don't use" },
];

// ---------- robots.txt ----------
export interface RobotsGroup { agents: string[]; allow: string[]; disallow: string[] }
export function parseRobots(txt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let cur: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/).slice(0, 5000)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === "allow") cur.allow.push(v);
    if (k === "disallow") cur.disallow.push(v);
  }
  return groups;
}
/** "blocked" = the bot may not fetch "/" ; "allowed" = it may; source = which group decided. */
export function botAccess(groups: RobotsGroup[], ua: string): { access: "blocked" | "allowed"; rule: "named" | "wildcard" | "none" } {
  const named = groups.filter((g) => g.agents.includes(ua.toLowerCase()));
  const use = named.length ? named : groups.filter((g) => g.agents.includes("*"));
  if (!use.length) return { access: "allowed", rule: "none" };
  const dis = use.flatMap((g) => g.disallow).filter(Boolean);
  const allow = use.flatMap((g) => g.allow);
  const blocked = dis.some((d) => d === "/" || d === "/*") && !allow.some((a) => a === "/" || a === "/$");
  return { access: blocked ? "blocked" : "allowed", rule: named.length ? "named" : "wildcard" };
}

// ---------- page analysis ----------
export function detectVendors(html: string) { return VENDORS.filter((v) => v.test.test(html)).map((v) => ({ id: v.id, name: v.name, friction: v.friction })); }
export function pageKind(html: string, url: string): "signup" | "login" | "contact" | "home" | "other" {
  const pw = (html.match(/type=["']?password/gi) || []).length;
  const p = new URL(url).pathname.toLowerCase();
  if (pw >= 2 || /sign-?up|register|create-account|join/.test(p)) return "signup";
  if (pw === 1 || /log-?in|sign-?in|account/.test(p)) return "login";
  if (/contact|support|demo|quote/.test(p) || /<textarea/i.test(html)) return "contact";
  return p === "/" ? "home" : "other";
}
export function findEmails(html: string, domain: string): string[] {
  const out = new Set<string>();
  const decoded = html.replace(/&#64;|&commat;|\[at\]|\(at\)/gi, "@");
  for (const m of decoded.matchAll(/mailto:([^"'?\s>]+)/gi)) { try { out.add(decodeURIComponent(m[1]).toLowerCase()); } catch { /* ignore */ } }
  for (const m of decoded.matchAll(/\b[a-z0-9._%+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,24}\b/gi)) out.add(m[0].toLowerCase());
  const base = domain.replace(/^www\./, "");
  return [...out].filter((e) => isEmail(e) && !/\.(png|jpe?g|gif|webp|svg)$/i.test(e) && !/example\.|sentry|wixpress|noreply|no-reply|donotreply/i.test(e) && e.split("@")[1].endsWith(base)).slice(0, 10);
}

async function fetchText(url: string, max = 1_000_000, timeoutMs = 8000): Promise<{ status: number; url: string; headers: Headers; text: string } | null> {
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "AttestOS-Scanner/1.0 (+https://attestos-edge.attestos.workers.dev/scanner/)", accept: "text/html,text/plain;q=0.9,*/*;q=0.5" }, signal: AbortSignal.timeout(timeoutMs) });
    const reader = res.body?.getReader();
    let text = "", size = 0;
    if (reader) {
      const dec = new TextDecoder();
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; text += dec.decode(value, { stream: true }); if (size > max) { await reader.cancel().catch(() => {}); break; } }
    }
    return { status: res.status, url: res.url || url, headers: res.headers, text };
  } catch { return null; }
}

export function targetUrl(input: string): URL {
  let s = str(input, 500);
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { throw new HttpError(400, "Enter a website address, e.g. example.com/signup"); }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || (u.port && !["80", "443"].includes(u.port))) throw new HttpError(400, "Only public http(s) websites can be scanned");
  const h = normHost(u.hostname);
  if (!h || h === "localhost" || h.startsWith("*.") || /\.(local|internal|lan|home|arpa)$/.test(h)) throw new HttpError(400, "Only public websites can be scanned");
  return u;
}

export async function scan(url: URL) {
  const page = await fetchText(url.toString());
  if (!page) throw new HttpError(502, "We couldn't reach that site (timeout or connection refused)");
  const final = new URL(page.url);
  const [robots, sec] = await Promise.all([
    fetchText(`${final.origin}/robots.txt`, 200_000, 5000),
    fetchText(`${final.origin}/.well-known/security.txt`, 50_000, 5000),
  ]);
  const html = page.text;
  const vendors = detectVendors(html);
  const forms = (html.match(/<form\b/gi) || []).length;
  const kind = pageKind(html, final.toString());
  const robotsOk = !!robots && robots.status === 200 && !/<html/i.test(robots.text.slice(0, 500));
  const groups = robotsOk ? parseRobots(robots!.text) : [];
  const bots = AI_BOTS.map((b) => ({ ...b, ...botAccess(groups, b.ua) }));
  const headers = HEADERS.map((x) => ({ name: x.name, present: page.headers.has(x.h), why: x.why }));
  const hasSecTxt = !!sec && sec.status === 200 && /contact\s*:/i.test(sec.text);

  // Score: start at 100, subtract for real, observed problems.
  let score = 100;
  const findings: { severity: "high" | "medium" | "low" | "info"; title: string; detail: string }[] = [];
  const hi = vendors.filter((v) => v.friction === "high");
  if (hi.length) { score -= 25; findings.push({ severity: "high", title: `Visible CAPTCHA: ${hi.map((v) => v.name).join(", ")}`, detail: "Image/checkbox puzzles add friction for every real visitor on this page and send visitor data to a third party. An invisible proof-of-work check runs in the background instead." }); }
  if (!vendors.length && forms > 0 && (kind === "signup" || kind === "login" || kind === "contact")) { score -= 20; findings.push({ severity: "medium", title: `Unprotected ${kind} form`, detail: `We found ${forms} form${forms === 1 ? "" : "s"} and no bot check on this page, so scripted sign-ups / credential stuffing / form spam only meet whatever the server does.` }); }
  if (vendors.some((v) => v.id === "recaptcha_v3" || v.id === "recaptcha_enterprise")) findings.push({ severity: "info", title: "Score-based reCAPTCHA", detail: "No puzzle for most visitors, but it loads Google scripts on the page (a privacy/consent question in the EU)." });
  const missing = headers.filter((h) => !h.present);
  if (missing.length) { score -= Math.min(25, missing.length * 5); findings.push({ severity: missing.length >= 3 ? "medium" : "low", title: `Missing security headers: ${missing.map((h) => h.name).join(", ")}`, detail: missing.map((h) => `${h.name} ${h.why}.`).join(" ") }); }
  const trainingOpen = bots.filter((b) => b.kind === "training" && b.access === "allowed");
  if (!robotsOk) { score -= 10; findings.push({ severity: "low", title: "No robots.txt", detail: "Crawlers (AI ones included) get no instructions at all." }); }
  else if (trainingOpen.length === bots.filter((b) => b.kind === "training").length) { score -= 10; findings.push({ severity: "low", title: "AI training crawlers not addressed", detail: `robots.txt doesn't block any model-training crawler (${trainingOpen.map((b) => b.ua).join(", ")}). That's fine if intended; if not, add rules. Note robots.txt is a request, not enforcement.` }); }
  if (!hasSecTxt) { score -= 5; findings.push({ severity: "low", title: "No security.txt", detail: "Researchers have no published way to report a vulnerability (RFC 9116)." }); }
  if (final.protocol !== "https:") { score -= 20; findings.push({ severity: "high", title: "Page served over plain HTTP", detail: "Form data travels unencrypted." }); }

  return {
    url: final.toString(), domain: final.hostname, status: page.status, kind, forms, vendors, bots, headers,
    robots: robotsOk ? "found" : "missing", security_txt: hasSecTxt, score: Math.max(0, score), findings,
    emails: findEmails(html, final.hostname),
    scanned_at: new Date().toISOString(),
  };
}

// ---------- routes ----------
export async function scannerRoute(req: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response | null> {
  if (path === "/api/v1/scan" && req.method === "POST") {
    if (await limited(env.SCAN_RL, req, "scan")) throw new HttpError(429, "A few scans a minute at most. Try again shortly.");
    const b = await readObject(req, 2048);
    const r = await scan(targetUrl(str(b.url, 500)));
    const { emails: _e, ...pub } = r; // published addresses are only used by the outreach pipeline, never shown
    let id: string | null = null;
    if (!(await budgetState(env)).tight) {
      id = randomId(12);
      await run(env, "INSERT INTO scans (id, domain, url, score, result_json) VALUES (?, ?, ?, ?, ?)", id, r.domain, r.url, r.score, JSON.stringify(pub));
    }
    return json({ id, ...pub });
  }
  let m = path.match(/^\/api\/v1\/scan\/([a-z0-9]{12})$/);
  if (m && req.method === "GET") {
    const row = await first<{ result_json: string }>(env, "SELECT result_json FROM scans WHERE id = ?", m[1]);
    if (!row) throw new HttpError(404, "Report not found (reports are kept 90 days)");
    return json({ id: m[1], ...safeJson(row.result_json, {}) }, 200, { "cache-control": "public, max-age=300" });
  }
  m = path.match(/^\/api\/v1\/scan\/([a-z0-9]{12})\/lead$/);
  if (m && req.method === "POST") {
    if (await limited(env.SCAN_RL, req, "lead")) throw new HttpError(429, "Slow down a little.");
    const b = await readObject(req, 1024);
    const email = str(b.email, 200).toLowerCase();
    if (!isEmail(email)) throw new HttpError(400, "Enter a valid email address");
    const row = await first<{ domain: string }>(env, "SELECT domain FROM scans WHERE id = ?", m[1]);
    if (!row) throw new HttpError(404, "Report not found");
    const ins = await run(env, "INSERT OR IGNORE INTO leads (email, domain, scan_id, source) VALUES (?, ?, ?, 'scanner')", email, row.domain, m[1]);
    if (Number(ins.meta?.changes ?? 0)) ctx.waitUntil(notifyOwner(env, { title: `Scanner lead: ${row.domain}`, message: `${email} asked for help with ${row.domain}`, priority: 4 }).then(() => undefined));
    return json({ ok: true });
  }
  return null;
}

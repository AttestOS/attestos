import type { Env } from "./env";
import { first, logError, run } from "./lib/db";
import { b64url, hmacSha256, signToken, verifyToken } from "./lib/crypto";
import { HttpError, json, readBodyText, str } from "./lib/http";
import { budgetState } from "./lib/quota";
import { limited } from "./lib/security";
import { getUsage, bumpUsage } from "./lib/usage";
import { hostAllowed, nowSec } from "./lib/util";
import { has } from "./plans";
import { getSite, getSiteBySecret, type Site } from "./sites";
import { assess } from "./signals";
import { accountMonth, bump } from "./stats";
import { patProbeUrl } from "./pat";

/** Ghost-PoW: the widget asks for a signed challenge, solves it in the visitor's browser, trades the solution for a
 *  short-lived pass token, and the customer's BACKEND redeems that token once at /api/siteverify with its secret
 *  (the same shape as reCAPTCHA/Turnstile siteverify).
 *
 *  Security properties (each one has a test in test/pow.test.ts):
 *   - challenges and pass tokens are HMAC-signed with keys derived from the APP_SECRET Worker secret;
 *   - the difficulty is chosen by the server (site policy + adaptive surge), never by the client;
 *   - challenges are bound to the site key and the page's hostname (must be one of the site's domains);
 *   - a pass token is single-use: the first siteverify inserts (site, salt) and every replay fails;
 *   - pass tokens expire after 5 minutes, challenges after 5 minutes. */

export const CHALLENGE_TTL = 300;
export const PASS_TTL = 300;
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};
const cjson = (data: unknown, status = 200) => json(data, status, { ...CORS, "cache-control": "no-store" });

const keyCache = new Map<string, string>();
async function subkey(env: Env, purpose: string): Promise<string> {
  if (!env.APP_SECRET || env.APP_SECRET.length < 32) throw new HttpError(503, "Server not configured (APP_SECRET missing)");
  const k = `${purpose}:${env.APP_SECRET.slice(0, 8)}`;
  let v = keyCache.get(k);
  if (!v) { v = b64url(await hmacSha256(env.APP_SECRET, `attestos:${purpose}:v1`)); keyCache.set(k, v); }
  return v;
}

/** The page hostname a browser request comes from (Origin, else Referer). */
export function requestHost(req: Request): string | null {
  for (const h of [req.headers.get("origin"), req.headers.get("referer")]) {
    if (!h || h === "null") continue;
    try { return new URL(h).hostname.toLowerCase(); } catch { /* ignore */ }
  }
  return null;
}
export function hostOk(site: Site, host: string | null): boolean {
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1") return site.policy.allowLocalhost;
  return hostAllowed(host, site.domains);
}

// ---------- adaptive difficulty (per edge location, in memory) ----------
const traffic = new Map<string, { minute: number; n: number; surge: boolean }>();
export function adaptiveBump(site: Site, alert?: (n: number) => void): number {
  const minute = Math.floor(Date.now() / 60_000);
  let t = traffic.get(site.id);
  if (!t || t.minute !== minute) { t = { minute, n: 0, surge: t?.surge ?? false }; traffic.set(site.id, t); }
  t.n++;
  if (traffic.size > 10_000) traffic.clear();
  if (!(site.policy.adaptive && has(site.ent, "adaptive"))) return 0;
  const lim = site.policy.surgePerMinute;
  const surge = t.n > lim;
  if (surge && !t.surge && alert) alert(t.n);
  t.surge = surge;
  return t.n > lim * 2 ? 2 : surge ? 1 : 0;
}

async function surgeAlert(env: Env, site: Site, n: number) {
  if (!has(site.ent, "alerts") || !site.policy.alertWebhook) return;
  // At most one alert per site per hour (one D1 counter row).
  const hourKey = `alert:${site.id}:${new Date().toISOString().slice(0, 13)}`;
  if ((await getUsage(env, hourKey, "day")) > 0) return;
  await bumpUsage(env, hourKey, "day");
  const text = `AttestOS: request surge on ${site.name} (${n}+ challenges in one minute at one edge location). Difficulty raised automatically.`;
  try { await fetch(site.policy.alertWebhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }) }); }
  catch (e) { await logError(env, "alert", e); }
}

// ---------- challenge ----------
export async function challenge(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (await limited(env.EDGE_RL, req, "chal")) return cjson({ error: "rate_limited" }, 429);
  const url = new URL(req.url);
  const site = await getSite(env, url.searchParams.get("sitekey") || "");
  if (!site || site.status !== "active") return cjson({ error: "invalid_sitekey" }, 400);
  const host = requestHost(req);
  if (!hostOk(site, host)) return cjson({ error: "hostname_not_allowed", host }, 403);
  const bumpBits = adaptiveBump(site, (n) => ctx.waitUntil(surgeAlert(env, site, n)));
  const difficulty = Math.min(28, site.policy.difficulty + bumpBits);
  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const token = await signToken(await subkey(env, "challenge"), { s: site.id, n: salt, d: difficulty, h: host }, CHALLENGE_TTL);
  const pat = site.policy.pat && has(site.ent, "pat") ? await patProbeUrl(env, site.id, host) : null;
  return cjson({ challenge: token, salt, difficulty, expires_in: CHALLENGE_TTL, pat });
}

export function leadingZeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) { n += 8; continue; }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
}
export async function powHash(salt: string, nonce: number): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${nonce}`)));
}

/** Issue a pass token (shared by PoW, Private Access Tokens and passkeys). */
export async function issuePass(env: Env, p: { site: Site; salt: string; host: string | null; method: "pow" | "pat" | "passkey"; difficulty?: number; risk?: number; flags?: string[]; user?: string }) {
  return signToken(await subkey(env, "pass"), {
    s: p.site.id, n: p.salt, h: p.host, m: p.method, d: p.difficulty ?? 0, r: p.risk ?? null, f: p.flags ?? [], u: p.user ?? null, t: nowSec(),
  }, PASS_TTL);
}

// ---------- redeem ----------
export async function redeem(req: Request, env: Env): Promise<Response> {
  if (await limited(env.EDGE_RL, req, "redeem")) return cjson({ error: "rate_limited" }, 429);
  let b: any;
  try { b = JSON.parse(await readBodyText(req, 16 * 1024)); } catch { return cjson({ error: "bad_json" }, 400); }
  const c = await verifyToken<{ s: string; n: string; d: number; h: string | null }>(await subkey(env, "challenge"), str(b?.challenge, 2000));
  if (!c) return cjson({ error: "invalid_or_expired_challenge" }, 400);
  const site = await getSite(env, c.s);
  if (!site || site.status !== "active") return cjson({ error: "invalid_sitekey" }, 400);
  const host = requestHost(req);
  if (host !== c.h) return cjson({ error: "hostname_mismatch" }, 403);
  const nonce = Number(b?.nonce);
  if (!Number.isSafeInteger(nonce) || nonce < 0) return cjson({ error: "bad_nonce" }, 400);
  if (leadingZeroBits(await powHash(c.n, nonce)) < c.d) return cjson({ error: "invalid_solution" }, 400);

  let risk: number | undefined, flags: string[] | undefined;
  if (has(site.ent, "signals") && site.policy.signals !== "off") {
    const a = assess(b?.signals, { headerUa: req.headers.get("user-agent") || "", attempts: nonce });
    risk = a.risk; flags = a.flags;
    if (site.policy.signals === "enforce" && a.risk >= site.policy.riskThreshold) return cjson({ error: "automation_suspected", flags: a.flags }, 403);
  }
  const token = await issuePass(env, { site, salt: c.n, host, method: "pow", difficulty: c.d, risk, flags });
  return cjson({ token, expires_in: PASS_TTL });
}

// ---------- siteverify (customer backend, secret key) ----------
async function readParams(req: Request): Promise<Record<string, string>> {
  const raw = await readBodyText(req, 16 * 1024);
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try { const o = JSON.parse(raw); return o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, str(v, 4000)])) : {}; } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export async function siteverify(req: Request, env: Env): Promise<Response> {
  const p = await readParams(req);
  const fail = (codes: string[], status = 200, extra: Record<string, unknown> = {}) => json({ success: false, "error-codes": codes, ...extra }, status, { "cache-control": "no-store" });
  if (!p.secret) return fail(["missing-input-secret"]);
  if (!p.response) return fail(["missing-input-response"]);
  const site = await getSiteBySecret(env, p.secret);
  if (!site) return fail(["invalid-input-secret"]);
  if (site.status !== "active") return fail(["site-disabled"]);

  const t = await verifyToken<{ s: string; n: string; h: string | null; m: "pow" | "pat" | "passkey"; d: number; r: number | null; f: string[]; u: string | null; t: number }>(await subkey(env, "pass"), p.response);
  if (!t || t.s !== site.id) { await bump(env, site, "fail"); return fail(["invalid-input-response"]); }

  const usage = await accountMonth(env, site.account_id);
  if (usage.verifs >= Math.ceil(site.ent.verifications * 1.1)) return fail(["quota-exceeded"], 200, { limit: site.ent.verifications });

  const budget = await budgetState(env);
  let stateless = false;
  if (budget.over) stateless = true; // documented degradation: still signed + unexpired, single-use not enforced
  else {
    try {
      const ins = await run(env, "INSERT OR IGNORE INTO redeemed (site_id, salt, at, method, host, risk) VALUES (?, ?, ?, ?, ?, ?)",
        site.id, t.n, nowSec(), t.m, t.h, t.r);
      if (!Number(ins.meta?.changes ?? 0)) { await bump(env, site, "fail"); return fail(["timeout-or-duplicate"]); }
    } catch (e) { await logError(env, "siteverify", e); return fail(["internal-error"], 500); }
  }
  await bump(env, site, "ok");
  if (t.m === "pat") await bump(env, site, "pat");
  if (t.m === "passkey") await bump(env, site, "passkey");
  if (t.r !== null && t.r >= site.policy.riskThreshold) await bump(env, site, "risky");

  const out: Record<string, unknown> = {
    success: true, challenge_ts: new Date(t.t * 1000).toISOString(), hostname: t.h, method: t.m, "error-codes": [],
  };
  if (t.m === "pow") out.difficulty = t.d;
  if (t.r !== null && has(site.ent, "signals")) { out.risk = t.r; out.signals = t.f; }
  if (t.u) out.user_id = t.u;
  if (stateless) out.stateless = true;
  return json(out, 200, { "cache-control": "no-store" });
}

/** Lookup helper for tests and the portal. */
export async function wasRedeemed(env: Env, siteId: string, salt: string) {
  return !!(await first(env, "SELECT 1 AS x FROM redeemed WHERE site_id = ? AND salt = ?", siteId, salt));
}

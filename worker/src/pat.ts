import type { Env } from "./env";
import { getSetting, logError, setSetting } from "./lib/db";
import { b64url, b64urlToBytes, signToken, verifyToken } from "./lib/crypto";
import { json } from "./lib/http";
import { safeJson } from "./lib/util";
import { toRsaEncryptionSpki } from "./lib/der";
import { CORS, issuePass } from "./pow";
import { has } from "./plans";
import { getSite } from "./sites";

/** Private Access Tokens / Privacy Pass (RFC 9576 architecture, RFC 9577 HTTP auth scheme, RFC 9578 issuance),
 *  token type 0x0002 (publicly verifiable, blind RSA 2048, RSASSA-PSS SHA-384, salt 48).
 *
 *  Flow: the widget fetches /api/v1/pat/probe?t=… . Without a token we answer 401 + `WWW-Authenticate: PrivateToken`.
 *  A supporting client (Safari / iOS 16+, macOS 13+, with Automatic Verification on) obtains a token from the issuer
 *  through Apple's attester and retries with `Authorization: PrivateToken token=…`. We verify the RSA signature
 *  against the issuer's published key and return a pass token (method "pat") — the visitor solved nothing.
 *  Anything else (other browsers, setting off, issuer down) gets the 401 and the widget falls back to Ghost-PoW.
 *
 *  The challenge is stateless: everything needed to rebuild the TokenChallenge rides in the signed `t` parameter.
 *  Single use: the token nonce becomes the pass token's id, which /api/siteverify accepts exactly once. */

const TOKEN_TYPE = 0x0002;
const NK = 256; // RSA-2048 signature length

export function issuers(env: Env): string[] {
  const list = safeJson<unknown>(env.PAT_ISSUERS, null);
  const arr = Array.isArray(list) ? list.map(String) : ["demo-pat.issuer.cloudflare.com"];
  return arr.filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)).slice(0, 3);
}

interface IssuerKey { issuer: string; key: string; id: string; notBefore?: number }
let keyCache: { at: number; keys: IssuerKey[] } | null = null;

async function sha256(b: Uint8Array) { return new Uint8Array(await crypto.subtle.digest("SHA-256", b)); }

export async function refreshIssuerKeys(env: Env): Promise<IssuerKey[]> {
  const keys: IssuerKey[] = [];
  for (const iss of issuers(env)) {
    try {
      const r = await fetch(`https://${iss}/.well-known/private-token-issuer-directory`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const d = (await r.json()) as { "token-keys"?: { "token-type": number; "token-key": string; "not-before"?: number }[] };
      for (const k of d["token-keys"] || []) {
        if (k["token-type"] !== TOKEN_TYPE || typeof k["token-key"] !== "string") continue;
        const raw = b64urlToBytes(k["token-key"].replace(/=+$/, ""));
        keys.push({ issuer: iss, key: k["token-key"], id: b64url(await sha256(raw)), notBefore: k["not-before"] });
      }
    } catch (e) { await logError(env, "pat_directory", `${iss}: ${e instanceof Error ? e.message : e}`); }
  }
  if (keys.length) await setSetting(env, "pat_keys", JSON.stringify(keys));
  keyCache = { at: Date.now(), keys };
  return keys;
}
async function issuerKeys(env: Env): Promise<IssuerKey[]> {
  if (keyCache && Date.now() - keyCache.at < 3600_000 && keyCache.keys.length) return keyCache.keys;
  const stored = safeJson<IssuerKey[]>(await getSetting(env, "pat_keys"), []);
  if (stored.length) { keyCache = { at: Date.now(), keys: stored }; return stored; }
  return refreshIssuerKeys(env);
}

const u16 = (n: number) => [(n >> 8) & 255, n & 255];
export function tokenChallenge(issuer: string, redemptionContext: Uint8Array, originInfo: string): Uint8Array {
  const iss = new TextEncoder().encode(issuer), origin = new TextEncoder().encode(originInfo);
  return new Uint8Array([...u16(TOKEN_TYPE), ...u16(iss.length), ...iss, redemptionContext.length, ...redemptionContext, ...u16(origin.length), ...origin]);
}

export function parseAuthorization(h: string | null): Uint8Array | null {
  const m = (h || "").match(/^PrivateToken\s+token="?([A-Za-z0-9_\-+/=]+)"?/i);
  if (!m) return null;
  try { return b64urlToBytes(m[1].replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")); } catch { return null; }
}

/** Verify a type-2 token against a challenge. Returns the nonce (hex) on success. */
export async function verifyToken2(token: Uint8Array, challenge: Uint8Array, keys: IssuerKey[]): Promise<string | null> {
  if (token.length !== 2 + 32 + 32 + 32 + NK) return null;
  if (((token[0] << 8) | token[1]) !== TOKEN_TYPE) return null;
  const digest = await sha256(challenge);
  if (!token.subarray(34, 66).every((b, i) => b === digest[i])) return null;
  const keyId = b64url(token.subarray(66, 98));
  const k = keys.find((x) => x.id === keyId);
  if (!k) return null;
  try {
    const spki = toRsaEncryptionSpki(b64urlToBytes(k.key.replace(/=+$/, "")));
    const pub = await crypto.subtle.importKey("spki", spki, { name: "RSA-PSS", hash: "SHA-384" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 48 }, pub, token.subarray(98), token.subarray(0, 98));
    return ok ? [...token.subarray(2, 34)].map((b) => b.toString(16).padStart(2, "0")).join("") : null;
  } catch { return null; }
}

/** URL the widget probes (returned by /api/v1/challenge when the site has PAT enabled). */
export async function patProbeUrl(env: Env, siteId: string, host: string | null) {
  const rc = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return `${env.SITE_URL}/api/v1/pat/probe?t=${encodeURIComponent(await signToken(`${env.APP_SECRET}|pat`, { s: siteId, h: host, r: rc }, 300))}`;
}

export async function patProbe(req: Request, env: Env): Promise<Response> {
  const headers = { ...CORS, "cache-control": "no-store" };
  const t = await verifyToken<{ s: string; h: string | null; r: string }>(`${env.APP_SECRET}|pat`, new URL(req.url).searchParams.get("t"));
  if (!t) return json({ error: "invalid_or_expired" }, 400, headers);
  const site = await getSite(env, t.s);
  if (!site || site.status !== "active" || !site.policy.pat || !has(site.ent, "pat")) return json({ error: "pat_not_enabled" }, 400, headers);
  const origin = new URL(env.SITE_URL).hostname;
  const keys = await issuerKeys(env);
  const rc = b64urlToBytes(t.r);
  const token = parseAuthorization(req.headers.get("authorization"));
  if (token) {
    for (const iss of [...new Set(keys.map((k) => k.issuer))]) {
      const nonce = await verifyToken2(token, tokenChallenge(iss, rc, origin), keys.filter((k) => k.issuer === iss));
      if (nonce) return json({ token: await issuePass(env, { site, salt: `pat:${nonce}`, host: t.h, method: "pat" }), method: "pat" }, 200, headers);
    }
  }
  const iss = keys[0]?.issuer;
  if (!iss) return json({ error: "no_issuer" }, 503, headers);
  const k = keys.filter((x) => x.issuer === iss).sort((a, b) => (b.notBefore ?? 0) - (a.notBefore ?? 0)).find((x) => !x.notBefore || x.notBefore * 1000 <= Date.now()) ?? keys[0];
  const challenge = b64url(tokenChallenge(iss, rc, origin));
  return json({ error: "token_required" }, 401, { ...headers, "www-authenticate": `PrivateToken challenge="${challenge}", token-key="${k.key}"`, "access-control-expose-headers": "www-authenticate" });
}

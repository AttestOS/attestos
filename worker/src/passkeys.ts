import type { Env } from "./env";
import { all, first, run } from "./lib/db";
import { b64url, b64urlToBytes, signToken, verifyToken } from "./lib/crypto";
import { HttpError, json, readObject, str } from "./lib/http";
import { limited } from "./lib/security";
import { hostAllowed } from "./lib/util";
import { decodeCbor } from "./lib/cbor";
import { ALGS, parseCoseKey, verifyCose } from "./lib/cose";
import { CORS, hostOk, issuePass, requestHost } from "./pow";
import { getSite, getSiteBySecret, type Site } from "./sites";

/** AttestKit passkeys (WebAuthn Level 2, attestation "none"). The customer's BACKEND starts a registration for one of
 *  its users (secret key), the browser creates the credential, we verify and store the public key. Sign-in is
 *  public (site key): the browser signs our challenge, we verify the signature and hand back a pass token carrying
 *  the customer's user_id, which their backend redeems once at /api/siteverify like any other token. */

const TTL = 300;
const cjson = (d: unknown, s = 200) => json(d, s, { ...CORS, "cache-control": "no-store" });
const label = (env: Env) => `${env.APP_SECRET}|passkey`;
const sha256 = async (b: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof b === "string" ? new TextEncoder().encode(b) : b));
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const newChallenge = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

function rpIdFor(site: Site): string {
  const rp = site.policy.rpId || site.domains.find((d) => !d.startsWith("*.") && d !== "localhost") || site.domains[0]?.replace(/^\*\./, "") || "";
  if (!rp) throw new HttpError(400, "Set a passkey RP ID (a domain) in the site policy first");
  return rp;
}
/** The browser origin must be HTTPS (or http://localhost while developing), allowed for the site, and the RP ID must
 *  be that host or a registrable suffix of it (WebAuthn's own rule). */
function checkOrigin(site: Site, origin: string, rpId: string) {
  let u: URL;
  try { u = new URL(origin); } catch { throw new HttpError(400, "bad origin in clientDataJSON"); }
  const host = u.hostname;
  const local = host === "localhost" && site.policy.allowLocalhost;
  if (u.protocol !== "https:" && !local) throw new HttpError(400, "passkeys need HTTPS");
  if (!local && !hostAllowed(host, site.domains)) throw new HttpError(403, "origin not allowed for this site");
  if (!local && host !== rpId && !host.endsWith(`.${rpId}`)) throw new HttpError(400, "RP ID does not match the page origin");
}

interface AuthData { rpIdHash: Uint8Array; flags: number; signCount: number; credId?: Uint8Array; coseKey?: Uint8Array }
export function parseAuthData(ad: Uint8Array): AuthData {
  if (ad.length < 37) throw new HttpError(400, "authenticator data too short");
  const flags = ad[32];
  const signCount = ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36];
  const out: AuthData = { rpIdHash: ad.slice(0, 32), flags, signCount };
  if (flags & 0x40) {
    if (ad.length < 55) throw new HttpError(400, "attested credential data truncated");
    const len = (ad[53] << 8) | ad[54];
    if (len > 1023 || ad.length < 55 + len + 1) throw new HttpError(400, "bad credential id");
    out.credId = ad.slice(55, 55 + len);
    const { end } = decodeCbor(ad, 55 + len);
    out.coseKey = ad.slice(55 + len, end);
  }
  return out;
}

function clientData(b64: string, type: string, challenge: string): { origin: string } {
  let cd: any;
  try { cd = JSON.parse(new TextDecoder().decode(b64urlToBytes(b64))); } catch { throw new HttpError(400, "bad clientDataJSON"); }
  if (cd?.type !== type) throw new HttpError(400, "wrong ceremony type");
  if (cd?.challenge !== challenge) throw new HttpError(400, "challenge mismatch");
  if (cd?.crossOrigin === true) throw new HttpError(400, "cross-origin ceremonies are refused");
  return { origin: String(cd.origin || "") };
}
const b = (v: unknown, max = 20000) => { const s = str(v, max * 2); if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new HttpError(400, "expected base64url"); return b64urlToBytes(s.replace(/=+$/, "")); };

// ---------- registration ----------
async function registerBegin(req: Request, env: Env) {
  const body = await readObject(req, 4096);
  const site = await getSiteBySecret(env, str(body.secret, 200));
  if (!site || site.status !== "active") throw new HttpError(401, "invalid secret");
  const userId = str(body.user_id, 128), userName = str(body.user_name, 128) || userId;
  if (!userId) throw new HttpError(400, "user_id is required");
  const count = (await first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM passkeys WHERE site_id = ?", site.id))?.n ?? 0;
  if (count >= site.ent.passkeys) throw new HttpError(403, `Your plan allows ${site.ent.passkeys} passkeys per site. Upgrade for more.`);
  const existing = await all<{ cred_id: string }>(env, "SELECT cred_id FROM passkeys WHERE site_id = ? AND user_id = ? LIMIT 20", site.id, userId);
  const rpId = rpIdFor(site);
  const challenge = newChallenge();
  const token = await signToken(label(env), { k: "reg", s: site.id, u: userId, n: userName, c: challenge, rp: rpId }, TTL);
  return json({
    token,
    publicKey: {
      challenge, rp: { id: rpId, name: site.name }, user: { id: b64url(new TextEncoder().encode(userId)), name: userName, displayName: userName },
      pubKeyCredParams: ALGS.map((alg) => ({ type: "public-key", alg })), timeout: TTL * 1000, attestation: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      excludeCredentials: existing.map((e) => ({ type: "public-key", id: e.cred_id })),
    },
  }, 200, { "cache-control": "no-store" });
}

async function registerFinish(req: Request, env: Env) {
  const body = await readObject(req, 32 * 1024);
  const t = await verifyToken<{ k: string; s: string; u: string; n: string; c: string; rp: string }>(label(env), str(body.token, 2000));
  if (!t || t.k !== "reg") return cjson({ error: "invalid or expired registration token" }, 400);
  const site = await getSite(env, t.s);
  if (!site || site.status !== "active") return cjson({ error: "invalid site" }, 400);
  const cred = (body.credential ?? {}) as any;
  const { origin } = clientData(str(cred?.response?.clientDataJSON, 20000), "webauthn.create", t.c);
  checkOrigin(site, origin, t.rp);
  const att = decodeCbor(b(cred?.response?.attestationObject)).value;
  if (!(att instanceof Map) || !(att.get("authData") instanceof Uint8Array)) return cjson({ error: "bad attestationObject" }, 400);
  const ad = parseAuthData(att.get("authData") as Uint8Array);
  if (!eq(ad.rpIdHash, await sha256(t.rp))) return cjson({ error: "RP ID hash mismatch" }, 400);
  if (!(ad.flags & 0x01)) return cjson({ error: "user presence flag missing" }, 400);
  if (!ad.credId || !ad.coseKey) return cjson({ error: "no credential in authenticator data" }, 400);
  const { alg, jwk } = parseCoseKey(ad.coseKey);
  const credId = b64url(ad.credId);
  const count = (await first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM passkeys WHERE site_id = ?", site.id))?.n ?? 0;
  if (count >= site.ent.passkeys) return cjson({ error: "passkey limit reached for this plan" }, 403);
  const r = await run(env, "INSERT OR IGNORE INTO passkeys (site_id, cred_id, user_id, user_name, public_key, alg, sign_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    site.id, credId, t.u, t.n, JSON.stringify(jwk), alg, ad.signCount);
  if (!Number(r.meta?.changes ?? 0)) return cjson({ error: "this credential is already registered" }, 409);
  return cjson({ ok: true, credential_id: credId, user_id: t.u, user_verified: !!(ad.flags & 0x04) });
}

// ---------- sign-in ----------
async function loginBegin(req: Request, env: Env) {
  if (await limited(env.EDGE_RL, req, "pk")) return cjson({ error: "rate_limited" }, 429);
  const body = await readObject(req, 2048);
  const site = await getSite(env, str(body.sitekey, 64));
  if (!site || site.status !== "active") return cjson({ error: "invalid_sitekey" }, 400);
  const host = requestHost(req);
  if (!hostOk(site, host)) return cjson({ error: "hostname_not_allowed" }, 403);
  const userId = str(body.user_id, 128);
  const creds = userId ? await all<{ cred_id: string }>(env, "SELECT cred_id FROM passkeys WHERE site_id = ? AND user_id = ? LIMIT 20", site.id, userId) : [];
  const rpId = rpIdFor(site);
  const challenge = newChallenge();
  const token = await signToken(label(env), { k: "auth", s: site.id, c: challenge, rp: rpId, h: host }, TTL);
  return cjson({ token, publicKey: { challenge, rpId, timeout: TTL * 1000, userVerification: "preferred", allowCredentials: creds.map((c) => ({ type: "public-key", id: c.cred_id })) } });
}

async function loginFinish(req: Request, env: Env) {
  if (await limited(env.EDGE_RL, req, "pk")) return cjson({ error: "rate_limited" }, 429);
  const body = await readObject(req, 32 * 1024);
  const t = await verifyToken<{ k: string; s: string; c: string; rp: string; h: string | null }>(label(env), str(body.token, 2000));
  if (!t || t.k !== "auth") return cjson({ error: "invalid or expired sign-in token" }, 400);
  const site = await getSite(env, t.s);
  if (!site || site.status !== "active") return cjson({ error: "invalid site" }, 400);
  const cred = (body.credential ?? {}) as any;
  const credId = str(cred?.id, 1400);
  const row = await first<{ user_id: string; public_key: string; alg: number; sign_count: number }>(env, "SELECT user_id, public_key, alg, sign_count FROM passkeys WHERE site_id = ? AND cred_id = ?", site.id, credId);
  if (!row) return cjson({ error: "unknown credential" }, 400);
  const cdBytes = b(cred?.response?.clientDataJSON);
  const { origin } = clientData(str(cred?.response?.clientDataJSON, 20000), "webauthn.get", t.c);
  checkOrigin(site, origin, t.rp);
  const adBytes = b(cred?.response?.authenticatorData);
  const ad = parseAuthData(adBytes);
  if (!eq(ad.rpIdHash, await sha256(t.rp))) return cjson({ error: "RP ID hash mismatch" }, 400);
  if (!(ad.flags & 0x01)) return cjson({ error: "user presence flag missing" }, 400);
  const signed = new Uint8Array(adBytes.length + 32);
  signed.set(adBytes, 0); signed.set(await sha256(cdBytes), adBytes.length);
  if (!(await verifyCose(JSON.parse(row.public_key), row.alg, b(cred?.response?.signature), signed))) return cjson({ error: "bad signature" }, 400);
  // Signature counter: if both sides count and it didn't go up, the key may have been cloned.
  if (ad.signCount !== 0 || row.sign_count !== 0) {
    if (ad.signCount <= row.sign_count) return cjson({ error: "signature counter did not increase (possible cloned authenticator)" }, 400);
  }
  await run(env, "UPDATE passkeys SET sign_count = ?, last_used = datetime('now') WHERE site_id = ? AND cred_id = ?", ad.signCount, site.id, credId);
  const token = await issuePass(env, { site, salt: `pk:${t.c}`, host: t.h, method: "passkey", user: row.user_id });
  return cjson({ token, user_id: row.user_id, user_verified: !!(ad.flags & 0x04) });
}

// ---------- management (customer backend) ----------
async function manage(req: Request, env: Env, action: "list" | "delete") {
  const body = await readObject(req, 4096);
  const site = await getSiteBySecret(env, str(body.secret, 200));
  if (!site) throw new HttpError(401, "invalid secret");
  if (action === "list") {
    const userId = str(body.user_id, 128);
    return json({ passkeys: await all(env, `SELECT cred_id AS credential_id, user_id, user_name, alg, created_at, last_used FROM passkeys WHERE site_id = ? ${userId ? "AND user_id = ?" : ""} ORDER BY created_at DESC LIMIT 500`, site.id, ...(userId ? [userId] : [])) });
  }
  const r = await run(env, "DELETE FROM passkeys WHERE site_id = ? AND cred_id = ?", site.id, str(body.credential_id, 1400));
  return json({ ok: Number(r.meta?.changes ?? 0) > 0 });
}

export async function passkeyRoute(req: Request, env: Env, path: string): Promise<Response | null> {
  if (req.method !== "POST" || !path.startsWith("/api/v1/passkeys/")) return null;
  switch (path.slice("/api/v1/passkeys/".length)) {
    case "register/begin": return registerBegin(req, env);
    case "register/finish": return registerFinish(req, env);
    case "login/begin": return loginBegin(req, env);
    case "login/finish": return loginFinish(req, env);
    case "list": return manage(req, env, "list");
    case "delete": return manage(req, env, "delete");
  }
  return null;
}

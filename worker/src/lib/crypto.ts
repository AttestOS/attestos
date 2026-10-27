const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export const b64url = (bytes: ArrayBuffer | Uint8Array) => bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}
export const strToB64url = (s: string) => b64url(enc.encode(s));
export const b64urlToStr = (s: string) => dec.decode(b64urlToBytes(s));

export async function hmacSha256(key: Uint8Array | string, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function sha256Hex(data: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(data));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Signed, expiring token: base64url(json).base64url(hmac). Used for unsubscribe links & OAuth state. */
export async function signToken(secret: string, payload: Record<string, unknown>, ttlSeconds = 60 * 60 * 24 * 365): Promise<string> {
  const body = strToB64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = b64url(await hmacSha256(secret, body));
  return `${body}.${sig}`;
}
/** Returns the payload, or null for anything malformed, forged or expired (never throws). */
export async function verifyToken<T = Record<string, unknown>>(secret: string, token: string | null | undefined): Promise<T | null> {
  if (typeof token !== "string" || !secret) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = b64url(await hmacSha256(secret, body));
  if (!timingSafeEqual(sig, expected)) return null;
  let payload: any;
  try { payload = JSON.parse(b64urlToStr(body)); } catch { return null; }
  if (!payload || typeof payload !== "object") return null;
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload as T;
}

/** AES-GCM encryption for stored OAuth refresh tokens (key derived from APP_SECRET). */
async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`aes:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptString(secret: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plain));
  return `${b64url(iv)}.${b64url(ct)}`;
}
export class DecryptError extends Error {}

/** Throws DecryptError (not a generic DOMException) for a malformed blob or a changed secret, so callers can
 *  tell "stored credential unusable, reconnect" apart from transient failures. */
export async function decryptString(secret: string, blob: string): Promise<string> {
  try {
    const [iv, ct] = String(blob).split(".");
    if (!iv || !ct) throw new Error("malformed");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlToBytes(iv) }, await aesKey(secret), b64urlToBytes(ct));
    return dec.decode(pt);
  } catch {
    throw new DecryptError("Stored credential could not be decrypted (APP_SECRET changed?)");
  }
}

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export function randomId(len = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

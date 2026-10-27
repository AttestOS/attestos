import type { Env } from "../env";
import { b64ToBytes, bytesToB64, sha256Hex, signToken, timingSafeEqual, verifyToken } from "./crypto";

/** Passwords (PBKDF2-SHA256, 100k iterations: the Workers maximum), cookies and signed sessions.
 *  Owner and customer sessions are signed with different derived labels so one can never be replayed as the other. */

const enc = new TextEncoder();
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}
export async function hashPassword(password: string, iterations = 100_000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${bytesToB64(salt)}$${bytesToB64(await pbkdf2(password, salt, iterations))}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, it, salt, hash] = (stored || "").split("$");
  const iterations = Number(it);
  if (kind !== "pbkdf2" || !salt || !hash || !Number.isInteger(iterations) || iterations < 10_000 || iterations > 100_000) return false;
  return timingSafeEqual(bytesToB64(await pbkdf2(password, b64ToBytes(salt), iterations)), hash);
}
/** A constant-cost dummy check so "unknown email" and "wrong password" take the same time. */
const DUMMY = "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
export const burnPasswordCheck = (password: string) => verifyPassword(password, DUMMY);

export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "That password is too long.";
  if (/^(.)\1+$/.test(pw) || /^(password|1234567890|qwertyuiop)/i.test(pw)) return "That password is too easy to guess.";
  return null;
}

export function readCookie(req: Request, name: string): string | null {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}
export const cookie = (name: string, value: string, path: string, maxAge: number) =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

async function label(env: Env, l: string) { return `${env.APP_SECRET}|${l}`; }

// ---------- owner ----------
export const OWNER_COOKIE = "ao_owner";
export const OWNER_TTL = 12 * 3600;
const ownerFp = async (env: Env) => (await sha256Hex(String(env.OWNER_PASSWORD_HASH))).slice(0, 16);
export async function ownerSession(env: Env) {
  return signToken(await label(env, "owner"), { sub: "owner", fp: await ownerFp(env) }, OWNER_TTL);
}
export async function isOwner(req: Request, env: Env): Promise<boolean> {
  if (!env.OWNER_PASSWORD_HASH || !env.APP_SECRET) return false;
  const p = await verifyToken<{ sub: string; fp: string }>(await label(env, "owner"), readCookie(req, OWNER_COOKIE));
  return !!p && p.sub === "owner" && p.fp === (await ownerFp(env));
}

// ---------- customers ----------
export const USER_COOKIE = "ao_sess";
export const USER_TTL = 14 * 86400;
export async function userSession(env: Env, accountId: string, ver: number) {
  return signToken(await label(env, "user"), { sub: accountId, v: ver }, USER_TTL);
}
export async function readUserSession(req: Request, env: Env): Promise<{ sub: string; v: number } | null> {
  if (!env.APP_SECRET) return null;
  return verifyToken<{ sub: string; v: number }>(await label(env, "user"), readCookie(req, USER_COOKIE));
}

// ---------- one-off links (email verification, password reset) ----------
export async function signLink(env: Env, purpose: "verify" | "reset", payload: Record<string, unknown>, ttl: number) {
  return signToken(await label(env, `link:${purpose}`), payload, ttl);
}
export async function readLink<T>(env: Env, purpose: "verify" | "reset", token: string | null): Promise<T | null> {
  return verifyToken<T>(await label(env, `link:${purpose}`), token);
}

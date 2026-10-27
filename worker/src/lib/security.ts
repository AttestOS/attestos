import type { Env } from "../env";
import { HttpError, clientIp, readBodyText } from "./http";

export const MAX_BODY_BYTES = 64 * 1024;

/** CSP for HTML produced by the Worker. Static pages get the same policy from site/_headers. */
export function csp(): string {
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
    "connect-src 'self'", "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'",
    "frame-ancestors 'none'", "form-action 'self'",
  ].join("; ");
}

/** Security headers on every Worker response. Public API responses stay CORS-open (they carry no cookies);
 *  owner/portal APIs are same-origin only (cookies are SameSite=Strict + Origin check). */
export function secure(res: Response, path: string): Response {
  if (res.status === 101) return res;
  const h = new Headers(res.headers);
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("strict-transport-security", "max-age=31536000");
  if ((h.get("content-type") || "").includes("text/html")) { h.set("content-security-policy", csp()); h.set("x-frame-options", "DENY"); }
  if (path.startsWith("/admin/api/") || path.startsWith("/api/v1/account") || path.startsWith("/api/press/")) h.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export async function readTextLimited(req: Request, max = MAX_BODY_BYTES): Promise<string> {
  return readBodyText(req, max);
}

/** Cookie-authenticated APIs: reject cross-site writes (CSRF) — the Origin must be our own. */
export function assertSameOrigin(req: Request, env: Env) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  const self = new URL(req.url).origin;
  const site = (() => { try { return new URL(env.SITE_URL).origin; } catch { return self; } })();
  if (!origin || (origin !== self && origin !== site)) throw new HttpError(403, "Cross-site request refused");
}

/** In-memory per-IP limiter (Workers Rate Limiting binding). Missing binding (tests) = allowed. */
export async function limited(rl: Env["EDGE_RL"], req: Request, bucket: string): Promise<boolean> {
  if (!rl) return false;
  try { return !(await rl.limit({ key: `${bucket}:${clientIp(req)}` })).success; } catch { return false; }
}

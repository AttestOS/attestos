import type { Env } from "./env";
import { logError, meter } from "./lib/db";
import { HttpError, json, readObject, str } from "./lib/http";
import { flushMeter } from "./lib/quota";
import { limited, secure } from "./lib/security";
import { CORS, challenge, redeem, siteverify } from "./pow";
import { accountRoute } from "./accounts";
import { portalRoute } from "./portal";
import { adminRoute } from "./admin";
import { goRoute, whopWebhook } from "./whop";
import { pressHook } from "./press/hooks";
import { scannerRoute } from "./scanner";
import { opsRoute, unsubscribe } from "./outreach";
import { PLANS } from "./plans";
import { runCron } from "./cron";
import { extraRoutes } from "./routes-extra";

/** AttestOS: one Worker serves the static site (ASSETS, free), the public verification API, the customer portal
 *  API, the owner console API, the Whop webhook and the cron jobs. */

let requestsSinceFlush = 0;
let lastFlush = Date.now();

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/{2,}/g, "/");
  const m = req.method;

  // Public, CORS-open verification API (no cookies involved).
  if (m === "OPTIONS" && path.startsWith("/api/")) return new Response(null, { status: 204, headers: CORS });
  if (path === "/api/v1/challenge" && m === "GET") return challenge(req, env, ctx);
  if (path === "/api/v1/redeem" && m === "POST") return redeem(req, env);
  if ((path === "/api/siteverify" || path === "/api/v1/siteverify") && m === "POST") return siteverify(req, env);
  if (path === "/api/v1/plans" && m === "GET") return json({ plans: Object.values(PLANS) }, 200, { ...CORS, "cache-control": "public, max-age=3600" });
  if (path === "/api/v1/demo/verify" && m === "POST") return demoVerify(req, env);
  if (path === "/api/v1/demo/config" && m === "GET") return json({ sitekey: env.DEMO_SITEKEY || null }, 200, { "cache-control": "public, max-age=300" });
  if (path === "/api/health") return json({ ok: true, service: "attestos", time: new Date().toISOString() }, 200, { "cache-control": "no-store" });

  // press mesh (bearer AO_PRESS_TOKEN; 404 when unset) - ahead of the flood guard: a press run posts a burst of cards
  if (path.startsWith("/api/press/")) { const r = await pressHook(req, env, path); if (r) return r; }
  if (path.startsWith("/api/") && m !== "GET" && (await limited(env.EDGE_RL, req, "api"))) throw new HttpError(429, "Too many requests. Slow down a little.");

  const extra = await extraRoutes(req, env, ctx, path);
  if (extra) return extra;

  if (path.startsWith("/api/v1/account/")) {
    const r = (await accountRoute(req, env, ctx, path)) ?? (await portalRoute(req, env, path));
    if (r) return r;
  }
  if (path.startsWith("/api/v1/scan")) { const r = await scannerRoute(req, env, ctx, path); if (r) return r; }
  if (path.startsWith("/api/ops/")) { const r = await opsRoute(req, env, path); if (r) return r; }
  if (path.startsWith("/admin/api/")) { const r = await adminRoute(req, env, path); if (r) return r; }
  if (path === "/api/webhooks/whop" && m === "POST") return whopWebhook(req, env, ctx);
  const go = path.match(/^\/go\/([a-z]+)\/?$/);
  if (go) return goRoute(req, env, go[1], ctx);
  const u = path.match(/^\/u\/([A-Za-z0-9_.-]{20,600})$/);
  if (u && (m === "GET" || m === "POST")) return unsubscribe(req, env, u[1]);

  if (path.startsWith("/api/") || path.startsWith("/admin/api/")) return json({ error: "Not found" }, 404);
  return env.ASSETS.fetch(req);
}

/** The landing-page demo: the browser solves for our own demo site, then this endpoint plays "your backend" and
 *  redeems the token at siteverify with the demo secret, so visitors see the real server-side answer. */
async function demoVerify(req: Request, env: Env): Promise<Response> {
  if (await limited(env.EDGE_RL, req, "demo")) throw new HttpError(429, "Slow down a little.");
  if (!env.DEMO_SECRET) throw new HttpError(503, "Demo not configured");
  const b = await readObject(req, 8192);
  const inner = new Request(new URL("/api/siteverify", req.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: env.DEMO_SECRET, response: str(b.token, 4000) }) });
  return siteverify(inner, env);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(req.url).pathname;
    let res: Response;
    try {
      res = await route(req, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message, ...(e.extra || {}) }, e.status, path.startsWith("/api/v1/challenge") || path.startsWith("/api/v1/redeem") ? CORS : {});
      else { ctx.waitUntil(logError(env, "fetch", e)); res = json({ error: "Something went wrong on our side." }, 500); }
    }
    requestsSinceFlush++;
    // Flush the per-isolate D1 meter at most every 5 minutes (or after 50 writes): each flush is one row write.
    if (meter.writes + meter.reads > 0 && (meter.writes >= 50 || Date.now() - lastFlush > 300_000)) {
      const n = requestsSinceFlush; requestsSinceFlush = 0; lastFlush = Date.now();
      ctx.waitUntil(flushMeter(env, n));
    }
    return secure(res, path);
  },
  async scheduled(evt: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(evt.cron, env).finally(() => flushMeter(env, 0)));
  },
};

// @ts-nocheck: Node-side test helpers.
import { makeD1 } from "./d1";
import worker from "../../src/index";
import { invalidateSites } from "../../src/sites";
import { _resetQuotaCache } from "../../src/lib/quota";
import { hashPassword } from "../../src/lib/auth";

export const ORIGIN = "https://attestos-edge.attestos.workers.dev";

export async function makeEnv(extra: Record<string, unknown> = {}) {
  const d1 = await makeD1();
  invalidateSites();
  _resetQuotaCache();
  const env = {
    DB: d1.DB,
    ASSETS: { fetch: async (req) => new Response(`<!doctype html><title>asset</title>${new URL(req.url).pathname}`, { headers: { "content-type": "text/html" } }) },
    SITE_URL: ORIGIN,
    BRAND: "AttestOS",
    APP_SECRET: "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz",
    OWNER_PASSWORD_HASH: await hashPassword("owner-pass-123", 10_000),
    ...extra,
  };
  return { env, q: d1.q, d1 };
}

export function makeCtx() {
  const waits: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})), passThroughOnException() {} }, flush: () => Promise.all(waits) };
}

/** Call the Worker like the platform does. */
export async function call(env, path: string, init: RequestInit & { origin?: string | null; cookie?: string; ip?: string } = {}) {
  const headers = new Headers(init.headers || {});
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  if (init.cookie) headers.set("cookie", init.cookie);
  headers.set("cf-connecting-ip", init.ip ?? "203.0.113.7");
  if (init.body && typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  const { ctx, flush } = makeCtx();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method: init.method || (init.body ? "POST" : "GET"), headers, body: init.body }), env, ctx);
  await flush();
  return res;
}
export const post = (env, path: string, body: unknown, o: Record<string, unknown> = {}) => call(env, path, { method: "POST", body: JSON.stringify(body), ...o });
export const cookieOf = (res: Response) => (res.headers.get("set-cookie") || "").split(";")[0];

/** Sign up + create a site, returning the session cookie, the site and its secret. */
export async function signupWithSite(env, email = "owner@shop.example", domains = ["shop.example"]) {
  const r = await post(env, "/api/v1/account/signup", { email, password: "correct horse battery" });
  if (r.status !== 201) throw new Error(`signup ${r.status} ${await r.text()}`);
  const cookie = cookieOf(r);
  const s = await post(env, "/api/v1/account/sites", { name: "Shop", domains }, { cookie });
  if (s.status !== 201) throw new Error(`site ${s.status} ${await s.text()}`);
  const j = await s.json();
  return { cookie, site: j.site, secret: j.secret };
}

export async function setPlan(env, q, email: string, plan: string) {
  q("UPDATE accounts SET comp_plan = ?, plan = ? WHERE email = ?", plan, plan, email);
  invalidateSites();
}
export async function setPolicy(env, cookie, siteId, policy) {
  const r = await post(env, `/api/v1/account/sites/${siteId}`, { policy }, { cookie });
  if (r.status !== 200) throw new Error(`policy ${r.status} ${await r.text()}`);
}

/** Solve a challenge the way the widget does. */
export async function solve(salt: string, bits: number) {
  const { leadingZeroBits, powHash } = await import("../../src/pow");
  for (let n = 0; ; n++) if (leadingZeroBits(await powHash(salt, n)) >= bits) return n;
}

import type { Env } from "./env";
import { HttpError, json, readObject, str } from "./lib/http";
import { assertSameOrigin } from "./lib/security";
import { CORS } from "./pow";
import { passkeyRoute } from "./passkeys";
import { patProbe } from "./pat";
import { agentCheck, listKeys, mintKey, revokeKey } from "./agents";
import { requireAccount } from "./accounts";
import { listSites } from "./sites";

/** Paid-module routes: passkeys, Private Access Tokens, AgentPass (+ the portal's agent-key management). */
export async function extraRoutes(req: Request, env: Env, _ctx: ExecutionContext, path: string): Promise<Response | null> {
  if (path.startsWith("/api/v1/passkeys/")) {
    try { return await passkeyRoute(req, env, path); }
    catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, CORS);
      return json({ error: e instanceof Error ? e.message.slice(0, 200) : "bad request" }, 400, CORS);
    }
  }
  if (path === "/api/v1/pat/probe" && req.method === "GET") return patProbe(req, env);
  if (path === "/api/v1/agent/check" && req.method === "POST") return agentCheck(req, env);

  const m = path.match(/^\/api\/v1\/account\/sites\/(ao_site_[a-z0-9]{12,24})\/agent-keys(?:\/([a-f0-9]{64})\/revoke)?$/);
  if (m) {
    if (req.method !== "GET") assertSameOrigin(req, env);
    const a = await requireAccount(req, env);
    const site = (await listSites(env, a.id)).find((s) => s.id === m[1]);
    if (!site) throw new HttpError(404, "Site not found");
    if (m[2] && req.method === "POST") { await revokeKey(env, site, m[2]); return json({ ok: true }); }
    if (!m[2] && req.method === "GET") return json({ keys: await listKeys(env, site) }, 200, { "cache-control": "no-store" });
    if (!m[2] && req.method === "POST") {
      const b = await readObject(req, 2048);
      const key = await mintKey(env, site, str(b.label, 80), Number(b.quota) || 0);
      return json({ key, note: "Copy this key now: it is shown once. Give it to the agent operator who paid you." }, 201);
    }
  }
  return null;
}

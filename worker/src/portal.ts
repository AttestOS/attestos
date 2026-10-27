import type { Env } from "./env";
import { all, run } from "./lib/db";
import { HttpError, json, readObject, str } from "./lib/http";
import { assertSameOrigin } from "./lib/security";
import { mailArmed } from "./mail/outbox";
import { requireAccount, type Account } from "./accounts";
import { PLANS, entitlements, has, parsePlans } from "./plans";
import { cleanDomains, createSite, invalidateSites, listSites, normPolicy, rotateSecret, type Site } from "./sites";
import { accountMonth } from "./stats";
import { checkoutUrl } from "./whop";

/** Customer portal API (/api/v1/account/...). Cookie session + same-origin check on writes. */

const siteView = (s: Site) => ({ id: s.id, name: s.name, domains: s.domains, policy: s.policy, status: s.status, secret_hint: s.secret_hint, created_at: s.created_at });

async function ownSite(env: Env, a: Account, id: string): Promise<Site> {
  const s = (await listSites(env, a.id)).find((x) => x.id === id);
  if (!s) throw new HttpError(404, "Site not found");
  return s;
}

export async function portalRoute(req: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith("/api/v1/account/")) return null;
  const sub = path.slice("/api/v1/account/".length);
  const m = req.method;
  if (m !== "GET") assertSameOrigin(req, env);

  if (sub === "me" && m === "GET") {
    const a = await requireAccount(req, env);
    const plans = parsePlans(a.plan);
    const ent = entitlements(plans);
    const sites = await listSites(env, a.id);
    const usage = await accountMonth(env, a.id);
    return json({
      email: a.email, verified: !!a.verified, plans, comp: a.comp_plan, entitlements: ent, usage, mail: mailArmed(env),
      sites: sites.map(siteView),
      catalog: Object.values(PLANS).map((p) => ({ ...p, checkout: p.id === "free" ? null : checkoutUrl(env, p.id) })),
    }, 200, { "cache-control": "no-store" });
  }

  if (sub === "sites" && m === "POST") {
    const a = await requireAccount(req, env);
    const b = await readObject(req, 8192);
    const { site, secret } = await createSite(env, a.id, entitlements(parsePlans(a.plan)), str(b.name, 80), b.domains);
    return json({ site: siteView(site), secret, note: "Copy the secret key now: it is shown once. Rotate it any time." }, 201);
  }

  const mm = sub.match(/^sites\/(ao_site_[a-z0-9]{12,24})(?:\/([a-z.]+))?$/);
  if (!mm) return null;
  const a = await requireAccount(req, env);
  const site = await ownSite(env, a, mm[1]);
  const action = mm[2] || "";

  if (action === "" && m === "POST") {
    const b = await readObject(req, 16 * 1024);
    const ent = entitlements(parsePlans(a.plan));
    const name = b.name === undefined ? site.name : str(b.name, 80) || site.name;
    const domains = b.domains === undefined ? site.domains : cleanDomains(b.domains, ent.domainsPerSite);
    const policy = b.policy === undefined ? site.policy : normPolicy(b.policy, site.policy);
    if (policy.alertWebhook && !has(ent, "alerts")) throw new HttpError(403, "Surge alerts are part of IntegrityRuntime Pro");
    await run(env, "UPDATE sites SET name = ?, domains = ?, policy = ? WHERE id = ? AND account_id = ?", name, JSON.stringify(domains), JSON.stringify(policy), site.id, a.id);
    invalidateSites();
    return json({ ok: true, site: siteView({ ...site, name, domains, policy }) });
  }
  if (action === "rotate" && m === "POST") return json({ secret: await rotateSecret(env, a.id, site.id), note: "The old secret stopped working just now. Update your backend." });
  if (action === "delete" && m === "POST") {
    const b = await readObject(req, 1024);
    if (str(b.confirm, 100) !== site.id) throw new HttpError(400, "Type the site key to confirm");
    await run(env, "DELETE FROM sites WHERE id = ? AND account_id = ?", site.id, a.id);
    await run(env, "DELETE FROM passkeys WHERE site_id = ?", site.id);
    await run(env, "DELETE FROM agent_keys WHERE site_id = ?", site.id);
    invalidateSites();
    return json({ ok: true });
  }
  if (action === "stats" && m === "GET") {
    const rows = await all(env, "SELECT day, ok, fail, pat, passkey, agent_allow, agent_charge, agent_block, risky FROM stats WHERE site_id = ? AND day >= date('now','-30 days') ORDER BY day", site.id);
    return json({ days: rows }, 200, { "cache-control": "no-store" });
  }
  if (action === "log" && m === "GET") {
    const rows = await all(env, "SELECT salt, at, method, host, risk FROM redeemed WHERE site_id = ? ORDER BY at DESC LIMIT 100", site.id);
    return json({ entries: rows.map((r: any) => ({ ...r, salt: String(r.salt).slice(0, 8) })) }, 200, { "cache-control": "no-store" });
  }
  if (action === "export.csv" && m === "GET") {
    if (!has(entitlements(parsePlans(a.plan)), "export")) throw new HttpError(403, "Audit export is part of the paid plans");
    const rows = await all<{ salt: string; at: number; method: string; host: string | null; risk: number | null }>(env,
      "SELECT salt, at, method, host, risk FROM redeemed WHERE site_id = ? AND at > ? ORDER BY at DESC LIMIT 50000", site.id, Math.floor(Date.now() / 1000) - 90 * 86400);
    const csv = ["time_utc,method,hostname,risk,token_id", ...rows.map((r) => [new Date(r.at * 1000).toISOString(), r.method, r.host ?? "", r.risk ?? "", r.salt].join(","))].join("\n");
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="attestos-${site.id}.csv"`, "cache-control": "no-store" } });
  }
  return null;
}


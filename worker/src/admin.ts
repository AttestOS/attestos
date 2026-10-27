import type { Env } from "./env";
import { all, first, getSetting, run, setSetting } from "./lib/db";
import { HttpError, clientIp, json, readObject, str } from "./lib/http";
import { assertSameOrigin, limited } from "./lib/security";
import { bumpUsage, getUsage } from "./lib/usage";
import { budgetState, budgets } from "./lib/quota";
import { cookie, isOwner, ownerSession, OWNER_COOKIE, OWNER_TTL, verifyPassword } from "./lib/auth";
import { laneCounts, laneState, lanes, saveLaneState } from "./mail/lanes";
import { refreshPlan } from "./accounts";
import { parsePlans } from "./plans";
import { invalidateSites } from "./sites";
import { outreachStatus } from "./outreach";

/** Owner console API (/admin/api/*). Password only (OWNER_PASSWORD_HASH), HMAC-signed cookie on Path=/admin. */
export async function adminRoute(req: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith("/admin/api/")) return null;
  const sub = path.slice("/admin/api/".length);
  const m = req.method;
  if (m !== "GET") assertSameOrigin(req, env);

  if (sub === "login" && m === "POST") {
    if (!env.OWNER_PASSWORD_HASH) throw new HttpError(503, "Owner login not configured (set the OWNER_PASSWORD_HASH secret)");
    if (await limited(env.LOGIN_RL, req, "owner")) throw new HttpError(429, "Too many attempts. Wait a minute.");
    const failKey = `ip:${clientIp(req)}:owner-fail`;
    if ((await getUsage(env, failKey, "day")) >= 8) throw new HttpError(429, "Locked for this network until midnight UTC after repeated failures.");
    const b = await readObject(req, 2048);
    if (!(await verifyPassword(typeof b.password === "string" ? b.password.slice(0, 256) : "", env.OWNER_PASSWORD_HASH))) {
      await bumpUsage(env, failKey, "day");
      throw new HttpError(401, "Wrong password");
    }
    return json({ ok: true }, 200, { "set-cookie": cookie(OWNER_COOKIE, await ownerSession(env), "/admin", OWNER_TTL), "cache-control": "no-store" });
  }
  if (sub === "logout" && m === "POST") return json({ ok: true }, 200, { "set-cookie": cookie(OWNER_COOKIE, "", "/admin", 0) });
  if (!(await isOwner(req, env))) throw new HttpError(401, "Owner login required");

  const q = new URL(req.url).searchParams;
  switch (`${m} ${sub}`) {
    case "GET overview": {
      const n = async (sql: string, ...b: unknown[]) => (await first<{ n: number }>(env, sql, ...b))?.n ?? 0;
      const month = `${new Date().toISOString().slice(0, 7)}-01`;
      const quota = await budgetState(env);
      const laneInfo = [];
      for (const l of lanes(env)) laneInfo.push({ id: l.id, user: l.user, caps: { cold: l.cold, transactional: l.transactional, hourly: l.hourly }, state: await laneState(env, l.id), sent: await laneCounts(env, l.id) });
      return json({
        accounts: await n("SELECT COUNT(*) AS n FROM accounts"),
        paying: await n("SELECT COUNT(*) AS n FROM accounts WHERE plan != 'free'"),
        sites: await n("SELECT COUNT(*) AS n FROM sites"),
        verifs_today: await n("SELECT COALESCE(SUM(ok),0) AS n FROM stats WHERE day = date('now')"),
        verifs_month: await n("SELECT COALESCE(SUM(ok),0) AS n FROM stats WHERE day >= ?", month),
        scans_7d: await n("SELECT COUNT(*) AS n FROM scans WHERE created_at > datetime('now','-7 days')"),
        leads: await n("SELECT COUNT(*) AS n FROM leads"),
        quota: { ...quota, budgets: budgets(env) },
        lanes: laneInfo,
        outreach: await outreachStatus(env),
        errors: await all(env, "SELECT at, scope, message FROM errors ORDER BY id DESC LIMIT 20"),
        config: {
          app_secret: !!env.APP_SECRET && env.APP_SECRET.length >= 32, whop_webhook: !!env.WHOP_WEBHOOK_SECRET, whop_plans: !!env.WHOP_PLAN_MAP,
          postal_address: !!env.POSTAL_ADDRESS, ops_token: !!env.AO_OPS_TOKEN, press_token: !!env.AO_PRESS_TOKEN, ntfy: !!env.NTFY_TOPIC,
          checkout: ["INTEGRITY", "HARDWARE", "AGENT", "ENTERPRISE"].filter((p) => !!env[`WHOP_CHECKOUT_${p}`]),
        },
      }, 200, { "cache-control": "no-store" });
    }
    case "GET accounts": {
      const s = `%${str(q.get("q"), 100).toLowerCase()}%`;
      return json({ accounts: await all(env, `SELECT a.id, a.email, a.plan, a.comp_plan, a.verified, a.status, a.created_at, a.last_login,
        (SELECT COUNT(*) FROM sites s WHERE s.account_id = a.id) AS sites FROM accounts a WHERE a.email LIKE ? ORDER BY a.created_at DESC LIMIT 200`, s) });
    }
    case "GET leads": return json({ leads: await all(env, "SELECT email, domain, scan_id, source, created_at FROM leads ORDER BY id DESC LIMIT 300") });
    case "GET prospects": {
      const st = str(q.get("status"), 20);
      return json({ prospects: await all(env, `SELECT domain, page_url, vendor, page_kind, contact_email, contact_source, status, first_sent_at, follow_sent_at, replied_at, last_error, created_at
        FROM prospects ${st ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 300`, ...(st ? [st] : [])) });
    }
    case "GET outbox": return json({ outbox: await all(env, "SELECT id, to_email, subject, kind, status, attempts, lane, error, created_at, sent_at FROM outbox ORDER BY id DESC LIMIT 200") });
    case "GET settings": return json({ outreach_enabled: (await getSetting(env, "outreach_enabled")) === "1" });
    case "POST settings": {
      const b = await readObject(req, 1024);
      if (b.outreach_enabled !== undefined) {
        if (b.outreach_enabled && !env.POSTAL_ADDRESS) throw new HttpError(400, "Set the POSTAL_ADDRESS variable first: commercial email must carry a valid postal address (CAN-SPAM).");
        await setSetting(env, "outreach_enabled", b.outreach_enabled ? "1" : "0");
      }
      return json({ ok: true });
    }
  }
  let mm = sub.match(/^accounts\/(acc_[a-z0-9]{8,24})$/);
  if (mm && m === "POST") {
    const b = await readObject(req, 2048);
    const sets: string[] = [], binds: unknown[] = [];
    if (b.comp_plan !== undefined) { const p = parsePlans(String(b.comp_plan || "")).filter((x) => x !== "free"); sets.push("comp_plan = ?"); binds.push(p.length ? p.join(",") : null); }
    if (b.status !== undefined) { if (!["active", "disabled"].includes(String(b.status))) throw new HttpError(400, "status must be active or disabled"); sets.push("status = ?"); binds.push(b.status); }
    if (b.verified === true) sets.push("verified = 1");
    if (!sets.length) throw new HttpError(400, "Nothing to change");
    const r = await run(env, `UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`, ...binds, mm[1]);
    if (!Number(r.meta?.changes ?? 0)) throw new HttpError(404, "No such account");
    const plans = await refreshPlan(env, mm[1]);
    invalidateSites();
    return json({ ok: true, plans });
  }
  mm = sub.match(/^prospects\/([a-z0-9.-]{3,253})$/);
  if (mm && m === "POST") {
    const b = await readObject(req, 1024);
    const st = str(b.status, 20);
    if (!["new", "skip", "replied", "unsub"].includes(st)) throw new HttpError(400, "status must be new, skip, replied or unsub");
    await run(env, "UPDATE prospects SET status = ? WHERE domain = ?", st, mm[1]);
    return json({ ok: true });
  }
  mm = sub.match(/^lanes\/([a-z][a-z0-9]{1,15})\/resume$/);
  if (mm && m === "POST") {
    const s = await laneState(env, mm[1]);
    await saveLaneState(env, mm[1], { ...s, status: "ok", reason: undefined, cooldownUntil: undefined, since: new Date().toISOString() });
    return json({ ok: true });
  }
  return null;
}

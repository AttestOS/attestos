import type { Env } from "./env";
import { all, first, logError, run } from "./lib/db";
import { json, readBodyText, redirect } from "./lib/http";
import { safeJson } from "./lib/util";
import { verifyStandardWebhook } from "./webhooks/verify";
import { claimUrl, refreshPlan } from "./accounts";
import { enqueue, processOutbox } from "./mail/outbox";
import { notifyOwner } from "./lib/notify";
import { PAID, PLANS, type PlanId } from "./plans";

/** Checkout happens entirely on Whop. Each paid plan has a checkout URL var (WHOP_CHECKOUT_<PLAN>); /go/<plan>
 *  redirects there. Entitlements come back through Whop's signed webhooks (Standard Webhooks) and attach to the
 *  AttestOS account with the same CONFIRMED email. Unknown buyers get a claim link by email. */

export function checkoutUrl(env: Env, plan: PlanId): string | null {
  const v = String(env[`WHOP_CHECKOUT_${plan.toUpperCase()}`] || "").trim();
  return /^https:\/\/(www\.)?whop\.com\//.test(v) ? v : null;
}
export function goRoute(env: Env, plan: string): Response {
  if (!PAID.includes(plan as PlanId)) return redirect("/pricing/");
  const url = checkoutUrl(env, plan as PlanId);
  return redirect(url ?? `/pricing/?checkout=soon#${plan}`);
}

/** WHOP_PLAN_MAP = {"plan_abc":"integrity","prod_xyz":"agent"} (plan or product ids from the Whop dashboard). */
export function planMap(env: Env): Record<string, PlanId> {
  const raw = safeJson<Record<string, unknown>>(env.WHOP_PLAN_MAP, {});
  const out: Record<string, PlanId> = {};
  for (const [k, v] of Object.entries(raw && typeof raw === "object" ? raw : {})) if (PAID.includes(v as PlanId)) out[k] = v as PlanId;
  return out;
}

export function extract(evt: any) {
  const d = evt?.data ?? {};
  const isMembership = String(evt?.type || "").startsWith("membership.");
  return {
    type: String(evt?.type || ""),
    email: (d.user?.email ?? d.email ?? d.member?.email ?? null)?.toLowerCase?.() ?? null,
    userId: d.user?.id ?? d.user_id ?? null,
    membershipId: isMembership ? d.id ?? null : d.membership?.id ?? d.membership_id ?? null,
    planId: d.plan?.id ?? d.plan_id ?? d.membership?.plan?.id ?? null,
    productId: d.product?.id ?? d.product_id ?? d.access_pass?.id ?? null,
    status: d.status ?? null,
  };
}

const VALID_EVENTS = ["membership.activated", "membership.went_valid"];
const INVALID_EVENTS = ["membership.deactivated", "membership.went_invalid"];

export async function whopWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await readBodyText(req, 256 * 1024);
  const h = { id: req.headers.get("webhook-id"), timestamp: req.headers.get("webhook-timestamp"), signature: req.headers.get("webhook-signature") };
  if (!env.WHOP_WEBHOOK_SECRET) return json({ error: "webhook secret not configured" }, 503);
  if (!(await verifyStandardWebhook(env.WHOP_WEBHOOK_SECRET, h, raw))) return json({ error: "invalid signature" }, 401);
  let evt: any;
  try { evt = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  await run(env, "INSERT OR IGNORE INTO events (webhook_id, type, payload_json) VALUES (?, ?, ?)", h.id, String(evt?.type ?? ""), raw.slice(0, 20_000));
  const claimed = await first(env, `UPDATE events SET processed_at = 'claim:' || datetime('now') WHERE webhook_id = ?
      AND (processed_at IS NULL OR (processed_at LIKE 'claim:%' AND processed_at < 'claim:' || datetime('now','-2 minutes'))) RETURNING webhook_id`, h.id);
  if (!claimed) {
    const row = await first<{ processed_at: string | null }>(env, "SELECT processed_at FROM events WHERE webhook_id = ?", h.id);
    if (row?.processed_at && !row.processed_at.startsWith("claim:")) return json({ ok: true, duplicate: true });
    return json({ error: "in progress" }, 409);
  }
  try {
    await handleEvent(env, ctx, evt);
    await run(env, "UPDATE events SET processed_at = datetime('now'), error = NULL WHERE webhook_id = ?", h.id);
    return json({ ok: true });
  } catch (e) {
    await run(env, "UPDATE events SET processed_at = NULL, error = ? WHERE webhook_id = ?", String(e).slice(0, 500), h.id);
    await logError(env, "whop", e);
    return json({ error: "processing failed" }, 500);
  }
}

export async function handleEvent(env: Env, ctx: ExecutionContext, evt: any) {
  const x = extract(evt);
  const map = planMap(env);
  const plan: PlanId | null = (x.planId && map[x.planId]) || (x.productId && map[x.productId]) || null;
  const valid = VALID_EVENTS.includes(x.type) || (x.type === "membership.updated" && ["active", "trialing", "past_due", "completed"].includes(String(x.status)));
  const invalid = INVALID_EVENTS.includes(x.type) || (x.type === "membership.updated" && ["canceled", "expired"].includes(String(x.status)));
  if (!x.membershipId || (!valid && !invalid)) return;
  if (!plan) { await logError(env, "whop", `unmapped plan ${x.planId ?? "?"} / product ${x.productId ?? "?"}: add it to WHOP_PLAN_MAP`); return; }

  const before = await first<{ status: string; email: string | null }>(env, "SELECT status, email FROM memberships WHERE membership_id = ?", x.membershipId);
  const email = x.email ?? before?.email ?? null;
  await run(env, `INSERT INTO memberships (membership_id, email, whop_user_id, plan, status) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(membership_id) DO UPDATE SET email = COALESCE(excluded.email, memberships.email), whop_user_id = COALESCE(excluded.whop_user_id, memberships.whop_user_id),
      plan = excluded.plan, status = excluded.status, updated_at = datetime('now')`, x.membershipId, email, x.userId, plan, valid ? "active" : "ended");
  if (!email) return;
  const accounts = await all<{ id: string; verified: number }>(env, "SELECT id, verified FROM accounts WHERE email = ?", email);
  for (const a of accounts) await refreshPlan(env, a.id);

  const becameValid = valid && before?.status !== "active";
  if (!becameValid) return;
  const name = PLANS[plan].name;
  const acct = accounts[0];
  const body = acct?.verified
    ? `Thanks for buying ${name}.\n\nIt is already active on your AttestOS account (${email}): ${env.SITE_URL}/app/\n\nManage or cancel billing any time on Whop: https://whop.com/@me/settings/memberships\n\n— AttestOS`
    : acct
      ? `Thanks for buying ${name}.\n\nYour AttestOS account (${email}) hasn't confirmed its email yet, so the plan isn't attached. Log in at ${env.SITE_URL}/app/ and press "Send confirmation email", or reset your password (that confirms the address too).\n\n— AttestOS`
      : `Thanks for buying ${name}.\n\nCreate your AttestOS login with this email to start using it (the link confirms the address, so the plan attaches straight away):\n${await claimUrl(env, email)}\n\nThe link works for 14 days. After that, sign up at ${env.SITE_URL}/app/ with ${email} and confirm the email.\n\n— AttestOS`;
  const id = await enqueue(env, { to: email, subject: `Your AttestOS ${name} plan`, body, kind: "notice", ref: x.membershipId });
  if (id) ctx.waitUntil(processOutbox(env, { onlyId: id }).then(() => undefined));
  ctx.waitUntil(notifyOwner(env, { title: `New ${name} purchase`, message: email, priority: 4 }).then(() => undefined));
}

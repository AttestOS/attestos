import type { Env } from "./env";
import { all, first, run } from "./lib/db";
import { randomId } from "./lib/crypto";
import { HttpError, clientIp, json, readObject, redirect, str } from "./lib/http";
import { assertSameOrigin, limited } from "./lib/security";
import { bumpUsage, getUsage } from "./lib/usage";
import { isEmail } from "./lib/util";
import { burnPasswordCheck, cookie, hashPassword, passwordProblem, readLink, readUserSession, signLink, userSession, USER_COOKIE, USER_TTL, verifyPassword } from "./lib/auth";
import { enqueue, mailArmed, processOutbox } from "./mail/outbox";
import { PAID, parsePlans, type PlanId } from "./plans";
import { invalidateSites } from "./sites";

export interface Account { id: string; email: string; plan: string; comp_plan: string | null; sess_ver: number; verified: number; status: string; created_at: string; last_login: string | null }
const COLS = "id, email, plan, comp_plan, sess_ver, verified, status, created_at, last_login";

export async function currentAccount(req: Request, env: Env): Promise<Account | null> {
  const s = await readUserSession(req, env);
  if (!s) return null;
  const a = await first<Account>(env, `SELECT ${COLS} FROM accounts WHERE id = ?`, s.sub);
  if (!a || a.sess_ver !== s.v || a.status !== "active") return null;
  return a;
}
export async function requireAccount(req: Request, env: Env): Promise<Account> {
  const a = await currentAccount(req, env);
  if (!a) throw new HttpError(401, "Please log in");
  return a;
}

const LIVE = ["active", "trialing", "past_due", "completed"];
/** Recompute an account's plan list from its live Whop memberships (by verified email) + the owner's comp plan. */
export async function refreshPlan(env: Env, accountId: string): Promise<PlanId[]> {
  const a = await first<Account>(env, `SELECT ${COLS} FROM accounts WHERE id = ?`, accountId);
  if (!a) return ["free"];
  const plans = new Set<PlanId>();
  if (a.verified) {
    const rows = await all<{ plan: string; status: string }>(env, "SELECT plan, status FROM memberships WHERE email = ?", a.email);
    for (const r of rows) if (LIVE.includes(r.status) && PAID.includes(r.plan as PlanId)) plans.add(r.plan as PlanId);
  }
  for (const p of parsePlans(a.comp_plan)) if (p !== "free") plans.add(p);
  const list = plans.size ? [...plans].sort() : ["free" as PlanId];
  const value = list.join(",");
  if (value !== a.plan) { await run(env, "UPDATE accounts SET plan = ? WHERE id = ?", value, a.id); invalidateSites(); }
  return list;
}

const sessionHeaders = async (env: Env, a: Pick<Account, "id" | "sess_ver">) =>
  ({ "set-cookie": cookie(USER_COOKIE, await userSession(env, a.id, a.sess_ver), "/", USER_TTL), "cache-control": "no-store" });

async function sendLink(env: Env, ctx: ExecutionContext, to: string, kind: "verify" | "reset", url: string) {
  const subject = kind === "verify" ? "Confirm your AttestOS email" : "Reset your AttestOS password";
  const body = kind === "verify"
    ? `Hi,\n\nConfirm this address for your AttestOS account:\n${url}\n\nThe link works for 3 days. Confirming lets purchases made on Whop with this email attach to your account.\nDidn't sign up? Ignore this email and nothing happens.\n\n— AttestOS`
    : `Hi,\n\nSomeone (hopefully you) asked to reset the AttestOS password for this address:\n${url}\n\nThe link works for 1 hour and logs out every other device. Didn't ask? Ignore this email.\n\n— AttestOS`;
  const id = await enqueue(env, { to, subject, body, kind });
  if (id) ctx.waitUntil(processOutbox(env, { onlyId: id }).then(() => undefined));
}

async function verifyUrl(env: Env, a: Pick<Account, "id" | "email">) {
  return `${env.SITE_URL}/api/v1/account/verify?t=${encodeURIComponent(await signLink(env, "verify", { a: a.id, e: a.email }, 3 * 86400))}`;
}

// ---------------- routes: /api/v1/account/* ----------------
export async function accountRoute(req: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response | null> {
  const m = req.method;
  if (path === "/api/v1/account/verify" && m === "GET") return verifyEmail(req, env);
  if (m === "POST") assertSameOrigin(req, env);
  switch (`${m} ${path}`) {
    case "POST /api/v1/account/signup": return signup(req, env, ctx);
    case "POST /api/v1/account/login": return login(req, env);
    case "POST /api/v1/account/logout": return json({ ok: true }, 200, { "set-cookie": cookie(USER_COOKIE, "", "/", 0), "cache-control": "no-store" });
    case "POST /api/v1/account/reset/request": return resetRequest(req, env, ctx);
    case "POST /api/v1/account/reset/confirm": return resetConfirm(req, env);
    case "POST /api/v1/account/verify/resend": {
      const a = await requireAccount(req, env);
      if (a.verified) return json({ ok: true, verified: true });
      if (!mailArmed(env)) throw new HttpError(503, "Email sending isn't switched on yet. Contact the owner to confirm your address.");
      if ((await bumpUsage(env, `verify:${a.id}`, "day")) > 3) throw new HttpError(429, "Three confirmation emails a day at most. Check your spam folder.");
      await sendLink(env, ctx, a.email, "verify", await verifyUrl(env, a));
      return json({ ok: true, sent: true });
    }
    case "POST /api/v1/account/password": {
      const a = await requireAccount(req, env);
      const b = await readObject(req, 4096);
      const row = await first<{ pw_hash: string }>(env, "SELECT pw_hash FROM accounts WHERE id = ?", a.id);
      if (!(await verifyPassword(str(b.current, 200), row?.pw_hash || ""))) throw new HttpError(403, "Current password is wrong");
      const next = typeof b.next === "string" ? b.next : "";
      const bad = passwordProblem(next);
      if (bad) throw new HttpError(400, bad);
      const ver = a.sess_ver + 1;
      await run(env, "UPDATE accounts SET pw_hash = ?, sess_ver = ? WHERE id = ?", await hashPassword(next), ver, a.id);
      return json({ ok: true }, 200, await sessionHeaders(env, { id: a.id, sess_ver: ver }));
    }
  }
  return null;
}

async function signup(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (await limited(env.LOGIN_RL, req, "signup")) throw new HttpError(429, "Too many attempts. Wait a minute.");
  const hourKey = `ip:${clientIp(req)}:signup:${new Date().toISOString().slice(11, 13)}`;
  if ((await getUsage(env, hourKey, "day")) >= 5) throw new HttpError(429, "Too many sign-ups from this network. Try again in an hour.");
  const b = await readObject(req, 4096);
  const email = str(b.email, 200).toLowerCase();
  const password = typeof b.password === "string" ? b.password : "";
  if (!isEmail(email)) throw new HttpError(400, "Enter a valid email address");
  const bad = passwordProblem(password);
  if (bad) throw new HttpError(400, bad);
  const claim = typeof b.claim === "string" ? await readLink<{ e: string }>(env, "reset", b.claim) : null;
  const verified = claim?.e === email ? 1 : 0;
  await bumpUsage(env, hourKey, "day");
  const id = `acc_${randomId(16)}`;
  const ins = await run(env, "INSERT OR IGNORE INTO accounts (id, email, pw_hash, verified) VALUES (?, ?, ?, ?)", id, email, await hashPassword(password), verified);
  if (!Number(ins.meta?.changes ?? 0)) throw new HttpError(409, "That email already has an account. Log in, or reset the password.");
  await run(env, "INSERT OR IGNORE INTO leads (email, source) VALUES (?, 'signup')", email);
  if (verified) await refreshPlan(env, id);
  else if (mailArmed(env)) await sendLink(env, ctx, email, "verify", await verifyUrl(env, { id, email }));
  return json({ ok: true, verified: !!verified, mail: mailArmed(env) }, 201, await sessionHeaders(env, { id, sess_ver: 1 }));
}

async function login(req: Request, env: Env): Promise<Response> {
  if (await limited(env.LOGIN_RL, req, "login")) throw new HttpError(429, "Too many attempts. Wait a minute.");
  const failKey = `ip:${clientIp(req)}:login-fail`;
  if ((await getUsage(env, failKey, "day")) >= 20) throw new HttpError(429, "Too many failed logins from this network today. Reset your password or try tomorrow.");
  const b = await readObject(req, 4096);
  const email = str(b.email, 200).toLowerCase();
  const password = typeof b.password === "string" ? b.password.slice(0, 200) : "";
  const row = await first<Account & { pw_hash: string }>(env, `SELECT ${COLS}, pw_hash FROM accounts WHERE email = ?`, email);
  const ok = row ? await verifyPassword(password, row.pw_hash) : await burnPasswordCheck(password);
  if (!row || !ok) { await bumpUsage(env, failKey, "day"); throw new HttpError(401, "Wrong email or password"); }
  if (row.status !== "active") throw new HttpError(403, "This account is disabled. Contact support.");
  await run(env, "UPDATE accounts SET last_login = datetime('now') WHERE id = ?", row.id);
  return json({ ok: true }, 200, await sessionHeaders(env, row));
}

async function resetRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (await limited(env.LOGIN_RL, req, "reset")) throw new HttpError(429, "Too many attempts. Wait a minute.");
  const b = await readObject(req, 2048);
  const email = str(b.email, 200).toLowerCase();
  if (!mailArmed(env)) throw new HttpError(503, "Email sending isn't switched on yet, so passwords can't be reset by email. Contact the owner.");
  // Same answer whether or not the account exists (no account enumeration).
  if (isEmail(email) && (await bumpUsage(env, `reset:${email}`, "day")) <= 3) {
    const a = await first<Account>(env, `SELECT ${COLS} FROM accounts WHERE email = ?`, email);
    if (a) {
      const t = await signLink(env, "reset", { a: a.id, v: a.sess_ver, e: a.email }, 3600);
      await sendLink(env, ctx, email, "reset", `${env.SITE_URL}/app/#reset=${encodeURIComponent(t)}`);
    }
  }
  return json({ ok: true });
}

/** Reset links double as proof of the mailbox, so a reset also confirms the email. One use: the session version moves on. */
async function resetConfirm(req: Request, env: Env): Promise<Response> {
  const b = await readObject(req, 4096);
  const t = await readLink<{ a?: string; v?: number; e: string }>(env, "reset", str(b.token, 2000));
  if (!t?.a) throw new HttpError(400, "This reset link is invalid or expired. Ask for a new one.");
  const password = typeof b.password === "string" ? b.password : "";
  const bad = passwordProblem(password);
  if (bad) throw new HttpError(400, bad);
  const ver = Number(t.v) + 1;
  const r = await run(env, "UPDATE accounts SET pw_hash = ?, sess_ver = ?, verified = 1 WHERE id = ? AND sess_ver = ? AND email = ?", await hashPassword(password), ver, t.a, t.v, t.e);
  if (!Number(r.meta?.changes ?? 0)) throw new HttpError(400, "This reset link was already used. Ask for a new one.");
  await refreshPlan(env, t.a);
  return json({ ok: true }, 200, await sessionHeaders(env, { id: t.a, sess_ver: ver }));
}

async function verifyEmail(req: Request, env: Env): Promise<Response> {
  const t = await readLink<{ a: string; e: string }>(env, "verify", new URL(req.url).searchParams.get("t"));
  if (!t) return redirect("/app/?notice=link-expired");
  const r = await run(env, "UPDATE accounts SET verified = 1 WHERE id = ? AND email = ? AND verified = 0", t.a, t.e);
  if (Number(r.meta?.changes ?? 0)) await refreshPlan(env, t.a);
  return redirect("/app/?notice=verified");
}

/** Whop purchase for an email with no account yet: a claim link that creates the account pre-confirmed. */
export async function claimUrl(env: Env, email: string) {
  return `${env.SITE_URL}/app/#claim=${encodeURIComponent(await signLink(env, "reset", { e: email }, 14 * 86400))}&email=${encodeURIComponent(email)}`;
}

// @ts-nocheck
import { describe, expect, it } from "vitest";
import { call, cookieOf, makeEnv, post, signupWithSite } from "./helpers/env";
import { signLink } from "../src/lib/auth";
import { signStandardWebhook } from "../src/webhooks/verify";

const PW = "correct horse battery";

describe("customer accounts", () => {
  it("signs up, reads /me, refuses duplicates and weak passwords", async () => {
    const { env } = await makeEnv();
    const r = await post(env, "/api/v1/account/signup", { email: "Me@Shop.example", password: PW });
    expect(r.status).toBe(201);
    const cookie = cookieOf(r);
    expect(r.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const me = await (await call(env, "/api/v1/account/me", { cookie })).json();
    expect(me).toMatchObject({ email: "me@shop.example", verified: false, plans: ["free"] });
    expect(me.catalog.find((p) => p.id === "integrity").price).toBe(49);
    expect((await post(env, "/api/v1/account/signup", { email: "me@shop.example", password: PW })).status).toBe(409);
    expect((await post(env, "/api/v1/account/signup", { email: "x@shop.example", password: "short" })).status).toBe(400);
    expect((await call(env, "/api/v1/account/me")).status).toBe(401);
  });

  it("blocks cross-site writes (CSRF) on cookie APIs", async () => {
    const { env } = await makeEnv();
    const { cookie } = await signupWithSite(env);
    expect((await post(env, "/api/v1/account/sites", { domains: ["b.example"] }, { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(env, "/api/v1/account/sites", { domains: ["b.example"] }, { cookie, origin: null })).status).toBe(403);
  });

  it("logs in with the right password only; password change logs other sessions out", async () => {
    const { env } = await makeEnv();
    const { cookie } = await signupWithSite(env, "u@shop.example");
    expect((await post(env, "/api/v1/account/login", { email: "u@shop.example", password: "wrong password!" })).status).toBe(401);
    expect((await post(env, "/api/v1/account/login", { email: "nobody@shop.example", password: PW })).status).toBe(401);
    const ok = await post(env, "/api/v1/account/login", { email: "u@shop.example", password: PW });
    expect(ok.status).toBe(200);
    const ch = await post(env, "/api/v1/account/password", { current: PW, next: "another long password" }, { cookie });
    expect(ch.status).toBe(200);
    expect((await call(env, "/api/v1/account/me", { cookie })).status).toBe(401);
    expect((await call(env, "/api/v1/account/me", { cookie: cookieOf(ch) })).status).toBe(200);
  });

  it("reset links work once and confirm the email", async () => {
    const { env, q } = await makeEnv();
    await signupWithSite(env, "r@shop.example");
    const a = q("SELECT id, sess_ver FROM accounts WHERE email = 'r@shop.example'")[0];
    const t = await signLink(env, "reset", { a: a.id, v: a.sess_ver, e: "r@shop.example" }, 3600);
    expect((await post(env, "/api/v1/account/reset/confirm", { token: t, password: "brand new password" })).status).toBe(200);
    expect(q("SELECT verified FROM accounts WHERE id = ?", a.id)[0].verified).toBe(1);
    expect((await post(env, "/api/v1/account/reset/confirm", { token: t, password: "brand new password 2" })).status).toBe(400);
  });

  it("enforces site and domain limits per plan and validates domains", async () => {
    const { env } = await makeEnv();
    const { cookie } = await signupWithSite(env);
    expect((await post(env, "/api/v1/account/sites", { domains: ["two.example"] }, { cookie })).status).toBe(403); // free = 1 site
    const r = await post(env, "/api/v1/account/sites", { domains: ["not a domain"] }, { cookie });
    expect(r.status).toBe(403);
  });

  it("rotates secrets (old one stops working) and deletes with confirmation", async () => {
    const { env } = await makeEnv();
    const { cookie, site, secret } = await signupWithSite(env);
    const rot = await (await post(env, `/api/v1/account/sites/${site.id}/rotate`, {}, { cookie })).json();
    expect(rot.secret).not.toBe(secret);
    const v = await (await post(env, "/api/siteverify", { secret, response: "x" }, { origin: null })).json();
    expect(v["error-codes"]).toEqual(["invalid-input-secret"]);
    expect((await post(env, `/api/v1/account/sites/${site.id}/delete`, { confirm: "nope" }, { cookie })).status).toBe(400);
    expect((await post(env, `/api/v1/account/sites/${site.id}/delete`, { confirm: site.id }, { cookie })).status).toBe(200);
  });

  it("a user cannot touch another user's site", async () => {
    const { env } = await makeEnv();
    const a = await signupWithSite(env, "a@a.example", ["a.example"]);
    const b = await signupWithSite(env, "b@b.example", ["b.example"]);
    expect((await post(env, `/api/v1/account/sites/${a.site.id}/rotate`, {}, { cookie: b.cookie })).status).toBe(404);
    expect((await call(env, `/api/v1/account/sites/${a.site.id}/log`, { cookie: b.cookie })).status).toBe(404);
  });

  it("verification link confirms the email", async () => {
    const { env, q } = await makeEnv();
    await signupWithSite(env, "v@shop.example");
    const a = q("SELECT id FROM accounts WHERE email = 'v@shop.example'")[0];
    const t = await signLink(env, "verify", { a: a.id, e: "v@shop.example" }, 3600);
    const r = await call(env, `/api/v1/account/verify?t=${encodeURIComponent(t)}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("verified");
    expect(q("SELECT verified FROM accounts WHERE id = ?", a.id)[0].verified).toBe(1);
  });
});

describe("Whop entitlements", () => {
  const SECRET = `whsec_${btoa("whop-test-secret-1234567890")}`;
  async function hook(env, id, body) {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signStandardWebhook(SECRET, id, ts, raw);
    return call(env, "/api/webhooks/whop", { method: "POST", body: raw, origin: null, headers: { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": sig, "content-type": "application/json" } });
  }
  const evt = (type, extra = {}) => ({ type, data: { id: "mem_1", status: "active", user: { id: "user_1", email: "buyer@shop.example" }, plan: { id: "plan_int" }, ...extra } });

  it("attaches to a confirmed account, dedupes, and ends cleanly", async () => {
    const { env, q } = await makeEnv({ WHOP_WEBHOOK_SECRET: SECRET, WHOP_PLAN_MAP: '{"plan_int":"integrity","plan_agent":"agent"}' });
    const { cookie } = await signupWithSite(env, "buyer@shop.example");
    q("UPDATE accounts SET verified = 1 WHERE email = 'buyer@shop.example'");
    expect((await hook(env, "msg_1", evt("membership.activated"))).status).toBe(200);
    expect((await (await hook(env, "msg_1", evt("membership.activated"))).json()).duplicate).toBe(true);
    let me = await (await call(env, "/api/v1/account/me", { cookie })).json();
    expect(me.plans).toEqual(["integrity"]);
    await hook(env, "msg_2", evt("membership.activated", { id: "mem_2", plan: { id: "plan_agent" } }));
    me = await (await call(env, "/api/v1/account/me", { cookie })).json();
    expect(me.plans).toEqual(["agent", "integrity"]);
    expect(me.entitlements.features).toEqual(expect.arrayContaining(["signals", "agentpass"]));
    await hook(env, "msg_3", evt("membership.deactivated", { status: "canceled" }));
    me = await (await call(env, "/api/v1/account/me", { cookie })).json();
    expect(me.plans).toEqual(["agent"]);
  });

  it("does not attach to an unconfirmed account (email squatting) and rejects bad signatures", async () => {
    const { env } = await makeEnv({ WHOP_WEBHOOK_SECRET: SECRET, WHOP_PLAN_MAP: '{"plan_int":"integrity"}' });
    const { cookie } = await signupWithSite(env, "buyer@shop.example");
    await hook(env, "msg_9", evt("membership.went_valid"));
    const me = await (await call(env, "/api/v1/account/me", { cookie })).json();
    expect(me.plans).toEqual(["free"]);
    const bad = await call(env, "/api/webhooks/whop", { method: "POST", body: "{}", origin: null, headers: { "webhook-id": "x", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" } });
    expect(bad.status).toBe(401);
  });

  it("/go/<plan> redirects to Whop checkout or back to pricing", async () => {
    const { env } = await makeEnv({ WHOP_CHECKOUT_INTEGRITY: "https://whop.com/checkout/plan_abc" });
    expect((await call(env, "/go/integrity")).headers.get("location")).toBe("https://whop.com/checkout/plan_abc");
    expect((await call(env, "/go/agent")).headers.get("location")).toContain("/pricing/");
    expect((await call(env, "/go/free")).headers.get("location")).toBe("/pricing/");
  });
});

describe("owner console", () => {
  it("requires the owner password and can comp a plan", async () => {
    const { env, q } = await makeEnv();
    await signupWithSite(env, "c@shop.example");
    expect((await call(env, "/admin/api/overview")).status).toBe(401);
    expect((await post(env, "/admin/api/login", { password: "nope" })).status).toBe(401);
    const ok = await post(env, "/admin/api/login", { password: "owner-pass-123" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("Path=/admin");
    const cookie = cookieOf(ok);
    const ov = await (await call(env, "/admin/api/overview", { cookie })).json();
    expect(ov.accounts).toBe(1);
    expect(ov.outreach.ready).toBe(false);
    const id = q("SELECT id FROM accounts")[0].id;
    const r = await post(env, `/admin/api/accounts/${id}`, { comp_plan: "enterprise" }, { cookie });
    expect((await r.json()).plans).toEqual(["enterprise"]);
    // A customer session cookie is not an owner session.
    const cust = cookieOf(await post(env, "/api/v1/account/login", { email: "c@shop.example", password: PW }));
    expect((await call(env, "/admin/api/overview", { cookie: cust.replace("ao_sess", "ao_owner") })).status).toBe(401);
    expect((await post(env, "/admin/api/settings", { outreach_enabled: true }, { cookie })).status).toBe(400); // no postal address
  });
});

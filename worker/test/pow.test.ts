// @ts-nocheck
import { describe, expect, it, vi, afterEach } from "vitest";
import { call, makeEnv, post, setPlan, setPolicy, signupWithSite, solve } from "./helpers/env";
import { leadingZeroBits } from "../src/pow";
import { invalidateSites } from "../src/sites";
import { _resetQuotaCache } from "../src/lib/quota";

const SHOP = "https://shop.example";

async function getChallenge(env, siteId, origin = SHOP, extra = "") {
  return call(env, `/api/v1/challenge?sitekey=${siteId}${extra}`, { origin });
}
async function passToken(env, siteId, origin = SHOP, signals = undefined) {
  const c = await (await getChallenge(env, siteId, origin)).json();
  const nonce = await solve(c.salt, c.difficulty);
  const r = await post(env, "/api/v1/redeem", { challenge: c.challenge, nonce, signals }, { origin });
  return { res: r, body: await r.json(), c };
}
const verify = (env, secret, response, form = false) => form
  ? call(env, "/api/siteverify", { method: "POST", body: new URLSearchParams({ secret, response }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" }, origin: null })
  : post(env, "/api/siteverify", { secret, response }, { origin: null });

afterEach(() => vi.useRealTimers());

describe("leadingZeroBits", () => {
  it("counts bits across bytes", () => {
    expect(leadingZeroBits(new Uint8Array([0, 0, 0x0f]))).toBe(20);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
  });
});

describe("Ghost-PoW end to end", () => {
  it("challenge → solve → redeem → siteverify once, then duplicate", async () => {
    const { env } = await makeEnv();
    const { cookie, site, secret } = await signupWithSite(env);
    await setPolicy(env, cookie, site.id, { difficulty: 12 });
    const { res, body } = await passToken(env, site.id);
    expect(res.status).toBe(200);
    const v1 = await (await verify(env, secret, body.token)).json();
    expect(v1).toMatchObject({ success: true, hostname: "shop.example", method: "pow", difficulty: 12 });
    expect(v1.risk).toBeUndefined(); // free plan: no signals
    const v2 = await (await verify(env, secret, body.token, true)).json();
    expect(v2).toMatchObject({ success: false, "error-codes": ["timeout-or-duplicate"] });
  });

  it("refuses unknown sitekeys, foreign hostnames and missing origins", async () => {
    const { env } = await makeEnv();
    const { site } = await signupWithSite(env);
    expect((await getChallenge(env, "ao_site_doesnotexist00")).status).toBe(400);
    expect((await getChallenge(env, site.id, "https://evil.example")).status).toBe(403);
    expect((await getChallenge(env, site.id, null)).status).toBe(403);
    expect((await getChallenge(env, site.id, "http://localhost:3000")).status).toBe(200); // allowLocalhost default
  });

  it("ignores a client-chosen difficulty (old ?difficulty=1 bypass)", async () => {
    const { env } = await makeEnv();
    const { site } = await signupWithSite(env);
    const c = await (await getChallenge(env, site.id, SHOP, "&difficulty=1")).json();
    expect(c.difficulty).toBe(16);
  });

  it("rejects wrong solutions, swapped hosts and forged tokens", async () => {
    const { env } = await makeEnv();
    const { cookie, site, secret } = await signupWithSite(env, "a@shop.example", ["shop.example", "www.shop.example"]);
    await setPolicy(env, cookie, site.id, { difficulty: 12 });
    const c = await (await getChallenge(env, site.id)).json();
    let bad = 0;
    while (leadingZeroBits(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${c.salt}:${bad}`)))) >= 12) bad++;
    expect((await post(env, "/api/v1/redeem", { challenge: c.challenge, nonce: bad }, { origin: SHOP })).status).toBe(400);
    const good = await solve(c.salt, c.difficulty);
    expect((await post(env, "/api/v1/redeem", { challenge: c.challenge, nonce: good }, { origin: "https://www.shop.example" })).status).toBe(403);
    // Old public-HMAC forgery: any token not signed with this deployment's key is invalid.
    const forged = `${btoa(JSON.stringify({ s: site.id, n: "x", m: "pow", exp: 9999999999 })).replace(/=+$/, "")}.AAAA`;
    expect((await (await verify(env, secret, forged)).json())["error-codes"]).toEqual(["invalid-input-response"]);
    expect((await (await verify(env, "ao_sec_wrongwrongwrongwrongwrongwrongwrong12", "x")).json())["error-codes"]).toEqual(["invalid-input-secret"]);
    expect((await (await verify(env, "", "x")).json())["error-codes"]).toEqual(["missing-input-secret"]);
  });

  it("a token for site A is useless with site B's secret", async () => {
    const { env } = await makeEnv();
    const a = await signupWithSite(env, "a@a.example", ["a.example"]);
    const b = await signupWithSite(env, "b@b.example", ["b.example"]);
    await setPolicy(env, a.cookie, a.site.id, { difficulty: 12 });
    const { body } = await passToken(env, a.site.id, "https://a.example");
    expect((await (await verify(env, b.secret, body.token)).json())["error-codes"]).toEqual(["invalid-input-response"]);
  });

  it("pass tokens expire after 5 minutes", async () => {
    const { env } = await makeEnv();
    const { cookie, site, secret } = await signupWithSite(env);
    await setPolicy(env, cookie, site.id, { difficulty: 12 });
    const { body } = await passToken(env, site.id);
    vi.useFakeTimers({ now: Date.now() + 301_000, toFake: ["Date"] });
    expect((await (await verify(env, secret, body.token)).json())["error-codes"]).toEqual(["invalid-input-response"]);
  });

  it("enforces the monthly quota (fails with quota-exceeded)", async () => {
    const { env, q } = await makeEnv();
    const { cookie, site, secret } = await signupWithSite(env);
    await setPolicy(env, cookie, site.id, { difficulty: 12 });
    q("INSERT INTO stats (site_id, day, ok) VALUES (?, ?, ?)", site.id, new Date().toISOString().slice(0, 10), 11_001);
    const { body } = await passToken(env, site.id);
    expect((await (await verify(env, secret, body.token)).json())["error-codes"]).toEqual(["quota-exceeded"]);
  });

  it("degrades to stateless (and says so) when the D1 budget is spent", async () => {
    const { env, q } = await makeEnv({ D1_WRITE_BUDGET: "10" });
    const { cookie, site, secret } = await signupWithSite(env);
    await setPolicy(env, cookie, site.id, { difficulty: 12 });
    q("INSERT INTO quota_daily (day, reads, writes) VALUES (?, 0, 1000)", new Date().toISOString().slice(0, 10));
    _resetQuotaCache();
    const { body } = await passToken(env, site.id);
    const v = await (await verify(env, secret, body.token)).json();
    expect(v).toMatchObject({ success: true, stateless: true });
  });
});

describe("IntegrityRuntime signals and adaptive difficulty", () => {
  it("adds risk + signals for integrity plans and can enforce", async () => {
    const { env, q } = await makeEnv();
    const { cookie, site, secret } = await signupWithSite(env);
    await setPlan(env, q, "owner@shop.example", "integrity");
    await setPolicy(env, cookie, site.id, { difficulty: 12, signals: "report" });
    const { body } = await passToken(env, site.id, SHOP, { wd: true, langs: 0 });
    const v = await (await verify(env, secret, body.token)).json();
    expect(v.risk).toBeGreaterThan(0.9);
    expect(v.signals).toContain("webdriver");
    await setPolicy(env, cookie, site.id, { signals: "enforce", riskThreshold: 0.5 });
    const r = await passToken(env, site.id, SHOP, { wd: true });
    expect(r.res.status).toBe(403);
    const clean = await passToken(env, site.id, SHOP, { wd: false, langs: 3, plugins: 5, ow: 1200, oh: 800 });
    expect(clean.res.status).toBe(200);
  });

  it("raises difficulty during a surge only on plans with adaptive difficulty", async () => {
    const { env, q } = await makeEnv();
    const { cookie, site } = await signupWithSite(env);
    await setPolicy(env, cookie, site.id, { difficulty: 12, surgePerMinute: 10 });
    let last;
    for (let i = 0; i < 12; i++) last = await (await getChallenge(env, site.id)).json();
    expect(last.difficulty).toBe(12); // free: no adaptive
    await setPlan(env, q, "owner@shop.example", "integrity");
    for (let i = 0; i < 12; i++) last = await (await getChallenge(env, site.id)).json();
    expect(last.difficulty).toBeGreaterThan(12);
    invalidateSites();
  });
});

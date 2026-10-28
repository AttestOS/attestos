// @ts-nocheck
import { describe, expect, it, vi, afterEach } from "vitest";

const sent: { to: string; mime: string }[] = [];
let failNext: any = null;
vi.mock("../src/mail/smtp", async (orig) => {
  const real = await orig();
  return {
    ...real,
    SmtpSession: { open: async () => ({ send: async (_f, to, mime) => { if (failNext) { const e = failNext; failNext = null; throw e; } sent.push({ to, mime }); return "250 ok"; }, quit: async () => {} }) },
  };
});

import { call, makeEnv, post } from "./helpers/env";
import { botAccess, detectVendors, findEmails, parseRobots, pageKind, scan, targetUrl } from "../src/scanner";
import { firstTouch, outreachTick, parseAddr } from "../src/outreach";
import { enqueue, processOutbox, unsubscribeUrl } from "../src/mail/outbox";
import { SmtpError } from "../src/mail/smtp";
import { setSetting } from "../src/lib/db";
import worker from "../src/index";

afterEach(() => { vi.unstubAllGlobals(); sent.length = 0; failNext = null; });

const LANE = { MAILBOXES: '[{"id":"lv1","host":"mail.example","cold":3,"transactional":5,"hourly":10}]', MAILBOX_LV1_USER: "me@mail.example", MAILBOX_LV1_PASS: "pw" };

describe("scanner", () => {
  it("parses robots.txt groups the way crawlers do", () => {
    const g = parseRobots("User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\n");
    expect(botAccess(g, "GPTBot")).toEqual({ access: "blocked", rule: "named" });
    expect(botAccess(g, "CCBot").access).toBe("blocked");
    expect(botAccess(g, "ClaudeBot")).toEqual({ access: "allowed", rule: "wildcard" });
    expect(botAccess(parseRobots(""), "GPTBot").rule).toBe("none");
  });
  it("detects vendors, page kinds and on-domain emails only", () => {
    expect(detectVendors('<script src="https://www.google.com/recaptcha/api.js"></script><div class="g-recaptcha">').map((v) => v.id)).toEqual(["recaptcha_v2"]);
    expect(detectVendors('<script src="https://js.hcaptcha.com/1/api.js">').map((v) => v.id)).toEqual(["hcaptcha"]);
    expect(detectVendors('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js">')[0].friction).toBe("none");
    expect(pageKind('<input type="password"><input type="password">', "https://a.example/x")).toBe("signup");
    expect(findEmails('<a href="mailto:sales@shop.example">x</a> admin@other.example hello&#64;shop.example', "www.shop.example")).toEqual(["sales@shop.example", "hello@shop.example"]);
  });
  it("refuses private / odd targets", () => {
    for (const bad of ["http://localhost/", "https://10.0.0.1/", "https://printer.local/", "ftp://a.example/", "https://user:pw@a.example/", "https://a.example:8080/"]) expect(() => targetUrl(bad)).toThrow();
    expect(targetUrl("shop.example/signup").toString()).toBe("https://shop.example/signup");
  });
  it("scans a page for real (fetch stubbed) and stores a shareable report", async () => {
    vi.stubGlobal("fetch", async (url) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      if (u.includes("security.txt")) return new Response("nope", { status: 404 });
      return new Response('<form><input type="password"><input type="password"></form><script src="https://www.google.com/recaptcha/api.js"></script>', { status: 200, headers: { "strict-transport-security": "max-age=1" } });
    });
    const r = await scan(new URL("https://shop.example/signup"));
    expect(r.vendors[0].id).toBe("recaptcha_v2");
    expect(r.findings.map((f) => f.title).join(" ")).toMatch(/Visible CAPTCHA/);
    expect(r.score).toBeLessThan(70);
    const { env } = await makeEnv();
    const res = await post(env, "/api/v1/scan", { url: "shop.example/signup" });
    const j = await res.json();
    expect(j.id).toMatch(/^[a-z0-9]{12}$/);
    expect(j.emails).toBeUndefined();
    expect((await call(env, `/api/v1/scan/${j.id}`)).status).toBe(200);
    expect((await post(env, `/api/v1/scan/${j.id}/lead`, { email: "me@shop.example" })).status).toBe(200);
  });
});

describe("honest outreach", () => {
  const P = { domain: "shop.example", page_url: "https://shop.example/signup", vendor: "recaptcha_v2", page_kind: "signup", contact_email: "hello@shop.example", contact_source: "https://shop.example/contact" };
  const ops = (env, body, token = "t".repeat(32)) => call(env, "/api/ops/prospects", { method: "POST", body: JSON.stringify(body), origin: null, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });

  it("ops intake needs the token and only accepts verifiable prospects", async () => {
    const { env, q } = await makeEnv({ AO_OPS_TOKEN: "t".repeat(32) });
    expect((await ops(env, { prospects: [P] }, "x".repeat(32))).status).toBe(401);
    const r = await (await ops(env, { prospects: [P, { ...P, domain: "dept.gov", contact_email: "a@dept.gov" }, { ...P, domain: "b.example", contact_email: "x@gmail.com" }, { ...P, domain: "c.example", vendor: "turnstile" }] })).json();
    expect(r).toMatchObject({ added: 1, skipped: 3 });
    expect(q("SELECT status FROM prospects")[0].status).toBe("new");
  });

  it("never sends until switched on with a postal address; then first touch + one follow-up", async () => {
    const { env, q } = await makeEnv({ AO_OPS_TOKEN: "t".repeat(32), ...LANE });
    await ops(env, { prospects: [P] });
    expect((await outreachTick(env)).queued).toBe(0);
    env.POSTAL_ADDRESS = "1 Main St, Harare, Zimbabwe";
    await setSetting(env, "outreach_enabled", "1");
    expect((await outreachTick(env)).queued).toBe(1);
    await processOutbox(env);
    expect(sent).toHaveLength(1);
    const mime = sent[0].mime;
    expect(mime).toMatch(/List-Unsubscribe: <mailto:me@mail\.example\?subject=unsubscribe>, <https:\/\/attestos-edge/);
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    const body = Buffer.from(mime.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString();
    expect(body).toContain("reCAPTCHA v2");
    expect(body).toContain("https://shop.example/signup");
    expect(body).toContain('Reply "no"');
    expect(body).toContain("1 Main St, Harare");
    expect(body).toContain("/u/");
    expect((await outreachTick(env)).queued).toBe(0); // no follow-up before 4 days
    q("UPDATE prospects SET first_sent_at = datetime('now','-5 days')");
    expect((await outreachTick(env)).queued).toBe(1);
    await processOutbox(env);
    expect(sent[1].mime).toMatch(/Subject: Re: /);
    q("UPDATE prospects SET first_sent_at = datetime('now','-9 days')");
    expect((await outreachTick(env)).queued).toBe(0); // only one follow-up ever
  });

  it("respects the lane's daily cold cap and suppresses bounced recipients", async () => {
    const { env, q } = await makeEnv({ AO_OPS_TOKEN: "t".repeat(32), ...LANE, POSTAL_ADDRESS: "1 Main St" });
    await setSetting(env, "outreach_enabled", "1");
    await ops(env, { prospects: [1, 2, 3, 4, 5].map((i) => ({ ...P, domain: `s${i}.example`, page_url: `https://s${i}.example/`, contact_email: `hi@s${i}.example`, contact_source: `https://s${i}.example/c` })) });
    expect((await outreachTick(env)).queued).toBe(3);
    failNext = new SmtpError("recipient", 550, "no such user");
    await processOutbox(env);
    expect(sent).toHaveLength(2);
    expect(q("SELECT COUNT(*) AS n FROM suppress")[0].n).toBe(1);
    expect((await outreachTick(env)).queued).toBe(0); // cap of 3 used today (2 sent + 1 refused attempt)
  });

  it("unsubscribe link: GET confirms, POST suppresses", async () => {
    const { env, q } = await makeEnv();
    const url = new URL(await unsubscribeUrl(env, "Hello@Shop.example"));
    const g = await call(env, url.pathname);
    expect(await g.text()).toContain("hello@shop.example");
    expect(g.headers.get("x-robots-tag")).toBe("noindex");
    expect(q("SELECT COUNT(*) AS n FROM suppress")[0].n).toBe(0);
    await call(env, url.pathname, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(q("SELECT reason FROM suppress")[0].reason).toBe("unsubscribe-link");
    expect(await enqueue(env, { to: "hello@shop.example", subject: "x", body: "y", kind: "first" })).toBeNull();
    expect(await enqueue(env, { to: "hello@shop.example", subject: "x", body: "y", kind: "notice" })).not.toBeNull();
  });

  it("template never claims more than we saw", () => {
    const m = firstTouch({ SITE_URL: "https://x", POSTAL_ADDRESS: "Addr", OWNER_NAME: "Sam" }, { domain: "a.example", page_url: "https://a.example/login", vendor: "hcaptcha", page_kind: "login" }, "https://x/u/t");
    expect(m.subject).toBe("a.example: the hCaptcha on your login page");
    expect(m.body).toContain("before they can log in");
    expect(m.body).not.toMatch(/\d+%|guarantee/i);
  });

  it("parses From addresses", () => {
    expect(parseAddr("From: \"Ann\" <Ann@Shop.example>\r\nSubject: hi", "From")).toBe("ann@shop.example");
    expect(parseAddr("Subject: x\r\nFrom: bob@a.example", "From")).toBe("bob@a.example");
  });
});

describe("worker shell", () => {
  it("adds security headers, 404s unknown APIs, serves assets", async () => {
    const { env } = await makeEnv();
    const r = await call(env, "/");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await call(env, "/api/nope")).status).toBe(404);
    const h = await (await call(env, "/api/health")).json();
    expect(h.ok).toBe(true);
    const plans = await (await call(env, "/api/v1/plans")).json();
    expect(plans.plans.map((p) => p.price)).toEqual([0, 49, 149, 99, 299]);
  });
  it("cron jobs run without SQL errors", async () => {
    const { env, q } = await makeEnv();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const waits = [];
    await worker.scheduled({ cron: "17 3 * * *" }, env, { waitUntil: (p) => waits.push(p) });
    await worker.scheduled({ cron: "*/10 * * * *" }, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    expect(q("SELECT COUNT(*) AS n FROM errors")[0].n).toBe(0);
  });
});

describe("prospect script stays in sync", () => {
  it("uses exactly the scanner's high-friction vendor patterns", async () => {
    const { VENDORS } = await import("../src/scanner");
    // @ts-expect-error plain .mjs script without types
    const { HIGH_FRICTION_VENDORS } = await import("../../scripts/prospects.mjs");
    const want = VENDORS.filter((v) => v.friction === "high").map((v) => [v.id, v.test.source]);
    expect(HIGH_FRICTION_VENDORS.map((v: { id: string; test: RegExp }) => [v.id, v.test.source])).toEqual(want);
  });
  it("reCAPTCHA v3 (render=key) is not reported as a visible v2 challenge", async () => {
    const { detectVendors } = await import("../src/scanner");
    const ids = detectVendors('<script src="https://www.google.com/recaptcha/api.js?render=6LcAbCdEfGhIjKlMnOp"></script>').map((v) => v.id);
    expect(ids).toEqual(["recaptcha_v3"]);
    expect(detectVendors('<div class="g-recaptcha" data-sitekey="x"></div><script src="https://www.google.com/recaptcha/api.js" async></script>').map((v) => v.id)).toEqual(["recaptcha_v2"]);
  });
});

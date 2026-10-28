// @ts-nocheck
// Press mesh hooks (/api/press/*): the contract press/auto.py and press/controls.py rely on, plus the console
// helpers behind the owner console Mesh tab. Bearer auth, fail-closed when unconfigured, content-addressed card hosting,
// encrypted owner-pasted rail keys that never come back to the UI.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1 } from "./helpers/d1";
import { HttpError } from "../src/lib/http";
import { goRoute, GO_PAGES } from "../src/whop";
import { runCron } from "../src/cron";
import { call, makeEnv, post, cookieOf } from "./helpers/env";
import { pressHook, pressOverview, setMeshOverride, setPressControl, setPressKey, PRESS_CONTROLS, pressRails } from "../src/press/hooks";

const SITE = "https://attestos-edge.attestos.workers.dev";
const TOKEN = "press-secret-token-123";
let env: any, q: (sql: string, ...b: unknown[]) => any[];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

beforeEach(async () => {
  const d = await makeD1();
  q = d.q;
  env = { DB: d.DB, SITE_URL: SITE, APP_SECRET: "s".repeat(32), AO_PRESS_TOKEN: TOKEN, DEV_MODE: "false" };
});

async function hit(path: string, o: { method?: string; body?: BodyInit; auth?: string | null; type?: string } = {}) {
  const headers: Record<string, string> = {};
  if (o.auth !== null) headers.authorization = `Bearer ${o.auth ?? TOKEN}`;
  if (o.type) headers["content-type"] = o.type;
  const req = new Request(SITE + path, { method: o.method || "GET", headers, body: o.body });
  try {
    const r = await pressHook(req, env, path);
    if (!r) return { status: 0, body: "", res: null as Response | null };
    return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.text() : "", res: r };
  } catch (e) {
    return { status: e instanceof HttpError ? e.status : 500, body: String((e as Error).message), res: null };
  }
}

describe("auth", () => {
  it("ignores non-press paths and fails closed without the token", async () => {
    expect((await hit("/api/v1/plans")).status).toBe(0);
    expect((await hit("/api/press/controls", { auth: null })).status).toBe(401);
    expect((await hit("/api/press/controls", { auth: "wrong" })).status).toBe(401);
    delete env.AO_PRESS_TOKEN;
    expect((await hit("/api/press/controls")).status).toBe(404);           // lane off: looks like nothing is there
  });
});

describe("controls + usage", () => {
  it("serves every catalog key with defaults, honours stored values, rejects out-of-range ones", async () => {
    let r = await hit("/api/press/controls");
    let v = JSON.parse(r.body);
    expect(v.ok).toBe(true);
    for (const s of PRESS_CONTROLS) expect(v.values[s.key]).toBe(s.default);
    await setPressControl(env, "AO_PRESS_ENABLED", 0);
    await expect(setPressControl(env, "AO_PRESS_LLM_CALLS_PER_RUN", 1000)).rejects.toThrow(/safe range/);
    await expect(setPressControl(env, "NOPE", 1)).rejects.toThrow(/Unknown/);
    v = JSON.parse((await hit("/api/press/controls")).body);
    expect(v.values.AO_PRESS_ENABLED).toBe(0);
  });
  it("records the last run's usage in one setting", async () => {
    const r = await hit("/api/press/quota-usage", { method: "POST", type: "application/json",
      body: JSON.stringify({ id: "press", at: "2026-10-27T10:00:00Z", value: 14, window: "123-1", effective: { AO_PRESS_LLM_CALLS_PER_RUN: 100 } }) });
    expect(JSON.parse(r.body).ok).toBe(true);
    expect((await pressOverview(env)).lastRun.value).toBe(14);
  });

  it("keeps only rail-shaped names from the run's armed list (console 'waiting for account')", async () => {
    await hit("/api/press/quota-usage", { method: "POST", type: "application/json", body: JSON.stringify({ id: "press", value: 1, armed: ["bsky", "x_a", "<b>", 7, "a".repeat(41)] }) });
    expect((await pressOverview(env)).lastRun.armed).toEqual(["bsky", "x_a"]);
    await hit("/api/press/quota-usage", { method: "POST", type: "application/json", body: JSON.stringify({ id: "press", value: 1 }) });
    expect((await pressOverview(env)).lastRun.armed).toBeUndefined();
  });
});

describe("card hosting", () => {
  it("stores a PNG once by sha256 and serves it publicly with an immutable cache", async () => {
    const a = JSON.parse((await hit("/api/press/img", { method: "POST", body: PNG, type: "image/png" })).body);
    const b = JSON.parse((await hit("/api/press/img", { method: "POST", body: PNG, type: "image/png" })).body);
    expect(a.url).toMatch(new RegExp(`^${SITE}/api/press/img/[a-f0-9]{64}\\.png$`));
    expect(b.url).toBe(a.url);
    expect(q("SELECT COUNT(*) AS n FROM press_img")[0].n).toBe(1);
    const path = new URL(a.url).pathname;
    const g = await hit(path, { auth: null });
    expect(g.status).toBe(200);
    expect(g.res!.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await g.res!.arrayBuffer())).toEqual(PNG);
    expect((await hit(path.replace(/[a-f0-9]{8}\.png$/, "00000000.png"), { auth: null })).status).toBe(404);
  });
  it("serves the bytes when D1 hands the BLOB back as a number[] (production D1 shape)", async () => {
    const hash = "a".repeat(64);
    const real = env.DB;
    env.DB = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ png: Array.from(PNG) }], meta: {} }) }) }) };
    const g = await hit(`/api/press/img/${hash}.png`, { auth: null });
    env.DB = real;
    expect(new Uint8Array(await g.res!.arrayBuffer())).toEqual(PNG);
  });
  it("rejects non-PNG and oversize uploads, and needs the token to upload", async () => {
    expect((await hit("/api/press/img", { method: "POST", body: "GIF89a....", type: "image/png" })).status).toBe(415);
    expect((await hit("/api/press/img", { method: "POST", body: new Uint8Array(1_600_000), type: "image/png" })).status).toBe(413);
    expect((await hit("/api/press/img", { method: "POST", body: PNG, auth: null })).status).toBe(401);
  });
  it("is purged by the daily retention sweep after 21 days", async () => {
    await hit("/api/press/img", { method: "POST", body: PNG, type: "image/png" });
    q("UPDATE press_img SET created_at = datetime('now','-22 days')");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));   // crawler ranges / issuer keys
    await runCron("17 3 * * *", env);
    vi.unstubAllGlobals();
    expect(q("SELECT COUNT(*) AS n FROM press_img")[0].n).toBe(0);
  });
});

describe("settings + mesh overrides", () => {
  it("returns owner-pasted keys decrypted to the press only, encrypted at rest, never to the console", async () => {
    await setPressKey(env, "AO_BUFFER_TOKEN_A_CO", "buf-secret-A");
    const raw = q("SELECT value FROM settings WHERE key = 'press_env:AO_BUFFER_TOKEN_A_CO'")[0].value;
    expect(raw).not.toContain("buf-secret-A");
    const s = JSON.parse((await hit("/api/press/settings")).body).settings;
    expect(s.AO_BUFFER_TOKEN_A_CO).toBe("buf-secret-A");
    const ov = await pressOverview(env);
    expect(JSON.stringify(ov)).not.toContain("buf-secret-A");
    expect(ov.keys.map((k: any) => k.name)).toEqual(["AO_BUFFER_TOKEN_A_CO"]);
    await setPressKey(env, "AO_BUFFER_TOKEN_A_CO", "");
    expect(JSON.parse((await hit("/api/press/settings")).body).settings).toEqual({});
  });
  it("refuses key names outside the press namespaces and the press token itself", async () => {
    for (const bad of ["APP_SECRET", "OWNER_PASSWORD_HASH", "AO_PRESS_TOKEN", "AO_SITE_URL", "lower_case", "WHOP_WEBHOOK_SECRET"])
      await expect(setPressKey(env, bad, "x")).rejects.toThrow(/not a press key/);
    await setPressKey(env, "GROQ_API_KEY", "gsk_x");
    await setPressKey(env, "WHOP_COMPANY_ID", "biz_x");
  });
  it("park/resume/per_day overrides reach the press for known rails only", async () => {
    await setMeshOverride(env, "x", { parked: true });
    await setMeshOverride(env, "linkedin_a", { per_day: 1 });
    await expect(setMeshOverride(env, "myspace", { parked: true })).rejects.toThrow(/Unknown rail/);
    await expect(setMeshOverride(env, "x", { per_day: 99 })).rejects.toThrow(/0–10/);
    const rails = JSON.parse((await hit("/api/press/mesh-config")).body).rails;
    expect(rails).toEqual({ x: { parked: true }, linkedin_a: { per_day: 1 } });
    await setMeshOverride(env, "x", { parked: false });
    expect(JSON.parse((await hit("/api/press/mesh-config")).body).rails.x.parked).toBe(false);
    expect(pressRails()).toContain("whop_public");
  });
});

describe("notify + go targets", () => {
  it("logs a rail alert and pushes it to the owner", async () => {
    const f = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", f);
    env.NTFY_TOPIC = "topic";
    const r = await hit("/api/press/notify", { method: "POST", type: "application/json", body: JSON.stringify({ content: "x: Buffer rejected", source: "press" }) });
    expect(JSON.parse(r.body).ok).toBe(true);
    expect(q("SELECT COUNT(*) AS n FROM errors WHERE scope = 'press:rail'")[0].n).toBe(1);
    expect(f).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("every /go page resolves with utm_source for tracked press links, and counts the click per key and rail", async () => {
    for (const [k, path] of Object.entries(GO_PAGES)) {
      const r = await goRoute(new Request(`${SITE}/go/${k}?src=x-test`), env, k);
      const loc = new URL(r.headers.get("location")!, SITE);
      expect(loc.pathname).toBe(path.split("#")[0]);
      expect(loc.searchParams.get("utm_source")).toBe("x-test");
    }
    expect(q("SELECT n FROM usage WHERE key = 'go:scanner:x'")[0].n).toBe(1);
    const plain = await goRoute(new Request(`${SITE}/go/docs`), env, "docs");             // untracked: no count, no utm
    expect(plain.headers.get("location")).toBe("/docs/");
    const junk = await goRoute(new Request(`${SITE}/go/docs?src=${"z".repeat(80)}`), env, "docs");
    expect(junk.headers.get("location")).toBe("/docs/");
    expect(q("SELECT key, n FROM usage WHERE key LIKE 'go:docs:%'")).toEqual([{ key: "go:docs:x", n: 1 }]);   // only the tracked click
    const robots = await goRoute(new Request(`${SITE}/go/robots?src=l-a`), env, "robots");
    expect(robots.headers.get("location")).toBe("/docs/?utm_source=l-a#robots");
    const plan = await goRoute(new Request(`${SITE}/go/integrity?src=l-a`), env, "integrity");  // no checkout yet
    expect(plan.headers.get("location")).toBe("/pricing/?checkout=soon#integrity");
    env.WHOP_CHECKOUT_INTEGRITY = "https://whop.com/checkout/plan_x";
    expect((await goRoute(new Request(`${SITE}/go/integrity`), env, "integrity")).headers.get("location")).toBe("https://whop.com/checkout/plan_x");
    expect((await goRoute(new Request(`${SITE}/go/nope?src=x-a`), env, "nope")).headers.get("location")).toBe("/pricing/");
  });
});

describe("owner console Mesh tab API", () => {
  it("needs the owner session, lists rails/controls/keys/clicks and saves overrides", async () => {
    const { env: e } = await makeEnv({ AO_PRESS_TOKEN: TOKEN });
    expect((await call(e, "/admin/api/press")).status).toBe(401);
    const cookie = cookieOf(await post(e, "/admin/api/login", { password: "owner-pass-123" }));
    let r = await call(e, "/admin/api/press", { cookie });
    expect(r.status).toBe(200);
    let j = await r.json();
    expect(j.configured).toBe(true);
    expect(j.rails.map((x) => x.rail)).toContain("bsky");
    expect(Array.isArray(j.clicks)).toBe(true);
    expect((await post(e, "/admin/api/press/rails/bsky", { parked: true }, { cookie })).status).toBe(200);
    expect((await post(e, "/admin/api/press/rails/bsky", { per_day: 50 }, { cookie })).status).toBe(400);
    expect((await post(e, "/admin/api/press/controls", { key: "AO_PRESS_ENABLED", value: 0 }, { cookie })).status).toBe(200);
    expect((await post(e, "/admin/api/press/keys", { name: "AO_BSKY_ID", value: "attestos.bsky.social" }, { cookie })).status).toBe(200);
    expect((await post(e, "/admin/api/press/keys", { name: "APP_SECRET", value: "x" }, { cookie })).status).toBe(400);
    expect((await post(e, "/admin/api/press/rails/bsky", { parked: false }, { cookie, origin: "https://evil.example" })).status).toBe(403);
    j = await (await call(e, "/admin/api/press", { cookie })).json();
    expect(j.overrides.bsky.parked).toBe(true);
    expect(j.controls.values.AO_PRESS_ENABLED).toBe(0);
    expect(j.keys.map((k) => k.name)).toEqual(["AO_BSKY_ID"]);
    expect(JSON.stringify(j)).not.toContain("attestos.bsky.social");
    // the press itself reads them back through the bearer route, end to end through the Worker
    r = await call(e, "/api/press/settings", { headers: { authorization: `Bearer ${TOKEN}` }, origin: null });
    expect((await r.json()).settings.AO_BSKY_ID).toBe("attestos.bsky.social");
    expect((await call(e, "/api/press/settings", { origin: null })).status).toBe(401);
  });
});

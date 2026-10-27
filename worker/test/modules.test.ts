// @ts-nocheck
import { describe, expect, it, vi, afterEach } from "vitest";
import { call, makeEnv, post, setPlan, setPolicy, signupWithSite } from "./helpers/env";
import { b64url, b64urlToBytes } from "../src/lib/crypto";
import { decodeCbor } from "../src/lib/cbor";
import { derToRaw } from "../src/lib/cose";
import { toRsaEncryptionSpki } from "../src/lib/der";
import { tokenChallenge, verifyToken2 } from "../src/pat";
import { classify, decide, inCidr } from "../src/agents";
import { DEFAULT_POLICY } from "../src/sites";
import { setSetting } from "../src/lib/db";

afterEach(() => vi.unstubAllGlobals());

// ---------- tiny CBOR encoder for building authenticator responses ----------
function cbor(v): number[] {
  const head = (major, n) => n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : [major << 5 | 25, n >> 8, n & 255];
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = [...new TextEncoder().encode(v)]; return [...head(3, b.length), ...b]; }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
  if (v instanceof Map) { const out = head(5, v.size); for (const [k, x] of v) out.push(...cbor(k), ...cbor(x)); return out; }
  throw new Error("unsupported");
}
const sha = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof b === "string" ? new TextEncoder().encode(b) : b));
function rawToDer(raw: Uint8Array) {
  const int = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = [...b.slice(i)]; if (v[0] & 0x80) v = [0, ...v]; return [2, v.length, ...v]; };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

describe("CBOR / COSE helpers", () => {
  it("decodes maps, negative ints and reports the end offset", () => {
    const bytes = new Uint8Array([...cbor(new Map([[1, 2], [-1, "x"]])), 0xff]);
    const { value, end } = decodeCbor(bytes);
    expect(value.get(1)).toBe(2);
    expect(value.get(-1)).toBe("x");
    expect(end).toBe(bytes.length - 1);
  });
  it("converts DER ECDSA signatures to raw r||s", () => {
    const raw = new Uint8Array(64).map((_, i) => (i === 0 ? 0x80 : i === 32 ? 0 : i));
    expect([...derToRaw(rawToDer(raw))]).toEqual([...raw]);
  });
});

describe("AttestKit passkeys (ES256, end to end)", () => {
  it("registers via the customer backend, signs in from the browser, siteverify returns user_id once", async () => {
    const { env } = await makeEnv();
    const { site, secret } = await signupWithSite(env, "pk@shop.example", ["shop.example"]);
    const ORIGIN = "https://shop.example";
    const begin = await (await post(env, "/api/v1/passkeys/register/begin", { secret, user_id: "user-42", user_name: "ada" }, { origin: null })).json();
    expect(begin.publicKey.rp.id).toBe("shop.example");

    // Authenticator: P-256 key pair, attestation "none".
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const cose = new Uint8Array(cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, b64urlToBytes(jwk.x)], [-3, b64urlToBytes(jwk.y)]])));
    const credId = crypto.getRandomValues(new Uint8Array(16));
    const rpHash = await sha("shop.example");
    const authData = new Uint8Array([...rpHash, 0x45, 0, 0, 0, 1, ...new Uint8Array(16), 0, 16, ...credId, ...cose]);
    const cd = (type, challenge) => b64url(new TextEncoder().encode(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false })));
    const attObj = new Uint8Array(cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])));
    const fin = await post(env, "/api/v1/passkeys/register/finish", { token: begin.token, credential: { id: b64url(credId), response: { clientDataJSON: cd("webauthn.create", begin.publicKey.challenge), attestationObject: b64url(attObj) } } }, { origin: ORIGIN });
    expect(fin.status).toBe(200);
    expect((await fin.json()).user_id).toBe("user-42");

    // Sign-in.
    const lb = await (await post(env, "/api/v1/passkeys/login/begin", { sitekey: site.id }, { origin: ORIGIN })).json();
    const signIn = async (count, challenge, token) => {
      const ad = new Uint8Array([...rpHash, 0x05, 0, 0, 0, count]);
      const cdj = cd("webauthn.get", challenge);
      const msg = new Uint8Array([...ad, ...(await sha(b64urlToBytes(cdj)))]);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, msg));
      return post(env, "/api/v1/passkeys/login/finish", { token, credential: { id: b64url(credId), response: { clientDataJSON: cdj, authenticatorData: b64url(ad), signature: b64url(rawToDer(sig)) } } }, { origin: ORIGIN });
    };
    const ok = await signIn(2, lb.publicKey.challenge, lb.token);
    expect(ok.status).toBe(200);
    const pass = await ok.json();
    const v = await (await post(env, "/api/siteverify", { secret, response: pass.token }, { origin: null })).json();
    expect(v).toMatchObject({ success: true, method: "passkey", user_id: "user-42" });
    expect((await (await post(env, "/api/siteverify", { secret, response: pass.token }, { origin: null })).json()).success).toBe(false);

    // Replayed counter (cloned key) and a tampered challenge are refused.
    const lb2 = await (await post(env, "/api/v1/passkeys/login/begin", { sitekey: site.id }, { origin: ORIGIN })).json();
    expect((await signIn(2, lb2.publicKey.challenge, lb2.token)).status).toBe(400);
    expect((await signIn(3, "wrong-challenge", lb2.token)).status).toBe(400);
  });

  it("caps passkeys on the free plan", async () => {
    const { env, q } = await makeEnv();
    const { site, secret } = await signupWithSite(env);
    for (let i = 0; i < 50; i++) q("INSERT INTO passkeys (site_id, cred_id, user_id, public_key, alg) VALUES (?, ?, 'u', '{}', -7)", site.id, `c${i}`);
    expect((await post(env, "/api/v1/passkeys/register/begin", { secret, user_id: "u2" }, { origin: null })).status).toBe(403);
  });
});

describe("Private Access Tokens (type 2)", () => {
  // AlgorithmIdentifier prefix of a real RSASSA-PSS SPKI (copied from Cloudflare's demo issuer directory).
  const DEMO = "MIIBUjA9BgkqhkiG9w0BAQowMKANMAsGCWCGSAFlAwQCAqEaMBgGCSqGSIb3DQEBCDALBglghkgBZQMEAgKiAwIBMAOCAQ8AMIIBCgKCAQEAowoPUtEXFUPBTARZmCFZe4TU9H1OdzjT82IwgiVjWmV9ExCR3ot1LlhXhiTQx2zdddmLpbwMQtnueY064Eqy-k5r5X3QvrmOi5fW_EEqkB6gC972TG7Vee3oK04Kk3Qojm9phKPmGKBubvIdUxYsX2KJdVDydNHSGlk_mY4YxkCgoRvqz1XnY0N9ri6qcuE2tQKSCVAcg1gNs3idu8rLPuhDv_M5ZkaCcdgUcBpxMi2f1cxH8lOKdpE-PsGPoRqy46OFQhQeYxR-xHfqlYMfvtN9FMwLntOYT-uHWaK08gZKlyushbQ1OkgHOBq3crLwg7uhpnCthV9IbJIHMpbXWwIDAQAB";

  it("imports a real issuer's RSASSA-PSS key after conversion", async () => {
    const spki = toRsaEncryptionSpki(b64urlToBytes(DEMO));
    const k = await crypto.subtle.importKey("spki", spki, { name: "RSA-PSS", hash: "SHA-384" }, false, ["verify"]);
    expect(k.algorithm.name).toBe("RSA-PSS");
  });

  async function issuer() {
    const kp = await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" }, true, ["sign", "verify"]);
    const plain = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
    // Re-wrap our RSAPublicKey in the PSS AlgorithmIdentifier, like a real issuer publishes it.
    const demo = b64urlToBytes(DEMO);
    const algId = demo.slice(4, 4 + 2 + demo[5]);
    const rsaKey = plain.slice(plain.length - 270);
    const bit = [0x03, 0x82, 0x01, 0x0f, 0x00, ...rsaKey];
    const body = [...algId, ...bit];
    const pss = new Uint8Array([0x30, 0x82, body.length >> 8, body.length & 255, ...body]);
    return { kp, key: b64url(pss), id: b64url(await sha(pss)) };
  }
  async function mint(kp, keyId, challenge) {
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const input = new Uint8Array([0, 2, ...nonce, ...(await sha(challenge)), ...b64urlToBytes(keyId)]);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 48 }, kp.privateKey, input));
    return new Uint8Array([...input, ...sig]);
  }

  it("verifies a valid token and rejects tampering / other challenges", async () => {
    const iss = await issuer();
    const keys = [{ issuer: "issuer.example", key: iss.key, id: iss.id }];
    const ch = tokenChallenge("issuer.example", new Uint8Array(32).fill(7), "attestos-edge.attestos.workers.dev");
    const tok = await mint(iss.kp, iss.id, ch);
    expect(await verifyToken2(tok, ch, keys)).toMatch(/^[0-9a-f]{64}$/);
    const other = tokenChallenge("issuer.example", new Uint8Array(32).fill(8), "attestos-edge.attestos.workers.dev");
    expect(await verifyToken2(tok, other, keys)).toBeNull();
    const bad = tok.slice(); bad[300] ^= 1;
    expect(await verifyToken2(bad, ch, keys)).toBeNull();
  });

  it("probe: 401 PrivateToken challenge without a token, pass token with one (hardware plan only)", async () => {
    const { env, q } = await makeEnv();
    const { site, secret, cookie } = await signupWithSite(env, "hw@shop.example");
    const iss = await issuer();
    await setSetting(env, "pat_keys", JSON.stringify([{ issuer: "issuer.example", key: iss.key, id: iss.id }]));
    let c = await (await call(env, `/api/v1/challenge?sitekey=${site.id}`, { origin: "https://shop.example" })).json();
    expect(c.pat).toBeNull(); // free plan
    await setPlan(env, q, "hw@shop.example", "hardware");
    c = await (await call(env, `/api/v1/challenge?sitekey=${site.id}`, { origin: "https://shop.example" })).json();
    const probe = new URL(c.pat).pathname + new URL(c.pat).search;
    const r401 = await call(env, probe, { origin: "https://shop.example" });
    expect(r401.status).toBe(401);
    const m = r401.headers.get("www-authenticate").match(/challenge="([^"]+)"/);
    const tok = await mint(iss.kp, iss.id, b64urlToBytes(m[1]));
    const ok = await call(env, probe, { origin: "https://shop.example", headers: { authorization: `PrivateToken token="${b64url(tok)}"` } });
    expect(ok.status).toBe(200);
    const v = await (await post(env, "/api/siteverify", { secret, response: (await ok.json()).token }, { origin: null })).json();
    expect(v).toMatchObject({ success: true, method: "pat" });
    void cookie;
  });
});

describe("AgentPass", () => {
  it("classifies agents and matches CIDRs", () => {
    expect(classify("Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)").agent.token).toBe("GPTBot");
    expect(classify("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0)").category).toBe("assistants");
    expect(classify("python-requests/2.31").category).toBe("unknownBots");
    expect(classify("Mozilla/5.0 (Macintosh) Safari/605.1.15").category).toBe("browser");
    expect(inCidr("20.125.66.85", "20.125.66.80/28")).toBe(true);
    expect(inCidr("20.125.66.96", "20.125.66.80/28")).toBe(false);
    expect(inCidr("2001:4860:4801:10::1", "2001:4860:4801:10::/64")).toBe(true);
    expect(inCidr("2001:4860:4801:11::1", "2001:4860:4801:10::/64")).toBe(false);
  });

  it("decides allow / charge (402 + publisher link) / block, and blocks spoofed crawlers", () => {
    const p = { ...DEFAULT_POLICY.agents, training: "charge", checkoutUrl: "https://pay.example/agents" };
    const d = decide(p, classify("GPTBot/1.2"), true, false);
    expect(d).toMatchObject({ action: "charge", status: 402, checkout_url: "https://pay.example/agents" });
    expect(d.headers.link).toContain("rel=\"payment\"");
    expect(decide(p, classify("GPTBot/1.2"), false, false)).toMatchObject({ action: "block" });
    expect(decide(p, classify("GPTBot/1.2"), true, true)).toMatchObject({ action: "allow", reason: "valid agent key" });
    expect(decide(p, classify("Googlebot/2.1"), null, false)).toMatchObject({ action: "allow" });
  });

  it("API: plan-gated, metered keys count down", async () => {
    const { env, q } = await makeEnv();
    const { site, secret, cookie } = await signupWithSite(env, "ag@shop.example");
    expect((await post(env, "/api/v1/agent/check", { secret, user_agent: "GPTBot/1.2" }, { origin: null })).status).toBe(403);
    await setPlan(env, q, "ag@shop.example", "agent");
    await setPolicy(env, cookie, site.id, { agents: { training: "charge", checkoutUrl: "https://pay.example/a" } });
    const k = await (await post(env, `/api/v1/account/sites/${site.id}/agent-keys`, { label: "acme-ai", quota: 1 }, { cookie })).json();
    const first = await (await post(env, "/api/v1/agent/check", { secret, user_agent: "CCBot/2.0", agent_key: k.key }, { origin: null })).json();
    expect(first.action).toBe("allow");
    const second = await (await post(env, "/api/v1/agent/check", { secret, user_agent: "CCBot/2.0", agent_key: k.key }, { origin: null })).json();
    expect(second).toMatchObject({ action: "charge", status: 402 });
    const browser = await (await post(env, "/api/v1/agent/check", { secret, user_agent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130" }, { origin: null })).json();
    expect(browser.action).toBe("allow");
  });
});

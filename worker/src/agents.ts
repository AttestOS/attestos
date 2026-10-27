import type { Env } from "./env";
import { all, first, getSetting, logError, run, setSetting } from "./lib/db";
import { randomId, sha256Hex } from "./lib/crypto";
import { HttpError, json, readObject, str } from "./lib/http";
import { safeJson } from "./lib/util";
import { has } from "./plans";
import { getSiteBySecret, type AgentPolicy, type Site } from "./sites";
import { accountMonth, bump } from "./stats";

/** AgentPass (AgentPass Pro / Enterprise). The customer's server (or edge middleware) asks, per request:
 *  "this User-Agent from this IP wants this path: allow, charge or block?" We classify the agent, verify crawler
 *  claims against the operators' PUBLISHED IP ranges (refreshed daily), honour metered agent keys the publisher sold,
 *  and answer. "charge" = respond HTTP 402 with the publisher's own checkout link; we never touch the money. */

export type Category = "search" | "training" | "assistants" | "unknownBots";
export interface KnownAgent { token: string; owner: string; category: Category; ranges?: string }
export const AGENTS: KnownAgent[] = [
  { token: "Googlebot", owner: "Google", category: "search", ranges: "https://developers.google.com/static/search/apis/ipranges/googlebot.json" },
  { token: "bingbot", owner: "Microsoft", category: "search", ranges: "https://www.bing.com/toolbox/bingbot.json" },
  { token: "OAI-SearchBot", owner: "OpenAI", category: "search", ranges: "https://openai.com/searchbot.json" },
  { token: "PerplexityBot", owner: "Perplexity", category: "search", ranges: "https://www.perplexity.com/perplexitybot.json" },
  { token: "Applebot", owner: "Apple", category: "search", ranges: "https://search.developer.apple.com/applebot.json" },
  { token: "Amazonbot", owner: "Amazon", category: "search" },
  { token: "DuckDuckBot", owner: "DuckDuckGo", category: "search" },
  { token: "GPTBot", owner: "OpenAI", category: "training", ranges: "https://openai.com/gptbot.json" },
  { token: "ClaudeBot", owner: "Anthropic", category: "training" },
  { token: "anthropic-ai", owner: "Anthropic", category: "training" },
  { token: "CCBot", owner: "Common Crawl", category: "training" },
  { token: "Bytespider", owner: "ByteDance", category: "training" },
  { token: "Meta-ExternalAgent", owner: "Meta", category: "training" },
  { token: "cohere-ai", owner: "Cohere", category: "training" },
  { token: "Diffbot", owner: "Diffbot", category: "training" },
  { token: "ChatGPT-User", owner: "OpenAI", category: "assistants", ranges: "https://openai.com/chatgpt-user.json" },
  { token: "Perplexity-User", owner: "Perplexity", category: "assistants", ranges: "https://www.perplexity.com/perplexity-user.json" },
  { token: "Claude-User", owner: "Anthropic", category: "assistants" },
  { token: "MistralAI-User", owner: "Mistral", category: "assistants" },
];
const GENERIC_BOT = /bot\b|crawler|spider|scraper|python-requests|curl\/|wget\/|httpx|go-http-client|okhttp|axios\/|node-fetch|headless/i;

export function classify(ua: string): { agent: KnownAgent | null; category: Category | "browser" } {
  const lower = ua.toLowerCase();
  // Most specific first (e.g. "Perplexity-User" before "PerplexityBot", "OAI-SearchBot" before "GPTBot").
  const a = [...AGENTS].sort((x, y) => y.token.length - x.token.length).find((k) => lower.includes(k.token.toLowerCase()));
  if (a) return { agent: a, category: a.category };
  if (!ua.trim() || GENERIC_BOT.test(ua)) return { agent: null, category: "unknownBots" };
  return { agent: null, category: "browser" };
}

// ---------- CIDR matching ----------
function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) { const v = Number(x); if (!/^\d{1,3}$/.test(x) || v > 255) return null; n = n * 256 + v; }
  return n;
}
function ipv6ToBig(ip: string): bigint | null {
  if (!ip.includes(":")) return null;
  let [head, tail] = ip.split("::");
  if (ip.split("::").length > 2) return null;
  const h = head ? head.split(":") : [], t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) { if (!/^[0-9a-f]{1,4}$/i.test(g)) return null; n = (n << 16n) + BigInt(parseInt(g, 16)); }
  return n;
}
export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsS] = cidr.split("/");
  const bits = Number(bitsS);
  if (ip.includes(":") !== base.includes(":")) return false;
  if (!ip.includes(":")) {
    const a = ipv4ToInt(ip), b = ipv4ToInt(base);
    if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  }
  const a = ipv6ToBig(ip), b = ipv6ToBig(base);
  if (a === null || b === null || !(bits >= 0 && bits <= 128)) return false;
  const shift = BigInt(128 - bits);
  return a >> shift === b >> shift;
}

// ---------- published ranges (daily) ----------
let rangesCache: { at: number; v: Record<string, string[]> } | null = null;
async function ranges(env: Env): Promise<Record<string, string[]>> {
  if (rangesCache && Date.now() - rangesCache.at < 3600_000) return rangesCache.v;
  const v = safeJson<Record<string, string[]>>(await getSetting(env, "crawler_ranges"), {});
  rangesCache = { at: Date.now(), v };
  return v;
}
export async function refreshCrawlerRanges(env: Env) {
  const out: Record<string, string[]> = safeJson(await getSetting(env, "crawler_ranges"), {});
  for (const a of AGENTS) {
    if (!a.ranges) continue;
    try {
      const r = await fetch(a.ranges, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "AttestOS/1.0 (crawler verification)" } });
      if (!r.ok) continue;
      const j = (await r.json()) as { prefixes?: { ipv4Prefix?: string; ipv6Prefix?: string }[] };
      const list = (j.prefixes || []).map((p) => p.ipv4Prefix || p.ipv6Prefix || "").filter((c) => /^[0-9a-f:.]+\/\d{1,3}$/i.test(c));
      if (list.length) out[a.token] = list.slice(0, 5000);
    } catch (e) { await logError(env, "crawler_ranges", `${a.token}: ${e instanceof Error ? e.message : e}`); }
  }
  await setSetting(env, "crawler_ranges", JSON.stringify(out));
  rangesCache = null;
}

// ---------- decision ----------
export interface Decision {
  action: "allow" | "charge" | "block"; status: 200 | 402 | 403; category: Category | "browser"; agent: string | null; operator: string | null;
  verified: boolean | null; reason: string; price_usd?: number; checkout_url?: string; headers?: Record<string, string>;
}

export function decide(policy: AgentPolicy, c: ReturnType<typeof classify>, verified: boolean | null, keyOk: boolean): Decision {
  const base = { category: c.category, agent: c.agent?.token ?? null, operator: c.agent?.owner ?? null, verified };
  if (c.category === "browser") return { ...base, action: "allow", status: 200, reason: "not an automated agent (by User-Agent)" };
  if (keyOk) return { ...base, action: "allow", status: 200, reason: "valid agent key" };
  if (c.agent && verified === false && policy.verifyCrawlers) return { ...base, action: "block", status: 403, reason: `claims to be ${c.agent.token} but the IP is outside ${c.agent.owner}'s published ranges` };
  const act = policy[c.category];
  if (act === "allow") return { ...base, action: "allow", status: 200, reason: `policy: ${c.category} allowed` };
  if (act === "block") return { ...base, action: "block", status: 403, reason: `policy: ${c.category} blocked` };
  const link = policy.checkoutUrl;
  return {
    ...base, action: "charge", status: 402, reason: `policy: ${c.category} must pay`, price_usd: policy.priceUsd, checkout_url: link || undefined,
    headers: { ...(link ? { link: `<${link}>; rel="payment"` } : {}), "x-agentpass-price-usd": String(policy.priceUsd) },
  };
}

export async function agentCheck(req: Request, env: Env): Promise<Response> {
  const b = await readObject(req, 8192);
  const site = await getSiteBySecret(env, str(b.secret, 200));
  if (!site) throw new HttpError(401, "invalid secret");
  if (!has(site.ent, "agentpass")) throw new HttpError(403, "AgentPass is part of the AgentPass Pro and Enterprise plans");
  const usage = await accountMonth(env, site.account_id);
  if (usage.agent >= Math.ceil(site.ent.agentChecks * 1.1)) return json({ action: "allow", status: 200, reason: "monthly AgentPass quota exceeded: failing open", quota_exceeded: true });
  const ua = str(b.user_agent, 500);
  const ip = str(b.ip, 64);
  const c = classify(ua);
  let verified: boolean | null = null;
  if (c.agent?.ranges) {
    const list = (await ranges(env))[c.agent.token];
    if (list?.length && ip) verified = list.some((cidr) => inCidr(ip, cidr));
  }
  let keyOk = false;
  const key = str(b.agent_key, 100);
  if (key && /^ak_[A-Za-z0-9]{24,40}$/.test(key)) {
    const r = await run(env, "UPDATE agent_keys SET used = used + 1 WHERE key_hash = ? AND site_id = ? AND status = 'active' AND (quota = 0 OR used < quota)", await sha256Hex(key), site.id);
    keyOk = Number(r.meta?.changes ?? 0) > 0;
  }
  const d = decide(site.policy.agents, c, verified, keyOk);
  if (d.category !== "browser") await bump(env, site, d.action === "allow" ? "agent_allow" : d.action === "charge" ? "agent_charge" : "agent_block");
  return json(d, 200, { "cache-control": "no-store" });
}

// ---------- publisher key management (portal) ----------
export async function listKeys(env: Env, site: Site) {
  return all(env, "SELECT key_hash AS id, label, hint, quota, used, status, created_at FROM agent_keys WHERE site_id = ? ORDER BY created_at DESC LIMIT 500", site.id);
}
export async function mintKey(env: Env, site: Site, label: string, quota: number) {
  if (!has(site.ent, "agentpass")) throw new HttpError(403, "AgentPass is part of the AgentPass Pro and Enterprise plans");
  const n = (await first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM agent_keys WHERE site_id = ?", site.id))?.n ?? 0;
  if (n >= 500) throw new HttpError(400, "500 keys per site at most: revoke old ones first");
  const key = `ak_${randomId(32)}`;
  await run(env, "INSERT INTO agent_keys (key_hash, site_id, label, hint, quota) VALUES (?, ?, ?, ?, ?)", await sha256Hex(key), site.id, label.slice(0, 80) || "agent", `…${key.slice(-4)}`, Math.max(0, Math.floor(quota)) || 0);
  return key;
}
export async function revokeKey(env: Env, site: Site, id: string) {
  const r = await run(env, "UPDATE agent_keys SET status = 'revoked' WHERE key_hash = ? AND site_id = ?", id, site.id);
  if (!Number(r.meta?.changes ?? 0)) throw new HttpError(404, "Key not found");
}

import type { Env } from "./env";
import { all, first, run } from "./lib/db";
import { randomId, sha256Hex } from "./lib/crypto";
import { HttpError } from "./lib/http";
import { clamp, normHost, safeJson } from "./lib/util";
import { entitlements, parsePlans, type Entitlements } from "./plans";

/** Per-site settings the customer controls (portal → "Policy"). Everything is validated server-side. */
export interface SitePolicy {
  difficulty: number;          // PoW difficulty in bits (12–24). 16 ≈ 65k hashes on average.
  adaptive: boolean;           // raise difficulty during request surges (IntegrityRuntime Pro)
  surgePerMinute: number;      // challenges/minute (per edge location) that count as a surge
  allowLocalhost: boolean;     // accept challenges from http://localhost while developing
  signals: "off" | "report" | "enforce"; // automation signals (Pro): report = included in siteverify; enforce = refuse risky solves
  riskThreshold: number;       // 0–1, used by "enforce"
  alertWebhook: string;        // Slack/Discord-compatible incoming webhook (Pro), "" = off
  pat: boolean;                // try Private Access Tokens before PoW (Hardware Gateway Pro)
  rpId: string;                // passkey relying-party ID (defaults to the first domain)
  agents: AgentPolicy;
}
export interface AgentPolicy {
  search: "allow" | "charge" | "block";     // search/answer crawlers (Googlebot, Bingbot, PerplexityBot, …)
  training: "allow" | "charge" | "block";   // model-training crawlers (GPTBot, CCBot, ClaudeBot, Google-Extended, …)
  assistants: "allow" | "charge" | "block"; // user-triggered agents (ChatGPT-User, Claude-User, Perplexity-User, …)
  unknownBots: "allow" | "charge" | "block";
  priceUsd: number;                          // quoted per request in the 402 response
  checkoutUrl: string;                       // YOUR payment link agents are sent to (we never touch the money)
  verifyCrawlers: boolean;                   // only trust a crawler UA when the IP is in its published ranges
}

export const DEFAULT_POLICY: SitePolicy = {
  difficulty: 16, adaptive: true, surgePerMinute: 120, allowLocalhost: true, signals: "report", riskThreshold: 0.7,
  alertWebhook: "", pat: true, rpId: "",
  agents: { search: "allow", training: "block", assistants: "allow", unknownBots: "allow", priceUsd: 0.002, checkoutUrl: "", verifyCrawlers: true },
};

const ACT = ["allow", "charge", "block"] as const;
const act = (v: unknown, d: AgentPolicy["search"]) => (ACT.includes(v as any) ? (v as AgentPolicy["search"]) : d);

export function normPolicy(input: unknown, base: SitePolicy = DEFAULT_POLICY): SitePolicy {
  const p = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const a = (p.agents && typeof p.agents === "object" ? p.agents : {}) as Record<string, any>;
  const url = (v: unknown, d: string) => {
    if (v === undefined) return d;
    const s = String(v || "").trim();
    if (!s) return "";
    try { const u = new URL(s); if (u.protocol !== "https:") throw 0; return u.toString().slice(0, 500); } catch { throw new HttpError(400, "Links must be full https:// URLs"); }
  };
  const num = (v: unknown, d: number, lo: number, hi: number) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : clamp(Number(v), lo, hi));
  const bool = (v: unknown, d: boolean) => (v === undefined ? d : v === true || v === "true" || v === 1 || v === "1");
  const rp = p.rpId === undefined ? base.rpId : String(p.rpId || "").trim() ? normHost(String(p.rpId)) : "";
  if (rp === null || (rp && rp.startsWith("*."))) throw new HttpError(400, "Passkey RP ID must be a plain hostname such as example.com");
  return {
    difficulty: Math.round(num(p.difficulty, base.difficulty, 12, 24)),
    adaptive: bool(p.adaptive, base.adaptive),
    surgePerMinute: Math.round(num(p.surgePerMinute, base.surgePerMinute, 10, 100_000)),
    allowLocalhost: bool(p.allowLocalhost, base.allowLocalhost),
    signals: ["off", "report", "enforce"].includes(p.signals) ? p.signals : base.signals,
    riskThreshold: num(p.riskThreshold, base.riskThreshold, 0.1, 1),
    alertWebhook: url(p.alertWebhook, base.alertWebhook),
    pat: bool(p.pat, base.pat),
    rpId: rp as string,
    agents: {
      search: act(a.search, base.agents.search),
      training: act(a.training, base.agents.training),
      assistants: act(a.assistants, base.agents.assistants),
      unknownBots: act(a.unknownBots, base.agents.unknownBots),
      priceUsd: num(a.priceUsd, base.agents.priceUsd, 0.0001, 100),
      checkoutUrl: url(a.checkoutUrl, base.agents.checkoutUrl),
      verifyCrawlers: bool(a.verifyCrawlers, base.agents.verifyCrawlers),
    },
  };
}

export interface Site {
  id: string; account_id: string; name: string; domains: string[]; policy: SitePolicy; status: string;
  secret_hint: string; created_at: string; ent: Entitlements;
}
type SiteRow = { id: string; account_id: string; name: string; domains: string; policy: string; status: string; secret_hint: string; created_at: string; plan: string; acct_status: string };

function hydrate(r: SiteRow): Site {
  return {
    id: r.id, account_id: r.account_id, name: r.name, domains: safeJson<string[]>(r.domains, []),
    policy: normPolicy(safeJson(r.policy, {})), status: r.acct_status === "active" ? r.status : "disabled",
    secret_hint: r.secret_hint, created_at: r.created_at, ent: entitlements(parsePlans(r.plan)),
  };
}
const SELECT = `SELECT s.id, s.account_id, s.name, s.domains, s.policy, s.status, s.secret_hint, s.created_at, a.plan, a.status AS acct_status
  FROM sites s JOIN accounts a ON a.id = s.account_id`;

// Per-isolate cache: the hot path (challenge/redeem/siteverify) costs zero D1 reads after the first hit.
const byId = new Map<string, { at: number; site: Site | null }>();
const bySecret = new Map<string, { at: number; site: Site | null }>();
const TTL = 60_000;
export function invalidateSites() { byId.clear(); bySecret.clear(); }

export async function getSite(env: Env, id: string): Promise<Site | null> {
  if (!/^ao_site_[a-z0-9]{12,24}$/.test(id)) return null;
  const c = byId.get(id);
  if (c && Date.now() - c.at < TTL) return c.site;
  const r = await first<SiteRow>(env, `${SELECT} WHERE s.id = ?`, id);
  const site = r ? hydrate(r) : null;
  if (byId.size > 5000) byId.clear();
  byId.set(id, { at: Date.now(), site });
  return site;
}
export async function getSiteBySecret(env: Env, secret: string): Promise<Site | null> {
  if (!/^ao_sec_[A-Za-z0-9]{32,64}$/.test(secret)) return null;
  const h = await sha256Hex(secret);
  const c = bySecret.get(h);
  if (c && Date.now() - c.at < TTL) return c.site;
  const r = await first<SiteRow>(env, `${SELECT} WHERE s.secret_hash = ?`, h);
  const site = r ? hydrate(r) : null;
  if (bySecret.size > 5000) bySecret.clear();
  bySecret.set(h, { at: Date.now(), site });
  return site;
}
export async function listSites(env: Env, accountId: string): Promise<Site[]> {
  return (await all<SiteRow>(env, `${SELECT} WHERE s.account_id = ? ORDER BY s.created_at`, accountId)).map(hydrate);
}

function newSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(30));
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return `ao_sec_${[...b].map((x) => A[x % A.length]).join("")}${randomId(10)}`;
}

export function cleanDomains(list: unknown, max: number): string[] {
  const raw = Array.isArray(list) ? list : String(list ?? "").split(/[\s,]+/);
  const out: string[] = [];
  for (const d of raw) {
    if (!String(d).trim()) continue;
    const h = normHost(String(d));
    if (!h) throw new HttpError(400, `Not a valid hostname: ${String(d).slice(0, 80)}`);
    if (!out.includes(h)) out.push(h);
  }
  if (!out.length) throw new HttpError(400, "Add at least one domain (e.g. example.com)");
  if (out.length > max) throw new HttpError(400, `Your plan allows ${max} domains per site`);
  return out;
}

export async function createSite(env: Env, accountId: string, ent: Entitlements, name: string, domains: unknown): Promise<{ site: Site; secret: string }> {
  const n = await first<{ c: number }>(env, "SELECT COUNT(*) AS c FROM sites WHERE account_id = ?", accountId);
  if ((n?.c ?? 0) >= ent.sites) throw new HttpError(403, `Your plan allows ${ent.sites} site${ent.sites === 1 ? "" : "s"}. Upgrade for more.`);
  const doms = cleanDomains(domains, ent.domainsPerSite);
  const id = `ao_site_${randomId(16)}`;
  const secret = newSecret();
  const policy = { ...DEFAULT_POLICY, rpId: doms.find((d) => !d.startsWith("*.") && d !== "localhost") ?? "" };
  await run(env, "INSERT INTO sites (id, account_id, name, domains, secret_hash, secret_hint, policy) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id, accountId, (name || doms[0]).slice(0, 80), JSON.stringify(doms), await sha256Hex(secret), `…${secret.slice(-4)}`, JSON.stringify(policy));
  invalidateSites();
  const site = (await getSite(env, id))!;
  return { site, secret };
}

export async function rotateSecret(env: Env, accountId: string, siteId: string): Promise<string> {
  const secret = newSecret();
  const r = await run(env, "UPDATE sites SET secret_hash = ?, secret_hint = ? WHERE id = ? AND account_id = ?", await sha256Hex(secret), `…${secret.slice(-4)}`, siteId, accountId);
  if (!Number(r.meta?.changes ?? 0)) throw new HttpError(404, "Site not found");
  invalidateSites();
  return secret;
}

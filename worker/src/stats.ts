import type { Env } from "./env";
import { first, logError, run } from "./lib/db";
import { budgetState } from "./lib/quota";
import { thisMonth, today } from "./lib/util";

export type Metric = "ok" | "fail" | "pat" | "passkey" | "agent_allow" | "agent_charge" | "agent_block" | "risky";
const METRICS: Metric[] = ["ok", "fail", "pat", "passkey", "agent_allow", "agent_charge", "agent_block", "risky"];

/** One UPSERT (one billed row write) per event; skipped when the D1 budget is spent. */
export async function bump(env: Env, site: { id: string; account_id: string }, metric: Metric, by = 1) {
  const siteId = site.id;
  if (!METRICS.includes(metric)) return;
  try {
    if ((await budgetState(env)).over) return;
    await run(env, `INSERT INTO stats (site_id, day, ${metric}) VALUES (?, ?, ?)
      ON CONFLICT(site_id, day) DO UPDATE SET ${metric} = ${metric} + excluded.${metric}`, siteId, today(), by);
    const c = monthCache.get(`a:${site.account_id}`);
    if (c && (metric === "ok" || metric === "fail")) c.verifs += by;
    if (c && metric.startsWith("agent_")) c.agent += by;
  } catch (e) { await logError(env, "stats", e); }
}

const monthCache = new Map<string, { at: number; month: string; verifs: number; agent: number }>();

/** This month's usage for every site of an account (siteverify calls and AgentPass checks), cached 60 s. */
export async function accountMonth(env: Env, accountId: string): Promise<{ verifs: number; agent: number }> {
  const key = `a:${accountId}`;
  const m = thisMonth();
  const c = monthCache.get(key);
  if (c && c.month === m && Date.now() - c.at < 60_000) return c;
  const r = await first<{ v: number; a: number }>(env,
    `SELECT COALESCE(SUM(ok + fail), 0) AS v, COALESCE(SUM(agent_allow + agent_charge + agent_block), 0) AS a
       FROM stats WHERE day >= ? AND site_id IN (SELECT id FROM sites WHERE account_id = ?)`, `${m}-01`, accountId);
  const v = { at: Date.now(), month: m, verifs: r?.v ?? 0, agent: r?.a ?? 0 };
  if (monthCache.size > 5000) monthCache.clear();
  monthCache.set(key, v);
  return v;
}

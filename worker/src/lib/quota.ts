import type { Env } from "../env";
import { first, meter } from "./db";
import { today } from "./util";

/** AttestOS's own D1 governor. The account's free D1 quota (100k writes / 5M reads per day) is shared with other
 *  Workers on the account, so AttestOS budgets itself at 20% by default (D1_WRITE_BUDGET / D1_READ_BUDGET).
 *  The per-isolate meter (lib/db.ts) is flushed into quota_daily; `budgetState` is cached for 30 s.
 *  When over budget: optional work (stats, scanner storage, outreach) pauses, and siteverify switches to
 *  stateless mode (signature + expiry still checked; single-use is not) and says so in its response. */
let cache: { at: number; day: string; reads: number; writes: number } | null = null;

export async function flushMeter(env: Env, requests = 0) {
  const r = meter.reads, w = meter.writes;
  if (!r && !w && !requests) return;
  meter.reads = 0; meter.writes = 0;
  try {
    await env.DB.prepare(`INSERT INTO quota_daily (day, reads, writes, requests) VALUES (?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET reads = reads + excluded.reads, writes = writes + excluded.writes, requests = requests + excluded.requests`)
      .bind(today(), r, w + 1, requests).run();
    if (cache && cache.day === today()) { cache.reads += r; cache.writes += w + 1; }
  } catch { meter.reads += r; meter.writes += w; }
}

export function budgets(env: Env) {
  return { writes: Number(env.D1_WRITE_BUDGET || 20_000), reads: Number(env.D1_READ_BUDGET || 1_000_000) };
}

export async function budgetState(env: Env): Promise<{ reads: number; writes: number; over: boolean; tight: boolean }> {
  const day = today();
  if (!cache || cache.day !== day || Date.now() - cache.at > 30_000) {
    const row = await first<{ reads: number; writes: number }>(env, "SELECT reads, writes FROM quota_daily WHERE day = ?", day);
    cache = { at: Date.now(), day, reads: row?.reads ?? 0, writes: row?.writes ?? 0 };
  }
  const b = budgets(env);
  const reads = cache.reads + meter.reads, writes = cache.writes + meter.writes;
  return { reads, writes, over: writes >= b.writes || reads >= b.reads, tight: writes >= b.writes * 0.8 || reads >= b.reads * 0.8 };
}
export const _resetQuotaCache = () => { cache = null; };

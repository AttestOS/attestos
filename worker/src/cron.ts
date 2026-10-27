import { IMG_KEEP_DAYS } from "./press/hooks";
import type { Env } from "./env";
import { getSetting, logError, run } from "./lib/db";
import { budgetState } from "./lib/quota";
import { processOutbox } from "./mail/outbox";
import { outreachTick, pollReplies } from "./outreach";
import { refreshCrawlerRanges } from "./agents";
import { refreshIssuerKeys } from "./pat";

/** Two cron triggers (the free plan allows 5 per account; TightBucket uses 2):
 *   every 10 minutes  → queue outreach within lane caps, send the outbox, and every 3rd run poll replies (IMAP)
 *   daily 03:17 UTC   → retention purges, verified-crawler IP ranges (AgentPass), Privacy Pass issuer keys */
export async function runCron(cron: string, env: Env) {
  try {
    if (cron === "17 3 * * *") return await daily(env);
    const slot = Math.floor(Date.now() / 600_000);
    if (!(await budgetState(env)).over) await outreachTick(env);
    await processOutbox(env, { max: 12, deadlineMs: 20_000 });
    if (slot % 3 === 0) await pollReplies(env);
    // Bootstrap after a fresh deploy: the daily job normally refreshes these (one settings read each, no writes).
    if (!(await getSetting(env, "crawler_ranges"))) await refreshCrawlerRanges(env);
    if (!(await getSetting(env, "pat_keys"))) await refreshIssuerKeys(env);
  } catch (e) { await logError(env, `cron:${cron}`, e); }
}

async function daily(env: Env) {
  const cutoff = Math.floor(Date.now() / 1000) - 90 * 86400;
  // Weekly (Sunday), bounded: `redeemed` has no index on `at` (that would double the write cost of every
  // verification), so the purge is a scan; once a week keeps the read cost small. D1 bills each deleted row as a write.
  if (new Date().getUTCDay() === 0) {
    await run(env, "DELETE FROM redeemed WHERE (site_id, salt) IN (SELECT site_id, salt FROM redeemed WHERE at < ? LIMIT 20000)", cutoff);
  }
  await run(env, "DELETE FROM scans WHERE created_at < datetime('now','-90 days')");
  await run(env, "DELETE FROM usage WHERE period < ? AND length(period) = 10", new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10));
  await run(env, "DELETE FROM errors WHERE at < datetime('now','-30 days')");
  await run(env, "DELETE FROM outbox WHERE status IN ('sent','failed') AND created_at < datetime('now','-180 days')");
  await run(env, "DELETE FROM events WHERE received_at < datetime('now','-180 days')");
  await run(env, "DELETE FROM quota_daily WHERE day < date('now','-60 days')");
  await run(env, `DELETE FROM press_img WHERE created_at < datetime('now','-${IMG_KEEP_DAYS} days')`);
  await refreshCrawlerRanges(env);
  await refreshIssuerKeys(env);
}

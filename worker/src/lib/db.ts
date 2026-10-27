import type { Env } from "../env";

/** Every D1 call goes through these helpers, so the quota governor (lib/quota.ts) sees the REAL cost of each
 *  query: D1 returns `meta.rows_read` / `meta.rows_written` (index writes included) and that's what Cloudflare bills.
 *  Counts accumulate per isolate and are flushed to `quota_daily` (one row per day) in batches. */
export const meter = {
  reads: 0,
  writes: 0,
  neurons: 0,
  /** Optional per-statement breakdown (enabled in dev/tests via meter.trace = true) to find hotspots. */
  trace: false,
  byStmt: new Map<string, { n: number; r: number; w: number }>(),
};

type Meta = { rows_read?: number; rows_written?: number } | undefined;
function track(sql: string, meta: Meta) {
  const r = Number(meta?.rows_read ?? 0) || 0;
  const w = Number(meta?.rows_written ?? 0) || 0;
  meter.reads += r;
  meter.writes += w;
  if (meter.trace) {
    const k = sql.replace(/\s+/g, " ").trim().slice(0, 90);
    const e = meter.byStmt.get(k) ?? { n: 0, r: 0, w: 0 };
    e.n++; e.r += r; e.w += w;
    meter.byStmt.set(k, e);
  }
}

export async function first<T = any>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  // .all() (not .first()) because only .all()/.run() return `meta`, which the governor needs.
  const r = await env.DB.prepare(sql).bind(...binds).all<T>();
  track(sql, r.meta as Meta);
  return (r.results?.[0] as T | undefined) ?? null;
}
export async function all<T = any>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  const r = await env.DB.prepare(sql).bind(...binds).all<T>();
  track(sql, r.meta as Meta);
  return r.results ?? [];
}
export async function run(env: Env, sql: string, ...binds: unknown[]) {
  const r = await env.DB.prepare(sql).bind(...binds).run();
  track(sql, r.meta as Meta);
  return r;
}
/** One round-trip, one implicit transaction. Statements: [sql, ...binds]. */
export async function batch(env: Env, stmts: [string, ...unknown[]][]) {
  if (!stmts.length) return [];
  const res = await env.DB.batch(stmts.map(([sql, ...b]) => env.DB.prepare(sql).bind(...b)));
  res.forEach((r, i) => track(stmts[i][0], r.meta as Meta));
  return res;
}
/** Rows changed by a write (D1 `meta.changes`). */
export const changes = (r: { meta?: { changes?: number } } | null | undefined) => Number(r?.meta?.changes ?? 0) || 0;

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const r = await first<{ value: string }>(env, "SELECT value FROM settings WHERE key = ?", key);
  return r?.value ?? null;
}
export async function setSetting(env: Env, key: string, value: string) {
  // No-op when unchanged: an UPDATE that rewrites the same value still costs a billed row write.
  await run(env, `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now') WHERE settings.value IS NOT excluded.value`, key, value);
}

const recentErrors = new Map<string, number>();
/** Error log with de-duplication: the same scope+message is stored at most once an hour, so a failure that repeats
 *  every cron run (e.g. "Gmail not connected") can't quietly burn the write quota. */
export async function logError(env: Env, scope: string, err: unknown) {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  console.error(`[${scope}]`, message);
  const key = `${scope}|${message}`;
  const now = Date.now();
  if ((recentErrors.get(key) ?? 0) > now - 3600_000) return;
  recentErrors.set(key, now);
  if (recentErrors.size > 200) recentErrors.clear();
  try {
    await run(env, `INSERT INTO errors (scope, message) SELECT ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM errors WHERE at > datetime('now','-1 hour') AND scope = ? AND message = ?)`, scope, message, scope, message);
  } catch { /* ignore */ }
}

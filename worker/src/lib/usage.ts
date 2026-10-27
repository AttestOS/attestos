import type { Env } from "../env";
import { first } from "./db";
import { thisMonth, today } from "./util";

/** Counters in D1 (one row per key+period): lockouts, signup throttles, alert throttles. */
export async function bumpUsage(env: Env, key: string, period: "day" | "month", by = 1): Promise<number> {
  const p = period === "day" ? today() : thisMonth();
  const r = await first<{ n: number }>(env,
    "INSERT INTO usage (key, period, n) VALUES (?, ?, ?) ON CONFLICT(key, period) DO UPDATE SET n = n + excluded.n RETURNING n", key, p, by);
  return r?.n ?? by;
}
export async function getUsage(env: Env, key: string, period: "day" | "month"): Promise<number> {
  const p = period === "day" ? today() : thisMonth();
  const r = await first<{ n: number }>(env, "SELECT n FROM usage WHERE key = ? AND period = ?", key, p);
  return r?.n ?? 0;
}

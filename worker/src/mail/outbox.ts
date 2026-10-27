import type { Env } from "../env";
import { all, first, logError, run } from "../lib/db";
import { signToken } from "../lib/crypto";
import { notifyOwner } from "../lib/notify";
import { buildMime } from "./mime";
import { SmtpError, SmtpSession } from "./smtp";
import { COLD_KINDS, laneCounts, laneState, laneUsable, lanes, saveLaneState, type Lane, type LaneState } from "./lanes";

export type Kind = "first" | "follow" | "verify" | "reset" | "notice";

export async function isSuppressed(env: Env, email: string) {
  return !!(await first(env, "SELECT 1 AS x FROM suppress WHERE email = ?", email.toLowerCase()));
}
export async function suppress(env: Env, email: string, reason: string) {
  await run(env, "INSERT OR IGNORE INTO suppress (email, reason) VALUES (?, ?)", email.toLowerCase(), reason.slice(0, 60));
  await run(env, "UPDATE outbox SET status = 'failed', error = 'suppressed' WHERE to_email = ? AND status = 'queued' AND kind IN ('first','follow')", email.toLowerCase());
}

export async function unsubscribeUrl(env: Env, email: string) {
  return `${env.SITE_URL}/u/${await signToken(`${env.APP_SECRET}|unsub`, { e: email.toLowerCase() }, 3 * 365 * 86400)}`;
}

/** Queue a message. Cold kinds are dropped for suppressed addresses. Returns the outbox id (null = not queued). */
export async function enqueue(env: Env, m: { to: string; subject: string; body: string; kind: Kind; ref?: string | null }): Promise<number | null> {
  const to = m.to.trim().toLowerCase();
  if (COLD_KINDS.includes(m.kind) && (await isSuppressed(env, to))) return null;
  const r = await first<{ id: number }>(env, "INSERT INTO outbox (to_email, subject, body, kind, ref) VALUES (?, ?, ?, ?, ?) RETURNING id",
    to, m.subject.slice(0, 200), m.body.slice(0, 20_000), m.kind, m.ref ?? null);
  return r?.id ?? null;
}

export const mailArmed = (env: Env) => lanes(env).length > 0;

type Row = { id: number; to_email: string; subject: string; body: string; kind: Kind; ref: string | null; attempts: number };

/** Send queued mail within each lane's caps. `onlyId` = send just that row now (verification emails).
 *  Rows are claimed with a conditional UPDATE, so a cron run and an immediate send can never double-send. */
export async function processOutbox(env: Env, o: { onlyId?: number; max?: number; deadlineMs?: number } = {}) {
  const ls = lanes(env);
  if (!ls.length) return { sent: 0, failed: 0, reason: "no mail lane armed" };
  const deadline = Date.now() + (o.deadlineMs ?? 20_000);
  // Rows stuck in 'sending' (a crashed invocation) go back to the queue after 15 minutes.
  if (!o.onlyId) await run(env, "UPDATE outbox SET status = 'queued' WHERE status = 'sending' AND created_at < datetime('now','-15 minutes') AND attempts < 5");
  const rows = o.onlyId
    ? await all<Row>(env, "SELECT id, to_email, subject, body, kind, ref, attempts FROM outbox WHERE id = ? AND status = 'queued'", o.onlyId)
    : await all<Row>(env, `SELECT id, to_email, subject, body, kind, ref, attempts FROM outbox WHERE status = 'queued'
        ORDER BY CASE WHEN kind IN ('verify','reset','notice') THEN 0 ELSE 1 END, id LIMIT ?`, o.max ?? 12);
  if (!rows.length) return { sent: 0, failed: 0 };

  const ctx = new Map<string, { lane: Lane; st: LaneState; c: { cold: number; tx: number; hour: number }; s?: SmtpSession; dead?: boolean }>();
  for (const l of ls) { const st = await laneState(env, l.id); if (laneUsable(st)) ctx.set(l.id, { lane: l, st, c: await laneCounts(env, l.id) }); }
  let sent = 0, failed = 0;
  try {
    for (const row of rows) {
      if (Date.now() > deadline) break;
      const cold = COLD_KINDS.includes(row.kind);
      const lc = [...ctx.values()].find((x) => !x.dead && x.c.hour < x.lane.hourly && (cold ? x.c.cold < x.lane.cold : x.c.tx < x.lane.transactional));
      if (!lc) continue;
      const claim = await run(env, "UPDATE outbox SET status = 'sending', attempts = attempts + 1, lane = ? WHERE id = ? AND status = 'queued'", lc.lane.id, row.id);
      if (!Number(claim.meta?.changes ?? 0)) continue;
      if (cold && (await isSuppressed(env, row.to_email))) { await run(env, "UPDATE outbox SET status = 'failed', error = 'suppressed' WHERE id = ?", row.id); continue; }
      const messageId = `<${crypto.randomUUID()}@${lc.lane.user.split("@")[1] || "attestos.local"}>`;
      const unsub = cold ? await unsubscribeUrl(env, row.to_email) : undefined;
      const mime = buildMime({ from: lc.lane.user, fromName: lc.lane.fromName, to: row.to_email, subject: row.subject, text: row.body, messageId, listUnsubscribe: unsub, listUnsubscribeMailto: cold ? lc.lane.user : undefined });
      try {
        lc.s ??= await SmtpSession.open({ host: lc.lane.host, port: lc.lane.smtpPort, user: lc.lane.user, pass: lc.lane.pass });
        await lc.s.send(lc.lane.user, row.to_email, mime);
        await run(env, "UPDATE outbox SET status = 'sent', sent_at = datetime('now'), message_id = ?, error = NULL WHERE id = ?", messageId, row.id);
        lc.c.hour++; if (cold) lc.c.cold++; else lc.c.tx++;
        sent++;
      } catch (e) {
        const err = e instanceof SmtpError ? e : new SmtpError("connection", 0, e instanceof Error ? e.message : String(e));
        const permanent = err.permanent;
        const giveUp = permanent || row.attempts + 1 >= 5;
        // A refused attempt still counts against the provider's limits: stamp it so the lane caps include it.
        await run(env, `UPDATE outbox SET status = ?, error = ?${permanent ? ", sent_at = datetime('now')" : ""} WHERE id = ?`, giveUp ? "failed" : "queued", err.message.slice(0, 300), row.id);
        if (giveUp) failed++;
        if (err.failure === "recipient") await suppress(env, row.to_email, "bounced");
        if (err.failure === "auth" || err.failure === "policy") {
          lc.dead = true;
          const until = new Date(Date.now() + (err.failure === "auth" ? 365 * 86400_000 : 6 * 3600_000)).toISOString();
          const st: LaneState = err.failure === "auth" ? { ...lc.st, status: "paused", reason: err.message.slice(0, 200), since: new Date().toISOString() } : { ...lc.st, cooldownUntil: until };
          await saveLaneState(env, lc.lane.id, st);
          await notifyOwner(env, { title: `AttestOS mail lane ${lc.lane.id} ${err.failure === "auth" ? "paused" : "cooling down"}`, message: err.message, priority: 4 });
        }
        if (err.failure === "connection" || err.failure === "temporary") { try { await lc.s?.quit(); } catch { /* ignore */ } lc.s = undefined; lc.dead = true; }
      }
    }
  } catch (e) { await logError(env, "outbox", e); }
  finally { for (const x of ctx.values()) if (x.s) await x.s.quit(); }
  return { sent, failed };
}

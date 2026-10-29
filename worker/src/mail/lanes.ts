import type { Env } from "../env";
import { first, getSetting, setSetting } from "../lib/db";
import { safeJson } from "../lib/util";

/** Sending lanes = SMTP/IMAP mailboxes. A lane is ARMED only when its JSON entry AND both secrets exist:
 *
 *   MAILBOXES = '[{"id":"gm1","provider":"gmail","fromName":"AttestOS","cold":20,"transactional":40,"hourly":12}]'
 *   secrets:   MAILBOX_GM1_USER (the Gmail address), MAILBOX_GM1_PASS (a 16-character Google app password)
 *
 *  Gmail route (docs/GMAIL.md): personal Gmail over SMTP 465 / IMAP 993 with an app password. No Google Cloud
 *  project, no OAuth, no billing: 2-Step Verification on, then myaccount.google.com/apppasswords.
 *  Google allows ~500 recipients per rolling 24 h, so a gmail lane's `hourly` is clamped to 18 (18 x 24 = 432):
 *  no rolling day can pass the limit, whatever the daily numbers say.
 *
 *  `cold` = first touches + follow-ups per UTC day (0 = this lane never sends cold mail),
 *  `transactional` = verification/reset/notice emails per day, `hourly` = ceiling for everything. */
export interface Lane {
  id: string; provider: string; host: string; imapHost: string; smtpPort: number; imapPort: number; user: string; pass: string; fromName: string;
  cold: number; transactional: number; hourly: number; spamFolder: string;
}

/** Provider presets. A lane names a provider (default gmail) instead of hosts; explicit fields still win. */
export const PROVIDERS: Record<string, { host: string; imapHost: string; spamFolder: string; hourlyMax: number }> = {
  gmail: { host: "smtp.gmail.com", imapHost: "imap.gmail.com", spamFolder: "[Gmail]/Spam", hourlyMax: 18 },
};
export interface LaneState { status: "ok" | "paused"; reason?: string; since?: string; cooldownUntil?: string; imap?: Record<string, { v: number; u: number }> }

const ID = /^[a-z][a-z0-9]{1,15}$/;
export function lanes(env: Env): Lane[] {
  const raw = safeJson<unknown>(env.MAILBOXES, []);
  if (!Array.isArray(raw)) return [];
  const out: Lane[] = [];
  const num = (v: unknown, d: number, max: number) => { const n = Number(v); return v !== undefined && Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : d; };
  for (const m of raw as any[]) {
    const id = String(m?.id || "").toLowerCase();
    if (!ID.test(id) || out.some((o) => o.id === id)) continue;
    const user = String(env[`MAILBOX_${id.toUpperCase()}_USER`] || "").trim().toLowerCase();
    // Google shows app passwords as four groups of four; the spaces are display only.
    const pass = String(env[`MAILBOX_${id.toUpperCase()}_PASS`] || "").replace(/\s+/g, "");
    const provider = String(m.provider || (m.host ? "custom" : "gmail")).toLowerCase();
    const preset = PROVIDERS[provider];
    const host = String(m.host || preset?.host || "");
    if (!user || !pass || !host) continue;
    const hourly = Math.min(num(m.hourly, 4, 60), preset?.hourlyMax ?? 60);
    out.push({
      id, provider, host, imapHost: String(m.imapHost || preset?.imapHost || host), smtpPort: num(m.smtpPort, 465, 65535), imapPort: num(m.imapPort, 993, 65535), user, pass,
      fromName: String(m.fromName || env.BRAND || "AttestOS").slice(0, 60),
      cold: num(m.cold, 0, 200), transactional: num(m.transactional, 10, 200), hourly,
      spamFolder: String(m.spamFolder || preset?.spamFolder || "INBOX/spam"),
    });
  }
  return out;
}

export async function laneState(env: Env, id: string): Promise<LaneState> {
  return { status: "ok", ...safeJson<Partial<LaneState>>(await getSetting(env, `lane:${id}`), {}) } as LaneState;
}
export const saveLaneState = (env: Env, id: string, s: LaneState) => setSetting(env, `lane:${id}`, JSON.stringify(s));
export const laneUsable = (s: LaneState, now = Date.now()) => s.status === "ok" && !(s.cooldownUntil && Date.parse(s.cooldownUntil) > now);

export const COLD_KINDS = ["first", "follow"];

/** Delivery attempts for a lane (sent, or refused by the server): today (cold / transactional) and the last rolling hour (everything). */
export async function laneCounts(env: Env, id: string) {
  const r = await first<{ cold: number; tx: number; hour: number }>(env,
    `SELECT COALESCE(SUM(CASE WHEN kind IN ('first','follow') AND sent_at >= date('now') THEN 1 ELSE 0 END), 0) AS cold,
            COALESCE(SUM(CASE WHEN kind NOT IN ('first','follow') AND sent_at >= date('now') THEN 1 ELSE 0 END), 0) AS tx,
            COALESCE(SUM(CASE WHEN sent_at >= datetime('now','-1 hour') THEN 1 ELSE 0 END), 0) AS hour
       FROM outbox WHERE lane = ? AND status IN ('sent','failed') AND sent_at >= datetime('now','-1 day')`, id);
  return { cold: r?.cold ?? 0, tx: r?.tx ?? 0, hour: r?.hour ?? 0 };
}

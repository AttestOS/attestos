import type { Env } from "./env";
import { all, first, getSetting, logError, run } from "./lib/db";
import { timingSafeEqual, verifyToken } from "./lib/crypto";
import { HttpError, html, json, readBodyText, readObject, str } from "./lib/http";
import { isEmail, normHost } from "./lib/util";
import { notifyOwner } from "./lib/notify";
import { budgetState } from "./lib/quota";
import { enqueue, suppress } from "./mail/outbox";
import { laneCounts, laneState, laneUsable, lanes, saveLaneState } from "./mail/lanes";
import { ImapSession } from "./mail/imap";
import { classifyInbound, decodeBody, failedRecipient } from "./mail/inbound";
import { VENDORS } from "./scanner";

/** Honest outreach. A GitHub Action (scripts/prospects.mjs) really scans public sites and posts the ones that show
 *  a visible CAPTCHA AND publish a business contact address on their own site. Owner 2026-11-04 (outreach v2):
 *    T1    plain text, NO links: what we saw and where, ending "reply and I'll send the links".
 *    link  a non-"no" reply gets the links straight away, in the same thread, same box; the owner is told.
 *    T2    day 7 with no reply: the links (scan, docs, free plan), threaded.
 *    T3    day 14 with no reply: one last short nudge with the scan link. Then never again.
 *  Daily cap per business ramps 10 → 25 → 50 (T1+T2+T3); the brake pauses new T1s on bounces > 5% or "no" > 3%.
 *  Every email carries the postal address and "reply no"; the List-Unsubscribe header stays on cold mail. */

const FOLLOW_AFTER_DAYS = 7; // T2 on day 7, T3 seven days later (day 14)
const HIGH_FRICTION = new Set(VENDORS.filter((v) => v.friction === "high").map((v) => v.id));
const SKIP_TLD = /\.(gov|mil|edu)(\.[a-z]{2})?$|\.gov\.[a-z]{2}$|\.ac\.[a-z]{2}$/;

export async function outreachStatus(env: Env) {
  const enabled = (await getSetting(env, "outreach_enabled")) === "1";
  const counts = await all<{ status: string; n: number }>(env, "SELECT status, COUNT(*) AS n FROM prospects GROUP BY status");
  const blockers: string[] = [];
  if (!enabled) blockers.push("switched off in the console");
  if (!env.POSTAL_ADDRESS) blockers.push("POSTAL_ADDRESS variable not set (required by CAN-SPAM)");
  if (!lanes(env).some((l) => l.cold > 0)) blockers.push("no mail lane with a cold allowance (MAILBOXES + secrets)");
  return { enabled, ready: blockers.length === 0, blockers, prospects: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
}

// ---------- ops intake (GitHub Action) ----------
function bearerOk(req: Request, token: string | undefined) {
  const h = req.headers.get("authorization") || "";
  return !!token && token.length >= 24 && h.startsWith("Bearer ") && timingSafeEqual(h.slice(7), token);
}

export async function opsRoute(req: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith("/api/ops/")) return null;
  if (!bearerOk(req, env.AO_OPS_TOKEN)) throw new HttpError(401, "Unauthorized");
  if (path === "/api/ops/prospects" && req.method === "POST") {
    const b = await readObject(req, 200 * 1024);
    const list = Array.isArray(b.prospects) ? b.prospects.slice(0, 200) : [];
    let added = 0, skipped = 0;
    for (const p of list) {
      const domain = normHost(str(p?.domain, 253));
      const email = str(p?.contact_email, 200).toLowerCase();
      const vendor = str(p?.vendor, 40);
      let page: URL | null = null;
      try { page = new URL(str(p?.page_url, 500)); } catch { page = null; }
      let src: URL | null = null;
      try { src = new URL(str(p?.contact_source, 500)); } catch { src = null; }
      const ok = domain && !domain.startsWith("*.") && !SKIP_TLD.test(domain) && page && page.protocol === "https:" && page.hostname.endsWith(domain.replace(/^www\./, ""))
        && HIGH_FRICTION.has(vendor) && isEmail(email) && email.split("@")[1].endsWith(domain.replace(/^www\./, "")) && src && src.hostname.endsWith(domain.replace(/^www\./, ""));
      if (!ok) { skipped++; continue; }
      const r = await run(env, `INSERT OR IGNORE INTO prospects (domain, page_url, vendor, page_kind, contact_email, contact_source, source) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        domain, page!.toString(), vendor, str(p?.page_kind, 20) || null, email, src!.toString(), str(p?.source, 20) || "tranco");
      if (Number(r.meta?.changes ?? 0)) added++; else skipped++;
    }
    return json({ ok: true, added, skipped });
  }
  if (path === "/api/ops/known" && req.method === "GET") {
    // Lets the Action skip domains it has already posted (keeps its scans fresh). Bounded.
    const rows = await all<{ domain: string }>(env, "SELECT domain FROM prospects ORDER BY created_at DESC LIMIT 20000");
    return json({ domains: rows.map((r) => r.domain) });
  }
  return null;
}

// ---------- messages ----------
const vendorName = (id: string) => VENDORS.find((v) => v.id === id)?.name ?? id;
const ACTION: Record<string, string> = { signup: "sign up", login: "log in", contact: "contact you" };

const who = (env: Env) => (env.OWNER_NAME ? `${env.OWNER_NAME}, AttestOS` : "AttestOS");
const footer = (env: Env) => `Not useful? Reply "no" and I won't write again.\n\n${who(env)}\n${env.POSTAL_ADDRESS}`;
const scanUrl = (env: Env, pageUrl: string) => `${env.SITE_URL}/scanner/?url=${encodeURIComponent(pageUrl)}`;
const reSubj = (subject: string) => (subject.startsWith("Re: ") ? subject : `Re: ${subject}`);
const where = (p: { domain: string; page_kind: string | null }) =>
  p.page_kind && p.page_kind !== "home" && p.page_kind !== "other" ? `the ${p.page_kind} page on ${p.domain}` : `the ${p.domain} homepage`;

/** T1: plain text, no links, no attachments. */
export function firstTouch(env: Env, p: { domain: string; page_url: string; vendor: string; page_kind: string | null }) {
  const v = vendorName(p.vendor);
  const action = ACTION[p.page_kind || ""] ?? "get through";
  return {
    subject: `${p.domain}: the ${v} on your ${p.page_kind && p.page_kind !== "home" && p.page_kind !== "other" ? `${p.page_kind} ` : ""}page`,
    body: `Hi ${p.domain} team,

I came across ${where(p)} in a public scan. It asks every real visitor to clear ${v} before they can ${action}.

Picture the person who finally decided to ${action}, on a phone, on a bus, squinting at blurry crosswalks, getting it wrong twice and giving up. They never tell you; they just leave. Meanwhile many bots get through anyway with paid solving services, so the people paying for the protection are mostly your real visitors.

I build AttestOS. It does the same job without the puzzle: a small proof-of-work check runs quietly in the visitor's browser and your server verifies the token with a call shaped like reCAPTCHA's siteverify. Your visitors just submit the form.

I ran a free scan of the page (headers, AI-crawler rules, forms). If you'd like it, and the free plan details, just reply and I'll send the links.

${footer(env)}`,
  };
}
/** Answer to a real reply: the links, once, in the same thread. */
export function linkReply(env: Env, p: { domain: string; page_url: string }, subject: string) {
  return {
    subject: reSubj(subject),
    body: `Thanks for getting back to me. Here they are:

Your scan of ${p.domain}: ${scanUrl(env, p.page_url)}
How the swap works (one script tag, one verify call): ${env.SITE_URL}/docs/
The free plan, 10,000 verifications a month, no card: ${env.SITE_URL}/app/#signup

Happy to answer anything about it here.

${who(env)}`,
  };
}
/** T2, day 7 with no reply: a gift first (the attached swap guide, mail/brief.ts), then the links, threaded. */
export function followUp(env: Env, p: { domain: string; page_url: string }, subject: string) {
  return {
    subject: reSubj(subject),
    body: `Hi again,

Rather than ask twice, I made you something: attached is a short guide to swapping the puzzle on ${p.domain} for a check your visitors never see. It shows what the scan found, then the swap itself, two lines on the page and one verify call on your server, with the code ready to paste. A developer can try it on a staging copy in about ten minutes.

Your free scan, live: ${scanUrl(env, p.page_url)}
The docs: ${env.SITE_URL}/docs/
The free plan, 10,000 verifications a month, no card: ${env.SITE_URL}/app/#signup

Every visitor who no longer meets a puzzle is one who gets to say yes.

${footer(env)}`,
  };
}
/** T3, day 14 with no reply: one last short nudge, then never again. */
export function nudge(env: Env, p: { domain: string; page_url: string }, subject: string) {
  return {
    subject: reSubj(subject),
    body: `Last note from me, and thank you for reading. Your ${p.domain} scan stays here if the puzzle ever becomes a priority: ${scanUrl(env, p.page_url)}

I won't email again.

${who(env)}
${env.POSTAL_ADDRESS}`,
  };
}

/** Daily outreach per business (owner 2026-11-04): 10 a day in week 1, 25 in week 2, 50 from week 3 (T1+T2+T3). */
export function outreachRamp(now = new Date(), start = "2026-11-05"): number {
  const days = Math.floor((now.getTime() - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  return days < 0 ? 0 : days < 7 ? 10 : days < 14 ? 25 : 50;
}
/** The brake: new first touches pause when the last 7 days show bounces > 5% or "no" replies > 3% (20+ sends). */
export function brakeReason(sent: number, bounced: number, stops: number): string {
  if (sent < 20) return "";
  // owner 2026-11-04: a wrong address or missing domain is not a failure; it never brakes or pauses outreach
  void bounced;
  if (stops / sent > 0.03) return `brake: ${stops} "no" replies in ${sent} sends this week (over 3%)`;
  return "";
}
async function weekHealth(env: Env) {
  const r = await first<{ sent: number }>(env, "SELECT COUNT(*) AS sent FROM outbox WHERE kind IN ('first','follow','nudge') AND status = 'sent' AND sent_at > datetime('now','-7 days')");
  const p = await first<{ bounced: number; stops: number }>(env, `SELECT COALESCE(SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END), 0) AS bounced,
    COALESCE(SUM(CASE WHEN status = 'unsub' AND replied_at > datetime('now','-7 days') THEN 1 ELSE 0 END), 0) AS stops
    FROM prospects WHERE first_sent_at > datetime('now','-21 days')`);
  return brakeReason(r?.sent ?? 0, p?.bounced ?? 0, p?.stops ?? 0);
}

/** Cron: queue T2/T3 (owed first) and then T1s, within the lanes' cold room AND the day's ramp. */
export async function outreachTick(env: Env, now = new Date()) {
  const st = await outreachStatus(env);
  if (!st.ready || (await budgetState(env)).tight) return { queued: 0, reason: st.blockers.join("; ") || "D1 budget tight" };
  let room = 0;
  for (const l of lanes(env)) {
    if (!l.cold || !laneUsable(await laneState(env, l.id))) continue;
    const c = await laneCounts(env, l.id);
    room += Math.max(0, Math.min(l.cold - c.cold, l.hourly - c.hour));
  }
  const pending = (await first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM outbox WHERE status IN ('queued','sending') AND kind IN ('first','follow','nudge')"))?.n ?? 0;
  const today = (await first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM outbox WHERE kind IN ('first','follow','nudge') AND created_at >= ? AND COALESCE(error,'') NOT IN ('suppressed','replied')", now.toISOString().slice(0, 10)))?.n ?? 0;
  room = Math.min(room - pending, outreachRamp(now, env.OUTREACH_START || undefined) - today);
  if (room <= 0) return { queued: 0 };
  let queued = 0;
  const firstSubject = async (domain: string) => (await first<{ subject: string }>(env, "SELECT subject FROM outbox WHERE ref = ? AND kind = 'first' AND status = 'sent' ORDER BY id DESC LIMIT 1", domain))?.subject || domain;
  const due = await all<{ domain: string; page_url: string; contact_email: string; status: string }>(env,
    `SELECT domain, page_url, contact_email, status FROM prospects
      WHERE (status = 'sent' AND first_sent_at < datetime('now', ?)) OR (status = 'followed' AND follow_sent_at < datetime('now', ?))
      ORDER BY first_sent_at LIMIT ?`, `-${FOLLOW_AFTER_DAYS} days`, `-${FOLLOW_AFTER_DAYS} days`, room);
  for (const p of due) {
    const t2 = p.status === "sent";
    const m = (t2 ? followUp : nudge)(env, p, await firstSubject(p.domain));
    const id = await enqueue(env, { to: p.contact_email, subject: m.subject, body: m.body, kind: t2 ? "follow" : "nudge", ref: p.domain });
    if (t2) await run(env, "UPDATE prospects SET status = ?, follow_sent_at = datetime('now') WHERE domain = ?", id ? "followed" : "unsub", p.domain);
    else await run(env, "UPDATE prospects SET status = ? WHERE domain = ?", id ? "nudged" : "unsub", p.domain);
    if (id) queued++;
  }
  const brake = queued < room ? await weekHealth(env) : "";
  if (queued < room && !brake) {
    const fresh = await all<{ domain: string; page_url: string; vendor: string; page_kind: string | null; contact_email: string }>(env,
      "SELECT domain, page_url, vendor, page_kind, contact_email FROM prospects WHERE status = 'new' ORDER BY created_at LIMIT ?", room - queued);
    for (const p of fresh) {
      const m = firstTouch(env, p);
      const id = await enqueue(env, { to: p.contact_email, subject: m.subject, body: m.body, kind: "first", ref: p.domain });
      await run(env, "UPDATE prospects SET status = ?, first_sent_at = datetime('now') WHERE domain = ?", id ? "sent" : "unsub", p.domain);
      if (id) queued++;
    }
  }
  return { queued, ...(brake ? { brake } : {}) };
}

// ---------- replies & bounces (IMAP, read-only) ----------
export function headerValue(header: string, field: string): string {
  const m = header.match(new RegExp(`^${field}:\\s*(.*(?:\\r?\\n[ \\t].+)*)`, "im"));
  return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : "";
}
export function parseAddr(header: string, field: string): string | null {
  const m = header.match(new RegExp(`^${field}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, "im"));
  if (!m) return null;
  const v = m[1].replace(/\r?\n[ \t]+/g, " ");
  return (v.match(/<([^>]+)>/)?.[1] ?? v.trim().split(/\s+/)[0]).toLowerCase();
}

/** Cron (every 30 min): look at new INBOX mail on each lane. A message from a prospect's address = reply → stop the
 *  sequence, notify the owner. "no"/"unsubscribe" replies also suppress the address. Bounces suppress too. */
export async function pollReplies(env: Env) {
  let replies = 0;
  for (const l of lanes(env)) {
    const st = await laneState(env, l.id);
    if (st.status !== "ok") continue;
    let s: ImapSession | null = null;
    try {
      s = await ImapSession.open({ host: l.imapHost, port: l.imapPort, user: l.user, pass: l.pass, timeoutMs: 12000 });
      const box = await s.examine("INBOX");
      const mark = st.imap?.INBOX;
      const from = mark && mark.v === box.uidValidity ? mark.u + 1 : Math.max(1, box.uidNext - 50);
      const uids = (await s.uidSearch(`UID ${from}:*`)).filter((u) => u >= from).slice(-40);
      const msgs = await s.fetch(uids, 1500);
      for (const msg of msgs) {
        const sender = parseAddr(msg.header, "From");
        const text = decodeBody(new TextDecoder().decode(msg.text)).slice(0, 4000);
        const hv = (f: string) => headerValue(msg.header, f);
        const headers = { "auto-submitted": hv("Auto-Submitted"), "x-autoreply": hv("X-Autoreply"), "x-autorespond": hv("X-Autorespond"),
          precedence: hv("Precedence"), "content-type": hv("Content-Type"), "x-failed-recipients": hv("X-Failed-Recipients") };
        // Owner 2026-11-04: delivery problems (wrong, full, unavailable, unmonitored inbox) are never a "no".
        const cls = classifyInbound({ from: sender || "", subject: hv("Subject"), text, headers });
        if (cls.kind === "bounce" || ((cls.kind === "soft" || cls.kind === "gone") && /mailer-daemon|postmaster|microsoftexchange/i.test(sender || "")) || headers["x-failed-recipients"]) {
          const cands = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
          const target = (parseAddr(msg.header, "X-Failed-Recipients") || failedRecipient({ text, headers }, cands.map((c) => c.toLowerCase())) || "").toLowerCase();
          if (target) {
            const p = await first<{ domain: string }>(env, "SELECT domain FROM prospects WHERE contact_email = ?", target);
            if (p) {
              const hard = cls.kind === "bounce";
              // hard: counts toward the bounce brake; soft/gone: the sequence ends quietly and counts as nothing
              await run(env, "UPDATE prospects SET status = ? WHERE domain = ?", hard ? "bounced" : "undeliverable", p.domain);
              await run(env, "UPDATE outbox SET status = 'failed', error = ? WHERE ref = ? AND status = 'queued'", hard ? "bounced" : "undeliverable", p.domain);
              await suppress(env, target, hard ? "bounced" : "undeliverable");
            }
          }
          continue;
        }
        if (!sender) continue;
        const p = await first<{ domain: string; status: string; page_url: string }>(env, "SELECT domain, status, page_url FROM prospects WHERE contact_email = ? AND status IN ('sent','followed','nudged')", sender);
        if (!p) continue;
        if (cls.kind === "auto") continue;                               // out-of-office: the sequence carries on
        if (cls.kind === "soft" || cls.kind === "gone") {               // full / unmonitored / left: end quietly, not a "no"
          await run(env, "UPDATE prospects SET status = 'undeliverable', replied_at = datetime('now') WHERE domain = ?", p.domain);
          await run(env, "UPDATE outbox SET status = 'failed', error = 'undeliverable' WHERE ref = ? AND status = 'queued'", p.domain);
          await suppress(env, sender, "undeliverable");
          continue;
        }
        const optout = cls.kind === "stop";
        await run(env, "UPDATE prospects SET status = ?, replied_at = datetime('now') WHERE domain = ?", optout ? "unsub" : "replied", p.domain);
        await run(env, "UPDATE outbox SET status = 'failed', error = 'replied' WHERE ref = ? AND status = 'queued'", p.domain);
        if (optout) await suppress(env, sender, "replied-no");
        else {
          replies++;
          // v2: the first touch had no links, so a real reply gets them now (once; T2 already carried them)
          let linked = false;
          if (p.status === "sent") {
            const subj = (await first<{ subject: string }>(env, "SELECT subject FROM outbox WHERE ref = ? AND kind = 'first' AND status = 'sent' ORDER BY id DESC LIMIT 1", p.domain))?.subject || p.domain;
            const m = linkReply(env, p, subj);
            linked = !!(await enqueue(env, { to: sender, subject: m.subject, body: m.body, kind: "link", ref: p.domain }));
          }
          await notifyOwner(env, { title: `Reply from ${p.domain}`, message: `${sender} replied.${linked ? " The links went back automatically, in-thread." : ""} Answer from ${l.user}.`, priority: 5 });
        }
      }
      const top = uids.length ? Math.max(...uids) : mark && mark.v === box.uidValidity ? mark.u : box.uidNext - 1;
      await saveLaneState(env, l.id, { ...st, imap: { ...(st.imap || {}), INBOX: { v: box.uidValidity, u: top } } });
    } catch (e) { await logError(env, `imap:${l.id}`, e); }
    finally { if (s) await s.logout(); }
  }
  return { replies };
}

// ---------- unsubscribe (/u/:token) ----------
const page = (title: string, body: string, status = 200) => html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · AttestOS</title><link rel="stylesheet" href="/assets/css/site.css"></head><body><main class="wrap narrow"><div class="card">${body}</div></main></body></html>`, status, { "x-robots-tag": "noindex", "cache-control": "no-store" });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function unsubscribe(req: Request, env: Env, token: string): Promise<Response> {
  const p = await verifyToken<{ e: string }>(`${env.APP_SECRET}|unsub`, token);
  if (!p?.e) return page("Link expired", `<h1>This link has expired</h1><p>Reply "no" to any of our emails and we'll stop.</p>`, 400);
  if (req.method === "POST") {
    await readBodyText(req, 4096).catch(() => "");
    await suppress(env, p.e, "unsubscribe-link");
    await run(env, "UPDATE prospects SET status = 'unsub' WHERE contact_email = ?", p.e);
    return page("Unsubscribed", `<h1>Done.</h1><p><b>${esc(p.e)}</b> won't hear from AttestOS again.</p>`);
  }
  return page("Unsubscribe", `<h1>Unsubscribe?</h1><p>Stop all AttestOS email to <b>${esc(p.e)}</b>.</p><form method="post"><button class="btn" type="submit">Unsubscribe</button></form>`);
}


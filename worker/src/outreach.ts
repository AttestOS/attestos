import type { Env } from "./env";
import { all, first, getSetting, logError, run } from "./lib/db";
import { timingSafeEqual, verifyToken } from "./lib/crypto";
import { HttpError, html, json, readBodyText, readObject, str } from "./lib/http";
import { isEmail, normHost } from "./lib/util";
import { notifyOwner } from "./lib/notify";
import { budgetState } from "./lib/quota";
import { enqueue, suppress, unsubscribeUrl } from "./mail/outbox";
import { laneCounts, laneState, laneUsable, lanes, saveLaneState } from "./mail/lanes";
import { ImapSession } from "./mail/imap";
import { VENDORS } from "./scanner";

/** Honest outreach. A GitHub Action (scripts/prospects.mjs) really scans public sites and posts the ones that show
 *  a visible CAPTCHA AND publish a business contact address on their own site. The Worker then sends ONE first
 *  touch and at most ONE follow-up (4 days later, only if no reply), through armed mail lanes, within their caps.
 *  Every email names what we saw and where, offers the free plan, links the live scan, and has a postal address,
 *  "reply no" and a one-click unsubscribe. Replies stop the sequence and are pushed to the owner, who answers. */

const FOLLOW_AFTER_DAYS = 4;
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

export function firstTouch(env: Env, p: { domain: string; page_url: string; vendor: string; page_kind: string | null }, unsub: string) {
  const v = vendorName(p.vendor);
  const action = ACTION[p.page_kind || ""] ?? "get through";
  const scan = `${env.SITE_URL}/scanner/?url=${encodeURIComponent(p.page_url)}`;
  const who = env.OWNER_NAME ? `${env.OWNER_NAME}, AttestOS` : "AttestOS";
  return {
    subject: `${p.domain}: the ${v} on your ${p.page_kind && p.page_kind !== "home" && p.page_kind !== "other" ? `${p.page_kind} ` : ""}page`,
    body: `Hi ${p.domain} team,

I came across ${p.page_url} in a public scan. It asks every real visitor to clear ${v} before they can ${action}.

Each of those puzzles costs you some of the people who were ready to ${action}: the ones on a phone, in a hurry, or on a weak connection. Many bots get through anyway with paid solving services.

I build AttestOS. It does the same job without the puzzle: a small proof-of-work check runs quietly in the visitor's browser and your server verifies the token with a call shaped like reCAPTCHA's siteverify. Your visitors just submit the form.

Your free scan (headers, AI-crawler rules, forms): ${scan}
The free plan covers 10,000 verifications a month, no card: ${env.SITE_URL}/app/#signup

Not useful? Reply "no" and I won't write again.

${who}
${env.POSTAL_ADDRESS}
Unsubscribe: ${unsub}`,
  };
}
export function followUp(env: Env, p: { domain: string; page_url: string }, subject: string, unsub: string) {
  const who = env.OWNER_NAME ? `${env.OWNER_NAME}, AttestOS` : "AttestOS";
  return {
    subject: subject.startsWith("Re: ") ? subject : `Re: ${subject}`,
    body: `Hi again,

One more thing that might help with ${p.domain}: the swap is two steps, one script tag on the page and one verify call on your server, and the docs walk through both: ${env.SITE_URL}/docs/
Your scan is still here: ${env.SITE_URL}/scanner/?url=${encodeURIComponent(p.page_url)}

This is my last email unless you reply. Either way, thank you for reading.

${who}
${env.POSTAL_ADDRESS}
Unsubscribe: ${unsub}`,
  };
}

/** Cron: queue first touches / follow-ups up to the lanes' remaining cold capacity for today. */
export async function outreachTick(env: Env) {
  const st = await outreachStatus(env);
  if (!st.ready || (await budgetState(env)).tight) return { queued: 0, reason: st.blockers.join("; ") || "D1 budget tight" };
  let room = 0;
  for (const l of lanes(env)) {
    if (!l.cold || !laneUsable(await laneState(env, l.id))) continue;
    const c = await laneCounts(env, l.id);
    room += Math.max(0, Math.min(l.cold - c.cold, l.hourly - c.hour));
  }
  const pending = (await first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM outbox WHERE status IN ('queued','sending') AND kind IN ('first','follow')"))?.n ?? 0;
  room -= pending;
  if (room <= 0) return { queued: 0 };
  let queued = 0;
  const follows = await all<{ domain: string; page_url: string; contact_email: string }>(env,
    `SELECT domain, page_url, contact_email FROM prospects WHERE status = 'sent' AND first_sent_at < datetime('now', ?) ORDER BY first_sent_at LIMIT ?`, `-${FOLLOW_AFTER_DAYS} days`, room);
  for (const p of follows) {
    const prev = await first<{ subject: string }>(env, "SELECT subject FROM outbox WHERE ref = ? AND kind = 'first' AND status = 'sent' ORDER BY id DESC LIMIT 1", p.domain);
    const m = followUp(env, p, prev?.subject || `${p.domain}`, await unsubscribeUrl(env, p.contact_email));
    const id = await enqueue(env, { to: p.contact_email, subject: m.subject, body: m.body, kind: "follow", ref: p.domain });
    await run(env, "UPDATE prospects SET status = ?, follow_sent_at = datetime('now') WHERE domain = ?", id ? "followed" : "unsub", p.domain);
    if (id) queued++;
  }
  if (queued < room) {
    const fresh = await all<{ domain: string; page_url: string; vendor: string; page_kind: string | null; contact_email: string }>(env,
      "SELECT domain, page_url, vendor, page_kind, contact_email FROM prospects WHERE status = 'new' ORDER BY created_at LIMIT ?", room - queued);
    for (const p of fresh) {
      const m = firstTouch(env, p, await unsubscribeUrl(env, p.contact_email));
      const id = await enqueue(env, { to: p.contact_email, subject: m.subject, body: m.body, kind: "first", ref: p.domain });
      await run(env, "UPDATE prospects SET status = ?, first_sent_at = datetime('now') WHERE domain = ?", id ? "sent" : "unsub", p.domain);
      if (id) queued++;
    }
  }
  return { queued };
}

// ---------- replies & bounces (IMAP, read-only) ----------
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
        const text = new TextDecoder().decode(msg.text).slice(0, 1500);
        const failed = parseAddr(msg.header, "X-Failed-Recipients");
        if (failed || /mailer-daemon|postmaster/i.test(sender || "")) {
          const target = failed || text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0]?.toLowerCase();
          if (target) {
            const p = await first<{ domain: string }>(env, "SELECT domain FROM prospects WHERE contact_email = ?", target);
            if (p) { await run(env, "UPDATE prospects SET status = 'bounced' WHERE domain = ?", p.domain); await suppress(env, target, "bounced"); }
          }
          continue;
        }
        if (!sender) continue;
        const p = await first<{ domain: string; status: string }>(env, "SELECT domain, status FROM prospects WHERE contact_email = ? AND status IN ('sent','followed')", sender);
        if (!p) continue;
        const optout = /^\s*(no|stop|unsubscribe|remove)\b/i.test(text) || /unsubscribe|remove me|not interested/i.test(parseAddr(msg.header, "Subject") || "");
        await run(env, "UPDATE prospects SET status = ?, replied_at = datetime('now') WHERE domain = ?", optout ? "unsub" : "replied", p.domain);
        await run(env, "UPDATE outbox SET status = 'failed', error = 'replied' WHERE ref = ? AND status = 'queued'", p.domain);
        if (optout) await suppress(env, sender, "replied-no");
        else { replies++; await notifyOwner(env, { title: `Reply from ${p.domain}`, message: `${sender} replied. Answer from ${l.user}.`, priority: 5 }); }
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


import { bytesToB64 } from "../lib/crypto";
import { openTls, utf8, type Conn } from "./wire";

/** Minimal SMTP submission client (RFC 5321 + AUTH PLAIN/LOGIN) for SMTPS port 465.
 *  One session sends several messages; every failure is classified so the outbox knows whether to retry the
 *  message, pause the mailbox, or drop the recipient. */

export type SmtpFailure =
  | "auth"        // credentials rejected → pause the mailbox, tell the owner
  | "policy"      // provider refused us (limit/lock/spam) → pause or cool the mailbox down
  | "recipient"   // this address is bad → fail the message, suppress the address
  | "message"     // this message was rejected (size, content) → fail the message
  | "temporary"   // 4xx: try later
  | "connection"; // network/TLS/timeout: try later

export class SmtpError extends Error {
  constructor(public failure: SmtpFailure, public code: number, msg: string) { super(msg); }
  get permanent() { return this.failure === "recipient" || this.failure === "message"; }
}

const POLICY = /\b(limit|exceed|quota|too many|rate|lock|block|suspend|disabled|spam|abuse|reputation|policy|frozen|denied)\b/i;

export interface SmtpReply { code: number; lines: string[] }

export async function readReply(c: Conn): Promise<SmtpReply> {
  const lines: string[] = [];
  for (;;) {
    const l = utf8(await c.readLine());
    const m = l.match(/^(\d{3})([ -])(.*)$/);
    if (!m) { lines.push(l); continue; } // tolerate junk
    lines.push(m[3]);
    if (m[2] === " ") return { code: Number(m[1]), lines };
  }
}

/** Classify an unexpected reply at a given stage. */
export function classify(stage: "greeting" | "ehlo" | "auth" | "mail" | "rcpt" | "data" | "body", r: SmtpReply): SmtpError {
  const text = r.lines.join(" ").slice(0, 300);
  const msg = `SMTP ${stage} ${r.code}: ${text}`;
  if (stage === "auth" || r.code === 535 || r.code === 534 || r.code === 530) return new SmtpError(r.code === 454 ? "temporary" : "auth", r.code, msg);
  if (r.code >= 400 && r.code < 500) return new SmtpError(POLICY.test(text) ? "policy" : "temporary", r.code, msg);
  if (stage === "rcpt" && [550, 551, 553, 501, 511].includes(r.code) && !POLICY.test(text)) return new SmtpError("recipient", r.code, msg);
  if ((stage === "data" || stage === "body") && (r.code === 552 || r.code === 554) && !POLICY.test(text)) return new SmtpError("message", r.code, msg);
  return new SmtpError(POLICY.test(text) || stage === "mail" ? "policy" : "message", r.code, msg);
}

/** RFC 5321 §4.5.2 transparency: lines starting with "." get another ".". Normalises bare LF to CRLF. */
export function dotStuff(mime: string): string {
  return mime.replace(/\r?\n/g, "\r\n").split("\r\n").map((l) => (l.startsWith(".") ? `.${l}` : l)).join("\r\n");
}

const b64 = (s: string) => bytesToB64(new TextEncoder().encode(s));

export class SmtpSession {
  private constructor(private c: Conn, public caps: string[]) {}

  static async open(o: { host: string; port?: number; user: string; pass: string; helo?: string; timeoutMs?: number }): Promise<SmtpSession> {
    let c: Conn;
    try { c = await openTls(o.host, o.port ?? 465, o.timeoutMs ?? 15000); }
    catch (e) { throw new SmtpError("connection", 0, e instanceof Error ? e.message : String(e)); }
    try { return await SmtpSession.handshake(c, o); }
    catch (e) { await c.close(); throw e instanceof SmtpError ? e : new SmtpError("connection", 0, e instanceof Error ? e.message : String(e)); }
  }

  /** Exposed for tests (runs over any Conn). */
  static async handshake(c: Conn, o: { user: string; pass: string; helo?: string }): Promise<SmtpSession> {
    const g = await readReply(c);
    if (g.code !== 220) throw classify("greeting", g);
    await c.write(`EHLO ${o.helo || "attestos.local"}\r\n`);
    const e = await readReply(c);
    if (e.code !== 250) throw classify("ehlo", e);
    const caps = e.lines.slice(1).map((l) => l.toUpperCase());
    const auth = caps.find((l) => l.startsWith("AUTH")) ?? "AUTH PLAIN LOGIN";
    let r: SmtpReply;
    if (/\bPLAIN\b/.test(auth)) {
      await c.write(`AUTH PLAIN ${b64(`\0${o.user}\0${o.pass}`)}\r\n`);
      r = await readReply(c);
    } else {
      await c.write("AUTH LOGIN\r\n");
      r = await readReply(c);
      if (r.code === 334) { await c.write(`${b64(o.user)}\r\n`); r = await readReply(c); }
      if (r.code === 334) { await c.write(`${b64(o.pass)}\r\n`); r = await readReply(c); }
    }
    if (r.code !== 235) throw classify("auth", r);
    return new SmtpSession(c, caps);
  }

  /** Send one message. `mime` must already contain the headers (From/To/Subject/Message-ID…). */
  async send(from: string, to: string, mime: string): Promise<string> {
    const step = async (cmd: string, stage: Parameters<typeof classify>[0], ok: number[]) => {
      await this.c.write(cmd);
      const r = await readReply(this.c);
      if (!ok.includes(r.code)) {
        // Leave the session usable for the next message after a per-message failure (including a rejected DATA or a
        // refused body: without RSET the next MAIL FROM can hit "503 bad sequence" and the whole lane looks broken).
        // Best effort: if the server already hung up, the classified error below must still win (a 550 bad recipient
        // has to fail + suppress the address, not be retried as a "connection" problem).
        if (stage === "rcpt" || stage === "mail" || stage === "data" || stage === "body") {
          try { await this.c.write("RSET\r\n"); await readReply(this.c); } catch { /* session is dead; the next send reconnects */ }
        }
        throw classify(stage, r);
      }
      return r;
    };
    await step(`MAIL FROM:<${from}>${this.caps.some((c) => c.startsWith("8BITMIME")) ? " BODY=8BITMIME" : ""}\r\n`, "mail", [250]);
    await step(`RCPT TO:<${to}>\r\n`, "rcpt", [250, 251]);
    await step("DATA\r\n", "data", [354]);
    const body = dotStuff(mime).replace(/(\r\n)*$/, "");
    const r = await step(`${body}\r\n.\r\n`, "body", [250]);
    return r.lines.join(" ").slice(0, 200);
  }

  async quit() {
    try { await this.c.write("QUIT\r\n"); await readReply(this.c); } catch { /* server may just hang up */ }
    await this.c.close();
  }
}

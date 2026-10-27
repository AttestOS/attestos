import { openTls, utf8, type Conn } from "./wire";

/** Minimal read-only IMAP4rev1 client (RFC 3501) for IMAPS 993: LOGIN, SELECT/EXAMINE, UID SEARCH, UID FETCH with
 *  BODY.PEEK (never marks mail as read, so the owner's webmail still shows it as new). */

export class ImapError extends Error {
  constructor(public failure: "auth" | "protocol" | "connection", msg: string) { super(msg); }
}

/** One untagged/tagged response, with literal payloads ({n}\r\n<n bytes>) inlined in order. */
export interface ImapResponse { line: string; literals: Uint8Array[] }

export const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export async function readResponse(c: Conn): Promise<ImapResponse> {
  let line = "";
  const literals: Uint8Array[] = [];
  for (;;) {
    const part = utf8(await c.readLine());
    line += part;
    const m = part.match(/\{(\d+)\}$/);
    if (!m) return { line, literals };
    const n = Number(m[1]);
    if (n > 5_000_000) throw new ImapError("protocol", "literal too large");
    literals.push(await c.readBytes(n));
    line = `${line.slice(0, line.length - m[0].length)}\u0000${literals.length - 1}\u0000`; // "{n}" → placeholder
  }
}

export interface FetchedMessage { uid: number; flags: string[]; header: string; text: Uint8Array }

export class ImapSession {
  private n = 0;
  private constructor(private c: Conn) {}

  static async open(o: { host: string; port?: number; user: string; pass: string; timeoutMs?: number }): Promise<ImapSession> {
    let c: Conn;
    try { c = await openTls(o.host, o.port ?? 993, o.timeoutMs ?? 15000); }
    catch (e) { throw new ImapError("connection", e instanceof Error ? e.message : String(e)); }
    const s = new ImapSession(c);
    try {
      const g = await readResponse(c);
      if (!/^\* (OK|PREAUTH)/i.test(g.line)) throw new ImapError("protocol", `greeting: ${g.line.slice(0, 120)}`);
      await s.login(o.user, o.pass);
      return s;
    } catch (e) {
      await c.close();
      throw e instanceof ImapError ? e : new ImapError("connection", e instanceof Error ? e.message : String(e));
    }
  }

  /** Exposed for tests. */
  static over(c: Conn) { return new ImapSession(c); }

  /** Send a command; collect untagged responses until the tagged completion. */
  async cmd(command: string): Promise<{ untagged: ImapResponse[]; status: string; text: string }> {
    const tag = `t${++this.n}`;
    await this.c.write(`${tag} ${command}\r\n`);
    const untagged: ImapResponse[] = [];
    for (;;) {
      const r = await readResponse(this.c);
      if (r.line.startsWith(`${tag} `)) {
        const m = r.line.slice(tag.length + 1).match(/^(OK|NO|BAD)\s?(.*)$/i);
        return { untagged, status: (m?.[1] ?? "BAD").toUpperCase(), text: m?.[2] ?? r.line };
      }
      if (r.line.startsWith("+")) continue; // continuation (not used: we only send synchronising-free commands)
      untagged.push(r);
    }
  }

  async login(user: string, pass: string) {
    const r = await this.cmd(`LOGIN ${quote(user)} ${quote(pass)}`);
    if (r.status !== "OK") throw new ImapError(/AUTHENTICATIONFAILED|invalid|incorrect|password|credentials/i.test(r.text) || r.status === "NO" ? "auth" : "protocol", `LOGIN ${r.status}: ${r.text.slice(0, 160)}`);
  }

  /** EXAMINE = read-only SELECT. Returns UIDVALIDITY / UIDNEXT / EXISTS. */
  async examine(mailbox: string) {
    const r = await this.cmd(`EXAMINE ${quote(mailbox)}`);
    if (r.status !== "OK") throw new ImapError("protocol", `EXAMINE ${mailbox}: ${r.text.slice(0, 160)}`);
    const all = r.untagged.map((u) => u.line).join("\n") + `\n${r.text}`;
    const num = (re: RegExp) => Number(all.match(re)?.[1] ?? 0) || 0;
    return { uidValidity: num(/UIDVALIDITY (\d+)/i), uidNext: num(/UIDNEXT (\d+)/i), exists: num(/\* (\d+) EXISTS/i) };
  }

  async uidSearch(criteria: string): Promise<number[]> {
    const r = await this.cmd(`UID SEARCH ${criteria}`);
    if (r.status !== "OK") throw new ImapError("protocol", `SEARCH: ${r.text.slice(0, 160)}`);
    return r.untagged.filter((u) => /^\* SEARCH/i.test(u.line)).flatMap((u) => u.line.replace(/^\* SEARCH/i, "").trim().split(/\s+/)).map(Number).filter((n) => n > 0);
  }

  /** Headers of interest + the first `textBytes` of the body for each UID. */
  async fetch(uids: number[], textBytes = 4000): Promise<FetchedMessage[]> {
    if (!uids.length) return [];
    const fields = "FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES AUTO-SUBMITTED PRECEDENCE CONTENT-TYPE CONTENT-TRANSFER-ENCODING X-FAILED-RECIPIENTS RETURN-PATH";
    const r = await this.cmd(`UID FETCH ${uids.join(",")} (UID FLAGS BODY.PEEK[HEADER.FIELDS (${fields})] BODY.PEEK[TEXT]<0.${textBytes}>)`);
    if (r.status !== "OK") throw new ImapError("protocol", `FETCH: ${r.text.slice(0, 160)}`);
    return r.untagged.filter((u) => /^\* \d+ FETCH/i.test(u.line)).map(parseFetch).filter((m): m is FetchedMessage => !!m);
  }

  async logout() {
    try { await this.cmd("LOGOUT"); } catch { /* server closes */ }
    await this.c.close();
  }
}

/** Parse one "* n FETCH (...)" response with its literals. Order of items varies by server. */
export function parseFetch(r: ImapResponse): FetchedMessage | null {
  const uid = Number(r.line.match(/\bUID (\d+)/i)?.[1] ?? 0);
  if (!uid) return null;
  const flags = (r.line.match(/\bFLAGS \(([^)]*)\)/i)?.[1] ?? "").split(/\s+/).filter(Boolean);
  let header = "";
  let text: Uint8Array = new Uint8Array(0);
  // Each BODY[...] item is followed by either a literal placeholder or a quoted string / NIL.
  for (const m of r.line.matchAll(/BODY\[(HEADER[^\]]*|TEXT)\](?:<\d+>)?\s+(?:\u0000(\d+)\u0000|"((?:[^"\\]|\\.)*)"|NIL)/gi)) {
    const bytes = m[2] !== undefined ? r.literals[Number(m[2])] : new TextEncoder().encode(m[3] ?? "");
    if (/^HEADER/i.test(m[1])) header = utf8(bytes);
    else text = bytes;
  }
  return { uid, flags, header, text };
}

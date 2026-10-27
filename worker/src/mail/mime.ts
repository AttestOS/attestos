import { b64url, bytesToB64 } from "../lib/crypto";

const enc = new TextEncoder();
const clean = (v: string) => v.replace(/[\r\n]+/g, " ").trim(); // header-injection guard

export function encodeHeaderWord(v: string): string {
  const c = clean(v);
  if (/^[\x20-\x7e]*$/.test(c)) return c;
  // RFC 2047: an encoded-word is at most 75 chars, so long non-ASCII text becomes several words (≤45 bytes each,
  // split on code points so no UTF-8 sequence is cut), folded onto continuation lines.
  const words: string[] = [];
  let chunk: number[] = [];
  for (const ch of c) {
    const b = enc.encode(ch);
    if (chunk.length + b.length > 45) { words.push(`=?UTF-8?B?${bytesToB64(new Uint8Array(chunk))}?=`); chunk = []; }
    chunk.push(...b);
  }
  if (chunk.length) words.push(`=?UTF-8?B?${bytesToB64(new Uint8Array(chunk))}?=`);
  return words.join("\r\n ");
}
export function formatAddress(email: string, name?: string): string {
  const e = clean(email);
  if (!/^[^@\s<>"]+@[^@\s<>"]+$/.test(e)) throw new Error(`Invalid email: ${e}`);
  if (!name) return e;
  const n = clean(name).replace(/["\\]/g, "").trim();
  if (!n) return e;
  // ASCII names with RFC 5322 specials ("Smith, Jane", "TightBucket: Sam") must be a quoted-string, or the header
  // parses as two addresses / a group. Non-ASCII names are encoded-words.
  const display = /^[\x20-\x7e]*$/.test(n) ? (/[()<>[\]:;@,.]/.test(n) ? `"${n}"` : n) : encodeHeaderWord(n);
  return `${display} <${e}>`;
}
const b64Body = (s: string) => bytesToB64(enc.encode(s)).replace(/.{1,76}/g, "$&\r\n").trimEnd();

export interface MimeInput {
  from: string; fromName?: string; to: string; subject: string; text: string; html?: string;
  inReplyTo?: string | null; references?: string | null; messageId?: string;
  listUnsubscribe?: string; // https URL; adds RFC 8058 one-click header
  listUnsubscribeMailto?: string; // address for "mailto:...?subject=unsubscribe" (works in every client)
  replyTo?: string;
}

export function buildMime(m: MimeInput, boundarySeed = crypto.randomUUID()): string {
  const h: string[] = [
    `From: ${formatAddress(m.from, m.fromName)}`,
    `To: ${formatAddress(m.to)}`,
    `Subject: ${encodeHeaderWord(m.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
  ];
  if (m.messageId) h.push(`Message-ID: ${clean(m.messageId)}`);
  if (m.replyTo) h.push(`Reply-To: ${formatAddress(m.replyTo)}`);
  if (m.inReplyTo) h.push(`In-Reply-To: ${clean(m.inReplyTo)}`);
  if (m.references || m.inReplyTo) h.push(`References: ${clean(m.references || m.inReplyTo!)}`);
  if (m.listUnsubscribe || m.listUnsubscribeMailto) {
    const targets = [
      m.listUnsubscribeMailto ? `<mailto:${clean(m.listUnsubscribeMailto)}?subject=unsubscribe>` : "",
      m.listUnsubscribe ? `<${clean(m.listUnsubscribe)}>` : "",
    ].filter(Boolean);
    h.push(`List-Unsubscribe: ${targets.join(", ")}`);
    if (m.listUnsubscribe) h.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  }
  if (!m.html) {
    h.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
    return `${h.join("\r\n")}\r\n\r\n${b64Body(m.text)}\r\n`;
  }
  const b = `b_${boundarySeed.replace(/-/g, "")}`;
  h.push(`Content-Type: multipart/alternative; boundary="${b}"`);
  return [
    h.join("\r\n"), "",
    `--${b}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64Body(m.text),
    `--${b}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64Body(m.html),
    `--${b}--`, "",
  ].join("\r\n");
}

/** Gmail API wants base64url of the full RFC 2822 message. */
export const toGmailRaw = (mime: string) => b64url(enc.encode(mime));

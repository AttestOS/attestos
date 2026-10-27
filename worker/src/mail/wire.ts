/** Byte-accurate line reader/writer over a TCP(TLS) socket, shared by the SMTP and IMAP clients.
 *  Works on bytes, not strings: IMAP literals ({123}) count octets, and UTF-8 text would make string lengths lie. */

const enc = new TextEncoder();
const dec = new TextDecoder();

export class WireError extends Error {
  constructor(msg: string, public kind: "timeout" | "closed" | "connect" = "closed") { super(msg); }
}

export interface Conn {
  /** Next line without its CRLF. */
  readLine(): Promise<Uint8Array>;
  readText(): Promise<string>;
  /** Exactly n bytes (IMAP literals). */
  readBytes(n: number): Promise<Uint8Array>;
  write(data: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export function connFromStreams(readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, timeoutMs = 15000, onClose?: () => Promise<void>): Conn {
  const reader = readable.getReader();
  const writer = writable.getWriter();
  let buf = new Uint8Array(0);
  let done = false;

  const pull = async () => {
    if (done) throw new WireError("connection closed by server");
    let timer: any;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new WireError(`no response in ${timeoutMs / 1000}s`, "timeout")), timeoutMs); });
    try {
      const r = await Promise.race([reader.read(), timeout]);
      if (r.done) { done = true; throw new WireError("connection closed by server"); }
      const next = new Uint8Array(buf.length + r.value.length);
      next.set(buf); next.set(r.value, buf.length);
      buf = next;
    } finally { clearTimeout(timer); }
  };

  const conn: Conn = {
    async readLine() {
      for (;;) {
        for (let i = 0; i + 1 < buf.length; i++) {
          if (buf[i] === 13 && buf[i + 1] === 10) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 2);
            return line;
          }
        }
        if (buf.length > 1_000_000) throw new WireError("line too long");
        await pull();
      }
    },
    async readText() { return dec.decode(await conn.readLine()); },
    async readBytes(n) {
      while (buf.length < n) await pull();
      const out = buf.slice(0, n);
      buf = buf.slice(n);
      return out;
    },
    async write(data) { await writer.write(typeof data === "string" ? enc.encode(data) : data); },
    async close() {
      try { await writer.close(); } catch { /* already closed */ }
      try { reader.releaseLock(); } catch { /* ignore */ }
      if (onClose) await onClose().catch(() => {});
    },
  };
  return conn;
}

/** Implicit-TLS connection (SMTPS 465, IMAPS 993). Workers' connect() blocks only port 25. */
export async function openTls(hostname: string, port: number, timeoutMs = 15000): Promise<Conn> {
  const { connect } = await import("cloudflare:sockets");
  const sock = connect({ hostname, port }, { secureTransport: "on", allowHalfOpen: false });
  try {
    await Promise.race([
      sock.opened,
      new Promise((_, rej) => setTimeout(() => rej(new WireError(`connect to ${hostname}:${port} timed out`, "connect")), timeoutMs)),
    ]);
  } catch (e) {
    await sock.close().catch(() => {});
    throw e instanceof WireError ? e : new WireError(`connect to ${hostname}:${port} failed: ${e instanceof Error ? e.message : e}`, "connect");
  }
  return connFromStreams(sock.readable, sock.writable, timeoutMs, () => sock.close());
}

export const utf8 = (b: Uint8Array) => dec.decode(b);

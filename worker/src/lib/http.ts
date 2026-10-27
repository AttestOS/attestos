export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-api-key",
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

export function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...extra } });
}

export function svg(body: string, maxAge = 3600): Response {
  return new Response(body, {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": `public, max-age=${maxAge}` },
  });
}

export function redirect(url: string, status = 302): Response {
  return new Response(null, { status, headers: { location: url } });
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

/** Read a request body as text with a hard BYTE cap (default 256 KB). Streams, so a chunked upload without a
 *  content-length can't make us buffer more than `max` bytes. */
export async function readBodyText(req: Request, max = 256 * 1024): Promise<string> {
  if (Number(req.headers.get("content-length") || "0") > max) throw new HttpError(413, "Payload too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new HttpError(413, "Payload too large"); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** Parse a JSON body with a size cap (default 256 KB). */
export async function readJson<T = any>(req: Request, max = 256 * 1024): Promise<T> {
  const text = await readBodyText(req, max);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

/** Like readJson, but guarantees a plain object (null, arrays, numbers and strings are rejected with a 400). */
export async function readObject<T extends Record<string, unknown> = Record<string, any>>(req: Request, max = 256 * 1024): Promise<T> {
  const v = await readJson<unknown>(req, max);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "Expected a JSON object");
  return v as T;
}

/** Coerce an untrusted value to a trimmed string (numbers allowed; objects/arrays/null become ""). */
export const str = (v: unknown, max = 2000): string =>
  typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : "";

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
}

/** Tiny router: patterns like "/api/report/:slug". */
export type Handler<E> = (req: Request, env: E, ctx: ExecutionContext, params: Record<string, string>) => Promise<Response> | Response;

export class Router<E> {
  private routes: { method: string; parts: string[]; handler: Handler<E> }[] = [];
  on(method: string, pattern: string, handler: Handler<E>) {
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler<E>) { return this.on("GET", p, h); }
  post(p: string, h: Handler<E>) { return this.on("POST", p, h); }

  match(method: string, path: string): { handler: Handler<E>; params: Record<string, string> } | null {
    const segs = path.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method && !(r.method === "GET" && method === "HEAD")) continue;
      const wildcard = r.parts[r.parts.length - 1] === "*";
      if (!wildcard && r.parts.length !== segs.length) continue;
      if (wildcard && segs.length < r.parts.length - 1) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const p = r.parts[i];
        if (p === "*") { params["*"] = segs.slice(i).join("/"); break; }
        if (p.startsWith(":")) {
          try { params[p.slice(1)] = decodeURIComponent(segs[i]); } catch { throw new HttpError(400, "Bad URL encoding"); }
        }
        else if (p !== segs[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }
}

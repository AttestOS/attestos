export const today = (d = new Date()) => d.toISOString().slice(0, 10);
export const thisMonth = (d = new Date()) => d.toISOString().slice(0, 7);
export const nowSec = () => Math.floor(Date.now() / 1000);
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const isEmail = (s: string) => /^[^@\s<>"',;]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i.test(s);
/** Normalise a user-entered hostname ("https://WWW.Example.com/x" → "www.example.com"); null if invalid. */
export function normHost(input: string): string | null {
  let s = String(input || "").trim().toLowerCase();
  if (!s) return null;
  const wild = s.startsWith("*.");
  if (wild) s = s.slice(2);
  s = s.replace(/^[a-z]+:\/\//, "").replace(/[/?#:].*$/, "").replace(/\.$/, "");
  if (s === "localhost") return wild ? null : s;
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s)) return null;
  return wild ? `*.${s}` : s;
}
/** Does `host` match one of the allowed patterns? "*.example.com" also matches "example.com". */
export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((p) => {
    if (p.startsWith("*.")) { const base = p.slice(2); return h === base || h.endsWith(`.${base}`); }
    return h === p;
  });
}
export function safeJson<T>(s: string | null | undefined, fallback: T): T {
  try { const v = JSON.parse(String(s ?? "")); return (v ?? fallback) as T; } catch { return fallback; }
}

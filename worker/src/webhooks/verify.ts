import { b64ToBytes, bytesToB64, hmacSha256, timingSafeEqual } from "../lib/crypto";

/** Standard Webhooks verification (used by Whop).
 *  signed = `${webhook-id}.${webhook-timestamp}.${rawBody}`, HMAC-SHA256, header "v1,<base64>" (space-separated list).
 *  Key: Whop docs show `ws_...` secrets used as raw UTF-8; Standard Webhooks `whsec_` secrets are base64 → try both. */
export async function verifyStandardWebhook(
  secret: string,
  h: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): Promise<boolean> {
  if (!secret || !h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const signed = `${h.id}.${h.timestamp}.${rawBody}`;
  const keys: (string | Uint8Array)[] = [secret];
  if (secret.startsWith("whsec_")) { try { keys.push(b64ToBytes(secret.slice(6))); } catch { /* not base64 */ } }
  const provided = h.signature.split(" ").map((s) => s.trim()).filter((s) => s.startsWith("v1,")).map((s) => s.slice(3));
  for (const k of keys) {
    const expected = bytesToB64(await hmacSha256(k, signed));
    if (provided.some((p) => timingSafeEqual(p, expected))) return true;
  }
  return false;
}

/** Test helper / for sending signed test events from scripts. */
export async function signStandardWebhook(secret: string, id: string, timestamp: number, body: string) {
  return `v1,${bytesToB64(await hmacSha256(secret, `${id}.${timestamp}.${body}`))}`;
}

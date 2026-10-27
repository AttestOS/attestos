import type { Env } from "../env";
import { logError } from "./db";

/** Push to the owner's phone via ntfy.sh (free, no account: subscribe to the secret topic in NTFY_TOPIC).
 *  No topic configured → does nothing (the console still shows everything). */
export async function notifyOwner(env: Env, n: { title: string; message: string; priority?: 1 | 2 | 3 | 4 | 5; click?: string }) {
  if (!env.NTFY_TOPIC) return false;
  try {
    const res = await fetch("https://ntfy.sh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: env.NTFY_TOPIC, title: n.title.slice(0, 120), message: n.message.slice(0, 1000), priority: n.priority ?? 3, click: n.click ?? `${env.SITE_URL}/admin/` }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (e) { await logError(env, "notify", e); return false; }
}

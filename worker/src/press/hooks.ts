// Press mesh hooks: the GitHub-hosted press (press/auto.py, the STPi/TightBucket distribution mesh) talks to the
// Worker here, bearer-authenticated with AO_PRESS_TOKEN (same secret in GitHub Actions and on the Worker).
//
//   GET  /api/press/settings     owner-pasted rail keys (decrypted) + cadence knobs; fills only UNSET runner env
//   GET  /api/press/mesh-config  per-rail park/resume/per_day overrides from the console Mesh tab
//   GET  /api/press/controls     {ok, values} for every key in press/control_catalog.json (strict policy read)
//   POST /api/press/quota-usage  last run's author-call count (one settings write per run)
//   POST /api/press/img          PNG card upload → {url}; content-addressed, re-uploads are no-ops
//   GET  /api/press/img/<sha>.png public card fetch for Buffer/Pinterest (immutable cache)
//   POST /api/press/notify       rail-failure alert → owner push (ntfy) + errors log
//
// Unset AO_PRESS_TOKEN = the press lane is off: every authed route 404s, nothing is read or written.
import type { Env } from "../env";
import { all, first, getSetting, logError, run, setSetting } from "../lib/db";
import { HttpError, json, readObject } from "../lib/http";
import { decryptString, encryptString, timingSafeEqual } from "../lib/crypto";
import { notifyOwner } from "../lib/notify";
import catalog from "../../../press/control_catalog.json";
import cadence from "../../../press/cadence.json";

type Spec = { key: string; group: string; type: string; default: number | string; min?: number; max?: number; label?: string };
export const PRESS_CONTROLS = catalog as Spec[];
const MAX_IMG = 1_500_000;                      // cards are 20–80 KB; D1 rows cap at ~2 MB
export const IMG_KEEP_DAYS = 21;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,59}$/;
// Names the owner console may store for the press. Never the press token or site URL themselves (those come from
// GitHub), never anything outside the press's own namespaces.
const ENV_ALLOWED = /^(AO_|PRESS_|WHOP_(COMPANY_ID|PUBLIC_EXP_ID|PRIVATE_EXP_ID|PRIVATE_CHANNEL_ID|API_KEY|APP_KEY)$|(GROQ|GEMINI|MISTRAL|COHERE|CEREBRAS)_API_KEY$|GH_MODELS_TOKEN$)/;
const ENV_DENIED = new Set(["AO_PRESS_TOKEN", "AO_SITE_URL"]);

export const pressRails = (): string[] => Object.keys(cadence).filter((k) => typeof (cadence as Record<string, unknown>)[k] === "object" && (cadence as Record<string, unknown>)[k] !== null);

function authed(req: Request, env: Env) {
  const tok = env.AO_PRESS_TOKEN || "";
  if (!tok) throw new HttpError(404, "Not found");
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!got || !timingSafeEqual(got, tok)) throw new HttpError(401, "Unauthorized");
}

export function controlValues(stored: Record<string, unknown>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const s of PRESS_CONTROLS) {
    const v = stored[s.key];
    out[s.key] = validControl(s, v) ? (v as number) : s.default;
  }
  return out;
}

export function validControl(s: Spec, v: unknown): boolean {
  if (s.type === "text") return typeof v === "string" && v.trim().length > 0 && v.length <= 200;
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (s.type === "int" && !Number.isInteger(v)) return false;
  return (s.min == null || v >= s.min) && (s.max == null || v <= s.max);
}

const parseObj = (raw: string | null): Record<string, any> => {
  try { const o = JSON.parse(raw || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; }
};

/** Returns a Response for /api/press/* paths, or null when the path is not a press route. */
export async function pressHook(req: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith("/api/press/")) return null;
  const m = path.match(/^\/api\/press\/img\/([a-f0-9]{64})\.png$/);
  if (m && (req.method === "GET" || req.method === "HEAD")) {
    const row = await first<{ png: ArrayBuffer | Uint8Array | number[] }>(env, "SELECT png FROM press_img WHERE hash = ?", m[1]);
    if (!row) throw new HttpError(404, "Not found");
    // D1 returns BLOB columns as a plain number[] (not an ArrayBuffer): handing that to Response would serialise
    // "137,80,78,…" as text. Normalise every shape to bytes.
    const bytes = new Uint8Array(row.png as ArrayLike<number>);
    return new Response(req.method === "HEAD" ? null : bytes, { headers: {
      "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*" } });
  }
  authed(req, env);
  const route = `${req.method} ${path}`;
  switch (route) {
    case "GET /api/press/settings": {
      const rows = await all<{ key: string; value: string }>(env,
        "SELECT key, value FROM settings WHERE key LIKE 'press_env:%' OR key = 'press_cadence'");
      const settings: Record<string, unknown> = {};
      for (const r of rows) {
        if (r.key === "press_cadence") { for (const [k, v] of Object.entries(parseObj(r.value))) settings[`cadence:${k}`] = v; continue; }
        const name = r.key.slice("press_env:".length);
        try { settings[name] = await decryptString(env.APP_SECRET, r.value); } catch { /* rotated APP_SECRET: skip, never 500 */ }
      }
      return json({ settings });
    }
    case "GET /api/press/mesh-config":
      return json({ rails: parseObj(await getSetting(env, "press_mesh")) });
    case "GET /api/press/controls":
      return json({ ok: true, values: controlValues(parseObj(await getSetting(env, "press_controls"))) });
    case "POST /api/press/quota-usage": {
      const b = await readObject(req, 16_000);
      const rec = { id: String(b.id || "").slice(0, 80), at: String(b.at || new Date().toISOString()).slice(0, 40),
        value: Number(b.value) || 0, window: String(b.window || "").slice(0, 80), effective: b.effective && typeof b.effective === "object" ? b.effective : {} };
      await setSetting(env, "press_last_usage", JSON.stringify(rec));
      return json({ ok: true });
    }
    case "POST /api/press/img": {
      const len = Number(req.headers.get("content-length") || 0);
      if (len > MAX_IMG) throw new HttpError(413, "Image too large");
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.byteLength > MAX_IMG) throw new HttpError(413, "Image too large");
      if (buf.byteLength < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) throw new HttpError(415, "PNG only");
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((x) => x.toString(16).padStart(2, "0")).join("");
      await run(env, "INSERT OR IGNORE INTO press_img (hash, png) VALUES (?, ?)", hash, buf);
      return json({ url: `${env.SITE_URL.replace(/\/$/, "")}/api/press/img/${hash}.png` });
    }
    case "POST /api/press/notify": {
      const b = await readObject(req, 16_000);
      const content = String(b.content || "").slice(0, 3000);
      if (!content) throw new HttpError(400, "content is required");
      await logError(env, "press:rail", content);
      await notifyOwner(env, { title: "Press rail failure", message: content.slice(0, 1000), priority: 3,
        click: `${env.SITE_URL.replace(/\/$/, "")}/admin/#mesh` });
      return json({ ok: true });
    }
  }
  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------- console (owner session) helpers

/** Mesh tab payload: rails from cadence.json, owner overrides, controls, which press keys are stored (names only). */
export async function pressOverview(env: Env) {
  const rows = await all<{ key: string; value: string; updated_at: string }>(env,
    "SELECT key, value, updated_at FROM settings WHERE key LIKE 'press_%'");
  const by = new Map(rows.map((r) => [r.key, r]));
  const cad = cadence as Record<string, any>;
  return {
    configured: Boolean(env.AO_PRESS_TOKEN),
    rails: pressRails().map((r) => ({ rail: r, per_day: cad[r].per_day })),
    overrides: parseObj(by.get("press_mesh")?.value ?? null),
    controls: { specs: PRESS_CONTROLS, values: controlValues(parseObj(by.get("press_controls")?.value ?? null)) },
    keys: rows.filter((r) => r.key.startsWith("press_env:")).map((r) => ({ name: r.key.slice(10), updated_at: r.updated_at })),
    lastRun: parseObj(by.get("press_last_usage")?.value ?? null),
  };
}

export async function setMeshOverride(env: Env, rail: string, o: { parked?: unknown; per_day?: unknown }) {
  if (!pressRails().includes(rail)) throw new HttpError(400, "Unknown rail");
  const all_ = parseObj(await getSetting(env, "press_mesh"));
  const cur: Record<string, unknown> = { ...(all_[rail] || {}) };
  if (o.parked !== undefined) {
    if (typeof o.parked !== "boolean") throw new HttpError(400, "parked must be true or false");
    cur.parked = o.parked;
  }
  if (o.per_day !== undefined) {
    if (o.per_day === null) delete cur.per_day;
    else if (typeof o.per_day !== "number" || !Number.isInteger(o.per_day) || o.per_day < 0 || o.per_day > 10) throw new HttpError(400, "per_day must be 0–10");
    else cur.per_day = o.per_day;
  }
  all_[rail] = cur;
  await setSetting(env, "press_mesh", JSON.stringify(all_));
  return all_;
}

export async function setPressControl(env: Env, key: string, value: unknown) {
  const s = PRESS_CONTROLS.find((x) => x.key === key);
  if (!s) throw new HttpError(400, "Unknown control");
  if (!validControl(s, value)) throw new HttpError(400, `${key} is outside its safe range`);
  const cur = parseObj(await getSetting(env, "press_controls"));
  cur[key] = value;
  await setSetting(env, "press_controls", JSON.stringify(cur));
  return controlValues(cur);
}

/** Store (encrypted with APP_SECRET) or delete (empty value) one press key. Values are never returned to the UI. */
export async function setPressKey(env: Env, name: string, value: unknown) {
  if (!ENV_NAME.test(name) || !ENV_ALLOWED.test(name) || ENV_DENIED.has(name)) throw new HttpError(400, "That key name is not a press key");
  if (value === "" || value == null) { await run(env, "DELETE FROM settings WHERE key = ?", `press_env:${name}`); return { removed: name }; }
  if (typeof value !== "string" || value.length > 4000 || /[\x00-\x1f\x7f]/.test(value)) throw new HttpError(400, "Invalid key value");
  await setSetting(env, `press_env:${name}`, await encryptString(env.APP_SECRET, value.trim()));
  return { stored: name };
}


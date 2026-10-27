/** Automation signals (IntegrityRuntime Pro). The widget reports a handful of browser facts; we turn them into a
 *  0–1 risk score with named flags. These are SIGNALS, not proof: a determined bot can fake every one of them,
 *  which is why the score is returned to the customer's backend instead of silently deciding for them
 *  (unless the site owner chose "enforce"). */

export interface RawSignals {
  wd?: unknown; ua?: unknown; langs?: unknown; plugins?: unknown; gl?: unknown; hc?: unknown; ow?: unknown; oh?: unknown;
  cdp?: unknown; ms?: unknown; touch?: unknown; tz?: unknown;
}
export interface Assessment { risk: number; flags: string[] }

const W: Record<string, number> = {
  webdriver: 0.9, headless_ua: 0.8, cdp_runtime: 0.5, software_gpu: 0.35, ua_mismatch: 0.4, no_languages: 0.3,
  zero_window: 0.3, no_plugins_desktop_chrome: 0.15, native_speed_solver: 0.3,
};

export function assess(raw: RawSignals | null | undefined, ctx: { headerUa: string; attempts: number }): Assessment {
  const s = raw && typeof raw === "object" ? raw : {};
  const flags: string[] = [];
  const ua = typeof s.ua === "string" ? s.ua.slice(0, 400) : "";
  if (s.wd === true) flags.push("webdriver");
  if (/HeadlessChrome|PhantomJS|SlimerJS|Electron\/|puppeteer|playwright/i.test(`${ua} ${ctx.headerUa}`)) flags.push("headless_ua");
  if (s.cdp === true) flags.push("cdp_runtime");
  if (typeof s.gl === "string" && /swiftshader|llvmpipe|softpipe|mesa offscreen|basic render driver/i.test(s.gl)) flags.push("software_gpu");
  if (ua && ctx.headerUa && ua !== ctx.headerUa) flags.push("ua_mismatch");
  if (Number(s.langs) === 0) flags.push("no_languages");
  if (Number(s.ow) === 0 && Number(s.oh) === 0) flags.push("zero_window");
  if (Number(s.plugins) === 0 && /Chrome\//.test(ctx.headerUa) && !/Mobile|Android/i.test(ctx.headerUa)) flags.push("no_plugins_desktop_chrome");
  // The solver counts nonces up from 0, so `attempts` hashes were computed in `ms`. A browser does at most a few
  // million SHA-256/s; a much higher rate means a native solver (GPU/C) did the work, not the page.
  const ms = Number(s.ms);
  if (Number.isFinite(ms) && ms >= 0 && ctx.attempts >= 50_000 && ctx.attempts / Math.max(ms, 1) > 20_000) flags.push("native_speed_solver");
  let keep = 1;
  for (const f of flags) keep *= 1 - (W[f] ?? 0.1);
  return { risk: Math.round((1 - keep) * 100) / 100, flags };
}

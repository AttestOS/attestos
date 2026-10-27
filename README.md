# AttestOS

Invisible bot verification for sign-up, login and contact forms. A small proof-of-work check runs in the visitor's browser, and your server verifies the resulting token once. The verify call has the same shape as reCAPTCHA's siteverify. Paid modules add risk signals, Private Access Tokens (RFC 9576–9578), passkeys and per-crawler AI policy (AgentPass).

**Live:** https://attestos-edge.attestos.workers.dev · [Docs](https://attestos-edge.attestos.workers.dev/docs/) · [Pricing](https://attestos-edge.attestos.workers.dev/pricing/) · [Free scanner](https://attestos-edge.attestos.workers.dev/scanner/)

```html
<script src="https://attestos-edge.attestos.workers.dev/v1/attestos.js" async defer></script>
<form method="post" action="/signup">
  …
  <div class="attestos" data-sitekey="ao_site_…"></div>
  <button>Sign up</button>
</form>
```

```js
const v = await fetch("https://attestos-edge.attestos.workers.dev/api/siteverify", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ secret: process.env.ATTESTOS_SECRET, response: req.body["attestos-response"] }),
}).then((r) => r.json());
if (!v.success) return res.status(400).send("Bot check failed");
```

## What it does, and what it doesn't

- Proof-of-work makes every automated submission cost CPU time. It doesn't prove identity: keep your own rate limits, and use the risk score or passkeys where it matters.
- Tokens are single-use, last 5 minutes, and are bound to your site key and domain. The server chooses the difficulty; clients can't lower it.
- AgentPass checks crawler claims against the IP ranges operators publish (Google, Bing, OpenAI, Perplexity, Apple). Operators without published ranges are classified by user agent only and reported as `verified: null`.

## Repository layout

| Path | What |
|---|---|
| `worker/` | The Cloudflare Worker (TypeScript): verification API, portal and owner-console APIs, Whop webhook, scanner, outreach, crons. Tests are in `worker/test` (vitest + sql.js D1). |
| `worker/migrations/` | D1 schema. |
| `site-src/` → `site/` | Static pages. Run `python3 scripts/build-site.py` after editing `site-src/` (CI checks this). `site/v1/attestos.js` is the widget. |
| `scripts/prospects.mjs` | Daily GitHub Action that finds sites showing a *visible* CAPTCHA and publishing a role contact address. |
| `scripts/owner-password.mjs` | Generates `OWNER_PASSWORD_HASH` for the owner console. |

## Develop

```sh
npm ci
npm run check                      # tsc + vitest
cd worker && npx wrangler d1 migrations apply attestos --local && npx wrangler dev
```

Put `APP_SECRET`, `OWNER_PASSWORD_HASH` and `SITE_URL=http://localhost:8787` in `worker/.dev.vars`.

## Deploy

Pushes to `main` run `.github/workflows/deploy.yml`, which applies the D1 migrations and runs `wrangler deploy`. It needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The Worker secrets are listed at the bottom of `worker/wrangler.toml`. The project runs on the Cloudflare free plan and stays within a self-imposed 20% of the account's daily D1 quota (`D1_WRITE_BUDGET` / `D1_READ_BUDGET`).

## Security

Report vulnerabilities through [GitHub security advisories](https://github.com/AttestOS/attestos/security/advisories/new) or the contact in `/.well-known/security.txt`.

Licensed under Apache-2.0 (see `LICENSE`).

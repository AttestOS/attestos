# Distribution mesh: account and secret checklist

The press (`press/auto.py`, run by `.github/workflows/press.yml`) is the STPi/TightBucket distribution mesh adapted to
AttestOS: one midday slot a day (cut from four on 2026-11-01 to keep GitHub Actions under 10-15 minutes a day), value posts plus at most one promo per rail per day, a weekly long-form essay, replies, a
card image on every post, and every link tracked through `/go/<key>?src=<rail>-<topic>` (clicks per destination and
rail show up in the owner console's **Mesh** tab).

What it writes about: four readers under one roof, each with its own track in `press/topics.json` (regenerate with
`python3 press/make_topics.py`): online stores (card testing, credential stuffing, fake accounts), SaaS founders
(signup abuse, server-side verification, passkeys), publishers (AI-crawler rules, crawler verification, HTTP 402) and
agencies (contact-form spam, client handover). The voice and the only numbers it may state are in `press/voice.md`;
prices and limits come from `brand/brand.json` (a Worker test keeps it equal to `worker/src/plans.ts`), and the
editor rejects any other price, limit, or claim such as "stops all bots".

**Everything is armed and nothing posts yet.** Each rail switches itself on the first slot after its keys exist, and
stays silent until then: no planning, no burned topics, no alerts.

## 0. Turn the press on (once)

1. **Link the press to the Worker.** This is already done: `AO_PRESS_TOKEN` is set both as a GitHub secret and as a
   Worker secret.
2. **Add keys for at least one rail** (sections below).
   - Option A: GitHub, under repo → Settings → Secrets and variables → Actions → *New repository secret*. Use the
     name exactly as written below.
   - Option B: the owner console's **Mesh** tab, under *Rail keys*. Keys are stored encrypted and are write-only. A GitHub
     secret with the same name wins.
3. **Set the switch.** Add the repo **variable** `PRESS_ENABLED` = `1` (Settings → Secrets and variables →
   Actions → *Variables*). Until then scheduled runs are skipped at 0 Actions minutes.
4. **Optional: check it first.** Actions → *press* → *Run workflow* with mode `dry` plans and validates without
   posting. The log line `press secrets present:` lists what the run can see, by name only.

The owner console **Mesh** tab can park or resume any rail, change any rail's posts per day, and pause the whole press
(*Autopilot* = 0) without touching GitHub.

## 1. Buffer: three accounts per identity (A, B, C)

Buffer's free plan allows 3 channels per account. That is why each identity uses three accounts:

| Account | Channels to connect in Buffer | Company secret | Seller A | Seller B |
|---|---|---|---|---|
| **A** | X, LinkedIn (page or profile), Pinterest | `AO_BUFFER_TOKEN_A_CO` | `AO_BUFFER_TOKEN_A` | `AO_BUFFER_TOKEN_B` |
| **B** | Facebook Page, Instagram (business), Threads | `AO_BUFFER_TOKEN_B_CO` | `AO_BUFFER_TOKEN_A_B` | `AO_BUFFER_TOKEN_B_B` |
| **C** | YouTube, TikTok, Google Business Profile | `AO_BUFFER_TOKEN_C_CO` | `AO_BUFFER_TOKEN_A_C` | `AO_BUFFER_TOKEN_B_C` |

Steps for each account:
1. Sign up at buffer.com with a separate email. Gmail `+` aliases work, e.g. `you+ao-a@gmail.com`.
2. Connect its three channels.
3. Create an API key under Settings → API (developers.buffer.com).
4. Store the key under the secret name in the table above.

**Channel IDs are discovered automatically** from each key, through Buffer's GraphQL `channels` query, cached for
24 hours. Disconnected channels are skipped. To pin one by hand, set `AO_CHANNEL_<RAIL>`, e.g. `AO_CHANNEL_X` or
`AO_CHANNEL_LINKEDIN_A`.

Extra keys for some channels:

| Channel | Extra secret | Notes |
|---|---|---|
| **Pinterest** | `PRESS_PINBOARD` (company), `PRESS_PINBOARD_A` / `PRESS_PINBOARD_B` (sellers) | Each needs a board ID. Without one the Pinterest rail stays off. |
| **YouTube and TikTok** | repo variable `AO_VIDEOS_REPO` (e.g. `AttestOS/attestos-videos`) | Points at a public repo of MP4s with a `manifest.json`. Until it is set, those two rails stay off; Instagram still posts cards. |

## 2. Direct rails (company)

| Rail | Create | Secrets |
|---|---|---|
| Bluesky | Account, then Settings → App passwords | `AO_BSKY_ID` (handle), `AO_BSKY_PASS` (app password). Sellers use `AO_BSKY_ID_A` / `_B` and `AO_BSKY_PASS_A` / `_B`. |
| dev.to (weekly long-form) | Account, then Settings → Extensions → API key | `AO_DEVTO_KEY` |
| Nostr (notes and long-form) | Nothing to sign up for. Generate a key with `python3 -c "import secrets;print(secrets.token_hex(32))"` | `AO_NOSTR_NSEC` (hex or `nsec1…`) |
| Whop public forum (promos) | A Forum app on the AttestOS Whop company, set to public | `WHOP_API_KEY` (company API key), `WHOP_COMPANY_ID` (`biz_…`), `WHOP_PUBLIC_EXP_ID` (`exp_…` of that forum) |
| Whop member forum (recaps) | A members-only Forum app, or a chat channel | `WHOP_PRIVATE_EXP_ID` or `WHOP_PRIVATE_CHANNEL_ID`, plus the two Whop keys above |
| Telegram | A channel, plus a bot from @BotFather added as admin | `AO_TG_BOT_TOKEN`, `AO_TG_CHANNEL` (`@name` or numeric ID) |
| Facebook Page (direct, instead of Buffer B) | A Page access token | `AO_FB_PAGE_TOKEN`, `AO_FB_PAGE_ID` |
| Mastodon | Account on an instance; Preferences → Development → new app with `write:statuses` | `AO_MASTODON_TOKEN`, `AO_MASTODON_INSTANCE` (e.g. `https://mastodon.social`) |
| Discord | A server channel, then Integrations → Webhooks | `AO_DISCORD_PRESS_WEBHOOK` |
| Tumblr | Nothing to create, the app exists: `python3 tumblr_connect.py link`, approve as the blog, then `python3 tumblr_connect.py exchange "<redirect URL>"` | `AO_TUMBLR_CK`, `AO_TUMBLR_CS`, `AO_TUMBLR_TOKEN`, `AO_TUMBLR_TOKEN_SECRET`, `AO_TUMBLR_BLOG` (all five, or the rail stays off) |

## 3. Replies (optional)

The reply engine answers relevant posts on Bluesky, Nostr and dev.to with the keys above. For X mentions, add
`AO_X_REPLY_TOKEN` (an OAuth2 user token with `tweet.read` and `tweet.write`) and `AO_X_REPLY_UID`. Without them,
X replies go out through Buffer account A.

## 4. Writing (optional)

The press writes with **Cloudflare Workers AI** by default, so there is nothing to sign up for here: the two
secrets below point at the same Cloudflare account that already runs the Worker. That account's free daily neurons
are otherwise idle — nothing under `worker/src` calls `env.AI` — and a post costs roughly 10 neurons, so a full day
of slots and replies is a fraction of a single percent of the free allowance.

| Provider | Secret |
|---|---|
| Cloudflare Workers AI (default lane) | `AO_CF_AI_TOKEN` (an API token with *Workers AI: Read*), `AO_CF_AI_ACCOUNT` (the account ID) |

GitHub Models used to be the keyless lane and is **not** one any more: it was retired 2026-07-30
([changelog](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/)) and `models.github.ai` now
answers every path and every token with `200 text/plain OK`, which is a JSON parse error, not a post. The lane is
gone from `author_chain`; leaving it in cost two wasted calls and ~40s per job and made the rail health check report
"authoring failures, nothing landed" for rails that were only ever waiting on an author. Free keys from Groq, Gemini, Mistral, Cohere or Cerebras add faster lanes:

| Provider | Secret |
|---|---|
| Groq | `GROQ_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Cohere | `COHERE_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |

The press uses Cloudflare Workers AI for authoring (see §4); the Worker itself does not, so the product's own
AI path is unaffected. The press gets its own `AO_CF_AI_*` secrets, never the deploy token.

## 5. Budget and the public repository

- **Actions minutes:** this repository is public, so its Actions minutes are free. Each slot is one job of about 1
  to 3 minutes. To post less, remove a `cron` line in `press.yml`; the planner spreads each day's quota over the
  slots that remain.
- **Secrets stay private:** only `press.yml` reads press secrets, and only on schedule or manual dispatch (never on
  pull requests from forks). It reads secrets **by name**, from an explicit list in its "export press secrets"
  step; every name in this guide is already on that list. `AO_OPS_TOKEN` and the Cloudflare keys are not on it. A
  secret with a name that is not listed is ignored. To add one, add an `S_<NAME>: ${{ secrets.<NAME> }}` line.
- **Bluesky logs in fresh each slot.** STPi/TightBucket cached Bluesky sessions in `actions/cache`. That was dropped
  here because caches on a public repo are not a safe place for login tokens.
- **The ledger is public.** It lives on the `press-state` branch (`state.json`, `run.log`, outbox drafts). It holds
  post texts, ids and times. Every press secret value is scrubbed from it before it is written.
- **Worker cost:** each post adds one card upload (one D1 row write) and one image fetch. Cards are purged after 21
  days. Each tracked click is one D1 write, behind the per-IP flood guard.

## 5b. Platforms with no API (copy and paste)

Reddit, Quora, Medium, Tumblr and itch.io have no rail in this press and no write API worth the ban risk.
`press/manual.py` writes a pack of drafts for exactly those five, from the same voice pack, product facts and
topic pool as every automated rail, and runs the press editor over each piece before it lands in the file:

```
python3 press/manual.py pack --topics 2      # -> press/manual/<date>-pack.md
```

In CI it runs on Mondays and writes into the ledger branch (`press-state`, `auto/manual-<date>.md`); a failure there
is a warning, never a failed press run. Topic rotation is remembered in `press/auto/manual.json`, so consecutive
packs move on instead of reworking the same idea.

## 6. What the owner still does by hand

- Create the accounts above. Phone or CAPTCHA checks are the reason this step is manual.
- Read and answer replies and DMs. The press writes first touches and public replies; real conversations are yours.

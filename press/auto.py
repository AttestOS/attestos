#!/usr/bin/env python3
"""AttestOS press autopilot (the STPi distribution mesh, ported as is): an autonomous content creator, no human and no agent in the loop.

One cron-friendly entry point plans, authors (via LLM), validates (hard gates, not vibes)
and publishes both value posts and promo posts across every rail we own:

  Buffer (X, LinkedIn, Pinterest scheduling) · dev.to long-form · Nostr (30023 mirror + notes)
  · Bluesky standalone posts · curated replies on dev.to-no (comments are API-dead),
  nostr and bsky via `autoreply`.

  python3 press/auto.py cycle            # dry run: plan + write + validate, publish nothing
  python3 press/auto.py cycle --live     # the real thing; what cron runs
  python3 press/auto.py cycle --live --draft-longform   # soft start: longform as dev.to draft
  python3 press/auto.py autoreply [--live]               # value replies, capped 2/platform/day
  python3 press/auto.py status           # human-readable state
  python3 press/auto.py health [--live]  # rail-failure alerts (::error::, mint /api/press/notify, alert=1)

Config is pure environment (put it in a 0600 file your cron sources):
  PRESS_LLM_API_KEY   optional quality upgrade (Groq etc); without it the author uses the free
                      keyless Pollinations API, and with neither reachable a live cycle publishes nothing
  PRESS_LLM_BASE      chat-completions URL, default https://api.groq.com/openai/v1/chat/completions
  PRESS_LLM_MODEL     default llama-3.3-70b-versatile
  AO_BUFFER_TOKEN  Buffer personal key   AO_DEVTO_KEY  dev.to key
  AO_NOSTR_NSEC    Nostr private key     AO_BSKY_ID / AO_BSKY_PASS  app password
  PRESS_FAKE_LLM=1    deterministic template author for self-tests (publishes stay gated by --live)

The gate is the point. The author is replaceable; the validators are the product's
reputation. Every rejection, publish and skip is logged to press/auto/run.log and the
state ledger so a human can audit the outbox any week and change nothing else.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import facts  # noqa: E402  (product facts generated from brand/brand.json)
ADIR = Path(os.environ.get("PRESS_AUTO_DIR", str(HERE / "auto")))
STATE_F = ADIR / "state.json"
LOG_F = ADIR / "run.log"
UA = "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0"
IMG_BASE = facts.site_url() + "/covers/"
PINS = ["pin-scanner.jpg", "pin-free-plan.jpg", "pin-agentpass.jpg", "pin-plans.jpg"]   # site/covers/ (press/make_covers.py)
PINBOARD = ""          # no default board: set PRESS_PINBOARD (and _A/_B for sellers) once the board exists


def pinboard_for(rail: str | None) -> str:
    """Board id per rail: GH secrets name them PRESS_PINBOARD/_A/_B (AO_PINBOARD* is the
    legacy local name). Seller rails MUST resolve their own board - falling back to the
    owner board on a seller channel is Buffer's exact "Board not found"."""
    suf = rail_suffix(rail or "")
    return (os.environ.get("PRESS_PINBOARD" + suf, "")
            or os.environ.get("AO_PINBOARD" + suf, "")).strip() or PINBOARD
_F = facts.facts()
LINKS = {"landing": _F["site"] + "/",
         "funnel": _F["site"] + "/",
         "ecom": _F["ecom_url"], "saas": _F["saas_url"], "sales": _F["sales_url"], "agency": _F["agency_url"],
         "tools": _F["tools_url"], "docs": _F["docs_url"], "signup": _F["signup_url"],
         "pricing": _F["pricing_url"],
         "store": facts.billing()["whop_url"]}
# ---- money plumbing ----
# Every link we hand out goes through the Worker's /go/<key>?src=<rail>-<topic>: the click is
# counted per key and source (usage table, monthly) and lands with utm_source set, so the
# cockpit can put clicks next to Whop sales. Codes are short so src stays under 30 chars.
RAIL_CODE = {"x": "x", "linkedin": "l", "pinterest": "p", "bsky": "b", "nostrnote": "n", "nostr30023": "a",
             "devto": "d", "whop_public": "w", "whop_private": "m",
             "telegram": "t", "facebook": "f", "instagram": "v", "threads": "h",
             "youtube": "y", "tiktok": "k", "gbp": "g", "mastodon": "u", "discord": "c"}
# destination name -> the Worker's /go/<key> (worker/src/whop.ts GO_PAGES + paid plan checkouts)
TARGET_CODE = {"landing": "home", "funnel": "home", "ecom": "scanner", "saas": "scanner", "sales": "robots",
               "agency": "scanner", "tools": "scanner", "docs": "docs", "pricing": "pricing", "signup": "signup",
               "store": "pricing",
               "whop_free": "signup", "whop_integrity": "integrity", "whop_agent": "agent",
               "whop_hardware": "hardware", "whop_enterprise": "enterprise"}
CHECKOUT_KEYS = tuple(k for k in TARGET_CODE if k.startswith("whop_"))
# Four audiences under one roof (keys shared with the STPi/TightBucket engine; for AttestOS "sales" is
# publishers and content sites deciding AI-crawler policy). Builders (SaaS, agencies, publishers) read
# LinkedIn, dev.to and the Whop community; store owners live on the visual rails. Every rail still gets every audience over a
# week (the pool falls back to all value topics when an audience has none left today).
AUDIENCES = ("ecom", "saas", "sales", "agency")
OPERATOR_RAILS = ("linkedin", "whop_private", "whop_public")
SEEKER_RAILS = ("x", "pinterest", "bsky", "nostrnote", "devto",
                "telegram", "facebook", "instagram", "threads",
                "youtube", "tiktok", "gbp", "mastodon", "discord")
AUDIENCE_RAILS = {   # value-post routing: which audience's topics a rail draws first
    "sales": ("linkedin", "whop_private", "x", "bsky", "mastodon", "nostrnote"),
    "saas": ("devto", "x", "bsky", "linkedin", "mastodon", "discord", "nostrnote", "telegram"),
    "agency": ("linkedin", "whop_public", "facebook", "threads", "x", "bsky"),
    "ecom": ("pinterest", "instagram", "facebook", "tiktok", "youtube", "threads", "gbp", "telegram"),
}
POINTER_RAILS = ("linkedin", "whop_public", "whop_private")   # value posts here end with one soft pointer
POINTER = {
    "ecom": ("ecom", "Free: see which CAPTCHA your login and checkout pages show shoppers, no signup: {url}"),
    "saas": ("saas", "Free: scan your signup page for visible puzzles and exposed forms, no signup: {url}"),
    "sales": ("sales", "Free: check how your robots.txt treats AI crawlers and generate per-crawler rules: {url}"),
    "agency": ("agency", "Free: scan a client's contact form before the first call, no signup: {url}"),
}
DEFAULT_AUDIENCE = "ecom"
AUDIENCE_BRIEF = {
    "ecom": ("Reader: the owner or developer of an online store (Shopify, WooCommerce or similar). Write "
             "about the abuse that reaches store forms and the cheapest honest defences: card testing at "
             "checkout, credential stuffing on login, fake accounts and promo farming, gift-card guessing, "
             "and the cost a visible puzzle puts on real buyers."),
    "saas": ("Reader: the founder or engineer of a small SaaS product. Write about signup and free-trial "
             "abuse, API key farming, server-side token verification done right (single use, expiry, error "
             "codes), proof of work, risk scores used as a fork, passkeys and adaptive difficulty."),
    "sales": ("Reader: a publisher or content-site owner deciding what AI crawlers may read. Write about "
              "robots.txt rules per crawler, training versus search versus live fetchers, verifying crawlers "
              "by published IP ranges, HTTP 402 paid crawling, agent keys and Private Access Tokens."),
    "agency": ("Reader: an agency owner or freelance developer who builds and maintains client sites. Write "
               "about contact-form spam, server-side verification on every form, key handover and domain "
               "allowlists, accessibility of puzzles, monitoring verify failures and spam incident response."),
}
LIMITS = {"x": 280, "linkedin": 1200, "pinterest": 450, "bsky": 300, "whop_public": 1800,
          "whop_private": 1800, "devto": 2500, "nostrnote": 300, "nostr": 300,   # devto: SHORT articles now too (owner 2026-10-01)
          "telegram": 3000, "facebook": 800, "instagram": 800, "threads": 450,
          "youtube": 900, "tiktok": 400, "gbp": 750, "mastodon": 300, "discord": 1800}
# nostrnote restored 2026-10-01: the devto edit dropped its cap and every authoring call on the
# rail raised KeyError('nostrnote') for two days - llm_error quietly, zero posts, no alert.
# tests/test_limits.py now pins: every planned rail carries a limit; the dry-rail witness
# treats llm_error as an attempt so this class can never be silent again.

# 3-Buffer-Account Architecture (Identical for Company and every Seller):
#   Buffer Account A (slot A / 1): X ('x'), LinkedIn ('linkedin'), Pinterest ('pinterest')
#   Buffer Account B (slot B / 2): Facebook Page ('facebook'), Instagram ('instagram'), Threads ('threads')
#   Buffer Account C (slot C / 3): YouTube ('youtube'), TikTok ('tiktok'), Google Business Profile ('gbp')
BUFFER_ACCOUNT_SLOTS = {
    "x": "A", "linkedin": "A", "pinterest": "A",
    "facebook": "B", "instagram": "B", "threads": "B",
    "youtube": "C", "tiktok": "C", "gbp": "C",
}
BUFFER_FAMILIES = tuple(BUFFER_ACCOUNT_SLOTS.keys())
VIDEO_FAMILIES = ("youtube", "tiktok", "instagram")

SELLER_IDS = ("a", "b")
SELLER_FAMILIES = ("x", "bsky", "linkedin", "pinterest",
                   "facebook", "instagram", "threads",
                   "youtube", "tiktok", "gbp")
SELLER_RAILS = tuple(f"{fam}_{s}" for fam in SELLER_FAMILIES for s in SELLER_IDS)
_RAIL_PLATFORM = {f"{fam}_{s}": fam for fam in SELLER_FAMILIES for s in SELLER_IDS}


def rail_family(ch: str) -> str:
    """The platform family a rail writes as: limits, prompts and publish dispatch follow the family."""
    if ch in _RAIL_PLATFORM:
        return _RAIL_PLATFORM[ch]
    m = re.match(r"^([a-z]+)_([a-z0-9]+)$", ch)
    if m and m.group(1) in SELLER_FAMILIES:
        return m.group(1)
    return ch


def rail_suffix(ch: str) -> str:
    """Per-seller credential env suffix: '_A' for x_a/bsky_a, '_B' for *_b, '' for the owner's rails."""
    m = re.match(r"^([a-z]+)_([a-z0-9]+)$", ch)
    if m and m.group(1) in SELLER_FAMILIES:
        return "_" + m.group(2).upper()
    return "_A" if ch.endswith("_a") else "_B" if ch.endswith("_b") else ""


def buffer_slot(ch: str) -> str:
    """Which of the 3 Buffer accounts ('A', 'B', or 'C') routes this rail."""
    return BUFFER_ACCOUNT_SLOTS.get(rail_family(ch), "A")


def buffer_token_for(ch: str) -> str:
    """Resolve the Buffer API token for a rail across the 3-Buffer-account architecture:
    - Buffer Account A (slot A / 1): X, LinkedIn, Pinterest
    - Buffer Account B (slot B / 2): Facebook Page, Instagram, Threads
    - Buffer Account C (slot C / 3): YouTube, TikTok, Google Business Profile
    Company rails (suf == '') and Seller rails (suf == '_A', '_B', ...) follow identical routing."""
    suf = rail_suffix(ch)
    slot = buffer_slot(ch)
    num = {"A": "1", "B": "2", "C": "3"}[slot]
    if not suf:
        candidates = [
            f"AO_BUFFER_TOKEN_{slot}_CO",
            f"PRESS_BUFFER_TOKEN_{slot}_CO",
            f"AO_BUFFER_TOKEN_{num}",
            f"PRESS_BUFFER_TOKEN_{num}",
            f"AO_BUFFER_{slot}_TOKEN",
            f"PRESS_BUFFER_{slot}_TOKEN",
        ]
        if slot == "A":
            candidates += ["AO_BUFFER_TOKEN", "PRESS_BUFFER_TOKEN"]
    else:
        candidates = [
            f"AO_BUFFER_TOKEN{suf}_{slot}",
            f"PRESS_BUFFER_TOKEN{suf}_{slot}",
            f"AO_BUFFER_TOKEN{suf}_{num}",
            f"PRESS_BUFFER_TOKEN{suf}_{num}",
            f"AO_BUFFER_{slot}_TOKEN{suf}",
            f"PRESS_BUFFER_{slot}_TOKEN{suf}",
        ]
        if slot == "A":
            candidates += [f"AO_BUFFER_TOKEN{suf}", f"PRESS_BUFFER_TOKEN{suf}"]
    for k in candidates:
        val = os.environ.get(k, "").strip()
        if val:
            return val
    return ""


def _buffer_channel_env(ch: str) -> str:
    """Check explicit AO_CHANNEL_<CH> / PRESS_CHANNEL_<CH> env vars for a rail."""
    up = ch.upper()
    for k in (f"AO_CHANNEL_{up}", f"PRESS_CHANNEL_{up}"):
        v = os.environ.get(k, "").strip()
        if v:
            return v
    return ""


LIMITS.update({r: LIMITS[rail_family(r)] for r in SELLER_RAILS})
RAIL_CODE.update({r: RAIL_CODE.get(rail_family(r), "s") for r in SELLER_RAILS})


def _rail_armed(ch: str) -> bool:
    """A seller rail plans only when its own credentials exist (2026-09-28 press bug: x_a/x_b/bsky_b
    planned slots while their secrets were still unset, burned a value topic and tripped the 48h
    health guard for 'the seller has no account yet'). The owner's Buffer Account A rails always
    plan; regional & Buffer B/C rails plan when their credentials are present."""
    if ch == "telegram":
        return bool(os.environ.get("AO_TG_BOT_TOKEN", "").strip()
                    and os.environ.get("AO_TG_CHANNEL", "").strip())
    if ch == "facebook":
        # Armed via either Company Buffer Account B OR direct Facebook Page Graph API
        has_fb_graph = bool(os.environ.get("AO_FB_PAGE_TOKEN", "").strip()
                            and os.environ.get("AO_FB_PAGE_ID", "").strip())
        has_fb_buffer = bool(buffer_token_for("facebook") and _buffer_channel_known("facebook"))
        return has_fb_graph or has_fb_buffer
    if ch == "mastodon":
        return bool(os.environ.get("AO_MASTODON_TOKEN", "").strip())
    if ch == "discord":
        return bool(os.environ.get("AO_DISCORD_PRESS_WEBHOOK", "").strip())
    if ch == "whop_private":
        # 2026-10-27 (audit F10): with no explicit target the rail auto-discovered, failed auth /
        # found no channel on every slot and burned value topics. Plan it only once the owner
        # sets PRESS_WHOP_CHANNEL or PRESS_WHOP_PRIVATE_EXP (and a Whop key) in repo secrets.
        return bool(_whop_keys() and os.environ.get("WHOP_COMPANY_ID", "").strip()
                    and (os.environ.get("WHOP_PRIVATE_CHANNEL_ID", "").strip()
                         or os.environ.get("WHOP_PRIVATE_EXP_ID", "").strip()))
    if ch == "whop_public":
        return bool(_whop_keys() and os.environ.get("WHOP_COMPANY_ID", "").strip()
                    and os.environ.get("WHOP_PUBLIC_EXP_ID", "").strip())
    # AttestOS starts with no accounts at all (owner 2026-10-27: "build it armed"), so company
    # rails arm exactly like seller rails: only when their own credentials exist.
    suf = rail_suffix(ch)
    fam = rail_family(ch)
    if fam in BUFFER_FAMILIES:
        if not buffer_token_for(ch) or not _buffer_channel_known(ch):
            return False
        if fam == "pinterest":
            return bool(pinboard_for(ch))
        if fam in ("youtube", "tiktok"):
            return bool(VIDEOS_REPO)
        return True
    if fam == "bsky":
        return bool(os.environ.get("AO_BSKY_ID" + suf, "").strip()
                    and os.environ.get("AO_BSKY_PASS" + suf, "").strip())
    if fam == "devto":
        return bool(os.environ.get("AO_DEVTO_KEY", "").strip())
    if fam in ("nostrnote", "nostr30023"):
        return bool(os.environ.get("AO_NOSTR_NSEC", "").strip())
    return False


def _buffer_channel_known(ch: str) -> bool:
    """No network: an explicit channel env, or a channel already discovered this run
    (prime_buffer_discovery runs once at the top of every cycle)."""
    if _buffer_channel_env(ch):
        return True
    tok = buffer_token_for(ch)
    key = hashlib.sha256(tok.encode()).hexdigest()[:16] if tok else ""
    svc = BUFFER_SERVICE.get(rail_family(ch), rail_family(ch))
    return bool(key and svc in (_BUFFER_DISCOVERED.get(key) or {}))


def prime_buffer_discovery(st: dict) -> None:
    """Discover channels for every Buffer token that exists (<= 9: A/B/C x company/sellers),
    24h-cached in state, so the planner's arming check stays offline."""
    seen = set()
    for ch in tuple(BUFFER_FAMILIES) + tuple(r for r in SELLER_RAILS if rail_family(r) in BUFFER_FAMILIES):
        tok = buffer_token_for(ch)
        if tok and tok not in seen:
            seen.add(tok)
            buffer_discover(tok, st)


HYPE = re.compile(r"revolutionary|game[- ]changing|game changer|cutting[- ]edge|seamless|unleash|supercharge|\b10x\b|magic|delv\w+|thrilled|revolutionize", re.I)
LEAKY = ("apik_", "ghp_", "github_pat_", "sk_live", "sk-av", "Bearer ", "nsec", "xpub", "BEGIN ", "AKIA", "whop_")
STATS = re.compile(r"\b\d{1,3}(?:\.\d+)?\s?%|\bstud(?:y|ies)\s+(?:show|says|suggest|finds)|research\s+(?:shows|suggests)|according to (?:a |an )?(?:survey|study)", re.I)
PRODUCT = re.compile(r"attestos|whop\.com|\$\d", re.I)
# (owner 2026-10-04: "the posts have nothing to do with our outfit") Value pins were generic
# tips. The AttestOS Pinterest reader is a store/site owner saving page-design ideas -
# frame value pins as page-design craft. Promo pins were already product-led.
PIN_VALUE_FRAME = (
    "Pinterest frame: the reader saving this pin runs an online store or a small business site and "
    "wants forms that keep bots out without annoying people. Write the topic as a form-security lesson "
    "(the signup form, the login page, the checkout, the contact form, robots.txt) - concrete, visual, "
    "skimmable; never a generic security scare. No product talk, no links.\n")
GAP_LONGFORM_DAYS = 7
VALUE_PLATFORMS = ("x", "linkedin", "pinterest", "bsky", "nostrnote", "devto",
                 "whop_private", "telegram", "facebook", "instagram", "threads",
                 "youtube", "tiktok", "gbp", "mastodon", "discord") + SELLER_RAILS
BUFFER_KEY = {"x": "twitter"}           # autopilot rail name -> Buffer service name


_CAD_OVERRIDE: dict = {}       # owner-console rail overrides (mint /api/press/mesh-config), merged below


def load_cadence() -> dict:
    f = HERE / "cadence.json"
    base = {"x": {"per_day": 2}, "linkedin": {"per_day": 1}, "pinterest": {"per_day": 2},
            "bsky": {"per_day": 2}, "nostrnote": {"per_day": 2}, "whop_private": {"per_day": 1},
            "whop_public": {"per_day": 1}, "promo_per_day": 1, "promo_min_gap_days": 3,
            "run_target": 4, "longform_days": 7, "reply_per_day": 4, "topic_max_rails": 3}
    if f.exists():
        try: base.update(json.loads(f.read_text()))
        except Exception: pass
    # 2026-10-13 (owner): the owner console retunes any rail live (park / resume / per_day)
    # without a code push - mint stores the overrides, the cycle merges them here.
    # 2026-10-14 (owner): settings-page cadence knobs (cadence:* keys) arrive as plain
    # ints and override the non-rail cadence fields (reply_per_day, run_target, ...).
    for rail, o in _CAD_OVERRIDE.items():
        if isinstance(o, dict):      # rail override (mesh page)
            if rail in base and isinstance(base[rail], dict) and o.get("per_day") is not None:
                try: base[rail]["per_day"] = max(0, int(o["per_day"]))
                except (TypeError, ValueError): pass
        elif rail in base and not isinstance(base[rail], dict):   # knob (settings page)
            try: base[rail] = type(base[rail])(o)
            except (TypeError, ValueError): pass
    return base


def fetch_runtime_settings(st: dict) -> None:
    """Owner console settings (owner 2026-10-14: 'I should not open the repo to change a
    key'). Pulls /api/press/settings from mint with the claim token and applies: env-shaped keys
    fill any env var that is unset OR empty (a real GitHub secret keeps priority), cadence:
    keys become _CAD_OVERRIDE knobs merged by load_cadence. Never fatal: unreachable
    settings leave the environment exactly as it was."""
    base_url = os.environ.get("AO_SITE_URL", "https://attestos-edge.attestos.workers.dev")
    tok = os.environ.get("AO_PRESS_TOKEN", "").strip()
    if not tok:
        return
    try:
        req = urllib.request.Request(base_url.rstrip("/") + "/api/press/settings",
                                     headers={"Authorization": f"Bearer {tok}", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            settings = (json.loads(r.read() or b"{}").get("settings") or {})
    except Exception as exc:  # noqa: BLE001
        log("settings_unreachable", err=repr(exc)[:120])
        return
    n_env = n_cad = 0
    for name, value in settings.items():
        if str(name).startswith("cadence:"):
            _CAD_OVERRIDE[str(name).split(":", 1)[1]] = value
            n_cad += 1
        elif re.fullmatch(r"[A-Z][A-Z0-9_]{1,59}", str(name)) and isinstance(value, str) and value:
            if not os.environ.get(name, "").strip():
                os.environ[name] = value
                n_env += 1
    if n_env or n_cad:
        log("settings_applied", env=n_env, cadence=n_cad)


def fetch_mesh_overrides(st: dict) -> None:
    """Pull the owner's mesh overrides from mint at cycle start (claim-token authed, same
    secret the image host uses). Never fatal: mint unreachable = cadence.json rules the day."""
    base_url = os.environ.get("AO_SITE_URL", "").strip()
    tok = os.environ.get("AO_PRESS_TOKEN", "").strip()
    if not base_url or not tok:
        return
    try:
        req = urllib.request.Request(base_url.rstrip("/") + "/api/press/mesh-config",
                                     headers={"Authorization": f"Bearer {tok}", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            rails = (json.loads(r.read() or b"{}").get("rails") or {})
    except Exception as exc:  # noqa: BLE001
        log("mesh_config_unreachable", err=repr(exc)[:120])
        return
    until_far = "2099-01-01T00:00:00+00:00"
    for rail, o in rails.items():
        if not isinstance(o, dict):
            continue
        if o.get("parked") is True:
            st.setdefault("rail_off", {})[rail] = until_far
            st.setdefault("rail_parked", {})[rail] = {"until": until_far,
                                                      "reason": "parked from the owner console (mesh page)"}
        elif o.get("parked") is False:
            st.get("rail_off", {}).pop(rail, None)
            if (st.get("rail_parked", {}).get(rail) or {}).get("reason", "").startswith("parked from the owner console"):
                st.get("rail_parked", {}).pop(rail, None)
        if o.get("per_day") is not None:
            _CAD_OVERRIDE[rail] = {"per_day": o.get("per_day")}
    if rails:
        log("mesh_overrides_applied", rails=json.dumps(rails)[:200])


# ---------- config + state ----------

def now() -> datetime:
    return datetime.now(timezone.utc)


def _sessions_file() -> Path | None:
    """Bluesky session tokens live OUTSIDE the committed ledger (audit F37: state.json on the
    press-state branch carried live accessJwt/refreshJwt). press.yml keeps this file in an
    actions/cache entry; unset = sessions are not persisted (a fresh login per run)."""
    p = os.environ.get("AO_BSKY_SESSIONS_FILE", "").strip()
    return Path(p) if p else None


def load_state() -> dict:
    if STATE_F.exists():
        st = json.loads(STATE_F.read_text())
    else:
        st = {"used": {}, "published": [], "channel_last": {}, "last_longform": None,
              "ledger": [], "reply_targets": [], "reply_day": {}, "pin_i": 0,
              "day_counts": {}, "runs_today": {}, "used_ts": {}}
    st.pop("bsky_sessions", None)          # never trust/keep tokens that leaked into the ledger
    sf = _sessions_file()
    if sf and sf.exists():
        try:
            st["bsky_sessions"] = json.loads(sf.read_text()) or {}
        except (OSError, ValueError):
            pass
    return st


def save_state(st: dict) -> None:
    ADIR.mkdir(exist_ok=True)
    out = dict(st)
    sessions = out.pop("bsky_sessions", None)
    STATE_F.write_text(redact(json.dumps(out, indent=1)))
    sf = _sessions_file()
    if sf and sessions is not None:
        # refresh tokens only: an accessJwt lives ~2 h and runs are 4 h apart
        keep = {k: {"did": v.get("did", ""), "refreshJwt": v.get("refreshJwt", "")}
                for k, v in sessions.items() if isinstance(v, dict) and v.get("refreshJwt")}
        sf.parent.mkdir(parents=True, exist_ok=True)
        sf.write_text(json.dumps(keep))
        try:
            sf.chmod(0o600)
        except OSError:
            pass


# ---------- the promo kit (owner 2026-10-14: 40 ready-made materials) ----------

_KIT_CACHE: list | None = None


def load_promo_kit() -> list[dict]:
    """press/promo-kit/promo-kit.json — 40 ready-to-post promo materials, every channel
    format, pre-rendered cards. Missing file = empty kit = authored promo as before."""
    global _KIT_CACHE
    if _KIT_CACHE is None:
        f = HERE / "promo-kit" / "promo-kit.json"
        try:
            _KIT_CACHE = json.loads(f.read_text())["materials"] if f.exists() else []
        except Exception as e:  # noqa: BLE001 — a broken kit must never break the cycle
            log("kit_load_error", err=repr(e)[:120])
            _KIT_CACHE = []
    return _KIT_CACHE


def take_kit(st: dict, ch: str) -> dict | None:
    """Next kit material this rail has not posted. Marks it used on take (a failed send
    burns it on that rail: no retry loops, no identical re-posts) and logs; None when the
    rail has burned the whole kit and promo falls back to authored copy."""
    kit = load_promo_kit()
    if not kit:
        return None
    used = st.setdefault("kit_used", {}).setdefault(ch, [])
    mat = next((m for m in kit if m["id"] not in used), None)
    if not mat:
        return None
    used.append(mat["id"])
    log("kit_used", rail=ch, material=mat["id"])
    return mat


# ---------- video subrepo (AO_VIDEOS_REPO) for Buffer Account C & Reels ----------

VIDEOS_REPO = os.environ.get("AO_VIDEOS_REPO", "").strip()   # e.g. AttestOS/attestos-videos; unset = video rails skip
VIDEOS_RAW_BASE = f"https://raw.githubusercontent.com/{VIDEOS_REPO}/main/"
_VIDEO_CACHE: list[dict] | None = None


def load_video_catalog(force: bool = False) -> list[dict]:
    """Load videos from the AO_VIDEOS_REPO subrepo.
    1. Checks local checkout directory (AO_VIDEOS_DIR or press/videos-repo or /tmp/attestos-videos):
       reads manifest.json if present AND auto-discovers any uploaded .mp4/.mov/.webm files
       (plus optional sidecar .txt/.md captions) so the user can drop video files straight
       into the subrepo without editing manifest.json.
    2. Falls back to fetching manifest.json from raw.githubusercontent.com if no local checkout exists."""
    global _VIDEO_CACHE
    if _VIDEO_CACHE is not None and not force:
        return _VIDEO_CACHE
    items_by_file: dict[str, dict] = {}
    candidates = [
        Path(os.environ["AO_VIDEOS_DIR"]) if os.environ.get("AO_VIDEOS_DIR") else None,
        HERE / "videos-repo",
        Path("/tmp/attestos-videos"),
        HERE.parent / "landing" / "videos",
    ]
    vdir = next((d for d in candidates if d and d.is_dir() and (any(d.rglob("*.mp4")) or (d / "manifest.json").is_file())), None)
    if vdir is not None:
        mf = vdir / "manifest.json"
        if mf.is_file():
            try:
                raw_m = json.loads(mf.read_text())
                for v in raw_m.get("videos", []):
                    rel = str(v.get("file") or "").lstrip("/")
                    if not rel or "onboarding" in rel.lower():
                        continue
                    if rel.startswith("AttestOS-Promo-Short-"):
                        rel_repo = f"shorts/{rel}"
                    elif rel == "AttestOS-Promo-Long-Complete.mp4":
                        rel_repo = f"long/{rel}"
                    else:
                        rel_repo = rel
                    url = str(v.get("url") or "")
                    if not url or not url.startswith("https://"):
                        url = VIDEOS_RAW_BASE + rel_repo
                    items_by_file[rel_repo] = {
                        "id": str(v.get("id") or Path(rel_repo).stem.lower()),
                        "file": rel_repo,
                        "url": url,
                        "title": str(v.get("title") or Path(rel_repo).stem.replace("-", " ")),
                        "caption": str(v.get("caption") or v.get("description") or ""),
                        "kind": str(v.get("kind") or ("short" if rel_repo.startswith("shorts/") else "long")),
                        "persona": "company" if rel_repo.startswith("company/") else (
                            "_A" if rel_repo.startswith("seller-a/") else ("_B" if rel_repo.startswith("seller-b/") else "all")
                        ),
                    }
            except Exception as exc:
                log("video_manifest_err", err=repr(exc)[:120])
        for p in sorted(vdir.rglob("*")):
            if not p.is_file() or p.suffix.lower() not in (".mp4", ".mov", ".webm"):
                continue
            rel = p.relative_to(vdir).as_posix()
            if "onboarding" in rel.lower() or "internal-vault" in rel.lower():
                continue
            repo_rel = f"shorts/{p.name}" if p.name.startswith("AttestOS-Promo-Short-") and "/" not in rel else (
                f"long/{p.name}" if p.name == "AttestOS-Promo-Long-Complete.mp4" and "/" not in rel else rel
            )
            if repo_rel in items_by_file:
                continue
            caption = ""
            for ext in (".txt", ".md"):
                sc = p.with_suffix(ext)
                if sc.is_file():
                    try:
                        caption = sc.read_text(encoding="utf-8", errors="replace").strip()
                        break
                    except Exception:
                        pass
            items_by_file[repo_rel] = {
                "id": p.stem.lower(),
                "file": repo_rel,
                "url": VIDEOS_RAW_BASE + repo_rel,
                "title": p.stem.replace("-", " "),
                "caption": caption,
                "kind": "short" if (repo_rel.startswith("shorts/") or "short" in p.stem.lower()) else "long",
                "persona": "company" if repo_rel.startswith("company/") else (
                    "_A" if repo_rel.startswith("seller-a/") else ("_B" if repo_rel.startswith("seller-b/") else "all")
                ),
            }
    if not items_by_file and VIDEOS_REPO and os.environ.get("PRESS_FAKE_LLM") != "1":
        try:
            req = urllib.request.Request(VIDEOS_RAW_BASE + "manifest.json", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                raw_m = json.loads(r.read() or b"{}")
            for v in raw_m.get("videos", []):
                rel = str(v.get("file") or "").lstrip("/")
                if not rel:
                    continue
                items_by_file[rel] = {
                    "id": str(v.get("id") or Path(rel).stem.lower()),
                    "file": rel,
                    "url": str(v.get("url") or (VIDEOS_RAW_BASE + rel)),
                    "title": str(v.get("title") or Path(rel).stem.replace("-", " ")),
                    "caption": str(v.get("caption") or v.get("description") or ""),
                    "kind": str(v.get("kind") or ("short" if rel.startswith("shorts/") else "long")),
                    "persona": "all",
                }
        except Exception as exc:
            log("video_remote_err", err=repr(exc)[:120])
    _VIDEO_CACHE = list(items_by_file.values())
    return _VIDEO_CACHE


def take_video(st: dict, ch: str) -> dict | None:
    """Select the next video from AO_VIDEOS_REPO for a video rail (YouTube, TikTok, Instagram, etc.)."""
    cat = load_video_catalog()
    if not cat:
        return None
    suf = rail_suffix(ch)
    want_persona = "company" if not suf else suf
    eligible = [v for v in cat if v.get("persona", "all") in ("all", want_persona)]
    if not eligible:
        eligible = list(cat)
    fam = rail_family(ch)
    if fam in ("tiktok", "instagram", "threads"):
        shorts = [v for v in eligible if v.get("kind") == "short"]
        if shorts:
            eligible = shorts
    used = st.setdefault("video_used", {}).setdefault(ch, [])
    pick = next((v for v in eligible if v["id"] not in used), None)
    if pick is None:
        used.clear()
        pick = eligible[0]
    used.append(pick["id"])
    log("video_selected", rail=ch, video=pick["id"], url=pick["url"])
    return pick


KIT_FMT_FALLBACK = {
    "nostrnote": "bsky", "whop_private": "whop_public", "mastodon": "bsky", "discord": "telegram",
    "instagram": "facebook", "threads": "x", "youtube": "linkedin", "tiktok": "x", "gbp": "facebook",
}


_SECRET_ENV = re.compile(r"^(AO_|PRESS_|WHOP_|GROQ_|GEMINI_|MISTRAL_|COHERE_|CEREBRAS_|GH_MODELS_)")
_NOT_SECRET = re.compile(r"(_ID|_URL|_REPO|_FILE|_HANDLE|_USER|_BOARD|_INSTANCE|_ENABLED|_PER_RUN|_DIR)(_[A-Z])?$|PINBOARD|CHANNEL_")


def redact(text: str) -> str:
    """The ledger (run.log, state.json) lives on a PUBLIC branch: scrub every press secret value out of it, whatever
    an exception message or URL happened to carry (a Telegram bot token rides in its API path, for one)."""
    for k, v in os.environ.items():
        if v and len(v) >= 8 and _SECRET_ENV.match(k) and not _NOT_SECRET.search(k) and v in text:
            text = text.replace(v, "[redacted]")
    return text


def log(event: str, **kw) -> None:
    ADIR.mkdir(exist_ok=True)
    line = {"ts": now().isoformat(timespec="seconds"), "ev": event, **kw}
    with LOG_F.open("a") as f:
        f.write(redact(json.dumps(line)) + "\n")


# ---------- the author ----------

def load_topics() -> list:
    return json.loads(facts.render((HERE / "topics.json").read_text()))


def system_prompt() -> str:
    return facts.render((HERE / "voice.md").read_text())


def _strip_fences(t: str) -> str:
    t = t.strip()
    if t.startswith("```"):
        t = "\n".join(t.splitlines()[1:])
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


def _pollinate(system: str, user: str) -> str:
    """Keyless free text API (the rail Cedar Loom itself falls back to)."""
    body = json.dumps({"model": "openai", "messages": [
        {"role": "system", "content": system}, {"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://text.pollinations.ai/", data=body,
                                 headers={"Content-Type": "application/json", "User-Agent": UA})
    return _strip_fences(urllib.request.urlopen(req, timeout=100).read().decode())


def _openai_like(url: str, key: str, model: str, system: str, user: str) -> str:
    """Any OpenAI-compatible chat endpoint. No temperature: the reasoning models reject it."""
    body = json.dumps({"model": model, "max_completion_tokens": 3800,
                       "messages": [{"role": "system", "content": system},
                                    {"role": "user", "content": user}]}).encode()
    req = urllib.request.Request(url, data=body,
                                 headers={"Authorization": f"Bearer {key}",
                                          "Content-Type": "application/json", "User-Agent": UA})
    r = json.loads(urllib.request.urlopen(req, timeout=120).read())
    out = _strip_fences(r["choices"][0]["message"]["content"] or "")
    if not out:                       # reasoning models can spend every token thinking
        raise RuntimeError(f"{model}: empty content")
    return out


def _cohere_like(url: str, key: str, model: str, system: str, user: str) -> str:
    body = json.dumps({"model": model, "message": user, "preamble": system,
                       "max_tokens": 3800, "temperature": 0.75}).encode()
    req = urllib.request.Request(url, data=body,
                                 headers={"Authorization": f"Bearer {key}",
                                          "Content-Type": "application/json", "User-Agent": UA})
    return _strip_fences(json.loads(urllib.request.urlopen(req, timeout=120).read())["text"])


# Order = what each free tier actually delivers, behavior-verified 2026-09-20. A provider
# that 429s/503s mid-day just falls through to the next; the day's budget survives.
# Cerebras sits last on purpose: the key authenticates but chat is billing-gated (402) -
# add the secret whenever billing is on and it joins the front of the queue's tail.
AUTHOR_PROVIDERS = (
    ("groq", "GROQ_API_KEY", "openai", "https://api.groq.com/openai/v1/chat/completions",
     ("openai/gpt-oss-120b", "openai/gpt-oss-20b")),
    ("gemini", "GEMINI_API_KEY", "openai",
     "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
     ("gemini-flash-lite-latest", "gemini-flash-latest")),
    ("mistral", "MISTRAL_API_KEY", "openai", "https://api.mistral.ai/v1/chat/completions",
     ("ministral-8b-2512", "ministral-14b-2512")),
    ("cohere", "COHERE_API_KEY", "cohere", "https://api.cohere.com/v1/chat",
     ("command-a-03-2025",)),
    ("cerebras", "CEREBRAS_API_KEY", "openai", "https://api.cerebras.ai/v1/chat/completions",
     ("gpt-oss-120b",)),
)


def author_chain() -> list:
    """Providers that have a key in the environment, legacy single-endpoint config first."""
    chain = []
    if os.environ.get("PRESS_LLM_API_KEY", "").strip():
        chain.append(("custom", "openai",
                      os.environ.get("PRESS_LLM_BASE", "https://api.groq.com/openai/v1/chat/completions"),
                      (os.environ.get("PRESS_LLM_MODEL", "llama-3.3-70b-versatile"),),
                      os.environ["PRESS_LLM_API_KEY"].strip()))
    for name, env, style, url, models in AUTHOR_PROVIDERS:
        key = os.environ.get(env, "").strip()
        if key:
            chain.append((name, style, url, models, key))
    # Two more free LLM lanes scavenged from the owner's Apps Script "Shortlist Press Factory"
    # (doc 27): both sit on infrastructure the outfit already uses at $0. GitHub Models wants a
    # classic PAT (the auto GITHUB_TOKEN has no models scope) - sandbox-unverifiable, so the
    # first CI run's run.log 'author' events are the verdict. Cloudflare AI reuses the D1
    # token + account id; model verified live 2026-09-30.
    gh = os.environ.get("GH_MODELS_TOKEN", "").strip()
    if gh:
        chain.append(("github-models", "openai",
                      "https://models.github.ai/inference/chat/completions",
                      ("openai/gpt-4o-mini", "openai/gpt-4o"), gh))
    cfk = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    cfa = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    if cfk and cfa:
        chain.append(("cloudflare-ai", "openai",
                      f"https://api.cloudflare.com/client/v4/accounts/{cfa}/ai/v1/chat/completions",
                      ("@cf/meta/llama-3.3-70b-instruct-fp8-fast",), cfk))
    return chain


# Provider circuit breaker (scavenged with the lanes above): cross-run memory via state.json
# so a throttled or burned provider stops costing a wasted request on every call. 429 parks
# the lane for an hour; 401/402/403/404 parks it for 24h and raises one alert ("fix or wait
# it out"); three straight soft failures (timeouts, 5xx) park it for an hour. Any success
# clears the entry, so a recovered provider rejoins immediately.
_CB_RATE_S, _CB_DEAD_S, _CB_SOFT_S = 3600, 86400, 3600


def _cb_open(st: dict, name: str) -> bool:
    until = (st.get("llm_cb", {}).get(name) or {}).get("until", 0)
    if until > time.time():
        log("llm_cb_skip", provider=name, resume_in=int(until - time.time()))
        return True
    return False


def _cb_fail(st: dict, name: str, err: Exception) -> None:
    code = getattr(err, "code", None)
    ent = st.setdefault("llm_cb", {}).setdefault(name, {})
    if code == 429:
        kind, span = "rate", _CB_RATE_S
    elif code in (401, 402, 403, 404):
        kind, span = "dead", _CB_DEAD_S
    else:
        ent["fails"] = ent.get("fails", 0) + 1
        if ent["fails"] < 3:
            log("llm_cb_soft", provider=name, fails=ent["fails"], err=repr(err)[:80])
            return
        kind, span = "soft", _CB_SOFT_S
    st["llm_cb"][name] = {"until": time.time() + span, "kind": kind, "code": code or 0}
    log("llm_cb", provider=name, kind=kind, held=span, code=code or 0)


_AUTHOR_CALLS = 0


def _reserve_author_call():
    global _AUTHOR_CALLS
    limit = int(os.environ.get("AO_PRESS_LLM_CALLS_PER_RUN", "100"))
    if not 0 <= limit <= 100 or _AUTHOR_CALLS >= limit:
        raise RuntimeError("Press author request ceiling reached for this process")
    _AUTHOR_CALLS += 1


def llm(prompt: str, kind: str, topic: dict, channel: str, st: dict | None = None) -> str:
    if os.environ.get("PRESS_FAKE_LLM") == "1":
        return compose_fake(kind, topic, channel)
    brief = AUDIENCE_BRIEF.get(topic.get("audience", DEFAULT_AUDIENCE), "")
    user_prompt = (
        f"Topic to author (JSON):\n{json.dumps(topic)}\n\n"
        # editor feedback from a rejected attempt: the deterministic gate's exact words,
        # front and centre (was buried in a topic beat before 2026-10-01 - the model read
        # "fix the shape", reworded the stat, and failed identically: devto sat silent)
        + (f"{prompt.strip()}\n\n" if prompt.strip() else "")
        + (f"{brief}\n" if brief and kind != "reply" else "")
        + (PIN_VALUE_FRAME if kind == "value" and rail_family(channel) == "pinterest" else "")
        + f"Deliverable kind: {kind}\n"
        + (f"Target channel: {channel} (platform: {rail_family(channel)}; HARD LIMIT "
              f"{LIMITS.get(channel) or LIMITS[rail_family(channel)]} characters -"
              f" anything longer is auto-rejected; stay well under it).\n"
          if kind != "longform" else f"Target channel: {channel}\n")
        + ("Write ONLY the article body markdown (no title line, no code fences)."
           if kind == "longform" else
           ("Reply to the quoted post by building on its mechanism, adding one thing it missed, and conceding what it gets right. No product talk, no links, 120-300 characters, one idea."
            if kind == "reply" else
            (f"Write a 120-300 WORD markdown recap of this topic for the AttestOS member community forum. Owner-to-members register (members are store owners, SaaS founders, publishers and agencies who protect their forms and decide what crawlers may read): honest status, what changed, what it means for their sites and their week. It may reference AttestOS and link to the product page {LINKS['funnel']} at most twice."
             if channel == "whop_private" else "Write ONLY the post text, nothing else."))))
    system = system_prompt()
    fails = []
    for name, style, url, models, key in author_chain():
        if st is not None and _cb_open(st, name):
            continue
        last_err: Exception | None = None
        for model in models:
            try:
                if _AUTHOR_CALLS >= int(os.environ.get("AO_PRESS_LLM_CALLS_PER_RUN", "100")):
                    raise RuntimeError("Press author request ceiling reached for this process")
                fn = _openai_like if style == "openai" else _cohere_like
                _reserve_author_call()
                out = fn(url, key, model, system, user_prompt)
                if st is not None:
                    st.get("llm_cb", {}).pop(name, None)
                log("author", provider=name, model=model, kind=kind, channel=channel)
                return out
            except Exception as e:                      # throttle, outage, empty think-loop
                if "request ceiling" in str(e):
                    raise
                last_err = e
                fails.append(f"{name}/{model}: {type(e).__name__}: {str(e)[:60]}")
        if st is not None and last_err is not None:
            _cb_fail(st, name, last_err)
    if fails:
        log("author_down_to_keyless", attempts=" | ".join(fails)[:400])
    _reserve_author_call()
    return _pollinate(system, user_prompt)


def compose_fake(kind: str, topic: dict, channel: str) -> str:
    """Deterministic template author. Plumbing-grade prose, tests and previews only."""
    t, beats = topic["title"], topic.get("beats", [])
    if kind == "longform":
        pool = [
            "Start from the mechanism, not the mood, because the mechanism is the part you can change on a Tuesday afternoon without anyone's permission.",
            "Most sites inherit a bot check from a launch rush that never got revisited, and the fix is structural rather than creative.",
            "Verify on the server, use each token once, watch the failure rate: three boring habits that outrank any clever widget.",
            "None of this requires a bigger budget, only that you stop improvising what can be checked once and re-checked on every form that takes input.",
            "The first week feels slow, the third week feels unfair to your old self, and the evidence tells you which version was actually working.",
            "That is the entire argument, stated plainly, skipped almost everywhere, and recovered by anyone willing to look at their own forms for one honest month.",
        ]
        parts = [f"Most advice sells you a harder puzzle. Abuse usually gets in through smaller holes: a token never checked on the server, a token that works twice, an endpoint that takes any POST. {t} is the honest version of that claim, and it is fixable without a rebuild. The pieces below are ordered by how little effort they take, not by how impressive they sound.", ""]
        for i, b in enumerate(beats):
            para = " ".join(pool[(i + j) % len(pool)] for j in range(6))
            parts.append(f"## {b[:70]}\n\n{b}, which is the concrete version of what most advice rounds off into encouragement instead of instruction. {para}")
            para2 = " ".join(pool[(i + 3 + j) % len(pool)] for j in range(5))
            parts.append(f"\nApplied badly versus applied once: {para2} The difference is not effort, it is whether the step lives in a system or in your mood on the day.")
            parts.append("")
        parts.append("Write the checks down once, run them on every form that takes input, and let the monitor do the remembering so your hours go to the judging, which is the part no tool should take from you.")
        return "\n".join(parts).strip()
    if kind == "reply":
        return f"Mechanism over mood here. {beats[0][:110] if beats else t[:110]}. The fix is structural: verify on the server, use tokens once, watch failures. Your own logs are the only honest scoreboard."
    if rail_family(channel) == "x":
        # budget-aware template (2026-10-01): the fake author must fit x's 280 the way the real
        # one does - the title and the trail survive whole, the example compresses to the room left
        core, trail = f"{t}. ", " Most bot holes are plumbing, not puzzles, and plumbing can be fixed on a Tuesday."
        beat = (beats[0] if beats else "Start from the mechanism, not the mood.")
        body = core + beat[:max(1, 280 - len(core) - len(trail))] + trail
    elif rail_family(channel) == "bsky":
        b2 = beats[1] if len(beats) > 1 else beats[0]
        body = f"{t}. {b2[:80]}. Boring on purpose: verify on the server, use tokens once, read the logs."
    elif channel == "nostrnote":
        # budget-aware like x (2026-10-01): nostr's cap is 300 - title and trail survive whole,
        # the beat compresses to the room left
        core, trail = f"{t}. ", " Plumbing beats puzzles: verify on the server, use tokens once, read the logs."
        beat = beats[0] if beats else "Start from the mechanism, not the mood."
        body = core + beat[:max(1, LIMITS["nostrnote"] - len(core) - len(trail))] + trail
    elif rail_family(channel) == "pinterest":
        body = f"{t}. A form-security note for store and site owners: {(beats[0][:165].rstrip('. ') + '.') if beats else 'a check nobody sees beats a puzzle everybody fails.'} Keep the check invisible and the verification on the server."
    else:
        lines = "\n".join(f"- {b[:150]}" for b in beats)
        body = f"{t}.\n\n{lines}\n\nHoles hide in defaults nobody re-checks. Verify every token on the server, accept it once, watch the failure rate: that is the whole method, and it survives a busy month better than a harder puzzle does."
    if kind == "promo":
        asset = str(topic.get("asset", "")).strip()
        cap = LIMITS.get(channel) or LIMITS.get(rail_family(channel)) or 10 ** 9
        if asset:
            if len(body) + 1 + len(asset) <= cap:
                body = body + " " + asset
            else:    # pointer survives whole: compress the body, keep title + asset intact
                body = body[:max(1, cap - 2 - len(asset))].rstrip(" ,;:.") + "… " + asset
    return body.strip()


# ---------- the editor (hard gates) ----------

def validate_copy(kind: str, topic: dict, channel: str, text: str) -> list[str]:
    p = []
    if not text or len(text) < 60:
        return [f"{channel}: too short ({len(text)} chars)"]
    for d in ("—", "–"):
        if d in text:
            p.append(f"{channel}: contains {d!r} (voice)")
    for lk in LEAKY:
        if lk in text:
            p.append(f"{channel}: secret-shaped string {lk!r}")
    if HYPE.search(text):
        p.append(f"{channel}: hype vocabulary ({HYPE.search(text).group(0)!r})")
    if STATS.search(text):
        p.append(f"{channel}: fabricated-stat shape ({STATS.search(text).group(0)!r})")
    if "!" in text and '"' not in text:
        p.append(f"{channel}: exclamation mark outside quotes")
    nlinks = text.count("http")
    if kind == "value" and channel != "whop_private" and PRODUCT.search(text):
        p.append(f"{channel}: value post names the product (80/20 rule)")
    if kind == "value" and channel == "whop_private" and nlinks > 2:
        p.append(f"{channel}: member recap can carry at most 2 links")
    if kind == "value" and nlinks > 1:
        p.append(f"{channel}: value post with {nlinks} links")
    nlinks_promo = len(re.findall(r"https?://\S+", text))
    if kind == "promo" and channel not in ("devto", "nostr30023", "whop_private"):
        if nlinks_promo == 0:
            p.append(f"{channel}: promo with no pointer link is just vibes")
        if nlinks_promo > 1:
            p.append(f"{channel}: promo should carry exactly one link")
    p += [f"{channel}: {c}" for c in facts.check_claims(text)]
    if kind != "longform" and channel in LIMITS and len(text) > LIMITS[channel]:
        p.append(f"{channel}: {len(text)} chars over {LIMITS[channel]}")
    if kind == "longform":
        w = len(text.split())
        if not (700 <= w <= 1700):
            p.append(f"longform: {w} words outside 700-1700")
        if "\n#" not in text:
            p.append("longform: no H2 structure")
    return p


def dedash(text: str) -> str:
    """Mechanical copy-edit for the one voice rule models ignore most: no em/en dashes.
    Ranges become hyphens (3–5 -> 3-5), spaced dashes become commas, the rest hyphens."""
    text = re.sub(r"(?<=\w)\s*[–—]\s*(?=\d)", "-", text)
    text = re.sub(r"\s+[–—]\s+", ", ", text)
    text = re.sub(r"[–—]", "-", text)
    return re.sub(r",\s*,", ",", text)


def _fixlist(probs: list[str]) -> str:
    """Editor rejection -> rewrite directives. Problems alone told the model WHAT failed;
    the hard bans also need the HOW (remove, not reword) - 2026-09-28 devto rejection loop."""
    out = [f"- {p}" for p in probs]
    if any("fabricated-stat" in p for p in probs):
        out.append("- remove every statistic and percentage outright (stats are banned in "
                   "press copy): delete the sentence or restate the claim without numbers, "
                   "do not reword the stat")
    if any("(voice)" in p for p in probs):
        out.append("- no em/en dashes anywhere: use commas, colons, or a plain hyphen")
    if any("names the product" in p for p in probs):
        out.append("- do NOT mention AttestOS, whop, or any product/tool name anywhere in a value post")
    if any("outside 700-1700" in p or "no H2 structure" in p for p in probs):
        out.append("- write a full 850-1200 word essay with at least three ## H2 section headings")
    return ("The previous draft was REJECTED by the deterministic editor. Write a fresh "
            "draft that fixes every item below, same topic and voice:\n" + "\n".join(out))


def author(kind: str, topic: dict, channel: str, st: dict | None = None) -> tuple[str, list[str]]:
    """LLM (or fake) writes, editor gates it, one feedback retry, then hand off clean or empty."""
    rejected = ""
    for attempt in (1, 2):
        try:
            text = dedash(llm(rejected, kind, topic, channel, st))
        except Exception as e:  # noqa: BLE001
            log("llm_error", channel=channel, topic=topic["id"], err=repr(e)[:140])
            return "", ["llm unavailable"]
        probs = validate_copy(kind, topic, channel, text)
        if not probs:
            return text, []
        log("rejected", channel=channel, topic=topic["id"], attempt=attempt, problems=probs)
        rejected = _fixlist(probs)
    return "", probs


# ---------- the planner ----------

def next_slot(st: dict, channel: str) -> str:
    """Spread a day's posts across ~9 hours instead of firing a burst: 40-minute grid."""
    used = {(p.get("due"), p["platform"]) for p in st["published"]}
    base = now() + timedelta(minutes=15)
    for k in range(14):
        slot = (base + timedelta(minutes=40 * k)).replace(second=0, microsecond=0)
        iso = slot.strftime("%Y-%m-%dT%H:%M:%SZ")
        if (iso, channel) not in used and slot.weekday() < 7:
            return iso
    return (base + timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _used_day(st: dict, tid: str) -> str:
    ts = st.get("used_ts", {}).get(tid)
    return ts[:10] if ts else ""


def _variant(st: dict, t: dict) -> dict:
    """Reusing a topic inside 3 days? Demand a genuinely different cut, in writing."""
    ts = st.get("used_ts", {}).get(t["id"])
    if ts and (now() - datetime.fromisoformat(ts)) < timedelta(days=3):
        return {**t, "beats": t.get("beats", []) + [
            "ROTATING REUSE: this topic ran within three days. Open differently, aim at a "
            "different reader than last time (first-time founder, seasoned operator, or the agency doing the work), and do not "
            "reuse any prior phrasing the topic words themselves allow."]}
    return t


def promo_ratio_ok(st: dict) -> bool:
    n = [p for p in st["published"] if (now() - datetime.fromisoformat(p["ts"])).days <= 28]
    # the ratio counts content pieces (topics), not channel copies: one promo idea
    # mirrored to five rails is still one promo
    val = {p["topic"] for p in n if p["kind"] in ("value", "longform")}
    pro = {p["topic"] for p in n if p["kind"] == "promo"}
    # owner directive 2026-09-30: 2 value : 1 promo per platform per day (was 4:1)
    return len(val) >= max(2, 2 * len(pro))


def due_this_cycle(st: dict, topics: list, cad: dict | None = None) -> list[dict]:
    """Daily budgets, spread across the day's runs: longform weekly, value shorts and promo
    up to per_day counts from cadence.json, never the same (topic, platform) twice a day."""
    cad = cad or load_cadence()
    out = []
    today = str(date.today())
    day = dict(st.get("day_counts", {}).get(today, {}))   # local copy: publish() is the sole
    # writer of real counts; the planner only simulates the remainder of THIS run against it
    runs_left = max(1, int(cad.get("run_target", 4)) - st.get("runs_today", {}).get(today, 0))
    ll = st.get("last_longform")
    lf_gap = int(cad.get("longform_days", GAP_LONGFORM_DAYS))
    longforms = [t for t in topics if t["format"] == "longform"]
    fresh_l = sorted((t for t in longforms if _used_day(st, t["id"]) != today),
                     key=lambda t: st["used_ts"].get(t["id"], "1970"))
    if (not ll or (now() - datetime.fromisoformat(ll)).days >= lf_gap) and fresh_l and any(
            _rail_armed(c) and not _rail_off(st, c) for c in ("devto", "nostr30023", "whop_private")):
        out.append({"kind": "longform", "topic": _variant(st, fresh_l[0]),
                    "channels": [c for c in ("devto", "nostr30023", "whop_private") if not _rail_off(st, c) and _rail_armed(c)]})
        day["whop_private"] = day.get("whop_private", 0) + 1     # simulation only

    todays = {(p["topic"], p["platform"]) for p in st["published"] if p["ts"][:10] == today}
    cap = max(1, int(cad.get("topic_max_rails", 3)))     # one idea on at most N rails a day

    def room(tid: str) -> int:      # published today + already planned in this run (both audience passes)
        return cap - sum(1 for (t_, _) in todays if t_ == tid) - sum(
            len(j["channels"]) for j in out if j["kind"] != "longform" and j["topic"]["id"] == tid)
    promos = sorted((t for t in topics if t["kind"] == "promo"),
                    key=lambda t: st["used_ts"].get(t["id"], "1970"))
    promos = [t for t in promos
              if not _recent(st, t["id"], int(cad.get("promo_min_gap_days", 3)))]
    # whop_public carries promos first (1 a day); it takes an operator value post only on days
    # when no promo can run there
    public_promo_today = bool(promos) and promo_ratio_ok(st) and not any(
        x["kind"] == "promo" and x["platform"] == "whop_public" and x["ts"][:10] == today for x in st["published"])
    op_rails = [r for r in OPERATOR_RAILS if r != "whop_public" or not public_promo_today]
    value_short = [t for t in topics if t["kind"] == "value" and t["format"] == "short"]
    company = [r for r in OPERATOR_RAILS + SEEKER_RAILS if r != "whop_public" or r in op_rails]
    k = (now().toordinal() + now().hour // 6) % len(AUDIENCES)   # 4 slots/day: each audience leads once
    for aud in AUDIENCES[k:] + AUDIENCES[:k]:
        rails = [r for r in company if r in AUDIENCE_RAILS[aud]]
        pool = [t for t in value_short if t.get("audience", DEFAULT_AUDIENCE) == aud] or value_short
        _plan_value(st, cad, out, day, todays, room, runs_left, today, rails, pool)
    rest = [r for r in company if not any(r in AUDIENCE_RAILS[a] for a in AUDIENCES)]
    if rest:
        _plan_value(st, cad, out, day, todays, room, runs_left, today, rest, value_short)
    # seller personas: B2B voices, so they draw the agency/sales pools first
    seller_pool = [t for t in value_short if t.get("audience") in ("agency", "sales")] or value_short
    _plan_value(st, cad, out, day, todays, room, runs_left, today, SELLER_RAILS, seller_pool)
    out += _plan_promo(st, cad, day, room, today, promos)
    return out


def _plan_value(st, cad, out, day, todays, room, runs_left, today, rails, pool) -> None:
    cap = max(1, int(cad.get("topic_max_rails", 3)))
    # cadence.json is the single source of truth for ENABLED rails: a rail missing from it
    # (e.g. pinterest_a, removed 2026-10-08 while seller-a Buffer Pinterest was dead) is not
    # planned at all - no cad lookup (KeyError), no push attempts, no park alerts. Re-enabling
    # is a one-line cadence edit.
    rails = [p for p in rails if p in cad]
    hungry = [p for p in rails if _rail_armed(p) and day.get(p, 0) < int(cad[p]["per_day"]) and not _rail_off(st, p)]
    if hungry:
        shorts = sorted((t for t in pool if _used_day(st, t["id"]) != today),
                        key=lambda t: st["used_ts"].get(t["id"], "1970"))
        if not shorts:      # pool exhausted today: rotate oldest with variant demand
            shorts = sorted(pool, key=lambda t: st["used_ts"].get(t["id"], "1970"))
        need = max(min(2, -(-(int(cad[p]["per_day"]) - day.get(p, 0)) // runs_left)) for p in hungry)
        max_jobs = need * -(-len(hungry) // cap)      # enough topics to cover the rails under the cap
        taken = 0
        for t in shorts:
            if taken >= max_jobs:
                break
            chans = []
            for p in hungry:
                if len(chans) >= room(t["id"]):
                    break
                if day.get(p, 0) >= int(cad[p]["per_day"]):
                    continue
                if (t["id"], p) in todays:
                    continue
                if sum(1 for j in out if j["kind"] == "value" and p in j["channels"]) >= need:
                    continue
                day[p] = day.get(p, 0) + 1
                chans.append(p)
            if chans:
                out.append({"kind": "value", "topic": _variant(st, t), "channels": chans})
                taken += 1


def _plan_promo(st, cad, day, room, today, promos) -> list[dict]:
    out: list[dict] = []
    vplatforms = list(VALUE_PLATFORMS) + ["whop_public"]
    # The cadence is the source of truth for ENABLED rails (same guard as _plan_value):
    # VALUE_PLATFORMS includes SELLER_RAILS, so a rail removed from cadence.json
    # (pinterest_a, 2026-10-08) would KeyError this list comprehension and kill the whole
    # slot — proven by the failed 14:15Z run of 2026-10-08 (the value pass was guarded,
    # the promo pass was not, and only the promo window triggers this line).
    vplatforms = [p for p in vplatforms if p in cad]
    # per-platform daily promo budget: promo occupies a slot in the platform's day, it never
    # inflates past per_day, and it is capped at promo_per_day promos per platform per day
    promo_hungry = [p for p in vplatforms
                    if _rail_armed(p) and not _rail_off(st, p) and day.get(p, 0) < int(cad[p]["per_day"]) and sum(
                        1 for x in st["published"] if x["kind"] == "promo" and x["platform"] == p
                        and x["ts"][:10] == today) < int(cad.get("promo_per_day", 1))]
    promo_hungry = promo_hungry[:max(0, room(promos[0]["id"]))] if promos else []
    if promos and promo_ratio_ok(st) and promo_hungry:
        for p in promo_hungry:
            day[p] = day.get(p, 0) + 1
        out.append({"kind": "promo", "topic": _variant(st, promos[0]), "channels": promo_hungry})
    return out


# ---------- links: soft pointer + click tracking ----------

def mint_base() -> str:
    return facts.site_url()


# Per-persona click hosts: two social personas must never share a link host (platform
# link-graph correlation is how paired accounts get banned together). A seller persona's host
# is set with AO_SITE_URL_A / _B (the same Worker on another route or workers.dev name); until
# then its rails keep the company host rather than emit dead links.
MINT_HOSTS = {"": "https://attestos-edge.attestos.workers.dev"}


def mint_base_for(rail: str) -> str:
    suf = rail_suffix(rail)
    if not suf:
        return facts.site_url()
    return (os.environ.get("AO_SITE_URL" + suf, "") or MINT_HOSTS.get(suf, "") or facts.site_url()).rstrip("/")


def go_link(rail: str, target: str, topic_id: str) -> str:
    tid = re.sub(r"[^a-z0-9-]", "", str(topic_id).lower()) or "-"
    src = f"{RAIL_CODE.get(rail_family(rail), 's')}{rail_suffix(rail).lower().lstrip('_')}-{tid}"[:30]
    return f"{mint_base_for(rail)}/go/{TARGET_CODE[target]}?src={src}"


def _link_table() -> list[tuple[str, str]]:
    b = facts.billing()
    tab = dict(LINKS)
    tab.update({k: b[k] for k in CHECKOUT_KEYS if b.get(k)})
    # the go links themselves are destinations too (a model may paste one): map them back to their key
    seen, rows = set(), []
    for k, u in tab.items():          # one row per URL: "store" and "whop_free" share /go/free
        u = u.rstrip("/")
        if k in TARGET_CODE and u not in seen:
            seen.add(u)
            rows.append((k, u))
    return sorted(rows, key=lambda kv: -len(kv[1]))


def track_links(text: str, rail: str, topic_id: str) -> str:
    """Swap every known destination for its tracked /go link (longest URL first: the landing URL is a
    prefix of the funnel URL). Unknown URLs are left alone."""
    for key, url in _link_table():
        pat = re.compile(re.escape(url) + r"/?(?:\?[^\s)\]]*?)?(?=$|[\s)\]>\"']|[.,;:!?](?:$|[\s)\]]))")
        k2 = "funnel" if key == "landing" else key
        text = pat.sub(lambda m, k=k2: go_link(rail, k, topic_id), text)
    return text


def finalize_text(ch: str, kind: str, topic: dict, text: str) -> str:
    """After the editor passed the copy: on LinkedIn and Whop a value post with no link gets one
    soft pointer (the free audit for the topic's audience; it never names the
    product), then every link becomes a tracked mint link. Over the rail's limit? Drop the pointer,
    then the tracking, never the post."""
    base = text
    if kind == "value" and ch in POINTER_RAILS and "http" not in text:
        target, line = POINTER.get(topic.get("audience", DEFAULT_AUDIENCE), POINTER[DEFAULT_AUDIENCE])
        text = f"{text.rstrip()}\n\n{line.format(url=LINKS[target])}"
    lim = LIMITS.get(ch)
    for cand in (track_links(text, ch, topic["id"]), text, track_links(base, ch, topic["id"]), base):
        if not lim or len(cand) <= lim:
            return cand
    return base


def pin_link(kind: str, topic: dict, text: str, rail: str = "pinterest") -> str:
    """Pinterest pins open a destination; until 2026-09-27 every pin went out with none."""
    m = re.search(r"https?://\S+", text)
    if m:
        return m.group(0).rstrip(".,;:!?)")
    return go_link(rail, POINTER.get(topic.get("audience", DEFAULT_AUDIENCE), POINTER[DEFAULT_AUDIENCE])[0], topic["id"])


def _rail_off(st: dict, rail: str) -> bool:
    until = st.get("rail_off", {}).get(rail)
    return bool(until and now() < datetime.fromisoformat(until))


def _recent(st: dict, tid: str, days: int = 28) -> bool:
    ts = st.get("used_ts", {}).get(tid)
    return bool(ts and (now() - datetime.fromisoformat(ts)).days < days)


# ---------- post images (every post carries one; owner rule 2026-09-27) ----------

URL_RAILS = (
    "x", "linkedin", "pinterest", "facebook", "instagram", "threads", "youtube", "tiktok", "gbp",
    "devto", "nostr30023", "nostrnote", "whop_public", "whop_private", "telegram", "discord",
) + tuple(r for r in SELLER_RAILS if rail_family(r) in BUFFER_FAMILIES)
BYTE_RAILS = ("bsky", "mastodon")                                                 # upload the bytes
IMG_FALLBACK = {"wide": facts.site_url() + "/promo/og-default-1200x630.jpg",
                "cover": facts.site_url() + "/promo/og-default-1200x630.jpg"}
_MINT_URLS: dict[str, str] = {}


def _mint_img(png: bytes) -> str:
    """Park the card on mint (D1) and return its public URL; '' when mint is unreachable."""
    base = (os.environ.get("AO_SITE_URL", "") or "https://attestos-edge.attestos.workers.dev").rstrip("/")
    tok = os.environ.get("AO_PRESS_TOKEN", "").strip()
    key = hashlib.sha256(png).hexdigest()
    if key in _MINT_URLS:
        return _MINT_URLS[key]
    if not tok:
        log("img_host_skip", note="no AO_PRESS_TOKEN")
        return ""
    try:
        req = urllib.request.Request(base + "/api/press/img", data=png, method="POST",
                                     headers={"Authorization": f"Bearer {tok}", "Content-Type": "image/png", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            url = json.loads(r.read()).get("url", "")
    except Exception as e:  # noqa: BLE001
        log("img_host_fail", err=repr(e)[:160])
        return ""
    _MINT_URLS[key] = url
    return url


def make_image(st: dict, topic: dict, kind: str, ch: str, text: str, kit_id: str = "") -> dict:
    """Render the card for this rail and host it when the rail fetches by URL. Never raises:
    a render/host failure falls back to a static brand image so the post still ships with one.
    kit_id: a promo-kit material posts its pre-rendered card (same factory, rendered once)."""
    import cards
    shape = cards.shape_for(ch)
    img = {"png": b"", "url": "", "alt": "", "shape": shape, "size": cards.SHAPES[shape], "src": ""}
    if kit_id:
        try:
            f = HERE / "promo-kit" / "img" / f"{kit_id}-{'pin' if shape == 'pin' else 'x'}.png"
            img["png"] = f.read_bytes()
            img["alt"] = f"AttestOS card: {topic.get('title', kit_id)}"[:900]
            img["src"] = "kit"
        except Exception as e:  # noqa: BLE001 — missing file falls through to a live render
            log("kit_img_miss", rail=ch, material=kit_id, err=repr(e)[:120])
    if not img["png"]:
      try:
        img["png"] = cards.render(topic, kind, text, ch, facts.billing())
        img["alt"] = cards.alt_text(topic, kind, text)
        img["src"] = "card"
      except Exception as e:  # noqa: BLE001
        log("img_render_fail", channel=ch, topic=topic.get("id"), err=repr(e)[:160])
    if ch in URL_RAILS:
        img["url"] = _mint_img(img["png"]) if img["png"] else ""
        if not img["url"]:
            if shape == "pin":
                img["url"] = IMG_BASE + PINS[st["pin_i"] % len(PINS)]
                st["pin_i"] += 1
            else:
                img["url"] = IMG_FALLBACK[shape]
            if img["src"] != "kit":     # a kit card that fails hosting is still a kit card
                img["src"] = "fallback"
            img["size"] = (848, 1264) if shape == "pin" else (1200, 630)
            log("img_fallback", channel=ch, url=img["url"])
    return img


# ---------- publishers ----------

BUFFER_SERVICE = {"x": "twitter", "gbp": "googlebusiness"}   # rail family -> Buffer `service`
_BUFFER_DISCOVERED: dict[str, dict] = {}


def buffer_discover(tok: str, st: dict | None = None) -> dict[str, str]:
    """{service: channel_id} for every connected channel on the Buffer account behind `tok`
    (account -> organizations -> channels). Cached per token for 24h in the state ledger so a
    run costs at most two GraphQL reads per Buffer account. Never raises: {} on any failure."""
    if not tok:
        return {}
    key = hashlib.sha256(tok.encode()).hexdigest()[:16]
    if key in _BUFFER_DISCOVERED:
        return _BUFFER_DISCOVERED[key]
    cache = st.setdefault("buffer_channels", {}) if st is not None else {}
    ent = cache.get(key) or {}
    if ent.get("at", 0) > time.time() - 86400 and isinstance(ent.get("map"), dict):
        _BUFFER_DISCOVERED[key] = ent["map"]
        return ent["map"]

    def gql(query: str, variables: dict | None = None) -> dict:
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        req = urllib.request.Request("https://api.buffer.com", data=body, method="POST", headers={
            "Authorization": f"Bearer {tok}", "Content-Type": "application/json", "User-Agent": UA})
        return json.loads(urllib.request.urlopen(req, timeout=20).read() or b"{}")

    out: dict[str, str] = {}
    try:
        orgs = ((gql("query { account { organizations { id } } }").get("data") or {})
                .get("account") or {}).get("organizations") or []
        for o in orgs[:3]:
            d = gql("query($input: ChannelsInput!) { channels(input: $input) { id service isDisconnected } }",
                    {"input": {"organizationId": o["id"]}})
            for c in (d.get("data") or {}).get("channels") or []:
                if c.get("isDisconnected"):
                    continue
                out.setdefault(str(c.get("service") or "").lower(), str(c["id"]))
        log("buffer_discovered", services=sorted(out))
    except Exception as exc:  # noqa: BLE001
        log("buffer_discover_failed", err=repr(exc)[:120])
        return {}
    _BUFFER_DISCOVERED[key] = out
    if st is not None:
        cache[key] = {"at": int(time.time()), "map": out}
    return out


def buffer_creds(ch: str, st: dict | None = None) -> tuple[str, str]:
    """(Buffer token, Buffer channel id) for a rail across the 3-Buffer-account architecture:
    - Buffer Account A (slot A / 1): X, LinkedIn, Pinterest
    - Buffer Account B (slot B / 2): Facebook Page, Instagram, Threads
    - Buffer Account C (slot C / 3): YouTube, TikTok, Google Business Profile
    Company rails and all Seller rails (_a, _b, ...) use identical 3-Buffer routing. An explicit
    AO_CHANNEL_<RAIL> wins; otherwise the channel is discovered from the token's own account."""
    tok = buffer_token_for(ch)
    fam = rail_family(ch)
    cid = _buffer_channel_env(ch)
    if not cid and tok:
        cid = buffer_discover(tok, st).get(BUFFER_SERVICE.get(fam, fam), "")
    return tok, cid


def pub_buffer(st: dict, channel: str, text: str, due: str, promo: bool, pin_img: str = "",
               img: dict | None = None, link: str = "", rail: str | None = None) -> bool:
    import push
    rail = rail or channel
    tok, ch_id = buffer_creds(rail, st)
    if not tok or not ch_id:
        log("skip_no_key", platform="buffer", channel=channel, slot=buffer_slot(rail))
        return False
    board = pinboard_for(rail)
    if rail_family(channel) == "pinterest" and not board:
        log("skip_no_pinboard", platform="buffer", channel=channel)
        return False
    # audit 2026-09-27: the rail is "x" here but "twitter" in push.CHANNEL_IDS, so every X post
    # (26 of 26 since 2026-09-20) died on KeyError('x') after the LLM had written it.
    item = {"channel_id": ch_id, "text": text, "due": due}
    vid_url = (img or {}).get("video_url", "")
    url = (img or {}).get("url", "")
    if vid_url:
        item["video_url"] = vid_url
        if rail_family(channel) == "youtube":
            item["youtube_title"] = str((img or {}).get("video_title") or text.splitlines()[0] or "AttestOS")[:100]
    elif url:
        item["image_url"] = url
    if rail_family(channel) == "pinterest":
        item.update({"image": pin_img, "board": board, "pin_title": text[:80]})
        if link:
            item["link"] = link
    r = push._gql(push.MUTATION, {"i": push.build_create_post_input(item)}, tok)
    res = r.get("data", {}).get("createPost", {}) or {}
    ok = res.get("__typename") == "PostActionSuccess"
    if not ok:
        errmsg = str(res.get("message") or res.get("__typename") or res)
        log("publish_error", platform="buffer", channel=channel, err=errmsg[:160])
        if "NotFound" in errmsg:
            # Buffer 404 = the channel was disconnected/deleted on the Buffer side. Nothing
            # on our side can fix it - parking it instead of knocking 4x/day, and leaving
            # the human action where the owner can find it (health pings once per day).
            until = (now() + timedelta(hours=72)).isoformat(timespec="seconds")
            st.setdefault("rail_off", {})[channel] = until
            st.setdefault("rail_parked", {})[channel] = {
                "until": until,
                "reason": "Buffer channel gone (NotFoundError) - reconnect it in the Buffer app, "
                          "then update its channel id in the repo secrets",
            }
            log("rail_parked", channel=channel, hours=72, reason="buffer channel 404 (NotFoundError)")
    if not ok and (url or vid_url) and rail_family(channel) not in ("pinterest", "youtube", "tiktok"):
        # the media must never cost us a text-capable post: retry text-only, and the ledger says so
        log("img_rejected", platform="buffer", channel=channel, err=str(res.get("message", ""))[:160])
        item.pop("image_url", None)
        item.pop("video_url", None)
        r = push._gql(push.MUTATION, {"i": push.build_create_post_input(item)}, tok)
        res = r.get("data", {}).get("createPost", {}) or {}
        ok = res.get("__typename") == "PostActionSuccess"
        if img is not None:
            img["attached"] = False
    elif ok and img is not None:
        img["attached"] = bool(vid_url or url or pin_img)
    if ok:
        st["channel_last"][channel] = now().isoformat(timespec="seconds")
    return ok


def pub_telegram(text: str, img: dict | None = None) -> bool:
    """2026-10-13 (owner): regional rail. A Telegram BOT posts to ONE channel it administers
    (AO_TG_CHANNEL, e.g. @attestos). Free Bot API, no rate wall at 3/day. Photo posts use
    the card URL; text falls back if the photo is rejected."""
    tok = os.environ.get("AO_TG_BOT_TOKEN", "").strip()
    chan = os.environ.get("AO_TG_CHANNEL", "").strip()
    if not tok or not chan:
        log("skip_no_key", platform="telegram")
        return False

    def call(method: str, fields: dict) -> tuple[int, dict]:
        data = urllib.parse.urlencode(fields).encode()
        req = urllib.request.Request(f"https://api.telegram.org/bot{tok}/{method}", data=data,
                                     headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read()[:220] or b"{}")
            except Exception:
                return e.code, {}

    url = (img or {}).get("url", "")
    if url:
        st, d = call("sendPhoto", {"chat_id": chan, "photo": url, "caption": text[:1024]})
        if st == 200 and (d.get("result") or {}).get("message_id"):
            if img is not None:
                img["attached"] = True
            return True
        log("img_rejected", platform="telegram", err=str(d.get("description", ""))[:160])
    st, d = call("sendMessage", {"chat_id": chan, "text": text[:4000],
                                 "link_preview_options": json.dumps({"is_disabled": not url})})
    ok = st == 200 and bool((d.get("result") or {}).get("message_id"))
    if not ok:
        log("publish_error", platform="telegram", err=str(d.get("description", ""))[:160])
    if img is not None and not url:
        img["attached"] = False
    return ok


def pub_facebook(text: str, img: dict | None = None, link: str = "") -> bool:
    """2026-10-13 (owner): regional rail. Posts to the AttestOS Facebook PAGE the owner manages
    (the Groups API was shut down in 2024 - a Page is the automatable surface). Graph API with
    a page token; photo posts carry the card, feed posts carry the link."""
    tok = os.environ.get("AO_FB_PAGE_TOKEN", "").strip()
    page = os.environ.get("AO_FB_PAGE_ID", "").strip()
    if not tok or not page:
        log("skip_no_key", platform="facebook")
        return False

    def call(path: str, fields: dict) -> tuple[int, dict]:
        fields = {**fields, "access_token": tok}
        data = urllib.parse.urlencode(fields).encode()
        req = urllib.request.Request(f"https://graph.facebook.com/v21.0/{path}", data=data,
                                     headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read()[:220] or b"{}")
            except Exception:
                return e.code, {}

    url = (img or {}).get("url", "")
    if url:
        st, d = call(f"{page}/photos", {"url": url, "caption": text[:2000]})
        if st == 200 and d.get("post_id"):
            if img is not None:
                img["attached"] = True
            return True
        log("img_rejected", platform="facebook", err=str(d.get("error", {}).get("message", ""))[:160])
    fields = {"message": text[:4000]}
    if link:
        fields["link"] = link
    st, d = call(f"{page}/feed", fields)
    ok = st == 200 and bool(d.get("id"))
    if not ok:
        log("publish_error", platform="facebook", err=str(d.get("error", {}).get("message", ""))[:160])
    if img is not None and not url:
        img["attached"] = False
    return ok


def pub_mastodon(text: str, img: dict | None = None) -> bool:
    """Posts a public status to Mastodon (default https://mastodon.social). Uploads the card PNG
    via /api/v2/media when present; falls back to text-only if media upload fails."""
    tok = os.environ.get("AO_MASTODON_TOKEN", "").strip()
    inst = (os.environ.get("AO_MASTODON_INSTANCE", "").strip() or "https://mastodon.social").rstrip("/")
    if not tok:
        log("skip_no_key", platform="mastodon")
        return False
    hdrs = {"Authorization": f"Bearer {tok}", "User-Agent": UA}
    media_ids = []
    png = (img or {}).get("png", b"")
    if png:
        boundary = f"----attestos{int(time.time() * 1000)}"
        alt = (img.get("alt", "") or "AttestOS card")[:400]
        body = (f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="description"\r\n\r\n{alt}\r\n'
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; filename="card.png"\r\n'
                f"Content-Type: image/png\r\n\r\n").encode() + png + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(f"{inst}/api/v2/media", data=body, method="POST",
                                     headers={**hdrs, "Content-Type": f"multipart/form-data; boundary={boundary}"})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                mid = (json.loads(r.read() or b"{}") or {}).get("id")
                if mid:
                    media_ids.append(str(mid))
        except Exception as e:  # noqa: BLE001 — text-only beats no post
            log("img_rejected", platform="mastodon", err=repr(e)[:160])
    if img is not None:
        img["attached"] = bool(media_ids)
    payload = {"status": text[:500], "visibility": "public"}
    if media_ids:
        payload["media_ids"] = media_ids
    req = urllib.request.Request(f"{inst}/api/v1/statuses", data=json.dumps(payload).encode(), method="POST",
                                 headers={**hdrs, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read() or b"{}")
            ok = r.status in (200, 202) and bool(d.get("id"))
    except Exception as e:  # noqa: BLE001
        log("publish_error", platform="mastodon", err=repr(e)[:160])
        return False
    if not ok:
        log("publish_error", platform="mastodon", err=str(d)[:160])
    return ok


def pub_discord(text: str, img: dict | None = None) -> bool:
    """Posts to the community Discord channel webhook (AO_DISCORD_PRESS_WEBHOOK). Attaches the
    card URL via embed image when available; falls back to plain content if rejected."""
    wh = os.environ.get("AO_DISCORD_PRESS_WEBHOOK", "").strip()
    if not wh:
        log("skip_no_key", platform="discord")
        return False
    sep = "&" if "?" in wh else "?"
    target = f"{wh}{sep}wait=true"

    def send(payload: dict) -> tuple[int, dict]:
        req = urllib.request.Request(target, data=json.dumps(payload).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read()[:220] or b"{}")
            except Exception:
                return e.code, {}

    url = (img or {}).get("url", "")
    if url:
        st, d = send({"content": text[:1900], "embeds": [{"image": {"url": url}}]})
        if st in (200, 204) and (st == 204 or d.get("id")):
            if img is not None:
                img["attached"] = True
            return True
        log("img_rejected", platform="discord", err=str(d)[:160])
    st, d = send({"content": text[:1900]})
    ok = st in (200, 204) and (st == 204 or bool(d.get("id")))
    if not ok:
        log("publish_error", platform="discord", err=str(d)[:160])
    if img is not None and not url:
        img["attached"] = False
    return ok


def pub_devto(title: str, body: str, tags: str, publish: bool, img: dict | None = None) -> str:
    key = os.environ.get("AO_DEVTO_KEY", "").strip()
    if not key:
        log("skip_no_key", platform="devto")
        return ""
    art = {"title": title, "body_markdown": body,
           "tags": [t.strip() for t in tags.split(",") if t.strip()], "published": publish}
    if (img or {}).get("url"):
        art["main_image"] = img["url"]          # dev.to cover (1000x420)
    payload = json.dumps({"article": art}).encode()
    req = urllib.request.Request("https://dev.to/api/articles", data=payload,
        headers={"api-key": key, "Content-Type": "application/json", "User-Agent": UA})
    d = json.loads(urllib.request.urlopen(req, timeout=40).read())
    if img is not None:
        img["attached"] = bool(d.get("cover_image") or d.get("main_image"))
    return d.get("url", "")


def pub_nostr_note(text: str, img: dict | None = None) -> bool:
    import nostr
    if not os.environ.get("AO_NOSTR_NSEC"):
        log("skip_no_key", platform="nostr")
        return False
    tags, content = [], text
    if (img or {}).get("url"):
        w, h = img["size"]
        content = f"{text}\n\n{img['url']}"      # clients render a bare image URL inline
        tags = [["imeta", f"url {img['url']}", "m image/png", f"dim {w}x{h}", f"alt {img.get('alt', '')[:300]}"]]
    ev = nostr.sign(1, tags, content)
    assert nostr.verify_sig(ev)
    res = asyncio.run(nostr.publish(ev))
    ok = sum(1 for v in res.values() if v.startswith("OK")) >= 2
    if img is not None:
        img["attached"] = ok and bool(tags)
    return ok


def pub_nostr_article(title: str, body: str, slug: str, img: dict | None = None) -> bool:
    import nostr
    if not os.environ.get("AO_NOSTR_NSEC"):
        log("skip_no_key", platform="nostr")
        return False
    ev = nostr.build_article({"title": title, "tags": ""}, body, slug, (img or {}).get("url") or None)
    res = asyncio.run(nostr.publish(ev))
    ok = sum(1 for v in res.values() if v.startswith("OK")) >= 2
    if img is not None:
        img["attached"] = ok and bool((img or {}).get("url"))
    return ok


WHOP_FORUMS_APP = "app_dYfm2IdXhDMquv"      # Whop's own verified Forums app
WHOP_MEMBER_EXP_NAME = "Member updates"
# Guard: the asset-bot key also reaches Cedar Loom's company. The rename landed live
# 2026-10-14 (title "STPi", route whop.com/stpi, old jacaranda-labs URL still resolves), so
# the guard is tight again: anything titled otherwise — including "Jacaranda Labs" — bounces.
WHOP_COMPANY_TITLES = ("AttestOS",)


def _whop_keys() -> list[str]:
    """Account key first: it posts AS the company admin (runtime truth 2026-09-27: the asset-bot
    v2 app key, installed on AttestOS, can create/attach experiences but its bot user gets
    'cannot post on this feed'). The app key follows for discovery, create and attach."""
    ks = [os.environ.get(k, "").strip() for k in ("WHOP_API_KEY", "WHOP_APP_KEY")]
    return [k for i, k in enumerate(ks) if k and k not in ks[:i]]


def _whop_api(path: str, method: str = "GET", body: dict | None = None,
              key: str | None = None) -> tuple[int, dict]:
    """Whop /api/v1 helper (runtime truth 2026-09-20: /v2 forum routes want scopes the company
    key lacks; /api/v1 works with it as-is)."""
    key = (key if key is not None else os.environ.get("WHOP_API_KEY", "")).strip()
    if not key:
        return 0, {}
    h = {"Authorization": f"Bearer {key}", "User-Agent": UA}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request("https://api.whop.com/api/v1" + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=35) as r:
            return r.status, json.loads((r.read() or b"{}").decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads((e.read()[:220] or b"{}").decode())
        except Exception: return e.code, {}


_INLINE = re.compile(r"\*\*(.+?)\*\*|\[([^\]]+)\]\((https?://[^)\s]+)\)|(https?://[^\s)]+)")


def _tt_inline(text: str) -> list[dict]:
    """Markdown inline -> Tiptap text nodes: **bold**, [label](url) and bare URLs as links."""
    out, i = [], 0
    for m in _INLINE.finditer(text):
        if m.start() > i:
            out.append({"type": "text", "text": text[i:m.start()]})
        if m.group(1):
            out.append({"type": "text", "text": m.group(1), "marks": [{"type": "bold"}]})
        else:
            label, href = (m.group(2), m.group(3)) if m.group(2) else (m.group(4), m.group(4))
            out.append({"type": "text", "text": label, "marks": [{"type": "link", "attrs": {"href": href}}]})
        i = m.end()
    if i < len(text):
        out.append({"type": "text", "text": text[i:]})
    return [n for n in out if n["text"]]


def whop_rich(text: str, img_url: str, alt: str) -> str:
    """Post body as Tiptap JSON (Whop renders rich_content ahead of content) with the card as an
    image node on top. Live 2026-09-27: Whop accepts the image node and mirrors it into content
    as ![alt](url); account API keys can't attach files, so this is how Whop posts carry images."""
    nodes = [{"type": "image", "attrs": {"src": img_url, "alt": alt[:300]}}] if img_url else []
    for block in re.split(r"\n\s*\n", (text or "").strip()):
        lines = [l for l in block.splitlines() if l.strip()]
        if not lines:
            continue
        if all(re.match(r"\s*[-*] ", l) for l in lines):
            nodes.append({"type": "bulletList", "content": [
                {"type": "listItem", "content": [{"type": "paragraph", "content": _tt_inline(re.sub(r"^\s*[-*] ", "", l))}]}
                for l in lines]})
        elif re.match(r"#{1,3} ", lines[0]) and len(lines) == 1:
            lvl = len(lines[0].split(" ", 1)[0])
            nodes.append({"type": "heading", "attrs": {"level": min(3, lvl + 1)},
                          "content": _tt_inline(lines[0].split(" ", 1)[1])})
        else:
            content = []
            for j, l in enumerate(lines):
                if j:
                    content.append({"type": "hardBreak"})
                content += _tt_inline(l.strip())
            nodes.append({"type": "paragraph", "content": content})
    return json.dumps({"type": "doc", "content": nodes})


def _whop_upload(png: bytes, key: str | None) -> str:
    """Whop file for a post attachment: POST /files -> PUT bytes to the presigned URL -> ready.
    The posting key goes first (live 2026-09-27: a file only attaches to a post made with the key
    that uploaded it); the other keys are a last resort."""
    order = [key] + [k for k in _whop_keys() if k != key]
    st, f, used = 0, {}, None
    for k in order:
        st, f = _whop_api("/files", "POST", {"filename": f"attestos-{hashlib.sha256(png).hexdigest()[:10]}.png",
                                             "visibility": "public"}, k)
        if st in (200, 201) and (f or {}).get("id") and (f or {}).get("upload_url"):    # Whop answers 201
            used = k
            break
        log("whop_upload_fail", stage="create", status=st, err=str(f)[:160])
    key = used
    fid, up = (f or {}).get("id", ""), (f or {}).get("upload_url", "")
    if not used:
        return ""
    h = {k: v for k, v in (f.get("upload_headers") or {}).items()}
    h.setdefault("Content-Type", "image/png")
    try:
        with urllib.request.urlopen(urllib.request.Request(up, data=png, method="PUT", headers=h), timeout=40) as r:
            if r.status not in (200, 201, 204):
                raise RuntimeError(f"put {r.status}")
    except Exception as e:  # noqa: BLE001
        log("whop_upload_fail", stage="put", err=repr(e)[:160])
        return ""
    for _ in range(6):
        st2, g = _whop_api(f"/files/{fid}", key=key)
        if st2 == 200 and g.get("upload_status") == "ready":
            return fid
        time.sleep(1.5)
    log("whop_upload_fail", stage="ready", id=fid)
    return ""


def _whop_forum_post(exp: str, text: str, title: str, key: str | None = None, img: dict | None = None) -> bool:
    """Create a forum post (with the card attached) and verify it by reading it back (rule #2).
    2026-10-13: Whop started requiring account_id alongside experience_id on this route
    ("Please provide both feed id and feed type" without it — that is what silently killed
    whop_private from Oct-9; the app key still authenticates fine)."""
    biz = os.environ.get("WHOP_COMPANY_ID", "").strip()
    body = {"experience_id": exp, "content": text, "title": (title or "AttestOS")[:120]}
    if biz:
        body["account_id"] = biz
    url = (img or {}).get("url", "")
    fid = ""
    if url:
        body["content"] = f"{text}\n\n![{(img.get('alt') or 'AttestOS card')[:120]}]({url})"
        body["rich_content"] = whop_rich(text, url, img.get("alt", ""))
    elif (img or {}).get("png"):
        fid = _whop_upload(img["png"], key)           # company/app-style keys can attach files
        if fid:
            body["attachments"] = [{"id": fid}]
    st, d = _whop_api("/forum_posts", "POST", body, key)
    if st in (400, 413, 415, 422) and (url or fid):     # only a definitive payload rejection is safe to retry
        log("img_rejected", platform="whop", status=st, err=str(d)[:160])
        body = {"experience_id": exp, "content": text, "title": (title or "AttestOS")[:120]}
        if biz:
            body["account_id"] = biz
        url = fid = ""
        st, d = _whop_api("/forum_posts", "POST", body, key)
    if img is not None:
        img["attached"] = bool(url or fid) and st in (200, 201)
    pid = d.get("id", "") if isinstance(d, dict) else ""
    if st not in (200, 201) or not pid:
        log("whop_post_fail", exp=exp, status=st, err=str(d)[:160])
        return False
    st2, r2 = _whop_api(f"/forum_posts/{pid}", key=key)
    got = re.sub(r"!\[[^\]]*\]\([^)]*\)\s*", "", r2.get("content") or "").strip()   # image mirrored into content
    if st2 == 200 and " ".join(got.split()) == " ".join(text.split()):
        return True
    log("whop_readback_doubt", id=pid, status=st2)
    return False


def _whop_member_forum(biz: str, key: str) -> str:
    """Return a members-only Forums experience on OUR company (never another account's), creating
    and attaching 'Member updates' when none exists. '' when the key can't see or create one."""
    want = os.environ.get("WHOP_PRIVATE_EXP_ID", "").strip()
    if want:
        return want
    st, d = _whop_api(f"/experiences?account_id={biz}&app_id={WHOP_FORUMS_APP}&first=50", key=key)
    rows = (d.get("data") or []) if st == 200 else []
    private = [e for e in rows if not e.get("is_public")]
    named = [e for e in private if (e.get("name") or "").strip().lower() == WHOP_MEMBER_EXP_NAME.lower()]
    if named or private:
        return (named or private)[0]["id"]
    st, d = _whop_api("/experiences", "POST", {"account_id": biz, "app_id": WHOP_FORUMS_APP,
                                               "name": WHOP_MEMBER_EXP_NAME, "is_public": False}, key)
    exp = d.get("id", "") if st == 200 and isinstance(d, dict) else ""
    if not exp:
        log("whop_no_member_forum", status=st, err=str(d)[:160],
            note="key cannot create experiences on this company: install app asset-bot v2 on it "
                 "(https://whop.com/apps/app_aJFKUT7MnR5730/install/) and approve the permissions")
        return ""
    log("whop_member_forum_created", exp=exp)
    stp, dp = _whop_api(f"/products?account_id={biz}&first=50", key=key)
    for prod in (dp.get("data") or []) if stp == 200 else []:
        sa, _ = _whop_api(f"/experiences/{exp}/attach", "POST", {"product_id": prod["id"]}, key)
        log("whop_attach", exp=exp, product=prod["id"], status=sa)
    return exp


def _whop_chat(biz: str, text: str, key: str) -> bool:
    chan = os.environ.get("WHOP_PRIVATE_CHANNEL_ID", "").strip()
    if not chan:
        st, d = _whop_api(f"/chat_channels?account_id={biz}&first=10", key=key)
        chans = d.get("data", []) if st == 200 else []
        if not chans:
            log("whop_no_channel", status=st)
            return False
        chan = chans[0]["id"]
    st, d = _whop_api("/messages", "POST", {"channel_id": chan, "content": text}, key)
    mid = d.get("id", "") if isinstance(d, dict) else ""
    if st != 200 or not mid:
        log("whop_msg_fail", status=st, err=str(d)[:160])
        return False
    st2, r2 = _whop_api(f"/messages?channel_id={chan}&last=5", key=key)
    rows = (r2.get("data") or []) if st2 == 200 else []
    if rows and not any(m.get("id") == mid for m in rows):
        log("whop_readback_doubt", id=mid, note="message created but not in recent list")
    return True


def pub_whop(text: str, public: bool, title: str = "", img: dict | None = None) -> bool:
    """Public rail: forum post on the marketplace-wide 'Public forum' experience.
    Private rail, per key (app key first): explicit chat channel -> members-only forum on our
    company (auto-created + attached to every product if missing) -> any chat channel.
    Read-back verifies every write (factory rule #2)."""
    biz = os.environ.get("WHOP_COMPANY_ID", "").strip()
    keys = _whop_keys()
    if not keys:
        log("skip_no_key", platform="whop", public=public)
        return False
    if not biz:
        log("skip_no_key", platform="whop", public=public, note="WHOP_COMPANY_ID unset")
        return False
    # Read-only identity/auth selection first. A stale account key must not shadow a valid
    # app key, and a successful check with one key must not authorize another key's writes.
    verified = []
    for index, key in enumerate(keys):
        status, company = _whop_api(f"/companies/{biz}", key=key)
        if status == 200 and (company.get("title") or "").strip() in WHOP_COMPANY_TITLES:
            verified.append(key)
        else:
            log("whop_auth_preflight", key_role="account" if key == os.environ.get("WHOP_API_KEY", "").strip() else "app",
                status=status, expected_company=False)
    if not verified:
        log("whop_wrong_company", status=0, note="no configured key verified the AttestOS company; no post attempted")
        return False
    if public:
        exp = os.environ.get("WHOP_PUBLIC_EXP_ID", "").strip()
        # Do not try another writer after an ambiguous create/readback failure: that can
        # publish a duplicate. The next diagnostic is read-only, not another blind POST.
        return _whop_forum_post(exp, text, title, verified[0], img)
    for key in verified:
        if os.environ.get("WHOP_PRIVATE_CHANNEL_ID", "").strip() and _whop_chat(biz, text, key):
            return True
        exp = _whop_member_forum(biz, key)
        if exp and _whop_forum_post(exp, text, title, key, img):
            return True
        if _whop_chat(biz, text, key):
            return True
    return False


def bsky_creds(ch: str) -> tuple[str, str]:
    """(handle, app password) for a rail: sellers' AO_BSKY_ID_A/PASS_A (B analog)."""
    suf = rail_suffix(ch)
    return os.environ.get("AO_BSKY_ID" + suf, ""), os.environ.get("AO_BSKY_PASS" + suf, "")


def _bsky_session(ident: str, pw: str, st: dict | None = None) -> dict:
    """Session reuse scavenged from the Apps Script factory: refresh beats fresh logins.
    A createSession password login on every post is exactly the shape platform abuse
    filters flag (doc 27); the 90-day refreshJwt covers ~4 months of quiet renewals,
    same one-request cost without the login signal."""
    import reply
    cache = st.setdefault("bsky_sessions", {}) if st is not None else {}
    ent = cache.get(ident) or {}
    if ent.get("refreshJwt"):
        try:
            code, body = reply._post("https://bsky.social/xrpc/com.atproto.server.refreshSession",
                                     None, {"Authorization": f"Bearer {ent['refreshJwt']}"})
            if code == 200 and body.get("accessJwt"):
                cache[ident] = {"did": body.get("did", ent.get("did", "")),
                                "accessJwt": body["accessJwt"],
                                "refreshJwt": body.get("refreshJwt") or ent["refreshJwt"]}
                log("bsky_session", mode="refresh")
                return cache[ident]
        except Exception as e:  # noqa: BLE001  (stale refresh -> plain login below)
            log("bsky_session_refresh_fail", err=repr(e)[:120])
    _code, sess = reply._post("https://bsky.social/xrpc/com.atproto.server.createSession",
                              {"identifier": ident, "password": pw})
    if st is not None and sess.get("accessJwt"):
        cache[ident] = {"did": sess.get("did", ""), "accessJwt": sess["accessJwt"],
                        "refreshJwt": sess.get("refreshJwt", "")}
    log("bsky_session", mode="create")
    return sess


def pub_bsky(text: str, img: dict | None = None, rail: str | None = None,
             st: dict | None = None) -> bool:
    import reply
    ident, pw = bsky_creds(rail or "bsky")
    if not ident or not pw:
        log("skip_no_key", platform="bsky")
        return False
    sess = _bsky_session(ident, pw, st)
    rec = {"text": text, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())}
    png = (img or {}).get("png", b"")
    if png:
        try:
            req = urllib.request.Request("https://bsky.social/xrpc/com.atproto.repo.uploadBlob", data=png, method="POST",
                                         headers={"Authorization": f"Bearer {sess['accessJwt']}",
                                                  "Content-Type": "image/png", "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                blob = json.loads(r.read())["blob"]
            w, h = img["size"]
            rec["embed"] = {"$type": "app.bsky.embed.images", "images": [
                {"alt": img.get("alt", "")[:1000], "image": blob, "aspectRatio": {"width": w, "height": h}}]}
        except Exception as e:  # noqa: BLE001  (text-only beats no post)
            log("img_rejected", platform="bsky", err=repr(e)[:160])
    if img is not None:
        img["attached"] = "embed" in rec
    st2, body2 = reply._post("https://bsky.social/xrpc/com.atproto.repo.createRecord",
                         {"repo": sess["did"], "collection": "app.bsky.feed.post", "record": rec},
                         {"Authorization": f"Bearer {sess['accessJwt']}"})
    if st2 != 200:
        log("publish_error", platform="bsky", rail=rail or "bsky",
            err=str((body2 or {}).get("message") or (body2 or {}).get("error") or st2)[:160])
    return st2 == 200


def publish(st: dict, job: dict, texts: dict[str, str], live: bool, draft_longform: bool) -> None:
    t, kind = job["topic"], job["kind"]
    slug = f"{now():%Y%m%d}-{t['id']}"
    adir = ADIR / "outbox"
    adir.mkdir(parents=True, exist_ok=True)
    recs = []
    for ch in job["channels"]:
        text = texts.get(ch, "")
        if not text:
            continue
        ckind_fin = "longform" if (ch in ("devto", "nostr30023") and kind == "longform") else kind
        kit_id = job.get("kit", {}).get(ch, "")
        tk = {**t, "asset": ""} if kit_id else t   # kit text carries its own pointer link
        text = finalize_text(ch, ckind_fin, tk, text)
        dc = st.setdefault("day_counts", {}).setdefault(str(date.today()), {})
        dc[ch] = dc.get(ch, 0) + 1
        st["channel_last"][ch] = now().isoformat(timespec="seconds")  # cooldown applies to the plan, live or dry
        (adir / f"{slug}-{ch}.md").write_text(f"# {t['title']}\n\nchannel: {ch}\nkind: {kind}\n\n{text}\n")
        rec = {"ts": now().isoformat(timespec="seconds"), "kind": kind, "platform": ch,
               "topic": t["id"], "due": job.get("due", {}).get(ch, ""), "ok": False, "live": live}
        ckind = ckind_fin
        img = make_image(st, tk, ckind, ch, text, kit_id)
        if rail_family(ch) in VIDEO_FAMILIES or job.get("video"):
            vid = take_video(st, ch)
            if vid:
                img["video_url"] = vid["url"]
                img["video_title"] = vid.get("title") or t["title"]
                rec["video"] = vid["id"]
                rec["video_url"] = vid["url"]
        # the card itself is NOT written to the outbox: press/auto round-trips through git on
        # every run, and ~40 KB x 11 posts a day would bloat the press-state branch forever
        rec["img"] = img.get("video_url") or img["url"] or ("upload" if img["png"] else "")
        rec["img_src"] = "video" if img.get("video_url") else img["src"]
        if live:
            try:
                if ch == "facebook" and not buffer_token_for("facebook") and os.environ.get("AO_FB_PAGE_TOKEN", "").strip():
                    rec["ok"] = pub_facebook(text, img, pin_link(kind, t, text, rail=ch) if kind == "promo" else "")
                elif rail_family(ch) in BUFFER_FAMILIES:
                    pin = img["url"] if rail_family(ch) == "pinterest" else ""
                    link = pin_link(kind, t, text, rail=ch) if rail_family(ch) == "pinterest" else ""
                    rec["ok"] = pub_buffer(st, ch, text, job.get("due", {}).get(ch, ""), kind == "promo", pin, img, link, rail=ch)
                elif rail_family(ch) == "bsky":
                    rec["ok"] = pub_bsky(text, img, rail=ch, st=st)
                elif ch == "nostrnote":
                    rec["ok"] = pub_nostr_note(text, img)
                elif ch == "telegram":
                    rec["ok"] = pub_telegram(text, img)
                elif ch == "facebook":
                    rec["ok"] = pub_facebook(text, img, pin_link(kind, t, text, rail=ch) if kind == "promo" else "")
                elif ch == "mastodon":
                    rec["ok"] = pub_mastodon(text, img)
                elif ch == "discord":
                    rec["ok"] = pub_discord(text, img)
                elif ch == "devto":
                    rec["ref"] = pub_devto(t["title"], text, t.get("tags", ""), not draft_longform, img)
                    rec["ok"] = bool(rec["ref"])
                elif ch == "nostr30023":
                    rec["ok"] = pub_nostr_article(t["title"], text, slug.split("-", 1)[1], img)
                elif ch in ("whop_public", "whop_private"):
                    rec["ok"] = pub_whop(text, ch == "whop_public", t["title"], img)
            except Exception as e:  # noqa: BLE001
                log("publish_error", platform=ch, err=repr(e)[:160])
                if "takedown" in repr(e).lower() or "suspended" in repr(e).lower():
                    # platform killed the account: park the rail instead of knocking on
                    # a door that is closed for good; the health guard pings once per day.
                    until = (now() + timedelta(hours=72)).isoformat(timespec="seconds")
                    st.setdefault("rail_off", {})[ch] = until
                    st.setdefault("rail_parked", {})[ch] = {
                        "until": until,
                        "reason": "platform takedown/suspension - the account itself must be "
                                  "restored before this rail can post again",
                    }
                    log("rail_parked", channel=ch, hours=72, reason="platform takedown/suspension")
        rec["img_ok"] = bool(img.get("attached")) if live else bool(img["png"] or img["url"])
        if live and ch == "whop_private" and not rec["ok"]:
            st.setdefault("rail_off", {})[ch] = (now() + timedelta(hours=24)).isoformat(timespec="seconds")
        st["published"].append(rec)
        recs.append(rec)
        log("published" if rec.get("ok") else "publish_failed" if live else "planned", channel=ch, topic=t["id"], live=live)
    landed = [r for r in recs if r.get("ok")]
    if live and not landed:
        log("topic_not_spent", topic=t["id"], note="every channel failed; the topic stays fresh")
        return
    st["used"][t["id"]] = st["used"].get(t["id"], 0) + 1
    st.setdefault("used_ts", {})[t["id"]] = now().isoformat(timespec="seconds")
    longform_landed = (not live) or any(r["platform"] in ("devto", "nostr30023") for r in landed)
    if (kind == "longform" or any(c == "devto" for c in job["channels"])) and longform_landed:
        st["last_longform"] = now().isoformat(timespec="seconds")


# ---------- reply autopilot ----------

def compose_reply_guard(cand: dict, text: str) -> list[str]:
    plat = cand["platform"]
    voice = "nostr" if plat == "nostr" else ("devto" if plat == "devto" else "bsky")
    if plat == "linkedin":
        voice = "linkedin"
    p = validate_copy("value", {"id": cand["id"], "title": "", "beats": []}, voice, text)
    if plat in ("nostr", "bsky") and "http" in text:
        p.append("reply: link on nostr/bsky")
    # 2026-10-13 per-platform bounds: x 280 (API), nostr/bsky 300, linkedin 1200 (conversational)
    lo = 40 if plat == "linkedin" else 120
    hi = {"x": 280, "nostr": 300, "bsky": 300, "linkedin": 1200}.get(plat, 300)
    if not (lo <= len(text) <= hi):
        p.append(f"reply: outside {lo}-{hi} chars for {plat}")
    return p


def cmd_autoreply(live: bool) -> int:
    import reply as rp
    fetch_runtime_settings({})          # console-managed reply creds + reply_per_day knob
    st = load_state()
    cands = rp.find_bsky(24) + rp.find_nostr()
    if not _cb_open(st, "x_mentions"):  # audit F9: a dead token 401'd on every run, forever
        try:
            cands += rp.find_x_mentions(24, raise_errors=True)    # x: mentions of us, creds-gated
            st.get("llm_cb", {}).pop("x_mentions", None)
        except Exception as e:  # noqa: BLE001
            _cb_fail(st, "x_mentions", e)
    for imp_plat, imp_name in (("linkedin", "import-linkedin.json"), ("x", "import-x.json")):
        imp_file = rp.ROOT / "replies" / imp_name if hasattr(rp, "ROOT") else None
        if imp_file and imp_file.exists():     # hand-picked LinkedIn / X targets when search/mentions are gated
            try:
                cands += [c for c in json.loads(imp_file.read_text()) if c.get("platform") == imp_plat]
            except Exception:                # noqa: BLE001 — a broken import file must never stop the pass
                log("reply_import_error", file=imp_name)
    rep_cap = int(load_cadence().get("reply_per_day", 4))
    sent = 0
    for cand in cands:
        if sent >= rep_cap * 3:
            break
        if cand["id"] in st["reply_targets"] or "attestos" in cand.get("excerpt", "").lower():
            continue
        day = str(date.today())
        today = st["reply_day"].get(day, {})
        plat = cand["platform"]
        if today.get(plat, 0) >= rep_cap:
            continue
        text, probs = author("reply", {"id": f"reply-{cand['id'][:12]}",
                                       "title": cand.get("excerpt", "")[:300],
                                       "beats": ["build on the poster's mechanism, add one they missed, concede what is right"]},
                             plat, st)
        if not text:
            continue
        g = compose_reply_guard(cand, text)
        if g:
            log("reply_rejected", target=cand["id"][:16], problems=g)
            continue
        if live:
            fn = {"nostr": rp.send_nostr, "bsky": rp.send_bsky,
                  "x": rp.send_x, "linkedin": rp.send_linkedin}[plat]
            try:
                ok, _ = fn(cand, text)
            except Exception as e:  # noqa: BLE001
                log("reply_error", err=repr(e)[:120]); ok = False
            if not ok:
                continue
        st["reply_targets"].append(cand["id"])
        today[plat] = today.get(plat, 0) + 1
        st["reply_day"][day] = today
        st["published"].append({"ts": now().isoformat(timespec="seconds"), "kind": "reply",
                                "platform": plat, "topic": cand["id"][:16], "due": "", "ok": live})
        log("reply_sent" if live else "reply_planned", platform=plat, target=cand["id"][:16])
        sent += 1
    save_state(st)
    print(f"{sent} replies {'sent' if live else 'planned (dry run)'}")
    return 0


# ---------- CLI ----------

def cmd_cycle(live: bool, draft_longform: bool) -> int:
    topics = load_topics()
    st = load_state()
    fetch_runtime_settings(st)          # owner console keys + cadence knobs (2026-10-14)
    fetch_mesh_overrides(st)            # owner console park/resume/per_day (2026-10-13)
    prime_buffer_discovery(st)          # channels from each Buffer token (24h cache), before arming
    today = str(date.today())
    st.setdefault("runs_today", {})[today] = st.get("runs_today", {}).get(today, 0) + 1
    jobs = due_this_cycle(st, topics)
    if not jobs:
        save_state(st)   # the run counter must survive even when the budget is done
        print("nothing due this cycle (cadence is the brand); exiting clean")
        return 0
    for job in jobs:
        due = {ch: next_slot(st, ch) for ch in job["channels"] if rail_family(ch) in BUFFER_FAMILIES}
        job["due"] = due
        texts = {}
        for ch in job["channels"]:
            kind = "value" if (ch == "whop_private" and job["kind"] == "longform") else (
                "longform" if (ch in ("devto", "nostr30023") and job["kind"] == "longform") else job["kind"]
            )
            txt, probs = "", []
            if kind == "promo":
                # the promo kit first (owner 2026-10-14): ready-made material, same gates
                mat = take_kit(st, ch)
                if mat:
                    fam = rail_family(ch)
                    body_kit = mat["formats"].get(fam) or mat["formats"].get(
                        KIT_FMT_FALLBACK.get(fam, "x")) or mat["formats"]["x"]
                    probs = validate_copy("promo", {"id": mat["id"], "title": mat["headline"],
                                                    "asset": ""}, ch, body_kit)
                    if not probs:
                        txt = body_kit
                        job.setdefault("kit", {})[ch] = mat["id"]
                    else:
                        log("kit_rejected", rail=ch, material=mat["id"], problems=probs)
            if not txt:
                txt, probs = author(kind, job["topic"], ch, st)
            if probs and ch == "nostr30023" and texts.get("devto"):
                txt = texts["devto"]     # mirror reuses the accepted longform, skips the model
            if txt:
                texts[ch] = txt
        if not texts:
            log("job_skipped", topic=job["topic"]["id"])
            continue
        publish(st, job, texts, live, draft_longform)
        save_state(st)
    n = sum(len(j["channels"]) for j in jobs)
    print(f"cycle done: {len(jobs)} jobs, {n} channel pieces, live={live}")
    return 0


def rail_alerts(st: dict, fail_today: int = 3, dry_hours: int = 48) -> list[str]:
    """Live ledger only (dry plans carry live=False and never alarm):
    - a rail with >= fail_today failed live attempts today, or
    - a rail that tried live in the last dry_hours and landed nothing in that window."""
    t0 = now()
    today = t0.date().isoformat()
    recent = [p for p in st.get("published", []) if p.get("live") is True
              and (t0 - datetime.fromisoformat(p["ts"])) <= timedelta(hours=dry_hours)]
    out = []
    for rail in sorted({p["platform"] for p in recent}):
        if rail_family(rail) in BUFFER_FAMILIES + ("bsky", "telegram", "mastodon", "discord") and not _rail_armed(rail):
            continue          # an unprovisioned rail cannot fail: historical records from
            # the pre-arm-gate fall-through days must not alarm forever (x_b/bsky_b)
        mine = [p for p in recent if p["platform"] == rail]
        fails_today = sum(1 for p in mine if not p.get("ok") and p["ts"][:10] == today)
        if fails_today >= fail_today:
            out.append(f"{rail}: {fails_today} failed live posts today")
        elif not any(p.get("ok") for p in mine):
            out.append(f"{rail}: 0 of {len(mine)} live posts landed in {dry_hours}h")
    return out


def llm_alerts(st: dict) -> list[str]:
    """Breakered-dead author providers: surface once per day through the health run."""
    out, today = [], str(date.today())
    for name, ent in (st.get("llm_cb") or {}).items():
        if ent.get("kind") == "dead" and ent.get("until", 0) > time.time() \
                and ent.get("alerted") != today:
            out.append(f"llm-{name}: author provider parked 24h as dead (HTTP "
                       f"{ent.get('code', 0)}) - key burned, billing off, or model renamed; "
                       "the other lanes cover the day meanwhile")
            ent["alerted"] = today
    return out


def image_alerts(st: dict) -> list[str]:
    """Every post must carry an image: alert when a live post landed today without one."""
    today = now().date().isoformat()
    bare = [p for p in st.get("published", []) if p.get("live") is True and p.get("ok")
            and p["ts"][:10] == today and "img_ok" in p and not p["img_ok"]]
    if not bare:
        return []
    rails = sorted({p["platform"] for p in bare})
    return [f"images: {len(bare)} live post(s) landed without an image today ({', '.join(rails)})"]


def whop_price_drift() -> list[str]:
    """Every visible paid Whop plan must match BILLING (owner decisions 2026-09-27): monthly USD
    `usd` (renewal, 30 days) for every paid AttestOS plan (IntegrityRuntime, AgentPass, Hardware, Enterprise).
    A renewal plan must have no extra first-payment fee: Whop's initial_price is charged ON TOP of
    the first renewal (a $30 leftover made the first Solo payment $336). Each tier must offer all
    three. Read-only; any key that can list plans decides. [] when no key can read them."""
    b = facts.billing()
    # AttestOS sells monthly USD memberships only
    want = {("usd", "month"): dict(b.get("usd") or {})}
    biz = os.environ.get("WHOP_COMPANY_ID", "").strip()
    if not biz:
        log("whop_price_check_skipped", note="WHOP_COMPANY_ID unset")
        return []
    rows = None
    for k in _whop_keys():
        st, d = _whop_api(f"/plans?account_id={biz}&first=50", key=k)
        if st == 200:
            rows = d.get("data") or []
            break
    if rows is None:
        log("whop_price_check_skipped", note="no key can list plans")
        return []
    out = []
    for tier in want[("usd", "month")]:
        plans = [p for p in rows if tier in ((p.get("product") or {}).get("title") or "").lower()
                 and p.get("visibility") == "visible"]
        seen = set()
        for p in plans:
            cur, kind = p.get("currency"), p.get("plan_type")
            if kind == "renewal" and p.get("billing_period") == 30:
                slot, price = (cur, "month"), float(p.get("renewal_price") or 0)
                if float(p.get("initial_price") or 0):
                    out.append(f"whop_prices: {tier} plan {p.get('id')} adds a first-payment fee of "
                               f"{cur} {float(p.get('initial_price')):g} on top of the monthly price")
            elif kind == "one_time" and p.get("expiration_days") == 365:
                slot, price = (cur, "year"), float(p.get("initial_price") or 0)
            else:
                out.append(f"whop_prices: {tier} plan {p.get('id')} is {kind}/{p.get('billing_period')}d "
                           f"{cur}, which BILLING does not sell")
                continue
            exp = want.get(slot, {}).get(tier)
            if exp is None or price != float(exp):
                out.append(f"whop_prices: {tier} plan {p.get('id')} charges {cur} {price:g} per {slot[1]}, "
                           f"BILLING says {slot[0]} {exp} per {slot[1]}")
            seen.add(slot)
        for slot in want:
            if want[slot].get(tier) is not None and slot not in seen:
                out.append(f"whop_prices: no visible {slot[0]} {slot[1]}ly plan for {tier}")
    return out


def _last_errors(rail: str, n: int = 2) -> str:
    """The most recent failure events from run.log, to make the alert actionable."""
    keys = {"whop_private": "whop", "whop_public": "whop", "x": "buffer", "linkedin": "buffer",
            "pinterest": "buffer"}.get(rail, rail)
    lines = LOG_F.read_text().splitlines() if LOG_F.exists() else []
    markers = ("fail", "error", "no_", "skip", "wrong", "doubt", "rejected", "llm_error")
    # the platform key is shared (x/linkedin/pinterest all "buffer") and a rail's own failure
    # lines (e.g. x's `rejected` drafts) carry no platform key at all - so quote ONLY this
    # rail's lines; quoting another rail's errors (2026-10-05: x's alert showed pinterest_a's
    # Buffer 404) points the owner at the wrong fix.
    own = [l for l in lines
           if re.search(rf'"(?:channel|platform|rail)"\s*:\s*"{re.escape(rail)}"', l)
           and any(w in l for w in markers)]
    return " | ".join(h[:220] for h in own[-n:])


def authoring_alerts(st: dict, hours: int = 48) -> list[str]:
    """Rails dying in the AUTHORING stage never reach the live ledger at all (no publish
    record), so rail_alerts cannot see them - the nostrnote KeyError('nostrnote') class of
    2026-10-01, silent for two days. Count run.log llm_error/rejected events per cadence-planned
    rail that landed nothing in the window; sustained failure >= 4 is a rail death, not a
    bad-draft afternoon."""
    t0 = now()
    if not LOG_F.exists():
        return []
    cadence = load_cadence()
    died: dict[str, int] = {}
    for line in LOG_F.read_text().splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        try:
            ts = datetime.fromisoformat(str(e.get("ts", "")))
        except ValueError:
            continue
        if (t0 - ts) > timedelta(hours=hours):
            continue
        ch = e.get("channel") or e.get("platform")
        if not ch or not cadence.get(ch, {}).get("per_day"):
            continue
        if e.get("ev") in ("llm_error", "rejected"):
            died[ch] = died.get(ch, 0) + 1
    # 2026-10-05: successes are recorded in the state ledger (st["published"]), never in
    # run.log - the old log-based `landed` was always empty, so a rail that re-authored its
    # way through 4 rejections and landed 3 posts (x, 2026-10-05) alarmed as "dying".
    landed: set[str] = set()
    for p in st.get("published", []):
        if p.get("live") is not True or not p.get("ok"):
            continue
        try:
            if (t0 - datetime.fromisoformat(p["ts"])) <= timedelta(hours=hours):
                landed.add(p["platform"])
        except (ValueError, KeyError):
            pass
    return [f"{ch}: {n} authoring failures in {hours}h, nothing landed - dying before the publish"
            f" ledger even records it" for ch, n in sorted(died.items()) if n >= 4 and ch not in landed]


def parked_alerts(st: dict) -> list[str]:
    """Rails parked by code (Buffer 404, platform takedown): one ping per day until the park
    expires. A parked rail whose fix is still human-gated must not go silent (2026-10-05:
    pinterest_a was dead in Buffer and only the authoring alarm - aimed at the wrong fix -
    was naming it)."""
    t0 = now()
    out = []
    enabled = set(load_cadence())
    dropped = False
    for rail, ent in sorted((st.get("rail_parked") or {}).items()):
        if rail not in enabled:
            # rail removed from the cadence (owner doctrine 2026-10-08: the machine never waits
            # on the owner) - its stale park entry must not keep pinging: drop it.
            st["rail_parked"].pop(rail, None)
            st.get("rail_off", {}).pop(rail, None)
            dropped = True
            continue
        try:
            until = datetime.fromisoformat(ent["until"])
        except (KeyError, ValueError, TypeError):
            continue
        if t0 < until and ent.get("reason"):
            out.append(f"{rail}: parked until {ent['until'][:16]}Z - {ent['reason']}")
    if dropped:
        save_state(st)   # persist the cleanup even when no new alert fires
    return out



def cmd_health(live: bool) -> int:
    """Alert on rail failure: ::error:: annotations always; one Discord ping per rail per day via
    mint /api/press/notify; writes alert=1 to GITHUB_OUTPUT only when a NEW alert fired today, so the
    workflow fails (and GitHub emails the owner) once per broken rail per day, not every run."""
    st = load_state()
    alerts = (rail_alerts(st) + authoring_alerts(st) + image_alerts(st)
              + whop_price_drift() + llm_alerts(st) + parked_alerts(st))
    today = str(date.today())
    sent = st.setdefault("alerted", {})
    fresh = [a for a in alerts if sent.get(a.split(":", 1)[0]) != today]
    for a in alerts:
        print(f"::error title=press rail failing::{a}")
    if not alerts:
        print("rails healthy")
    if fresh and live:
        body = "Press rail failure:\n" + "\n".join(
            f"- {a}\n  last: {_last_errors(a.split(':', 1)[0]) or 'see press/auto/run.log on press-state'}" for a in fresh)
        url, tok = os.environ.get("AO_SITE_URL", "").rstrip("/"), os.environ.get("AO_PRESS_TOKEN", "")
        if url and tok:
            try:
                req = urllib.request.Request(url + "/api/press/notify", method="POST",
                                             data=json.dumps({"content": body, "source": "press"}).encode(),
                                             headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json",
                                                      "User-Agent": UA})
                with urllib.request.urlopen(req, timeout=20) as r:
                    log("rail_alert_sent", status=r.status, rails=[a.split(":", 1)[0] for a in fresh])
            except Exception as e:  # noqa: BLE001  (the ::error:: + failed run still alert)
                log("rail_alert_notify_fail", err=repr(e)[:160])
        for a in fresh:
            sent[a.split(":", 1)[0]] = today
        save_state(st)
        gh = os.environ.get("GITHUB_OUTPUT")
        if gh:
            with open(gh, "a") as f:
                f.write("alert=1\n")
    return 0


def cmd_status() -> int:
    st = load_state()
    up = [p for p in st["published"] if p.get("ok")]
    print(f"published pieces: {len(up)}  topics used: {len(st['used'])}  replies sent: {len(st['reply_targets'])}")
    print(f"last longform: {st.get('last_longform')}  value:promo ratio: ", end="")
    v = len({p["topic"] for p in st["published"] if p["kind"] in ("value", "longform")})
    pr = len({p["topic"] for p in st["published"] if p["kind"] == "promo"})
    print(f"{v}:{pr} (rule: value topics >= 4x promo topics)")
    cad = load_cadence()
    day = st.get("day_counts", {}).get(str(date.today()), {})
    today_p = {c: f"{day.get(c, 0)}/{cad.get(c, {}).get('per_day', '?')}"
               for c in list(VALUE_PLATFORMS) + ["whop_public"] if isinstance(cad.get(c), dict)}
    print("today:", "  ".join(f"{k}:{v}" for k, v in today_p.items()))
    print(f"runs today: {st.get('runs_today', {}).get(str(date.today()), 0)}/{cad.get('run_target', 4)}")
    for line in LOG_F.read_text().splitlines()[-5:] if LOG_F.exists() else []:
        print(" ", line[:140])
    return 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        sys.exit(2)
    if a[0] in {"cycle", "autoreply"}:
        sys.path.insert(0, str(HERE.parent))
        from controls import apply_runtime_controls, publish_usage
        if os.environ.get("AO_PRESS_TOKEN"):
            apply_runtime_controls(strict=True)
        if os.environ.get("AO_PRESS_ENABLED", "1").strip() == "0":
            print("press paused from the cockpit (AO_PRESS_ENABLED=0); nothing authored or published")
            sys.exit(0)
        try:
            code = cmd_cycle(live="--live" in a, draft_longform="--draft-longform" in a) if a[0] == "cycle" else cmd_autoreply(live="--live" in a)
        finally:
            publish_usage("press", _AUTHOR_CALLS, "Press author network attempts in this process; not tokens or provider account total",
                          (os.environ.get("GITHUB_RUN_ID", "local") + "-" + str(os.getpid()))[:80], groups=("ai",), keys=("AO_PRESS_LLM_CALLS_PER_RUN",))
        sys.exit(code)
    if a[0] == "status":
        sys.exit(cmd_status())
    if a[0] == "health":
        sys.exit(cmd_health(live="--live" in a))
    sys.exit(2)

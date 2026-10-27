#!/usr/bin/env python3
"""Reply-guy engine for the surfaces NOT mediated by Buffer (dev.to, Nostr, Bluesky).

Model: FIND → DRAFT → SEND (manual path; press/auto.py wraps the same send rails with an
LLM author + hard validators for fully unattended operation).

  python press/reply.py find [--hours 12] [--import targets.json]   # → press/replies/candidates.json
  # (nostr search is policy-blocked for server IPs; import human-picked targets instead)
  # operator edits: press/replies/drafts-YYYY-MM-DD.json  [{"target":"<id>","reply":"..."}]
  python press/reply.py send <drafts.json>     # validate + dispatch, ledger-guarded

Rules enforced in code (the polite-net constitution):
  * one reply per target, ever (ledger in press/replies/sent.json)
  * max 5 sends per platform per day (rate silence beats eloquence)
  * replies >= 120 chars of substance, <= 300, at most ONE link
  * no links at all in nostr/bsky replies (value must stand naked)
  * never reply to spam-shaped posts (giveaway/cashapp/nft-flavored text)

Bluesky needs an App Password (Settings → App Passwords on bsky.app) in env:
  AO_BSKY_ID (handle) + AO_BSKY_PASS (app password). OAuth client secrets do not
  work for this; verified 2026-09-20 (token endpoint demands a full registered DPoP client).
Nostr uses AO_NOSTR_NSEC (via press/nostr.py). dev.to uses AO_DEVTO_KEY.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RDIR = ROOT / "replies"
UA = "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0"
DEVTO = "https://dev.to/api"
NRELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.snort.social"]
SPAMMY = re.compile(r"cashapp|giveaway|\$500|500 \$|nft|mint pass|discord\.gg/gift|whatsapp \+", re.I)

DEVTO_TAGS = ["security", "webdev", "saas", "ecommerce", "wordpress", "ai", "seo", "javascript"]
NOSTR_TAGS = ["security", "webdev", "saas", "infosec", "ai", "privacy"]


def _get(url, hdr=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(hdr or {})})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read())


def _post(url, payload, hdr=None, form=False):
    if payload is None:
        # XRPC procedures without input (e.g. com.atproto.server.refreshSession) reject ANY body
        # with HTTP 400 — sending "{}" made 131/134 Bluesky refreshes fail into password logins.
        req = urllib.request.Request(url, data=b"", method="POST", headers={"User-Agent": UA, **(hdr or {})})
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, json.loads(r.read() or b"{}")
    if form:
        data = urllib.parse.urlencode(payload).encode()
        h = {"Content-Type": "application/x-www-form-urlencoded"}
    else:
        data = json.dumps(payload).encode()
        h = {"Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, headers={**h, "User-Agent": UA, **(hdr or {})})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.status, json.loads(r.read() or b"{}")


def _ok_text(t: str) -> bool:
    return 60 <= len(t) <= 500 and not SPAMMY.search(t)


# ---------------- find ----------------

def find_devto(hours: int) -> list[dict]:
    out = []
    for tag in DEVTO_TAGS:
        try:
            rows = _get(f"{DEVTO}/articles?top={max(1, hours // 6)}&tag={tag}&per_page=5")
        except Exception:
            continue
        for a in rows or []:
            body = (a.get("positive_score") or 0)
            out.append({"platform": "devto", "id": str(a["id"]), "title": a.get("title", "")[:120],
                        "excerpt": (a.get("description") or "")[:400], "author": (a.get("user") or {}).get("name", ""),
                        "url": "https://dev.to" + (a.get("url") or a.get("path") or ""), "score": body})
    return out

def find_nostr() -> list[dict]:
    import asyncio
    kw = re.compile(r"\b(captcha|recaptcha|hcaptcha|turnstile|bots?|spam|signup|sign-up|credential stuffing|card testing|fake accounts|robots\.txt|AI crawlers?|GPTBot|scrapers?|passkeys?|proof of work|form spam)\b", re.I)
    async def grab():
        import websockets
        evs = []
        async def one(url):
            try:
                async with websockets.connect(url, open_timeout=12) as ws:
                    await ws.send(json.dumps(["REQ", "frd", [{"kinds": [1], "limit": 80}]]))
                    while True:
                        m = json.loads(await asyncio.wait_for(ws.recv(), 15))
                        if m[0] == "EOSE":
                            return
                        if m[0] == "EVENT" and len(m) > 2:
                            evs.append(m[2])
            except Exception:
                return
        await asyncio.gather(*(one(u) for u in NRELAYS))
        return evs
    seen = set()
    out = []
    try:
        events = asyncio.run(grab())
    except Exception:
        return []
    for ev in events:
        t = ev.get("content", "")
        if ev["id"] in seen or not _ok_text(t) or SPAMMY.search(t) or "http" in t:
            continue
        if not kw.search(t):
            continue
        if re.search(r"zapathon|kind 6|kind 7", t, re.I):
            continue
        seen.add(ev["id"])
        out.append({"platform": "nostr", "id": ev["id"], "author": ev["pubkey"],
                    "created": ev["created_at"], "excerpt": t[:400]})
    return out

_BSKY_JWT: dict = {}


def _bsky_jwt(ident: str, pw: str) -> str:
    """One password login per process (find + every send used to log in again; repeated
    createSession calls are the pattern that got the account suspended on 2026-09-29)."""
    if ident not in _BSKY_JWT:
        _, sess = _post("https://bsky.social/xrpc/com.atproto.server.createSession",
                        {"identifier": ident, "password": pw})
        _BSKY_JWT[ident] = sess["accessJwt"]
    return _BSKY_JWT[ident]


def find_bsky(hours: int) -> list[dict]:
    import os
    ident, pw = os.environ.get("AO_BSKY_ID", ""), os.environ.get("AO_BSKY_PASS", "")
    if not ident or not pw:
        return []
    try:
        jwt = _bsky_jwt(ident, pw)
    except Exception as e:
        print(f"~ bsky session: {e}")
        return []
    out = []
    for q in ("captcha signup form", "bot signups saas", "robots.txt AI crawlers", "contact form spam"):
        try:
            r = (200, _get("https://bsky.social/xrpc/app.bsky.feed.searchPosts?" +
                urllib.parse.urlencode({"q": q, "limit": 12, "sort": "latest"}) +
                "", {"Authorization": f"Bearer {jwt}"}))
        except Exception:
            continue
        for p in (r[1].get("posts") or []):
            rec = p.get("record") or {}
            t = rec.get("text", "")
            if not _ok_text(t) or "attestos" in t.lower() or SPAMMY.search(t):
                continue
            out.append({"platform": "bsky", "id": p["uri"], "author": (p.get("author") or {}).get("handle", ""),
                        "excerpt": t[:400], "cid": p["cid"],
                        "rkey": p["uri"].rsplit("/", 1)[-1]})
    return out

def cmd_find(hours: int = 12, import_file: str = "") -> int:
    # x mentions ride along when AO_X_REPLY_TOKEN/UID exist; linkedin targets have no
    # free search API, so they arrive via --import (press/replies/import-linkedin.json).
    cands = find_devto(hours) + find_nostr() + find_bsky(hours) + find_x_mentions(hours)
    if import_file:
        # Relays policy-block anonymous search from server IPs, so a human can
        # pick targets in a relay UI and drop them here: list of {"platform":
        # "nostr", "id": <event id>, "author": <pubkey hex>, "excerpt": "..."}
        extra = json.loads(Path(import_file).read_text())
        cands = extra + cands
    RDIR.mkdir(exist_ok=True)
    (RDIR / "candidates.json").write_text(json.dumps(cands, indent=1))
    by = {}
    for c in cands:
        by[c["platform"]] = by.get(c["platform"], 0) + 1
    print(f"{len(cands)} candidates → {RDIR/'candidates.json'} by platform {by}")
    return 0


# ---------------- send ----------------

def _ledger():
    f = RDIR / "sent.json"
    return json.loads(f.read_text()) if f.exists() else {}

def validate_drafts(drafts: list, cands: list) -> list[str]:
    probs = []
    idx = {c["id"]: c for c in cands}
    for d in drafts:
        t = d.get("reply", "")
        if d.get("target") not in idx:
            probs.append(f"unknown target {str(d.get('target'))[:12]}")
            continue
        if len(t) < 120:
            probs.append(f"{str(d['target'])[:10]}: reply under 120 chars of substance")
        plat = idx[d["target"]]["platform"]
        if len(t) > 280 and plat == "x":                      # hard API limit
            probs.append(f"{str(d['target'])[:10]}: over 280 chars for x")
        if len(t) > 300 and plat in ("nostr", "bsky"):
            probs.append(f"{str(d['target'])[:10]}: too long for nostr/bsky")
        if plat in ("nostr", "bsky") and "http" in t:
            probs.append(f"{str(d['target'])[:10]}: links not allowed on {plat}")
        if plat == "linkedin" and len(t) > 1200:              # keep comments conversational
            probs.append(f"{str(d['target'])[:10]}: linkedin comment over 1200 chars")
    return probs

def send_devto(cand, text):
    import os
    key = os.environ["AO_DEVTO_KEY"]
    st, body = _post(f"{DEVTO}/comments", {"commentable_id": cand["id"], "body_markdown": text},
                     {"api-key": key})
    return st == 201, f"comment {body.get('id')} on article {cand['id']}"

def send_nostr(cand, text):
    import nostr
    ev = nostr.sign(1, [["e", cand["id"], "", "root"], ["p", cand["author"]]], text)
    assert nostr.verify_sig(ev)
    import asyncio
    res = asyncio.run(nostr.publish(ev, relays=NRELAYS))
    return sum(1 for r in res.values() if r.startswith("OK")) >= 2, ev["id"]

def send_bsky(cand, text):
    import os
    ident, pw = os.environ["AO_BSKY_ID"], os.environ["AO_BSKY_PASS"]
    jwt = _bsky_jwt(ident, pw)
    rec = {"text": text, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
           "reply": {"root": {"uri": cand["id"], "cid": cand["cid"]},
                     "parent": {"uri": cand["id"], "cid": cand["cid"]}}}
    st, body = _post("https://bsky.social/xrpc/com.atproto.repo.createRecord",
                     {"repo": ident, "collection": "app.bsky.feed.post", "record": rec},
                     {"Authorization": f"Bearer {jwt}"})
    return st == 200, body.get("uri", "")

def find_x_mentions(hours: int = 24, raise_errors: bool = False) -> list[dict]:
    """2026-10-13 (owner: engagement beats broadcast). X replies target MENTIONS of our own
    account (people who talked at us) - free-tier reads are tight, so one poll per cycle.
    Needs AO_X_REPLY_TOKEN (OAuth2 user token with tweet.read+tweet.write) and
    AO_X_REPLY_UID (our numeric user id). Missing creds = [] (the rail waits quietly)."""
    import os
    tok = os.environ.get("AO_X_REPLY_TOKEN", "").strip()
    uid = os.environ.get("AO_X_REPLY_UID", "").strip()
    if not tok or not uid:
        return []
    try:
        res = _get(f"https://api.twitter.com/2/users/{uid}/mentions?max_results=25"
                   "&tweet.fields=author_id,created_at&expansions=author_id"
                   "&user.fields=username", {"Authorization": f"Bearer {tok}"})
        st, d = res if isinstance(res, tuple) else (200, res)
    except Exception as e:  # noqa: BLE001 — credits depleted (402) or token expired must not abort autoreply
        print(f"~ x mentions: {e}")
        if raise_errors:          # autoreply feeds this to the circuit breaker (401 -> parked 24 h)
            raise
        return []
    if st != 200:
        print(f"~ x mentions: {st} {str(d)[:120]}")
        return []
    users = {u["id"]: u.get("username", "?") for u in (d.get("includes", {}) or {}).get("users", [])}
    out = []
    for t in (d.get("data") or []):
        if str(t.get("author_id")) == str(uid):        # never reply to ourselves
            continue
        out.append({"platform": "x", "id": str(t["id"]), "author": users.get(t.get("author_id"), "?"),
                    "excerpt": (t.get("text") or "")[:280], "ts": t.get("created_at", "")})
    return out

BUFFER_GQL = "https://api.buffer.com"
DEFAULT_BUFFER_X_CHANNEL_ID = ""   # AttestOS: from AO_CHANNEL_X / Buffer discovery, never hardcoded


def send_x_via_buffer(cand, text):
    """Fallback X engagement rail via Buffer GraphQL (`createPost` with
    `metadata.twitter.retweet` = Quote-Tweet on `cand['id']`). Buffer's public GraphQL
    schema does not expose `in_reply_to_tweet_id` or mention-reading queries, so when
    direct X API `/2/tweets` is unavailable or credits-depleted (HTTP 402/403), Buffer
    publishes the response as a Quote-Tweet referencing the target tweet."""
    import os
    tok = (os.environ.get("PRESS_BUFFER_TOKEN") or os.environ.get("AO_BUFFER_TOKEN") or "").strip()
    if not tok:
        raise KeyError("PRESS_BUFFER_TOKEN")
    cid = (os.environ.get("PRESS_BUFFER_X_CHANNEL_ID") or os.environ.get("AO_CHANNEL_X")
           or DEFAULT_BUFFER_X_CHANNEL_ID).strip()
    if not cid:
        try:
            import auto
            cid = auto.buffer_discover(tok).get("twitter", "")
        except Exception:  # noqa: BLE001
            cid = ""
    if not cid:
        raise KeyError("AO_CHANNEL_X")
    query = (
        "mutation($input: CreatePostInput!) {"
        " createPost(input: $input) {"
        " ... on PostActionSuccess { post { id status } }"
        " ... on MutationError { message }"
        " } }"
    )
    variables = {
        "input": {
            "channelId": cid,
            "text": text[:280],
            "schedulingType": "automatic",
            "mode": "shareNow",
            "metadata": {
                "twitter": {
                    "retweet": {"id": str(cand["id"]), "comment": text[:280]}
                }
            },
        }
    }
    st, body = _post(BUFFER_GQL, {"query": query, "variables": variables},
                     {"Authorization": f"Bearer {tok}"})
    res = ((body or {}).get("data") or {}).get("createPost") or {}
    post = res.get("post") or {}
    if st == 200 and post.get("id"):
        return True, f"buffer:{post['id']}"
    return False, str(res.get("message") or (body or {}).get("errors") or "")[:80]


def send_x(cand, text):
    """Reply to a tweet by id via X `/2/tweets`, falling back to Buffer Quote-Tweet
    (`send_x_via_buffer`) when X API write credits are depleted (402/403) or only
    `PRESS_BUFFER_TOKEN` / `AO_BUFFER_TOKEN` is configured."""
    import os
    tok = os.environ.get("AO_X_REPLY_TOKEN", "").strip()
    buf_tok = (os.environ.get("PRESS_BUFFER_TOKEN") or os.environ.get("AO_BUFFER_TOKEN") or "").strip()
    if tok:
        try:
            st, body = _post("https://api.twitter.com/2/tweets",
                             {"text": text[:280], "reply": {"in_reply_to_tweet_id": str(cand["id"])}},
                             {"Authorization": f"Bearer {tok}"})
            if st == 201:
                return True, (body.get("data") or {}).get("id", "")
        except urllib.error.HTTPError as e:
            if not buf_tok or e.code not in (401, 402, 403, 429):
                raise
    if buf_tok:
        return send_x_via_buffer(cand, text)
    if not tok:
        raise KeyError("AO_X_REPLY_TOKEN")
    return False, ""

def send_linkedin(cand, text):
    """Comment on a LinkedIn post by its URN (urn:li:share:...). Targets come from the
    import file (LinkedIn's free member API can POST comments but cannot search) — the
    owner or a VA drops post links into press/replies/import-linkedin.json and `find`
    picks them up. Needs AO_LI_REPLY_TOKEN (member token, w_member_social)."""
    import os
    tok = os.environ["AO_LI_REPLY_TOKEN"]
    st, body = _post(f"https://api.linkedin.com/v2/socialActions/{cand['id']}/comments",
                     {"actor": cand.get("actor_urn", ""), "object": cand["id"],
                      "message": {"text": text[:1200]}},
                     {"Authorization": f"Bearer {tok}",
                      "X-Restli-Protocol-Version": "2.0.0"})
    return st in (200, 201), str((body or {}).get("id", "") or body or "")[:80]

def cmd_send(drafts_file: str) -> int:
    drafts = json.loads(Path(drafts_file).read_text())
    cands = json.loads((RDIR / "candidates.json").read_text())
    idx = {c["id"]: c for c in cands}
    probs = validate_drafts(drafts, cands)
    if probs:
        [print("✗", p, file=sys.stderr) for p in probs]
        return 1
    led = _ledger()
    today = date.today().isoformat()
    sent_today = {}
    for v in led.values():
        if v.get("day") == today:
            sent_today[v["platform"]] = sent_today.get(v["platform"], 0) + 1
    for d in drafts:
        cand = idx[d["target"]]
        if d["target"] in led:
            print(f"~ already replied to {d['target'][:12]}")
            continue
        if sent_today.get(cand["platform"], 0) >= 5:
            print(f"✗ daily cap hit for {cand['platform']}; skipping rest")
            return 1
        fn = {"devto": send_devto, "nostr": send_nostr, "bsky": send_bsky,
              "x": send_x, "linkedin": send_linkedin}[cand["platform"]]
        try:
            ok, ref = fn(cand, d["reply"])
            time.sleep(8)  # rate silence beats eloquence
        except urllib.error.HTTPError as e:
            print(f"✗ {cand['platform']} {e.code}: {e.read()[:120]!r}")
            continue
        except KeyError as e:
            print(f"✗ {cand['platform']} needs env/credential: {e}")
            continue
        if ok:
            print(f"✓ replied on {cand['platform']} → {str(ref)[:60]}")
            led[d["target"]] = {"day": today, "platform": cand["platform"], "ref": str(ref)}
            RDIR.mkdir(exist_ok=True)
            (RDIR / "sent.json").write_text(json.dumps(led, indent=1))
            sent_today[cand["platform"]] = sent_today.get(cand["platform"], 0) + 1
    return 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "find":
        h = int(a[a.index("--hours") + 1]) if "--hours" in a else 12
        f = a[a.index("--import") + 1] if "--import" in a else ""
        sys.exit(cmd_find(h, f))
    if a and a[0] == "send":
        sys.path.insert(0, str(ROOT))
        sys.exit(cmd_send(a[1]))
    print(__doc__)
    sys.exit(2)

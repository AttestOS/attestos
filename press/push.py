#!/usr/bin/env python3
"""AttestOS press kit (ported from the STPi mesh): value-first distribution.

Buffer GraphQL API schedules X / LinkedIn / Pinterest (media-by-url); dev.to REST
publishes long-form. Hashnode's GraphQL API went paid (2026-05) — until the blog is
Pro, its articles are pasted from press/articles/*.md by hand; the same files work.

Keys live in env vars, never in this repo, never in argv, never printed:
  AO_BUFFER_TOKEN   (personal API key from publish.buffer.com/settings/api)
  AO_DEVTO_KEY      (dev.to API key)

Usage:
  python press/push.py plan                     # validate + show what would go out
  python press/push.py send                     # schedule everything un-sent (Buffer)
  python press/push.py send --preflight         # canary: send only the first (future-dated) item
  python press/push.py devto <article.md> [--publish]   # push a long-form article

Sent-state ledger: press/sent.json (ids only, no secrets). Re-running is a no-op for
already-sent ids, so a partial night never double-posts.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
QUEUE_F = ROOT / "queue.json"
SENT_F = ROOT / "sent.json"
IMG_BASE = "https://attestos-edge.attestos.workers.dev/covers/"
VID_BASE = f"https://raw.githubusercontent.com/{os.environ.get('AO_VIDEOS_REPO', 'AttestOS/attestos-videos')}/main/"
BUFFER_GQL = "https://api.buffer.com/graphql"
DEVTO_API = "https://dev.to/api"
UA = "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0"   # dev.to sits behind CF bot checks
LIMITS = {
    "twitter": 280, "x": 280,
    "linkedin": 3000,
    "pinterest": 500,
    "facebook": 2000,
    "instagram": 2200,
    "threads": 500,
    "youtube": 5000,
    "tiktok": 2200,
    "gbp": 1500,
}
# Company Buffer Account A channels for the manual queue (queue.json). AttestOS keeps no
# hardcoded ids: set AO_CHANNEL_TWITTER / _LINKEDIN / _PINTEREST (the autopilot discovers them itself).
CHANNEL_IDS = {k: os.environ.get(f"AO_CHANNEL_{k.upper()}", "").strip()
               for k in ("twitter", "linkedin", "pinterest")}


def load_queue() -> dict:
    return json.loads(QUEUE_F.read_text())


def validate_queue(q: dict, *, allow_past: bool = False) -> list[str]:
    """Return a list of problems; empty list means the slate is clean."""
    problems = []
    seen = set()
    for it in q["items"]:
        iid = it.get("id", "?")
        if iid in seen:
            problems.append(f"{iid}: duplicate id")
        seen.add(iid)
        ch = it.get("channel")
        if ch not in LIMITS:
            problems.append(f"{iid}: unknown channel {ch!r}")
            continue
        if CHANNEL_IDS.get(ch) and it.get("channel_id") != CHANNEL_IDS[ch]:
            problems.append(f"{iid}: channel_id mismatch for {ch}")
        text = it.get("text", "")
        if not text:
            problems.append(f"{iid}: empty text")
        if len(text) > LIMITS[ch]:
            problems.append(f"{iid}: {len(text)} chars over {LIMITS[ch]} for {ch}")
        for banned in ("—", "–"):  # bible voice: no em/en dashes in public copy
            if banned in text:
                problems.append(f"{iid}: contains {banned!r} (voice rule)")
        for leak in ("apik_", "ghp_", "whop_", "sk_live", "Bearer "):
            if leak in text:
                problems.append(f"{iid}: leaks a secret-shaped token {leak!r}")
        if ch == "pinterest" and not it.get("image"):
            problems.append(f"{iid}: pinterest pin requires an image")
        if ch == "pinterest" and not re.fullmatch(r"pin-[a-z0-9\-]+\.png", it.get("image", "")):
            problems.append(f"{iid}: image must be a press/img filename")
        if ch == "pinterest" and it.get("board","").startswith("nope"):
            problems.append(f"{iid}: placeholder board id")
        if ch == "pinterest" and not it.get("board"):
            problems.append(f"{iid}: pinterest requires a board id")
        try:
            due = datetime.fromisoformat(it["due"].replace("Z", "+00:00"))
            if not allow_past and due <= datetime.now(timezone.utc):
                problems.append(f"{iid}: due time is in the past")
        except Exception as e:  # noqa: BLE001
            problems.append(f"{iid}: unparseable due ({e})")
    return problems


def build_create_post_input(item: dict) -> dict:
    inp = {
        "channelId": item["channel_id"],
        "text": item["text"],
        "assets": [],
        "mode": "customScheduled",
        "schedulingType": "automatic",
        "dueAt": item["due"],
    }
    # Video posts pull MP4s from AO_VIDEOS_REPO; image posts carry the Worker's /api/press/img card
    vid = item.get("video_url") or item.get("video") or ""
    src = item.get("image_url") or item.get("image") or ""
    if vid:
        inp["assets"] = [{"video": {"url": vid if vid.startswith("https://") else VID_BASE + vid.lstrip("/")}}]
    elif src:
        inp["assets"] = [{"image": {"url": src if src.startswith("https://") else IMG_BASE + src}}]
    if item.get("url"):
        inp["text"] = item["text"] + "\n\n" + item["url"]
    if item.get("board"):
        inp["metadata"] = {"pinterest": {"boardServiceId": item["board"],
                                         "title": item.get("pin_title", "")[:100],
                                         "url": item.get("link")}}
    elif item.get("youtube_title"):
        inp["metadata"] = {"youtube": {"title": item["youtube_title"][:100]}}
    return inp


def _gql(query: str, variables: dict, token: str) -> dict:
    body = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(BUFFER_GQL, data=body, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": UA,
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


MUTATION = ("mutation($i: CreatePostInput!) { createPost(input: $i) { __typename "
            "... on PostActionSuccess { post { id status dueAt } } "
            "... on InvalidInputError { message } ... on UnexpectedError { message } "
            "... on LimitReachedError { message } } }")


def _load_sent() -> dict:
    return json.loads(SENT_F.read_text()) if SENT_F.exists() else {}


def cmd_send(*, preflight: bool = False) -> int:
    token = os.environ.get("AO_BUFFER_TOKEN", "").strip()
    if not token:
        print("AO_BUFFER_TOKEN missing in env", file=sys.stderr)
        return 2
    q = load_queue()
    problems = validate_queue(q, allow_past=preflight)
    if problems:
        print("queue has problems:", file=sys.stderr)
        [print("  -", p, file=sys.stderr) for p in problems]
        return 1
    sent = _load_sent()
    items = q["items"][:1] if preflight else q["items"]   # canary: first future-dated post only
    rc = 0
    for it in items:
        if it["id"] in sent:
            print(f"~ {it['id']}: already sent {sent[it['id']].get('at')}")
            continue
        resp = _gql(MUTATION, {"i": build_create_post_input(it)}, token)
        if resp.get("errors"):
            print(f"✗ {it['id']}: {resp['errors'][0].get('message')}", file=sys.stderr)
            rc = 1
            if preflight:
                break
            continue
        cp = (resp.get("data") or {}).get("createPost") or {}
        if cp.get("__typename") != "PostActionSuccess":
            print(f"✗ {it['id']}: {cp.get('__typename')}: {cp.get('message')}", file=sys.stderr)
            rc = 1
            if preflight:
                break
            continue
        post = cp.get("post") or {}
        print(f"✓ {it['id']}: {it['channel']} → {post.get('status') or cp['__typename']} "
              f"post={post.get('id') or '-'}")
        sent[it["id"]] = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                          "resp": cp}
        SENT_F.write_text(json.dumps(sent, indent=1))
        if preflight:
            break
    return rc


FRONT = re.compile(r"^---\n(.*?)\n---\n", re.S)


def parse_article(path: Path) -> tuple[dict, str]:
    raw = path.read_text()
    m = FRONT.match(raw)
    meta = {}
    if m:
        for line in m.group(1).splitlines():
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip().strip('"')
    return meta, raw[m.end():] if m else raw


def cmd_devto(art: str, publish: bool) -> int:
    key = os.environ.get("AO_DEVTO_KEY", "").strip()
    if not key:
        print("AO_DEVTO_KEY missing in env", file=sys.stderr)
        return 2
    meta, body = parse_article(Path(art))
    payload = {
        "article": {
            "title": meta.get("title", Path(art).stem.replace("-", " ")),
            "body_markdown": body,
            "tags": [t.strip() for t in meta.get("tags", "").split(",") if t.strip()],
            "published": bool(publish),
        }
    }
    req = urllib.request.Request(DEVTO_API + "/articles", data=json.dumps(payload).encode(),
                                 headers={"api-key": key, "Content-Type": "application/json",
                                          "User-Agent": UA}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read())
        print(f"✓ dev.to {'published' if payload['article']['published'] else 'draft'}: "
              f"https://dev.to{d.get('path')}  (id {d.get('id')})")
        return 0
    except urllib.error.HTTPError as e:
        print(f"✗ dev.to {e.code}: {e.read()[:300].decode('utf-8', 'replace')}", file=sys.stderr)
        return 1


def cmd_plan() -> int:
    q = load_queue()
    problems = validate_queue(q, allow_past=True)
    sent = set(_load_sent())
    print(f"{len(q['items'])} items, {len(sent)} already sent")
    for it in q["items"]:
        flag = "sent" if it["id"] in sent else "queued"
        print(f"  [{flag:5}] {it['due']}  {it['channel']:9} {it['id']}  ({len(it['text'])} chars)")
    if problems:
        print("problems:")
        [print("  -", p) for p in problems]
    return 1 if problems else 0


def cmd_nostr(argv: list[str]) -> int:
    import nostr
    if not argv:
        print("usage: nostr profile|article <md>|verify", file=sys.stderr)
        return 2
    if argv[0] == "verify":
        return nostr.cmd_publish("verify")
    if argv[0] == "article" and len(argv) > 1:
        return nostr.cmd_publish("article", argv[1], parser=parse_article)
    if argv[0] == "profile":
        return nostr.cmd_publish("profile")
    print("usage: nostr profile|article <md>|verify", file=sys.stderr)
    return 2


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] == "plan":
        sys.exit(cmd_plan())
    if args[0] == "send":
        sys.exit(cmd_send(preflight="--preflight" in args))
    if args[0] == "devto":
        sys.exit(cmd_devto(args[1], "--publish" in args))
    if args[0] == "nostr":
        sys.exit(cmd_nostr(args[1:]))
    print(__doc__)
    sys.exit(2)

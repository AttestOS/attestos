#!/usr/bin/env python3
"""announce_storefront.py - put the answer pages and the writing on the Whop storefront.

Whop exposes no endpoint for storefront navigation, but POST /forum_posts writes into the public
forum that sits on the hub a buyer lands on. This posts one pinned entry carrying the two links,
and does nothing if that entry is already there.

Env: WHOP_API_KEY (or the repo's own key name), WHOP_COMPANY_ID, WHOP_PUBLIC_EXP_ID,
     VENTURE_NAME, ANSWERS_URL, WRITING_URL.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.whop.com/api/v1"
MARKER = "Every question, answered in plain terms"


def call(key, path, method="GET", body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + key,
                                          "User-Agent": "announce/1.0", "Accept": "application/json",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read()[:300].decode("utf-8", "replace")}
    except Exception as e:  # noqa: BLE001
        return 0, {"error": str(e)[:200]}


def main() -> int:
    key = os.environ.get("WHOP_API_KEY", "").strip()
    company = os.environ.get("WHOP_COMPANY_ID", "").strip()
    exp = os.environ.get("WHOP_PUBLIC_EXP_ID", "").strip()
    venture = os.environ.get("VENTURE_NAME", "").strip() or "this product"
    answers = os.environ.get("ANSWERS_URL", "").strip()
    writing = os.environ.get("WRITING_URL", "").strip()
    if not (key and company and answers and writing):
        print("missing env: key/company/answers/writing", file=sys.stderr)
        return 2

    if not exp:
        st, data = call(key, "/experiences?company_id=%s" % company)
        if st != 200:
            print("cannot list experiences: %s %s" % (st, str(data)[:150]), file=sys.stderr)
            return 1
        items = data.get("data", data)
        forum = next((e for e in items if "forum" in (e.get("name") or "").lower()), None)
        exp = (forum or {}).get("id", "")
    if not exp:
        print("no public forum experience found", file=sys.stderr)
        return 1

    st, data = call(key, "/forum_posts?experience_id=%s&first=50" % exp)
    posts = data.get("data", data) if st == 200 else []
    for p in posts if isinstance(posts, list) else []:
        if MARKER in (p.get("title") or ""):
            print("already posted: %s" % p.get("id"))
            return 0

    title = "%s - %s" % (MARKER, venture)
    content = (
        "The questions buyers actually ask, answered in full, with the numbers on the page rather "
        "than in a sales call:\n\n"
        "**Every question about %s** - %s\n\n"
        "**The longer write-up** - %s\n\n"
        "Every claim on those pages carries how to check it. Nothing there is a claim we cannot show "
        "you the evidence for." % (venture, answers, writing))
    st, res = call(key, "/forum_posts", "POST", {
        "experience_id": exp, "account_id": company, "title": title, "content": content,
        "pinned": True, "is_mention": False})
    if st in (200, 201):
        print("posted %s (pinned) in %s" % (res.get("id"), exp))
        return 0
    print("POST failed %s %s" % (st, str(res)[:300]), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

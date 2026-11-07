#!/usr/bin/env python3
"""Tumblr OAuth 1.0a handshake helper (AttestOS press).

Two commands:

  python3 tumblr_connect.py link
      Mint a request token, persist it to ~/.tumblr_pending.json, print the authorize URL.

  python3 tumblr_connect.py exchange "<the redirect URL you landed on>"
      Take the oauth_token + oauth_verifier out of that URL, exchange them for the access
      token, verify it against /v2/user/info, and print the blog details plus the three
      values the press needs.

Why this file exists: OAuth 1.0a needs the request-token SECRET as well as the token to sign
the exchange, so the secret has to outlive the process that minted it. The first attempt kept
it in /tmp, which does not survive between sessions, and the verifier the owner approved could
not be used. The pending pair is now written under the home directory instead.

No third-party dependencies: the signature is HMAC-SHA1 built with hmac and hashlib, so this
runs anywhere the press runs.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PENDING_F = Path.home() / ".tumblr_pending.json"
CK = os.environ.get("TUMBLR_CK", "fiITy5CxH54rRlPCpGpzVFkUS92y8C8vJPSsq16uCM9x3ehC6z").strip()
CS = os.environ.get("TUMBLR_CS", "86YxVqtnYhNQ3BgXUzBwDvZQkgYzfwekcXnydk7fZ6AHAbfhba").strip()
UA = "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0"

REQUEST_URL = "https://www.tumblr.com/oauth/request_token"
AUTHORIZE_URL = "https://www.tumblr.com/oauth/authorize"
ACCESS_URL = "https://www.tumblr.com/oauth/access_token"


def _q(s: str) -> str:
    """RFC 5849 percent-encoding: quote everything except unreserved characters."""
    return urllib.parse.quote(str(s), safe="~-._")


def sign(method: str, url: str, params: dict, ck: str, cs: str,
         token: str = "", token_secret: str = "", body: dict | None = None) -> str:
    """OAuth 1.0a Authorization header for one request (HMAC-SHA1)."""
    oauth = {
        "oauth_consumer_key": ck,
        "oauth_nonce": secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_version": "1.0",
    }
    if token:
        oauth["oauth_token"] = token
    signing = dict(oauth)
    signing.update(params or {})
    signing.update(body or {})
    parts = sorted((_q(k), _q(v)) for k, v in signing.items())
    param_str = "&".join(f"{k}={v}" for k, v in parts)
    base_url = url.split("?")[0]
    base = "&".join([method.upper(), _q(base_url), _q(param_str)])
    key = f"{_q(cs)}&{_q(token_secret)}".encode()
    digest = hmac.new(key, base.encode(), hashlib.sha1).digest()
    oauth["oauth_signature"] = base64.b64encode(digest).decode()
    return "OAuth " + ", ".join(f'{_q(k)}="{_q(v)}"' for k, v in sorted(oauth.items()))


def _call(url: str, method: str = "GET", params: dict | None = None, body: dict | None = None,
          ck: str = CK, cs: str = CS, token: str = "", token_secret: str = "") -> tuple[int, str]:
    headers = {"User-Agent": UA,
               "Authorization": sign(method, url, params or {}, ck, cs, token, token_secret, body)}
    data = None
    if body is not None:
        data = urllib.parse.urlencode(body).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    full = url + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(full, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def cmd_link() -> int:
    st, txt = _call(REQUEST_URL, "POST")
    if st != 200:
        print(f"request_token failed: HTTP {st}: {txt[:300]}")
        return 1
    d = dict(urllib.parse.parse_qsl(txt))
    PENDING_F.write_text(json.dumps({"token": d["oauth_token"],
                                     "secret": d["oauth_token_secret"],
                                     "at": int(time.time())}, indent=1))
    os.chmod(PENDING_F, 0o600)
    print(f"pending token saved to {PENDING_F} (mode 600)")
    print("\nOpen this, sign in as the AttestOS blog, and approve:\n")
    print(f"  {AUTHORIZE_URL}?oauth_token={d['oauth_token']}\n")
    print("Tumblr will bounce you to the app's registered callback URL. Paste that whole URL back.")
    return 0


def cmd_exchange(url: str) -> int:
    try:
        pend = json.loads(PENDING_F.read_text())
    except Exception:
        print(f"no pending token at {PENDING_F}: run `python3 tumblr_connect.py link` first")
        return 1
    qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    tok = (qs.get("oauth_token") or [""])[0]
    ver = (qs.get("oauth_verifier") or [""])[0]
    if not ver:
        ver = url.strip()          # tolerate a bare verifier being pasted
    if not ver:
        print("no oauth_verifier in that URL")
        return 1
    if tok and tok != pend["token"]:
        print(f"warning: URL token {tok[:8]}... is not the pending one {pend['token'][:8]}...; trying anyway")
    st, txt = _call(ACCESS_URL, "POST", body={"oauth_verifier": ver},
                    token=pend["token"], token_secret=pend["secret"])
    if st != 200:
        print(f"access_token failed: HTTP {st}: {txt[:300]}")
        print("request tokens expire: if this is old, run `link` again and approve a fresh one")
        return 1
    d = dict(urllib.parse.parse_qsl(txt))
    print("ACCESS TOKEN OK")
    print(f"  oauth_token        = {d['oauth_token']}")
    print(f"  oauth_token_secret = {d['oauth_token_secret']}")

    # prove it works and find the blog name, in the same breath
    st, txt = _call("https://api.tumblr.com/v2/user/info",
                    token=d["oauth_token"], token_secret=d["oauth_token_secret"])
    print(f"\n/v2/user/info -> HTTP {st}")
    blogs = []
    if st == 200:
        info = json.loads(txt).get("response", {}).get("user", {})
        blogs = info.get("blogs") or []
        print(f"  user: {info.get('name')}")
        for b in blogs:
            print(f"  blog: {b.get('name')} | title={b.get('title')!r} | posts={b.get('posts')} | primary={b.get('primary')}")
    out = Path.home() / "tumblr_token.json"
    out.write_text(json.dumps({"token": d["oauth_token"], "secret": d["oauth_token_secret"],
                               "blogs": [b.get("name") for b in blogs]}, indent=1))
    os.chmod(out, 0o600)
    PENDING_F.unlink(missing_ok=True)
    primary = next((b.get("name") for b in blogs if b.get("primary")), (blogs[0].get("name") if blogs else ""))
    print(f"\nnext: set secrets AO_TUMBLR_TOKEN, AO_TUMBLR_TOKEN_SECRET, AO_TUMBLR_BLOG={primary or '<blog>'}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("link", "exchange"):
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(cmd_link() if sys.argv[1] == "link"
                     else cmd_exchange(sys.argv[2] if len(sys.argv) > 2 else ""))

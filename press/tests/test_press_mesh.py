"""2026-10-13 (owner): the distribution mesh build. No network — every publisher is faked.
Covers: the regional rails (telegram/facebook) cred-gating + senders, the reply engine's
x/linkedin senders, whop's account_id fix, and the owner-console mesh overrides (park /
resume / per_day) the press cycle pulls from mint at start."""
import importlib.util as _ilu
import json
import os
from pathlib import Path

import pytest

pytest.importorskip("coincurve", reason="install the [press] extra")

ROOT = Path(__file__).resolve().parents[2]
spec = _ilu.spec_from_file_location("stpi_press_auto", ROOT / "press" / "auto.py")
auto = _ilu.module_from_spec(spec)
spec.loader.exec_module(auto)

rspec = _ilu.spec_from_file_location("stpi_press_reply", ROOT / "press" / "reply.py")
reply = _ilu.module_from_spec(rspec)
rspec.loader.exec_module(reply)


# ---- 1. the regional rails arm only with credentials ------------------------

def test_telegram_rail_gated_on_credentials(monkeypatch):
    monkeypatch.delenv("AO_TG_BOT_TOKEN", raising=False)
    monkeypatch.delenv("AO_TG_CHANNEL", raising=False)
    assert auto._rail_armed("telegram") is False
    monkeypatch.setenv("AO_TG_BOT_TOKEN", "123:abc")
    monkeypatch.setenv("AO_TG_CHANNEL", "@stpi_jobs_zw")
    assert auto._rail_armed("telegram") is True


def test_facebook_rail_gated_on_credentials(monkeypatch):
    monkeypatch.delenv("AO_FB_PAGE_TOKEN", raising=False)
    monkeypatch.delenv("AO_FB_PAGE_ID", raising=False)
    assert auto._rail_armed("facebook") is False
    monkeypatch.setenv("AO_FB_PAGE_TOKEN", "EAAG...")
    monkeypatch.setenv("AO_FB_PAGE_ID", "1122334455")
    assert auto._rail_armed("facebook") is True


def test_new_rails_are_seeker_value_rails_with_limits():
    for rail in ("telegram", "facebook"):
        assert rail in auto.SEEKER_RAILS
        assert rail in auto.VALUE_PLATFORMS
        assert rail in auto.LIMITS


def test_pub_telegram_sends_and_falls_back(monkeypatch):
    calls = []

    class Resp:
        def __init__(self, code, body): self.status, self.body = code, body
        def read(self, b=-1): return json.dumps(self.body).encode()[:b] if b > 0 else json.dumps(self.body).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout=30):
        from urllib.parse import parse_qs, urlparse
        u = urlparse(req.full_url)
        q = parse_qs((req.data or b"").decode())
        calls.append((u.path.split("/")[-1], q))
        if u.path.endswith("sendPhoto"):
            return Resp(200, {"ok": True, "result": {"message_id": 42}})
        return Resp(200, {"ok": True, "result": {"message_id": 43}})

    monkeypatch.setenv("AO_TG_BOT_TOKEN", "123:abc")
    monkeypatch.setenv("AO_TG_CHANNEL", "@stpi_jobs_zw")
    monkeypatch.setattr(auto.urllib.request, "urlopen", fake_urlopen)
    assert auto.pub_telegram("hello from the mesh", {"url": "https://x/img.png"}) is True
    assert calls[0][0] == "sendPhoto" and calls[0][1]["chat_id"] == ["@stpi_jobs_zw"]
    # text-only post
    assert auto.pub_telegram("plain text", None) is True
    assert calls[-1][0] == "sendMessage"


def test_pub_telegram_no_keys_is_a_silent_skip(monkeypatch):
    monkeypatch.delenv("AO_TG_BOT_TOKEN", raising=False)
    assert auto.pub_telegram("x") is False        # skip_no_key, no exception


def test_pub_facebook_posts_photo_then_feed(monkeypatch):
    calls = []

    class Resp:
        def __init__(self, code, body): self.status, self.body = code, body
        def read(self, b=-1): return json.dumps(self.body).encode()[:b] if b > 0 else json.dumps(self.body).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout=30):
        from urllib.parse import parse_qs, urlparse
        u = urlparse(req.full_url)
        q = parse_qs((req.data or b"").decode())
        calls.append((u.path, q))
        if u.path.endswith("/photos"):
            return Resp(200, {"id": "ph1", "post_id": "p_1"})
        return Resp(200, {"id": "feed_1"})

    monkeypatch.setenv("AO_FB_PAGE_TOKEN", "EAAG...")
    monkeypatch.setenv("AO_FB_PAGE_ID", "1122334455")
    monkeypatch.setattr(auto.urllib.request, "urlopen", fake_urlopen)
    assert auto.pub_facebook("closing dates matter", {"url": "https://x/c.png"}, "https://getstpi.pages.dev/") is True
    assert calls[0][0].endswith("1122334455/photos")
    assert auto.pub_facebook("feed only", None, "") is True
    assert calls[-1][0].endswith("1122334455/feed")


# ---- 2. the reply engine's x + linkedin senders -----------------------------

def test_find_x_mentions_needs_credentials(monkeypatch):
    monkeypatch.delenv("AO_X_REPLY_TOKEN", raising=False)
    monkeypatch.delenv("AO_X_REPLY_UID", raising=False)
    assert reply.find_x_mentions() == []          # quiet rail, no alarm


def test_find_x_mentions_parses_and_skips_self(monkeypatch):
    monkeypatch.setenv("AO_X_REPLY_TOKEN", "tok")
    monkeypatch.setenv("AO_X_REPLY_UID", "111")
    seen = {}

    def fake_get(url, hdr=None):
        seen["url"] = url
        return 200, {"data": [{"id": "9001", "text": "hey @stpi does this draft letters?",
                               "author_id": "222", "created_at": "2026-10-13T10:00:00Z"},
                              {"id": "9002", "text": "our own post", "author_id": "111"}],
                     "includes": {"users": [{"id": "222", "username": "asker"}]}}

    monkeypatch.setattr(reply, "_get", fake_get)
    out = reply.find_x_mentions()
    assert "users/111/mentions" in seen["url"]
    assert len(out) == 1 and out[0]["platform"] == "x" and out[0]["author"] == "asker"


def test_send_x_and_send_linkedin_shapes(monkeypatch):
    calls = []

    def fake_post(url, payload, hdr=None, form=False):
        calls.append((url, payload, hdr or {}))
        if "twitter" in url:
            return 201, {"data": {"id": "777"}}
        return 201, {"id": "urn:li:comment:(share:1,c1)"}

    monkeypatch.setattr(reply, "_post", fake_post)
    monkeypatch.setenv("AO_X_REPLY_TOKEN", "tok")
    ok, ref = reply.send_x({"id": "9001"}, "we feel you — here is the mechanism")
    assert ok and ref == "777" and calls[0][1]["reply"]["in_reply_to_tweet_id"] == "9001"
    monkeypatch.setenv("AO_LI_REPLY_TOKEN", "tok")
    ok, ref = reply.send_linkedin({"id": "urn:li:share:abc", "actor_urn": "urn:li:person:x"},
                                  "a comment")
    assert ok and "socialActions/urn:li:share:abc/comments" in calls[1][0]
    assert calls[1][2].get("X-Restli-Protocol-Version") == "2.0.0"


def test_reply_platform_map_knows_all_senders():
    import inspect
    src = inspect.getsource(reply.cmd_send)
    for name in ("send_devto", "send_nostr", "send_bsky", "send_x", "send_linkedin"):
        assert name in src


# ---- 3. whop: account_id rides every forum post (the Oct-9 breakage) --------

def test_whop_forum_post_carries_account_id(monkeypatch):
    posts = []

    def fake_api(path, method="GET", body=None, key=None):
        if method == "POST" and path == "/forum_posts":
            posts.append(body)
            return 200, {"id": "post_x1"}
        if path.startswith("/forum_posts/"):
            return 200, {"content": (posts[0]["content"] if posts else "")[:200]}
        return 200, {}

    monkeypatch.setenv("WHOP_COMPANY_ID", "biz_1")
    monkeypatch.setenv("WHOP_API_KEY", "k")
    monkeypatch.setattr(auto, "_whop_api", fake_api)
    assert auto._whop_forum_post("exp_1", "the post text", "title", key="k") is True
    assert posts[0].get("account_id") == "biz_1", "Whop rejects experience-only posts since Oct-9"


# ---- 4. mesh overrides: park / resume / per_day -----------------------------

def test_fetch_mesh_overrides_parks_and_tunes(monkeypatch):
    st = {"rail_off": {}, "rail_parked": {}, "channel_last": {}}

    class FakeResp:
        def read(self, b=-1): return json.dumps(
            {"rails": {"bsky": {"parked": True}, "x": {"per_day": 1}}}).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setenv("AO_SITE_URL", "https://mint.example")
    monkeypatch.setenv("AO_PRESS_TOKEN", "tok")
    monkeypatch.setattr(auto.urllib.request, "urlopen", lambda req, timeout=20: FakeResp())
    auto._CAD_OVERRIDE.clear()
    auto.fetch_mesh_overrides(st)
    assert st["rail_off"]["bsky"] == "2099-01-01T00:00:00+00:00"
    assert "owner console" in st["rail_parked"]["bsky"]["reason"]
    assert auto._CAD_OVERRIDE["x"] == {"per_day": 1}
    cad = auto.load_cadence()
    assert cad["x"]["per_day"] == 1                                 # override applied


def test_fetch_mesh_overrides_resume_only_its_own_parks(monkeypatch):
    st = {"rail_off": {"x": "2099-01-01T00:00:00+00:00"},
          "rail_parked": {"x": {"until": "2099-01-01T00:00:00+00:00",
                                "reason": "parked from the owner console (mesh page)"},
                          "pinterest": {"until": "soon", "reason": "Buffer channel gone"}},
          "channel_last": {}}

    class FakeResp:
        def read(self, b=-1): return json.dumps({"rails": {"x": {"parked": False}}}).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setenv("AO_SITE_URL", "https://mint.example")
    monkeypatch.setenv("AO_PRESS_TOKEN", "tok")
    monkeypatch.setattr(auto.urllib.request, "urlopen", lambda req, timeout=20: FakeResp())
    auto.fetch_mesh_overrides(st)
    assert "x" not in st["rail_off"] and "x" not in st["rail_parked"]
    assert "pinterest" in st["rail_parked"]       # a non-console park (Buffer 404) survives


def test_fetch_mesh_overrides_never_fatal(monkeypatch):
    def boom(req, timeout=20): raise OSError("mint down")
    monkeypatch.setenv("AO_SITE_URL", "https://mint.example")
    monkeypatch.setenv("AO_PRESS_TOKEN", "tok")
    monkeypatch.setattr(auto.urllib.request, "urlopen", boom)
    auto.fetch_mesh_overrides({"channel_last": {}})      # returns quietly; cadence rules


# ---- 5. owner-console runtime settings (owner 2026-10-14: no repo edits for keys) ----

def test_fetch_runtime_settings_fills_missing_env_only(monkeypatch):
    class FakeResp:
        def read(self, b=-1): return json.dumps({"settings": {
            "AO_TG_BOT_TOKEN": "123:abc", "PRESS_LLM_API_KEY": "gsk_console",
            "cadence:reply_per_day": "6"}}).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False
    monkeypatch.setenv("AO_SITE_URL", "https://mint.example")
    monkeypatch.setenv("AO_PRESS_TOKEN", "tok")
    monkeypatch.setattr(auto.urllib.request, "urlopen", lambda req, timeout=20: FakeResp())
    monkeypatch.delenv("AO_TG_BOT_TOKEN", raising=False)
    monkeypatch.setenv("PRESS_LLM_API_KEY", "gsk_github_secret")   # a real secret wins
    auto._CAD_OVERRIDE.clear()
    auto.fetch_runtime_settings({})
    assert os.environ["AO_TG_BOT_TOKEN"] == "123:abc"            # gap filled from console
    assert os.environ["PRESS_LLM_API_KEY"] == "gsk_github_secret"  # env kept priority
    assert auto._CAD_OVERRIDE["reply_per_day"] == "6"
    assert auto.load_cadence()["reply_per_day"] == 6               # knob merged over cadence.json


def test_fetch_runtime_settings_junk_names_never_touch_env(monkeypatch):
    class FakeResp:
        def read(self, b=-1): return json.dumps({"settings": {
            "rm -rf /": "x", "lowercase_name": "y", "meta:x_a:handle": "@agent",
            "cadence:reply_per_day": "7", "AO_OK_KEY": "z"}}).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False
    monkeypatch.setenv("AO_SITE_URL", "https://mint.example")
    monkeypatch.setenv("AO_PRESS_TOKEN", "tok")
    monkeypatch.setattr(auto.urllib.request, "urlopen", lambda req, timeout=20: FakeResp())
    auto.fetch_runtime_settings({})
    assert "rm -rf /" not in os.environ and "lowercase_name" not in os.environ
    assert "meta:x_a:handle" not in os.environ      # console metadata never touches env
    assert auto.load_cadence()["reply_per_day"] == 7
    assert os.environ.get("AO_OK_KEY") == "z"


def test_fetch_runtime_settings_never_fatal(monkeypatch):
    monkeypatch.setenv("AO_SITE_URL", "https://mint.example")
    monkeypatch.setenv("AO_PRESS_TOKEN", "tok")
    def boom(req, timeout=20): raise OSError("mint down")
    monkeypatch.setattr(auto.urllib.request, "urlopen", boom)
    auto.fetch_runtime_settings({})       # returns quietly, env untouched


def test_mastodon_and_discord_armed_and_publish(monkeypatch):
    monkeypatch.delenv("AO_MASTODON_TOKEN", raising=False)
    monkeypatch.delenv("AO_DISCORD_PRESS_WEBHOOK", raising=False)
    assert auto._rail_armed("mastodon") is False
    assert auto._rail_armed("discord") is False
    monkeypatch.setenv("AO_MASTODON_TOKEN", "m_tok")
    monkeypatch.setenv("AO_DISCORD_PRESS_WEBHOOK", "https://discord.com/api/webhooks/1/a")
    assert auto._rail_armed("mastodon") is True
    assert auto._rail_armed("discord") is True

    calls = []
    class FakeResp:
        status = 200
        def __init__(self, body): self._b = body
        def read(self, b=-1): return self._b
        def __enter__(self): return self
        def __exit__(self, *a): return False
    def fake_open(req, timeout=30):
        calls.append(req.full_url)
        return FakeResp(json.dumps({"id": "12345"}).encode())
    monkeypatch.setattr(auto.urllib.request, "urlopen", fake_open)
    img_m = {"png": b"\x89PNG\r\n", "alt": "card"}
    assert auto.pub_mastodon("hello mastodon", img_m) is True
    assert img_m["attached"] is True
    img_d = {"url": "https://mint.example/c.png"}
    assert auto.pub_discord("hello discord", img_d) is True
    assert img_d["attached"] is True


def test_x_mentions_http_error_returns_empty(monkeypatch):
    monkeypatch.setenv("AO_X_REPLY_TOKEN", "tok")
    monkeypatch.setenv("AO_X_REPLY_UID", "111")
    def boom(u, h=None): raise RuntimeError("402 Payment Required")
    monkeypatch.setattr(reply, "_get", boom)
    assert reply.find_x_mentions(24) == []


def test_send_x_falls_back_to_buffer_quote_tweet(monkeypatch):
    import io
    import urllib.error
    calls = []

    def fake_post(url, payload, hdr=None, form=False):
        calls.append((url, payload, hdr or {}))
        if "twitter.com" in url:
            raise urllib.error.HTTPError(url, 402, "Payment Required", {}, io.BytesIO(b'{"title":"CreditsDepleted"}'))
        return 200, {"data": {"createPost": {"post": {"id": "buf_qt_1", "status": "sent"}}}}

    monkeypatch.setattr(reply, "_post", fake_post)
    monkeypatch.setenv("AO_X_REPLY_TOKEN", "tok")
    monkeypatch.setenv("PRESS_BUFFER_TOKEN", "buf_tok")
    monkeypatch.setenv("PRESS_BUFFER_X_CHANNEL_ID", "chan_x_1")
    ok, ref = reply.send_x({"id": "9001"}, "Mechanism beats mood: track reply timing.")
    assert ok and ref == "buffer:buf_qt_1"
    assert len(calls) == 2 and "api.buffer.com" in calls[1][0]
    inp = calls[1][1]["variables"]["input"]
    assert inp["channelId"] == "chan_x_1"
    assert inp["metadata"]["twitter"]["retweet"] == {
        "id": "9001",
        "comment": "Mechanism beats mood: track reply timing.",
    }



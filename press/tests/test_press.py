"""Press-kit tests: the slate is data, so we validate it hard and unit-test the builders.
No network: pushing to Buffer/dev.to is an operator action guarded by env keys."""
import importlib.util as _ilu
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

pytest.importorskip("coincurve", reason="install the [press] extra")

ROOT = Path(__file__).resolve().parents[2]
spec = _ilu.spec_from_file_location("stpi_press_push", ROOT / "press" / "push.py")
push = _ilu.module_from_spec(spec)
spec.loader.exec_module(push)


def test_builder_shape():
    pin = {"channel": "pinterest", "channel_id": "ch-pin", "text": "Shipping shown late", "due": "2030-01-01T10:00:00Z",
           "image": "store-audit-square.jpg", "board": "board-1", "link": "https://attestos-edge.attestos.workers.dev/store-audit"}
    inp = push.build_create_post_input(pin)
    assert inp["assets"] == [{"image": {"url": push.IMG_BASE + pin["image"]}}]
    assert push.IMG_BASE.startswith("https://attestos-edge.attestos.workers.dev/covers/")
    assert inp["dueAt"] == pin["due"] and inp["mode"] == "customScheduled"
    assert inp["metadata"]["pinterest"]["boardServiceId"] == "board-1"
    tw = {"channel": "twitter", "channel_id": "ch-x", "text": "a post", "due": "2030-01-01T10:00:00Z"}
    tinp = push.build_create_post_input(tw)
    assert tinp["assets"] == [] and tinp["mode"] == "customScheduled"
    assert tinp["schedulingType"] == "automatic"
    assert tinp["dueAt"] == tw["due"] and "saveToDraft" not in tinp


# ---- nostr channel (substitutes Hashnode; offline tests only, relays stay unhit) ----

import sys as _sys
_sys.path.insert(0, str(ROOT / "press"))
_sys.path.insert(1, str(ROOT))
import nostr  # noqa: E402

TEST_SK = "0000000000000000000000000000000000000000000000000000000000000021"

def _use_test_key(monkeypatch):
    monkeypatch.setenv("AO_NOSTR_NSEC", TEST_SK)

def test_bech32_npub_matches_live_identity():
    # npub is PUBLIC data by design; pinning it proves the bech32 implementation
    # against the real identity without touching the secret.
    from nostr import bech32_encode
    pk = "d4d7c4a683b71dcb59825b4dde60e9c8fb00c837eb0657fb9ecd6570ecc37e45"
    assert bech32_encode("npub", bytes.fromhex(pk)) == (
        "npub16ntuff5rkuwukkvztdxauc8feraspjphavr907u7e4jhpmxr0ezsks2ggp")
    assert nostr.bech32_decode("npub",
        "npub16ntuff5rkuwukkvztdxauc8feraspjphavr907u7e4jhpmxr0ezsks2ggp") == pk

def test_sign_and_verify_event(monkeypatch):
    _use_test_key(monkeypatch)
    ev = nostr.sign(1, [], "hello nostr", created=1700000000)
    import hashlib, json as _j
    pre = _j.dumps([0, ev["pubkey"], 1700000000, 1, [], "hello nostr"], separators=(",", ":"))
    assert ev["id"] == hashlib.sha256(pre.encode()).hexdigest()
    assert nostr.verify_sig(ev)
    ev["content"] = "tampered"
    assert not nostr.verify_sig(ev)

def test_derivation_and_nsec_env_roundtrip(monkeypatch):
    _use_test_key(monkeypatch)
    from coincurve import PrivateKey
    g_x = PrivateKey(bytes.fromhex(TEST_SK)).public_key.format(compressed=True)[1:].hex()
    assert nostr.pubkey_hex() == g_x                      # env hex form
    monkeypatch.setenv("AO_NOSTR_NSEC", nostr.bech32_encode("nsec", bytes.fromhex(TEST_SK)))
    assert nostr.pubkey_hex() == g_x                      # nsec1… form accepted too

def test_article_event_shape(monkeypatch):
    _use_test_key(monkeypatch)
    ev = nostr.build_article({"title": "T"}, "body", "slug-x", image="http://i.png")
    assert ev["kind"] == 30023
    tags = {t[0]: t[1] for t in ev["tags"]}
    assert tags["d"] == "slug-x" and tags["title"] == "T"
    assert tags.get("image") == "http://i.png" and "published_at" in tags
    assert nostr.verify_sig(ev)

def test_profile_event_valid_json_and_signed(monkeypatch):
    _use_test_key(monkeypatch)
    ev = nostr.profile_event()
    prof = json.loads(ev["content"])
    assert prof["name"] == "attestos" and "lud16" not in prof and "null" not in ev["content"]
    assert prof["website"].startswith("https://attestos-edge.attestos.workers.dev")
    assert ev["kind"] == 0 and nostr.verify_sig(ev)

# ---- reply engine guards (offline) ----
import reply as reply_mod  # noqa: E402  (press/ already on sys.path)

def _fake_cands():
    return [{"platform": "nostr", "id": "n1", "author": "a" * 64, "excerpt": "x"},
            {"platform": "bsky", "id": "at://did:x/app.bsky.feed.post/y", "cid": "c",
             "excerpt": "x", "author": "x.bsky.social"},
            {"platform": "devto", "id": "99", "excerpt": "x", "url": "/t", "title": "t",
             "author": "w", "score": 0}]

def test_reply_validation_rules():
    c = _fake_cands()
    good = "Great framing. Volume matters but timing beats it: apply within hours of posting and your reply rate changes for boring operational reasons, not wording."
    probs = reply_mod.validate_drafts([{"target": "n1", "reply": good}], c)
    assert probs == []
    assert any("under 120" in p for p in reply_mod.validate_drafts([{"target": "n1", "reply": "nice"}], c))
    assert any("links not allowed" in p for p in reply_mod.validate_drafts(
        [{"target": "n1", "reply": good + " see https://x.com"}], c))
    assert any("too long" in p for p in reply_mod.validate_drafts(
        [{"target": "n1", "reply": "z" * 400}], c))
    assert any("unknown target" in p for p in reply_mod.validate_drafts(
        [{"target": "nope", "reply": good}], c))

def test_pinterest_value_framing_is_form_security(monkeypatch):
    """Pinterest value posts read as form-security craft for store and site owners, via BOTH
    authoring paths (the STPi lesson: generic tips 'have nothing to do with our outfit')."""
    from press import auto
    topic = {"id": "x-doc", "title": "Every token should work once", "kind": "value", "format": "short",
             "audience": "ecom", "beats": ["Single use and a short expiry are the two properties to check"]}
    body = auto.compose_fake("value", topic, "pinterest")
    assert "form-security" in body and "store" in body, body
    for stale in ("coach", "candidate", "job", "CV"):
        assert stale not in body
    assert len(body) <= auto.LIMITS["pinterest"], len(body)
    monkeypatch.setenv("PRESS_FAKE_LLM", "1")
    out = auto.llm("", "value", topic, "pinterest", None)
    assert "form-security" in out, out
    assert auto.PIN_VALUE_FRAME.startswith("Pinterest frame:") and "job" not in auto.PIN_VALUE_FRAME


def test_parked_alert_for_removed_rail_is_dropped_not_pingable(tmp_path, monkeypatch):
    from datetime import timedelta as _td
    from press import auto
    # pinterest_a was removed from cadence.json 2026-10-08 (seller-a Buffer Pinterest dead);
    # its stale park entry must NOT keep alerting the owner, and the entry must be cleaned.
    st = {
        "rail_parked": {
            "pinterest_a": {"until": (auto.now() + _td(hours=10)).isoformat(timespec="seconds"),
                            "reason": "Buffer channel gone (NotFoundError)"},
            "x_b": {"until": (auto.now() + _td(hours=10)).isoformat(timespec="seconds"),
                    "reason": "platform takedown"},
        },
        "rail_off": {"pinterest_a": "x", "x_b": "x"},
    }
    saved = []
    monkeypatch.setattr(auto, "save_state", lambda s: saved.append(1))
    alerts = auto.parked_alerts(st)
    assert not any(a.startswith("pinterest_a") for a in alerts), alerts
    assert "pinterest_a" not in st["rail_parked"]
    assert "pinterest_a" not in st["rail_off"]
    assert saved, "the cleanup must persist (save_state)"
    assert any(a.startswith("x_b") for a in alerts), "enabled rails keep their alert"


def test_planner_skips_rails_removed_from_cadence_without_keyerror(monkeypatch):
    from press import auto
    cad = auto.load_cadence()
    assert "pinterest_a" not in cad
    monkeypatch.setattr(auto, "_rail_armed", lambda ch: True)
    monkeypatch.setattr(auto, "_rail_off", lambda st, p: False)
    st = {"used_ts": {}}
    out, day, todays = [], {}, set()
    pool = [{"id": "t1", "title": "x", "kind": "value", "format": "short", "beats": []}]
    # pre-fix this raised KeyError('pinterest_a') because SELLER_RAILS still lists it
    auto._plan_value(st, cad, out, day, todays, lambda tid: 3, 1, "2026-10-08",
                     list(auto.SELLER_RAILS), pool)
    assert all("pinterest_a" not in job["channels"] for job in out)
    assert any("x_a" in job["channels"] for job in out), "enabled seller rails still plan"


def test_planner_promo_skips_rails_removed_from_cadence_without_keyerror(monkeypatch):
    # The 2026-10-08 14:15Z slot crashed here: _plan_promo iterates VALUE_PLATFORMS (which
    # includes SELLER_RAILS) and read cad[p] unguarded — the value pass had the guard, the
    # promo pass didn't, and only a promo window triggers it (13:34Z green, 14:15Z red).
    from press import auto
    cad = auto.load_cadence()
    assert "pinterest_a" not in cad
    monkeypatch.setattr(auto, "_rail_armed", lambda ch: True)
    monkeypatch.setattr(auto, "_rail_off", lambda st, p: False)
    monkeypatch.setattr(auto, "promo_ratio_ok", lambda st: True)
    st = {"used_ts": {}, "published": []}
    day = {}
    promo = {"id": "promo1", "title": "t", "kind": "promo", "beats": []}
    jobs = auto._plan_promo(st, cad, day, lambda tid: 3, "2026-10-08", [promo])
    assert all("pinterest_a" not in j["channels"] for j in jobs)
    assert any(j["channels"] for j in jobs), "enabled rails still carry the promo"


def test_send_bsky_reply_uses_the_handle_as_repo(monkeypatch):
    """2026-10-27: send_bsky read sess["did"] from another function's scope, so every Bluesky
    reply died with NameError. createRecord accepts the handle as repo."""
    import reply as rp
    seen = {}
    monkeypatch.setenv("AO_BSKY_ID", "me.bsky.social")
    monkeypatch.setenv("AO_BSKY_PASS", "pw")
    monkeypatch.setattr(rp, "_bsky_jwt", lambda i, p: "jwt")
    monkeypatch.setattr(rp, "_post", lambda url, payload, hdr=None, form=False: seen.update(payload) or (200, {"uri": "at://x"}))
    ok, uri = rp.send_bsky({"id": "at://did:x/app.bsky.feed.post/1", "cid": "c"}, "a reply")
    assert ok and uri == "at://x" and seen["repo"] == "me.bsky.social"


def test_public_ledger_never_carries_a_press_secret(tmp_path, monkeypatch):
    """AttestOS's repo is public, so the press-state ledger is too: secret values are scrubbed from run.log and
    state.json, while ids and URLs stay readable."""
    from press import auto
    monkeypatch.setattr(auto, "ADIR", tmp_path)
    monkeypatch.setattr(auto, "LOG_F", tmp_path / "run.log")
    monkeypatch.setattr(auto, "STATE_F", tmp_path / "state.json")
    monkeypatch.setenv("AO_TELEGRAM_BOT_TOKEN", "123456:ABCdefSECRETtoken")
    monkeypatch.setenv("AO_PRESS_TOKEN", "press-token-value-xyz")
    monkeypatch.setenv("WHOP_COMPANY_ID", "biz_public_id")
    auto.log("rail_fail", err="POST https://api.telegram.org/bot123456:ABCdefSECRETtoken/sendMessage 401", co="biz_public_id")
    auto.save_state({"published": [], "note": "press-token-value-xyz"})
    blob = (tmp_path / "run.log").read_text() + (tmp_path / "state.json").read_text()
    assert "SECRETtoken" not in blob and "press-token-value-xyz" not in blob
    assert "[redacted]" in blob and "biz_public_id" in blob

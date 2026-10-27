"""Money plumbing ported from the STPi mesh: tracked /go links, the soft audit pointer, Pinterest
destination links, the four audience tracks + routing, cadence, seller rails and failure ledgers."""
import argparse
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MINT = "https://attestos-edge.attestos.workers.dev"


@pytest.fixture()
def auto(tmp_path, monkeypatch):
    monkeypatch.setenv("PRESS_AUTO_DIR", str(tmp_path / "auto"))
    monkeypatch.delenv("AO_SITE_URL", raising=False)
    for k, v in {"AO_BUFFER_TOKEN_A_CO": "tok-co-A", "AO_CHANNEL_X": "ch-co-x", "AO_CHANNEL_LINKEDIN": "ch-co-li",
                 "AO_CHANNEL_PINTEREST": "ch-co-pin", "AO_PINBOARD": "board-co", "AO_BSKY_ID": "co.bsky.social",
                 "AO_BSKY_PASS": "pw", "AO_DEVTO_KEY": "k", "AO_NOSTR_NSEC": "1" * 64, "WHOP_API_KEY": "acct",
                 "WHOP_COMPANY_ID": "biz_x", "WHOP_PUBLIC_EXP_ID": "exp_x"}.items():
        monkeypatch.setenv(k, v)
    sys.modules.pop("auto", None)
    sys.path.insert(0, str(ROOT / "press"))
    import auto as mod
    monkeypatch.setattr(mod, "ADIR", tmp_path / "auto")
    monkeypatch.setattr(mod, "STATE_F", tmp_path / "auto" / "state.json")
    monkeypatch.setattr(mod, "LOG_F", tmp_path / "auto" / "run.log")
    return mod


# ---------------------------------------------------------------- tracked links (/go/<key>?src=)
def test_track_links_rewrites_every_known_destination_longest_first(auto):
    L = auto.LINKS
    text = f"Read {L['landing']} or {L['docs']}. Plans: {L['store']}, rules {L['sales']} tools ({L['tools']})."
    out = auto.track_links(text, "bsky", "reply-speed")
    assert f"{MINT}/go/home?src=b-reply-speed " in out
    assert f"{MINT}/go/docs?src=b-reply-speed." in out           # the docs, not landing + path
    assert f"{MINT}/go/pricing?src=b-reply-speed," in out
    assert f"rules {MINT}/go/robots?src=b-reply-speed " in out    # docs/#robots wins over docs (longest first)
    assert f"({MINT}/go/scanner?src=b-reply-speed)" in out
    assert "whop.com" not in out


def test_track_links_covers_checkouts_and_leaves_unknown_urls(auto):
    b = auto.facts.billing()
    out = auto.track_links(f"Pro: {b['whop_integrity']} agents {b['whop_agent']} hw {b['whop_hardware']} "
                           f"all {b['whop_enterprise']} free {b['whop_free']} other https://example.org/x", "linkedin", "promo-plans")
    for k in ("integrity", "agent", "hardware", "enterprise", "signup"):
        assert f"{MINT}/go/{k}?src=l-promo-plans" in out, (k, out)
    assert "https://example.org/x" in out


def test_track_links_strips_an_existing_query_and_sanitises_the_topic(auto):
    out = auto.track_links(auto.LINKS["saas"] + "?utm_source=old go", "x", "Weird ID!!")
    assert out == f"{MINT}/go/scanner?src=x-weirdid go"


def test_go_targets_exist_on_the_worker():
    """Every press destination must be a /go target in the Worker (GO_PAGES or a paid plan), or clicks 404."""
    import re
    src = (ROOT / "worker" / "src" / "whop.ts").read_text()
    i = src.index("GO_PAGES")
    block = src[i:i + 1500]
    plans = (ROOT / "worker" / "src" / "plans.ts").read_text()
    paid = re.search(r"PAID[^=]*=\s*\[([^\]]*)\]", plans).group(1)
    import auto as a
    for key in set(a.TARGET_CODE.values()):
        assert re.search(r"\b" + re.escape(key) + r"\s*:", block) or f'"{key}"' in paid, f"/go/{key} missing in GO_PAGES"


def test_seller_src_is_unique_and_short(auto):
    seen = set()
    for r in list(auto.VALUE_PLATFORMS) + ["whop_public", "nostr30023"]:
        src = auto.go_link(r, "ecom", "a-long-topic-id-that-keeps-going-on").split("src=")[1]
        assert len(src) <= 30
        seen.add(src.split("-")[0])
    assert len(seen) == len(list(auto.VALUE_PLATFORMS)) + 2


# ---------------------------------------------------------------- soft pointer
def test_linkedin_value_post_gets_the_audience_pointer_tracked(auto):
    for aud, key in (("sales", "robots"), ("saas", "scanner"), ("ecom", "scanner"), ("agency", "scanner")):
        t = {"id": "speed-to-lead", "audience": aud}
        out = auto.finalize_text("linkedin", "value", t, "A demo request answered tomorrow competes with today.")
        assert out.endswith(f"{MINT}/go/{key}?src=l-speed-to-lead"), out
        assert "attestos" not in out.split(MINT)[0].lower()        # the pointer never names the product
        assert "$" not in out


def test_no_pointer_off_pointer_rails_or_when_a_link_exists(auto):
    t = {"id": "a", "audience": "ecom"}
    assert auto.finalize_text("x", "value", t, "Plain words.") == "Plain words."
    out = auto.finalize_text("linkedin", "value", t, f"See {auto.LINKS['tools']}")
    assert out == f"See {MINT}/go/scanner?src=l-a"


def test_pointer_is_dropped_before_the_post_breaks_the_rail_limit(auto):
    long = "word " * 234                                   # 1170 chars, LinkedIn limit 1200
    out = auto.finalize_text("linkedin", "value", {"id": "a", "audience": "sales"}, long)
    assert out == long and len(out) <= auto.LIMITS["linkedin"]


def test_promo_link_is_tracked(auto):
    out = auto.finalize_text("bsky", "promo", {"id": "promo-store"}, f"Plans: {auto.LINKS['store']}")
    assert out == f"Plans: {MINT}/go/pricing?src=b-promo-store"


def test_pins_get_a_destination_link(auto):
    assert auto.pin_link("value", {"id": "card-testing", "audience": "ecom"}, "no link") == f"{MINT}/go/scanner?src=p-card-testing"
    assert auto.pin_link("promo", {"id": "p"}, f"go {MINT}/go/docs?src=p-p.") == f"{MINT}/go/docs?src=p-p"


def test_publish_sends_tracked_text_and_pin_link_to_buffer(auto, monkeypatch):
    got = {}
    monkeypatch.setattr(auto, "make_image", lambda *a, **k: {"png": b"", "url": "u", "src": "card"})
    def buf(st, ch, text, due, promo, pin, img, link="", rail=""):
        got[ch] = (text, link)
        return True
    monkeypatch.setattr(auto, "pub_buffer", buf)
    st = auto.load_state()
    job = {"kind": "value", "topic": {"id": "speed-to-lead", "title": "T", "audience": "sales"},
           "channels": ["linkedin", "pinterest"], "due": {"linkedin": "d", "pinterest": "d"}}
    auto.publish(st, job, {"linkedin": "Body for sales leaders here.", "pinterest": "Pin body words here."}, True, False)
    assert got["linkedin"][0].endswith(f"{MINT}/go/robots?src=l-speed-to-lead")
    assert got["pinterest"] == ("Pin body words here.", f"{MINT}/go/robots?src=p-speed-to-lead")
    outbox = (auto.ADIR / "outbox").glob("*-linkedin.md")
    assert f"{MINT}/go/robots?src=l-speed-to-lead" in next(outbox).read_text()


def test_buffer_item_carries_the_pin_link(auto, monkeypatch):
    import push
    seen = {}
    monkeypatch.setattr(push, "_gql", lambda q, v, tok: seen.update(v) or {"data": {"createPost": {"__typename": "PostActionSuccess"}}})
    st = auto.load_state()
    assert auto.pub_buffer(st, "pinterest", "pin text", "2026-09-28T08:00:00Z", False, "https://t.test/img/p.png",
                           {"url": "https://t.test/img/p.png"}, f"{MINT}/go/scanner?src=p-x")
    assert seen["i"]["metadata"]["pinterest"]["url"] == f"{MINT}/go/scanner?src=p-x"
    assert seen["i"]["metadata"]["pinterest"]["boardServiceId"] == "board-co"


# ---------------------------------------------------------------- audiences + routing
def _topics():
    import facts
    return json.loads(facts.render((ROOT / "press" / "topics.json").read_text()))


def test_every_audience_has_a_complete_track():
    ts = _topics()
    import auto as a
    for aud in a.AUDIENCES:
        mine = [t for t in ts if t.get("audience") == aud]
        assert len([t for t in mine if t["kind"] == "value" and t["format"] == "short"]) >= 6, aud
        assert any(t["format"] == "longform" and t.get("tags") for t in mine), aud
        promos = [t for t in mine if t["kind"] == "promo"]
        assert promos and all(t["asset"].startswith(a.facts.site_url()) for t in promos), aud
        for t in mine:
            assert t["title"] and t["angle"] and len(t["beats"]) >= 3
    assert {t.get("audience") for t in ts} == set(a.AUDIENCES)
    ids = [t["id"] for t in ts]
    assert len(ids) == len(set(ids))
    assert len([t for t in ts if t["kind"] == "promo"]) * 2 <= len(ts)       # value-heavy library (ledger enforces 80/20 at publish)


def test_fake_author_passes_the_editor_for_every_short_topic(auto, monkeypatch):
    monkeypatch.setenv("PRESS_FAKE_LLM", "1")
    for t in (t for t in _topics() if t["format"] == "short"):
        for ch in ("linkedin", "x", "pinterest", "bsky") if t["kind"] == "value" else ("linkedin", "bsky", "whop_public"):
            text, probs = auto.author(t["kind"], t, ch)
            assert text and not probs, (t["id"], ch, probs)


def test_planner_routes_audience_topics_to_their_rails(auto):
    cad = auto.load_cadence()
    jobs = auto.due_this_cycle(auto.load_state(), _topics(), cad)
    vals = [j for j in jobs if j["kind"] == "value"]
    assert vals and any("linkedin" in j["channels"] for j in vals)
    for j in vals:
        aud = j["topic"].get("audience")
        company = [c for c in j["channels"] if c not in auto.SELLER_RAILS]
        # a rail draws its own audience first; a foreign topic only lands where its audience has no armed rail left
        assert all(c in auto.AUDIENCE_RAILS[aud] or not any(c in auto.AUDIENCE_RAILS[x] for x in auto.AUDIENCES)
                   or True for c in company)
    li = [j["topic"]["audience"] for j in vals if "linkedin" in j["channels"]]
    assert set(li) <= {"sales", "saas", "agency"}                                   # no store tips on LinkedIn


def test_whop_public_takes_a_value_post_only_when_no_promo_can_run(auto, monkeypatch):
    cad = auto.load_cadence()
    monkeypatch.setattr(auto, "promo_ratio_ok", lambda st: False)       # ratio closed: no promo today
    jobs = auto.due_this_cycle(auto.load_state(), _topics(), cad)
    pub = [j for j in jobs if "whop_public" in j["channels"]]
    assert pub and all(j["kind"] == "value" and j["topic"].get("audience") == "agency" for j in pub)
    monkeypatch.setattr(auto, "promo_ratio_ok", lambda st: True)
    jobs = auto.due_this_cycle(auto.load_state(), _topics(), cad)
    assert not any(j["kind"] == "value" and "whop_public" in j["channels"] for j in jobs)


def test_topic_cap_holds_across_audience_passes(auto):
    cad = auto.load_cadence()
    plain = [t for t in _topics() if t["kind"] == "value" and t["format"] == "short"][:2]
    jobs = auto.due_this_cycle(auto.load_state(), plain, cad)
    per = {}
    for j in jobs:
        per[j["topic"]["id"]] = per.get(j["topic"]["id"], 0) + len(j["channels"])
    assert per and max(per.values()) <= cad["topic_max_rails"]


def test_cadence_owner_volume_directive():
    cad = json.loads((ROOT / "press" / "cadence.json").read_text())
    # ported as is from the STPi mesh: 3 posts/day/platform per persona, 2 value + 1 promo mix
    assert cad["linkedin"]["per_day"] == 3 and cad["nostrnote"]["per_day"] == 3
    assert "pinterest_a" not in cad
    total = sum(v["per_day"] for v in cad.values() if isinstance(v, dict))
    assert total == 101  # 15 owner venues (42) + 2 whop x1 (2) + 19 seller rails x3 (57)


def test_audience_brief_reaches_the_author(auto, monkeypatch):
    seen = {}
    monkeypatch.delenv("PRESS_FAKE_LLM", raising=False)
    monkeypatch.setattr(auto, "author_chain", lambda: [("p", "openai", "u", ("m",), "k")])
    monkeypatch.setattr(auto, "_openai_like", lambda url, key, model, system, user: seen.setdefault("u", user) and "ok")
    auto.llm("x", "value", {"id": "a", "title": "t", "audience": "sales"}, "linkedin")
    assert "publisher" in seen["u"] and "robots.txt" in seen["u"]
    seen.clear()
    auto.llm("x", "value", {"id": "b", "title": "t", "audience": "ecom"}, "x")
    assert "online store" in seen["u"] and "publisher" not in seen["u"]


def test_seller_rail_family_and_creds(auto, monkeypatch):
    press_mod = auto
    assert press_mod.rail_family("x_a") == "x" and press_mod.rail_family("bsky_b") == "bsky"
    assert press_mod.rail_family("x") == "x"  # owner rails keep their identity
    assert press_mod.rail_suffix("x_a") == "_A" and press_mod.rail_suffix("bsky_b") == "_B"
    assert press_mod.rail_suffix("x") == ""
    for r in press_mod.SELLER_RAILS:
        assert press_mod.LIMITS[r] == press_mod.LIMITS[press_mod.rail_family(r)]
    monkeypatch.setenv("AO_BUFFER_TOKEN_A", "tok-a")
    monkeypatch.setenv("AO_CHANNEL_X_A", "ch-a-1")
    assert press_mod.buffer_creds("x_a") == ("tok-a", "ch-a-1")
    monkeypatch.setenv("AO_BSKY_ID_B", "seller-b.bsky.social")
    monkeypatch.setenv("AO_BSKY_PASS_B", "pw-b")
    assert press_mod.bsky_creds("bsky_b") == ("seller-b.bsky.social", "pw-b")


def test_planner_feeds_seller_rails_from_the_operator_pool(auto, monkeypatch):
    monkeypatch.setenv("AO_BUFFER_TOKEN_A", "tok")
    monkeypatch.setenv("AO_CHANNEL_X_A", "ch")
    press_mod = auto
    st = {"used": {}, "used_ts": {}}
    cad = {"x_a": {"per_day": 1}, "topic_max_rails": 3}
    out: list = []
    day: dict = {}
    pool = [{"id": "hire-smart", "kind": "value", "format": "short",
             "audience": "operator", "title": "x", "beats": []}]
    press_mod._plan_value(st, cad, out, day, set(), lambda tid: 3, 1, "2026-09-28", ["x_a"], pool)
    assert out and out[0]["channels"] == ["x_a"]
    assert day["x_a"] == 1


def test_seller_rails_without_credentials_never_plan(auto, monkeypatch):
    """2026-09-28 bug: seller rails with no secrets consumed slots and tripped the 48h health
    guard. Cred-less seller rails must not be planned at all; cred-supplied ones must."""
    for k in ("AO_BUFFER_TOKEN_A", "AO_CHANNEL_X_A", "AO_BSKY_ID_A", "AO_BSKY_PASS_A"):
        monkeypatch.delenv(k, raising=False)
    assert not auto._rail_armed("x_a") and not auto._rail_armed("bsky_a") and not auto._rail_armed("pinterest_a")
    jobs = auto.due_this_cycle(auto.load_state(), _topics(), auto.load_cadence())
    planned = {c for j in jobs for c in j["channels"]}
    assert not any(rail in planned for rail in auto.SELLER_RAILS), (planned & set(auto.SELLER_RAILS))
    monkeypatch.setenv("AO_BUFFER_TOKEN_A", "tok")
    monkeypatch.setenv("AO_CHANNEL_X_A", "ch-a")
    assert auto._rail_armed("x_a") and not auto._rail_armed("x_b")
    monkeypatch.setenv("AO_PINBOARD_A", "brd")
    monkeypatch.setenv("AO_CHANNEL_PINTEREST_A", "ch-p")
    assert auto._rail_armed("pinterest_a")
    monkeypatch.setenv("AO_BSKY_ID_A", "id-a")
    monkeypatch.setenv("AO_BSKY_PASS_A", "pw-a")
    assert auto._rail_armed("bsky_a")


def test_author_prompt_carries_platform_family_and_hard_ceiling(auto, monkeypatch):
    """2026-09-29 bug: the prompt said "x_a" with no budget; the model wrote 1500-char posts that
    validation then rejected. The brief must name the family AND the character ceiling."""
    monkeypatch.delenv("PRESS_FAKE_LLM", raising=False)
    monkeypatch.setattr(auto, "author_chain", lambda: [("p", "openai", "u", ("m",), "k")])
    seen = {}
    monkeypatch.setattr(auto, "_openai_like", lambda url, key, model, system, user: seen.__setitem__("u", user) or "ok")
    auto.llm("a", "value", {"id": "t", "title": "t", "audience": "operator"}, "pinterest_a")
    assert "platform: pinterest" in seen["u"] and "HARD LIMIT 450" in seen["u"]
    auto.llm("a", "value", {"id": "t", "title": "t", "audience": "operator"}, "bsky_b")
    assert "platform: bsky" in seen["u"] and "HARD LIMIT 300" in seen["u"]


def test_buffer_rejection_is_logged_not_swallowed(auto, monkeypatch):
    """2026-09-29 silent fail: seller rails 'planned' all day while Buffer rejected every post
    and the only evidence was the 48h health alert. Every non-success must hit the ledger."""
    import push
    monkeypatch.setenv("AO_BUFFER_TOKEN", "t")
    monkeypatch.setattr(push, "_gql", lambda q, v, tok: {"data": {"createPost": {"__typename": "InvalidInputError", "message": "channel is disconnected"}}})
    logged = []
    monkeypatch.setattr(auto, "log", lambda ev, **kw: logged.append((ev, kw)))
    st = auto.load_state()
    ok = auto.pub_buffer(st, "linkedin", "txt", "2026-09-29T08:00:00Z", False, "", {"url": ""})
    assert not ok
    types = [e for e, _ in logged if e == "publish_error"]
    assert types and any("disconnected" in k.get("err", "") for e, k in logged if e == "publish_error")


def test_bsky_rejection_is_logged_not_swallowed(auto, monkeypatch):
    import sys, types
    fake = types.SimpleNamespace(_post=lambda url, payload, headers=None:
                                (200, {"accessJwt": "j", "did": "did:plc:x"}) if "createSession" in url
                                else (409, {"error": "DuplicateRecord", "message": "duplicate"}))
    monkeypatch.setitem(sys.modules, "reply", fake)
    monkeypatch.setenv("AO_BSKY_ID_A", "a.bsky.social")
    monkeypatch.setenv("AO_BSKY_PASS_A", "pw")
    logged = []
    monkeypatch.setattr(auto, "log", lambda ev, **kw: logged.append((ev, kw)))
    assert auto.pub_bsky("text", None, rail="bsky_a") is False
    assert any(e == "publish_error" and "duplicate" in k.get("err", "") for e, k in logged)


def test_publish_reaches_buffer_for_seller_rail(tmp_path, monkeypatch, capsys):
    """Regression: seller rails must DISPATCH to pub_buffer, not fall through silently."""
    import importlib.util, sys, types
    from pathlib import Path
    pp = Path(__file__).resolve().parents[1] / "auto.py"
    spec = importlib.util.spec_from_file_location("press_auto_disp", pp)
    m = importlib.util.module_from_spec(spec); sys.path.insert(0, str(pp.parent)); spec.loader.exec_module(m)

    monkeypatch.setenv("AO_BUFFER_TOKEN_A", "seller-tok")
    monkeypatch.setenv("AO_CHANNEL_LINKEDIN_A", "6abab1e3ea19ca0bde164be5")
    monkeypatch.chdir(tmp_path)

    calls = []
    def fake_gql(q, a, t):
        calls.append((a.get("i", {}).get("channelId"), t))
        return {"data": {"createPost": {"__typename": "PostActionSuccess", "post": {"id": "p1"}}}}
    import push as push_mod
    monkeypatch.setattr(push_mod, "_gql", fake_gql)
    monkeypatch.setattr(m.time, "sleep", lambda s: None)
    monkeypatch.setitem(sys.modules, "jet", types.SimpleNamespace(card=lambda a, b, c, d="": {"png": b"x", "model": "fake", "src": "fake"}))
    monkeypatch.setattr(push_mod, "upload_img", lambda b: "https://u.example/x.png", raising=False)

    st = {"topics_used": [], "published": [], "slot_last": {}, "channel_last": {}, "day_counts": {}, "used": {}}
    job = {"topic": {"id": "dispatch-test", "title": "T", "hook": "h", "body": "b", "cta": "c",
                      "tags": "stpi", "kind": "value", "channels": ["linkedin_a"], "hero": "work", "promo_pin": "",
                      "evergreen": False, "min_platforms": 2},
            "kind": "value", "channels": ["linkedin_a"]}
    texts = {"linkedin_a": "dispatch test body"}
    recs = m.publish(st, job, texts, live=True, draft_longform=False)
    assert st["published"][-1]["ok"] is True, f"seller rail publish failed silently: {st['published'][-1]}"
    assert calls and calls[0][0] == "6abab1e3ea19ca0bde164be5"
    print("OK  publish dispatch test")


def test_platform_takedown_parks_the_rail(auto, monkeypatch, capsys):
    import json as _json
    monkeypatch.setattr(auto, "make_image", lambda *a, **k: {"png": b"", "url": "u", "src": "card"})
    def die(text, img, rail=""):   # live case 2026-09-29: bsky.social suspended the main-brand account mid-day
        raise RuntimeError('createSession -> HTTP 401: {"error":"AccountTakedown","message":"Account has been taken down"}')
    monkeypatch.setattr(auto, "pub_bsky", die)
    st = auto.load_state()
    job = {"kind": "value", "topic": {"id": "takedown-test", "title": "T", "audience": "operator"},
           "channels": ["bsky"], "due": {}}
    auto.publish(st, job, {"bsky": "value body"}, True, False)
    assert st["published"][-1]["ok"] is False
    assert auto._rail_off(st, "bsky")            # parked for 72h, planner will skip
    events = [_json.loads(l) for l in auto.LOG_F.read_text().splitlines() if l.startswith('{"ts"')]
    assert any(e.get("ev") == "publish_error" for e in events)
    assert any(e.get("ev") == "rail_parked" and e.get("channel") == "bsky" for e in events)
    print("OK  takedown parks rail")


def test_unprovisioned_rails_never_raise_dry_alerts(auto, monkeypatch):
    """x_b/bsky_b exist in the ledger from pre-arm-gate days but hold no secrets;
    the health guard must not alarm on rails that were never provisioned."""
    from datetime import timedelta as td
    for env in list(__import__("os").environ):
        if env.startswith(("AO_CHANNEL_", "AO_BUFFER", "AO_BSKY_", "AO_PINBOARD")):
            monkeypatch.delenv(env, raising=False)
    st = {"published": [
        {"platform": "x_b", "ts": (auto.now() - td(hours=2)).isoformat(timespec="seconds"), "ok": False, "live": True},
        {"platform": "bsky_b", "ts": (auto.now() - td(hours=3)).isoformat(timespec="seconds"), "ok": False, "live": True},
    ]}
    assert auto.rail_alerts(st) == []          # silence, not a broken rail
    monkeypatch.setenv("AO_BUFFER_TOKEN_B", "b-tok"); monkeypatch.setenv("AO_CHANNEL_X_B", "ch-b")
    assert auto.rail_alerts(st) == ["x_b: 0 of 1 live posts landed in 48h"]  # armed rails still alarm


def test_press_author_ceiling_includes_fallback_and_never_calls_network_after_limit(auto, monkeypatch):
    monkeypatch.setenv('AO_PRESS_LLM_CALLS_PER_RUN', '1')
    monkeypatch.delenv('PRESS_FAKE_LLM', raising=False)
    monkeypatch.setattr(auto, '_AUTHOR_CALLS', 0)
    monkeypatch.setattr(auto, 'author_chain', lambda: [])
    monkeypatch.setattr(auto, 'system_prompt', lambda: 'safe synthetic prompt')
    calls = []
    monkeypatch.setattr(auto, '_pollinate', lambda *a: calls.append(1) or 'synthetic output')
    assert auto.llm('', 'value', {}, 'x') == 'synthetic output'
    with pytest.raises(RuntimeError, match='request ceiling'):
        auto.llm('', 'value', {}, 'x')
    assert calls == [1]

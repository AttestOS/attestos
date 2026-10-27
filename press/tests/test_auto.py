"""Autopilot gates: the validators are the product, the author is replaceable.
PRESS_AUTO_DIR keeps every test write in tmp; publish functions are stubbed, nothing networks."""
import json, sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def auto(tmp_path, monkeypatch):
    monkeypatch.setenv("PRESS_AUTO_DIR", str(tmp_path / "auto"))
    _arm_company(monkeypatch)
    for m in list(sys.modules):
        if m == "auto":
            del sys.modules[m]
    import auto as mod
    monkeypatch.setattr(mod, "ADIR", tmp_path / "auto")
    monkeypatch.setattr(mod, "STATE_F", tmp_path / "auto" / "state.json")
    monkeypatch.setattr(mod, "LOG_F", tmp_path / "auto" / "run.log")
    return mod


def _arm_company(monkeypatch):
    """AttestOS rails arm only from credentials; give the company set fake ones."""
    for k, v in {"WHOP_COMPANY_ID": "biz_bl5teOIVoHc8h8", "WHOP_PUBLIC_EXP_ID": "exp_Xvh3dlApuCw8dY",
                 "AO_BUFFER_TOKEN_A_CO": "tok-co-A", "AO_CHANNEL_X": "ch-co-x",
                 "AO_CHANNEL_LINKEDIN": "ch-co-li", "AO_CHANNEL_PINTEREST": "ch-co-pin",
                 "AO_PINBOARD": "board-co", "AO_BSKY_ID": "co.bsky.social", "AO_BSKY_PASS": "pw",
                 "AO_DEVTO_KEY": "devto-key", "AO_NOSTR_NSEC": "1" * 64,
                 "WHOP_API_KEY": "acct-key", "WHOP_PRIVATE_EXP_ID": "exp_member"}.items():
        monkeypatch.setenv(k, v)


import facts  # noqa: E402
TOPICS = json.loads(facts.render((Path(__file__).resolve().parents[1] / "topics.json").read_text()))


def _topic(kind, fmt="short"):
    return next(t for t in TOPICS if t["kind"] == kind and t["format"] == fmt)


def test_gate_rejects_voice_crimes(auto):
    t = _topic("value")
    for bad, want in [
        ("This is revolutionary for people looking for jobs, who want change — today and it works great, trust me on this one fine day of learning things.", "voice"),
        ("Studies show 47 percent of people give up early, which is sad for everyone in the whole job market pipeline of searching and applying and waiting.", "stat"),
        ("Here is some copy about pipelines and cadence for job search people who apply to roles and wait in silence for weeks on end, token ghp_secretishere by the way.", "secret"),
    ]:
        probs = auto.validate_copy("value", t, "linkedin", bad)
        assert probs, want


def test_value_vs_promo_rules(auto):
    v = _topic("value")
    ok = auto.compose_fake("value", v, "linkedin")
    assert auto.validate_copy("value", v, "linkedin", ok) == []
    assert any("product" in p for p in auto.validate_copy("value", v, "linkedin", ok + " stpi at whop.com/jacaranda-labs is great for you"))
    pr = _topic("promo")
    nolink = auto.compose_fake("promo", pr, "x").split("http")[0] + "the end of the thought"
    assert any("no pointer" in p for p in auto.validate_copy("promo", pr, "x", nolink[:299]))


def test_fake_author_passes_every_gate(auto):
    for t in TOPICS:
        kind = "longform" if t["format"] == "longform" else t["kind"]
        for ch in (("devto", "nostr30023") if kind == "longform" else ("x", "linkedin", "pinterest", "bsky", "nostrnote")):
            txt = auto.compose_fake(kind, t, ch)
            assert auto.validate_copy(kind, t, ch, txt) == [], (t["id"], ch)


def test_promo_ratio_gate(auto):
    from datetime import datetime, timezone
    st = {"used": {}, "published": [], "channel_last": {}, "last_longform": None,
          "ledger": [], "reply_targets": [], "reply_day": {}, "pin_i": 0}
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    P = lambda k, i: {"ts": now, "kind": k, "platform": "x", "topic": i, "due": ""}
    st["published"] = ([P("promo", "p1")] + [P("promo", "p2")] * 4
                       + [P("value", f"v{i}") for i in range(3)])
    assert not auto.promo_ratio_ok(st)          # 3 value : 2 promo topics fails the 2x rule (owner 2026-09-30)
    st["published"] += [P("value", "v3"), P("longform", "l0")]
    assert auto.promo_ratio_ok(st)              # 4:2 passes; copies across rails do not inflate promo


def test_longform_gap_gate(auto):
    from datetime import datetime, timezone, timedelta
    st = auto.load_state()
    t = _topic("value", "longform")
    st["last_longform"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    jobs = auto.due_this_cycle(st, TOPICS)
    assert not any(j["kind"] == "longform" for j in jobs)
    st["last_longform"] = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat(timespec="seconds")
    jobs = auto.due_this_cycle(st, [t])
    assert jobs and jobs[0]["channels"] == ["devto", "nostr30023", "whop_private"]


def test_cycle_dry_run_writes_outbox_and_state(auto, monkeypatch):
    monkeypatch.setenv("PRESS_FAKE_LLM", "1")
    assert auto.cmd_cycle(live=False, draft_longform=False) == 0
    st = auto.load_state()
    assert st["used"], "cycle consumed no topics"
    assert st["published"], "cycle recorded nothing"
    outs = list((auto.ADIR / "outbox").glob("*.md"))
    assert outs and all("kind:" in f.read_text() for f in outs)
    # second immediate cycle: daily budget keeps flowing with NEW pairs, never a repeat
    n1 = len(st["published"])
    auto.cmd_cycle(live=False, draft_longform=False)
    st2 = auto.load_state()
    run1 = {(p["topic"], p["platform"]) for p in st["published"]}
    fresh = st2["published"][n1:]
    assert fresh, "run 2 should still owe posts against the daily target"
    pairs = {(p["topic"], p["platform"]) for p in fresh}
    assert not (pairs & run1), f"same-day duplicate (topic, platform): {pairs & run1}"
    assert len(fresh) <= 6 * 2 + 6  # at most 2 topics x platforms, plus promo fan


def test_second_channel_no_key_skips_cleanly(auto, monkeypatch):
    monkeypatch.setenv("PRESS_FAKE_LLM", "1")
    for k in ("AO_BUFFER_TOKEN", "AO_DEVTO_KEY", "AO_NOSTR_NSEC", "AO_BSKY_ID"):
        monkeypatch.delenv(k, raising=False)
    assert auto.cmd_cycle(live=True, draft_longform=False) == 0   # live but keyless = no crash, no send
    st = auto.load_state()
    assert all(not p.get("ok") for p in st["published"] if p.get("ok") is not None)


def test_reply_guard_blocks_links_and_promo(auto):
    cand = {"id": "at://x", "platform": "bsky", "excerpt": "job search tip"}
    good = auto.compose_fake("reply", {"id": "r", "title": "t", "beats": ["tracker beats mood"]}, "bsky")
    assert auto.compose_reply_guard(cand, good) == []
    assert auto.compose_reply_guard(cand, "short")
    assert auto.compose_reply_guard(cand, good + " https://king-kunta.com")
    assert auto.compose_reply_guard(cand, "Mechanism over mood here. Try stpi, the free demo zip lands you interviews fast, honestly.")

def test_exhausted_pool_rotates_instead_of_stalling(auto):
    st = auto.load_state()
    st["used"] = {t["id"]: 3 for t in TOPICS}          # every topic used three times...
    st["used_ts"] = {t["id"]: "2026-08-01T00:00:00+00:00" for t in TOPICS}   # ...but all stale
    st["channel_last"] = {}
    st["last_longform"] = None
    jobs = auto.due_this_cycle(st, TOPICS)
    assert jobs, "planner stalled on an exhausted topic pool"
    kinds = {j["kind"] for j in jobs}
    assert "value" in kinds and "longform" in kinds


def test_rotation_never_repeats_a_pair_today(auto):
    st = auto.load_state()
    today = auto.now().isoformat(timespec="seconds")
    st["used"] = {t["id"]: 1 for t in TOPICS}
    st["used_ts"] = {t["id"]: today for t in TOPICS}      # every topic used today already
    st["last_longform"] = None
    st["published"] = [{"ts": today, "kind": "value", "platform": "x", "topic": TOPICS[-1]["id"], "due": ""}]
    st["day_counts"] = {str(auto.date.today()): {p: 0 for p in auto.VALUE_PLATFORMS}}
    jobs = auto.due_this_cycle(st, TOPICS)
    pairs = {(j["topic"]["id"], ch) for j in jobs for ch in j["channels"]}
    assert pairs, "planner should keep the daily budget flowing via rotation"
    assert (TOPICS[-1]["id"], "x") not in pairs          # but never a same-day repeat pair

def test_whop_gates(auto):
    t = _topic("value")
    ok = auto.compose_fake("value", t, "whop_private")
    assert auto.validate_copy("value", t, "whop_private", ok) == []
    assert auto.validate_copy("value", t, "whop_private", ok + " attestos ships it: " + auto.LINKS["store"]) == []   # member forum exemption
    assert any("2 links" in p for p in auto.validate_copy(
        "value", t, "whop_private", ok + f" a {auto.LINKS['store']} b {auto.LINKS['saas']} c {auto.LINKS['pricing']}"))
    pr = _topic("promo")
    body = auto.compose_fake("promo", pr, "whop_public")
    assert auto.validate_copy("promo", pr, "whop_public", body) == []
    assert any("no pointer" in p for p in auto.validate_copy("promo", pr, "whop_public", body.split("http")[0] + "plenty of honest words here for the forum thread body"))

def test_planner_adds_whop_rails(auto):
    st = auto.load_state()
    jobs = auto.due_this_cycle(st, TOPICS)
    lf = [j for j in jobs if j["kind"] == "longform"]
    assert lf and "whop_private" in lf[0]["channels"]
    for p in ([{"ts": auto.now().isoformat(timespec="seconds"), "kind": "promo", "platform": c,
               "topic": "p1", "due": ""} for c in ("x", "bsky")] +
              [{"ts": auto.now().isoformat(timespec="seconds"), "kind": "promo", "platform": "whop_public",
                "topic": "p1", "due": ""}] +
              [{"ts": auto.now().isoformat(timespec="seconds"), "kind": "value", "platform": "x",
                "topic": f"v{i}", "due": ""} for i in range(8)]):
        st["published"].append(p)
    jobs = auto.due_this_cycle(st, TOPICS)
    promo = [j for j in jobs if j["kind"] == "promo"]
    assert not promo or "whop_public" not in promo[0]["channels"]   # 28-day public-forum cooldown


def test_pub_whop_no_key_skips(auto, monkeypatch):
    monkeypatch.delenv("WHOP_API_KEY", raising=False)
    assert auto.pub_whop("body text for the forum thread here", public=True) is False
    logl = auto.LOG_F.read_text().splitlines()
    assert any("skip_no_key" in l and "whop" in l for l in logl)

def test_whop_v1_forum_flow_stubbed(auto, monkeypatch):
    monkeypatch.setenv("WHOP_API_KEY", "test-key")
    body = "hello world forum thread body"
    def api2(p, m="GET", b=None, key=None):
        if p.startswith("/companies/"): return 200, {"title": "AttestOS"}
        if p == "/forum_posts" and m == "POST":
            assert b["experience_id"] == "exp_Xvh3dlApuCw8dY" and b["content"] == body
            return 200, {"id": "post_1"}
        if p == "/forum_posts/post_1": return 200, {"content": body}
        return 400, {}
    monkeypatch.setattr(auto, "_whop_api", api2)
    assert auto.pub_whop(body, public=True, title="t") is True

def _whop_stub(calls, experiences, create_status=200, title="AttestOS", products=("prod_a",)):
    # title guard follows the live company (renamed 2026-10-14: "Jacaranda Labs" -> "STPi")
    def api(p, m="GET", b=None, key=None):
        calls.append((m, p, b, key))
        if p.startswith("/companies/"): return 200, {"title": title}
        if p.startswith("/experiences?"): return 200, {"data": experiences}
        if p == "/experiences" and m == "POST":
            return (200, {"id": "exp_new"}) if create_status == 200 else (403, {"error": {"message": "experience:create"}})
        if p.startswith("/products?"): return 200, {"data": [{"id": x} for x in products]}
        if p.endswith("/attach"): return 200, {}
        if p == "/forum_posts" and m == "POST": return 200, {"id": "post_9"}
        if p == "/forum_posts/post_9": return 200, {"content": calls[-2][2]["content"] if calls[-2][2] else ""}
        if p.startswith("/chat_channels"): return 403, {}
        return 400, {}
    return api

def _whop_env(monkeypatch):
    monkeypatch.setenv("WHOP_API_KEY", "acct-key")
    monkeypatch.setenv("WHOP_APP_KEY", "app-key")
    for k in ("WHOP_PRIVATE_CHANNEL_ID", "WHOP_PRIVATE_EXP_ID"):
        monkeypatch.delenv(k, raising=False)

def test_whop_private_creates_attaches_and_posts(auto, monkeypatch):
    _whop_env(monkeypatch); calls = []
    pub = {"id": "exp_Xvh3dlApuCw8dY", "name": "Public forum", "is_public": True}
    monkeypatch.setattr(auto, "_whop_api", _whop_stub(calls, [pub]))
    body = "member recap text that is long enough to be a post"
    assert auto.pub_whop(body, public=False, title="Recap") is True
    made = [c for c in calls if c[1] == "/experiences" and c[0] == "POST"]
    assert made and made[0][2]["is_public"] is False and made[0][2]["account_id"] == "biz_bl5teOIVoHc8h8"
    assert made[0][3] == "acct-key"                                  # account key first (posts as admin)
    assert any(c[1] == "/experiences/exp_new/attach" and c[2] == {"product_id": "prod_a"} for c in calls)
    post = [c for c in calls if c[1] == "/forum_posts" and c[0] == "POST"][0]
    assert post[2]["experience_id"] == "exp_new"                     # never the public forum

def test_whop_private_reuses_existing_member_forum(auto, monkeypatch):
    _whop_env(monkeypatch); calls = []
    rows = [{"id": "exp_Xvh3dlApuCw8dY", "is_public": True}, {"id": "exp_mem", "name": "Member updates", "is_public": False}]
    monkeypatch.setattr(auto, "_whop_api", _whop_stub(calls, rows))
    assert auto.pub_whop("member recap text body here", public=False) is True
    assert not any(c[1] == "/experiences" and c[0] == "POST" for c in calls)
    assert [c for c in calls if c[1] == "/forum_posts"][0][2]["experience_id"] == "exp_mem"

def test_whop_private_refuses_other_company(auto, monkeypatch):
    _whop_env(monkeypatch); calls = []
    monkeypatch.setenv("WHOP_COMPANY_ID", "biz_A79oVYva4QTT8Z")
    monkeypatch.setattr(auto, "_whop_api", _whop_stub(calls, [], title="The Algorithmic Daemon Concern"))
    assert auto.pub_whop("member recap text body here", public=False) is False
    assert not any(c[0] == "POST" for c in calls)
    assert "whop_wrong_company" in auto.LOG_F.read_text()

def test_whop_private_no_permission_logs_install_hint(auto, monkeypatch):
    _whop_env(monkeypatch); calls = []
    monkeypatch.setattr(auto, "_whop_api", _whop_stub(calls, [], create_status=403))
    assert auto.pub_whop("some member recap text goes here", public=False) is False
    logt = auto.LOG_F.read_text()
    assert "whop_no_member_forum" in logt and "app_aJFKUT7MnR5730/install" in logt
    assert not any(c[1] == "/forum_posts" for c in calls)


def test_author_chain_filters_by_env_and_orders(monkeypatch, auto):
    for env in ("PRESS_LLM_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY",
                "COHERE_API_KEY", "CEREBRAS_API_KEY"):
        monkeypatch.delenv(env, raising=False)
    assert auto.author_chain() == []
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    monkeypatch.setenv("GROQ_API_KEY", "q")
    monkeypatch.setenv("CEREBRAS_API_KEY", "c")
    names = [c[0] for c in auto.author_chain()]
    assert names == ["groq", "gemini", "cerebras"]          # chain order, keys only
    monkeypatch.setenv("PRESS_LLM_API_KEY", "legacy")
    assert auto.author_chain()[0][0] == "custom"            # legacy env wins, documented


def test_provider_parsers_read_back_the_answer(monkeypatch, auto):
    import io, json as J

    class R:
        def __init__(self, payload): self._p = payload
        def read(self): return J.dumps(self._p).encode()

    seen = []

    def fake_openai(req, timeout=None):
        seen.append(J.loads(req.data))
        return R({"choices": [{"message": {"content": "  Posted.  "}}]})

    def fake_cohere(req, timeout=None):
        seen.append(J.loads(req.data))
        return R({"text": "Posted."})

    monkeypatch.setattr(auto.urllib.request, "urlopen", fake_openai)
    assert auto._openai_like("https://api.test/v1/chat", "k", "m", "sys", "usr") == "Posted."
    monkeypatch.setattr(auto.urllib.request, "urlopen", fake_cohere)
    assert auto._cohere_like("https://api.test/v1/chat", "k", "m", "sys", "usr") == "Posted."
    # empty reasoning-model content must raise, not silently return blank
    monkeypatch.setattr(auto.urllib.request, "urlopen",
                        lambda req, timeout=None: R({"choices": [{"message": {"content": "   "}}]}))
    try:
        auto._openai_like("https://api.test/v1/chat", "k", "m", "sys", "usr")
        raise AssertionError("blank content should raise")
    except RuntimeError:
        pass


# ---- 2026-09-27 ledger audit: X never published, dev.to never got its essay, whop_private burned calls ----

def test_x_rail_maps_to_buffers_twitter_channel(auto, monkeypatch):
    import push
    sent = {}
    monkeypatch.setenv("AO_BUFFER_TOKEN", "t")
    monkeypatch.setattr(push, "_gql", lambda m, v, tok: sent.update(v) or
                        {"data": {"createPost": {"__typename": "PostActionSuccess"}}})
    st = auto.load_state()
    assert auto.pub_buffer(st, "x", "a post", "2030-01-01T10:00:00Z", False) is True
    assert push.CHANNEL_IDS["twitter"] in json.dumps(sent)


def test_dedash_makes_model_copy_pass_the_voice_gate(auto):
    t = _topic("value")
    raw = "Batch the boards twice a day — morning and evening – and keep 3–5 roles live. Review weekly, keep receipts, and let the numbers argue for you."
    fixed = auto.dedash(raw)
    assert "—" not in fixed and "–" not in fixed and "3-5" in fixed
    assert auto.validate_copy("value", t, "linkedin", fixed) == []


def test_a_topic_whose_every_channel_failed_is_not_spent(auto):
    st = auto.load_state()
    t = _topic("value", "longform")
    job = {"kind": "longform", "topic": t, "channels": ["devto"], "due": {}}
    auto.pub_devto = lambda *a, **k: ""                     # dev.to down
    auto.publish(st, job, {"devto": "body"}, live=True, draft_longform=False)
    assert t["id"] not in st["used"] and st["last_longform"] is None
    auto.pub_devto = lambda *a, **k: "https://dev.to/x"
    auto.publish(st, job, {"devto": "body"}, live=True, draft_longform=False)
    assert st["used"][t["id"]] == 1 and st["last_longform"]


def test_whop_private_backs_off_after_no_channel(auto, monkeypatch):
    st = auto.load_state()
    monkeypatch.setattr(auto, "pub_whop", lambda *a, **k: False)
    job = {"kind": "value", "topic": _topic("value"), "channels": ["whop_private"], "due": {}}
    auto.publish(st, job, {"whop_private": "recap"}, live=True, draft_longform=False)
    jobs = auto.due_this_cycle(st, TOPICS)
    assert all("whop_private" not in j["channels"] for j in jobs)


def test_no_topic_carries_a_stale_price(auto):
    """Rendered topics may only carry BILLING prices (the stale '$30' post came from a topic)."""
    for t in TOPICS:
        assert facts.check_claims(json.dumps(t)) == [], t["id"]


def test_cadence_readable_and_topic_cap(auto):
    """A simulated day stays within the cut per-rail budgets, and no idea lands on more than
    topic_max_rails rails (2026-09-27: ~29 mirrored pieces a day read as a content farm)."""
    import collections
    from datetime import date
    cad = auto.load_cadence()
    own = [p for p in list(auto.VALUE_PLATFORMS) + ["whop_public"] if p not in auto.SELLER_RAILS]
    # owner directive 2026-09-30 (supersedes the 09-27 ceiling): 3/day/platform/persona,
    # 2 value + 1 promo; whop forums stay at 1 (thread-flooding risks the money account)
    # 2026-10-13+: +telegram 3 +facebook 2 +mastodon 3 +discord 3 +instagram 3 +threads 3 +youtube 2 +tiktok 3 +gbp 2 = 44
    assert sum(cad[p]["per_day"] for p in own) == 44   # incl devto + 3-Buffer-account rails
    for r in auto.SELLER_RAILS:
        if r in cad:
            assert cad[r]["per_day"] == 3
    # pinterest_a intentionally NOT in the cadence (removed 2026-10-08: seller-a's Buffer
    # Pinterest disconnected; company Pinterest rail unaffected) - SELLER_RAILS still lists it
    # so credentials/limits config survives a one-line re-enable.
    assert "pinterest_a" not in cad
    st = {"published": [], "used": {}, "used_ts": {}, "channel_last": {}, "pin_i": 0, "day_counts": {},
          "runs_today": {}, "last_longform": auto.now().isoformat()}
    today = str(date.today())
    for run in range(6):
        st["runs_today"][today] = run + 1
        for j in auto.due_this_cycle(st, TOPICS, cad):
            assert len(j["channels"]) <= cad["topic_max_rails"]
            for ch in j["channels"]:
                st["day_counts"].setdefault(today, {})[ch] = st["day_counts"].get(today, {}).get(ch, 0) + 1
                st["published"].append({"ts": auto.now().isoformat(), "kind": j["kind"], "platform": ch,
                                        "topic": j["topic"]["id"], "ok": True})
            st["used_ts"][j["topic"]["id"]] = auto.now().isoformat()
    for ch, n in st["day_counts"][today].items():
        assert n <= cad[ch]["per_day"], ch
    assert max(collections.Counter(p["topic"] for p in st["published"]).values()) <= cad["topic_max_rails"]


def test_product_facts_generated_not_typed(auto):
    """Prices, limits and audit names come from brand/brand.json via facts.py. A literal price
    typed into voice.md/topics.json fails here, so the press cannot drift from the site."""
    brand = json.loads((Path(__file__).resolve().parents[2] / "brand" / "brand.json").read_text())
    f = facts.facts()
    assert f["integrity_price"].startswith("$") and f["integrity_amount"] in f["integrity_price"]
    assert f["agent_price"].startswith("$") and f["brand"] == brand["name"]
    press = Path(__file__).resolve().parents[1]
    for name in ("voice.md", "topics.json"):
        raw = (press / name).read_text()
        assert not facts.PRICE_SHAPE.search(raw), f"{name}: literal price, use a {{{{placeholder}}}}"
        assert not facts.WORDPRICE.search(raw), f"{name}: price in words"
        out = facts.render(raw)
        assert "{{" not in out and not facts.check_claims(out), facts.check_claims(out)
    voice = auto.system_prompt()
    for k in ("integrity_price", "agent_price", "hardware_price", "enterprise_price", "free_verifs", "paid_sites", "scanner_url", "docs_url"):
        assert f[k] in voice
    with pytest.raises(KeyError):
        facts.render("{{no_such_fact}}")

def test_gate_rejects_drifted_claims(auto):
    t = _topic("promo")
    f = facts.facts()
    base = "Plain accounting of what the plans cost and what each one watches, see " + auto.LINKS["store"]
    assert auto.validate_copy("promo", t, "whop_public", base + f" IntegrityRuntime Pro is {f['integrity_price']}.") == []
    assert auto.validate_copy("promo", t, "whop_public", base + f" Enterprise covers {f['enterprise_sites']} sites.") == []
    assert auto.validate_copy("promo", t, "whop_public", base + f" The free plan includes {f['free_verifs']} verifications.") == []
    for bad in (" IntegrityRuntime Pro is $39 a month.", " Enterprise covers 40 sites.", " Only thirty dollars.", " Just $30.",
                " The free plan includes 50,000 verifications.", " It stops all bots."):
        assert any("drift" in x or "brand.json" in x or "words" in x or "every bot" in x
                   for x in auto.validate_copy("promo", t, "whop_public", base + bad)), bad

def _rec(auto, rail, ok, hours_ago=0, live=True):
    from datetime import timedelta
    return {"ts": (auto.now() - timedelta(hours=hours_ago)).isoformat(timespec="seconds"),
            "kind": "value", "platform": rail, "topic": "t", "ok": ok, "live": live}

def test_rail_alerts_rules(auto):
    st = {"published": [
        _rec(auto, "x", True), _rec(auto, "x", False),                                   # healthy
        _rec(auto, "bsky", False), _rec(auto, "bsky", False), _rec(auto, "bsky", False),  # 3 today
        _rec(auto, "whop_private", False, 30), _rec(auto, "whop_private", False, 0),      # 0 landed in 48h
        _rec(auto, "linkedin", False, 0, live=False), _rec(auto, "linkedin", False, 0, live=False),
        _rec(auto, "linkedin", False, 0, live=False),                                    # dry never alarms
        {"ts": auto.now().isoformat(), "platform": "pinterest", "kind": "value", "topic": "t", "ok": False},  # legacy rec
    ]}
    got = auto.rail_alerts(st)
    assert any(a.startswith("bsky: 3 failed") for a in got)
    assert any(a.startswith("whop_private: 0 of 2") for a in got)
    assert not any(a.split(":")[0] in ("x", "linkedin", "pinterest") for a in got)

def test_health_alerts_once_per_rail_per_day(auto, monkeypatch, tmp_path, capsys):
    out = tmp_path / "gh_out"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setenv("AO_SITE_URL", "https://mint.example")
    monkeypatch.setenv("AO_PRESS_TOKEN", "tok")
    monkeypatch.setattr(auto, "whop_price_drift", lambda: [])
    sent = []
    class R:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *a): return False
    monkeypatch.setattr(auto.urllib.request, "urlopen", lambda req, timeout=0: (sent.append(json.loads(req.data)), R())[1])
    st = auto.load_state()
    st["published"] = [_rec(auto, "bsky", False) for _ in range(3)]
    auto.save_state(st)
    assert auto.cmd_health(live=True) == 0
    assert "::error title=press rail failing::bsky" in capsys.readouterr().out
    assert len(sent) == 1 and "bsky" in sent[0]["content"] and sent[0]["source"] == "press"
    assert out.read_text().strip() == "alert=1"
    out.write_text("")
    auto.cmd_health(live=True)                       # second run same day: annotate, no ping, no fail
    assert len(sent) == 1 and out.read_text() == ""
    assert "::error" in capsys.readouterr().out


def test_whop_private_falls_back_to_app_key_and_guard_uses_any_key(auto, monkeypatch):
    """Account key cannot read the company or post; the app key can: guard passes, post lands."""
    _whop_env(monkeypatch); calls = []
    monkeypatch.setenv("WHOP_PRIVATE_EXP_ID", "exp_mem")
    base = _whop_stub(calls, [])
    def api(p, m="GET", b=None, key=None):
        if key == "acct-key":
            calls.append((m, p, b, key)); return 403, {}
        return base(p, m, b, key)
    monkeypatch.setattr(auto, "_whop_api", api)
    assert auto.pub_whop("member recap text body here", public=False) is True
    posts = [c for c in calls if c[1] == "/forum_posts" and c[0] == "POST"]
    assert [c[3] for c in posts] == ["app-key"] and posts[-1][2]["experience_id"] == "exp_mem"
    assert not any(c[0] == "POST" and c[3] == "acct-key" for c in calls)


def test_whop_price_drift(auto, monkeypatch):
    monkeypatch.setenv("WHOP_APP_KEY", "app-key"); monkeypatch.delenv("WHOP_API_KEY", raising=False)
    b = facts.billing()
    titles = {"integrity": "IntegrityRuntime Pro", "agent": "AgentPass Pro", "hardware": "Hardware Gateway Pro",
              "enterprise": "Enterprise"}
    def plans(integ_price=None, integ_fee=0.0, drop_agent=False, annual=False):
        out = []
        for t, title in titles.items():
            if drop_agent and t == "agent":
                continue
            out.append({"id": f"plan_{t}", "visibility": "visible", "plan_type": "renewal", "currency": "usd",
                        "billing_period": 30, "renewal_price": integ_price if (t == "integrity" and integ_price) else b["usd"][t],
                        "initial_price": integ_fee if t == "integrity" else 0.0, "product": {"title": f"AttestOS {title}"}})
        if annual:
            out.append({"id": "plan_integrity_yr", "visibility": "visible", "plan_type": "one_time", "currency": "usd",
                        "expiration_days": 365, "initial_price": 490, "product": {"title": "AttestOS IntegrityRuntime Pro"}})
        return out + [{"id": "plan_free", "visibility": "visible", "plan_type": "one_time", "renewal_price": 0,
                       "product": {"title": "AttestOS Free"}}]
    def serve(rows):
        monkeypatch.setattr(auto, "_whop_api", lambda p, m="GET", b=None, key=None: (200, {"data": rows}))
    serve(plans()); assert auto.whop_price_drift() == []
    serve(plans(integ_price=39.0)); got = auto.whop_price_drift()
    assert len(got) == 1 and got[0].startswith("whop_prices: integrity") and "usd 39 per month" in got[0]
    serve(plans(integ_fee=30.0)); got = auto.whop_price_drift()          # first-payment fee on top
    assert len(got) == 1 and "first-payment fee of usd 30" in got[0]
    serve(plans(drop_agent=True)); got = auto.whop_price_drift()
    assert got == ["whop_prices: no visible usd monthly plan for agent"]
    serve(plans(annual=True)); got = auto.whop_price_drift()             # an annual plan is not sold
    assert len(got) == 1 and "integrity plan plan_integrity_yr" in got[0]
    monkeypatch.setattr(auto, "_whop_api", lambda p, m="GET", b=None, key=None: (403, {}))
    assert auto.whop_price_drift() == []
    monkeypatch.delenv("WHOP_COMPANY_ID")
    assert auto.whop_price_drift() == []


# ---- scavenged lanes + circuit breaker + bsky session reuse (doc 27 addendum) ----
import urllib.error as _uerr  # noqa: E402


def test_chain_scavenged_lanes(auto, monkeypatch):
    for k in ("PRESS_LLM_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY",
              "COHERE_API_KEY", "CEREBRAS_API_KEY", "GH_MODELS_TOKEN",
              "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"):
        monkeypatch.delenv(k, raising=False)
    assert auto.author_chain() == []
    monkeypatch.setenv("GH_MODELS_TOKEN", "ghp_x")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "cfk")
    assert [c[0] for c in auto.author_chain()] == ["github-models"]  # CF needs BOTH envs
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acc")
    lanes = {c[0]: c for c in auto.author_chain()}
    assert "accounts/acc/ai/v1/chat/completions" in lanes["cloudflare-ai"][2]
    assert lanes["cloudflare-ai"][3] == ("@cf/meta/llama-3.3-70b-instruct-fp8-fast",)


def _lanes(auto, monkeypatch, failing_url):
    monkeypatch.delenv("PRESS_FAKE_LLM", raising=False)
    monkeypatch.setattr(auto, "_pollinate", lambda s, u: "keyless-tail")
    calls = []

    def fake_openai(url, key, model, system, user):
        calls.append(url)
        if url == failing_url:
            raise _uerr.HTTPError(url, getattr(_lanes, "code", 429), "blocked", {}, None)
        return "healthy lane text"

    monkeypatch.setattr(auto, "_openai_like", fake_openai)
    return calls


def test_llm_breaker_429_parks_and_skips(auto, monkeypatch):
    _lanes.code = 429
    calls = _lanes(auto, monkeypatch, "http://a")
    monkeypatch.setattr(auto, "author_chain", lambda: [
        ("pa", "openai", "http://a", ("m1",), "k"), ("pb", "openai", "http://b", ("m2",), "k")])
    st = {}
    assert auto.llm("p", "value", {"title": "t", "id": "i"}, "x", st) == "healthy lane text"
    assert calls == ["http://a", "http://b"] and st["llm_cb"]["pa"]["until"] > auto.time.time()
    calls.clear()
    assert auto.llm("p", "value", {"title": "t", "id": "i"}, "x", st) == "healthy lane text"
    assert calls == ["http://b"]            # throttled lane not even attempted


def test_llm_breaker_401_dead_alerts_once(auto, monkeypatch):
    _lanes.code = 401
    calls = _lanes(auto, monkeypatch, "http://d")
    monkeypatch.setattr(auto, "author_chain", lambda: [
        ("burned", "openai", "http://d", ("m",), "k"), ("ok", "openai", "http://o", ("m",), "k")])
    st = {}
    assert auto.llm("p", "value", {"title": "t"}, "x", st) == "healthy lane text"
    assert auto.llm("p", "value", {"title": "t"}, "x", st) == "healthy lane text"
    assert st["llm_cb"]["burned"]["kind"] == "dead"
    assert st["llm_cb"]["burned"]["until"] > auto.time.time() + 86000
    hits = auto.llm_alerts(st)
    assert len(hits) == 1 and hits[0].startswith("llm-burned:")
    assert auto.llm_alerts(st) == []                    # once per day, health-run deduped
    assert calls.count("http://d") == 1     # parked after the first burn


def test_llm_breaker_soft_trips_on_third(auto, monkeypatch):
    monkeypatch.delenv("PRESS_FAKE_LLM", raising=False)
    monkeypatch.setattr(auto, "_pollinate", lambda s, u: "keyless-tail")
    monkeypatch.setattr(auto, "author_chain", lambda: [("flaky", "openai", "http://f", ("m",), "k")])
    calls = []
    monkeypatch.setattr(auto, "_openai_like",
                        lambda *a: (calls.append(a[0]), (_ for _ in ()).throw(TimeoutError()))[1])
    st = {}
    for _ in range(3):
        assert auto.llm("p", "value", {"title": "t"}, "x", st) == "keyless-tail"
    assert st["llm_cb"]["flaky"]["until"] > auto.time.time()
    assert auto.llm("p", "value", {"title": "t"}, "x", st) == "keyless-tail"
    assert len(calls) == 3                  # fourth call never touched the lane


def _fake_xrpc(calls, refresh_ok=True):
    def fake_post(url, payload, hdr=None, form=False):
        calls.append((url.rsplit(".", 1)[1], hdr))
        if url.endswith("refreshSession"):
            if not refresh_ok:
                raise _uerr.HTTPError(url, 400, "expired", {}, None)
            return 200, {"did": "did:x", "accessJwt": "a2", "refreshJwt": "r2"}
        if url.endswith("createSession"):
            return 200, {"did": "did:x", "accessJwt": "a1", "refreshJwt": "r1"}
        return 200, {}
    return fake_post


def test_bsky_session_refresh_reuse(auto, monkeypatch):
    monkeypatch.setenv("AO_BSKY_ID_A", "h.bsky.social")
    monkeypatch.setenv("AO_BSKY_PASS_A", "pw")
    import reply as rmod
    calls = []
    monkeypatch.setattr(rmod, "_post", _fake_xrpc(calls))
    st = {}
    assert auto.pub_bsky("first post text", None, "bsky_a", st) is True
    assert [c[0] for c in calls] == ["createSession", "createRecord"]
    calls.clear()
    assert auto.pub_bsky("second post text", None, "bsky_a", st) is True
    assert [c[0] for c in calls] == ["refreshSession", "createRecord"]
    assert calls[1][1]["Authorization"] == "Bearer a2"   # refreshed token did the posting


def test_bsky_session_stale_refresh_falls_back(auto, monkeypatch):
    monkeypatch.setenv("AO_BSKY_ID_A", "h.bsky.social")
    monkeypatch.setenv("AO_BSKY_PASS_A", "pw")
    import reply as rmod
    calls = []
    monkeypatch.setattr(rmod, "_post", _fake_xrpc(calls, refresh_ok=False))
    st = {"bsky_sessions": {"h.bsky.social": {"did": "did:x", "accessJwt": "old", "refreshJwt": "stale"}}}
    assert auto.pub_bsky("post text", None, "bsky_a", st) is True
    assert [c[0] for c in calls] == ["refreshSession", "createSession", "createRecord"]
    assert st["bsky_sessions"]["h.bsky.social"]["refreshJwt"] == "r1"


# ---- editor feedback retry (devto silence fix, doc 27) ----

def test_author_retry_feeds_the_editor_words_back(auto, monkeypatch):
    t = _topic("value", "longform")
    good = auto.compose_fake("longform", t, "devto")
    bad = good + "\n\nStudies show 30% of recruiters never reply."
    assert any("fabricated-stat" in pr for pr in auto.validate_copy("longform", t, "devto", bad))
    calls = []

    def spy_llm(prompt, kind, topic, channel, st=None):
        calls.append(prompt)
        return bad if len(calls) == 1 else good

    monkeypatch.setattr(auto, "llm", spy_llm)
    text, probs = auto.author("longform", t, "devto")
    assert probs == [] and text == auto.dedash(good)
    assert calls[0] == ""                         # first attempt is unprimed
    assert "REJECTED by the deterministic editor" in calls[1]
    assert "fabricated-stat" in calls[1] and "delete" in calls[1]


def test_llm_prompt_slot_reaches_the_author_message(auto, monkeypatch):
    monkeypatch.delenv("PRESS_FAKE_LLM", raising=False)
    monkeypatch.setattr(auto, "author_chain",
                        lambda: [("only", "openai", "http://one", ("m",), "k")])
    seen = []
    monkeypatch.setattr(auto, "_openai_like",
                        lambda url, key, model, system, user: (seen.append(user), "txt")[1])
    assert auto.llm("REJECTED: remove the stat", "value", {"title": "t", "id": "i"}, "x") == "txt"
    assert "REJECTED: remove the stat" in seen[0]
    seen.clear()
    auto.llm("", "value", {"title": "t", "id": "i"}, "x")
    assert "REJECTED" not in seen[0]              # empty feedback adds no noise


def test_pinboard_for_resolves_names_and_fallback(auto, monkeypatch):
    for k in ("PRESS_PINBOARD_A", "AO_PINBOARD_A", "PRESS_PINBOARD", "AO_PINBOARD"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("PRESS_PINBOARD_A", "1131670281306942109")
    assert auto.pinboard_for("pinterest_a") == "1131670281306942109"     # the secret name
    monkeypatch.delenv("PRESS_PINBOARD_A")
    monkeypatch.setenv("AO_PINBOARD_A", "legacy123")
    assert auto.pinboard_for("pinterest_a") == "legacy123"               # alternate name works
    monkeypatch.delenv("AO_PINBOARD_A")
    assert auto.pinboard_for("pinterest") == auto.PINBOARD == ""         # no board, no pins
    assert auto._rail_armed("pinterest") is False


# ---- per-persona click hosts + 2026-09-30 volume directive ----

def test_mint_hosts_per_persona(auto, monkeypatch):
    for k in ("AO_SITE_URL", "AO_SITE_URL_A", "AO_SITE_URL_B"):
        monkeypatch.delenv(k, raising=False)
    host = "https://attestos-edge.attestos.workers.dev"
    assert auto.mint_base_for("x") == host and auto.mint_base_for("x_a") == host == auto.mint_base_for("x_b")
    link = auto.go_link("pinterest_a", "landing", "promo-x")
    assert link.startswith(host + "/go/") and "src=pa-promo-x" in link    # seller code rides in src
    assert len(link.split("src=")[1]) <= 30
    monkeypatch.setenv("AO_SITE_URL_A", "https://override.example/")
    assert auto.mint_base_for("bsky_a") == "https://override.example"


def test_cadence_owner_directive_three_a_day(auto):
    cad = auto.load_cadence()
    for r in ("x", "linkedin", "bsky", "pinterest", "nostrnote",
              "x_a", "linkedin_a", "bsky_a", "pinterest_b"):  # pinterest_a removed 2026-10-08
        assert cad[r]["per_day"] == 3, r
    assert cad["reply_per_day"] == 4           # bsky/mastodon reply cadence untouched


def test_whop_public_stale_account_key_does_not_shadow_valid_app(auto, monkeypatch):
    _whop_env(monkeypatch)
    body = "Synthetic public forum text for the authentication regression."
    calls = []
    def api(path, method="GET", payload=None, key=None):
        calls.append((path, method, key))
        if path.startswith("/companies/"):
            return (401, {}) if key == "acct-key" else (200, {"title": "AttestOS"})
        if method == "POST": return 201, {"id": "post_synthetic"}
        return 200, {"content": body}
    monkeypatch.setattr(auto, "_whop_api", api)
    assert auto.pub_whop(body, public=True)
    assert [key for path, method, key in calls if method == "POST"] == ["app-key"]


@pytest.mark.parametrize("status", [201, 401, 403, 429, 500])
def test_whop_ambiguous_or_auth_failure_never_causes_a_second_write(auto, monkeypatch, status):
    posts = []
    body = "Synthetic complete forum body."
    def api(path, method="GET", payload=None, key=None):
        if method == "POST":
            posts.append(payload)
            return status, {"id": "post_synthetic"} if status == 201 else {}
        return 200, {"content": body}
    monkeypatch.setattr(auto, "_whop_api", api)
    result = auto._whop_forum_post("exp_synthetic", body, "Title", "synthetic", {"url": "https://example.test/card.png"})
    assert result is (status == 201)
    assert len(posts) == 1


def test_whop_readback_same_prefix_different_body_is_not_success(auto, monkeypatch):
    body = "A" * 50 + " original full content"
    def api(path, method="GET", payload=None, key=None):
        return (201, {"id": "post_synthetic"}) if method == "POST" else (200, {"content": "A" * 50 + " wrong content"})
    monkeypatch.setattr(auto, "_whop_api", api)
    assert not auto._whop_forum_post("exp_synthetic", body, "Title", "synthetic")


def test_nostr_limit_and_fixlist_directives(auto):
    assert auto.LIMITS["nostr"] == 300
    fix = auto._fixlist(["names the product", "outside 700-1700 words", "no H2 structure"])
    assert "do NOT mention AttestOS" in fix
    assert "at least three ## H2 section headings" in fix

def test_three_buffer_accounts_company_and_sellers_routing(auto, monkeypatch):
    import push
    # 1. Slot mapping is identical for Company and Sellers (_a, _b)
    for suf in ("", "_a", "_b"):
        for fam in ("x", "linkedin", "pinterest"):
            assert auto.buffer_slot(fam + suf) == "A"
        for fam in ("facebook", "instagram", "threads"):
            assert auto.buffer_slot(fam + suf) == "B"
        for fam in ("youtube", "tiktok", "gbp"):
            assert auto.buffer_slot(fam + suf) == "C"

    # 2. Company 3 Buffer tokens resolve per slot (A, B, C)
    monkeypatch.setenv("AO_BUFFER_TOKEN", "tok-co-A")
    monkeypatch.setenv("AO_BUFFER_TOKEN_B_CO", "tok-co-B")
    monkeypatch.setenv("AO_BUFFER_TOKEN_C_CO", "tok-co-C")
    monkeypatch.setenv("AO_CHANNEL_INSTAGRAM", "ch-co-ig")
    monkeypatch.setenv("AO_CHANNEL_YOUTUBE", "ch-co-yt")
    assert auto.buffer_creds("x")[0] == "tok-co-A"
    assert auto.buffer_creds("instagram") == ("tok-co-B", "ch-co-ig")
    assert auto.buffer_creds("youtube") == ("tok-co-C", "ch-co-yt")

    # 3. Seller A and Seller B 3 Buffer tokens resolve per slot (A, B, C)
    monkeypatch.setenv("AO_BUFFER_TOKEN_A", "tok-selA-A")
    monkeypatch.setenv("AO_BUFFER_TOKEN_A_B", "tok-selA-B")
    monkeypatch.setenv("AO_BUFFER_TOKEN_A_C", "tok-selA-C")
    monkeypatch.setenv("AO_CHANNEL_THREADS_A", "ch-selA-threads")
    monkeypatch.setenv("AO_CHANNEL_TIKTOK_A", "ch-selA-tt")
    assert auto.buffer_creds("x_a")[0] == "tok-selA-A"
    assert auto.buffer_creds("threads_a") == ("tok-selA-B", "ch-selA-threads")
    assert auto.buffer_creds("tiktok_a") == ("tok-selA-C", "ch-selA-tt")
    monkeypatch.setattr(auto, "VIDEOS_REPO", "AttestOS/attestos-videos")
    assert auto._rail_armed("tiktok_a") is True

    monkeypatch.setenv("AO_BUFFER_TOKEN_B", "tok-selB-A")
    monkeypatch.setenv("AO_BUFFER_TOKEN_B_B", "tok-selB-B")
    monkeypatch.setenv("AO_BUFFER_TOKEN_B_C", "tok-selB-C")
    monkeypatch.setenv("AO_CHANNEL_GBP_B", "ch-selB-gbp")
    assert auto.buffer_creds("gbp_b") == ("tok-selB-C", "ch-selB-gbp")
    assert auto._rail_armed("gbp_b") is True

    # 4. Video rails stay unarmed until a videos repo exists; then the catalog attaches the asset
    monkeypatch.setattr(auto, "VIDEOS_REPO", "")
    assert auto._rail_armed("youtube") is False
    inp = push.build_create_post_input({
        "channel_id": "ch-co-yt", "text": "Find the leak.\nhttps://attestos-edge.attestos.workers.dev",
        "due": "2026-10-18T12:00:00Z", "video_url": "https://example.com/v.mp4", "youtube_title": "T" * 120})
    assert inp["assets"][0]["video"]["url"] == "https://example.com/v.mp4"
    assert inp["metadata"]["youtube"]["title"] == "T" * 100


def test_nothing_arms_without_credentials(auto, monkeypatch):
    """Owner 2026-10-27: no accounts yet, build the mesh armed - every rail waits for its secrets."""
    import os
    for k in list(os.environ):
        if k.startswith(("AO_", "PRESS_", "WHOP_")):
            monkeypatch.delenv(k, raising=False)
    assert [r for r in auto.VALUE_PLATFORMS + ("whop_public",) if auto._rail_armed(r)] == []


def test_buffer_discovery_arms_rails_and_caches(auto, monkeypatch):
    import io, os
    for k in list(os.environ):
        if k.startswith(("AO_CHANNEL_", "PRESS_CHANNEL_")):
            monkeypatch.delenv(k, raising=False)
    calls = []
    def fake(req, timeout=20):
        q = json.loads(req.data)["query"]; calls.append(q)
        assert req.headers["Authorization"] == "Bearer tok-co-A"
        if "organizations" in q:
            return io.BytesIO(json.dumps({"data": {"account": {"organizations": [{"id": "org1"}]}}}).encode())
        return io.BytesIO(json.dumps({"data": {"channels": [
            {"id": "c-tw", "service": "twitter", "isDisconnected": False},
            {"id": "c-li", "service": "linkedin", "isDisconnected": True}]}}).encode())
    monkeypatch.setattr(auto.urllib.request, "urlopen", fake)
    auto._BUFFER_DISCOVERED.clear()
    assert auto._rail_armed("x") is False                    # offline check: nothing discovered yet
    st = {}
    auto.prime_buffer_discovery(st)
    assert auto._rail_armed("x") is True and auto._rail_armed("linkedin") is False   # disconnected skipped
    assert auto.buffer_creds("x", st) == ("tok-co-A", "c-tw")
    n = len(calls)
    auto._BUFFER_DISCOVERED.clear()
    auto.prime_buffer_discovery(st)                           # 24h state cache: no new reads
    assert len(calls) == n == 2
    monkeypatch.setattr(auto.urllib.request, "urlopen", lambda *a, **k: (_ for _ in ()).throw(OSError("down")))
    assert auto.buffer_discover("other-token", {}) == {}      # never raises


def test_planner_rotates_audience_start(auto, monkeypatch):
    seen = set()
    for h in (0, 6, 12, 18, 24, 30):
        monkeypatch.setattr(auto, "now", lambda h=h: auto.datetime(2026, 11, 2, tzinfo=auto.timezone.utc) + auto.timedelta(hours=h))
        jobs = auto.due_this_cycle(auto.load_state(), TOPICS)
        vals = [j for j in jobs if j["kind"] == "value"]
        if vals:
            seen.add(vals[0]["topic"].get("audience"))
    assert len(seen) >= 3, seen

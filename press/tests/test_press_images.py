"""Every autopilot post carries an image (owner rule 2026-09-27).
Cards render in the runner; URL rails get a mint-hosted URL, byte rails upload the PNG; an image
failure never costs the post (text-only retry) and a bare post raises a health alert.
Nothing networks: urlopen, Buffer, Whop, Bluesky and Nostr are stubbed."""
import io
import json
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cards  # noqa: E402
import facts  # noqa: E402

TOPICS = json.loads(facts.render((Path(__file__).resolve().parents[1] / "topics.json").read_text()))
RAILS = ["x", "linkedin", "pinterest", "bsky", "nostrnote", "whop_public", "whop_private", "devto", "nostr30023"]
TEXT = ("Repeated requirements are the real ones. Read the listing for the problem, not the list. "
        "The ones that show up twice decide the shortlist. Details: https://example.org/x")


@pytest.fixture()
def auto(tmp_path, monkeypatch):
    monkeypatch.setenv("PRESS_AUTO_DIR", str(tmp_path / "auto"))
    for k, v in {"AO_BUFFER_TOKEN_A_CO": "tok-co-A", "AO_CHANNEL_X": "ch-co-x", "AO_CHANNEL_LINKEDIN": "ch-co-li",
                 "AO_CHANNEL_PINTEREST": "ch-co-pin", "AO_PINBOARD": "board-co"}.items():
        monkeypatch.setenv(k, v)
    sys.modules.pop("auto", None)
    import auto as mod
    monkeypatch.setattr(mod, "ADIR", tmp_path / "auto")
    monkeypatch.setattr(mod, "STATE_F", tmp_path / "auto" / "state.json")
    monkeypatch.setattr(mod, "LOG_F", tmp_path / "auto" / "run.log")
    mod._MINT_URLS.clear()
    return mod


def _t(kind, fmt="short"):
    return next(t for t in TOPICS if t["kind"] == kind and t["format"] == fmt)


# ---------- the cards ----------

@pytest.mark.parametrize("rail", RAILS)
@pytest.mark.parametrize("kind", ["value", "promo", "longform"])
def test_every_rail_and_kind_renders_a_png_of_its_shape(rail, kind):
    png = cards.render(_t("promo" if kind == "promo" else "value"), kind, TEXT, rail, facts.billing())
    im = Image.open(io.BytesIO(png))
    assert im.format == "PNG" and im.size == cards.SHAPES[cards.shape_for(rail)]
    assert len(png) < 1_000_000                       # Bluesky's blob ceiling and mint's cap


def test_card_text_comes_from_approved_copy_never_urls():
    assert "http" not in cards.pull_line(TEXT)
    assert cards.pull_line(TEXT).startswith("Repeated requirements")
    assert "http" not in cards.alt_text(_t("value"), "value", TEXT)


def test_long_titles_still_fit(monkeypatch):
    t = {"id": "long", "title": "A very long title " * 12}
    for rail in ("x", "pinterest", "devto"):
        Image.open(io.BytesIO(cards.render(t, "value", TEXT, rail))).verify()


# ---------- hosting + fallback ----------

class _Resp(io.BytesIO):
    status = 200
    def __enter__(self): return self
    def __exit__(self, *a): return False


def test_url_rails_get_a_mint_url_byte_rails_get_bytes(auto, monkeypatch):
    monkeypatch.setenv("AO_PRESS_TOKEN", "c")
    seen = []
    def fake_open(req, timeout=0):
        seen.append(req.full_url)
        assert req.headers["Authorization"] == "Bearer c" and req.data[:4] == b"\x89PNG"
        return _Resp(json.dumps({"url": "https://mint.test/img/abc.png"}).encode())
    monkeypatch.setattr(auto.urllib.request, "urlopen", fake_open)
    st = auto.load_state()
    for rail in RAILS:
        img = auto.make_image(st, _t("value"), "value", rail, TEXT)
        assert img["png"][:4] == b"\x89PNG"
        if rail in auto.URL_RAILS:
            assert img["url"] == "https://mint.test/img/abc.png" and img["src"] == "card"
        else:
            assert img["url"] == ""
    assert all(u.endswith("/api/press/img") for u in seen)


def test_mint_down_falls_back_to_static_brand_images(auto, monkeypatch):
    monkeypatch.setenv("AO_PRESS_TOKEN", "c")
    def boom(*a, **k): raise OSError("mint down")
    monkeypatch.setattr(auto.urllib.request, "urlopen", boom)
    st = auto.load_state()
    x = auto.make_image(st, _t("value"), "value", "x", TEXT)
    pin = auto.make_image(st, _t("value"), "value", "pinterest", TEXT)
    assert x["url"].endswith("/promo/og-default-1200x630.jpg") and x["src"] == "fallback"
    assert pin["url"].startswith(auto.IMG_BASE) and pin["url"].rsplit("/", 1)[-1] in auto.PINS


# ---------- each publisher attaches it ----------

def test_buffer_sends_the_card_and_retries_text_only_if_rejected(auto, monkeypatch):
    import push
    monkeypatch.setenv("AO_BUFFER_TOKEN", "t")
    sent = []
    def gql(m, v, tok):
        sent.append(v["i"])
        if v["i"]["assets"]:
            return {"data": {"createPost": {"__typename": "InvalidInputError", "message": "bad image"}}}
        return {"data": {"createPost": {"__typename": "PostActionSuccess"}}}
    monkeypatch.setattr(push, "_gql", gql)
    st = auto.load_state()
    img = {"url": "https://mint.test/img/a.png"}
    assert auto.pub_buffer(st, "linkedin", "a post", "2030-01-01T10:00:00Z", False, "", img) is True
    assert sent[0]["assets"] == [{"image": {"url": "https://mint.test/img/a.png"}}]
    assert sent[1]["assets"] == [] and img["attached"] is False


def test_buffer_pinterest_takes_a_full_url(auto, monkeypatch):
    import push
    monkeypatch.setenv("AO_BUFFER_TOKEN", "t")
    sent = []
    monkeypatch.setattr(push, "_gql", lambda m, v, tok: sent.append(v["i"]) or
                        {"data": {"createPost": {"__typename": "PostActionSuccess"}}})
    img = {"url": "https://mint.test/img/p.png"}
    assert auto.pub_buffer(auto.load_state(), "pinterest", "a pin", "2030-01-01T10:00:00Z", False, img["url"], img)
    assert sent[0]["assets"][0]["image"]["url"] == "https://mint.test/img/p.png" and img["attached"]


def test_bsky_uploads_blob_and_embeds_with_alt(auto, monkeypatch):
    import reply
    monkeypatch.setenv("AO_BSKY_ID", "me"); monkeypatch.setenv("AO_BSKY_PASS", "pw")
    recs = []
    def post(url, payload, hdr=None, form=False):
        if url.endswith("createSession"): return 200, {"did": "did:x", "accessJwt": "j"}
        recs.append(payload["record"]); return 200, {}
    monkeypatch.setattr(reply, "_post", post)
    monkeypatch.setattr(auto.urllib.request, "urlopen",
                        lambda req, timeout=0: _Resp(json.dumps({"blob": {"$type": "blob", "ref": "r"}}).encode()))
    img = {"png": b"\x89PNG....", "alt": "card alt", "size": (1200, 675)}
    assert auto.pub_bsky("text post", img) is True
    emb = recs[0]["embed"]
    assert emb["$type"] == "app.bsky.embed.images" and emb["images"][0]["alt"] == "card alt"
    assert emb["images"][0]["aspectRatio"] == {"width": 1200, "height": 675} and img["attached"]


def test_whop_post_carries_the_card_as_a_tiptap_image_and_survives_a_rejection(auto, monkeypatch):
    calls = []
    def api(p, m="GET", b=None, key=None):
        calls.append((m, p, dict(b) if b else b))
        if p == "/forum_posts" and m == "POST":
            return (422, {"error": "rich"}) if len([c for c in calls if c[1] == "/forum_posts"]) == 1 else (200, {"id": "post_1"})
        if p == "/forum_posts/post_1": return 200, {"content": text}
        return 400, {}
    monkeypatch.setattr(auto, "_whop_api", api)
    text = "hello forum body text\n\n- one **bold** point\n- see https://example.org/a\n\n## Next\n\nmore [here](https://x.org)"
    img = {"url": "https://mint.test/img/w.png", "alt": "card alt"}
    assert auto._whop_forum_post("exp_1", text, "t", "k", img) is True
    first, second = [c[2] for c in calls if c[1] == "/forum_posts" and c[0] == "POST"]
    doc = json.loads(first["rich_content"])
    assert doc["content"][0] == {"type": "image", "attrs": {"src": "https://mint.test/img/w.png", "alt": "card alt"}}
    kinds = [n["type"] for n in doc["content"]]
    assert kinds == ["image", "paragraph", "bulletList", "heading", "paragraph"]
    marks = json.dumps(doc)
    assert '"type": "bold"' in marks and '"href": "https://example.org/a"' in marks and '"href": "https://x.org"' in marks
    assert first["content"].endswith("![card alt](https://mint.test/img/w.png)")
    assert "rich_content" not in second and second["content"] == text and img["attached"] is False


def test_whop_readback_ignores_the_mirrored_image(auto, monkeypatch):
    def api(p, m="GET", b=None, key=None):
        if p == "/forum_posts" and m == "POST": return 200, {"id": "post_2"}
        return 200, {"content": "![stpi card](https://mint.test/img/w.png)\nhello forum body text and more"}
    monkeypatch.setattr(auto, "_whop_api", api)
    img = {"url": "https://mint.test/img/w.png", "alt": "stpi card"}
    assert auto._whop_forum_post("exp_1", "hello forum body text and more", "t", "k", img) is True
    assert img["attached"] is True
    assert "whop_readback_doubt" not in (auto.LOG_F.read_text() if auto.LOG_F.exists() else "")


def test_nostr_note_carries_url_and_imeta(auto, monkeypatch):
    import nostr
    monkeypatch.setenv("AO_NOSTR_NSEC", "x")
    got = {}
    monkeypatch.setattr(nostr, "sign", lambda k, tags, content: got.update(tags=tags, content=content) or {"id": "e"})
    monkeypatch.setattr(nostr, "verify_sig", lambda ev: True)
    async def pub(ev): return {"a": "OK", "b": "OK"}
    monkeypatch.setattr(nostr, "publish", pub)
    img = {"url": "https://mint.test/img/n.png", "size": (1200, 675), "alt": "a"}
    assert auto.pub_nostr_note("note text", img) is True
    assert got["content"].endswith("https://mint.test/img/n.png")
    assert got["tags"][0][0] == "imeta" and "dim 1200x675" in got["tags"][0] and img["attached"]


# ---------- the ledger + health ----------

def test_publish_passes_an_image_to_every_rail_and_ledgers_it(auto, monkeypatch):
    monkeypatch.setattr(auto, "_mint_img", lambda png: "https://mint.test/img/z.png")
    got = {}
    def rec(name):
        def f(*a, **k):
            img = a[-1]
            got[name] = img
            img["attached"] = True
            return "https://dev.to/p" if name == "devto" else True
        return f
    for fn in ("pub_bsky", "pub_nostr_note", "pub_devto", "pub_nostr_article", "pub_whop"):
        monkeypatch.setattr(auto, fn, rec(fn))
    def buf(st, ch, text, due, promo, pin, img, link="", rail=""):
        got[ch] = img
        img["attached"] = True
        return True
    monkeypatch.setattr(auto, "pub_buffer", buf)
    st = auto.load_state()
    chans = ["x", "linkedin", "pinterest", "bsky", "nostrnote", "whop_private"]
    job = {"kind": "value", "topic": _t("value"), "channels": chans, "due": {c: "2030-01-01T10:00:00Z" for c in chans}}
    auto.publish(st, job, {c: TEXT for c in chans}, live=True, draft_longform=False)
    for c in ("x", "linkedin", "pinterest"):
        assert got[c]["url"] == "https://mint.test/img/z.png"
    assert got["pub_bsky"]["png"][:4] == b"\x89PNG" and got["pub_whop"]["url"] == "https://mint.test/img/z.png"
    recs = [p for p in st["published"] if p["live"]]
    assert len(recs) == len(chans) and all(p["img_ok"] for p in recs)
    assert auto.image_alerts(st) == []
    assert not list((auto.ADIR / "outbox").glob("*.png"))          # never bloat press-state
    assert all(p["img"] for p in recs)


def test_a_bare_post_raises_the_image_alert(auto):
    st = auto.load_state()
    ts = auto.now().isoformat(timespec="seconds")
    st["published"] += [{"ts": ts, "kind": "value", "platform": "x", "topic": "t", "ok": True, "live": True, "img_ok": False},
                        {"ts": ts, "kind": "value", "platform": "bsky", "topic": "t", "ok": True, "live": True, "img_ok": True},
                        {"ts": ts, "kind": "value", "platform": "x", "topic": "old", "ok": True, "live": True}]
    a = auto.image_alerts(st)
    assert a == ["images: 1 live post(s) landed without an image today (x)"]


def test_whop_upload_falls_back_to_the_app_key_when_the_account_key_lacks_file_scope(auto, monkeypatch):
    monkeypatch.setenv("WHOP_API_KEY", "acct"); monkeypatch.setenv("WHOP_APP_KEY", "app")
    used = []
    def api(p, m="GET", b=None, key=None):
        used.append((p, key))
        if p == "/files" and m == "POST":
            return (403, {"error": "file:create"}) if key == "acct" else (200, {"id": "file_2", "upload_url": "https://s3.test/u"})
        if p == "/files/file_2": return 200, {"upload_status": "ready"}
        return 400, {}
    monkeypatch.setattr(auto, "_whop_api", api)
    monkeypatch.setattr(auto.urllib.request, "urlopen", lambda req, timeout=0: _Resp(b""))
    assert auto._whop_upload(b"\x89PNGxx", "acct") == "file_2"
    assert ("/files", "acct") in used and ("/files", "app") in used and ("/files/file_2", "app") in used


def test_alt_text_does_not_repeat_the_title():
    t = {"id": "x", "title": "Repeated requirements are the real ones"}
    assert cards.alt_text(t, "value", "Repeated requirements are the real ones. More here.") == \
        "AttestOS card: Repeated requirements are the real ones"

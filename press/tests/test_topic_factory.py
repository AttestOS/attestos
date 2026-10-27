"""Topic factory: LLM drafts, the fuzzy matcher + schema gates keep the registry honest."""
import json, sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import facts  # noqa: E402
import topic_factory as tf  # noqa: E402


@pytest.fixture()
def fac(tmp_path, monkeypatch):
    raw = (Path(__file__).resolve().parents[1] / "topics.json").read_text()
    monkeypatch.setattr(tf, "RAW", raw)
    monkeypatch.setattr(tf, "HERE", tmp_path)
    (tmp_path / "topics.json").write_text(raw)
    return tf


_FRESH_TITLES = {
    1: "Honest angle for store owners hit by card testing",
    2: "Founder math on the signup bots nobody counts",
}


def _fresh(i):
    return {"id": f"promo-fresh-{i}", "kind": "promo", "format": "short",
            "title": _FRESH_TITLES[i], "angle": "a" * 20,
            "beats": ["a concrete beat here", "another concrete beat"]}


def test_fuzzy_matcher_shapes(fac):
    assert fac.fuzzy_dup("promo-store-scan", "totally other words", {"promo-store-scan"}, []) == "same id"
    assert "prefix" in fac.fuzzy_dup("promo-flagship-alpha-beta-x", "other words",
                                    {"promo-flagship-alpha-beta-y"}, [])
    near = "Six prompts, free forever copy and paste"
    assert "overlap" in fac.fuzzy_dup("promo-new", "Six prompts, free forever copy and paste", set(), [near])
    assert fac.fuzzy_dup("promo-new", "completely distinct honest angle", set(), [near]) is None


def test_schema_gates(fac):
    assert fac.validate_entry(_fresh(1)) == []
    bad = dict(_fresh(1), title="Revolutionary 50% off today")
    assert "title" in fac.validate_entry(bad) and fac.validate_entry(bad)[-1].startswith("hype")
    inv = dict(_fresh(1), beats=[_fresh(1)["beats"][0], "costs {{mega_price}} only"])
    assert any("placeholder" in p for p in fac.validate_entry(inv))
    assert "unknown asset url" in fac.validate_entry(dict(_fresh(1), asset="https://evil.example/x"))


def test_factory_appends_only_clean_fresh(fac, monkeypatch):
    llm_out = json.dumps([
        dict(_fresh(1), id="promo-store-scan"),                               # duplicate id
        {"id": "promo-evil", "kind": "promo", "format": "short", "title": "x"},  # schema junk
        _fresh(1), _fresh(2),
    ])
    monkeypatch.setattr(fac, "factory_llm", lambda prompt: llm_out)
    monkeypatch.setattr(sys, "argv", ["fac", "--count", "5", "--dry"])
    assert fac.main() == 0                                  # dry: nothing written
    monkeypatch.setattr(sys, "argv", ["fac", "--count", "5"])
    assert fac.main() == 0
    new_raw = (fac.HERE / "topics.json").read_text()
    topics = json.loads(facts.render(new_raw))              # render still parses
    ids = [t["id"] for t in topics]
    assert "promo-fresh-1" in ids and "promo-fresh-2" in ids and "promo-evil" not in ids
    assert len(ids) == len(set(ids))


def test_zero_topic_ceiling_pauses_before_any_author_request(fac, monkeypatch):
    monkeypatch.setenv('AO_PROMO_TOPICS_PER_RUN', '0')
    monkeypatch.delenv('AO_PRESS_TOKEN', raising=False)
    monkeypatch.setattr(sys, 'argv', ['topic_factory.py', '--count', '9999'])
    monkeypatch.setattr(fac, '_ask_llm', lambda *a: pytest.fail('paused factory must not request AI'))
    assert fac.main() == 0

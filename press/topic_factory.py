"""Promo-topic factory (owner 2026-10-01: "draft 30 promo topics, and automate drafting new ones").

The LLM ladder drafts candidate promo topics against the same facts registry the press
renders from; a fuzzy duplicate matcher (scavenged from the owner's Apps Script factory:
exact slug, 25-char prefix, 0.7 token overlap) drops repeats; only schema-clean entries
get appended to press/topics.json. Runs on demand and weekly via topic-factory.yml.
"""
import argparse, json, os, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import auto, facts  # noqa: E402

RAW = (HERE / "topics.json").read_text()
PLACEHOLDERS = set(re.findall(r"\{\{[a-z_]+\}\}", RAW))          # never invent tokens
KNOWN_URLS = {u.rstrip("/") for u in (list(auto.LINKS.values()) + [
])}

def _toks(s: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", s.lower()) if len(t) > 2}


def fuzzy_dup(new_id: str, new_title: str, ids: set[str], titles: list[str]) -> str | None:
    """Scavenged near-duplicate gate; returns the reason or None."""
    if new_id in ids:
        return "same id"
    for i in ids | {re.sub(r"[^a-z0-9-]", "", re.sub(r"\s+", "-", t.lower())) for t in titles}:
        if i[:25] and new_id[:25] == i[:25]:
            return f"25-char prefix of '{i}'"
    nt = _toks(new_title)
    for t in titles:
        ot = _toks(t)
        if nt and ot and len(nt & ot) / max(1, len(nt | ot)) >= 0.7:
            return f"0.7 token overlap with '{t[:40]}'"
    return None


def validate_entry(e: dict) -> list[str]:
    p = []
    if not re.fullmatch(r"promo-[a-z0-9-]{3,48}", str(e.get("id", ""))):
        p.append("id")
    if e.get("kind") != "promo" or e.get("format") != "short":
        p.append("kind/format")
    t, a = str(e.get("title", "")), str(e.get("angle", ""))
    if not (20 <= len(t) <= 90) or any(c.isdigit() for c in t):
        p.append("title")                                     # stat-shapes are banned in titles
    if not a or len(a) > 160:
        p.append("angle")
    beats = e.get("beats")
    if not isinstance(beats, list) or not (2 <= len(beats) <= 6) or \
            any(not isinstance(b, str) or not (12 <= len(b) <= 120) for b in beats):
        p.append("beats")                          # 120 keeps x-post templates under 280
    blob = t + a + " ".join(beats or []) + str(e.get("asset", ""))
    if auto.HYPE.search(blob):
        p.append(f"hype '{auto.HYPE.search(blob).group(0)}'")
    if not p:
        p += facts.check_claims(json.dumps(e))     # registry rule: no invented prices/stats
        if facts.PRICE_SHAPE.search(blob):          # template rule: prices render via {{placeholders}}
            p.append("literal price - use a {{placeholder}}")
        try:
            rendered = facts.render(blob)
        except KeyError:                            # unknown placeholders: flagged just below
            rendered = blob
        if auto.STATS.search(rendered):            # stat shapes can hide inside a placeholder's value
            p.append("stat shape even after render")
    ph = set(re.findall(r"\{\{[a-z_]+\}\}", blob))
    if ph - PLACEHOLDERS:
        p.append(f"invented placeholder {sorted(ph - PLACEHOLDERS)}")
    if "http" in t + a + " ".join(beats or []):
        p.append("url in prose - the asset field owns the pointer")
    asset = str(e.get("asset", ""))
    if asset and asset.rstrip("/") not in KNOWN_URLS and not asset.rstrip("/").startswith(
            auto.facts.site_url()):
        p.append("unknown asset url")
    aud = e.get("audience")
    if aud is not None and aud not in auto.AUDIENCES:
        p.append("audience")
    return p


def factory_llm(prompt: str) -> str:
    """Every author lane the press owns, keyless tail last."""
    for name, style, url, models, key in auto.author_chain():
        try:
            auto._reserve_author_call()
            fn = auto._openai_like if style == "openai" else auto._cohere_like
            return fn(url, key, models[0],
                      "You are the AttestOS growth copywriter vending machine. Output JSON only.", prompt)
        except Exception:
            continue
    auto._reserve_author_call()
    return auto._pollinate("Output JSON only.", prompt)


def existing(raw: str) -> tuple[set[str], list[str]]:
    ids = set(re.findall(r'"id":\s*"([^"]+)"', raw))
    titles = re.findall(r'"title":\s*"([^"]+)"', raw)
    return ids, titles


def _prompt(ask: int, ids: set, catalog: str) -> str:
    return f"""Draft {ask} NEW promo topics for the AttestOS press registry.

Catalog (facts are the ground truth; never invent numbers - use the placeholders where a price belongs):
{catalog}

Each topic is ONE JSON object:
{{"id": "promo-<kebab-slug>", "kind": "promo", "format": "short",
  "title": "<20-90 chars, no digits>",
  "angle": "<the honest selling angle, max 160 chars>",
  "beats": ["<2-6 concrete beats a post can hit, 12-160 chars each, no hype words>"],
  "asset": "<one URL from catalog.links, optional>"}}
Optional "audience": one of "ecom" (online stores), "saas" (SaaS founders), "sales" (B2B sales leads), "agency" (marketing/web agencies).
Angles must vary: objection-handling, specific persona, use-case, comparison ethics,
behind-the-scenes, buyer fear, buyer math. Do not reuse these ids: {sorted(ids)[-14:]}.

Return a JSON array only, no fences, no prose."""


def _ask_llm(prompt: str, shrink_prompt: str) -> list:
    for text in (prompt, shrink_prompt):
        try:
            out = auto._strip_fences(factory_llm(text))
        except Exception:                       # a lane 500ing is one lane, not the factory
            continue
        m = re.search(r"\[.*\]", out, re.S)
        if not m:
            continue
        try:
            cands = json.loads(m.group(0))
            if isinstance(cands, list) and cands:
                return cands
        except json.JSONDecodeError:
            continue
    return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=6)
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    from controls import apply_runtime_controls, validate
    if os.environ.get("AO_PRESS_TOKEN"):
        apply_runtime_controls(strict=True)
    a.count = min(max(0, a.count), validate("AO_PROMO_TOPICS_PER_RUN", os.environ.get("AO_PROMO_TOPICS_PER_RUN", "6")))
    if a.count == 0:
        print("factory: paused by topic ceiling; no author request")
        return 0
    ids, titles = existing(RAW)
    bill = facts.billing()
    catalog = json.dumps({
        "products": {k: v for k, v in bill.items() if isinstance(v, str)},
        "links": auto.LINKS,
        "placeholders_allowed": sorted(PLACEHOLDERS)}, indent=1)[:2400]
    entries, skipped, rounds = [], 0, 0
    # batched asks: a 30-topic single completion exceeds every provider's output cap and
    # parses as nothing - five-ish validated topics per round is the model-reliable size
    max_rounds = a.count // 4 + 3
    while len(entries) < a.count and rounds < max_rounds:
        rounds += 1
        want = min(5, a.count - len(entries))
        cands = _ask_llm(_prompt(want * 3, ids | {e["id"] for e in entries}, catalog),
                         _prompt(want, ids | {e["id"] for e in entries}, catalog))
        for c in cands:
            if len(entries) >= a.count:
                break
            probs = validate_entry(c) if isinstance(c, dict) else ["not an object"]
            dup = None if probs else fuzzy_dup(
                str(c["id"]), str(c["title"]), ids | {x["id"] for x in entries},
                titles + [x["title"] for x in entries])
            if probs or dup:
                skipped += 1
                continue
            entries.append(c)
    if not entries:
        print(f"factory: nothing usable after {rounds} rounds ({skipped} skipped)")
        return 1
    ser = ",\n ".join(json.dumps(e, ensure_ascii=False, indent=2).replace("\n", "\n ") for e in entries)
    ser = re.sub(r'"(\{\{[a-z_]+\}\})"', r"\1", ser)
    new_raw = RAW.rstrip()
    assert new_raw.endswith("]")
    new_raw = new_raw[:-1].rstrip()
    assert new_raw.endswith("}")
    new_raw = new_raw + ",\n " + ser + "\n]\n"
    json.loads(facts.render(new_raw))          # prove the render still parses before disk
    if not a.dry:
        (HERE / "topics.json").write_text(new_raw)
    print(f"factory: added {len(entries)} promo topics in {rounds} rounds ({skipped} skipped): "
          f"{[e['id'] for e in entries]}")
    return 0


if __name__ == "__main__":
    from controls import publish_usage
    try:
        code = main()
    finally:
        publish_usage("press", auto._AUTHOR_CALLS, "Promo topic factory author attempts in this process; not tokens/account total",
                      (os.environ.get("GITHUB_RUN_ID", "local") + "-" + str(os.getpid()))[:80], groups=("ai",))
    raise SystemExit(code)

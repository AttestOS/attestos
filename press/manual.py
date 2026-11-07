#!/usr/bin/env python3
"""Manual-post pack: the rails that have no API, written by the same author as the rest.

Reddit, Quora, Medium, Tumblr and itch.io have no publishing rail in this press and no
public write API worth the risk of a ban. Instead of leaving them empty, this generates a
copy-paste pack for each one from the SAME brief as every other rail: the voice pack
(press/voice.md), the product facts (brand/brand.json via facts.py), and the topic pool
(press/topics.json). Every piece is checked by the press editor before it goes in the pack,
so what you paste cannot carry a price, claim or dash the live rails are forbidden.

Usage:
  python3 press/manual.py pack                 # this week's pack -> press/manual/<date>.md
  python3 press/manual.py pack --topics 3      # three topics instead of two

The author lane is whatever press/auto.py's author_chain() resolves (Cloudflare Workers AI
in CI), so this needs the same environment as a cycle. Nothing is published: the pack is a
file, and you post it by hand.

Rotation: topics already used in a pack are remembered in press/auto/manual.json, so the
next pack moves on instead of repeating last week's essay.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import auto  # noqa: E402

# Every target shares this bar. The first draft of this script produced pleasant, generic,
# repetitive copy that opened with a fabricated first-person anecdote ("I have been monitoring
# the transaction logs of my online store"), which would be a lie on Reddit and reads as filler
# anywhere. Named once, applied to all five.
QUALITY = (
    "Rules that override the brief above: never invent personal experience, customers, "
    "anecdotes or quotes; you are an engineer explaining a mechanism, not a shop owner telling a "
    "story. Do not open with context or with 'In today's...'. Every paragraph must add something "
    "new: a mechanism, a specific observable, or a cost to the attacker. Never restate a point in "
    "different words to fill space. Prefer one concrete example a reader can verify on their own "
    "site over three general sentences. Plain sentences, varied length, no hype."
)

ROTATION_F = Path(os.environ.get("PRESS_AUTO_DIR", HERE / "auto")) / "manual.json"

# Copy-paste shapes. Each one is a real platform culture, not a generic post: Reddit wants a
# plain-text story with no pitch, Quora wants an answer to a question someone already asked,
# Medium wants the essay, Tumblr wants something short and human with tags, itch.io wants a
# devlog written for people who follow the project.
TARGETS = {
    "reddit": {
        "chars": 9000,
        "brief": (
            "Write a Reddit self-post for r/webdev or r/ecommerce. Title on the first line prefixed "
            "with 'TITLE: ', then the body. Plain text only, no markdown headings, no links except "
            "at most one at the very end. Open with the mechanic itself, in one sentence, and why "
            "it is easy to miss. Write as an engineer explaining to peers what the pattern is, how "
            "a script produces it and what the store sees in its logs. No first-person stories "
            "about your own store, no persona, no product pitch: this must be useful to someone "
            "who will never buy anything. 350 to 550 words."
        ),
    },
    "quora": {
        "chars": 9000,
        "brief": (
            "Write a Quora answer. First line is the question this answers, prefixed with 'Q: ', "
            "phrased the way a real person would ask it. Then the answer, in plain prose, no "
            "headings, no bullet lists. Answer the question directly in the first two sentences, "
            "then explain the mechanism, then one thing the reader can check themselves. 250 to "
            "450 words. No links, no pitch."
        ),
    },
    "medium": {
        "chars": 12000,
        "brief": (
            "Write a Medium article. First line is the title prefixed with 'TITLE: ', then a "
            "one-sentence standfirst prefixed with 'SUBTITLE: ', then markdown with '## ' "
            "sections. 800 to 1200 words. Essay register: one idea developed properly, concrete "
            "examples a reader can verify, no listicles, no 'in today's fast-paced world' openings."
        ),
    },
    "tumblr": {
        "chars": 3000,
        "brief": (
            "Write a Tumblr post. Short, dry, human, no marketing voice. 90 to 180 words. Plain "
            "text, at most one line break paragraph structure. On the last line put exactly three "
            "tags, space separated, each starting with '#'."
        ),
    },
    "itchio": {
        "chars": 6000,
        "brief": (
            "Write an itch.io devlog post for AttestOS. First line is the heading prefixed with "
            "«TITLE: », then 200 to 350 words addressed to people who already follow the project: "
            "what changed this week, what was hard, what is next. Technical, honest about limits, "
            "no marketing. Markdown allowed."
        ),
    },
}


def load_rotation() -> dict:
    try:
        return json.loads(ROTATION_F.read_text())
    except Exception:
        return {"used": []}


def save_rotation(rot: dict) -> None:
    ROTATION_F.parent.mkdir(parents=True, exist_ok=True)
    ROTATION_F.write_text(json.dumps(rot, indent=1))


def pick_topics(n: int) -> list[dict]:
    """Topic pool minus anything a previous pack already used, least recently used first."""
    rot = load_rotation()
    used = rot.get("used") or []
    pool = [t for t in auto.load_topics() if t.get("id")]
    fresh = [t for t in pool if t["id"] not in used]
    if len(fresh) < n:                       # pool exhausted: rotate from the top again
        rot["used"] = []
        fresh = pool
    # one topic per audience so a pack never reads like five versions of the same post
    picked, seen = [], set()
    for t in fresh:
        aud = t.get("audience")
        if aud in seen:
            continue
        seen.add(aud)
        picked.append(t)
        if len(picked) == n:
            break
    for t in fresh:
        if len(picked) >= n:
            break
        if t not in picked:
            picked.append(t)
    return picked[:n]


def generate(target: str, topic: dict) -> str:
    spec = TARGETS[target]
    prompt = (spec["brief"] + "\n\n" + QUALITY +
              f"\n\nHARD LIMIT: {spec['chars']} characters, anything longer is auto-rejected. "
              "No em-dashes or en-dashes. No emoji. No invented statistics or percentages.")
    out = auto.llm(prompt, "value", topic, target, {})
    return auto.dedash(out).strip()


def check(target: str, text: str) -> list[str]:
    """The press editor, adapted: these rails are not in LIMITS, so check what carries over."""
    problems = list(auto.validate_copy("value", {"id": "manual"}, "x", text))
    over = len(text) - TARGETS[target]["chars"]
    if over > 0:
        problems.append(f"{target}: {over} chars over {TARGETS[target]['chars']}")
    return [p for p in problems if "x:" not in p]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="manual.py")
    ap.add_argument("cmd", choices=["pack"])
    ap.add_argument("--topics", type=int, default=2)
    ap.add_argument("--out", default="")
    a = ap.parse_args(argv)

    topics = pick_topics(a.topics)
    if not topics:
        print("no topics available")
        return 1
    out_path = Path(a.out) if a.out else (HERE / "manual" / f"{date.today().isoformat()}-pack.md")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    lines = [f"# Manual post pack, {date.today().isoformat()}", "",
             "Generated by `press/manual.py` from the same voice pack, product facts and topic pool as",
             "every automated rail. Checked by the press editor before it landed here. Nothing in this",
             "file has been published: copy a block, paste it on the platform, done.", ""]

    written = 0
    for topic in topics:
        lines += [f"## Topic: {topic.get('title') or topic['id']}", ""]
        if topic.get("audience"):
            lines.append(f"*audience: {topic['audience']}*")
            lines.append("")
        for target in TARGETS:
            try:
                text = generate(target, topic)
            except Exception as exc:                      # noqa: BLE001
                lines += [f"### {target}", "", f"_generation failed: {type(exc).__name__}: {exc}_", ""]
                continue
            bad = check(target, text)
            lines += [f"### {target}", "", "```text", text, "```", ""]
            if bad:
                lines += [f"**editor notes (fix before posting):** {'; '.join(bad)}", ""]
            else:
                lines += [f"_clean: {len(text)} chars, passes the press editor_", ""]
            written += 1
        rot = load_rotation()
        if topic["id"] not in rot.setdefault("used", []):
            rot["used"].append(topic["id"])
        save_rotation(rot)

    out_path.write_text("\n".join(lines).rstrip() + "\n")
    print(f"pack: {written} pieces for {len(topics)} topic(s) -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Builds the static fallback images the press links to when a rendered card cannot be hosted:
site/promo/og-default-1200x630.jpg (wide fallback, Nostr banner), site/promo/icon-tile-1024.png (Nostr
avatar) and site/covers/pin-*.jpg (Pinterest fallbacks, auto.PINS). Run: python3 press/make_covers.py"""
import io
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cards  # noqa: E402
import facts  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

SITE = HERE.parent / "site"


def _jpg(png: bytes, path: Path, size=None):
    im = Image.open(io.BytesIO(png)).convert("RGB")
    if size:
        im = im.resize(size, Image.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "JPEG", quality=86, optimize=True, progressive=True)


def main():
    b = facts.billing()
    wide = {"id": "og-default", "title": "Bot checks your visitors never see"}
    _jpg(cards.render(wide, "value", facts.brand()["promise"], "x", b), SITE / "promo" / "og-default-1200x630.jpg", (1200, 630))
    pins = {
        "pin-scanner.jpg": ({"id": "pin-scanner", "title": "Scan any page: which CAPTCHA does it show?"},
                            "value", "Paste a URL. See the bot check, the exposed forms and how robots.txt treats AI crawlers. Free, no signup."),
        "pin-free-plan.jpg": ({"id": "pin-free", "title": "An invisible check instead of an image puzzle"},
                              "value", "Proof of work runs in the background. One server-side verify call. Free plan for 1 site."),
        "pin-agentpass.jpg": ({"id": "pin-agentpass", "title": "Allow, charge or block each AI crawler"},
                              "value", "Verify crawlers by their published IP ranges. Charge with HTTP 402. Meter agent keys."),
        "pin-plans.jpg": ({"id": "pin-plans", "title": "AttestOS plans"}, "promo", ""),
    }
    for name, (topic, kind, text) in pins.items():
        _jpg(cards.render(topic, kind, text, "pinterest", b), SITE / "covers" / name, (848, 1264))
    # avatar: the mark on the night background
    im = Image.new("RGB", (1024, 1024), "#060B16")
    cards._mark(ImageDraw.Draw(im), 112, 112, 800, "#22D3EE", "#E2E8F0", "#060B16")
    im.save(SITE / "promo" / "icon-tile-1024.png", optimize=True)
    print("covers written")


if __name__ == "__main__":
    main()

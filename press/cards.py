"""Post cards: every autopilot post ships with an image rendered here, in the runner, for $0.

A card is built from text that has already passed the editor (the topic title and the
approved post's opening line), so an image can never say something the post couldn't.
Promo cards add the price strip straight from BILLING. Shapes per rail:

  wide   1200x675   x, linkedin, bsky, nostrnote, whop_public, whop_private
  pin    1000x1500  pinterest
  cover  1000x420   devto, nostr30023 (dev.to crops covers to 1000x420)

Palette follows the topic (same idea = same colours on every rail); the layout rotates
between a quote card and a points card so a feed doesn't look stamped.
"""
from __future__ import annotations

import hashlib
import io
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
FONT_DIRS = (HERE / "fonts", Path("/usr/share/fonts/truetype/dejavu"))
SHAPES = {"wide": (1200, 675), "pin": (1000, 1500), "cover": (1000, 420)}
RAIL_SHAPE = {"pinterest": "pin", "devto": "cover", "nostr30023": "cover"}
PALETTES = [  # bg, ink, accent, muted — AttestOS site tokens (site/assets/css/site.css)
    ("#060B16", "#E2E8F0", "#22D3EE", "#94A3B8"),   # night, cyan
    ("#0F1A2E", "#E2E8F0", "#A78BFA", "#94A3B8"),   # card, violet
    ("#F8FAFC", "#060B16", "#0891B2", "#475569"),   # light, deep cyan
    ("#0B1324", "#FFFFFF", "#34D399", "#94A3B8"),   # night, green
]
KICKER = {"value": "FIELD NOTE", "longform": "ESSAY", "promo": "FROM THE BUILD"}
PRICED = re.compile(r"tiers|pricing|plans|storefront|community|upgrade")
FOOTER = "AttestOS  ·  bot checks your visitors never see"


def shape_for(rail: str) -> str:
    return RAIL_SHAPE.get(rail, "wide")


def _font(size: int, bold: bool = False):
    from PIL import ImageFont
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    for d in FONT_DIRS:
        if (d / name).exists():
            return ImageFont.truetype(str(d / name), size)
    return ImageFont.load_default(size=size)


def _clean(text: str) -> str:
    t = re.sub(r"https?://\S+", "", text or "")
    t = re.sub(r"[*_`#>\[\]]", "", t)
    return re.sub(r"\s+", " ", t).strip()


def pull_line(text: str, limit: int = 150) -> str:
    """First full sentence of the approved copy (the hook), trimmed on a word boundary."""
    t = _clean(text)
    m = re.match(r"(.{25,}?[.?:])(\s|$)", t)
    s = m.group(1) if m else t
    if len(s) > limit:
        s = s[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "..."
    return s


def points(text: str, n: int = 3) -> list[str]:
    """Up to n short list lines or sentences from the approved copy, for the points layout."""
    lines = [_clean(x)[2:].strip() if _clean(x)[:2] in ("- ", "* ") else "" for x in (text or "").splitlines()]
    pts = [x for x in lines if 12 <= len(x) <= 90]
    if len(pts) < 2:
        sents = re.split(r"(?<=[.?])\s+", _clean(text))
        pts = [s for s in sents[1:] if 20 <= len(s) <= 90]
    return pts[:n]


def _wrap(d, text: str, font, width: int) -> list[str]:
    out, cur = [], ""
    for w in text.split():
        trial = (cur + " " + w).strip()
        if d.textlength(trial, font=font) <= width:
            cur = trial
        else:
            if cur:
                out.append(cur)
            cur = w
    if cur:
        out.append(cur)
    return out


def _fit(d, text: str, width: int, max_lines: int, sizes: tuple, bold: bool = True):
    """Largest size at which text wraps into max_lines; ellipsis at the smallest size."""
    for sz in sizes:
        f = _font(sz, bold)
        ln = _wrap(d, text, f, width)
        if len(ln) <= max_lines:
            return f, ln, sz
    f = _font(sizes[-1], bold)
    ln = _wrap(d, text, f, width)[:max_lines]
    ln[-1] = ln[-1].rstrip(".,;:") + "..."
    return f, ln, sizes[-1]


def _mark(d, x: int, y: int, s: int, col: str, ink: str = "#0B1324", bg: str = "#FFFFFF") -> None:
    """The AttestOS mark (site/assets/img/favicon.svg, 64-unit grid): a shield outline in the palette
    accent with the check in ink."""
    u = s / 64.0
    P = lambda pts: [(x + px * u, y + py * u) for px, py in pts]
    shield = [(32, 8), (52, 16), (52, 30), (50.5, 38), (46, 45.5), (39.5, 51.5), (32, 56),
              (24.5, 51.5), (18, 45.5), (13.5, 38), (12, 30), (12, 16), (32, 8)]
    d.line(P(shield), fill=col, width=max(2, int(4 * u)), joint="curve")
    d.line(P([(22, 32), (29, 39), (42, 25)]), fill=ink, width=max(2, int(4.5 * u)), joint="curve")


def render(topic: dict, kind: str, text: str, rail: str, billing: dict | None = None) -> bytes:
    from PIL import Image, ImageDraw
    shape = shape_for(rail)
    W, H = SHAPES[shape]
    seed = int(hashlib.sha256(str(topic.get("id", "")).encode()).hexdigest(), 16)
    bg, ink, acc, mut = PALETTES[seed % len(PALETTES)]
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    pad = int(W * 0.07)
    tw = W - 2 * pad
    k = 1.25 if shape == "pin" else W / 1200     # pins are read on phones: type a size up

    # header: mark + wordmark + kicker
    ms = int(54 * k)
    _mark(d, pad, int(pad * 0.8), ms, acc, ink, bg)
    d.text((pad + ms + int(14 * k), int(pad * 0.8) + int(4 * k)), "AttestOS", font=_font(int(34 * k), True), fill=ink)
    kick = KICKER.get(kind, "FIELD NOTE")
    kf = _font(int(22 * k), True)
    d.text((W - pad - d.textlength(kick, font=kf), int(pad * 0.8) + int(12 * k)), kick, font=kf, fill=acc)

    title = _clean(topic.get("title", ""))
    y = int(pad * 0.8) + ms + int(40 * k)
    footer_h = int(70 * k)

    if shape == "cover":
        f, ln, sz = _fit(d, title, tw, 2, tuple(int(s * k) for s in (64, 56, 50, 44)))
        y = (H - len(ln) * int(sz * 1.2)) // 2 + int(20 * k)
        for line in ln:
            d.text((pad, y), line, font=f, fill=ink)
            y += int(sz * 1.2)
        d.rectangle((pad, H - int(28 * k), pad + int(120 * k), H - int(22 * k)), fill=acc)
        return _png(img)

    big = shape == "pin"
    top = y
    body = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(body)
    y = 0
    f, ln, sz = _fit(d, title, tw, 4 if big else 3,
                     tuple(int(s * k) for s in ((84, 74, 64, 56) if big else (64, 56, 50, 44, 40))))
    for line in ln:
        d.text((pad, y), line, font=f, fill=ink)
        y += int(sz * 1.18)
    y += int(22 * k)
    d.rectangle((pad, y, pad + int(90 * k), y + int(6 * k)), fill=acc)
    y += int(40 * k)

    room = H - footer_h - top - y - int(20 * k)
    pts = points(text) if (seed >> 3) % 2 else []
    if kind == "promo" and billing and billing.get("usd") and PRICED.search(str(topic.get("id", ""))):
        u = billing["usd"]
        strip = (f"Free $0   ·   IntegrityRuntime ${u['integrity']}/mo   ·   AgentPass ${u['agent']}/mo   ·   "
                 f"Hardware ${u['hardware']}/mo   ·   Enterprise ${u['enterprise']}/mo")
        sf, sl, ssz = _fit(d, strip, tw, 2, tuple(int(s * k) for s in (30, 27, 24)), bold=True)
        for line in sl:
            d.text((pad, y), line, font=sf, fill=acc)
            y += int(ssz * 1.3)
        d.text((pad, y + int(6 * k)), "Free plan: " + str(billing.get("free_verifs", "")) + " verifications a month. Checkout on Whop.",
               font=_font(int(24 * k)), fill=mut)
        y += int(44 * k)
    elif len(pts) >= 2 and room > int(150 * k):
        pf = _font(int((34 if big else 28) * k))
        for i, ptxt in enumerate(pts):
            pl = _wrap(d, ptxt, pf, tw - int(50 * k))[:2]
            if y + len(pl) * int(38 * k) > H - footer_h - top - int(10 * k):
                break
            d.ellipse((pad, y + int(10 * k), pad + int(16 * k), y + int(26 * k)), fill=acc)
            for line in pl:
                d.text((pad + int(40 * k), y), line, font=pf, fill=ink)
                y += int((44 if big else 38) * k)
            y += int(12 * k)
    else:
        q = pull_line(text, 220 if big else 150)
        if q and q.rstrip(".?: ").lower() != title.rstrip(".?: ").lower():
            qf, ql, qsz = _fit(d, q, tw, max(1, room // int(44 * k)),
                               tuple(int(s * k) for s in ((40, 36, 32) if big else (32, 29, 26))), bold=False)
            for line in ql:
                d.text((pad, y), line, font=qf, fill=mut)
                y += int(qsz * 1.35)

    # centre the content block between header and footer (never above the header line)
    avail = H - footer_h - top
    y0 = top + max(0, (avail - y) // 2) if big or y < avail * 0.8 else top
    img.paste(body.crop((0, 0, W, min(y, avail))), (0, y0))
    d = ImageDraw.Draw(img)
    kf2 = W / 1200
    d.text((pad, H - footer_h + int(18 * kf2)), FOOTER, font=_font(int((24 if big else 20) * kf2)), fill=mut)
    return _png(img)


def alt_text(topic: dict, kind: str, text: str) -> str:
    t = _clean(topic.get("title", ""))
    q = pull_line(text, 200)
    if q.rstrip(".?: ").lower() == t.rstrip(".?: ").lower():
        q = ""
    return (f"AttestOS {KICKER.get(kind, 'field note').lower()} card: {t}. {q}" if q else f"AttestOS card: {t}")[:900]


def _png(img) -> bytes:
    b = io.BytesIO()
    img.save(b, "PNG", optimize=True)
    return b.getvalue()

"""Product facts for the press author, generated from brand/brand.json so copy cannot drift.

brand/brand.json is AttestOS's single source of truth for the press (plans mirror worker/src/plans.ts;
worker/test checks the prices match). voice.md and topics.json carry {{placeholders}} instead of literal
prices/limits; render() fills them at runtime and raises on an unknown name. check_claims() is the
publish-time gate: any dollar amount, site count or verification count in model copy must be a real fact,
and promises AttestOS cannot keep ("stops all bots") are rejected.
"""
from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "brand" / "brand.json"
PH = re.compile(r"\{\{\s*([a-z_]+)\s*\}\}")
USDAMT = re.compile(r"\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d\d)?(?![\d,])")
# "5 sites", "25 sites": counts the reader could hold us to
SITES = re.compile(r"\b(\d{1,4})\s+(?:protected\s+)?(?:web)?sites?\b", re.IGNORECASE)
# "10,000 verifications", "100k verifications"
VERIFS = re.compile(r"\b(\d{1,3}(?:,\d{3})+|\d+k?)\s+(?:free\s+)?(?:verifications?|verifies|solves)\b", re.IGNORECASE)
# kept for the shared engine/tests (TightBucket's audit-count and audit-speed gates have no AttestOS equivalent)
AUDITS = re.compile(r"(?!x)x")
SECONDS = re.compile(r"(?!x)x")
BOARDS = re.compile(r"(?!x)x")
_WORDS = (r"(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|"
          r"thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)")
# prices written in words or as "USD 30" dodge the amount check: always rejected
WORDPRICE = re.compile(r"\b" + _WORDS + r"[\s-]+(?:US\s)?dollars?\b|\bUSD\s?\d|\d\s?USD\b", re.IGNORECASE)
# any price shape at all: used by the test that keeps literal prices out of voice.md/topics.json
PRICE_SHAPE = re.compile(r"\$\s?\d|\bUSD\s?\d|\d\s?USD\b", re.IGNORECASE)


def site_url() -> str:
    """Public host for every link we hand out (never attestos.com until the domain is live)."""
    return (os.environ.get("AO_SITE_URL", "") or "https://attestos-edge.attestos.workers.dev").rstrip("/")


@lru_cache(maxsize=1)
def brand() -> dict:
    return json.loads(BRAND.read_text())


def _cat(key: str) -> dict:
    for c in brand()["catalog"]:
        if c["key"] == key:
            return c
    raise KeyError(f"catalog entry {key!r} missing from brand.json")


def _amount(price: str) -> str:
    """'$39/mo' -> '$39'; 'from $300' -> '$300'."""
    m = USDAMT.search(price)
    if not m:
        raise ValueError(f"not a dollar price: {price!r}")
    return "$" + m.group(1)


def _num(text: str, pattern: str) -> str:
    m = re.search(pattern, text, re.I)
    if not m:
        raise ValueError(f"{pattern!r} not found in {text!r}")
    return m.group(1)


@lru_cache(maxsize=1)
def billing() -> dict:
    """Prices, plan limits and checkout links. Every checkout goes through the Worker's /go/<plan>, which
    redirects to the Whop checkout (or the pricing page while a plan's checkout is not open yet)."""
    site = site_url()
    free, integ, agent, hw, ent = (_cat(k) for k in ("free", "integrity", "agent", "hardware", "enterprise"))
    bullets = lambda c: " | ".join(c.get("bullets") or [])
    usd = {k: int(_amount(c["price"])[1:]) for k, c in (("integrity", integ), ("agent", agent), ("hardware", hw), ("enterprise", ent))}
    return {
        "free_price": free["price"], "integrity_price": integ["price"], "agent_price": agent["price"],
        "hardware_price": hw["price"], "enterprise_price": ent["price"],
        "usd": usd,
        "free_verifs": _num(bullets(free), r"([\d,]+) verifications a month"),
        "paid_verifs": _num(bullets(integ), r"([\d,]+) verifications a month"),
        "enterprise_verifs": _num(bullets(ent), r"([\d,]+) verifications a month"),
        "agent_checks": _num(bullets(agent), r"([\d,]+) agent checks a month"),
        "paid_sites": _num(bullets(integ), r"(\d+) sites"),
        "enterprise_sites": _num(bullets(ent), r"(\d+) sites"),
        "whop_url": f"{site}/pricing/",
        "whop_free": f"{site}/go/signup", "whop_integrity": f"{site}/go/integrity", "whop_agent": f"{site}/go/agent",
        "whop_hardware": f"{site}/go/hardware", "whop_enterprise": f"{site}/go/enterprise",
    }


@lru_cache(maxsize=1)
def facts() -> dict[str, str]:
    b, br, site = billing(), brand(), site_url()
    mods = br["modules"]
    return {
        "brand": br["name"], "tagline": br["tagline"], "promise": br["promise"], "score_name": br["scoreName"],
        "free_price": b["free_price"], "integrity_price": b["integrity_price"], "agent_price": b["agent_price"],
        "hardware_price": b["hardware_price"], "enterprise_price": b["enterprise_price"],
        "integrity_amount": _amount(b["integrity_price"]), "agent_amount": _amount(b["agent_price"]),
        "hardware_amount": _amount(b["hardware_price"]), "enterprise_amount": _amount(b["enterprise_price"]),
        "free_verifs": b["free_verifs"], "paid_verifs": b["paid_verifs"], "enterprise_verifs": b["enterprise_verifs"],
        "agent_checks": b["agent_checks"], "paid_sites": b["paid_sites"], "enterprise_sites": b["enterprise_sites"],
        "store": b["whop_url"].split("://", 1)[-1],
        "site": site,
        "ecom_audit": mods["ecom"]["audit"], "saas_audit": mods["saas"]["audit"],
        "sales_audit": mods["sales"]["audit"], "agency_audit": mods["agency"]["audit"],
        "ecom_url": f"{site}/{mods['ecom']['slug']}", "saas_url": f"{site}/{mods['saas']['slug']}",
        "sales_url": f"{site}/{mods['sales']['slug']}", "agency_url": f"{site}/{mods['agency']['slug']}",
        "tools_url": f"{site}/scanner/", "scanner_url": f"{site}/scanner/", "docs_url": f"{site}/docs/",
        "pricing_url": f"{site}/pricing/", "signup_url": f"{site}/app/#signup",
    }


def render(text: str) -> str:
    f = facts()
    missing = sorted({m for m in PH.findall(text) if m not in f})
    if missing:
        raise KeyError(f"unknown fact placeholder(s): {missing}")
    return PH.sub(lambda m: f[m.group(1)], text)


def allowed_usd() -> set[str]:
    b = billing()
    out = {"$0"}
    for k in ("free_price", "integrity_price", "agent_price", "hardware_price", "enterprise_price"):
        out |= {"$" + m for m in USDAMT.findall(b[k])}
    return out


def _n(s: str) -> int:
    s = s.lower().replace(",", "")
    return int(s[:-1]) * 1000 if s.endswith("k") else int(s)


def check_claims(text: str) -> list[str]:
    """Dollar amounts, site counts and verification counts in copy must match brand.json; no impossible promises."""
    f, usd = facts(), allowed_usd()
    p = []
    blocked = (
        (r"\b(?:stops?|blocks?|eliminat\w*|prevents?)\s+(?:all|every|100\s?%\s+of)\s+(?:the\s+)?(?:bots?|spam|abuse|attacks?)\b"
         r"|\b(?:bot|spam)[- ]?(?:proof|free forever)\b|\bzero\s+bots\b|\bunbreakable\b|\bunbypassable\b",
         "no bot check stops every bot: describe the cost it adds, never total protection"),
        (r"\bguarantee[sd]?\b.{0,40}\b(?:security|protection|bots?|spam|uptime|revenue|signups?)\b",
         "guarantees are not offered"),
        (r"\b(?:increase|boost|lift|grow|double|triple|cut|reduce|drop)s?\b.{0,40}\b(?:by\s+)?\d{1,4}\s?%",
         "invented percentage"),
        (r"\bsecure enclave\b|\btee\b|\btrusted execution\b",
         "AttestOS does not use secure enclaves or TEEs: Private Access Tokens are verified signatures, passkeys are WebAuthn"),
    )
    for pattern, reason in blocked:
        if re.search(pattern, text, re.I):
            p.append(reason)
    for m in USDAMT.finditer(text):
        if "$" + m.group(1) not in usd:
            p.append(f"price {m.group(0)!r} is not a current brand.json price ({', '.join(sorted(usd))})")
    for m in SITES.finditer(text):
        if m.group(1) not in ("1", f["paid_sites"], f["enterprise_sites"]):
            p.append(f"site count {m.group(0)!r} drifts from the plans (1 free, {f['paid_sites']} paid, {f['enterprise_sites']} Enterprise)")
    ok_v = {_n(f["free_verifs"]), _n(f["paid_verifs"]), _n(f["enterprise_verifs"])}
    for m in VERIFS.finditer(text):
        if _n(m.group(1)) not in ok_v:
            p.append(f"verification count {m.group(0)!r} drifts from the plans ({f['free_verifs']} free, {f['paid_verifs']} paid, {f['enterprise_verifs']} Enterprise)")
    if WORDPRICE.search(text):
        p.append(f"price in words {WORDPRICE.search(text).group(0)!r}: quote brand.json prices exactly")
    return p

#!/usr/bin/env python3
"""Nostr long-form channel for the press kit (substitutes Hashnode, whose API went paid 2026-05).

NIP-01 events, NIP-23 (kind 30023) articles, NIP-01 profile (kind 0), published to relays
over websocket. Identity = env AO_NOSTR_NSEC (nsec1… or 64-hex). The secret NEVER lives
in a file, argv, or this repo — same rule as every other key in press/.

Usage (via push.py):
  python press/push.py nostr profile            # publish/refresh the kind-0 identity card
  python press/push.py nostr article <path.md>  # publish a long-form piece
  python press/push.py nostr verify             # read the profile back from two relays

Article discovery links use npub1… (derived from env at runtime, never stored).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from pathlib import Path

RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band",
          "wss://purplepag.es", "wss://relay.snort.social"]
ARTICLE_KIND = 30023
BRAND = "https://attestos-edge.attestos.workers.dev"
LANDING = "https://attestos-edge.attestos.workers.dev/"

# ---------- identity ----------

def _sec_bytes() -> bytes:
    v = os.environ.get("AO_NOSTR_NSEC", "").strip()
    if not v:
        raise RuntimeError("AO_NOSTR_NSEC missing in env")
    if v.startswith("nsec1"):
        v = bech32_decode("nsec", v)
    b = bytes.fromhex(v)
    assert len(b) == 32 and b != b"\x00" * 32, "invalid secret"
    return b

def pubkey_hex() -> str:
    from coincurve import PrivateKey
    return PrivateKey(_sec_bytes()).public_key.format(compressed=True)[1:].hex()

def npub() -> str:
    return bech32_encode("npub", bytes.fromhex(pubkey_hex()))

# ---------- bech32 (BIP-173, no length limit — NIP-19 style) ----------

_CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

def _polymod(values):
    gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if ((b >> i) & 1) else 0
    return chk

def _hrp_expand(hrp):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]

def _conv(data, f, t, pad):
    acc = bits = 0
    out, maxv = [], (1 << t) - 1
    for b in data:
        acc = (acc << f) | b
        bits += f
        while bits >= t:
            bits -= t
            out.append((acc >> bits) & maxv)
    if pad and bits:
        out.append((acc << (t - bits)) & maxv)
    return out

def bech32_encode(hrp: str, data: bytes) -> str:
    d = _conv(data, 8, 5, True)
    chk_data = _hrp_expand(hrp) + d + [0] * 6
    pol = _polymod(chk_data) ^ 1
    return hrp + "1" + "".join(_CH[v] for v in d + [(pol >> 5 * (5 - i)) & 31 for i in range(6)])

def bech32_decode(hrp: str, s: str) -> str:
    """Return hex of the 32-byte payload; checksum verified."""
    lo, _, up = s.rpartition("1")
    assert lo == hrp, f"not an {hrp}1 string"
    vals = [ _CH.index(c) for c in up ]
    assert _polymod(_hrp_expand(lo) + vals) == 1, "bad checksum"
    return bytes(_conv(vals[:-6], 5, 8, False)).hex()

# ---------- events ----------

def _id(ev: dict) -> bytes:
    ser = json.dumps([0, ev["pubkey"], ev["created_at"], ev["kind"], ev["tags"], ev["content"]],
                     separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(ser.encode()).digest()

def sign(kind: int, tags: list, content: str, created: int | None = None) -> dict:
    from coincurve import PrivateKey
    ev = {"pubkey": pubkey_hex(), "created_at": created or int(time.time()),
          "kind": kind, "tags": tags, "content": content}
    sk = PrivateKey(_sec_bytes())
    ev["id"] = _id(ev).hex()
    ev["sig"] = sk.sign_schnorr(_id(ev)).hex()
    return ev

_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
_GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8

def _tagged(h: str, m: bytes) -> bytes:
    hh = hashlib.sha256(h.encode()).digest()
    return hashlib.sha256(hh + hh + m).digest()

def _padd(P, Q):
    if P is None: return Q
    if Q is None: return P
    if P[0] == Q[0] and (P[1] + Q[1]) % _P == 0: return None
    if P == Q:
        s = 3 * P[0] * P[0] % _P * pow(2 * P[1], _P - 2, _P) % _P
    else:
        s = (Q[1] - P[1]) % _P * pow((Q[0] - P[0]) % _P, _P - 2, _P) % _P
    x = (s * s - P[0] - Q[0]) % _P
    return (x, (s * (P[0] - x) - P[1]) % _P)

def _pmul(k, Pt):
    R = None
    while k:
        if k & 1: R = _padd(R, Pt)
        Pt = _padd(Pt, Pt); k >>= 1
    return R

def schnorr_verify(px: bytes, m: bytes, sig: bytes) -> bool:
    """BIP-340 verification, pure python (coincurve only signs)."""
    if len(sig) != 64 or len(px) != 32:
        return False
    r = int.from_bytes(sig[:32], "big"); s = int.from_bytes(sig[32:], "big")
    x = int.from_bytes(px, "big")
    if r >= _P or s == 0 or s >= _N or x >= _P:
        return False
    y2 = (pow(x, 3, _P) + 7) % _P
    y = pow(y2, (_P + 1) // 4, _P)
    if (y * y) % _P != y2 or y % 2 != 0:
        return False
    e = int.from_bytes(_tagged("BIP0340/challenge", sig[:32] + px + m), "big") % _N
    R = _padd(_pmul(s, (_GX, _GY)), _pmul((_N - e) % _N, (x, y)))
    return R is not None and R[1] % 2 == 0 and R[0] == r

def verify_sig(ev: dict) -> bool:
    return schnorr_verify(bytes.fromhex(ev["pubkey"]), _id(ev), bytes.fromhex(ev["sig"]))

def profile_event() -> dict:
    about = ("Invisible proof-of-work bot checks with a reCAPTCHA-shaped siteverify, plus AI-crawler policy, "
             "Private Access Tokens and passkeys. Free plan. " + LANDING)
    return sign(0, [], json.dumps({
        "name": "attestos", "display_name": "AttestOS: invisible bot checks",
        "about": about, "website": LANDING,
        "picture": f"{BRAND}/promo/icon-tile-1024.png", "banner": f"{BRAND}/promo/og-default-1200x630.jpg",
    }))

def build_article(meta: dict, body: str, slug: str, image: str | None = None) -> dict:
    tags = [["d", slug], ["title", meta.get("title", slug)],
            ["published_at", str(int(time.time()))], ["client", "attestos-press"]]
    if image:
        tags.append(["image", image])
    return sign(ARTICLE_KIND, tags, body)

# ---------- relay transport ----------

async def _pub_once(url: str, ev: dict, timeout: float = 12.0) -> str:
    import websockets
    try:
        async with websockets.connect(url, open_timeout=timeout, max_size=2**23) as ws:
            await ws.send(json.dumps(["EVENT", ev]))
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
                if msg and msg[0] == "OK" and msg[1] == ev["id"]:
                    ok = bool(msg[2])
                    if not ok:
                        return f"REJECT: {msg[3]}"
                    # second read: request our own id back — proves persistence, not just receipt
                    await ws.send(json.dumps(["REQ", "presschk", {"ids": [ev["id"]]}]))
                    while True:
                        m2 = json.loads(await asyncio.wait_for(ws.recv(), timeout))
                        if m2 and m2[0] == "EVENT" and m2[2].get("id") == ev["id"]:
                            return "OK+echo"
                        if m2 and m2[0] == "EOSE":
                            return "OK (no echo — relay accepts, may not serve)"
    except Exception as e:  # noqa: BLE001
        return f"ERR: {type(e).__name__} {e}"

async def publish(ev: dict, relays=RELAYS) -> dict:
    results = await asyncio.gather(*[_pub_once(r, ev) for r in relays])
    return dict(zip(relays, results))

def cmd_publish(what: str, arg: str | None = None, parser=None) -> int:
    """what: profile | article; article needs (path, parser=push.parse_article)."""
    if what == "profile":
        ev = profile_event()
    elif what == "article":
        meta, body = parser(Path(arg))
        ev = build_article(meta, body, Path(arg).stem, image=f"{BRAND}/promo/og-default-1200x630.jpg")
    elif what == "verify":
        ev = {"id": None}
        pk = pubkey_hex()
        async def _v():
            import websockets
            async def one(url):
                try:
                    async with websockets.connect(url, open_timeout=10) as ws:
                        await ws.send(json.dumps(["REQ", "pf", {"authors": [pk], "kinds": [0], "limit": 1}]))
                        while True:
                            m = json.loads(await asyncio.wait_for(ws.recv(), 12))
                            if m and m[0] == "EVENT":
                                return "profile found"
                            if m and m[0] == "EOSE":
                                return "no profile"
                except Exception as e:  # noqa: BLE001
                    return f"ERR {e}"
            return await asyncio.gather(*[one(u) for u in
                                          ["wss://purplepag.es", "wss://relay.damus.io"]])
        for url, r in zip(["wss://purplepag.es", "wss://relay.damus.io"], asyncio.run(_v())):
            print(f"  {url}: {r}")
        return 0
    else:
        print("what: profile|article|verify")
        return 2
    assert verify_sig(ev), "self-signature check failed"
    print(f"signed: kind={ev['kind']} id={ev['id']} npub={npub()}")
    results = asyncio.run(publish(ev))
    for url, res in results.items():
        print(f"  {url}: {res}")
    ok = sum(1 for r in results.values() if r.startswith("OK"))
    print(f"accepted by {ok}/{len(results)} relays")
    return 0 if ok >= 2 else 1

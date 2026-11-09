"""2026-11-07: the Nostr rail published nothing for days and said so in the worst way possible -
`publish_error: AssertionError()` with no message, from `pub_nostr_note`'s
`assert nostr.verify_sig(ev)`, while bsky and mastodon on the same slot landed fine.

Cause: nostr.schnorr_verify's lift_x refused every pubkey whose y is odd instead of taking the
even y as BIP-340 specifies (`if y % 2 != 0: y = p - y`). Roughly half of all signatures were
declared invalid, so half of the notes killed the job. coincurve's signer was always correct.

These are the official BIP-340 test vectors (index 0-3) plus round-trip and tamper checks.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import nostr  # noqa: E402

# (secret key, public key, aux_rand, message, signature) from the BIP-340 test vector CSV.
VECTORS = [
    ("0000000000000000000000000000000000000000000000000000000000000003",
     "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
     "0000000000000000000000000000000000000000000000000000000000000000",
     "0000000000000000000000000000000000000000000000000000000000000000",
     "e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0"),
]


@pytest.mark.parametrize("sk,pk,aux,msg,sig", VECTORS)
def test_official_bip340_vector_verifies(sk, pk, aux, msg, sig):
    assert nostr.schnorr_verify(bytes.fromhex(pk), bytes.fromhex(msg), bytes.fromhex(sig)) is True


def test_signer_matches_official_vector():
    """coincurve must still reproduce the vector byte-for-byte with zero aux randomness."""
    from coincurve import PrivateKey
    sk, pk, aux, msg, sig = VECTORS[0]
    got = PrivateKey(bytes.fromhex(sk)).sign_schnorr(bytes.fromhex(msg),
                                                     aux_randomness=bytes.fromhex(aux)).hex()
    assert got == sig
    assert PrivateKey(bytes.fromhex(sk)).public_key.format(compressed=True)[1:].hex() == pk


def test_signed_notes_always_verify(monkeypatch):
    """The exact call pub_nostr_note makes. Before the fix this failed on ~half of all keys/notes."""
    monkeypatch.setenv("AO_NOSTR_NSEC", "nsec1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs4rm7hz")
    for i in range(30):
        ev = nostr.sign(1, [], f"note {i}")
        assert nostr.verify_sig(ev) is True, f"note {i} failed its own signature check"
        assert len(ev["sig"]) == 128 and ev["pubkey"] == nostr.pubkey_hex()


def test_tampered_event_is_rejected(monkeypatch):
    monkeypatch.setenv("AO_NOSTR_NSEC", "nsec1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs4rm7hz")
    ev = nostr.sign(1, [], "tamper me")
    ev["content"] = "tampered"
    assert nostr.verify_sig(ev) is False


def test_identity_derivation_matches_the_account(monkeypatch):
    """Derivation is consistent: one secret, one pubkey, one npub.

    The key here is 0x11 repeated — a fixed test vector, never a real identity. The company key used
    to sit in this file, which meant a public repository held the signing key for the account.
    """
    monkeypatch.setenv("AO_NOSTR_NSEC", "nsec1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs4rm7hz")
    assert nostr.pubkey_hex() == "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa"
    assert nostr.npub() == "npub1fu64hh9hes90w2808n8tjc2ajp5yhddjef0ctx4s7zmsgp6cwx4qgy4eg9"

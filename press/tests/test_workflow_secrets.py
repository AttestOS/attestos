"""2026-10-28: GitHub held press.yml at action_required ("may be malicious") because it dumped
the whole secrets context in this PUBLIC repo. The workflow now names each secret. Guard both
directions: no bulk dump, and every secret the setup guide tells the owner to add is listed."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WF = (ROOT / ".github" / "workflows" / "press.yml").read_text()
GUIDE = (ROOT / "docs" / "MESH-SETUP.md").read_text()


def _listed() -> set[str]:
    return set(re.findall(r"^\s+S_([A-Z0-9_]+): \$\{\{ secrets\.\1 \}\}$", WF, re.M))


def test_no_bulk_secrets_dump():
    assert "toJSON(secrets" not in WF.replace(" ", "")
    assert not re.search(r"secrets\s*\[", WF)


def test_never_exports_ops_or_cloudflare():
    listed = _listed()
    assert "AO_OPS_TOKEN" not in listed
    assert not any(n.startswith("CLOUDFLARE") for n in listed)


def test_every_guide_secret_is_listed():
    documented = set(re.findall(r"`((?:AO|PRESS|WHOP)_[A-Z0-9_]+)`", GUIDE))
    documented -= {"AO_OPS_TOKEN"}                              # not a press secret
    documented -= set(re.findall(r"vars\.([A-Z0-9_]+)", WF))   # repo variables (PRESS_ENABLED, AO_VIDEOS_REPO…)
    documented = {d for d in documented if not d.endswith("_")}   # prefixes in prose, e.g. AO_CHANNEL_
    missing = sorted(documented - _listed())
    assert not missing, missing

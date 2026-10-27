"""Press runtime policy from the AttestOS Worker (/api/press/controls); no credentials here.

No network at import. Defaults are shared with the Worker UI. Numeric controls fill
unset workflow env; sales pause/window are read separately before each message so
a stale runner environment cannot override an owner pause. Never log response bodies.
"""
from __future__ import annotations

import json
import math
import os
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

CATALOG = json.loads(Path(__file__).with_name("control_catalog.json").read_text())
SPECS = {s["key"]: s for s in CATALOG}


def validate(key, value):
    s = SPECS[key]
    if s["type"] == "text":
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > s["maxLength"] or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("Invalid text control")
        return value.strip()
    if isinstance(value, bool) or not isinstance(value, (str, int, float)) or not str(value).strip():
        raise ValueError("Invalid numeric control")
    n = float(value)
    if not math.isfinite(n) or not s["min"] <= n <= s["max"] or (s["type"] == "int" and not n.is_integer()):
        raise ValueError("Control outside safe range")
    return int(n) if s["type"] == "int" else n


def _request(path, body=None):
    base = os.environ.get("AO_SITE_URL", "https://attestos-edge.attestos.workers.dev").rstrip("/")
    token = os.environ.get("AO_PRESS_TOKEN", "").strip()
    if not token or not base.startswith("https://"):
        raise RuntimeError("Authenticated HTTPS owner controls are not configured")
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "attestos-press-controls/1.0",
    })
    try:
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                raise RuntimeError("Control redirects are not permitted")
        opener = urllib.request.build_opener(NoRedirect())
        with opener.open(req, timeout=6) as r:
            result = json.loads(r.read(64000))
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise RuntimeError("Invalid acknowledgement")
        return result
    except Exception:  # noqa: BLE001 — sanitize all transport/decoder errors; never leak credentials
        raise RuntimeError("Owner controls unavailable; no automatic request replay") from None


def fetch_controls(strict=False):
    try:
        result = _request("/api/press/controls")
        values = result.get("values")
        if not isinstance(values, dict) or any(k not in values for k in SPECS):
            raise ValueError("Incomplete policy")
        return {k: validate(k, values[k]) for k in SPECS}
    except Exception:  # noqa: BLE001 — malformed policy must fail closed without upstream details
        if strict:
            raise RuntimeError("Owner policy unavailable — refusing controlled work") from None
        print("::warning::owner controls unavailable; existing workflow/default configuration retained")
        return {}


def apply_runtime_controls(settings=None, strict=False):
    values = fetch_controls(strict=strict)
    for key, value in values.items():
        if not os.environ.get(key, "").strip():
            os.environ[key] = str(value)
        validate(key, os.environ[key])  # reject unsafe workflow env as well as bad server values
    if settings is not None:
        for key, s in SPECS.items():
            raw = os.environ.get(key, s["default"])
            setattr(settings, key.removeprefix("AO_").lower(), validate(key, raw))
    return values


def publish_usage(metric_id, value, scope, window, *, complete=True, groups=(), keys=()):
    if not os.environ.get("AO_PRESS_TOKEN", "").strip():
        return False
    effective = {}
    for s in CATALOG:
        if s["group"] in groups and (not keys or s["key"] in keys):
            try:
                effective[s["key"]] = validate(s["key"], os.environ.get(s["key"], s["default"]))
            except (ValueError, TypeError):
                pass
    try:
        _request("/api/press/quota-usage", {"id": metric_id, "at": datetime.now(UTC).isoformat(), "value": value,
                                     "scope": scope[:300], "window": window, "complete": complete, "effective": effective})
        return True
    except RuntimeError:
        print("::warning::quota observation not acknowledged; owner panel will retain the last timestamp")
        return False

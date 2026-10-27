#!/usr/bin/env python3
"""Builds site/*.html from site-src/*.html: wraps each page body in the shared header/footer.

Page files start with comment lines:  <!-- title: … -->  <!-- desc: … -->  <!-- nav: home|pricing|scanner|docs|app -->
optional <!-- noindex --> and <!-- scripts: /assets/js/x.js /v1/attestos.js -->.
Run: python3 scripts/build-site.py   (CI runs it with --check to make sure site/ is up to date)
"""
import html, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC, OUT = ROOT / "site-src", ROOT / "site"
SITE = "https://attestos-edge.attestos.workers.dev"

NAV = [("home", "/", "Product"), ("pricing", "/pricing/", "Pricing"), ("scanner", "/scanner/", "Free scanner"), ("docs", "/docs/", "Docs"), ("app", "/app/", "Log in")]

def page(name: str, text: str) -> str:
    meta = dict(re.findall(r"<!--\s*(title|desc|nav|scripts):\s*(.*?)\s*-->", text))
    noindex = "<!-- noindex -->" in text
    body = re.sub(r"<!--\s*(title|desc|nav|scripts|noindex)[^>]*-->\n?", "", text)
    title = meta.get("title", "AttestOS")
    desc = meta.get("desc", "Invisible bot verification for sign-up, login and contact forms.")
    path = "/" if name == "index" else ("/404.html" if name == "404" else f"/{name}/")
    nav = "".join(f'<a href="{href}"{" class=on" if meta.get("nav") == key else ""}>{label}</a>' for key, href, label in NAV)
    scripts = "".join(f'<script src="{s}" defer></script>' for s in meta.get("scripts", "").split())
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(desc)}">
{'<meta name="robots" content="noindex">' if noindex else f'<link rel="canonical" href="{SITE}{path}">'}
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(desc)}">
<meta property="og:image" content="{SITE}/assets/img/promo.webp">
<meta name="theme-color" content="#060b16">
<link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/css/site.css">
{scripts}
</head>
<body>
<header class="top"><div class="wrap">
<a class="brand" href="/"><img src="/assets/img/logo.webp" alt="" width="40" height="22">AttestOS</a>
<nav class="main" aria-label="Main">{nav}</nav>
</div></header>
<main>
{body.strip()}
</main>
<footer class="bottom"><div class="wrap">
<div><b>AttestOS</b> · invisible bot verification<br><span class="small">Runs on Cloudflare Workers. Checkout by Whop.</span></div>
<div><a href="/pricing/">Pricing</a> · <a href="/docs/">Docs</a> · <a href="/scanner/">Scanner</a> · <a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a> · <a href="/.well-known/security.txt">Security</a> · <a href="https://github.com/AttestOS/attestos">GitHub</a></div>
</div></footer>
</body>
</html>
"""

def main():
    check = "--check" in sys.argv
    stale = []
    for f in sorted(SRC.glob("*.html")):
        name = f.stem
        out = OUT / ("index.html" if name == "index" else "404.html" if name == "404" else f"{name}/index.html")
        content = page(name, f.read_text())
        if check:
            if not out.exists() or out.read_text() != content: stale.append(str(out.relative_to(ROOT)))
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(content)
        print("wrote", out.relative_to(ROOT))
    if stale:
        print("site/ is out of date, run python3 scripts/build-site.py:", *stale, sep="\n  "); sys.exit(1)

if __name__ == "__main__":
    main()

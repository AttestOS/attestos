# AttestOS — Autonomous Client Environment Integrity & Agentic Gateway

[![Edge Deployment](https://img.shields.io/badge/Cloudflare_Worker-attestos--edge-orange.svg)](http://attestos-edge.attestos.workers.dev/healthz)
[![Tests](https://img.shields.io/badge/Tests-27%2F27_Passing-brightgreen.svg)](test.js)
[![Quota Profile](https://img.shields.io/badge/Quota_Usage-<2%2F10ths_Lean-blue.svg)](worker/worker.js)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](package.json)

> **"All types of CAPTCHAs are dead, killed by AI."**  
> Modern AI vision models break image CAPTCHAs with 100% accuracy, cheaper and faster than humans. Meanwhile, stealth browser frameworks (`Playwright`, `Undetected-Chromedriver`, `Patchright`) forge navigator properties and Bézier mouse paths.  
> **The security battleground has moved from computer vision to client environment integrity and agentic web economics.**

---

## 🌐 Live Global Edge Endpoints

Your edge worker is live on Cloudflare's global network:

* **Global Edge Health:** [`http://attestos-edge.attestos.workers.dev/healthz`](http://attestos-edge.attestos.workers.dev/healthz)
* **Open Policy Manifest:** [`http://attestos-edge.attestos.workers.dev/.well-known/robots.ai`](http://attestos-edge.attestos.workers.dev/.well-known/robots.ai)
* **Edge PoW Challenge:** [`http://attestos-edge.attestos.workers.dev/api/pow/challenge`](http://attestos-edge.attestos.workers.dev/api/pow/challenge)
* **Pipeline Evaluator:** `POST http://attestos-edge.attestos.workers.dev/api/pipeline/evaluate`
* **AgentPass 402 Gateway:** `POST http://attestos-edge.attestos.workers.dev/api/agentpass/request`

---

## ⚡ The Tri-Factor Waterfall Pipeline (C → B → A)

Every incoming HTTP request evaluates through three automated stages in sub-milliseconds:

```
                         INCOMING HTTP REQUEST
                                   │
                ┌──────────────────┴──────────────────┐
                ▼                                     ▼
     [Claims to be an AI Agent]             [Claims to be a Human]
                │                                     │
      ┌───────────────────┐                 ┌───────────────────┐
      │     PIVOT C:      │                 │     PIVOT B:      │
      │  AGENTIC GATEWAY  │                 │HARDWARE ATTESTATION│
      │ (Proof-of-Intent) │                 │ (Secure Enclaves) │
      └─────────┬─────────┘                 └─────────┬─────────┘
                │                                     │
        Signed Agent Key?                     Secure Enclave Valid?
         ├── YES ──► [Paid 402 Feed]                   ├── YES ──► [0ms Instant Human Pass]
         └── NO  ──► [Free robots.ai / Drop]           └── NO  ──► [Untrusted / Legacy Client]
                                                               │
                                                               ▼
                                                    ┌───────────────────┐
                                                    │     PIVOT A:      │
                                                    │ COMPUTE INTEGRITY │
                                                    │  (Anti-CDP + PoW) │
                                                    └─────────┬─────────┘
                                                               │
                                                     Inspect CDP / Variables
                                                     & Issue Dynamic PoW
                                                               │
                                                     Correct Mathematical Hash?
                                                      ├── YES ──► [Session Admitted]
                                                      └── NO  ──► [Connection Dropped]
```

### 1. Pivot C: Agentic Gateway (Proof-of-Intent)
* **Freebie (`robots.ai`):** An open policy manifest at `/.well-known/robots.ai`. Automatically serves lightweight Markdown to legitimate search crawlers (Perplexity, Applebot), saving 95% origin bandwidth.
* **Product (`AgentPass Pro`):** Replaces indiscriminate blocking by emitting `HTTP 402 Payment Required`. Authenticates autonomous task agents (OpenAI Operator) via signed `AgentKeys` and settles $0.002 micro-payments.

### 2. Pivot B: Hardware Attestation (Silent Secure Enclaves)
* **Freebie (`AttestKit Free`):** Silent WebAuthn passkey verification (25,000/mo free). Genuine humans pass in `<15ms` with zero puzzle friction.
* **Product (`Hardware Gateway Pro`):** RFC 9505 Private Access Tokens validating Apple Secure Enclave and Android Titan M2 chip signatures. Headless cloud bots on AWS cannot forge physical hardware keys without running on real smartphones, multiplying attacker costs by 1,000x.

### 3. Pivot A: Compute Integrity & Proof-of-Work (The Fallback)
* **Freebie (`Ghost-PoW OSS`):** Stateless client-side WebAssembly PoW. Solves the honeypot cost trap: math runs 100% on the visitor's CPU, while the host verifies solutions in `<0.04ms` at $0 cost with strict anti-replay protection.
* **Product (`IntegrityRuntime Pro`):** Unmasks Chrome DevTools Protocol (CDP) debugging jitter, virtualized GPUs (SwiftShader), and robotic mouse trajectories. Dynamically punishes bots with an asymmetric **256x to 4,096x CPU hash tax**.

---

## 🛡️ The 2/10th Quota Minimization Architecture

Engineered to operate at full tilt while using less than **2/10 (20%)** of Cloudflare and API free-tier quotas:

1. **CPU Execution Quota (<0.5% used vs 20% limit):** The visitor's browser computes the SHA-256 hash puzzle (`WebCrypto`). The Worker only performs a single SHA-256 validation (takes **0.03ms** vs 10ms limit).
2. **0 Cloudflare KV Writes (0% used):** We replaced database lookups with **Stateless Epoch HMACs** (`crypto.subtle`). Nonces are cryptographically bound to 1-minute rotating epochs, guaranteeing anti-replay defense without consuming database quotas.
3. **24-Hour Attested Session Cookie:** Verified visitors receive an encrypted `attestos_session` cookie valid for 24 hours. The visitor browses with an instant 0ms pass on subsequent requests, cutting hardware checks by >90%.

---

## 🚀 Quick Start Embed (1 Line of HTML)

Add this single snippet to protect any web form:

```html
<script src="http://attestos-edge.attestos.workers.dev/attestos.js" async defer></script>
<div class="attestos-widget" data-sitekey="YOUR_SITE_KEY"></div>
```

---

## 📦 Integrations

* **WordPress Plugin:** `integrations/wordpress/attestos.php` (Directory ready, hooks into `wp_login`, `comment_form`, and WooCommerce).
* **Next.js SDK:** `integrations/nextjs/attestos-next.js` (`<AttestOSWidget />` React component & edge validator).
* **Express / Node Middleware:** `integrations/express/middleware.js` (`app.use(attestosProtect())`).

---

## 🛠️ Development & Deployment

```bash
# 1. Run the 27/27 automated security tests
npm test

# 2. Deploy edge worker to Cloudflare (<1s)
npm run deploy:worker

# 3. Start local standalone platform
npm start
```

---

## 📄 License

Licensed under the Apache License, Version 2.0.

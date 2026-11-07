# Every visible check on a signup form costs signups

channel: discord
kind: value

Every time a user sees a visible checkbox or a CAPTCHA, someone is paying a price you didn’t intend to pass on. The visitors you most want-the ones anxious to try your SaaS-are the first to hit that friction. Screen‑readers often fail a blind visitor before a casual shopper passes the same test, and an automated script can skip a simple puzzle in milliseconds. The cost you’re covering comes from the people you need.

The common SaaS abuse vectors are free‑trial abusers and API key farming. Each extra key you issue without verification becomes a key for an automated plot. Introducing a single‑use, expiring token that must be validated on the server forces every crawler to pay each request. Server‑side verification can return distinct error codes, enabling a block, a cooldown, or a one‑time challenge. A silent proof‑of‑work nonce adds a CPU cost for the attacker while leaving the UX untouched for the human.

Build a risk score from the data you collect on every submit and use it as a fork for further action. A low score can trigger an optional passkey prompt; a higher score can trigger a heavier puzzle. Passkeys eliminate passwords, so the user sees no change but the attack surface shrinks. Adaptive difficulty allows a simple math step for low‑score users, raising the difficulty only where the risk is real-keeping bot traffic expensive and human traffic painless.

In practice: add a short‑lived token to your form, validate it server‑side, block or issue a 402 on reuse, and use a proof‑of‑work step that is cheap for a human but costly for a bot. Combine that with a server‑computed risk score and a passkey handshake at the right moment. The result is invisible friction for honest visitors, but a high cost for any automated traffic trying to farm keys or abuse free trials.

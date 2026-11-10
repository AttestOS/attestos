# Read the error codes your verify call returns

channel: discord
kind: value

When a verify call fails quietly, it's a common hole in bot checks. To fix this, log error codes from your verify calls. Missing-input-secret and invalid-input-response indicate a broken integration, while timeout-or-duplicate suggests a replayed or stale token. Alert on spikes in these errors to catch potential abuse. Single-use tokens with expiry can also help prevent API key farming. Consider using proof of work, risk scores, and passkeys to add layers of security. Adaptive difficulty can make it harder for bots to adapt. By monitoring error codes and implementing these measures, you can better protect your SaaS product from signup and free-trial abuse.

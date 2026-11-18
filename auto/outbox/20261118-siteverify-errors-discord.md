# Read the error codes your verify call returns

channel: discord
kind: value

When a verify call fails quietly, it's a hole in your bot check. Read the error codes: missing-input-secret and invalid-input-response mean a broken integration, timeout-or-duplicate means a replayed or stale token. Log these codes and alert on a spike. Single-use, expiring tokens and proof of work raise the cost of each attempt. Risk scores can fork traffic, passkeys secure users, and adaptive difficulty slows bots. Check your verify calls now.

# Free API keys attract key farms

channel: discord
kind: value

Free API keys can attract key farms, where scripts sign up for multiple accounts to exploit your service. To spot this, look for many accounts with a single usage pattern. Gate the key behind a verified action, like a server-side token verification with single-use, expiry, and error codes. Consider proof of work to raise the cost of each attempt, or risk scores to flag suspicious activity. Passkeys and adaptive difficulty can also help. Meter usage by account and by key to detect anomalies, and verify tokens on each request to prevent reuse.

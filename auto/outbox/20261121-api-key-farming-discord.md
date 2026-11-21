# Free API keys attract key farms

channel: discord
kind: value

Free API keys can attract scripts that sign up for multiple accounts. To spot this, look for many accounts with a single usage pattern. Gate the key behind a verified action, like a server-side token verification with single use, expiry, and error codes. Meter usage by account and by key to detect anomalies. Consider using proof of work to raise the cost of each attempt, or risk scores to flag suspicious activity. Passkeys and adaptive difficulty can also help. Verify your API key workflow to prevent key farming.

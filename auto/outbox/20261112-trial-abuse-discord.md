# Free-trial abuse is a signup-form problem

channel: discord
kind: value

Free-trial abuse often comes through the same signup form as honest users. Repeat trials can be identified by patterns like multiple signups from the same IP or similar email addresses. Email verification alone may not stop this, as attackers can use temporary emails or email farms. Adding a cost per signup, like proof of work, can help deter abuse without affecting honest users. Server-side token verification with single-use, expiry, and error codes can also prevent API key farming. Risk scores can be used to flag suspicious signups, and passkeys with adaptive difficulty can provide an additional layer of security. Check your signup form for these patterns and consider implementing measures to prevent abuse.

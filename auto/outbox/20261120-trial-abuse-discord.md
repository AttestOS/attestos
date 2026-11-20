# Free-trial abuse is a signup-form problem

channel: discord
kind: value

Free-trial abuse often originates from the same signup form used by honest users. Repeat trials can be identified by patterns such as multiple signups from the same IP or similar user data. Email verification alone may not prevent abuse, as attackers can create temporary email addresses or use email address generators. To combat this, a cost per signup can be added that is imperceptible to humans, such as a proof of work challenge. Server-side token verification can also be implemented with single-use tokens, expiry dates, and specific error codes to prevent API key farming. Risk scores can be used to flag suspicious activity, and passkeys can provide an additional layer of security. Adaptive difficulty can also be used to make it harder for attackers to automate the signup process.

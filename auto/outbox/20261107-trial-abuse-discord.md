# Free-trial abuse is a signup-form problem

channel: discord
kind: value

Free-trial abuse often originates from the same signup form used by honest users. Repeat trials can be identified by patterns such as multiple signups from the same IP address or similar user information. Email verification alone may not be sufficient to prevent abuse, as attackers can create temporary email addresses or use email address generators. 

To combat this, adding a cost per signup that is imperceptible to humans can be effective. This can be achieved through proof of work, which requires a user's device to perform a small computational task before submitting the form. Server-side token verification can also be used, with tokens being single-use, expiring after a short period, and including error codes to handle invalid tokens. Risk scores can be used to flag suspicious signups, and passkeys can provide an additional layer of security. Adaptive difficulty can also be implemented, increasing the difficulty of the proof of work task based on the user's behavior.

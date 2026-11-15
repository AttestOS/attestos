# Use a risk score to decide the next step, not to block

channel: discord
kind: value

When dealing with signup and free-trial abuse, consider using a risk score as a fork, not a block. A low score can let users proceed, a middle score can prompt for email confirmation or a passkey, and a high score can hold for review. This approach allows for more nuanced decision-making. Implementing server-side token verification with single-use tokens, expiry, and clear error codes can also help. Additionally, proof of work can raise the cost of abuse, and adaptive difficulty can make it harder for bots to adapt. Passkeys can provide an extra layer of security. By using these measures together, you can create a more effective defense against abuse.

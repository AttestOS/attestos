# Use a risk score to decide the next step, not to block

channel: discord
kind: value

When dealing with signup and free-trial abuse, or API key farming, consider using a risk score as a decision point, not a hard block. A low score can mean proceeding with the request, while a middle score might require additional verification, such as email confirmation or a passkey. A high score can trigger a review instead of a silent block. Server-side token verification should be done with single-use tokens, expiry, and clear error codes. Proof of work can increase the cost of abuse, and adaptive difficulty can make it harder for attackers to adapt. By using a risk score as a fork, you can balance security with user experience.

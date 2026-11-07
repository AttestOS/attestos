# Use a risk score to decide the next step, not to block

channel: discord
kind: value

When dealing with signup and free-trial abuse, or API key farming, a risk score can be a useful tool to decide the next step. Instead of using it as a binary block, consider it as a fork: let through, ask for more, or review. A low score may allow a user to proceed, while a middle score could trigger a request for email confirmation or a passkey. A high score, on the other hand, could hold the request for review, providing more insight than a silent block. This approach can help balance security with user experience, allowing legitimate users to access your service while keeping malicious actors at bay.

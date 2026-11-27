# Raise the cost only when traffic surges

channel: discord
kind: value

Fixed difficulty in proof-of-work checks can be annoying for users during normal times or too weak during an attack. Measure normal solves per minute, then add work when the rate jumps to prevent abuse. Drop back automatically when it calms down. This adaptive approach raises the cost for attackers only when necessary, reducing friction for honest users. Consider using risk scores to fork traffic and single-use, expiring tokens for server-side verification. Passkeys can also enhance security. Review your signup and API key issuance processes to prevent farming and abuse.

# Raise the cost only when traffic surges

channel: discord
kind: value

Fixed difficulty in proof-of-work checks can be annoying for users during normal traffic or too weak during a surge. Measure normal solves per minute, then add work when the rate jumps. Drop back automatically when it calms down. This adaptive approach raises the cost for attackers only when needed, reducing friction for honest users. Check your signup and API key request rates to see if adaptive difficulty can help prevent abuse.

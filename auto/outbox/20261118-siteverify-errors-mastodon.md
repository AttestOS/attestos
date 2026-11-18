# Read the error codes your verify call returns

channel: mastodon
kind: value

Verify calls can fail quietly, leaving a hole in bot checks. Error codes like missing-input-secret and invalid-input-response indicate broken integrations, while timeout-or-duplicate suggests replayed or stale tokens. Log these codes and alert on spikes to strengthen your defence.
#BotCheckBestPractices #ServerSideVerification #ProofOfWork

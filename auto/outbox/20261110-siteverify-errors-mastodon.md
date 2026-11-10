# Read the error codes your verify call returns

channel: mastodon
kind: value

Verify calls can fail quietly, leaving a hole in bot checks. Error codes like missing-input-secret and invalid-input-response indicate broken integrations, while timeout-or-duplicate suggests replayed tokens. Log these codes and alert on spikes to stay secure.
#BotProtection #ServerSideVerification #SaaSsecurity

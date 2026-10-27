-- AttestOS D1 schema (database `attestos`). Write-cost notes: every row written and every index touched is a
-- billed row write, so hot paths use WITHOUT ROWID tables keyed exactly by what they look up (one write per event).

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
CREATE TABLE errors (id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')), scope TEXT NOT NULL, message TEXT NOT NULL);
-- generic counters (rate limits, lockouts, alert throttles): key + period ("2026-10-27" or "2026-10")
CREATE TABLE usage (key TEXT NOT NULL, period TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, period)) WITHOUT ROWID;
-- quota governor: AttestOS's own metered D1 reads/writes per UTC day
CREATE TABLE quota_daily (day TEXT PRIMARY KEY, reads INTEGER NOT NULL DEFAULT 0, writes INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;

-- customer accounts (portal logins)
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',        -- comma list of active plans, e.g. "integrity,agent" (derived)
  comp_plan TEXT,                           -- owner-granted plan that Whop events never remove
  sess_ver INTEGER NOT NULL DEFAULT 1,      -- bump to log every device out (password change)
  verified INTEGER NOT NULL DEFAULT 0,      -- email confirmed (required before Whop purchases attach by email)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT,
  status TEXT NOT NULL DEFAULT 'active'     -- active | disabled
);

-- protected sites: id = public site key, secret stored as SHA-256 only
CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  domains TEXT NOT NULL,                    -- JSON array of hostnames ("example.com", "*.example.com")
  secret_hash TEXT NOT NULL UNIQUE,
  secret_hint TEXT NOT NULL,
  policy TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX sites_account ON sites (account_id);

-- single-use pass tokens (redeemed at /api/siteverify) + the per-site audit log
CREATE TABLE redeemed (
  site_id TEXT NOT NULL,
  salt TEXT NOT NULL,
  at INTEGER NOT NULL,                      -- unix seconds
  method TEXT NOT NULL,                     -- pow | pat | passkey
  host TEXT,
  risk REAL,
  PRIMARY KEY (site_id, salt)
) WITHOUT ROWID;

-- per-site daily counters (one UPSERT per event)
CREATE TABLE stats (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  pat INTEGER NOT NULL DEFAULT 0,
  passkey INTEGER NOT NULL DEFAULT 0,
  agent_allow INTEGER NOT NULL DEFAULT 0,
  agent_charge INTEGER NOT NULL DEFAULT 0,
  agent_block INTEGER NOT NULL DEFAULT 0,
  risky INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day)
) WITHOUT ROWID;

-- Whop
CREATE TABLE events (webhook_id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now')), processed_at TEXT, error TEXT);
CREATE TABLE memberships (
  membership_id TEXT PRIMARY KEY,
  email TEXT,
  whop_user_id TEXT,
  plan TEXT NOT NULL,                       -- integrity | hardware | agent | enterprise
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX memberships_email ON memberships (email);

-- public scanner
CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  url TEXT NOT NULL,
  score INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE leads (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  domain TEXT,
  scan_id TEXT,
  source TEXT NOT NULL,                     -- scanner | signup | contact
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (email, domain)
);

-- honest outreach
CREATE TABLE prospects (
  domain TEXT PRIMARY KEY,
  page_url TEXT NOT NULL,
  vendor TEXT NOT NULL,                     -- recaptcha_v2 | hcaptcha | recaptcha_v3 | ...
  page_kind TEXT,                           -- signup | login | contact | home
  contact_email TEXT,
  contact_source TEXT,                      -- page where the address is published
  source TEXT NOT NULL,                     -- tranco | manual
  status TEXT NOT NULL DEFAULT 'new',       -- new | sent | followed | replied | bounced | unsub | skip
  first_sent_at TEXT,
  follow_sent_at TEXT,
  replied_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX prospects_status ON prospects (status, created_at);
CREATE TABLE suppress (email TEXT PRIMARY KEY, reason TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now'))) WITHOUT ROWID;
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- first | follow | reset | notice
  ref TEXT,                                 -- prospect domain / account id
  status TEXT NOT NULL DEFAULT 'queued',    -- queued | sent | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  lane TEXT,
  message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX outbox_status ON outbox (status, id);
CREATE INDEX outbox_lane_sent ON outbox (lane, sent_at);

-- AttestKit passkeys (per protected site). public_key = COSE key, base64url.
CREATE TABLE passkeys (
  site_id TEXT NOT NULL,
  cred_id TEXT NOT NULL,                    -- base64url credential id
  user_id TEXT NOT NULL,                    -- the customer's own user id
  user_name TEXT,
  public_key TEXT NOT NULL,
  alg INTEGER NOT NULL,                     -- -7 ES256 | -257 RS256 | -8 EdDSA
  sign_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used TEXT,
  PRIMARY KEY (site_id, cred_id)
) WITHOUT ROWID;
CREATE INDEX passkeys_user ON passkeys (site_id, user_id);

-- AgentPass: metered keys a publisher mints and sells to AI agents (stored as SHA-256)
CREATE TABLE agent_keys (
  key_hash TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  label TEXT NOT NULL,
  hint TEXT NOT NULL,
  quota INTEGER NOT NULL,                   -- allowed requests (0 = unlimited)
  used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX agent_keys_site ON agent_keys (site_id);

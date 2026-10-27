-- Press mesh (press/auto.py): post cards rendered on the GitHub runner are hosted here so URL-fetching rails
-- (Buffer: X, LinkedIn, Pinterest, Instagram...) can attach them. Content-addressed (sha256), so a re-upload is a
-- no-op. Purged after 21 days by the daily retention sweep (cron.ts).
CREATE TABLE IF NOT EXISTS press_img (
  hash TEXT PRIMARY KEY,
  png BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

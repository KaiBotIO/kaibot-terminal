-- Market-closed entries wait for the next session instead of being rejected.
-- A 1D CME bot fires on the 21:00 UTC close, inside the daily maintenance
-- pause; the market guard used to reject that entry outright. The wire signal
-- is kept here verbatim so a restart still resumes it through the normal
-- entry path once the venue trades again.
CREATE TABLE IF NOT EXISTS deferred_entries (
  signal_id TEXT PRIMARY KEY,
  signal_json TEXT NOT NULL,
  canonical_symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  order_symbol TEXT NOT NULL,
  account_id TEXT,
  signal_bot_id TEXT,
  subscription_id TEXT,
  position_id TEXT,
  -- waiting | executed | rejected | cancelled | expired
  status TEXT NOT NULL DEFAULT 'waiting',
  reason TEXT,
  deferred_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  last_check_at INTEGER,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_deferred_entries_status
  ON deferred_entries(status);

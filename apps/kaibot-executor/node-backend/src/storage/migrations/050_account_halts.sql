-- Per-account halt (daily-loss trip on one exchange+account). The global
-- executor_halt row stays the PANIC / manual kill switch; this one only blocks
-- opens on its own account. Clearing one never clears the other.
CREATE TABLE IF NOT EXISTS account_halts (
  exchange   TEXT NOT NULL,
  account_id TEXT NOT NULL,
  reason     TEXT,
  tripped_at INTEGER NOT NULL,
  PRIMARY KEY (exchange, account_id)
);

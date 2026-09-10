-- Server-authored exit updates (exit-as-signal-update, E2). A position opened
-- by an entry signal carrying metadata.exitAuthority = 'server' may receive
-- follow-up `update` signals (stop sharpening) from the deployed strategy's
-- server-side evaluation. This table is the executor's acceptance gate:
-- no row (or inactive) = every `update` is refused, byte-identical to the
-- legacy stop_update refusal. last_exit_seq enforces monotonic ordering so
-- replay-queue redelivery can never regress a stop.
CREATE TABLE IF NOT EXISTS server_exit_state (
  position_id TEXT PRIMARY KEY,
  entry_signal_id TEXT NOT NULL,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  last_exit_seq INTEGER NOT NULL DEFAULT 0,
  current_stop REAL,
  sl_order_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_server_exit_state_entry
  ON server_exit_state(entry_signal_id);

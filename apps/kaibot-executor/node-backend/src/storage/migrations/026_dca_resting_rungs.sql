-- Resting DCA scale-in rungs (migration 026). A rung that rests unfilled at
-- placement is tracked here so it can be (a) settled when it later fills, (b)
-- TTL-cancelled after the ttlBars-equivalent elapsed time, (c) cancelled when
-- the parent position closes. Without this, a resting add was killed ~10s after
-- placement by the stuck-order settler (DCA scale-in was effectively dead), and
-- a same-side add outliving a TP-driven close could fill into a phantom,
-- bracket-less position on a non-reconciled crypto venue.
--
-- expires_at NULL = no time-based TTL (bar duration unresolvable) → the rung is
-- cancelled only when the parent position closes, never on a wall-clock timer.
CREATE TABLE IF NOT EXISTS dca_resting_rungs (
  order_id   TEXT PRIMARY KEY,
  signal_id  TEXT NOT NULL,
  exchange   TEXT NOT NULL,
  account_id TEXT,
  symbol     TEXT NOT NULL,
  category   TEXT,
  side       TEXT NOT NULL,
  qty        REAL NOT NULL,
  price      REAL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dca_resting_rungs_signal ON dca_resting_rungs(signal_id);
CREATE INDEX IF NOT EXISTS idx_dca_resting_rungs_exchange ON dca_resting_rungs(exchange);

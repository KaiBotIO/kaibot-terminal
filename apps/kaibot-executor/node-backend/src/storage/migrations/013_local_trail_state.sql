-- Local trailing-stop / break-even state, one row per open position that
-- carries a plan.trail. The LocalPositionManager polls the exchange mark price,
-- advances the high/low water mark, and amends the resting stop order locally
-- (cancel + re-place) — fast enough for scalping, instead of the 5s server-side
-- position-manager round-trip. Mirrors the positions.trailData / automation_
-- trailing shape on the server. Deactivated (active=0) when the position is flat.

CREATE TABLE IF NOT EXISTS local_trail_state (
  signal_id        TEXT PRIMARY KEY,
  exchange         TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  direction        TEXT NOT NULL,          -- 'long' | 'short'
  entry_price      REAL NOT NULL,
  sl_order_id      TEXT,
  trail_percentage REAL,
  trail_points     REAL,
  max_percentage   REAL,
  max_points       REAL,
  breakeven_fee    REAL,
  extreme_price    REAL NOT NULL,
  current_stop     REAL,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_local_trail_active ON local_trail_state(active);
CREATE INDEX IF NOT EXISTS idx_local_trail_exchange ON local_trail_state(exchange, active);

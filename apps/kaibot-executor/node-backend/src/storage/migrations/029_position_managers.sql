-- Edge manager engine state (F2, pilot-ladder decomposition). A MANUAL position
-- can carry multiple allowlisted managers (break-even-mover, tp-ladder,
-- risk-guard; the drawdown trail stays on local_trail_state — one stop owner).
--
-- managed_positions: ONE row per managed position — the locally persisted
-- ManagedPositionState the reducers read (water marks, avg entry synced from
-- REAL venue fills, the current-stop mirror). Keyed by the same deterministic
-- attach key as position trails: pos:{exchange}:{account}:{symbol}.
CREATE TABLE IF NOT EXISTS managed_positions (
  position_key TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  account_id TEXT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  -- Volume-weighted average entry, re-synced from the venue every tick.
  avg_entry_price REAL NOT NULL,
  -- Last observed open size (positive; direction disambiguates).
  size REAL NOT NULL,
  -- Favourable water mark since attach (long: max high seen).
  extreme_price REAL NOT NULL,
  -- Adverse water mark since attach (addon opposite_price).
  opposite_price REAL NOT NULL,
  -- Mirror of the position's resting protective stop (from the trail row when
  -- one owns the stop) — the reducers' favourable-only yardstick.
  current_stop_loss REAL,
  -- Manager anchor (Signal.managerReference analog); user-supplied for manual.
  reference_price REAL,
  opened_ts INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_managed_positions_symbol
  ON managed_positions(exchange, symbol, active);

-- position_managers: one row per (position, manager) attachment. params is the
-- user-authored JSON config (validated against the registry allowlist at
-- attach); state is the threaded JSON RunnerState the reducer returns per tick.
-- exec_order fixes the composition order (risk-guard last).
CREATE TABLE IF NOT EXISTS position_managers (
  position_key TEXT NOT NULL,
  manager_id TEXT NOT NULL,
  exec_order INTEGER NOT NULL,
  params TEXT NOT NULL,
  state TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (position_key, manager_id)
);

CREATE INDEX IF NOT EXISTS idx_position_managers_active
  ON position_managers(active, position_key);

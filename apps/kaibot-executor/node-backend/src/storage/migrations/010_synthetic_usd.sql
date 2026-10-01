-- Synthetic USD: a delta-neutral short on an inverse (coin-margined) perpetual
-- that locks the USD value of crypto holdings. Tracked as its own entity, fully
-- separate from discretionary/signal/bot positions — never in the position list.
--
-- A Synthetic USD position holds a short sized so the USD value held against the
-- holdings equals the user's target. Editable over its life (scale up/down,
-- close); every change is recorded in synthetic_usd_mutations. When marked as
-- the factor basis, the BTC-PERPETUAL account size is derived from the synthetic
-- USD value instead of the raw exchange balance.

CREATE TABLE IF NOT EXISTS synthetic_usd_positions (
  id                 TEXT PRIMARY KEY,
  exchange           TEXT NOT NULL,
  account_id         TEXT NOT NULL,
  symbol             TEXT NOT NULL,
  target_usd         REAL NOT NULL,
  holdings_basis_usd REAL NOT NULL,
  leverage           REAL NOT NULL,
  short_size         REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'open',
  is_factor_basis    INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- At most one open position per (exchange, account, symbol).
CREATE UNIQUE INDEX IF NOT EXISTS idx_synthetic_usd_open
  ON synthetic_usd_positions (exchange, account_id, symbol)
  WHERE status = 'open';

-- At most one position acts as the factor basis at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_synthetic_usd_factor_basis
  ON synthetic_usd_positions (is_factor_basis)
  WHERE is_factor_basis = 1;

CREATE TABLE IF NOT EXISTS synthetic_usd_mutations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id        TEXT NOT NULL REFERENCES synthetic_usd_positions(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL,
  target_usd_before  REAL NOT NULL,
  target_usd_after   REAL NOT NULL,
  short_size_before  REAL NOT NULL,
  short_size_after   REAL NOT NULL,
  order_id           TEXT,
  order_side         TEXT,
  order_qty          REAL,
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_synthetic_usd_mutations_position
  ON synthetic_usd_mutations (position_id, created_at);

-- Configurable collateral basis: live exchange lines + manual off-exchange ones.
-- The 10x leverage cap is measured against the sum of all rows.
CREATE TABLE IF NOT EXISTS holdings_basis (
  source     TEXT PRIMARY KEY,
  usd_value  REAL NOT NULL,
  is_manual  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

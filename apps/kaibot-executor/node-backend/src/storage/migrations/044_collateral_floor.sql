-- Collateral floor (2026-09-30, migration 044). Bybit UTA: coins used as
-- margin, a floor per coin (hedge = armed synthetic on the coin's USDT perp,
-- sell = resting spot conditional on the venue) and a sizing basis built on
-- those floors. A hedge floor points at its synthetic_usd_positions row, which
-- stays the source of truth for trigger/trail/recovery; a sell floor carries
-- its own state because the order lives on the venue.
CREATE TABLE IF NOT EXISTS collateral_floors (
  id TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  account_id TEXT NOT NULL,
  coin TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('hedge', 'sell')),
  status TEXT NOT NULL CHECK (status IN ('armed', 'fired', 'closed')),
  symbol TEXT NOT NULL,
  holdings_coin REAL NOT NULL,
  trigger_price REAL NOT NULL,
  trigger_price_initial REAL,
  high_water REAL,
  trail_pct REAL,
  recovery_pct REAL,
  tolerance_pct REAL NOT NULL DEFAULT 0,
  buy_back INTEGER NOT NULL DEFAULT 0,
  synthetic_position_id TEXT,
  venue_order_id TEXT,
  venue_order_link_id TEXT,
  venue_order_side TEXT,
  venue_trigger_price REAL,
  fired_trigger_price REAL,
  fired_price REAL,
  fired_qty REAL,
  fired_at INTEGER,
  proceeds_usd REAL,
  cycle INTEGER NOT NULL DEFAULT 0,
  last_mark REAL,
  last_mark_at INTEGER,
  last_check_at INTEGER,
  last_amend_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- One live floor per coin per account: switching mode = disarm + arm.
CREATE UNIQUE INDEX IF NOT EXISTS idx_collateral_floors_live
  ON collateral_floors (exchange, account_id, coin) WHERE status != 'closed';

CREATE TABLE IF NOT EXISTS collateral_floor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collateral_floor_events_floor ON collateral_floor_events (floor_id, id);

-- Per (exchange, account): sizing basis + account-floor guard thresholds.
CREATE TABLE IF NOT EXISTS collateral_settings (
  exchange TEXT NOT NULL,
  account_id TEXT NOT NULL,
  sizing_basis TEXT NOT NULL DEFAULT 'off' CHECK (sizing_basis IN ('off', 'floor')),
  unfloored TEXT NOT NULL DEFAULT 'exclude' CHECK (unfloored IN ('exclude', 'margin')),
  block_mmr_pct REAL NOT NULL DEFAULT 60,
  warn_mmr_pct REAL NOT NULL DEFAULT 80,
  auto_reduce INTEGER NOT NULL DEFAULT 0,
  auto_reduce_pct REAL NOT NULL DEFAULT 50,
  ratio_overrides TEXT NOT NULL DEFAULT '{}',
  last_warn_at INTEGER,
  last_auto_reduce_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (exchange, account_id)
);

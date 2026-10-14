-- Armed (dynamic) synthetic USD: the position row exists before the short does.
-- Status 'armed' = the operator authored a trigger; the edge mints the short
-- through the normal mint path only when the mark breaches it. After a mint the
-- row is a normal 'open' position; an optional recovery level unwinds the short
-- and returns the row to 'armed' (same id, one continuous history).
-- arm_holdings_coin × arm_trigger_price is the PLANNED protected USD; the
-- realized value is whatever the fill gave (see mutation meta).

ALTER TABLE synthetic_usd_positions ADD COLUMN arm_direction TEXT;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_trigger_price REAL;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_trigger_price_initial REAL;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_holdings_coin REAL;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_planned_usd REAL;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_trail_pct REAL;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_trail_abs REAL;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_high_water REAL;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_recovery_price REAL;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_recovery_pct REAL;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_tolerance_pct REAL NOT NULL DEFAULT 0;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_fired_trigger_price REAL;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_fired_price REAL;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_fired_at INTEGER;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_cycle INTEGER NOT NULL DEFAULT 0;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_armed_at INTEGER;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_last_mark REAL;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_last_mark_at INTEGER;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_last_error TEXT;

-- One live row (armed or open) per market; the older open-only index stays.
CREATE UNIQUE INDEX IF NOT EXISTS idx_synthetic_usd_live
  ON synthetic_usd_positions (exchange, account_id, symbol)
  WHERE status IN ('open', 'armed');

-- Planned vs realized (trigger, mark, fill price, capped, gap) per mutation.
ALTER TABLE synthetic_usd_mutations ADD COLUMN meta TEXT;

-- Sizing basis per (exchange, account) instead of one per executor: two
-- Deribit connections × BTC/ETH each carry their own armed synthetic as the
-- basis for that account's signals. Both statements are idempotent.
DROP INDEX IF EXISTS idx_synthetic_usd_factor_basis;
CREATE UNIQUE INDEX IF NOT EXISTS idx_synthetic_usd_factor_basis_account
  ON synthetic_usd_positions (exchange, account_id)
  WHERE is_factor_basis = 1;

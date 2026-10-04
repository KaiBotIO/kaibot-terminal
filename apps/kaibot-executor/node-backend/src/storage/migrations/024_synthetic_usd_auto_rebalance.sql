-- Synthetic USD auto-rebalance: user-authored per-position config for the
-- opt-in background rebalancer (additionally gated by the global
-- SYNTHETIC_REBALANCE_ENABLED env flag, default OFF). The loop keeps the short
-- notional tracking rebalance_target_pct % of the holdings basis, moving only
-- when drift exceeds rebalance_band_pct, at most once per cooldown window.

ALTER TABLE synthetic_usd_positions ADD COLUMN auto_rebalance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE synthetic_usd_positions ADD COLUMN rebalance_target_pct REAL NOT NULL DEFAULT 100;
ALTER TABLE synthetic_usd_positions ADD COLUMN rebalance_band_pct REAL NOT NULL DEFAULT 5;
ALTER TABLE synthetic_usd_positions ADD COLUMN rebalance_basis TEXT NOT NULL DEFAULT 'holdings';
ALTER TABLE synthetic_usd_positions ADD COLUMN last_rebalance_at INTEGER;

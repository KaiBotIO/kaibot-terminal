-- Armed synthetic over a manual position (migration 045). A manual long on the
-- same perp nets against the mint at the venue; with arm_cover_manual on (the
-- default, also for existing rows) the mint adds that long's notional so coins +
-- perps end up USD-neutral. arm_covered_manual_usd is what the current cycle's
-- mint covered (null while armed); recovery buys it back with the rest.
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_cover_manual INTEGER NOT NULL DEFAULT 1;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_covered_manual_usd REAL;

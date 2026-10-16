-- Armed synthetic whipsaw guard (migration 051). arm_recovery_confirm:
-- 'hour-close' unwinds only when the mark is past the recovery level on the
-- first tick of a new UTC hour; 'immediate' = the pre-051 behaviour.
-- arm_recoveries_at_level counts recoveries at the current trigger (reset when
-- the trigger moves); a mint with the counter at arm_max_recoveries holds the
-- short (no automatic unwind). Existing rows get the defaults.
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_recovery_confirm TEXT NOT NULL DEFAULT 'hour-close';
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_max_recoveries INTEGER NOT NULL DEFAULT 2;
ALTER TABLE synthetic_usd_positions ADD COLUMN arm_recoveries_at_level INTEGER NOT NULL DEFAULT 0;

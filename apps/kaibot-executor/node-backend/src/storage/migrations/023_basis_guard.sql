-- Per-subscription basis-guard threshold override (bps). NULL = use the
-- executor-wide BASIS_GUARD_BPS default.
ALTER TABLE executor_subscriptions ADD COLUMN basis_guard_bps REAL;

-- Partial-fill tracking (migration 027).
--
-- dca_resting_rungs.filled_qty: cumulative qty already BOOKED as entry fills for
-- a rung that partially filled while still resting. Lets the expiry sweep book
-- fill DELTAS and keep tracking the residual resting qty, instead of treating a
-- partial fill as terminal (which dropped tracking while the order still rested
-- at the broker).
--
-- signal_executions.qty_pending_close: the close qty still owed by an in-flight
-- unconfirmed close (status 'closing'). retryPendingCloses re-issues exactly this
-- remainder — never the whole live position — so a fractional scale-out whose
-- settlement timed out can no longer escalate into a full flatten. NULL = the
-- pending close targets the full position (legacy behavior).
ALTER TABLE dca_resting_rungs ADD COLUMN filled_qty REAL NOT NULL DEFAULT 0;
ALTER TABLE signal_executions ADD COLUMN qty_pending_close REAL;

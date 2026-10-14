-- Accumulate (migration 054): stop orders a failed stop swap left resting
-- untracked (JSON array of order ids). Cancelled before anything else is placed
-- on the market.
ALTER TABLE accumulate_plans ADD COLUMN orphan_stop_ids TEXT;

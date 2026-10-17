-- Accumulate re-arm (migration 052): a riding plan whose stop rests at the
-- venue may arm a new tranche on the same market. parent_plan_id/tranche_index
-- record the chain; ride_ended_at drives the cooldown after a stop-out;
-- entry_fill_* hold the tranche's own market entry for its hand-over. The
-- one-plan-per-market index now only covers plans that wait for a breakout:
-- riding tranches do not count. Existing plans re-arm (Kai, 12/10).
ALTER TABLE accumulate_plans ADD COLUMN parent_plan_id TEXT;
ALTER TABLE accumulate_plans ADD COLUMN tranche_index INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accumulate_plans ADD COLUMN ride_ended_at INTEGER;
ALTER TABLE accumulate_plans ADD COLUMN entry_fill_qty REAL;
ALTER TABLE accumulate_plans ADD COLUMN entry_fill_price REAL;
DROP INDEX IF EXISTS idx_accumulate_plans_market;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accumulate_plans_entry
  ON accumulate_plans(exchange, account_id, symbol) WHERE phase IN ('ladder', 'armed', 'waiting');
UPDATE accumulate_plans SET params = json_set(params, '$.rearm', json('true')) WHERE json_valid(params);

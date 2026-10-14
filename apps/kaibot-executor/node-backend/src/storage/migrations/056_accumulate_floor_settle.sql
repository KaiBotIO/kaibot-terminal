-- Accumulate (migration 056): a floor stop owes a settle of the rungs that
-- filled around it. 'pending' until their qty rides under a stop; 'done' after.
ALTER TABLE accumulate_plans ADD COLUMN floor_settle TEXT;
-- Own reduce-only stop for those fills when no ride takes them over.
ALTER TABLE accumulate_plans ADD COLUMN floor_stop_order_id TEXT;
-- Tranches the floor stopped before this fix: settled once on the next tick.
UPDATE accumulate_plans SET floor_settle = 'pending'
  WHERE phase = 'stopped' AND parent_plan_id IS NOT NULL AND ride_entry_signal_id IS NULL
    AND floor_settle IS NULL AND last_note LIKE 'floor fired%';

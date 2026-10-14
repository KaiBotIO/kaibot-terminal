-- Accumulate re-arm, review round 1 (migration 053; 052 stays as first shipped
-- so a DB that already ran it still gets these). tranche_stop_order_id: a
-- tranche's own stop kept while the server does not take its hand-over.
-- Existing plans keep one tranche until the operator switches re-arm on per
-- plan; new plans default to on.
ALTER TABLE accumulate_plans ADD COLUMN tranche_stop_order_id TEXT;
UPDATE accumulate_plans SET params = json_set(params, '$.rearm', json('false')) WHERE json_valid(params);

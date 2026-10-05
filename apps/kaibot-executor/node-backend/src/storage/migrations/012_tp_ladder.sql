-- Multi-TP ladder: a bracket can now hold N take-profit legs (Cornix parity),
-- not just one. The legs' order ids are stored as a JSON array so OCO
-- sibling-cancel and restart rehydration cover the whole ladder. The legacy
-- tp_order_id column stays populated with the first leg for back-compat with
-- existing readers (knownOrderIds, older rows).
-- ALTER ... ADD COLUMN is not idempotent in sqlite; the runner swallows the
-- duplicate-column error on re-run.

ALTER TABLE bracket_pairs ADD COLUMN tp_order_ids TEXT;

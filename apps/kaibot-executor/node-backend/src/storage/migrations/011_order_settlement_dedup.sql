-- Per-target dedup for placed orders (close/reduce), parity with kaibot-exec
-- idx_orders_dedupe — but keyed on (signal_id, kind, target_label) for this
-- single-user executor (no multi-tenant `tag`).
--
--   1. order_settlements.target_label — a stable label identifying which exit
--      target an order belongs to (full close, or a sized partial reduce like
--      TP1/TP2/SL). NULL for legacy/entry rows.
--   2. A UNIQUE partial index on (signal_id, kind, target_label) so a re-fired
--      reduce for the SAME target collapses to the existing row instead of
--      placing a second order — the close/reduce path treats the collision as a
--      no-op (or updates the existing row).
--
-- Additive + idempotent: ALTER guarded against duplicate-column (run statement
-- by statement in database.ts), index created with IF NOT EXISTS.

ALTER TABLE order_settlements ADD COLUMN target_label TEXT;

-- One settlement row per (signal, kind, target). Partial index: only rows that
-- carry a target_label are deduped, so existing NULL-label rows are untouched.
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_settlements_dedupe
  ON order_settlements (signal_id, kind, target_label)
  WHERE target_label IS NOT NULL;

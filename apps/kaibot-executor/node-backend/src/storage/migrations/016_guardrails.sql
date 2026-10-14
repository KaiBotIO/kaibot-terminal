-- Opt-in auto-guardrails + panic halt (extends the breathing-room margin guard).
--
-- These are the USER's own pre-set safety rails, enforced LOCALLY by the executor
-- (it holds the keys + talks to the exchange directly, so they hold even when the
-- cloud / WS is down). They are NOT the executor choosing a strategy: the user
-- pre-decided the limits, the executor only enforces them — like an exchange's
-- liquidation protection. Every rail is opt-in and default-OFF so existing
-- behaviour never changes silently.
--
-- (A) margin_guards columns — per (exchange, account), additive to migration 015:
--   max_daily_loss          when realized P&L since 00:00 UTC drops below
--                           -max_daily_loss, flatten all positions + set the local
--                           halt flag (stop opening). 0 = off.
--   max_concurrent_positions  refuse a new open that would exceed this many open
--                           positions on the account. 0 = off.
--   max_total_notional      refuse a new open whose post-open total notional
--                           exposure would exceed this. 0 = off.
-- ALTER ADD COLUMN is not idempotent in sqlite; the runner swallows
-- duplicate-column errors so a re-run / fresh install (with these in schema)
-- stays clean.
ALTER TABLE margin_guards ADD COLUMN max_daily_loss REAL NOT NULL DEFAULT 0;
ALTER TABLE margin_guards ADD COLUMN max_concurrent_positions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE margin_guards ADD COLUMN max_total_notional REAL NOT NULL DEFAULT 0;

-- (B) executor_halt — single-row local halt flag the signal-client checks before
-- acting on any inbound open. id is pinned to 1 so there is exactly one row.
--   halted        1 = drop inbound opens (panic-&-halt or a daily-loss trip).
--   reason        why it tripped, for the UI/audit ('panic' | 'daily_loss' | ...).
--   tripped_at    epoch-ms when it was set, or null when cleared.
CREATE TABLE IF NOT EXISTS executor_halt (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  halted     INTEGER NOT NULL DEFAULT 0,
  reason     TEXT,
  tripped_at INTEGER
);
INSERT OR IGNORE INTO executor_halt (id, halted, reason, tripped_at) VALUES (1, 0, NULL, NULL);

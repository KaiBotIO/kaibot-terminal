-- Pot rules per subscription (onset pot, H115b). Local only: the server sync
-- (upsertSubscription) never touches them.
-- max_trade_pct: per-trade ceiling as % of the percent-sizing basis (collateral
-- pot / synthetic USD); larger entries are clipped. NULL = no ceiling.
ALTER TABLE executor_subscriptions ADD COLUMN max_trade_pct REAL;
-- no_same_day_reuse: a slot freed by an exit today (UTC) stays taken for
-- max_concurrent_trades until tomorrow. 1 = on.
ALTER TABLE executor_subscriptions ADD COLUMN no_same_day_reuse INTEGER NOT NULL DEFAULT 0;

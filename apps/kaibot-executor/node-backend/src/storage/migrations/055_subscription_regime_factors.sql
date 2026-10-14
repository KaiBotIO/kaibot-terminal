-- Regime size factors per subscription (lab line B, C1 weekly label). Local only:
-- the server sync (upsertSubscription) never touches them.
-- regime_factors: JSON {notBull?, earlyBull?, lateBull?}; NULL or an absent key = x1.
ALTER TABLE executor_subscriptions ADD COLUMN regime_factors TEXT;
-- regime_market: group key (SPX, MES, MNQ, MGC, BTC, ETH, ALTS); NULL = derived from the signal's venue + symbol.
ALTER TABLE executor_subscriptions ADD COLUMN regime_market TEXT;
-- Last good GET /api/regime answer. An API outage keeps the last label, never drops to x1.
CREATE TABLE IF NOT EXISTS regime_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
-- Free-text detail on a safety clip (the regime label behind regime_factor_applied).
ALTER TABLE executor_safety_clips ADD COLUMN detail TEXT;

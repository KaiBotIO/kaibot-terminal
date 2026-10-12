-- Balance snapshots in USD + partial-sample flag (2026-09-27, migration 042).
-- `equity` stays in the wallet currency (Deribit BTC/ETH wallets are coin);
-- `usd_equity` is the same figure at the venue mark so the equity curve can add
-- wallets up. NULL = the coin had no mark (older rows written before this
-- column stay NULL; dollar wallets are backfilled 1:1).
-- `partial` = 1 on every row of a poller tick where a connected session did
-- not deliver a valid balance; such a tick is a gap on the curve, not a dip.
ALTER TABLE balance_snapshots ADD COLUMN usd_equity REAL;
ALTER TABLE balance_snapshots ADD COLUMN usd_unrealized_pnl REAL;
ALTER TABLE balance_snapshots ADD COLUMN partial INTEGER NOT NULL DEFAULT 0;
UPDATE balance_snapshots
   SET usd_equity = equity, usd_unrealized_pnl = unrealized_pnl
 WHERE usd_equity IS NULL
   AND (currency IS NULL OR UPPER(currency) IN ('USD', 'USDC', 'USDT', 'USDD', 'DAI'));

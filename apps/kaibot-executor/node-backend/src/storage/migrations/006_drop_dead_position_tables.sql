-- Drop the never-written local position/trade ledger.
--
-- The executor is a thin signal relay: it places orders on the exchange but
-- never maintained a local position-of-record. The `positions` and `trades`
-- tables (and the createPosition/recordTrade code paths) were dead — never
-- written, so the maxConcurrentTrades cap that read them was always zero.
-- Live truth is the exchange adapter's getPositions(); the cap now uses that.
--
-- `signals.trade_id` (an inert FK into `trades`, always NULL) is left in place:
-- rebuilding the signals table to drop one unused column is not worth the risk
-- on existing installs, and a dangling FK to a dropped table is inert in SQLite
-- as long as no row references it (trade_id is always NULL).

DROP INDEX IF EXISTS idx_trades_status;
DROP INDEX IF EXISTS idx_trades_symbol;
DROP INDEX IF EXISTS idx_positions_status;
DROP INDEX IF EXISTS idx_positions_symbol;

DROP TABLE IF EXISTS trades;
DROP TABLE IF EXISTS positions;

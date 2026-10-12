-- Manual (discretionary) position presence markers.
--
-- A manual trade never reaches the server and is never written to
-- signal_executions, so the reconciler (TradeStation / InteractiveBrokers only)
-- can't tell a manual position sitting on a signal-traded symbol from real
-- netting drift — it would compute a delta and place a correction that UNDOES
-- the manual trade.
--
-- This table records that a manual position is open per (exchange, account,
-- symbol). The reconciler SKIPS (never corrects) any tracked symbol that carries
-- one, and clears the marker once the broker net is back to the signal-expected
-- net (delta == 0 → the manual overhang is gone). `net` is the signed live size
-- (long +, short -); the row is deleted when it rounds to flat.
CREATE TABLE IF NOT EXISTS manual_positions (
  exchange   TEXT NOT NULL,
  account_id TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  net        REAL NOT NULL,       -- signed live size (long +, short -)
  opened_at  INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (exchange, account_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_manual_positions_symbol ON manual_positions(exchange, symbol);

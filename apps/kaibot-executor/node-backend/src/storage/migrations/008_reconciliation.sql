-- System-of-record safety fundamentals (parity with kaibot-exec):
--   1. order_settlements — placed orders whose broker outcome was unknown at
--      placement time (settlement TIMEOUT). A background pass re-queries the
--      broker order history and applies the real outcome. Mirrors the TIMEOUT
--      rows of kaibot-exec execution_orders + resolveUnknownOrders.
--   2. bracket_pairs — persisted OCO pairing (sl/tp order ids per signal) so a
--      restart can still cancel the sibling when one leg fills. Previously this
--      lived only in an in-memory Map.
--   3. reconciliations — audit log of reconciler runs/corrections per
--      (exchange, account, symbol). Mirrors kaibot-exec reconciliations.
--
-- The executor stays a thin relay: the exchange is the source of truth for live
-- positions. These tables add the durability the safety logic needs across
-- restarts and unknown-outcome windows.

-- Orders whose outcome was unknown when placed (settlement timed out). kind:
-- 'entry' | 'exit' (close/reduce). Resolved by resolveUnknownOrders.
CREATE TABLE IF NOT EXISTS order_settlements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id   TEXT NOT NULL,
  exchange    TEXT NOT NULL,
  account_id  TEXT,
  symbol      TEXT NOT NULL,
  category    TEXT,
  kind        TEXT NOT NULL,           -- 'entry' | 'exit'
  side        TEXT NOT NULL,           -- 'buy' | 'sell'
  qty         REAL NOT NULL,
  order_id    TEXT NOT NULL,
  status      TEXT NOT NULL,           -- 'unknown' | 'filled' | 'rejected' | 'cancelled' | 'lost'
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_order_settlements_status ON order_settlements(status);
CREATE INDEX IF NOT EXISTS idx_order_settlements_signal ON order_settlements(signal_id);

-- Persisted OCO bracket pairing: when one leg fills we cancel the sibling. Keyed
-- by each leg's order id → the pair, so a restart can rebuild the in-memory map.
CREATE TABLE IF NOT EXISTS bracket_pairs (
  signal_id     TEXT PRIMARY KEY,
  exchange      TEXT NOT NULL,
  sl_order_id   TEXT,
  tp_order_id   TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bracket_pairs_sl ON bracket_pairs(sl_order_id);
CREATE INDEX IF NOT EXISTS idx_bracket_pairs_tp ON bracket_pairs(tp_order_id);

-- Reconciler audit: one row per correction attempt or flagged mismatch.
CREATE TABLE IF NOT EXISTS reconciliations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange     TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  expected_net REAL NOT NULL,          -- expected net from our signal_executions
  broker_net   REAL NOT NULL,          -- net observed at the broker
  delta        REAL NOT NULL,          -- expected - broker
  action       TEXT NOT NULL,          -- 'corrected' | 'skipped_working' | 'skipped_large' | 'skipped_cooldown' | 'skipped_closed' | 'skipped_manual' | 'alert_foreign_order'
  side         TEXT,                   -- correction side, when corrected
  qty          REAL,                   -- correction qty, when corrected
  order_id     TEXT,
  status       TEXT,                   -- settlement status of a correction order
  ts           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reconciliations_ts ON reconciliations(ts);
CREATE INDEX IF NOT EXISTS idx_reconciliations_key ON reconciliations(exchange, account_id, symbol);

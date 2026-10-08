-- Per-signal execution state machine, fills ledger, and balance snapshots.
--
-- Ported (adapted) from the standalone kaibot-exec service. The executor stays a
-- thin relay — the exchange remains the source of truth for live positions — so
-- these tables do NOT introduce a virtual position ledger or a reconciler. They
-- add three things the TradeStation path was missing:
--
--  1. signal_executions — idempotent per-signal state. An open is recorded once;
--     a failed open is marked 'error' and blocks any later reduce/close for that
--     signal. Survives reconnect/replay so a signal never opens twice.
--  2. signal_fills — the actual fills (entry/exit, price, qty, commission) per
--     signal, the basis for fills-based realized/unrealized PnL.
--  3. balance_snapshots — periodic equity/cash snapshots per exchange account,
--     feeding the dashboard equity curve.

-- Idempotent execution state, one row per signal id.
CREATE TABLE IF NOT EXISTS signal_executions (
  signal_id   TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,           -- resolved tradable symbol (front-month for futures)
  exchange    TEXT NOT NULL,
  direction   TEXT NOT NULL,           -- 'long' | 'short'
  status      TEXT NOT NULL,           -- 'open' | 'closed' | 'error'
  qty_opened  REAL NOT NULL DEFAULT 0,
  qty_closed  REAL NOT NULL DEFAULT 0,
  error_reason TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signal_executions_symbol ON signal_executions(exchange, symbol);
CREATE INDEX IF NOT EXISTS idx_signal_executions_status ON signal_executions(status);

-- Per-signal fills. kind: 'entry' (open) | 'exit' (reduce/close). One signal can
-- have one entry fill and one or more exit fills.
CREATE TABLE IF NOT EXISTS signal_fills (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- 'entry' | 'exit'
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL,           -- 'buy' | 'sell'
  qty         REAL NOT NULL,
  price       REAL,                    -- null when the exchange didn't report a fill price
  commission  REAL NOT NULL DEFAULT 0,
  order_id    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signal_fills_signal ON signal_fills(signal_id);

-- Periodic equity/cash snapshots per exchange account → dashboard equity curve.
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange    TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  equity      REAL NOT NULL,
  balance     REAL NOT NULL,
  unrealized_pnl REAL NOT NULL DEFAULT 0,
  currency    TEXT,
  ts          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_balance_snapshots_ts ON balance_snapshots(ts);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_acct_ts ON balance_snapshots(exchange, account_id, ts);

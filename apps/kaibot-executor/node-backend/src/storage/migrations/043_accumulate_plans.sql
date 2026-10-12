-- Accumulate & ride plans (migration 043). One row per (exchange, account,
-- symbol); the operator arms it, the executor runs the cycle ladder -> riding
-- -> waiting. `pending` holds the actions of a decision in flight so a restart
-- replays them (every action is idempotent); the rungs a plan owns sit in
-- accumulate_rungs, their fills are booked by the dca_resting_rungs sweep.
CREATE TABLE IF NOT EXISTS accumulate_plans (
  id               TEXT PRIMARY KEY,
  exchange         TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  direction        TEXT NOT NULL,
  ride_bot_id      TEXT NOT NULL,
  params           TEXT NOT NULL,
  phase            TEXT NOT NULL,
  reference        REAL NOT NULL,
  entry_bar_time   INTEGER NOT NULL,
  local_level      REAL,
  last_evaluated_bar INTEGER,
  ladder_seq       INTEGER NOT NULL DEFAULT 0,
  basis_usd        REAL,
  ride_position_id TEXT,
  ride_entry_signal_id TEXT,
  stop_sized_qty   REAL,
  pending          TEXT,
  last_note        TEXT,
  last_error       TEXT,
  last_breakout    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accumulate_plans_market
  ON accumulate_plans(exchange, account_id, symbol) WHERE phase != 'stopped';

CREATE TABLE IF NOT EXISTS accumulate_rungs (
  order_id   TEXT PRIMARY KEY,
  plan_id    TEXT NOT NULL,
  ladder_seq INTEGER NOT NULL,
  idx        INTEGER NOT NULL,
  price      REAL NOT NULL,
  qty        REAL NOT NULL,
  -- open | filled | cancelled
  state      TEXT NOT NULL,
  filled_qty REAL NOT NULL DEFAULT 0,
  adopted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accumulate_rungs_plan ON accumulate_rungs(plan_id);

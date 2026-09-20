-- Hedge guards (edge hedge, executor-hedge plan). One guard per MAIN position
-- (pos:{exchange}:{account}:{symbol}), armed explicitly by the user like a
-- stop: trigger, sizing and wind-down policy are authored up front; the edge
-- only executes. The hedge leg is an opposite position on a DIFFERENT (paired)
-- instrument — one venue instrument holds one net position, so a same-symbol
-- hedge would net the main position away (the synthetic-mint conflict).
-- Lifecycle is one-shot (legacy parity): armed -> hedged -> closed/orphaned;
-- re-arming is a new explicit arm.

CREATE TABLE IF NOT EXISTS hedge_guards (
  position_key TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  hedge_symbol TEXT NOT NULL,
  hedge_account_id TEXT NOT NULL,
  -- Adverse breach of this level (long: price below, short: price above)
  -- opens the hedge. Legacy referencePrice / startHedgingAfter.
  trigger_price REAL NOT NULL,
  -- 'match' = |main position| in USD notional at trigger time (legacy dynamic
  -- hedge); 'fixed-usd' = fixed_usd notional (legacy flat hedge quantity —
  -- Deribit inverse contracts ARE USD).
  size_mode TEXT NOT NULL CHECK (size_mode IN ('match', 'fixed-usd')),
  fixed_usd REAL,
  -- Optional: price recovering past this level (in the main's favourable
  -- direction) closes the hedge (edge analog of legacy fullRecovery).
  recovery_price REAL,
  -- What happens to the hedge when the main position closes: 'keep' leaves it
  -- standing (legacy freeze) with a notification; 'close' flattens it.
  on_main_close TEXT NOT NULL CHECK (on_main_close IN ('keep', 'close')),
  status TEXT NOT NULL CHECK (status IN ('armed', 'hedged', 'closed', 'orphaned')),
  hedge_side TEXT CHECK (hedge_side IN ('buy', 'sell')),
  hedge_qty REAL,
  hedge_entry_price REAL,
  hedge_opened_ts INTEGER,
  close_reason TEXT,
  last_error TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hedge_guards_active
  ON hedge_guards(active, exchange);

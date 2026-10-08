-- Generalize local_trail_state from signal-keyed to position-scoped (F1,
-- pilot-ladder decomposition). The signal_id column stays the primary key but
-- becomes an ATTACH KEY: signal rows keep their signal id; a trail armed on a
-- position by hand uses the deterministic key `pos:{exchange}:{account}:{symbol}`.
-- New columns default to the legacy (signal / fixed-distance) behaviour so
-- existing rows migrate in place.

-- Which path armed the trail: 'signal' (signal-client, gated behind
-- EXECUTOR_LOCAL_TRAILING) or 'manual' (the user armed it explicitly on a
-- position — no env gate).
ALTER TABLE local_trail_state ADD COLUMN source TEXT NOT NULL DEFAULT 'signal';
ALTER TABLE local_trail_state ADD COLUMN account_id TEXT;
-- Trail mode: 'fixed' (constant distance off the water mark) or 'drawdown'
-- (drawdown-depth trail, the SDK computeDrawdownTrailingStop maths).
ALTER TABLE local_trail_state ADD COLUMN mode TEXT NOT NULL DEFAULT 'fixed';
-- Drawdown mode: floor on the trail distance (the practical "distance" knob —
-- the carried drawdown depth is ~0 right after arming). max_percentage /
-- max_points double as the drawdown caps (default 40% / 500pt when null).
ALTER TABLE local_trail_state ADD COLUMN min_percentage REAL;
ALTER TABLE local_trail_state ADD COLUMN min_points REAL;
-- Force point-based maths regardless of venue (else TradeStation => points).
ALTER TABLE local_trail_state ADD COLUMN use_points INTEGER NOT NULL DEFAULT 0;
-- Drawdown mode: trail off the FIXED pre-arm swing (reference_price) instead of
-- the advancing favourable extreme (legacy extreme_price_at_entry semantics).
ALTER TABLE local_trail_state ADD COLUMN freeze_extreme INTEGER NOT NULL DEFAULT 0;
-- Operator lock: the engine trail is suspended; the manual stop is absolute.
ALTER TABLE local_trail_state ADD COLUMN trailing_lock INTEGER NOT NULL DEFAULT 0;
-- The user's own stop. Always participates in the effective stop; the engine
-- only improves on it; under trailing_lock it is absolute.
ALTER TABLE local_trail_state ADD COLUMN manual_stop REAL;
-- The engine-computed stop (trail/BE ratchet, favourable-only). Kept separate
-- from current_stop (the stop actually resting at the venue) so a dominant
-- manual stop never resets the engine ratchet.
ALTER TABLE local_trail_state ADD COLUMN engine_stop REAL;
-- Adverse water mark (the addon's opposite_price) — drawdown depth input.
ALTER TABLE local_trail_state ADD COLUMN opposite_price REAL;
-- Operator anchor: frozen trail extreme under freeze_extreme, and the
-- onlyWhenProfit-style reference for the drawdown maths.
ALTER TABLE local_trail_state ADD COLUMN reference_price REAL;
-- The bracket (bracket_pairs.signal_id) whose protective stop this trail took
-- over at arm time. Each cancel/replace rebinds the bracket's sl to the fresh
-- order id so OCO sibling-cancel keeps targeting the LIVE stop.
ALTER TABLE local_trail_state ADD COLUMN bracket_signal_id TEXT;

CREATE INDEX IF NOT EXISTS idx_local_trail_symbol ON local_trail_state(exchange, symbol, active);

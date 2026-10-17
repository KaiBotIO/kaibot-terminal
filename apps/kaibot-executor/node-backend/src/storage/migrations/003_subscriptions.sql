-- Executor subscription persistence
-- Mirrors server-side subscription state + offline signal queue

CREATE TABLE IF NOT EXISTS executor_subscriptions (
    id TEXT PRIMARY KEY,                       -- server-side subscription id
    signal_bot_id TEXT NOT NULL,
    bot_name TEXT,
    selected_markets TEXT,                      -- JSON array of markets
    factor REAL NOT NULL DEFAULT 1.0,
    max_position_size REAL,                     -- optional safety cap
    max_concurrent_trades INTEGER,              -- optional safety cap
    exchange TEXT,                              -- preferred exchange for this sub
    account_id TEXT,                            -- preferred accountId for this sub
    status TEXT NOT NULL DEFAULT 'active',      -- 'active' | 'paused' | 'cancelled'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_executor_subs_bot ON executor_subscriptions(signal_bot_id);
CREATE INDEX IF NOT EXISTS idx_executor_subs_status ON executor_subscriptions(status);

-- Offline signal queue: tracks signals that arrived while paused / reconnecting
CREATE TABLE IF NOT EXISTS executor_signal_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id TEXT NOT NULL,
    action TEXT NOT NULL,                       -- 'buy' | 'sell' | 'close'
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    reason TEXT,                                -- 'stale_open' | 'close_replay' | 'sub_paused' | 'executed' | 'rejected'
    metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_signal_queue_signal ON executor_signal_queue(signal_id);

-- Safety clip audit log: every time factor or safety cap changes a quantity
CREATE TABLE IF NOT EXISTS executor_safety_clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id TEXT NOT NULL,
    subscription_id TEXT,
    reason TEXT NOT NULL,                       -- 'factor_applied' | 'max_position_size' | 'min_contract_size' | 'step_size_round' | 'max_concurrent_trades'
    original_quantity REAL,
    adjusted_quantity REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_safety_clips_signal ON executor_safety_clips(signal_id);

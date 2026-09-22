-- KaiBot Executor Database Schema

-- User authentication (single admin user)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    settings TEXT -- JSON settings
);

-- API Keys for connecting to KaiBot platform
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key_encrypted TEXT NOT NULL,
    permissions TEXT, -- JSON array of permissions
    last_validated DATETIME,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Exchange/Broker connections
CREATE TABLE IF NOT EXISTS exchanges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL, -- 'alpaca', 'tradestation', 'ibkr', etc.
    credentials_encrypted TEXT NOT NULL, -- JSON with encrypted API keys
    is_active BOOLEAN DEFAULT 1,
    is_paper BOOLEAN DEFAULT 0,
    last_connected DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- NOTE: there is intentionally no local `positions`/`trades` ledger.
-- The executor relays signals and places orders, but the exchange is the
-- source of truth for open positions (read live via the exchange adapter's
-- getPositions()). Earlier installs created `positions`/`trades` tables that
-- were never written; migration 006 drops them.

-- Signals from KaiBot platform
CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY, -- Signal ID from platform
    strategy_id TEXT NOT NULL,
    strategy_name TEXT,
    symbol TEXT NOT NULL,
    action TEXT NOT NULL, -- 'buy', 'sell', 'close'
    quantity REAL,
    price REAL,
    type TEXT, -- 'market', 'limit', 'stop', 'stopLimit'
    confidence REAL,
    stop_loss REAL,
    take_profit REAL,
    stop_loss_order_id TEXT,
    take_profit_order_id TEXT,
    metadata TEXT, -- JSON with additional signal data
    received_at DATETIME NOT NULL,
    processed_at DATETIME,
    status TEXT NOT NULL, -- 'pending', 'executed', 'rejected', 'expired', 'closed'
    trade_id INTEGER, -- legacy, always NULL (no local trades ledger)
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Bot configurations
CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    exchange_id INTEGER NOT NULL,
    is_active BOOLEAN DEFAULT 0,
    is_paper BOOLEAN DEFAULT 1,
    config TEXT NOT NULL, -- JSON configuration
    risk_config TEXT, -- JSON risk management settings
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (exchange_id) REFERENCES exchanges(id)
);

-- Performance metrics
CREATE TABLE IF NOT EXISTS performance_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER,
    date DATE NOT NULL,
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    total_pnl REAL DEFAULT 0,
    win_rate REAL,
    average_win REAL,
    average_loss REAL,
    sharpe_ratio REAL,
    max_drawdown REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bot_id) REFERENCES bots(id)
);

-- Local session tokens (hashed) for the admin user
CREATE TABLE IF NOT EXISTS auth_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- System logs
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL, -- 'debug', 'info', 'warn', 'error'
    category TEXT NOT NULL, -- 'system', 'trading', 'connection', etc.
    message TEXT NOT NULL,
    metadata TEXT, -- JSON with additional context
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
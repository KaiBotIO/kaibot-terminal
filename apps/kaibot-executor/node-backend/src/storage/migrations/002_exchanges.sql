-- Exchange connections table
CREATE TABLE IF NOT EXISTS exchange_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  exchange_name TEXT NOT NULL,
  connection_type TEXT NOT NULL,
  encrypted_credentials TEXT NOT NULL,
  session_data TEXT,
  is_active INTEGER DEFAULT 1,
  last_refresh INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Exchange accounts table
CREATE TABLE IF NOT EXISTS exchange_accounts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  exchange_name TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_type TEXT,
  account_data TEXT NOT NULL,
  last_sync INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (connection_id) REFERENCES exchange_connections(id)
);

-- Exchange balances table
CREATE TABLE IF NOT EXISTS exchange_balances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  balance_data TEXT NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (account_id) REFERENCES exchange_accounts(id)
);

-- Exchange positions table
CREATE TABLE IF NOT EXISTS exchange_positions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  position_data TEXT NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (account_id) REFERENCES exchange_accounts(id)
);

-- Exchange orders table
CREATE TABLE IF NOT EXISTS exchange_orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  order_data TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (account_id) REFERENCES exchange_accounts(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_exchange_connections_user_id ON exchange_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_exchange_connections_active ON exchange_connections(is_active);
CREATE INDEX IF NOT EXISTS idx_exchange_accounts_connection ON exchange_accounts(connection_id);
CREATE INDEX IF NOT EXISTS idx_exchange_balances_account ON exchange_balances(account_id);
CREATE INDEX IF NOT EXISTS idx_exchange_balances_timestamp ON exchange_balances(timestamp);
CREATE INDEX IF NOT EXISTS idx_exchange_positions_account ON exchange_positions(account_id);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_account ON exchange_orders(account_id);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_status ON exchange_orders(status);
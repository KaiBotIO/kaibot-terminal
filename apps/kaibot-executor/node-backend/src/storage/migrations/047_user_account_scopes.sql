-- Which accounts a viewer may see (migration 047). kind 'connection' grants a
-- whole connection by label ('default', 'acct1'); kind 'account' grants one
-- venue account id ('21084933', 'acct1/btc'). Admins ignore this table; a
-- viewer without rows sees no account data.
CREATE TABLE IF NOT EXISTS user_account_scopes (
  user_id INTEGER NOT NULL,
  exchange TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('connection', 'account')),
  ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, exchange, kind, ref)
);

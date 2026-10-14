-- Multiple connections per (user, exchange): a label per connection row.
-- Existing rows keep id `<user>:<exchange>` and label 'default'; a labeled
-- connection gets id `<user>:<exchange>:<label>`. A subscription may pin the
-- connection it routes through (account_key = label); NULL = default.
-- Bracket pairs record the account the legs rest on so a fill's OCO sibling
-- cancel routes to the right connection after a restart.
ALTER TABLE exchange_connections ADD COLUMN label TEXT NOT NULL DEFAULT 'default';
CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_connections_user_exchange_label
  ON exchange_connections(user_id, exchange_name, label);
ALTER TABLE executor_subscriptions ADD COLUMN account_key TEXT;
ALTER TABLE bracket_pairs ADD COLUMN account_id TEXT;

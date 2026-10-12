-- Off-exchange coins (cold wallet) that the collateral pot counts as sizing
-- basis (migration 046). Never margin: the cap on real margin, the MMR guard
-- and the floors only see the venue wallet.
CREATE TABLE IF NOT EXISTS collateral_virtual_lines (
  exchange TEXT NOT NULL,
  account_id TEXT NOT NULL,
  coin TEXT NOT NULL,
  label TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (exchange, account_id, coin, label)
);

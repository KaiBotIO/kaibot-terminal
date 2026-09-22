-- Per-account contract sizing (parity #6 with kaibot-exec account_sizes).
--
-- Caps the contracts placed per signal, per (exchange account, symbol root).
-- A row of max_contracts = 0 is a per-market kill-switch: signals on that root
-- for that account are rejected (execution off). When no row exists, the
-- root's built-in default applies. Enforced in the signal pipeline as a clip
-- (audited like the other safety clips) before any order is placed.
--
-- root = the futures root (MES, MNQ, ...) for futures, or the bare symbol for
-- crypto pairs (BTC-PERPETUAL → BTC-PERPETUAL); kept generic so crypto venues
-- can be sized too.
CREATE TABLE IF NOT EXISTS account_sizes (
  exchange      TEXT NOT NULL,
  account       TEXT NOT NULL,
  root          TEXT NOT NULL,
  max_contracts REAL NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (exchange, account, root)
);

CREATE INDEX IF NOT EXISTS idx_account_sizes_account ON account_sizes(exchange, account);

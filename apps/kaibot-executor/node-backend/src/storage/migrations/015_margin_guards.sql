-- Pre-open breathing-room margin guard (crypto-aware port of kaibot-exec).
--
-- Per (exchange account) config for the pre-open margin buffer: refuse an open
-- that would leave too little free margin to keep existing positions safe.
-- A row with exchange='*' AND account='*' is the GLOBAL DEFAULT, applied when no
-- exact (exchange, account) row exists. With no rows at all the built-in/env
-- defaults apply (guard disabled by default). Enforced in the signal pipeline as
-- a reject, audited like the other safety clips, before any order is placed.
--
-- floor_mode: 'maintenance' (floor = account maintenance margin, the default),
--             'initial'     (floor = account initial margin, stricter),
--             'equityPct'   (floor = equity_pct × equity, leverage-independent).
CREATE TABLE IF NOT EXISTS margin_guards (
  exchange    TEXT NOT NULL,
  account     TEXT NOT NULL,
  enabled     INTEGER NOT NULL,
  buffer_mult REAL NOT NULL,
  floor_mode  TEXT NOT NULL,
  equity_pct  REAL NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (exchange, account)
);

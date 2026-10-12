-- Synthetic USD: persist the user-set leverage ceiling per position.
--
-- The cap is a protective ceiling the USER chooses, not a KaiBot risk decision.
-- It bounds how far above the holdings basis the locked USD target may go
-- (target <= holdings_basis_usd * leverage_cap). Stored per position so it is
-- the user's authored config, carried across scale mutations. Existing rows keep
-- the historical 10x default so behaviour is unchanged for already-open positions.

ALTER TABLE synthetic_usd_positions
  ADD COLUMN leverage_cap REAL NOT NULL DEFAULT 10;

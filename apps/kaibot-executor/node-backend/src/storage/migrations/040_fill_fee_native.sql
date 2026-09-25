-- The venue's own fee figure next to the USD commission on a fill. Deribit
-- charges coin-margined contracts in the coin (BTC/ETH); commission stays the
-- USD conversion the P&L uses, these two keep what the venue actually charged.
ALTER TABLE signal_fills ADD COLUMN fee_native REAL;
ALTER TABLE signal_fills ADD COLUMN fee_currency TEXT;

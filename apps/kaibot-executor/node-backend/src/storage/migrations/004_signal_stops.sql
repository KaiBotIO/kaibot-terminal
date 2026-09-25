-- Add bracket order fields (stop-loss / take-profit) to the executor's
-- local signals table so the executor can track sibling order ids for OCO.

ALTER TABLE signals ADD COLUMN stop_loss REAL;
ALTER TABLE signals ADD COLUMN take_profit REAL;
ALTER TABLE signals ADD COLUMN stop_loss_order_id TEXT;
ALTER TABLE signals ADD COLUMN take_profit_order_id TEXT;

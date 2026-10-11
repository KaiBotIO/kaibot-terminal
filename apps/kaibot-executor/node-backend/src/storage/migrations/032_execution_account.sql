-- Broker account on the execution record.
--
-- signal_executions had no account column, so the reconciler could only net
-- expected-vs-broker per SYMBOL, summed across every broker account: two bots
-- on the same root in different accounts hid each other's drift, and a
-- correction order went to whichever account happened to appear last in
-- getPositions. With account_id recorded at open time the whole reconcile loop
-- keys on (account, symbol). Historical rows stay NULL — the reconciler treats
-- those symbols as unattributed and never auto-corrects them.
ALTER TABLE signal_executions ADD COLUMN account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_signal_executions_account
  ON signal_executions(exchange, account_id, symbol);

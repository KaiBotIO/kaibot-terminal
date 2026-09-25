-- Portfolio sharing (opt-in): mark which local fills + balance snapshots have
-- been shipped to the server analytics ingest, so the PortfolioShipper sends each
-- row exactly once and survives restarts. The server gates ingest on the user's
-- opt-in; the executor ships regardless and lets the server skip when opted out.
-- ALTER ... ADD COLUMN is not idempotent in sqlite; the runner swallows the
-- duplicate-column error.

ALTER TABLE signal_fills ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;
ALTER TABLE balance_snapshots ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;

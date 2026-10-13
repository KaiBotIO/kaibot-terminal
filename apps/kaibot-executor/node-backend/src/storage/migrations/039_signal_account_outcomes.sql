-- Per-account outcomes of a signal that fanned out over several
-- subscriptions of one bot (services/fanout). JSON array of AccountOutcome on
-- the WIRE signal row; the per-account lineages keep their own rows under a
-- derived id (`<wireId>~<8 hex>`, metadata.fanoutOf = the wire id).
ALTER TABLE signals ADD COLUMN account_outcomes TEXT;

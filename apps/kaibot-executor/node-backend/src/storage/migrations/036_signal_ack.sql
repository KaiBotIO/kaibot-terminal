-- When the executor told the server what happened to a signal.
--
-- The ack was fire-and-forget: nothing recorded whether it landed, so the
-- Signals drawer could show when a signal arrived and when it was processed,
-- but never whether the server was informed. A signal that executed locally
-- while every ack failed is a real state (the server still thinks it is
-- pending) and the timeline has to be able to say so.
ALTER TABLE signals ADD COLUMN acked_at DATETIME;
-- ack_status is 'ok' or 'failed'.
ALTER TABLE signals ADD COLUMN ack_status TEXT;

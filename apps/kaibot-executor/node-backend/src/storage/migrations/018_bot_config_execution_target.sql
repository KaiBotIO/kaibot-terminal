-- Licence-free refactor §4.5 / INV7: per-bot execution target on the frozen edge
-- config. The strategy decision loop runs at the executor edge; where its alerts
-- GO is user-selectable. 'kaibot' (default) keeps the existing local order path
-- (signalClient.ingestLocalSignal); 'webhook' renders the user's payload template
-- and POSTs it to an external executor/consumer (3Commas / TradingView-consumer /
-- own bot) INSTEAD — so KaiBot's own executor is one peer, never the only path.
--
--  execution_target        'kaibot' | 'webhook'
--  alert_webhook_url        outbound URL when execution_target = 'webhook'
--  alert_payload_template   user-defined body template (placeholders), rendered per alert
ALTER TABLE bot_configs ADD COLUMN execution_target TEXT NOT NULL DEFAULT 'kaibot';
ALTER TABLE bot_configs ADD COLUMN alert_webhook_url TEXT;
ALTER TABLE bot_configs ADD COLUMN alert_payload_template TEXT;

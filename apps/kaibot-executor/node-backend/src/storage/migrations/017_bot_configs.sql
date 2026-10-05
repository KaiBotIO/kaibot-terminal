-- Edge strategy runner (licence-free refactor §1): the decision loop now runs
-- in the executor. These two tables are the executor analog of the server's
-- signal_bots + signal_bot_runs rows.
--
--  bot_configs   — the FROZEN strategy definition synced from the server at
--                  bot-start (config-freeze contract). One row per (bot, market).
--  bot_run_state — the per-bot RunnerState JSON + last processed candle ts.
--                  Mirrors server signalBotRuns.state / lastCandleAt so the
--                  lastCandleAt guard fires identically and the loop never
--                  re-emits on the same closed candle.

CREATE TABLE IF NOT EXISTS bot_configs (
    id TEXT PRIMARY KEY,                        -- local run id = `${signalBotId}:${exchange}:${symbol}:${timeframe}`
    signal_bot_id TEXT NOT NULL,                -- server signal-bot id (resolves the subscription + sizing)
    bot_name TEXT,
    strategy_id TEXT NOT NULL,
    strategy_name TEXT,
    strategy_type TEXT NOT NULL,                -- built-in type ('ema_cross'...) or 'sdk:<id>'
    strategy_config TEXT NOT NULL,              -- JSON StrategyConfig (discriminated)
    indicator_sources TEXT,                     -- JSON { ref: sourceCode } — frozen indicator deps
    exchange TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',     -- 'running' | 'paused' | 'stopped'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bot_configs_bot ON bot_configs(signal_bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_configs_status ON bot_configs(status);

CREATE TABLE IF NOT EXISTS bot_run_state (
    bot_config_id TEXT PRIMARY KEY,             -- FK → bot_configs.id (same composite key)
    state TEXT,                                 -- JSON RunnerState
    last_candle_at INTEGER,                     -- ms epoch of last processed closed candle
    last_signal_at INTEGER,                     -- ms epoch of last emitted signal
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

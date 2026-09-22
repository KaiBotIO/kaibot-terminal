-- Per-subscription size unit: 'native' (contracts/coin, default) or 'usd'.
-- In 'usd' mode the executor reads the factor-sized quantity AND the max
-- position size as USD notionals and converts them to venue-native units
-- before placing orders. NULL/absent = 'native' (backwards compatible).
ALTER TABLE executor_subscriptions ADD COLUMN size_unit TEXT;

-- Remote-companion control plane (opt-in, default OFF).
--
-- The executor's owner can enable remote management from the mobile companion
-- app. While disabled the executor REFUSES every relayed command and pushes no
-- state — enabling is a conscious, revocable consent action. Wave 1 stores a
-- flag + a placeholder pairing code + a simple paired-device flag; Layer 3
-- replaces the pairing internals with real on-device keys + PAKE pinning.
--
-- companion_settings — single-row config (id pinned to 1).
--   enabled        1 = remote management ON (commands accepted, state pushed).
--   pairing_code   the code shown in the executor UI; a phone must present it to
--                  pair. Minted on enable, cleared on disable. (Wave-1 placeholder.)
--   enabled_at     epoch-ms when enabled, or null when disabled.
CREATE TABLE IF NOT EXISTS companion_settings (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  enabled      INTEGER NOT NULL DEFAULT 0,
  pairing_code TEXT,
  enabled_at   INTEGER
);
INSERT OR IGNORE INTO companion_settings (id, enabled, pairing_code, enabled_at) VALUES (1, 0, NULL, NULL);

-- companion_devices — one row per paired phone. Wave-1 carries only an id + a
-- label + paired-at; Layer 3 adds the pinned device public key + verified flag.
CREATE TABLE IF NOT EXISTS companion_devices (
  id         TEXT PRIMARY KEY,
  label      TEXT,
  paired_at  INTEGER NOT NULL
);

-- Companion E2E (Layer 3) — real on-device X25519 identity + code-authenticated
-- pairing. Replaces the wave-1 placeholder pairing-code flow.
--
-- companion_identity — the executor's long-term X25519 identity keypair (single
-- row, id pinned to 1). The private key is stored ENCRYPTED via the storage
-- Crypto vault (AES-256-GCM, per-install key) and NEVER leaves the box. The
-- public key is safe to relay during pairing.
CREATE TABLE IF NOT EXISTS companion_identity (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  pub_key        TEXT NOT NULL,    -- hex X25519 public key (relayed, not secret)
  enc_secret_key TEXT NOT NULL,    -- Crypto-vault ciphertext of the 32-byte secret
  created_at     INTEGER NOT NULL
);

-- A device must pin the peer's public key and prove it holds the matching key.
--   pub_key  : hex X25519 identity pubkey of the phone (pinned at pair time).
--   verified : 0 = PENDING (pair seen, awaiting pairConfirm), 1 = PAIRED.
ALTER TABLE companion_devices ADD COLUMN pub_key TEXT;
ALTER TABLE companion_devices ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;

-- Drop any wave-1 placeholder device rows (keyless) — Layer 3 requires a pinned
-- key per device, so old rows can no longer authenticate and must re-pair.
DELETE FROM companion_devices WHERE pub_key IS NULL;

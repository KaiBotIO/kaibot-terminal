// Companion opt-in service — the consent cornerstone of the remote control plane.
//
// Remote management is OFF by default. While off, the executor refuses every
// relayed command (`companion_disabled`) and pushes no state. Enabling is a
// conscious, revocable action; a phone must then PAIR with a code-authenticated
// key exchange (defeats a relay MITM) before any command is accepted. Disabling
// unpairs every device and resumes refusing.
//
// Layer 3: real on-device X25519 identity keys + a SAS (short authentication
// string) the user reads off the executor and types on the phone. The executor's
// identity private key is held ENCRYPTED in the storage Crypto vault and never
// leaves the box. See docs/companion-e2e.md + companion/crypto.ts.

import type { KaiBotDatabase } from '../storage/database.js';
import type { Crypto } from '../storage/crypto.js';
import {
  generateIdentity,
  deriveSessionKey,
  computeSAS,
  toHex,
  fromHex,
} from '../companion/crypto.js';

export interface PairedDevice {
  id: string;
  label: string | null;
  pairedAt: number;
  verified: boolean;
}

export interface CompanionStatus {
  enabled: boolean;
  pairingCode: string | null; // the SAS of the latest pending device (or null)
  enabledAt: number | null;
  devices: PairedDevice[];
}

export class CompanionService {
  // The crypto vault encrypts/decrypts the executor's identity secret key. The
  // identity is created lazily on first enable/pair so a never-enabled executor
  // holds no key material.
  constructor(
    private db: KaiBotDatabase,
    private vault?: Crypto,
  ) {}

  isCompanionEnabled(): boolean {
    return this.db.getCompanionSettings().enabled;
  }

  // True only when remote management is ON and at least one device is VERIFIED
  // (pairConfirm completed). A merely-pending device does NOT satisfy this — the
  // command handler requires a verified, key-pinned device before dispatching.
  hasPairedDevice(): boolean {
    return this.isCompanionEnabled() && this.db.listCompanionDevices().some((d) => d.verified === 1);
  }

  getStatus(): CompanionStatus {
    const s = this.db.getCompanionSettings();
    return {
      enabled: s.enabled,
      pairingCode: this.getPairingCode(),
      enabledAt: s.enabledAt,
      devices: this.listPairedDevices(),
    };
  }

  // The pairing code to DISPLAY: the SAS of the most-recent pending device, i.e.
  // the phone currently trying to pair. Computed live from the pinned device
  // pubkey + the executor pubkey; the SAS itself is never transmitted. Null when
  // disabled or when no phone is mid-pairing.
  getPairingCode(): string | null {
    const s = this.db.getCompanionSettings();
    if (!s.enabled) return null;
    const id = this.getIdentity();
    if (!id) return null;
    const pending = this.db
      .listCompanionDevices()
      .filter((d) => d.verified === 0 && d.pub_key)
      .sort((a, b) => b.paired_at - a.paired_at)[0];
    if (!pending?.pub_key) return null;
    return computeSAS(fromHex(pending.pub_key), fromHex(id.pubKey));
  }

  // Turn remote management ON. Ensures the executor identity key exists so the
  // first phone can pair immediately. No placeholder code is minted — the SAS is
  // derived per pairing attempt from the exchanged public keys.
  enableCompanion(): CompanionStatus {
    this.ensureIdentity();
    this.db.setCompanionEnabled(true, null);
    this.db.log('warn', 'system', 'Companion remote management ENABLED', {});
    return this.getStatus();
  }

  // Turn remote management OFF: unpair every device so the executor refuses
  // commands again until the owner re-enables and re-pairs. The identity key is
  // KEPT (re-pairing re-uses the same executor pubkey — convenient + harmless,
  // pairing always re-authenticates with a fresh SAS).
  disableCompanion(): CompanionStatus {
    this.db.clearCompanionDevices();
    this.db.setCompanionEnabled(false, null);
    this.db.log('warn', 'system', 'Companion remote management DISABLED (all devices unpaired)', {});
    return this.getStatus();
  }

  listPairedDevices(): PairedDevice[] {
    return this.db.listCompanionDevices().map((d) => ({
      id: d.id,
      label: d.label,
      pairedAt: d.paired_at,
      verified: d.verified === 1,
    }));
  }

  unpairDevice(id: string): void {
    this.db.removeCompanionDevice(id);
    this.db.log('info', 'system', 'Companion device unpaired', { id });
  }

  // ── Layer 3: identity + pairing ──────────────────────────────────────────────

  // The executor's public identity key (hex), or null if no identity exists yet.
  getExecutorPublicKeyHex(): string | null {
    return this.getIdentity()?.pubKey ?? null;
  }

  // Step `pair` (UNSEALED): the phone presented its pubkey. Pin it as a PENDING
  // device, ensure the executor identity, and return the executor pubkey so the
  // phone can compute the SAS. The SAS is DISPLAYED in the executor UI (via
  // getPairingCode) — it is never transmitted. Re-pairing the same device pubkey
  // resets it to pending.
  beginPairing(devicePubKeyHex: string): { executorPubKeyHex: string; deviceId: string } {
    const id = this.ensureIdentity();
    const devicePub = fromHex(devicePubKeyHex);
    if (devicePub.length !== 32) throw new Error('bad_device_key');
    // Deterministic id from the device pubkey so re-pair updates the same row.
    const deviceId = `dev-${devicePubKeyHex.slice(0, 16)}`;
    this.db.addCompanionDevice(deviceId, null, devicePubKeyHex, false);
    this.db.log('info', 'system', 'Companion pairing started (pending)', { deviceId });
    return { executorPubKeyHex: id.pubKey, deviceId };
  }

  // The session key for a device by its pinned pubkey, or null if not pinned.
  // Used by the seal seam: a pending device's key opens its pairConfirm; a paired
  // device's key seals/opens every management frame.
  sessionKeyForDevice(devicePubKeyHex: string): Uint8Array | null {
    const id = this.getIdentity();
    if (!id || !this.vault) return null;
    const row = this.db.listCompanionDevices().find((d) => d.pub_key === devicePubKeyHex);
    if (!row?.pub_key) return null;
    const sk = fromHex(this.vault.decrypt(id.encSecretKey));
    return deriveSessionKey(sk, fromHex(row.pub_key));
  }

  // The session key of the (single) VERIFIED paired device, or null. Drives the
  // sealed command/state path once pairing is complete.
  pairedSessionKey(): Uint8Array | null {
    const row = this.db.listCompanionDevices().find((d) => d.verified === 1 && d.pub_key);
    if (!row?.pub_key) return null;
    return this.sessionKeyForDevice(row.pub_key);
  }

  // The (single) PENDING device's pubkey hex, or null. The handler opens its
  // pairConfirm with this device's session key.
  pendingDevicePubKeyHex(): string | null {
    const pending = this.db
      .listCompanionDevices()
      .filter((d) => d.verified === 0 && d.pub_key)
      .sort((a, b) => b.paired_at - a.paired_at)[0];
    return pending?.pub_key ?? null;
  }

  // Step `pairConfirm`: the phone proved (by sealing with the matching session
  // key) that its SAS matched the executor's displayed code. Promote PENDING →
  // PAIRED. Caller has already opened the sealed pairConfirm with this device's
  // key (the AEAD open IS the proof) before calling this.
  confirmPairing(devicePubKeyHex: string): void {
    const row = this.db.listCompanionDevices().find((d) => d.pub_key === devicePubKeyHex);
    if (!row) throw new Error('not_paired');
    this.db.setCompanionDeviceVerified(row.id, true);
    this.db.log('info', 'system', 'Companion device paired (verified)', { deviceId: row.id });
  }

  // ── identity helpers ──
  private getIdentity(): { pubKey: string; encSecretKey: string } | null {
    return this.db.getCompanionIdentity();
  }

  // Create the executor identity keypair if absent. The secret key is stored
  // ENCRYPTED via the Crypto vault. Requires a vault; without one (shouldn't
  // happen in prod) pairing is impossible by design.
  private ensureIdentity(): { pubKey: string; encSecretKey: string } {
    const existing = this.getIdentity();
    if (existing) return existing;
    if (!this.vault) throw new Error('companion_no_vault');
    const kp = generateIdentity();
    const encSecretKey = this.vault.encrypt(toHex(kp.secretKey));
    const pubKey = toHex(kp.publicKey);
    this.db.setCompanionIdentity(pubKey, encSecretKey);
    this.db.log('warn', 'system', 'Companion identity key generated', {});
    return { pubKey, encSecretKey };
  }
}

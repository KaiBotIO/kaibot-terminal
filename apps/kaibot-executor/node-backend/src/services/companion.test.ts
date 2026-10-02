import { describe, expect, it } from 'bun:test';
import { CompanionService } from './companion.js';
import { StatePusher } from '../websocket/state-pusher.js';
import {
  generateIdentity,
  deriveSessionKey,
  computeSAS,
  seal as cryptoSeal,
  open as cryptoOpen,
  toHex,
  fromHex,
} from '../companion/crypto.js';

// In-memory backing for the companion settings/devices/identity tables (Layer 3).
class FakeDb {
  logs: any[] = [];
  settings = { enabled: false, pairingCode: null as string | null, enabledAt: null as number | null };
  devices: Array<{ id: string; label: string | null; paired_at: number; pub_key: string | null; verified: number }> = [];
  identity: { pub_key: string; enc_secret_key: string } | null = null;

  log(_l: string, _c: string, _m: string, _meta?: any) {
    this.logs.push({});
  }
  getCompanionSettings() {
    return { ...this.settings };
  }
  setCompanionEnabled(enabled: boolean, pairingCode: string | null) {
    this.settings = { enabled, pairingCode: enabled ? pairingCode : null, enabledAt: enabled ? Date.now() : null };
  }
  listCompanionDevices() {
    return [...this.devices].sort((a, b) => b.paired_at - a.paired_at);
  }
  addCompanionDevice(id: string, label: string | null, pubKey?: string | null, verified = false) {
    const existing = this.devices.find((d) => d.id === id);
    if (existing) {
      existing.label = label;
      existing.paired_at = Date.now();
      existing.pub_key = pubKey ?? null;
      existing.verified = verified ? 1 : 0;
    } else {
      this.devices.push({ id, label, paired_at: Date.now(), pub_key: pubKey ?? null, verified: verified ? 1 : 0 });
    }
  }
  setCompanionDeviceVerified(id: string, verified: boolean) {
    const d = this.devices.find((x) => x.id === id);
    if (d) d.verified = verified ? 1 : 0;
  }
  removeCompanionDevice(id: string) {
    this.devices = this.devices.filter((d) => d.id !== id);
  }
  clearCompanionDevices() {
    this.devices = [];
  }
  getCompanionIdentity() {
    return this.identity ? { pubKey: this.identity.pub_key, encSecretKey: this.identity.enc_secret_key } : null;
  }
  setCompanionIdentity(pubKey: string, encSecretKey: string) {
    this.identity = { pub_key: pubKey, enc_secret_key: encSecretKey };
  }
  // state-snapshot reads (used by the StatePusher push path)
  getHaltState() {
    return { halted: false, reason: null, tripped_at: null };
  }
  getBotConfigs() {
    return [];
  }
  getSubscriptions() {
    return [];
  }
  listAccountSizes() {
    return [];
  }
  getMarginGuard() {
    return null;
  }
}

// A passthrough "vault" with the same encrypt/decrypt shape as storage Crypto.
// (The real one is AES-GCM; for the unit it only needs to round-trip a string.)
const fakeVault = {
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
} as any;

function newService() {
  const db = new FakeDb();
  const svc = new CompanionService(db as any, fakeVault);
  return { db, svc };
}

describe('CompanionService opt-in lifecycle', () => {
  it('is OFF by default — no code, no paired device', () => {
    const { svc } = newService();
    expect(svc.isCompanionEnabled()).toBe(false);
    expect(svc.hasPairedDevice()).toBe(false);
    expect(svc.getPairingCode()).toBeNull();
  });

  it('enable creates an identity but no code yet (no phone pairing)', () => {
    const { svc } = newService();
    const status = svc.enableCompanion();
    expect(status.enabled).toBe(true);
    // No phone has started pairing → no SAS to display yet.
    expect(status.pairingCode).toBeNull();
    expect(svc.getExecutorPublicKeyHex()).toBeTruthy();
    // Enabled but unpaired → not a usable paired state.
    expect(svc.hasPairedDevice()).toBe(false);
  });

  it('disable unpairs every device and resumes refusing', () => {
    const { svc } = newService();
    svc.enableCompanion();
    const phone = generateIdentity();
    svc.beginPairing(toHex(phone.publicKey));
    svc.disableCompanion();
    expect(svc.isCompanionEnabled()).toBe(false);
    expect(svc.getPairingCode()).toBeNull();
    expect(svc.listPairedDevices()).toHaveLength(0);
  });

  it('unpairDevice removes a single device', () => {
    const { svc } = newService();
    svc.enableCompanion();
    const p1 = generateIdentity();
    const p2 = generateIdentity();
    const r1 = svc.beginPairing(toHex(p1.publicKey));
    const r2 = svc.beginPairing(toHex(p2.publicKey));
    expect(svc.listPairedDevices()).toHaveLength(2);
    svc.unpairDevice(r1.deviceId);
    expect(svc.listPairedDevices().map((d) => d.id)).toEqual([r2.deviceId]);
  });
});

describe('Layer-3 pairing (SAS + key pinning)', () => {
  it('pair pins the device as PENDING and the SAS matches the phone-computed code', () => {
    const { svc } = newService();
    svc.enableCompanion();
    const phone = generateIdentity();
    const { executorPubKeyHex, deviceId } = svc.beginPairing(toHex(phone.publicKey));

    // The device is pending (not verified) until pairConfirm.
    expect(svc.hasPairedDevice()).toBe(false);
    const dev = svc.listPairedDevices().find((d) => d.id === deviceId)!;
    expect(dev.verified).toBe(false);

    // The SAS the executor DISPLAYS equals what the phone computes over the same
    // two public keys — the provability anchor.
    const execSas = svc.getPairingCode();
    const phoneSas = computeSAS(phone.publicKey, fromHex(executorPubKeyHex));
    expect(execSas).toBe(phoneSas);
    expect(execSas).toHaveLength(8);
  });

  it('pairConfirm promotes PENDING → PAIRED only with the matching session key', () => {
    const { svc } = newService();
    svc.enableCompanion();
    const phone = generateIdentity();
    const { executorPubKeyHex, deviceId } = svc.beginPairing(toHex(phone.publicKey));

    // The phone derives the session key and seals a pairConfirm.
    const phoneSession = deriveSessionKey(phone.secretKey, fromHex(executorPubKeyHex));
    const confirmBlob = cryptoSeal(phoneSession, JSON.stringify({ type: 'pairConfirm' }), 'cmd-1:cmd');

    // The executor opens it with the pending device's session key (the proof).
    const pendingPub = svc.pendingDevicePubKeyHex()!;
    const execKey = svc.sessionKeyForDevice(pendingPub)!;
    const opened = cryptoOpen(execKey, confirmBlob, 'cmd-1:cmd');
    expect(JSON.parse(opened).type).toBe('pairConfirm');

    svc.confirmPairing(pendingPub);
    expect(svc.hasPairedDevice()).toBe(true);
    expect(svc.listPairedDevices().find((d) => d.id === deviceId)!.verified).toBe(true);

    // Both sides now hold the SAME paired session key.
    expect(toHex(svc.pairedSessionKey()!)).toBe(toHex(phoneSession));
  });

  it('MITM: a swapped pubkey makes the two SAS differ → the user-typed code fails', () => {
    const { svc } = newService();
    svc.enableCompanion();
    const phone = generateIdentity();
    const attacker = generateIdentity();

    // The executor pins the ATTACKER's key (relay swapped it) — its displayed SAS
    // is over (attacker, exec). The honest phone computes its SAS over
    // (phone, execReal). The two codes don't match, so the user-typed code (the
    // executor's) won't equal the phone's → the phone refuses to confirm.
    const { executorPubKeyHex } = svc.beginPairing(toHex(attacker.publicKey));
    const execDisplayedSas = svc.getPairingCode();
    const phoneComputedSas = computeSAS(phone.publicKey, fromHex(executorPubKeyHex));
    expect(execDisplayedSas).not.toBe(phoneComputedSas);
  });
});

describe('StatePusher gating', () => {
  function build(paired: boolean) {
    const { db, svc } = newService();
    if (paired) {
      svc.enableCompanion();
      const phone = generateIdentity();
      const { executorPubKeyHex } = svc.beginPairing(toHex(phone.publicKey));
      // Promote to paired (the pairConfirm proof is exercised above).
      const pendingPub = svc.pendingDevicePubKeyHex()!;
      svc.confirmPairing(pendingPub);
      // The phone holds this session key to open the pushed state.
      const phoneSession = deriveSessionKey(phone.secretKey, fromHex(executorPubKeyHex));
      const sent: any[] = [];
      const pusher = new StatePusher({
        db: db as any,
        exchangeManager: null,
        companion: svc,
        send: (m) => sent.push(m),
        isConnected: () => true,
      });
      return { pusher, sent, db, svc, phoneSession };
    }
    const sent: any[] = [];
    const pusher = new StatePusher({
      db: db as any,
      exchangeManager: null,
      companion: svc,
      send: (m) => sent.push(m),
      isConnected: () => true,
    });
    return { pusher, sent, db, svc, phoneSession: null as Uint8Array | null };
  }

  it('pushes nothing while remote management is OFF / unpaired', async () => {
    const { pusher, sent } = build(false);
    await pusher.pushImmediate();
    expect(sent).toHaveLength(0);
  });

  it('pushes a SEALED executor_state that the phone can open', async () => {
    const { pusher, sent, phoneSession } = build(true);
    await pusher.pushImmediate();
    expect(sent).toHaveLength(1);
    const frame = sent[0];
    expect(frame.type).toBe('executor_state');
    expect(typeof frame.blob).toBe('string');
    expect(frame.seq).toBe(1);
    // The blob is CIPHERTEXT — not readable JSON.
    expect(() => JSON.parse(frame.blob)).toThrow();
    expect(frame.blob).not.toContain('portfolio');
    // The phone opens it with the paired session key + the `state` aad.
    const snap = JSON.parse(cryptoOpen(phoneSession!, frame.blob, 'state'));
    expect(snap).toHaveProperty('halt');
    expect(snap).toHaveProperty('portfolio');
    expect(snap).toHaveProperty('bots');
    expect(snap.type).toBeUndefined();
  });

  it('does not push when the socket is closed', async () => {
    const { db, svc } = newService();
    svc.enableCompanion();
    const phone = generateIdentity();
    svc.beginPairing(toHex(phone.publicKey));
    svc.confirmPairing(svc.pendingDevicePubKeyHex()!);
    const sent: any[] = [];
    const pusher = new StatePusher({
      db: db as any,
      exchangeManager: null,
      companion: svc,
      send: (m) => sent.push(m),
      isConnected: () => false,
    });
    await pusher.pushImmediate();
    expect(sent).toHaveLength(0);
  });

  it('seq increments monotonically across pushes', async () => {
    const { pusher, sent } = build(true);
    await pusher.pushImmediate();
    await pusher.pushImmediate();
    await pusher.pushImmediate();
    expect(sent.map((f) => f.seq)).toEqual([1, 2, 3]);
  });
});

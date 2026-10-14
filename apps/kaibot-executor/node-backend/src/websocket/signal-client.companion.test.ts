import { describe, expect, it } from 'bun:test';
import { SignalWebSocketClient } from './signal-client.js';
import { StatePusher } from './state-pusher.js';
import {
  generateIdentity,
  deriveSessionKey,
  seal as cryptoSeal,
  open as cryptoOpen,
  toHex,
} from '../companion/crypto.js';
import type { ExecutorCommandDeps } from './executor-command-handler.js';

// Drives the executor_command WS case end-to-end: feed a relayed message into
// handleMessage and capture the executor_command_result reply written by the
// client's sendMessage. The reply's `error` is cleartext; the `resultBlob` is
// SEALED (we open() it with the session key to assert the result shape).

// One executor⇄phone key pair shared across the suite.
const EXEC = generateIdentity();
const PHONE = generateIdentity();
const SESSION = deriveSessionKey(EXEC.secretKey, PHONE.publicKey);
const PHONE_PUB_HEX = toHex(PHONE.publicKey);

function sealCmd(type: string, payload: unknown, cmdId: string): string {
  return cryptoSeal(SESSION, JSON.stringify({ type, payload }), `${cmdId}:cmd`);
}

class MiniDb {
  logs: any[] = [];
  halt = { halted: false, reason: null as string | null, tripped_at: null as number | null };
  log() {
    this.logs.push({});
  }
  getHaltState() {
    return this.halt;
  }
  setHaltState(halted: boolean, reason?: string | null) {
    this.halt = { halted, reason: halted ? reason ?? null : null, tripped_at: halted ? Date.now() : null };
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

// Companion stub: a paired companion holds the shared SESSION key.
function fakeCompanion(enabled: boolean, paired: boolean) {
  return {
    isCompanionEnabled: () => enabled,
    hasPairedDevice: () => enabled && paired,
    pairedSessionKey: () => (enabled && paired ? SESSION : null),
    pendingDevicePubKeyHex: () => null,
    sessionKeyForDevice: () => null,
    beginPairing: () => {
      throw new Error('not used');
    },
    confirmPairing: () => {
      throw new Error('not used');
    },
  } as any;
}

function attachFakeSocket(client: SignalWebSocketClient): { sent: any[] } {
  const sent: any[] = [];
  const fakeWs = {
    readyState: 1, // OPEN
    send: (data: string) => sent.push(JSON.parse(data)),
  };
  (client as any).ws = fakeWs;
  return { sent };
}

function buildClient(opts: { enabled?: boolean; paired?: boolean }) {
  const db = new MiniDb();
  const client = new SignalWebSocketClient(db as any, null, null);
  const { sent } = attachFakeSocket(client);
  const companion = fakeCompanion(opts.enabled ?? true, opts.paired ?? true);
  const deps: ExecutorCommandDeps = { db: db as any, exchangeManager: null, companion };
  const pusher = new StatePusher({
    db: db as any,
    exchangeManager: null,
    companion,
    send: (m) => (client as any).sendCompanionMessage(m),
    isConnected: () => client.isConnected(),
  });
  pusher.setCadence(10, 1);
  client.setCompanion(deps, pusher);
  return { db, client, sent };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 5));
}

describe('signal-client executor_command path', () => {
  it('replies companion_disabled (cleartext) when remote management is off', async () => {
    const { client, sent } = buildClient({ enabled: false });
    (client as any).handleMessage({
      type: 'executor_command',
      cmdId: 'c1',
      issuedAt: Date.now(),
      blob: sealCmd('getState', {}, 'c1'),
    });
    await flush();
    const reply = sent.find((m) => m.type === 'executor_command_result');
    expect(reply).toBeTruthy();
    expect(reply.cmdId).toBe('c1');
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('companion_disabled');
    expect(reply.resultBlob).toBeUndefined();
  });

  it('replies not_paired when enabled but unpaired', async () => {
    const { client, sent } = buildClient({ enabled: true, paired: false });
    (client as any).handleMessage({
      type: 'executor_command',
      cmdId: 'c2',
      blob: sealCmd('setHalt', { halted: true }, 'c2'),
    });
    await flush();
    const reply = sent.find((m) => m.type === 'executor_command_result');
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('not_paired');
  });

  it('bad blob → bad_payload (cleartext), socket survives', async () => {
    const { client, sent } = buildClient({ enabled: true, paired: true });
    // Not ciphertext and not a pairing message → AEAD open fails → bad_payload.
    (client as any).handleMessage({ type: 'executor_command', cmdId: 'c3', blob: '{not json' });
    await flush();
    const reply = sent.find((m) => m.type === 'executor_command_result');
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('bad_payload');
  });

  it('dispatches setHalt and replies ok with a SEALED resultBlob', async () => {
    const { db, client, sent } = buildClient({ enabled: true, paired: true });
    (client as any).handleMessage({
      type: 'executor_command',
      cmdId: 'c4',
      blob: sealCmd('setHalt', { halted: true, reason: 'remote' }, 'c4'),
    });
    await flush();
    const reply = sent.find((m) => m.type === 'executor_command_result' && m.cmdId === 'c4');
    expect(reply.ok).toBe(true);
    expect(typeof reply.resultBlob).toBe('string');
    expect(db.halt.halted).toBe(true);
    // resultBlob is CIPHERTEXT (sealed with the paired key + `${cmdId}:result`).
    expect(() => JSON.parse(reply.resultBlob)).toThrow();
    const result = JSON.parse(cryptoOpen(SESSION, reply.resultBlob, 'c4:result')) as any;
    expect(result.halted).toBe(true);
  });

  it('a relayed MANAGEMENT command blob is ciphertext — the relay sees no JSON', () => {
    // The wire blob the phone produced (and the relay forwards) is opaque.
    const blob = sealCmd('panic', { halt: true }, 'cX');
    expect(blob).not.toContain('panic');
    expect(blob).not.toContain('halt');
    expect(() => JSON.parse(blob)).toThrow();
  });

  it('a successful mutation triggers a SEALED state push (debounced)', async () => {
    const { client, sent } = buildClient({ enabled: true, paired: true });
    (client as any).handleMessage({
      type: 'executor_command',
      cmdId: 'c5',
      blob: sealCmd('setHalt', { halted: true }, 'c5'),
    });
    await new Promise((r) => setTimeout(r, 15));
    const stateFrame = sent.find((m) => m.type === 'executor_state');
    expect(stateFrame).toBeTruthy();
    expect(typeof stateFrame.blob).toBe('string');
    // The state frame is sealed too — opens with the paired key + `state` aad.
    const snap = JSON.parse(cryptoOpen(SESSION, stateFrame.blob, 'state'));
    expect(snap).toHaveProperty('halt');
  });

  it('a pairConfirm reply forwards verbatim (sealed by the handler)', async () => {
    // A paired+enabled companion with a PENDING device whose key is SESSION.
    const db = new MiniDb();
    const client = new SignalWebSocketClient(db as any, null, null);
    const { sent } = attachFakeSocket(client);
    const companion = {
      isCompanionEnabled: () => true,
      hasPairedDevice: () => false,
      pairedSessionKey: () => null,
      pendingDevicePubKeyHex: () => PHONE_PUB_HEX,
      sessionKeyForDevice: (hex: string) => (hex === PHONE_PUB_HEX ? SESSION : null),
      confirmPairing: () => {},
    } as any;
    const deps: ExecutorCommandDeps = { db: db as any, exchangeManager: null, companion };
    client.setCompanion(deps, null as any);

    const confirmBlob = cryptoSeal(SESSION, JSON.stringify({ type: 'pairConfirm' }), 'p1:cmd');
    (client as any).handleMessage({ type: 'executor_command', cmdId: 'p1', blob: confirmBlob });
    await flush();
    const reply = sent.find((m) => m.type === 'executor_command_result' && m.cmdId === 'p1');
    expect(reply.ok).toBe(true);
    // The handler sealed { paired: true } with the now-paired key.
    const opened = JSON.parse(cryptoOpen(SESSION, reply.resultBlob, 'p1:result'));
    expect(opened.paired).toBe(true);
  });
});

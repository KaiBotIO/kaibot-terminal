import { describe, expect, it } from 'bun:test';
import {
  ALLOWED_COMMANDS,
  handleExecutorCommand,
  type ExecutorCommandDeps,
} from './executor-command-handler.js';
import { detachBot } from '../services/bot-detach.js';
import {
  generateIdentity,
  deriveSessionKey,
  seal as cryptoSeal,
  open as cryptoOpen,
} from '../companion/crypto.js';

// Hand-rolled fakes — no SQLite, no venue. The handler dispatches to db/service
// fns; we record the calls and assert each command hits the right one.
//
// Layer 3: commands ride a SEALED blob. The handler owns the keyed open(), so the
// tests SEAL each command with the paired session key + `${cmdId}:cmd` aad, the
// same way the phone does. A fixed cmdId keeps the aad deterministic per call.

// One executor⇄phone key pair shared across the dispatch suite.
const EXEC = generateIdentity();
const PHONE = generateIdentity();
const SESSION = deriveSessionKey(EXEC.secretKey, PHONE.publicKey);

function sealCmd(type: string, payload: unknown, cmdId = 'cmd-1'): string {
  return cryptoSeal(SESSION, JSON.stringify({ type, payload }), `${cmdId}:cmd`);
}

class FakeDb {
  logs: any[] = [];
  halt = { halted: false, reason: null as string | null, tripped_at: null as number | null };
  guardrails: any[] = [];
  accountSizes: any[] = [];
  botStatus = new Map<string, string>();
  subStatus = new Map<string, string>();
  bots = new Map<string, any>();
  subs = new Map<string, any>();
  openSignalsByBot = new Map<string, Array<{ id: string }>>();
  activeTrails: any[] = [];
  deactivatedTrails: string[] = [];

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata });
  }

  getHaltState() {
    return this.halt;
  }
  setHaltState(halted: boolean, reason?: string | null) {
    this.halt = { halted, reason: halted ? reason ?? null : null, tripped_at: halted ? Date.now() : null };
  }
  setGuardrails(exchange: string, account: string, cfg: any) {
    this.guardrails.push({ exchange, account, ...cfg });
  }
  setAccountSize(exchange: string, account: string, root: string, maxContracts: number) {
    this.accountSizes.push({ exchange, account, root, maxContracts });
  }
  getBotConfig(id: string) {
    return this.bots.get(id) ?? null;
  }
  setBotConfigStatus(id: string, status: string) {
    this.botStatus.set(id, status);
    const b = this.bots.get(id);
    if (b) b.status = status;
  }
  getSubscription(id: string) {
    return this.subs.get(id) ?? null;
  }
  setSubscriptionStatus(id: string, status: string) {
    this.subStatus.set(id, status);
  }
  getOpenSignalsForBotConfig(id: string) {
    return this.openSignalsByBot.get(id) ?? [];
  }
  activeLocalTrailsForSignals(_ids: string[]) {
    return this.activeTrails;
  }
  deactivateLocalTrail(signalId: string) {
    this.deactivatedTrails.push(signalId);
  }
  // state-snapshot reads (getState path)
  getBotConfigs(_onlyRunning: boolean) {
    return [...this.bots.values()];
  }
  getSubscriptions(_includeCancelled: boolean) {
    return [...this.subs.values()];
  }
  listAccountSizes() {
    return [];
  }
  getMarginGuard() {
    return null;
  }
}

class FakeAdapter {
  positions: any[] = [];
  placed: any[] = [];
  async getPositions() {
    return this.positions;
  }
  async getBalances() {
    return [];
  }
  async getAccounts() {
    return [{ accountId: 'default', name: 'default' }];
  }
  async placeOrder(o: any) {
    this.placed.push(o);
    return { orderId: `ord-${this.placed.length}`, status: 'filled' };
  }
}

class FakeManager {
  constructor(private adapter: FakeAdapter) {}
  async getAllSessions() {
    return [{ adapter: this.adapter, status: 'connected', userId: 'default', exchangeName: 'deribit' }];
  }
  async getSession() {
    return { adapter: this.adapter, status: 'connected', userId: 'default', exchangeName: 'deribit' };
  }
}

// Companion stub. A paired companion holds the shared SESSION key; pending/pairing
// hooks are stubbed for the dispatch suite (the pairing suite uses a real service).
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

function deps(opts: {
  enabled?: boolean;
  paired?: boolean;
  db?: FakeDb;
  adapter?: FakeAdapter;
  noManager?: boolean;
}): { deps: ExecutorCommandDeps; db: FakeDb; adapter: FakeAdapter } {
  const db = opts.db ?? new FakeDb();
  const adapter = opts.adapter ?? new FakeAdapter();
  const exchangeManager = opts.noManager ? null : (new FakeManager(adapter) as any);
  return {
    deps: {
      db: db as any,
      exchangeManager,
      companion: fakeCompanion(opts.enabled ?? true, opts.paired ?? true),
    },
    db,
    adapter,
  };
}

// ── Opt-in gate (consent) ─────────────────────────────────────────────────────

describe('opt-in gate', () => {
  it('refuses EVERY command (incl getState) with companion_disabled when off', async () => {
    for (const type of ALLOWED_COMMANDS) {
      const { deps: d } = deps({ enabled: false });
      // Off ⇒ refused before any open(); the blob never even gets decrypted.
      const res = await handleExecutorCommand(d, sealCmd(type, {}), 'cmd-1');
      expect(res.ok).toBe(false);
      expect(res.error).toBe('companion_disabled');
    }
  });

  it('refuses with not_paired when enabled but no device paired', async () => {
    for (const type of ALLOWED_COMMANDS) {
      const { deps: d } = deps({ enabled: true, paired: false });
      // A non-pairing blob with no paired key → not_paired (no key to open it).
      const res = await handleExecutorCommand(d, sealCmd(type, {}), 'cmd-1');
      expect(res.ok).toBe(false);
      expect(res.error).toBe('not_paired');
    }
  });
});

// ── MiCA structural guarantee ────────────────────────────────────────────────

describe('MiCA guard', () => {
  it('ALLOWED_COMMANDS contains no order-placement verb', () => {
    const ORDER_VERBS = [
      'buy',
      'sell',
      'open',
      'openposition',
      'placeorder',
      'order',
      'trade',
      'long',
      'short',
      'entry',
      'close', // closing a directional position is also a trade decision
      'reduce',
      'market',
      'limit',
    ];
    for (const cmd of ALLOWED_COMMANDS) {
      const lc = cmd.toLowerCase();
      for (const verb of ORDER_VERBS) {
        expect(lc.includes(verb)).toBe(false);
      }
    }
  });

  it('an unknown order-shaped command is rejected, never dispatched to placeOrder', async () => {
    const { deps: d, adapter } = deps({});
    for (const type of ['placeOrder', 'buy', 'openPosition', 'trade']) {
      const res = await handleExecutorCommand(
        d,
        sealCmd(type, { symbol: 'BTC', side: 'buy', quantity: 1 }),
        'cmd-1',
      );
      expect(res.ok).toBe(false);
      expect(res.error).toBe('unknown_command');
    }
    // The only path that ever calls adapter.placeOrder is panic (reduce-only,
    // close-all) — no command we sent placed a directional order.
    expect(adapter.placed).toHaveLength(0);
  });

  it('panic only ever places reduce-only close orders (never a directional open)', async () => {
    const adapter = new FakeAdapter();
    adapter.positions = [
      { accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long', size: 5, entryPrice: 60000 },
    ];
    const { deps: d } = deps({ adapter });
    const res = await handleExecutorCommand(d, sealCmd('panic', { halt: true }), 'cmd-1');
    expect(res.ok).toBe(true);
    expect(adapter.placed).toHaveLength(1);
    expect(adapter.placed[0].reduceOnly).toBe(true);
    expect(adapter.placed[0].side).toBe('sell'); // opposite the long → flatten only
  });
});

// ── Per-command dispatch ──────────────────────────────────────────────────────

describe('command dispatch (enabled + paired)', () => {
  it('panic → panicCloseAll + halt', async () => {
    const { deps: d, db } = deps({});
    const res = await handleExecutorCommand(d, sealCmd('panic', { halt: true }), 'cmd-1');
    expect(res.ok).toBe(true);
    expect(db.halt.halted).toBe(true);
    expect(db.halt.reason).toBe('remote');
  });

  it('setHalt → db.setHaltState', async () => {
    const { deps: d, db } = deps({});
    const res = await handleExecutorCommand(d, sealCmd('setHalt', { halted: true, reason: 'remote' }), 'cmd-1');
    expect(res.ok).toBe(true);
    expect(db.halt.halted).toBe(true);
  });

  it('setHalt bad payload → bad_payload', async () => {
    const { deps: d } = deps({});
    const res = await handleExecutorCommand(d, sealCmd('setHalt', { halted: 'yes' }), 'cmd-1');
    expect(res).toMatchObject({ ok: false, error: 'bad_payload' });
  });

  it('setGuardrails → db.setGuardrails', async () => {
    const { deps: d, db } = deps({});
    const res = await handleExecutorCommand(
      d,
      sealCmd('setGuardrails', {
        exchange: 'deribit',
        account: 'btc',
        maxDailyLoss: 100,
        maxConcurrentPositions: 2,
        maxTotalNotional: 0,
      }),
      'cmd-1',
    );
    expect(res.ok).toBe(true);
    expect(db.guardrails).toHaveLength(1);
    expect(db.guardrails[0]).toMatchObject({ exchange: 'deribit', maxDailyLoss: 100, maxConcurrentPositions: 2 });
  });

  it('setGuardrails rejects negative / non-integer concurrency', async () => {
    const { deps: d } = deps({});
    const neg = await handleExecutorCommand(
      d,
      sealCmd('setGuardrails', { exchange: 'deribit', account: 'btc', maxDailyLoss: -1, maxConcurrentPositions: 1, maxTotalNotional: 0 }),
      'cmd-1',
    );
    expect(neg.error).toBe('bad_payload');
    const frac = await handleExecutorCommand(
      d,
      sealCmd('setGuardrails', { exchange: 'deribit', account: 'btc', maxDailyLoss: 0, maxConcurrentPositions: 1.5, maxTotalNotional: 0 }),
      'cmd-1',
    );
    expect(frac.error).toBe('bad_payload');
  });

  it('setAccountSizes → db.setAccountSize (batch)', async () => {
    const { deps: d, db } = deps({});
    const res = await handleExecutorCommand(
      d,
      sealCmd('setAccountSizes', {
        sizes: [
          { exchange: 'deribit', account: 'btc', root: 'BTC', maxContracts: 10 },
          { exchange: 'deribit', account: 'eth', root: 'ETH', maxContracts: 5 },
        ],
      }),
      'cmd-1',
    );
    expect(res.ok).toBe(true);
    expect(db.accountSizes).toHaveLength(2);
  });

  it('botStart / botStop → db.setBotConfigStatus', async () => {
    const db = new FakeDb();
    db.bots.set('bot-1', { id: 'bot-1', status: 'stopped', strategyId: 's1' });
    const start = deps({ db });
    const r1 = await handleExecutorCommand(start.deps, sealCmd('botStart', { id: 'bot-1' }, 'cmd-1'), 'cmd-1');
    expect(r1.ok).toBe(true);
    expect(db.botStatus.get('bot-1')).toBe('running');
    const r2 = await handleExecutorCommand(start.deps, sealCmd('botStop', { id: 'bot-1' }, 'cmd-2'), 'cmd-2');
    expect(r2.ok).toBe(true);
    expect(db.botStatus.get('bot-1')).toBe('stopped');
  });

  it('botStart unknown id → not found', async () => {
    const { deps: d } = deps({});
    const res = await handleExecutorCommand(d, sealCmd('botStart', { id: 'nope' }), 'cmd-1');
    expect(res).toMatchObject({ ok: false, error: 'not found' });
  });

  it('botDetach → detachBot (parity with shared extraction)', async () => {
    const mkDb = () => {
      const db = new FakeDb();
      db.bots.set('bot-1', { id: 'bot-1', status: 'running', strategyId: 'strat-1' });
      db.openSignalsByBot.set('bot-1', [{ id: 'sig-1' }]);
      db.activeTrails = [{ signal_id: 'sig-1' }];
      return db;
    };
    const dbA = mkDb();
    const dbB = mkDb();
    const viaHandler = await handleExecutorCommand(deps({ db: dbA }).deps, sealCmd('botDetach', { id: 'bot-1' }), 'cmd-1');
    const viaDirect = detachBot(dbB as any, 'bot-1');
    expect(viaHandler.ok).toBe(true);
    expect(viaHandler.result).toEqual(viaDirect);
    expect(dbA.deactivatedTrails).toEqual(dbB.deactivatedTrails);
    expect((viaHandler.result as any).paused).toBe(true);
    expect((viaHandler.result as any).retiredManagers).toBe(1);
  });

  it('subscriptionPause / Resume → db.setSubscriptionStatus', async () => {
    const db = new FakeDb();
    db.subs.set('sub-1', { id: 'sub-1', status: 'active' });
    const d = deps({ db });
    const pause = await handleExecutorCommand(d.deps, sealCmd('subscriptionPause', { id: 'sub-1' }, 'cmd-1'), 'cmd-1');
    expect(pause.ok).toBe(true);
    expect(db.subStatus.get('sub-1')).toBe('paused');
    const resume = await handleExecutorCommand(d.deps, sealCmd('subscriptionResume', { id: 'sub-1' }, 'cmd-2'), 'cmd-2');
    expect(resume.ok).toBe(true);
    expect(db.subStatus.get('sub-1')).toBe('active');
  });

  it('getState → assembled snapshot shape (not flagged mutated)', async () => {
    const db = new FakeDb();
    db.bots.set('bot-1', { id: 'bot-1', signalBotId: 'sb', strategyId: 's', strategyType: '', exchange: 'deribit', symbol: 'BTC', timeframe: '1h', status: 'running', executionTarget: 'kaibot' });
    const { deps: d } = deps({ db });
    const res = await handleExecutorCommand(d, sealCmd('getState', {}), 'cmd-1');
    expect(res.ok).toBe(true);
    expect(res.mutated).toBeFalsy();
    const snap = res.result as any;
    expect(snap).toHaveProperty('halt');
    expect(snap).toHaveProperty('portfolio');
    expect(snap).toHaveProperty('guardrails');
    expect(snap).toHaveProperty('accountSizes');
    expect(snap).toHaveProperty('bots');
    expect(snap).toHaveProperty('subscriptions');
  });

  it('a mutating command is flagged mutated (drives the state push)', async () => {
    const { deps: d } = deps({});
    const res = await handleExecutorCommand(d, sealCmd('setHalt', { halted: true }), 'cmd-1');
    expect(res.ok).toBe(true);
    expect(res.mutated).toBe(true);
  });

  it('unknown command type → unknown_command', async () => {
    const { deps: d } = deps({});
    const res = await handleExecutorCommand(d, sealCmd('frobnicate', {}), 'cmd-1');
    expect(res).toMatchObject({ ok: false, error: 'unknown_command' });
  });
});

// ── Sealed-channel proof (the operator-can't-read invariant) ──────────────────

describe('sealed channel', () => {
  it('a relayed management command blob is ciphertext — no readable JSON', () => {
    const blob = sealCmd('panic', { halt: true }, 'cmd-9');
    // No plaintext command structure survives in the wire blob.
    expect(blob).not.toContain('panic');
    expect(blob).not.toContain('type');
    expect(blob).not.toContain('halt');
    expect(() => JSON.parse(blob)).toThrow();
    // The legitimate holder of the session key + aad can still recover it.
    const opened = JSON.parse(cryptoOpen(SESSION, blob, 'cmd-9:cmd'));
    expect(opened.type).toBe('panic');
  });

  it('a tampered command blob → bad_payload (AEAD rejects it)', async () => {
    const { deps: d } = deps({});
    const blob = sealCmd('setHalt', { halted: true }, 'cmd-1');
    const i = blob.length - 4;
    const tampered = blob.slice(0, i) + (blob[i] === 'A' ? 'B' : 'A') + blob.slice(i + 1);
    const res = await handleExecutorCommand(d, tampered, 'cmd-1');
    expect(res).toMatchObject({ ok: false, error: 'bad_payload' });
  });

  it('a blob sealed under the WRONG aad → bad_payload (anti-reflection)', async () => {
    const { deps: d } = deps({});
    // Seal for cmd-1 but relay it as cmd-2 → aad mismatch → AEAD open fails.
    const blob = sealCmd('setHalt', { halted: true }, 'cmd-1');
    const res = await handleExecutorCommand(d, blob, 'cmd-2');
    expect(res).toMatchObject({ ok: false, error: 'bad_payload' });
  });
});

// ── No-key/secret leakage in the snapshot ────────────────────────────────────

describe('state snapshot excludes secrets', () => {
  it('getState result has no api key / secret / model / strategyConfig field', async () => {
    const db = new FakeDb();
    db.bots.set('bot-1', {
      id: 'bot-1',
      signalBotId: 'sb',
      strategyId: 's',
      strategyType: 'sdk:flagship',
      strategyConfig: '{"proprietary":"x"}',
      indicatorSources: '{"a":"code"}',
      exchange: 'deribit',
      symbol: 'BTC',
      timeframe: '1h',
      status: 'running',
      executionTarget: 'kaibot',
    });
    const { deps: d } = deps({ db });
    const res = await handleExecutorCommand(d, sealCmd('getState', {}), 'cmd-1');
    const json = JSON.stringify(res.result);
    expect(json).not.toContain('apiKey');
    expect(json).not.toContain('proprietary');
    expect(json).not.toContain('strategyConfig');
    expect(json).not.toContain('indicatorSources');
  });
});

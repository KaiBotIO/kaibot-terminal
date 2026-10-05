// StatePusher — pushes the executor state snapshot up the WS, but ONLY while
// remote management is enabled. While disabled it sends nothing (the consent
// invariant: opt-off ⇒ no state leaves the box).
//
// Cadence: a ~15s heartbeat + an on-change push (debounced ~500ms) fired after
// any panic/halt/guardrail/bot/subscription mutation, on WS `open`, and on
// enable. Each push is `{ type:'executor_state', snapshotAt, seq:++, blob }`
// where blob is the SEALED snapshot. seq is monotonic so a late frame can be
// dropped downstream.

import type { KaiBotDatabase } from '../storage/database.js';
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js';
import type { CompanionService } from '../services/companion.js';
import { assembleExecutorState } from '../services/state-snapshot.js';
import { seal } from '../companion/seal.js';

export interface StatePusherDeps {
  db: KaiBotDatabase;
  exchangeManager: ExchangeManager | null;
  companion: CompanionService;
  // Send a JSON message up the WS (no-op when the socket is closed).
  send: (msg: unknown) => void;
  // Whether the WS is currently open (skip a push when it isn't).
  isConnected: () => boolean;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class StatePusher {
  private seq = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatMs = 15_000;
  private debounceMs = 500;

  constructor(private deps: StatePusherDeps) {}

  // Test seam: shrink the timers so tests don't burn real seconds.
  setCadence(heartbeatMs: number, debounceMs: number) {
    this.heartbeatMs = heartbeatMs;
    this.debounceMs = debounceMs;
    if (this.heartbeat) {
      this.start(); // restart with the new cadence
    }
  }

  // Begin the heartbeat (idempotent). The heartbeat itself is gated on
  // companionEnabled at fire time, so starting it while disabled is harmless.
  start() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      void this.pushIfEnabled();
    }, this.heartbeatMs);
  }

  stop() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // Debounced on-change trigger. Coalesces a burst of mutations into one push.
  pushStateNow() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.pushIfEnabled();
    }, this.debounceMs);
  }

  // Immediate push, bypassing the debounce (used on WS open / on enable).
  async pushImmediate() {
    await this.pushIfEnabled();
  }

  private async pushIfEnabled(): Promise<void> {
    const { companion, db, exchangeManager, send, isConnected } = this.deps;
    // The consent gate: nothing leaves the box while remote management is off.
    if (!companion.isCompanionEnabled()) return;
    if (!isConnected()) return;
    // No verified paired device ⇒ no one holds the session key to read the state.
    // Skip the push (the phone gets a fresh snapshot right after it pairs).
    const sessionKey = companion.pairedSessionKey();
    if (!sessionKey) return;
    try {
      const snapshot = await assembleExecutorState(
        db,
        // assembleExecutorState fail-softs each exchange read; a null manager
        // still yields the local-only state (halt/bots/subscriptions).
        (exchangeManager ?? (null as unknown as ExchangeManager)),
      );
      send({
        type: 'executor_state',
        snapshotAt: Date.now(),
        seq: ++this.seq,
        blob: seal(sessionKey, snapshot, 'state'),
      });
    } catch (e) {
      db.log('warn', 'system', 'StatePusher: snapshot push failed', { error: errMsg(e) });
    }
  }
}

import WebSocket from 'ws';
import { KaiBotDatabase, parseTpOrderIds, type DeferredEntryRow } from '../storage/database.js';
import type { Signal, DcaRestingRungRow } from '../storage/types.js';
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js';
import type { ExchangeAdapter, Balance, Order, OrderResult, Position } from '../services/exchanges/types.js';
import type { NotificationBus } from '../services/notifications/notification-bus.js';
import { getContractConstraints, ensureContractConstraints, roundToStep } from '../services/exchanges/contract-constraints.js';
import { contractMultiplier, isDatedContractOf, pickOrderContract, rootOf } from '../services/exchanges/futures-contracts.js';
import { usdToNativeSize } from '@kaibot/types/core';
import { EXECUTOR_VERSION, EXECUTOR_PLATFORM, getBuildType } from '../version.js';
import { withOrderLock } from '../services/order-lock.js';
import { deriveClientOrderId, toClientOrderRef } from '../services/client-order-id.js';
import { settleAdapterOrder } from '../services/order-settlement.js';
import { isMarketTradable } from '../services/market-guard.js';
import {
  matchesDeferredLineage,
  planDeferral,
  resolveDeferConfig,
  type DeferConfig,
  type LineageProbe,
} from '../services/deferred-entries.js';
import { resolveVenue } from '../services/venue-resolver.js';
import { mapToVenueSymbol } from '../services/symbol-map.js';
import { checkBasis } from '../services/basis-guard.js';
import { clipToAccountSize, sizingRoot } from '../services/account-sizing.js';
import { getSyntheticSizingBasis, percentToQuantity } from '../services/synthetic-sizing.js';
import {
  effectiveMarginGuard,
  effectiveGuardrails,
  computeBreathingRoom,
  isInverseVenue,
  defaultLeverageFor,
  type BreathingRoom,
  type MarginGuardConfig,
} from '../services/margin-guard.js';
import {
  checkConcurrency,
  checkNotional,
  checkDailyLoss,
  guardrailsActive,
} from '../services/guardrails.js';
import { realizedPnlTodayUtc } from '../services/daily-pnl.js';
import { computeTpLadderLegs, computeDcaEntryLegs, timeframeToMs } from '../services/order-ladder.js';
import { botConfigsBlockSignal, botConfigsClipEntry } from '../services/take-over.js';
import { isFavourableStop } from '../services/local-trailing.js';
import { ensureBotGroup, autoLinkPosition } from '../services/position-groups.js';
import { attributeVenueExit } from '../services/exit-attribution.js';
import { handleFuturesRollNotice } from '../services/futures-roll.js';
import {
  sweepVenueExitOrders,
  adoptVenueClose,
  type VenueExitSweepDeps,
  type AdoptVenueCloseInput,
} from '../services/venue-exit-sweep.js';
import {
  isProtectiveStop,
  replaceServerExitStop,
  serverExitEffectiveStop,
  serverExitEngineStop,
  serverExitStopNeedsMove,
} from '../services/server-exit-stop.js';
import {
  handleExecutorCommand,
  sealResult,
  type ExecutorCommandDeps,
} from './executor-command-handler.js';
import type { StatePusher } from './state-pusher.js';
import {
  accountKeyOf,
  rowOnAccount,
  adapterAccountKey,
  scopeAccountId as withAccountKey,
  venueAccountOf,
} from '../services/exchanges/account-scope.js';

// Full close ⟺ the whole BOT-SCOPED base is requested, or effectively closed
// (the dust-fallback can raise closeQty above requestedSize). NEVER keyed on
// the venue net: an opposing book can net the venue below the bot's base, so a
// fraction close clamped to positionSize would otherwise masquerade as full
// and strip brackets/DCA rungs off a book with live remainder. Exported for
// the regression test.
export function isFullCloseRequest(
  requestedSize: number,
  closeQty: number,
  closeBaseQty: number,
): boolean {
  return requestedSize >= closeBaseQty - 1e-9 || closeQty >= closeBaseQty - 1e-9;
}

// The signal hub allows exactly one LIVE non-observer socket per account
// (apps/api/src/lib/signal-wire.ts EXECUTOR_CONFLICT_CLOSE_CODE) and closes any
// later one with this code the moment it connects. A single occurrence can
// also be OUR OWN reconnect racing the hub's stale-socket cleanup (see
// planNewExecutorSocket server-side) — the hub only replaces a stale peer once
// it looks stale by ping timing, which can lag a few seconds behind us already
// having moved on. Only treat it as a real standing conflict (and back off
// hard) after EXECUTOR_CONFLICT_CONFIRM_COUNT consecutive 4409s within
// EXECUTOR_CONFLICT_CONFIRM_WINDOW_MS; a single one is retried like any other
// transient close. See the 'close' handler and scheduleReconnect() below.
const EXECUTOR_CONFLICT_CLOSE_CODE = 4409;
const EXECUTOR_CONFLICT_CONFIRM_COUNT = 2;
const EXECUTOR_CONFLICT_CONFIRM_WINDOW_MS = 2 * 60 * 1000;

// In-memory OCO bracket group: one stop-loss leg + N take-profit legs sharing a
// single open position. Mirrors the persisted bracket_pairs row.
interface BracketGroup {
  // Account the legs rest on; null on legacy rows (default connection).
  accountId?: string | null;
  signalId: string;
  exchangeName: string;
  slOrderId?: string;
  tpOrderIds: string[];
}

// A roll notice older than this on replay is history (the contract expired
// or the user rolled long ago).
const ROLL_NOTICE_REPLAY_WINDOW_MS = 7 * 86_400_000;

export class SignalWebSocketClient {
  private ws: WebSocket | null = null;
  private db: KaiBotDatabase;
  private exchangeManager: ExchangeManager | null;
  private notifications: NotificationBus | null;
  private apiUrl: string | null = null;
  private apiKey: string | null = null;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  // Reconnect state machine (2026-09-06 skaibox blip): set when the socket is
  // lost until the next 'open'; a socket stuck CLOSING is detached and
  // replaced instead of waited on. Surfaced via /api/ws/status.
  private reconnectingSince: number | null = null;
  // Set once a standing conflict is CONFIRMED (see EXECUTOR_CONFLICT_CONFIRM_COUNT
  // above); cleared on the next successful 'open'. Surfaced via /api/ws/status
  // so the UI can say WHY it's not connecting instead of just "reconnecting".
  private conflictSince: number | null = null;
  // Consecutive-4409 tracking, reset on 'open' or once the confirm window lapses.
  private consecutiveConflictCloses = 0;
  private firstConflictCloseAt: number | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private connectTimeoutMs = 30_000;
  private isIntentionallyClosed = false;
  private lastConnectedAt: Date | null = null;
  // Soft update banner state, set when the API reports a newer version is out
  // (still above the hard min). Surfaced to the UI via /api/ws/status.
  private updateInfo: { latestVersion: string; current: string } | null = null;
  private staleOpenWindowMs = 60_000;
  private wasConnected = false;
  // Short-lived cache of live positions per exchange, so a burst of signals
  // doesn't hit the exchange's getPositions endpoint once per signal.
  private positionsCacheTtlMs = 3_000;
  private positionsCache = new Map<string, { at: number; positions: Position[] }>();
  // Short balance cache for the breathing-room guard. Opens are serialized by
  // the order lock, so this just keeps a signal burst from hammering the venue.
  private balanceCache = new Map<string, { at: number; balances: Balance[] }>();
  // Order-settlement poll cadence. Production defaults; tests shrink it so the
  // timeout path doesn't burn real seconds.
  private settleAttempts = 20;
  private settleIntervalMs = 500;
  // Client-side liveness watchdog (EX8): the server pings every ~30s, so a
  // socket with no inbound message for this long is a zombie (asymmetric
  // network failure — we look connected but receive nothing). Force-reconnect.
  private stalenessTimeoutMs = 90_000;
  private stalenessTimer: NodeJS.Timeout | null = null;
  private lastInboundAt = 0;
  // Remote-companion control plane (opt-in). Injected by main.ts via
  // setCompanion(); when absent the executor_command case refuses with
  // companion_disabled (no companion service ⇒ definitionally off).
  private companionDeps: ExecutorCommandDeps | null = null;
  private statePusher: StatePusher | null = null;
  // Injectable clock: the market guard and the deferred-entry poller read it
  // so tests can walk a closed market to its reopen without real waiting.
  private now: () => number = () => Date.now();
  // Market-closed entries (migration 037): parked rows are re-checked on this
  // cadence and resumed through the normal entry path once the venue trades.
  private deferConfig: DeferConfig = resolveDeferConfig();
  private deferredTimer: NodeJS.Timeout | null = null;
  private deferredTickRunning = false;

  constructor(
    db: KaiBotDatabase,
    exchangeManager: ExchangeManager | null = null,
    notifications: NotificationBus | null = null,
  ) {
    this.db = db;
    this.exchangeManager = exchangeManager;
    this.notifications = notifications;
  }

  // Ride hand-over after a fill: an entry whose metadata carries `handoverTo`
  // (drawing trigger "signal + hand over") is adopted by the ride bot once it
  // is filled and acked. Wired from main.ts; absent = the metadata is ignored.
  private entryFilledHook:
    | ((input: {
        entrySignalId: string
        positionId: string
        exchange: string
        symbol: string
        accountId: string
        direction: 'long' | 'short'
        fillPrice: number
        stopPrice: number | null
        slOrderId: string | null
        botId: string
        botName?: string
        ladderFrom?: 'entry' | 'now'
        marketExchange?: string
        canonicalSymbol?: string
      }) => Promise<unknown>)
    | null = null;
  // Contract-roll notices (services/futures-roll): report a position left on
  // the outgoing contract; roll it only when the owner opted in
  // (EXECUTOR_AUTO_ROLL=1, wired from main.ts).
  private autoRoll = false;
  private handledRollNotices = new Map<string, number>();

  setAutoRoll(enabled: boolean) {
    this.autoRoll = enabled;
  }

  private async handleRollNotice(signal: Signal): Promise<void> {
    // The same roll is announced live and again at each engine boot for a
    // week; one report per notice per executor session is enough.
    const seenAt = this.handledRollNotices.get(signal.id);
    if (seenAt && Date.now() - seenAt < 6 * 60 * 60_000) return;
    this.handledRollNotices.set(signal.id, Date.now());
    try {
      await handleFuturesRollNotice(signal, {
        db: this.db,
        exchangeManager: this.exchangeManager,
        notifications: this.notifications,
        autoRoll: this.autoRoll,
        retireBracket: (exchange, signalId) => this.retireBracket(exchange, signalId),
      });
    } catch (err: any) {
      this.db.log('error', 'trading', 'Roll notice handling failed', { signalId: signal.id, error: err?.message });
    }
  }

  setEntryFilledHook(fn: typeof this.entryFilledHook) {
    this.entryFilledHook = fn;
  }

  setStaleOpenWindowMs(ms: number) {
    this.staleOpenWindowMs = ms;
  }

  setClock(fn: () => number) {
    this.now = fn;
  }

  setDeferConfig(partial: Partial<DeferConfig>) {
    this.deferConfig = { ...this.deferConfig, ...partial };
  }

  setPositionsCacheTtlMs(ms: number) {
    this.positionsCacheTtlMs = ms;
  }

  // Tune the order-settlement poll cadence (tests use tiny values to keep the
  // unknown-outcome path fast).
  setSettleOptions(attempts: number, intervalMs: number) {
    this.settleAttempts = attempts;
    this.settleIntervalMs = intervalMs;
  }

  // Tune the liveness watchdog (tests use tiny values).
  setStalenessTimeoutMs(ms: number) {
    this.stalenessTimeoutMs = ms;
  }

  // Tune the handshake timeout (tests use tiny values).
  setConnectTimeoutMs(ms: number) {
    this.connectTimeoutMs = ms;
  }

  // Drop the current socket whatever state it is in and dial again through
  // the backoff path. terminate() on a hung socket may never fire 'close' (the
  // 2026-09-06 blip left the client 'closing' for good, no reconnect logged),
  // so the socket is detached first — its late events can no longer touch the
  // client — and the reconnect is scheduled directly.
  private forceReconnect(reason: string): void {
    this.db.log('warn', 'connection', 'Forcing signal WS reconnect', { reason });
    this.stopStalenessWatchdog();
    this.detachSocket();
    if (this.reconnectingSince == null) this.reconnectingSince = Date.now();
    this.scheduleReconnect();
  }

  private detachSocket(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    const old = this.ws;
    this.ws = null;
    if (!old) return;
    old.removeAllListeners();
    old.on('error', () => {
      /* detached socket: swallow late errors */
    });
    try {
      old.terminate();
    } catch {
      /* already gone */
    }
  }

  // ── Liveness watchdog (EX8) ──
  // Started on 'open', fed by every inbound message. When nothing has arrived
  // for stalenessTimeoutMs, terminate the socket — the 'close' event then rides
  // the existing backoff/reconnect path. Without this, an asymmetric network
  // failure leaves the executor reporting "connected" while receiving no
  // signals at all (the server pings; the client never verified).
  private startStalenessWatchdog() {
    this.stopStalenessWatchdog();
    this.lastInboundAt = Date.now();
    const checkEvery = Math.max(1, Math.floor(this.stalenessTimeoutMs / 3));
    this.stalenessTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const silentFor = Date.now() - this.lastInboundAt;
      if (silentFor < this.stalenessTimeoutMs) return;
      this.db.log('warn', 'connection', 'No inbound WS traffic — forcing reconnect', {
        silentForMs: silentFor,
        timeoutMs: this.stalenessTimeoutMs,
      });
      this.forceReconnect('no inbound traffic');
    }, checkEvery);
  }

  private stopStalenessWatchdog() {
    if (this.stalenessTimer) {
      clearInterval(this.stalenessTimer);
      this.stalenessTimer = null;
    }
  }

  // Wire the remote-companion control plane. `deps` carries the db +
  // exchangeManager + companion service the command handler dispatches to;
  // `statePusher` pushes state snapshots up (gated on companion-enabled). Both
  // injected by main.ts after construction so the WS client stays decoupled.
  setCompanion(deps: ExecutorCommandDeps, statePusher: StatePusher) {
    this.companionDeps = deps;
    this.statePusher = statePusher;
  }

  // The API base URL once connected, for sibling services (e.g. the portfolio
  // shipper) that POST to the same backend. Null until connect() runs.
  getApiUrl(): string | null {
    return this.apiUrl;
  }

  // The per-user API key the WS authenticates with. Sibling REST calls (ack,
  // portfolio ingest) send it so the server resolves the SAME user from the key
  // hash instead of a shared session secret. Null until connect() runs.
  getApiKey(): string | null {
    return this.apiKey;
  }

  // The user's own local-trailing parameters, read from their executor settings
  // (settings.localTrailing). These are the USER's risk tooling, NOT proprietary
  // strategy output: the executor never sources trail distance from the inbound
  // signal's order_plan (that is the server's IP). Returns null when the user has
  // not configured local trailing — in which case no local trail is registered
  // (the executor injects no defaults on the user's behalf).
  private getLocalTrailingSettings(): {
    trailPercentage: number | null;
    trailPoints: number | null;
    maxPercentage: number | null;
    maxPoints: number | null;
    breakevenFee: number | null;
  } | null {
    try {
      const user = this.db.getAdminUser();
      if (!user?.settings) return null;
      const parsed = JSON.parse(user.settings) as {
        localTrailing?: {
          enabled?: boolean;
          trailPercentage?: number | null;
          trailPoints?: number | null;
          maxPercentage?: number | null;
          maxPoints?: number | null;
          breakevenFee?: number | null;
        };
      };
      const t = parsed.localTrailing;
      if (!t || t.enabled === false) return null;
      const pct = typeof t.trailPercentage === 'number' ? t.trailPercentage : null;
      const pts = typeof t.trailPoints === 'number' ? t.trailPoints : null;
      // No distance configured → nothing to trail.
      if ((pct == null || pct <= 0) && (pts == null || pts <= 0)) return null;
      return {
        trailPercentage: pct,
        trailPoints: pts,
        maxPercentage: typeof t.maxPercentage === 'number' ? t.maxPercentage : null,
        maxPoints: typeof t.maxPoints === 'number' ? t.maxPoints : null,
        breakevenFee: typeof t.breakevenFee === 'number' ? t.breakevenFee : null,
      };
    } catch {
      return null;
    }
  }

  connect(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.isIntentionallyClosed = false;
    // reconnectAttempts resets on 'open', NOT here: the reconnect timer calls
    // connect(), so resetting here would pin the backoff at its first step and
    // keep the sustained-outage alert from ever firing.

    // Convert http(s) to ws(s)
    const wsUrl = apiUrl.replace(/^http/, 'ws');

    // Prefer session token (MVP shortcut) if configured, fallback to apiKey
    const sessionToken = process.env.EXECUTOR_SESSION_TOKEN;
    const authQuery = sessionToken
      ? `sessionToken=${encodeURIComponent(sessionToken)}`
      : `apiKey=${encodeURIComponent(apiKey)}`;
    // Version telemetry rides in the handshake URL so the API can record what's
    // deployed and gate ancient executors before the upgrade completes.
    const telemetry =
      `v=${encodeURIComponent(EXECUTOR_VERSION)}` +
      `&buildType=${encodeURIComponent(getBuildType())}` +
      `&platform=${encodeURIComponent(EXECUTOR_PLATFORM)}`;
    const fullUrl = `${wsUrl}/api/ws/signals?${authQuery}&${telemetry}`;

    // One socket at a time: a previous generation (open, connecting or stuck
    // closing) is detached, never awaited.
    this.detachSocket();
    try {
      this.ws = new WebSocket(fullUrl);
      this.setupEventHandlers();
      this.db.log('info', 'connection', 'Attempting to connect to signal service', {
        url: wsUrl,
        authMode: sessionToken ? 'session' : 'apiKey',
      });
      // connecting → closed with backoff when the handshake never completes.
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (this.ws && this.ws.readyState !== WebSocket.OPEN && !this.isIntentionallyClosed) {
          this.forceReconnect('handshake timeout');
        }
      }, this.connectTimeoutMs);
    } catch (error: any) {
      this.db.log('error', 'connection', 'Failed to create WebSocket connection', { error: error.message });
      this.scheduleReconnect();
    }
  }

  private setupEventHandlers() {
    if (!this.ws) return;

    this.ws.on('open', () => {
      this.db.log('info', 'connection', 'Connected to signal service');
      this.reconnectAttempts = 0;
      this.reconnectingSince = null;
      this.conflictSince = null;
      // NOT the conflict streak (consecutiveConflictCloses/firstConflictCloseAt):
      // 'open' fires even on a connection the hub immediately closes with 4409
      // (the handshake completes before the close frame is processed), so
      // resetting the streak here would erase it before the close handler ever
      // sees two in a row. The streak resets on any close that ISN'T 4409.
      if (this.connectTimer) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
      if (this.reconnectInterval) {
        clearTimeout(this.reconnectInterval);
        this.reconnectInterval = null;
      }
      // Request replay of signals missed during downtime
      if (this.lastConnectedAt) {
        this.sendMessage({
          type: 'request_missed',
          since: this.lastConnectedAt.toISOString(),
        });
        this.db.log('info', 'connection', 'Requested missed signals replay', {
          since: this.lastConnectedAt.toISOString(),
        });
      }
      if (this.wasConnected) {
        this.notifications?.publish({
          type: 'connection_restored',
          title: 'Signal service reconnected',
          body: 'KaiBot Terminal is back online.',
        });
      }
      this.lastConnectedAt = new Date();
      this.wasConnected = true;
      this.startStalenessWatchdog();

      // Push a fresh companion snapshot on (re)connect so the phone gets the
      // current state immediately (no-op while remote management is off).
      void this.statePusher?.pushImmediate();
    });

    this.ws.on('message', (data) => {
      this.lastInboundAt = Date.now();
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error: any) {
        this.db.log('error', 'signal', 'Failed to parse WebSocket message', { error: error.message });
      }
    });

    this.ws.on('error', (error) => {
      this.db.log('error', 'connection', 'WebSocket error', { error: error.message });
    });

    // The API gates executors below minExecutorVersion at the HTTP upgrade with
    // a 426. Reconnecting won't help — only an update will — so stop the loop
    // and surface a clear, actionable message instead of hammering the server.
    this.ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 426) {
        this.isIntentionallyClosed = true;
        if (this.reconnectInterval) {
          clearTimeout(this.reconnectInterval);
          this.reconnectInterval = null;
        }
        const required = res.headers['x-min-executor-version'];
        this.db.log('error', 'connection', 'Executor version rejected by signal service (426)', {
          current: EXECUTOR_VERSION,
          required,
        });
        this.notifications?.publish({
          type: 'update_required',
          title: 'Update required',
          body: `This executor (v${EXECUTOR_VERSION}) is too old to connect${required ? `; v${required}+ required` : ''}. Please update.`,
          data: { current: EXECUTOR_VERSION, required },
        });
      } else {
        // Any OTHER non-101 (401 during a key rotation, 502/503 from the LB
        // during a deploy): registering this listener suppresses ws's default
        // abortHandshake, so without this branch no 'close'/'error' fires and the
        // executor sits 'connecting' forever with positions unmanaged. Abort and
        // reconnect.
        this.db.log('warn', 'connection', `Signal WS handshake rejected (${res.statusCode}); will retry`, {
          statusCode: res.statusCode,
        });
        try { (res as any).destroy?.(); } catch { /* best-effort */ }
        if (!this.isIntentionallyClosed) this.forceReconnect(`handshake ${res.statusCode}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      this.stopStalenessWatchdog();
      this.db.log('info', 'connection', 'WebSocket connection closed', {
        code,
        reason: reason.toString(),
        intentional: this.isIntentionallyClosed
      });

      if (!this.isIntentionallyClosed) {
        if (this.reconnectingSince == null) this.reconnectingSince = Date.now();

        if (code === EXECUTOR_CONFLICT_CLOSE_CODE) {
          const now = Date.now();
          if (
            this.firstConflictCloseAt == null ||
            now - this.firstConflictCloseAt > EXECUTOR_CONFLICT_CONFIRM_WINDOW_MS
          ) {
            this.firstConflictCloseAt = now;
            this.consecutiveConflictCloses = 1;
          } else {
            this.consecutiveConflictCloses++;
          }

          if (this.consecutiveConflictCloses < EXECUTOR_CONFLICT_CONFIRM_COUNT) {
            // Could be our own reconnect racing the hub's stale-socket cleanup
            // rather than a real second machine (see planNewExecutorSocket
            // server-side). Don't alarm the user over a single occurrence,
            // just retry promptly like any other transient close.
            this.db.log(
              'warn',
              'connection',
              'Got a 4409 (executor conflict) once, retrying before treating it as a standing conflict',
              { code, consecutive: this.consecutiveConflictCloses },
            );
            this.notifications?.publish({
              type: 'connection_lost',
              title: 'Signal service disconnected',
              body: `Connection closed (code ${code}). Reconnecting…`,
              data: { code, reason: reason.toString() },
            });
            this.scheduleReconnect();
            return;
          }

          // Confirmed: at least two in a row within the window, so another
          // paired machine really does hold this account's only executor
          // slot. Retrying on the normal (fast, early) backoff would just get
          // rejected again for as long as that one stays connected, so back
          // off harder and say plainly why, instead of the generic
          // "reconnecting" spam.
          this.conflictSince = now;
          this.db.log('warn', 'connection', 'Another executor is already connected for this account', {
            code,
            consecutive: this.consecutiveConflictCloses,
          });
          this.notifications?.publish({
            type: 'executor_conflict',
            title: 'Another executor is connected',
            body: 'This account already has an executor connected elsewhere. Signals go to that one only until it disconnects.',
            data: { code },
          });
          this.scheduleReconnect(true);
          return;
        }

        // Any other close breaks a conflict streak: whatever this was, it
        // was not another 4409 immediately following the last one.
        this.consecutiveConflictCloses = 0;
        this.firstConflictCloseAt = null;

        this.notifications?.publish({
          type: 'connection_lost',
          title: 'Signal service disconnected',
          body: `Connection closed (code ${code}). Reconnecting…`,
          data: { code, reason: reason.toString() },
        });
        this.scheduleReconnect();
      }
    });
  }

  private handleMessage(message: any) {
    switch (message.type) {
      case 'connected':
        this.db.log('info', 'connection', 'Signal service connection confirmed', { userId: message.userId });
        break;

      case 'ping':
        this.sendMessage({ type: 'pong' });
        break;

      case 'signal':
        this.handleSignal(message.signal);
        break;

      case 'missed_signals':
        this.handleMissedSignals(message.signals || []);
        break;

      case 'executor_command':
        // Remote-companion command relayed by the API. The body is an opaque
        // sealed blob; open it, dispatch through the gated handler, reply with a
        // sealed result. Fire-and-forget — the reply rides the same socket.
        void this.handleExecutorCommandMessage(message);
        break;

      case 'update_available':
        // Soft window: a newer version is out but we're still above the hard
        // floor. Surface a banner, don't disrupt anything.
        this.updateInfo = {
          latestVersion: String(message.latestVersion ?? ''),
          current: EXECUTOR_VERSION,
        };
        this.db.log('info', 'connection', 'Update available', this.updateInfo);
        this.notifications?.publish({
          type: 'update_available',
          title: 'Update available',
          body: `A newer KaiBot Terminal (v${message.latestVersion}) is available. You're on v${EXECUTOR_VERSION}.`,
          data: this.updateInfo,
        });
        break;

      case 'error':
        this.db.log('error', 'signal', 'Signal service error', { message: message.message });
        break;

      default:
        this.db.log('warn', 'signal', 'Unknown message type', { type: message.type });
    }
  }

  // Process a relayed `executor_command`: open the sealed blob, dispatch through
  // the companion handler, reply with `executor_command_result`. The `error` code
  // is CLEARTEXT (companion_disabled / not_paired / unknown_command / bad_payload
  // / generic); only the `resultBlob` is sealed. A mutation that succeeds nudges a
  // fresh state push so the phone sees the change without polling.
  private async handleExecutorCommandMessage(message: any): Promise<void> {
    const cmdId = message?.cmdId;
    // No companion wired → definitionally off. Reply with the cleartext refusal.
    if (!this.companionDeps) {
      this.sendMessage({ type: 'executor_command_result', cmdId, ok: false, error: 'companion_disabled' });
      return;
    }

    if (typeof message?.blob !== 'string' || typeof cmdId !== 'string') {
      this.sendMessage({ type: 'executor_command_result', cmdId, ok: false, error: 'bad_payload' });
      return;
    }

    // The handler owns the keyed open() (pairing window vs sealed command). It
    // never throws; a failed AEAD-open maps to `bad_payload`.
    let result;
    try {
      result = await handleExecutorCommand(this.companionDeps, message.blob, cmdId);
    } catch (err: any) {
      this.sendMessage({
        type: 'executor_command_result',
        cmdId,
        ok: false,
        error: err?.message ?? String(err),
      });
      return;
    }

    // Pairing replies (`pair` plaintext / `pairConfirm` sealed) arrive wire-ready
    // as result.resultBlob — forward verbatim. A normal command's cleartext result
    // is sealed here with the paired session key (aad `${cmdId}:result`).
    const resultBlob = result.ok
      ? (result.resultBlob ?? sealResult(this.companionDeps.companion, result.result, cmdId) ?? undefined)
      : undefined;

    this.sendMessage({
      type: 'executor_command_result',
      cmdId,
      ok: result.ok,
      resultBlob,
      error: result.error,
    });

    // A successful mutating command (or a fresh pairConfirm) changed local state
    // or gained a reader — push a snapshot so the companion reflects it promptly.
    // The handler flags `mutated`; a plain read (getState) does not.
    if (result.mutated) {
      this.statePusher?.pushStateNow();
    }
  }

  private async handleMissedSignals(signals: Signal[]) {
    this.db.log('info', 'signal', 'Processing missed signals replay', { count: signals.length });
    for (const signal of signals) {
      const age = Date.now() - new Date(signal.received_at ?? signal.created_at ?? Date.now()).getTime();

      // Roll notices are never recorded as signals: a replayed one is handled
      // while the roll is recent, dropped silently after (no row, no ack).
      if ((signal.action as string) === 'roll') {
        if (age <= ROLL_NOTICE_REPLAY_WINDOW_MS) await this.handleSignal(signal);
        else this.db.recordSignalQueue({ signalId: signal.id, action: signal.action, reason: 'roll_stale', metadata: { ageMs: age } });
        continue;
      }

      // Locally terminal → this executor already finished the signal and acked
      // it; a replayed copy must not run again OR re-ack (2026-09-04: the
      // replayed close 89ec2b65's second executed-ack closed the WRONG — one
      // hour newer — position row server-side). "Missed" means never received;
      // a signal in our own table was received.
      const localStatus = this.db.getSignalStatus?.(signal.id);
      if (localStatus === 'executed' || localStatus === 'closed') {
        this.db.log('info', 'signal', 'Replay skipped: signal already terminal locally', {
          signalId: signal.id,
          action: signal.action,
          localStatus,
        });
        this.db.recordSignalQueue({
          signalId: signal.id,
          action: signal.action,
          reason: 'replay_already_terminal',
          metadata: { localStatus, ageMs: age },
        });
        continue;
      }

      // Parked for market open: the poller owns it. A replayed copy must not
      // stale-drop it (that would reject the entry the deferral exists for).
      if (localStatus === 'deferred') {
        this.db.log('info', 'signal', 'Replay skipped: entry waiting for market open', {
          signalId: signal.id,
          ageMs: age,
        });
        this.db.recordSignalQueue({
          signalId: signal.id,
          action: signal.action,
          reason: 'replay_deferred',
          metadata: { ageMs: age },
        });
        continue;
      }

      // Close signals always replay to avoid orphaned positions
      if (signal.action === 'close') {
        this.db.recordSignalQueue({
          signalId: signal.id,
          action: signal.action,
          reason: 'close_replay',
          metadata: { ageMs: age },
        });
        await this.handleSignal(signal);
        continue;
      }

      // Open signals beyond the stale window get dropped
      if (age > this.staleOpenWindowMs) {
        this.db.log('warn', 'signal', 'Dropping stale open signal on replay', {
          signalId: signal.id,
          ageMs: age,
          windowMs: this.staleOpenWindowMs,
        });
        this.db.recordSignalQueue({
          signalId: signal.id,
          action: signal.action,
          reason: 'stale_open',
          metadata: { ageMs: age },
        });
        try {
          await this.db.recordSignal({
            id: signal.id,
            strategyId: signal.strategy_id,
            strategyName: signal.strategy_name,
            symbol: signal.symbol,
            action: signal.action,
            quantity: signal.quantity,
            price: signal.price,
            type: signal.type,
            confidence: signal.confidence,
            metadata: signal.metadata,
          });
          this.db.updateSignalStatus(signal.id, 'expired', undefined, 'stale on replay');
        } catch {
          /* row may already exist */
        }
        await this.ackToApi(signal.id, 'rejected', undefined, 'stale on replay');
        continue;
      }

      // Within window — execute normally
      this.db.recordSignalQueue({
        signalId: signal.id,
        action: signal.action,
        reason: 'within_window_replay',
        metadata: { ageMs: age },
      });
      await this.handleSignal(signal);
    }
  }

  // Resolve the exchange this signal will execute on, for the per-exchange
  // order lock. Uses the same inputs the full pipeline resolves the venue from
  // (subscription exchange, then signal metadata) so the lock key always matches
  // the venue the inner handler orders on. Unresolvable venues share a fallback
  // key — those signals are rejected inside without placing an order, so the
  // shared key only serializes bookkeeping.
  private resolveOrderLockKey(signal: Signal): string {
    try {
      const signalBotId =
        (signal.metadata?.signalBotId as string | undefined) ??
        (signal.metadata?.signal_bot_id as string | undefined);
      const sub = signalBotId ? this.db.getSubscriptionForBot(signalBotId) : null;
      const venue = resolveVenue({
        subscriptionExchange: sub?.exchange as string | undefined,
        signalMetadataExchange: signal.metadata?.exchange as string | undefined,
      });
      return venue.exchange ?? '';
    } catch {
      return '';
    }
  }

  // Public entry point. Serializes the whole signal lifecycle (open / reduce /
  // close) through the per-exchange order lock so two near-simultaneous signals
  // on the same venue never race past each other's guards and double-place an
  // order — while a stalled venue no longer freezes the others. Recording/ack
  // work inside is cheap and harmless to serialize.
  private handleSignal(signal: Signal): Promise<void> {
    return withOrderLock(this.resolveOrderLockKey(signal), () => this.handleSignalInner(signal))
  }

  // Local entry into the existing order path: run a Signal through the SAME
  // serialized, lock-guarded path the server-WS `signal` message triggers, so
  // every guard / sizing / bracket step runs identically. The executor runs no
  // strategy itself — signals come from the server (the brain). Kept public for
  // ops/test injection of an already-decided signal.
  public ingestLocalSignal(signal: Signal): Promise<void> {
    return withOrderLock(this.resolveOrderLockKey(signal), () => this.handleSignalInner(signal))
  }

  private async handleSignalInner(signal: Signal, opts: { resumedDeferral?: boolean } = {}) {
    // Wire copy taken before the venue remap mutates symbol/action: a deferred
    // entry is persisted from, and resumed with, exactly this shape.
    const wireSignal: Signal = structuredClone(signal);
    const resumed = opts.resumedDeferral === true;
    // Not a trade: no signals row, no ack, no sizing. Handled under the same
    // venue lock so it never interleaves with a close on that contract.
    if ((signal.action as string) === 'roll') {
      await this.handleRollNotice(signal);
      return;
    }
    try {
      if (!resumed) {
      this.db.log('info', 'signal', 'Received signal', {
        id: signal.id,
        action: signal.action,
        symbol: signal.symbol,
        stopLoss: signal.stop_loss,
        takeProfit: signal.take_profit,
      });

      this.notifications?.publish({
        type: 'signal_received',
        title: 'Signal received',
        body: `${signal.action.toUpperCase()} ${signal.quantity ?? ''} ${signal.symbol}${signal.strategy_name ? ` — ${signal.strategy_name}` : ''}`.trim(),
        data: {
          signalId: signal.id,
          symbol: signal.symbol,
          action: signal.action,
          quantity: signal.quantity,
          strategy: signal.strategy_name,
        },
      });

      // Record the signal in database (map snake_case → camelCase)
      try {
        await this.db.recordSignal({
          id: signal.id,
          strategyId: signal.strategy_id,
          strategyName: signal.strategy_name,
          symbol: signal.symbol,
          action: signal.action,
          quantity: signal.quantity,
          price: signal.price,
          type: signal.type,
          confidence: signal.confidence,
          stopLoss: signal.stop_loss,
          takeProfit: signal.take_profit,
          metadata: signal.metadata,
        });
      } catch {
        /* replay or dupe — row may exist */
      }

      // Send acknowledgment
      this.sendMessage({
        type: 'signal_ack',
        signalId: signal.id,
      });
      }

      // ─── Resolve subscription (null for unsubscribed) ───
      const signalBotId =
        (signal.metadata?.signalBotId as string | undefined) ??
        (signal.metadata?.signal_bot_id as string | undefined);
      let sub = signalBotId ? this.db.getSubscriptionForBot(signalBotId) : null;

      // Discretionary trading is a built-in per-user bot. The FIRST discretionary
      // signal auto-provisions a LOCAL subscription (the size base, default
      // factor 1) which the user can then tune in the Subscriptions UI. Without
      // it the signal would carry no base and skip factor scaling entirely.
      // Guard on existence by id (ANY status): getSubscriptionForBot filters
      // active-only, so re-provisioning here would silently un-pause a paused
      // subscription and wipe its factor/maxPositionSize/size_unit back to
      // defaults. A paused sub stays paused (this signal runs unscaled).
      if (
        !sub &&
        signalBotId &&
        signal.metadata?.source === 'discretionary' &&
        !this.db.getSubscription(signalBotId)
      ) {
        // A TradingView-webhook source rides its own bot and carries its name in
        // metadata.botName, so the auto-provisioned local subscription shows the
        // source name instead of the generic "Discretionary" label.
        const botName = (signal.metadata?.botName as string | undefined) ?? 'Discretionary';
        this.db.upsertSubscription({
          id: signalBotId,
          signalBotId,
          botName,
          selectedMarkets: [],
          factor: 1,
          status: 'active',
        });
        sub = this.db.getSubscriptionForBot(signalBotId);
        this.db.log('info', 'subscription', 'Auto-provisioned discretionary subscription', {
          signalBotId,
        });
      }

      // Take-over guard rail (F3): a detached/paused bot config means the user
      // took the position over — the bot may never touch it again. Enforced
      // HERE (not via the config row alone) because subscription status is the
      // only other runtime gate; this covers entries, adds AND closes.
      if (signalBotId) {
        const configs = this.db
          .getBotConfigs(false)
          .filter((c) => c.signalBotId === signalBotId);
        if (botConfigsBlockSignal(configs, signal.symbol)) {
          this.db.log('warn', 'signal', 'Bot detached (take-over) — signal dropped', {
            signalId: signal.id,
            signalBotId,
            symbol: signal.symbol,
            action: signal.action,
          });
          this.db.recordSignalQueue({
            signalId: signal.id,
            action: signal.action,
            reason: 'bot_detached',
            metadata: { signalBotId },
          });
          this.db.updateSignalStatus(signal.id, 'rejected', undefined, 'bot detached (take-over)');
          await this.ackToApi(signal.id, 'rejected', undefined, 'bot detached (take-over)');
          return;
        }
        // Phase-out clip (ride-bot phase 2): the server no longer emits
        // entries for a phasing-out run, but a replayed / in-flight one must
        // not open anything either. Closes, updates and adds inside a
        // position pass — the bot finishes what it holds.
        const isEntryAction =
          (signal.action === 'buy' || signal.action === 'sell') &&
          signal.metadata?.add !== true &&
          signal.metadata?.virtualClose !== true;
        if (isEntryAction && botConfigsClipEntry(configs, signal.symbol)) {
          this.db.log('warn', 'signal', 'Bot phasing out — entry clipped', {
            signalId: signal.id,
            signalBotId,
            symbol: signal.symbol,
          });
          this.db.recordSignalQueue({
            signalId: signal.id,
            action: signal.action,
            reason: 'bot_phasing_out',
            metadata: { signalBotId },
          });
          this.db.updateSignalStatus(signal.id, 'rejected', undefined, 'bot phasing out (no new entries)');
          await this.ackToApi(signal.id, 'rejected', undefined, 'bot phasing out (no new entries)');
          return;
        }
      }

      // Paused subscription → queue + drop
      if (sub && sub.status === 'paused') {
        this.db.log('info', 'signal', 'Subscription paused, dropping signal', {
          signalId: signal.id,
          subscriptionId: sub.id,
        });
        this.db.recordSignalQueue({
          signalId: signal.id,
          action: signal.action,
          reason: 'sub_paused',
          metadata: { subscriptionId: sub.id },
        });
        this.db.updateSignalStatus(signal.id, 'rejected', undefined, 'subscription paused');
        await this.ackToApi(signal.id, 'rejected', undefined, 'subscription paused');
        return;
      }

      // A bot routed to several connections ([ALLOC] subs): a close must run
      // on the subscription whose connection holds this lineage, not on the
      // bot's first sub (2026-09-22, Fault-Line ETH adopted on acct1 while the
      // default connection's ETH belonged to a ride bot).
      if (signalBotId && (signal.action === 'close' || signal.metadata?.virtualClose === true)) {
        sub = this.subForLineageClose(signalBotId, signal.symbol, sub);
      }

      // A close / cancel for a lineage whose entry is still waiting for market
      // open retires that entry first: the position it targets never existed
      // on the venue, so the close below ends as a no-op ack.
      if (
        signal.action === 'close' ||
        signal.metadata?.virtualClose === true ||
        (signal.action as string) === 'cancel'
      ) {
        await this.cancelDeferredEntriesFor(signal, sub);
      }

      // Close signals pass through without factor scaling (avoid orphaning positions)
      if (signal.action === 'close') {
        return this.executeCloseSignal(signal, sub);
      }

      // Net-delta virtual close (2026-09-03, MNQ lead-trail exit): the server
      // wires a mixed-book close as a plain buy/sell with metadata
      // {virtualClose:true, positionId} — its MEANING is "flatten this virtual
      // position's lineage", never "open a position". Before this branch the
      // executor ran it through the ENTRY path: a phantom opposite execution
      // in the book, the real exit unbooked, and the lineage's GTC stop left
      // resting on a flat account (order 1304545343). Route it through the
      // close path: bracket legs cancel first, the flatten sizes against the
      // lineage's own tracked book, the fill books as the lineage's exit and
      // the executed ack hits the server's virtualClosePositionId branch.
      if (signal.metadata?.virtualClose === true) {
        this.db.log('info', 'signal', 'Virtual close routed through the close path', {
          signalId: signal.id,
          symbol: signal.symbol,
          wireAction: signal.action,
          positionId: signal.metadata?.positionId,
        });
        signal.action = 'close';
        return this.executeCloseSignal(signal, sub);
      }

      if (!this.exchangeManager) {
        this.db.log('error', 'signal', 'No exchange manager configured', { signalId: signal.id });
        this.db.updateSignalStatus(signal.id, 'rejected', undefined, 'exchange manager not configured');
        await this.ackToApi(signal.id, 'rejected', undefined, 'exchange manager not configured');
        return;
      }

      // Subscription venue wins; a legacy per-venue signal may name its own.
      // Composite signals ('index') carry NO venue — unresolvable is a loud
      // reject, never a default venue.
      const venue = resolveVenue({
        subscriptionExchange: sub?.exchange as string | undefined,
        signalMetadataExchange: signal.metadata?.exchange as string | undefined,
      });
      if (!venue.exchange) {
        this.db.log('error', 'signal', 'No execution venue resolvable', {
          signalId: signal.id,
          symbol: signal.symbol,
          reason: venue.rejectReason,
        });
        this.db.updateSignalStatus(signal.id, 'rejected', undefined, venue.rejectReason!);
        await this.ackToApi(signal.id, 'rejected', undefined, venue.rejectReason!);
        return;
      }
      const exchangeName = venue.exchange;

      // Canonical -> venue-native symbol. The canonical stays in the recorded
      // signal + market filter; every sizing/guard/order step below works on
      // the venue symbol.
      const canonicalSymbol = signal.symbol;
      const mapping = mapToVenueSymbol(exchangeName, signal.symbol, signal.metadata?.venueSymbols);
      if (!mapping.venueSymbol) {
        this.db.log('error', 'signal', 'Canonical symbol has no venue mapping', {
          signalId: signal.id,
          symbol: signal.symbol,
          exchange: exchangeName,
        });
        this.db.updateSignalStatus(signal.id, 'rejected', undefined, mapping.rejectReason!);
        await this.ackToApi(signal.id, 'rejected', undefined, mapping.rejectReason!);
        return;
      }
      signal.symbol = mapping.venueSymbol;

      // Registry-added symbols aren't in the static constraints map; fetch
      // min/step from the venue before any sizing/rounding uses them.
      await ensureContractConstraints(exchangeName, signal.symbol);

      // Resolved once; every sizing step, guard and the order itself key off it.
      const sizingAccount = this.subAccountId(sub, exchangeName, signal.symbol);
      const session = await this.sessionForAccount(exchangeName, sizingAccount);

      if (!session || session.status !== 'connected') {
        const reason = session ? `session status ${session.status}` : 'no session for exchange';
        this.db.log('error', 'signal', 'No connected exchange session', {
          signalId: signal.id,
          exchange: exchangeName,
          reason,
        });
        this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
        await this.ackToApi(signal.id, 'rejected', undefined, reason);
        return;
      }

      // Carve-out (R10 / INV9): the legacy Model-B stop_update stays REFUSED
      // outright — that wire name belonged to the removed server-side
      // position-manager and must never execute again.
      if ((signal.action as string) === 'stop_update') {
        const reason = 'server stop_update refused: exits are managed locally, not by the server';
        this.db.log('warn', 'signal', 'Refused server-pushed stop_update', { signalId: signal.id });
        this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
        await this.ackToApi(signal.id, 'rejected', undefined, reason);
        return;
      }

      // Exit-as-signal-update: an `update` is a follow-up signal on an entry
      // (keyed by metadata.positionId) emitted by the strategy the USER
      // deployed — not a KaiBot-authored stop move. Accepted ONLY for
      // positions the entry opened with exitAuthority:'server' (gate row in
      // server_exit_state), monotonically (exitSeq), and sharpen-only. Every
      // other update is refused exactly like the legacy stop_update.
      if ((signal.action as string) === 'update') {
        await this.handleServerExitUpdate(signal, session, exchangeName);
        return;
      }

      // User-initiated cancel (relayed by the server from the user's own
      // cancel action; the old pending-sweeper is gone): cancel the entry's
      // RESTING order(s) on the exchange. No sizing, no new position.
      if ((signal.action as string) === 'cancel') {
        await this.handleCancel(signal, session, exchangeName);
        return;
      }

      if (!signal.quantity || signal.quantity <= 0) {
        this.db.updateSignalStatus(signal.id, 'rejected', undefined, 'invalid quantity');
        await this.ackToApi(signal.id, 'rejected', undefined, 'invalid quantity');
        return;
      }

      // ─── Local halt gate (panic-&-halt or a daily-loss trip) ───
      // When the executor is halted, refuse to OPEN anything until the user (or
      // the daily-loss trip's owner) re-enables it. Close / cancel already
      // returned above — they only reduce risk, so they're never halted.
      // This is the offline-proof kill switch: it's local state checked here, so
      // it bites even with the cloud down. Defensive on getHaltState (some test
      // doubles omit it) — a missing method means "not halted".
      if (typeof this.db.getHaltState === 'function' && this.db.getHaltState().halted) {
        const reason = 'executor halted (panic / daily-loss); not opening new positions';
        this.db.log('warn', 'signal', 'Signal rejected — executor halted', {
          signalId: signal.id,
          symbol: signal.symbol,
        });
        this.notifyGuardReject(signal, 'executor halt', reason);
        this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
        await this.ackToApi(signal.id, 'rejected', undefined, reason);
        return;
      }

      // ─── Market filter (selected_markets on the sub) ───
      // Matched on the CANONICAL symbol: composite subscriptions select 'BTC',
      // not the venue instrument (legacy subs stored the venue symbol, which
      // equals canonicalSymbol for legacy signals).
      if (sub?.selected_markets) {
        try {
          const markets = JSON.parse(sub.selected_markets) as string[];
          if (markets.length > 0 && !markets.includes(canonicalSymbol)) {
            this.db.log('info', 'signal', 'Signal symbol not in subscribed markets, skipping', {
              signalId: signal.id,
              symbol: canonicalSymbol,
              selected: markets,
            });
            this.db.updateSignalStatus(signal.id, 'rejected', undefined, 'symbol not in selected markets');
            await this.ackToApi(signal.id, 'rejected', undefined, 'symbol not in selected markets');
            return;
          }
        } catch {
          /* malformed JSON, fall through */
        }
      }

      // ─── Basis guard (entries only; closes/cancels returned above) ───
      // A composite signal prices on the index feed; if this venue has drifted
      // past the threshold, entering "at the signal" is no longer the trade the
      // strategy decided. Venue price unobtainable → fail-open + flagged event
      // (set BASIS_GUARD_FAIL_CLOSED=1 to block instead).
      // Skipped entirely when the adapter has no public ticker (mirrors
      // market-guard's "no way to tell → don't block").
      if (signal.price && signal.price > 0 && typeof session.adapter.getLastPrice === 'function') {
        // Only the adapter's public ticker — deliberately no positions
        // fallback (sizing paths must not gain a positions dependency).
        let venuePrice: number | null = null;
        try {
          venuePrice = (await session.adapter.getLastPrice(signal.symbol)) ?? null;
        } catch {
          /* inconclusive below */
        }
        const subThreshold = sub?.basis_guard_bps != null ? Number(sub.basis_guard_bps) : null;
        const basis = checkBasis({ signalPrice: signal.price, venuePrice, thresholdBps: subThreshold });
        if (basis.inconclusive) {
          if (process.env.BASIS_GUARD_FAIL_CLOSED === '1') {
            const reason = 'basis guard: venue price unavailable (fail-closed)';
            this.db.recordSignalQueue({ signalId: signal.id, action: signal.action, reason: 'basis_guard' });
            this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
            await this.ackToApi(signal.id, 'rejected', undefined, reason);
            return;
          }
          this.db.log('warn', 'signal', 'Basis guard inconclusive — executing anyway', {
            signalId: signal.id,
            symbol: signal.symbol,
            exchange: exchangeName,
          });
          this.notifications?.publish({
            type: 'basis_guard_inconclusive',
            title: 'Basis guard inconclusive',
            body: `No venue price for ${signal.symbol} on ${exchangeName}; executed without basis check.`,
            data: { signalId: signal.id, symbol: signal.symbol },
          });
        } else if (!basis.ok) {
          const reason = `basis guard: signal ${signal.price} vs venue ${venuePrice} (${basis.deviationBps} bps > ${basis.thresholdBps})`;
          this.db.log('warn', 'signal', 'Basis guard rejected entry', {
            signalId: signal.id,
            symbol: signal.symbol,
            exchange: exchangeName,
            deviationBps: basis.deviationBps,
            thresholdBps: basis.thresholdBps,
          });
          this.db.recordSignalQueue({
            signalId: signal.id,
            action: signal.action,
            reason: 'basis_guard',
            metadata: { deviationBps: basis.deviationBps, thresholdBps: basis.thresholdBps },
          });
          this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
          await this.ackToApi(signal.id, 'rejected', undefined, reason);
          this.notifications?.publish({
            type: 'basis_guard_rejected',
            title: 'Entry skipped: price divergence',
            body: `${signal.symbol} on ${exchangeName} deviates ${basis.deviationBps} bps from the signal price.`,
            data: { signalId: signal.id, symbol: signal.symbol, deviationBps: basis.deviationBps },
          });
          return;
        }
      }

      // ─── Multi-account broker routing guard (entries only) ───
      // TradeStation carries several real AccountIDs behind one session; the
      // 'default' fallback is not one of them. An entry without an explicit
      // subscription account would go to the broker with a bogus AccountID —
      // refuse loudly here (config-time create already rejects this too).
      if (exchangeName === 'tradestation' && sizingAccount === 'default') {
        const reason =
          'no broker account configured on this subscription (tradestation needs an AccountID)';
        this.db.log('error', 'signal', 'Signal rejected — no broker account routed', {
          signalId: signal.id,
          symbol: signal.symbol,
          subscriptionId: sub?.id,
        });
        this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
        await this.ackToApi(signal.id, 'rejected', undefined, reason);
        return;
      }

      // ─── Factor × safety pipeline ───
      const originalQty = signal.quantity;
      let quantity = signal.quantity;
      // Server-side DCA add (position-manager scale_in): a same-side market leg
      // on an EXISTING position. Sized by factor like the seed (qty 1 → 1 factor
      // = 1%), but must NOT be treated as a new concurrent trade.
      const isAdd = signal.metadata?.add === true;

      if (sub) {
        const factor = Number(sub.factor) || 1;
        quantity = originalQty * factor;
        // Size unit: per-subscription config wins, else a per-signal override
        // (tradingview-webhook / drawing-trigger). 'usd' reinterprets the
        // factor-sized quantity as a USD notional (converted below).
        const sizeUnit =
          (sub as { size_unit?: string }).size_unit ?? signal.metadata?.sizeUnit ?? 'native';
        this.db.logSafetyClip({
          signalId: signal.id,
          subscriptionId: sub.id,
          reason: 'factor_applied',
          originalQuantity: originalQty,
          adjustedQuantity: quantity,
        });

        // ─── Synthetic USD sizing basis (synthetic mode) ───
        // A synthetic USD position flagged as the factor basis makes its USD
        // value the account size for this (exchange, account) — every symbol,
        // not just its own market. `quantity` above is then a PERCENT of that
        // value (qty 1 → 1 factor = 1%), converted here to an order quantity
        // BEFORE any contract-unit caps so downstream steps keep comparing
        // like units. No flagged position → quantity stays a contract count.
        const syntheticBasis = getSyntheticSizingBasis(this.db, exchangeName, sizingAccount, signal.symbol);
        if (syntheticBasis) {
          const percent = quantity;
          let price: number | undefined;
          if (!isInverseVenue(exchangeName, signal.symbol)) {
            // Linear venues need a price; same fallback chain as the notional
            // guardrail. Inverse skips this — the notional IS the quantity.
            const positions = await this.getCachedPositions(exchangeName, session.adapter);
            const samePos = positions.find(
              (p) => sizingRoot(p.symbol) === sizingRoot(signal.symbol) && Math.abs(p.size) > 0,
            );
            price = signal.price || samePos?.markPrice || samePos?.entryPrice || undefined;
          }
          const { stepSize } = getContractConstraints(exchangeName, signal.symbol);
          const sizing = percentToQuantity(
            percent,
            syntheticBasis.basisUsd,
            exchangeName,
            signal.symbol,
            stepSize,
            price,
          );
          // Fail closed: a wrongly sized order is worse than a missed one.
          if (sizing.priceMissing) {
            const reason = 'synthetic sizing: no price available to convert the USD notional';
            this.db.logSafetyClip({
              signalId: signal.id,
              subscriptionId: sub.id,
              reason: 'synthetic_sizing_no_price',
              originalQuantity: percent,
              adjustedQuantity: 0,
            });
            this.db.log('warn', 'signal', 'Signal rejected — synthetic sizing has no price', {
              signalId: signal.id,
              symbol: signal.symbol,
              exchange: exchangeName,
              account: sizingAccount,
            });
            this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
            await this.ackToApi(signal.id, 'rejected', undefined, reason);
            return;
          }
          quantity = sizing.quantity;
          this.db.logSafetyClip({
            signalId: signal.id,
            subscriptionId: sub.id,
            reason: 'synthetic_sizing_applied',
            originalQuantity: percent,
            adjustedQuantity: quantity,
          });
          if (syntheticBasis.basisKind !== 'open') {
            // Armed/realized floor as the basis (dynamic synthetic): visible
            // in the log so a fill sized on a planned floor is traceable.
            this.db.log('info', 'signal', 'Synthetic sizing on an armed-cycle basis', {
              signalId: signal.id,
              basisKind: syntheticBasis.basisKind,
              basisUsd: syntheticBasis.basisUsd,
              quantity,
            });
          }
          if (sizing.capped) {
            this.db.log('warn', 'signal', 'Synthetic sizing capped at 100% of the synthetic USD value', {
              signalId: signal.id,
              percent,
              targetUsd: syntheticBasis.basisUsd,
            });
            this.db.logSafetyClip({
              signalId: signal.id,
              subscriptionId: sub.id,
              reason: 'synthetic_notional_cap',
              originalQuantity: percent,
              adjustedQuantity: quantity,
            });
          }
        }

        // Price for USD<->native conversions on linear venues (inverse perps
        // are already USD-denominated, so they need none).
        let sizingPrice: number | undefined;
        if (sizeUnit === 'usd' && !isInverseVenue(exchangeName, signal.symbol)) {
          const positions = await this.getCachedPositions(exchangeName, session.adapter);
          const samePos = positions.find(
            (p) => sizingRoot(p.symbol) === sizingRoot(signal.symbol) && Math.abs(p.size) > 0,
          );
          sizingPrice = signal.price || samePos?.markPrice || samePos?.entryPrice || undefined;
        }
        // One futures contract's notional is price × multiplier (1 MES ≈ $38.7k,
        // not $7.7k) — the USD→contracts division must use the per-contract
        // notional, not the index price. 1 outside tradestation.
        const sizingNotionalPrice =
          sizingPrice != null
            ? sizingPrice * contractMultiplier(exchangeName, signal.symbol)
            : undefined;

        // ─── USD-denominated sizing (per-bot size_unit='usd') ───
        // The sized quantity is a USD notional; convert to venue-native BEFORE
        // the caps so downstream keeps comparing like units — same contract as
        // the synthetic path, and skipped when a synthetic basis already
        // produced a native quantity.
        if (!syntheticBasis && sizeUnit === 'usd') {
          const { stepSize, minSize } = getContractConstraints(exchangeName, signal.symbol);
          const r = usdToNativeSize({
            exchange: exchangeName,
            symbol: signal.symbol,
            usdNotional: quantity,
            price: sizingNotionalPrice,
            stepSize,
            minSize,
          });
          if (r.priceMissing) {
            const reason = 'usd sizing: no price available to convert the USD notional';
            this.db.log('warn', 'signal', 'Signal rejected — USD sizing has no price', {
              signalId: signal.id,
              symbol: signal.symbol,
              exchange: exchangeName,
            });
            this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
            await this.ackToApi(signal.id, 'rejected', undefined, reason);
            return;
          }
          // A USD notional too small for one contract rounds to 0 — never place
          // a zero/dust order (the min-size guard below is a no-op when the
          // symbol's constraints are unknown, so reject here).
          if (!(r.size > 0) || r.belowMin) {
            const reason = `usd sizing: converted size ${r.size} is below the tradable minimum`;
            this.db.log('warn', 'signal', 'Signal rejected — USD size below minimum', {
              signalId: signal.id,
              symbol: signal.symbol,
              exchange: exchangeName,
              usdNotional: quantity,
            });
            this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
            await this.ackToApi(signal.id, 'rejected', undefined, reason);
            return;
          }
          const before = quantity;
          quantity = r.size;
          this.db.logSafetyClip({
            signalId: signal.id,
            subscriptionId: sub.id,
            reason: 'usd_sizing_applied',
            originalQuantity: before,
            adjustedQuantity: quantity,
          });
        }

        // maxPositionSize cap (clip, don't reject). In USD-mode the cap is a
        // USD notional too — convert it to native so the clip compares like
        // units (fixes the "Max position size (USD)" field that used to clip
        // in raw contracts).
        let maxPositionNative = sub.max_position_size;
        if (maxPositionNative && sizeUnit === 'usd') {
          const { stepSize } = getContractConstraints(exchangeName, signal.symbol);
          const capConv = usdToNativeSize({
            exchange: exchangeName,
            symbol: signal.symbol,
            usdNotional: maxPositionNative,
            price: sizingNotionalPrice,
            stepSize,
          });
          if (!capConv.priceMissing) {
            if (capConv.size <= 0) {
              // The USD cap is smaller than one tradable contract: no compliant
              // order exists, so REJECT — never fall through to the raw USD
              // number (which would leave the cap silently unenforced).
              const reason = 'maxPositionSize (USD) below one contract';
              this.db.logSafetyClip({
                signalId: signal.id,
                subscriptionId: sub.id,
                reason: 'max_position_size',
                originalQuantity: quantity,
                adjustedQuantity: 0,
              });
              this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
              await this.ackToApi(signal.id, 'rejected', undefined, reason);
              return;
            }
            maxPositionNative = capConv.size;
          }
        }
        if (maxPositionNative) {
          // The cap is a TOTAL exposure safety cap, not a per-order one: DCA
          // adds and multi-position entries for the same bot/market must not
          // compound past it. Count what this bot already holds on this market
          // (open executions net of closes, plus still-resting DCA rungs that
          // can fill later) and clip this order to the remaining headroom.
          const existingQty = this.cumulativeOpenQtyForCap(
            canonicalSymbol,
            signalBotId ?? sub.id,
            signal.action === 'buy' ? 'long' : 'short',
          );
          const headroom = maxPositionNative - existingQty;
          if (headroom <= 0) {
            const reason = `maxPositionSize reached (${existingQty} already open, cap ${maxPositionNative})`;
            this.db.logSafetyClip({
              signalId: signal.id,
              subscriptionId: sub.id,
              reason: 'max_position_size',
              originalQuantity: quantity,
              adjustedQuantity: 0,
            });
            this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
            await this.ackToApi(signal.id, 'rejected', undefined, reason);
            return;
          }
          if (quantity > headroom) {
            const before = quantity;
            quantity = headroom;
            this.db.log('warn', 'signal', 'Quantity clipped to maxPositionSize', {
              signalId: signal.id,
              before,
              after: quantity,
              existingQty,
              cap: maxPositionNative,
            });
            this.db.logSafetyClip({
              signalId: signal.id,
              subscriptionId: sub.id,
              reason: 'max_position_size',
              originalQuantity: before,
              adjustedQuantity: quantity,
            });
          }
        }

        // maxConcurrentTrades — count live open positions on the exchange.
        // The local `positions` table is never written, so it cannot be the
        // source of truth here. We count the exchange's actual open positions
        // (scoped to the subscription's markets when set), with a short cache
        // so a burst of signals doesn't hammer the API.
        if (sub.max_concurrent_trades && !isAdd) {
          const openCount = await this.countOpenPositions(exchangeName, session.adapter, sub);
          if (openCount >= sub.max_concurrent_trades) {
            const reason = `maxConcurrentTrades reached (${sub.max_concurrent_trades})`;
            this.db.logSafetyClip({
              signalId: signal.id,
              subscriptionId: sub.id,
              reason: 'max_concurrent_trades',
              originalQuantity: originalQty,
              adjustedQuantity: 0,
            });
            this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
            await this.ackToApi(signal.id, 'rejected', undefined, reason);
            return;
          }
        }
      }

      // ─── Per-account contract sizing (kill-switch + per-signal cap) ───
      // Caps the contracts placed per signal for this (account, symbol root).
      // A configured cap of 0 kills the market for the account → reject. This is
      // independent of the subscription's maxPositionSize (which is per-bot);
      // sizing is operator policy per broker account.
      const sizeClip = clipToAccountSize(this.db, exchangeName, sizingAccount, signal.symbol, quantity);
      if (sizeClip.killed) {
        const reason = `market disabled for account (account size 0 on ${sizeClip.root})`;
        this.db.logSafetyClip({
          signalId: signal.id,
          subscriptionId: sub?.id,
          reason: 'account_size_killswitch',
          originalQuantity: quantity,
          adjustedQuantity: 0,
        });
        this.db.log('warn', 'signal', 'Signal rejected by account kill-switch', {
          signalId: signal.id,
          exchange: exchangeName,
          account: sizingAccount,
          root: sizeClip.root,
        });
        this.notifyGuardReject(signal, 'account kill-switch', reason);
        this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
        await this.ackToApi(signal.id, 'rejected', undefined, reason);
        return;
      }
      if (sizeClip.clipped) {
        const before = quantity;
        quantity = sizeClip.quantity;
        this.db.log('warn', 'signal', 'Quantity clipped to account size', {
          signalId: signal.id,
          account: sizingAccount,
          root: sizeClip.root,
          cap: sizeClip.cap,
          before,
          after: quantity,
        });
        this.db.logSafetyClip({
          signalId: signal.id,
          subscriptionId: sub?.id,
          reason: 'account_size_cap',
          originalQuantity: before,
          adjustedQuantity: quantity,
        });
      }

      // ─── Breathing room: pre-open margin buffer ───
      // Refuse the open if it would leave too little free margin to keep the
      // account's existing positions safe. Configurable per (exchange, account);
      // fail-open on a balance-lookup hiccup so a data blip never silently blocks
      // trading. Applies to opens and scale-in adds alike (both consume margin).
      const marginGuard = effectiveMarginGuard(this.db, exchangeName, sizingAccount);
      // Server-driven override: a signal flagged `force` bypasses ONLY this
      // margin guard (never the account-size kill-switch or min-size — those are
      // hard limits). The executor doesn't decide to force; the server sets it.
      const forceMarginBypass = signal.metadata?.force === true;
      if (marginGuard.enabled && forceMarginBypass) {
        // warn (not info): a forced open disables the strongest pre-open margin
        // protection — keep it visible in operator logs alongside rejections.
        this.db.log('warn', 'signal', 'Breathing room bypassed (force)', { signalId: signal.id });
      }
      if (marginGuard.enabled && !forceMarginBypass) {
        try {
          const room = await this.checkBreathingRoom(
            exchangeName,
            session.adapter,
            sizingAccount,
            signal,
            quantity,
            marginGuard,
            sub?.account_id as string | undefined,
          );
          if (room && !room.ok) {
            const reason =
              `breathing room: free margin $${room.available.toFixed(0)} minus ~$${room.orderMargin.toFixed(0)} ` +
              `order margin leaves $${room.after.toFixed(0)}, under the $${room.required.toFixed(0)} floor ` +
              `(${marginGuard.bufferMult}x ${marginGuard.floorMode} $${room.floorBasis.toFixed(0)})`;
            this.db.logSafetyClip({
              signalId: signal.id,
              subscriptionId: sub?.id,
              reason: 'breathing_room',
              originalQuantity: quantity,
              adjustedQuantity: 0,
            });
            this.db.log('warn', 'signal', 'Signal rejected by breathing room', {
              signalId: signal.id,
              exchange: exchangeName,
              account: sizingAccount,
              available: room.available,
              orderMargin: room.orderMargin,
              after: room.after,
              required: room.required,
            });
            this.notifyGuardReject(signal, 'breathing room', reason);
            this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
            await this.ackToApi(signal.id, 'rejected', undefined, reason);
            return;
          }
        } catch (e: any) {
          this.db.log('warn', 'signal', 'Breathing room check failed, proceeding', {
            signalId: signal.id,
            error: e?.message ?? String(e),
          });
        }
      }

      // ─── Opt-in auto-guardrails ───
      // The USER's own pre-set safety rails (opt-in, default-off): the user
      // pre-decided the limits, the executor only ENFORCES them — a safety rail,
      // not a strategy decision. Enforced locally so they hold with the cloud
      // down. Three rails:
      //   • daily loss     → realized P&L since 00:00 UTC breached ⇒ flatten +
      //                       halt (a hard stop; not bypassable by `force`).
      //   • concurrency    → refuse an open past the max distinct open positions.
      //   • total notional → refuse an open that would exceed max exposure.
      // Fail-open on a data hiccup so a blip never silently blocks trading.
      const guardrails = effectiveGuardrails(this.db, exchangeName, sizingAccount);
      if (guardrailsActive(guardrails)) {
        try {
          // (1) Daily-loss trip — flatten everything + halt. Checked first and
          // unconditionally (no force bypass): if today's realized loss already
          // breached the user's limit, opening more is exactly what the rail
          // exists to stop.
          if (guardrails.maxDailyLoss > 0) {
            const realized = realizedPnlTodayUtc(this.db);
            const dl = checkDailyLoss(guardrails, realized);
            if (dl.breached) {
              const reason = `daily loss limit hit: realized $${realized.toFixed(0)} ≤ -$${guardrails.maxDailyLoss.toFixed(0)} — flattening + halting`;
              this.db.log('warn', 'signal', 'Daily-loss guardrail breached — flatten + halt', {
                signalId: signal.id,
                exchange: exchangeName,
                account: sizingAccount,
                realized,
                limit: guardrails.maxDailyLoss,
              });
              this.db.logSafetyClip({
                signalId: signal.id,
                subscriptionId: sub?.id,
                reason: 'daily_loss_limit',
                originalQuantity: quantity,
                adjustedQuantity: 0,
              });
              // Flatten all + set the halt flag. Imported lazily to avoid a
              // module cycle (panic → exchanges → … ) at load time.
              try {
                const { panicCloseAll } = await import('../services/panic.js');
                if (this.exchangeManager) {
                  await panicCloseAll(this.db, this.exchangeManager, { halt: true, reason: 'daily_loss' });
                } else {
                  this.db.setHaltState(true, 'daily_loss');
                }
              } catch (flattenErr: any) {
                // Even if the flatten errors, HALT so nothing new opens.
                this.db.setHaltState(true, 'daily_loss');
                this.db.log('error', 'signal', 'Daily-loss flatten failed, halted anyway', {
                  error: flattenErr?.message ?? String(flattenErr),
                });
              }
              this.notifyGuardReject(signal, 'daily-loss limit', reason);
              this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
              await this.ackToApi(signal.id, 'rejected', undefined, reason);
              return;
            }
          }

          // (2) + (3) Refuse-open rails. `force` (operator override) bypasses
          // these soft pre-open refusals, consistent with the breathing-room
          // guard above.
          const forceBypass = signal.metadata?.force === true;
          if (!forceBypass && (guardrails.maxConcurrentPositions > 0 || guardrails.maxTotalNotional > 0)) {
            // Rails are per (exchange, account): a routed subscription counts
            // only its own account's positions.
            const positions = this.positionsForAccount(
              await this.getCachedPositions(exchangeName, session.adapter),
              sub?.account_id as string | undefined,
            );
            const openSymbols = positions.filter((p) => Math.abs(p.size) > 0).map((p) => p.symbol);

            if (guardrails.maxConcurrentPositions > 0 && !isAdd) {
              const cc = checkConcurrency(guardrails, openSymbols, signal.symbol);
              if (!cc.ok) {
                const reason = `max concurrent positions reached (${cc.openCount}/${cc.limit})`;
                this.db.logSafetyClip({
                  signalId: signal.id,
                  subscriptionId: sub?.id,
                  reason: 'max_concurrent_positions',
                  originalQuantity: quantity,
                  adjustedQuantity: 0,
                });
                this.db.log('warn', 'signal', 'Signal rejected by concurrency guardrail', {
                  signalId: signal.id,
                  exchange: exchangeName,
                  account: sizingAccount,
                  openCount: cc.openCount,
                  limit: cc.limit,
                });
                this.notifyGuardReject(signal, 'max concurrent positions', reason);
                this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
                await this.ackToApi(signal.id, 'rejected', undefined, reason);
                return;
              }
            }

            if (guardrails.maxTotalNotional > 0) {
              // Current exposure + the new order's notional in the venue's terms.
              // Inverse venues (Deribit) settle in coin: position value = |size| /
              // price; linear venues use |size| × price. Same convention as the
              // breathing-room order-notional math.
              const inverse = isInverseVenue(exchangeName, signal.symbol);
              const px = (p: Position) => p.markPrice || p.entryPrice || 0;
              // Futures notional = size × price × contract multiplier (per
              // symbol — 1 outside tradestation); inverse stays size / price.
              const notionalOf = (size: number, price: number, symbol: string) =>
                price > 0
                  ? inverse
                    ? Math.abs(size) / price
                    : Math.abs(size) * price * contractMultiplier(exchangeName, symbol)
                  : 0;
              const currentNotional = positions
                .filter((p) => Math.abs(p.size) > 0)
                .reduce((s, p) => s + notionalOf(p.size, px(p), p.symbol), 0);
              const samePos = positions.find(
                (p) => sizingRoot(p.symbol) === sizingRoot(signal.symbol) && Math.abs(p.size) > 0,
              );
              const orderPrice = signal.price || samePos?.markPrice || samePos?.entryPrice || 0;
              const orderNotional = notionalOf(quantity, orderPrice, signal.symbol);
              // No usable price → can't size the order's notional → fail-open (skip).
              if (orderNotional > 0) {
                const nc = checkNotional(guardrails, currentNotional, orderNotional);
                if (!nc.ok) {
                  const reason = `max total notional exceeded ($${nc.afterNotional.toFixed(0)} > $${nc.limit.toFixed(0)})`;
                  this.db.logSafetyClip({
                    signalId: signal.id,
                    subscriptionId: sub?.id,
                    reason: 'max_total_notional',
                    originalQuantity: quantity,
                    adjustedQuantity: 0,
                  });
                  this.db.log('warn', 'signal', 'Signal rejected by notional guardrail', {
                    signalId: signal.id,
                    exchange: exchangeName,
                    account: sizingAccount,
                    currentNotional: nc.currentNotional,
                    orderNotional: nc.orderNotional,
                    after: nc.afterNotional,
                    limit: nc.limit,
                  });
                  this.notifyGuardReject(signal, 'max total notional', reason);
                  this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
                  await this.ackToApi(signal.id, 'rejected', undefined, reason);
                  return;
                }
              }
            }
          }
        } catch (e: any) {
          this.db.log('warn', 'signal', 'Guardrail check failed, proceeding', {
            signalId: signal.id,
            error: e?.message ?? String(e),
          });
        }
      }

      // ─── Exchange constraints: min size + step rounding ───
      const { minSize, stepSize } = getContractConstraints(exchangeName, signal.symbol);
      if (stepSize > 0) {
        const before = quantity;
        quantity = roundToStep(quantity, stepSize);
        if (quantity !== before) {
          this.db.logSafetyClip({
            signalId: signal.id,
            subscriptionId: sub?.id,
            reason: 'step_size_round',
            originalQuantity: before,
            adjustedQuantity: quantity,
          });
        }
      }
      if (minSize > 0 && quantity < minSize) {
        const reason = `below min contract size (${minSize})`;
        this.db.logSafetyClip({
          signalId: signal.id,
          subscriptionId: sub?.id,
          reason: 'min_contract_size',
          originalQuantity: originalQty,
          adjustedQuantity: quantity,
        });
        this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
        await this.ackToApi(signal.id, 'rejected', undefined, reason);
        return;
      }

      const accountId = sizingAccount;
      const orderType = (signal.type ?? 'market') as Order['orderType'];

      // Resolve the tradable symbol once (front-month for a futures root) so the
      // entry order, bracket legs, fills and execution record all agree. The
      // engine puts the contract its bars came from on the wire
      // (metadata.contract); that wins over our own quote-volume pick, which
      // flips a couple of sessions earlier around a roll.
      let orderSymbol = signal.symbol;
      const contractHint = signal.metadata?.contract;
      const hinted = pickOrderContract({ root: rootOf(signal.symbol), hint: contractHint });
      if (hinted.source === 'hint') {
        orderSymbol = hinted.symbol;
        this.db.log('info', 'trading', 'Order contract from signal', {
          signalId: signal.id, symbol: signal.symbol, contract: orderSymbol,
        });
      } else if (session.adapter.resolveSymbol) {
        try {
          orderSymbol = await session.adapter.resolveSymbol(signal.symbol);
        } catch (resolveErr: any) {
          const reason = `symbol resolution failed: ${resolveErr.message}`;
          this.db.log('error', 'trading', 'Symbol resolution failed', {
            signalId: signal.id,
            symbol: signal.symbol,
            error: resolveErr.message,
          });
          this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
          this.db.insertSignalExecution({
            signalId: signal.id,
            symbol: signal.symbol,
            exchange: exchangeName,
            direction: signal.action === 'buy' ? 'long' : 'short',
            status: 'error',
            errorReason: reason,
            accountId: sizingAccount,
          });
          await this.ackToApi(signal.id, 'rejected', undefined, reason);
          return;
        }
      }

      // ─── Market-open / stale-quote guard (market orders only) ───
      // A market order into a closed/halted session can't fill or fills at a bad
      // reopen print. Crypto venues are 24/7 and skip this. Done BEFORE the
      // idempotent insert so a parked signal isn't burned: the entry is
      // deferred (not rejected) and re-runs this whole path, sizing and guards
      // included, once the venue trades again (2026-09-19: a 1D CME bot fires
      // on the 21:00 UTC close, inside the Globex maintenance pause, and never
      // got a live entry).
      if (orderType === 'market') {
        const tradable = await isMarketTradable(session.adapter, orderSymbol, { now: this.now() });
        if (!tradable) {
          await this.deferEntry(wireSignal, {
            canonicalSymbol,
            exchangeName,
            orderSymbol,
            accountId: sizingAccount,
            signalBotId,
            subscriptionId: sub?.id as string | undefined,
          });
          return;
        }
      }

      // ─── Idempotent open: one execution per signal id, across reconnect/replay ───
      const direction: 'long' | 'short' = signal.action === 'buy' ? 'long' : 'short';
      const inserted = this.db.insertSignalExecution({
        signalId: signal.id,
        symbol: orderSymbol,
        exchange: exchangeName,
        direction,
        status: 'open',
        qtyOpened: quantity,
        accountId: sizingAccount,
      });
      if (!inserted) {
        // A row already exists → this signal was already processed (duplicate
        // delivery or a replay). Never open twice.
        const existing = this.db.getSignalExecution(signal.id);
        this.db.log('info', 'signal', 'Duplicate open ignored (execution already recorded)', {
          signalId: signal.id,
          status: existing?.status,
        });
        this.db.recordSignalQueue({
          signalId: signal.id,
          action: signal.action,
          reason: 'duplicate_open',
          metadata: { existingStatus: existing?.status },
        });
        return;
      }

      // DCA / scale-in: when the plan lists multiple entries they REPLACE the
      // single entry — the first rung is the main order, the rest are resting
      // limit adds placed after the main fills. Legs sum to the sized `quantity`.
      const dcaLegs = computeDcaEntryLegs(quantity, signal.order_plan?.entries);
      const mainEntryQty = dcaLegs.length > 0 ? dcaLegs[0].qty : quantity;
      const extraEntryRungs = dcaLegs.slice(1);

      // Deterministic per-(signal, leg) client order id: a redelivered/retried
      // leg submits the SAME id, so venues with client-id idempotency reject the
      // duplicate broker-side instead of double-placing (EX7).
      const entryClientOrderId = deriveClientOrderId(signal.id, 'entry');
      const order: Order = {
        accountId,
        symbol: orderSymbol,
        side: signal.action,
        orderType,
        quantity: mainEntryQty,
        price: signal.price,
        label: `kaibot:${signal.id}:main`,
        clientOrderId: entryClientOrderId,
      };

      try {
        const result = await session.adapter.placeOrder(order);
        this.db.log('info', 'trading', 'Order placed', {
          signalId: signal.id,
          orderId: result.orderId,
          status: result.status,
          finalQty: quantity,
          originalQty,
          factor: sub?.factor,
        });

        // ─── Settle the entry: confirm a terminal outcome before treating the
        // position as open. For a market order the adapter usually reports
        // 'filled' immediately; otherwise (and when the adapter exposes
        // getOrderStatus) poll to a terminal status. A rejected/cancelled entry
        // is marked error so no later close acts on a phantom position. An
        // unknown outcome (timeout) is persisted for background resolution and
        // the execution stays tracked. ───
        const settled = await this.settleEntry(
          session.adapter,
          result,
          signal,
          orderSymbol,
          exchangeName,
          accountId,
          quantity,
        );
        if (settled.outcome === 'rejected') {
          const reason = settled.reason ?? 'entry order rejected';
          this.db.updateSignalExecution(signal.id, {
            status: 'error',
            errorReason: reason,
            qtyOpened: 0,
          });
          this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
          await this.ackToApi(signal.id, 'rejected', undefined, reason);
          this.notifications?.publish({
            type: 'order_rejected',
            title: 'Order rejected',
            body: `✗ ${signal.symbol}: ${reason}`,
            data: { signalId: signal.id, symbol: signal.symbol, error: reason },
          });
          return;
        }

        // Unknown outcome (settle timeout): the order was placed but neither a
        // fill nor a terminal rejection is confirmed. Do NOT book a phantom
        // position or brackets — settleEntry already persisted an unresolved
        // settlement row, and resolveUnknownOrders will retro-apply the real
        // outcome (filled → open at the real fill; rejected → error). Leaving
        // qty_opened at 0 here is what prevents an orphaned position. The
        // execution stays tracked (status 'open', qty 0) until then.
        if (settled.outcome === 'unknown') {
          // The execution row was pre-seeded 'open' with the full quantity before
          // placement; reset qty to 0 so an unconfirmed entry isn't counted as a
          // held position. resolveUnknownOrders sets the real qty once the broker
          // confirms the fill. Local status only — no API ack (neither executed
          // nor rejected yet); resolveUnknownOrders acks the real outcome.
          this.db.updateSignalExecution(signal.id, { qtyOpened: 0 });
          this.db.updateSignalStatus(signal.id, 'pending', undefined, 'entry outcome pending resolution');
          return;
        }

        // Record the entry fill (basis for fills-based PnL). Quantity falls back
        // to the requested size when the exchange doesn't report a filled qty
        // (e.g. a pending limit). Price comes from the settled average, otherwise
        // the signal's requested price.
        const filledQty = settled.filledQty > 0 ? settled.filledQty : quantity;
        const fillPrice =
          settled.avgPrice && settled.avgPrice > 0 ? settled.avgPrice : signal.price ?? null;
        this.db.insertSignalFill({
          signalId: signal.id,
          kind: 'entry',
          symbol: orderSymbol,
          side: signal.action,
          qty: filledQty,
          price: fillPrice,
          orderId: result.orderId,
        });
        this.db.updateSignalExecution(signal.id, { qtyOpened: filledQty, status: 'open' });

        // G0 auto-grouping: a bot-driven fill lands in its bot's group (lazily
        // created, name = bot/strategy name). Visibility only — never blocks or
        // alters execution, hence best-effort.
        if (signalBotId) {
          try {
            const cfg = this.db.getBotConfigBySignalBotId(signalBotId, signal.symbol);
            const group = ensureBotGroup(this.db, {
              signalBotId,
              botConfigId: cfg?.id ?? null,
              name: cfg?.botName ?? cfg?.strategyName ?? sub?.bot_name ?? null,
            });
            autoLinkPosition(this.db, {
              exchange: exchangeName,
              accountId,
              symbol: orderSymbol,
              groupId: group.id,
            });
          } catch (groupErr: any) {
            this.db.log('warn', 'trading', 'Position group auto-link failed', {
              signalId: signal.id,
              error: groupErr.message,
            });
          }
        }

        // Place bracket orders (stop-loss + take-profit) on the opposite side.
        // Size defaults to the requested quantity when the exchange reports 0
        // filled (e.g., pending limit orders). Bracket orders are reduce-only.
        // With DCA the brackets cover the FULL intended size (all rungs); the
        // reduce-only flag clamps each leg to whatever is actually filled, so an
        // unfilled rung never causes an over-close.
        const bracketSize = dcaLegs.length > 0
          ? quantity
          : result.filledQuantity && result.filledQuantity > 0
            ? result.filledQuantity
            : quantity; // sized quantity (post factor×base+caps), never the raw factor
        const oppositeSide: 'buy' | 'sell' = signal.action === 'buy' ? 'sell' : 'buy';

        let slOrderId: string | undefined;
        const tpOrderIds: string[] = [];

        if (signal.stop_loss !== undefined && signal.stop_loss !== null) {
          try {
            const slResult = await session.adapter.placeOrder({
              accountId,
              symbol: orderSymbol,
              side: oppositeSide,
              orderType: 'stop',
              quantity: bracketSize,
              stopPrice: signal.stop_loss,
              reduceOnly: true,
              label: `kaibot:${signal.id}:sl`,
              clientOrderId: deriveClientOrderId(signal.id, 'sl'),
            });
            slOrderId = slResult.orderId;
            this.db.log('info', 'trading', 'Stop-loss placed', {
              signalId: signal.id,
              orderId: slOrderId,
              triggerPrice: signal.stop_loss,
            });
          } catch (slErr: any) {
            this.db.log('error', 'trading', 'Stop-loss placement failed', {
              signalId: signal.id,
              error: slErr.message,
            });
          }
        }

        // Take-profit legs. A plan ladder (plan.takeProfits) wins; otherwise the
        // flat take_profit becomes a single full-size leg (back-compat). Each leg
        // is a reduce-only limit sized to its tranche of the filled size.
        const ladderLegs = computeTpLadderLegs(bracketSize, signal.order_plan?.takeProfits);
        const tpTargets: Array<{ price: number; qty: number; label: string }> =
          ladderLegs.length > 0
            ? ladderLegs.map((leg, i) => ({ price: leg.price, qty: leg.qty, label: `TP${i + 1}` }))
            : signal.take_profit !== undefined && signal.take_profit !== null
              ? [{ price: signal.take_profit, qty: bracketSize, label: 'TP1' }]
              : [];

        for (let i = 0; i < tpTargets.length; i++) {
          const target = tpTargets[i];
          try {
            const tpResult = await session.adapter.placeOrder({
              accountId,
              symbol: orderSymbol,
              side: oppositeSide,
              orderType: 'limit',
              quantity: target.qty,
              price: target.price,
              reduceOnly: true,
              // The target label rides into metadata via the order label so the
              // exit dedup (resolveExitTargetLabel) keeps TP1..TPn distinct.
              label: `kaibot:${signal.id}:tp${i + 1}`,
              clientOrderId: deriveClientOrderId(signal.id, 'tp', i + 1),
            });
            tpOrderIds.push(tpResult.orderId);
            this.db.log('info', 'trading', 'Take-profit placed', {
              signalId: signal.id,
              orderId: tpResult.orderId,
              price: target.price,
              qty: target.qty,
              leg: target.label,
            });
          } catch (tpErr: any) {
            this.db.log('error', 'trading', 'Take-profit placement failed', {
              signalId: signal.id,
              leg: target.label,
              error: tpErr.message,
            });
          }
        }

        const firstTpOrderId = tpOrderIds[0];
        if (slOrderId || tpOrderIds.length > 0) {
          this.db.updateSignalOrderIds(signal.id, slOrderId, firstTpOrderId);
          // Track bracket in memory AND persist it, so siblings can be cancelled
          // on fill even after a restart (the in-memory map is empty on boot —
          // loadPersistedBrackets() rehydrates it).
          this.trackBracket(exchangeName, signal.id, slOrderId, tpOrderIds, sizingAccount);
          this.db.upsertBracketPair({
            signalId: signal.id,
            exchange: exchangeName,
            accountId: sizingAccount,
            slOrderId,
            tpOrderIds,
          });
        }

        // Local trailing / break-even: register the position with the
        // LocalPositionManager so the resting stop is amended on local ticks
        // (sub-second), not the 5s server loop. Every trail parameter — distance,
        // caps, break-even fee — comes from the USER's own executor settings
        // (their risk tooling), NEVER from the inbound signal's order_plan (the
        // server's proprietary IP). When the user has not configured local
        // trailing, no trail is registered: the executor injects no defaults.
        const trail = this.getLocalTrailingSettings();
        const entryPriceForTrail = fillPrice ?? signal.price ?? null;
        if (trail && entryPriceForTrail != null) {
          this.db.upsertLocalTrailState({
            signalId: signal.id,
            exchange: exchangeName,
            symbol: orderSymbol,
            direction,
            entryPrice: entryPriceForTrail,
            slOrderId,
            trailPercentage: trail.trailPercentage,
            trailPoints: trail.trailPoints,
            maxPercentage: trail.maxPercentage,
            maxPoints: trail.maxPoints,
            breakevenFee: trail.breakevenFee,
            extremePrice: entryPriceForTrail,
            currentStop: signal.stop_loss ?? null,
          });
        }

        // Server-authored exit updates (exit-as-signal-update): an entry whose
        // metadata carries exitAuthority:'server' registers its position for
        // follow-up `update` signals from the deployed strategy's server-side
        // evaluation. Without this row every `update` is refused (the gate).
        // Requires the venue-resting backstop: only bracketed entries qualify,
        // so a dead connection always leaves an exchange-resting stop behind.
        if (
          signal.metadata?.exitAuthority === 'server' &&
          typeof signal.metadata?.positionId === 'string' &&
          typeof this.db.upsertServerExitState === 'function'
        ) {
          if (slOrderId) {
            this.db.upsertServerExitState({
              positionId: signal.metadata.positionId,
              entrySignalId: signal.id,
              exchange: exchangeName,
              symbol: orderSymbol,
              direction,
              currentStop: signal.stop_loss ?? null,
              slOrderId,
            });
          } else {
            this.db.log('warn', 'signal', 'exitAuthority:server entry without resting stop — updates will be refused', {
              signalId: signal.id,
              positionId: signal.metadata.positionId,
            });
          }
        }

        // DCA scale-in: place the additional same-side entry rungs as resting
        // limit orders. Immediate fills are recorded + accumulated into
        // qty_opened so fills-based PnL re-weights the average; rungs that rest
        // are settled later by the reconciler. Placed after brackets so a failed
        // bracket never blocks the adds.
        if (extraEntryRungs.length > 0) {
          await this.placeDcaRungs(
            session.adapter,
            signal,
            signal.action === 'buy' ? 'buy' : 'sell',
            orderSymbol,
            exchangeName,
            accountId,
            extraEntryRungs,
            filledQty,
          );
        }

        this.db.updateSignalStatus(signal.id, 'executed', undefined, result.message);
        await this.ackToApi(signal.id, 'executed', result.orderId, undefined, slOrderId, firstTpOrderId, {
          price: fillPrice,
          size: filledQty,
          time: Date.now(),
        });

        // Drawing-trigger "signal + hand over": the filled entry is adopted by
        // the ride bot now that the server row is open (the ack landed).
        const handoverTo = signal.metadata?.handoverTo as
          | { botId?: string; botName?: string; ladderFrom?: 'entry' | 'now'; marketExchange?: string; canonicalSymbol?: string }
          | undefined;
        if (handoverTo?.botId && typeof signal.metadata?.positionId === 'string' && this.entryFilledHook) {
          try {
            await this.entryFilledHook({
              entrySignalId: signal.id,
              positionId: signal.metadata.positionId,
              exchange: exchangeName,
              symbol: orderSymbol,
              accountId: sizingAccount ?? accountId,
              direction,
              fillPrice: fillPrice ?? signal.price ?? 0,
              stopPrice: signal.stop_loss ?? null,
              slOrderId: slOrderId ?? null,
              botId: handoverTo.botId,
              botName: handoverTo.botName,
              ladderFrom: handoverTo.ladderFrom,
              marketExchange: handoverTo.marketExchange,
              canonicalSymbol: handoverTo.canonicalSymbol,
            });
          } catch (err: any) {
            this.db.log('error', 'trading', 'Hand-over after fill failed — position stays manual', {
              signalId: signal.id,
              botId: handoverTo.botId,
              error: err?.message,
            });
          }
        }
        this.notifications?.publish({
          type: 'order_filled',
          title: 'Order filled',
          body: `✓ ${signal.action.toUpperCase()} ${filledQty} ${signal.symbol}${result.orderId ? ` (#${result.orderId})` : ''}`,
          data: {
            signalId: signal.id,
            orderId: result.orderId,
            symbol: signal.symbol,
            quantity: filledQty,
          },
        });
      } catch (orderError: any) {
        this.db.log('error', 'trading', 'Order placement failed', {
          signalId: signal.id,
          error: orderError.message,
        });
        // Mark the execution failed → blocks any later reduce/close for this
        // signal from acting on a position that was never opened.
        this.db.updateSignalExecution(signal.id, {
          status: 'error',
          errorReason: orderError.message,
          qtyOpened: 0,
        });
        // A thrown placeOrder does NOT prove the order never reached the venue:
        // a lost response after a real fill would otherwise become an invisible
        // unprotected position (the signal_id PK makes redelivery a no-op).
        // Persist an unknown-outcome settlement keyed by the deterministic
        // client order id so resolveUnknownOrders can poll the broker and
        // retro-apply a real fill (EX2). Resolution by client id needs venue
        // support — adapters without getOrderStatus skip it harmlessly.
        try {
          this.db.insertOrderSettlement({
            signalId: signal.id,
            exchange: exchangeName,
            accountId,
            symbol: orderSymbol,
            category: (signal.metadata?.category as string | undefined) ?? null,
            kind: 'entry',
            side: signal.action === 'buy' ? 'buy' : 'sell',
            qty: quantity,
            orderId: toClientOrderRef(entryClientOrderId),
            targetLabel: 'entry-attempt',
          });
        } catch {
          /* dedup collision on a redelivered signal — the row already exists */
        }
        this.db.updateSignalStatus(signal.id, 'rejected', undefined, orderError.message);
        await this.ackToApi(signal.id, 'rejected', undefined, orderError.message);
        this.notifications?.publish({
          type: 'order_rejected',
          title: 'Order rejected',
          body: `✗ ${signal.symbol}: ${orderError.message || 'unknown error'}`,
          data: { signalId: signal.id, symbol: signal.symbol, error: orderError.message },
        });
      }
    } catch (error: any) {
      this.db.log('error', 'signal', 'Failed to handle signal', {
        signalId: signal.id,
        error: error.message,
      });
      try {
        this.db.updateSignalStatus(signal.id, 'rejected', undefined, error.message);
      } catch {
        /* swallow — db might not have the row yet */
      }
    }
  }

  /**
   * Execute a `close` signal. Resolves the open position(s) for this
   * signal/subscription on the correct exchange, cancels any outstanding
   * bracket/OCO siblings, and places a reduce-only market order to flatten
   * (or partially reduce) the position.
   *
   * Position resolution uses the live exchange position as the source of truth
   * for side and size (the local positions table is not maintained by the
   * order path). Local executed entry signals for the same symbol are used to
   * find which bracket legs to cancel. A close can be partial when the signal
   * carries an explicit size (metadata.closeSize / metadata.size, or a
   * quantity smaller than the open position); otherwise the full position is
   * closed.
   */
  /**
   * User-initiated cancel (relayed by the server from the user's own cancel
   * action; the old pending-sweeper is gone): cancel the RESTING order(s) the
   * executor placed for an entry — the unfilled entry limit and any resting
   * bracket legs. The executor only retires the working orders. Keyed by
   * metadata.entrySignalId.
   *
   * CRITICAL SAFETY: only resting/unfilled orders are cancelled. If the entry
   * actually FILLED (the execution holds a net position), cancelling here would
   * naked the position — so we ack gracefully and touch nothing. Idempotent: an
   * order that's already gone, or no order to cancel at all, still acks success.
   */
  /**
   * Server-authored exit `update` (exit-as-signal-update): a follow-up signal
   * on an open position, emitted by the strategy the user deployed. Applies a
   * SHARPEN-ONLY stop amendment (cancel old resting stop, place the new one)
   * for positions whose entry was opened with exitAuthority:'server'.
   *
   * Gates, in order: authority row must exist and be active (else refused,
   * byte-identical posture to the legacy stop_update refusal), exitSeq must be
   * strictly monotonic (stale/duplicate replay acks as a no-op), the position
   * must still be live (flat deactivates the row), and the new stop must be
   * favourable vs the current one (a loosening stop is refused loudly — the
   * server only ever sharpens).
   */
  private async handleServerExitUpdate(
    signal: Signal,
    initialSession: { adapter: any; status?: string },
    exchangeName: string,
  ): Promise<void> {
    let session: { adapter: any; status?: string } = initialSession;
    const meta = (signal.metadata ?? {}) as Record<string, unknown>;
    const positionId = typeof meta.positionId === 'string' ? meta.positionId : undefined;
    const exitSeq = typeof meta.exitSeq === 'number' ? meta.exitSeq : undefined;
    const newStop = typeof signal.price === 'number' && signal.price > 0 ? signal.price : undefined;

    const refuse = async (reason: string) => {
      this.db.log('warn', 'signal', 'Refused server exit update', { signalId: signal.id, positionId, reason });
      this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
      await this.ackToApi(signal.id, 'rejected', undefined, reason);
    };
    const noop = async (message: string) => {
      this.db.updateSignalStatus(signal.id, 'executed', undefined, message);
      await this.ackToApi(signal.id, 'executed', undefined);
    };

    if (!positionId || exitSeq == null || newStop == null) {
      return refuse('update invalid: positionId, exitSeq and price are required');
    }
    const state =
      typeof this.db.getServerExitState === 'function' ? this.db.getServerExitState(positionId) : null;
    if (!state || !state.active) {
      // Same posture as the legacy stop_update refusal: no authority, no move.
      return refuse('server update refused: position not opened with exitAuthority server');
    }
    if (exitSeq <= state.last_exit_seq) {
      // Replay-queue redelivery / out-of-order — already applied or superseded.
      return noop(`stale exitSeq ${exitSeq} ignored (last ${state.last_exit_seq})`);
    }
    // Favourable-only against the bot's OWN previous stop (engine_stop), never
    // against the user's floor: a floor above the bot's stop must not make the
    // bot's next sharpening look like a loosening.
    const enginePrev = serverExitEngineStop(state);
    if (!isFavourableStop(newStop, enginePrev, state.direction)) {
      // The server only sharpens. A loosening stop is a protocol violation,
      // never something to apply quietly.
      return refuse('server update refused: stop move is not favourable');
    }

    // The account that holds this lineage decides the connection (a bot can
    // be routed to several): the entry's execution, not the first sub the
    // caller resolved. Position lookup, cancel and the new stop all go
    // through THAT session.
    const execForLookup = this.db.getSignalExecution(state.entry_signal_id);
    if (execForLookup?.account_id) {
      const owned = await this.sessionForAccount(exchangeName, execForLookup.account_id);
      if (!owned || owned.status !== 'connected') {
        return refuse(`no connected session for the account holding this position (${execForLookup.account_id})`);
      }
      session = owned;
    }
    // Position must still be live; flat = the run is over, retire the gate row.
    const positions = await session.adapter.getPositions();
    const live = (positions as Position[]).find(
      (p) =>
        p.symbol.toLowerCase() === state.symbol.toLowerCase() &&
        Math.abs(p.size) > 0 &&
        (!execForLookup?.account_id || !p.accountId || p.accountId === execForLookup.account_id),
    );
    if (!live) {
      this.db.deactivateServerExitState(positionId);
      return noop('position flat — exit state retired');
    }
    // The venue stop is the composition of the user's floor and the bot's
    // stop (stop-floor, migration 038): the floor always participates, the
    // bot only improves on it, under trailing_lock the floor is absolute. The
    // bot's stop is recorded either way so an unlock resumes from it.
    const effective = serverExitEffectiveStop(state, newStop);
    const lineageAccount = execForLookup?.account_id ?? null;
    const markPrice = (live as any).markPrice as number | undefined;

    if (effective == null || !serverExitStopNeedsMove(state, effective)) {
      this.db.applyServerExitUpdate(positionId, {
        exitSeq,
        currentStop: state.current_stop,
        slOrderId: state.sl_order_id,
        engineStop: newStop,
      });
      return noop(
        state.trailing_lock
          ? 'stop floor locked: bot stop recorded, venue stop kept'
          : 'stop floor above bot stop: bot stop recorded, venue stop kept',
      );
    }

    // Keep the existing protective stop when the market already crossed the new
    // one (the old stop is about to do its job); the seq still advances so a
    // later, fresher update isn't blocked behind this one.
    if (markPrice != null && markPrice > 0 && !isProtectiveStop(state.direction, effective, markPrice)) {
      this.db.applyServerExitUpdate(positionId, {
        exitSeq,
        currentStop: state.current_stop,
        slOrderId: state.sl_order_id,
      });
      return noop('new stop crossed mark — kept previous stop');
    }

    // Cancel the old resting stop before placing the new one (same amend flow
    // as the local trail loop). One resting stop per position.
    try {
      await replaceServerExitStop({
        db: this.db as any,
        adapter: session.adapter,
        state,
        live,
        lineageAccount,
        stopPrice: effective,
        exitSeq,
        engineStop: newStop,
        label: `kaibot:${state.entry_signal_id}:exit-update`,
        context: { signalId: signal.id },
      });
      this.db.log('info', 'trading', 'Server exit update applied', {
        signalId: signal.id, positionId, exitSeq, newStop, effective,
        manualStop: state.manual_stop ?? undefined,
      });
      this.db.updateSignalStatus(signal.id, 'executed');
      await this.ackToApi(signal.id, 'executed', undefined);
    } catch (err: any) {
      // Old stop already cancelled, stale id dropped, seq NOT advanced so the
      // server's retry can re-place.
      await refuse(`stop replacement failed: ${err.message}`);
    }
  }

  private async handleCancel(
    signal: Signal,
    session: { adapter: any; status?: string },
    exchangeName: string,
  ): Promise<void> {
    const meta = (signal.metadata ?? {}) as Record<string, unknown>;
    const entrySignalId =
      typeof meta.entrySignalId === 'string' ? meta.entrySignalId : undefined;
    if (!entrySignalId) {
      this.db.updateSignalStatus(signal.id, 'rejected', undefined, 'cancel: missing entrySignalId');
      await this.ackToApi(signal.id, 'rejected', undefined, 'cancel invalid');
      return;
    }

    // Filled-race guard: if the entry opened a position (and isn't already flat),
    // the resting order filled — never cancel/flatten it from here. The pending
    // sweep races a late fill; the ack route will have moved the position to
    // open, but this signal may still be in flight. Ack as a no-op.
    const exec = this.db.getSignalExecution(entrySignalId);
    if (exec && exec.status !== 'closed' && exec.qty_opened - exec.qty_closed > 1e-9) {
      this.db.log('info', 'trading', 'cancel: entry already filled, not cancelling', {
        signalId: signal.id,
        entrySignalId,
        qtyOpened: exec.qty_opened,
        qtyClosed: exec.qty_closed,
      });
      this.db.updateSignalStatus(signal.id, 'executed', undefined, 'cancel: entry already filled');
      await this.ackToApi(signal.id, 'executed', undefined);
      return;
    }

    // Collect the resting order ids to cancel: the entry order itself (from its
    // recorded entry fill and any unresolved entry settlement) plus any resting
    // bracket legs (stop-loss / take-profit) tracked on the entry signal row.
    const orderIds = new Set<string>();
    for (const fill of this.db.getSignalFills(entrySignalId)) {
      if (fill.kind === 'entry' && fill.order_id) orderIds.add(fill.order_id);
    }
    for (const s of this.db.listUnresolvedSettlements(exchangeName)) {
      if (s.kind === 'entry' && s.signal_id === entrySignalId && s.order_id) {
        orderIds.add(s.order_id);
      }
    }
    const bracket = this.db.getSignalBracket(entrySignalId);
    if (bracket?.stop_loss_order_id) orderIds.add(bracket.stop_loss_order_id);
    if (bracket?.take_profit_order_id) orderIds.add(bracket.take_profit_order_id);

    // Resting DCA scale-in adds are handled separately (below) via the same
    // verify-before-drop guard as the close path, so a rung that filled in the
    // cancel race is booked instead of silently dropped. Keeping them out of the
    // generic cancel loop (which swallows every error) is what makes that guard
    // reachable.
    const restingRungCount = this.db.getDcaRestingRungsForSignal(entrySignalId).length;

    if (orderIds.size === 0 && restingRungCount === 0) {
      // Nothing resting to cancel (e.g. a market entry that filled-and-closed, or
      // the order was already retired). Graceful idempotent ack.
      this.db.log('info', 'trading', 'cancel: no resting order found', {
        signalId: signal.id,
        entrySignalId,
      });
      if (exec) this.db.updateSignalExecution(entrySignalId, { status: 'closed' });
      this.db.updateSignalStatus(signal.id, 'executed', undefined, 'cancel: nothing to cancel');
      await this.ackToApi(signal.id, 'executed', undefined);
      return;
    }

    const adapter = session.adapter;
    for (const orderId of orderIds) {
      // Drop the OCO pairing for this leg regardless of cancel outcome.
      this.brackets.delete(orderId);
      try {
        await adapter.cancelOrder(orderId);
        this.db.log('info', 'trading', 'cancel: resting order cancelled', {
          signalId: signal.id,
          entrySignalId,
          orderId,
        });
      } catch (err: any) {
        // Order already gone (filled/cancelled/unknown id) → treat as cancelled.
        this.db.log('warn', 'trading', 'cancel: order already gone', {
          signalId: signal.id,
          entrySignalId,
          orderId,
          error: err?.message,
        });
      }
    }

    // Cancel any resting DCA scale-in adds tracked for this entry with the same
    // verify-before-drop guard as the close path (a rung that filled in the race
    // is booked, not silently dropped; a live one on a failed cancel keeps its
    // tracking row).
    await this.cancelRestingDcaRungsForSignals(exchangeName, [entrySignalId]);

    // The resting entry never became a held position → close out its tracking and
    // drop the persisted bracket pair so a restart doesn't rehydrate dead legs.
    this.db.deleteBracketPair(entrySignalId);
    if (exec) this.db.updateSignalExecution(entrySignalId, { status: 'closed' });
    this.db.updateSignalStatus(signal.id, 'executed', undefined, 'cancel: resting orders cancelled');
    await this.ackToApi(signal.id, 'executed', undefined);
  }

  private async executeCloseSignal(signal: Signal, sub: any | null) {
    this.db.log('info', 'signal', 'Processing close signal', {
      signalId: signal.id,
      symbol: signal.symbol,
    });

    if (!this.exchangeManager) {
      const reason = 'exchange manager not configured';
      this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
      await this.ackToApi(signal.id, 'rejected', undefined, reason);
      return;
    }

    const venue = resolveVenue({
      subscriptionExchange: sub?.exchange as string | undefined,
      signalMetadataExchange: signal.metadata?.exchange as string | undefined,
    });
    if (!venue.exchange) {
      this.db.log('error', 'signal', 'Close: no execution venue resolvable', {
        signalId: signal.id,
        symbol: signal.symbol,
        reason: venue.rejectReason,
      });
      this.db.updateSignalStatus(signal.id, 'rejected', undefined, venue.rejectReason!);
      await this.ackToApi(signal.id, 'rejected', undefined, venue.rejectReason!);
      return;
    }
    const exchangeName = venue.exchange;

    // Entry rows are recorded under the CANONICAL symbol (recordSignal runs before
    // the venue remap), so the entry lookup below must query by canonical — not the
    // venue symbol signal.symbol is about to become. Missing this made composite
    // closes ('BTC' → 'BTCUSDT'/'BTC-PERPETUAL') match nothing: brackets stayed
    // live, exit fills were unattributed and the daily-loss rail went blind.
    const canonicalSymbol = signal.symbol;
    const mapping = mapToVenueSymbol(exchangeName, signal.symbol, signal.metadata?.venueSymbols);
    if (!mapping.venueSymbol) {
      this.db.updateSignalStatus(signal.id, 'rejected', undefined, mapping.rejectReason!);
      await this.ackToApi(signal.id, 'rejected', undefined, mapping.rejectReason!);
      return;
    }
    signal.symbol = mapping.venueSymbol;
    await ensureContractConstraints(exchangeName, signal.symbol);

    // The sub's connection (account_key / namespaced account_id) owns the
    // position; the default connection is what every pre-label sub resolves to.
    const session = await this.sessionForAccount(
      exchangeName,
      this.subAccountId(sub, exchangeName, signal.symbol),
    );
    if (!session || session.status !== 'connected') {
      const reason = session ? `session status ${session.status}` : 'no session for exchange';
      this.db.log('error', 'signal', 'Close: no connected exchange session', {
        signalId: signal.id,
        exchange: exchangeName,
        reason,
      });
      this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
      await this.ackToApi(signal.id, 'rejected', undefined, reason);
      return;
    }

    // Lineage identities the close carries (see the entry-signal lookup below
    // for why every candidate is tried).
    const subFilterCandidates = [
      sub?.id as string | undefined,
      signal.metadata?.subscriptionId as string | undefined,
      signal.metadata?.signalBotId as string | undefined,
    ].filter((v, i, a): v is string => typeof v === 'string' && v.length > 0 && a.indexOf(v) === i);

    // Which dated contract to close (futures root): the one this lineage's own
    // open entry was filled on, whatever today's front is — after a roll the
    // position still sits on the old contract until the user rolls it
    // (roll-position). Then the engine's contract hint, then our quote pick.
    let closeSymbol = signal.symbol;
    const closeRoot = rootOf(signal.symbol);
    const heldContracts = new Set<string>();
    for (const cand of subFilterCandidates.length > 0 ? subFilterCandidates : [undefined]) {
      for (const entry of this.db.getOpenEntrySignals(canonicalSymbol, cand)) {
        const exec = this.db.getSignalExecution(entry.id);
        if (exec && exec.status !== 'error' && isDatedContractOf(exec.symbol, closeRoot)) {
          heldContracts.add(exec.symbol.toUpperCase());
        }
      }
      if (heldContracts.size > 0) break;
    }
    if (heldContracts.size > 1) {
      this.db.log('warn', 'signal', 'Close: lineage holds more than one contract, using the front', {
        signalId: signal.id, symbol: signal.symbol, contracts: [...heldContracts],
      });
    }
    let resolvedFront: string | null = null;
    if (heldContracts.size !== 1 && session.adapter.resolveSymbol) {
      try {
        resolvedFront = await session.adapter.resolveSymbol(signal.symbol);
      } catch {
        /* fall back to the raw symbol; the position match below may still hit */
      }
    }
    const picked = pickOrderContract({
      root: closeRoot,
      held: heldContracts.size === 1 ? [...heldContracts][0] : null,
      hint: signal.metadata?.contract,
      resolved: resolvedFront,
    });
    if (picked.source !== 'root') closeSymbol = picked.symbol;
    else if (resolvedFront) closeSymbol = resolvedFront;

    // ─── Resolve live position (source of truth for side + size) ───
    // Account-scoped (vangnet 2026-08-26, Volcap cross-account close): a
    // subscription-routed close may only ever see ITS OWN account's position.
    // The symbol-only match found ANOTHER account's long on the same contract,
    // "closed" it with a sell routed to the sub's account — and TradeStation
    // has no reduce-only, so that opened an unintended short (order
    // 1301467781). Position identity is (exchange, account, symbol).
    const scopeAccountId = (sub?.account_id as string | undefined) ?? undefined;
    let position: Position | undefined;
    try {
      const positions = await session.adapter.getPositions();
      position = positions.find(
        (p) =>
          p.symbol.toLowerCase() === closeSymbol.toLowerCase() &&
          Math.abs(p.size) > 0 &&
          (scopeAccountId == null || p.accountId == null || p.accountId === scopeAccountId),
      );
    } catch (err: any) {
      const reason = `failed to fetch positions: ${err.message}`;
      this.db.log('error', 'signal', 'Close: position lookup failed', {
        signalId: signal.id,
        exchange: exchangeName,
        error: err.message,
      });
      this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
      await this.ackToApi(signal.id, 'rejected', undefined, reason);
      return;
    }

    // Find local entry signals so we can cancel their bracket legs. Filter by
    // subscription/bot when the close carries one, to avoid touching unrelated
    // positions on the same symbol. Try every identity the close carries until
    // one MATCHES: live entry metadata carries only signalBotId (the server's
    // owner-sub has no subscription row → no subscriptionId on the wire, and
    // the executor-local `local-…` sub id never appears in signal metadata), so
    // filtering on sub.id alone can never match — the close then books nothing
    // (qty_closed stays 0) and the reconciler re-opens the just-closed position
    // (2026-08-26 struct-entry phantom rebuy).
    let subFilter: string | undefined = subFilterCandidates[0];
    let allEntrySignals: ReturnType<KaiBotDatabase['getOpenEntrySignals']> = [];
    for (const cand of subFilterCandidates) {
      const rows = this.db.getOpenEntrySignals(canonicalSymbol, cand);
      if (rows.length > 0) {
        subFilter = cand;
        allEntrySignals = rows;
        break;
      }
    }
    // No identity on the close at all → legacy unscoped flatten semantics:
    // every open entry on the symbol.
    if (subFilterCandidates.length === 0) {
      allEntrySignals = this.db.getOpenEntrySignals(canonicalSymbol, undefined);
    }

    // Failed-open guard: drop entry signals whose execution never opened (status
    // 'error'). They hold no position, so the close must not retire them or
    // cancel brackets that were never placed. Surface a clear activity error.
    const entrySignals = allEntrySignals.filter((e) => {
      const exec = this.db.getSignalExecution(e.id);
      if (exec && exec.status === 'error') {
        this.db.log('warn', 'signal', 'Close skips a failed-open entry (never opened)', {
          closeSignalId: signal.id,
          entrySignalId: e.id,
          reason: exec.error_reason,
        });
        this.notifications?.publish({
          type: 'error',
          title: 'Close skipped a failed entry',
          body: `Entry ${e.id} for ${signal.symbol} failed to open (${exec.error_reason ?? 'unknown'}); not closing it.`,
          data: { closeSignalId: signal.id, entrySignalId: e.id, symbol: signal.symbol },
        });
        return false;
      }
      return true;
    });

    // ─── Lineage guard (2026-09-01, B&C zombie close) ───
    // A close that CARRIES a bot/sub identity may only ever flatten its own
    // lineage. When none of its identities has an open entry on this symbol,
    // this bot holds nothing here — whatever the account-scoped position
    // lookup found belongs to ANOTHER lineage on the same (account, symbol).
    // Tonight's incident: B&C Alpha's zombie close (its entry was guardrail-
    // rejected) matched the Ascender's MNQ long and sold it; only the Globex
    // maintenance pause cancelled the order. Desired end-state for THIS
    // lineage is flat → executed no-op ack, never an order. Identity-less
    // closes keep the legacy unscoped flatten semantics below.
    if (subFilterCandidates.length > 0 && entrySignals.length === 0) {
      this.db.log('warn', 'signal', 'Close: no open entries for this lineage — no-op', {
        signalId: signal.id,
        symbol: signal.symbol,
        exchange: exchangeName,
        identities: subFilterCandidates,
        venuePositionPresent: !!position,
      });
      if (position) {
        this.notifications?.publish({
          type: 'error',
          title: 'Close ignored: not this bot\'s position',
          body: `A close for ${signal.symbol} carries a bot/subscription with no open entries; the live position belongs to another bot or manual trade and was left alone.`,
          data: { signalId: signal.id, symbol: signal.symbol, identities: subFilterCandidates },
        });
      }
      this.db.updateSignalStatus(signal.id, 'executed', undefined, 'no open entries for this lineage');
      await this.ackToApi(signal.id, 'executed', undefined, undefined);
      return;
    }

    // ─── Close idempotency: block restacking a close (Item 1) ───
    // A matching entry execution already in 'closing' means a prior close was
    // placed but never confirmed a fill (rejected/cancelled/timeout). That close
    // is owned by retryPendingCloses / resolveUnknownOrders; a second close
    // signal must NOT place another order on top — that's exactly how a position
    // overshoots/reverses. Mirrors kaibot-exec exec-service, where a close on an
    // execution already 'closing' (prior order unresolved) is a no-op.
    const inFlightClose = entrySignals.find(
      (e) => this.db.getSignalExecution(e.id)?.status === 'closing',
    );
    if (inFlightClose) {
      this.db.log('info', 'signal', 'Close ignored: a prior close is still in flight', {
        signalId: signal.id,
        entrySignalId: inFlightClose.id,
        symbol: signal.symbol,
      });
      this.db.updateSignalStatus(signal.id, 'pending', undefined, 'prior close in flight');
      // No ack and no order: the earlier close finishes the job.
      return;
    }

    // ─── Lineage-scoped close (R1, 2026-09-05: two bots on one Deribit
    // instrument) ───
    // Side and size of a bot-scoped close come from the bot's OWN open
    // executions on (exchange, account, symbol), never from the venue net: a
    // bc-short next to a fault-line-long nets the venue to ~flat (or to the
    // OTHER bot's side), and "opposite of the venue side, capped at the venue
    // size" then buys the wrong way or does nothing. Trusting the book over
    // the venue is only safe when the whole book on that pair EXPLAINS the
    // venue net (other lineages account for the difference) — a drifted book
    // (stop filled elsewhere, unbooked exit) keeps the venue-truth semantics.
    const lineage = subFilter
      ? this.resolveLineageClose(exchangeName, closeSymbol, entrySignals, position, scopeAccountId)
      : null;

    if (!position && !lineage?.bookConsistent) {
      // Nothing live to close. Still tidy up any orphaned bracket legs and
      // mark the entries closed so they don't linger. Ack executed — the
      // desired end-state (flat) is satisfied.
      this.db.log('warn', 'signal', 'Close: no open position on exchange, reconciling brackets', {
        signalId: signal.id,
        symbol: signal.symbol,
        exchange: exchangeName,
      });
      await this.cancelBracketsForEntries(exchangeName, entrySignals);
      await this.cancelRestingDcaRungsForSignals(exchangeName, entrySignals.map((e) => e.id));
      for (const e of entrySignals) {
        this.db.markEntrySignalClosed(e.id, 'closed: no live position');
        if (this.db.getSignalExecution(e.id)) {
          this.db.updateSignalExecution(e.id, { status: 'closed' });
        }
      }
      this.retireServerExitStatesFor(entrySignals.map((e) => e.id));
      this.db.updateSignalStatus(signal.id, 'executed', undefined, 'no open position');
      await this.ackToApi(signal.id, 'executed', undefined, undefined);
      return;
    }

    // ─── Determine close quantity (partial vs full) ───
    // Venue net (0 when the other lineage nets this one out entirely).
    const positionSize = position ? Math.abs(position.size) : 0;

    // Close base: the lineage's own tracked book when the close is bot-scoped
    // and that book is venue-consistent (see resolveLineageClose); otherwise
    // the legacy venue-position base (flatten semantics) — untracked/unscoped
    // closes, or a book that does not explain the venue.
    const closeBaseQty = lineage ? lineage.qty : positionSize;
    const requestedSize = this.resolveCloseSize(signal, closeBaseQty);

    // Trust the lineage for side + cap when the venue covers the close on the
    // lineage's side (a plain reduce-only, identical to the legacy outcome),
    // OR when the whole book explains the venue net (the other lineage nets
    // this one out: the close is a reversal at the venue, sized to the
    // lineage's own quantity, never more). A venue that neither covers nor is
    // explained by the book means the book drifted → venue-truth: side and
    // cap from the venue, exactly as before.
    const trustLineage =
      !!lineage && (lineage.venueCovers(requestedSize) || lineage.bookConsistent);
    const closeCap = trustLineage ? lineage!.qty : positionSize;
    let closeQty = Math.min(requestedSize, closeCap);

    const { minSize, stepSize } = getContractConstraints(exchangeName, signal.symbol);
    if (stepSize > 0) {
      const before = closeQty;
      closeQty = roundToStep(closeQty, stepSize);
      // A close must never leave dust the exchange won't accept on the way out:
      // if rounding down would zero a still-open partial, fall back to closing
      // the whole (bot-scoped) base instead of silently no-op'ing.
      if (closeQty <= 0 && closeCap > 0) {
        const fallback = Math.min(closeBaseQty, closeCap);
        closeQty = roundToStep(fallback, stepSize) || fallback;
      }
      if (closeQty !== before) {
        this.db.logSafetyClip({
          signalId: signal.id,
          subscriptionId: sub?.id,
          reason: 'step_size_round',
          originalQuantity: before,
          adjustedQuantity: closeQty,
        });
      }
    }

    if (closeQty <= 0 || (minSize > 0 && closeQty < minSize && closeQty < closeCap)) {
      const reason = `close quantity ${closeQty} below min contract size (${minSize})`;
      this.db.updateSignalStatus(signal.id, 'rejected', undefined, reason);
      await this.ackToApi(signal.id, 'rejected', undefined, reason);
      return;
    }

    const isFullClose = isFullCloseRequest(requestedSize, closeQty, closeBaseQty);

    // ─── Reduce/close dedup via targetLabel (Item 4) ───
    // A re-fired exit for the SAME target (e.g. TP1 delivered twice) must not
    // place a second order. The settlement row for (signal, kind='exit',
    // targetLabel) is the dedup key; if it already produced a non-retryable
    // outcome (filled / in-flight unknown), this close is a no-op. Mirrors
    // kaibot-exec exec-service reduce dedup via targetAlreadyProcessed.
    const targetLabel = this.resolveExitTargetLabel(signal, isFullClose, closeQty);
    if (this.db.targetAlreadyProcessed(signal.id, 'exit', targetLabel)) {
      this.db.log('info', 'signal', 'Close/reduce ignored: target already processed', {
        signalId: signal.id,
        targetLabel,
        symbol: signal.symbol,
      });
      // NO second ack (2026-09-04, close 89ec2b65): the original execution
      // already acked this signal; a replayed duplicate's fresh executed-ack
      // made the server's close-reconcile pick the NEWEST open row — it closed
      // a position opened an hour AFTER this close, and the reverse-sync then
      // flattened a sim whose broker position was live. The server already
      // knows the outcome; re-telling it is what did the damage.
      this.db.updateSignalStatus(signal.id, 'executed', undefined, `duplicate ${targetLabel}`);
      return;
    }

    // ─── Cancel bracket siblings + resting DCA adds — FULL close only ───
    // A partial (fraction) close leaves the position live, so its protective
    // SL/TP legs and same-side DCA rungs MUST survive. Cancelling them here would
    // strand the remainder naked: the server refuses stop_update for a partial and
    // the reconciler has no bracket logic on crypto venues, so nothing re-places a
    // stop. The bracket legs are reduce-only (see bracket placement), so a stop
    // still sized for the pre-reduce position harmlessly reduces at most what's
    // left — leaving it in place is the safe variant with the existing adapter API.
    // Mirrors backtester parity, which keeps brackets on the remainder for the
    // same fraction close.
    if (isFullClose) {
      await this.cancelBracketsForEntries(exchangeName, entrySignals, position?.accountId);
      // Cancel any resting DCA scale-in adds so a same-side rung can't fill after
      // the position is closed (phantom-position guard on non-reconciled venues).
      await this.cancelRestingDcaRungsForSignals(exchangeName, entrySignals.map((e) => e.id));
    }

    // Market order on the opposite side of the LINEAGE (bot-scoped) or of the
    // venue position (legacy). reduce-only only when the venue net is on the
    // lineage's side and covers the order — when the other lineage has netted
    // the venue flat or to its own side, this close must move the net BY the
    // lineage's quantity (it is a reversal at the venue), so reduce-only would
    // be rejected or clipped to nothing.
    const closeSide: 'buy' | 'sell' = trustLineage
      ? lineage!.direction === 'long'
        ? 'sell'
        : 'buy'
      : position!.side === 'long'
        ? 'sell'
        : 'buy';
    const reduceOnly = trustLineage ? lineage!.venueCovers(closeQty) : true;
    const accountId = withAccountKey(
      sub?.account_key as string | undefined,
      (sub?.account_id as string | undefined) ??
        position?.accountId ??
        this.resolveAccountId(exchangeName, signal.symbol),
    );

    // Dated close symbol, never the root: the adapter would re-resolve a root
    // to today's front and close the wrong contract after a roll.
    const order: Order = {
      accountId,
      symbol: closeSymbol,
      side: closeSide,
      orderType: 'market',
      quantity: closeQty,
      reduceOnly,
      label: `kaibot:${signal.id}:close`,
      // Keyed by the exit target so a re-fired TP1 collides broker-side while
      // TP1/TP2 (different targets) stay distinct.
      clientOrderId: deriveClientOrderId(signal.id, `exit:${targetLabel}`),
    };

    try {
      const result = await session.adapter.placeOrder(order);
      this.db.log('info', 'trading', 'Close order placed', {
        signalId: signal.id,
        orderId: result.orderId,
        status: result.status,
        side: closeSide,
        quantity: closeQty,
        partial: !isFullClose,
        positionSize,
        reduceOnly,
        ...(trustLineage ? { lineage: { direction: lineage!.direction, qty: lineage!.qty } } : {}),
      });

      // ─── Settle the close before retiring anything. An unconfirmed close
      // must NOT mark the position closed — that's exactly how a still-live
      // position gets double-handled. Instead, persist the unknown outcome and
      // flag the matching entry executions 'closing' so retryPendingCloses
      // re-issues until it confirms (or the unknown order resolves). ───
      const settled = await this.settleClose(
        session.adapter,
        result,
        signal,
        closeSymbol,
        exchangeName,
        accountId,
        closeSide,
        closeQty,
        targetLabel,
      );

      if (settled.outcome === 'unknown') {
        for (const e of entrySignals) {
          if (this.db.getSignalExecution(e.id)) {
            // Remember the requested close qty so the retry re-issues exactly
            // this fraction — never the whole live position.
            this.db.updateSignalExecution(e.id, { status: 'closing', qtyPendingClose: closeQty });
          }
        }
        this.db.updateSignalStatus(signal.id, 'pending', undefined, 'close outcome pending');
        // No ack yet: the close hasn't confirmed. retryPendingCloses finishes it.
        return;
      }

      // Terminal partial fill (e.g. a done-for-day kill after a partial fill):
      // book ONLY what actually filled and keep the remainder pending — booking
      // the full closeQty would retire a position that is still partly live.
      const filledCloseQty =
        settled.filledQty && settled.filledQty > 0 ? Math.min(settled.filledQty, closeQty) : closeQty;
      if (filledCloseQty < closeQty - 1e-9) {
        const remainder = closeQty - filledCloseQty;
        const exitPricePartial =
          settled.avgPrice && settled.avgPrice > 0 ? settled.avgPrice : signal.price ?? null;
        this.attributeExitFills(
          entrySignals,
          filledCloseQty,
          closeSymbol,
          closeSide,
          exitPricePartial,
          result.orderId,
          false,
        );
        for (const e of entrySignals) {
          if (this.db.getSignalExecution(e.id)) {
            this.db.updateSignalExecution(e.id, { status: 'closing', qtyPendingClose: remainder });
          }
        }
        // Dedup a re-fired same-target close against this order's outcome.
        if (result.orderId) {
          this.db.insertOrderSettlement({
            signalId: signal.id,
            exchange: exchangeName,
            accountId,
            symbol: closeSymbol,
            category: (signal.metadata?.category as string | undefined) ?? null,
            kind: 'exit',
            side: closeSide,
            qty: filledCloseQty,
            orderId: result.orderId,
            targetLabel,
            status: 'filled',
          });
        }
        this.db.log('warn', 'trading', 'Close partially filled — remainder pending retry', {
          signalId: signal.id,
          orderId: result.orderId,
          filled: filledCloseQty,
          remainder,
        });
        this.db.updateSignalStatus(signal.id, 'pending', undefined, 'close partially filled; remainder retrying');
        // No ack yet: the position isn't flat. retryPendingCloses finishes it.
        return;
      }

      // Record the resolved exit against its target so a re-fired close/reduce
      // for the same target dedups to this row (Item 1 + Item 4). The 'filled'
      // status is non-retryable → targetAlreadyProcessed returns true next time.
      if (result.orderId) {
        this.db.insertOrderSettlement({
          signalId: signal.id,
          exchange: exchangeName,
          accountId,
          symbol: closeSymbol,
          category: (signal.metadata?.category as string | undefined) ?? null,
          kind: 'exit',
          side: closeSide,
          qty: closeQty,
          orderId: result.orderId,
          targetLabel,
          status: 'filled',
        });
      }

      // Confirmed (or best-effort filled): record exit fills + retire/reduce.
      const exitPrice =
        settled.avgPrice && settled.avgPrice > 0 ? settled.avgPrice : signal.price ?? null;
      this.attributeExitFills(
        entrySignals,
        closeQty,
        closeSymbol,
        closeSide,
        exitPrice,
        result.orderId,
        isFullClose,
      );

      // Persist outcome: a full close retires the matching entry signals AND
      // their server exit state — a spent state row left active makes the
      // venue-exit sweep poll its cancelled stop forever (2026-09-02 MNQU26).
      if (isFullClose) {
        for (const e of entrySignals) this.db.markEntrySignalClosed(e.id, `closed by ${signal.id}`);
        this.retireServerExitStatesFor(entrySignals.map((e) => e.id));
      }
      this.db.updateSignalStatus(
        signal.id,
        'executed',
        undefined,
        isFullClose ? 'position closed' : `partial close (${closeQty}/${positionSize})`,
      );
      await this.ackToApi(signal.id, 'executed', result.orderId, undefined, undefined, undefined, {
        price: exitPrice,
        size: closeQty,
        time: Date.now(),
      });

      this.notifications?.publish({
        type: 'order_filled',
        title: isFullClose ? 'Position closed' : 'Position reduced',
        body: `✓ CLOSE ${closeQty} ${signal.symbol}${result.orderId ? ` (#${result.orderId})` : ''}`,
        data: {
          signalId: signal.id,
          orderId: result.orderId,
          symbol: signal.symbol,
          quantity: closeQty,
          partial: !isFullClose,
        },
      });
    } catch (orderError: any) {
      this.db.log('error', 'trading', 'Close order placement failed', {
        signalId: signal.id,
        error: orderError.message,
      });
      this.db.updateSignalStatus(signal.id, 'rejected', undefined, orderError.message);
      await this.ackToApi(signal.id, 'rejected', undefined, orderError.message);
      this.notifications?.publish({
        type: 'order_rejected',
        title: 'Close rejected',
        body: `✗ CLOSE ${signal.symbol}: ${orderError.message || 'unknown error'}`,
        data: { signalId: signal.id, symbol: signal.symbol, error: orderError.message },
      });
    }
  }

  /**
   * Resolve the requested close size from a signal, against the REAL live
   * position size the executor just read from the exchange.
   *
   * Privacy contract: a live close carries ONLY `metadata.fraction` in (0,1] —
   * the server never ships an absolute size (it doesn't know the user's real
   * size; its own `size` is just the factor). A partial fraction closes
   * fraction × the real position size, computed HERE on the user's machine.
   * fraction >= 1 (or absent) flattens the whole position.
   *
   * Legacy absolute hints (`metadata.closeSize` / `metadata.size`) are still
   * honored for back-compat with any non-fraction caller, but fraction wins.
   * The bare `signal.quantity` is intentionally NOT used as a partial hint —
   * systematic exit signals carry quantity 1 as a "flatten" placeholder, so
   * honoring it would wrongly close a single contract of a larger position.
   */
  // `baseQty` is the close base the fraction applies to: the bot's OWN tracked
  // open qty for a bot-scoped close, else the venue position size (legacy).
  // Bot-scoped close semantics (R1, 2026-09-05). The lineage's own direction
  // and still-open quantity on this (exchange, account, symbol), plus whether
  // the venue net covers a reduce-only order of a given size. null when the
  // lineage holds nothing, or when the whole book on the pair does not explain
  // the venue net (drift: an unbooked exit elsewhere) — then the caller keeps
  // the venue-truth semantics instead of trusting a stale book.
  private resolveLineageClose(
    exchangeName: string,
    venueSymbol: string,
    entrySignals: Array<{ id: string; action?: 'buy' | 'sell' }>,
    position: Position | undefined,
    scopeAccountId: string | undefined,
  ): {
    direction: 'long' | 'short';
    qty: number;
    // Venue net sits on the lineage's side and covers a reduce-only order of this size.
    venueCovers: (qty: number) => boolean;
    // Every open execution on the pair, all lineages, adds up to the venue net.
    bookConsistent: boolean;
  } | null {
    const openQty = (e: { status: string; qty_opened: number; qty_closed: number }) =>
      e.status === 'open' || e.status === 'closing' ? Math.max(0, e.qty_opened - e.qty_closed) : 0;

    let lineageNet = 0;
    for (const e of entrySignals) {
      const exec = this.db.getSignalExecution(e.id);
      if (!exec) continue;
      const q = openQty(exec);
      if (q <= 0) continue;
      const dir = exec.direction ?? (e.action === 'sell' ? 'short' : 'long');
      lineageNet += dir === 'long' ? q : -q;
    }
    if (Math.abs(lineageNet) <= 1e-9) return null;

    const venueNet = position
      ? position.side === 'long'
        ? Math.abs(position.size)
        : -Math.abs(position.size)
      : 0;
    const accountId = scopeAccountId ?? position?.accountId;

    // Whole-book net on the pair, every lineage. Defensive on the DB surface
    // (close-path test doubles predate the listing): without it the lineage
    // is the whole book.
    const lister = (this.db as { listOpenExecutionsForExchange?: (ex: string) => any[] })
      .listOpenExecutionsForExchange;
    let bookNet = lineageNet;
    if (typeof lister === 'function') {
      bookNet = 0;
      for (const e of lister.call(this.db, exchangeName)) {
        if (String(e.symbol).toLowerCase() !== venueSymbol.toLowerCase()) continue;
        if (accountId && e.account_id && e.account_id !== accountId) continue;
        const q = openQty(e);
        if (q <= 0) continue;
        bookNet += e.direction === 'long' ? q : -q;
      }
    }

    // The armed synthetic's minted short sits on this same instrument and is
    // not an execution: it explains the venue net too (a bot long next to the
    // synthetic short nets to flat at the venue).
    const synthetic = (
      this.db as {
        getLiveSyntheticUsdPosition?: (
          exchange: string,
          account: string,
          symbol: string,
        ) => { status: string; short_size: number } | null | undefined;
      }
    ).getLiveSyntheticUsdPosition;
    if (typeof synthetic === 'function' && accountId) {
      const row = synthetic.call(this.db, exchangeName, accountId, venueSymbol);
      if (row && row.status === 'open' && row.short_size > 0) bookNet -= row.short_size;
    }

    const { stepSize } = getContractConstraints(exchangeName, venueSymbol);
    const tol = Math.max(stepSize > 0 ? stepSize / 2 : 0, 1e-9);
    const bookConsistent = Math.abs(bookNet - venueNet) <= tol;
    const direction: 'long' | 'short' = lineageNet > 0 ? 'long' : 'short';
    const sameSideVenue = direction === 'long' ? venueNet : -venueNet;
    if (!bookConsistent) {
      this.db.log('info', 'signal', 'Close: book does not fully explain the venue net', {
        exchange: exchangeName,
        symbol: venueSymbol,
        lineageNet,
        bookNet,
        venueNet,
      });
    }
    return {
      direction,
      qty: Math.abs(lineageNet),
      venueCovers: (qty: number) => sameSideVenue >= qty - tol,
      bookConsistent,
    };
  }

  private resolveCloseSize(signal: Signal, baseQty: number): number {
    const fraction = this.toPositiveNumber(signal.metadata?.fraction);
    if (fraction !== undefined) {
      return fraction >= 1 ? baseQty : baseQty * fraction;
    }
    const explicit =
      this.toPositiveNumber(signal.metadata?.closeSize) ??
      this.toPositiveNumber(signal.metadata?.size);
    return explicit !== undefined ? explicit : baseQty;
  }

  private toPositiveNumber(value: unknown): number | undefined {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  /**
   * Stable label identifying which exit target a close/reduce belongs to, used
   * as the per-target dedup key (signal_id, kind='exit', target_label) so a
   * re-fired reduce for the same target is a no-op instead of double-executing.
   *
   * Scheme (the signal payload carries no native TP1/TP2 identifier):
   *  - an explicit `metadata.target` / `metadata.label` wins (e.g. 'TP1','SL');
   *  - a full close → 'close' (one effective close per signal);
   *  - a sized partial reduce → 'reduce:<size>', so two re-fires of the same
   *    partial collapse, while TP1 then TP2 (different sizes) stay distinct.
   */
  private resolveExitTargetLabel(signal: Signal, isFullClose: boolean, closeQty: number): string {
    const explicit =
      (signal.metadata?.target as string | undefined) ??
      (signal.metadata?.label as string | undefined);
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
    if (isFullClose) return 'close';
    return `reduce:${closeQty}`;
  }

  /**
   * Spread a close's filled quantity across the matching entry signals (newest
   * first) and record an exit fill per entry, so each signal's fills-based PnL
   * reflects what was closed against it. A full close also marks each touched
   * execution 'closed'. The local positions table is not the source of truth —
   * this is purely for per-signal PnL bookkeeping.
   */
  private attributeExitFills(
    entrySignals: Array<{ id: string }>,
    closeQty: number,
    symbol: string,
    side: 'buy' | 'sell',
    price: number | null,
    orderId: string | undefined,
    isFullClose: boolean,
  ) {
    let remaining = closeQty;
    for (const e of entrySignals) {
      if (remaining <= 1e-9) break;
      const exec = this.db.getSignalExecution(e.id);
      // How much of this entry is still open (opened minus already closed).
      const openQty = exec ? Math.max(0, exec.qty_opened - exec.qty_closed) : remaining;
      const portion = isFullClose ? (exec ? openQty : remaining) : Math.min(remaining, openQty || remaining);
      if (portion <= 0) continue;
      this.db.insertSignalFill({
        signalId: e.id,
        kind: 'exit',
        symbol,
        side,
        qty: portion,
        price,
        orderId: orderId ?? null,
      });
      if (exec) {
        const newClosed = exec.qty_closed + portion;
        this.db.updateSignalExecution(e.id, {
          qtyClosed: newClosed,
          status: newClosed >= exec.qty_opened - 1e-9 ? 'closed' : 'open',
        });
      }
      remaining -= portion;
    }
  }

  /**
   * Cancel any outstanding bracket (stop-loss / take-profit) legs recorded on
   * the given entry signals, and drop them from the in-memory OCO tracker.
   * Best-effort: a leg that is already gone/cancelled is logged and ignored.
   */
  private async cancelBracketsForEntries(
    exchangeName: string,
    entrySignals: Array<{ stop_loss_order_id: string | null; take_profit_order_id: string | null }>,
    // Account the legs rest on (routes to the owning connection).
    accountId?: string | null,
  ) {
    if (!this.exchangeManager) return;
    const orderIds = new Set<string>();
    for (const e of entrySignals) {
      if (e.stop_loss_order_id) orderIds.add(e.stop_loss_order_id);
      if (e.take_profit_order_id) orderIds.add(e.take_profit_order_id);
    }
    if (orderIds.size === 0) return;

    const session = await this.sessionForAccount(exchangeName, accountId);
    if (!session || session.status !== 'connected') return;

    for (const orderId of orderIds) {
      // Stop tracking this leg's OCO pair regardless of cancel outcome.
      this.brackets.delete(orderId);
      try {
        await session.adapter.cancelOrder(orderId);
        this.db.log('info', 'trading', 'Bracket leg cancelled on close', {
          exchange: exchangeName,
          orderId,
        });
      } catch (err: any) {
        this.db.log('warn', 'trading', 'Bracket leg cancel on close failed', {
          exchange: exchangeName,
          orderId,
          error: err.message,
        });
      }
    }
  }

  private async ackToApi(
    signalId: string,
    status: 'executed' | 'rejected' | 'deferred',
    tradeId?: string,
    errorMessage?: string,
    stopLossOrderId?: string,
    takeProfitOrderId?: string,
    // `size` is the REAL filled contract count — kept on the local fill object
    // for callers' bookkeeping but DELIBERATELY NOT sent to the API. The server
    // tracks positions in factor units only; the user's real size never leaves
    // this machine. Only price/time/order ids are acked.
    fill?: { price?: number | null; size?: number | null; time?: number | null },
  ) {
    if (!this.apiUrl) return;
    const sessionToken = process.env.EXECUTOR_SESSION_TOKEN;
    // Auth: prefer the per-user API key (server resolves the user from its hash,
    // same as the WS), fall back to the legacy shared session token. One must
    // exist or the server can't attribute the fill.
    if (!sessionToken && !this.apiKey) return;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (sessionToken) headers['x-session-token'] = sessionToken;

    try {
      const res = await fetch(`${this.apiUrl}/api/signals/ack`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          signalId,
          status,
          tradeId,
          errorMessage,
          stopLossOrderId,
          takeProfitOrderId,
          // Per-signal fill detail so the API can move the position from pending
          // to open. ONLY the fill PRICE/TIME are sent — never the real filled
          // size: positions.size on the server stays the seeded factor, so the
          // user's real contract count never leaves this machine (size leak).
          fillPrice: typeof fill?.price === 'number' ? fill.price : undefined,
          fillTime: fill?.time ? new Date(fill.time).toISOString() : undefined,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.db.log('warn', 'signal', 'ack to API failed', {
          signalId,
          status: res.status,
          body: text,
        });
      }
      this.recordAckOutcome(signalId, res.ok);
    } catch (err: any) {
      this.db.log('warn', 'signal', 'ack to API error', {
        signalId,
        error: err.message,
      });
      this.recordAckOutcome(signalId, false);
    }
  }

  // Bookkeeping only: the Signals drawer shows whether the server was told.
  // Never allowed to throw into the ack path.
  private recordAckOutcome(signalId: string, ok: boolean): void {
    try {
      this.db.recordSignalAck(signalId, ok);
    } catch {
      /* the ack itself already happened; the timestamp is cosmetic */
    }
  }

  /**
   * Settle a freshly placed close order. A close that doesn't confirm a fill
   * leaves the position live, so any non-filled outcome (rejected / cancelled /
   * timeout) is reported as 'unknown' → the caller keeps the entries 'closing'
   * and retryPendingCloses re-issues. A timeout also persists a settlement row
   * so the unknown broker outcome can be resolved later. Only a confirmed fill
   * retires the position.
   */
  private async settleClose(
    adapter: ExchangeAdapter,
    result: OrderResult,
    signal: Signal,
    closeSymbol: string,
    exchangeName: string,
    accountId: string,
    closeSide: 'buy' | 'sell',
    closeQty: number,
    targetLabel: string = 'close',
  ): Promise<{ outcome: 'filled' | 'unknown'; avgPrice?: number; filledQty?: number }> {
    if (result.status === 'filled') {
      return {
        outcome: 'filled',
        avgPrice: result.averagePrice,
        filledQty:
          result.filledQuantity && result.filledQuantity > 0 ? result.filledQuantity : closeQty,
      };
    }
    if (!adapter.getOrderStatus) {
      // Can't confirm → trust the result (legacy best-effort behavior).
      return {
        outcome: 'filled',
        avgPrice: result.averagePrice,
        filledQty:
          result.filledQuantity && result.filledQuantity > 0 ? result.filledQuantity : closeQty,
      };
    }

    const settled = await settleAdapterOrder(
      adapter,
      result.orderId,
      {
        accountId,
        symbol: closeSymbol,
        category: (signal.metadata?.category as string | undefined) ?? undefined,
      },
      { attempts: this.settleAttempts, intervalMs: this.settleIntervalMs },
    );

    if (settled.status === 'filled' || settled.status === 'partially_filled') {
      // Report the REAL filled qty: a terminal partial (e.g. a done-for-day
      // kill after a partial fill) must not be booked as a full close — the
      // caller books the actual qty and keeps the remainder pending.
      return {
        outcome: 'filled',
        avgPrice: settled.averagePrice,
        filledQty:
          settled.filledQuantity && settled.filledQuantity > 0 ? settled.filledQuantity : closeQty,
      };
    }

    // Not filled → the position is still live. Persist the unknown order for
    // background resolution and let the close be retried.
    if (settled.status === 'timeout') {
      this.db.insertOrderSettlement({
        signalId: signal.id,
        exchange: exchangeName,
        accountId,
        symbol: closeSymbol,
        category: (signal.metadata?.category as string | undefined) ?? null,
        kind: 'exit',
        side: closeSide,
        qty: closeQty,
        orderId: result.orderId,
        targetLabel,
      });
    }
    this.db.log('warn', 'trading', 'Close not confirmed, will retry', {
      signalId: signal.id,
      orderId: result.orderId,
      symbol: closeSymbol,
      settledStatus: settled.status,
    });
    if (settled.status === 'timeout') {
      this.notifications?.publish({
        type: 'error',
        title: 'Settlement timeout',
        body: `Close order for ${signal.symbol} (#${result.orderId}) timed out without a confirmed outcome — retrying in the background.`,
        data: { signalId: signal.id, orderId: result.orderId, symbol: signal.symbol, kind: 'settlement_timeout' },
      });
    }
    return { outcome: 'unknown' };
  }

  /**
   * Settle a freshly placed entry order. When the adapter reports a clear fill
   * up front, trust it. Otherwise, if the adapter can query order status, poll
   * to a terminal outcome. On timeout (unknown), persist an order_settlements
   * row so a background pass resolves it later — the position stays tracked.
   *
   * Returns:
   *  - { outcome: 'filled', filledQty, avgPrice } — position is live
   *  - { outcome: 'unknown', filledQty: 0 } — kept tracked, settlement persisted
   *  - { outcome: 'rejected', reason } — entry definitively failed
   */
  /**
   * Place the additional DCA / scale-in entry rungs (everything after the main
   * entry) as resting limit orders on the same side. A rung that fills up front
   * is recorded as an entry fill and accumulated into qty_opened so fills-based
   * PnL re-weights the average entry. A rung that rests unfilled is persisted to
   * dca_resting_rungs, NOT run through settleEntry: settling a still-'working'
   * limit cancels it after the ~10s settle window (order-settlement.ts), which
   * killed every scale-in add before it could fill AND never honored ttlBars.
   * The tracked rung is instead (a) TTL-cancelled by expireDcaRungs once past its
   * ttlBars-equivalent expiry, and (b) cancelled when the parent position closes
   * so it can't fill into a phantom position. Already inside the per-signal order
   * lock (handleSignal wraps the whole open path).
   */
  private async placeDcaRungs(
    adapter: ExchangeAdapter,
    signal: Signal,
    side: 'buy' | 'sell',
    orderSymbol: string,
    exchangeName: string,
    accountId: string,
    rungs: Array<{ price?: number; qty: number }>,
    mainFilledQty: number,
  ): Promise<void> {
    let cumulativeQty = mainFilledQty;
    for (let i = 0; i < rungs.length; i++) {
      const rung = rungs[i];
      if (!(rung.qty > 0)) continue;
      try {
        const rungResult = await adapter.placeOrder({
          accountId,
          symbol: orderSymbol,
          side,
          orderType: rung.price != null ? 'limit' : 'market',
          quantity: rung.qty,
          price: rung.price,
          reduceOnly: false,
          label: `kaibot:${signal.id}:dca${i + 1}`,
          clientOrderId: deriveClientOrderId(signal.id, 'dca', i + 1),
        });
        const immediateFill =
          rungResult.status === 'filled' ||
          (rungResult.status === 'partially_filled' && (rungResult.filledQuantity ?? 0) > 0);
        if (immediateFill) {
          const filledQty =
            rungResult.filledQuantity && rungResult.filledQuantity > 0
              ? rungResult.filledQuantity
              : rung.qty;
          const rungPrice =
            rungResult.averagePrice && rungResult.averagePrice > 0
              ? rungResult.averagePrice
              : rung.price ?? null;
          this.db.insertSignalFill({
            signalId: signal.id,
            kind: 'entry',
            symbol: orderSymbol,
            side,
            qty: filledQty,
            price: rungPrice,
            orderId: rungResult.orderId,
          });
          cumulativeQty += filledQty;
          this.db.updateSignalExecution(signal.id, { qtyOpened: cumulativeQty });
          this.db.log('info', 'trading', 'DCA rung placed', {
            signalId: signal.id,
            rung: i + 1,
            orderId: rungResult.orderId,
            price: rung.price,
            qty: rung.qty,
            outcome: 'filled',
          });
        } else if (rungResult.status === 'rejected') {
          this.db.log('warn', 'trading', 'DCA rung rejected', {
            signalId: signal.id,
            rung: i + 1,
            orderId: rungResult.orderId,
            reason: rungResult.message,
          });
        } else {
          // Resting (pending / working) → track it so ttlBars + cancel-on-close
          // can manage its lifecycle instead of the stuck-order settler.
          this.db.insertDcaRestingRung({
            orderId: rungResult.orderId,
            signalId: signal.id,
            exchange: exchangeName,
            accountId,
            symbol: orderSymbol,
            category: (signal.metadata?.category as string | undefined) ?? null,
            side,
            qty: rung.qty,
            price: rung.price ?? null,
            expiresAt: this.computeRungExpiry(signal),
          });
          this.db.log('info', 'trading', 'DCA rung placed', {
            signalId: signal.id,
            rung: i + 1,
            orderId: rungResult.orderId,
            price: rung.price,
            qty: rung.qty,
            outcome: 'resting',
          });
        }
      } catch (rungErr: any) {
        this.db.log('error', 'trading', 'DCA rung placement failed', {
          signalId: signal.id,
          rung: i + 1,
          error: rungErr.message,
        });
      }
    }
  }

  // Best-effort bar duration for this signal: metadata.timeframe first (forward-
  // compat; the server does not stamp it today), else the bot-config timeframe
  // looked up by metadata.signalBotId, else undefined.
  private resolveBarMs(signal: Signal): number | undefined {
    const metaTf = timeframeToMs(signal.metadata?.timeframe as string | undefined);
    if (metaTf !== undefined) return metaTf;
    const botId = signal.metadata?.signalBotId as string | undefined;
    if (!botId) return undefined;
    const cfg = this.db.getBotConfigs(false).find((c) => c.signalBotId === botId);
    return timeframeToMs(cfg?.timeframe);
  }

  // Absolute expiry (epoch ms) mirroring the backtest's plan.ttlBars resting-rung
  // cancellation, or null when ttlBars / bar duration can't be resolved — in
  // which case the rung degrades safely to cancel-on-close only.
  private computeRungExpiry(signal: Signal): number | null {
    const ttl = signal.order_plan?.ttlBars;
    const barMs = this.resolveBarMs(signal);
    return ttl && ttl > 0 && barMs ? Date.now() + ttl * barMs : null;
  }

  /**
   * Reconciler-hooked sweep over tracked resting DCA rungs (mirrors
   * resolveUnknownOrders). For each rung: settle it if it filled while resting,
   * drop it if it reached a terminal (rejected/cancelled/unknown) state, and
   * cancel it if it is still working past its ttlBars-equivalent expiry — the
   * live-executor analogue of the backtest cancelling a resting entry once the
   * bar index passes the plan's ttlBars. Runs inside the reconciler's order lock
   * so it never races an in-flight order. Returns the number of rungs acted on.
   */
  async expireDcaRungs(exchange?: string): Promise<number> {
    if (!this.exchangeManager) return 0;
    const rows = this.db
      .listDcaRestingRungs()
      .filter((r) => !exchange || r.exchange === exchange);
    if (rows.length === 0) return 0;
    const now = Date.now();
    let acted = 0;
    for (const row of rows) {
      const session = await this.sessionForAccount(row.exchange, row.account_id);
      if (!session || session.status !== 'connected') continue;
      const adapter = session.adapter;
      const getOrderStatus = adapter.getOrderStatus?.bind(adapter);
      if (!getOrderStatus) continue;
      const ctx = {
        accountId: row.account_id ?? undefined,
        symbol: row.symbol,
        category: row.category ?? undefined,
      };
      let status;
      try {
        status = await getOrderStatus(row.order_id, ctx);
      } catch {
        continue;
      }

      if (status.state === 'filled') {
        const filledQty =
          status.filledQuantity && status.filledQuantity > 0 ? status.filledQuantity : row.qty;
        this.bookRestingRungFillDelta(row, filledQty, status.averagePrice ?? null);
        this.db.deleteDcaRestingRung(row.order_id);
        acted++;
        this.db.log('info', 'trading', 'DCA rung filled while resting', {
          signalId: row.signal_id,
          orderId: row.order_id,
          qty: filledQty,
        });
        continue;
      }

      if (status.state === 'partially_filled') {
        // Partially filled but STILL RESTING at the broker (e.g. Bybit
        // 'PartiallyFilled' is a live status): book the newly filled delta and
        // KEEP tracking the residual resting qty — dropping the row here would
        // leave a live order unmanaged (no TTL cancel, no cancel-on-close).
        // Falls through to the TTL check so a stale residual still expires.
        const cum = status.filledQuantity && status.filledQuantity > 0 ? status.filledQuantity : 0;
        const alreadyBooked = row.filled_qty ?? 0;
        const delta = this.bookRestingRungFillDelta(row, cum, status.averagePrice ?? null);
        if (delta > 0) {
          row.filled_qty = alreadyBooked + delta;
          this.db.setDcaRestingRungFilledQty(row.order_id, row.filled_qty);
          acted++;
          this.db.log('info', 'trading', 'DCA rung partially filled while resting', {
            signalId: row.signal_id,
            orderId: row.order_id,
            filledQty: delta,
            restingQty: row.qty - row.filled_qty,
          });
        }
      } else if (status.state === 'rejected' || status.state === 'cancelled') {
        // Definitively terminal → the rung is gone; stop tracking it. A
        // cancelled rung may still carry a PARTIAL fill (Bybit reports
        // 'PartiallyFilledCanceled' as cancelled with cumExecQty > 0) — book
        // the filled portion before dropping, or the position is bigger than
        // the books say. 'unknown' is deliberately NOT terminal here: a
        // transient 'unknown' (exchange hiccup / propagation lag) must not drop
        // a still-live resting rung. It falls through to the TTL check below
        // and is retried next cycle, only removed once genuinely past its
        // ttlBars.
        const cum = status.filledQuantity && status.filledQuantity > 0 ? status.filledQuantity : 0;
        const delta = this.bookRestingRungFillDelta(row, cum, status.averagePrice ?? null);
        if (delta > 0) {
          this.db.log('info', 'trading', 'Cancelled DCA rung carried a partial fill — booked', {
            signalId: row.signal_id,
            orderId: row.order_id,
            filledQty: delta,
          });
        }
        this.db.deleteDcaRestingRung(row.order_id);
        acted++;
        continue;
      }

      // status.state === 'working' | 'unknown' | live 'partially_filled' → not
      // definitively terminal. Keep tracking (retry next cycle) and cancel only
      // once past the ttlBars expiry — a rung past its TTL still expires as
      // before (a partially-filled one cancels only its resting residual).
      if (row.expires_at != null && now > row.expires_at) {
        try {
          await adapter.cancelOrder(row.order_id, ctx);
          // The cancel raced any last-moment fill: re-check and book the
          // unbooked filled portion (PartiallyFilledCanceled) before dropping.
          await this.bookRungResidualFillAfterCancel(adapter, row);
          this.db.deleteDcaRestingRung(row.order_id);
          acted++;
          this.db.log('info', 'trading', 'DCA rung expired (ttlBars)', {
            signalId: row.signal_id,
            orderId: row.order_id,
          });
        } catch (err: any) {
          // Cancel failed at expiry — the rung may have filled in the race, or the
          // venue timed out with the order still live. Verify before dropping so a
          // late fill is booked and a still-live order keeps its tracking row.
          const outcome = await this.reconcileRestingRungAfterFailedCancel(adapter, row);
          if (outcome !== 'kept') acted++;
          this.db.log('warn', 'trading', 'DCA rung expiry cancel failed — reconciled', {
            signalId: row.signal_id,
            orderId: row.order_id,
            error: err?.message,
            outcome,
          });
        }
      }
    }
    return acted;
  }

  // Cancel + forget any resting DCA rungs for these signal ids. Called when the
  // parent position is closed (or the entry cancelled) so a same-side add can't
  // outlive the position and fill into a naked, bracket-less position on a
  // non-reconciled crypto venue — the reconciler's allowlist covers only
  // tradestation/interactivebrokers, exactly NOT the venues order_plan DCA runs on.
  // Public: the manual-trade close path retires its authored entry rungs
  // through this same verify-before-drop machinery (deps.cancelEntryRungs).
  async cancelRestingDcaRungsForSignals(
    exchangeName: string,
    signalIds: string[],
  ): Promise<void> {
    if (!this.exchangeManager || signalIds.length === 0) return;
    for (const signalId of signalIds) {
      for (const rung of this.db.getDcaRestingRungsForSignal(signalId)) {
        // The rung's account names its connection.
        const session = await this.sessionForAccount(exchangeName, rung.account_id);
        const adapter = session && session.status === 'connected' ? session.adapter : null;
        if (!adapter) {
          // Session disconnected mid-close: KEEP the row. Deleting it here would
          // stop tracking a still-live limit add that a later tick/expire pass
          // could cancel — the reconciler doesn't cover crypto venues, so a
          // dropped row is a naked, unalerted phantom add waiting to happen.
          this.db.log('warn', 'trading', 'Resting DCA rung kept (no connected session to cancel)', {
            signalId,
            orderId: rung.order_id,
          });
          continue;
        }
        try {
          await adapter.cancelOrder(rung.order_id, {
            accountId: rung.account_id ?? undefined,
            symbol: rung.symbol,
            category: rung.category ?? undefined,
          });
          // Cancel confirmed → the rung is gone; book any partial fill that
          // landed before the kill (PartiallyFilledCanceled), then stop
          // tracking it.
          await this.bookRungResidualFillAfterCancel(adapter, rung);
          this.db.deleteDcaRestingRung(rung.order_id);
          this.db.log('info', 'trading', 'Resting DCA rung cancelled on close', {
            signalId,
            orderId: rung.order_id,
          });
        } catch (err: any) {
          // Cancel threw — the rung may have FILLED in the race (price hit the
          // rung level just as the close fired) or the venue hiccuped. An
          // unconditional delete strands a live order or drops an unbooked fill,
          // so verify the real venue state before dropping tracking.
          const outcome = await this.reconcileRestingRungAfterFailedCancel(adapter, rung);
          this.db.log('warn', 'trading', 'Resting DCA rung cancel on close failed — reconciled', {
            signalId,
            orderId: rung.order_id,
            error: err?.message,
            outcome,
          });
        }
      }
    }
  }

  // Book the UNBOOKED portion of a resting DCA rung's fill as an entry fill and
  // accumulate it onto the parent execution's opened qty. `cumFilledQty` is the
  // venue-reported cumulative filled qty; the delta past the row's already-booked
  // filled_qty is what gets booked, so a rung that partially fills across several
  // sweeps is never double-counted. Returns the booked delta (0 = nothing new).
  // Shared by the expiry sweep and the cancel-race recovery so a rung fill is
  // booked identically wherever it is detected.
  private bookRestingRungFillDelta(
    row: DcaRestingRungRow,
    cumFilledQty: number,
    avgPrice: number | null,
  ): number {
    const alreadyBooked = row.filled_qty ?? 0;
    const delta = Math.min(cumFilledQty, row.qty) - alreadyBooked;
    if (delta <= 0) return 0;
    // Manual ladder rungs have no signal execution, and their REAL sizes must
    // never enter signal_fills (the portfolio shipper syncs those rows off the
    // machine). The delta still counts so the row's filled_qty tracking and the
    // callers' cancel/drop decisions stay correct.
    if (row.signal_id.startsWith('manual:')) return delta;
    this.db.insertSignalFill({
      signalId: row.signal_id,
      kind: 'entry',
      symbol: row.symbol,
      side: row.side,
      qty: delta,
      price: avgPrice ?? row.price ?? null,
      orderId: row.order_id,
    });
    const exec = this.db.getSignalExecution(row.signal_id);
    if (exec) {
      this.db.updateSignalExecution(row.signal_id, { qtyOpened: exec.qty_opened + delta });
    }
    return delta;
  }

  // A rung's cancel just SUCCEEDED. The order is gone from the book, but a
  // partial fill may have landed before the kill (Bybit reports it as
  // PartiallyFilledCanceled with cumExecQty > 0). Re-check and book the
  // unbooked delta so the fill isn't discarded with the tracking row.
  // Best-effort: a failed lookup books nothing (the venue said the cancel
  // succeeded; sweeps already booked any partial seen earlier).
  private async bookRungResidualFillAfterCancel(
    adapter: ExchangeAdapter,
    row: DcaRestingRungRow,
  ): Promise<void> {
    if (!adapter.getOrderStatus) return;
    try {
      const status = await adapter.getOrderStatus(row.order_id, {
        accountId: row.account_id ?? undefined,
        symbol: row.symbol,
        category: row.category ?? undefined,
      });
      const cum = status.filledQuantity && status.filledQuantity > 0 ? status.filledQuantity : 0;
      const delta = this.bookRestingRungFillDelta(row, cum, status.averagePrice ?? null);
      if (delta > 0) {
        this.db.log('info', 'trading', 'Cancelled DCA rung carried a partial fill — booked', {
          signalId: row.signal_id,
          orderId: row.order_id,
          filledQty: delta,
        });
      }
    } catch {
      /* best-effort */
    }
  }

  // A resting DCA rung's cancel just FAILED (threw). Do NOT blindly delete the
  // tracking row: query the venue and decide.
  //   filled            → book the unbooked delta, drop tracking ('settled')
  //   partially_filled  → still LIVE at the broker with a partial: book the
  //                       delta, record it on the row and KEEP tracking the
  //                       residual ('kept') — a later expire/close pass retries
  //                       the cancel on what still rests.
  //   cancelled/rejected → genuinely gone; book any partial the venue reports
  //                       (PartiallyFilledCanceled), then drop ('dropped')
  //   working/unknown/lookup-failed/no-status-API → KEEP the row ('kept') so a
  //                              later expire/close pass retries — never a silent
  //                              row loss that leaves a live add untracked.
  private async reconcileRestingRungAfterFailedCancel(
    adapter: ExchangeAdapter,
    row: DcaRestingRungRow,
  ): Promise<'settled' | 'dropped' | 'kept'> {
    if (!adapter.getOrderStatus) return 'kept';
    let status;
    try {
      status = await adapter.getOrderStatus(row.order_id, {
        accountId: row.account_id ?? undefined,
        symbol: row.symbol,
        category: row.category ?? undefined,
      });
    } catch {
      return 'kept';
    }
    const cum = status.filledQuantity && status.filledQuantity > 0 ? status.filledQuantity : 0;
    if (status.state === 'filled') {
      this.bookRestingRungFillDelta(row, cum > 0 ? cum : row.qty, status.averagePrice ?? null);
      this.db.deleteDcaRestingRung(row.order_id);
      return 'settled';
    }
    if (status.state === 'partially_filled') {
      const alreadyBooked = row.filled_qty ?? 0;
      const delta = this.bookRestingRungFillDelta(row, cum, status.averagePrice ?? null);
      if (delta > 0) {
        row.filled_qty = alreadyBooked + delta;
        this.db.setDcaRestingRungFilledQty(row.order_id, row.filled_qty);
      }
      return 'kept';
    }
    if (status.state === 'cancelled' || status.state === 'rejected') {
      this.bookRestingRungFillDelta(row, cum, status.averagePrice ?? null);
      this.db.deleteDcaRestingRung(row.order_id);
      return 'dropped';
    }
    return 'kept';
  }

  private async settleEntry(
    adapter: ExchangeAdapter,
    result: OrderResult,
    signal: Signal,
    orderSymbol: string,
    exchangeName: string,
    accountId: string,
    requestedQty: number,
  ): Promise<{ outcome: 'filled' | 'unknown' | 'rejected'; filledQty: number; avgPrice?: number; reason?: string }> {
    // A clearly-filled market order needs no polling.
    if (result.status === 'filled') {
      return {
        outcome: 'filled',
        filledQty: result.filledQuantity && result.filledQuantity > 0 ? result.filledQuantity : requestedQty,
        avgPrice: result.averagePrice,
      };
    }
    if (result.status === 'rejected') {
      return { outcome: 'rejected', filledQty: 0, reason: result.message ?? 'rejected' };
    }
    // No way to confirm → trust the placeOrder result (best-effort, legacy behavior).
    if (!adapter.getOrderStatus) {
      return {
        outcome: 'filled',
        filledQty: result.filledQuantity && result.filledQuantity > 0 ? result.filledQuantity : requestedQty,
        avgPrice: result.averagePrice,
      };
    }

    const settled = await settleAdapterOrder(
      adapter,
      result.orderId,
      {
        accountId,
        symbol: orderSymbol,
        category: (signal.metadata?.category as string | undefined) ?? undefined,
      },
      { attempts: this.settleAttempts, intervalMs: this.settleIntervalMs },
    );

    if (settled.status === 'filled' || settled.status === 'partially_filled') {
      return {
        outcome: 'filled',
        filledQty: settled.filledQuantity && settled.filledQuantity > 0 ? settled.filledQuantity : requestedQty,
        avgPrice: settled.averagePrice,
      };
    }
    if (settled.status === 'rejected') {
      return { outcome: 'rejected', filledQty: 0, reason: 'entry rejected' };
    }
    if (settled.status === 'cancelled') {
      // A cancelled entry may still carry a PARTIAL fill (Bybit maps
      // 'PartiallyFilledCanceled' → cancelled; Deribit reports cancelled with
      // filled_amount > 0). Booking it as rejected/0 orphans the live partial
      // position — no brackets, no trail, no close bookkeeping. Honor the fill.
      if (settled.filledQuantity && settled.filledQuantity > 0) {
        return { outcome: 'filled', filledQty: settled.filledQuantity, avgPrice: settled.averagePrice };
      }
      return { outcome: 'rejected', filledQty: 0, reason: 'entry cancelled' };
    }
    // timeout → unknown outcome. Persist for background resolution; keep tracked.
    this.db.insertOrderSettlement({
      signalId: signal.id,
      exchange: exchangeName,
      accountId,
      symbol: orderSymbol,
      category: (signal.metadata?.category as string | undefined) ?? null,
      kind: 'entry',
      side: signal.action === 'buy' ? 'buy' : 'sell',
      qty: requestedQty,
      orderId: result.orderId,
    });
    this.db.log('warn', 'trading', 'Entry order outcome unknown, tracking for resolution', {
      signalId: signal.id,
      orderId: result.orderId,
      symbol: orderSymbol,
    });
    this.notifications?.publish({
      type: 'order_pending',
      title: 'Order outcome pending',
      body: `Entry for ${signal.symbol} couldn't be confirmed yet; resolving in the background.`,
      data: { signalId: signal.id, orderId: result.orderId, symbol: signal.symbol },
    });
    // Settlement TIMEOUT is operationally significant (a placed order whose
    // outcome we can't confirm) → also raise an alertable event for the external
    // webhook, separate from the in-app pending notice above.
    this.notifications?.publish({
      type: 'error',
      title: 'Settlement timeout',
      body: `Entry order for ${signal.symbol} (#${result.orderId}) timed out without a confirmed outcome — resolving in the background.`,
      data: { signalId: signal.id, orderId: result.orderId, symbol: signal.symbol, kind: 'settlement_timeout' },
    });
    return { outcome: 'unknown', filledQty: 0 };
  }

  // --- OCO bracket tracking ---
  // In-memory map of active bracket pairs keyed by each leg's order id, so that
  // when one leg fills (reported via the exchange's user.orders/user.trades
  // stream) we can cancel the sibling. This is a pragmatic OCO emulation —
  // Deribit doesn't expose a native OCO concept for reduce-only stop + limit
  // pairs. The map is ALSO persisted (bracket_pairs) and rehydrated on startup
  // via loadPersistedBrackets(), so a restart can still cancel the sibling.
  // Each bracket group holds one stop-loss leg + N take-profit legs (the
  // multi-TP ladder). Every leg's order id maps to the SAME group object so a
  // fill on any leg can locate and mutate the group.
  private brackets = new Map<string, BracketGroup>();

  private trackBracket(
    exchangeName: string,
    signalId: string,
    slOrderId?: string,
    tpOrderIds?: string[],
    accountId?: string | null,
  ) {
    const tps = (tpOrderIds ?? []).filter((id): id is string => !!id);
    const group: BracketGroup = { signalId, exchangeName, slOrderId, tpOrderIds: tps, accountId: accountId ?? null };
    if (slOrderId) this.brackets.set(slOrderId, group);
    for (const id of tps) this.brackets.set(id, group);
  }

  /**
   * Rehydrate the in-memory bracket map from the persisted bracket_pairs table.
   * Call once at startup so OCO sibling-cancel survives a restart. Returns the
   * number of pairs loaded (handy for tests).
   */
  loadPersistedBrackets(): number {
    let loaded = 0;
    for (const row of this.db.listBracketPairs()) {
      const tpIds = parseTpOrderIds(row.tp_order_ids);
      const tpOrderIds = tpIds.length > 0 ? tpIds : row.tp_order_id ? [row.tp_order_id] : [];
      this.trackBracket(
        row.exchange,
        row.signal_id,
        row.sl_order_id ?? undefined,
        tpOrderIds,
        row.account_id ?? null,
      );
      loaded++;
    }
    this.db.log('info', 'trading', 'Rehydrated persisted bracket pairs', { count: loaded });
    return loaded;
  }

  /**
   * Register an externally-placed OCO bracket (e.g. a manual trade) into the live
   * tracker AND persist it, so a fill on one leg cancels the sibling — both in the
   * current session and after a restart (loadPersistedBrackets rehydrates it).
   * The manual path owns no signal_executions row; the OCO fill handler needs
   * none — it works purely off the in-memory group + the exchange order stream.
   */
  registerBracket(
    exchangeName: string,
    signalId: string,
    slOrderId?: string,
    tpOrderIds?: string[],
    accountId?: string | null,
  ) {
    const tps = (tpOrderIds ?? []).filter((id): id is string => !!id);
    this.trackBracket(exchangeName, signalId, slOrderId, tps, accountId);
    this.db.upsertBracketPair({
      signalId,
      exchange: exchangeName,
      accountId: accountId ?? null,
      slOrderId: slOrderId ?? null,
      tpOrderIds: tps,
    });
  }

  /**
   * Rebind a bracket's stop leg to a fresh order id after an edge trail
   * cancel/replaced it, in memory AND persisted — so a TP fill's OCO
   * sibling-cancel targets the LIVE stop instead of the one just cancelled.
   * TP legs are untouched.
   */
  rebindBracketStop(exchangeName: string, signalId: string, newSlOrderId: string) {
    const persisted = this.db.listBracketPairs().find((r) => r.signal_id === signalId);
    const tpIds = persisted ? parseTpOrderIds(persisted.tp_order_ids) : [];
    const tps = tpIds.length > 0 ? tpIds : persisted?.tp_order_id ? [persisted.tp_order_id] : [];
    if (persisted?.sl_order_id) this.brackets.delete(persisted.sl_order_id);
    this.trackBracket(exchangeName, signalId, newSlOrderId, tps, persisted?.account_id ?? null);
    this.db.upsertBracketPair({
      signalId,
      exchange: exchangeName,
      accountId: persisted?.account_id ?? null,
      slOrderId: newSlOrderId,
      tpOrderIds: tps,
    });
  }

  /**
   * Cancel + retire a persisted bracket by signal id. Called when a manual
   * position is closed by hand, so its resting SL/TP legs don't linger as orphans.
   * Best-effort: a leg that's already gone/filled is logged and ignored.
   */
  async retireBracket(exchangeName: string, signalId: string): Promise<void> {
    const persisted = this.db.listBracketPairs().find((r) => r.signal_id === signalId);
    const ids = new Set<string>();
    if (persisted) {
      if (persisted.sl_order_id) ids.add(persisted.sl_order_id);
      if (persisted.tp_order_id) ids.add(persisted.tp_order_id);
      for (const id of parseTpOrderIds(persisted.tp_order_ids)) ids.add(id);
    }
    // Untrack in-memory + drop the persisted pair regardless of cancel outcome.
    for (const id of ids) this.brackets.delete(id);
    this.db.deleteBracketPair(signalId);
    if (ids.size === 0 || !this.exchangeManager) return;

    const session = await this.sessionForAccount(exchangeName, persisted?.account_id);
    if (!session || session.status !== 'connected') return;
    for (const id of ids) {
      try {
        await session.adapter.cancelOrder(id);
        this.db.log('info', 'trading', 'Manual bracket leg cancelled on close', { exchange: exchangeName, signalId, orderId: id });
      } catch (err: any) {
        this.db.log('warn', 'trading', 'Manual bracket leg cancel failed', { exchange: exchangeName, signalId, orderId: id, error: err?.message });
      }
    }
  }

  // --- Venue-exit sweep glue (services/venue-exit-sweep.ts) ---
  // The sweep itself is a standalone, unit-tested module; the client provides
  // the adapter lookup, the OCO retire, the protective-order retire and the
  // server report.

  // Deactivate the server exit state rows tied to these (now closed) entries.
  // A spent state row left active keeps the venue-exit sweep polling its
  // consumed/cancelled stop order forever (2026-09-02 MNQU26).
  private retireServerExitStatesFor(entrySignalIds: string[]) {
    if (entrySignalIds.length === 0) return;
    // Defensive on the DB surface — close-path test doubles predate this table.
    const dbAny = this.db as unknown as {
      listActiveServerExitStates?: () => Array<{ position_id: string; entry_signal_id: string }>;
      deactivateServerExitState?: (positionId: string) => unknown;
    };
    if (typeof dbAny.listActiveServerExitStates !== 'function') return;
    const ids = new Set(entrySignalIds);
    for (const state of dbAny.listActiveServerExitStates()) {
      if (ids.has(state.entry_signal_id)) dbAny.deactivateServerExitState?.(state.position_id);
    }
  }

  private venueExitSweepDeps(): VenueExitSweepDeps {
    return {
      db: this.db,
      getAdapter: async (exchange: string, accountId?: string | null) => {
        if (!this.exchangeManager) return null;
        const session = await this.sessionForAccount(exchange, accountId);
        if (!session || session.status !== 'connected') return null;
        return session.adapter;
      },
      retireOrderGroup: (exchange: string, orderId: string) =>
        this.onExchangeOrderUpdate({ orderId, state: 'filled', exchangeName: exchange }),
      retireProtections: (exchange: string, signalId: string) => this.retireBracket(exchange, signalId),
      reportVenueExit: (positionId, fill) => this.reportVenueExitToApi(positionId, fill),
    };
  }

  /**
   * Reconciler pre-step: poll our resting exit orders (server-managed GTC
   * stops, bracket legs, trail stops) and book broker-side fills as first-class
   * exits — execution closed, fill in the ledger, protective state retired,
   * server told the position is flat. Without this, a filled stop leaves the
   * book at "expected N" and the netting comparison re-opens the position
   * (2026-09-01 MGCZ26 rebuy loop).
   */
  async sweepRestingExitOrders(exchange?: string): Promise<number> {
    if (!this.exchangeManager) return 0;
    const exchanges = exchange
      ? [exchange]
      : this.db.listExecutionExchanges().map((r) => r.exchange);
    let booked = 0;
    for (const name of exchanges) {
      try {
        booked += await sweepVenueExitOrders(this.venueExitSweepDeps(), name);
      } catch (err: any) {
        this.db.log('warn', 'trading', 'Venue exit sweep failed', {
          exchange: name,
          error: err?.message,
        });
      }
    }
    return booked;
  }

  /** Reconciler hook: book a vanished broker position as an adopted close. */
  async adoptVenueClose(input: AdoptVenueCloseInput): Promise<void> {
    await adoptVenueClose(this.venueExitSweepDeps(), input);
  }

  // Report a venue-side exit (filled resting stop / adopted disappearance) so
  // the server closes the positions row and the runner goes flat. Counterpart
  // of the exit-signal-runner's 'stop_filled' → "awaiting executor
  // reconciliation" hand-off. Public: the book-repair operations route uses it.
  // Generic authenticated POST to the server (same credentials as the ack /
  // venue-exit reports). Used by the ride hand-over. Never throws on a non-2xx:
  // the caller reads ok/status/body.
  async postToServer(
    path: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; body: any }> {
    if (!this.apiUrl) return { ok: false, status: 0, body: { error: 'not connected to the server' } };
    const sessionToken = process.env.EXECUTOR_SESSION_TOKEN;
    if (!sessionToken && !this.apiKey) {
      return { ok: false, status: 0, body: { error: 'no server credentials' } };
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (sessionToken) headers['x-session-token'] = sessionToken;
    const res = await fetch(`${this.apiUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    let parsed: any = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = { error: `server ${res.status}` };
    }
    return { ok: res.ok, status: res.status, body: parsed };
  }

  // 'executed' ack for an entry adopted from a manual position
  // (services/adopt-position): the same body the fill path sends (price/time,
  // never the size) so the server re-opens its position row. Returns the
  // server's answer instead of swallowing it: the adoption result shows it.
  async ackAdoptedEntry(
    signalId: string,
    fill: { price: number | null; time: number },
    stopLossOrderId?: string | null,
  ): Promise<{ ok: boolean; positionId: string | null }> {
    const res = await this.postToServer('/api/signals/ack', {
      signalId,
      status: 'executed',
      stopLossOrderId: stopLossOrderId ?? undefined,
      fillPrice: typeof fill.price === 'number' ? fill.price : undefined,
      fillTime: new Date(fill.time).toISOString(),
    });
    if (!res.ok) {
      this.db.log('warn', 'signal', 'adoption ack to API failed', {
        signalId,
        status: res.status,
        body: res.body,
      });
    }
    this.recordAckOutcome(signalId, res.ok);
    return { ok: res.ok, positionId: typeof res.body?.positionId === 'string' ? res.body.positionId : null };
  }

  async reportVenueExitToApi(
    positionId: string,
    fill: { price: number | null; timeMs: number; orderId?: string | null },
  ): Promise<void> {
    if (!this.apiUrl) return;
    const sessionToken = process.env.EXECUTOR_SESSION_TOKEN;
    if (!sessionToken && !this.apiKey) return;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (sessionToken) headers['x-session-token'] = sessionToken;
    const res = await fetch(`${this.apiUrl}/api/signals/venue-exit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        positionId,
        fillPrice: typeof fill.price === 'number' ? fill.price : undefined,
        fillTime: new Date(fill.timeMs).toISOString(),
        orderId: fill.orderId ?? undefined,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`venue-exit report failed (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  /**
   * Re-issue closes that never confirmed (executions left in 'closing'). For
   * each, re-check the live position: if it's already flat the close did land →
   * mark closed. If still live and the market is open, place a fresh reduce-only
   * market close and settle it; a fill retires the execution, otherwise it stays
   * 'closing' for the next pass. Runs under the global order lock (the reconciler
   * passes it in) so it never races an in-flight order.
   *
   * Ref: kaibot-exec/src/exec-service.ts `retryPendingCloses`.
   */
  async retryPendingCloses(exchange?: string): Promise<number> {
    if (!this.exchangeManager) return 0;
    let retried = 0;
    const closing = this.db
      .listClosingExecutions()
      .filter((e) => !exchange || e.exchange === exchange);
    // Group by connection (exchange + account key) so positions are fetched
    // once per connection and a close never reads a sibling account's book.
    const byConnection = new Map<string, { exchangeName: string; accountId: string | null; execs: typeof closing }>();
    for (const e of closing) {
      const key = `${e.exchange}|${accountKeyOf(e.account_id) ?? ''}`;
      const bucket = byConnection.get(key) ?? { exchangeName: e.exchange, accountId: e.account_id ?? null, execs: [] };
      bucket.execs.push(e);
      byConnection.set(key, bucket);
    }

    for (const { exchangeName, accountId: connectionAccount, execs } of byConnection.values()) {
      const session = await this.sessionForAccount(exchangeName, connectionAccount);
      if (!session || session.status !== 'connected') continue;

      let positions: Position[];
      try {
        positions = await session.adapter.getPositions();
      } catch (err: any) {
        this.db.log('warn', 'trading', 'retryPendingCloses: getPositions failed', {
          exchange: exchangeName,
          error: err.message,
        });
        continue;
      }

      for (const exec of execs) {
        const live = positions.find(
          (p) => p.symbol.toLowerCase() === exec.symbol.toLowerCase() && Math.abs(p.size) > 0,
        );

        // Position already flat → the earlier close landed after all.
        if (!live) {
          this.db.updateSignalExecution(exec.signal_id, { status: 'closed', qtyPendingClose: null });
          this.db.markEntrySignalClosed(exec.signal_id, 'close confirmed flat on retry');
          this.retireServerExitStatesFor([exec.signal_id]);
          this.db.log('info', 'trading', 'Pending close resolved: position flat', {
            signalId: exec.signal_id,
            symbol: exec.symbol,
          });
          continue;
        }

        // A market order can't fill into a closed session — wait for reopen.
        const tradable = await isMarketTradable(session.adapter, exec.symbol);
        if (!tradable) continue;

        const closeSide: 'buy' | 'sell' = live.side === 'long' ? 'sell' : 'buy';
        const accountId = live.accountId ?? this.resolveAccountId(exchangeName, exec.symbol);
        const liveSize = Math.abs(live.size);
        // Preserve the ORIGINAL close fraction: a pending fractional scale-out
        // re-issues exactly the remembered remainder, never the whole position.
        // NULL (legacy / full-close intent) keeps the flatten semantics.
        const pending = exec.qty_pending_close;
        const retryQty = pending != null && pending > 0 ? Math.min(pending, liveSize) : liveSize;
        try {
          const result = await session.adapter.placeOrder({
            accountId,
            symbol: exec.symbol,
            side: closeSide,
            orderType: 'market',
            quantity: retryQty,
            reduceOnly: true,
            label: `kaibot:${exec.signal_id}:close-retry`,
            // Same id on every retry: while a prior retry is still live at the
            // broker, a duplicate submit is rejected instead of stacking closes.
            clientOrderId: deriveClientOrderId(exec.signal_id, 'close-retry'),
          });
          retried++;
          const settled = await this.settleClose(
            session.adapter,
            result,
            { id: exec.signal_id, metadata: {} } as Signal,
            exec.symbol,
            exchangeName,
            accountId,
            closeSide,
            retryQty,
          );
          if (settled.outcome === 'filled') {
            const filledQty =
              settled.filledQty && settled.filledQty > 0
                ? Math.min(settled.filledQty, retryQty)
                : retryQty;
            // Book the retry's exit fill so fills-based PnL and qty accounting
            // reflect what actually closed.
            this.db.insertSignalFill({
              signalId: exec.signal_id,
              kind: 'exit',
              symbol: exec.symbol,
              side: closeSide,
              qty: filledQty,
              price: settled.avgPrice ?? null,
              orderId: result.orderId,
            });
            const newClosed = exec.qty_closed + filledQty;
            const positionFlat = filledQty >= liveSize - 1e-9;
            const retryComplete = filledQty >= retryQty - 1e-9;
            if (positionFlat || (pending == null && retryComplete)) {
              // Full-close intent satisfied (or the position is flat anyway).
              this.db.updateSignalExecution(exec.signal_id, {
                status: 'closed',
                qtyClosed: newClosed,
                qtyPendingClose: null,
              });
              this.db.markEntrySignalClosed(exec.signal_id, 'closed by retry');
            } else if (retryComplete) {
              // The remembered fraction is fully closed; the rest of the
              // position legitimately stays open.
              this.db.updateSignalExecution(exec.signal_id, {
                status: 'open',
                qtyClosed: newClosed,
                qtyPendingClose: null,
              });
            } else {
              // Retry itself only partially filled — still owe the remainder.
              this.db.updateSignalExecution(exec.signal_id, {
                status: 'closing',
                qtyClosed: newClosed,
                qtyPendingClose: pending != null ? retryQty - filledQty : null,
              });
            }
            this.db.log('info', 'trading', 'Pending close retried and filled', {
              signalId: exec.signal_id,
              symbol: exec.symbol,
              qty: filledQty,
              requested: retryQty,
            });
          }
        } catch (err: any) {
          this.db.log('warn', 'trading', 'retryPendingCloses: close re-issue failed', {
            signalId: exec.signal_id,
            symbol: exec.symbol,
            error: err.message,
          });
        }
      }
    }
    return retried;
  }

  /**
   * Resolve orders whose outcome was unknown when placed (settlement TIMEOUT),
   * by asking the broker what actually happened and applying the truth to the
   * execution. Must run before reconciliation — the reconciler assumes our
   * books are reality. An order the broker reports terminal-without-fill leaves
   * the execution as-is (entry: error; exit: still 'closing', retried). A LOST
   * order (no longer reported after a week) is given up on with an alert.
   *
   * Ref: kaibot-exec/src/exec-service.ts `resolveUnknownOrders`.
   */
  async resolveUnknownOrders(exchange?: string): Promise<number> {
    if (!this.exchangeManager) return 0;
    let resolved = 0;
    const rows = this.db.listUnresolvedSettlements(exchange);
    const LOST_MS = 7 * 86_400_000;

    for (const row of rows) {
      const session = await this.sessionForAccount(row.exchange, row.account_id);
      if (!session || session.status !== 'connected' || !session.adapter.getOrderStatus) continue;

      let status;
      try {
        status = await session.adapter.getOrderStatus(row.order_id, {
          accountId: row.account_id ?? undefined,
          symbol: row.symbol,
          category: row.category ?? undefined,
        });
      } catch {
        continue;
      }

      if (status.state === 'unknown') {
        // A row from a THROWN placeOrder ('entry-attempt', client-id ref): the
        // common cause is a genuine venue rejection, so once the broker has had
        // ample time to report it and still doesn't, conclude it was never
        // placed and resolve quietly — the execution already reads 'error'.
        // A real-but-lost fill would have shown up by client id well within
        // this window. Auto-reject ONLY on a venue-CONFIRMED absence
        // (absenceConfirmed): a failed/inconclusive lookup says nothing about
        // the order, so the row stays unknown for a later pass instead of a
        // live fill being written off as never-placed.
        if (row.target_label === 'entry-attempt' && status.absenceConfirmed === true) {
          const ATTEMPT_UNKNOWN_MS = 30 * 60_000;
          if (Date.now() - row.created_at > ATTEMPT_UNKNOWN_MS) {
            this.db.resolveOrderSettlement(row.id, 'rejected');
            this.db.log('info', 'trading', 'Thrown entry confirmed never placed', {
              signalId: row.signal_id,
              orderId: row.order_id,
            });
          }
          continue;
        }
        if (Date.now() - row.created_at > LOST_MS) {
          this.db.resolveOrderSettlement(row.id, 'lost');
          this.db.log('warn', 'trading', 'Gave up resolving lost order', {
            orderId: row.order_id,
            symbol: row.symbol,
          });
          this.notifications?.publish({
            type: 'error',
            title: 'Unresolved order',
            body: `Could not resolve ${row.kind} order ${row.order_id} (${row.symbol}); the broker no longer reports it. Please check it manually.`,
          });
        }
        continue;
      }
      if (status.state === 'working') continue; // still live at the broker

      // Terminal: apply the truth.
      const filled = status.state === 'filled' || status.state === 'partially_filled';
      this.db.resolveOrderSettlement(
        row.id,
        filled ? 'filled' : status.state === 'rejected' ? 'rejected' : 'cancelled',
      );
      resolved++;

      const exec = this.db.getSignalExecution(row.signal_id);
      if (!exec) {
        // An EXIT settlement is keyed on the CLOSE signal, which has no
        // execution row of its own — the position is held by the entry
        // executions. Keying the lookup on row.signal_id therefore always
        // missed, and a broker-confirmed close was resolved without ever
        // booking its fill (2026-08-28: two live trades left unpriced).
        if (row.kind === 'exit' && filled) {
          const closedQty =
            status.filledQuantity && status.filledQuantity > 0 ? status.filledQuantity : row.qty;
          const booked = attributeVenueExit(this.db, {
            exchange: row.exchange,
            accountId: row.account_id,
            symbol: row.symbol,
            side: row.side,
            qty: closedQty,
            price: status.averagePrice ?? null,
            orderId: row.order_id,
            reason: 'close resolved as filled',
          });
          this.db.log('info', 'trading', 'Unknown close resolved as filled (attributed to entries)', {
            signalId: row.signal_id,
            orderId: row.order_id,
            qty: closedQty,
            attributed: booked.map((b) => ({ signalId: b.signalId, qty: b.qty })),
          });
        }
        continue;
      }

      if (row.kind === 'entry') {
        if (filled) {
          const qty = status.filledQuantity && status.filledQuantity > 0 ? status.filledQuantity : row.qty;
          const price = status.averagePrice ?? null;
          // Prefer the real broker order id from the status payload — a
          // client-id ref row ("client:<id>") never carried one.
          const raw = status.raw as any;
          const brokerOrderId =
            raw?.orderId != null ? String(raw.orderId)
            : raw?.order_id != null ? String(raw.order_id)
            : row.order_id;
          this.db.updateSignalExecution(row.signal_id, { status: 'open', qtyOpened: qty, errorReason: null });
          this.db.insertSignalFill({
            signalId: row.signal_id,
            kind: 'entry',
            symbol: row.symbol,
            side: row.side,
            qty,
            price,
            orderId: brokerOrderId,
          });
          // A fill surfacing from a THROWN placeOrder means the books said
          // "rejected" while a live position existed — operator attention.
          if (row.target_label === 'entry-attempt') {
            this.notifications?.publish({
              type: 'error',
              title: 'Recovered a lost fill',
              body: `Entry for ${row.symbol} was booked as failed but actually filled at the broker (order ${brokerOrderId}). Books corrected — please verify protective orders.`,
              data: { signalId: row.signal_id, orderId: brokerOrderId, symbol: row.symbol },
            });
          }
          // The synchronous entry path didn't ack on the unknown branch; ack the
          // real outcome now that the historical lookup confirmed the fill.
          this.db.updateSignalStatus(row.signal_id, 'executed', undefined, 'entry resolved as filled');
          await this.ackToApi(row.signal_id, 'executed', row.order_id, undefined, undefined, undefined, {
            price,
            size: qty,
            time: Date.now(),
          });
          this.db.log('info', 'trading', 'Unknown entry resolved as filled', { signalId: row.signal_id, orderId: row.order_id });
        } else {
          // The entry never held a position.
          const reason = `entry ${status.state}`;
          this.db.updateSignalExecution(row.signal_id, { status: 'error', errorReason: reason, qtyOpened: 0 });
          this.db.updateSignalStatus(row.signal_id, 'rejected', undefined, reason);
          await this.ackToApi(row.signal_id, 'rejected', undefined, reason);
        }
      } else {
        // exit (close)
        if (filled) {
          const closedQty =
            status.filledQuantity && status.filledQuantity > 0 ? status.filledQuantity : row.qty;
          this.db.insertSignalFill({
            signalId: row.signal_id,
            kind: 'exit',
            symbol: row.symbol,
            side: row.side,
            qty: closedQty,
            price: status.averagePrice ?? null,
            orderId: row.order_id,
          });
          // A fractional close that resolves as filled must not flatten the
          // books: only mark closed once the cumulative closed qty covers the
          // opened qty. A partial goes back to 'open' with the fill accounted.
          const newClosed = exec.qty_closed + closedQty;
          const fullyClosed = newClosed >= exec.qty_opened - 1e-9;
          this.db.updateSignalExecution(row.signal_id, {
            status: fullyClosed ? 'closed' : 'open',
            qtyClosed: newClosed,
            qtyPendingClose: null,
          });
          if (fullyClosed) {
            this.db.markEntrySignalClosed(row.signal_id, 'close resolved as filled');
          }
          this.db.log('info', 'trading', 'Unknown close resolved as filled', { signalId: row.signal_id, orderId: row.order_id, qty: closedQty, fullyClosed });
        }
        // Not filled → leave it 'closing'; retryPendingCloses re-issues.
      }
    }
    return resolved;
  }

  /**
   * Called externally when the exchange reports an order update. If the updated
   * order is a filled bracket leg, cancel its sibling to emulate OCO.
   */
  async onExchangeOrderUpdate(update: { orderId: string; state?: string; exchangeName: string }) {
    if (!update.orderId) return;
    const group = this.brackets.get(update.orderId);
    if (!group) return;
    if (update.state !== 'filled') return;

    // Multi-TP OCO semantics:
    //  • SL fills (full stop-out) → cancel every remaining TP leg, retire group.
    //  • A TP leg fills → drop that leg; if it was the LAST TP, cancel the SL and
    //    retire the group; otherwise leave the SL + remaining TPs resting (the SL
    //    is reduce-only so it clamps to whatever size is left after the partial).
    const isStopLeg = update.orderId === group.slOrderId;
    const toCancel: string[] = [];
    let retireGroup = false;

    if (isStopLeg) {
      toCancel.push(...group.tpOrderIds);
      retireGroup = true;
    } else {
      group.tpOrderIds = group.tpOrderIds.filter((id) => id !== update.orderId);
      this.brackets.delete(update.orderId);
      if (group.tpOrderIds.length === 0) {
        if (group.slOrderId) toCancel.push(group.slOrderId);
        retireGroup = true;
      }
    }

    if (retireGroup) {
      if (group.slOrderId) this.brackets.delete(group.slOrderId);
      for (const id of group.tpOrderIds) this.brackets.delete(id);
      this.db.deleteBracketPair(group.signalId);
    } else {
      // Partial ladder fill: persist the shrunk leg set so a restart cancels the
      // right siblings.
      this.db.upsertBracketPair({
        signalId: group.signalId,
        exchange: group.exchangeName,
        accountId: group.accountId ?? null,
        slOrderId: group.slOrderId,
        tpOrderIds: group.tpOrderIds,
      });
    }

    if (toCancel.length > 0 && this.exchangeManager) {
      await this.cancelOcoSiblings(group, update.orderId, toCancel);
    }

    // The group retiring means the position is gone (stopped out or fully
    // taken). Any resting same-side entry rungs (signal DCA or a manual entry
    // ladder) must not outlive it and fill into a naked, bracket-less position.
    if (retireGroup) {
      await this.cancelRestingDcaRungsForSignals(group.exchangeName, [group.signalId]);
    }
  }

  private async cancelOcoSiblings(
    group: BracketGroup,
    filledOrderId: string,
    toCancel: string[],
  ): Promise<void> {
    if (!this.exchangeManager) return;
    try {
      const session = await this.sessionForAccount(group.exchangeName, group.accountId);
      if (!session || session.status !== 'connected') return;
      for (const siblingId of toCancel) {
        try {
          await session.adapter.cancelOrder(siblingId);
          this.db.log('info', 'trading', 'OCO sibling cancelled', {
            signalId: group.signalId,
            filledOrderId,
            cancelledOrderId: siblingId,
          });
        } catch (err: any) {
          this.db.log('warn', 'trading', 'OCO sibling cancel failed', {
            signalId: group.signalId,
            siblingId,
            error: err.message,
          });
        }
      }
    } catch (err: any) {
      this.db.log('warn', 'trading', 'OCO sibling cancel session error', {
        signalId: group.signalId,
        error: err.message,
      });
    }
  }

  /**
   * Count live open positions on an exchange for the maxConcurrentTrades cap.
   * Uses the exchange adapter as the source of truth (the local `positions`
   * table is never written). Results are cached per exchange for a few seconds
   * so a burst of signals doesn't issue one getPositions call per signal.
   *
   * When the subscription restricts to specific markets (`selected_markets`),
   * only positions in those markets are counted; otherwise every open position
   * on the exchange counts toward the cap.
   */
  // Live positions for the exchange, served from the short cache so a burst of
  // signals (or several guardrails in one open) hits getPositions at most once
  // per TTL. Shared by countOpenPositions, the guardrails and breathing-room.
  private async getCachedPositions(
    exchangeName: string,
    adapter: ExchangeAdapter,
  ): Promise<Position[]> {
    const cacheKey = this.cacheKey(exchangeName, adapter);
    const cached = this.positionsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.positionsCacheTtlMs) {
      return cached.positions;
    }
    const positions = await adapter.getPositions();
    this.positionsCache.set(cacheKey, { at: Date.now(), positions });
    return positions;
  }

  // Position/balance caches are per CONNECTION: two connections on one
  // exchange must never serve each other's snapshot.
  private cacheKey(exchangeName: string, adapter: unknown): string {
    const key = adapterAccountKey(adapter);
    return key ? `${exchangeName}|${key}` : exchangeName;
  }

  // Account a subscription routes to for this symbol: an explicit account_id
  // wins (namespaced with the sub's connection label when it isn't yet), else
  // the venue's own per-symbol account on the sub's connection. Subs without a
  // label resolve exactly as before multi-connection support.
  // The subscription a bot close runs on when the bot has more than one active
  // subscription: the one whose connection (account_key) and account pin cover
  // the account that holds this lineage's open execution. Falls back to the
  // given sub when the bot has one sub, no open lineage here, or the lineage
  // is spread over accounts (each account then needs its own close anyway).
  private subForLineageClose(signalBotId: string, canonicalSymbol: string, current: any | null): any | null {
    if (typeof this.db.listActiveSubscriptionsForBot !== 'function') return current;
    const subs = this.db.listActiveSubscriptionsForBot(signalBotId);
    if (subs.length <= 1) return current;
    const accounts = new Set<string>();
    for (const entry of this.db.getOpenEntrySignals(canonicalSymbol, signalBotId)) {
      const exec = this.db.getSignalExecution(entry.id);
      if (exec && (exec.status === 'open' || exec.status === 'closing') && exec.account_id) {
        accounts.add(exec.account_id);
      }
    }
    if (accounts.size !== 1) return current;
    const accountId = [...accounts][0]!;
    const key = accountKeyOf(accountId);
    const match = subs.find(
      (s) => (s.account_key ?? undefined) === key && (!s.account_id || s.account_id === accountId),
    );
    if (!match) return current;
    if (match.id !== current?.id) {
      this.db.log('info', 'signal', 'Close routed to the subscription holding the lineage', {
        signalBotId,
        symbol: canonicalSymbol,
        accountId,
        subscriptionId: match.id,
        insteadOf: current?.id ?? null,
      });
    }
    return match;
  }

  private subAccountId(sub: any | null, exchangeName: string, symbol: string): string {
    const key = (sub?.account_key as string | null | undefined) || undefined;
    const explicit = sub?.account_id as string | undefined;
    return withAccountKey(key, explicit ?? this.resolveAccountId(exchangeName, symbol));
  }

  // The connection that owns an account id ('acct2/btc' → the labeled
  // connection, 'btc'/'931' → the default one).
  private sessionForAccount(exchangeName: string, accountId?: string | null) {
    return this.exchangeManager!.getSession('default', exchangeName, accountKeyOf(accountId));
  }

  // Realized P&L since 00:00 UTC, summed locally from the executor's own fills
  // (signal_fills) — no cloud. Powers the daily-loss guardrail. Pulls recent
  // executions (closes happen on already-open signals, so the most recent few
  // hundred more than cover today) and sums realizedNet for signals whose last
  // exit fill landed today.
  // Cumulative qty this bot already holds on a market/side, from the local
  // books: open/closing executions net of closes, plus still-resting DCA rungs
  // (they fill later and count toward the same exposure). Powers the
  // maxPositionSize TOTAL-exposure cap so repeated adds can't compound past it.
  private cumulativeOpenQtyForCap(
    canonicalSymbol: string,
    subFilter: string | undefined,
    direction: 'long' | 'short',
  ): number {
    let total = 0;
    for (const e of this.db.getOpenEntrySignals(canonicalSymbol, subFilter)) {
      if ((e.action === 'buy' ? 'long' : 'short') !== direction) continue;
      const exec = this.db.getSignalExecution(e.id);
      if (exec && (exec.status === 'open' || exec.status === 'closing')) {
        total += Math.max(0, exec.qty_opened - exec.qty_closed);
      }
      if (typeof this.db.getDcaRestingRungsForSignal === 'function') {
        for (const rung of this.db.getDcaRestingRungsForSignal(e.id)) {
          total += Math.max(0, rung.qty - (rung.filled_qty ?? 0));
        }
      }
    }
    return total;
  }

  // Positions relevant to a routed broker account: drop other accounts' rows,
  // keep rows without account attribution (single-account venues). Only active
  // when the subscription explicitly routes an account — subs without one keep
  // the whole-venue view (crypto behaviour unchanged). Without this, bot A's
  // positions on account A block bot B's caps on account B.
  private positionsForAccount(
    positions: Position[],
    explicitAccount: string | null | undefined,
  ): Position[] {
    if (!explicitAccount) return positions;
    return positions.filter((p) => !p.accountId || p.accountId === explicitAccount);
  }

  private async countOpenPositions(
    exchangeName: string,
    adapter: ExchangeAdapter,
    sub: any | null,
  ): Promise<number> {
    const positions = this.positionsForAccount(
      await this.getCachedPositions(exchangeName, adapter),
      sub?.account_id as string | undefined,
    );

    const open = positions.filter((p) => Math.abs(p.size) > 0);

    let markets: string[] | undefined;
    if (sub?.selected_markets) {
      try {
        const parsed = JSON.parse(sub.selected_markets) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) markets = parsed;
      } catch {
        /* malformed JSON → count all open positions */
      }
    }
    if (!markets) return open.length;

    const wanted = new Set(markets.map((m) => m.toLowerCase()));
    return open.filter((p) => wanted.has(p.symbol.toLowerCase())).length;
  }

  // Pre-open breathing-room check: fetch live balances + positions, estimate the
  // new order's margin from notional/leverage in the account's currency, and run
  // the pure guard. Returns null when the inputs can't be resolved (the caller
  // treats null as "skip" — fail-open). Linear venues use qty × price (quote
  // currency); inverse venues (Deribit) use qty / price (settlement coin).
  // Guard refusals are operator-critical: a silently rejected open looks like
  // a quiet bot (2026-08-24 E2E: every futures entry refused, unnoticed).
  // Publish them on the same channel as broker rejects.
  // ─── Deferred entries (market closed) ─────────────────────────────────────

  // Park a market entry that hit a closed venue. Idempotent per signal id: a
  // duplicate delivery or a resume that finds the venue closed again keeps the
  // original row (and deadline). Inside the weekend gap the entry is dropped
  // with a clear reason unless DEFER_OVER_WEEKEND=1.
  private async deferEntry(
    wireSignal: Signal,
    ctx: {
      canonicalSymbol: string;
      exchangeName: string;
      orderSymbol: string;
      accountId: string;
      signalBotId?: string;
      subscriptionId?: string;
    },
  ): Promise<void> {
    const signalId = wireSignal.id;
    const nowMs = this.now();
    const existing = this.db.getDeferredEntry(signalId);
    if (existing) {
      if (existing.status === 'waiting') {
        this.db.touchDeferredEntry(signalId, nowMs);
        this.db.log('info', 'trading', 'Entry still waiting for market open', {
          signalId,
          symbol: ctx.orderSymbol,
          exchange: ctx.exchangeName,
          deadlineAt: new Date(existing.deadline_at).toISOString(),
        });
      } else {
        this.db.log('info', 'trading', 'Deferred entry already resolved, not re-parking', {
          signalId,
          status: existing.status,
        });
      }
      return;
    }

    const plan = planDeferral({
      nowMs,
      maxWaitMs: this.deferConfig.maxWaitMs,
      deferOverWeekend: this.deferConfig.deferOverWeekend,
    });
    if (plan.kind === 'drop') {
      this.db.log('warn', 'trading', 'Open skipped: market closed for the weekend', {
        signalId,
        symbol: ctx.orderSymbol,
        exchange: ctx.exchangeName,
      });
      this.db.recordSignalQueue({
        signalId,
        action: wireSignal.action,
        reason: 'deferred_weekend_drop',
        metadata: { orderSymbol: ctx.orderSymbol, exchange: ctx.exchangeName },
      });
      this.notifications?.publish({
        type: 'entry_deferred_dropped',
        title: 'Entry dropped',
        body: `${ctx.orderSymbol} on ${ctx.exchangeName}: ${plan.reason}`,
        data: { signalId, symbol: ctx.orderSymbol, exchange: ctx.exchangeName },
      });
      this.db.updateSignalStatus(signalId, 'rejected', undefined, plan.reason);
      await this.ackToApi(signalId, 'rejected', undefined, plan.reason);
      return;
    }

    const positionId = wireSignal.metadata?.positionId;
    this.db.upsertDeferredEntry({
      signalId,
      signalJson: JSON.stringify(wireSignal),
      canonicalSymbol: ctx.canonicalSymbol,
      exchange: ctx.exchangeName,
      orderSymbol: ctx.orderSymbol,
      accountId: ctx.accountId,
      signalBotId: ctx.signalBotId ?? null,
      subscriptionId: ctx.subscriptionId ?? null,
      positionId: typeof positionId === 'string' ? positionId : null,
      reason: plan.reason,
      deferredAt: nowMs,
      deadlineAt: plan.deadlineMs,
    });
    this.db.recordSignalQueue({
      signalId,
      action: wireSignal.action,
      reason: 'deferred_market_closed',
      metadata: {
        orderSymbol: ctx.orderSymbol,
        exchange: ctx.exchangeName,
        deadlineAt: new Date(plan.deadlineMs).toISOString(),
      },
    });
    this.db.updateSignalStatus(signalId, 'deferred', undefined, plan.reason);
    this.db.log('warn', 'trading', 'Open deferred: market not tradable', {
      signalId,
      symbol: ctx.orderSymbol,
      exchange: ctx.exchangeName,
      deadlineAt: new Date(plan.deadlineMs).toISOString(),
    });
    this.notifications?.publish({
      type: 'entry_deferred',
      title: 'Entry waiting for market open',
      body: `${ctx.orderSymbol} on ${ctx.exchangeName}: market closed, the entry runs when the venue trades again.`,
      data: {
        signalId,
        symbol: ctx.orderSymbol,
        exchange: ctx.exchangeName,
        deadlineAt: new Date(plan.deadlineMs).toISOString(),
      },
    });
    await this.ackToApi(signalId, 'deferred', undefined, plan.reason);
    this.startDeferredEntryPoller();
  }

  startDeferredEntryPoller(): void {
    if (this.deferredTimer) return;
    this.deferredTimer = setInterval(() => {
      void this.checkDeferredEntries();
    }, this.deferConfig.pollMs);
    this.deferredTimer.unref?.();
  }

  stopDeferredEntryPoller(): void {
    if (this.deferredTimer) {
      clearInterval(this.deferredTimer);
      this.deferredTimer = null;
    }
  }

  // One poll pass over the waiting rows: expire past the deadline, resume the
  // ones whose venue trades again, skip the rest. Public so ops and tests can
  // drive it without the timer. Re-entrancy guarded: a slow venue check never
  // overlaps the next tick.
  async checkDeferredEntries(): Promise<{ resumed: string[]; expired: string[] }> {
    const resumed: string[] = [];
    const expired: string[] = [];
    if (this.deferredTickRunning) return { resumed, expired };
    this.deferredTickRunning = true;
    try {
      const rows = this.db.listWaitingDeferredEntries();
      if (rows.length === 0) {
        this.stopDeferredEntryPoller();
        return { resumed, expired };
      }
      for (const row of rows) {
        const nowMs = this.now();
        if (nowMs >= row.deadline_at) {
          await this.expireDeferredEntry(row, nowMs);
          expired.push(row.signal_id);
          continue;
        }
        if (!this.exchangeManager) continue;
        let session: Awaited<ReturnType<typeof this.sessionForAccount>> | null = null;
        try {
          session = await this.sessionForAccount(row.exchange, row.account_id);
        } catch {
          session = null;
        }
        if (!session || session.status !== 'connected') {
          this.db.touchDeferredEntry(row.signal_id, nowMs);
          continue;
        }
        const tradable = await isMarketTradable(session.adapter, row.order_symbol, { now: nowMs });
        this.db.touchDeferredEntry(row.signal_id, nowMs);
        if (!tradable) continue;
        await this.resumeDeferredEntry(row);
        resumed.push(row.signal_id);
      }
    } catch (err: any) {
      this.db.log('error', 'trading', 'Deferred entry poll failed', { error: err?.message ?? String(err) });
    } finally {
      this.deferredTickRunning = false;
    }
    return { resumed, expired };
  }

  // Same path as a fresh entry: sizing, basis guard on the price the venue
  // shows now, brackets. Serialized through the per-venue order lock like a
  // live signal.
  private async resumeDeferredEntry(row: DeferredEntryRow): Promise<void> {
    const signal = JSON.parse(row.signal_json) as Signal;
    this.db.log('info', 'trading', 'Market open: resuming deferred entry', {
      signalId: row.signal_id,
      symbol: row.order_symbol,
      exchange: row.exchange,
      waitedMs: this.now() - row.deferred_at,
    });
    this.db.recordSignalQueue({
      signalId: row.signal_id,
      action: signal.action,
      reason: 'deferred_resumed',
      metadata: { waitedMs: this.now() - row.deferred_at },
    });
    this.notifications?.publish({
      type: 'entry_resumed',
      title: 'Market open: entry resumed',
      body: `${row.order_symbol} on ${row.exchange}: the deferred entry is running now.`,
      data: { signalId: row.signal_id, symbol: row.order_symbol, exchange: row.exchange },
    });
    await withOrderLock(this.resolveOrderLockKey(signal), () =>
      this.handleSignalInner(signal, { resumedDeferral: true }),
    );
    const status = this.db.getSignalStatus(row.signal_id);
    // Parked again: the venue closed between the poll and the guard.
    if (status === 'deferred') return;
    const outcome = status === 'executed' || status === 'pending' ? 'executed' : 'rejected';
    this.db.resolveDeferredEntry(row.signal_id, outcome, `local status ${status ?? 'unknown'}`, this.now());
  }

  private async expireDeferredEntry(row: DeferredEntryRow, nowMs: number): Promise<void> {
    const waitedH = ((nowMs - row.deferred_at) / 3_600_000).toFixed(1);
    const reason = `market stayed closed past the wait limit (${waitedH} h)`;
    if (!this.db.resolveDeferredEntry(row.signal_id, 'expired', reason, nowMs)) return;
    let action = 'buy';
    try {
      action = (JSON.parse(row.signal_json) as Signal).action;
    } catch {
      /* keep the default */
    }
    this.db.log('warn', 'trading', 'Deferred entry expired: market still closed', {
      signalId: row.signal_id,
      symbol: row.order_symbol,
      exchange: row.exchange,
      waitedH,
    });
    this.db.recordSignalQueue({ signalId: row.signal_id, action, reason: 'deferred_expired' });
    this.notifications?.publish({
      type: 'entry_deferred_dropped',
      title: 'Entry dropped',
      body: `${row.order_symbol} on ${row.exchange}: ${reason}`,
      data: { signalId: row.signal_id, symbol: row.order_symbol, exchange: row.exchange },
    });
    this.db.updateSignalStatus(row.signal_id, 'expired', undefined, reason);
    await this.ackToApi(row.signal_id, 'rejected', undefined, reason);
  }

  // A close / cancel that reaches a lineage whose entry is still parked
  // retires the parked entry: no position ever opened on the venue, so the
  // server learns the entry never filled and the close itself ends as a
  // no-op ack. Defensive on the db methods (older test doubles omit them).
  private async cancelDeferredEntriesFor(signal: Signal, sub: any | null): Promise<string[]> {
    if (typeof this.db.listWaitingDeferredEntries !== 'function') return [];
    const rows = this.db.listWaitingDeferredEntries();
    if (rows.length === 0) return [];
    const meta = (signal.metadata ?? {}) as Record<string, unknown>;
    const probe: LineageProbe = {
      canonicalSymbol: signal.symbol,
      signalBotId:
        (meta.signalBotId as string | undefined) ?? (meta.signal_bot_id as string | undefined),
      subscriptionId: (meta.subscriptionId as string | undefined) ?? (sub?.id as string | undefined),
      positionId: typeof meta.positionId === 'string' ? meta.positionId : undefined,
      entrySignalId:
        (signal.action as string) === 'cancel' && typeof meta.entrySignalId === 'string'
          ? meta.entrySignalId
          : undefined,
    };
    const cancelled: string[] = [];
    const nowMs = this.now();
    for (const row of rows) {
      if (!matchesDeferredLineage(row, probe)) continue;
      const reason = `cancelled before fill: ${signal.action} ${signal.id} arrived while waiting for market open`;
      if (!this.db.resolveDeferredEntry(row.signal_id, 'cancelled', reason, nowMs)) continue;
      let action = 'buy';
      try {
        action = (JSON.parse(row.signal_json) as Signal).action;
      } catch {
        /* keep the default */
      }
      this.db.log('info', 'trading', 'Deferred entry cancelled by a later signal', {
        entrySignalId: row.signal_id,
        bySignalId: signal.id,
        byAction: signal.action,
        symbol: row.order_symbol,
      });
      this.db.recordSignalQueue({
        signalId: row.signal_id,
        action,
        reason: 'deferred_cancelled',
        metadata: { bySignalId: signal.id, byAction: signal.action },
      });
      this.db.updateSignalStatus(row.signal_id, 'expired', undefined, reason);
      await this.ackToApi(row.signal_id, 'rejected', undefined, reason);
      cancelled.push(row.signal_id);
    }
    return cancelled;
  }

  private notifyGuardReject(signal: Signal, guard: string, reason: string): void {
    this.notifications?.publish({
      type: 'order_rejected',
      title: `Entry blocked: ${guard}`,
      body: `\u2717 ${signal.symbol}: ${reason}`,
      data: { signalId: signal.id, symbol: signal.symbol, guard, error: reason },
    })
  }

  private async checkBreathingRoom(
    exchangeName: string,
    adapter: ExchangeAdapter,
    accountId: string,
    signal: Signal,
    quantity: number,
    cfg: MarginGuardConfig,
    // Explicitly routed subscription account: scopes the position set (leverage
    // pick + offset credit) to this account. Undefined = whole-venue view.
    explicitAccount?: string,
  ): Promise<BreathingRoom | null> {
    let balances: Balance[];
    const cacheKey = this.cacheKey(exchangeName, adapter);
    const cachedBal = this.balanceCache.get(cacheKey);
    if (cachedBal && Date.now() - cachedBal.at < this.positionsCacheTtlMs) {
      balances = cachedBal.balances;
    } else {
      balances = await adapter.getBalances();
      this.balanceCache.set(cacheKey, { at: Date.now(), balances });
    }

    // The balance for this account. On inverse multi-wallet venues (Deribit
    // btc/eth) the coin pools are SEPARATE collateral, so resolve the symbol's
    // coin wallet exactly and never cross to another coin — skip (fail-open) if
    // it's absent rather than risk checking an ETH order against the BTC pool.
    // Single-pool venues (binance 'usdm-futures', bybit 'unified'/'contract')
    // that don't tag the routed 'default' account fall back to the largest-equity
    // wallet — the collateral the order draws margin from.
    const bal = isInverseVenue(exchangeName, signal.symbol)
      ? balances.find((b) => venueAccountOf(b.accountId) === this.resolveAccountId(exchangeName, signal.symbol))
      : (balances.find((b) => b.accountId === accountId) ??
        balances.reduce<Balance | undefined>(
          (best, b) => ((b.equity ?? 0) > (best?.equity ?? -Infinity) ? b : best),
          undefined,
        ));
    if (!bal) return null;

    let positions: Position[];
    let positionsFresh = false;
    const cachedPos = this.positionsCache.get(cacheKey);
    if (cachedPos && Date.now() - cachedPos.at < this.positionsCacheTtlMs) {
      positions = cachedPos.positions;
    } else {
      positions = await adapter.getPositions();
      this.positionsCache.set(cacheKey, { at: Date.now(), positions });
      positionsFresh = true;
    }
    // A routed account only nets/offsets against its own positions — an
    // opposing position on ANOTHER broker account nets nothing at the broker.
    positions = this.positionsForAccount(positions, explicitAccount);

    // Leverage for the new order: server-supplied (signal metadata) wins, then
    // the live position on this root, the heaviest leverage on the account, else
    // the configured default.
    const root = sizingRoot(signal.symbol);
    const samePos = positions.find((p) => sizingRoot(p.symbol) === root && Math.abs(p.size) > 0);
    const metaLev = Number(signal.metadata?.leverage);
    const sameLev = samePos?.leverage && samePos.leverage > 0 ? samePos.leverage : 0;
    const maxLev = Math.max(0, ...positions.map((p) => p.leverage ?? 0));
    const leverage =
      (Number.isFinite(metaLev) && metaLev > 0 ? metaLev : 0) || sameLev || maxLev || defaultLeverageFor(exchangeName);

    // Price: the signal price, else the live mark/entry of an existing position.
    // No price → can't size the order margin → skip (fail-open).
    const price = signal.price || samePos?.markPrice || samePos?.entryPrice || 0;
    if (price <= 0) return null;

    // Order margin must land in the SAME currency as equity/margins. Inverse
    // venues (Deribit) quote quantity in USD and settle in coin, so the position
    // value in coin is quantity / price; linear venues use quantity × price ×
    // contract multiplier (futures notional per contract is price × multiplier;
    // 1 outside tradestation).
    const inverse = isInverseVenue(exchangeName, signal.symbol);
    const mult = contractMultiplier(exchangeName, signal.symbol);
    const notionalOf = (qty: number) => (inverse ? qty / price : qty * price * mult);
    const orderNotional = notionalOf(quantity);

    // Offset credit: an open opposing an existing same-root net position nets the
    // broker down (futures/perps net per symbol), so that part consumes no new
    // margin — only the remainder past the offset does, and a pure offset is never
    // blocked. Sum the signed same-root size and value the portion this order
    // opposes at the same price/venue convention. Ref: kaibot-exec 383e5bc.
    const orderIsLong = signal.action === 'buy';
    const netOf = (list: Position[]) =>
      list.reduce((net, p) => {
        if (sizingRoot(p.symbol) !== root) return net;
        return net + (p.side === 'short' ? -1 : 1) * Math.abs(p.size);
      }, 0);
    const opposingOf = (net: number) => (orderIsLong ? Math.max(0, -net) : Math.max(0, net));
    let opposingQty = opposingOf(netOf(positions));
    if (opposingQty > 0 && !positionsFresh) {
      // The credit (and the pure-offset floor skip it can trigger) must never
      // ride on the short positions cache: the opposing position may have
      // closed since the snapshot, making this a genuinely NEW open that the
      // margin floor must vet. Re-read fresh before granting any credit; if
      // the fresh read fails, grant no credit (fail-closed for the credit
      // only — the guard itself still runs on the snapshot).
      try {
        const fresh = await adapter.getPositions();
        this.positionsCache.set(cacheKey, { at: Date.now(), positions: fresh });
        positions = this.positionsForAccount(fresh, explicitAccount);
        opposingQty = opposingOf(netOf(positions));
      } catch {
        opposingQty = 0;
      }
    }
    const offsetNotional = notionalOf(Math.min(quantity, opposingQty));

    return computeBreathingRoom(cfg, {
      equity: bal.equity ?? 0,
      initialMargin: bal.initialMargin ?? 0,
      maintenanceMargin: bal.maintenanceMargin ?? 0,
      orderNotional,
      offsetNotional,
      leverage,
    });
  }

  private resolveAccountId(exchangeName: string, symbol: string): string {
    if (exchangeName === 'deribit') {
      const s = symbol.toUpperCase();
      // Linear USDC perps (SOL_USDC-PERPETUAL, BTC_USDC-PERPETUAL) settle in
      // the USDC account — check before the coin prefixes, BTC_USDC starts
      // with BTC too.
      if (s.includes('_USDC')) return 'usdc';
      if (s.startsWith('BTC')) return 'btc';
      if (s.startsWith('ETH')) return 'eth';
      return 'btc';
    }
    return 'default';
  }

  private sendMessage(message: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  // Public send for the companion StatePusher (writes a state frame up the same
  // socket). No-op when the socket is closed, like sendMessage.
  sendCompanionMessage(message: unknown) {
    this.sendMessage(message);
  }

  private scheduleReconnect(extendedBackoff = false) {
    if (this.isIntentionallyClosed) return;
    // Idempotent: a failed handshake can request a reconnect twice (the
    // unexpected-response branch schedules directly AND its terminate() fires
    // 'close', which schedules again). Overwriting a pending timer would leak
    // it and open parallel sockets — one per generation — during an outage.
    if (this.reconnectInterval) return;

    if (extendedBackoff) {
      // A conflict close means another executor is very likely still
      // connected: skip the fast early retries (1s/2s/4s/8s) that would just
      // get rejected again right away, and start from a slower step instead.
      this.reconnectAttempts = Math.max(this.reconnectAttempts, 4);
    }

    // Never give up: an unattended executor that stops reconnecting leaves open
    // positions unmanaged (close signals never delivered). Cap the exponential
    // backoff at 60s and keep retrying indefinitely; alert once after a sustained
    // outage instead of quitting (maxReconnectAttempts is now the alert threshold).
    const delay = Math.min(1000 * Math.pow(2, Math.min(this.reconnectAttempts, 6)), 60000);
    this.reconnectAttempts++;

    if (this.reconnectAttempts === this.maxReconnectAttempts) {
      this.notifications?.publish({
        type: 'connection_lost',
        title: 'Signal service still unreachable',
        body: `Still retrying after ${this.reconnectAttempts} attempts. Open positions may be unmanaged until the connection is restored.`,
        data: { attempts: this.reconnectAttempts },
      });
    }

    this.db.log('info', 'connection', `Scheduling reconnection attempt ${this.reconnectAttempts}`, { delay });

    this.reconnectInterval = setTimeout(() => {
      this.reconnectInterval = null;
      if (this.apiUrl && this.apiKey && !this.isIntentionallyClosed) {
        this.connect(this.apiUrl, this.apiKey);
      }
    }, delay);
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    this.stopStalenessWatchdog();
    this.reconnectingSince = null;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
      this.reconnectInterval = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }
    this.db.log('info', 'connection', 'Signal client disconnected');
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getUpdateInfo(): { latestVersion: string; current: string } | null {
    return this.updateInfo;
  }

  // Reconnect telemetry for /api/ws/status: since when the client has been
  // without an open socket, and how many dials it has made since.
  getReconnectInfo(): { reconnectingSince: string | null; reconnectAttempts: number } {
    return {
      reconnectingSince: this.reconnectingSince ? new Date(this.reconnectingSince).toISOString() : null,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  getConnectionStatus(): string {
    const isOpen = !!(this.ws && this.ws.readyState === WebSocket.OPEN);
    if (this.conflictSince != null && !isOpen) {
      return 'conflict';
    }
    if (this.reconnectingSince != null && !isOpen) {
      return 'reconnecting';
    }
    if (!this.ws) return 'disconnected';
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING: return 'connecting';
      case WebSocket.OPEN: return 'connected';
      case WebSocket.CLOSING: return 'closing';
      case WebSocket.CLOSED: return 'disconnected';
      default: return 'unknown';
    }
  }
}
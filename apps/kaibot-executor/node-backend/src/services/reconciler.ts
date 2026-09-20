// Position reconciler (TradeStation-scoped).
//
// Periodically compares the expected net position per (account, symbol) — derived
// from our signal_executions — against the live broker position, and nudges the
// broker toward the expected net under tight safeguards. Net-per-symbol broker
// accounts (futures) make per-signal positions virtual; drift between our books
// and the broker happens after unknown-outcome orders, manual intervention, or
// missed fills.
//
// Safeguards (all from hard lessons in kaibot-exec/src/jobs.ts reconcileTick):
//  - runs inside the global order lock → never collides with an in-flight order;
//  - keys STRICTLY on (account, symbol): only pairs WE have executed with a
//    recorded account are ever corrected — a position on another broker account
//    (or on a pair we never traded) is never touched, no matter the symbol;
//  - pre-migration executions without an account are UNATTRIBUTED: their
//    symbols are flagged for manual review, never auto-corrected;
//  - on the first pass after connect, any live broker overhang (broker net
//    minus our expected net per pair) is ADOPTED as a manual-position marker —
//    positions that existed before the executor came up are the user's, not
//    drift to "correct" away;
//  - never corrects while orders are working on that (account, symbol) — a stuck-
//    but-live order plus a correction is how a 2-lot becomes an 8-lot;
//  - a working order WE didn't place on a symbol we trade is flagged, not touched;
//  - at most one correction per pair per cooldown window;
//  - skips while the market is closed (stale quote);
//  - refuses to auto-correct an implausibly large delta (flags for manual review);
//  - persists every run/decision to the reconciliations table.
//
// Scoped to TradeStation: crypto venues (alwaysOpen / no getMarketStatus and no
// order-status query) are skipped entirely. Each (signal) position there is its
// own instrument, so there is no netting drift to reconcile.

import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type {
  ExchangeAdapter,
  OrderQueryContext,
  Position,
} from './exchanges/types.js'
import type { NotificationBus } from './notifications/notification-bus.js'
import { withOrderLock } from './order-lock.js'
import { deriveClientOrderId } from './client-order-id.js'
import { isMarketTradable } from './market-guard.js'
import { settleAdapterOrder } from './order-settlement.js'

const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS) || 60 * 1000
const RECONCILE_MAX_DELTA = Number(process.env.RECONCILE_MAX_DELTA) || 10
const RECONCILE_COOLDOWN_MS = Number(process.env.RECONCILE_COOLDOWN_MS) || 5 * 60 * 1000
// Grace window after an exit fill on a pair before corrections may touch it.
// The close path's bookkeeping (qty_closed attribution) can trail the fill; a
// correction inside that gap reads "expected 1, broker 0" and re-opens a
// position the strategy just closed (2026-08-26: struct-entry close →
// phantom rebuy 4 seconds later).
const RECONCILE_EXIT_GRACE_MS = Number(process.env.RECONCILE_EXIT_GRACE_MS) || 5 * 60 * 1000
const ALERT_THROTTLE_MS = 15 * 60 * 1000

// Allowlist of venues the reconciler is ever permitted to operate on. These are
// net-per-symbol broker accounts (futures/equities) where netting drift is real
// and a bounded correction order is the documented fix. Crypto/always-open venues
// are NOT here on purpose: each signal position is its own instrument (no netting
// drift), and an autonomous correction order on a live crypto venue would be the
// executor deciding on its own — a violation of executor-never-decides.
export const RECONCILE_ALLOWED_VENUES = new Set(['tradestation', 'interactivebrokers'])

// Parse the configured venue list and drop anything outside the allowlist, logging
// an error per rejected venue. Pure so it can be unit-tested without re-importing
// the module. `log` defaults to console.error (startup path).
export function resolveReconcileExchanges(
  raw: string | undefined,
  log: (msg: string) => void = (msg) => console.error(msg),
): string[] {
  return (raw || 'tradestation')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((venue) => {
      if (RECONCILE_ALLOWED_VENUES.has(venue)) return true
      log(
        `[reconciler] Refusing to reconcile "${venue}": not a known net-per-symbol broker venue ` +
          `(allowed: ${[...RECONCILE_ALLOWED_VENUES].join(', ')}). ` +
          `Autonomous correction orders on this venue would violate executor-never-decides. Skipping.`,
      )
      return false
    })
}

// Exchanges the reconciler operates on (net-per-symbol broker accounts). Anything
// outside the allowlist is logged and dropped at startup, never reconciled.
const RECONCILE_EXCHANGES = resolveReconcileExchanges(process.env.RECONCILE_EXCHANGES)

export interface ReconcilerDeps {
  db: KaiBotDatabase
  exchangeManager: ExchangeManager
  notifications?: NotificationBus | null
  // Hook so the signal client's pending-close retry runs in the same locked tick
  // before reconciliation (the reconciler assumes virtual == truth). Receives the
  // exchange whose lock is currently held; hooks must scope their work to it.
  retryPendingCloses?: (exchange?: string) => Promise<unknown>
  // Hook to resolve unknown-outcome orders before reconciling.
  resolveUnknownOrders?: (exchange?: string) => Promise<unknown>
  // Hook to settle/expire/cancel resting DCA rungs in the same locked pre-step.
  expireDcaRungs?: (exchange?: string) => Promise<unknown>
  // Hook to poll resting exit orders (GTC stops / TP legs / trail stops) and
  // book broker-side fills BEFORE the netting comparison — a filled stop must
  // become a booked exit, never a mismatch to "correct" (2026-09-01 MGCZ26
  // rebuy loop). Runs first among the pre-steps.
  sweepRestingExits?: (exchange: string) => Promise<unknown>
  // Hook to book exposure that vanished at the broker as an adopted close on
  // the executions holding it (venue-exit-sweep.adoptVenueClose). Replaces the
  // exposure-increasing correction order.
  adoptVenueClose?: (input: {
    exchange: string
    accountId: string
    symbol: string
    side: 'buy' | 'sell'
    qty: number
  }) => Promise<unknown>
}

export interface ReconcileSummary {
  pairs: number
  mismatches: number
  corrected: number
  flaggedLarge: number
  skippedWorking: number
  skippedClosed: number
  skippedCooldown: number
  skippedRecentExit: number
  skippedManual: number
  // Symbols carrying pre-migration executions without an account — flagged,
  // never auto-corrected.
  skippedUnattributed: number
  // Pre-existing broker positions adopted as manual markers on the first pass
  // after connect.
  adopted: number
  // Vanished broker positions booked as closes on their executions (never
  // re-opened with a correction order).
  adoptedCloses: number
  foreignOrders: number
  // Detect-and-alert mode (crypto venues): mismatches observed and alerted on,
  // never auto-corrected.
  observedMismatches: number
}

const pairKey = (accountId: string, symbol: string) => `${accountId}::${symbol}`

/** Liveness of the reconciler loop itself, for the Reconciliation page. */
export interface ReconcilerStatus {
  lastTickAt: number | null
  /** Newest pass that found no drift at all. */
  lastCleanPassAt: number | null
  intervalMs: number
}

export class Reconciler {
  private timer: NodeJS.Timeout | null = null
  private lastCorrectionAt = new Map<string, number>()
  private lastWorkingAlertAt = new Map<string, number>()
  private lastManualAlertAt = new Map<string, number>()
  private lastObservedAlertAt = new Map<string, number>()
  private lastUnattributedAlertAt = new Map<string, number>()
  private foreignOrderAlerted = new Set<string>()
  // Exchanges whose pre-existing broker positions were adopted this process.
  // Adoption re-runs after a restart, but existing markers are never doubled.
  private adoptedExchanges = new Set<string>()
  // Heartbeat for the UI. A clean pass writes no row, so without this the page
  // can only show the last INCIDENT and a healthy book looks like silence.
  // In-memory on purpose: a restart resets it and the next pass refills it,
  // which beats a DB write every minute.
  private lastTickAt: number | null = null
  private lastCleanPassAt: number | null = null

  constructor(private deps: ReconcilerDeps) {}

  status(): ReconcilerStatus {
    return {
      lastTickAt: this.lastTickAt,
      lastCleanPassAt: this.lastCleanPassAt,
      intervalMs: RECONCILE_INTERVAL_MS,
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), RECONCILE_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // Every exchange this tick must touch: the configured correction venues, plus
  // any venue with pending settlement work (unknown orders, unconfirmed closes,
  // resting DCA rungs) or live executions (crypto detect-and-alert). Defensive
  // on the DB surface — test doubles may not implement every listing.
  private collectTickExchanges(): string[] {
    const exchanges = new Set<string>(RECONCILE_EXCHANGES)
    const db = this.deps.db as any
    try {
      if (typeof db.listUnresolvedSettlements === 'function') {
        for (const r of db.listUnresolvedSettlements()) exchanges.add(r.exchange)
      }
      if (typeof db.listClosingExecutions === 'function') {
        for (const r of db.listClosingExecutions()) exchanges.add(r.exchange)
      }
      if (typeof db.listDcaRestingRungs === 'function') {
        for (const r of db.listDcaRestingRungs()) exchanges.add(r.exchange)
      }
      if (typeof db.listExecutionExchanges === 'function') {
        for (const r of db.listExecutionExchanges()) exchanges.add(r.exchange)
      }
    } catch {
      /* enumeration is best-effort; the configured venues always run */
    }
    return [...exchanges].filter(Boolean)
  }

  /**
   * One reconciliation pass. Each exchange runs under ITS OWN order lock (a
   * stalled venue no longer blocks the others' pre-steps or corrections), with
   * the pre-steps (unknown-order resolution, pending-close retry, DCA rung
   * expiry) scoped to that exchange inside the same lock hold — so nothing can
   * interleave between settling the books and acting on them.
   *
   * Venues outside the correction allowlist run in detect-and-alert mode only:
   * mismatches between our books and the live broker are logged + alerted,
   * never corrected (executor-never-decides).
   */
  async tick(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      pairs: 0,
      mismatches: 0,
      corrected: 0,
      flaggedLarge: 0,
      skippedWorking: 0,
      skippedClosed: 0,
      skippedCooldown: 0,
      skippedRecentExit: 0,
      skippedManual: 0,
      skippedUnattributed: 0,
      adopted: 0,
      adoptedCloses: 0,
      foreignOrders: 0,
      observedMismatches: 0,
    }

    for (const exchangeName of this.collectTickExchanges()) {
      await withOrderLock(exchangeName, async () => {
        // Book broker-side fills of our resting exit orders, resolve unknown
        // orders and retry pending closes first: the reconciler assumes our
        // books reflect reality, which those settle. The exit sweep runs
        // before everything else — a filled GTC stop that is not yet booked
        // reads as "expected N, broker 0" downstream.
        try {
          await this.deps.sweepRestingExits?.(exchangeName)
          await this.deps.resolveUnknownOrders?.(exchangeName)
          await this.deps.retryPendingCloses?.(exchangeName)
          await this.deps.expireDcaRungs?.(exchangeName)
        } catch (err: any) {
          this.deps.db.log('warn', 'trading', 'Reconciler pre-step failed', {
            exchange: exchangeName,
            error: err?.message,
          })
        }

        try {
          if (RECONCILE_EXCHANGES.includes(exchangeName)) {
            await this.reconcileExchange(exchangeName, summary)
          } else {
            await this.observeExchange(exchangeName, summary)
          }
        } catch (err: any) {
          this.deps.db.log('error', 'trading', 'Reconcile exchange failed', {
            exchange: exchangeName,
            error: err?.message,
          })
        }
      })
    }
    this.lastTickAt = Date.now()
    if (summary.mismatches === 0 && summary.observedMismatches === 0) {
      this.lastCleanPassAt = this.lastTickAt
    }
    return summary
  }

  /**
   * Detect-and-alert pass for venues outside the correction allowlist (crypto).
   * Compares the expected net per tracked symbol against the live broker
   * position and alerts on any drift — an unexpected live position, a position
   * that should exist but is gone, or a size mismatch. NEVER places an order:
   * an autonomous correction on these venues would violate
   * executor-never-decides; a human resolves it.
   */
  private async observeExchange(exchangeName: string, summary: ReconcileSummary): Promise<void> {
    const { db, exchangeManager } = this.deps
    const session = await exchangeManager.getSession('default', exchangeName)
    if (!session || session.status !== 'connected') return

    const symbols = db.listExecutionSymbols(exchangeName).map((r) => r.symbol)
    if (symbols.length === 0) return

    const expected = new Map<string, number>()
    for (const e of db.listOpenExecutionsForExchange(exchangeName)) {
      const remaining = Math.max(0, e.qty_opened - e.qty_closed)
      if (remaining <= 0) continue
      expected.set(e.symbol, (expected.get(e.symbol) ?? 0) + (e.direction === 'long' ? remaining : -remaining))
    }

    let positions: Position[]
    try {
      positions = await session.adapter.getPositions()
    } catch (err: any) {
      db.log('warn', 'trading', 'Observe: getPositions failed', {
        exchange: exchangeName,
        error: err.message,
      })
      return
    }
    const brokerNet = new Map<string, number>()
    for (const p of positions) {
      const signed = p.side === 'long' ? Math.abs(p.size) : -Math.abs(p.size)
      brokerNet.set(p.symbol, (brokerNet.get(p.symbol) ?? 0) + signed)
    }

    const now = Date.now()
    for (const symbol of symbols) {
      const exp = expected.get(symbol) ?? 0
      const brk = brokerNet.get(symbol) ?? 0
      const delta = exp - brk
      summary.pairs++
      if (Math.abs(delta) <= 1e-9) continue
      // A manual position explains the drift — the user's own trade, leave it be.
      if (db.hasManualPosition(exchangeName, symbol)) continue

      summary.observedMismatches++
      db.insertReconciliation({
        exchange: exchangeName,
        accountId: '',
        symbol,
        expectedNet: exp,
        brokerNet: brk,
        delta,
        action: 'alert_observed_mismatch',
      })
      const key = `${exchangeName}:${symbol}`
      const last = this.lastObservedAlertAt.get(key) ?? 0
      if (now - last >= ALERT_THROTTLE_MS) {
        this.lastObservedAlertAt.set(key, now)
        this.alert(
          `Position mismatch on ${exchangeName} ${symbol}: expected ${exp}, broker holds ${brk}. ` +
            `This venue is never auto-corrected — please check it manually.`,
        )
      }
    }
  }

  private async reconcileExchange(exchangeName: string, summary: ReconcileSummary): Promise<void> {
    const { db, exchangeManager } = this.deps
    const session = await exchangeManager.getSession('default', exchangeName)
    if (!session || session.status !== 'connected') return
    const adapter = session.adapter

    // (account, symbol) pairs ever executed. A NULL account is a pre-migration
    // row — its symbol is unattributed and exempt from any correction.
    const dbAny = db as unknown as {
      listExecutionAccountSymbols?: (exchange: string) => Array<{ account_id: string | null; symbol: string }>
    }
    const pairRows =
      typeof dbAny.listExecutionAccountSymbols === 'function'
        ? dbAny.listExecutionAccountSymbols(exchangeName)
        : db.listExecutionSymbols(exchangeName).map((r) => ({ account_id: null, symbol: r.symbol }))

    // Expected net per (account, symbol) from our live executions (long +,
    // short -). Live executions without an account poison their symbol: we can
    // no longer tell which account the expected size sits on.
    const expected = new Map<string, number>()
    const unattributedSymbols = new Set<string>(
      pairRows.filter((r) => r.account_id == null).map((r) => r.symbol),
    )
    for (const e of db.listOpenExecutionsForExchange(exchangeName)) {
      const remaining = Math.max(0, e.qty_opened - e.qty_closed)
      if (remaining <= 0) continue
      const account = (e as { account_id?: string | null }).account_id
      if (account == null) {
        unattributedSymbols.add(e.symbol)
        continue
      }
      const signed = e.direction === 'long' ? remaining : -remaining
      const key = pairKey(account, e.symbol)
      expected.set(key, (expected.get(key) ?? 0) + signed)
    }

    const pairs = new Map<string, { accountId: string; symbol: string }>()
    for (const r of pairRows) {
      if (r.account_id == null || unattributedSymbols.has(r.symbol)) continue
      pairs.set(pairKey(r.account_id, r.symbol), { accountId: r.account_id, symbol: r.symbol })
    }

    // Live broker positions per (account, symbol).
    let positions: Position[]
    try {
      positions = await adapter.getPositions()
    } catch (err: any) {
      db.log('warn', 'trading', 'Reconcile: getPositions failed', { exchange: exchangeName, error: err.message })
      return
    }
    const brokerNet = new Map<string, { accountId: string; symbol: string; net: number }>()
    for (const p of positions) {
      const signed = p.side === 'long' ? Math.abs(p.size) : -Math.abs(p.size)
      const key = pairKey(p.accountId, p.symbol)
      const cur = brokerNet.get(key)
      brokerNet.set(key, { accountId: p.accountId, symbol: p.symbol, net: (cur?.net ?? 0) + signed })
    }

    // ─── Adoption of pre-existing broker positions ───
    // A broker position that exceeds what our executions account for existed
    // before we did (the user's own trade on the platform) — mark the overhang
    // as a manual position so it is never "corrected" away.
    //  - Pairs we have NEVER executed: adopted every tick. The correction loop
    //    can't touch them anyway, but the persisted marker protects them the
    //    moment a bot starts trading that (account, symbol).
    //  - Pairs we HAVE executed: adopted only on the first pass after boot —
    //    the executor can't tell boot-time overhang from the user's platform
    //    trades, so it defers to the human. In-session drift on those pairs
    //    stays correctable as before.
    // Markers persist, are never doubled, and the delta==0 auto-heal clears
    // them once the overhang is gone.
    const firstPass = !this.adoptedExchanges.has(exchangeName)
    this.adoptedExchanges.add(exchangeName)
    for (const { accountId, symbol, net } of brokerNet.values()) {
      if (!accountId || unattributedSymbols.has(symbol)) continue
      const key = pairKey(accountId, symbol)
      if (!firstPass && pairs.has(key)) continue
      const overhang = net - (expected.get(key) ?? 0)
      if (Math.abs(overhang) <= 1e-9) continue
      if (db.getManualPosition(exchangeName, accountId, symbol)) continue
      db.addManualPosition(exchangeName, accountId, symbol, overhang > 0 ? 'buy' : 'sell', Math.abs(overhang))
      summary.adopted++
      db.insertReconciliation({
        exchange: exchangeName,
        accountId,
        symbol,
        expectedNet: expected.get(key) ?? 0,
        brokerNet: net,
        delta: -overhang,
        action: 'adopted_existing',
      })
      db.log('info', 'trading', 'Adopted pre-existing broker position', {
        exchange: exchangeName,
        accountId,
        symbol,
        overhang,
      })
    }

    // Unattributed symbols: flag once per throttle window, never correct.
    const now = Date.now()
    for (const symbol of unattributedSymbols) {
      summary.skippedUnattributed++
      db.insertReconciliation({
        exchange: exchangeName,
        accountId: '',
        symbol,
        expectedNet: 0,
        brokerNet: 0,
        delta: 0,
        action: 'skipped_unattributed',
      })
      const last = this.lastUnattributedAlertAt.get(`${exchangeName}:${symbol}`) ?? 0
      if (now - last >= ALERT_THROTTLE_MS) {
        this.lastUnattributedAlertAt.set(`${exchangeName}:${symbol}`, now)
        this.alert(
          `Executions on ${exchangeName} ${symbol} predate account tracking — reconciliation is paused for it. Close or re-open those positions through the executor to resume.`,
        )
      }
    }

    // Working orders (block corrections) + foreign-order detection.
    const trackedSymbols = [...new Set([...pairs.values()].map((p) => p.symbol))]
    const working = await this.collectWorkingOrders(adapter, exchangeName, trackedSymbols, summary)

    // Pairs with a FRESH exit fill: hold corrections until the grace window
    // passes — the close's bookkeeping may still be landing (see
    // RECONCILE_EXIT_GRACE_MS). Defensive on the DB surface for test doubles.
    const recentExitPairs = new Set<string>()
    const dbRecent = db as unknown as {
      listRecentExitSettlements?: (
        exchange: string,
        sinceMs: number,
      ) => Array<{ account_id: string | null; symbol: string }>
    }
    if (typeof dbRecent.listRecentExitSettlements === 'function') {
      try {
        for (const r of dbRecent.listRecentExitSettlements(exchangeName, Date.now() - RECONCILE_EXIT_GRACE_MS)) {
          if (r.account_id) recentExitPairs.add(pairKey(r.account_id, r.symbol))
        }
      } catch {
        /* best-effort; corrections then rely on the other guards */
      }
    }

    for (const { accountId, symbol } of pairs.values()) {
      const key = pairKey(accountId, symbol)
      const exp = expected.get(key) ?? 0
      const brk = brokerNet.get(key)?.net ?? 0
      const delta = exp - brk // move broker by +delta to match expected
      summary.pairs++

      const hasManual = !!db.getManualPosition(exchangeName, accountId, symbol)
      if (delta === 0) {
        // Broker net is back to the signal-expected net → any manual overhang is
        // gone. Clear a stale marker so reconciliation resumes on this pair.
        // Safe: we only clear when already balanced, so it can't trigger a
        // correction.
        if (hasManual) db.clearManualPosition(exchangeName, accountId, symbol)
        continue
      }
      summary.mismatches++

      // Open manual position on this (account, symbol) → the delta can't be
      // attributed to netting drift vs. the user's own hand-placed size, so
      // NEVER auto-correct (a correction would undo the manual trade). Flag it
      // and let the human reconcile by hand.
      if (hasManual) {
        summary.skippedManual++
        db.insertReconciliation({
          exchange: exchangeName,
          accountId,
          symbol,
          expectedNet: exp,
          brokerNet: brk,
          delta,
          action: 'skipped_manual',
        })
        const last = this.lastManualAlertAt.get(key) ?? 0
        if (now - last >= ALERT_THROTTLE_MS) {
          this.lastManualAlertAt.set(key, now)
          this.alert(
            `Mismatch on ${exchangeName} ${symbol} (account ${accountId}: expected ${exp} vs broker ${brk}), but a manual position is open on it. Auto-correction is paused — reconcile it by hand.`,
          )
        }
        continue
      }

      // Implausibly large delta → never auto-correct, flag for manual review.
      if (Math.abs(delta) > RECONCILE_MAX_DELTA) {
        summary.flaggedLarge++
        db.insertReconciliation({
          exchange: exchangeName,
          accountId,
          symbol,
          expectedNet: exp,
          brokerNet: brk,
          delta,
          action: 'skipped_large',
        })
        this.alert(
          `Large position mismatch on ${exchangeName} ${symbol} (account ${accountId}: expected ${exp} vs broker ${brk}). Not corrected automatically — please check it.`,
        )
        continue
      }

      // Fresh exit fill on this pair → the books may not reflect that close
      // yet. Correcting now would trade AGAINST the strategy's own decision;
      // wait out the grace window (the mismatch self-heals once the close is
      // booked, or the next pass corrects with settled books).
      if (recentExitPairs.has(key)) {
        summary.skippedRecentExit++
        db.insertReconciliation({
          exchange: exchangeName,
          accountId,
          symbol,
          expectedNet: exp,
          brokerNet: brk,
          delta,
          action: 'skipped_recent_exit',
        })
        continue
      }

      // Working order on this (account, symbol) → wait (position is about to
      // change). Orders the adapter can't attribute to an account block the
      // whole symbol, conservatively.
      if ((working.byPair.get(key) ?? 0) + (working.bySymbolNoAccount.get(symbol) ?? 0) > 0) {
        summary.skippedWorking++
        db.insertReconciliation({
          exchange: exchangeName,
          accountId,
          symbol,
          expectedNet: exp,
          brokerNet: brk,
          delta,
          action: 'skipped_working',
        })
        const last = this.lastWorkingAlertAt.get(key) ?? 0
        if (now - last >= ALERT_THROTTLE_MS) {
          this.lastWorkingAlertAt.set(key, now)
          this.alert(
            `Mismatch on ${exchangeName} ${symbol} (account ${accountId}: expected ${exp} vs broker ${brk}), but working orders are still on it. Waiting before correcting.`,
          )
        }
        continue
      }

      // ─── Trust direction (2026-09-01 MGCZ26 rebuy loop) ───
      // A correction order may only ever SHRINK the broker's exposure toward
      // the expected net: opposite side of the broker net, never past zero.
      // Exposure the broker no longer holds (a filled stop the sweep missed, a
      // close booked elsewhere, an outside actor flattening) is NEVER re-opened
      // by a buy/sell "correction" — that trades real money into an
      // unprotected position on stale books. Instead the disappearance is
      // adopted as a close: booked onto the executions via attribution, states
      // retired, human alerted.
      const reducesExposure =
        brk !== 0 && Math.sign(delta) === -Math.sign(brk) && Math.abs(delta) <= Math.abs(brk) + 1e-9
      if (!reducesExposure) {
        const cooldownKey = `${exchangeName}:${key}`
        const lastAttempt = this.lastCorrectionAt.get(cooldownKey) ?? 0
        if (now - lastAttempt < RECONCILE_COOLDOWN_MS) {
          summary.skippedCooldown++
          db.insertReconciliation({
            exchange: exchangeName,
            accountId,
            symbol,
            expectedNet: exp,
            brokerNet: brk,
            delta,
            action: 'skipped_cooldown',
          })
          continue
        }
        this.lastCorrectionAt.set(cooldownKey, now)
        summary.adoptedCloses++
        // Only OUR vanished exposure gets booked: |delta| when broker and book
        // share a sign, the whole |exp| when the broker even flipped sides (the
        // foreign remainder is the reduce path's or the human's problem). exp
        // is nonzero here — exp === 0 with a nonzero broker net always reduces.
        const missingQty = Math.min(Math.abs(delta), Math.abs(exp))
        const closingSide: 'buy' | 'sell' = exp > 0 ? 'sell' : 'buy'
        let adoptStatus = 'booked'
        try {
          await this.deps.adoptVenueClose?.({
            exchange: exchangeName,
            accountId,
            symbol,
            side: closingSide,
            qty: missingQty,
          })
        } catch (err: any) {
          adoptStatus = `error: ${err?.message}`
        }
        db.insertReconciliation({
          exchange: exchangeName,
          accountId,
          symbol,
          expectedNet: exp,
          brokerNet: brk,
          delta,
          action: 'adopted_close',
          side: closingSide,
          qty: missingQty,
          status: adoptStatus,
        })
        this.alert(
          `Position on ${exchangeName} ${symbol} (account ${accountId}) is gone at the broker ` +
            `(expected ${exp}, broker holds ${brk}). Booked the disappearance as a close (${adoptStatus}) — ` +
            `no order was placed. Please verify the exit price and cause.`,
        )
        continue
      }

      // Market closed / stale → defer until reopen.
      const tradable = await isMarketTradable(adapter, symbol)
      if (!tradable) {
        summary.skippedClosed++
        db.insertReconciliation({
          exchange: exchangeName,
          accountId,
          symbol,
          expectedNet: exp,
          brokerNet: brk,
          delta,
          action: 'skipped_closed',
        })
        continue
      }

      // Cooldown: at most one correction per pair per window.
      const cooldownKey = `${exchangeName}:${key}`
      const lastAttempt = this.lastCorrectionAt.get(cooldownKey) ?? 0
      if (now - lastAttempt < RECONCILE_COOLDOWN_MS) {
        summary.skippedCooldown++
        db.insertReconciliation({
          exchange: exchangeName,
          accountId,
          symbol,
          expectedNet: exp,
          brokerNet: brk,
          delta,
          action: 'skipped_cooldown',
        })
        continue
      }
      this.lastCorrectionAt.set(cooldownKey, now)

      // Correct: reduce-only market order in the direction of the delta, on the
      // pair's OWN account — never an account inferred from broker positions.
      const side: 'buy' | 'sell' = delta > 0 ? 'buy' : 'sell'
      const qty = Math.abs(delta)
      let status = 'error'
      let orderId: string | null = null
      try {
        const result = await adapter.placeOrder({
          accountId,
          symbol,
          side,
          orderType: 'market',
          quantity: qty,
          reduceOnly: true,
          label: `kaibot:reconcile:${symbol}`,
          // Deterministic within one cooldown window: a crash-retry of the same
          // correction collides broker-side instead of double-placing.
          clientOrderId: deriveClientOrderId(
            `reconcile:${exchangeName}:${accountId}:${symbol}`,
            'correction',
            Math.floor(now / RECONCILE_COOLDOWN_MS),
          ),
        })
        orderId = result.orderId
        const ctx: OrderQueryContext = { accountId, symbol }
        const settled = adapter.getOrderStatus
          ? await settleAdapterOrder(adapter, result.orderId, ctx)
          : { status: result.status === 'filled' ? ('filled' as const) : ('timeout' as const) }
        status = settled.status
      } catch (err: any) {
        status = `error: ${err.message}`
      }
      summary.corrected++
      db.insertReconciliation({
        exchange: exchangeName,
        accountId,
        symbol,
        expectedNet: exp,
        brokerNet: brk,
        delta,
        action: 'corrected',
        side,
        qty,
        orderId,
        status,
      })
      this.alert(
        `Corrected a mismatch on ${exchangeName} ${symbol} (account ${accountId}): ${side} ${qty} (expected ${exp}, broker was ${brk}) → ${status}.`,
      )
    }
  }

  /**
   * Count working orders per (account, symbol) — orders the adapter can't
   * attribute to an account land in bySymbolNoAccount and block the whole
   * symbol. Also flags any working order on a symbol we trade that we didn't
   * place (a duplicate or an outside actor) — we hold off on corrections for
   * that symbol when one is found.
   */
  private async collectWorkingOrders(
    adapter: ExchangeAdapter,
    exchangeName: string,
    trackedSymbols: string[],
    summary: ReconcileSummary,
  ): Promise<{ byPair: Map<string, number>; bySymbolNoAccount: Map<string, number> }> {
    const working = { byPair: new Map<string, number>(), bySymbolNoAccount: new Map<string, number>() }
    // Working-order discovery needs a broker listing the adapter may not expose.
    // listWorkingOrders is optional; when absent we simply can't block on working
    // orders (correction still gated by cooldown + market-open + max-delta).
    const lister = (adapter as any).listWorkingOrders as
      | undefined
      | ((symbols: string[]) => Promise<Array<{ orderId: string; symbol: string; accountId?: string }>>)
    if (typeof lister !== 'function') return working

    let orders: Array<{ orderId: string; symbol: string; accountId?: string }>
    try {
      orders = await lister.call(adapter, trackedSymbols)
    } catch {
      return working
    }
    const known = this.deps.db.listKnownOrderIds(exchangeName)
    const tracked = new Set(trackedSymbols)
    for (const o of orders) {
      if (o.accountId) {
        const key = pairKey(o.accountId, o.symbol)
        working.byPair.set(key, (working.byPair.get(key) ?? 0) + 1)
      } else {
        working.bySymbolNoAccount.set(o.symbol, (working.bySymbolNoAccount.get(o.symbol) ?? 0) + 1)
      }
      if (
        tracked.has(o.symbol) &&
        !known.has(String(o.orderId)) &&
        !this.foreignOrderAlerted.has(String(o.orderId))
      ) {
        this.foreignOrderAlerted.add(String(o.orderId))
        summary.foreignOrders++
        this.deps.db.insertReconciliation({
          exchange: exchangeName,
          accountId: o.accountId ?? '',
          symbol: o.symbol,
          expectedNet: 0,
          brokerNet: 0,
          delta: 0,
          action: 'alert_foreign_order',
          orderId: o.orderId,
        })
        this.alert(
          `A working order on ${exchangeName} ${o.symbol} (id ${o.orderId}) wasn't placed by KaiBot. Holding off on corrections for that symbol — please check it.`,
        )
      }
    }
    return working
  }

  private alert(body: string): void {
    this.deps.db.log('warn', 'trading', 'Reconciler', { message: body })
    this.deps.notifications?.publish({
      type: 'error',
      title: 'Position reconciliation',
      body,
    })
  }
}

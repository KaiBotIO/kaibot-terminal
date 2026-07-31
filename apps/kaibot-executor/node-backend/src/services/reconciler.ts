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
//  - only touches (account, symbol) pairs WE have executed (manual positions on
//    untouched symbols are never disturbed);
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
}

export interface ReconcileSummary {
  pairs: number
  mismatches: number
  corrected: number
  flaggedLarge: number
  skippedWorking: number
  skippedClosed: number
  skippedCooldown: number
  skippedManual: number
  foreignOrders: number
  // Detect-and-alert mode (crypto venues): mismatches observed and alerted on,
  // never auto-corrected.
  observedMismatches: number
}

export class Reconciler {
  private timer: NodeJS.Timeout | null = null
  private lastCorrectionAt = new Map<string, number>()
  private lastWorkingAlertAt = new Map<string, number>()
  private lastManualAlertAt = new Map<string, number>()
  private lastObservedAlertAt = new Map<string, number>()
  private foreignOrderAlerted = new Set<string>()

  constructor(private deps: ReconcilerDeps) {}

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
      skippedManual: 0,
      foreignOrders: 0,
      observedMismatches: 0,
    }

    for (const exchangeName of this.collectTickExchanges()) {
      await withOrderLock(exchangeName, async () => {
        // Resolve unknown orders + retry pending closes first: the reconciler
        // assumes our books reflect reality, which those settle.
        try {
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

    const symbols = db.listExecutionSymbols(exchangeName).map((r) => r.symbol)
    if (symbols.length === 0) return

    // Expected net per symbol from our live executions (long +, short -).
    const expected = new Map<string, { net: number; accountId: string }>()
    for (const e of db.listOpenExecutionsForExchange(exchangeName)) {
      const remaining = Math.max(0, e.qty_opened - e.qty_closed)
      if (remaining <= 0) continue
      const signed = e.direction === 'long' ? remaining : -remaining
      const cur = expected.get(e.symbol)
      // accountId isn't on the execution row; resolved from the broker position below.
      expected.set(e.symbol, { net: (cur?.net ?? 0) + signed, accountId: cur?.accountId ?? '' })
    }

    // Live broker positions + working orders.
    let positions: Position[]
    try {
      positions = await adapter.getPositions()
    } catch (err: any) {
      db.log('warn', 'trading', 'Reconcile: getPositions failed', { exchange: exchangeName, error: err.message })
      return
    }
    const brokerNet = new Map<string, number>()
    const brokerAccount = new Map<string, string>()
    for (const p of positions) {
      const signed = p.side === 'long' ? Math.abs(p.size) : -Math.abs(p.size)
      brokerNet.set(p.symbol, (brokerNet.get(p.symbol) ?? 0) + signed)
      brokerAccount.set(p.symbol, p.accountId)
    }

    // Working orders per symbol (block corrections) + foreign-order detection.
    const workingBySymbol = await this.collectWorkingOrders(adapter, exchangeName, symbols, summary)

    const now = Date.now()
    for (const symbol of symbols) {
      const exp = expected.get(symbol)?.net ?? 0
      const brk = brokerNet.get(symbol) ?? 0
      const delta = exp - brk // move broker by +delta to match expected
      summary.pairs++

      const hasManual = db.hasManualPosition(exchangeName, symbol)
      if (delta === 0) {
        // Broker net is back to the signal-expected net → any manual overhang is
        // gone. Clear a stale marker so reconciliation resumes on this symbol.
        // Safe: we only clear when already balanced, so it can't trigger a
        // correction.
        if (hasManual) db.clearManualPositionSymbol(exchangeName, symbol)
        continue
      }
      summary.mismatches++

      const accountId = brokerAccount.get(symbol) ?? this.resolveAccountId(exchangeName, symbol)

      // Open manual position on this symbol → the delta can't be attributed to
      // netting drift vs. the user's own hand-placed size, so NEVER auto-correct
      // (a correction would undo the manual trade). Flag it and let the human
      // reconcile by hand.
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
        const last = this.lastManualAlertAt.get(symbol) ?? 0
        if (now - last >= ALERT_THROTTLE_MS) {
          this.lastManualAlertAt.set(symbol, now)
          this.alert(
            `Mismatch on ${exchangeName} ${symbol} (expected ${exp} vs broker ${brk}), but a manual position is open on it. Auto-correction is paused — reconcile it by hand.`,
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
          `Large position mismatch on ${exchangeName} ${symbol} (expected ${exp} vs broker ${brk}). Not corrected automatically — please check it.`,
        )
        continue
      }

      // Working order on this symbol → wait (position is about to change).
      if ((workingBySymbol.get(symbol) ?? 0) > 0) {
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
        const last = this.lastWorkingAlertAt.get(symbol) ?? 0
        if (now - last >= ALERT_THROTTLE_MS) {
          this.lastWorkingAlertAt.set(symbol, now)
          this.alert(
            `Mismatch on ${exchangeName} ${symbol} (expected ${exp} vs broker ${brk}), but working orders are still on it. Waiting before correcting.`,
          )
        }
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
      const key = `${accountId}:${symbol}`
      const lastAttempt = this.lastCorrectionAt.get(key) ?? 0
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
      this.lastCorrectionAt.set(key, now)

      // Correct: reduce-only market order in the direction of the delta.
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
            `reconcile:${exchangeName}:${symbol}`,
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
        `Corrected a mismatch on ${exchangeName} ${symbol}: ${side} ${qty} (expected ${exp}, broker was ${brk}) → ${status}.`,
      )
    }
  }

  /**
   * Count working orders per symbol, and flag any working order on a symbol we
   * trade that we didn't place (a duplicate or an outside actor) — we hold off
   * on corrections for that symbol when one is found.
   */
  private async collectWorkingOrders(
    adapter: ExchangeAdapter,
    exchangeName: string,
    trackedSymbols: string[],
    summary: ReconcileSummary,
  ): Promise<Map<string, number>> {
    const working = new Map<string, number>()
    // Working-order discovery needs a broker listing the adapter may not expose.
    // listWorkingOrders is optional; when absent we simply can't block on working
    // orders (correction still gated by cooldown + market-open + max-delta).
    const lister = (adapter as any).listWorkingOrders as
      | undefined
      | ((symbols: string[]) => Promise<Array<{ orderId: string; symbol: string }>>)
    if (typeof lister !== 'function') return working

    let orders: Array<{ orderId: string; symbol: string }>
    try {
      orders = await lister.call(adapter, trackedSymbols)
    } catch {
      return working
    }
    const known = this.deps.db.listKnownOrderIds(exchangeName)
    const tracked = new Set(trackedSymbols)
    for (const o of orders) {
      working.set(o.symbol, (working.get(o.symbol) ?? 0) + 1)
      if (
        tracked.has(o.symbol) &&
        !known.has(String(o.orderId)) &&
        !this.foreignOrderAlerted.has(String(o.orderId))
      ) {
        this.foreignOrderAlerted.add(String(o.orderId))
        summary.foreignOrders++
        this.deps.db.insertReconciliation({
          exchange: exchangeName,
          accountId: '',
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

  private resolveAccountId(exchangeName: string, symbol: string): string {
    if (exchangeName === 'deribit') {
      if (symbol.toUpperCase().startsWith('ETH')) return 'eth'
      return 'btc'
    }
    return 'default'
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

// Executor-side local trailing-stop / break-even manager.
//
// Polls the exchange mark price on a short interval and amends the resting stop
// order locally (cancel + re-place) the instant the trail/break-even advances —
// far faster than the 5s server-side position-manager round-trip, which stays as
// a fallback for positions without a local trail (or when this poll fails).
//
// Two attach paths share this loop (F1, pilot-ladder decomposition):
//   - signal rows (source='signal'), armed by signal-client.ts and gated behind
//     EXECUTOR_LOCAL_TRAILING (SPINE: the executor never decides autonomously);
//   - manual rows (source='manual'), armed EXPLICITLY by the user on an open
//     position via /api/trade/manage — no env gate (the human opted in per
//     position).
// Per tick each row advances its water marks, computes the engine stop per its
// mode (fixed distance or drawdown depth), then composes the EFFECTIVE stop:
// the manual stop always participates, the engine only improves on it, and
// under trailing_lock the manual value is absolute (pilot-ladder:319-327).
//
// Mirrors BalanceSnapshotPoller's shape: getAllSessions → per-session adapter →
// local DB. All order ops run under the global order lock so a stop amend never
// races an inbound signal or the reconciler.

import type { KaiBotDatabase } from '../storage/database.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { LocalTrailStateRow, ManagedPositionRow } from '../storage/types.js'
import { withOrderLock } from './order-lock.js'
import { updateExtreme } from './local-trailing.js'
import {
  composeEffectiveStop,
  computeEngineStopCandidate,
  stopsDiffer,
  updateAdverseExtreme,
} from './position-trail.js'
import { settleAdapterOrder } from './order-settlement.js'
import { EDGE_MANAGER_REGISTRY } from './edge-managers/registry.js'
import {
  foldCloseFraction,
  foldStopCandidate,
  runManagersTick,
  type RuntimeManagerEntry,
} from './edge-managers/runtime.js'
import {
  advanceManagedPosition,
  EMPTY_MANAGER_STATE,
  isFavourableStop,
  type GroupAggregateState,
  type ManagedPositionState,
  type ManagerRunnerState,
} from './edge-managers/contract.js'
import { buildGroupAggregateStates, groupInfoForPosition, type LivePositionRef } from './position-groups.js'
import { attributeVenueExit } from './exit-attribution.js'
import type { NotificationBus } from './notifications/notification-bus.js'
import type { ExchangeAdapter, Position } from './exchanges/types.js'
import { accountKeyOf, adapterAccountKey, sessionsForExchange } from './exchanges/account-scope.js'

// The slice of the hedge-guard service the tick loop drives (user-armed hedge
// guards: trigger watch + wind-down). Kept structural so tests can stub it.
export interface HedgeTicker {
  activeExchanges(): string[]
  tickExchange(exchange: string, adapter: ExchangeAdapter, positions: Position[]): Promise<void>
}

const DEFAULT_TICK_MS = 3_000

export class LocalPositionManager {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly tickMs: number
  // Whether SIGNAL-armed rows may be driven (the EXECUTOR_LOCAL_TRAILING gate).
  // Manual rows are always driven — the user armed them explicitly.
  private readonly signalTrailingEnabled: boolean
  // Rebinds a bracket pair's stop leg to a fresh order id after a cancel/replace
  // so OCO sibling-cancel keeps targeting the LIVE stop (signal-client wiring).
  private readonly rebindBracketStop?: (exchange: string, signalId: string, newSlOrderId: string) => void
  // Manual-close-parity cleanup hooks for a FULL manager-driven close: retire
  // the OCO bracket for a signal id / cancel its resting entry rungs.
  private readonly retireBracket?: (exchange: string, signalId: string) => Promise<void> | void
  private readonly cancelEntryRungs?: (exchange: string, signalIds: string[]) => Promise<void> | void
  // User-armed hedge guards, driven off the same per-exchange position fetch.
  private readonly hedgeTicker?: HedgeTicker
  // Armed (dynamic) synthetic USD rows: same shape, same snapshot.
  private readonly syntheticTicker?: HedgeTicker

  constructor(
    private db: KaiBotDatabase,
    private exchangeManager: ExchangeManager,
    private notifications: NotificationBus | null = null,
    opts?: {
      tickMs?: number
      signalTrailingEnabled?: boolean
      rebindBracketStop?: (exchange: string, signalId: string, newSlOrderId: string) => void
      retireBracket?: (exchange: string, signalId: string) => Promise<void> | void
      cancelEntryRungs?: (exchange: string, signalIds: string[]) => Promise<void> | void
      hedgeTicker?: HedgeTicker
      syntheticTicker?: HedgeTicker
    },
  ) {
    this.tickMs = opts?.tickMs ?? DEFAULT_TICK_MS
    this.signalTrailingEnabled = opts?.signalTrailingEnabled ?? true
    this.rebindBracketStop = opts?.rebindBracketStop
    this.retireBracket = opts?.retireBracket
    this.cancelEntryRungs = opts?.cancelEntryRungs
    this.hedgeTicker = opts?.hedgeTicker
    this.syntheticTicker = opts?.syntheticTicker
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.db.log('error', 'trading', 'LocalPositionManager tick failed', { error: err?.message })
      })
    }, this.tickMs)
    this.db.log('info', 'system', 'Local position manager started', {
      tickMs: this.tickMs,
      signalTrailingEnabled: this.signalTrailingEnabled,
    })
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // One pass over all active local trails + edge-managed positions. Public for
  // tests. Managed positions run FIRST so their stop candidates feed the trail
  // rows' engine composition in the same tick (one stop owner, one dispatch).
  async tick(): Promise<void> {
    // SPINE gate: without EXECUTOR_LOCAL_TRAILING only manual rows (explicitly
    // armed by the user per position) are driven; signal rows stay inert.
    const trails = this.db
      .listActiveLocalTrails()
      .filter((t) => t.source === 'manual' || this.signalTrailingEnabled)
    // Edge manager engine rows (F2) — always manual (the user attached them).
    const managed = this.db.listActiveManagedPositions()
    // Exchanges carrying an armed/open hedge guard need this cycle's positions
    // too, even without any trail or manager row.
    const hedgeExchanges = [
      ...(this.hedgeTicker?.activeExchanges() ?? []),
      ...(this.syntheticTicker?.activeExchanges() ?? []),
    ]
    if (trails.length === 0 && managed.length === 0 && hedgeExchanges.length === 0) return

    // Group by exchange so positions are fetched once per exchange.
    const byExchange = new Map<string, LocalTrailStateRow[]>()
    for (const t of trails) {
      byExchange.set(t.exchange, [...(byExchange.get(t.exchange) ?? []), t])
    }
    const managedByExchange = new Map<string, ManagedPositionRow[]>()
    for (const m of managed) {
      managedByExchange.set(m.exchange, [...(managedByExchange.get(m.exchange) ?? []), m])
      if (!byExchange.has(m.exchange)) byExchange.set(m.exchange, [])
    }
    for (const ex of hedgeExchanges) {
      if (!byExchange.has(ex)) byExchange.set(ex, [])
    }

    for (const [exchangeName, exchangeRows] of byExchange) {
      // One pass per CONNECTION on the exchange: rows belong to the connection
      // their account names (null account = default), and a row must only ever
      // read its own connection's positions.
      const sessions = await sessionsForExchange(this.exchangeManager, 'default', exchangeName)
      for (const session of sessions) {
        if (!session || session.status !== 'connected') continue
        const connectionKey = adapterAccountKey(session.adapter)
        const ownsRow = (accountId: string | null | undefined) => accountKeyOf(accountId) === connectionKey
        const rows = exchangeRows.filter((t) => ownsRow(t.account_id))
        const managedRows = (managedByExchange.get(exchangeName) ?? []).filter((m) => ownsRow(m.account_id))

        let positions
        try {
          positions = await session.adapter.getPositions()
        } catch (err: any) {
          // Local stream/poll unavailable → leave the server manager as fallback.
          this.db.log('warn', 'trading', 'LocalPositionManager getPositions failed', {
            exchange: exchangeName,
            error: err.message,
          })
          continue
        }

        // Group aggregates (G2), FROZEN from this cycle's position fetch: every
        // managed row on this exchange sees the same numbers even as earlier
        // rows' closes shrink the group mid-loop — the whole group reacts on the
        // same cycle (backtester per-bar-freeze parity).
        const liveRefs: LivePositionRef[] = positions
          .filter((p) => Math.abs(p.size) > 0)
          .map((p) => ({
            exchange: exchangeName,
            accountId: p.accountId,
            symbol: p.symbol,
            side: p.side,
            size: p.size,
            entryPrice: p.entryPrice,
            markPrice: p.markPrice,
            unrealizedPnL: p.unrealizedPnL,
          }))
        const groupStates = buildGroupAggregateStates(this.db, liveRefs)

        // 1) Edge manager engine. Collects manager stop candidates per symbol and
        //    the symbols a manager fully closed this tick (their trails were
        //    already retired inside the close — skip them below).
        const managerStops = new Map<string, number>()
        const closedSymbols = new Set<string>()
        for (const row of managedRows) {
          const live = positions.find(
            (p) =>
              p.symbol.toLowerCase() === row.symbol.toLowerCase() &&
              Math.abs(p.size) > 0 &&
              (row.account_id == null || p.accountId === row.account_id),
          )
          if (!live) {
            // Position flat → managers retire with it (the trail loop below
            // handles the stop-order cleanup for its own rows).
            this.db.deactivateManagedPosition(row.position_key)
            this.db.log('info', 'trading', 'Edge managers retired (position flat)', {
              key: row.position_key, exchange: exchangeName,
            })
            continue
          }
          const price = live.markPrice
          if (price == null || !(price > 0)) continue
          const groupInfo = groupInfoForPosition(
            this.db,
            exchangeName,
            live.accountId ?? row.account_id ?? 'default',
            row.symbol,
          )
          const group = groupInfo ? groupStates.get(groupInfo.id) : undefined
          try {
            const out = await this.runManagedPosition(exchangeName, session.adapter, row, live, price, group)
            if (out.stopCandidate != null) {
              const k = row.symbol.toLowerCase()
              const prev = managerStops.get(k)
              managerStops.set(
                k,
                prev == null
                  ? out.stopCandidate
                  : isFavourableStop(out.stopCandidate, prev, row.direction)
                    ? out.stopCandidate
                    : prev,
              )
            }
            if (out.fullyClosed) closedSymbols.add(row.symbol.toLowerCase())
          } catch (err: any) {
            this.db.log('error', 'trading', 'Edge manager tick failed', {
              key: row.position_key, error: err?.message,
            })
          }
        }

        // 2) Trail rows (the stop owners). Position identity is (exchange,
        // account, symbol) — without the account filter a row could read the
        // OTHER account's same-symbol position (wrong mark, and worse: a flat
        // row kept "alive" by the sibling account's position, or retired with a
        // cancel of a stop that still protects the sibling).
        for (const row of rows) {
          if (closedSymbols.has(row.symbol.toLowerCase())) continue
          const live = positions.find(
            (p) =>
              p.symbol.toLowerCase() === row.symbol.toLowerCase() &&
              Math.abs(p.size) > 0 &&
              (row.account_id == null || p.accountId == null || p.accountId === row.account_id),
          )
          if (!live) {
            // Position flat → the trail is done. A manual-armed trail OWNS its
            // stop order (it may not be in any OCO bracket), so cancel it too —
            // a reduce-only stop left resting against nothing is an orphan.
            await this.retireFlatTrail(exchangeName, session.adapter, row)
            continue
          }
          const price = live.markPrice
          if (price == null || !(price > 0)) continue
          await this.advanceTrail(
            exchangeName,
            session.adapter,
            row,
            price,
            managerStops.get(row.symbol.toLowerCase()),
          )
        }

        // 3) Hedge guards (trigger watch + wind-down), same frozen position
        //    snapshot. A hedge opened this cycle becomes visible to trails/
        //    managers on the NEXT cycle — per-cycle-freeze parity.
        if (this.hedgeTicker) {
          try {
            await this.hedgeTicker.tickExchange(exchangeName, session.adapter, positions)
          } catch (err: any) {
            this.db.log('error', 'trading', 'Hedge guard pass failed', {
              exchange: exchangeName, error: err?.message,
            })
          }
        }

        // 4) Armed synthetic USD rows (trigger mint / recovery unwind), same
        //    frozen snapshot of THIS connection; the mark comes from the venue
        //    when no position exists on the instrument yet.
        if (this.syntheticTicker) {
          try {
            await this.syntheticTicker.tickExchange(exchangeName, session.adapter, positions)
          } catch (err: any) {
            this.db.log('error', 'trading', 'Synthetic guard pass failed', {
              exchange: exchangeName, error: err?.message,
            })
          }
        }
      }
    }
  }

  // Run one edge-managed position for one mark tick: advance the persisted
  // ManagedPositionState, drive every attached reducer's onTick (composition +
  // risk-guard filter in runManagersTick), apply reduce-closes, and return the
  // composed stop candidate for the trail row (the stop OWNER) to dispatch.
  private async runManagedPosition(
    exchangeName: string,
    adapter: { placeOrder: Function; cancelOrder: Function; getPositions: Function },
    row: ManagedPositionRow,
    live: { size: number; entryPrice: number; accountId?: string },
    price: number,
    // The position's group aggregates for this cycle (G2), if grouped.
    group?: GroupAggregateState,
  ): Promise<{ stopCandidate: number | null; fullyClosed: boolean }> {
    const managerRows = this.db.listActiveManagersForPosition(row.position_key)
    const entries: RuntimeManagerEntry[] = []
    for (const m of managerRows) {
      const def = EDGE_MANAGER_REGISTRY[m.manager_id]
      if (!def) {
        this.db.log('warn', 'trading', 'Unknown edge manager skipped', {
          key: row.position_key, managerId: m.manager_id,
        })
        continue
      }
      let params: unknown
      let state: ManagerRunnerState
      try {
        params = JSON.parse(m.params)
        state = JSON.parse(m.state) as ManagerRunnerState
      } catch {
        this.db.log('error', 'trading', 'Edge manager row corrupt — skipped', {
          key: row.position_key, managerId: m.manager_id,
        })
        continue
      }
      entries.push({
        managerId: m.manager_id,
        plugin: def.plugin,
        params,
        state: state ?? EMPTY_MANAGER_STATE,
        execOrder: m.exec_order,
      })
    }
    if (entries.length === 0) return { stopCandidate: null, fullyClosed: false }

    // The current-stop yardstick is the venue-resting stop the trail row owns.
    const trailRow = this.db
      .findActiveTrailsForSymbol(exchangeName, row.symbol)
      .find((t) => t.account_id == null || row.account_id == null || t.account_id === row.account_id)
    const currentStopLoss = trailRow?.current_stop ?? row.current_stop_loss

    // Advance the persisted mirror with this tick, syncing size/avg entry from
    // the venue's REAL position (true fills, not authored rung prices).
    const base: ManagedPositionState = {
      id: row.position_key,
      direction: row.direction,
      avgEntryPrice: live.entryPrice,
      size: Math.abs(live.size),
      extremePriceAtEntry: row.extreme_price,
      oppositePrice: row.opposite_price,
      currentStopLoss,
      openedTs: row.opened_ts,
      exchange: exchangeName,
      ...(row.reference_price != null ? { referencePrice: row.reference_price } : {}),
    }
    const position = advanceManagedPosition(base, { high: price, low: price })

    const result = runManagersTick({ position, managers: entries, price, ts: Date.now(), group })
    for (const dropped of result.dropped) {
      // Protect/reduce-only: entry-side actions never execute on the edge.
      this.db.log('warn', 'trading', 'Edge manager action dropped (protect/reduce-only)', {
        key: row.position_key, action: dropped.type, reason: (dropped as any).reason,
      })
    }

    // Persist the advanced mirror + each manager's threaded state.
    this.db.updateManagedPosition(row.position_key, {
      avgEntryPrice: position.avgEntryPrice,
      size: position.size,
      extremePrice: position.extremePriceAtEntry,
      oppositePrice: position.oppositePrice,
      currentStopLoss,
    })
    for (const m of managerRows) {
      const next = result.states.get(m.manager_id)
      if (!next) continue
      const encoded = JSON.stringify(next)
      if (encoded !== m.state) this.db.updatePositionManagerState(row.position_key, m.manager_id, encoded)
    }

    // Reduce-closes (tp-ladder tranches, risk-guard global stop).
    const { fraction, reasons } = foldCloseFraction(result.actions)
    let fullyClosed = false
    if (fraction > 0) {
      fullyClosed = await this.applyManagerClose(exchangeName, adapter, row, fraction, reasons)
    }

    const stopCandidate = fullyClosed ? null : foldStopCandidate(position, result.actions)
    return { stopCandidate, fullyClosed }
  }

  // Place a reduce-only market close for `fraction` of the live position, with
  // manual-close-parity cleanup on a FULL close (retire brackets + entry rungs
  // + trails + managers). Returns true when the position was fully closed.
  private async applyManagerClose(
    exchangeName: string,
    adapter: { placeOrder: Function; cancelOrder: Function; getPositions: Function },
    row: ManagedPositionRow,
    fraction: number,
    reasons: string[],
  ): Promise<boolean> {
    const reason = reasons.join('+') || 'manager-close'
    return withOrderLock(exchangeName, async () => {
      // Re-fetch inside the lock: the qty must come from the position as it is
      // NOW (an in-flight fill may have changed it since the tick started).
      let positions
      try {
        positions = await adapter.getPositions()
      } catch {
        return false
      }
      const live = positions.find(
        (p: any) =>
          p.symbol.toLowerCase() === row.symbol.toLowerCase() &&
          Math.abs(p.size) > 0 &&
          (row.account_id == null || p.accountId === row.account_id),
      )
      if (!live) {
        this.db.deactivateManagedPosition(row.position_key)
        return true
      }
      const full = fraction >= 1
      const qty = Math.abs(live.size) * fraction
      if (!(qty > 0)) return false
      const closeSide: 'buy' | 'sell' = row.direction === 'long' ? 'sell' : 'buy'
      const accountId = live.accountId ?? row.account_id ?? 'default'

      // Full close: cancel every resting protective/pre-authorized order FIRST
      // (manual-close parity) — a stop/TP can't fire against a position we're
      // flattening, and a resting entry rung can't fill into nothing.
      if (full) {
        const manualIds = this.db.listManualEntrySignalIds(exchangeName, row.symbol)
        for (const sid of manualIds) {
          try {
            await this.retireBracket?.(exchangeName, sid)
          } catch {
            /* best effort — the leg may already be gone */
          }
        }
        if (manualIds.length > 0) {
          try {
            await this.cancelEntryRungs?.(exchangeName, manualIds)
          } catch {
            /* best effort */
          }
        }
        for (const trail of this.db.findActiveTrailsForSymbol(exchangeName, row.symbol)) {
          if (trail.sl_order_id) {
            try {
              await adapter.cancelOrder(trail.sl_order_id, { symbol: row.symbol })
            } catch {
              /* already gone */
            }
          }
          this.db.deactivateLocalTrail(trail.signal_id)
        }
      }

      const result = await adapter.placeOrder({
        accountId,
        symbol: row.symbol,
        side: closeSide,
        orderType: 'market',
        quantity: qty,
        reduceOnly: true,
        label: `kaibot:${row.position_key}:manage`,
      })
      const settlementId = this.db.insertOrderSettlement({
        signalId: row.position_key,
        exchange: exchangeName,
        accountId,
        symbol: row.symbol,
        kind: 'exit',
        side: closeSide,
        qty,
        orderId: result.orderId,
        targetLabel: `manage:${reason}`,
        status: 'unknown',
      })
      const settled = await settleAdapterOrder(adapter as any, result.orderId, {
        symbol: row.symbol,
        accountId,
      })
      // With a broker status endpoint the settlement is authoritative; without
      // one the placeOrder result is. timeout/pending stays 'unknown' so
      // resolveUnknownOrders finishes it (same rule as the manual-trade path).
      const src = (adapter as any).getOrderStatus ? settled.status : result.status
      if (src === 'filled' || src === 'partially_filled') {
        this.db.resolveOrderSettlement(settlementId, 'filled')
        // A manager exit is still the bot's exit: book it onto the executions
        // holding the position, or the trade is realized at the venue and
        // unpriced in the fills ledger (no exit fill = no P&L, no analytics).
        const filledQty =
          settled.filledQuantity && settled.filledQuantity > 0
            ? settled.filledQuantity
            : result.filledQuantity && result.filledQuantity > 0
              ? result.filledQuantity
              : qty
        attributeVenueExit(this.db, {
          exchange: exchangeName,
          accountId,
          symbol: row.symbol,
          side: closeSide,
          qty: filledQty,
          price: settled.averagePrice ?? result.averagePrice ?? null,
          orderId: result.orderId,
          reason: `closed by manager (${reason})`,
        })
      } else if (src === 'rejected') {
        this.db.resolveOrderSettlement(settlementId, 'rejected')
      } else if (src === 'cancelled') {
        this.db.resolveOrderSettlement(settlementId, 'cancelled')
      }
      // Move the manual marker toward flat (no-op without a marker).
      this.db.reduceManualPosition(exchangeName, accountId, row.symbol, qty)

      if (full) this.db.deactivateManagedPosition(row.position_key)
      this.db.log('info', 'trading', 'Edge manager close executed', {
        key: row.position_key, exchange: exchangeName, symbol: row.symbol,
        fraction, qty, reason, full,
      })
      this.notifications?.publish({
        type: 'manager_close',
        title: full ? 'Position closed by manager' : 'Position reduced by manager',
        body: `${row.symbol}: ${reason} closed ${(fraction * 100).toFixed(1)}% (reduce-only).`,
        data: { key: row.position_key, symbol: row.symbol, fraction, reason },
      })
      return full
    })
  }

  private async retireFlatTrail(
    exchangeName: string,
    adapter: { cancelOrder: Function },
    row: LocalTrailStateRow,
  ): Promise<void> {
    if (row.source === 'manual' && row.sl_order_id) {
      const slOrderId = row.sl_order_id
      await withOrderLock(exchangeName, async () => {
        try {
          await adapter.cancelOrder(slOrderId, { symbol: row.symbol })
          this.db.log('info', 'trading', 'Trail stop cancelled (position flat)', {
            key: row.signal_id, exchange: exchangeName, slOrderId,
          })
        } catch (err: any) {
          // Already filled/cancelled (e.g. the stop itself flattened the
          // position) — nothing to place, but LOG it: a silent retire made the
          // 2026-08-26 wind-down unauditable (no trace of who removed the stop).
          this.db.log('info', 'trading', 'Trail stop cancel skipped on flat (already terminal)', {
            key: row.signal_id, exchange: exchangeName, slOrderId, error: err?.message,
          })
        }
      })
    }
    this.db.deactivateLocalTrail(row.signal_id)
  }

  private async advanceTrail(
    exchangeName: string,
    adapter: { placeOrder: Function; cancelOrder: Function },
    row: LocalTrailStateRow,
    price: number,
    // Composed stop candidate from the position's edge managers this tick (F2).
    managerStop?: number,
  ): Promise<void> {
    const extreme = updateExtreme(row.direction, row.extreme_price, price)
    const opposite = updateAdverseExtreme(
      row.direction,
      row.opposite_price ?? row.entry_price,
      price,
    )
    // Engine ratchet seed: rows from before migration 028 carry the server stop
    // in current_stop only — seed the engine off it so behaviour is unchanged.
    const engineStopPrev = row.engine_stop ?? row.current_stop
    const engineCandidate = computeEngineStopCandidate(
      row,
      extreme,
      opposite,
      price,
      engineStopPrev,
      managerStop != null ? [managerStop] : [],
    )
    const engineStop = engineCandidate ?? engineStopPrev ?? null

    // Effective stop: manual always participates, engine only improves,
    // trailing_lock = manual absolute (may move the stop against the position).
    const effective = composeEffectiveStop({
      direction: row.direction,
      manualStop: row.manual_stop,
      engineStop,
      trailingLock: !!row.trailing_lock,
    })

    // Persist advanced marks/ratchet even when the venue stop doesn't move
    // (e.g. a dominant manual stop, or no placeable candidate yet).
    const persistMarks = () => {
      const fields: Parameters<KaiBotDatabase['updateLocalTrail']>[1] = {}
      if (extreme !== row.extreme_price) fields.extremePrice = extreme
      if (stopsDiffer(opposite, row.opposite_price)) fields.oppositePrice = opposite
      if (engineCandidate != null && stopsDiffer(engineStop, row.engine_stop)) {
        fields.engineStop = engineStop
      }
      if (Object.keys(fields).length > 0) this.db.updateLocalTrail(row.signal_id, fields)
    }

    // No resting venue stop (fresh manual arm without an adoptable seed, or a
    // failed replace that nulled sl_order_id) → place it even when the level
    // equals current_stop; the row's stop is only real once it rests on the
    // venue.
    const needsPlacement = row.sl_order_id == null
    if (effective == null || (!needsPlacement && !stopsDiffer(effective, row.current_stop))) {
      persistMarks()
      return
    }
    // Never cancel the resting stop for a replacement the venue would reject
    // (wrong side of the market) — that would leave the position unprotected
    // (EX4). Composition can yield a wrong-side stop when a locked manual value
    // is stale against the moved market.
    if (!(row.direction === 'long' ? effective < price : effective > price)) {
      persistMarks()
      return
    }

    const newStopPrice = effective
    // Re-place the protective stop on the opposite side, reduce-only.
    const side: 'buy' | 'sell' = row.direction === 'long' ? 'sell' : 'buy'

    await withOrderLock(exchangeName, async () => {
      // Find the live size for the replacement stop quantity.
      let positions
      try {
        positions = await (adapter as any).getPositions()
      } catch {
        return
      }
      const live = positions.find(
        (p: any) =>
          p.symbol.toLowerCase() === row.symbol.toLowerCase() &&
          Math.abs(p.size) > 0 &&
          (row.account_id == null || p.accountId == null || p.accountId === row.account_id),
      )
      if (!live) {
        this.db.deactivateLocalTrail(row.signal_id)
        return
      }
      const qty = Math.abs(live.size)

      // Re-validate against the price observed NOW (the lock may have delayed
      // us past the tick that produced the candidate): if the market moved to
      // the wrong side of the new stop, keep the existing protective stop.
      const priceNow = live.markPrice != null && live.markPrice > 0 ? live.markPrice : price
      const stillValid =
        row.direction === 'long' ? newStopPrice < priceNow : newStopPrice > priceNow
      if (!stillValid) {
        persistMarks()
        return
      }

      // Cancel the old stop before placing the new one.
      if (row.sl_order_id) {
        try {
          await adapter.cancelOrder(row.sl_order_id, { symbol: row.symbol })
        } catch (err: any) {
          this.db.log('warn', 'trading', 'Trail: cancel old stop failed', {
            signalId: row.signal_id, slOrderId: row.sl_order_id, error: err.message,
          })
        }
      }

      // Preserve the TP id across the SL update (updateSignalOrderIds writes BOTH
      // columns) and resolve the real account — hardcoded 'default' mis-routes
      // Deribit btc/eth and TS/IB accounts.
      const tpId = this.db.getSignalBracket(row.signal_id)?.take_profit_order_id ?? undefined
      try {
        const placed = await adapter.placeOrder({
          accountId: live.accountId ?? row.account_id ?? 'default',
          symbol: row.symbol,
          side,
          orderType: 'stop',
          quantity: qty,
          stopPrice: newStopPrice,
          reduceOnly: true,
          label: `kaibot:${row.signal_id}:trail`,
        })
        this.db.updateLocalTrail(row.signal_id, {
          slOrderId: placed.orderId,
          extremePrice: extreme,
          oppositePrice: opposite,
          engineStop,
          currentStop: newStopPrice,
        })
        // Propagate the new stop id to the persisted signal so a TP fill / server
        // close cancels the LIVE stop, not the one we just cancelled (double-exit).
        this.db.updateSignalOrderIds(row.signal_id, placed.orderId, tpId)
        // Manual attach adopted an existing bracket's stop → rebind the bracket
        // to the fresh order id so its OCO sibling-cancel targets the live stop.
        if (row.bracket_signal_id) {
          this.rebindBracketStop?.(exchangeName, row.bracket_signal_id, placed.orderId)
        }
        this.db.log('info', 'trading', 'Trailing stop amended', {
          signalId: row.signal_id, exchange: exchangeName, newStop: newStopPrice, extreme,
        })
      } catch (err: any) {
        this.db.log('error', 'trading', 'Trail: place new stop failed — position is UNPROTECTED until retried', {
          signalId: row.signal_id, error: err.message,
        })
        // The old stop was already cancelled above. Drop the stale id everywhere so
        // nothing cancels a dead order; current_stop is left unchanged so a later
        // tick re-attempts the placement.
        this.db.updateLocalTrail(row.signal_id, { slOrderId: null })
        this.db.updateSignalOrderIds(row.signal_id, undefined, tpId)
        this.notifications?.publish({
          type: 'trail_stop_failed',
          title: 'Trailing stop not replaced',
          body: `Could not re-place the protective stop for ${row.symbol}; the position is unprotected until it retries.`,
          data: { signalId: row.signal_id, symbol: row.symbol },
        })
      }
    })
  }
}

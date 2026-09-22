// Venue-exit sweep: notice broker-side exits we did not place in this process
// tick and book them.
//
// A resting GTC stop (server_exit_state / bracket_pairs / local_trail_state) is
// a first-class exit: when the broker fills it, the execution must close, the
// fill must land in the ledger, the protective state must retire and the server
// must learn the position is flat. Nothing did that before 2026-09-01: a filled
// MGCZ26 stop left the book at "expected 1", and the reconciler bought the
// position BACK (unprotected) to make the broker match the stale book.
//
// Two entry points:
//  - sweepVenueExitOrders: polls the resting exit orders we track via
//    getOrderStatus and books any that filled. Runs as a reconciler pre-step
//    (inside the exchange order lock, BEFORE the netting comparison), so a
//    stop-fill is booked before any correction logic can see a mismatch.
//  - adoptVenueClose: the reconciler's replacement for exposure-increasing
//    "corrections". A position that vanished at the broker is adopted as a
//    close (booked via attribution), never re-bought.

import type { OrderStatus } from './exchanges/types.js'
import { attributeVenueExit, type ExitAllocation } from './exit-attribution.js'
import { parseTpOrderIds } from '../storage/database.js'
import { accountKeyOf } from './exchanges/account-scope.js'

export interface VenueExitSweepDb {
  listActiveServerExitStates(exchange?: string): Array<{
    position_id: string
    entry_signal_id: string
    exchange: string
    symbol: string
    direction: 'long' | 'short'
    sl_order_id: string | null
  }>
  listBracketPairs(): Array<{
    signal_id: string
    exchange: string
    sl_order_id: string | null
    tp_order_id: string | null
    tp_order_ids: string | null
  }>
  listActiveLocalTrails(): Array<{
    signal_id: string
    exchange: string
    symbol: string
    sl_order_id: string | null
  }>
  getSignalExecution(signalId: string):
    | {
        signal_id: string
        symbol: string
        exchange: string
        direction: 'long' | 'short'
        status: string
        qty_opened: number
        qty_closed: number
        account_id: string | null
        created_at: number
      }
    | undefined
  targetAlreadyProcessed(signalId: string, kind: 'entry' | 'exit', targetLabel: string): boolean
  /** Total exit-fill quantity already booked in the ledger for this order id. */
  sumExitFillQtyForOrder(orderId: string): number
  insertOrderSettlement(row: {
    signalId: string
    exchange: string
    accountId?: string | null
    symbol: string
    kind: 'entry' | 'exit'
    side: 'buy' | 'sell'
    qty: number
    orderId: string
    targetLabel?: string | null
    status?: 'unknown' | 'filled' | 'rejected' | 'cancelled' | 'lost'
  }): number
  deactivateServerExitState(positionId: string): unknown
  deactivateLocalTrail(signalId: string): unknown
  deleteBracketPair(signalId: string): unknown
  // Attribution surface (ExitAttributionDb, structurally)
  listOpenExecutionsForExchange(exchange: string): Array<{
    signal_id: string
    symbol: string
    account_id: string | null
    qty_opened: number
    qty_closed: number
    created_at: number
  }>
  insertSignalFill(fill: {
    signalId: string
    kind: 'entry' | 'exit'
    symbol: string
    side: 'buy' | 'sell'
    qty: number
    price?: number | null
    orderId?: string | null
    createdAtMs?: number
  }): unknown
  updateSignalExecution(
    signalId: string,
    patch: {
      status?: 'open' | 'closed' | 'closing' | 'error'
      qtyClosed?: number
      qtyPendingClose?: number | null
    },
  ): unknown
  markEntrySignalClosed(signalId: string, reason?: string): unknown
  log(level: string, category: string, message: string, data?: unknown): unknown
}

export interface VenueExitSweepDeps {
  db: VenueExitSweepDb
  // Adapter surface for one exchange; null when not connected. accountId
  // (namespaced on labeled connections) picks the owning connection.
  getAdapter(exchange: string, accountId?: string | null): Promise<{
    getOrderStatus?: (orderId: string, ctx?: { accountId?: string; symbol?: string }) => Promise<OrderStatus>
    getLastPrice?: (symbol: string) => Promise<number | null | undefined>
  } | null>
  // OCO retire hook (signal client's onExchangeOrderUpdate): cancels sibling
  // legs + resting rungs and drops the persisted bracket pair.
  retireOrderGroup?(exchange: string, orderId: string): Promise<void>
  // Cancel + forget every protective order tracked on this entry signal
  // (bracket legs, trail-owned stops). Used by adoptVenueClose: the position is
  // gone, but its GTC stop may still rest — an orphaned stop fills into a naked
  // position later.
  retireProtections?(exchange: string, signalId: string): Promise<void>
  // Tell the server this position is flat (venue exit) so the runner retires.
  reportVenueExit?(
    positionId: string,
    fill: { price: number | null; timeMs: number; orderId?: string | null },
  ): Promise<void>
}

interface RestingExitCandidate {
  orderId: string
  entrySignalId: string
  kind: 'stop' | 'take-profit' | 'trail'
  positionId?: string
}

// Resting exit orders we track for this exchange, deduped by order id. A stop
// registered both as server exit state and as a bracket leg counts once (the
// richer server-state context wins — it carries the position id).
export function collectRestingExitCandidates(
  db: Pick<VenueExitSweepDb, 'listActiveServerExitStates' | 'listBracketPairs' | 'listActiveLocalTrails'>,
  exchange: string,
): RestingExitCandidate[] {
  const byOrder = new Map<string, RestingExitCandidate>()
  for (const pair of db.listBracketPairs()) {
    if (pair.exchange !== exchange) continue
    if (pair.sl_order_id) {
      byOrder.set(pair.sl_order_id, { orderId: pair.sl_order_id, entrySignalId: pair.signal_id, kind: 'stop' })
    }
    for (const tp of [pair.tp_order_id, ...parseTpOrderIds(pair.tp_order_ids)]) {
      if (tp) byOrder.set(tp, { orderId: tp, entrySignalId: pair.signal_id, kind: 'take-profit' })
    }
  }
  for (const trail of db.listActiveLocalTrails()) {
    if (trail.exchange !== exchange || !trail.sl_order_id) continue
    byOrder.set(trail.sl_order_id, {
      orderId: trail.sl_order_id,
      entrySignalId: trail.signal_id,
      kind: 'trail',
    })
  }
  for (const state of db.listActiveServerExitStates(exchange)) {
    if (!state.sl_order_id) continue
    byOrder.set(state.sl_order_id, {
      orderId: state.sl_order_id,
      entrySignalId: state.entry_signal_id,
      kind: 'stop',
      positionId: state.position_id,
    })
  }
  return [...byOrder.values()]
}

// Retire every protective/state row that referenced this now-closed entry
// signal, and report the venue exit for its server-managed position.
async function retireStateForClosedSignal(
  deps: VenueExitSweepDeps,
  exchange: string,
  signalId: string,
  fill: { price: number | null; timeMs: number; orderId?: string | null },
): Promise<void> {
  const { db } = deps
  for (const state of db.listActiveServerExitStates(exchange)) {
    if (state.entry_signal_id !== signalId) continue
    db.deactivateServerExitState(state.position_id)
    try {
      await deps.reportVenueExit?.(state.position_id, fill)
    } catch (err: any) {
      db.log('warn', 'trading', 'Venue exit report to server failed', {
        positionId: state.position_id,
        signalId,
        error: err?.message,
      })
    }
  }
  for (const trail of db.listActiveLocalTrails()) {
    if (trail.exchange === exchange && trail.signal_id === signalId) {
      db.deactivateLocalTrail(trail.signal_id)
    }
  }
}

/**
 * Poll the resting exit orders tracked on this exchange and book any that the
 * broker reports filled. Returns the number of orders booked. Idempotent per
 * order id via the settlement dedup key (`venue-exit:<orderId>`).
 */
export async function sweepVenueExitOrders(
  deps: VenueExitSweepDeps,
  exchange: string,
): Promise<number> {
  const { db } = deps
  const candidates = collectRestingExitCandidates(db, exchange)
  if (candidates.length === 0) return 0
  // One adapter per connection (the execution's account names it).
  const adapters = new Map<string, Awaited<ReturnType<VenueExitSweepDeps['getAdapter']>>>()
  const adapterFor = async (accountId: string | null | undefined) => {
    const key = accountKeyOf(accountId) ?? ''
    if (!adapters.has(key)) adapters.set(key, await deps.getAdapter(exchange, accountId))
    return adapters.get(key) ?? null
  }

  let booked = 0
  for (const cand of candidates) {
    const exec = db.getSignalExecution(cand.entrySignalId)
    // Self-heal (2026-09-02, MNQU26): a close path that forgot to retire its
    // protective state leaves the sweep polling a cancelled order forever.
    // A terminal execution proves the position is gone — retire the lingering
    // rows here (bookkeeping only, the close already cancelled the orders).
    if (exec && (exec.status === 'closed' || exec.status === 'error')) {
      if (cand.positionId) db.deactivateServerExitState(cand.positionId)
      for (const state of db.listActiveServerExitStates(exchange)) {
        if (state.entry_signal_id === cand.entrySignalId) db.deactivateServerExitState(state.position_id)
      }
      db.deactivateLocalTrail(cand.entrySignalId)
      // A sibling leg may still rest at the broker (a failed cancel during the
      // close) — retireProtections cancels best-effort and drops the pair row;
      // without the hook (tests), dropping the row alone stops the polling.
      if (deps.retireProtections) {
        try {
          await deps.retireProtections(exchange, cand.entrySignalId)
        } catch {
          db.deleteBracketPair(cand.entrySignalId)
        }
      } else {
        db.deleteBracketPair(cand.entrySignalId)
      }
      db.log('info', 'trading', 'Venue exit sweep: retired lingering protective state of a terminal execution', {
        exchange,
        signalId: cand.entrySignalId,
        orderId: cand.orderId,
      })
      continue
    }
    if (!exec || (exec.status !== 'open' && exec.status !== 'closing')) continue
    const openQty = exec.qty_opened - exec.qty_closed
    if (!(openQty > 0)) continue

    const adapter = await adapterFor(exec.account_id)
    if (!adapter?.getOrderStatus) continue

    let status: OrderStatus
    try {
      status = await adapter.getOrderStatus(cand.orderId, {
        symbol: exec.symbol,
        ...(exec.account_id ? { accountId: exec.account_id } : {}),
      })
    } catch (err: any) {
      db.log('warn', 'trading', 'Venue exit sweep: order status lookup failed', {
        orderId: cand.orderId,
        signalId: exec.signal_id,
        error: err?.message,
      })
      continue
    }
    if (status.state !== 'filled' && status.state !== 'partially_filled') continue

    // Idempotence per fill EVENT: a full fill books once under the bare label;
    // a partial books once per cumulative level (Bybit/Binance report
    // partially_filled on a still-live order, so the same cum must not restack
    // while a grown cum books only the delta past what this ORDER already has
    // in the ledger — attribution further caps at the execution's open qty).
    const cum = status.filledQuantity && status.filledQuantity > 0 ? status.filledQuantity : null
    const targetLabel =
      status.state === 'filled'
        ? `venue-exit:${cand.orderId}`
        : `venue-exit:${cand.orderId}:${cum ?? 'partial'}`
    if (db.targetAlreadyProcessed(exec.signal_id, 'exit', targetLabel)) continue
    const bookedForOrder = db.sumExitFillQtyForOrder(cand.orderId)
    const filledQty = cum != null ? Math.min(cum - bookedForOrder, openQty) : openQty
    if (!(filledQty > 0)) continue
    const side: 'buy' | 'sell' = exec.direction === 'long' ? 'sell' : 'buy'
    const price = status.averagePrice ?? null
    const timeMs = status.filledAtMs ?? Date.now()

    // Settlement row first: it is the idempotence key AND feeds the
    // reconciler's recent-exit grace window for this (account, symbol).
    db.insertOrderSettlement({
      signalId: exec.signal_id,
      exchange,
      accountId: exec.account_id,
      symbol: exec.symbol,
      kind: 'exit',
      side,
      qty: filledQty,
      orderId: cand.orderId,
      targetLabel,
      status: 'filled',
    })

    const plan = attributeVenueExit(db, {
      exchange,
      accountId: exec.account_id,
      symbol: exec.symbol,
      side,
      qty: filledQty,
      price,
      orderId: cand.orderId,
      filledAtMs: status.filledAtMs ?? null,
      reason: `venue ${cand.kind} filled`,
    })
    booked += 1
    db.log('info', 'trading', 'Venue exit booked from resting order', {
      exchange,
      symbol: exec.symbol,
      orderId: cand.orderId,
      kind: cand.kind,
      qty: filledQty,
      price,
      attributed: plan.map((a) => ({ signalId: a.signalId, qty: a.qty })),
    })

    // OCO semantics on a FULL fill: cancel sibling legs + resting rungs, drop
    // the pair row. A partial leaves the group standing — on Bybit/Binance the
    // order is still live at the broker.
    if (status.state === 'filled') {
      try {
        await deps.retireOrderGroup?.(exchange, cand.orderId)
      } catch (err: any) {
        db.log('warn', 'trading', 'Venue exit sweep: OCO retire failed', {
          orderId: cand.orderId,
          error: err?.message,
        })
      }
    }

    const fill = { price, timeMs, orderId: cand.orderId }
    for (const a of plan) {
      if (a.fullyClosed) await retireStateForClosedSignal(deps, exchange, a.signalId, fill)
    }
    // No open execution matched (plan empty) but the tracked order DID fill:
    // the protective state is spent either way.
    if (plan.length === 0 && cand.positionId) {
      db.deactivateServerExitState(cand.positionId)
      try {
        await deps.reportVenueExit?.(cand.positionId, fill)
      } catch (err: any) {
        db.log('warn', 'trading', 'Venue exit report to server failed', {
          positionId: cand.positionId,
          error: err?.message,
        })
      }
    }
  }
  return booked
}

export interface AdoptVenueCloseInput {
  exchange: string
  accountId: string
  symbol: string
  /** Closing-order side that the venue must have executed (long book → 'sell'). */
  side: 'buy' | 'sell'
  qty: number
  reason?: string
}

/**
 * Book a position that DISAPPEARED at the broker as a close on the executions
 * holding it. The counterpart of a reconciler "correction": exposure that the
 * broker no longer holds is adopted as an exit (best-effort price), never
 * re-opened with a new order. Also retires any leftover protective orders on
 * the closed executions — the exit that flattened the position at the venue may
 * not have been ours, so our GTC stop can still be resting.
 */
export async function adoptVenueClose(
  deps: VenueExitSweepDeps,
  input: AdoptVenueCloseInput,
): Promise<ExitAllocation[]> {
  const { db } = deps
  let price: number | null = null
  try {
    const adapter = await deps.getAdapter(input.exchange, input.accountId)
    price = (await adapter?.getLastPrice?.(input.symbol)) ?? null
  } catch {
    /* estimate only — a missing price still books the close */
  }
  const timeMs = Date.now()

  db.insertOrderSettlement({
    signalId: `venue-adopt:${input.accountId}:${input.symbol}`,
    exchange: input.exchange,
    accountId: input.accountId,
    symbol: input.symbol,
    kind: 'exit',
    side: input.side,
    qty: input.qty,
    orderId: `adopted:${timeMs}`,
    targetLabel: 'venue-adopt',
    status: 'filled',
  })

  const plan = attributeVenueExit(db, {
    exchange: input.exchange,
    accountId: input.accountId,
    symbol: input.symbol,
    side: input.side,
    qty: input.qty,
    price,
    orderId: null,
    reason: input.reason ?? 'position gone at broker — adopted as close',
  })
  db.log('warn', 'trading', 'Adopted broker-side close', {
    exchange: input.exchange,
    accountId: input.accountId,
    symbol: input.symbol,
    qty: input.qty,
    priceEstimate: price,
    attributed: plan.map((a) => ({ signalId: a.signalId, qty: a.qty })),
  })

  const fill = { price, timeMs, orderId: null }
  for (const a of plan) {
    if (!a.fullyClosed) continue
    try {
      await deps.retireProtections?.(input.exchange, a.signalId)
    } catch (err: any) {
      db.log('warn', 'trading', 'Adopt close: protective retire failed', {
        signalId: a.signalId,
        error: err?.message,
      })
    }
    await retireStateForClosedSignal(deps, input.exchange, a.signalId, fill)
  }
  return plan
}

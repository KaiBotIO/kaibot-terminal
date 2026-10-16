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
import { confirmedFiredVerdict, freshVenueNet, rowLineageQtyFor, type StopBookDb } from './server-exit-stop.js'
import type { Position } from './exchanges/types.js'

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
  // Forget a stop the venue no longer holds (only while the row still points at it).
  dropServerExitStopOrder?(positionId: string, orderId: string): unknown
  dropBracketStop?(signalId: string, orderId: string): unknown
  dropLocalTrailStop?(signalId: string, orderId: string): unknown
  getSignalFills?(signalId: string): Array<{
    kind: 'entry' | 'exit'
    price: number | null
    order_id: string | null
    created_at: number
  }>
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
    commission?: number
    feeNative?: number | null
    feeCurrency?: string | null
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
    getOrderFills?: (orderId: string, ctx?: { accountId?: string; symbol?: string }) => Promise<{ filledQuantity: number }>
    getPositions?: () => Promise<Position[]>
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
  // sent:false = returned without the server confirming.
  reportVenueExit?(
    positionId: string,
    fill: { price: number | null; timeMs: number; orderId?: string | null },
  ): Promise<{ sent: boolean; kept?: boolean; reason?: string } | void>
  // Push to the operator (notification bus).
  notify?(event: { type: 'error'; title: string; body: string; data?: Record<string, unknown> }): void
}

type SweepAdapter = NonNullable<Awaited<ReturnType<VenueExitSweepDeps['getAdapter']>>>

// One error line + push per key per hour: the sweep runs every minute.
const ALERT_EVERY_MS = 60 * 60 * 1000
// A fired stop whose fill stays unreadable this long escalates.
export const FIRED_ESCALATE_MS = 15 * 60 * 1000
const lastAlertAt = new Map<string, number>()
const firedSeenAt = new Map<string, number>()
function alertOnce(
  deps: VenueExitSweepDeps,
  key: string,
  message: string,
  push: { title: string; body: string },
  data: Record<string, unknown>,
): void {
  const now = Date.now()
  if (now - (lastAlertAt.get(key) ?? 0) < ALERT_EVERY_MS) return
  lastAlertAt.set(key, now)
  deps.db.log('error', 'trading', message, data)
  deps.notify?.({ type: 'error', ...push, data })
}

// Tests run sweeps back to back on fresh databases.
export function resetVenueExitSweepAlerts(): void {
  lastAlertAt.clear()
  firedSeenAt.clear()
}

// What the venue says this order filled: the status itself, else its trades.
// Null = the trades could not be read (not ruled out).
async function fillsOf(
  adapter: SweepAdapter,
  orderId: string,
  status: OrderStatus,
  exec: { symbol: string; account_id: string | null },
): Promise<number | null> {
  if (status.filledQuantity != null && status.filledQuantity > 0) return status.filledQuantity
  if (!adapter.getOrderFills) return 0
  try {
    const { filledQuantity } = await adapter.getOrderFills(orderId, {
      symbol: exec.symbol,
      ...(exec.account_id ? { accountId: exec.account_id } : {}),
    })
    return filledQuantity > 0 ? filledQuantity : 0
  } catch {
    return null
  }
}

// Venue verdict on a fired stop with an unreadable fill: fresh positions
// reads after the status read, "dropped" only when two reads agree (see
// confirmedFiredVerdict). Never a cached read: a sibling booked earlier in this
// sweep moved the book.
async function firedVerdictFor(
  deps: VenueExitSweepDeps,
  adapter: SweepAdapter,
  exchange: string,
  cand: { entrySignalId: string; positionId?: string },
  exec: { signal_id: string; symbol: string; account_id: string | null; direction: 'long' | 'short' },
): Promise<'filled' | 'dropped' | 'unresolved'> {
  const book = deps.db as unknown as StopBookDb
  return confirmedFiredVerdict(book, freshVenueNet(adapter, exec.symbol, exec.account_id), {
    exchange,
    symbol: exec.symbol,
    accountId: exec.account_id,
    direction: exec.direction,
    lineageQty: () => {
      if (cand.positionId) {
        return rowLineageQtyFor(book, { position_id: cand.positionId, entry_signal_id: cand.entrySignalId, exchange, symbol: exec.symbol })
      }
      const cur = deps.db.getSignalExecution(exec.signal_id)
      return cur && (cur.status === 'open' || cur.status === 'closing') ? Math.max(0, cur.qty_opened - cur.qty_closed) : 0
    },
  })
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
      const positionIds = new Set<string>()
      for (const state of db.listActiveServerExitStates(exchange)) {
        if (state.entry_signal_id === cand.entrySignalId || state.position_id === cand.positionId) {
          positionIds.add(state.position_id)
        }
      }
      // A still-active server state on a closed execution may be an exit the
      // server never heard about (a failed PANIC report): report it from the
      // booked exit fill, retire only once the server confirmed.
      const lastExit = db
        .getSignalFills?.(cand.entrySignalId)
        ?.filter((f) => f.kind === 'exit')
        .sort((a, b) => b.created_at - a.created_at)[0]
      for (const positionId of positionIds) {
        if (!deps.reportVenueExit || exec.status !== 'closed') {
          db.deactivateServerExitState(positionId)
          continue
        }
        try {
          const res = await deps.reportVenueExit(positionId, {
            price: lastExit?.price ?? null,
            timeMs: lastExit?.created_at ?? Date.now(),
            orderId: lastExit?.order_id ?? null,
          })
          if (res && (res.sent || res.kept)) db.deactivateServerExitState(positionId)
          else {
            db.log('warn', 'trading', 'Venue exit sweep: lingering server state not confirmed by the server', {
              positionId,
              signalId: cand.entrySignalId,
              reason: res ? res.reason : 'reporter gave no status',
            })
          }
        } catch (err: any) {
          db.log('warn', 'trading', 'Venue exit report to server failed', {
            positionId,
            signalId: cand.entrySignalId,
            error: err?.message,
          })
        }
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
    // Fired at the venue, fill not readable yet. Never a cancel on its own:
    // the venue position settles it. Still in the book's venue net = dropped
    // (handled like a cancel below); moved by the lineage = filled (state
    // kept, the fill must be booked); neither = unresolved, escalated.
    let firedDropped = false
    if (status.state === 'unknown' && status.triggered) {
      const verdict = await firedVerdictFor(deps, adapter, exchange, cand, exec)
      const data = { exchange, positionId: cand.positionId ?? null, signalId: exec.signal_id, orderId: cand.orderId, verdict }
      if (verdict === 'dropped') {
        firedSeenAt.delete(cand.orderId)
        firedDropped = true
      } else {
        const now = Date.now()
        const first = firedSeenAt.get(cand.orderId) ?? now
        firedSeenAt.set(cand.orderId, first)
        if (verdict === 'filled') {
          alertOnce(deps, `fired-filled:${cand.orderId}`, 'Venue exit sweep: tracked stop fired and the venue moved by its qty, fill not readable, state kept', {
            title: 'Stop filled, fill not readable',
            body: `${exec.symbol}: stop ${cand.orderId} fired and the venue position moved by the lineage (${openQty}), but the venue does not return the fill. The exit is not booked yet; book it by hand if it stays like this.`,
          }, data)
        } else if (now - first >= FIRED_ESCALATE_MS) {
          alertOnce(deps, `fired-escalated:${cand.orderId}`, 'Venue exit sweep: fired stop still unresolved, manual check needed', {
            title: 'Stop outcome unresolved',
            body: `${exec.symbol}: stop ${cand.orderId} fired over ${Math.round((now - first) / 60000)} min ago. The fill cannot be read and the venue position does not say whether it filled. No new stop goes up for this lineage until it is settled: check the venue.`,
          }, data)
        } else {
          alertOnce(deps, `fired:${cand.orderId}`, 'Venue exit sweep: tracked stop fired at the venue, fill not readable yet, state kept', {
            title: 'Stop fired, fill not readable yet',
            body: `${exec.symbol}: stop ${cand.orderId} fired at the venue; its fill cannot be read yet. The state is kept and polled every minute.`,
          }, data)
        }
        continue
      }
    }
    // A tracked stop the venue cancelled or rejected (Deribit drops a
    // reduce-only trigger on an account netted the other way) no longer
    // protects anything: stop polling it (each poll walks the trigger
    // history) and leave the slot empty, so the next update places a fresh
    // stop. The lineage is unprotected until then. Only once the order's
    // trades confirm it never filled: a cancel verdict next to a fill keeps
    // the state (alert, the operator decides). Every candidate kind ends here
    // with an outcome: server row, bracket-only stop, trail stop, take-profit.
    if (status.state === 'cancelled' || status.state === 'rejected' || firedDropped) {
      const goneState = firedDropped ? 'fired-dropped' : status.state
      const goneData = {
        exchange,
        positionId: cand.positionId ?? null,
        signalId: exec.signal_id,
        orderId: cand.orderId,
        kind: cand.kind,
        state: goneState,
      }
      const filledSeen = firedDropped ? 0 : await fillsOf(adapter, cand.orderId, status, exec)
      if (filledSeen !== 0) {
        alertOnce(deps, `cancel-doubt:${cand.orderId}`, 'Venue exit sweep: tracked stop reported gone but fills are not ruled out, state kept', {
          title: 'Stop gone, fills not ruled out',
          body: `${exec.symbol}: the venue reports ${cand.kind} ${cand.orderId} ${status.state}, but its fills ${filledSeen == null ? 'could not be read' : `show ${filledSeen}`}. The state is kept; check the venue.`,
        }, { ...goneData, filledQuantity: filledSeen })
        continue
      }
      if (cand.kind === 'take-profit') {
        // No slot to free: the bracket keeps it until the lineage closes.
        alertOnce(deps, `tp-gone:${cand.orderId}`, 'Venue exit sweep: tracked take-profit is gone at the venue', {
          title: 'Take-profit gone at the venue',
          body: `${exec.symbol}: take-profit ${cand.orderId} is gone at the venue (${goneState}); that part of the exit no longer rests.`,
        }, goneData)
        continue
      }
      // Every slot that still names this order (a trail and a bracket can
      // share one stop id); each drop only applies while the slot points at it.
      if (cand.positionId) db.dropServerExitStopOrder?.(cand.positionId, cand.orderId)
      db.dropBracketStop?.(cand.entrySignalId, cand.orderId)
      db.dropLocalTrailStop?.(cand.entrySignalId, cand.orderId)
      db.log('error', 'trading', 'Venue exit sweep: tracked stop is gone at the venue, lineage unprotected', goneData)
      deps.notify?.({
        type: 'error',
        title: 'Stop gone at the venue',
        body: `${exec.symbol}: ${cand.kind} ${cand.orderId} is gone at the venue (${goneState}) and the lineage is unprotected until a fresh stop is placed.`,
        data: goneData,
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
    // The status fee covers the order's cumulative fill; this booking is the
    // delta past what the ledger already has.
    const feeShare = cum != null && cum > 0 ? filledQty / cum : 1
    const commission = status.commission != null ? status.commission * feeShare : 0
    const feeNative = status.feeNative != null ? status.feeNative * feeShare : null

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
      commission,
      feeNative,
      feeCurrency: status.feeCurrency ?? null,
      orderId: cand.orderId,
      filledAtMs: status.filledAtMs ?? null,
      reason: `venue ${cand.kind} filled`,
      preferSignalId: exec.signal_id,
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

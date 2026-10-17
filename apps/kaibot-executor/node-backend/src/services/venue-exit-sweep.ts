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

import type { OpenOrder, OrderStatus } from './exchanges/types.js'
import { attributeVenueExit, type ExitAllocation } from './exit-attribution.js'
import { parseTpOrderIds } from '../storage/database.js'
import { accountKeyOf, rowOnAccount } from './exchanges/account-scope.js'
import { findLandedStop, isPendingStop, parsePendingStop, sameRoot } from './pending-stop.js'
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
    account_id?: string | null
    sl_order_id: string | null
    tp_order_id: string | null
    tp_order_ids: string | null
  }>
  listActiveLocalTrails(): Array<{
    signal_id: string
    exchange: string
    symbol: string
    sl_order_id: string | null
    bracket_signal_id?: string | null
    direction?: 'long' | 'short'
    account_id?: string | null
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
  // Heal of a wrongly dropped stop: the entry's recorded stop id, and the
  // re-attach of a still-live order to emptied slots (each only fills an empty slot).
  getEntryStopRow?(signalId: string): { stop_loss_order_id: string | null } | null | undefined
  // Every signal recording this order as its stop or take-profit.
  listSignalIdsByOrderId?(orderId: string): string[]
  rebindBracketStopOrder?(signalId: string, fromId: string | null, toId: string): boolean
  reattachServerExitStopOrder?(positionId: string, orderId: string): boolean
  reattachLocalTrailStop?(signalId: string, orderId: string): boolean
  // Pending placement (marker) resolved: every slot holding `fromId` moves to
  // `toId` (null frees it); the entry records the adopted stop.
  swapStopOrderId?(fromId: string, toId: string | null): number
  setEntryStopOrderId?(signalId: string, orderId: string | null): unknown
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
    getWorkingOrders?: (ctx: { accountId: string; symbol?: string }) => Promise<OpenOrder[]>
    cancelOrder?: (orderId: string, ctx?: { accountId?: string; symbol?: string }) => Promise<void>
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
  // A bracket-only lineage whose stop is confirmed gone: put a fresh stop up
  // at the entry's recorded level and rebind the bracket. The implementation
  // reads the venue fresh and blocks when unsure; it never throws on a block.
  replaceGoneStop?(input: GoneStopInput): Promise<GoneStopOutcome>
}

export interface GoneStopInput {
  exchange: string
  entrySignalId: string
  goneOrderId: string
  symbol: string
  accountId: string | null
  direction: 'long' | 'short'
  lineageQty: number
}

// skipped: the venue is out of scope for automatic re-placement (old behaviour: push only).
export type GoneStopOutcome =
  | { outcome: 'placed'; orderId: string }
  | { outcome: 'blocked'; reason: string }
  | { outcome: 'skipped' }

type SweepAdapter = NonNullable<Awaited<ReturnType<VenueExitSweepDeps['getAdapter']>>>

// One error line + push per key per hour: the sweep runs every minute.
const ALERT_EVERY_MS = 60 * 60 * 1000
// A fired stop whose fill stays unreadable this long escalates.
export const FIRED_ESCALATE_MS = 15 * 60 * 1000
const lastAlertAt = new Map<string, number>()
const firedSeenAt = new Map<string, number>()
// Recorded stop ids the heal settled (terminal, or claimed elsewhere): not
// looked up again. Inconclusive lookups back off (Deribit walks its trigger
// history per lookup).
const healSettled = new Set<string>()
const healBackoff = new Map<string, { nextAt: number; delayMs: number }>()
const HEAL_BACKOFF_MIN_MS = 5 * 60 * 1000
const HEAL_BACKOFF_MAX_MS = 60 * 60 * 1000
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
  healSettled.clear()
  healBackoff.clear()
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
    if (pair.sl_order_id && !isPendingStop(pair.sl_order_id)) {
      byOrder.set(pair.sl_order_id, { orderId: pair.sl_order_id, entrySignalId: pair.signal_id, kind: 'stop' })
    }
    for (const tp of [pair.tp_order_id, ...parseTpOrderIds(pair.tp_order_ids)]) {
      if (tp) byOrder.set(tp, { orderId: tp, entrySignalId: pair.signal_id, kind: 'take-profit' })
    }
  }
  for (const trail of db.listActiveLocalTrails()) {
    if (trail.exchange !== exchange || !trail.sl_order_id || isPendingStop(trail.sl_order_id)) continue
    byOrder.set(trail.sl_order_id, {
      orderId: trail.sl_order_id,
      entrySignalId: trail.signal_id,
      kind: 'trail',
    })
  }
  for (const state of db.listActiveServerExitStates(exchange)) {
    if (!state.sl_order_id || isPendingStop(state.sl_order_id)) continue
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

// A stop that no longer rests (cancelled, rejected, dropped after firing, or
// the rest of a partial cancelled): free its slots and say so. A bracket-only
// lineage gets the guarded re-place for what it still holds.
async function settleGoneStop(
  deps: VenueExitSweepDeps,
  exchange: string,
  cand: RestingExitCandidate,
  exec: { signal_id: string; symbol: string; account_id: string | null; direction: 'long' | 'short' },
  goneState: string,
  goneData: Record<string, unknown>,
  openQty: number,
): Promise<void> {
  const { db } = deps
  // A dead bracket stop next to a server row on another stop of the same
  // entry: the bracket missed a replace (ZEREBRO 16/10 17:31). The server
  // row protects; the bracket follows it, no "unprotected" alarm.
  if (cand.kind === 'stop' && !cand.positionId) {
    const serverStop = db
      .listActiveServerExitStates(exchange)
      .find((st) => st.entry_signal_id === cand.entrySignalId && st.sl_order_id && st.sl_order_id !== cand.orderId)?.sl_order_id
    if (serverStop) {
      db.dropBracketStop?.(cand.entrySignalId, cand.orderId)
      const pair = db.listBracketPairs().find((p) => p.signal_id === cand.entrySignalId)
      // A marker is no order: the pending-placement read rebinds the bracket.
      const rebound =
        !isPendingStop(serverStop) && !!pair && rowOnAccount(pair.account_id, exec.account_id) && !!db.rebindBracketStopOrder?.(cand.entrySignalId, null, serverStop)
      db.log('info', 'trading', 'Venue exit sweep: superseded bracket stop dropped, the server row holds the live stop', {
        ...goneData, serverStop, rebound,
      })
      return
    }
  }
  // Every slot that still names this order (a trail and a bracket can
  // share one stop id); each drop only applies while the slot points at it.
  if (cand.positionId) db.dropServerExitStopOrder?.(cand.positionId, cand.orderId)
  db.dropBracketStop?.(cand.entrySignalId, cand.orderId)
  db.dropLocalTrailStop?.(cand.entrySignalId, cand.orderId)
  db.log('error', 'trading', 'Venue exit sweep: tracked stop is gone at the venue, lineage unprotected', goneData)
  // A bracket-only lineage has no server update or trail tick that would
  // ever put a new stop up: re-place it here, once, behind fresh reads.
  let notReplaced: string | null = null
  if (cand.kind === 'stop' && !cand.positionId && deps.replaceGoneStop && bracketOnly(db, exchange, cand.entrySignalId)) {
    let res: GoneStopOutcome
    try {
      res = await deps.replaceGoneStop({
        exchange,
        entrySignalId: cand.entrySignalId,
        goneOrderId: cand.orderId,
        symbol: exec.symbol,
        accountId: exec.account_id,
        direction: exec.direction,
        lineageQty: openQty,
      })
    } catch (err: any) {
      res = { outcome: 'blocked', reason: err?.message ?? String(err) }
    }
    if (res.outcome === 'placed') {
      db.log('info', 'trading', 'Venue exit sweep: gone bracket stop re-placed', { ...goneData, newOrderId: res.orderId })
      deps.notify?.({
        type: 'error',
        title: 'Stop re-placed',
        body: `${exec.symbol}: stop ${cand.orderId} was gone at the venue (${goneState}); stop ${res.orderId} replaces it at the recorded level.`,
        data: { ...goneData, newOrderId: res.orderId },
      })
      return
    }
    if (res.outcome === 'blocked') {
      notReplaced = res.reason
      db.log('error', 'trading', 'Venue exit sweep: gone bracket stop not re-placed', { ...goneData, reason: res.reason })
    }
  }
  deps.notify?.({
    type: 'error',
    title: 'Stop gone at the venue',
    body:
      `${exec.symbol}: ${cand.kind} ${cand.orderId} is gone at the venue (${goneState}) and the lineage is unprotected until a fresh stop is placed.` +
      (notReplaced ? ` Not re-placed automatically: ${notReplaced}. Check the venue.` : ''),
    data: notReplaced ? { ...goneData, notReplaced } : goneData,
  })
}

// No server exit row and no trail on this entry: only the bracket guards it.
function bracketOnly(db: VenueExitSweepDb, exchange: string, entrySignalId: string): boolean {
  if (db.listActiveServerExitStates(exchange).some((st) => st.entry_signal_id === entrySignalId)) return false
  return !db.listActiveLocalTrails().some((t) => t.exchange === exchange && t.signal_id === entrySignalId)
}

// A parked placement that stays unresolved this long is pushed (1x/u).
export const PENDING_ESCALATE_MS = 10 * 60 * 1000

interface PendingContext {
  symbol: string
  direction: 'long' | 'short'
  accountId: string | null
  // The entry whose stop record follows an adoption; null for a manual trail.
  entryId: string | null
}

/**
 * A thrown stop placement parked its slot on a marker (no client order id on
 * TradeStation, the stop may have landed). Each sweep reads the venue for it:
 *  - lineage open: one matching unclaimed stop is adopted into every slot of
 *    the marker; none frees the slot (the next update places); several keep
 *    it parked. A placeFirst marker restores the kept stop instead and
 *    withdraws a landed newcomer.
 *  - lineage gone: a landed stop is an orphan that can open a position: one
 *    match is cancelled, several are pushed with their ids.
 * Not readable (disconnected, venue error): the marker keeps blocking, and
 * after PENDING_ESCALATE_MS it is pushed. Never silent, never a blind placement.
 */
async function resolvePendingPlacements(
  deps: VenueExitSweepDeps,
  exchange: string,
  adapterFor: (accountId: string | null | undefined) => Promise<SweepAdapter | null>,
): Promise<void> {
  const { db } = deps
  if (!db.swapStopOrderId) return
  const states = db.listActiveServerExitStates(exchange)
  const trails = db.listActiveLocalTrails().filter((t) => t.exchange === exchange)
  const pairs = db.listBracketPairs().filter((p) => p.exchange === exchange)
  const contexts = new Map<string, PendingContext>()
  for (const st of states) {
    if (!isPendingStop(st.sl_order_id) || contexts.has(st.sl_order_id)) continue
    const exec = db.getSignalExecution(st.entry_signal_id)
    contexts.set(st.sl_order_id, { symbol: st.symbol, direction: st.direction, accountId: exec?.account_id ?? null, entryId: st.entry_signal_id })
  }
  for (const t of trails) {
    if (!isPendingStop(t.sl_order_id) || contexts.has(t.sl_order_id) || !t.direction) continue
    // A manual trail ('pos:<exchange>:<account>:<symbol>') has no execution:
    // its own row names the account, symbol and side.
    const entryId = t.bracket_signal_id ?? (db.getSignalExecution(t.signal_id) ? t.signal_id : null)
    contexts.set(t.sl_order_id, { symbol: t.symbol, direction: t.direction, accountId: t.account_id ?? null, entryId })
  }
  for (const p of pairs) {
    if (!isPendingStop(p.sl_order_id) || contexts.has(p.sl_order_id)) continue
    const exec = db.getSignalExecution(p.signal_id)
    if (!exec) continue
    contexts.set(p.sl_order_id, { symbol: exec.symbol, direction: exec.direction, accountId: exec.account_id ?? p.account_id ?? null, entryId: p.signal_id })
  }
  if (contexts.size === 0) return
  const claimed = new Set<string>()
  for (const r of [...states, ...trails, ...pairs]) if (r.sl_order_id) claimed.add(r.sl_order_id)
  for (const p of pairs) for (const tp of [p.tp_order_id, ...parseTpOrderIds(p.tp_order_ids)]) if (tp) claimed.add(tp)

  for (const [marker, ctx] of contexts) {
    const want = parsePendingStop(marker)
    const data: Record<string, unknown> = { exchange, signalId: ctx.entryId, symbol: ctx.symbol, marker }
    if (!want) {
      db.swapStopOrderId(marker, null)
      db.log('warn', 'trading', 'Venue exit sweep: malformed pending stop marker freed', data)
      continue
    }
    const account = want.accountId ?? ctx.accountId
    const stuck = (reason: string) => {
      if (Date.now() - want.atMs < PENDING_ESCALATE_MS) {
        db.log('warn', 'trading', 'Venue exit sweep: pending stop placement not settled yet', { ...data, reason })
        return
      }
      alertOnce(deps, `pending-stuck:${marker}`, 'Venue exit sweep: pending stop placement still unresolved', {
        title: 'Stop placement still unresolved',
        body: `${ctx.symbol}: a stop at ${want.stopPrice} that threw ${Math.round((Date.now() - want.atMs) / 60000)} min ago is still not settled (${reason}). Nothing is placed for it until it is; check the venue.`,
      }, { ...data, reason })
    }
    const adapter = await adapterFor(account)
    if (!adapter) {
      stuck('the connection is not live')
      continue
    }
    // Is the lineage still there? The book when it has one, else the venue.
    let open: boolean
    const exec = ctx.entryId ? db.getSignalExecution(ctx.entryId) : undefined
    if (exec) {
      open = (exec.status === 'open' || exec.status === 'closing') && exec.qty_opened - exec.qty_closed > 0
    } else {
      if (!adapter.getPositions) {
        stuck('positions cannot be read')
        continue
      }
      try {
        const pos = (await adapter.getPositions()).find(
          (p) => sameRoot(p.symbol, ctx.symbol) && Math.abs(p.size) > 0 && (!account || !p.accountId || p.accountId === account),
        )
        open = !!pos && pos.side === ctx.direction
      } catch (err: any) {
        stuck(`positions read failed (${err?.message ?? err})`)
        continue
      }
    }
    const landed = await findLandedStop(adapter, {
      accountId: account,
      symbol: ctx.symbol,
      side: ctx.direction === 'long' ? 'sell' : 'buy',
      stopPrice: want.stopPrice,
      quantity: want.quantity,
      isKnown: (id) => claimed.has(id) || (db.listSignalIdsByOrderId?.(id) ?? []).some((sid) => sid !== ctx.entryId),
    })
    if (landed.kind === 'unreadable') {
      stuck(landed.reason)
      continue
    }
    const withdraw = async (orderId: string): Promise<boolean> => {
      try {
        await adapter.cancelOrder?.(orderId, { symbol: ctx.symbol, ...(account ? { accountId: account } : {}) })
        return !!adapter.cancelOrder
      } catch {
        return false
      }
    }

    if (!open || want.keep) {
      // Gone lineage: a landed stop is an orphan. placeFirst: the kept stop
      // protects, a landed newcomer is the second plain stop. Either way it goes.
      if (landed.kind === 'many') {
        if (!open) db.swapStopOrderId(marker, null)
        alertOnce(deps, `pending-many:${marker}`, 'Venue exit sweep: several stops match a pending placement', {
          title: 'Stop placement unresolved',
          body: `${ctx.symbol}: ${landed.ids.length} stops at ${want.stopPrice} match a placement that threw (${landed.ids.join(', ')}). ${open ? 'Nothing is placed for this lineage until you clear them at the venue.' : 'The lineage is closed: cancel them at the venue.'}`,
        }, { ...data, ids: landed.ids })
        continue
      }
      if (landed.kind === 'one' && !(await withdraw(landed.orderId))) {
        stuck(`stop ${landed.orderId} landed and could not be cancelled`)
        continue
      }
      db.swapStopOrderId(marker, open ? want.keep : null)
      db.log('warn', 'trading', 'Venue exit sweep: pending stop placement settled', {
        ...data, open, restored: open ? want.keep : null, cancelled: landed.kind === 'one' ? landed.orderId : null,
      })
      if (landed.kind === 'one') {
        deps.notify?.({
          type: 'error',
          title: open ? 'Stop placement withdrawn' : 'Orphan stop cancelled',
          body: open
            ? `${ctx.symbol}: the stop that threw did land as ${landed.orderId}; it is cancelled and stop ${want.keep} stays.`
            : `${ctx.symbol}: the stop that threw landed as ${landed.orderId} after the lineage closed; it is cancelled.`,
          data: { ...data, orderId: landed.orderId },
        })
      }
      continue
    }
    if (landed.kind === 'many') {
      alertOnce(deps, `pending-many:${marker}`, 'Venue exit sweep: several stops match a pending placement, slot kept parked', {
        title: 'Stop placement unresolved',
        body: `${ctx.symbol}: ${landed.ids.length} stops at ${want.stopPrice} match a placement that threw (${landed.ids.join(', ')}). Nothing is placed for this lineage until you clear it at the venue.`,
      }, { ...data, ids: landed.ids })
      continue
    }
    if (landed.kind === 'one') {
      db.swapStopOrderId(marker, landed.orderId)
      if (ctx.entryId) {
        db.setEntryStopOrderId?.(ctx.entryId, landed.orderId)
        db.rebindBracketStopOrder?.(ctx.entryId, null, landed.orderId)
      }
      db.log('warn', 'trading', 'Venue exit sweep: pending stop placement found at the venue and adopted', { ...data, orderId: landed.orderId })
      deps.notify?.({
        type: 'error',
        title: 'Stop found and tracked',
        body: `${ctx.symbol}: the stop placement that threw did land as ${landed.orderId} at ${want.stopPrice}; it is tracked now.`,
        data: { ...data, orderId: landed.orderId },
      })
      continue
    }
    db.swapStopOrderId(marker, null)
    db.log('error', 'trading', 'Venue exit sweep: pending stop placement did not land, slot freed', data)
    deps.notify?.({
      type: 'error',
      title: 'Stop placement did not land',
      body: `${ctx.symbol}: the stop at ${want.stopPrice} that threw is not at the venue. The lineage is unprotected until a fresh stop is placed.`,
      data,
    })
  }
}

/**
 * Heal of stops a sweep dropped while they still rested (TradeStation DON
 * read as cancelled, 16/10 21:00): an open lineage with an emptied slot whose
 * entry still records a stop id the venue reports live gets that order back
 * in its empty slots. No order is placed or cancelled. Only an id no other
 * slot or entry on the exchange claims; a terminal one is not looked up
 * again, an inconclusive lookup backs off.
 */
async function healDroppedStops(
  deps: VenueExitSweepDeps,
  exchange: string,
  adapterFor: (accountId: string | null | undefined) => Promise<SweepAdapter | null>,
): Promise<void> {
  const { db } = deps
  if (!db.getEntryStopRow || !db.listSignalIdsByOrderId) return
  const states = db.listActiveServerExitStates(exchange)
  const trails = db.listActiveLocalTrails().filter((t) => t.exchange === exchange)
  const pairs = db.listBracketPairs().filter((p) => p.exchange === exchange)
  // A shell trail (manual attach) guards the entry its bracket names.
  const trailLineage = (t: { signal_id: string; bracket_signal_id?: string | null }) => t.bracket_signal_id ?? t.signal_id
  const entries = new Set<string>()
  for (const st of states) if (!st.sl_order_id) entries.add(st.entry_signal_id)
  for (const t of trails) if (!t.sl_order_id) entries.add(trailLineage(t))
  for (const p of pairs) if (!p.sl_order_id) entries.add(p.signal_id)

  const now = Date.now()
  for (const entryId of entries) {
    const stopId = db.getEntryStopRow(entryId)?.stop_loss_order_id ?? null
    if (!stopId || healSettled.has(stopId) || (healBackoff.get(stopId)?.nextAt ?? 0) > now) continue
    const own = {
      states: states.filter((st) => st.entry_signal_id === entryId),
      trails: trails.filter((t) => trailLineage(t) === entryId),
      pairs: pairs.filter((p) => p.signal_id === entryId),
    }
    if ([...own.states, ...own.trails, ...own.pairs].some((r) => r.sl_order_id === stopId)) continue
    // Claimed elsewhere (another lineage's slot, an adoption that recorded it
    // on its own entry): re-attaching would hand one order to two lineages.
    const elsewhere =
      states.some((st) => st.entry_signal_id !== entryId && st.sl_order_id === stopId) ||
      trails.some((t) => trailLineage(t) !== entryId && t.sl_order_id === stopId) ||
      pairs.some(
        (p) => p.signal_id !== entryId && [p.sl_order_id, p.tp_order_id, ...parseTpOrderIds(p.tp_order_ids)].includes(stopId),
      ) ||
      db.listSignalIdsByOrderId(stopId).some((id) => id !== entryId && !own.trails.some((t) => t.signal_id === id))
    if (elsewhere) {
      if (!healSettled.has(stopId)) {
        db.log('warn', 'trading', 'Venue exit sweep: recorded stop is claimed by another lineage, not re-attached', {
          exchange, signalId: entryId, orderId: stopId,
        })
      }
      healSettled.add(stopId)
      continue
    }
    const exec = db.getSignalExecution(entryId)
    if (!exec || (exec.status !== 'open' && exec.status !== 'closing') || !(exec.qty_opened - exec.qty_closed > 0)) continue
    const adapter = await adapterFor(exec.account_id)
    if (!adapter?.getOrderStatus) continue
    const backOff = () => {
      const delayMs = Math.min(HEAL_BACKOFF_MAX_MS, (healBackoff.get(stopId)?.delayMs ?? HEAL_BACKOFF_MIN_MS / 2) * 2)
      healBackoff.set(stopId, { nextAt: Date.now() + delayMs, delayMs })
    }
    let status: OrderStatus
    try {
      status = await adapter.getOrderStatus(stopId, {
        symbol: exec.symbol,
        ...(exec.account_id ? { accountId: exec.account_id } : {}),
      })
    } catch {
      backOff()
      continue
    }
    if (status.state === 'unknown' && status.absenceConfirmed !== true) {
      backOff()
      continue
    }
    healBackoff.delete(stopId)
    if (status.state !== 'working') {
      healSettled.add(stopId)
      continue
    }
    const healed: string[] = []
    for (const st of own.states) {
      if (!st.sl_order_id && db.reattachServerExitStopOrder?.(st.position_id, stopId)) healed.push(`exit-state ${st.position_id}`)
    }
    for (const t of own.trails) {
      if (!t.sl_order_id && db.reattachLocalTrailStop?.(t.signal_id, stopId)) healed.push('trail')
    }
    for (const p of own.pairs) {
      if (!p.sl_order_id && db.rebindBracketStopOrder?.(entryId, null, stopId)) healed.push('bracket')
    }
    if (healed.length === 0) continue
    const data = { exchange, signalId: entryId, orderId: stopId, queued: status.queued === true, slots: healed }
    db.log('warn', 'trading', 'Venue exit sweep: live stop re-attached to its emptied slots', data)
    deps.notify?.({
      type: 'error',
      title: 'Stop tracked again',
      body: `${exec.symbol}: stop ${stopId} still rests at the venue${status.queued ? ' (queued for the next session)' : ''}; it is tracked again (${healed.join(', ')}). No order was placed or cancelled.`,
      data,
    })
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
  // One adapter per connection (the execution's account names it).
  const adapters = new Map<string, Awaited<ReturnType<VenueExitSweepDeps['getAdapter']>>>()
  const adapterFor = async (accountId: string | null | undefined) => {
    const key = accountKeyOf(accountId) ?? ''
    if (!adapters.has(key)) adapters.set(key, await deps.getAdapter(exchange, accountId))
    return adapters.get(key) ?? null
  }
  // Bookkeeping aids only: a failing heal or pending read never holds up the
  // fill booking.
  try {
    await resolvePendingPlacements(deps, exchange, adapterFor)
  } catch (err: any) {
    db.log('warn', 'trading', 'Venue exit sweep: pending stop placement read failed', { exchange, error: err?.message })
  }
  try {
    await healDroppedStops(deps, exchange, adapterFor)
  } catch (err: any) {
    db.log('warn', 'trading', 'Venue exit sweep: heal of dropped stops failed', { exchange, error: err?.message })
  }
  const candidates = collectRestingExitCandidates(db, exchange)
  if (candidates.length === 0) return 0

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
      await settleGoneStop(deps, exchange, cand, exec, goneState, goneData, openQty)
      continue
    }
    // TradeStation reports a fill on a still-queued order as working: book it
    // like a live partial (per cumulative level), the order keeps resting.
    const queuedPartial = status.state === 'working' && status.queued === true && (status.filledQuantity ?? 0) > 0
    if (status.state !== 'filled' && status.state !== 'partially_filled' && !queuedPartial) continue

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
    const doneBefore = db.targetAlreadyProcessed(exec.signal_id, 'exit', targetLabel)
    const bookedForOrder = db.sumExitFillQtyForOrder(cand.orderId)
    const filledQty = cum != null ? Math.min(cum - bookedForOrder, openQty) : openQty
    if (!doneBefore && filledQty > 0) {
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
    // The rest of a partially filled stop was cancelled at the venue: book the
    // part (above), then the stop is gone for what the lineage still holds.
    // Its slot is freed so the order is not polled forever.
    if (status.state === 'partially_filled' && status.remainderCancelled && cand.kind !== 'take-profit') {
      const cur = db.getSignalExecution(exec.signal_id)
      const rest = cur && (cur.status === 'open' || cur.status === 'closing') ? cur.qty_opened - cur.qty_closed : 0
      if (rest > 0) {
        await settleGoneStop(deps, exchange, cand, exec, 'partially filled, rest cancelled', {
          exchange,
          positionId: cand.positionId ?? null,
          signalId: exec.signal_id,
          orderId: cand.orderId,
          kind: cand.kind,
          state: 'partially filled, rest cancelled',
          filledQuantity: cum,
        }, rest)
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

// Stop floor on a BOT-managed position (server_exit_state, migration 038).
//
// The user pins a stop under a position the bot manages, without taking it
// over: the bot keeps closing/reducing (rungs, TP, close signals) and keeps
// proposing stops, but the venue stop is always the composition
//
//   effective = composeEffectiveStop(manual_stop, engine_stop, trailing_lock)
//
// same rule as the edge trail rows (position-trail.ts). The bot's candidates
// stay favourable-only against the previous ENGINE stop, never against the
// floor; under trailing_lock the bot's moves are recorded but not placed.
//
// One resting stop per position: every amend cancels the old order and places
// the new one through the same path the server exit update already used.

import type { ServerExitStateRow } from '../storage/types.js'
import type { ExchangeAdapter, Position } from './exchanges/types.js'
import { rowOnAccount } from './exchanges/account-scope.js'
import { getContractConstraints } from './exchanges/contract-constraints.js'
import { wireIdOf } from './fanout.js'
import { composeEffectiveStop, stopsDiffer } from './position-trail.js'
import { findLandedStop, isPendingStop, pendingStopMarker } from './pending-stop.js'

export type ServerExitStopState = Pick<
  ServerExitStateRow,
  | 'position_id'
  | 'entry_signal_id'
  | 'exchange'
  | 'symbol'
  | 'direction'
  | 'last_exit_seq'
  | 'current_stop'
  | 'sl_order_id'
> &
  Partial<Pick<ServerExitStateRow, 'manual_stop' | 'trailing_lock' | 'engine_stop'>>

// The bot's own stop. Rows from before migration 038 (or test doubles) carry
// it in current_stop only.
export function serverExitEngineStop(state: ServerExitStopState): number | null {
  return state.engine_stop ?? state.current_stop ?? null
}

// What should rest at the venue for this row right now.
export function serverExitEffectiveStop(
  state: ServerExitStopState,
  engineStop: number | null = serverExitEngineStop(state),
): number | null {
  return composeEffectiveStop({
    direction: state.direction,
    manualStop: state.manual_stop ?? null,
    engineStop,
    trailingLock: !!state.trailing_lock,
  })
}

// A stop protects only on the correct side of the market (EX4).
export function isProtectiveStop(direction: 'long' | 'short', stop: number, mark: number): boolean {
  return direction === 'long' ? stop < mark : stop > mark
}

// Reduce-only protects only while the venue holds the lineage's side. A long
// lineage on an account a synthetic/hedge nets short gets a reduce-only sell
// the venue drops when it triggers (FL ETH 15/10, ETH-SLTS-8046826): there the
// stop has to move the net by the lineage's own qty, like the lineage close.
// A book that does not explain the venue keeps reduce-only (drift: never open
// exposure on a guess). venueNet undefined = not read (entry), the book stands in.
// inert: reduce-only on a venue that holds nothing on the lineage's side can
// never fill (FL ETH 15/10 20:02, ETH-SLTS-8047093); callers must not place it.
export interface ProtectiveStopPlan {
  quantity: number
  reduceOnly: boolean
  inert?: true
}

export function protectiveStopOrder(args: {
  direction: 'long' | 'short'
  lineageQty: number
  bookNet: number
  venueNet?: number
  tolerance: number
}): ProtectiveStopPlan {
  const side = (net: number) => (args.direction === 'long' ? net : -net)
  const covered = (net: number) => side(net) >= args.lineageQty - args.tolerance
  if (args.venueNet === undefined) return { quantity: args.lineageQty, reduceOnly: covered(args.bookNet) }
  if (covered(args.venueNet)) return { quantity: args.lineageQty, reduceOnly: true }
  if (Math.abs(args.bookNet - args.venueNet) <= args.tolerance) return { quantity: args.lineageQty, reduceOnly: false }
  return side(args.venueNet) > args.tolerance
    ? { quantity: args.lineageQty, reduceOnly: true }
    : { quantity: args.lineageQty, reduceOnly: true, inert: true }
}

// DB surface for planning a stop against the whole book.
export interface StopBookDb {
  listOpenExecutionsForExchange?(exchange: string): Array<{
    signal_id: string
    symbol: string
    direction: 'long' | 'short'
    status: string
    qty_opened: number
    qty_closed: number
    account_id: string | null
  }>
  getLiveSyntheticUsdPosition?(
    exchange: string,
    account: string,
    symbol: string,
  ): { status: string; short_size: number } | null | undefined
  getSignalExecution?(signalId: string):
    | { status: string; qty_opened: number; qty_closed: number; account_id: string | null }
    | null
    | undefined
  listOpenExecutionsForPosition?(
    exchange: string,
    symbol: string,
    accountId: string | null,
    wirePositionId: string,
  ): Array<{ signal_id: string; status: string; qty_opened: number; qty_closed: number }>
}

// Whole-book net on (exchange, account, symbol), every lineage, minus the
// armed synthetic's minted short (not an execution, but it explains the venue
// net too). Null when the DB surface cannot list executions.
export function bookNetFor(db: StopBookDb, exchange: string, symbol: string, accountId: string | null | undefined): number | null {
  if (typeof db.listOpenExecutionsForExchange !== 'function') return null
  let bookNet = 0
  for (const e of db.listOpenExecutionsForExchange(exchange)) {
    if (String(e.symbol).toLowerCase() !== symbol.toLowerCase()) continue
    if (accountId && e.account_id && e.account_id !== accountId) continue
    const q = e.status === 'open' || e.status === 'closing' ? Math.max(0, e.qty_opened - e.qty_closed) : 0
    if (q <= 0) continue
    bookNet += e.direction === 'long' ? q : -q
  }
  if (typeof db.getLiveSyntheticUsdPosition === 'function' && accountId) {
    const row = db.getLiveSyntheticUsdPosition(exchange, accountId, symbol)
    if (row && row.status === 'open' && row.short_size > 0) bookNet -= row.short_size
  }
  return bookNet
}

// Open qty of one server row on its account: the exit-state entry plus every
// open execution placed for the same wire positionId (adds).
export function rowLineageQtyFor(
  db: StopBookDb,
  state: { position_id: string; entry_signal_id: string; exchange: string; symbol: string },
): number {
  const entry = typeof db.getSignalExecution === 'function' ? db.getSignalExecution(state.entry_signal_id) : undefined
  const openOf = (e: { status: string; qty_opened: number; qty_closed: number } | null | undefined) =>
    e && (e.status === 'open' || e.status === 'closing') ? Math.max(0, e.qty_opened - e.qty_closed) : 0
  let qty = openOf(entry)
  if (typeof db.listOpenExecutionsForPosition === 'function') {
    for (const e of db.listOpenExecutionsForPosition(state.exchange, state.symbol, entry?.account_id ?? null, wireIdOf(state.position_id))) {
      if (e.signal_id !== state.entry_signal_id) qty += openOf(e)
    }
  }
  return qty
}

// Stop plan for one lineage from the venue (when read) and the whole book.
// Null when the book cannot be read or the lineage holds nothing.
export function planProtectiveStop(
  db: StopBookDb,
  args: {
    exchange: string
    symbol: string
    accountId: string | null | undefined
    direction: 'long' | 'short'
    lineageQty: number
    venue?: Pick<Position, 'side' | 'size'>
  },
): ProtectiveStopPlan | null {
  const bookNet = bookNetFor(db, args.exchange, args.symbol, args.accountId)
  if (bookNet == null || !(args.lineageQty > 0)) return null
  const { stepSize } = getContractConstraints(args.exchange, args.symbol)
  return protectiveStopOrder({
    direction: args.direction,
    lineageQty: args.lineageQty,
    bookNet,
    venueNet: args.venue ? (args.venue.side === 'long' ? Math.abs(args.venue.size) : -Math.abs(args.venue.size)) : undefined,
    tolerance: Math.max(stepSize > 0 ? stepSize / 2 : 0, 1e-9),
  })
}

export interface ServerExitStopDb extends StopBookDb {
  getSignalBracket(signalId: string):
    | { stop_loss_order_id: string | null; take_profit_order_id: string | null }
    | undefined
  getBracketPair?(signalId: string): { sl_order_id: string | null; account_id?: string | null } | undefined
  applyServerExitUpdate(
    positionId: string,
    patch: { exitSeq: number; currentStop?: number | null; slOrderId?: string | null; engineStop?: number | null },
  ): unknown
  updateSignalOrderIds(signalId: string, slOrderId?: string, tpOrderId?: string): unknown
  listSignalIdsByOrderId?(orderId: string): string[]
  // Moves the bracket's stop leg only while it still names fromId.
  rebindBracketStopOrder?(signalId: string, fromId: string | null, toId: string): boolean
  updateLocalTrail?(signalId: string, patch: { slOrderId?: string | null; currentStop?: number | null }): unknown
  log(level: 'debug' | 'info' | 'warn' | 'error', category: string, message: string, metadata?: any): unknown
}

export type ServerExitStopAdapter = Pick<ExchangeAdapter, 'placeOrder' | 'cancelOrder'> &
  Partial<Pick<ExchangeAdapter, 'getOrderStatus' | 'getPositions' | 'getWorkingOrders'>>

// Venues that do not honour reduce-only: a second stop there is a second exit.
export function venueHasNoReduceOnly(exchange: string | null | undefined): boolean {
  return exchange === 'tradestation'
}

// Cancel errors that mean the order no longer rests at the venue.
export function isOrderGoneError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '')
  return /not[_ ]?found|not_open_order|does not exist|not exists|unknown order|too late to cancel|already (closed|cancel|filled)/i.test(msg)
}

export type OldStopRetirement =
  | { outcome: 'cancelled' | 'gone' }
  | { outcome: 'filled' | 'failed' | 'unresolved'; reason: string }

// A stop that fired at the venue but whose fill cannot be read: did it fill?
// A filled stop moved the venue by its qty; a dropped one left the venue where
// the book (this lineage still in it) says.
export type FiredStopVerdict = 'filled' | 'dropped' | 'unresolved'

export function venueNetOf(pos: Pick<Position, 'side' | 'size'> | null | undefined): number {
  if (!pos) return 0
  return pos.side === 'long' ? Math.abs(pos.size) : -Math.abs(pos.size)
}

export function firedStopVerdict(
  db: StopBookDb,
  args: {
    exchange: string
    symbol: string
    accountId: string | null | undefined
    direction: 'long' | 'short'
    lineageQty: number
    venueNet: number
  },
): FiredStopVerdict {
  const bookNet = bookNetFor(db, args.exchange, args.symbol, args.accountId)
  if (bookNet == null || !(args.lineageQty > 0)) return 'unresolved'
  const { stepSize } = getContractConstraints(args.exchange, args.symbol)
  const tol = Math.max(stepSize > 0 ? stepSize / 2 : 0, 1e-9)
  const lineageSigned = args.direction === 'long' ? args.lineageQty : -args.lineageQty
  const stillIn = Math.abs(bookNet - args.venueNet) <= tol
  const out = Math.abs(bookNet - lineageSigned - args.venueNet) <= tol
  if (stillIn && !out) return 'dropped'
  if (out && !stillIn) return 'filled'
  return 'unresolved'
}

// Pause between the two venue reads that must both say "dropped".
export const firedConfirm = { pauseMs: 1500 }

// Net position on (symbol, account) from a fresh positions read.
export function venueNetFrom(positions: Position[], symbol: string, accountId: string | null | undefined): number {
  const pos = positions.find(
    (p) =>
      p.symbol.toLowerCase() === symbol.toLowerCase() &&
      Math.abs(p.size) > 0 &&
      (!accountId || !p.accountId || p.accountId === accountId),
  )
  return venueNetOf(pos)
}

// Verdict on a fired stop from FRESH venue reads taken after its status read,
// never a snapshot from before. "dropped" frees the slot for a new stop, so it
// must hold on two reads a pause apart (a fill can land between status and
// read); anything else on the second read is unresolved. No read = unresolved.
export async function confirmedFiredVerdict(
  db: StopBookDb,
  readVenueNet: () => Promise<number | null>,
  args: { exchange: string; symbol: string; accountId: string | null | undefined; direction: 'long' | 'short'; lineageQty: () => number },
): Promise<FiredStopVerdict> {
  const verdictOnce = async (): Promise<FiredStopVerdict> => {
    let venueNet: number | null
    try {
      venueNet = await readVenueNet()
    } catch {
      return 'unresolved'
    }
    if (venueNet == null) return 'unresolved'
    return firedStopVerdict(db, { ...args, lineageQty: args.lineageQty(), venueNet })
  }
  const first = await verdictOnce()
  if (first !== 'dropped') return first
  if (firedConfirm.pauseMs > 0) await new Promise((r) => setTimeout(r, firedConfirm.pauseMs))
  return (await verdictOnce()) === 'dropped' ? 'dropped' : 'unresolved'
}

// Fresh positions reader for confirmedFiredVerdict; null without getPositions.
export function freshVenueNet(
  adapter: { getPositions?: () => Promise<Position[]> },
  symbol: string,
  accountId: string | null | undefined,
): () => Promise<number | null> {
  return async () => (typeof adapter.getPositions === 'function' ? venueNetFrom(await adapter.getPositions(), symbol, accountId) : null)
}

// Retire the stop a fresh one replaces. Gone at the venue counts as retired (a
// stop that fired and was dropped must not block updates forever), unless it
// FILLED: the lineage it guarded is out, and a plain replacement would sell it
// a second time. An unreadable status after "gone" stays failed: the caller
// keeps the old stop and retries on the next update. Fired but unreadable:
// the venue position decides (resolveFired); without it, unresolved. Not
// found at cancel with an inconclusive status: unresolved, never gone.
export async function retireOldStop(
  adapter: ServerExitStopAdapter,
  orderId: string,
  symbol: string,
  resolveFired?: () => FiredStopVerdict | Promise<FiredStopVerdict>,
  // The lineage's account: TradeStation cannot look an order up without it.
  accountId?: string | null,
  // Venues without reduce-only (TradeStation): a cancel error that is not
  // "gone" may still have gone through, and an acked cancel may race a fill.
  // Read the order again before anyone decides on a replacement.
  opts: { verify?: boolean } = {},
): Promise<OldStopRetirement> {
  const ctx = { symbol, ...(accountId ? { accountId } : {}) }
  try {
    await adapter.cancelOrder(orderId, { symbol })
  } catch (err: any) {
    const reason = String(err?.message ?? err)
    if (!isOrderGoneError(err)) {
      if (!opts.verify || typeof adapter.getOrderStatus !== 'function') return { outcome: 'failed', reason }
      try {
        const st = await adapter.getOrderStatus(orderId, ctx)
        if (st.state === 'cancelled' || st.state === 'rejected') return { outcome: 'cancelled' }
        if (st.state === 'filled' || st.state === 'partially_filled') {
          return { outcome: 'filled', reason: `old stop ${orderId} filled (cancel answered: ${reason})` }
        }
        if (st.state === 'working') return { outcome: 'failed', reason: `${reason}; old stop ${orderId} still ${st.queued ? 'queued' : 'working'}` }
        return { outcome: 'unresolved', reason: `${reason}; old stop ${orderId} status ${st.state}` }
      } catch (statusErr: any) {
        return { outcome: 'unresolved', reason: `${reason}; status unreadable: ${statusErr?.message ?? statusErr}` }
      }
    }
    if (typeof adapter.getOrderStatus !== 'function') return { outcome: 'gone' }
    try {
      const st = await adapter.getOrderStatus(orderId, { symbol, ...(accountId ? { accountId } : {}) })
      if (st.state === 'filled' || st.state === 'partially_filled') {
        return { outcome: 'filled', reason: `old stop ${orderId} already filled` }
      }
      if (st.state === 'unknown' && st.triggered) {
        const verdict = resolveFired ? await resolveFired() : 'unresolved'
        if (verdict === 'dropped') return { outcome: 'gone' }
        if (verdict === 'filled') {
          return { outcome: 'filled', reason: `old stop ${orderId} fired and the venue moved by its qty` }
        }
        return { outcome: 'unresolved', reason: `old stop ${orderId} fired, fill unreadable and the venue position does not settle it` }
      }
      // Gone only on the venue's word. An inconclusive lookup (rate limit,
      // timeout in the fired-trigger walk) may hide a fill: no replacement.
      if (st.state === 'unknown' && st.absenceConfirmed !== true) {
        return { outcome: 'unresolved', reason: `old stop ${orderId} not found at cancel and its status lookup was inconclusive` }
      }
      // The cancel was refused but the order still lives (TS OPN/ACK/FPR after
      // "too late to cancel"): a replacement would be a second exit.
      if (st.state !== 'cancelled' && st.state !== 'rejected' && st.state !== 'unknown') {
        return { outcome: 'unresolved', reason: `old stop ${orderId} refused the cancel (${reason}) and still reports ${st.state}` }
      }
      return { outcome: 'gone' }
    } catch (statusErr: any) {
      return { outcome: 'unresolved', reason: `${reason}; status unreadable: ${statusErr?.message ?? statusErr}` }
    }
  }
  // Cancel acked. A fill that beat the cancel shows here: then the lineage is
  // out and a replacement would open the other side.
  if (opts.verify && typeof adapter.getOrderStatus === 'function') {
    try {
      const st = await adapter.getOrderStatus(orderId, ctx)
      if (st.state === 'filled' || st.state === 'partially_filled') {
        return { outcome: 'filled', reason: `old stop ${orderId} filled before the cancel took` }
      }
    } catch {
      /* the cancel was acked; an unreadable status adds nothing */
    }
  }
  return { outcome: 'cancelled' }
}

// Pull a just-placed stop back. Returns its id when it could not be withdrawn
// (it then rests untracked and the operator must remove it).
export async function withdrawStop(adapter: ServerExitStopAdapter, orderId: string, symbol: string): Promise<string | null> {
  try {
    await adapter.cancelOrder(orderId, { symbol })
    return null
  } catch {
    return orderId
  }
}

export interface ReplaceServerExitStopInput {
  db: ServerExitStopDb
  adapter: ServerExitStopAdapter
  state: ServerExitStopState
  live: Position
  // Account holding the lineage (the entry's execution), when known.
  lineageAccount: string | null
  stopPrice: number
  exitSeq: number
  // Omitted = the bot's stop is unchanged (a floor-only amend).
  engineStop?: number | null
  label: string
  // Stop size when it is not the venue position (one tranche of several).
  quantity?: number
  // false only via protectiveStopOrder (opposing book); then quantity is required.
  reduceOnly?: boolean
  // false when `live` is not a venue read: no venue-based verdicts.
  venueRead?: boolean
  // New stop first, old one cancelled after: the position is never bare. When
  // the old cancel fails the new stop is withdrawn and the state keeps the old.
  placeFirst?: boolean
  // For the log lines.
  context?: Record<string, unknown>
}

// Cancel the resting stop, place the new one, and re-point every record that
// knows the order id (exit state, entry bracket, a local trail on the same
// entry). Throws after the bookkeeping when the placement fails: the old
// order is already gone, the stale id is dropped everywhere, the seq is left
// where it was so the caller (or the server's retry) can re-place.
// placeFirst: the old stop would not cancel, so it stays the tracked stop.
// orphanId: the new stop could not be withdrawn either and rests untracked.
export class OldStopKeptError extends Error {
  constructor(
    readonly slOrderId: string,
    reason: string,
    readonly orphanId: string | null = null,
    readonly outcome?: 'filled' | 'failed' | 'unresolved',
  ) {
    super(
      `old stop ${slOrderId} could not be cancelled: ${reason}` +
        (orphanId ? `; new stop ${orphanId} could not be withdrawn and rests untracked` : ''),
    )
  }
}

// The old stop filled (or fired): the lineage it guarded is out, so no
// replacement goes up. Nothing was placed or cancelled, the state is untouched
// (the venue-exit sweep books the fill).
export class OldStopFilledError extends Error {
  constructor(readonly slOrderId: string, reason: string, readonly outcome: 'filled' | 'unresolved' = 'filled') {
    super(`no new stop: ${reason}`)
  }
}

// A thrown placement may have landed (no client order id on TradeStation): the
// slot holds a marker and nothing is placed until the sweep re-reads the venue.
export class StopPlacementPendingError extends Error {
  readonly outcome = 'unresolved' as const
  constructor(readonly marker: string, reason?: string) {
    super(
      reason
        ? `stop placement outcome unknown (${reason}); it may still appear at the venue, check it. Nothing is placed until the next venue read`
        : 'an earlier stop placement is still unresolved; nothing is placed until the venue is read again',
    )
  }
}

// A reduce-only stop that can never fill (the venue holds nothing on the
// lineage's side and the book does not explain why). Nothing placed or cancelled.
export class InertStopError extends Error {
  constructor(readonly positionId: string, readonly venueNet: number | null) {
    super(
      `no stop placed: the venue holds nothing on the lineage's side${venueNet != null ? ` (venue net ${venueNet})` : ''} and the book does not explain it; a reduce-only stop could never fill`,
    )
  }
}

export async function replaceServerExitStop(input: ReplaceServerExitStopInput): Promise<{ orderId: string }> {
  const { db, adapter, state, live } = input
  const ctx = input.context ?? {}

  // An earlier placement threw and may have landed: nothing goes up until the
  // venue-exit sweep has read the venue again.
  if (isPendingStop(state.sl_order_id)) throw new StopPlacementPendingError(state.sl_order_id)

  // No explicit plan from the caller: plan against the whole book, so every
  // path (stop floor, accumulate fits, …) gets the same opposed/inert rule as
  // the server trail update.
  if (input.reduceOnly === undefined && input.venueRead !== false) {
    const plan = planProtectiveStop(db, {
      exchange: state.exchange,
      symbol: state.symbol,
      accountId: input.lineageAccount ?? (live.accountId as string | undefined),
      direction: state.direction,
      lineageQty: rowLineageQtyFor(db, state),
      venue: live,
    })
    if (plan?.inert) {
      db.log('error', 'trading', 'Exit stop amend: reduce-only stop could never fill, nothing placed', {
        ...ctx, positionId: state.position_id, venueSide: live.side, venueSize: live.size,
      })
      throw new InertStopError(state.position_id, live.side === 'long' ? Math.abs(live.size) : -Math.abs(live.size))
    }
    if (plan && !plan.reduceOnly) {
      return replaceServerExitStop({ ...input, quantity: plan.quantity, reduceOnly: false, placeFirst: true })
    }
  }

  // Never cancel an order whose bracket row sits on ANOTHER account
  // (2026-09-22: an adoption had taken over the default connection's stop; the
  // update then cancelled it through the acct1 session). The row stays
  // untouched, the new stop still goes up so this account's position is
  // protected, and the error names the stray order for the operator.
  const bracket = db.getSignalBracket(state.entry_signal_id)
  const pair = typeof db.getBracketPair === 'function' ? db.getBracketPair(state.entry_signal_id) : undefined
  const oldStopId = state.sl_order_id ?? bracket?.stop_loss_order_id ?? null
  const stopAccount = input.lineageAccount ?? (live.accountId as string | undefined) ?? null
  // Only on connections whose positions we read (accumulate passes its own
  // tranche as `live`): a fresh read, never `live` itself.
  const resolveFired =
    input.venueRead === false
      ? undefined
      : () => {
          const accountId = input.lineageAccount ?? (live.accountId as string | undefined)
          return confirmedFiredVerdict(db, freshVenueNet(adapter, state.symbol, accountId), {
            exchange: state.exchange,
            symbol: state.symbol,
            accountId,
            direction: state.direction,
            lineageQty: () => rowLineageQtyFor(db, state),
          })
        }
  const oldStopOnThisAccount =
    !oldStopId ||
    !pair ||
    pair.sl_order_id !== oldStopId ||
    rowOnAccount(pair.account_id, input.lineageAccount ?? (live.accountId as string | undefined))
  if (oldStopId && !oldStopOnThisAccount) {
    db.log('error', 'trading', 'Exit stop amend: old stop belongs to another account, NOT cancelled', {
      ...ctx,
      positionId: state.position_id,
      slOrderId: oldStopId,
      bracketAccountId: pair?.account_id ?? null,
      lineageAccountId: input.lineageAccount,
    })
  }
  const tpId = bracket?.take_profit_order_id ?? undefined
  const reduceOnly = !(input.reduceOnly === false && input.quantity != null && input.quantity > 0)
  // TradeStation forwards no reduce-only: every stop there is plain.
  const plainAtVenue = !reduceOnly || venueHasNoReduceOnly(state.exchange)
  // The bracket follows the new stop only once the old one is confirmed off.
  let oldRetired = !oldStopId
  if (oldStopId && oldStopOnThisAccount && !input.placeFirst) {
    const old = await retireOldStop(adapter, oldStopId, state.symbol, resolveFired, stopAccount, { verify: venueHasNoReduceOnly(state.exchange) })
    if (old.outcome === 'filled' || old.outcome === 'unresolved') {
      // FL ETH 15/10 20:02: ETH-SLTS-8047026 had filled the lineage; the
      // update still put a fresh stop up for it.
      db.log('error', 'trading', `Exit stop amend: old stop ${old.outcome}, no new stop for this lineage`, {
        ...ctx, positionId: state.position_id, slOrderId: oldStopId, error: old.reason,
      })
      throw new OldStopFilledError(oldStopId, old.reason, old.outcome)
    }
    if (old.outcome === 'failed') {
      // A plain stop next to one that would not cancel (TradeStation 504):
      // two plain stops, both fire. Nothing placed, the old one stays tracked.
      if (plainAtVenue) {
        db.log('error', 'trading', 'Exit stop amend: cancel old stop failed, plain replacement not placed', {
          ...ctx, positionId: state.position_id, slOrderId: oldStopId, error: old.reason,
        })
        throw new OldStopKeptError(oldStopId, old.reason, null, 'failed')
      }
      db.log('warn', 'trading', 'Exit stop amend: cancel old stop failed', {
        ...ctx, slOrderId: oldStopId, error: old.reason,
      })
    } else {
      oldRetired = true
    }
  }
  // A plain stop next to an old one this session may not retire would leave
  // two plain stops resting: nothing is placed, the old one stays tracked.
  if (!reduceOnly && oldStopId && !oldStopOnThisAccount) {
    throw new OldStopKeptError(oldStopId, 'it rests on another account; plain replacement not placed')
  }
  const side: 'buy' | 'sell' = state.direction === 'long' ? 'sell' : 'buy'
  const quantity = input.quantity != null && input.quantity > 0 ? input.quantity : Math.abs(live.size)
  try {
    let placed: { orderId: string }
    try {
      placed = await adapter.placeOrder({
        accountId: live.accountId ?? 'default',
        symbol: state.symbol,
        side,
        orderType: 'stop',
        quantity,
        stopPrice: input.stopPrice,
        reduceOnly,
        label: input.label,
      })
    } catch (placeErr: any) {
      // TradeStation takes no client order id: a throw may hide a stop that
      // landed. One matching stop is adopted; anything else parks the slot.
      if (!venueHasNoReduceOnly(state.exchange)) throw placeErr
      const placeAccount = (live.accountId as string | undefined) ?? stopAccount
      const landed = await findLandedStop(adapter, {
        accountId: placeAccount,
        symbol: state.symbol,
        side,
        stopPrice: input.stopPrice,
        quantity,
        isKnown: (id) => id === oldStopId || (db.listSignalIdsByOrderId?.(id) ?? []).length > 0,
      })
      if (landed.kind !== 'one') {
        // placeFirst: the old stop still rests and stays the protection. The
        // marker keeps it; the venue read restores it and withdraws a newcomer.
        const keep = input.placeFirst && oldStopId && oldStopOnThisAccount ? oldStopId : null
        const marker = pendingStopMarker(input.stopPrice, quantity, { accountId: placeAccount, keep })
        db.applyServerExitUpdate(state.position_id, {
          exitSeq: state.last_exit_seq,
          currentStop: keep ? state.current_stop : input.stopPrice,
          slOrderId: marker,
          ...(input.engineStop !== undefined && !keep ? { engineStop: input.engineStop } : {}),
        })
        if (!keep) db.updateSignalOrderIds(state.entry_signal_id, undefined, tpId)
        if (typeof db.updateLocalTrail === 'function') db.updateLocalTrail(state.entry_signal_id, { slOrderId: marker })
        const detail = landed.kind === 'many' ? `${landed.ids.length} matching stops (${landed.ids.join(', ')})` : landed.kind === 'none' ? 'no matching stop yet' : landed.reason
        db.log('error', 'trading', 'Exit stop amend: placement threw, outcome unknown, no new stop until the venue is read again', {
          ...ctx, positionId: state.position_id, marker, error: placeErr?.message, venue: detail,
        })
        throw new StopPlacementPendingError(marker, `${placeErr?.message ?? placeErr}; ${detail}`)
      }
      db.log('warn', 'trading', 'Exit stop amend: placement threw, the stop found at the venue is adopted', {
        ...ctx, positionId: state.position_id, orderId: landed.orderId, error: placeErr?.message,
      })
      placed = { orderId: landed.orderId }
    }
    if (input.placeFirst && oldStopId && oldStopOnThisAccount) {
      const old = await retireOldStop(adapter, oldStopId, state.symbol, resolveFired, stopAccount, { verify: venueHasNoReduceOnly(state.exchange) })
      if (old.outcome === 'filled' || old.outcome === 'failed' || old.outcome === 'unresolved') {
        const orphanId = await withdrawStop(adapter, placed.orderId, state.symbol)
        db.log('error', 'trading', 'Exit stop amend: old stop not retired, kept it and withdrew the new one', {
          ...ctx, positionId: state.position_id, slOrderId: oldStopId, orphanId, outcome: old.outcome, error: old.reason,
        })
        throw new OldStopKeptError(oldStopId, old.reason, orphanId, old.outcome)
      }
      oldRetired = true
    }
    db.applyServerExitUpdate(state.position_id, {
      exitSeq: input.exitSeq,
      currentStop: input.stopPrice,
      slOrderId: placed.orderId,
      ...(input.engineStop !== undefined ? { engineStop: input.engineStop } : {}),
    })
    // Re-point the persisted entry bracket at the live stop so a TP fill /
    // close cancels the real order, not the one we just cancelled, and the
    // venue-exit sweep does not poll the cancelled id (ZEREBRO 16/10 17:31).
    db.updateSignalOrderIds(state.entry_signal_id, placed.orderId, tpId)
    if (oldStopId && oldStopOnThisAccount && oldRetired && oldStopId !== placed.orderId) {
      db.rebindBracketStopOrder?.(state.entry_signal_id, oldStopId, placed.orderId)
    }
    // An emptied bracket slot of this entry takes the new stop too, so the
    // last TP's OCO cancels it.
    if (pair && pair.sl_order_id == null && rowOnAccount(pair.account_id, stopAccount)) {
      db.rebindBracketStopOrder?.(state.entry_signal_id, null, placed.orderId)
    }
    // A local trail on the same entry amends the same resting stop: hand it
    // the fresh id and level.
    if (typeof db.updateLocalTrail === 'function') {
      db.updateLocalTrail(state.entry_signal_id, { slOrderId: placed.orderId, currentStop: input.stopPrice })
    }
    return { orderId: placed.orderId }
  } catch (err: any) {
    if (err instanceof StopPlacementPendingError) throw err
    if (input.placeFirst) {
      if (err instanceof OldStopKeptError) throw err
      db.log('error', 'trading', 'Exit stop amend: place new stop failed, the old stop stays', {
        ...ctx, positionId: state.position_id, slOrderId: oldStopId, error: err?.message,
      })
      throw err
    }
    db.log('error', 'trading', 'Exit stop amend: place new stop failed, position is UNPROTECTED until retried', {
      ...ctx, positionId: state.position_id, error: err?.message,
    })
    db.applyServerExitUpdate(state.position_id, {
      exitSeq: state.last_exit_seq,
      currentStop: state.current_stop,
      slOrderId: null,
    })
    db.updateSignalOrderIds(state.entry_signal_id, undefined, tpId)
    throw err
  }
}

// Whether the venue stop has to move for a new effective level. A missing
// resting order always needs a placement.
export function serverExitStopNeedsMove(state: ServerExitStopState, effective: number | null): boolean {
  if (effective == null) return false
  if (state.sl_order_id == null) return true
  return stopsDiffer(effective, state.current_stop)
}

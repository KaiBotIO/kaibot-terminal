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
import { composeEffectiveStop, stopsDiffer } from './position-trail.js'

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
export function protectiveStopOrder(args: {
  direction: 'long' | 'short'
  lineageQty: number
  bookNet: number
  venueNet?: number
  tolerance: number
}): { quantity: number; reduceOnly: boolean } {
  const covered = (net: number) => (args.direction === 'long' ? net : -net) >= args.lineageQty - args.tolerance
  if (args.venueNet === undefined) return { quantity: args.lineageQty, reduceOnly: covered(args.bookNet) }
  if (covered(args.venueNet)) return { quantity: args.lineageQty, reduceOnly: true }
  return { quantity: args.lineageQty, reduceOnly: Math.abs(args.bookNet - args.venueNet) > args.tolerance }
}

export interface ServerExitStopDb {
  getSignalBracket(signalId: string):
    | { stop_loss_order_id: string | null; take_profit_order_id: string | null }
    | undefined
  getBracketPair?(signalId: string): { sl_order_id: string | null; account_id?: string | null } | undefined
  applyServerExitUpdate(
    positionId: string,
    patch: { exitSeq: number; currentStop?: number | null; slOrderId?: string | null; engineStop?: number | null },
  ): unknown
  updateSignalOrderIds(signalId: string, slOrderId?: string, tpOrderId?: string): unknown
  updateLocalTrail?(signalId: string, patch: { slOrderId?: string | null; currentStop?: number | null }): unknown
  log(level: 'debug' | 'info' | 'warn' | 'error', category: string, message: string, metadata?: any): unknown
}

export type ServerExitStopAdapter = Pick<ExchangeAdapter, 'placeOrder' | 'cancelOrder'> &
  Partial<Pick<ExchangeAdapter, 'getOrderStatus'>>

// Cancel errors that mean the order no longer rests at the venue.
export function isOrderGoneError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '')
  return /not[_ ]?found|not_open_order|does not exist|not exists|unknown order|too late to cancel|already (closed|cancel|filled)/i.test(msg)
}

export type OldStopRetirement =
  | { outcome: 'cancelled' | 'gone' }
  | { outcome: 'filled' | 'failed'; reason: string }

// Retire the stop a fresh one replaces. Gone at the venue counts as retired (a
// stop that fired and was dropped must not block updates forever), unless it
// FILLED: the lineage it guarded is out, and a plain replacement would sell it
// a second time. An unreadable status after "gone" stays failed: the caller
// keeps the old stop and retries on the next update.
export async function retireOldStop(
  adapter: ServerExitStopAdapter,
  orderId: string,
  symbol: string,
): Promise<OldStopRetirement> {
  try {
    await adapter.cancelOrder(orderId, { symbol })
    return { outcome: 'cancelled' }
  } catch (err: any) {
    const reason = String(err?.message ?? err)
    if (!isOrderGoneError(err)) return { outcome: 'failed', reason }
    if (typeof adapter.getOrderStatus !== 'function') return { outcome: 'gone' }
    try {
      const st = await adapter.getOrderStatus(orderId, { symbol })
      if (st.state === 'filled' || st.state === 'partially_filled') {
        return { outcome: 'filled', reason: `old stop ${orderId} already filled` }
      }
      return { outcome: 'gone' }
    } catch (statusErr: any) {
      return { outcome: 'failed', reason: `${reason}; status unreadable: ${statusErr?.message ?? statusErr}` }
    }
  }
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
  constructor(readonly slOrderId: string, reason: string, readonly orphanId: string | null = null) {
    super(
      `old stop ${slOrderId} could not be cancelled: ${reason}` +
        (orphanId ? `; new stop ${orphanId} could not be withdrawn and rests untracked` : ''),
    )
  }
}

export async function replaceServerExitStop(input: ReplaceServerExitStopInput): Promise<{ orderId: string }> {
  const { db, adapter, state, live } = input
  const ctx = input.context ?? {}

  // Never cancel an order whose bracket row sits on ANOTHER account
  // (2026-09-22: an adoption had taken over the default connection's stop; the
  // update then cancelled it through the acct1 session). The row stays
  // untouched, the new stop still goes up so this account's position is
  // protected, and the error names the stray order for the operator.
  const bracket = db.getSignalBracket(state.entry_signal_id)
  const pair = typeof db.getBracketPair === 'function' ? db.getBracketPair(state.entry_signal_id) : undefined
  const oldStopId = state.sl_order_id ?? bracket?.stop_loss_order_id ?? null
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
  } else if (oldStopId && !input.placeFirst) {
    try {
      await adapter.cancelOrder(oldStopId, { symbol: state.symbol })
    } catch (err: any) {
      db.log('warn', 'trading', 'Exit stop amend: cancel old stop failed', {
        ...ctx, slOrderId: oldStopId, error: err?.message,
      })
    }
  }

  const tpId = bracket?.take_profit_order_id ?? undefined
  const reduceOnly = !(input.reduceOnly === false && input.quantity != null && input.quantity > 0)
  // A plain stop next to an old one this session may not retire would leave
  // two plain stops resting: nothing is placed, the old one stays tracked.
  if (!reduceOnly && oldStopId && !oldStopOnThisAccount) {
    throw new OldStopKeptError(oldStopId, 'it rests on another account; plain replacement not placed')
  }
  try {
    const placed = await adapter.placeOrder({
      accountId: live.accountId ?? 'default',
      symbol: state.symbol,
      side: state.direction === 'long' ? 'sell' : 'buy',
      orderType: 'stop',
      quantity: input.quantity != null && input.quantity > 0 ? input.quantity : Math.abs(live.size),
      stopPrice: input.stopPrice,
      reduceOnly,
      label: input.label,
    })
    if (input.placeFirst && oldStopId && oldStopOnThisAccount) {
      const old = await retireOldStop(adapter, oldStopId, state.symbol)
      if (old.outcome === 'filled' || old.outcome === 'failed') {
        const orphanId = await withdrawStop(adapter, placed.orderId, state.symbol)
        db.log('error', 'trading', 'Exit stop amend: old stop not retired, kept it and withdrew the new one', {
          ...ctx, positionId: state.position_id, slOrderId: oldStopId, orphanId, outcome: old.outcome, error: old.reason,
        })
        throw new OldStopKeptError(oldStopId, old.reason, orphanId)
      }
    }
    db.applyServerExitUpdate(state.position_id, {
      exitSeq: input.exitSeq,
      currentStop: input.stopPrice,
      slOrderId: placed.orderId,
      ...(input.engineStop !== undefined ? { engineStop: input.engineStop } : {}),
    })
    // Re-point the persisted entry bracket at the live stop so a TP fill /
    // close cancels the real order, not the one we just cancelled.
    db.updateSignalOrderIds(state.entry_signal_id, placed.orderId, tpId)
    // A local trail on the same entry amends the same resting stop: hand it
    // the fresh id and level.
    if (typeof db.updateLocalTrail === 'function') {
      db.updateLocalTrail(state.entry_signal_id, { slOrderId: placed.orderId, currentStop: input.stopPrice })
    }
    return { orderId: placed.orderId }
  } catch (err: any) {
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

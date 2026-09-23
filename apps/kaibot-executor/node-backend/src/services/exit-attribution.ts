// Spreading a realized close across the bot executions that hold the position.
//
// A venue position can be held by several signal executions on the same
// (exchange, account, symbol). When something closes that position, each
// execution needs its share booked as an exit fill — that fill IS the fills-based
// P&L, so an exit that never lands leaves a real trade unpriced and invisible in
// analytics (2026-08-28: a manual close and a broker-confirmed close both went
// unbooked this way).
//
// Bookkeeping only: nothing here places, cancels or sizes an order. It records
// what the venue already did.

export interface AttributableExecution {
  signal_id: string
  qty_opened: number
  qty_closed: number
  created_at: number
}

export interface ExitAllocation {
  signalId: string
  qty: number
  /** The execution has no open quantity left after this allocation. */
  fullyClosed: boolean
}

const EPS = 1e-9

/**
 * Allocate `closeQty` over the executions' still-open quantity, newest first —
 * the same LIFO order the signal close path uses, so a manual close and a
 * signal close attribute identically. Executions with nothing open are skipped;
 * quantity beyond the tracked book is dropped (the surplus belongs to a
 * position the executor does not track, never to an unrelated execution).
 */
export function planExitAttribution(
  executions: AttributableExecution[],
  closeQty: number,
): ExitAllocation[] {
  if (!(closeQty > EPS)) return []
  const newestFirst = [...executions].sort((a, b) => b.created_at - a.created_at)
  const out: ExitAllocation[] = []
  let remaining = closeQty
  for (const e of newestFirst) {
    if (remaining <= EPS) break
    const open = e.qty_opened - e.qty_closed
    if (open <= EPS) continue
    const qty = Math.min(open, remaining)
    out.push({ signalId: e.signal_id, qty, fullyClosed: qty >= open - EPS })
    remaining -= qty
  }
  return out
}

// Narrow structural view of the executor DB — keeps this module unit-testable
// without a SQLite file and makes the write surface explicit: fills + per-
// execution quantity accounting, nothing else.
export interface ExitAttributionDb {
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
    patch: { status?: 'open' | 'closed' | 'closing' | 'error'; qtyClosed?: number; qtyPendingClose?: number | null },
  ): unknown
  markEntrySignalClosed(signalId: string, reason?: string): unknown
}

export interface VenueExit {
  exchange: string
  /** Null matches any account (adapters that don't report one). */
  accountId: string | null
  symbol: string
  /** Side of the CLOSING order. */
  side: 'buy' | 'sell'
  qty: number
  price: number | null
  orderId?: string | null
  /** Real venue fill moment (epoch ms) when known; the fill row defaults to now. */
  filledAtMs?: number | null
  /** Goes on the retired entry signal, e.g. 'closed by manual close'. */
  reason: string
}

/**
 * Book a realized venue exit onto the executions holding that position. Returns
 * what was attributed (empty when the position is untracked — a purely manual
 * position has no execution to book against, which is not an error).
 */
export function attributeVenueExit(db: ExitAttributionDb, exit: VenueExit): ExitAllocation[] {
  const symbol = exit.symbol.toUpperCase()
  const holders = db.listOpenExecutionsForExchange(exit.exchange).filter(
    (e) =>
      e.symbol.toUpperCase() === symbol &&
      (exit.accountId == null || e.account_id == null || e.account_id === exit.accountId),
  )
  const plan = planExitAttribution(holders, exit.qty)
  const byId = new Map(holders.map((h) => [h.signal_id, h]))
  for (const a of plan) {
    const holder = byId.get(a.signalId)!
    db.insertSignalFill({
      signalId: a.signalId,
      kind: 'exit',
      symbol: exit.symbol,
      side: exit.side,
      qty: a.qty,
      price: exit.price,
      orderId: exit.orderId ?? null,
      ...(exit.filledAtMs != null ? { createdAtMs: exit.filledAtMs } : {}),
    })
    db.updateSignalExecution(a.signalId, {
      status: a.fullyClosed ? 'closed' : 'open',
      qtyClosed: holder.qty_closed + a.qty,
      ...(a.fullyClosed ? { qtyPendingClose: null } : {}),
    })
    if (a.fullyClosed) db.markEntrySignalClosed(a.signalId, exit.reason)
  }
  return plan
}

// Fills-based per-signal PnL.
//
// Ported from the standalone kaibot-exec service (src/pnl.ts) and adapted to the
// executor's fill model: fills are stored per signal with kind 'entry' | 'exit'
// (rather than open/reduce/close order rows). The PnL semantics are identical —
// weighted entry/exit averages, realized on the closed quantity, unrealized on
// the remainder, per-root contract multipliers for futures.
//
// Honest accounting: realized PnL is computed from actual fill prices and
// includes commissions when the exchange reported them.

import type { SignalExecutionRow, SignalFillRow } from '../storage/types.js'
import { multiplierFor } from './exchanges/futures-contracts.js'

export interface SignalPnl {
  entryAvg: number | null
  exitAvg: number | null
  qtyOpened: number
  qtyClosed: number
  qtyRemaining: number
  realizedPnl: number // gross, on the closed quantity
  realizedNet: number // gross minus commissions allocated to the closed portion
  commission: number // commissions allocated to the closed portion
  unrealizedPnl: number | null // on the remaining quantity, requires lastPrice
  multiplier: number
  basis: 'fills'
}

interface WeightedAvg {
  avg: number | null
  qty: number
  commission: number
}

function weightedAvg(fills: SignalFillRow[]): WeightedAvg {
  let qty = 0
  let priceVolume = 0
  let commission = 0
  for (const f of fills) {
    commission += f.commission || 0
    if (f.price == null) continue
    qty += f.qty
    priceVolume += f.price * f.qty
  }
  return { avg: qty > 0 ? priceVolume / qty : null, qty, commission }
}

/**
 * Compute fills-based PnL for one signal's execution. `lastPrice` (optional) is
 * the current mark for unrealized PnL on the still-open remainder.
 */
export function computeSignalPnl(
  exec: Pick<SignalExecutionRow, 'symbol' | 'direction' | 'status'>,
  fills: SignalFillRow[],
  lastPrice?: number | null,
): SignalPnl {
  const priced = fills.filter((f) => f.price != null)
  const entryFills = priced.filter((f) => f.kind === 'entry')
  const exitFills = priced.filter((f) => f.kind === 'exit')

  // Commission totals use all fills (a fill may carry commission without a price).
  const entry = weightedAvg(fills.filter((f) => f.kind === 'entry'))
  const exit = weightedAvg(fills.filter((f) => f.kind === 'exit'))

  const mult = multiplierFor(exec.symbol)
  // Long gains when price rises; short gains when price falls.
  const sign = exec.direction === 'short' ? 1 : -1

  const entryAvg = weightedAvg(entryFills).avg
  const exitAvg = weightedAvg(exitFills).avg

  const qtyOpened = entry.qty
  const qtyClosed = exit.qty
  const qtyRemaining = Math.max(0, qtyOpened - qtyClosed)

  const realizedPnl =
    entryAvg != null && exitAvg != null ? sign * (entryAvg - exitAvg) * qtyClosed * mult : 0

  // Allocate the entry commission proportionally to the closed quantity, plus the
  // full exit commission on that closed portion.
  const entryCommClosed = qtyOpened > 0 ? entry.commission * (qtyClosed / qtyOpened) : 0
  const commission = entryCommClosed + exit.commission
  const realizedNet = realizedPnl - commission

  let unrealizedPnl: number | null = null
  if (exec.status === 'open' && qtyRemaining > 0 && entryAvg != null && lastPrice != null) {
    unrealizedPnl = sign * (entryAvg - lastPrice) * qtyRemaining * mult
  }

  return {
    entryAvg,
    exitAvg,
    qtyOpened,
    qtyClosed,
    qtyRemaining,
    realizedPnl,
    realizedNet,
    commission,
    unrealizedPnl,
    multiplier: mult,
    basis: 'fills',
  }
}

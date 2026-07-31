import { describe, expect, it } from 'bun:test'
import { computeSignalPnl } from './pnl.js'
import type { SignalExecutionRow, SignalFillRow } from '../storage/types.js'

let fillId = 0
function fill(over: Partial<SignalFillRow> = {}): SignalFillRow {
  return {
    id: ++fillId,
    signal_id: 'sig-1',
    kind: 'entry',
    symbol: 'MESM26',
    side: 'buy',
    qty: 1,
    price: 5000,
    commission: 0,
    order_id: null,
    created_at: Date.now(),
    ...over,
  }
}

function exec(over: Partial<SignalExecutionRow> = {}): Pick<SignalExecutionRow, 'symbol' | 'direction' | 'status'> {
  return { symbol: 'MESM26', direction: 'long', status: 'closed', ...over }
}

describe('computeSignalPnl — futures multipliers', () => {
  it('realizes a long MES win at the $5/pt multiplier', () => {
    // Buy 1 @ 5000, sell 1 @ 5010 → 10 pts × $5 = $50.
    const fills = [
      fill({ kind: 'entry', side: 'buy', price: 5000, qty: 1 }),
      fill({ kind: 'exit', side: 'sell', price: 5010, qty: 1 }),
    ]
    const pnl = computeSignalPnl(exec(), fills)
    expect(pnl.multiplier).toBe(5)
    expect(pnl.realizedPnl).toBe(50)
    expect(pnl.entryAvg).toBe(5000)
    expect(pnl.exitAvg).toBe(5010)
    expect(pnl.qtyClosed).toBe(1)
    expect(pnl.qtyRemaining).toBe(0)
  })

  it('realizes a short MNQ win when price falls', () => {
    // Short 2 @ 18000, cover 2 @ 17950 → 50 pts × $2 × 2 = $200.
    const fills = [
      fill({ symbol: 'MNQZ25', kind: 'entry', side: 'sell', price: 18000, qty: 2 }),
      fill({ symbol: 'MNQZ25', kind: 'exit', side: 'buy', price: 17950, qty: 2 }),
    ]
    const pnl = computeSignalPnl(exec({ symbol: 'MNQZ25', direction: 'short' }), fills)
    expect(pnl.multiplier).toBe(2)
    expect(pnl.realizedPnl).toBe(200)
  })

  it('a long loss is negative', () => {
    const fills = [
      fill({ kind: 'entry', side: 'buy', price: 5010, qty: 1 }),
      fill({ kind: 'exit', side: 'sell', price: 5000, qty: 1 }),
    ]
    expect(computeSignalPnl(exec(), fills).realizedPnl).toBe(-50)
  })
})

describe('computeSignalPnl — weighted averages and partial closes', () => {
  it('weights entry and exit averages by quantity', () => {
    // Buy 1 @ 5000 and 1 @ 5020 → avg 5010. Sell 2 @ 5030 → 20 pts × $5 × 2 = $200.
    const fills = [
      fill({ kind: 'entry', side: 'buy', price: 5000, qty: 1 }),
      fill({ kind: 'entry', side: 'buy', price: 5020, qty: 1 }),
      fill({ kind: 'exit', side: 'sell', price: 5030, qty: 2 }),
    ]
    const pnl = computeSignalPnl(exec(), fills)
    expect(pnl.entryAvg).toBe(5010)
    expect(pnl.qtyOpened).toBe(2)
    expect(pnl.realizedPnl).toBe(200)
  })

  it('realizes only the closed portion and leaves a remainder for unrealized', () => {
    // Buy 4 @ 5000, sell 1 @ 5010 → realized 10×$5×1 = $50, 3 left.
    const fills = [
      fill({ kind: 'entry', side: 'buy', price: 5000, qty: 4 }),
      fill({ kind: 'exit', side: 'sell', price: 5010, qty: 1 }),
    ]
    const pnl = computeSignalPnl(exec({ status: 'open' }), fills, 5020)
    expect(pnl.realizedPnl).toBe(50)
    expect(pnl.qtyRemaining).toBe(3)
    // Unrealized on 3 @ entry 5000, mark 5020 → 20×$5×3 = $300.
    expect(pnl.unrealizedPnl).toBe(300)
  })

  it('returns null unrealized without a mark price', () => {
    const fills = [fill({ kind: 'entry', side: 'buy', price: 5000, qty: 1 })]
    const pnl = computeSignalPnl(exec({ status: 'open' }), fills)
    expect(pnl.unrealizedPnl).toBeNull()
    expect(pnl.realizedPnl).toBe(0)
  })
})

describe('computeSignalPnl — commissions and net', () => {
  it('subtracts allocated commissions from net PnL', () => {
    // Buy 2 @ 5000 ($2 entry comm), sell 1 @ 5010 ($1 exit comm).
    // Gross on the closed 1 = 10×$5 = $50. Entry comm allocated to closed half = $1.
    // Net = 50 - (1 + 1) = 48.
    const fills = [
      fill({ kind: 'entry', side: 'buy', price: 5000, qty: 2, commission: 2 }),
      fill({ kind: 'exit', side: 'sell', price: 5010, qty: 1, commission: 1 }),
    ]
    const pnl = computeSignalPnl(exec({ status: 'open' }), fills)
    expect(pnl.realizedPnl).toBe(50)
    expect(pnl.commission).toBe(2)
    expect(pnl.realizedNet).toBe(48)
  })
})

describe('computeSignalPnl — crypto default multiplier', () => {
  it('uses multiplier 1 for non-futures symbols', () => {
    // Long BTC: buy 1 @ 60000, sell 1 @ 61000 → $1000 at multiplier 1.
    const fills = [
      fill({ symbol: 'BTC-PERPETUAL', kind: 'entry', side: 'buy', price: 60000, qty: 1 }),
      fill({ symbol: 'BTC-PERPETUAL', kind: 'exit', side: 'sell', price: 61000, qty: 1 }),
    ]
    const pnl = computeSignalPnl(exec({ symbol: 'BTC-PERPETUAL' }), fills)
    expect(pnl.multiplier).toBe(1)
    expect(pnl.realizedPnl).toBe(1000)
  })
})

describe('computeSignalPnl — degenerate cases', () => {
  it('zero realized when no exit fills', () => {
    const pnl = computeSignalPnl(exec({ status: 'open' }), [fill({ kind: 'entry', qty: 1 })])
    expect(pnl.realizedPnl).toBe(0)
    expect(pnl.exitAvg).toBeNull()
  })

  it('ignores fills without a price for averages but keeps their commission', () => {
    const fills = [
      fill({ kind: 'entry', side: 'buy', price: 5000, qty: 1, commission: 1 }),
      fill({ kind: 'exit', side: 'sell', price: null, qty: 1, commission: 1 }),
    ]
    const pnl = computeSignalPnl(exec(), fills)
    // No priced exit → no realized gross, but commissions still tracked.
    expect(pnl.realizedPnl).toBe(0)
    expect(pnl.commission).toBe(1) // exit commission only; nothing closed at a price
  })
})

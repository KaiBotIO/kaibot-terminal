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

// Inverse perps (crypto-top2 §4.3, 2026-09-04): qty is USD notional, payout in
// coin. USD P&L = qty × (exit − entry) / entry. The plain (exit − entry) × qty
// was off by a factor of the entry price — Analytics on Deribit and the
// daily-loss rail both leaned on it.
describe('computeSignalPnl — inverse perps (Deribit)', () => {
  const inv = (over: Partial<SignalExecutionRow> = {}) => ({
    ...exec({ symbol: 'BTC-PERPETUAL', ...over }),
    exchange: 'deribit',
  })

  it('REGRESSION: a long on BTC-PERPETUAL realizes qty × (exit − entry) / entry, not × qty', () => {
    // 10.000 USD long from 50.000 to 55.000: 10.000 × 5.000 / 50.000 = 1.000 USD (not 50.000.000).
    const pnl = computeSignalPnl(inv(), [
      fill({ symbol: 'BTC-PERPETUAL', kind: 'entry', side: 'buy', qty: 10_000, price: 50_000 }),
      fill({ symbol: 'BTC-PERPETUAL', kind: 'exit', side: 'sell', qty: 10_000, price: 55_000 }),
    ])
    expect(pnl.realizedPnl).toBeCloseTo(1_000, 6)
  })

  it('a short on ETH-PERPETUAL gains when price falls, scaled by the entry price', () => {
    // 3.000 USD short from 3.000 to 2.700: 3.000 × 300 / 3.000 = 300 USD.
    const pnl = computeSignalPnl(inv({ symbol: 'ETH-PERPETUAL', direction: 'short' }), [
      fill({ symbol: 'ETH-PERPETUAL', kind: 'entry', side: 'sell', qty: 3_000, price: 3_000 }),
      fill({ symbol: 'ETH-PERPETUAL', kind: 'exit', side: 'buy', qty: 3_000, price: 2_700 }),
    ])
    expect(pnl.realizedPnl).toBeCloseTo(300, 6)
  })

  it('unrealized on the remainder uses the same inverse formula', () => {
    const pnl = computeSignalPnl(inv({ status: 'open' }), [
      fill({ symbol: 'BTC-PERPETUAL', kind: 'entry', side: 'buy', qty: 10_000, price: 50_000 }),
    ], 45_000)
    // 10.000 × (45.000 − 50.000) / 50.000 = −1.000 USD.
    expect(pnl.unrealizedPnl).toBeCloseTo(-1_000, 6)
  })

  it('USDC-linear perps on Deribit keep the plain formula (qty in coin)', () => {
    const pnl = computeSignalPnl(inv({ symbol: 'BTC_USDC-PERPETUAL' }), [
      fill({ symbol: 'BTC_USDC-PERPETUAL', kind: 'entry', side: 'buy', qty: 0.1, price: 50_000 }),
      fill({ symbol: 'BTC_USDC-PERPETUAL', kind: 'exit', side: 'sell', qty: 0.1, price: 55_000 }),
    ])
    expect(pnl.realizedPnl).toBeCloseTo(500, 6)
  })

  it('without an exchange on the row nothing changes (linear default)', () => {
    const pnl = computeSignalPnl(exec({ symbol: 'BTC-PERPETUAL' }), [
      fill({ symbol: 'BTC-PERPETUAL', kind: 'entry', side: 'buy', qty: 1, price: 50_000 }),
      fill({ symbol: 'BTC-PERPETUAL', kind: 'exit', side: 'sell', qty: 1, price: 55_000 }),
    ])
    expect(pnl.realizedPnl).toBeCloseTo(5_000, 6)
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

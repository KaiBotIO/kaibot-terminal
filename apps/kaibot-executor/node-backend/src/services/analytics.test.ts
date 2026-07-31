import { describe, expect, it } from 'bun:test'
import {
  buildSummary,
  buildCumulativePnl,
  buildTradeDistribution,
  closedRowsFromExecutions,
  type ClosedRow,
} from './analytics.js'
import type { SignalFillRow } from '../storage/types.js'

const HOUR = 3_600_000

// Contract fixture: identical numbers to the web app's analytics.test.ts
// (packages/trpc/src/routers/__tests__/analytics.test.ts). If these two ever
// disagree, the executor and the web app are computing different metrics.
function row(symbol: string, realizedPnl: number, opts: { openOffsetH?: number } = {}): ClosedRow {
  const closedAt = new Date('2026-06-01T12:00:00Z').getTime()
  const openDate = closedAt - (opts.openOffsetH ?? 1) * HOUR
  return { symbol, direction: 'long', realizedPnl, entryAvg: null, exitAvg: null, closedAt, openDate }
}

describe('buildSummary', () => {
  it('reports the empty state when no trades', () => {
    const s = buildSummary([])
    expect(s.hasData).toBe(false)
    expect(s.totalTrades).toBe(0)
    expect(s.winRate).toBeNull()
    expect(s.profitFactor).toBeNull()
    expect(s.maxDrawdownPct).toBeNull()
  })

  it('computes win rate, profit factor and net P&L (web-app parity)', () => {
    const s = buildSummary([row('BTC', 100), row('BTC', -50), row('ETH', 50), row('ETH', -25)])
    expect(s.hasData).toBe(true)
    expect(s.totalTrades).toBe(4)
    expect(s.winningTrades).toBe(2)
    expect(s.losingTrades).toBe(2)
    expect(s.winRate).toBe(0.5)
    // gross profit 150 / gross loss 75 = 2
    expect(s.profitFactor).toBe(2)
    expect(s.netPnl).toBe(75)
  })

  it('returns Infinity profit factor when there are no losers', () => {
    const s = buildSummary([row('BTC', 10), row('BTC', 20)])
    expect(s.profitFactor).toBe(Infinity)
    expect(s.winRate).toBe(1)
    expect(s.losingTrades).toBe(0)
  })

  it('computes a non-positive max drawdown on the cumulative curve', () => {
    // cumulative: +100, +50 (peak 100). dd at +50 = -0.5.
    const s = buildSummary([row('BTC', 100), row('BTC', -50)])
    expect(s.maxDrawdownPct).not.toBeNull()
    expect(s.maxDrawdownPct as number).toBeLessThanOrEqual(0)
    expect(s.maxDrawdownPct).toBeCloseTo(-0.5, 5)
  })

  it('floors max drawdown at -100% (cannot lose more than the account)', () => {
    // cumulative: +10 (peak 10) then -10. raw dd = (-10-10)/10 = -2.0 (-200%),
    // which is impossible — floored to -1.0. Regression for the -200% bug.
    const s = buildSummary([row('BTC', 10), row('BTC', -20)])
    expect(s.maxDrawdownPct).toBe(-1)
  })

  // Regression (delta review 2026-07-08): an account that never went positive
  // reported maxDrawdownPct 0.0% next to a red net P&L — the peak guard left the
  // accumulator at its initial 0. There is no percentage peak to divide by, so
  // the percentage is undefined; the absolute drawdown still is not.
  it('reports an undefined drawdown percentage when the curve never went positive', () => {
    const s = buildSummary([row('BTC', -30), row('BTC', -20)])
    expect(s.netPnl).toBe(-50)
    expect(s.maxDrawdownPct).toBeNull()
    expect(s.maxDrawdownAbs).toBe(-50)
  })

  it('reports an undefined drawdown percentage for a single losing trade', () => {
    const s = buildSummary([row('BTC', -10)])
    expect(s.maxDrawdownPct).toBeNull()
    expect(s.maxDrawdownAbs).toBe(-10)
  })

  it('reports the absolute drawdown alongside the percentage once the curve is positive', () => {
    // cumulative: +100 (peak 100), +50. abs dd = -50, pct = -0.5.
    const s = buildSummary([row('BTC', 100), row('BTC', -50)])
    expect(s.maxDrawdownAbs).toBe(-50)
    expect(s.maxDrawdownPct).toBeCloseTo(-0.5, 5)
  })

  it('reports zero drawdown for a monotonically rising curve', () => {
    const s = buildSummary([row('BTC', 10), row('BTC', 20)])
    expect(s.maxDrawdownPct).toBe(0)
    expect(s.maxDrawdownAbs).toBe(0)
  })

  it('averages trade duration from open to close', () => {
    const s = buildSummary([row('BTC', 10, { openOffsetH: 2 }), row('BTC', 10, { openOffsetH: 4 })])
    expect(s.avgTradeDurationMs).toBe(3 * HOUR)
  })
})

describe('buildCumulativePnl', () => {
  it('accumulates realized P&L in order', () => {
    const pts = buildCumulativePnl([row('BTC', 10), row('BTC', -4), row('ETH', 20)])
    expect(pts.map((p) => p.pnl)).toEqual([10, 6, 26])
  })

  it('is empty for no trades', () => {
    expect(buildCumulativePnl([])).toEqual([])
  })
})

describe('buildTradeDistribution', () => {
  it('groups by market, sorted by trade count', () => {
    const dist = buildTradeDistribution([
      row('BTC', 10),
      row('BTC', -5),
      row('BTC', 3),
      row('ETH', 7),
    ])
    expect(dist[0]).toEqual({ market: 'BTC', trades: 3, netPnl: 8 })
    expect(dist[1]).toEqual({ market: 'ETH', trades: 1, netPnl: 7 })
  })
})

describe('closedRowsFromExecutions', () => {
  const fill = (
    signal_id: string,
    kind: 'entry' | 'exit',
    qty: number,
    price: number,
    created_at: number,
    commission = 0,
  ): SignalFillRow => ({
    id: 0,
    signal_id,
    kind,
    symbol: 'BTCUSDT',
    side: kind === 'entry' ? 'buy' : 'sell',
    qty,
    price,
    commission,
    order_id: null,
    created_at,
  })

  const exec = (signal_id: string, status: 'open' | 'closed' | 'error', direction: 'long' | 'short' = 'long') => ({
    signal_id,
    symbol: 'BTCUSDT',
    direction,
    status,
    qty_opened: 1,
    qty_closed: status === 'closed' ? 1 : 0,
  })

  it('maps a closed long to a ClosedRow with net realized P&L and open/close times', () => {
    const fills = new Map<string, SignalFillRow[]>([
      ['s1', [fill('s1', 'entry', 1, 100, 1_000, 1), fill('s1', 'exit', 1, 110, 5_000, 1)]],
    ])
    const rows = closedRowsFromExecutions([exec('s1', 'closed')], fills)
    expect(rows).toHaveLength(1)
    expect(rows[0].symbol).toBe('BTCUSDT')
    expect(rows[0].direction).toBe('long')
    // per-trade breakdown carried for the closed-trades table (delta review 2026-07-08)
    expect(rows[0].entryAvg).toBe(100)
    expect(rows[0].exitAvg).toBe(110)
    // long +10/unit, qty 1, minus 2 commission = 8 net
    expect(rows[0].realizedPnl).toBe(8)
    expect(rows[0].openDate).toBe(1_000)
    expect(rows[0].closedAt).toBe(5_000)
  })

  it('skips open, errored, and exit-less executions', () => {
    const fills = new Map<string, SignalFillRow[]>([
      ['open', [fill('open', 'entry', 1, 100, 1_000)]],
      ['err', [fill('err', 'entry', 1, 100, 1_000)]],
      ['noexit', [fill('noexit', 'entry', 1, 100, 1_000)]],
    ])
    const rows = closedRowsFromExecutions(
      [exec('open', 'open'), exec('err', 'error'), exec('noexit', 'closed')],
      fills,
    )
    expect(rows).toHaveLength(0)
  })

  it('returns rows ascending by close time', () => {
    const fills = new Map<string, SignalFillRow[]>([
      ['late', [fill('late', 'entry', 1, 100, 1_000), fill('late', 'exit', 1, 105, 9_000)]],
      ['early', [fill('early', 'entry', 1, 100, 1_000), fill('early', 'exit', 1, 105, 3_000)]],
    ])
    const rows = closedRowsFromExecutions([exec('late', 'closed'), exec('early', 'closed')], fills)
    expect(rows.map((r) => r.closedAt)).toEqual([3_000, 9_000])
  })
})

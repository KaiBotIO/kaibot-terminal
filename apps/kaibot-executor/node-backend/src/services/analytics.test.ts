import { describe, expect, it } from 'bun:test'
import {
  buildSummary,
  buildCumulativePnl,
  buildTradeDistribution,
  buildStrategyScorecards,
  closedRowsFromExecutions,
  countUnpricedCloses,
  filterClosedRows,
  filterOptionsFrom,
  resolveStrategyLabel,
  UNATTRIBUTED_STRATEGY,
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

  // Regression (live panel 2026-08-28): the first trade was a -$149 loser and the
  // curve only turned positive after it. The peak-guard never sampled that dip,
  // yet the "peak ever positive" flag flipped on the later winners, so the panel
  // printed 0.0% next to -$149.00. The deepest dip had no peak above it → the
  // percentage is undefined, the amount is not.
  it('reports an undefined percentage when the deepest dip predates the first peak', () => {
    const s = buildSummary([row('MNQ', -149), row('MNQ', 389.5), row('MES', 182.5)])
    expect(s.netPnl).toBe(423)
    expect(s.maxDrawdownAbs).toBe(-149)
    expect(s.maxDrawdownPct).toBeNull()
  })

  // The same curve with a DEEPER post-peak dip: now the worst drawdown does have
  // a peak, so the percentage describes that same dip (never the earlier one).
  it('measures the percentage against the peak of the deepest dip', () => {
    // cumulative: -149, +240.5 (peak 240.5), +40.5 → deepest dd = -200 from 240.5.
    const s = buildSummary([row('MNQ', -149), row('MNQ', 389.5), row('MES', -200)])
    expect(s.maxDrawdownAbs).toBe(-200)
    expect(s.maxDrawdownPct).toBeCloseTo(-200 / 240.5, 5)
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

describe('buildStrategyScorecards', () => {
  const t = (
    strategy: string | null,
    signalBotId: string | null,
    pnl: number,
    closedAtMs: number,
  ): ClosedRow => ({
    ...row('MNQ', pnl),
    strategy,
    signalBotId,
    closedAt: closedAtMs,
    openDate: closedAtMs - HOUR,
  })

  it('splits the same trades per bot with the shared metric conventions', () => {
    const cards = buildStrategyScorecards([
      t('Regime Slow', 'bot-a', -149, 1),
      t('MGC Ascender', 'bot-b', 389.5, 2),
      t('Regime Slow', 'bot-a', 182.5, 3),
    ])
    expect(cards.map((c) => c.strategy)).toEqual(['MGC Ascender', 'Regime Slow'])

    const slow = cards.find((c) => c.signalBotId === 'bot-a')!
    expect(slow.summary.totalTrades).toBe(2)
    expect(slow.summary.winningTrades).toBe(1)
    expect(slow.summary.netPnl).toBe(33.5)
    expect(slow.curve.map((p) => p.pnl)).toEqual([-149, 33.5])
    expect(slow.firstTradeAt).toBe(1)
    expect(slow.lastTradeAt).toBe(3)
    // Same drawdown rule as the panel: the dip predates any peak → no percentage.
    expect(slow.summary.maxDrawdownPct).toBeNull()
    expect(slow.summary.maxDrawdownAbs).toBe(-149)
  })

  it('buckets unattributed trades and sorts them last', () => {
    const cards = buildStrategyScorecards([
      t(null, null, -10, 1),
      t('Winner', 'bot-a', 5, 2),
    ])
    expect(cards.map((c) => c.strategy)).toEqual(['Winner', UNATTRIBUTED_STRATEGY])
    expect(cards[1].signalBotId).toBeNull()
    expect(cards[1].summary.netPnl).toBe(-10)
  })

  it('keys on the bot id so a renamed bot stays one row', () => {
    const cards = buildStrategyScorecards([
      t('Old name', 'bot-a', 10, 1),
      t('New name', 'bot-a', 10, 2),
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0].summary.totalTrades).toBe(2)
  })

  it('per-strategy net P&L adds up to the overall net P&L', () => {
    const rows = [t('A', 'a', 10, 1), t('B', 'b', -4, 2), t(null, null, 7, 3)]
    const cards = buildStrategyScorecards(rows)
    const sum = cards.reduce((acc, c) => acc + c.summary.netPnl, 0)
    expect(sum).toBeCloseTo(buildSummary(rows).netPnl, 9)
  })

  it('is empty without trades', () => {
    expect(buildStrategyScorecards([])).toEqual([])
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

  // Regression (live panel 2026-08-28): two closed executions carried
  // qty_closed 1 but no exit fill (a close that went pending and was flattened
  // by the reconciler, and a manual close under its own signal id). They vanish
  // from every metric — the count is what keeps the panel honest about it.
  describe('countUnpricedCloses', () => {
    it('counts closed executions that realized a close with no exit fill', () => {
      const fills = new Map<string, SignalFillRow[]>([
        ['priced', [fill('priced', 'entry', 1, 100, 1_000), fill('priced', 'exit', 1, 110, 5_000)]],
        ['unpriced', [fill('unpriced', 'entry', 1, 100, 1_000)]],
      ])
      const execs = [exec('priced', 'closed'), exec('unpriced', 'closed')]
      expect(closedRowsFromExecutions(execs, fills)).toHaveLength(1)
      expect(countUnpricedCloses(execs, fills)).toBe(1)
    })

    it('ignores open/errored rows and a cancelled entry that never traded', () => {
      const fills = new Map<string, SignalFillRow[]>([
        ['open', [fill('open', 'entry', 1, 100, 1_000)]],
        ['err', [fill('err', 'entry', 1, 100, 1_000)]],
      ])
      const cancelled = { ...exec('cancelled', 'closed'), qty_opened: 1, qty_closed: 0 }
      expect(
        countUnpricedCloses([exec('open', 'open'), exec('err', 'error'), cancelled], fills),
      ).toBe(0)
    })
  })
})

// Regression (Kai, 2026-09-02): the two reconciler round-trips of 01/09 were
// booked under synthetic signal ids (`reconcile-roundtrip:<orderId>`) on the
// SAME (account, symbol) as the live Ascender MGC position, and attribution
// resolved purely on the position group. The scorecard read 3 trades / -3.001
// where the bot had done 1 trade / -2.820.
describe('resolveStrategyLabel', () => {
  const ascender = { name: 'Ascender MGC 15m', signalBotId: 'bot-mgc' }

  it('attributes a bot signal to its own bot', () => {
    expect(
      resolveStrategyLabel({
        signalBotId: 'bot-mgc',
        fromSignal: true,
        group: ascender,
        configForBot: null,
        configForSymbol: null,
      }),
    ).toEqual({ strategy: 'Ascender MGC 15m', signalBotId: 'bot-mgc' })
  })

  it('leaves a synthetic reconciler round-trip unattributed', () => {
    // No signal row behind it, but it sits on the bot's group.
    expect(
      resolveStrategyLabel({
        signalBotId: null,
        fromSignal: false,
        group: ascender,
        configForBot: null,
        configForSymbol: { name: 'Ascender MGC 15m', signalBotId: 'bot-mgc' },
      }),
    ).toBeNull()
  })

  it('leaves a manual order unattributed even on a bot symbol', () => {
    expect(
      resolveStrategyLabel({
        signalBotId: null,
        fromSignal: false,
        group: ascender,
        configForBot: null,
        configForSymbol: null,
      }),
    ).toBeNull()
  })

  it('never lets one bot claim another bot position group', () => {
    expect(
      resolveStrategyLabel({
        signalBotId: 'bot-mnq',
        fromSignal: true,
        group: ascender,
        configForBot: { name: 'Ascender MNQ 6m' },
        configForSymbol: null,
      }),
    ).toEqual({ strategy: 'Ascender MNQ 6m', signalBotId: 'bot-mnq' })
  })

  it('falls back to the bot id rather than dropping a real bot trade', () => {
    expect(
      resolveStrategyLabel({
        signalBotId: 'bot-mnq',
        fromSignal: true,
        group: ascender,
        configForBot: null,
        configForSymbol: null,
      }),
    ).toEqual({ strategy: 'bot-mnq', signalBotId: 'bot-mnq' })
  })

  it('takes a group with no bot of its own for the signal bot', () => {
    expect(
      resolveStrategyLabel({
        signalBotId: 'bot-mgc',
        fromSignal: true,
        group: { name: 'Unsorted MGC', signalBotId: null },
        configForBot: null,
        configForSymbol: null,
      }),
    ).toEqual({ strategy: 'Unsorted MGC', signalBotId: 'bot-mgc' })
  })

  it('still resolves a legacy signal without bot metadata by its position', () => {
    expect(
      resolveStrategyLabel({
        signalBotId: null,
        fromSignal: true,
        group: ascender,
        configForBot: null,
        configForSymbol: null,
      }),
    ).toEqual({ strategy: 'Ascender MGC 15m', signalBotId: 'bot-mgc' })
  })

  it('falls back to the symbol config for a legacy signal with no group', () => {
    expect(
      resolveStrategyLabel({
        signalBotId: null,
        fromSignal: true,
        group: null,
        configForBot: null,
        configForSymbol: { name: 'Ascender MGC 15m', signalBotId: 'bot-mgc' },
      }),
    ).toEqual({ strategy: 'Ascender MGC 15m', signalBotId: 'bot-mgc' })
  })
})

// The scorecards this feeds: the bot row must carry only its own trades, and
// the non-bot posts must stay visible in their own bucket.
describe('buildStrategyScorecards separates non-bot posts', () => {
  const at = (h: number) => new Date('2026-09-01T00:00:00Z').getTime() + h * HOUR

  it('keeps reconciler round-trips out of the bot row but in the totals', () => {
    const rows: ClosedRow[] = [
      {
        symbol: 'MGCZ26', direction: 'long', realizedPnl: -2820, entryAvg: 4678.8, exitAvg: 4396.8,
        closedAt: at(1), openDate: at(0), strategy: 'Ascender MGC 15m', signalBotId: 'bot-mgc',
      },
      {
        symbol: 'MGCZ26', direction: 'long', realizedPnl: -90, entryAvg: 4400, exitAvg: 4391,
        closedAt: at(2), openDate: at(2), strategy: null, signalBotId: null,
      },
      {
        symbol: 'MGCZ26', direction: 'long', realizedPnl: -91, entryAvg: 4392, exitAvg: 4382.9,
        closedAt: at(3), openDate: at(3), strategy: null, signalBotId: null,
      },
    ]

    const cards = buildStrategyScorecards(rows)
    const bot = cards.find((c) => c.strategy === 'Ascender MGC 15m')!
    const rest = cards.find((c) => c.strategy === UNATTRIBUTED_STRATEGY)!

    expect(bot.summary.totalTrades).toBe(1)
    expect(bot.summary.netPnl).toBe(-2820)
    expect(rest.summary.totalTrades).toBe(2)
    expect(rest.summary.netPnl).toBe(-181)
    // Unattributed always sorts last, and the rows still add up to the panel.
    expect(cards[cards.length - 1]!.strategy).toBe(UNATTRIBUTED_STRATEGY)
    expect(cards.reduce((s, c) => s + c.summary.netPnl, 0)).toBe(-3001)
  })
})

// Regression (Kai, 2026-09-02): a $3.289 dip off a $560 peak is -587%, floored
// to -100% — which reads as "the account is gone" instead of "the dip was five
// times its own peak". The floor stays; the UI needs to know it was applied.
describe('max drawdown clamp is flagged', () => {
  const t = (pnl: number, h: number): ClosedRow => ({
    symbol: 'MGCZ26', direction: 'long', realizedPnl: pnl, entryAvg: null, exitAvg: null,
    closedAt: new Date('2026-09-01T00:00:00Z').getTime() + h * HOUR,
    openDate: new Date('2026-09-01T00:00:00Z').getTime() + h * HOUR,
  })

  it('flags a drawdown deeper than the peak it fell from', () => {
    const s = buildSummary([t(560, 1), t(-3289, 2)])
    expect(s.maxDrawdownAbs).toBe(-3289)
    expect(s.maxDrawdownPct).toBe(-1)
    expect(s.maxDrawdownPctClamped).toBe(true)
  })

  it('does not flag an ordinary drawdown', () => {
    const s = buildSummary([t(1000, 1), t(-400, 2)])
    expect(s.maxDrawdownPct).toBeCloseTo(-0.4, 10)
    expect(s.maxDrawdownPctClamped).toBe(false)
  })

  it('does not flag a dip that never had a peak (percentage withheld)', () => {
    const s = buildSummary([t(-500, 1)])
    expect(s.maxDrawdownPct).toBeNull()
    expect(s.maxDrawdownPctClamped).toBe(false)
  })
})

// The Analytics filter bar: one pure pass over the closed rows, ahead of every
// aggregation, so the KPIs, the curve, the by-strategy table and the market
// distribution can never describe different sets of trades.
describe('filterClosedRows', () => {
  const DAY = 24 * HOUR
  const base = new Date('2026-09-01T12:00:00Z').getTime()
  const row = (over: Partial<ClosedRow>): ClosedRow => ({
    symbol: 'MGCZ26',
    direction: 'long',
    accountId: '21084933',
    realizedPnl: -100,
    entryAvg: null,
    exitAvg: null,
    closedAt: base,
    openDate: base - HOUR,
    strategy: 'Ascender MGC 15m',
    signalBotId: 'bot-mgc',
    ...over,
  })

  const mgc = row({})
  const mnq = row({ symbol: 'MNQU26', accountId: '21084931', strategy: 'BC Alpha Volcap 1h', signalBotId: 'bot-bc', direction: 'short', realizedPnl: -149 })
  const manual = row({ strategy: null, signalBotId: null, realizedPnl: -90, closedAt: base + DAY })
  const all = [mgc, mnq, manual]

  it('keeps everything on an empty filter', () => {
    expect(filterClosedRows(all, {})).toEqual(all)
  })

  it('filters on account, multi-select', () => {
    expect(filterClosedRows(all, { accounts: ['21084931'] })).toEqual([mnq])
    expect(filterClosedRows(all, { accounts: ['21084931', '21084933'] })).toHaveLength(3)
  })

  it('filters on strategy key, multi-select', () => {
    expect(filterClosedRows(all, { strategies: ['bot-mgc'] })).toEqual([mgc])
    expect(filterClosedRows(all, { strategies: ['bot-mgc', 'bot-bc'] })).toEqual([mgc, mnq])
  })

  it('groups the non-bot posts under the Unattributed key', () => {
    expect(filterClosedRows(all, { strategies: [UNATTRIBUTED_STRATEGY] })).toEqual([manual])
  })

  it('filters on market', () => {
    expect(filterClosedRows(all, { symbols: ['MNQU26'] })).toEqual([mnq])
  })

  it('filters on direction, and treats both as no filter', () => {
    expect(filterClosedRows(all, { direction: 'short' })).toEqual([mnq])
    expect(filterClosedRows(all, { direction: 'long' })).toEqual([mgc, manual])
    expect(filterClosedRows(all, { direction: 'both' })).toHaveLength(3)
  })

  it('filters on an inclusive close-time range', () => {
    expect(filterClosedRows(all, { from: base, to: base })).toEqual([mgc, mnq])
    expect(filterClosedRows(all, { from: base + DAY })).toEqual([manual])
    expect(filterClosedRows(all, { to: base - 1 })).toEqual([])
  })

  it('drops manual and repair posts when non-bot is off', () => {
    expect(filterClosedRows(all, { includeNonBot: false })).toEqual([mgc, mnq])
    expect(filterClosedRows(all, { includeNonBot: true })).toHaveLength(3)
  })

  it('ands the criteria together', () => {
    expect(
      filterClosedRows(all, {
        accounts: ['21084933'],
        direction: 'long',
        includeNonBot: false,
      }),
    ).toEqual([mgc])
  })

  it('returns nothing when the criteria exclude each other', () => {
    expect(filterClosedRows(all, { accounts: ['21084931'], symbols: ['MGCZ26'] })).toEqual([])
  })

  it('feeds every aggregation the same rows', () => {
    const kept = filterClosedRows(all, { includeNonBot: false })
    expect(buildSummary(kept).totalTrades).toBe(2)
    expect(buildCumulativePnl(kept)).toHaveLength(2)
    expect(buildTradeDistribution(kept).reduce((s, d) => s + d.trades, 0)).toBe(2)
    expect(buildStrategyScorecards(kept).map((c) => c.strategy)).not.toContain(
      UNATTRIBUTED_STRATEGY,
    )
  })

  it('offers every choice from the unfiltered ledger', () => {
    const o = filterOptionsFrom(all)
    expect(o.accounts).toEqual(['21084931', '21084933'])
    expect(o.symbols).toEqual(['MGCZ26', 'MNQU26'])
    // Menu order is by label, so "Ascender MGC 15m" sits above "BC Alpha Volcap 1h".
    expect(o.strategies.map((s) => s.key)).toEqual(['bot-mgc', 'bot-bc', UNATTRIBUTED_STRATEGY])
    // Unattributed always sits at the bottom of the menu.
    expect(o.strategies[o.strategies.length - 1]!.label).toBe(UNATTRIBUTED_STRATEGY)
  })
})

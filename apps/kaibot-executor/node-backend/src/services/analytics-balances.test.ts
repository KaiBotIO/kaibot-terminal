import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import {
  accountBalanceFor,
  buildAccountScorecards,
  buildStrategyScorecards,
  buildSummary,
  type ClosedRow,
} from './analytics.js'
import { buildAccountBalances, periodStartOf } from './analytics-balances.js'

const HOUR = 3_600_000
const START = new Date('2026-10-01T00:00:00Z').getTime()

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-ddpct-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function trade(accountId: string, pnl: number, h: number, over: Partial<ClosedRow> = {}): ClosedRow {
  return {
    symbol: 'MESZ26',
    direction: 'long',
    accountId,
    exchange: 'tradestation',
    realizedPnl: pnl,
    entryAvg: null,
    exitAvg: null,
    closedAt: START + h * HOUR,
    openDate: START + (h - 1) * HOUR,
    ...over,
  }
}

function analyse(rows: ClosedRow[], from: number | null = START) {
  const balances = buildAccountBalances(db, rows, periodStartOf(from, rows))
  return {
    summary: buildSummary(rows, accountBalanceFor(rows, balances)),
    byAccount: buildAccountScorecards(rows, balances),
    byStrategy: buildStrategyScorecards(rows, balances),
  }
}

// Regression (live Terminal 0.4.35, 11/10): max DD % was relative to the P&L
// peak. Regime-Slow MES (+800 peak, -1.004,10 dip) showed ">100%", Ascender MGC
// (never positive) showed "—". It has to be a share of the account.
describe('max drawdown % against the period-start equity', () => {
  it('Regime-Slow MES: -1.004,10 on 14.369 is about -7%, no clamp', () => {
    db.insertBalanceSnapshot({ exchange: 'tradestation', accountId: 'SIM-MES', equity: 14_369, balance: 14_300, ts: START + 60_000 })
    db.insertBalanceSnapshot({ exchange: 'tradestation', accountId: 'SIM-MES', equity: 15_000, balance: 15_000, ts: START + 48 * HOUR })
    const rows = [
      trade('SIM-MES', 800, 1, { strategy: 'Regime-Slow MES', signalBotId: 'slow' }),
      trade('SIM-MES', -1004.1, 2, { strategy: 'Regime-Slow MES', signalBotId: 'slow' }),
      trade('SIM-MES', 778.1, 3, { strategy: 'Regime-Slow MES', signalBotId: 'slow' }),
    ]
    const { summary, byAccount, byStrategy } = analyse(rows)
    expect(summary.netPnl).toBeCloseTo(574, 6)
    expect(summary.maxDrawdownAbs).toBeCloseTo(-1004.1, 6)
    expect(summary.maxDrawdownPct).toBeCloseTo(-1004.1 / 14_369, 10)
    expect(summary.maxDrawdownPct).toBeCloseTo(-0.0699, 4)
    expect('maxDrawdownPctClamped' in summary).toBe(false)
    expect(byAccount[0]!.summary.maxDrawdownPct).toBeCloseTo(-0.0699, 4)
    expect(byStrategy[0]!.summary.maxDrawdownPct).toBeCloseTo(-0.0699, 4)
  })

  it('Ascender MGC, all losing: -2.858,50 on 27.319 gets a percentage instead of null', () => {
    db.insertBalanceSnapshot({ exchange: 'tradestation', accountId: 'SIM-MGC', equity: 27_319, balance: 27_319, ts: START })
    const { summary } = analyse([trade('SIM-MGC', -2858.5, 1, { symbol: 'MGCZ26' })])
    expect(summary.maxDrawdownAbs).toBe(-2858.5)
    expect(summary.maxDrawdownPct).toBeCloseTo(-2858.5 / 27_319, 10)
    expect(summary.maxDrawdownPct).toBeCloseTo(-0.1046, 4)
  })

  it('no snapshot for the account at all: null', () => {
    const { summary, byAccount } = analyse([trade('SIM-NONE', 100, 1), trade('SIM-NONE', -50, 2)])
    expect(summary.maxDrawdownAbs).toBe(-50)
    expect(summary.maxDrawdownPct).toBeNull()
    expect(byAccount[0]!.summary.maxDrawdownPct).toBeNull()
  })

  it('falls back to the last snapshot before the period start', () => {
    db.insertBalanceSnapshot({ exchange: 'tradestation', accountId: 'A', equity: 9_000, balance: 9_000, ts: START - 10 * HOUR })
    db.insertBalanceSnapshot({ exchange: 'tradestation', accountId: 'A', equity: 10_000, balance: 10_000, ts: START - HOUR })
    const { summary } = analyse([trade('A', -500, 1)])
    expect(summary.maxDrawdownPct).toBeCloseTo(-0.05, 10)
  })

  it('without a range the first trade in view is the period start', () => {
    db.insertBalanceSnapshot({ exchange: 'tradestation', accountId: 'A', equity: 5_000, balance: 5_000, ts: START - 100 * HOUR })
    db.insertBalanceSnapshot({ exchange: 'tradestation', accountId: 'A', equity: 10_000, balance: 10_000, ts: START + HOUR })
    const { summary } = analyse([trade('A', -500, 5)], null)
    expect(summary.maxDrawdownPct).toBeCloseTo(-0.05, 10)
  })

  it('a strategy row trading two accounts sums both balances; the account rows keep their own', () => {
    db.insertBalanceSnapshot({ exchange: 'tradestation', accountId: 'A', equity: 10_000, balance: 10_000, ts: START })
    db.insertBalanceSnapshot({ exchange: 'tradestation', accountId: 'B', equity: 30_000, balance: 30_000, ts: START })
    const rows = [
      trade('A', -1_000, 1, { strategy: 'Two-acct', signalBotId: 'two' }),
      trade('B', -1_000, 2, { strategy: 'Two-acct', signalBotId: 'two' }),
    ]
    const { summary, byStrategy, byAccount } = analyse(rows)
    expect(byStrategy[0]!.summary.maxDrawdownAbs).toBe(-2_000)
    expect(byStrategy[0]!.summary.maxDrawdownPct).toBeCloseTo(-2_000 / 40_000, 10)
    expect(summary.maxDrawdownPct).toBeCloseTo(-0.05, 10)
    const a = byAccount.find((c) => c.accountId === 'A')!
    const b = byAccount.find((c) => c.accountId === 'B')!
    expect(a.summary.maxDrawdownPct).toBeCloseTo(-0.1, 10)
    expect(b.summary.maxDrawdownPct).toBeCloseTo(-1_000 / 30_000, 10)
  })

  it('a strategy row is null when one of its accounts has no balance', () => {
    db.insertBalanceSnapshot({ exchange: 'tradestation', accountId: 'A', equity: 10_000, balance: 10_000, ts: START })
    const rows = [trade('A', -100, 1, { signalBotId: 'x' }), trade('B', -100, 2, { signalBotId: 'x' })]
    expect(analyse(rows).byStrategy[0]!.summary.maxDrawdownPct).toBeNull()
  })

  it('keys balances by exchange as well as account', () => {
    db.insertBalanceSnapshot({ exchange: 'bybit', accountId: 'A', equity: 1_000, balance: 1_000, ts: START })
    expect(analyse([trade('A', -100, 1)]).summary.maxDrawdownPct).toBeNull()
  })
})

// Review 11/10: a tick holds one row per coin wallet. Taking one row (LIMIT 1)
// read the Bybit UTA as its USDT wallet (-1,39 or 1,39) instead of the account.
describe('multi-wallet ticks', () => {
  it('sums usd_equity over every wallet of the tick', () => {
    db.insertBalanceSnapshot({ exchange: 'bybit', accountId: 'unified', equity: -1.39, balance: -1.39, currency: 'USDT', ts: START })
    db.insertBalanceSnapshot({
      exchange: 'bybit', accountId: 'unified', equity: 0.25, balance: 0.25, currency: 'BTC', ts: START, usdEquity: 15_000,
    })
    const rows = [trade('unified', -1_500, 1, { exchange: 'bybit' })]
    const balances = buildAccountBalances(db, rows, START)
    expect(balances.get('bybit|unified')).toBeCloseTo(14_998.61, 6)
    expect(analyse(rows).summary.maxDrawdownPct).toBeCloseTo(-1_500 / 14_998.61, 10)
  })

  it('a near-zero USDC wallet next to priced collateral does not become the denominator', () => {
    db.insertBalanceSnapshot({ exchange: 'bybit', accountId: 'unified', equity: 1.39, balance: 1.39, currency: 'USDC', ts: START })
    db.insertBalanceSnapshot({
      exchange: 'bybit', accountId: 'unified', equity: 5, balance: 5, currency: 'ETH', ts: START, usdEquity: 15_000,
    })
    const { summary } = analyse([trade('unified', -2858.5, 1, { exchange: 'bybit' })])
    expect(summary.maxDrawdownPct).toBeCloseTo(-2858.5 / 15_001.39, 10)
    expect(summary.maxDrawdownPct!).toBeGreaterThan(-0.2)
  })

  it('leaves unpriced coin wallets out of the sum', () => {
    db.insertBalanceSnapshot({ exchange: 'bybit', accountId: 'unified', equity: 10_000, balance: 10_000, currency: 'USDT', ts: START })
    db.insertBalanceSnapshot({
      exchange: 'bybit', accountId: 'unified', equity: 100, balance: 100, currency: 'SOL', ts: START, usdEquity: null,
    })
    expect(analyse([trade('unified', -500, 1, { exchange: 'bybit' })]).summary.maxDrawdownPct).toBeCloseTo(-0.05, 10)
  })

  it('an account with only <= 0 rows and no usd_equity is null', () => {
    db.insertBalanceSnapshot({
      exchange: 'bybit', accountId: 'unified', equity: 0, balance: 0, currency: 'BTC', ts: START, usdEquity: null,
    })
    db.insertBalanceSnapshot({
      exchange: 'bybit', accountId: 'unified', equity: -2, balance: -2, currency: 'ETH', ts: START + HOUR, usdEquity: null,
    })
    expect(analyse([trade('unified', -500, 1, { exchange: 'bybit' })]).summary.maxDrawdownPct).toBeNull()
  })

  it('a tick whose priced sum is <= 0 is null', () => {
    db.insertBalanceSnapshot({ exchange: 'bybit', accountId: 'unified', equity: -1.39, balance: -1.39, currency: 'USDT', ts: START })
    expect(analyse([trade('unified', -500, 1, { exchange: 'bybit' })]).summary.maxDrawdownPct).toBeNull()
  })
})

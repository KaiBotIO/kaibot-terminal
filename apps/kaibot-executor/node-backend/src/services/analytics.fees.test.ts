import { describe, expect, it } from 'bun:test'
import {
  buildAccountScorecards,
  buildStrategyScorecards,
  buildSummary,
  closedRowsFromExecutions,
  UNATTRIBUTED_ACCOUNT,
  type ClosedRow,
} from './analytics.js'
import type { SignalFillRow } from '../storage/types.js'

const T0 = new Date('2026-09-20T12:00:00Z').getTime()
const HOUR = 3_600_000

function row(over: Partial<ClosedRow> & { realizedPnl: number }): ClosedRow {
  return {
    symbol: 'MESU26',
    direction: 'long',
    entryAvg: null,
    exitAvg: null,
    closedAt: T0,
    openDate: T0 - HOUR,
    ...over,
  }
}

describe('buildSummary fees', () => {
  it('totals fees and reports gross next to net', () => {
    const s = buildSummary([
      row({ realizedPnl: 100, grossPnl: 102.5, commission: 2.5 }),
      row({ realizedPnl: -50, grossPnl: -48.76, commission: 1.24 }),
    ])
    expect(s.netPnl).toBe(50)
    expect(s.commission).toBeCloseTo(3.74, 10)
    expect(s.grossPnl).toBeCloseTo(53.74, 10)
  })

  it('treats rows without a fee as zero fee', () => {
    const s = buildSummary([row({ realizedPnl: 10 })])
    expect(s.commission).toBe(0)
    expect(s.grossPnl).toBe(10)
  })

  it('is zero on an empty book', () => {
    expect(buildSummary([])).toMatchObject({ grossPnl: 0, commission: 0 })
  })
})

describe('buildAccountScorecards', () => {
  const rows = [
    row({ realizedPnl: 10, commission: 1, accountId: 'acct1/eth', exchange: 'deribit', closedAt: T0 }),
    row({ realizedPnl: -4, commission: 0.5, accountId: 'acct1/eth', exchange: 'deribit', closedAt: T0 + HOUR }),
    row({ realizedPnl: 30, commission: 2, accountId: '21084931', exchange: 'tradestation', closedAt: T0 + 2 * HOUR }),
    row({ realizedPnl: 1, accountId: null, closedAt: T0 + 3 * HOUR }),
  ]

  it('groups by broker account with the same metrics as the strategy table', () => {
    const cards = buildAccountScorecards(rows)
    expect(cards.map((c) => c.key)).toEqual(['21084931', 'acct1/eth', UNATTRIBUTED_ACCOUNT])
    const eth = cards.find((c) => c.key === 'acct1/eth')!
    expect(eth.account).toBe('deribit · acct1/eth')
    expect(eth.exchange).toBe('deribit')
    expect(eth.summary.totalTrades).toBe(2)
    expect(eth.summary.netPnl).toBe(6)
    expect(eth.summary.commission).toBe(1.5)
    expect(eth.summary.grossPnl).toBe(7.5)
    expect(eth.curve.map((p) => p.pnl)).toEqual([10, 6])
    expect(eth.firstTradeAt).toBe(T0)
    expect(eth.lastTradeAt).toBe(T0 + HOUR)
  })

  it('sorts best net first and rows without an account last', () => {
    const cards = buildAccountScorecards(rows)
    expect(cards[0]!.summary.netPnl).toBe(30)
    expect(cards[cards.length - 1]!.accountId).toBeNull()
    expect(cards[cards.length - 1]!.account).toBe(UNATTRIBUTED_ACCOUNT)
  })

  it('adds up to the panel totals, like the strategy split does', () => {
    const total = buildSummary(rows)
    const byAccount = buildAccountScorecards(rows)
    const byStrategy = buildStrategyScorecards(rows)
    const sum = (cards: Array<{ summary: { netPnl: number; commission: number } }>) =>
      cards.reduce((s, c) => s + c.summary.netPnl, 0)
    expect(sum(byAccount)).toBeCloseTo(total.netPnl, 10)
    expect(sum(byStrategy)).toBeCloseTo(total.netPnl, 10)
    expect(byAccount.reduce((s, c) => s + c.summary.commission, 0)).toBeCloseTo(total.commission, 10)
  })
})

describe('closedRowsFromExecutions fees', () => {
  const fill = (over: Partial<SignalFillRow>): SignalFillRow => ({
    id: 1,
    signal_id: 'sig',
    kind: 'entry',
    symbol: 'MESU26',
    side: 'buy',
    qty: 1,
    price: 7700,
    commission: 0,
    order_id: null,
    created_at: T0,
    ...over,
  })

  it('carries gross, fees and net per closed trade', () => {
    const rows = closedRowsFromExecutions(
      [{ signal_id: 'sig', symbol: 'MESU26', direction: 'long', status: 'closed', qty_opened: 1, qty_closed: 1, exchange: 'tradestation', account_id: 'A' }],
      new Map([
        ['sig', [
          fill({ kind: 'entry', side: 'buy', price: 7700, commission: 0.62, created_at: T0 - HOUR }),
          fill({ kind: 'exit', side: 'sell', price: 7702, commission: 0.62, created_at: T0 }),
        ]],
      ]),
    )
    expect(rows).toHaveLength(1)
    // MES = $5/point: 2 points × 5 = $10 gross
    expect(rows[0]!.grossPnl).toBeCloseTo(10, 10)
    expect(rows[0]!.commission).toBeCloseTo(1.24, 10)
    expect(rows[0]!.realizedPnl).toBeCloseTo(8.76, 10)
    expect(rows[0]!.exchange).toBe('tradestation')
    expect(rows[0]!.accountId).toBe('A')
  })
})

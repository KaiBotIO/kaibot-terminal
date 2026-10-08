import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  utcDayStartMs,
  realizedPnlSince,
  realizedPnlTodayUtc,
  contractKindOf,
  type DailyRealizedInput,
  type SkippedExecution,
} from './daily-pnl.js'
import { KaiBotDatabase } from '../storage/database.js'
import type { SignalFillRow } from '../storage/types.js'

const fill = (over: Partial<SignalFillRow>): SignalFillRow => ({
  id: 0,
  signal_id: 's',
  kind: 'entry',
  symbol: 'BTCUSDT',
  side: 'buy',
  qty: 1,
  price: 100,
  commission: 0,
  order_id: null,
  created_at: 0,
  ...over,
})

// ─── utcDayStartMs ───

test('utcDayStartMs floors to 00:00:00.000 UTC of the same day', () => {
  const noonUtc = Date.UTC(2026, 5, 20, 12, 30, 45, 123)
  expect(utcDayStartMs(noonUtc)).toBe(Date.UTC(2026, 5, 20))
})

test('utcDayStartMs at exactly midnight returns the same instant', () => {
  const mid = Date.UTC(2026, 5, 20)
  expect(utcDayStartMs(mid)).toBe(mid)
})

// ─── realizedPnlSince ───

const DAY = Date.UTC(2026, 5, 20)
const longClosed = (signalId: string, entry: number, exit: number, qty: number, exitAt: number): DailyRealizedInput => ({
  exec: { exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long', status: 'closed' },
  fills: [
    fill({ signal_id: signalId, kind: 'entry', side: 'buy', qty, price: entry, created_at: DAY - 60_000 }),
    fill({ signal_id: signalId, kind: 'exit', side: 'sell', qty, price: exit, created_at: exitAt }),
  ],
})

test('sums realized net for signals closed today (a winner and a loser net out)', () => {
  const inputs = [
    longClosed('win', 100, 110, 1, DAY + 1_000), // +10
    longClosed('loss', 100, 95, 2, DAY + 2_000), // -10
  ]
  expect(realizedPnlSince(inputs, DAY)).toBeCloseTo(0, 6)
})

test('a single losing day produces a negative total', () => {
  const inputs = [longClosed('loss', 100, 90, 3, DAY + 5_000)] // (100-90)*-1*3 = -30
  expect(realizedPnlSince(inputs, DAY)).toBeCloseTo(-30, 6)
})

test('signals whose last exit fill is before the cutoff are excluded', () => {
  const inputs = [
    longClosed('yesterday', 100, 80, 5, DAY - 10_000), // closed before 00:00 UTC → ignored
    longClosed('today', 100, 90, 1, DAY + 10_000), // -10
  ]
  expect(realizedPnlSince(inputs, DAY)).toBeCloseTo(-10, 6)
})

test('open signals with no exit fill contribute nothing', () => {
  const inputs: DailyRealizedInput[] = [
    {
      exec: { exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long', status: 'open' },
      fills: [fill({ signal_id: 'open', kind: 'entry', side: 'buy', qty: 1, price: 100, created_at: DAY + 1 })],
    },
  ]
  expect(realizedPnlSince(inputs, DAY)).toBe(0)
})

test('a short closed today realizes profit when price fell', () => {
  const inputs: DailyRealizedInput[] = [
    {
      exec: { exchange: 'bybit', symbol: 'BTCUSDT', direction: 'short', status: 'closed' },
      fills: [
        fill({ signal_id: 'sh', kind: 'entry', side: 'sell', qty: 2, price: 100, created_at: DAY }),
        fill({ signal_id: 'sh', kind: 'exit', side: 'buy', qty: 2, price: 90, created_at: DAY + 100 }), // +20
      ],
    },
  ]
  expect(realizedPnlSince(inputs, DAY)).toBeCloseTo(20, 6)
})

// ─── contract kinds (06/10 incident: inverse perp read as linear) ───

const closed = (
  exchange: string | null,
  symbol: string,
  direction: 'long' | 'short',
  qty: number,
  entry: number,
  exit: number,
): DailyRealizedInput => ({
  exec: { signal_id: `${exchange}:${symbol}`, exchange, symbol, direction, status: 'closed' },
  fills: [
    fill({ kind: 'entry', symbol, qty, price: entry, created_at: DAY - 60_000 }),
    fill({ kind: 'exit', symbol, qty, price: exit, created_at: DAY + 60_000 }),
  ],
})

describe('realizedPnlSince per contract kind', () => {
  test('Deribit ETH-PERPETUAL inverse: qty is USD notional, not coins', () => {
    const pnl = realizedPnlSince([closed('deribit', 'ETH-PERPETUAL', 'long', 6424, 2718.45, 2710.6)], DAY)
    expect(pnl).toBeCloseTo((6424 * (2710.6 - 2718.45)) / 2718.45, 6)
    expect(pnl).toBeGreaterThan(-19)
    expect(pnl).toBeLessThan(-18)
  })

  test('Deribit BTC-PERPETUAL inverse short', () => {
    const pnl = realizedPnlSince([closed('deribit', 'BTC-PERPETUAL', 'short', 2950, 86000, 85555)], DAY)
    expect(pnl).toBeCloseTo((2950 * 445) / 86000, 6)
  })

  test('TradeStation MES and MGC use the contract multiplier', () => {
    expect(realizedPnlSince([closed('tradestation', 'MESZ26', 'long', 1, 7900, 7877)], DAY)).toBeCloseTo(-115, 6)
    expect(realizedPnlSince([closed('tradestation', 'MGCZ26', 'short', 2, 4500, 4490)], DAY)).toBeCloseTo(200, 6)
  })

  test('Bybit linear USDT and Deribit USDC perps stay qty x move', () => {
    expect(realizedPnlSince([closed('bybit', 'SOLUSDT', 'long', 10, 150, 147)], DAY)).toBeCloseTo(-30, 6)
    expect(realizedPnlSince([closed('deribit', 'BTC_USDC-PERPETUAL', 'long', 0.1, 86000, 85000)], DAY)).toBeCloseTo(-100, 6)
  })

  test('unknown contract kind is skipped and reported, never guessed linear', () => {
    const skipped: SkippedExecution[] = []
    const pnl = realizedPnlSince(
      [
        closed(null, 'ETH-PERPETUAL', 'long', 6424, 2718.45, 2710.6),
        closed('tradestation', 'CLZ26', 'long', 1, 70, 60),
        closed('bybit', 'SOLUSDT', 'long', 10, 150, 147),
      ],
      DAY,
      (s) => skipped.push(s),
    )
    expect(pnl).toBeCloseTo(-30, 6)
    expect(skipped.map((s) => s.symbol)).toEqual(['ETH-PERPETUAL', 'CLZ26'])
  })

  test('contractKindOf', () => {
    expect(contractKindOf('deribit', 'BTC-PERPETUAL')).toBe('inverse')
    expect(contractKindOf('bybit', 'BTCUSD')).toBe('inverse')
    expect(contractKindOf('bybit', 'BTCUSDT')).toBe('linear')
    expect(contractKindOf('tradestation', 'MES')).toBe('future')
    expect(contractKindOf('tradestation', 'MESZ26')).toBe('future')
    expect(contractKindOf('tradestation', 'AAPL')).toBe('linear')
    expect(contractKindOf('tradestation', 'CLZ26')).toBeNull()
    expect(contractKindOf(null, 'BTC-PERPETUAL')).toBeNull()
    expect(contractKindOf('kraken', 'XBTUSD')).toBeNull()
  })
})

describe('realizedPnlTodayUtc (DB-wired)', () => {
  let dir: string
  let db: KaiBotDatabase
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kaibot-daily-pnl-'))
    db = new KaiBotDatabase(join(dir, 'test.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('reads the exchange off the execution row: the ETH ride is ~-18,5 USD, not -50.428', () => {
    const now = Date.now()
    db.insertSignalExecution({ signalId: 'eth-ride', symbol: 'ETH-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'closed', qtyOpened: 6424, qtyClosed: 6424, createdAtMs: now })
    db.insertSignalFill({ signalId: 'eth-ride', kind: 'entry', symbol: 'ETH-PERPETUAL', side: 'buy', qty: 6424, price: 2718.45, createdAtMs: now - 3_600_000 })
    db.insertSignalFill({ signalId: 'eth-ride', kind: 'exit', symbol: 'ETH-PERPETUAL', side: 'sell', qty: 6424, price: 2710.6, createdAtMs: now })
    const pnl = realizedPnlTodayUtc(db)
    expect(pnl).toBeCloseTo((6424 * (2710.6 - 2718.45)) / 2718.45, 6)
  })

  // 06/10: the TS account's limit was checked against a sum over every venue.
  const closeTrade = (id: string, exchange: string, accountId: string | null, symbol: string, entry: number, exit: number, qty: number) => {
    const now = Date.now()
    db.insertSignalExecution({ signalId: id, symbol, exchange, direction: 'long', status: 'closed', qtyOpened: qty, qtyClosed: qty, accountId, createdAtMs: now })
    db.insertSignalFill({ signalId: id, kind: 'entry', symbol, side: 'buy', qty, price: entry, createdAtMs: now - 60_000 })
    db.insertSignalFill({ signalId: id, kind: 'exit', symbol, side: 'sell', qty, price: exit, createdAtMs: now })
  }

  test('scoped: a Deribit loss does not count toward a TradeStation account', () => {
    closeTrade('eth-ride', 'deribit', 'eth', 'ETH-PERPETUAL', 2718.45, 2710.6, 6424)
    closeTrade('mes', 'tradestation', '21084933', 'MESZ26', 7880, 7878, 1) // -10
    expect(realizedPnlTodayUtc(db, { exchange: 'tradestation', accountId: '21084933' })).toBeCloseTo(-10, 6)
    expect(realizedPnlTodayUtc(db, { exchange: 'deribit', accountId: 'eth' })).toBeCloseTo((6424 * -7.85) / 2718.45, 6)
    expect(realizedPnlTodayUtc(db)).toBeCloseTo(-10 + (6424 * -7.85) / 2718.45, 6)
  })

  test('scoped: another account on the same venue does not count', () => {
    closeTrade('a', 'tradestation', '21084931', 'MESZ26', 7880, 7780, 1) // -500
    closeTrade('b', 'tradestation', '21084936', 'MESZ26', 7880, 7870, 1) // -50
    expect(realizedPnlTodayUtc(db, { exchange: 'tradestation', accountId: '21084936' })).toBeCloseTo(-50, 6)
    expect(realizedPnlTodayUtc(db, { exchange: 'tradestation', accountId: '21084933' })).toBe(0)
  })

  test('scoped: an execution without an account is left out, not guessed onto one', () => {
    closeTrade('legacy', 'tradestation', null, 'MESZ26', 7880, 7780, 1)
    expect(realizedPnlTodayUtc(db, { exchange: 'tradestation', accountId: '21084933' })).toBe(0)
    expect(realizedPnlTodayUtc(db)).toBeCloseTo(-500, 6)
  })
})

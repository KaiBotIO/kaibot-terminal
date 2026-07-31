import { test, expect } from 'bun:test'
import { utcDayStartMs, realizedPnlSince, type DailyRealizedInput } from './daily-pnl.js'
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
  exec: { symbol: 'BTCUSDT', direction: 'long', status: 'closed' },
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
      exec: { symbol: 'BTCUSDT', direction: 'long', status: 'open' },
      fills: [fill({ signal_id: 'open', kind: 'entry', side: 'buy', qty: 1, price: 100, created_at: DAY + 1 })],
    },
  ]
  expect(realizedPnlSince(inputs, DAY)).toBe(0)
})

test('a short closed today realizes profit when price fell', () => {
  const inputs: DailyRealizedInput[] = [
    {
      exec: { symbol: 'BTCUSDT', direction: 'short', status: 'closed' },
      fills: [
        fill({ signal_id: 'sh', kind: 'entry', side: 'sell', qty: 2, price: 100, created_at: DAY }),
        fill({ signal_id: 'sh', kind: 'exit', side: 'buy', qty: 2, price: 90, created_at: DAY + 100 }), // +20
      ],
    },
  ]
  expect(realizedPnlSince(inputs, DAY)).toBeCloseTo(20, 6)
})

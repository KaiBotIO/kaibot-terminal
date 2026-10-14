import { test, expect, describe, it } from 'bun:test'
import {
  mapTradeStationOrderStatus,
  resolveTradeStationTif,
  tsPriceString,
  TS_TERMINAL,
} from './tradestation-orders.js'

// Regression (live-money): protective bracket legs were placed with TIF=DAY, so
// the broker-side stop/take-profit was killed at Globex session close (status
// DON), leaving an overnight futures position UNPROTECTED until reopen. A
// reduce-only leg with no explicit TIF must default to GTC so it survives.
test('reduce-only leg with no explicit TIF resolves to GTC (survives session close)', () => {
  // Pre-fix this returned 'DAY' — the overnight-exposure bug.
  expect(resolveTradeStationTif({ reduceOnly: true })).toBe('GTC')
})

test('non-reduce-only order with no explicit TIF keeps the DAY default', () => {
  // Entry orders are re-issued on reopen / market entries ignore TIF, so DAY stays.
  expect(resolveTradeStationTif({})).toBe('DAY')
  expect(resolveTradeStationTif({ reduceOnly: false })).toBe('DAY')
})

test('an explicit timeInForce is always honored, even on a reduce-only leg', () => {
  expect(resolveTradeStationTif({ reduceOnly: true, timeInForce: 'DAY' })).toBe('DAY')
  expect(resolveTradeStationTif({ reduceOnly: true, timeInForce: 'GTC' })).toBe('GTC')
  expect(resolveTradeStationTif({ timeInForce: 'IOC' })).toBe('IOC')
  expect(resolveTradeStationTif({ timeInForce: 'FOK' })).toBe('FOK')
})

// Regression: execution hung permanently in 'closing'. A market close order placed
// while the session was shut (Globex closed on a Sunday) ends DON (done-for-day) and
// never fills, but DON was mapped to 'filled' — so settleClose reported a false close
// and retryPendingCloses never re-issued it. DON must map to a non-fill terminal.
// Ref: kaibot-exec cebd203.
test('DON with no fill maps to cancelled (retryable, not a phantom fill)', () => {
  const s = mapTradeStationOrderStatus('101', {
    Status: 'DON',
    Legs: [{ ExecQuantity: '0', QuantityOrdered: '2' }],
  })
  expect(s.state).toBe('cancelled')
  expect(s.filledQuantity ?? 0).toBe(0)
})

test('DON never reports QuantityOrdered as filled', () => {
  // The bug: the FLL branch fell back to QuantityOrdered, so a zero-fill DON looked
  // like a full fill. A DON must only ever count what actually executed.
  const s = mapTradeStationOrderStatus('102', {
    Status: 'DON',
    Legs: [{ QuantityOrdered: '3' }],
  })
  expect(s.state).toBe('cancelled')
})

test('DON with a partial fill before the kill is preserved (not re-traded)', () => {
  const s = mapTradeStationOrderStatus('103', {
    Status: 'DON',
    FilledPrice: '4200',
    Legs: [{ ExecQuantity: '1', QuantityOrdered: '3', ExecutionPrice: '4200' }],
  })
  expect(s.state).toBe('partially_filled')
  expect(s.filledQuantity).toBe(1)
  expect(s.averagePrice).toBe(4200)
})

test('FLL still maps to filled with the executed quantity', () => {
  const s = mapTradeStationOrderStatus('104', {
    Status: 'FLL',
    FilledPrice: '4200',
    Legs: [{ ExecQuantity: '2', ExecutionPrice: '4200' }],
  })
  expect(s.state).toBe('filled')
  expect(s.filledQuantity).toBe(2)
  expect(s.averagePrice).toBe(4200)
})

test('DON stays a terminal status (does not read as still-working)', () => {
  expect(TS_TERMINAL.has('DON')).toBe(true)
})

test('REJ maps to rejected, CAN/EXP/OUT to cancelled', () => {
  expect(mapTradeStationOrderStatus('1', { Status: 'REJ' }).state).toBe('rejected')
  for (const st of ['CAN', 'EXP', 'OUT', 'BRC']) {
    expect(mapTradeStationOrderStatus('1', { Status: st }).state).toBe('cancelled')
  }
})

// vangnet 2026-08-24: float-tail prices (29233.5 * 0.95 = 27771.824999999997)
// were serialized verbatim and hard-rejected by TradeStation ("Max 8 decimal
// places supported for 'StopPrice'") — the ascender sync entry lost its venue
// backstop. Wire prices must always be within 8 decimals.
describe('tsPriceString', () => {
  it('cuts float tails to a TradeStation-acceptable string', () => {
    expect(tsPriceString(29233.5 * 0.95)).toBe('27771.825')
    expect(tsPriceString(25014.25)).toBe('25014.25')
    expect(tsPriceString(7157.5)).toBe('7157.5')
  })
  it('passes through absent/invalid values as undefined', () => {
    expect(tsPriceString(undefined)).toBeUndefined()
    expect(tsPriceString(null)).toBeUndefined()
    expect(tsPriceString(Number.NaN)).toBeUndefined()
  })
})

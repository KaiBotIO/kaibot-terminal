import { test, expect, describe, it } from 'bun:test'
import {
  fetchTradeStationWorkingOrders,
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

// DON is "Queued" in the TradeStation v3 API, not done-for-day: a GTC stop after
// the 21:00 UTC session close, or a market order sent into a shut session, rests
// queued and fills at reopen. Reading it as cancelled dropped the live MES stop
// 1324503597 on 16/10 21:00 (and re-sent queued closes on top of themselves).
test('DON (queued) with no fill is a live, working order', () => {
  const s = mapTradeStationOrderStatus('101', {
    Status: 'DON',
    StatusDescription: 'Queued',
    Duration: 'GTC',
    Legs: [{ ExecQuantity: '0', QuantityOrdered: '2' }],
  })
  expect(s.state).toBe('working')
  expect(s.queued).toBe(true)
  expect(s.filledQuantity ?? 0).toBe(0)
})

test('DON never reports QuantityOrdered as filled', () => {
  const s = mapTradeStationOrderStatus('102', {
    Status: 'DON',
    Legs: [{ QuantityOrdered: '3' }],
  })
  expect(s.state).toBe('working')
  expect(s.filledQuantity ?? 0).toBe(0)
})

test('DON with a fill already on it keeps the fill and stays live', () => {
  const s = mapTradeStationOrderStatus('103', {
    Status: 'DON',
    FilledPrice: '4200',
    Legs: [{ ExecQuantity: '1', QuantityOrdered: '3', ExecutionPrice: '4200' }],
  })
  expect(s.state).toBe('working')
  expect(s.queued).toBe(true)
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

test('a queued order cancelled after a partial keeps the partial (terminal partial, no re-trade)', () => {
  const s = mapTradeStationOrderStatus('105', {
    Status: 'CAN',
    FilledPrice: '5890',
    Legs: [{ ExecQuantity: '1', QuantityOrdered: '3' }],
  })
  expect(s.state).toBe('partially_filled')
  expect(s.filledQuantity).toBe(1)
  expect(s.averagePrice).toBe(5890)
})

test('DON is not a terminal status', () => {
  expect(TS_TERMINAL.has('DON')).toBe(false)
})

describe('fetchTradeStationWorkingOrders', () => {
  const row = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    OrderID: id,
    AccountID: '21084931',
    Status: status,
    OrderType: 'StopMarket',
    StopPrice: '5800',
    Legs: [{ Symbol: 'MESZ26', BuyOrSell: 'Sell', QuantityOrdered: '1' }],
    ...extra,
  })

  it('lists working and queued orders, skips the terminal rows of the day', async () => {
    const orders = await fetchTradeStationWorkingOrders(
      async () => ({ Orders: [row('1', 'DON'), row('2', 'ACK'), row('3', 'CAN'), row('4', 'FLL'), row('5', 'OPN', { AccountID: 'other' })] }),
      '21084931',
    )
    expect(orders.map((o) => [o.orderId, o.state])).toEqual([
      ['1', 'DON'],
      ['2', 'ACK'],
    ])
    expect(orders[0]).toMatchObject({ symbol: 'MESZ26', side: 'sell', type: 'StopMarket', triggerPrice: 5800, amount: 1 })
  })

  it('throws when the venue answers without an order list', async () => {
    await expect(fetchTradeStationWorkingOrders(async () => ({}), '21084931')).rejects.toThrow()
  })
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

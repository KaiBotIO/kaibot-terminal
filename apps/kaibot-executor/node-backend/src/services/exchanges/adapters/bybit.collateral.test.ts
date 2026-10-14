import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { BybitSim } from './bybit-sim.fixture.js'
import type { Order } from '../types.js'

let sim: BybitSim
beforeEach(() => {
  sim = new BybitSim()
  sim.prices = { BTCUSDT: 100_000, ETHUSDT: 4_000, SOLUSDT: 200 }
  sim.wallet = { BTC: 0.2, ETH: 10, SOL: 100, USDT: -1_250.5 }
  sim.install()
})
afterEach(() => sim.uninstall())

describe('Bybit UTA collateral wallet', () => {
  it('parses coins, collateral flags, the USDT loan and the account rates', async () => {
    sim.collateralOff.add('SOL')
    sim.mmRate = 0.42
    const w = await sim.adapter().getCollateralWallet()
    expect(w.accountType).toBe('UNIFIED')
    expect(w.accountMMRate).toBe(0.42)
    const byCoin = Object.fromEntries(w.coins.map((c) => [c.coin, c]))
    expect(byCoin.BTC.walletBalance).toBe(0.2)
    expect(byCoin.BTC.usdValue).toBe(20_000)
    expect(byCoin.SOL.collateralSwitch).toBe(false)
    expect(byCoin.USDT.walletBalance).toBe(-1_250.5)
    expect(byCoin.USDT.borrowAmount).toBe(1_250.5)
  })

  it('getBalances keeps the negative USDT row (a loan is not an empty wallet)', async () => {
    const rows = await sim.adapter().getBalances()
    expect(rows.find((b) => b.currency === 'USDT')?.balance).toBe(-1_250.5)
  })

  it('account margin is the venue USD figure, not one wallet row', async () => {
    const m = await sim.adapter().getAccountMargin()
    // 0,2 × 100k + 10 × 4k + 100 × 200 − 1.250,5
    expect(m!.equityUsd).toBeCloseTo(78_749.5, 6)
    expect(m!.initialMarginUsd).toBeCloseTo(7_874.95, 6)
    expect(m!.mmRate).toBe(0.05)
  })

  it('tiered collateral ratios from the public endpoint', async () => {
    const tiers = await sim.adapter().getCollateralRatioTiers(['BTC', 'SOL', 'DOGE'])
    expect(tiers.get('BTC')).toEqual([{ minQty: 0, maxQty: null, ratio: 0.95 }])
    expect(tiers.get('SOL')![1]).toEqual({ minQty: 50_000, maxQty: null, ratio: 0.5 })
    expect(tiers.has('DOGE')).toBe(false)
  })
})

describe('Bybit spot conditionals (collateral-floor sell)', () => {
  it('places a resting StopOrder sell in base coin, stepped on basePrecision', async () => {
    const a = sim.adapter()
    const res = await a.placeOrder({
      accountId: 'unified', symbol: 'BTCUSDT', side: 'sell', orderType: 'stop', quantity: 0.2000004,
      stopPrice: 85_000.004, clientOrderId: 'kbcf-s0-abc', category: 'spot',
    } as Order)
    const create = sim.requests.find((r) => r.path === '/v5/order/create')!.params
    expect(create).toMatchObject({
      category: 'spot', side: 'Sell', orderType: 'Market', orderFilter: 'StopOrder', qty: '0.200000',
      triggerPrice: '85000.00', marketUnit: 'baseCoin', orderLinkId: 'kbcf-s0-abc',
    })
    expect(res.status).toBe('pending')
    expect(sim.openOrders()).toHaveLength(1)
  })

  it('a quote-unit market buy (buy-back with the proceeds) steps on quotePrecision and skips minOrderQty', async () => {
    await sim.adapter().placeOrder({
      accountId: 'unified', symbol: 'BTCUSDT', side: 'buy', orderType: 'stop', quantity: 16_983.123456789,
      stopPrice: 90_000, category: 'spot', marketUnit: 'quoteCoin',
    } as Order)
    const create = sim.requests.find((r) => r.path === '/v5/order/create')!.params
    expect(create.marketUnit).toBe('quoteCoin')
    expect(create.qty).toBe('16983.1234567')
  })

  it('cancel and status of a spot conditional carry orderFilter StopOrder', async () => {
    const a = sim.adapter()
    const { orderId } = await a.placeOrder({
      accountId: 'unified', symbol: 'ETHUSDT', side: 'sell', orderType: 'stop', quantity: 10, stopPrice: 3_400, category: 'spot',
    } as Order)
    const st = await a.getOrderStatus(orderId, { symbol: 'ETHUSDT', category: 'spot', orderFilter: 'StopOrder' })
    expect(st.state).toBe('working')
    expect(sim.requests.filter((r) => r.path === '/v5/order/realtime').at(-1)!.params.orderFilter).toBe('StopOrder')
    await a.cancelOrder(orderId, { symbol: 'ETHUSDT', category: 'spot', orderFilter: 'StopOrder' })
    const cancel = sim.requests.find((r) => r.path === '/v5/order/cancel')!.params
    expect(cancel).toMatchObject({ category: 'spot', symbol: 'ETHUSDT', orderFilter: 'StopOrder' })
    expect(sim.openOrders()).toHaveLength(0)
  })

  it('instrument filters are cached per category (BTCUSDT spot ≠ BTCUSDT perp)', async () => {
    const a = sim.adapter()
    const spot = await a.getInstrument('BTCUSDT', 'spot')
    const perp = await a.getInstrument('BTCUSDT', 'linear')
    expect(spot.qtyStep).toBe(0.000001)
    expect(perp.qtyStep).toBe(0.001)
  })

  it('amend moves the trigger of the resting order in place', async () => {
    const a = sim.adapter()
    const { orderId } = await a.placeOrder({
      accountId: 'unified', symbol: 'BTCUSDT', side: 'sell', orderType: 'stop', quantity: 0.2, stopPrice: 85_000, category: 'spot',
    } as Order)
    await a.amendOrder(orderId, { symbol: 'BTCUSDT', category: 'spot' }, { triggerPrice: 90_000 })
    expect(sim.openOrders()[0].triggerPrice).toBe(90_000)
  })
})

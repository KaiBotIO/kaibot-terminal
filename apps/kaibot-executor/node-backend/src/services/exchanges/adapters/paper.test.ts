import { describe, expect, it } from 'bun:test'
import { PaperExchangeAdapter } from './paper.js'

describe('PaperExchangeAdapter', () => {
  it('fills a market buy and opens a long at the mark price', async () => {
    const a = new PaperExchangeAdapter('deribit', { 'BTC-PERPETUAL': 60000 })
    const res = await a.placeOrder({
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      side: 'buy',
      orderType: 'market',
      quantity: 10,
    })
    expect(res.status).toBe('filled')
    expect(res.filledQuantity).toBe(10)
    expect(res.averagePrice).toBe(60000)

    const positions = await a.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0]).toMatchObject({ side: 'long', size: 10, entryPrice: 60000 })
  })

  it('reduce-only close flattens the position and never flips it', async () => {
    const a = new PaperExchangeAdapter('deribit', { 'BTC-PERPETUAL': 60000 })
    await a.placeOrder({ accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'buy', orderType: 'market', quantity: 10 })

    a.setMarkPrice('BTC-PERPETUAL', 61000)
    const close = await a.placeOrder({
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      side: 'sell',
      orderType: 'market',
      quantity: 25, // larger than the position
      reduceOnly: true,
    })
    expect(close.filledQuantity).toBe(10) // clipped to the live size
    expect(await a.getPositions()).toHaveLength(0)
  })

  it('partial reduce-only close keeps the position open', async () => {
    const a = new PaperExchangeAdapter('deribit', { 'BTC-PERPETUAL': 60000 })
    await a.placeOrder({ accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'buy', orderType: 'market', quantity: 10 })
    await a.placeOrder({ accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'sell', orderType: 'market', quantity: 4, reduceOnly: true })
    const positions = await a.getPositions()
    expect(positions[0].size).toBe(6)
  })

  it('rejects an order when reject mode is armed', async () => {
    const a = new PaperExchangeAdapter('deribit', { 'BTC-PERPETUAL': 60000 })
    a.rejectNextOrder('insufficient margin')
    const res = await a.placeOrder({ accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'buy', orderType: 'market', quantity: 1 })
    expect(res.status).toBe('rejected')
    expect(res.message).toBe('insufficient margin')
    expect(await a.getPositions()).toHaveLength(0)

    // reject-once cleared after one order
    const ok = await a.placeOrder({ accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'buy', orderType: 'market', quantity: 1 })
    expect(ok.status).toBe('filled')
  })

  it('records bracket legs as working resting orders that do not fill', async () => {
    const a = new PaperExchangeAdapter('deribit', { 'BTC-PERPETUAL': 60000 })
    await a.placeOrder({ accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'buy', orderType: 'market', quantity: 10 })
    const sl = await a.placeOrder({
      accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'sell', orderType: 'stop',
      quantity: 10, stopPrice: 59000, reduceOnly: true,
    })
    const status = await a.getOrderStatus(sl.orderId)
    expect(status.state).toBe('working')
    // Position untouched by the resting bracket.
    expect((await a.getPositions())[0].size).toBe(10)
  })

  it('getOrderStatus reports a filled market order for settlement polling', async () => {
    const a = new PaperExchangeAdapter('deribit', { 'BTC-PERPETUAL': 60000 })
    a.setPlacePending(true)
    const res = await a.placeOrder({ accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'buy', orderType: 'market', quantity: 5 })
    expect(res.status).toBe('pending') // forces the poller
    const status = await a.getOrderStatus(res.orderId)
    expect(status.state).toBe('filled')
    expect(status.filledQuantity).toBe(5)
  })

  it('cancelOrder marks a resting bracket cancelled', async () => {
    const a = new PaperExchangeAdapter('deribit', { 'BTC-PERPETUAL': 60000 })
    const tp = await a.placeOrder({
      accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'sell', orderType: 'limit',
      quantity: 5, price: 62000, reduceOnly: true,
    })
    await a.cancelOrder(tp.orderId)
    expect((await a.getOrderStatus(tp.orderId)).state).toBe('cancelled')
  })
})

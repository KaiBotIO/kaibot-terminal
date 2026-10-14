import { describe, expect, it } from 'bun:test'
import { PaperExchangeAdapter } from './paper.js'

// Paper trading charges nothing, and says so explicitly: a fill booked from a
// paper result carries commission 0, never "unknown".
describe('PaperExchangeAdapter fees', () => {
  it('reports commission 0 on the fill and on the status', async () => {
    const a = new PaperExchangeAdapter('deribit', { 'BTC-PERPETUAL': 60000 })
    const res = await a.placeOrder({ accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'buy', orderType: 'market', quantity: 10 })
    expect(res.commission).toBe(0)
    const status = await a.getOrderStatus(res.orderId)
    expect(status.commission).toBe(0)
  })
})

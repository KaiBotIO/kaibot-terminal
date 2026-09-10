import { describe, expect, it, afterEach } from 'bun:test'
import { TradeStationOAuthAdapter } from './tradestation-oauth.js'
import {
  lookupTradeStationOrderStatus,
  mapTradeStationOrderStatus,
} from './tradestation-orders.js'

// Item 2: a timed-out ENTRY whose outcome was unknown when placed must still be
// found once the order leaves the working /orders set. getOrderStatus consults
// /historicalorders as a fallback so a late-filled entry resolves to `filled`
// instead of staying `unknown` forever (= an orphaned position). This is wired
// into BOTH TradeStation adapters via the shared lookup helper.

const realFetch = globalThis.fetch

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    return handler(url, init)
  }) as any
}

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  globalThis.fetch = realFetch
})

// A TradeStation order object as the brokerage API returns it for a fill.
function filledOrder(orderId: string) {
  return {
    OrderID: orderId,
    Status: 'FLL',
    FilledPrice: '5000',
    CommissionFee: '1.2',
    Legs: [{ Symbol: 'MESM26', QuantityOrdered: '4', ExecQuantity: '4' }],
  }
}

describe('mapTradeStationOrderStatus', () => {
  it('maps a FLL order to a filled status with qty + price', () => {
    const s = mapTradeStationOrderStatus('o1', filledOrder('o1'))
    expect(s.state).toBe('filled')
    expect(s.filledQuantity).toBe(4)
    expect(s.averagePrice).toBe(5000)
  })

  it('maps a non-terminal status to working', () => {
    expect(mapTradeStationOrderStatus('o1', { OrderID: 'o1', Status: 'ACK' }).state).toBe('working')
  })

  it('maps REJ to rejected and CAN to cancelled', () => {
    expect(mapTradeStationOrderStatus('o1', { Status: 'REJ' }).state).toBe('rejected')
    expect(mapTradeStationOrderStatus('o1', { Status: 'CAN' }).state).toBe('cancelled')
  })
})

describe('lookupTradeStationOrderStatus (/orders → /historicalorders)', () => {
  it('returns unknown while the order is in neither set (timeout window)', async () => {
    const seen: string[] = []
    const call = async (endpoint: string) => {
      seen.push(endpoint)
      return { Orders: [] } // working set empty, history empty
    }
    const s = await lookupTradeStationOrderStatus(call, 'ACC1', 'ord-1')
    expect(s.state).toBe('unknown')
    // Both endpoints were consulted.
    expect(seen.some((e) => e.includes('/orders/'))).toBe(true)
    expect(seen.some((e) => e.includes('/historicalorders/'))).toBe(true)
  })

  it('finds a terminal order via /historicalorders after it left the working set', async () => {
    const call = async (endpoint: string) => {
      if (endpoint.includes('/historicalorders/')) return { Orders: [filledOrder('ord-1')] }
      return { Orders: [] } // working set no longer reports it
    }
    const s = await lookupTradeStationOrderStatus(call, 'ACC1', 'ord-1')
    expect(s.state).toBe('filled')
    expect(s.filledQuantity).toBe(4)
  })

  it('still falls back to historical when the working /orders query throws', async () => {
    const call = async (endpoint: string) => {
      if (endpoint.includes('/historicalorders/')) return { Orders: [filledOrder('ord-1')] }
      throw new Error('orders endpoint 500')
    }
    const s = await lookupTradeStationOrderStatus(call, 'ACC1', 'ord-1')
    expect(s.state).toBe('filled')
  })
})

describe('OAuth adapter getOrderStatus consults historicalorders', () => {
  function primed(): TradeStationOAuthAdapter {
    const a = new TradeStationOAuthAdapter()
    ;(a as any).session = {
      access_token: 'tok-1',
      token_type: 'Bearer',
      expires_in: 1200,
      timestamp: Date.now(),
    }
    return a
  }

  it('returns unknown without an account', async () => {
    const s = await primed().getOrderStatus('ord-1', {})
    expect(s.state).toBe('unknown')
  })

  it('resolves a late fill that only appears in /historicalorders', async () => {
    const hit = { orders: false, historical: false }
    installFetch((url) => {
      if (url.includes('/historicalorders/')) {
        hit.historical = true
        return jsonResponse(200, { Orders: [filledOrder('ord-1')] })
      }
      if (url.includes('/orders/')) {
        hit.orders = true
        return jsonResponse(200, { Orders: [] })
      }
      return jsonResponse(200, {})
    })
    const s = await primed().getOrderStatus('ord-1', { accountId: 'ACC1' })
    expect(s.state).toBe('filled')
    expect(s.filledQuantity).toBe(4)
    // The historical endpoint was actually reached (the new wiring).
    expect(hit.orders).toBe(true)
    expect(hit.historical).toBe(true)
  })
})

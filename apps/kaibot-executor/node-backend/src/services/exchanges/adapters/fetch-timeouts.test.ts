import { describe, expect, it, afterEach } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { BinanceAdapter } from './binance.js'
import { BybitAdapter } from './bybit.js'
import { DeribitAdapter } from './deribit.js'
import { FETCH_TIMEOUTS } from '../fetch-timeout.js'
import { toClientOrderRef } from '../../client-order-id.js'

// EX1 regression: every adapter REST call must carry an abort timeout. Without
// one, a single black-holed request hangs its caller forever — and, through the
// order lock, froze order flow on that venue (and, before the per-exchange
// lock, on every venue).

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function captureFetch(responder: (url: string) => any) {
  const seen: Array<{ url: string; signal: AbortSignal | null | undefined }> = []
  globalThis.fetch = (async (url: any, init?: any) => {
    seen.push({ url: String(url), signal: init?.signal })
    return Response.json(responder(String(url)))
  }) as typeof fetch
  return seen
}

describe('adapter fetch abort signals (EX1)', () => {
  it('Binance signed requests carry an AbortSignal', async () => {
    const seen = captureFetch(() => ({ code: 0 }))
    const adapter = new BinanceAdapter()
    ;(adapter as any).credentials = { type: 'apiKey', apiKey: 'k', apiSecret: 's' }
    await (adapter as any).signedRequest('GET', '/fapi/v2/balance', {})
    expect(seen).toHaveLength(1)
    expect(seen[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('Bybit signed GET and POST carry an AbortSignal', async () => {
    const seen = captureFetch(() => ({ retCode: 0, retMsg: 'OK', result: {} }))
    const adapter = new BybitAdapter()
    ;(adapter as any).credentials = { type: 'apiKey', apiKey: 'k', apiSecret: 's' }
    await (adapter as any).signedGet('/v5/account/info', {})
    await (adapter as any).signedPost('/v5/order/create', { symbol: 'BTCUSDT' })
    expect(seen).toHaveLength(2)
    expect(seen[0].signal).toBeInstanceOf(AbortSignal)
    expect(seen[1].signal).toBeInstanceOf(AbortSignal)
  })

  it('Deribit calls carry an AbortSignal', async () => {
    const seen = captureFetch(() => ({ result: {} }))
    const adapter = new DeribitAdapter()
    await (adapter as any).call('public/get_time', {})
    expect(seen).toHaveLength(1)
    expect(seen[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('a hung venue aborts instead of hanging forever (functional)', async () => {
    globalThis.fetch = realFetch
    // Server accepts the connection and never responds.
    const server: Server = createServer(() => {
      /* never respond */
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port))
    })

    const prevRead = FETCH_TIMEOUTS.read
    FETCH_TIMEOUTS.read = 100
    try {
      const adapter = new BybitAdapter()
      ;(adapter as any).credentials = { type: 'apiKey', apiKey: 'k', apiSecret: 's' }
      ;(adapter as any).baseURL = `http://127.0.0.1:${port}`

      const started = Date.now()
      await expect((adapter as any).signedGet('/v5/account/info', {})).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      FETCH_TIMEOUTS.read = prevRead
      // The aborted fetch leaves a half-open connection on the silent server;
      // without force-dropping it, server.close() never completes and the bun
      // test process hangs at exit (flaky suite-wide stall).
      ;(server as any).closeAllConnections?.()
      server.close()
    }
  })
})

// EX2 support: crypto adapters resolve a "client:<id>" ref through their
// query-by-client-order-id endpoint, so an order whose placeOrder threw before
// returning a broker id can still be settled against broker truth.
describe('order status by client id (EX2)', () => {
  it('Bybit queries /v5/order/realtime by orderLinkId for client refs', async () => {
    const seen = captureFetch((url) =>
      url.includes('orderLinkId=kb-abc')
        ? {
            retCode: 0,
            retMsg: 'OK',
            result: {
              list: [{ orderLinkId: 'kb-abc', orderId: 'b-1', orderStatus: 'Filled', cumExecQty: '5', avgPrice: '100' }],
            },
          }
        : { retCode: 0, retMsg: 'OK', result: { list: [] } },
    )
    const adapter = new BybitAdapter()
    ;(adapter as any).credentials = { type: 'apiKey', apiKey: 'k', apiSecret: 's' }

    const status = await adapter.getOrderStatus(toClientOrderRef('kb-abc'), { symbol: 'BTCUSDT' })
    expect(status.state).toBe('filled')
    expect(status.filledQuantity).toBe(5)
    expect(seen.some((s) => s.url.includes('orderLinkId=kb-abc'))).toBe(true)
  })

  it('Binance queries /fapi/v1/order by origClientOrderId for client refs', async () => {
    const seen = captureFetch(() => ({
      orderId: 42,
      status: 'FILLED',
      executedQty: '5',
      avgPrice: '100',
    }))
    const adapter = new BinanceAdapter()
    ;(adapter as any).credentials = { type: 'apiKey', apiKey: 'k', apiSecret: 's' }

    const status = await adapter.getOrderStatus(toClientOrderRef('kb-abc'), { symbol: 'BTCUSDT' })
    expect(status.state).toBe('filled')
    expect(seen[0].url).toContain('origClientOrderId=kb-abc')
    expect(seen[0].url).not.toContain('orderId=kb-abc')
  })
})

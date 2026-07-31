import { describe, expect, it, afterEach } from 'bun:test'
import { TradeStationOAuthAdapter } from './tradestation-oauth.js'

// Item 6: the 401 path on an order-placing POST must NOT blindly re-send the
// request — the order may already have been accepted server-side before the
// auth check, so a re-send risks a DUPLICATE order. The adapter refreshes the
// token (so the NEXT call works) but discards the POST and surfaces a clear,
// non-duplicate error. Reads/cancels keep re-sending after a refresh.

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

// An adapter primed with a live session + credentials (so call() and a token
// refresh both work without an interactive authorize flow).
function primedAdapter(): TradeStationOAuthAdapter {
  const a = new TradeStationOAuthAdapter()
  ;(a as any).credentials = { type: 'oauth', apiKey: 'app-key', apiSecret: 'app-secret' }
  ;(a as any).session = {
    access_token: 'tok-1',
    refresh_token: 'refresh-1',
    token_type: 'Bearer',
    expires_in: 1200,
    timestamp: Date.now(),
  }
  return a
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('TradeStationOAuthAdapter call() 401 handling', () => {
  it('does NOT re-send an order POST on 401 (refreshes token, then surfaces a clear error)', async () => {
    const orderPosts: Array<{ url: string }> = []
    let refreshCalls = 0

    installFetch((url, init) => {
      // The token refresh endpoint after the 401.
      if (url.includes('/v2/Security/Authorize')) {
        refreshCalls++
        return jsonResponse(200, { access_token: 'tok-2', expires_in: 1200, token_type: 'Bearer' })
      }
      // Quote lookup during resolveSymbol — keep it a passthrough non-future symbol.
      if (url.includes('/marketdata/quotes/')) {
        return jsonResponse(200, { Quotes: [] })
      }
      // The order POST: always 401 here.
      if (url.includes('/v3/brokerage/orders') && (init?.method ?? 'GET') === 'POST') {
        orderPosts.push({ url })
        return jsonResponse(401, { Message: 'unauthorized' })
      }
      return jsonResponse(200, {})
    })

    const a = primedAdapter()
    await expect(
      a.placeOrder({
        accountId: 'ACC1',
        symbol: 'AAPL', // non-futures: resolveSymbol passes it through
        side: 'buy',
        orderType: 'market',
        quantity: 1,
      }),
    ).rejects.toThrow(/duplicate order/i)

    // The POST was sent exactly once — never resent.
    expect(orderPosts).toHaveLength(1)
    // The token WAS refreshed on the 401 (so the next call would work).
    expect(refreshCalls).toBe(1)
    // The refreshed access token is now live on the session.
    expect((a as any).session.access_token).toBe('tok-2')
  })

  it('DOES re-send a GET read on 401 after refreshing the token', async () => {
    let accountCalls = 0
    let refreshCalls = 0

    installFetch((url, init) => {
      if (url.includes('/v2/Security/Authorize')) {
        refreshCalls++
        return jsonResponse(200, { access_token: 'tok-2', expires_in: 1200, token_type: 'Bearer' })
      }
      if (url.includes('/v3/brokerage/accounts') && (init?.method ?? 'GET') === 'GET') {
        accountCalls++
        if (accountCalls === 1) return jsonResponse(401, { Message: 'unauthorized' })
        return jsonResponse(200, { Accounts: [] })
      }
      return jsonResponse(200, {})
    })

    const a = primedAdapter()
    const accounts = await a.getAccounts()
    expect(accounts).toEqual([])
    // GET was retried after the 401 (two calls), token refreshed once.
    expect(accountCalls).toBe(2)
    expect(refreshCalls).toBe(1)
  })
})

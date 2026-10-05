import { describe, expect, it, afterEach } from 'bun:test'
import { TradeStationCouchDBAdapter } from './tradestation-couchdb.js'

// The 401 path on an order-placing POST must NOT blindly re-send the request — a
// re-send risks placing the order twice. It may re-read the (rotated) token, but
// then surfaces the 401 instead of reposting. Reads/cancels keep re-sending.

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

// Build an adapter with a primed session so call() skips the CouchDB fetch.
function primedAdapter(): TradeStationCouchDBAdapter {
  const a = new TradeStationCouchDBAdapter()
  ;(a as any).couch = { url: 'http://couch/db', authHeader: null, sessionDocId: 'sess' }
  ;(a as any).session = { access_token: 'tok-1' }
  return a
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('TradeStation call() 401 handling', () => {
  it('does NOT re-send an order POST on 401 (re-reads token, then surfaces 401)', async () => {
    const sent: Array<{ url: string; method?: string }> = []
    let couchReads = 0

    installFetch((url, init) => {
      // CouchDB session re-read after the 401.
      if (url.includes('/db/sess')) {
        couchReads++
        return jsonResponse(200, { access_token: 'tok-2' })
      }
      // The TradeStation order POST: always 401 here.
      sent.push({ url, method: init?.method })
      return jsonResponse(401, { Message: 'unauthorized' })
    })

    const a = primedAdapter()
    await expect(
      a.placeOrder({
        accountId: 'ACC1',
        symbol: 'MESM26',
        side: 'buy',
        orderType: 'market',
        quantity: 1,
      }),
    ).rejects.toThrow()

    // The POST was sent exactly once — never resent.
    const posts = sent.filter((s) => s.method === 'POST')
    expect(posts).toHaveLength(1)
    // But the token WAS re-read from CouchDB on the 401.
    expect(couchReads).toBe(1)
  })

  it('DOES re-send a GET read on 401 after re-reading the token', async () => {
    let getCalls = 0
    let couchReads = 0

    installFetch((url, init) => {
      if (url.includes('/db/sess')) {
        couchReads++
        return jsonResponse(200, { access_token: 'tok-2' })
      }
      // First GET 401s; the retry (with the fresh token) succeeds.
      if ((init?.method ?? 'GET') === 'GET') {
        getCalls++
        if (getCalls === 1) return jsonResponse(401, { Message: 'unauthorized' })
        return jsonResponse(200, { Accounts: [] })
      }
      return jsonResponse(200, {})
    })

    const a = primedAdapter()
    const accounts = await a.getAccounts()
    expect(accounts).toEqual([])
    // GET was retried after the 401 (two calls), token re-read once.
    expect(getCalls).toBe(2)
    expect(couchReads).toBe(1)
  })
})

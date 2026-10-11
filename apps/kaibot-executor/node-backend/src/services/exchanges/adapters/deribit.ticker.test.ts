import { afterEach, describe, expect, it } from 'bun:test'
import { DeribitAdapter } from './deribit.js'
import { scopeAdapter } from '../account-scope.js'

const realFetch = globalThis.fetch
const respond = (body: string, status = 200) => {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch
}

describe('Deribit public ticker', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('quoteLastPrice returns the mark', async () => {
    respond(JSON.stringify({ result: { mark_price: 2455.86, last_price: 2455 } }))
    expect(await new DeribitAdapter().quoteLastPrice('ETH-PERPETUAL')).toBe(2455.86)
  })

  it('quoteLastPrice says why: rate limit, HTTP error, empty ticker', async () => {
    const a = new DeribitAdapter()
    respond(JSON.stringify({ error: { message: 'too_many_requests', code: 10028 } }), 429)
    await expect(a.quoteLastPrice('ETH-PERPETUAL')).rejects.toThrow('too_many_requests (10028)')
    respond('<html>bad gateway</html>', 502)
    await expect(a.quoteLastPrice('ETH-PERPETUAL')).rejects.toThrow('HTTP 502')
    respond(JSON.stringify({ result: {} }))
    await expect(a.quoteLastPrice('ETH-PERPETUAL')).rejects.toThrow('ticker returned no price')
  })

  it('getLastPrice keeps its null contract', async () => {
    respond(JSON.stringify({ error: { message: 'too_many_requests', code: 10028 } }), 429)
    expect(await new DeribitAdapter().getLastPrice('ETH-PERPETUAL')).toBeNull()
  })

  it('isTestnet follows the connection host, also through a labeled connection', () => {
    const a = new DeribitAdapter()
    expect(a.isTestnet).toBe(false)
    ;(a as any).baseURL = 'https://test.deribit.com/api/v2'
    expect(a.isTestnet).toBe(true)
    expect(scopeAdapter(a as any, 'acct1').isTestnet).toBe(true)
  })
})

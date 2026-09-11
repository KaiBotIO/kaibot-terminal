import { describe, expect, it } from 'bun:test'
import { buildCryptoMarkets, type BuildCryptoMarketsInput } from './crypto-markets.js'

const VENUE: Record<string, string> = { BTC: 'BTC-PERPETUAL', ETH: 'ETH-PERPETUAL' }

const base = (over: Partial<BuildCryptoMarketsInput> = {}): BuildCryptoMarketsInput => ({
  connections: [
    { exchangeName: 'deribit', accountKey: null, label: 'deribit' },
    { exchangeName: 'deribit', accountKey: 'acct1', label: 'deribit · acct1' },
  ],
  subscriptions: [],
  synthetics: [],
  positions: [],
  mapSymbol: (_ex, market) => VENUE[market.toUpperCase()] ?? (market.includes('-') ? market : null),
  labelOf: (exchange, accountKey) => (accountKey ? `${exchange} · ${accountKey}` : exchange),
  ...over,
})

// Kai, 2026-09-05: "Crypto markets 0" while three connections were live. The
// section only listed markets that happened to hold an open position.
describe('buildCryptoMarkets', () => {
  it('lists a subscribed market on a flat book', () => {
    const rows = buildCryptoMarkets(
      base({
        subscriptions: [
          { exchange: 'deribit', accountKey: null, status: 'active', markets: ['BTC'] },
        ],
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].symbol).toBe('BTC-PERPETUAL')
    expect(rows[0].sources).toEqual(['subscription'])
    expect(rows[0].position).toBeNull()
    expect(rows[0].open).toBe(true)
  })

  it('keeps a paused subscription and drops a cancelled one', () => {
    const rows = buildCryptoMarkets(
      base({
        subscriptions: [
          { exchange: 'deribit', accountKey: null, status: 'paused', markets: ['BTC'] },
          { exchange: 'deribit', accountKey: null, status: 'cancelled', markets: ['ETH'] },
        ],
      }),
    )
    expect(rows.map((r) => r.symbol)).toEqual(['BTC-PERPETUAL'])
  })

  it('lists an armed synthetic and drops a closed one', () => {
    const rows = buildCryptoMarkets(
      base({
        synthetics: [
          { exchange: 'deribit', accountKey: null, symbol: 'BTC-PERPETUAL', status: 'armed' },
          { exchange: 'deribit', accountKey: null, symbol: 'ETH-PERPETUAL', status: 'closed' },
        ],
      }),
    )
    expect(rows.map((r) => r.symbol)).toEqual(['BTC-PERPETUAL'])
    expect(rows[0].sources).toEqual(['synthetic'])
  })

  it('merges the reasons for one market instead of repeating it', () => {
    const rows = buildCryptoMarkets(
      base({
        subscriptions: [
          { exchange: 'deribit', accountKey: null, status: 'active', markets: ['BTC'] },
        ],
        synthetics: [
          { exchange: 'deribit', accountKey: null, symbol: 'BTC-PERPETUAL', status: 'open' },
        ],
        positions: [
          { exchange: 'deribit', accountKey: null, symbol: 'BTC-PERPETUAL', size: 2, side: 'short', markPrice: 79_500 },
        ],
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].sources).toEqual(['subscription', 'synthetic', 'position'])
    expect(rows[0].position).toEqual({ size: 2, side: 'short' })
    expect(rows[0].last).toBe(79_500)
  })

  it('keeps two connections on the same symbol apart', () => {
    const rows = buildCryptoMarkets(
      base({
        subscriptions: [
          { exchange: 'deribit', accountKey: null, status: 'active', markets: ['BTC'] },
          { exchange: 'deribit', accountKey: 'acct1', status: 'active', markets: ['BTC'] },
        ],
      }),
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.connection)).toEqual(['deribit', 'deribit · acct1'])
  })

  it('ignores a flat position row', () => {
    const rows = buildCryptoMarkets(
      base({
        positions: [
          { exchange: 'deribit', accountKey: null, symbol: 'BTC-PERPETUAL', size: 0, side: 'short' },
        ],
      }),
    )
    expect(rows).toEqual([])
  })

  it('ignores a market on a connection that is not up', () => {
    const rows = buildCryptoMarkets(
      base({
        subscriptions: [
          { exchange: 'bybit', accountKey: null, status: 'active', markets: ['BTC'] },
          { exchange: 'deribit', accountKey: 'gone', status: 'active', markets: ['BTC'] },
        ],
      }),
    )
    expect(rows).toEqual([])
  })

  it('skips a market with no venue symbol rather than guessing', () => {
    const rows = buildCryptoMarkets(
      base({
        subscriptions: [
          { exchange: 'deribit', accountKey: null, status: 'active', markets: ['DOGE'] },
        ],
      }),
    )
    expect(rows).toEqual([])
  })

  it('passes a venue-native market through the mapping unchanged', () => {
    const rows = buildCryptoMarkets(
      base({
        subscriptions: [
          { exchange: 'deribit', accountKey: null, status: 'active', markets: ['BTC_USDC-PERPETUAL'] },
        ],
      }),
    )
    expect(rows.map((r) => r.symbol)).toEqual(['BTC_USDC-PERPETUAL'])
  })

  it('sorts by connection then symbol', () => {
    const rows = buildCryptoMarkets(
      base({
        subscriptions: [
          { exchange: 'deribit', accountKey: 'acct1', status: 'active', markets: ['ETH'] },
          { exchange: 'deribit', accountKey: null, status: 'active', markets: ['ETH', 'BTC'] },
        ],
      }),
    )
    expect(rows.map((r) => `${r.connection}:${r.symbol}`)).toEqual([
      'deribit:BTC-PERPETUAL',
      'deribit:ETH-PERPETUAL',
      'deribit · acct1:ETH-PERPETUAL',
    ])
  })
})

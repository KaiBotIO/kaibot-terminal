import { describe, expect, it } from 'bun:test'
import { getSyntheticSizingBasis, percentToQuantity } from './synthetic-sizing.js'

describe('percentToQuantity', () => {
  it('maps percent to USD notional 1:1 on an inverse venue, no price needed', () => {
    const r = percentToQuantity(5, 100_000, 'deribit', 'BTC-PERPETUAL', 10)
    expect(r).toMatchObject({ quantity: 5000, notionalUsd: 5000, capped: false, priceMissing: false })
  })

  it('rounds the inverse notional down to the contract step', () => {
    const r = percentToQuantity(1, 100_005, 'deribit', 'BTC-PERPETUAL', 10)
    expect(r.quantity).toBe(1000)
    expect(r.notionalUsd).toBeCloseTo(1000.05)
  })

  it('divides the notional by price on a linear venue', () => {
    const r = percentToQuantity(10, 50_000, 'bybit', 'BTCUSDT', 0.001, 100_000)
    expect(r).toMatchObject({ quantity: 0.05, capped: false, priceMissing: false })
  })

  it('rounds the linear quantity down to the step, never up', () => {
    // 1% of 10k = 100 USD at 30k → 0.00333... BTC → floors to 0.003
    const r = percentToQuantity(1, 10_000, 'bybit', 'BTCUSDT', 0.001, 30_000)
    expect(r.quantity).toBe(0.003)
  })

  it('fails closed on a linear venue without a price', () => {
    const r = percentToQuantity(5, 100_000, 'bybit', 'BTCUSDT', 0.001)
    expect(r).toMatchObject({ quantity: 0, notionalUsd: 0, capped: false, priceMissing: true })
  })

  it('caps a percent above 100 at exactly the synthetic value', () => {
    const r = percentToQuantity(160, 20_000, 'deribit', 'BTC-PERPETUAL', 10)
    expect(r.quantity).toBe(20_000)
    expect(r.notionalUsd).toBe(20_000)
    expect(r.capped).toBe(true)
  })

  it('returns zero for a zero or negative percent', () => {
    expect(percentToQuantity(0, 100_000, 'deribit', 'BTC-PERPETUAL', 10).quantity).toBe(0)
    const neg = percentToQuantity(-5, 100_000, 'deribit', 'BTC-PERPETUAL', 10)
    expect(neg.quantity).toBe(0)
    expect(neg.capped).toBe(false)
  })

  it('returns zero when the synthetic value is zero', () => {
    const r = percentToQuantity(5, 0, 'deribit', 'BTC-PERPETUAL', 10)
    expect(r.quantity).toBe(0)
    expect(r.capped).toBe(false)
  })

  it('leaves the quantity unrounded when the step is unknown (0)', () => {
    const r = percentToQuantity(1, 12_345, 'deribit', 'BTC-25DEC26', 0)
    expect(r.quantity).toBeCloseTo(123.45)
  })
})

describe('getSyntheticSizingBasis', () => {
  const flagged = {
    exchange: 'deribit',
    account_id: 'btc',
    symbol: 'BTC-PERPETUAL',
    target_usd: 50_000,
    status: 'open',
  }
  function makeDb(pos: typeof flagged | null) {
    return { getFactorBasisSyntheticUsdPosition: () => pos } as any
  }

  it('matches on (exchange, account) regardless of the signal symbol', () => {
    // The basis drives sizing account-wide, not just its own market.
    const basis = getSyntheticSizingBasis(makeDb(flagged), 'deribit', 'btc')
    expect(basis?.target_usd).toBe(50_000)
  })

  it('returns null for a different exchange', () => {
    expect(getSyntheticSizingBasis(makeDb(flagged), 'bybit', 'btc')).toBeNull()
  })

  it('returns null for a different account', () => {
    expect(getSyntheticSizingBasis(makeDb(flagged), 'deribit', 'eth')).toBeNull()
  })

  it('returns null when nothing is flagged', () => {
    expect(getSyntheticSizingBasis(makeDb(null), 'deribit', 'btc')).toBeNull()
  })

  it('returns null when the db double omits the lookup', () => {
    expect(getSyntheticSizingBasis({} as any, 'deribit', 'btc')).toBeNull()
  })
})

import { describe, expect, it } from 'bun:test'
import { getSyntheticSizingBasis, percentToQuantity, syntheticBasisUsd } from './synthetic-sizing.js'

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

// Kai (04/09): an armed synthetic sizes signals before the mint — on the
// planned floor while armed, on the realized floor (holdings × fill) once
// minted, and on target_usd for a plain (non-cycle) position.
describe('syntheticBasisUsd', () => {
  const base = { target_usd: 0, arm_trigger_price: null, arm_planned_usd: null, arm_holdings_coin: null, arm_fired_price: null, arm_fired_trigger_price: null }
  it('armed → planned floor', () => {
    expect(syntheticBasisUsd({ ...base, status: 'armed', arm_trigger_price: 90_000, arm_planned_usd: 180_000, arm_holdings_coin: 2 })).toEqual({ usd: 180_000, kind: 'armed' })
  })
  it('open in a cycle → holdings × fill, not the short notional', () => {
    expect(
      syntheticBasisUsd({ ...base, status: 'open', target_usd: 180_000, arm_trigger_price: 90_000, arm_holdings_coin: 2, arm_fired_trigger_price: 90_000, arm_fired_price: 89_000 }),
    ).toEqual({ usd: 178_000, kind: 'realized' })
  })
  it('plain open → target_usd', () => {
    expect(syntheticBasisUsd({ ...base, status: 'open', target_usd: 50_000 })).toEqual({ usd: 50_000, kind: 'open' })
  })
  it('getSyntheticSizingBasis carries basisUsd/basisKind for an armed row', () => {
    const armed = { exchange: 'deribit', account_id: 'acct1/btc', symbol: 'BTC-PERPETUAL', status: 'armed', target_usd: 0, arm_trigger_price: 57_725.5, arm_planned_usd: 115_451, arm_holdings_coin: 2, arm_fired_price: null, arm_fired_trigger_price: null }
    const b = getSyntheticSizingBasis({ getFactorBasisSyntheticUsdPosition: () => armed } as any, 'deribit', 'acct1/btc')
    expect(b?.basisUsd).toBe(115_451)
    expect(b?.basisKind).toBe('armed')
    expect(getSyntheticSizingBasis({ getFactorBasisSyntheticUsdPosition: () => armed } as any, 'deribit', 'btc')).toBeNull()
  })
})

// Crypto-couple (2026-09-04): strategies trade the USDC-linear pairs while the
// armed synthetic that sets the basis is on the coin account. A BTC_USDC
// signal on `usdc` must size against the BTC armed row of its own connection.
describe('getSyntheticSizingBasis for USDC-linear signals', () => {
  const rows: Record<string, any> = {
    'deribit|btc': { exchange: 'deribit', account_id: 'btc', status: 'armed', target_usd: 0, arm_planned_usd: 5772.55 },
    'deribit|acct1/eth': { exchange: 'deribit', account_id: 'acct1/eth', status: 'armed', target_usd: 0, arm_planned_usd: 7519.25 },
  }
  const db = {
    getFactorBasisSyntheticUsdPosition: (exchange: string, account: string) => rows[`${exchange}|${account}`] ?? null,
  } as any

  it('maps a BTC_USDC signal on the usdc account to the btc armed row', () => {
    const b = getSyntheticSizingBasis(db, 'deribit', 'usdc', 'BTC_USDC-PERPETUAL')
    expect(b?.account_id).toBe('btc')
    expect(b?.basisUsd).toBeCloseTo(5772.55)
  })

  it('keeps the connection label: acct1/usdc + ETH_USDC → acct1/eth', () => {
    const b = getSyntheticSizingBasis(db, 'deribit', 'acct1/usdc', 'ETH_USDC-PERPETUAL')
    expect(b?.account_id).toBe('acct1/eth')
    expect(b?.basisUsd).toBeCloseTo(7519.25)
  })

  it('never crosses connections or coins', () => {
    expect(getSyntheticSizingBasis(db, 'deribit', 'usdc', 'ETH_USDC-PERPETUAL')).toBeNull()
    expect(getSyntheticSizingBasis(db, 'deribit', 'acct1/usdc', 'BTC_USDC-PERPETUAL')).toBeNull()
    expect(getSyntheticSizingBasis(db, 'deribit', 'usdc', 'SOL_USDC-PERPETUAL')).toBeNull()
  })

  it('leaves inverse and non-USDC symbols on the direct account lookup', () => {
    expect(getSyntheticSizingBasis(db, 'deribit', 'btc', 'BTC-PERPETUAL')?.account_id).toBe('btc')
    expect(getSyntheticSizingBasis(db, 'deribit', 'eth', 'ETH-PERPETUAL')).toBeNull()
  })
})

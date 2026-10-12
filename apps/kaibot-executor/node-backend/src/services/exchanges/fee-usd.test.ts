import { describe, expect, it } from 'bun:test'
import { deribitFeeCurrency, feeToUsd, isCoinUsdFuture } from './fee-usd.js'

describe('feeToUsd', () => {
  it('passes a stablecoin fee through unchanged', async () => {
    const fee = await feeToUsd({ fee: 0.42, feeCurrency: 'USDC', symbol: 'SOL_USDC-PERPETUAL', fillPrice: 150 })
    expect(fee).toEqual({ commission: 0.42, feeNative: 0.42, feeCurrency: 'USDC' })
  })

  it('converts a coin fee on a coin future with the fill price', async () => {
    // 0.00001 BTC on BTC-PERPETUAL filled at 60,000 → $0.60
    const fee = await feeToUsd({ fee: 0.00001, feeCurrency: 'BTC', symbol: 'BTC-PERPETUAL', fillPrice: 60000 })
    expect(fee!.commission).toBeCloseTo(0.6, 10)
    expect(fee).toMatchObject({ feeNative: 0.00001, feeCurrency: 'BTC' })
  })

  it('converts an ETH fee on a dated ETH future with the fill price', async () => {
    const fee = await feeToUsd({ fee: 0.001, feeCurrency: 'ETH', symbol: 'ETH-26DEC25', fillPrice: 3000 })
    expect(fee!.commission).toBeCloseTo(3, 10)
  })

  it('falls back to the coin mark when the fill price does not quote the fee coin', async () => {
    // An option priced in BTC: the fill price is not a USD price.
    const fee = await feeToUsd({
      fee: 0.0003,
      feeCurrency: 'BTC',
      symbol: 'BTC-27MAR26-100000-C',
      fillPrice: 0.05,
      markFor: async (coin) => (coin === 'BTC' ? 50000 : null),
    })
    expect(fee!.commission).toBeCloseTo(15, 10)
  })

  it('returns null when a coin fee cannot be priced', async () => {
    expect(await feeToUsd({ fee: 0.0003, feeCurrency: 'BTC', symbol: 'BTC-27MAR26-100000-C', fillPrice: 0.05 })).toBeNull()
  })

  it('keeps a zero fee as zero without pricing', async () => {
    expect(await feeToUsd({ fee: 0, feeCurrency: 'BTC', symbol: 'BTC-PERPETUAL' })).toEqual({
      commission: 0,
      feeNative: 0,
      feeCurrency: 'BTC',
    })
  })

  it('rejects a non-numeric fee', async () => {
    expect(await feeToUsd({ fee: Number.NaN, feeCurrency: 'BTC', symbol: 'BTC-PERPETUAL', fillPrice: 1 })).toBeNull()
  })
})

describe('isCoinUsdFuture / deribitFeeCurrency', () => {
  it('recognises perps and dated futures of the fee coin only', () => {
    expect(isCoinUsdFuture('BTC-PERPETUAL', 'BTC')).toBe(true)
    expect(isCoinUsdFuture('ETH-26DEC25', 'ETH')).toBe(true)
    expect(isCoinUsdFuture('BTC-PERPETUAL', 'ETH')).toBe(false)
    expect(isCoinUsdFuture('BTC-27MAR26-100000-C', 'BTC')).toBe(false)
    expect(isCoinUsdFuture('SOL_USDC-PERPETUAL', 'SOL')).toBe(false)
  })

  it('charges linear contracts in the stablecoin and inverse ones in the coin', () => {
    expect(deribitFeeCurrency('BTC-PERPETUAL')).toBe('BTC')
    expect(deribitFeeCurrency('ETH-PERPETUAL')).toBe('ETH')
    expect(deribitFeeCurrency('SOL_USDC-PERPETUAL')).toBe('USDC')
    expect(deribitFeeCurrency('BTC_USDT-PERPETUAL')).toBe('USDT')
  })
})

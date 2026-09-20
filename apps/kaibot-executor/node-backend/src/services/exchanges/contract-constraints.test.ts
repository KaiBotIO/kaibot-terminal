import { describe, expect, it, afterEach } from 'bun:test'
import {
  getContractConstraints,
  ensureContractConstraints,
  roundToStep,
} from './contract-constraints.js'

describe('getContractConstraints', () => {
  it('returns known constraints case-insensitively', () => {
    expect(getContractConstraints('Deribit', 'BTC-PERPETUAL')).toEqual({ minSize: 10, stepSize: 10 })
    expect(getContractConstraints('BYBIT', 'btcusdt')).toEqual({ minSize: 0.001, stepSize: 0.001 })
  })

  it('returns a no-op constraint for unknown markets', () => {
    expect(getContractConstraints('kraken', 'XBTUSD')).toEqual({ minSize: 0, stepSize: 0 })
  })

  // TS live blockers 2026-08: tradestation had NO constraints ({0,0}), so a
  // factor of 0.5 sent a fractional contract quantity to the broker. Whole
  // contracts, for roots and dated symbols alike.
  it('enforces whole contracts on every tradestation symbol', () => {
    for (const symbol of ['MES', 'MESU26', 'MNQZ26', 'MGC', 'SIL', 'AAPL']) {
      expect(getContractConstraints('tradestation', symbol)).toEqual({ minSize: 1, stepSize: 1 })
      expect(getContractConstraints('TradeStation', symbol)).toEqual({ minSize: 1, stepSize: 1 })
    }
    // 0.5 contract rounds to 0 → rejected by the min-size floor downstream.
    expect(roundToStep(0.5, 1)).toBe(0)
    expect(roundToStep(2.5, 1)).toBe(2)
  })
})

describe('ensureContractConstraints', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('caches bybit lot filters for symbols outside the static map', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: { list: [{ lotSizeFilter: { minOrderQty: '0.1', qtyStep: '0.1' } }] },
        }),
      )) as unknown as typeof fetch
    await ensureContractConstraints('bybit', 'SOLPERP')
    expect(getContractConstraints('bybit', 'SOLPERP')).toEqual({ minSize: 0.1, stepSize: 0.1 })
  })

  it('caches deribit contract size for linear USDC perps', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ result: { min_trade_amount: 0.1, contract_size: 0.1 } }),
      )) as unknown as typeof fetch
    await ensureContractConstraints('deribit', 'SOL_USDC-PERPETUAL')
    expect(getContractConstraints('deribit', 'SOL_USDC-PERPETUAL')).toEqual({
      minSize: 0.1,
      stepSize: 0.1,
    })
  })

  it('keeps the no-op fallback when the venue fetch fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    await ensureContractConstraints('bybit', 'DOGEPERP')
    expect(getContractConstraints('bybit', 'DOGEPERP')).toEqual({ minSize: 0, stepSize: 0 })
  })

  it('never overrides the static map', async () => {
    globalThis.fetch = (async () => {
      throw new Error('should not be called')
    }) as unknown as typeof fetch
    await ensureContractConstraints('deribit', 'BTC-PERPETUAL')
    expect(getContractConstraints('deribit', 'BTC-PERPETUAL')).toEqual({ minSize: 10, stepSize: 10 })
  })
})

describe('roundToStep', () => {
  it('rounds down to the nearest step', () => {
    expect(roundToStep(27, 10)).toBe(20)
    expect(roundToStep(30, 10)).toBe(30)
  })

  it('keeps the quantity when step is zero', () => {
    expect(roundToStep(0.1234, 0)).toBe(0.1234)
  })

  it('avoids binary float dust on fractional steps', () => {
    expect(roundToStep(0.0035, 0.001)).toBe(0.003)
    expect(roundToStep(0.03, 0.01)).toBe(0.03)
  })
})

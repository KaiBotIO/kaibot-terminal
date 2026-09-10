import { describe, expect, it } from 'bun:test'
import {
  isUsdLike,
  usdMarkSymbol,
  usdRatesFor,
  usdValue,
  withUsdValues,
} from './balance-usd.js'
import { isOpenPosition } from './open-position.js'
import type { Balance, Position } from './types.js'

const bal = (over: Partial<Balance>): Balance => ({
  accountId: 'btc',
  balance: 0.1,
  equity: 0.1,
  realizedPnL: 0,
  unrealizedPnL: 0,
  currency: 'BTC',
  timestamp: 0,
  ...over,
})

describe('usd-like currencies', () => {
  it('treats the dollar stables as worth a dollar', () => {
    for (const c of ['USD', 'usdc', 'USDT']) expect(isUsdLike(c)).toBe(true)
    expect(isUsdLike('BTC')).toBe(false)
    expect(isUsdLike(null)).toBe(false)
  })

  it('names the perpetual that prices a coin', () => {
    expect(usdMarkSymbol('BTC')).toBe('BTC-PERPETUAL')
    expect(usdMarkSymbol('eth')).toBe('ETH-PERPETUAL')
    expect(usdMarkSymbol('USDC')).toBeNull()
  })
})

describe('usdValue', () => {
  it('converts a coin amount at the mark', () => {
    expect(usdValue(0.1, 'BTC', 79_500)).toBeCloseTo(7950, 6)
  })

  it('passes a dollar amount through untouched', () => {
    expect(usdValue(5248, 'USD', null)).toBe(5248)
  })

  it('refuses to guess without a usable mark', () => {
    expect(usdValue(0.1, 'BTC', null)).toBeNull()
    expect(usdValue(0.1, 'BTC', 0)).toBeNull()
    expect(usdValue(0.1, 'BTC', Number.NaN)).toBeNull()
  })
})

// Kai, 2026-09-05: the Exchanges strip summed 0,1 BTC + 5 ETH + 9 USDC as if
// every wallet were dollars.
describe('withUsdValues', () => {
  it('values every wallet of a Deribit connection', () => {
    const rows = withUsdValues(
      [
        bal({ currency: 'BTC', balance: 0.1, equity: 0.1 }),
        bal({ accountId: 'eth', currency: 'ETH', balance: 5, equity: 5 }),
        bal({ accountId: 'usdc', currency: 'USDC', balance: 9.36, equity: 9.36 }),
      ],
      new Map([
        ['BTC', 79_500],
        ['ETH', 2450],
      ]),
    )
    expect(rows.map((r) => r.usdEquity)).toEqual([7950, 12_250, 9.36])
    expect(rows.map((r) => r.usdRate)).toEqual([79_500, 2450, 1])
    expect(rows.reduce((s, r) => s + (r.usdEquity ?? 0), 0)).toBeCloseTo(20_209.36, 2)
  })

  it('leaves an unpriced coin null rather than reporting the raw amount', () => {
    const [row] = withUsdValues([bal({ currency: 'SOL', balance: 12, equity: 12 })], new Map())
    expect(row.usdEquity).toBeNull()
    expect(row.usdRate).toBeNull()
  })
})

describe('usdRatesFor', () => {
  it('asks the venue once per coin currency and never for stables', async () => {
    const asked: string[] = []
    const rates = await usdRatesFor(
      [
        bal({ currency: 'BTC' }),
        bal({ accountId: 'btc2', currency: 'BTC' }),
        bal({ accountId: 'eth', currency: 'ETH' }),
        bal({ accountId: 'usdc', currency: 'USDC' }),
      ],
      async (symbol) => {
        asked.push(symbol)
        return symbol === 'BTC-PERPETUAL' ? 79_500 : 2450
      },
    )
    expect(asked.sort()).toEqual(['BTC-PERPETUAL', 'ETH-PERPETUAL'])
    expect(rates.get('BTC')).toBe(79_500)
    expect(rates.get('ETH')).toBe(2450)
    expect(rates.has('USDC')).toBe(false)
  })

  it('degrades to null when the adapter has no price hook or throws', async () => {
    expect((await usdRatesFor([bal({ currency: 'BTC' })])).get('BTC')).toBeNull()
    const rates = await usdRatesFor([bal({ currency: 'BTC' })], async () => {
      throw new Error('venue down')
    })
    expect(rates.get('BTC')).toBeNull()
  })
})

// Kai, 2026-09-05: "OPEN POSITIONS 11" on a book holding 2. Deribit lists every
// instrument the account ever traded, size 0 when flat.
describe('isOpenPosition', () => {
  const p = (size: number) => ({ size }) as Position
  it('keeps only rows that hold size', () => {
    expect(isOpenPosition(p(1))).toBe(true)
    expect(isOpenPosition(p(-2))).toBe(true)
    expect(isOpenPosition(p(0))).toBe(false)
    expect(isOpenPosition({ size: Number.NaN } as Position)).toBe(false)
  })
})

import { describe, expect, it } from 'bun:test'
import {
  FrontMonthResolver,
  candidateContracts,
  contractMultiplier,
  isFuturesRoot,
  multiplierFor,
  pickFrontMonth,
  rootOf,
  type QuoteLike,
} from './futures-contracts.js'

describe('candidateContracts', () => {
  it('produces 14 contracts, nearest expiry first, with month-letter codes', () => {
    // June 2026 → month index 5 → code "M", year "26".
    const out = candidateContracts('MES', new Date(2026, 5, 15))
    expect(out).toHaveLength(14)
    expect(out[0]).toBe('MESM26')
    expect(out[1]).toBe('MESN26') // July → N
    // Rolls into next year.
    expect(out[7]).toBe('MESF27') // Jan 2027 → F
  })

  it('maps every month to the right futures code', () => {
    // Jan..Dec 2026.
    const codes = Array.from({ length: 12 }, (_, m) =>
      candidateContracts('ES', new Date(2026, m, 1))[0],
    )
    expect(codes).toEqual([
      'ESF26', 'ESG26', 'ESH26', 'ESJ26', 'ESK26', 'ESM26',
      'ESN26', 'ESQ26', 'ESU26', 'ESV26', 'ESX26', 'ESZ26',
    ])
  })
})

describe('isFuturesRoot / rootOf', () => {
  it('recognises bare roots case-insensitively', () => {
    expect(isFuturesRoot('MES')).toBe(true)
    expect(isFuturesRoot('mnq')).toBe(true)
    expect(isFuturesRoot('MESM26')).toBe(false)
    expect(isFuturesRoot('BTC-PERPETUAL')).toBe(false)
  })

  it('strips month + year from dated contracts', () => {
    expect(rootOf('MESM26')).toBe('MES')
    expect(rootOf('MNQZ25')).toBe('MNQ')
    expect(rootOf('MES')).toBe('MES') // already a root
    expect(rootOf('BTC-PERPETUAL')).toBe('BTC-PERPETUAL') // non-future passthrough
  })
})

describe('multiplierFor', () => {
  it('returns per-root multipliers for roots and dated contracts', () => {
    expect(multiplierFor('MES')).toBe(5)
    expect(multiplierFor('MESM26')).toBe(5)
    expect(multiplierFor('MNQZ25')).toBe(2)
    expect(multiplierFor('MGC')).toBe(10)
    expect(multiplierFor('SIL')).toBe(1000)
  })

  it('defaults unknown roots to 1', () => {
    expect(multiplierFor('ZZZ')).toBe(1)
    expect(multiplierFor('BTC-PERPETUAL')).toBe(1)
  })
})

describe('pickFrontMonth', () => {
  it('picks the highest-volume priced contract', () => {
    const quotes: QuoteLike[] = [
      { Symbol: 'MESM26', Last: '5000', Volume: '1200000' }, // near expiry, low vol
      { Symbol: 'MESU26', Last: '5010', Volume: '1900000' }, // front month, high vol
      { Symbol: 'MESZ26', Last: '5020', Volume: '300000' },
    ]
    const front = pickFrontMonth(quotes)
    expect(front?.symbol).toBe('MESU26')
    expect(front?.last).toBe(5010)
  })

  it('ignores unpriced candidates', () => {
    const quotes: QuoteLike[] = [
      { Symbol: 'MESM26', Volume: '5000000' }, // no price → skipped despite huge volume
      { Symbol: 'MESU26', Last: '5010', Volume: '100' },
    ]
    expect(pickFrontMonth(quotes)?.symbol).toBe('MESU26')
  })

  it('falls back to Close / Ask when Last is absent', () => {
    const quotes: QuoteLike[] = [{ Symbol: 'MESU26', Close: '4999', Volume: '10' }]
    expect(pickFrontMonth(quotes)?.last).toBe(4999)
  })

  it('returns null when nothing is priced', () => {
    expect(pickFrontMonth([{ Symbol: 'MESM26', Volume: '10' }])).toBeNull()
    expect(pickFrontMonth([])).toBeNull()
  })
})

describe('FrontMonthResolver', () => {
  const quotes: QuoteLike[] = [
    { Symbol: 'MESM26', Last: '5000', Volume: '100' },
    { Symbol: 'MESU26', Last: '5010', Volume: '999' },
  ]

  it('resolves a root to the highest-volume contract', async () => {
    const r = new FrontMonthResolver()
    const front = await r.resolve('MES', async () => quotes)
    expect(front.symbol).toBe('MESU26')
  })

  it('caches within the TTL and re-quotes after it', async () => {
    const r = new FrontMonthResolver(1000)
    let calls = 0
    const quoteFn = async () => {
      calls++
      return quotes
    }
    await r.resolve('MES', quoteFn, 0)
    await r.resolve('MES', quoteFn, 500) // within TTL → cached
    expect(calls).toBe(1)
    await r.resolve('MES', quoteFn, 1500) // past TTL → re-quote
    expect(calls).toBe(2)
  })

  it('throws when no candidate is priced', async () => {
    const r = new FrontMonthResolver()
    await expect(r.resolve('MES', async () => [{ Symbol: 'MESM26', Volume: '1' }])).rejects.toThrow(
      /no priced contract/,
    )
  })
})

// TS live blockers 2026-08: USD-notional math (sizing, margin, notional rails)
// must value a futures contract at price × multiplier, never bare price.
describe('contractMultiplier', () => {
  it('returns the per-root multiplier on tradestation, for roots and dated contracts', () => {
    expect(contractMultiplier('tradestation', 'MES')).toBe(5)
    expect(contractMultiplier('tradestation', 'MESU26')).toBe(5)
    expect(contractMultiplier('tradestation', 'MNQ')).toBe(2)
    expect(contractMultiplier('tradestation', 'MNQZ26')).toBe(2)
    expect(contractMultiplier('tradestation', 'MGC')).toBe(10)
    expect(contractMultiplier('TradeStation', 'SIL')).toBe(1000)
  })

  it('is 1 for unknown tradestation symbols and for every other venue', () => {
    expect(contractMultiplier('tradestation', 'AAPL')).toBe(1)
    expect(contractMultiplier('deribit', 'BTC-PERPETUAL')).toBe(1)
    expect(contractMultiplier('bybit', 'ETHUSDT')).toBe(1)
  })
})

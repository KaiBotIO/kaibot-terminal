import { afterEach, describe, expect, it } from 'bun:test'
import { MARK_MAX_AGE_MS, clearMarks, lastMark, recordMarks } from './mark-cache.js'

afterEach(() => clearMarks())

describe('mark cache', () => {
  it('prefers the account mark, falls back to the latest on the market', () => {
    recordMarks('deribit', [{ symbol: 'BTC-PERPETUAL', accountId: 'main', markPrice: 62_480 }], 1_000)
    recordMarks('deribit', [{ symbol: 'BTC-PERPETUAL', accountId: 'eth', markPrice: 62_500 }], 2_000)
    expect(lastMark('deribit', 'BTC-PERPETUAL', 'main', 3_000)).toEqual({ markPrice: 62_480, markAt: 1_000 })
    expect(lastMark('Deribit', 'btc-perpetual', 'other', 3_000)).toEqual({ markPrice: 62_500, markAt: 2_000 })
  })

  it('skips rows without a usable mark', () => {
    recordMarks('bybit', [{ symbol: 'DYDXUSDT', markPrice: 0 }, { symbol: 'SOLUSDT' }], 1_000)
    expect(lastMark('bybit', 'DYDXUSDT', null, 1_000)).toBeNull()
    expect(lastMark('bybit', 'SOLUSDT', null, 1_000)).toBeNull()
  })

  it('drops a mark older than the max age', () => {
    recordMarks('bybit', [{ symbol: 'DYDXUSDT', markPrice: 0.1343 }], 0)
    expect(lastMark('bybit', 'DYDXUSDT', null, MARK_MAX_AGE_MS)).not.toBeNull()
    expect(lastMark('bybit', 'DYDXUSDT', null, MARK_MAX_AGE_MS + 1)).toBeNull()
  })
})

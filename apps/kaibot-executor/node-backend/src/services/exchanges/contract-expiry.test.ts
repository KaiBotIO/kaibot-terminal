import { describe, expect, it } from 'bun:test'
import {
  expiryInfoForSymbol,
  nextCycleContract,
  thirdFriday,
  thirdLastBusinessDay,
} from './contract-expiry.js'

const utc = (y: number, m: number, d: number, h = 0) => new Date(Date.UTC(y, m - 1, d, h))

describe('thirdFriday', () => {
  it('matches the 2026 quarterly calendar', () => {
    expect(thirdFriday(2026, 3)).toEqual(utc(2026, 3, 20))
    expect(thirdFriday(2026, 6)).toEqual(utc(2026, 6, 19))
    expect(thirdFriday(2026, 9)).toEqual(utc(2026, 9, 18))
    expect(thirdFriday(2026, 12)).toEqual(utc(2026, 12, 18))
  })

  it('handles a month starting on a Friday', () => {
    expect(thirdFriday(2026, 5)).toEqual(utc(2026, 5, 15))
  })
})

describe('thirdLastBusinessDay', () => {
  it('counts back over a weekday tail', () => {
    // Dec 2026 ends Thu 31 -> 31, 30, 29.
    expect(thirdLastBusinessDay(2026, 12)).toEqual(utc(2026, 12, 29))
  })

  it('skips a weekend at month end', () => {
    // Feb 2027 ends Sun 28 -> Fri 26, Thu 25, Wed 24.
    expect(thirdLastBusinessDay(2027, 2)).toEqual(utc(2027, 2, 24))
  })
})

describe('nextCycleContract', () => {
  it('advances within the cycle and wraps the year', () => {
    expect(nextCycleContract('MNQU26')).toBe('MNQZ26')
    expect(nextCycleContract('MNQZ26')).toBe('MNQH27')
    expect(nextCycleContract('MGCZ26')).toBe('MGCG27')
  })

  it('returns null for unknown roots and non-contracts', () => {
    expect(nextCycleContract('CLZ26')).toBeNull()
    expect(nextCycleContract('MNQ')).toBeNull()
  })
})

describe('expiryInfoForSymbol', () => {
  it('calculates tradfi contract expiry (marked calculated)', () => {
    const info = expiryInfoForSymbol('MNQZ26', utc(2026, 12, 1))
    expect(info).not.toBeNull()
    expect(info!.date).toBe(utc(2026, 12, 18).toISOString())
    expect(info!.daysLeft).toBe(17)
    expect(info!.source).toBe('calculated')
    expect(info!.nextSymbol).toBe('MNQH27')
  })

  it('clamps daysLeft at zero on/after expiry day', () => {
    expect(expiryInfoForSymbol('MNQZ26', utc(2026, 12, 18))!.daysLeft).toBe(0)
  })

  it('parses crypto dated futures from the symbol (exchange-provided)', () => {
    const info = expiryInfoForSymbol('BTC-27MAR26', utc(2026, 3, 1))
    expect(info).not.toBeNull()
    expect(info!.date).toBe(utc(2026, 3, 27, 8).toISOString())
    expect(info!.daysLeft).toBe(26)
    expect(info!.source).toBe('exchange-provided')
    expect(info!.nextSymbol).toBeNull()
  })

  it('handles linear USDC delivery symbols', () => {
    expect(expiryInfoForSymbol('BTC_USDC-26JUN26', utc(2026, 6, 1))!.source).toBe('exchange-provided')
  })

  it('returns null for perpetuals, spot and bare roots', () => {
    expect(expiryInfoForSymbol('BTC-PERPETUAL')).toBeNull()
    expect(expiryInfoForSymbol('BTCUSDT')).toBeNull()
    expect(expiryInfoForSymbol('MNQ')).toBeNull()
    expect(expiryInfoForSymbol('CLZ26')).toBeNull()
  })
})

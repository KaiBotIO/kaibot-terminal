import { describe, expect, it } from 'bun:test'
import {
  debtOf,
  defaultAccount,
  distanceToTriggerPct,
  marginStateFor,
  plannedFloorUsd,
  ratioOverridesFromForm,
  roundPrice,
  thresholdError,
  triggerFromMark,
  virtualLineShare,
} from './collateral'
import type { CollateralCoinView } from './collateral-api'

const coin = (over: Partial<CollateralCoinView>): CollateralCoinView => ({
  coin: 'USDT',
  walletBalance: 0,
  equity: 0,
  borrowAmount: 0,
  markPrice: 1,
  usdValue: 0,
  collateralSwitch: true,
  marginCollateral: true,
  collateralRatio: 1,
  ratioSource: 'venue',
  marginValueUsd: 0,
  floor: null,
  venueQty: 0,
  virtualQty: 0,
  totalQty: 0,
  virtual: null,
  virtualImpliedFloorUsd: null,
  ...over,
})

describe('quick-fill triggers', () => {
  it('drops from the mark and rounds by price scale', () => {
    expect(triggerFromMark(100_000, 10)).toBe(90_000)
    expect(triggerFromMark(163.37, 15)).toBe(138.86)
    expect(triggerFromMark(0.5123, 20)).toBe(0.4098)
    expect(triggerFromMark(null, 10)).toBeNull()
    expect(roundPrice(Number.NaN)).toBe(0)
  })
})

describe('planned floor + distance', () => {
  it('is holdings × trigger, 0 on missing input', () => {
    expect(plannedFloorUsd(0.5, 90_000)).toBe(45_000)
    expect(plannedFloorUsd(0, 90_000)).toBe(0)
    expect(plannedFloorUsd(1, 0)).toBe(0)
  })

  it('measures distance as a share of the mark', () => {
    expect(distanceToTriggerPct(100, 90)).toBeCloseTo(10)
    expect(distanceToTriggerPct(100, 110)).toBeCloseTo(-10)
    expect(distanceToTriggerPct(null, 90)).toBeNull()
  })
})

describe('margin guard', () => {
  it('blocks between block and warn, warns above warn', () => {
    expect(marginStateFor(0.3, 60, 80)).toBe('ok')
    expect(marginStateFor(0.6, 60, 80)).toBe('block')
    expect(marginStateFor(0.85, 60, 80)).toBe('warn')
    expect(marginStateFor(null, 60, 80)).toBe('unknown')
  })

  it('rejects inverted or out-of-range thresholds', () => {
    expect(thresholdError(60, 80)).toBeNull()
    expect(thresholdError(80, 60)).not.toBeNull()
    expect(thresholdError(0, 80)).not.toBeNull()
    expect(thresholdError(60, 120)).not.toBeNull()
  })
})

describe('debt + accounts', () => {
  it('reads borrowed USDT from a negative balance or borrowAmount', () => {
    expect(debtOf(coin({ walletBalance: -250 }))).toBe(250)
    expect(debtOf(coin({ walletBalance: 10, borrowAmount: 40 }))).toBe(40)
    expect(debtOf(coin({ walletBalance: 10 }))).toBe(0)
  })

  it('defaults to the first connected Bybit account', () => {
    const a = [
      { exchange: 'deribit', accountId: 'btc', label: null, connected: true },
      { exchange: 'bybit', accountId: 'old', label: null, connected: false },
      { exchange: 'bybit', accountId: 'unified', label: null, connected: true },
    ]
    expect(defaultAccount(a)?.accountId).toBe('unified')
    expect(defaultAccount([])).toBeNull()
  })
})

describe('ratio overrides', () => {
  it('turns percent strings into fractions and skips blanks', () => {
    expect(ratioOverridesFromForm({ BTC: '95', ETH: '', SOL: ' ' })).toEqual({ BTC: 0.95 })
    expect(ratioOverridesFromForm({ BTC: '150' })).toBeNull()
  })
})

describe('virtualLineShare', () => {
  it("splits a coin's virtual pot value and implied floor over its lines by quantity", () => {
    const c = coin({
      coin: 'BTC', virtualQty: 0.1, virtual: { coin: 'BTC', usd: 8_000, source: 'floor', virtual: true }, virtualImpliedFloorUsd: 8_500,
    })
    expect(virtualLineShare(c, 0.025)).toEqual({ potUsd: 2_000, floorUsd: 2_125 })
    expect(virtualLineShare(coin({ coin: 'SOL', virtualQty: 115 }), 115)).toEqual({ potUsd: null, floorUsd: null })
    expect(virtualLineShare(undefined, 1)).toEqual({ potUsd: null, floorUsd: null })
  })
})

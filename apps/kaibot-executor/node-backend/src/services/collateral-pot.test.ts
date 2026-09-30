import { describe, expect, it } from 'bun:test'
import {
  checkPotCap,
  computeCollateralPot,
  entriesBlocked,
  largestReducible,
  marginState,
  resolveCollateralRatio,
  tieredCollateralRatio,
  usedNotionalUsd,
  validateThresholds,
  type PotCoinInput,
  type PotFloorInput,
} from './collateral-pot.js'
import { ratchetTrigger } from './synthetic-guard.js'

// The report example: 0,2 BTC + 10 ETH + 100 SOL, no stablecoins.
const coins = (marks: { BTC: number; ETH: number; SOL: number }): PotCoinInput[] => [
  { coin: 'BTC', walletCoin: 0.2, mark: marks.BTC, ratio: 0.95, collateral: true },
  { coin: 'ETH', walletCoin: 10, mark: marks.ETH, ratio: 0.95, collateral: true },
  { coin: 'SOL', walletCoin: 100, mark: marks.SOL, ratio: 0.9, collateral: true },
]
const MARKS = { BTC: 100_000, ETH: 4_000, SOL: 200 }
const floor = (coin: string, holdingsCoin: number, triggerPrice: number, extra: Partial<PotFloorInput> = {}): PotFloorInput => ({
  coin, mode: 'hedge', status: 'armed', holdingsCoin, triggerPrice, proceedsUsd: null, ...extra,
})

describe('collateral pot', () => {
  it('report example: floored coins at trigger × ratio, SOL without floor excluded', () => {
    const r = computeCollateralPot(
      coins(MARKS),
      [floor('BTC', 0.2, 85_000), floor('ETH', 10, 3_400)],
      'exclude',
    )
    // 0,2 × 85.000 × 0,95 = 16.150 ; 10 × 3.400 × 0,95 = 32.300
    expect(r.components).toEqual([
      { coin: 'BTC', usd: 16_150, source: 'floor' },
      { coin: 'ETH', usd: 32_300, source: 'floor' },
    ])
    expect(r.potUsd).toBeCloseTo(48_450, 6)
  })

  it("'margin' mode values an unfloored coin at mark × ratio", () => {
    const r = computeCollateralPot(coins(MARKS), [floor('BTC', 0.2, 85_000), floor('ETH', 10, 3_400)], 'margin')
    // + 100 × 200 × 0,9 = 18.000
    expect(r.components.find((c) => c.coin === 'SOL')).toEqual({ coin: 'SOL', usd: 18_000, source: 'margin' })
    expect(r.potUsd).toBeCloseTo(66_450, 6)
  })

  it('a price drop alone never shrinks the floored pot; the ratchet only lifts it', () => {
    const f = [floor('BTC', 0.2, 85_000)]
    const before = computeCollateralPot(coins(MARKS), f, 'exclude').potUsd
    const crash = computeCollateralPot(coins({ BTC: 60_000, ETH: 2_000, SOL: 90 }), f, 'exclude').potUsd
    expect(crash).toBe(before)
    // Trail 15 %: a new high at 120k lifts the trigger to 102k, a pullback keeps it.
    let t = ratchetTrigger({ direction: 'long', triggerPrice: 85_000, highWater: 100_000, trailPct: 15, trailAbs: null }, 120_000)
    expect(t.triggerPrice).toBe(102_000)
    t = ratchetTrigger({ direction: 'long', triggerPrice: t.triggerPrice, highWater: t.highWater, trailPct: 15, trailAbs: null }, 90_000)
    expect(t.triggerPrice).toBe(102_000)
    const lifted = computeCollateralPot(coins({ ...MARKS, BTC: 90_000 }), [floor('BTC', 0.2, t.triggerPrice)], 'exclude').potUsd
    expect(lifted).toBeCloseTo(0.2 * 102_000 * 0.95, 6)
    expect(lifted).toBeGreaterThan(before)
  })

  it('withdrawn coins shrink the pot, extra unfloored coins do not grow it', () => {
    const c = coins(MARKS)
    c[0].walletCoin = 0.1
    expect(computeCollateralPot(c, [floor('BTC', 0.2, 85_000)], 'exclude').potUsd).toBeCloseTo(0.1 * 85_000 * 0.95, 6)
    c[0].walletCoin = 0.5
    expect(computeCollateralPot(c, [floor('BTC', 0.2, 85_000)], 'exclude').potUsd).toBeCloseTo(0.2 * 85_000 * 0.95, 6)
  })

  it('a fired sell floor counts its USDT proceeds; a closed floor counts nothing; collateral off counts nothing', () => {
    const c = coins(MARKS)
    c[0].walletCoin = 0
    const sold = computeCollateralPot(c, [floor('BTC', 0.2, 85_000, { mode: 'sell', status: 'fired', proceedsUsd: 16_900 })], 'exclude')
    expect(sold.components).toEqual([{ coin: 'BTC', usd: 16_900, source: 'sold' }])
    expect(computeCollateralPot(coins(MARKS), [floor('BTC', 0.2, 85_000, { status: 'closed' })], 'exclude').potUsd).toBe(0)
    const off = coins(MARKS)
    off[1].collateral = false
    expect(computeCollateralPot(off, [floor('ETH', 10, 3_400)], 'margin').components.find((x) => x.coin === 'ETH')!.usd).toBe(0)
  })

  it('a fired hedge floor keeps its coins at the trigger (the short holds the value)', () => {
    const r = computeCollateralPot(coins({ ...MARKS, BTC: 70_000 }), [floor('BTC', 0.2, 85_000, { status: 'fired' })], 'exclude')
    expect(r.potUsd).toBeCloseTo(16_150, 6)
  })
})

describe('collateral ratio', () => {
  it('tiered: each slice valued at its own tier', () => {
    const tiers = [
      { minQty: 0, maxQty: 50_000, ratio: 0.9 },
      { minQty: 50_000, maxQty: null, ratio: 0.5 },
    ]
    expect(tieredCollateralRatio(100, tiers)).toBeCloseTo(0.9, 9)
    expect(tieredCollateralRatio(100_000, tiers)).toBeCloseTo(0.7, 9)
    expect(tieredCollateralRatio(0, tiers)).toBe(0.9)
    expect(tieredCollateralRatio(1, [])).toBeNull()
  })

  it('override > venue tiers > default (BTC/ETH 0,95, stables 1, other 0,8)', () => {
    const tiers = [{ minQty: 0, maxQty: null, ratio: 0.85 }]
    expect(resolveCollateralRatio({ coin: 'BTC', qty: 1, override: 0.9, tiers })).toEqual({ ratio: 0.9, source: 'override' })
    expect(resolveCollateralRatio({ coin: 'BTC', qty: 1, tiers })).toEqual({ ratio: 0.85, source: 'venue' })
    expect(resolveCollateralRatio({ coin: 'eth', qty: 1 })).toEqual({ ratio: 0.95, source: 'default' })
    expect(resolveCollateralRatio({ coin: 'USDT', qty: 1 })).toEqual({ ratio: 1, source: 'default' })
    expect(resolveCollateralRatio({ coin: 'SOL', qty: 1 })).toEqual({ ratio: 0.8, source: 'default' })
  })
})

describe('1x pot cap', () => {
  it('refuses the entry that would push open notional past the pot', () => {
    expect(checkPotCap({ potUsd: 48_450, usedNotionalUsd: 40_000, orderNotionalUsd: 8_000 }).ok).toBe(true)
    const no = checkPotCap({ potUsd: 48_450, usedNotionalUsd: 40_000, orderNotionalUsd: 9_000 })
    expect(no.ok).toBe(false)
    expect(no.reason).toMatch(/exceeds 1x the collateral pot/)
    expect(checkPotCap({ potUsd: 0, usedNotionalUsd: 0, orderNotionalUsd: 1 }).ok).toBe(false)
  })

  it('open notional at the mark, the floor hedge part of a short excluded', () => {
    const hedges = new Map([['BTCUSDT', 0.2]])
    const used = usedNotionalUsd(
      [
        { symbol: 'BTCUSDT', side: 'short', size: 0.25, markPrice: 80_000 },
        { symbol: 'XRPUSDT', side: 'long', size: 1_000, markPrice: 2 },
        { symbol: 'SOLUSDT', side: 'long', size: 10, entryPrice: 150 },
      ],
      hedges,
    )
    // 0,05 × 80.000 + 1.000 × 2 + 10 × 150
    expect(used).toBeCloseTo(4_000 + 2_000 + 1_500, 6)
  })
})

describe('margin-ratio guard', () => {
  it('ok below block, block from 60 %, warn (worse) from 80 %, unknown without a rate', () => {
    expect(marginState(0.3, 60, 80)).toBe('ok')
    expect(marginState(0.6, 60, 80)).toBe('block')
    expect(marginState(0.79, 60, 80)).toBe('block')
    expect(marginState(0.8, 60, 80)).toBe('warn')
    expect(marginState(null, 60, 80)).toBe('unknown')
    expect(entriesBlocked('block')).toBe(true)
    expect(entriesBlocked('warn')).toBe(true)
    expect(entriesBlocked('ok')).toBe(false)
    expect(entriesBlocked('unknown')).toBe(false)
  })

  it('thresholds: both in (0, 100) and warn above block', () => {
    expect(() => validateThresholds(60, 80)).not.toThrow()
    expect(() => validateThresholds(80, 60)).toThrow(/above/)
    expect(() => validateThresholds(0, 80)).toThrow(/between/)
    expect(() => validateThresholds(60, 100)).toThrow(/between/)
  })

  it('auto-reduce candidate = largest non-hedge notional', () => {
    const hedges = new Map([['BTCUSDT', 0.2]])
    const pick = largestReducible(
      [
        { symbol: 'BTCUSDT', side: 'short' as const, size: 0.2, markPrice: 80_000 },
        { symbol: 'SOLUSDT', side: 'long' as const, size: 50, markPrice: 150 },
        { symbol: 'XRPUSDT', side: 'long' as const, size: 1_000, markPrice: 2 },
      ],
      hedges,
    )
    expect(pick?.position.symbol).toBe('SOLUSDT')
    expect(pick?.reducibleSize).toBe(50)
    expect(largestReducible([{ symbol: 'BTCUSDT', side: 'short' as const, size: 0.2, markPrice: 1 }], hedges)).toBeNull()
  })
})

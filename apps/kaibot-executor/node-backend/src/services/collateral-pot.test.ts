import { describe, expect, it } from 'bun:test'
import {
  checkPotCap,
  computeCollateralPot,
  entriesBlocked,
  hedgePlan,
  marginAfterFire,
  largestReducible,
  marginState,
  resolveCollateralRatio,
  tieredCollateralRatio,
  topUpNeededUsd,
  usdWhole,
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

describe('virtual lines (off-exchange coins)', () => {
  const virt = (coin: string, qty: number, mark: number | null, ratio = 0.95) => ({ coin, qty, mark, ratio })

  it('armed floor: virtual qty at the floor trigger, as its own virtual component', () => {
    const r = computeCollateralPot(coins(MARKS), [floor('BTC', 0.2, 85_000)], 'exclude', [virt('BTC', 0.1, 100_000)])
    expect(r.components).toEqual([
      { coin: 'BTC', usd: 16_150, source: 'floor' },
      { coin: 'BTC', usd: 0.1 * 85_000 * 0.95, source: 'floor', virtual: true },
    ])
    expect(r.venueUsd).toBeCloseTo(16_150, 6)
    expect(r.virtualUsd).toBeCloseTo(8_075, 6)
    expect(r.potUsd).toBeCloseTo(24_225, 6)
  })

  it('fired floor: the venue coins were protected, the virtual ones were not → min(mark, trigger)', () => {
    const r = computeCollateralPot(
      coins({ ...MARKS, BTC: 70_000 }),
      [floor('BTC', 0.2, 85_000, { mode: 'sell', status: 'fired', proceedsUsd: 16_900 })],
      'exclude',
      [virt('BTC', 0.1, 70_000)],
    )
    expect(r.components.find((c) => c.virtual)).toEqual({ coin: 'BTC', usd: 0.1 * 70_000 * 0.95, source: 'floor', virtual: true })
  })

  it("unfloored: excluded in 'exclude' mode, mark × ratio in 'margin' mode; stablecoins and zero qty skipped", () => {
    const v = [virt('SOL', 115, 200, 0.9), virt('USDT', 1_000, 1, 1), virt('ETH', 0, 4_000)]
    expect(computeCollateralPot(coins(MARKS), [], 'exclude', v).virtualUsd).toBe(0)
    const m = computeCollateralPot(coins(MARKS), [], 'margin', v)
    expect(m.components.filter((c) => c.virtual)).toEqual([{ coin: 'SOL', usd: 115 * 200 * 0.9, source: 'margin', virtual: true }])
  })

  it('a coin held only off-exchange still counts against its floor-less rules', () => {
    const r = computeCollateralPot([], [], 'margin', [virt('SOL', 115, 200, 0.9)])
    expect(r.venueUsd).toBe(0)
    expect(r.potUsd).toBeCloseTo(20_700, 6)
  })

  it('top-up needed = what the order overshoots 1x the venue part of the pot', () => {
    expect(topUpNeededUsd({ venueUsd: 10_000, usedNotionalUsd: 6_000, orderNotionalUsd: 3_000 })).toBe(0)
    expect(topUpNeededUsd({ venueUsd: 10_000, usedNotionalUsd: 6_000, orderNotionalUsd: 5_500 })).toBe(1_500)
    expect(usdWhole(12_345.2)).toBe('12.346')
    expect(usdWhole(999.01)).toBe('1.000')
    expect(usdWhole(42)).toBe('42')
  })
})

describe('virtual hedge plan (cross margin)', () => {
  // Kai's bybit/unified on 05/10: venue coins sold at the sell triggers, cold
  // wallet shorted at the same triggers.
  const margin = marginAfterFire(
    [
      { coin: 'BTC', walletCoin: 0.05, mark: 86_000, ratio: 0.98, collateral: true },
      { coin: 'ETH', walletCoin: 0.264, mark: 2_715, ratio: 0.98, collateral: true },
      { coin: 'SOL', walletCoin: 4, mark: 120, ratio: 0.95, collateral: true },
    ],
    [
      { coin: 'BTC', mode: 'sell', status: 'armed', holdingsCoin: 0.05, triggerPrice: 76_905, proceedsUsd: null },
      { coin: 'ETH', mode: 'sell', status: 'armed', holdingsCoin: 0.264, triggerPrice: 2_471, proceedsUsd: null },
      { coin: 'SOL', mode: 'sell', status: 'armed', holdingsCoin: 4, triggerPrice: 109, proceedsUsd: null },
    ],
  )
  const legs = [
    { coin: 'BTC', qty: 0.079, price: 76_905, mmr: 0.0033 },
    { coin: 'ETH', qty: 1.35, price: 2_471, mmr: 0.0033 },
    { coin: 'SOL', qty: 115, price: 109, mmr: 0.005 },
  ]

  it('margin after fire = sale proceeds at the triggers', () => {
    expect(margin).toBeCloseTo(0.05 * 76_905 + 0.264 * 2_471 + 4 * 109, 6)
  })

  it('leverage, liquidation distance and top-ups follow the formula', () => {
    const p = hedgePlan({ marginUsd: margin, legs })
    const N = 0.079 * 76_905 + 1.35 * 2_471 + 115 * 109
    const Mh = 0.079 * 76_905 * 0.0033 + 1.35 * 2_471 * 0.0033 + 115 * 109 * 0.005
    expect(p.notionalUsd).toBeCloseTo(N, 6)
    expect(p.leverage!).toBeCloseTo(N / margin, 9)
    expect(p.liqDistancePct!).toBeCloseTo(((margin - Mh) / (N + Mh)) * 100, 9)
    expect(p.topUp2xUsd).toBeCloseTo(N / 2 - margin, 6)
    expect(p.topUp1xUsd).toBeCloseTo(N - margin, 6)
    expect(p.ok).toBe(true)
    expect(p.leverage!).toBeLessThan(5)
    expect(p.liqDistancePct!).toBeGreaterThan(15)
  })

  it('refuses above 5x with the deposit that makes it pass', () => {
    const p = hedgePlan({ marginUsd: 2_000, legs })
    expect(p.ok).toBe(false)
    expect(p.reason).toMatch(/^Leverage after it fires [\d,]+x \(max 5x\)/)
    const again = hedgePlan({ marginUsd: 2_000 + p.topUpToArmUsd, legs })
    expect(again.ok).toBe(true)
    expect(p.reason).toContain(`Deposit ${usdWhole(p.topUpToArmUsd)} USD`)
  })

  it('refuses a liquidation closer than 15 % even under 5x', () => {
    const fat = legs.map((l) => ({ ...l, mmr: 0.2 }))
    const p = hedgePlan({ marginUsd: margin, legs: fat })
    expect(p.leverage!).toBeLessThan(5)
    expect(p.liqDistancePct!).toBeLessThan(15)
    expect(p.ok).toBe(false)
    expect(hedgePlan({ marginUsd: margin + p.topUpToArmUsd, legs: fat }).liqDistancePct!).toBeCloseTo(15, 6)
  })

  it('other positions\' maintenance margin brings the liquidation closer', () => {
    const a = hedgePlan({ marginUsd: margin, legs })
    const b = hedgePlan({ marginUsd: margin, legs, otherMmUsd: 500 })
    expect(b.liqDistancePct!).toBeLessThan(a.liqDistancePct!)
  })

  it('no legs: nothing to check', () => {
    expect(hedgePlan({ marginUsd: 100, legs: [] })).toMatchObject({ ok: true, leverage: null, liqDistancePct: null, notionalUsd: 0 })
  })

  it('an open leg locks the virtual coins as a hedged component at the fill', () => {
    const r = computeCollateralPot(
      [{ coin: 'SOL', walletCoin: 0, mark: 90, ratio: 0.95, collateral: true }],
      [{ coin: 'SOL', mode: 'sell', status: 'fired', holdingsCoin: 4, triggerPrice: 109, proceedsUsd: 432 }],
      'exclude',
      [{ coin: 'SOL', qty: 115, mark: 90, ratio: 0.95, hedgedPrice: 108 }],
    )
    expect(r.components.find((c) => c.virtual)).toEqual({ coin: 'SOL', usd: 115 * 108, source: 'hedged', virtual: true })
  })
})

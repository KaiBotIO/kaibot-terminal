import { describe, expect, it } from 'bun:test'
import {
  isFavourableStop,
  computeBreakevenStop,
  computeTrailingStop,
  updateExtreme,
  nextStop,
  type TrailConfig,
} from './local-trailing'

describe('isFavourableStop', () => {
  it('long: only a higher stop is favourable', () => {
    expect(isFavourableStop(100, null, 'long')).toBe(true)
    expect(isFavourableStop(110, 100, 'long')).toBe(true)
    expect(isFavourableStop(90, 100, 'long')).toBe(false)
  })
  it('short: only a lower stop is favourable', () => {
    expect(isFavourableStop(100, null, 'short')).toBe(true)
    expect(isFavourableStop(90, 100, 'short')).toBe(true)
    expect(isFavourableStop(110, 100, 'short')).toBe(false)
  })
})

describe('computeBreakevenStop', () => {
  const long: TrailConfig = { direction: 'long', entryPrice: 100, breakevenFee: 0.0015 }
  it('returns null until price is in profit', () => {
    expect(computeBreakevenStop(long, 99)).toBeNull()
    expect(computeBreakevenStop(long, 100)).toBeNull()
  })
  it('returns entry + fee once in profit (long)', () => {
    expect(computeBreakevenStop(long, 101)).toBeCloseTo(100.15, 6)
  })
  it('returns entry - fee once in profit (short)', () => {
    const short: TrailConfig = { direction: 'short', entryPrice: 100, breakevenFee: 0.0015 }
    expect(computeBreakevenStop(short, 99)).toBeCloseTo(99.85, 6)
  })
  it('null when no break-even fee configured', () => {
    expect(computeBreakevenStop({ direction: 'long', entryPrice: 100 }, 110)).toBeNull()
  })
})

describe('computeTrailingStop', () => {
  it('percentage trail sits below the extreme (long)', () => {
    const cfg: TrailConfig = { direction: 'long', entryPrice: 100, trailPercentage: 2 }
    expect(computeTrailingStop(cfg, 110)).toBeCloseTo(107.8, 6) // 110 - 2%
  })
  it('points trail sits below the extreme (long) and respects maxPoints', () => {
    const cfg: TrailConfig = { direction: 'long', entryPrice: 100, trailPoints: 5, maxPoints: 3 }
    expect(computeTrailingStop(cfg, 110)).toBe(107) // capped at 3 points
  })
  it('short trail sits above the extreme', () => {
    const cfg: TrailConfig = { direction: 'short', entryPrice: 100, trailPercentage: 2 }
    expect(computeTrailingStop(cfg, 90)).toBeCloseTo(91.8, 6) // 90 + 2%
  })
  it('points take precedence over percentage', () => {
    const cfg: TrailConfig = { direction: 'long', entryPrice: 100, trailPoints: 4, trailPercentage: 50 }
    expect(computeTrailingStop(cfg, 110)).toBe(106)
  })
  it('null when no distance configured', () => {
    expect(computeTrailingStop({ direction: 'long', entryPrice: 100 }, 110)).toBeNull()
  })
})

describe('updateExtreme', () => {
  it('tracks the high-water mark for a long', () => {
    expect(updateExtreme('long', 100, 105)).toBe(105)
    expect(updateExtreme('long', 105, 103)).toBe(105)
  })
  it('tracks the low-water mark for a short', () => {
    expect(updateExtreme('short', 100, 95)).toBe(95)
    expect(updateExtreme('short', 95, 97)).toBe(95)
  })
})

describe('nextStop', () => {
  it('long: picks the most favourable of break-even and trail, only if it improves', () => {
    const cfg: TrailConfig = { direction: 'long', entryPrice: 100, trailPercentage: 2, breakevenFee: 0.0015 }
    // extreme 110 → trail 107.8, break-even 100.15 → best 107.8, improves over 105.
    expect(nextStop(cfg, 110, 110, 105)).toBeCloseTo(107.8, 6)
    // No improvement over an already-higher stop.
    expect(nextStop(cfg, 110, 110, 108)).toBeNull()
  })
  it('break-even floors the stop before the trail catches up (long)', () => {
    const cfg: TrailConfig = { direction: 'long', entryPrice: 100, trailPercentage: 5, breakevenFee: 0.0015 }
    // price/extreme 101 → trail 95.95, break-even 100.15 → best is break-even.
    expect(nextStop(cfg, 101, 101, null)).toBeCloseTo(100.15, 6)
  })
  it('returns null when nothing is configured', () => {
    expect(nextStop({ direction: 'long', entryPrice: 100 }, 110, 110, null)).toBeNull()
  })

  // ── EX4 regressions: the stop must never land on the wrong side of the market ──

  it('EX4: shallow poke into profit must NOT arm a break-even stop above the market (long)', () => {
    const cfg: TrailConfig = { direction: 'long', entryPrice: 100, breakevenFee: 0.0015 }
    // Price 100.1 is in profit, but BE (100.15) would sit ABOVE the market —
    // venue-rejected; the old code emitted it and the position went unprotected.
    expect(nextStop(cfg, 100.1, 100.1, null)).toBeNull()
    // Once the price clears entry + fee, the BE stop is placeable.
    expect(nextStop(cfg, 100.2, 100.2, null)).toBeCloseTo(100.15, 6)
  })

  it('EX4: break-even arms off the CURRENT price, not the high-water mark (long)', () => {
    const cfg: TrailConfig = { direction: 'long', entryPrice: 100, breakevenFee: 0.0015 }
    // Spike to 101 then retrace to 100.05: the old code fed the extreme (101)
    // into the BE computation → stop 100.15 above the live 100.05 market.
    expect(nextStop(cfg, 101, 100.05, null)).toBeNull()
  })

  it('EX4: trail candidate above the live price is suppressed (fast drop, long)', () => {
    const cfg: TrailConfig = { direction: 'long', entryPrice: 100, trailPercentage: 2 }
    // Extreme 110 → trail 107.8; price already fell to 107 → not placeable.
    expect(nextStop(cfg, 110, 107, 105)).toBeNull()
  })

  it('EX4: short side mirrors — no stop below the live price', () => {
    const cfg: TrailConfig = { direction: 'short', entryPrice: 100, breakevenFee: 0.0015 }
    // In profit at 99.9 but BE (99.85) would sit BELOW the market for a buy-stop.
    expect(nextStop(cfg, 99.9, 99.9, null)).toBeNull()
    expect(nextStop(cfg, 99.8, 99.8, null)).toBeCloseTo(99.85, 6)
    // Low-water 99 then bounce to 99.9: extreme-fed BE would be invalid.
    expect(nextStop(cfg, 99, 99.9, null)).toBeNull()
  })
})

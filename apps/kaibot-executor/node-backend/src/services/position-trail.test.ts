import { describe, expect, it } from 'bun:test'
import {
  composeEffectiveStop,
  computeEngineStopCandidate,
  positionTrailKey,
  stopsDiffer,
  updateAdverseExtreme,
} from './position-trail.js'
import type { LocalTrailStateRow } from '../storage/types.js'

// Minimal row for the engine candidate (fixed mode, no BE, unlocked).
function rowBase(over: Partial<LocalTrailStateRow> = {}) {
  return {
    direction: 'long' as const,
    entry_price: 100,
    mode: 'fixed' as const,
    exchange: 'bybit',
    trail_percentage: 2,
    trail_points: null,
    max_percentage: null,
    max_points: null,
    min_percentage: null,
    min_points: null,
    breakeven_fee: null,
    use_points: 0,
    freeze_extreme: 0,
    trailing_lock: 0,
    reference_price: null,
    ...over,
  }
}

describe('positionTrailKey', () => {
  it('is deterministic and case-normalized', () => {
    expect(positionTrailKey('Bybit', 'acct-1', 'btcusdt')).toBe('pos:bybit:acct-1:BTCUSDT')
    expect(positionTrailKey('bybit', 'acct-1', 'BTCUSDT')).toBe('pos:bybit:acct-1:BTCUSDT')
  })
})

describe('composeEffectiveStop — pilot-ladder:319-327 port', () => {
  it('manual stop always participates: engine only improves on it (long)', () => {
    // Engine below the manual stop → manual wins.
    expect(
      composeEffectiveStop({ direction: 'long', manualStop: 98, engineStop: 95, trailingLock: false }),
    ).toBe(98)
    // Engine above → engine improves.
    expect(
      composeEffectiveStop({ direction: 'long', manualStop: 98, engineStop: 99, trailingLock: false }),
    ).toBe(99)
  })

  it('manual stop always participates (short: lower = better)', () => {
    expect(
      composeEffectiveStop({ direction: 'short', manualStop: 102, engineStop: 105, trailingLock: false }),
    ).toBe(102)
    expect(
      composeEffectiveStop({ direction: 'short', manualStop: 102, engineStop: 101, trailingLock: false }),
    ).toBe(101)
  })

  it('one side missing → the other stands', () => {
    expect(
      composeEffectiveStop({ direction: 'long', manualStop: null, engineStop: 97, trailingLock: false }),
    ).toBe(97)
    expect(
      composeEffectiveStop({ direction: 'long', manualStop: 96, engineStop: null, trailingLock: false }),
    ).toBe(96)
    expect(
      composeEffectiveStop({ direction: 'long', manualStop: null, engineStop: null, trailingLock: false }),
    ).toBeNull()
  })

  it('trailingLock: the manual value is ABSOLUTE — even when worse than the engine', () => {
    expect(
      composeEffectiveStop({ direction: 'long', manualStop: 90, engineStop: 99, trailingLock: true }),
    ).toBe(90)
    expect(
      composeEffectiveStop({ direction: 'short', manualStop: 110, engineStop: 101, trailingLock: true }),
    ).toBe(110)
  })

  it('trailingLock without a manual stop falls back to the engine stop (pilot semantics)', () => {
    expect(
      composeEffectiveStop({ direction: 'long', manualStop: null, engineStop: 99, trailingLock: true }),
    ).toBe(99)
  })
})

describe('updateAdverseExtreme', () => {
  it('ratchets against the position', () => {
    expect(updateAdverseExtreme('long', 100, 97)).toBe(97)
    expect(updateAdverseExtreme('long', 97, 105)).toBe(97)
    expect(updateAdverseExtreme('short', 100, 104)).toBe(104)
    expect(updateAdverseExtreme('short', 104, 90)).toBe(104)
  })
})

describe('computeEngineStopCandidate — fixed mode', () => {
  it('trails a fixed percentage off the water mark, favourable-only', () => {
    // extreme 110, 2% → 107.8, improves on prev 95.
    expect(computeEngineStopCandidate(rowBase(), 110, 95, 108, 95)).toBeCloseTo(107.8, 6)
    // No improvement on an already-better stop.
    expect(computeEngineStopCandidate(rowBase(), 110, 95, 108, 107.8)).toBeNull()
  })

  it('rejects a candidate on the wrong side of the market (EX4)', () => {
    // Trail off extreme 110 = 107.8, but price crashed to 107 → not placeable.
    expect(computeEngineStopCandidate(rowBase(), 110, 95, 107, 95)).toBeNull()
  })

  it('break-even floors the stop once in profit — even under trailing lock', () => {
    const row = rowBase({ trailing_lock: 1, breakeven_fee: 0.001 })
    // Locked → trail suppressed; BE = 100 * 1.001 = 100.1 (price 105 in profit).
    expect(computeEngineStopCandidate(row, 110, 95, 105, 95)).toBeCloseTo(100.1, 6)
    // Not in profit → nothing.
    expect(computeEngineStopCandidate(row, 110, 95, 99, 95)).toBeNull()
  })

  it('trailing lock suppresses the trail candidate', () => {
    const row = rowBase({ trailing_lock: 1 })
    expect(computeEngineStopCandidate(row, 110, 95, 108, 95)).toBeNull()
  })
})

describe('computeEngineStopCandidate — drawdown mode delegates to the SDK maths', () => {
  it('uses the carried drawdown depth as the trail distance (pct mode)', () => {
    const row = rowBase({
      mode: 'drawdown',
      trail_percentage: null,
      min_percentage: 1,
      max_percentage: 40,
    })
    // extreme 110, opposite 99 → depth 11 → 10% of extreme → stop = price * 0.9.
    const stop = computeEngineStopCandidate(row, 110, 99, 120, null)
    expect(stop).toBeCloseTo(120 * (1 - 10 / 100), 6)
  })

  it('floors the distance at min_percentage right after arming (depth ~ 0)', () => {
    const row = rowBase({
      mode: 'drawdown',
      trail_percentage: null,
      min_percentage: 2,
    })
    // extreme == opposite → depth 0 → floored at 2%.
    const stop = computeEngineStopCandidate(row, 110, 110, 110, null)
    expect(stop).toBeCloseTo(110 * 0.98, 6)
  })

  it('caps the distance at max_percentage', () => {
    const row = rowBase({
      mode: 'drawdown',
      trail_percentage: null,
      min_percentage: 0,
      max_percentage: 5,
    })
    // depth 20% of extreme → capped to 5%.
    const stop = computeEngineStopCandidate(row, 100, 80, 120, null)
    expect(stop).toBeCloseTo(120 * 0.95, 6)
  })

  it('use_points forces point-based maths on any venue', () => {
    const row = rowBase({
      mode: 'drawdown',
      trail_percentage: null,
      min_points: 5,
      max_points: 500,
      use_points: 1,
    })
    // depth 3 points < floor 5 → stop = price - 5.
    const stop = computeEngineStopCandidate(row, 110, 107, 112, null)
    expect(stop).toBeCloseTo(107, 6)
  })

  it('freeze_extreme trails off the fixed reference anchor, not the advancing extreme', () => {
    const frozen = rowBase({
      mode: 'drawdown',
      trail_percentage: null,
      min_percentage: 0,
      freeze_extreme: 1,
      reference_price: 105,
    })
    // frozen anchor 105, opposite 100 → depth 5/105 ≈ 4.7619%.
    const stop = computeEngineStopCandidate(frozen, 120, 100, 120, null)
    expect(stop).toBeCloseTo(120 * (1 - 5 / 105), 6)
    // Same row without freeze uses the advancing extreme 120 → depth 20/120.
    const advancing = rowBase({
      mode: 'drawdown',
      trail_percentage: null,
      min_percentage: 0,
      freeze_extreme: 0,
      reference_price: 105,
    })
    const stop2 = computeEngineStopCandidate(advancing, 120, 100, 120, null)
    expect(stop2).toBeCloseTo(120 * (1 - 20 / 120), 6)
  })

  it('favourable-only against the previous engine stop', () => {
    const row = rowBase({ mode: 'drawdown', trail_percentage: null, min_percentage: 2 })
    // Candidate 110*0.98 = 107.8 does not improve on 108.
    expect(computeEngineStopCandidate(row, 110, 110, 110, 108)).toBeNull()
  })
})

describe('stopsDiffer', () => {
  it('treats float noise as equal and null transitions as different', () => {
    expect(stopsDiffer(107.8, 107.8 + 1e-12)).toBe(false)
    expect(stopsDiffer(107.8, 107.9)).toBe(true)
    expect(stopsDiffer(null, 107.8)).toBe(true)
    expect(stopsDiffer(null, null)).toBe(false)
  })
})

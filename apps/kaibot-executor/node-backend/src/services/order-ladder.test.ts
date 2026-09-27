import { describe, expect, it } from 'bun:test'
import {
  computeTpLadderLegs,
  computeTotalFractionTpLegs,
  computeDcaEntryLegs,
  planHasTpLadder,
  planHasDca,
  timeframeToMs,
} from './order-ladder'

describe('computeTpLadderLegs', () => {
  it('splits by fraction of the remaining open size (sequential semantics)', () => {
    // [0.5, 0.5] of remaining → 0.5, then 0.5 of the leftover 0.5 = 0.25; a
    // 0.25 runner stays open.
    const legs = computeTpLadderLegs(1, [
      { price: 110, fraction: 0.5 },
      { price: 120, fraction: 0.5 },
    ])
    expect(legs).toEqual([
      { price: 110, qty: 0.5 },
      { price: 120, qty: 0.25 },
    ])
  })

  it('a final fraction of 1 closes the whole remainder', () => {
    const legs = computeTpLadderLegs(2, [
      { price: 110, fraction: 0.5 },
      { price: 120, fraction: 1 },
    ])
    expect(legs).toEqual([
      { price: 110, qty: 1 },
      { price: 120, qty: 1 },
    ])
  })

  it('returns empty for no ladder or non-positive size', () => {
    expect(computeTpLadderLegs(1, undefined)).toEqual([])
    expect(computeTpLadderLegs(0, [{ price: 1, fraction: 1 }])).toEqual([])
    expect(computeTpLadderLegs(1, [])).toEqual([])
  })

  it('skips zero-price and non-positive-fraction rungs', () => {
    const legs = computeTpLadderLegs(1, [
      { price: 0, fraction: 0.5 },
      { price: 110, fraction: 0 },
      { price: 120, fraction: 1 },
    ])
    expect(legs).toEqual([{ price: 120, qty: 1 }])
  })

  it('never over-closes when fractions sum past 1', () => {
    const legs = computeTpLadderLegs(1, [
      { price: 110, fraction: 0.8 },
      { price: 120, fraction: 0.8 },
      { price: 130, fraction: 0.8 },
    ])
    const total = legs.reduce((s, l) => s + l.qty, 0)
    expect(total).toBeLessThanOrEqual(1)
  })
})

describe('computeDcaEntryLegs', () => {
  it('weights equity-fraction sizes onto the total contract qty', () => {
    const legs = computeDcaEntryLegs(4, [
      { size: 0.5 },
      { price: 95, size: 0.5 },
    ])
    expect(legs).toEqual([
      { price: undefined, qty: 2 },
      { price: 95, qty: 2 },
    ])
  })

  it('the last rung sweeps the rounding remainder so rungs sum to total', () => {
    const legs = computeDcaEntryLegs(1, [
      { size: 1 },
      { price: 95, size: 1 },
      { price: 90, size: 1 },
    ])
    const total = legs.reduce((s, l) => s + l.qty, 0)
    expect(total).toBeCloseTo(1, 8)
  })

  it('returns empty when no entries or zero size', () => {
    expect(computeDcaEntryLegs(1, undefined)).toEqual([])
    expect(computeDcaEntryLegs(1, [{ size: 0 }])).toEqual([])
    expect(computeDcaEntryLegs(0, [{ size: 1 }])).toEqual([])
  })
})

describe('plan predicates', () => {
  it('detects a TP ladder', () => {
    expect(planHasTpLadder({ takeProfits: [{ price: 1, fraction: 1 }] })).toBe(true)
    expect(planHasTpLadder({})).toBe(false)
    expect(planHasTpLadder(undefined)).toBe(false)
  })

  it('detects DCA only when more than one entry', () => {
    expect(planHasDca({ entries: [{ size: 1 }, { size: 1 }] })).toBe(true)
    expect(planHasDca({ entries: [{ size: 1 }] })).toBe(false)
    expect(planHasDca(undefined)).toBe(false)
  })
})

describe('timeframeToMs', () => {
  it('maps standard timeframes to a bar duration in ms', () => {
    expect(timeframeToMs('1m')).toBe(60_000)
    expect(timeframeToMs('5m')).toBe(300_000)
    expect(timeframeToMs('15m')).toBe(900_000)
    expect(timeframeToMs('1h')).toBe(3_600_000)
    expect(timeframeToMs('4h')).toBe(14_400_000)
    expect(timeframeToMs('1d')).toBe(86_400_000)
    expect(timeframeToMs('1w')).toBe(604_800_000)
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(timeframeToMs('1H')).toBe(3_600_000)
    expect(timeframeToMs(' 4h ')).toBe(14_400_000)
  })

  it('returns undefined for an absent or unrecognised timeframe', () => {
    expect(timeframeToMs(undefined)).toBeUndefined()
    expect(timeframeToMs('')).toBeUndefined()
    expect(timeframeToMs('garbage')).toBeUndefined()
    expect(timeframeToMs('0m')).toBeUndefined()
    expect(timeframeToMs('1y')).toBeUndefined()
  })
})

describe('computeTotalFractionTpLegs (manual-path TP ladder)', () => {
  it('sizes each leg as a fraction of the TOTAL, not of the remainder', () => {
    const legs = computeTotalFractionTpLegs(10, [
      { price: 110, fraction: 0.5 },
      { price: 120, fraction: 0.5 },
    ])
    expect(legs).toEqual([
      { price: 110, qty: 5 },
      { price: 120, qty: 5 },
    ])
  })

  it('a sum below 1 leaves a runner (no resting TP for the tail)', () => {
    const legs = computeTotalFractionTpLegs(10, [
      { price: 110, fraction: 0.3 },
      { price: 120, fraction: 0.3 },
    ])
    expect(legs).toEqual([
      { price: 110, qty: 3 },
      { price: 120, qty: 3 },
    ])
  })

  it('caps the cumulative size at the total (never over-closes)', () => {
    const legs = computeTotalFractionTpLegs(10, [
      { price: 110, fraction: 0.7 },
      { price: 120, fraction: 0.7 },
    ])
    expect(legs).toEqual([
      { price: 110, qty: 7 },
      { price: 120, qty: 3 },
    ])
  })

  it('skips invalid legs and clamps fractions above 1', () => {
    const legs = computeTotalFractionTpLegs(10, [
      { price: 0, fraction: 0.5 }, // invalid price
      { price: 110, fraction: 0 }, // invalid fraction
      { price: 120, fraction: 2 }, // clamped to 1 → whole remainder
    ])
    expect(legs).toEqual([{ price: 120, qty: 10 }])
  })

  it('returns empty for no ladder or non-positive size', () => {
    expect(computeTotalFractionTpLegs(1, undefined)).toEqual([])
    expect(computeTotalFractionTpLegs(0, [{ price: 1, fraction: 1 }])).toEqual([])
    expect(computeTotalFractionTpLegs(1, [])).toEqual([])
  })
})

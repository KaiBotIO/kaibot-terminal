import { describe, expect, it } from 'bun:test'
import { checkBasis } from './basis-guard.js'

describe('basis-guard', () => {
  it('passes when venue is within the threshold', () => {
    const r = checkBasis({ signalPrice: 60_000, venuePrice: 60_060, thresholdBps: 30 })
    expect(r.ok).toBe(true)
    expect(r.deviationBps).toBe(10)
  })

  it('rejects beyond the threshold', () => {
    const r = checkBasis({ signalPrice: 60_000, venuePrice: 60_300, thresholdBps: 30 })
    expect(r.ok).toBe(false)
    expect(r.deviationBps).toBe(50)
  })

  it('exact boundary passes (<=)', () => {
    const r = checkBasis({ signalPrice: 10_000, venuePrice: 10_030, thresholdBps: 30 })
    expect(r.ok).toBe(true)
    expect(r.deviationBps).toBe(30)
  })

  it('no venue price → inconclusive, ok stays true (policy is the caller\'s)', () => {
    const r = checkBasis({ signalPrice: 60_000, venuePrice: null, thresholdBps: 30 })
    expect(r.ok).toBe(true)
    expect(r.inconclusive).toBe(true)
  })

  it('no signal price → guard does not apply', () => {
    const r = checkBasis({ signalPrice: null, venuePrice: 60_000, thresholdBps: 30 })
    expect(r.ok).toBe(true)
    expect(r.inconclusive).toBe(false)
    expect(r.deviationBps).toBeNull()
  })

  it('deviation is symmetric', () => {
    const above = checkBasis({ signalPrice: 60_000, venuePrice: 60_600, thresholdBps: 30 })
    const below = checkBasis({ signalPrice: 60_000, venuePrice: 59_400, thresholdBps: 30 })
    expect(above.deviationBps).toBe(below.deviationBps)
    expect(above.ok).toBe(false)
    expect(below.ok).toBe(false)
  })
})

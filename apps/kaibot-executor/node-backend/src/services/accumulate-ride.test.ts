import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_ACCUMULATE_PARAMS,
  computeLadder,
  decide,
  localExtreme,
  rideStopFor,
  sizeForUsd,
  validateAccumulateParams,
  type Bar,
  type InstrumentSpec,
  type PlanCore,
} from './accumulate-ride.js'

const BTC: InstrumentSpec = { stepSize: 10, minSize: 10, tickSize: 0.5, inverse: true }
const ETH: InstrumentSpec = { stepSize: 1, minSize: 1, tickSize: 0.05, inverse: true }
const P = DEFAULT_ACCUMULATE_PARAMS
const H = 3_600_000

// Flat bars at `level` (high = level) for `n` hours from t0, then the extra ones.
function bars(t0: number, n: number, level: number, extra: Array<Partial<Bar>> = []): Bar[] {
  const out: Bar[] = []
  for (let i = 0; i < n; i++) out.push({ time: t0 + i * H, open: level - 5, high: level, low: level - 10, close: level - 5 })
  extra.forEach((b, i) => {
    const time = t0 + (n + i) * H
    out.push({ time, open: b.close ?? level, high: b.high ?? b.close ?? level, low: b.low ?? level - 10, close: b.close ?? level })
  })
  return out
}

describe('rung sizing', () => {
  it('reproduces the live BTC ladder: 1 % of 0,1 BTC at mark floors to 80 USD', () => {
    const basis = 0.09999992 * 84_443
    const rungs = computeLadder({ reference: 84_443, basisUsd: basis, direction: 'long', params: P, spec: BTC })
    expect(rungs).toHaveLength(10)
    expect(rungs.every((r) => r.qty === 80)).toBe(true)
    expect(rungs[0].price).toBe(83_598.5)
    expect(rungs[9].price).toBe(75_998.5)
    expect(rungs.every((r) => (r.price / 0.5) % 1 === 0)).toBe(true)
  })

  it('reproduces the live ETH ladder: 1 % of 5 ETH floors to 136 USD, prices on the 0,05 tick', () => {
    const rungs = computeLadder({ reference: 2_734.55, basisUsd: 5 * 2_734.55, direction: 'long', params: P, spec: ETH })
    expect(rungs.map((r) => r.qty)).toEqual(Array(10).fill(136))
    expect(rungs[0].price).toBe(2_707.2)
    expect(rungs.every((r) => Math.abs(r.price / 0.05 - Math.round(r.price / 0.05)) < 1e-6)).toBe(true)
  })

  it('shorts ladder upwards and round prices away from the market', () => {
    const rungs = computeLadder({ reference: 100.03, basisUsd: 10_000, direction: 'short', params: { ...P, rungCount: 2 }, spec: ETH })
    expect(rungs.map((r) => r.price)).toEqual([101.05, 102.05])
  })

  it('drops rungs below the venue minimum', () => {
    expect(sizeForUsd(9, 80_000, BTC)).toBe(0)
    expect(computeLadder({ reference: 80_000, basisUsd: 500, direction: 'long', params: P, spec: BTC })).toEqual([])
  })

  it('sizes linear contracts in coin', () => {
    expect(sizeForUsd(100, 50_000, { stepSize: 0.0001, minSize: 0.0001, tickSize: 1, inverse: false })).toBe(0.002)
  })

  it('puts the ride stop one step beyond the deepest rung', () => {
    expect(rideStopFor(100_000, 'long', P, BTC)).toBe(89_000)
    expect(rideStopFor(100_000, 'short', P, BTC)).toBe(111_000)
  })

  it('validates params', () => {
    expect(validateAccumulateParams(P)).toEqual([])
    expect(validateAccumulateParams({ ...P, rungCount: 60 })).not.toEqual([])
    expect(validateAccumulateParams({ ...P, rungStepPct: 10, rungCount: 10 })).toContain('the ladder reaches below zero')
  })
})

describe('local level', () => {
  it('takes the highest high of the lookback bars before the entry bar only', () => {
    const b = bars(0, 50, 100, [{ close: 500, high: 500 }])
    expect(localExtreme(b, 50 * H, 48, 'long')).toBe(100)
    expect(localExtreme(b, 51 * H, 48, 'long')).toBe(500)
    expect(localExtreme(b, 10 * H, 48, 'long')).toBeNull()
  })
})

describe('phase machine', () => {
  const entryBar = 48 * H
  const base: PlanCore = {
    phase: 'ladder',
    direction: 'long',
    reference: 100,
    entryBarTime: entryBar,
    localLevel: null,
    lastEvaluatedBar: null,
  }
  const obs = (b: Bar[], extra: Partial<Parameters<typeof decide>[1]> = {}) => ({
    now: b[b.length - 1].time + H,
    bars: b,
    positionQty: 2_870,
    rideActive: false,
    syntheticHedgeActive: false,
    ...extra,
  })

  it('ladder: a close at the local high is no breakout, a close above is', () => {
    const flat = decide(base, obs(bars(0, 48, 100, [{ close: 100 }])), P)
    expect(flat.actions).toEqual([])
    expect(flat.next.lastEvaluatedBar).toBe(entryBar)

    const d = decide(base, obs(bars(0, 48, 100, [{ close: 99 }, { close: 101 }])), P)
    expect(d.next.phase).toBe('riding')
    expect(d.next.reference).toBe(101)
    expect(d.actions.map((a) => a.kind)).toEqual(['cancel-rungs', 'handover', 'place-ladder'])
    expect(d.breakout).toEqual({ barTime: entryBar + H, close: 101, level: 100 })
  })

  it('ladder: the level stays the one before the entry bar (not rolling)', () => {
    // A spike inside the cycle does not raise the bar to beat.
    const b = bars(0, 48, 100, [{ close: 99, high: 150 }, { close: 101 }])
    expect(decide(base, obs(b), P).next.phase).toBe('riding')
  })

  it('never evaluates the same bar twice and ignores the open bar', () => {
    const b = bars(0, 48, 100, [{ close: 101 }])
    const d = decide({ ...base, lastEvaluatedBar: entryBar }, obs(b), P)
    expect(d.actions).toEqual([])
    const open = decide(base, { ...obs(b), now: entryBar + H - 1 }, P)
    expect(open.actions).toEqual([])
  })

  it('ladder: a closed position cancels the rungs and waits', () => {
    const d = decide(base, obs(bars(0, 49, 100), { positionQty: 0 }), P)
    expect(d.next.phase).toBe('waiting')
    expect(d.actions).toEqual([{ kind: 'cancel-rungs' }])
  })

  it('riding: the ride ending cancels the rungs and waits', () => {
    const d = decide({ ...base, phase: 'riding' }, obs(bars(0, 49, 100), { rideActive: false }), P)
    expect(d.next.phase).toBe('waiting')
    expect(d.actions).toEqual([{ kind: 'cancel-rungs' }])
  })

  it('riding: a new breakout at least one step above the reference moves the ladder up', () => {
    const riding: PlanCore = { ...base, phase: 'riding', reference: 100 }
    const small = decide(riding, obs(bars(0, 49, 100, [{ close: 100.5 }]), { rideActive: true }), P)
    expect(small.actions).toEqual([])
    const big = decide(riding, obs(bars(0, 49, 100, [{ close: 102 }]), { rideActive: true }), P)
    expect(big.actions.map((a) => a.kind)).toEqual(['cancel-rungs', 'place-ladder'])
    expect(big.next.reference).toBe(102)
    expect(decide(riding, obs(bars(0, 49, 100, [{ close: 102 }]), { rideActive: true }), { ...P, reanchorOnBreakout: false }).actions).toEqual([])
  })

  it('waiting: the next breakout re-enters, hands over and ladders', () => {
    const waiting: PlanCore = { ...base, phase: 'waiting', reference: 100 }
    const quiet = decide(waiting, obs(bars(0, 49, 100, [{ close: 99 }]), { positionQty: 0 }), P)
    expect(quiet.actions).toEqual([])
    const d = decide(waiting, obs(bars(0, 49, 100, [{ close: 103 }]), { positionQty: 0 }), P)
    expect(d.actions.map((a) => a.kind)).toEqual(['market-entry', 'handover', 'place-ladder'])
    expect(d.next.phase).toBe('riding')
  })

  it('holds a breakout while a synthetic hedge nets the instrument', () => {
    const d = decide(base, obs(bars(0, 48, 100, [{ close: 101 }]), { syntheticHedgeActive: true }), P)
    expect(d.actions).toEqual([])
    expect(d.next.phase).toBe('ladder')
    expect(d.note).toContain('synthetic')
  })

  it('short plans break out below the local low', () => {
    const short: PlanCore = { ...base, direction: 'short' }
    const b = bars(0, 48, 100, [{ close: 89, low: 88 }])
    // local low of the flat bars = 90
    expect(decide(short, obs(b), P).next.phase).toBe('riding')
  })

  it('stopped plans do nothing', () => {
    expect(decide({ ...base, phase: 'stopped' }, obs(bars(0, 48, 100, [{ close: 200 }])), P).actions).toEqual([])
  })
})

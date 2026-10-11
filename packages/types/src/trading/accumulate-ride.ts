// Accumulate & ride: pure core (no DB, no adapter).
//
// An operator-armed plan per (exchange, account, market). The operator
// pre-authorizes the whole cycle; the executor carries it out:
//
//   ladder   position + N resting buy rungs below the reference. Waits for a
//            root-bar close beyond the local extreme measured before the
//            entry bar.
//   riding   the whole position is handed to a tf-ride bot (server manages the
//            exit). A fresh ladder rests below the breakout level; its fills
//            land in the ridden position. A later breakout re-anchors the
//            ladder higher.
//   waiting  the ride ended (stop, L1, disaster, manual close): no rungs, no
//            position. The next breakout re-enters with the start size and
//            hands over again.
//   stopped  operator stop: rungs cancelled, the position is left alone.
//
// Nothing here decides a trade on its own: every order is the operator's
// pre-authorized rule applied to the venue's candles.

export type AccumulatePhase = 'ladder' | 'riding' | 'waiting' | 'stopped'
export type Direction = 'long' | 'short'

export interface AccumulateParams {
  // Root bars the local extreme looks back over (before the entry bar).
  lookbackBars: number
  // Root bar in minutes (breakout closes are measured on this bar).
  barMinutes: number
  // Distance between rungs, in % of the reference.
  rungStepPct: number
  // Size of each rung, in % of the basis.
  rungPct: number
  rungCount: number
  // Re-entry size after a ride ended, in % of the basis.
  startPct: number
  // The ride's resting venue stop sits this many steps beyond the deepest rung
  // (the hand-over needs one; the rungs themselves carry no stop).
  rideStopExtraSteps: number
  // Move the ladder up on a new breakout while riding.
  reanchorOnBreakout: boolean
}

export const DEFAULT_ACCUMULATE_PARAMS: AccumulateParams = {
  lookbackBars: 48,
  barMinutes: 60,
  rungStepPct: 1,
  rungPct: 1,
  rungCount: 10,
  startPct: 34,
  rideStopExtraSteps: 1,
  reanchorOnBreakout: true,
}

export function validateAccumulateParams(p: AccumulateParams): string[] {
  const errors: string[] = []
  const int = (v: number) => Number.isInteger(v)
  if (!int(p.lookbackBars) || p.lookbackBars < 2 || p.lookbackBars > 1000) errors.push('lookbackBars must be 2..1000')
  if (!int(p.barMinutes) || p.barMinutes < 1 || p.barMinutes > 1440) errors.push('barMinutes must be 1..1440')
  if (!(p.rungStepPct > 0 && p.rungStepPct <= 20)) errors.push('rungStepPct must be in (0, 20]')
  if (!(p.rungPct > 0 && p.rungPct <= 50)) errors.push('rungPct must be in (0, 50]')
  if (!int(p.rungCount) || p.rungCount < 0 || p.rungCount > 50) errors.push('rungCount must be 0..50')
  if (!(p.startPct > 0 && p.startPct <= 200)) errors.push('startPct must be in (0, 200]')
  if (!int(p.rideStopExtraSteps) || p.rideStopExtraSteps < 1 || p.rideStopExtraSteps > 20) {
    errors.push('rideStopExtraSteps must be 1..20')
  }
  // The deepest level (ride stop) must stay on the right side of zero.
  if ((p.rungCount + p.rideStopExtraSteps) * p.rungStepPct >= 100) errors.push('the ladder reaches below zero')
  return errors
}

export interface Bar {
  // Bar open time, epoch ms.
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface InstrumentSpec {
  // Order amount step and minimum (inverse perps: USD; linear: coin).
  stepSize: number
  minSize: number
  tickSize: number
  // Inverse (coin-margined, USD-sized) contract.
  inverse: boolean
}

const EPS = 1e-9

function floorToStep(v: number, step: number): number {
  if (!(step > 0)) return v
  return Math.floor(v / step + EPS) * step
}

function roundPrice(v: number, tick: number, mode: 'down' | 'up'): number {
  if (!(tick > 0)) return v
  const n = mode === 'down' ? Math.floor(v / tick + EPS) : Math.ceil(v / tick - EPS)
  // Shed float dust (0.05 ticks).
  return Number((n * tick).toFixed(10))
}

// Size for a USD amount, floored to the contract step. 0 when below the minimum.
export function sizeForUsd(usd: number, price: number, spec: InstrumentSpec): number {
  if (!(usd > 0) || !(price > 0)) return 0
  const native = spec.inverse ? usd : usd / price
  const q = floorToStep(native, spec.stepSize)
  const clean = Number(q.toFixed(10))
  return clean + EPS >= spec.minSize && clean > 0 ? clean : 0
}

export interface RungLevel {
  // 1-based distance in steps from the reference.
  idx: number
  price: number
  qty: number
}

// N rungs at -1·step … -N·step (long) from the reference, each rungPct of the
// basis. Prices round AWAY from the market (never a better fill than the rule).
export function computeLadder(input: {
  reference: number
  basisUsd: number
  direction: Direction
  params: AccumulateParams
  spec: InstrumentSpec
}): RungLevel[] {
  const { reference, basisUsd, direction, params, spec } = input
  if (!(reference > 0) || !(basisUsd > 0)) return []
  const out: RungLevel[] = []
  for (let i = 1; i <= params.rungCount; i++) {
    const off = (i * params.rungStepPct) / 100
    const raw = direction === 'long' ? reference * (1 - off) : reference * (1 + off)
    const price = roundPrice(raw, spec.tickSize, direction === 'long' ? 'down' : 'up')
    const qty = sizeForUsd((basisUsd * params.rungPct) / 100, price, spec)
    if (qty > 0 && price > 0) out.push({ idx: i, price, qty })
  }
  return out
}

// The ride's resting venue stop: rideStopExtraSteps beyond the deepest rung.
export function rideStopFor(reference: number, direction: Direction, params: AccumulateParams, spec: InstrumentSpec): number {
  const off = ((params.rungCount + params.rideStopExtraSteps) * params.rungStepPct) / 100
  const raw = direction === 'long' ? reference * (1 - off) : reference * (1 + off)
  return roundPrice(raw, spec.tickSize, direction === 'long' ? 'down' : 'up')
}

// Highest high (long) / lowest low (short) of the `lookback` bars that opened
// strictly before `beforeTime`. Null when the window is not complete.
export function localExtreme(bars: Bar[], beforeTime: number, lookback: number, direction: Direction): number | null {
  const window = bars.filter((b) => b.time < beforeTime).slice(-lookback)
  if (window.length < lookback) return null
  return direction === 'long' ? Math.max(...window.map((b) => b.high)) : Math.min(...window.map((b) => b.low))
}

// Bars whose close is final at `now`.
export function closedBars(bars: Bar[], barMinutes: number, now: number): Bar[] {
  const ms = barMinutes * 60_000
  return bars.filter((b) => b.time + ms <= now).sort((a, b) => a.time - b.time)
}

// Start time of the bar that contains `t`.
export function barStart(t: number, barMinutes: number): number {
  const ms = barMinutes * 60_000
  return Math.floor(t / ms) * ms
}

export function closesBeyond(close: number, level: number, direction: Direction): boolean {
  return direction === 'long' ? close > level : close < level
}

export interface PlanCore {
  phase: AccumulatePhase
  direction: Direction
  // Level the current ladder hangs from.
  reference: number
  // Start of the bar the current cycle began in (ladder phase: the entry bar).
  entryBarTime: number
  // Local extreme fixed for the ladder phase (bars before the entry bar).
  localLevel: number | null
  // Last closed bar already evaluated (no bar is acted on twice).
  lastEvaluatedBar: number | null
}

export interface Observation {
  now: number
  // Venue bars (any order; open ones are ignored).
  bars: Bar[]
  // Directional size of the plan's position (0 = flat).
  positionQty: number
  // A tf-ride bot currently manages the position.
  rideActive: boolean
  // A synthetic-USD short on the same instrument + account: the net venue
  // position no longer equals the directional one, so no new entry/hand-over.
  syntheticHedgeActive: boolean
}

export type AccumulateAction =
  | { kind: 'cancel-rungs' }
  | { kind: 'market-entry' }
  | { kind: 'handover'; anchor: number }
  | { kind: 'place-ladder'; reference: number }

export interface Decision {
  next: PlanCore
  actions: AccumulateAction[]
  // Why nothing happened / what happened, for the status line.
  note: string
  breakout?: { barTime: number; close: number; level: number }
}

// One step of the machine. Evaluates only the LATEST closed bar that was not
// evaluated before: after a restart the plan acts on what is true now, never
// on a breakout that already reversed while it was down.
export function decide(plan: PlanCore, obs: Observation, params: AccumulateParams): Decision {
  const same = (note: string, next: PlanCore = plan): Decision => ({ next, actions: [], note })
  if (plan.phase === 'stopped') return same('stopped')

  if (plan.phase === 'ladder' && !(obs.positionQty > 0)) {
    return {
      next: { ...plan, phase: 'waiting' },
      actions: [{ kind: 'cancel-rungs' }],
      note: 'position gone: rungs cancelled, waiting for the next breakout',
    }
  }
  if (plan.phase === 'riding' && !obs.rideActive) {
    return {
      next: { ...plan, phase: 'waiting' },
      actions: [{ kind: 'cancel-rungs' }],
      note: 'ride ended: rungs cancelled, waiting for the next breakout',
    }
  }

  const closed = closedBars(obs.bars, params.barMinutes, obs.now)
  const last = closed[closed.length - 1]
  if (!last) return same('no closed bars yet')
  if (plan.lastEvaluatedBar != null && last.time <= plan.lastEvaluatedBar) return same('waiting for the next bar close')
  const evaluated: PlanCore = { ...plan, lastEvaluatedBar: last.time }

  const level =
    plan.phase === 'ladder'
      ? plan.localLevel ?? localExtreme(closed, plan.entryBarTime, params.lookbackBars, plan.direction)
      : localExtreme(closed, last.time, params.lookbackBars, plan.direction)
  if (level == null) return same('not enough bars for the local level', evaluated)
  if (plan.phase === 'ladder' && last.time < plan.entryBarTime) return same('before the entry bar', evaluated)
  if (!closesBeyond(last.close, level, plan.direction)) return same('no breakout', evaluated)

  const breakout = { barTime: last.time, close: last.close, level }
  const beyondRef =
    plan.direction === 'long'
      ? last.close >= plan.reference * (1 + params.rungStepPct / 100)
      : last.close <= plan.reference * (1 - params.rungStepPct / 100)

  switch (plan.phase) {
    case 'ladder':
      if (obs.syntheticHedgeActive) return same('breakout held: synthetic hedge open on this instrument', evaluated)
      return {
        next: { ...evaluated, phase: 'riding', reference: last.close, entryBarTime: last.time, localLevel: null },
        actions: [
          { kind: 'cancel-rungs' },
          { kind: 'handover', anchor: last.close },
          { kind: 'place-ladder', reference: last.close },
        ],
        note: 'breakout: handed over, ladder moved to the breakout level',
        breakout,
      }
    case 'riding':
      if (!params.reanchorOnBreakout || !beyondRef) return same('riding', evaluated)
      return {
        next: { ...evaluated, reference: last.close },
        actions: [{ kind: 'cancel-rungs' }, { kind: 'place-ladder', reference: last.close }],
        note: 'new breakout while riding: ladder moved up',
        breakout,
      }
    case 'waiting':
      if (obs.syntheticHedgeActive) return same('breakout held: synthetic hedge open on this instrument', evaluated)
      return {
        next: { ...evaluated, phase: 'riding', reference: last.close, entryBarTime: last.time, localLevel: null },
        actions: [
          { kind: 'market-entry' },
          { kind: 'handover', anchor: last.close },
          { kind: 'place-ladder', reference: last.close },
        ],
        note: 'breakout: re-entered at the re-entry size and handed over',
        breakout,
      }
  }
  return same('idle', evaluated)
}

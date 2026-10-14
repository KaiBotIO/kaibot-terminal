// Pure helpers that turn an OrderPlan ladder into concrete order legs the
// executor places on the exchange. Kept free of DB/adapter so the sizing maths
// can be unit-tested in isolation. Sizing mirrors the SDK/backtester semantics
// the plan documents (packages/types OrderPlan).

import type { OrderPlan, PlannedEntry, PlannedTakeProfit } from '../storage/types'

export interface TpLeg {
  price: number
  qty: number
}

export interface EntryLeg {
  // Resting limit price; undefined → market entry at signal time.
  price?: number
  qty: number
}

// Round to 8 decimals to shed floating-point dust; the adapter still applies the
// exchange's own min/step rounding when the order is placed.
function roundQty(qty: number): number {
  return Math.round(qty * 1e8) / 1e8
}

function clampFraction(f: number): number {
  if (!Number.isFinite(f) || f <= 0) return 0
  return f > 1 ? 1 : f
}

// Build reduce-only take-profit legs from a ladder. `fraction` is the portion of
// the *current* (remaining) open size to close at each rung — the sequential
// semantics documented on PlannedTakeProfit. Fractions summing to < 1 leave a
// runner open (no resting TP for the tail); the trailing/SL leg manages it.
export function computeTpLadderLegs(
  totalQty: number,
  takeProfits: PlannedTakeProfit[] | undefined,
): TpLeg[] {
  if (!takeProfits || takeProfits.length === 0 || !(totalQty > 0)) return []
  const legs: TpLeg[] = []
  let remaining = totalQty
  for (const tp of takeProfits) {
    if (remaining <= 0) break
    if (!(tp.price > 0)) continue
    const frac = clampFraction(tp.fraction)
    if (frac <= 0) continue
    let qty = roundQty(frac * remaining)
    if (qty <= 0) continue
    if (qty > remaining) qty = remaining
    legs.push({ price: tp.price, qty })
    remaining = roundQty(remaining - qty)
  }
  return legs
}

// Build entry legs for a DCA / scale-in plan. `size` is an equity fraction
// (0..1) per the plan; we weight it against the total intended contract size so
// the rungs sum to `totalQty`. An entry without a price is a market rung.
export function computeDcaEntryLegs(
  totalQty: number,
  entries: PlannedEntry[] | undefined,
): EntryLeg[] {
  if (!entries || entries.length === 0 || !(totalQty > 0)) return []
  const sizeSum = entries.reduce((s, e) => s + (e.size > 0 ? e.size : 0), 0)
  if (sizeSum <= 0) return []
  const legs: EntryLeg[] = []
  let allocated = 0
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!(e.size > 0)) continue
    const isLast = i === entries.length - 1
    // The final rung sweeps the rounding remainder so the rungs sum to totalQty.
    let qty = isLast
      ? roundQty(totalQty - allocated)
      : roundQty((e.size / sizeSum) * totalQty)
    if (qty <= 0) continue
    legs.push({ price: e.price, qty })
    allocated = roundQty(allocated + qty)
  }
  return legs
}

// Manual-path TP ladder: each fraction is of the TOTAL position size (user
// authors "close 30% here, 30% there"; fractions sum to ≤ 1), unlike
// PlannedTakeProfit's sequential fraction-of-remaining semantics. Legs are
// capped so their cumulative size never exceeds totalQty; a sum < 1 leaves a
// runner for the stop/manual close to manage.
export function computeTotalFractionTpLegs(
  totalQty: number,
  takeProfits: Array<{ price: number; fraction: number }> | undefined,
): TpLeg[] {
  if (!takeProfits || takeProfits.length === 0 || !(totalQty > 0)) return []
  const legs: TpLeg[] = []
  let remaining = totalQty
  for (const tp of takeProfits) {
    if (remaining <= 0) break
    if (!(tp.price > 0)) continue
    const frac = clampFraction(tp.fraction)
    if (frac <= 0) continue
    let qty = roundQty(frac * totalQty)
    if (qty <= 0) continue
    if (qty > remaining) qty = remaining
    legs.push({ price: tp.price, qty })
    remaining = roundQty(remaining - qty)
  }
  return legs
}

// Convenience: a signal carries a plan when it has any laddered exits or entries.
export function planHasTpLadder(plan: OrderPlan | undefined): boolean {
  return !!plan?.takeProfits && plan.takeProfits.length > 0
}

export function planHasDca(plan: OrderPlan | undefined): boolean {
  return !!plan?.entries && plan.entries.length > 1
}

// Map a strategy timeframe string to a bar duration in ms, so the live executor
// can turn the plan's ttlBars (a bar count) into a wall-clock expiry for a
// resting DCA rung. Undefined for an unrecognised/absent timeframe → the caller
// falls back to no time-based TTL (cancel-on-close only).
const TF_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
export function timeframeToMs(tf: string | undefined): number | undefined {
  if (!tf) return undefined
  const m = /^(\d+)\s*([mhdw])$/i.exec(tf.trim())
  if (!m) return undefined
  const n = Number(m[1])
  if (!(n > 0)) return undefined
  return n * TF_UNIT_MS[m[2].toLowerCase()]
}

// Pure local trailing-stop + break-even maths. Kept free of DB/adapter so the
// stop computation is unit-testable. The executor runs these on a local price
// tick (poll loop) and amends the resting stop order — fast enough for scalping,
// instead of the 5s server-side manager round-trip.
//
// Trailing model: a CONSTANT-distance trail from the high/low water mark (the
// plan's PlannedTrail overrides the SDK's drawdown-depth derivation with a fixed
// distance — percentage or points). Break-even: once price is in profit the stop
// is floored at entry +/- a fee buffer. The stop only ever moves toward profit.

export type TrailDirection = 'long' | 'short'

export interface TrailConfig {
  direction: TrailDirection
  entryPrice: number
  // Fixed trail distance. Points take precedence over percentage when both set.
  trailPercentage?: number | null
  trailPoints?: number | null
  // Optional caps on the trail distance.
  maxPercentage?: number | null
  maxPoints?: number | null
  // Break-even fee buffer (fraction, e.g. 0.0015). Null/undefined → no
  // break-even. Always sourced from the user-authored plan.trail; the executor
  // never substitutes a default fee on the user's behalf.
  breakevenFee?: number | null
}

// A new stop is favourable only if it moves toward profit (or there is no stop
// yet). Mirrors the SDK isFavourableStop.
export function isFavourableStop(
  newStop: number,
  currentStop: number | null | undefined,
  direction: TrailDirection,
): boolean {
  if (currentStop == null) return true
  return direction === 'long' ? newStop > currentStop : newStop < currentStop
}

// Break-even stop: entry +/- fee buffer, once price has moved into profit.
export function computeBreakevenStop(config: TrailConfig, price: number): number | null {
  const fee = config.breakevenFee
  if (fee == null) return null
  const inProfit =
    config.direction === 'long' ? price > config.entryPrice : price < config.entryPrice
  if (!inProfit) return null
  return config.direction === 'long'
    ? config.entryPrice * (1 + fee)
    : config.entryPrice * (1 - fee)
}

// Trailing stop: a fixed distance below the high-water mark (long) / above the
// low-water mark (short). Returns null when no trail distance is configured.
export function computeTrailingStop(config: TrailConfig, extremePrice: number): number | null {
  let distance: number | null = null
  if (config.trailPoints != null && config.trailPoints > 0) {
    distance = config.trailPoints
    if (config.maxPoints != null && config.maxPoints > 0) {
      distance = Math.min(distance, config.maxPoints)
    }
  } else if (config.trailPercentage != null && config.trailPercentage > 0) {
    let pct = config.trailPercentage
    if (config.maxPercentage != null && config.maxPercentage > 0) {
      pct = Math.min(pct, config.maxPercentage)
    }
    distance = extremePrice * (pct / 100)
  }
  if (distance == null || !(distance > 0)) return null
  return config.direction === 'long' ? extremePrice - distance : extremePrice + distance
}

// Advance the high/low water mark with a new tick.
export function updateExtreme(
  direction: TrailDirection,
  extreme: number,
  price: number,
): number {
  return direction === 'long' ? Math.max(extreme, price) : Math.min(extreme, price)
}

// A stop trigger is only placeable on the correct side of the market: below the
// current price for a long's protective sell-stop, above it for a short's
// buy-stop. A stop on the wrong side is venue-rejected — and cancelling the old
// stop first would leave the position unprotected (EX4).
export function isValidTriggerSide(
  stop: number,
  currentPrice: number,
  direction: TrailDirection,
): boolean {
  return direction === 'long' ? stop < currentPrice : stop > currentPrice
}

// Decide the next stop for a tick: the most favourable of the break-even and
// trailing candidates that improves on the current stop AND is validly
// placeable against the CURRENT price. Returns null when no move is warranted.
// `extremePrice` is the already-updated water mark; `currentPrice` is the live
// tick. Break-even arms off the current price — never the high-water mark: a
// spike-and-retrace would otherwise compute a BE stop above the market (long),
// get venue-rejected after the old stop was cancelled, and leave the position
// unprotected (EX4).
export function nextStop(
  config: TrailConfig,
  extremePrice: number,
  currentPrice: number,
  currentStop: number | null,
): number | null {
  const candidates: number[] = []
  const be = computeBreakevenStop(config, currentPrice)
  if (be != null) candidates.push(be)
  const trail = computeTrailingStop(config, extremePrice)
  if (trail != null) candidates.push(trail)
  if (candidates.length === 0) return null

  // Most favourable = highest for long, lowest for short — but never on the
  // wrong side of the market.
  const placeable = candidates.filter((c) =>
    isValidTriggerSide(c, currentPrice, config.direction),
  )
  if (placeable.length === 0) return null
  const best =
    config.direction === 'long' ? Math.max(...placeable) : Math.min(...placeable)
  return isFavourableStop(best, currentStop, config.direction) ? best : null
}

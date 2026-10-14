// Position-scoped trail engine — the pure maths behind "attach a trail /
// break-even to ANY open position" (F1, pilot-ladder decomposition). Free of
// DB/adapter so every rule is unit-testable:
//
//   - attach key derivation for manual (position-scoped) trails,
//   - the adverse water mark (addon opposite_price),
//   - the per-mode engine stop candidate (fixed distance via local-trailing,
//     drawdown depth via the SDK computeDrawdownTrailingStop mirror),
//   - the effective-stop rule (port of pilot-ladder.ts:319-327): the manual
//     stop ALWAYS participates, the engine only improves on it, and under
//     trailingLock the manual value is absolute.

import type { LocalTrailStateRow } from '../storage/types.js'
import {
  computeBreakevenStop,
  computeTrailingStop,
  isFavourableStop,
  isValidTriggerSide,
  type TrailDirection,
} from './local-trailing.js'
import {
  computeDrawdownTrailingStop,
  isPointBasedExchange,
} from './drawdown-trail.js'

// SDK reference defaults (drawdownTrailingStopParamsSchema) for the drawdown
// caps when the row leaves them unset.
const DEFAULT_MAX_TRAILING_PCT = 40
const DEFAULT_MAX_TRAILING_POINTS = 500

// Deterministic attach key for a trail armed on a position by hand. One-way
// positions only (one net position per (exchange, account, symbol)) — the
// direction is a row attribute, not part of the key, so ONE stop owner per
// position holds by construction.
export function positionTrailKey(exchange: string, accountId: string, symbol: string): string {
  return `pos:${exchange.toLowerCase()}:${accountId}:${symbol.toUpperCase()}`
}

// Gross notional at risk for one position: |size| × mark, where mark is the
// live mark when valid (>0), else the entry, else 0.
export function positionNotional(p: {
  size: number
  markPrice?: number | null
  entryPrice?: number | null
}): number {
  const mark = p.markPrice && p.markPrice > 0 ? p.markPrice : (p.entryPrice ?? 0)
  return Math.abs(p.size) * mark
}

// Advance the adverse water mark (addon opposite_price): the worst price seen
// against the position. For a long that is the lowest low; for a short the
// highest high.
export function updateAdverseExtreme(
  direction: TrailDirection,
  opposite: number,
  price: number,
): number {
  return direction === 'long' ? Math.min(opposite, price) : Math.max(opposite, price)
}

// Effective stop composition — port of pilot-ladder.ts:319-327. The manual
// stop always participates; the engine only improves on it (favourable-only);
// under trailingLock the manual value is absolute (may move the stop AGAINST
// the position — the human owns it).
export function composeEffectiveStop(input: {
  direction: TrailDirection
  manualStop: number | null | undefined
  engineStop: number | null | undefined
  trailingLock: boolean
}): number | null {
  const manual = input.manualStop ?? null
  const engine = input.engineStop ?? null
  if (input.trailingLock) return manual ?? engine
  if (manual == null) return engine
  if (engine == null) return manual
  return input.direction === 'long' ? Math.max(manual, engine) : Math.min(manual, engine)
}

// The engine's stop candidate for one tick, per the row's mode. Favourable-only
// against the previous ENGINE stop and placeable against the live price (never
// on the wrong side of the market — EX4). Under trailing_lock the trail is
// suspended but break-even still participates (pilot-ladder semantics: BE
// promotion runs regardless of the lock; only the trail block is gated).
// `extraCandidates` are stop prices emitted by attached edge managers (F2) —
// they join the same favourable-only/placeable composition, like break-even
// they are NOT gated by the row's trailing_lock (the effective-stop rule
// already makes the manual value absolute under lock).
// Returns null when no engine move is warranted.
export function computeEngineStopCandidate(
  row: Pick<
    LocalTrailStateRow,
    | 'direction'
    | 'entry_price'
    | 'mode'
    | 'exchange'
    | 'trail_percentage'
    | 'trail_points'
    | 'max_percentage'
    | 'max_points'
    | 'min_percentage'
    | 'min_points'
    | 'breakeven_fee'
    | 'use_points'
    | 'freeze_extreme'
    | 'trailing_lock'
    | 'reference_price'
  >,
  extreme: number,
  opposite: number,
  price: number,
  engineStopPrev: number | null,
  extraCandidates: number[] = [],
): number | null {
  const direction = row.direction
  const candidates: number[] = [...extraCandidates]

  // Break-even floor: entry ± fee once in profit. Arms off the LIVE price.
  const be = computeBreakevenStop(
    { direction, entryPrice: row.entry_price, breakevenFee: row.breakeven_fee },
    price,
  )
  if (be != null) candidates.push(be)

  if (!row.trailing_lock) {
    if (row.mode === 'drawdown') {
      const pointBased = !!row.use_points || isPointBasedExchange(row.exchange)
      const dd = computeDrawdownTrailingStop({
        params: {
          maxTrailingPercentage: row.max_percentage ?? DEFAULT_MAX_TRAILING_PCT,
          maxTrailingPoints: row.max_points ?? DEFAULT_MAX_TRAILING_POINTS,
          minTrailingPercentage: row.min_percentage ?? 0,
          minTrailingPoints: row.min_points ?? 0,
          trailingLock: false, // the lock is composed above, not delegated
          onlyWhenProfit: false,
          referencePrice: row.reference_price ?? 0,
          freezeExtreme: !!row.freeze_extreme,
        },
        position: {
          direction,
          avgEntryPrice: row.entry_price,
          extremePriceAtEntry: extreme,
          oppositePrice: opposite,
          currentStopLoss: engineStopPrev,
          exchange: row.exchange,
        },
        price,
        reference: row.reference_price ?? undefined,
        frozenExtreme: row.freeze_extreme ? (row.reference_price ?? undefined) : undefined,
        // use_points forces point-mode for any venue (pilot-ladder trailUsePoints);
        // else the mode derives from the exchange inside the compute.
        pointBased,
      })
      if (dd != null) candidates.push(dd)
    } else {
      const trail = computeTrailingStop(
        {
          direction,
          entryPrice: row.entry_price,
          trailPercentage: row.trail_percentage,
          trailPoints: row.trail_points,
          maxPercentage: row.max_percentage,
          maxPoints: row.max_points,
        },
        extreme,
      )
      if (trail != null) candidates.push(trail)
    }
  }

  if (candidates.length === 0) return null
  const placeable = candidates.filter((c) => isValidTriggerSide(c, price, direction))
  if (placeable.length === 0) return null
  const best = direction === 'long' ? Math.max(...placeable) : Math.min(...placeable)
  return isFavourableStop(best, engineStopPrev, direction) ? best : null
}

// One relative epsilon for "did the stop actually move" checks — avoids
// cancel/replace churn on float noise.
export function stopsDiffer(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a !== b
  return Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
}

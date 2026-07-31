// Synthetic mode sizing: when a synthetic USD position is flagged as the
// factor basis, its USD value acts as the account size for signal sizing on
// that (exchange, account) — every symbol, not just the synthetic's own
// market. A signal's factor units become a percent of that value
// (qty 1 → 1 factor = 1%), converted to an order quantity per venue type.

import type { KaiBotDatabase } from '../storage/database.js'
import type { SyntheticUsdPositionRow } from '../storage/types.js'
import { usdToNativeSize } from '@kaibot/types/core'

// The flagged synthetic USD position when it applies to THIS (exchange,
// account). Deliberately NOT symbol-scoped. Returns null when nothing is
// flagged (a closed position never matches — the db lookup filters on open)
// or the flagged position belongs elsewhere. Defensive on the db method for
// test doubles.
export function getSyntheticSizingBasis(
  db: KaiBotDatabase,
  exchange: string,
  account: string,
): SyntheticUsdPositionRow | null {
  const get = (db as Partial<KaiBotDatabase>).getFactorBasisSyntheticUsdPosition
  if (typeof get !== 'function') return null
  const pos = get.call(db)
  if (!pos) return null
  if (pos.exchange !== exchange || pos.account_id !== account) return null
  return pos
}

export interface PercentToQuantityResult {
  // Final order quantity, rounded to the contract step.
  quantity: number
  // USD notional this represents (post-cap, pre-rounding).
  notionalUsd: number
  // True when the requested percent implied more than 100% of targetUsd.
  capped: boolean
  // True when a linear conversion needed a price and none was supplied.
  priceMissing: boolean
}

// Pure: percent-of-synthetic-account → order quantity. Inverse venues quote
// the order quantity as a USD notional, so no price is needed; linear venues
// need one (quantity = notional / price) and the caller must fail closed on
// priceMissing. A single order never exceeds 100% of targetUsd.
export function percentToQuantity(
  percent: number,
  targetUsd: number,
  exchange: string,
  symbol: string,
  stepSize: number,
  price?: number,
): PercentToQuantityResult {
  const safePercent = Math.max(0, percent)
  const safeTarget = Math.max(0, targetUsd)
  const requestedNotional = (safePercent / 100) * safeTarget
  const notionalUsd = Math.min(requestedNotional, safeTarget)
  const capped = requestedNotional > notionalUsd

  const r = usdToNativeSize({ exchange, symbol, usdNotional: notionalUsd, price, stepSize })
  if (r.priceMissing) return { quantity: 0, notionalUsd: 0, capped: false, priceMissing: true }
  return { quantity: r.size, notionalUsd, capped, priceMissing: false }
}

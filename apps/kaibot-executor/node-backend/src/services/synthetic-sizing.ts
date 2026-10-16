// Synthetic mode sizing: when a synthetic USD position is flagged as the
// factor basis, its USD value acts as the account size for signal sizing on
// that (exchange, account) — every symbol, not just the synthetic's own
// market. A signal's factor units become a percent of that value
// (qty 1 → 1 factor = 1%), converted to an order quantity per venue type.

import type { KaiBotDatabase } from '../storage/database.js'
import type { SyntheticUsdPositionRow } from '../storage/types.js'
import { usdToNativeSize } from '@kaibot/types/core'
import { accountKeyOf, scopeAccountId } from './exchanges/account-scope.js'

// The USD value a flagged row lends to sizing, by phase (Kai, 04/09: an
// armed synthetic MUST size signals before it is minted):
//   armed            → the planned floor, holdings × trigger
//   open, arm cycle  → the realized floor, holdings × fill
//   open, plain      → target_usd (as before)
export type SyntheticBasisKind = 'armed' | 'realized' | 'open'

export function syntheticBasisUsd(
  row: Pick<
    SyntheticUsdPositionRow,
    'status' | 'target_usd' | 'arm_trigger_price' | 'arm_planned_usd' | 'arm_holdings_coin' | 'arm_fired_price' | 'arm_fired_trigger_price'
  >,
): { usd: number; kind: SyntheticBasisKind } {
  if (row.status === 'armed') {
    return { usd: Math.max(0, row.arm_planned_usd ?? 0), kind: 'armed' }
  }
  if (row.arm_trigger_price != null && row.arm_holdings_coin != null) {
    const fill = row.arm_fired_price ?? row.arm_fired_trigger_price ?? row.arm_trigger_price
    return { usd: Math.max(0, row.arm_holdings_coin * fill), kind: 'realized' }
  }
  return { usd: Math.max(0, row.target_usd), kind: 'open' }
}

export type SyntheticSizingBasis = SyntheticUsdPositionRow & {
  basisUsd: number
  basisKind: SyntheticBasisKind
}

// The flagged synthetic USD position when it applies to THIS (exchange,
// account). Deliberately NOT symbol-scoped. Returns null when nothing is
// flagged (a closed position never matches — the db lookup filters on
// open/armed) or the flagged position belongs elsewhere. Defensive on the db
// method for test doubles. `basisUsd` is the value to size against.
export function getSyntheticSizingBasis(
  db: KaiBotDatabase,
  exchange: string,
  account: string,
  // Signal symbol: a USDC-linear perp sizes against its coin's basis (below).
  symbol?: string | null,
): SyntheticSizingBasis | null {
  const get = (db as Partial<KaiBotDatabase>).getFactorBasisSyntheticUsdPosition
  if (typeof get !== 'function') return null
  const lookup = (acct: string): SyntheticSizingBasis | null => {
    // Per-account lookup; a test double that ignores the arguments still gets
    // re-checked below.
    const pos = get.call(db, exchange, acct)
    if (!pos) return null
    if (pos.exchange !== exchange || pos.account_id !== acct) return null
    const basis = syntheticBasisUsd(pos)
    return { ...pos, basisUsd: basis.usd, basisKind: basis.kind }
  }
  const direct = lookup(account)
  if (direct) return direct
  const coinAccount = linearCoinAccount(account, symbol)
  return coinAccount && coinAccount !== account ? lookup(coinAccount) : null
}

// A USDC-linear signal (BTC_USDC-PERPETUAL) settles in the venue's `usdc`
// account, while the armed synthetic that protects the coin lives on the coin
// account ('btc'). Size it against that coin's basis on the SAME connection:
// 'acct1/usdc' + BTC_USDC-PERPETUAL → 'acct1/btc'. Null for anything else.
export function linearCoinAccount(account: string, symbol?: string | null): string | null {
  if (!symbol) return null
  const m = /^([A-Z]+)_USDC/i.exec(symbol)
  if (!m) return null
  return scopeAccountId(accountKeyOf(account), m[1].toLowerCase())
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

// Venue exposure the executor holds OUTSIDE bot executions: synthetic USD
// shorts (plain or minted by a coin/collateral floor). A perp holds one net
// position per (account, symbol), so such a short nets with the bots' exposure
// there (2026-10-14: ETH floor hedge -12.356 + Fault Line +1.972 = venue
// -10.384). Hedge-guard legs are not here: they register as manual markers.

import type { KaiBotDatabase } from '../storage/database.js'
import type { SyntheticUsdPositionRow } from '../storage/types.js'

export type HedgeLegKind = 'floor-hedge' | 'synthetic-usd'

export interface HedgeLeg {
  kind: HedgeLegKind
  id: string
  accountId: string
  symbol: string
  /** Signed, in venue units (short = negative). */
  net: number
  entryPrice: number | null
}

export const hedgeLegLabel = (kind: HedgeLegKind): string => (kind === 'floor-hedge' ? 'floor hedge' : 'synthetic USD')

export function hedgeLegFromSynthetic(r: SyntheticUsdPositionRow): HedgeLeg | null {
  if (r.status !== 'open' || !(r.short_size > 0)) return null
  return {
    kind: r.arm_trigger_price != null ? 'floor-hedge' : 'synthetic-usd',
    id: r.id,
    accountId: r.account_id,
    symbol: r.symbol,
    net: -r.short_size,
    entryPrice: r.arm_fired_price ?? null,
  }
}

/** Throws when the hedge source can't be read: a close path must fail closed. */
export function hedgeLegsOnStrict(
  db: KaiBotDatabase,
  exchange: string,
  symbol: string,
  onAccount: (accountId: string) => boolean,
): HedgeLeg[] {
  const lister = (db as Partial<KaiBotDatabase>).listSyntheticUsdPositions
  if (typeof lister !== 'function') throw new Error('synthetic USD positions not readable')
  const legs: HedgeLeg[] = []
  for (const r of lister.call(db, false)) {
    if (r.exchange !== exchange || r.symbol.toUpperCase() !== symbol.toUpperCase() || !onAccount(r.account_id)) continue
    const leg = hedgeLegFromSynthetic(r)
    if (leg) legs.push(leg)
  }
  return legs
}

/** Fail-open read for observers (reconciler, overview): no source = no hedge. */
export function hedgeLegsOn(
  db: KaiBotDatabase,
  exchange: string,
  symbol: string,
  onAccount: (accountId: string) => boolean,
): HedgeLeg[] {
  try {
    return hedgeLegsOnStrict(db, exchange, symbol, onAccount)
  } catch {
    return []
  }
}

export function manualNetOn(
  db: KaiBotDatabase,
  exchange: string,
  symbol: string,
  onAccount: (accountId: string) => boolean,
): number {
  const lister = (db as Partial<KaiBotDatabase>).listManualPositions
  if (typeof lister !== 'function') return 0
  try {
    return lister
      .call(db)
      .filter((m) => m.exchange === exchange && m.symbol.toUpperCase() === symbol.toUpperCase() && onAccount(m.account_id))
      .reduce((a, m) => a + m.net, 0)
  } catch {
    return 0
  }
}

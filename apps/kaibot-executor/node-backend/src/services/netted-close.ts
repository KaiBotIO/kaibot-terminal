// Bulk closes (group close, PANIC, daily-loss flatten) on a perp that nets a
// floor/synthetic hedge with other exposure. Closing the venue position would
// buy the hedge back: only the non-hedge part may go, with a reduce-only order,
// and only when that part sits on the same side as the venue net.

import type { KaiBotDatabase } from '../storage/database.js'
import { rowOnAccount } from './exchanges/account-scope.js'
import { hedgeLegLabel, hedgeLegsOnStrict } from './venue-hedge-legs.js'

export type NettedClosePlan =
  /** No hedge on the instrument: close the venue position as before. */
  | { kind: 'plain' }
  /** Reduce-only close of `qty`; the hedge stays. */
  | { kind: 'partial'; qty: number; side: 'buy' | 'sell' }
  | { kind: 'blocked'; reason: string }

export interface VenuePositionRef {
  exchange: string
  accountId: string
  symbol: string
  side: 'long' | 'short'
  size: number
}

const fmt = (n: number, signed = false) => {
  const s = Math.abs(n).toLocaleString('nl-BE', { maximumFractionDigits: 8 })
  return n < 0 ? `-${s}` : signed ? `+${s}` : s
}

/** Signed remaining size of the open executions on (account, symbol). */
export function botLineageNet(db: KaiBotDatabase, p: Pick<VenuePositionRef, 'exchange' | 'accountId' | 'symbol'>): number {
  return db
    .listOpenExecutionsForExchange(p.exchange)
    .filter(
      (e) =>
        rowOnAccount((e as { account_id?: string | null }).account_id ?? null, p.accountId) &&
        e.symbol.toUpperCase() === p.symbol.toUpperCase(),
    )
    .reduce((a, e) => {
      const rem = Math.max(0, e.qty_opened - e.qty_closed)
      return a + (e.direction === 'long' ? rem : -rem)
    }, 0)
}

/**
 * `target`: 'bots' closes the bots' own lineage (group close); 'non-hedge'
 * closes everything except the hedge (PANIC, daily-loss). Throws when the
 * hedge source can't be read: callers leave the position open and report it.
 */
export function nettedClosePlan(db: KaiBotDatabase, p: VenuePositionRef, target: 'bots' | 'non-hedge'): NettedClosePlan {
  const hedges = hedgeLegsOnStrict(db, p.exchange, p.symbol, (a) => a === p.accountId)
  if (hedges.length === 0) return { kind: 'plain' }

  const venueNet = p.side === 'long' ? Math.abs(p.size) : -Math.abs(p.size)
  const hedgeNet = hedges.reduce((a, h) => a + h.net, 0)
  const want = target === 'bots' ? botLineageNet(db, p) : venueNet - hedgeNet
  const eps = 1e-9 * Math.max(1, Math.abs(venueNet))
  const hedgeText = hedges.map((h) => `${hedgeLegLabel(h.kind)} ${fmt(h.net, true)}`).join(', ')

  if (Math.abs(want) <= eps) {
    return {
      kind: 'blocked',
      reason: `${p.symbol}: only the ${hedgeText} is left. Manage it on the Synthetic USD page.`,
    }
  }
  if (Math.sign(want) === Math.sign(venueNet) && Math.abs(want) <= Math.abs(venueNet) + eps) {
    return { kind: 'partial', qty: Math.abs(want), side: want > 0 ? 'sell' : 'buy' }
  }
  return {
    kind: 'blocked',
    reason:
      `${p.symbol}: ${target === 'bots' ? 'bots' : 'other exposure'} ${fmt(want, true)} netted with ${hedgeText} ` +
      `(venue ${fmt(venueNet)}). A reduce-only close can only buy back the hedge.`,
  }
}

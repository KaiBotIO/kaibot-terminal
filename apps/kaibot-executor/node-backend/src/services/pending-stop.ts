// A stop placement that threw on a venue without client order ids
// (TradeStation) may still have landed. The slot then holds a marker instead
// of an order id: no update places another stop on top until the venue is read
// again (venue-exit sweep), which adopts the stop or frees the slot.

import type { OpenOrder } from './exchanges/types.js'

const PREFIX = 'pending-stop:'

// accountId: the account the placement went to (the venue read needs it).
// keep: a plain stop that stayed tracked while the new one went first
// (placeFirst); the read restores it and withdraws a landed newcomer.
export function pendingStopMarker(
  stopPrice: number,
  quantity: number,
  opts: { accountId?: string | null; keep?: string | null; atMs?: number } = {},
): string {
  let m = `${PREFIX}${stopPrice}:${quantity}:${opts.atMs ?? Date.now()}`
  if (opts.accountId) m += `:a=${encodeURIComponent(opts.accountId)}`
  if (opts.keep) m += `:k=${encodeURIComponent(opts.keep)}`
  return m
}

export function isPendingStop(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.startsWith(PREFIX)
}

export interface PendingStop {
  stopPrice: number
  quantity: number
  atMs: number
  accountId: string | null
  keep: string | null
}

export function parsePendingStop(id: string | null | undefined): PendingStop | null {
  if (!isPendingStop(id)) return null
  const [p, q, t, ...rest] = id.slice(PREFIX.length).split(':')
  const [stopPrice, quantity, atMs] = [p, q, t].map(Number)
  if (![stopPrice, quantity, atMs].every(Number.isFinite)) return null
  const field = (k: string) => {
    const hit = rest.find((r) => r.startsWith(`${k}=`))
    return hit ? decodeURIComponent(hit.slice(k.length + 1)) : null
  }
  return { stopPrice, quantity, atMs, accountId: field('a'), keep: field('k') }
}

// Same instrument for a stop-presence check. Futures compare by root: a stop
// on another month of the root counts too.
export function sameRoot(a: string, b: string): boolean {
  if (a.toUpperCase() === b.toUpperCase()) return true
  const root = (s: string) => s.toUpperCase().replace(/[FGHJKMNQUVXZ]\d{1,2}$/, '')
  return root(a) === root(b)
}

export type LandedStop =
  | { kind: 'one'; orderId: string }
  | { kind: 'none' }
  | { kind: 'many'; ids: string[] }
  | { kind: 'unreadable'; reason: string }

// The stop a thrown placement may have left: a live closing-side stop on the
// root at the asked trigger and qty that no record claims yet.
export async function findLandedStop(
  adapter: { getWorkingOrders?: (ctx: { accountId: string; symbol?: string }) => Promise<OpenOrder[]> },
  args: { accountId: string | null | undefined; symbol: string; side: 'buy' | 'sell'; stopPrice: number; quantity: number; isKnown: (id: string) => boolean },
): Promise<LandedStop> {
  if (typeof adapter.getWorkingOrders !== 'function' || !args.accountId) return { kind: 'unreadable', reason: 'the venue orders cannot be read' }
  let orders: OpenOrder[]
  try {
    orders = await adapter.getWorkingOrders({ accountId: args.accountId })
  } catch (err: any) {
    return { kind: 'unreadable', reason: `venue orders read failed (${err?.message ?? err})` }
  }
  const ids = orders
    .filter(
      (o) =>
        o.side === args.side &&
        sameRoot(o.symbol, args.symbol) &&
        o.triggerPrice != null &&
        Math.abs(o.triggerPrice - args.stopPrice) < 1e-6 &&
        Math.abs(o.amount - args.quantity) < 1e-9 &&
        !args.isKnown(o.orderId),
    )
    .map((o) => o.orderId)
  if (ids.length === 1) return { kind: 'one', orderId: ids[0] }
  return ids.length === 0 ? { kind: 'none' } : { kind: 'many', ids }
}

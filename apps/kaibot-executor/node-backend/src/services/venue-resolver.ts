// Resolves which REAL venue a signal executes on. Composite signals carry the
// data feed ('index'), never an execution venue — that choice belongs to the
// user's subscription. There is deliberately NO default venue: a signal that
// cannot be resolved must be rejected loudly, not silently sent to deribit
// (the old hardcoded fallback this module replaces).
import { INDEX_EXCHANGE } from '@kaibot/types/core'

export interface VenueResolution {
  exchange: string | null
  /** Why resolution failed; null when exchange is set. */
  rejectReason: string | null
}

export function resolveVenue(params: {
  subscriptionExchange?: string | null
  signalMetadataExchange?: string | null
}): VenueResolution {
  const subEx = params.subscriptionExchange?.trim().toLowerCase() || null
  if (subEx && subEx !== INDEX_EXCHANGE) return { exchange: subEx, rejectReason: null }

  // Legacy per-venue bots: the signal itself names the venue it ran on.
  const metaEx = params.signalMetadataExchange?.trim().toLowerCase() || null
  if (metaEx && metaEx !== INDEX_EXCHANGE) return { exchange: metaEx, rejectReason: null }

  return {
    exchange: null,
    rejectReason:
      metaEx === INDEX_EXCHANGE || subEx === INDEX_EXCHANGE
        ? 'composite signal: no execution venue configured on the subscription'
        : 'no execution venue: subscription has no exchange and signal names none',
  }
}

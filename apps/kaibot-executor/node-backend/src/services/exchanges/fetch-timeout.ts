// Shared fetch timeouts for all exchange adapters. Without a timeout a single
// stuck REST call (venue outage, black-holed TCP connection) hangs its caller
// forever — and, through the order lock, freezes order flow on that venue.
//
// Order placement gets a longer budget than reads: aborting a placement mid-
// flight leaves an unknown outcome (was it accepted?), so we give the venue more
// time to answer before giving up. Reads are safely retried, so they fail fast.
//
// Values are mutable so tests can shrink them; production code treats them as
// constants.

export const FETCH_TIMEOUTS = {
  // Idempotent reads: balances, positions, order status, tickers.
  read: 10_000,
  // Order placement / cancellation — aborting creates an unknown outcome, so
  // allow more time before the settlement machinery has to take over.
  order: 30_000,
  // Auth / token exchange / session reads.
  auth: 15_000,
}

export type FetchTimeoutKind = keyof typeof FETCH_TIMEOUTS

/** AbortSignal that fires after the configured timeout for this op kind. */
export function timeoutSignal(kind: FetchTimeoutKind): AbortSignal {
  return AbortSignal.timeout(FETCH_TIMEOUTS[kind])
}

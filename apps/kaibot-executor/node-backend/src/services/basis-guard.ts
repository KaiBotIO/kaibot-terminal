// Basis guard: composite signals price on the index feed, but the order fills
// on one venue. When the venue has drifted too far from the signal price
// (volatility spike, venue dislocation), entering "at the signal" is no longer
// what the strategy decided — skip the entry and surface it.
//
// Entries only: closes and cancels always pass (they reduce risk).
// Mirrors market-guard's shape: pure decision function + injectable inputs.

const DEFAULT_THRESHOLD_BPS = Number(process.env.BASIS_GUARD_BPS) || 30

export interface BasisCheck {
  ok: boolean
  deviationBps: number | null
  thresholdBps: number
  /** True when no venue price could be obtained (guard inconclusive). */
  inconclusive: boolean
}

export function checkBasis(params: {
  signalPrice: number | null | undefined
  venuePrice: number | null | undefined
  thresholdBps?: number | null
}): BasisCheck {
  const thresholdBps = params.thresholdBps ?? DEFAULT_THRESHOLD_BPS
  const signalPrice = params.signalPrice ?? null
  const venuePrice = params.venuePrice ?? null

  // No signal price (pure market orders without a reference) → nothing to
  // compare against; the guard does not apply.
  if (signalPrice === null || signalPrice <= 0) {
    return { ok: true, deviationBps: null, thresholdBps, inconclusive: false }
  }
  // No venue price → inconclusive. Policy (fail-open vs fail-closed) is the
  // caller's; blocking every entry because a ticker endpoint hiccuped is worse
  // than the basis risk, so callers default to fail-open WITH a flagged event.
  if (venuePrice === null || venuePrice <= 0) {
    return { ok: true, deviationBps: null, thresholdBps, inconclusive: true }
  }

  const deviationBps = Math.abs(venuePrice - signalPrice) / signalPrice * 10_000
  return {
    ok: deviationBps <= thresholdBps,
    deviationBps: Math.round(deviationBps * 100) / 100,
    thresholdBps,
    inconclusive: false,
  }
}

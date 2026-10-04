// Accounting modes for backtests / forward tests on inverse (coin-margined)
// perpetuals. The engines stay linear quote-USD; 'inverse-coin' is a pure
// post-run overlay (see @kaibot/backtester inverse-accounting) that shows what
// the account does when collateral is the base coin: unhedged (flat = long the
// coin) and with a synthetic-USD hedge (delta-neutral short on the collateral).

import { isInverseContract } from './sizing.js';

export type AccountingMode = 'linear-usd' | 'inverse-coin';

export interface InverseAccountingConfig {
  mode: AccountingMode;
  // Fraction of the collateral value the hedge short targets. 1 = full
  // synthetic USD, 0 = no hedge (unhedged coin curve only).
  syntheticUsdHedgePct?: number;
  // Drift band before the hedge re-targets, in bps of the target notional.
  hedgeRebalanceThresholdBps?: number;
  // Funding per 8h period in bps of hedge notional. Positive = the short
  // pays, negative = the short receives (earns carry). 0 ignores funding.
  fundingBps8h?: number;
}

export const DEFAULT_SYNTHETIC_USD_HEDGE_PCT = 1;
export const DEFAULT_HEDGE_REBALANCE_THRESHOLD_BPS = 100;
export const DEFAULT_FUNDING_BPS_8H = 0;

// Sim-side venue gate. Delegates to the shared contract discriminator so the
// sim and the executor agree on what is inverse. Pass the venue-native symbol:
// Deribit USDC perps are LINEAR, so 'deribit' alone is not enough.
export function isInverseAccountingVenue(
  exchange: string | null | undefined,
  symbol?: string | null,
): boolean {
  return isInverseContract(exchange, symbol);
}

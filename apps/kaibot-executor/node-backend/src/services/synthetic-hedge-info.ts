import type { KaiBotDatabase } from '../storage/database.js'

export interface SyntheticHedgeInfo {
  id: string
  // Fired trigger for an arm-cycle row; null for a plain synthetic short.
  triggerPrice: number | null
  firedPrice: number | null
  firedAt: number | null
  shortUsd: number
  holdingsCoin: number | null
  holdingsUsd: number
}

// A short that IS a synthetic USD hedge of coin holdings (open row on the same
// exchange, account and symbol): no stop by design, and not manual.
export function syntheticHedgeFor(
  db: KaiBotDatabase,
  exchange: string,
  p: { accountId?: string | null; symbol: string; side: string },
): SyntheticHedgeInfo | null {
  if (p.side !== 'short' || !p.accountId) return null
  try {
    const r = db.getOpenSyntheticUsdPosition(exchange, p.accountId, p.symbol)
    if (!r) return null
    return {
      id: r.id,
      triggerPrice: r.arm_fired_trigger_price ?? r.arm_trigger_price ?? null,
      firedPrice: r.arm_fired_price ?? null,
      firedAt: r.arm_fired_at ?? null,
      shortUsd: r.short_size,
      holdingsCoin: r.arm_holdings_coin ?? null,
      holdingsUsd: r.holdings_basis_usd,
    }
  } catch {
    return null
  }
}
